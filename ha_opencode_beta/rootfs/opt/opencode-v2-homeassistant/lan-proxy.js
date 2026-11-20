import http from "node:http";
import https from "node:https";
import { directSubnet as parseSubnet } from "./direct-lan.js";
import { BlockList, isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { createLanPairing } from "./lan-pairing.js";

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
// Restrict the upstream's broader development CORS policy to these app origins.
export const NATIVE_APP_ORIGINS = Object.freeze(["openchamber-ui://app", "capacitor://localhost", "https://localhost"]);
// Renderer origin of the official OpenCode desktop app (Electron, custom "oc" scheme).
// Ordinary web pages cannot claim it; authentication is still required.
export const OPENCODE_DESKTOP_ORIGINS = Object.freeze(["oc://renderer"]);

export function createLanProxy({ mode, origin, proxies, corsOrigins = [], nativeApps = false, desktopApps = false, password, backendPassword, upstreamPort, directSubnet, tls }) {
  if (!["api", "ui"].includes(mode)) throw new Error("Invalid LAN proxy mode");
  const publicUrl = new URL(origin);
  const direct = mode === "api" && Boolean(directSubnet);
  const clients = direct ? parseSubnet(directSubnet) : null;
  const plainHttp = direct && publicUrl.protocol === "http:";
  if (!plainHttp && publicUrl.protocol !== "https:") throw new Error("Invalid LAN protocol");
  if (direct && (!clients || !desktopApps || (!plainHttp && (!tls?.cert || !tls?.key)))) throw new Error("Incomplete direct LAN settings");
  const trusted = new BlockList();
  for (const value of proxies) {
    const ip = normalizeIp(value);
    trusted.addAddress(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
  }
  const nativeApp = mode === "ui" && nativeApps === true;
  const nativeOrigins = new Set(nativeApp ? NATIVE_APP_ORIGINS : []);
  const desktopOrigins = mode === "api" && desktopApps === true ? OPENCODE_DESKTOP_ORIGINS : [];
  const allowedOrigins = new Set([origin, ...(mode === "api" ? corsOrigins : []), ...desktopOrigins, ...nativeOrigins]);
  const lanAuthorization = hash(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
  const upstreamAuthorization = mode === "api" ? `Basic ${Buffer.from(`opencode:${backendPassword}`).toString("base64")}` : null;
  const sockets = new Set();
  const outgoing = new Set();
  const deviceSockets = new Map();
  const requestPath = Symbol("lanPath");
  const administrator = Symbol("lanAdministrator");
  const device = Symbol("lanDevice");
  const cookieName = publicUrl.port ? `opencode_session_${publicUrl.port}` : "opencode_session";
  const pairing = mode === "api" ? createLanPairing({ onRevoke(id) {
    for (const [socket, ids] of deviceSockets) if (ids.has(id)) socket.destroy();
  } }) : null;

  function authorize(req, upgrade) {
    const remote = normalizeIp(req.socket.remoteAddress);
    if (req.headers.host?.toLowerCase() !== publicUrl.host) return 403;
    if (direct) {
      if ((!plainHttp && !req.socket.encrypted) || isIP(remote) !== 4 || !clients.check(remote, "ipv4")) return 403;
      if (Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-"))) return 403;
    } else {
      if (!isIP(remote) || !trusted.check(remote, isIP(remote) === 6 ? "ipv6" : "ipv4")) return 403;
      if (req.headers["x-forwarded-proto"] !== "https") return 403;
      if (req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"].toLowerCase() !== publicUrl.host) return 403;
      // Use a single overwritten client IP, never an untrusted forwarding chain.
      if (typeof req.headers["x-forwarded-for"] !== "string" || !isIP(req.headers["x-forwarded-for"])) return 403;
    }
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && !allowedOrigins.has(originHeader)) return 403;
    if (mode === "ui" && (upgrade || !["GET", "HEAD", "OPTIONS"].includes(req.method)) && originHeader !== origin
      // The desktop shell logs in without Origin; its renderer uses a packaged
      // origin. OpenChamber still authenticates the password/cookie/client token.
      && !(nativeApp && (originHeader === undefined || nativeOrigins.has(originHeader)))) return 403;
    let path;
    try {
      if (!req.url.startsWith("/") || req.url.startsWith("//") || /[\\\x00-\x20]/.test(req.url)) return 400;
      path = decodeURIComponent(new URL(req.url, origin).pathname);
      if (path.includes("%") || path.includes("\\")) return 400;
    } catch { return 400; }
    req[requestPath] = path;
    if (path.startsWith("/api/ha-editor-lsp") || path.startsWith("/api/hassio_ingress") || path.startsWith("/__ha") || /^\/ha-(?:mcp|assist)(?:\/|$)/.test(path)) return 403;
    if (mode === "api") {
      const redeem = req.method === "GET" && /^\/auth\/connect\/[A-Za-z0-9_-]{22}$/.test(path) && !upgrade;
      if (!(path.startsWith("/api/") || path === "/openapi.json" || redeem)) return 404;
      if (req.method === "OPTIONS" && originHeader && req.headers["access-control-request-method"]) return 204;
      req[administrator] = timingSafeEqual(hash(String(req.headers.authorization || "")), lanAuthorization);
      if (req[administrator]) deviceSockets.delete(req.socket);
      if (redeem) return 0; // The local handler atomically consumes the capability.
      if (!req[administrator]) {
        const encoded = /^Basic ([A-Za-z0-9+/=]{1,2048})$/i.exec(req.headers.authorization ?? "")?.[1];
        const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
        let id = decoded.startsWith("opencode:") ? pairing.authenticate(decoded.slice(9)) : null;
        if (!id) {
          const cookies = String(req.headers.cookie ?? "").split(";").map(value => value.trim());
          const matches = cookies.filter(value => value.startsWith(`${cookieName}=`));
          if (matches.length === 1) id = pairing.authenticate(matches[0].slice(cookieName.length + 1));
          if (id && (upgrade || !["GET", "HEAD"].includes(req.method)) && originHeader !== origin) return 403;
        }
        if (!id) return 401;
        req[device] = id;
        if (!deviceSockets.has(req.socket)) {
          deviceSockets.set(req.socket, new Set());
          req.socket.once("close", () => deviceSockets.delete(req.socket));
        }
        deviceSockets.get(req.socket).add(id);
      }
      // Only the administrator can issue pairings or inspect/revoke devices.
      if ((path === "/api/pair" || path.startsWith("/api/lan/devices")) && !req[administrator]) return 403;
    }
    return 0;
  }

  function cors(req) {
    return mode === "api" && allowedOrigins.has(req.headers.origin) ? {
      "access-control-allow-origin": req.headers.origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-opencode-capabilities, x-opencode-directory, x-opencode-worktree, x-opencode-ticket",
      vary: "Origin",
    } : {};
  }

  function headers(req, upgrade = false) {
    const result = cleanHeaders(req.headers, upgrade);
    result.host = publicUrl.host;
    result["x-forwarded-host"] = publicUrl.host;
    result["x-forwarded-proto"] = plainHttp ? "http" : "https";
    result["x-forwarded-for"] = direct ? normalizeIp(req.socket.remoteAddress) : req.headers["x-forwarded-for"];
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
    if (mode === "api") delete result["set-cookie"];
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

  const server = direct && !plainHttp
    ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2", maxHeaderSize: 16384 })
    : http.createServer({ maxHeaderSize: 16384 });
  server.on("request", (req, res) => {
    const denied = authorize(req, false);
    if (denied) return reject(req, res, denied);
    if (pairing) {
      const path = req[requestPath];
      const json = (status, data, extra = {}) => {
        req.resume();
        res.writeHead(status, { ...cors(req), "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra });
        res.end(JSON.stringify(data));
      };
      if (path === "/api/pair") {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
        const code = pairing.issue();
        return json(code ? 200 : 429, code ?? { error: "pairing_capacity_reached" });
      }
      if (path.startsWith("/auth/connect/")) {
        const result = pairing.consume(path.slice("/auth/connect/".length));
        if (!result) return json(401, { error: "pairing_expired_or_used" });
        if (req.headers.accept?.includes("text/html")) {
          req.resume();
          res.writeHead(303, { location: "/api/info", "cache-control": "no-store", "referrer-policy": "no-referrer",
            "set-cookie": `${cookieName}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
          return res.end();
        }
        return json(200, { token: result.token });
      }
      if (path === "/api/lan/devices") {
        if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
        return json(200, { devices: pairing.list(), restart_revokes_all: true });
      }
      if (path.startsWith("/api/lan/devices/")) {
        if (req.method !== "DELETE") return json(405, { error: "method_not_allowed" });
        const id = path.slice("/api/lan/devices/".length);
        if (!/^[a-f0-9]{24}$/.test(id)) return json(400, { error: "invalid_device" });
        return json(200, { revoked: pairing.revoke(id) });
      }
    }
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
      pairing?.close();
      for (const request of outgoing) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
