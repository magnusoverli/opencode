import { createServer } from "node:http";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeResultSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReadServer } from "./ha-facing-backend.js";
import { createAuthorization, equal, SCOPE, HttpError, requireThat, selectAuthMode } from "./ha-facing-auth.js";

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function pairs(params) {
  const result = Object.create(null);
  for (const [key, value] of params) {
    requireThat(!Object.hasOwn(result, key));
    result[key] = value;
  }
  return result;
}
async function body(req, type) {
  requireThat(req.headers["content-type"]?.split(";")[0].trim() === type, 415, "unsupported_media_type");
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 32768, 413, "request_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (type === "application/x-www-form-urlencoded") return pairs(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { throw new HttpError(400, "invalid_json"); }
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function html(res, content, callback) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    // no-referrer makes Chromium send Origin:null on form POSTs. Keep the
    // origin for CSRF checks without disclosing the Ingress path or query.
    "Referrer-Policy": "strict-origin", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; form-action 'self'${callback ? ` ${new URL(callback).href}` : ""}; frame-ancestors 'self'; base-uri 'none'`,
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Home Assistant MCP</title><body><h1>Home Assistant Read-Only MCP</h1>${content}</body></html>`);
}

/**
 * Two listeners, deliberately not one proxyable OAuth surface. The internal
 * Core HTTP network uses a trusted host peer or existing OAuth credentials;
 * it must not be host-published. Browser setup/consent uses HA Ingress only.
 * The router must verify Supervisor source + identity and replace all four
 * X-HA-MCP-* headers. The shared secret is never forwarded from the browser.
 */
export async function startHaFacing({ state, resourceUrl, ingressSecret, verifyAdmin, backendFactory,
  coreHost = "0.0.0.0", corePort = 8766, ipcPort = 8767, callTimeout,
  authMode = selectAuthMode(state), trustedPeer,
}) {
  const resource = new URL(resourceUrl);
  requireThat(resource.protocol === "http:" && resource.pathname === "/mcp" && !resource.search && !resource.hash && !resource.username && !resource.password);
  requireThat(authMode === "oauth" || authMode === "trusted_host", 500, "invalid_auth_mode");
  const trusted = authMode === "trusted_host";
  requireThat(!trusted || (state.data.client === null && typeof trustedPeer === "string" && isIP(trustedPeer) === 4), 500, "invalid_core_peer");
  const auth = trusted ? null : createAuthorization(state, resource.href);
  const sessions = new Map();
  const pending = new Set();
  let closing = false;
  let authRequests = 0; let windowStart = Date.now(); let ipcRequests = 0;
  function rateLimit() {
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); authRequests = 0; }
    requireThat(++authRequests <= 120, 429, "too_many_requests");
  }
  async function dispose(session) {
    if (session.closed) return;
    session.closed = true; sessions.delete(session.id);
    await Promise.allSettled([session.server.close(), session.backend.close()]);
  }
  async function reap() {
    const now = Date.now();
    await Promise.all([...sessions.values()].filter((session) =>
      session.idle < now - 300000 || session.created < now - 3600000 ||
      (!trusted && !state.data.grants.some((grant) => grant.id === session.grantId && grant.expires > now))
    ).map(dispose));
  }
  function handler(fn, coreRequest = false) {
    return (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      Promise.resolve().then(() => {
        requireThat(!closing && state.healthy !== false, 503, "unavailable");
        if (coreRequest && trusted) {
          const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
          requireThat(peer === trustedPeer, 403, "untrusted_host");
        }
        requireThat(req.url.length <= 8192 && req.url.startsWith("/") && !req.url.startsWith("//"));
        return fn(req, res, new URL(req.url, resource.origin));
      }).catch((error) => {
        if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.message : "server_error" });
        else res.destroy();
      });
    };
  }
  const core = createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, handler(async (req, res, url) => {
    requireThat(req.headers.host === resource.host && !req.headers.origin, 403, "forbidden_origin");
    if (trusted) {
      requireThat(url.pathname === "/mcp", 404, "not_found");
    }
    if (req.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) {
      return json(res, 200, { resource: resource.href, authorization_servers: [resource.origin], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      requireThat(state.data.client, 503, "setup_required");
      return json(res, 200, { issuer: resource.origin, authorization_endpoint: state.data.client.authorizationUrl,
        token_endpoint: `${resource.origin}/token`, revocation_endpoint: `${resource.origin}/revoke`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post"], revocation_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"], scopes_supported: [SCOPE],
      });
    }
    if (["/token", "/revoke"].includes(url.pathname)) {
      requireThat(req.method === "POST", 405, "method_not_allowed"); rateLimit();
      requireThat(!req.headers.authorization && !url.search);
      const params = await body(req, "application/x-www-form-urlencoded");
      if (url.pathname === "/token") return json(res, 200, auth.exchange(params));
      auth.revoke(params); await reap(); return json(res, 200, {});
    }
    requireThat(url.pathname === "/mcp", 404, "not_found");
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || "");
    const grant = trusted ? { id: "trusted-host" } : bearer && auth.verify(bearer[1]);
    if (!grant) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`);
      return json(res, 401, { error: "invalid_token" });
    }
    requireThat(!url.search);
    // No standalone SSE stream: all replies are bounded JSON POST responses.
    requireThat(req.method === "POST" || req.method === "DELETE", 405, "method_not_allowed");
    const id = req.headers["mcp-session-id"];
    let session = id && sessions.get(id);
    if (session && (session.idle < Date.now() - 300000 || session.created < Date.now() - 3600000)) {
      await dispose(session); session = undefined;
    }
    if (id) requireThat(session && session.grantId === grant.id && !session.closed, 404, "session_not_found");
    if (req.method === "DELETE") {
      requireThat(session, 404, "session_not_found"); await dispose(session); return json(res, 200, {});
    }
    const message = await body(req, "application/json");
    requireThat(message && !Array.isArray(message) && typeof message === "object");
    if (session && message.method === "initialize") {
      // HA validates an already-initialized session by initializing it again.
      // Replay only the completed SDK negotiation; never reset its state.
      requireThat(JSONRPCRequestSchema.safeParse(message).success && isInitializeRequest(message) && session.initialization &&
        isDeepStrictEqual(message.params, session.initialization.params) &&
        req.headers["mcp-protocol-version"] === session.initialization.result.protocolVersion,
      400, "initialize_mismatch");
      requireThat(req.headers.accept?.includes("application/json") && req.headers.accept.includes("text/event-stream"), 406, "not_acceptable");
      session.idle = Date.now();
      res.setHeader("Mcp-Session-Id", session.id);
      return json(res, 200, { jsonrpc: "2.0", id: message.id, result: session.initialization.result });
    }
    if (!session) {
      requireThat(isInitializeRequest(message), 400, "initialize_required");
      requireThat(sessions.size + pending.size < 8, 429, "session_limit");
      const reservation = {}; pending.add(reservation);
      let backend; let server;
      try {
        backend = await backendFactory();
        server = await createReadServer(backend, { timeout: callTimeout });
        requireThat(!closing && state.healthy !== false, 503, "unavailable");
        requireThat(trusted || auth.verify(bearer[1]), 401, "invalid_token");
        session = { id: randomUUID(), grantId: grant.id, backend, server, created: Date.now(), idle: Date.now(), requests: 0 };
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => session.id, enableJsonResponse: true });
        session.transport = transport;
        const send = transport.send.bind(transport);
        transport.send = async (reply, options) => {
          await send(reply, options);
          if (reply.id === message.id && InitializeResultSchema.safeParse(reply.result).success) {
            session.initialization = { params: structuredClone(message.params), result: structuredClone(reply.result) };
            transport.send = send;
          }
        };
        await server.connect(transport);
        sessions.set(session.id, session);
      } catch (error) {
        await Promise.allSettled([backend?.close(), server?.close()]); throw error;
      } finally { pending.delete(reservation); }
    }
    requireThat(session.requests < 2, 429, "request_limit");
    session.requests++; session.idle = Date.now();
    try { await session.transport.handleRequest(req, res, message); }
    catch (error) { await dispose(session); throw error; }
    finally { session.requests--; }
  }, true));

  const ipc = createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, handler(async (req, res, url) => {
    requireThat(req.socket.remoteAddress === "127.0.0.1" && equal(req.headers["x-ha-mcp-ingress-secret"], ingressSecret), 403, "untrusted_ingress");
    if (req.method === "GET" && url.pathname === "/ha-mcp/status") {
      return json(res, 200, { ready: trusted || Boolean(state.data.client), url: resource.href, authMode });
    }
    requireThat(ipcRequests < 4, 429, "too_many_requests");
    ipcRequests++;
    try {
      const user = req.headers["x-ha-mcp-user-id"];
      const origin = req.headers["x-ha-mcp-external-origin"];
      const externalPath = req.headers["x-ha-mcp-external-path"];
      let external;
      try { external = new URL(origin); } catch { throw new HttpError(403, "invalid_ingress_origin"); }
      requireThat(external.origin === origin && ["http:", "https:"].includes(external.protocol) && !external.username && !external.password, 403, "invalid_ingress_origin");
      requireThat(typeof externalPath === "string" && /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/ha-mcp\/(?:authorize)?$/.test(externalPath) && externalPath.endsWith(url.pathname), 403, "invalid_ingress_path");
      const base = externalPath.slice(0, externalPath.length - url.pathname.length) + "/ha-mcp/";
      requireThat(typeof user === "string" && await verifyAdmin(user), 403, "administrator_required");
      const path = url.pathname;
      requireThat(path === "/ha-mcp/" || path === "/ha-mcp/authorize", 404, "not_found");
      if (trusted) {
        requireThat(path === "/ha-mcp/", 404, "not_found");
        requireThat(req.method === "GET", 403, "trusted_host_setup_automatic");
        return html(res, `<p>Trusted-host access is ready. Automatic discovery requires Home Assistant Core app-MCP discovery support, expected in 2026.10. On supported versions, confirm the discovered integration in Home Assistant, then select its API for your conversation agent. Publishing readiness does not prove confirmation. No client credentials need to be copied.</p><p>Access includes installation-wide home states, entity details, devices, areas and calendars, not only Assist-exposed entities. No control or configuration tools are available.</p><p>The internal HTTP endpoint trusts the Supervisor-reported host gateway. Other host processes and host-network apps may also read this data; access is not unique to Core. Do not publish port 8766. HTTP or HTTPS Home Assistant browser access is supported.</p><p>Optional endpoint for manual legacy integration setup: <code>${escape(resource.href)}</code></p>`);
      }
      requireThat(req.method === "GET" || req.method === "POST", 405, "method_not_allowed");
      if (req.method === "POST") requireThat(req.headers.origin === origin, 403, "invalid_csrf_origin");
      if (path === "/ha-mcp/") {
        if (req.method === "GET") {
          const nonce = auth.form(user, origin, base, "setup");
          return html(res, `<p><strong>Retained OAuth mode.</strong> This installation retains its provisioned OAuth authentication, so manual credential setup and consent remain available.</p><p>Provision one confidential Home Assistant OAuth client. Replacing it revokes all existing grants. Access includes home state, devices, areas and calendars, not only Assist-exposed entities.</p><p>Core credentials and tokens use the trusted internal HTTP container network. Do not publish port 8766.</p><form method="post" action="${escape(base)}"><input type="hidden" name="csrf" value="${nonce}"><label>Exact Home Assistant callback (HTTP or HTTPS /auth/external/callback, or HTTPS My Home Assistant) <input name="redirect_uri" required size="65" value="${escape(state.data.client?.redirect || "https://my.home-assistant.io/redirect/oauth")}"></label><p><label><input type="checkbox" name="approved" value="yes" required>I approve provisioning or replacing this client and revoking existing access.</label></p><button name="action" value="provision">Provision client</button></form>`);
        }
        requireThat(!url.search);
        const params = await body(req, "application/x-www-form-urlencoded");
        auth.consumeForm(params.csrf, user, origin, base, "setup");
        requireThat(params.approved === "yes" && params.action === "provision");
        const credentials = auth.provision(params.redirect_uri, `${origin}${base}authorize`);
        await reap();
        return html(res, `<p>Enter these application credentials in Home Assistant's MCP integration. The secret is shown once; it is not stored in plaintext. Provision again to replace it.</p><p>MCP endpoint for manual setup: <code>${escape(resource.href)}</code></p><dl><dt>Client ID</dt><dd><code>${escape(credentials.client_id)}</code></dd><dt>Client secret</dt><dd><code>${escape(credentials.client_secret)}</code></dd></dl><p>Discovery is now ready. If the browser's Ingress cookie expires, reopen the add-on from Home Assistant, then retry authorization. Reprovision only if the external origin or app Ingress path changes. No direct authorization bypass exists.</p>`);
      }
      requireThat(state.data.client?.authorizationUrl === `${origin}${base}authorize`, 403, "ingress_session_changed");
      if (req.method === "GET") {
        const request = auth.authorizationRequest(pairs(url.searchParams));
        const nonce = auth.form(user, origin, base, "consent", request);
        return html(res, `<p>Client <code>${escape(request.clientId)}</code> requests <strong>${SCOPE}</strong>: read home states, entity details, areas, devices and calendars. This is installation-wide, not limited to Assist exposure. No control or configuration tools are available.</p><p>Callback: <code>${escape(request.redirect)}</code></p><form method="post" action="${escape(base)}authorize"><input type="hidden" name="csrf" value="${nonce}"><button name="decision" value="approve">Approve read-only access</button> <button name="decision" value="deny">Deny</button></form>`, request.redirect);
      }
      requireThat(!url.search);
      const params = await body(req, "application/x-www-form-urlencoded");
      const request = auth.consumeForm(params.csrf, user, origin, base, "consent");
      requireThat(params.decision === "approve" || params.decision === "deny");
      let redirect;
      if (params.decision === "approve") redirect = auth.approve(request, user);
      else {
        const target = new URL(request.redirect); target.searchParams.set("error", "access_denied"); target.searchParams.set("state", request.state); redirect = target.href;
      }
      res.writeHead(303, { Location: redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end();
    } finally { ipcRequests--; }
  }));
  core.maxConnections = 64; ipc.maxConnections = 16;
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  const stop = (server) => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  });
  try { await listen(core, corePort, coreHost); await listen(ipc, ipcPort, "127.0.0.1"); }
  catch (error) { await Promise.all([stop(core), stop(ipc)]); throw error; }
  const timer = setInterval(() => { reap().catch(() => {}); }, 1000).unref();
  return {
    corePort: core.address().port, ipcPort: ipc.address().port,
    async close() {
      closing = true; clearInterval(timer);
      await Promise.all([...sessions.values()].map(dispose));
      await Promise.all([stop(core), stop(ipc)]);
    },
  };
}
