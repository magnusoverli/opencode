import http from "node:http";
import { BlockList, isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest();
const normalizeIp = (ip = "") => ip.startsWith("::ffff:") ? ip.slice(7) : ip;
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function cleanHeaders(headers, websocket = false) {
  const result = { ...headers };
  const connection = String(headers.connection || "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connection]) delete result[name];
  for (const name of Object.keys(result)) {
    if (name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("x-ingress-") || name.startsWith("x-ha-")) delete result[name];
  }
  if (websocket) { result.connection = "Upgrade"; result.upgrade = "websocket"; }
  return result;
}

// Origins of OpenChamber's packaged clients (desktop, iOS, Android WebViews).
// OpenChamber's own server grants CORS to exactly these.
export const NATIVE_APP_ORIGINS = Object.freeze(["openchamber-ui://app", "capacitor://localhost", "https://localhost"]);

export function createLanProxy({ mode, origin, proxies, corsOrigins = [], nativeApps = false, password, backendPassword, upstreamPort }) {
  if (!["api", "ui"].includes(mode)) throw new Error("Invalid LAN proxy mode");
  const publicUrl = new URL(origin);
  const trusted = new BlockList();
  for (const value of proxies) {
    const ip = normalizeIp(value);
    trusted.addAddress(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  }
  const nativeApp = mode === "ui" && nativeApps === true;
  const nativeOrigins = new Set(nativeApp ? NATIVE_APP_ORIGINS : []);
  const allowedOrigins = new Set([origin, ...(mode === "api" ? corsOrigins : []), ...nativeOrigins]);
  const lanAuthorization = hash(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
  const upstreamAuthorization = mode === "api" ? `Basic ${Buffer.from(`opencode:${backendPassword}`).toString("base64")}` : null;
  const sockets = new Set();
  const outgoing = new Set();

  function authorize(req, upgrade) {
    const remote = normalizeIp(req.socket.remoteAddress);
    if (!isIP(remote) || !trusted.check(remote, isIP(remote) === 6 ? "ipv6" : "ipv4")) return 403;
    if (req.headers.host?.toLowerCase() !== publicUrl.host || req.headers["x-forwarded-proto"] !== "https") return 403;
    if (req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"].toLowerCase() !== publicUrl.host) return 403;
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && !allowedOrigins.has(originHeader)) return 403;
    if (mode === "ui" && (upgrade || !["GET", "HEAD", "OPTIONS"].includes(req.method)) && originHeader !== origin
      // Browsers always send Origin on writes, so a missing one is a non-browser
      // client (the desktop shell's main-process login) that cannot be forged cross-site.
      && !(nativeApp && (originHeader === undefined || nativeOrigins.has(originHeader)))) return 403;
    // The nearest trusted proxy must overwrite X-Forwarded-For with one IP.
    // Do not let an arbitrary list become OpenChamber's login rate-limit key.
    if (typeof req.headers["x-forwarded-for"] !== "string" || !isIP(req.headers["x-forwarded-for"])) return 403;
    let path;
    try {
      if (!req.url.startsWith("/") || req.url.startsWith("//") || /[\\\x00-\x20]/.test(req.url)) return 400;
      path = decodeURIComponent(new URL(req.url, origin).pathname);
      if (path.includes("%") || path.includes("\\")) return 400;
    } catch { return 400; }
    if (path.startsWith("/api/ha-editor-lsp") || path.startsWith("/api/hassio_ingress") || path.startsWith("/__ha") || path === "/ha-mcp" || path.startsWith("/ha-mcp/")) return 403;
    if (mode === "api") {
      if (!(path.startsWith("/api/") || path === "/openapi.json")) return 404;
      if (req.method === "OPTIONS" && originHeader && req.headers["access-control-request-method"]) return 204;
      if (!timingSafeEqual(hash(String(req.headers.authorization || "")), lanAuthorization)) return 401;
    }
    return 0;
  }

  function cors(req) {
    return mode === "api" && allowedOrigins.has(req.headers.origin) ? {
      "access-control-allow-origin": req.headers.origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-opencode-directory, x-opencode-worktree, x-opencode-ticket",
      vary: "Origin",
    } : {};
  }

  function headers(req, upgrade = false) {
    const result = cleanHeaders(req.headers, upgrade);
    result.host = publicUrl.host;
    result["x-forwarded-host"] = publicUrl.host;
    result["x-forwarded-proto"] = "https";
    result["x-forwarded-for"] = req.headers["x-forwarded-for"];
    if (mode === "api") {
      result.authorization = upstreamAuthorization;
      delete result.cookie;
      // Origin has already been checked here. Keep backend CORS independent.
      delete result.origin;
    }
    return result;
  }

  function responseHeaders(req, source) {
    const result = cleanHeaders(source);
    // OpenChamber answers packaged-app origins with its own CORS headers; keep them.
    if (!nativeOrigins.has(req.headers.origin)) {
      for (const name of Object.keys(result)) if (name.startsWith("access-control-")) delete result[name];
    }
    return { ...result, ...cors(req), "cache-control": "no-store" };
  }

  function reject(req, res, status) {
    req.resume();
    res.writeHead(status, { ...cors(req), "cache-control": "no-store", "content-type": "text/plain",
      ...(status === 401 ? { "www-authenticate": 'Basic realm="OpenCode LAN", charset="UTF-8"' } : {}),
    });
    res.end(status === 204 ? undefined : "LAN request denied\n");
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const denied = authorize(req, false);
    if (denied) return reject(req, res, denied);
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers: headers(req) }, (reply) => {
      res.writeHead(reply.statusCode, responseHeaders(req, reply.headers));
      reply.on("error", () => res.destroy());
      reply.pipe(res);
    });
    outgoing.add(upstream);
    upstream.once("close", () => outgoing.delete(upstream));
    upstream.on("error", () => {
      if (!res.headersSent) { res.writeHead(502, { "cache-control": "no-store" }); res.end("Managed service unavailable\n"); }
      else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    const denied = authorize(req, true);
    if (denied || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end(`HTTP/1.1 ${denied || 400} Denied\r\nConnection: close\r\n\r\n`);
      return;
    }
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: req.url, method: "GET", headers: headers(req, true) });
    outgoing.add(upstream);
    upstream.once("close", () => outgoing.delete(upstream));
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (reply) => {
      socket.end(`HTTP/1.1 ${reply.statusCode} Denied\r\nConnection: close\r\n\r\n`);
      reply.resume();
    });
    upstream.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
      const safe = cleanHeaders(reply.headers, true);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(safe).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      socket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  return {
    server,
    async close() {
      for (const request of outgoing) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
