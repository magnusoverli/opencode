#!/usr/bin/env node
const http = require("http");
const net = require("net");
const zlib = require("zlib");

const LISTEN_HOST = process.env.OPENCHAMBER_INGRESS_HOST || "0.0.0.0";
const LISTEN_PORT = Number.parseInt(process.env.OPENCHAMBER_INGRESS_PORT || "8099", 10);
const UPSTREAM_HOST = process.env.OPENCHAMBER_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number.parseInt(process.env.OPENCHAMBER_UPSTREAM_PORT || "3010", 10);
const SUPERVISOR_INGRESS_IP = process.env.HA_INGRESS_PROXY_IP || "172.30.32.2";

function normalizeRemoteAddress(address) {
  if (!address) return "";
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  if (address === "::1") return "127.0.0.1";
  return address;
}

function isAllowedRemote(address) {
  const normalized = normalizeRemoteAddress(address);
  return normalized === "127.0.0.1"
    || normalized === SUPERVISOR_INGRESS_IP
    || normalized.startsWith("127.");
}

function normalizeIngressPath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || !trimmed.startsWith("/")) return "";
  return trimmed;
}

function ingressPathFromRequest(req) {
  const headerValue = Array.isArray(req.headers["x-ingress-path"])
    ? req.headers["x-ingress-path"][0]
    : req.headers["x-ingress-path"];
  const fromHeader = normalizeIngressPath(headerValue);
  if (fromHeader) return fromHeader;

  const match = (req.url || "").match(/^(\/api\/hassio_ingress\/[^/?#]+)/);
  return match ? match[1] : "";
}

function stripIngressPath(url, ingressPath) {
  if (!ingressPath || !url.startsWith(ingressPath)) return url || "/";
  const stripped = url.slice(ingressPath.length);
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function forwardedProto(req) {
  const explicit = req.headers["x-forwarded-proto"];
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.split(",")[0].trim();
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim()) {
    try {
      return new URL(origin).protocol.replace(/:$/, "");
    } catch {
      return "http";
    }
  }
  return "http";
}

function transformLocationHeader(value, ingressPath) {
  if (!ingressPath || typeof value !== "string" || !value.startsWith("/")) {
    return value;
  }
  if (value.startsWith(ingressPath)) return value;
  return `${ingressPath}${value}`;
}

function escapeHtmlAttribute(value) {
  return value.replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function noStoreHeaders(extra = {}) {
  return {
    ...extra,
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

function transformRootAssetUrls(content, ingressPath) {
  const assetPath = ingressPath ? `${ingressPath}/assets/` : "assets/";
  return content
    .replace(/(["'`])\/assets\//g, `$1${assetPath}`)
    .replace(/url\((["]?)\/assets\//g, `url($1${assetPath}`)
    .replace(/url\((\')\/assets\//g, `url($1${assetPath}`)
    .replace(/assetsURL=function\((\w+)\)\{return"\/"\+\1\}/g, "assetsURL=function($1){return $1}")
    .replace(/("modulepreload",\w+=function\()(\w+)(\)\{return)"\/"\+\2(\},\w+=\{\})/g, "$1$2$3 $2$4");
}

function serviceWorkerResetScript() {
  return `self.addEventListener("install", (event) => {\n`
    + `  self.skipWaiting();\n`
    + `});\n`
    + `self.addEventListener("activate", (event) => {\n`
    + `  event.waitUntil((async () => {\n`
    + `    try {\n`
    + `      for (const key of await caches.keys()) {\n`
    + `        if (/openchamber|workbox|vite/i.test(key)) await caches.delete(key);\n`
    + `      }\n`
    + `    } catch {}\n`
    + `    try { await self.registration.unregister(); } catch {}\n`
    + `    try {\n`
    + `      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });\n`
    + `      for (const client of clients) client.navigate(client.url);\n`
    + `    } catch {}\n`
    + `  })());\n`
    + `});\n`;
}

function ingressRuntimeScript(ingressPath) {
  const basePath = ingressPath || "";

  return `(() => {\n`
    + `  const configuredBasePath = ${JSON.stringify(basePath)};\n`
    + `  const match = window.location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n`
    + `  const basePath = configuredBasePath || (match ? match[1] : "");\n`
    + `  const absoluteBase = basePath ? window.location.origin + basePath : window.location.origin;\n`
    + `  if (basePath && !document.querySelector("base[data-ha-ingress-base]")) {\n`
    + `    const base = document.createElement("base");\n`
    + `    base.setAttribute("data-ha-ingress-base", "");\n`
    + `    base.href = basePath.replace(/\\/+$/, "") + "/";\n`
    + `    document.head.prepend(base);\n`
    + `  }\n`
    + `  if (typeof window.process === "undefined") window.process = { env: {} };\n`
    + `  window.__OPENCHAMBER_API_BASE_URL__ = absoluteBase;\n`
    + `  window.__OPENCHAMBER_LOCAL_ORIGIN__ = window.location.origin;\n`
    + `  window.__OPENCHAMBER_INGRESS_BASE_PATH__ = basePath;\n`
    + `  window.__OPENCHAMBER_UPDATE_PWA_MANIFEST__ ||= () => {};\n`
    + `  window.__OPENCHAMBER_GET_PWA_INSTALL_NAME__ ||= () => "OpenChamber";\n`
    + `  window.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ ||= (value) => value || "OpenChamber";\n`
    + `  window.__OPENCHAMBER_SET_PWA_ORIENTATION__ ||= (value) => value || "system";\n`
    + `  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {\n`
    + `    navigator.serviceWorker.getRegistrations().then((registrations) => {\n`
    + `      for (const registration of registrations) {\n`
    + `        const urls = [registration.scope, registration.active?.scriptURL, registration.waiting?.scriptURL, registration.installing?.scriptURL].filter(Boolean);\n`
    + `        const shouldRemove = urls.some((value) => {\n`
    + `          try {\n`
    + `            const url = new URL(value, window.location.href);\n`
    + `            return url.pathname === "/sw.js" || (basePath && (url.pathname === basePath || url.pathname.startsWith(basePath + "/"))) || url.pathname.includes("/api/hassio_ingress/");\n`
    + `          } catch {\n`
    + `            return false;\n`
    + `          }\n`
    + `        });\n`
    + `        if (shouldRemove) registration.unregister().catch(() => {});\n`
    + `      }\n`
    + `    }).catch(() => {});\n`
    + `  }\n`
    + `  if (basePath && typeof window.fetch === "function" && !window.__OPENCHAMBER_INGRESS_FETCH_PATCHED__) {\n`
    + `    window.__OPENCHAMBER_INGRESS_FETCH_PATCHED__ = true;\n`
    + `    const originalFetch = window.fetch.bind(window);\n`
    + `    const shouldPrefix = (pathname) => pathname === "/api" || pathname.startsWith("/api/") || pathname === "/auth" || pathname.startsWith("/auth/") || pathname === "/health";\n`
    + `    const rewriteInput = (input) => {\n`
    + `      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;\n`
    + `      if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;\n`
    + `      try {\n`
    + `        const url = new URL(rawUrl, window.location.href);\n`
    + `        if (url.origin !== window.location.origin) return null;\n`
    + `        if (url.pathname === basePath || url.pathname.startsWith(basePath + "/")) return null;\n`
    + `        if (!shouldPrefix(url.pathname)) return null;\n`
    + `        url.pathname = basePath + url.pathname;\n`
    + `        return url.toString();\n`
    + `      } catch {\n`
    + `        return null;\n`
    + `      }\n`
    + `    };\n`
    + `    window.fetch = (input, init) => {\n`
    + `      const rewritten = rewriteInput(input);\n`
    + `      if (!rewritten) return originalFetch(input, init);\n`
    + `      if (input instanceof Request) return originalFetch(new Request(rewritten, input), init);\n`
    + `      return originalFetch(rewritten, init);\n`
    + `    };\n`
    + `  }\n`
    + `})();\n`;
}

function transformHtml(html, ingressPath) {
  const baseHref = ingressPath ? `${ingressPath}/` : "";
  const runtimeSrc = ingressPath ? `${baseHref}__openchamber_ingress_runtime.js` : "__openchamber_ingress_runtime.js";
  let transformed = html.replace(
    /\s*<script\b[^>]*\bdata-ha-ingress-runtime\b[^>]*>[\s\S]*?<\/script>/g,
    ""
  );

  transformed = transformed.replace(
    "const baseUrl = location.origin;",
    "const ingressBaseMatch = location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n      const baseUrl = location.origin + (ingressBaseMatch ? ingressBaseMatch[1] : '');"
  );

  if (ingressPath && !transformed.includes("data-ha-ingress-base")) {
    transformed = transformed.replace(
      /<head([^>]*)>/i,
      `<head$1>\n    <base data-ha-ingress-base href="${escapeHtmlAttribute(baseHref)}">`
    );
  }

  if (!transformed.includes("data-ha-ingress-runtime")) {
    transformed = transformed.replace(
      /\s*<script type="module"/,
      `\n    <script data-ha-ingress-runtime src="${escapeHtmlAttribute(runtimeSrc)}"></script>\n    <script type="module"`
    );
  }

  transformed = transformed.replace(/\b(href|src)="\/(assets\/[^"#?]+(?:[?#][^"]*)?)"/g, (_match, attr, path) => {
    return `${attr}="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  }).replace(/\bhref="\/(favicon[^"#?]*(?:[?#][^"]*)?)"/g, (_match, path) => {
    return `href="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  }).replace(/\bhref="\/(apple-touch-icon[^"#?]*(?:[?#][^"]*)?)"/g, (_match, path) => {
    return `href="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  });

  return transformRootAssetUrls(transformed, ingressPath);
}

function transformJavaScript(content, ingressPath) {
  return transformRootAssetUrls(content, ingressPath)
    .replace(/if\("serviceWorker"in navigator\)\{/g, 'if(false&&"serviceWorker"in navigator){');
}

function transformCss(content, ingressPath) {
  return transformRootAssetUrls(content, ingressPath);
}

function decodeBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding || "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "gzip") return zlib.gunzipSync(buffer);
  if (encoding === "deflate") return zlib.inflateSync(buffer);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer);
  throw new Error(`Unsupported content encoding: ${contentEncoding}`);
}

// Provider OAuth loopback bridge.
//
// OpenCode's browser sign-in methods (for example "ChatGPT Pro/Plus (browser)")
// start a callback HTTP server on a loopback port *inside this container* and
// send the browser to http://localhost:<port>/auth/callback. That works when the
// browser runs on the same machine as OpenCode; behind Home Assistant Ingress the
// browser is on the user's own device, so the redirect lands on their machine,
// nothing answers, and the authorization code never reaches the listener. The
// pending POST /provider/<id>/oauth/callback then waits on that listener forever
// -- the pasted code is ignored for these "auto" methods -- so OpenChamber sits
// on "Saving..." until the request deadline expires (issue #54).
//
// Bridge it locally instead: remember the loopback redirect URI and state from
// the authorize response, and when the user pastes the code, replay the redirect
// to the in-container listener before forwarding the callback request. The
// listener resolves, OpenCode exchanges the code, and the pending request
// completes normally. The replay is best effort and never changes what is
// forwarded upstream, so providers that do not use a loopback callback -- and
// methods that consume the pasted code themselves -- are unaffected.
const OAUTH_AUTHORIZE_PATTERN = /^\/api\/provider\/([^/?#]+)\/oauth\/authorize(?:[?#]|$)/;
const OAUTH_CALLBACK_PATTERN = /^\/api\/provider\/([^/?#]+)\/oauth\/callback(?:[?#]|$)/;
const OAUTH_BRIDGE_TTL_MS = 15 * 60 * 1000;
const OAUTH_BRIDGE_TIMEOUT_MS = 10000;
// A callback payload is a small JSON object ({ method, code }); anything beyond
// this is not something we should be buffering.
const OAUTH_CALLBACK_BODY_LIMIT = 256 * 1024;

const pendingOauthRedirects = new Map();

function matchProviderOauth(upstreamPath, pattern) {
  const match = upstreamPath.match(pattern);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1" || /^127\./.test(host);
}

function loopbackHostCandidates(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  // Node binds "localhost" to whichever address family the resolver returns
  // first, so try both loopback literals instead of guessing which one won.
  return host === "localhost" ? ["127.0.0.1", "::1"] : [host];
}

function oauthAuthorizationPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.data && typeof payload.data === "object") return payload.data;
  return payload;
}

function rememberOauthRedirect(providerID, payload) {
  const body = oauthAuthorizationPayload(payload);
  if (!body || typeof body.url !== "string" || !body.url) return null;

  // "code" methods hand the pasted code to the provider themselves and need no
  // bridging. Anything else is treated as a candidate, and the loopback check
  // below decides: a provider that redirects somewhere reachable never arms.
  const mode = typeof body.method === "string" ? body.method : typeof body.mode === "string" ? body.mode : "";
  if (mode === "code") return null;

  let authorizeUrl;
  try {
    authorizeUrl = new URL(body.url);
  } catch {
    return null;
  }

  const redirectValue = authorizeUrl.searchParams.get("redirect_uri");
  if (!redirectValue) return null;

  let redirect;
  try {
    redirect = new URL(redirectValue);
  } catch {
    return null;
  }

  // Loopback OAuth callbacks are plain HTTP; keeping this to http:// also keeps
  // the replay below on the http module.
  if (redirect.protocol !== "http:" || !isLoopbackHostname(redirect.hostname)) return null;

  const entry = {
    redirectUri: redirect.toString(),
    label: `${redirect.origin}${redirect.pathname}`,
    state: authorizeUrl.searchParams.get("state") || "",
    expires: Date.now() + OAUTH_BRIDGE_TTL_MS,
  };
  pendingOauthRedirects.set(providerID, entry);
  console.log(`OAuth loopback bridge armed for provider "${providerID}" (${entry.label})`);
  return entry;
}

function oauthBridgeInstructions(entry) {
  return `Complete the sign-in in your browser. The redirect to ${entry.label} cannot reach this`
    + " add-on, so that page will fail to load. Copy the whole URL from your browser's address bar,"
    + " paste it below, then select Complete.";
}

// Returns the rewritten authorize response body when the bridge was armed, or
// null to forward the upstream bytes untouched.
function armOauthBridge(providerID, decoded) {
  // A new authorization supersedes whatever was pending for this provider, even
  // when it turns out not to need bridging -- never replay a stale redirect.
  pendingOauthRedirects.delete(providerID);

  let payload;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }

  const entry = rememberOauthRedirect(providerID, payload);
  if (!entry) return null;

  // Upstream's copy ("this window will close automatically") describes the
  // same-machine flow. Tell the user what actually happens behind Ingress.
  const body = oauthAuthorizationPayload(payload);
  body.instructions = oauthBridgeInstructions(entry);
  try {
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return null;
  }
}

function readCallbackCode(body) {
  try {
    const payload = JSON.parse(body.toString("utf8"));
    return payload && typeof payload === "object" ? payload.code : null;
  } catch {
    return null;
  }
}

function searchParamsFrom(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).searchParams;
    } catch {
      return null;
    }
  }
  if (/(^|[?&])code=/.test(value)) {
    try {
      return new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
    } catch {
      return null;
    }
  }
  return null;
}

// Accepts the bare authorization code or the whole redirect URL the browser
// failed to open, so users do not have to dig the code out of the address bar.
function parsePastedCode(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  const params = searchParamsFrom(value);
  const code = params ? params.get("code") : null;
  if (code) return { code, state: params.get("state") || "" };
  return { code: value, state: "" };
}

function requestLoopback(target) {
  const port = Number.parseInt(target.port, 10) || 80;
  const path = `${target.pathname}${target.search}`;
  const attempt = (host) => new Promise((resolve) => {
    const request = http.request(
      { host, port, path, method: "GET", headers: { host: target.host } },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.setTimeout(OAUTH_BRIDGE_TIMEOUT_MS, () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });

  return loopbackHostCandidates(target.hostname).reduce(
    (chain, host) => chain.then((delivered) => (delivered ? true : attempt(host))),
    Promise.resolve(false),
  );
}

// Resolves to "skipped" (nothing armed for this provider), "expired",
// "delivered", or "failed" (armed, but the listener could not be reached).
function deliverOauthCode(providerID, pasted) {
  const entry = pendingOauthRedirects.get(providerID);
  if (!entry) return Promise.resolve("skipped");
  if (entry.expires <= Date.now()) {
    pendingOauthRedirects.delete(providerID);
    return Promise.resolve("expired");
  }

  let target;
  try {
    target = new URL(entry.redirectUri);
  } catch {
    return Promise.resolve("skipped");
  }

  target.searchParams.set("code", pasted.code);
  const state = pasted.state || entry.state;
  if (state) target.searchParams.set("state", state);

  return requestLoopback(target).then((delivered) => (delivered ? "delivered" : "failed"));
}

function bridgeOauthCallback(req, res, ingressPath, upstreamPath, providerID) {
  const chunks = [];
  let size = 0;
  let rejected = false;

  const reject = (statusCode, message) => {
    rejected = true;
    if (res.headersSent) return;
    res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
    res.once("finish", () => req.destroy());
    res.end(`${message}\n`);
  };

  req.on("data", (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > OAUTH_CALLBACK_BODY_LIMIT) {
      reject(413, "OAuth callback payload too large");
      return;
    }
    chunks.push(chunk);
  });

  req.on("error", () => {
    if (rejected) return;
    reject(400, "Malformed OAuth callback request");
  });

  req.on("end", () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
    const forward = () => forwardRequest(req, res, { ingressPath, upstreamPath, body });
    const pasted = parsePastedCode(readCallbackCode(body));
    if (!pasted) {
      forward();
      return;
    }

    deliverOauthCode(providerID, pasted)
      .then((result) => {
        if (result === "delivered") {
          console.log(`OAuth loopback bridge delivered the authorization code for provider "${providerID}"`);
          return;
        }
        if (result === "expired") {
          console.error(
            `OAuth loopback bridge expired for provider "${providerID}"; start the sign-in again.`,
          );
          return;
        }
        if (result === "failed") {
          const entry = pendingOauthRedirects.get(providerID);
          console.error(
            `OAuth loopback bridge could not reach ${entry ? entry.label : "the callback listener"}`
            + ` for provider "${providerID}"; sign-in will not complete.`,
          );
        }
      })
      .catch((error) => {
        console.error(`OAuth loopback bridge failed for provider "${providerID}": ${error.message}`);
      })
      .then(forward)
      .catch((error) => {
        console.error(`OAuth loopback bridge could not forward the callback: ${error.message}`);
        if (res.headersSent) return;
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("OpenChamber upstream unavailable\n");
      });
  });
}

function relayOauthAuthorizeResponse(upstreamRes, res, responseHeaders, providerID) {
  const chunks = [];
  upstreamRes.on("data", (chunk) => chunks.push(chunk));
  upstreamRes.on("end", () => {
    const raw = Buffer.concat(chunks);
    const statusCode = upstreamRes.statusCode || 200;
    let rewritten = null;
    if (statusCode < 400) {
      try {
        rewritten = armOauthBridge(providerID, decodeBody(raw, responseHeaders["content-encoding"]));
      } catch (error) {
        console.error(`OAuth loopback bridge could not read the authorize response: ${error.message}`);
      }
    }

    if (!rewritten) {
      res.writeHead(statusCode, responseHeaders);
      res.end(raw);
      return;
    }

    delete responseHeaders["content-length"];
    delete responseHeaders["content-encoding"];
    delete responseHeaders.etag;
    res.writeHead(statusCode, responseHeaders);
    res.end(rewritten);
  });
}

function proxyRequest(req, res) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  if (!isAllowedRemote(remoteAddress)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }

  const ingressPath = ingressPathFromRequest(req);
  const upstreamPath = stripIngressPath(req.url || "/", ingressPath);

  // Canned "you are up to date" response for OpenChamber's update check.
  // OpenChamber is pinned and Ingress-patched at image build time, and its
  // self-update (an npm reinstall of @openchamber/web) cannot persist across
  // restarts or stay patched for Ingress here -- it only hangs the UI on
  // "Waiting for server...". OPENCHAMBER_UPDATE_API_URL points the server-side
  // check at this endpoint so it always reports no update, which also makes the
  // POST /api/openchamber/update-install route return "No update available"
  // instead of running the doomed reinstall. The posted currentVersion is
  // echoed back as latestVersion so the check resolves to available:false
  // (the server discards a latestVersion older than currentVersion).
  if (upstreamPath.split("?", 1)[0] === "/__ha_openchamber_update_check") {
    const respond = (latestVersion) => {
      if (res.headersSent) return;
      res.writeHead(200, noStoreHeaders({
        "content-type": "application/json; charset=utf-8",
      }));
      res.end(JSON.stringify({ latestVersion, updateAvailable: false }));
    };
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // A version-check payload is tiny; drop anything unreasonable.
      if (body.length > 65536) req.destroy();
    });
    req.on("end", () => {
      // Fall back to a sentinel that is never older than the real version, so
      // the server never treats the response as a stale downgrade.
      let latestVersion = "99999.0.0";
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.currentVersion === "string" && parsed.currentVersion.trim()) {
          latestVersion = parsed.currentVersion.trim();
        }
      } catch {
        // Malformed/empty body: keep the sentinel version.
      }
      respond(latestVersion);
    });
    req.on("error", () => respond("99999.0.0"));
    return;
  }

  if (upstreamPath.split("?", 1)[0] === "/__openchamber_ingress_runtime.js") {
    res.writeHead(200, noStoreHeaders({
      "content-type": "application/javascript; charset=utf-8",
    }));
    res.end(ingressRuntimeScript(ingressPath));
    return;
  }

  if (upstreamPath.split("?", 1)[0] === "/sw.js") {
    res.writeHead(200, noStoreHeaders({
      "content-type": "application/javascript; charset=utf-8",
      "service-worker-allowed": ingressPath ? `${ingressPath}/` : "/",
    }));
    res.end(serviceWorkerResetScript());
    return;
  }

  const oauthCallbackProviderID = req.method === "POST"
    ? matchProviderOauth(upstreamPath, OAUTH_CALLBACK_PATTERN)
    : "";
  if (oauthCallbackProviderID) {
    bridgeOauthCallback(req, res, ingressPath, upstreamPath, oauthCallbackProviderID);
    return;
  }

  forwardRequest(req, res, {
    ingressPath,
    upstreamPath,
    oauthAuthorizeProviderID: req.method === "POST"
      ? matchProviderOauth(upstreamPath, OAUTH_AUTHORIZE_PATTERN)
      : "",
  });
}

function forwardRequest(req, res, { ingressPath, upstreamPath, body = null, oauthAuthorizeProviderID = "" }) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = forwardedProto(req);
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;

  const upstreamReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: upstreamPath,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    if (responseHeaders.location) {
      responseHeaders.location = transformLocationHeader(responseHeaders.location, ingressPath);
    }

    const contentType = String(upstreamRes.headers["content-type"] || "");
    if (oauthAuthorizeProviderID && contentType.includes("application/json")) {
      relayOauthAuthorizeResponse(upstreamRes, res, responseHeaders, oauthAuthorizeProviderID);
      return;
    }

    const isHtml = contentType.includes("text/html");
    const isJavaScript = /(?:application|text)\/javascript|\bmodule\b/.test(contentType);
    const isCss = contentType.includes("text/css");
    if (!isHtml && !isJavaScript && !isCss) {
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const decoded = decodeBody(Buffer.concat(chunks), responseHeaders["content-encoding"]);
      const text = decoded.toString("utf8");
      const body = isHtml
        ? transformHtml(text, ingressPath)
        : isCss
          ? transformCss(text, ingressPath)
          : transformJavaScript(text, ingressPath);
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders.etag;
      Object.assign(responseHeaders, noStoreHeaders());
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });

  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`OpenChamber upstream unavailable: ${error.message}\n`);
  });

  if (body === null) {
    req.pipe(upstreamReq);
    return;
  }
  upstreamReq.end(body);
}

function proxyUpgrade(req, socket, head) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  if (!isAllowedRemote(remoteAddress)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const ingressPath = ingressPathFromRequest(req);
  const upstreamPath = stripIngressPath(req.url || "/", ingressPath);
  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = forwardedProto(req);
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;

  const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstreamSocket.write(`${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) upstreamSocket.write(`${name}: ${entry}\r\n`);
      } else if (value !== undefined) {
        upstreamSocket.write(`${name}: ${value}\r\n`);
      }
    }
    upstreamSocket.write("\r\n");
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
}

const server = http.createServer(proxyRequest);
server.on("upgrade", proxyUpgrade);
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`OpenChamber ingress proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Forwarding to http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
