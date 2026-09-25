const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");

const root = "../rootfs/opt/opencode-v2-homeassistant/";
const password = "fixture-lan-password";
const backendPassword = "fixture-backend-password";
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const origin = "https://code.example.test";
const baseHeaders = { host: "code.example.test", "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.10", authorization };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function request(port, { path = "/api/info", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { ...baseHeaders, ...headers } }, (res) => {
      const data = [];
      res.on("data", (chunk) => data.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(data).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, settings = {}) {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push(req);
    if (req.url === "/api/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); return; }
    if (req.url === "/auth/session") {
      res.writeHead(401, { "set-cookie": "oc_ui_session=; HttpOnly; Secure; SameSite=Lax", "content-type": "application/json" });
      res.end('{"authenticated":false}');
      return;
    }
    const data = [];
    req.on("data", (chunk) => data.push(chunk));
    req.on("end", () => res.writeHead(200, req.headers.origin ? { "access-control-allow-origin": req.headers.origin } : {}).end(JSON.stringify({ method: req.method, body: Buffer.concat(data).toString(),
      authenticated: req.headers.authorization === `Basic ${Buffer.from(`opencode:${backendPassword}`).toString("base64")}`,
      cookie: req.headers.cookie, origin: req.headers.origin, ingress: req.headers["x-ingress-path"],
      forwarded: req.headers.forwarded, proto: req.headers["x-forwarded-proto"], client: req.headers["x-forwarded-for"],
    })));
  });
  const upstreamPort = await listen(upstream);
  const { createLanProxy } = await import(`${root}lan-proxy.js`);
  const proxy = createLanProxy({ mode: "api", origin, proxies: ["127.0.0.1"], password, backendPassword,
    upstreamPort, corsOrigins: ["https://client.example.test"], ...settings });
  const port = await listen(proxy.server);
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { port, calls, proxy, upstream };
}

test("LAN options fail closed without logging values and allow a disabled legacy configuration", async () => {
  const { parseLanOptions } = await import(`${root}lan-config.js`);
  assert.deepEqual(parseLanOptions({ enable_server: false, cors_origins: ["legacy"] }), { apiEnabled: false, uiEnabled: false });
  const options = { enable_server: true, lan_password: password, lan_trusted_proxies: ["127.0.0.1"], server_public_url: origin };
  assert.equal(parseLanOptions(options).apiOrigin, origin);
  for (const override of [{ lan_password: "short" }, { lan_trusted_proxies: [] }, { lan_trusted_proxies: ["0.0.0.0/0"] },
    { server_public_url: "http://code.test" }, { server_public_url: "https://user:private@code.test" },
    { server_public_url: "https://code.test/path" }, { cors_origins: ["*"] },
    { enable_openchamber_lan: true, interface_mode: "terminal" }]) {
    assert.throws(() => parseLanOptions({ ...options, ...override }), (error) => !error.message.includes(password) && !error.message.includes("user:private"));
  }
});

test("API frontend authenticates separately and forwards bodies without credential or header leakage", async (t) => {
  const { port } = await fixture(t);
  const res = await request(port, { method: "POST", headers: { "content-type": "application/json", cookie: "ambient-cookie", forwarded: "spoofed", "x-ingress-path": "/spoofed" }, body: '{"fixture":true}' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { method: "POST", body: '{"fixture":true}', authenticated: true, proto: "https", client: "192.0.2.10" });
  assert.ok(!res.text.includes(password) && !res.text.includes(backendPassword));
});

test("rejects wrong LAN credentials, direct HTTP, spoofed authority/origin and internal routes before upstream", async (t) => {
  const { port, calls } = await fixture(t);
  for (const [headers, status] of [
    [{ authorization: "" }, 401], [{ authorization: `Basic ${Buffer.from(`opencode:${backendPassword}`).toString("base64")}` }, 401],
    [{ "x-forwarded-proto": "http" }, 403], [{ "x-forwarded-proto": "https,http" }, 403],
    [{ host: "evil.test" }, 403], [{ "x-forwarded-host": "evil.test" }, 403],
    [{ origin: "null" }, 403], [{ origin: "https://evil.test" }, 403],
    [{ "x-forwarded-for": "192.0.2.10, 192.0.2.11" }, 403],
  ]) assert.equal((await request(port, { headers })).status, status);
  for (const path of ["/api/ha-editor-lsp/diagnostics", "/api/%68a-editor-lsp/diagnostics", "/api/hassio_ingress/test", "/__ha_openchamber_update_check"]) {
    assert.equal((await request(port, { path })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test("requires the actual socket peer to be trusted regardless of forwarding headers", async (t) => {
  const { port, calls } = await fixture(t, { proxies: ["192.0.2.2"] });
  assert.equal((await request(port)).status, 403);
  assert.equal(calls.length, 0);
});

test("CORS preflight is exact-origin and actual requests still require authentication", async (t) => {
  const { port, calls } = await fixture(t);
  const headers = { authorization: "", origin: "https://client.example.test", "access-control-request-method": "POST" };
  const preflight = await request(port, { method: "OPTIONS", headers });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], headers.origin);
  assert.equal((await request(port, { headers })).status, 401);
  assert.equal((await request(port, { method: "OPTIONS", headers: { ...headers, origin: "https://evil.test" } })).status, 403);
  assert.equal(calls.length, 0);
});

test("UI frontend retains native authentication, secure cookies and strict same-origin writes", async (t) => {
  const { port, calls } = await fixture(t, { mode: "ui" });
  assert.equal((await request(port, { path: "/auth/session", method: "POST" })).status, 403);
  assert.equal((await request(port, { path: "/auth/session", method: "POST", headers: { origin: "https://client.example.test" } })).status, 403);
  const res = await request(port, { path: "/auth/session", method: "POST", headers: { origin, authorization: "", "content-type": "application/json" }, body: '{"password":"incorrect"}' });
  assert.equal(res.status, 401);
  assert.ok(res.headers["set-cookie"][0].includes("Secure"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "");
});

test("OpenChamber native-app access is opt-in, UI-only and limited to packaged origins", async (t) => {
  const { parseLanOptions } = await import(`${root}lan-config.js`);
  const options = { enable_openchamber_lan: true, interface_mode: "openchamber", lan_password: password,
    lan_trusted_proxies: ["127.0.0.1"], openchamber_public_url: origin };
  assert.equal(parseLanOptions(options).nativeApps, false);
  assert.equal(parseLanOptions({ ...options, openchamber_lan_native_apps: true }).nativeApps, true);
  assert.equal(parseLanOptions({ ...options, enable_openchamber_lan: false, enable_server: true,
    server_public_url: origin, openchamber_lan_native_apps: true }).nativeApps, false);
  assert.throws(() => parseLanOptions({ ...options, openchamber_lan_native_apps: "yes" }), /openchamber_lan_native_apps/);

  const { port, calls } = await fixture(t, { mode: "ui", nativeApps: true });
  const login = { path: "/api/fixture", method: "POST", headers: { authorization: "" } };
  assert.equal((await request(port, login)).status, 200);
  const app = await request(port, { ...login, headers: { authorization: "", origin: "openchamber-ui://app" } });
  assert.equal(app.status, 200);
  assert.equal(app.headers["access-control-allow-origin"], "openchamber-ui://app");
  assert.equal((await request(port, { ...login, headers: { authorization: "", origin: "https://localhost" } })).status, 200);
  const own = await request(port, { ...login, headers: { authorization: "", origin } });
  assert.equal(own.headers["access-control-allow-origin"], undefined);
  const before = calls.length;
  for (const bad of ["null", "https://evil.test", "openchamber-ui://evil", "http://localhost"]) {
    assert.equal((await request(port, { ...login, headers: { authorization: "", origin: bad } })).status, 403);
  }
  assert.equal(calls.length, before);

  const off = await fixture(t, { mode: "ui" });
  assert.equal((await request(off.port, { ...login, headers: { authorization: "", origin: "openchamber-ui://app" } })).status, 403);
  assert.equal((await request(off.port, login)).status, 403);
  const api = await fixture(t, { nativeApps: true });
  assert.equal((await request(api.port, { headers: { origin: "openchamber-ui://app" } })).status, 403);
});

test("closing a frontend terminates existing SSE streams for app-restart credential rotation", async (t) => {
  const { port, proxy } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/event", headers: baseHeaders }, resolve);
    req.on("error", reject);
  });
  response.resume();
  const closed = new Promise((resolve) => { response.once("close", resolve); response.on("error", () => {}); });
  await proxy.close();
  await closed;
});

test("WebSocket upgrades require LAN authentication and are closed with their frontend", async (t) => {
  const { port, proxy, upstream } = await fixture(t);
  let upgraded = false;
  upstream.on("upgrade", (req, socket) => {
    upgraded = true;
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`opencode:${backendPassword}`).toString("base64")}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
  });
  const upgrade = (auth) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/pty/fixture/connect", headers: { ...baseHeaders, authorization: auth, connection: "Upgrade", upgrade: "websocket" } });
    req.on("error", reject);
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.end();
  });
  assert.equal((await upgrade("")).status, 401);
  assert.equal(upgraded, false);
  const result = await upgrade(authorization);
  assert.equal(result.status, 101);
  const closed = once(result.socket, "close");
  await proxy.close();
  result.socket.resume();
  await closed;
});
