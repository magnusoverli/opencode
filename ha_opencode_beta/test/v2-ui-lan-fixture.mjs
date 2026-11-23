// Run against the exact OpenChamber authentication implementation in the image.
// No Supervisor, Home Assistant instance or model provider is contacted.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createLanProxy } from "/opt/opencode-v2-homeassistant/lan-proxy.js";

const root = await fs.mkdtemp("/tmp/ha-ui-lan-");
process.env.OPENCHAMBER_DATA_DIR = root;
process.env.OPENCHAMBER_AUTH_DIR = root;
const require = createRequire("/opt/openchamber-preview/packages/web/package.json");
const express = require("express");
const { createUiAuth } = await import("/opt/openchamber-preview/packages/web/build/server/lib/ui-auth/ui-auth.js");
const { createRemoteClientAuthRuntime } = await import("/opt/openchamber-preview/packages/web/build/server/lib/client-auth/remote-clients.js");
const clientAuth = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(root, "clients.json") });
const password = "fixture-ui-password-not-real";
const publicOrigin = "https://code.fixture.test";
const alias = new URL("https://tail.fixture.test:4097");
const makeAuth = () => createUiAuth({ password, clientAuthController: clientAuth, readSettingsFromDiskMigrated: async () => ({ publicOrigin }) });
let auth = makeAuth();
const appOrigin = "openchamber-ui://app";
const app = express();
// Match the pinned server's inline CORS middleware. Password, cookie and client
// token handling below use its real modules, not an authentication test double.
app.use((req, res, next) => {
  if ([appOrigin, "capacitor://localhost", "http://localhost", "https://localhost"].includes(req.headers.origin)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});
app.use(express.json());
app.post("/auth/session", (req, res) => auth.handleSessionCreate(req, res));
app.get("/auth/session", (req, res) => auth.handleSessionStatus(req, res));
app.use((req, res, next) => auth.requireAuth(req, res, next));
app.get("/fixture/passkeys", (req, res) => auth.handlePasskeyStatus(req, res));
app.post("/fixture/reset-auth", (req, res) => auth.handleResetAuth(req, res));
app.post("/api/fixture", (_req, res) => res.json({ ok: true }));
app.get("/api/event", (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); });
const upstream = http.createServer(app);
upstream.on("upgrade", async (req, socket) => {
  if (!await auth.resolveAuthContext(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  socket.on("error", () => {});
  socket.on("end", () => socket.end());
});
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
let proxy;
let strict;
try {
  const upstreamPort = await listen(upstream);
  const options = { mode: "ui", origin: publicOrigin, aliases: [alias.origin], proxies: ["127.0.0.1"], password, upstreamPort };
  proxy = createLanProxy({ ...options, nativeApps: true });
  strict = createLanProxy(options);
  const port = await listen(proxy.server);
  const strictPort = await listen(strict.server);
  const base = { host: "code.fixture.test", "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.1", accept: "application/json" };
  const request = ({ method = "GET", route = "/auth/session", headers = {}, body, target = port } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: target, path: route, method, headers: { ...base, ...headers }, signal: AbortSignal.timeout(5000) }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
  const login = (candidate, headers = {}, target = port) => request({ method: "POST", target,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: candidate, issueClientToken: true, clientKind: "desktop", clientLabel: "Fixture desktop" }) });
  assert.equal((await login(password, {}, strictPort)).status, 403);
  assert.equal((await login(password, { origin: appOrigin }, strictPort)).status, 403);
  assert.equal((await login("incorrect")).status, 401);
  const loggedIn = await login(password);
  assert.equal(loggedIn.status, 200);
  const { clientToken, client } = JSON.parse(loggedIn.text);
  assert.ok(clientToken && client.id);
  assert.ok(loggedIn.headers["set-cookie"].some(value => value.includes("HttpOnly") && value.includes("Secure") && value.includes("SameSite=Strict")));
  const cookie = loggedIn.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
  const headers = { origin: appOrigin, authorization: `Bearer ${clientToken}` };
  const aliasHeaders = { host: alias.host, origin: alias.origin };
  const aliasLogin = await login(password, aliasHeaders, strictPort);
  assert.equal(aliasLogin.status, 200);
  assert.match(aliasLogin.headers["set-cookie"][0], /^oc_ui_session_4097=/);
  const aliasCookie = aliasLogin.headers["set-cookie"][0].split(";")[0];
  for (const [origin, host, jar, foreign] of [
    [publicOrigin, new URL(publicOrigin).host, cookie, alias.origin],
    [alias.origin, alias.host, aliasCookie, publicOrigin],
  ]) {
    const h = { host, origin, cookie: jar };
    const status = await request({ route: "/fixture/passkeys", headers: h });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).rpID, new URL(origin).hostname);
    assert.equal((await request({ method: "POST", route: "/api/fixture", headers: { ...h, origin: foreign } })).status, 403);
  }
  const preflight = await request({ method: "OPTIONS", route: "/api/fixture", headers: { origin: appOrigin,
    "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], appOrigin);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.match(preflight.headers["access-control-allow-headers"], /authorization/i);
  assert.equal((await request({ method: "POST", route: "/api/fixture", headers: { origin: appOrigin } })).status, 401);
  assert.equal((await request({ method: "POST", route: "/api/fixture", headers })).status, 200);
  assert.equal((await request({ headers: { cookie, origin: publicOrigin } })).status, 200);
  for (const origin of ["null", "https://evil.test", "openchamber-ui://evil", "http://localhost"]) {
    assert.equal((await request({ method: "POST", route: "/api/fixture", headers: { ...headers, origin } })).status, 403);
  }
  for (const route of ["/api/ha-editor-lsp/diagnostics", "/ha-mcp", "/__ha_private"]) {
    assert.equal((await request({ route, headers })).status, 403);
  }
  const upgrade = (extra) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/event/ws", headers: { ...base, ...extra, connection: "Upgrade", upgrade: "websocket" } });
    req.on("error", reject);
    req.on("response", res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.end();
  });
  assert.equal((await upgrade({ origin: appOrigin })).status, 401);
  assert.equal((await upgrade({ ...headers, origin: "https://evil.test" })).status, 403);
  const ws = await upgrade(headers);
  assert.equal(ws.status, 101);
  assert.equal((await upgrade({ ...aliasHeaders, origin: publicOrigin, cookie: aliasCookie })).status, 403);
  const aliasWs = await upgrade({ ...aliasHeaders, cookie: aliasCookie });
  assert.equal(aliasWs.status, 101);
  aliasWs.socket.destroy();
  const stream = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/event", headers: { ...base, ...headers } }, resolve);
    req.on("error", reject);
  });
  assert.equal(stream.statusCode, 200);
  stream.resume();
  const streamClosed = new Promise(resolve => { stream.on("error", () => {}); stream.once("close", resolve); });
  const wsClosed = once(ws.socket, "close");
  ws.socket.resume();
  await clientAuth.revokeClient(client.id);
  assert.equal((await request({ headers })).status, 401);
  // Native auth remains authoritative; granting an origin never grants a token.
  const nextLogin = await login(password, { origin: publicOrigin });
  assert.equal(nextLogin.status, 200);
  const nextToken = JSON.parse(nextLogin.text).clientToken;
  const reset = await request({ method: "POST", route: "/fixture/reset-auth", headers: { ...aliasHeaders, cookie: aliasCookie } });
  assert.equal(reset.status, 200);
  assert.match(reset.headers["set-cookie"][0], /^oc_ui_session_4097=/);
  assert.equal((await request({ headers: { ...aliasHeaders, cookie: aliasCookie } })).status, 401);
  auth.dispose();
  await fs.rm(root, { recursive: true, force: true });
  auth = makeAuth();
  assert.equal((await request({ headers: { origin: appOrigin, authorization: `Bearer ${nextToken}` } })).status, 401);
  assert.equal((await request({ headers: { origin: publicOrigin, cookie } })).status, 401);
  await proxy.close();
  await Promise.all([streamClosed, wsClosed]);
  console.log("OpenChamber LAN: native login, cookies, client tokens, CORS, protected routes, streams and restart invalidation passed");
} finally {
  await proxy?.close();
  await strict?.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  auth.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
