const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const root = "../rootfs/opt/opencode-v2-homeassistant/";
const options = { enable_server: true, server_desktop_app: true, server_direct_subnet: "192.168.5.0/24",
  server_public_url: "https://192.168.5.33:4096", lan_password: "direct-test-password" };

test("direct LAN requires a matching private network, desktop access, and a separate HTTPS proxy for the UI", async () => {
  const { parseLanOptions } = await import(`${root}lan-config.js`);
  assert.deepEqual(parseLanOptions(options).proxies, []);
  for (const subnet of ["0.0.0.0/0", "192.168.5.33/24", "172.16.0.0/11", "10.0.0.0/7", "192.168.0.0/15", "192.168.6.0/24"]) {
    assert.throws(() => parseLanOptions({ ...options, server_direct_subnet: subnet }));
  }
  assert.throws(() => parseLanOptions({ ...options, server_desktop_app: false }), /server_desktop_app/);
  assert.throws(() => parseLanOptions({ ...options, server_public_url: "http://192.168.6.33" }), /server_public_url/);
  assert.throws(() => parseLanOptions({ ...options, server_public_url: "http://192.168.5.33", server_direct_subnet: "", lan_trusted_proxies: ["127.0.0.1"] }), /server_public_url/);
  assert.throws(() => parseLanOptions({ ...options, server_public_url: "http://192.168.5.33", enable_openchamber_lan: true,
    interface_mode: "openchamber", lan_trusted_proxies: ["127.0.0.1"], openchamber_public_url: "http://192.168.5.33:4097" }), /openchamber_public_url/);
  assert.throws(() => parseLanOptions({ ...options, enable_openchamber_lan: true, interface_mode: "openchamber",
    openchamber_public_url: "https://ui.example.test" }), /lan_trusted_proxies/);
  assert.throws(() => parseLanOptions({ ...options, server_direct_subnet: "" }), /lan_trusted_proxies/);
});

test("direct HTTP preflight and staging succeed without certificate files", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-http-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "options.json");
  const output = path.join(dir, "lan.json");
  const url = "http://192.168.5.33:4096";
  fs.writeFileSync(input, JSON.stringify({ ...options, server_public_url: url }));
  for (const args of [["--check", input], ["--write", input, output]]) {
    execFileSync(process.execPath, [require.resolve(`${root}lan-config.js`), ...args]);
  }
  assert.equal(JSON.parse(fs.readFileSync(output)).apiOrigin, url);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["lan.json", "options.json"]);
});

for (const protocol of ["http", "https"]) test(`direct ${protocol} authenticates desktop requests and rejects off-subnet peers and forwarded identities`, async t => {
  const { directSubnet, validateDirectTls } = await import(`${root}direct-lan.js`);
  const { createLanProxy } = await import(`${root}lan-proxy.js`);
  const ip = Object.values(os.networkInterfaces()).flat().find(n => n.family === "IPv4" && directSubnet(`${n.address}/32`))?.address;
  if (!ip) return t.skip("requires a private IPv4 interface for a real on-subnet connection");
  const origin = `${protocol}://${ip}:4096`;
  let tls;
  if (protocol === "https") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-direct-tls-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=direct-test",
      "-addext", `subjectAltName=IP:${ip}`, "-keyout", "key", "-out", "cert"], { cwd: dir, stdio: "pipe" });
    tls = { cert: fs.readFileSync(path.join(dir, "cert")), key: fs.readFileSync(path.join(dir, "key")) };
    validateDirectTls(tls.cert, tls.key, origin);
    assert.throws(() => validateDirectTls(tls.cert, tls.key, "https://192.0.2.1"));
    assert.throws(() => validateDirectTls(tls.cert, tls.cert, origin));
  }
  const calls = [];
  const upstream = http.createServer((req, res) => { calls.push(req.headers); res.end("ok"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  async function listener(bind) {
    const proxy = createLanProxy({ mode: "api", origin, proxies: [], directSubnet: `${ip}/32`, tls,
      desktopApps: true, password: options.lan_password, backendPassword: "separate", upstreamPort: upstream.address().port });
    proxy.server.listen(0, bind);
    await once(proxy.server, "listening");
    t.after(() => proxy.close());
    return proxy.server.address().port;
  }
  const port = await listener(ip);
  const auth = `Basic ${Buffer.from(`opencode:${options.lan_password}`).toString("base64")}`;
  function request(headers, method = "GET", connection = {}) {
    return new Promise((resolve, reject) => {
      const req = (tls ? https : http).request({ hostname: ip, port, ca: tls?.cert, agent: false, path: "/api/info",
        // Pin verification to the intended server IP even in negative Host/peer tests.
        checkServerIdentity: (_host, peer) => require("node:tls").checkServerIdentity(ip, peer), ...connection,
        headers: { host: new URL(origin).host, origin: "oc://renderer", ...headers }, method }, res => {
        res.resume(); res.on("end", () => resolve(res));
      });
      req.on("error", reject); req.end();
    });
  }
  assert.equal((await request({ "access-control-request-method": "GET" }, "OPTIONS")).headers["access-control-allow-origin"], "oc://renderer");
  assert.equal((await request({})).statusCode, 401);
  assert.equal((await request({ authorization: auth })).statusCode, 200);
  assert.equal(calls[0]["x-forwarded-for"], ip);
  assert.equal(calls[0]["x-forwarded-proto"], protocol);
  for (const headers of [{ "x-forwarded-for": ip }, { forwarded: `for=${ip}` }, { host: "foreign.test" }, { origin: "https://unrelated.test" }]) {
    assert.equal((await request({ authorization: auth, ...headers })).statusCode, 403);
  }
  if (tls) await assert.rejects(request({}, "GET", { ca: [] }));
  // Connect over loopback with the correct host and credentials.
  assert.equal((await request({ authorization: auth }, "GET", { port: await listener("127.0.0.1"),
    hostname: "127.0.0.1" })).statusCode, 403);
  assert.equal(calls.length, 1);
});
