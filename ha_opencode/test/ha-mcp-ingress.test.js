// Real HTTP/router integration with simulated Supervisor peer metadata and Linux
// secret-file ownership. No production trust bypass or test port is introduced.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");

const prefix = "/api/hassio_ingress/test_token";
const user = "a".repeat(32);
const uiHtml = '<html><head></head><body><script type="module" src="/assets/test.js"></script></body></html>';
const headers = {
  "x-ingress-path": prefix, "x-remote-user-id": user,
  "x-forwarded-host": "ha.example:8443", "x-forwarded-proto": "https",
  origin: "https://ha.example:8443",
  "x-ha-mcp-ingress-secret": "forged", "x-ha-mcp-user-id": "forged",
  "x-ha-mcp-external-origin": "https://evil.example", "x-ha-mcp-external-path": "/forged",
};
const scripts = (channel) => path.resolve(__dirname, "../..", channel, "rootfs/usr/local/bin");
function load(file, dependencies, extras = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, require: (name) => dependencies[name] || require(name), URL, Buffer,
    console: { log() {}, error() {} }, ...extras,
  }, { filename: file });
  return module.exports;
}
function request(port, url, overrides = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, ...overrides }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body);
  });
}

for (const channel of ["ha_opencode", "ha_opencode_beta"]) {
  test(`${channel}: shared ingress security and UI routing`, async (t) => {
    let remote = "172.30.32.2";
    let secret = "s".repeat(43);
    let mode = 0o600;
    let owner = 0;
    let missing = false;
    let reads = 0;
    const hits = [];
    const ipc = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(303, { location: "https://ha.example/callback?code=untouched", "content-type": "text/html" });
        res.end('<html><head></head><form action="/unchanged"></form></html>');
      });
    });
    const ui = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(uiHtml), etag: '"ui"' });
      res.end(uiHtml);
    });
    ui.on("upgrade", (req, socket) => {
      socket.on("error", () => {});
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n${req.url}`);
    });
    for (const server of [ipc, ui]) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    t.after(() => { ipc.closeAllConnections(); ipc.close(); ui.closeAllConnections(); ui.close(); });
    const route = load(path.join(scripts(channel), "ha-mcp-ingress.js"), {
      "node:fs": {
        constants: fs.constants,
        lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: 0o700 }),
        openSync: () => { if (missing) throw new Error("missing"); return 1; },
        fstatSync: () => ({ isFile: () => true, uid: owner, mode, nlink: 1, size: 43 }),
        readFileSync: () => { reads++; return secret; }, closeSync() {},
      },
      "node:http": { request: (options, callback) => {
        assert.equal(options.host, "127.0.0.1"); assert.equal(options.port, 8767);
        return http.request({ ...options, port: ipc.address().port }, callback);
      } },
    });
    const disabledPages = {};
    for (const [uiMode, setupEnabled] of [["terminal", false], ["terminal", true], ["openchamber", false], ["openchamber", true], ["lan", true]]) {
      let router;
      load(path.join(scripts(channel), "openchamber-ingress-proxy.js"), {
        "./ha-mcp-ingress.js": route,
        http: { ...http, createServer: (handler) => {
          router = http.createServer((req, res) => {
            Object.defineProperty(req.socket, "remoteAddress", { configurable: true, get: () => remote });
            handler(req, res);
          });
          const listen = router.listen.bind(router);
          router.listen = () => listen(0, "127.0.0.1");
          return router;
        } },
      }, { process: { env: {
        HA_INGRESS_UI: uiMode, OPENCHAMBER_UPSTREAM_PORT: String(ui.address().port),
        HA_MCP_SETUP_ENABLED: String(setupEnabled),
        OPENCHAMBER_ALLOW_ANY_REMOTE: String(uiMode === "lan"),
      } } });
      await once(router, "listening");
      t.after(() => { router.closeAllConnections(); router.close(); });
      const port = router.address().port;
      const send = (url = "/ha-mcp/", extra = {}, body = "") => request(port, url, { headers, ...extra }, body);

      if (uiMode === "lan") {
        for (const proto of ["http", "https"]) {
          assert.equal((await send("/ha-mcp/", { headers: {
            ...headers, "x-forwarded-proto": proto, origin: `${proto}://ha.example:8443`,
          } })).status, 403, "even Supervisor cannot use LAN consent");
        }
        assert.equal((await send(`${prefix}/`)).body.includes("data-ha-mcp-setup"), false);
        continue;
      }
      for (const pathname of ["/ha-mcp/", "/ha-mcp/authorize"]) {
        for (const [full, proto] of [[false, "http"], [true, "http"], [false, "https"], [true, "https"]]) {
          remote = "::ffff:172.30.32.2";
          const origin = `${proto}://ha.example:8443`;
          const response = await send(`${full ? prefix : ""}${pathname}?state=a%2Bb&repeat=1&repeat=2`, {
            method: "POST", headers: { ...headers, "x-forwarded-proto": proto, origin },
          }, "csrf=a%2Bb&decision=approve");
          assert.equal(response.status, 303);
          assert.equal(response.headers.location, "https://ha.example/callback?code=untouched");
          assert.equal(response.body, '<html><head></head><form action="/unchanged"></form></html>');
          const hit = hits.at(-1);
          assert.equal(hit.url, `${pathname}?state=a%2Bb&repeat=1&repeat=2`);
          assert.equal(hit.method, "POST"); assert.equal(hit.body, "csrf=a%2Bb&decision=approve");
          assert.equal(hit.headers.origin, origin);
          assert.equal(hit.headers["x-forwarded-proto"], proto);
          assert.equal(hit.headers["x-ha-mcp-ingress-secret"], secret);
          assert.equal(hit.headers["x-ha-mcp-user-id"], user);
          assert.equal(hit.headers["x-ha-mcp-external-origin"], origin);
          assert.equal(hit.headers["x-ha-mcp-external-path"], prefix + pathname);
        }
      }
      const before = hits.length;
      for (remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2", "172.30.32.3"]) {
        for (const proto of ["http", "https"]) {
          assert.equal((await send("/ha-mcp/", { headers: {
            ...headers, "x-forwarded-proto": proto, origin: `${proto}://ha.example:8443`,
          } })).status, 403);
        }
      }
      remote = "172.30.32.2";
      // Forged IPC headers cannot substitute for missing or ambiguous metadata,
      // even on navigations where the browser does not send Origin.
      for (const proto of [undefined, "", "HTTP", "HTTPS", "ftp", "https, http", "http, https", "ht tp", ["http", "http"], ["https", "https"], ["http", "https"]]) {
        const h = { ...headers, "x-forwarded-proto": proto };
        delete h.origin;
        if (proto === undefined) delete h["x-forwarded-proto"];
        assert.equal((await send("/ha-mcp/", { headers: h })).status, 403);
      }
      for (const name of ["x-forwarded-host", "x-ingress-path", "origin"]) {
        assert.equal((await send("/ha-mcp/", { headers: { ...headers, [name]: [headers[name], headers[name]] } })).status, 403);
      }
      for (const delta of [
        { "x-remote-user-id": "" }, { "x-remote-user-id": "admin" },
        { "x-forwarded-proto": "http" }, { "x-forwarded-proto": "https, http" },
        { "x-forwarded-host": "evil.example/path" }, { "x-forwarded-host": "ha.example, evil.example" },
        { "x-forwarded-host": "" }, { "x-ingress-path": "" }, { "x-ingress-path": prefix + "?query" },
        { "x-remote-user-id": [user, user] },
      ]) assert.equal((await send("/ha-mcp/", { headers: { ...headers, ...delta } })).status, 403);
      for (const url of ["/ha-mcp/status", "/ha-mcp/token", "/ha-mcp/authorize/", "/ha-mcp/"]) {
        const h = { ...headers };
        if (url === "/ha-mcp/") delete h["x-remote-user-id"];
        assert.equal((await send(url, { headers: h })).status, 403);
      }
      assert.equal(hits.length, before, "rejected requests never reach IPC");
      const previousReads = reads;
      secret = "r".repeat(43);
      assert.equal((await send()).status, 303);
      assert.equal(reads, previousReads + 1);
      assert.equal(hits.at(-1).headers["x-ha-mcp-ingress-secret"], secret);
      missing = true; assert.equal((await send()).status, 503); missing = false;
      mode = 0o644; assert.equal((await send()).status, 503); mode = 0o600;
      owner = 1000; assert.equal((await send()).status, 503); owner = 0;
      // Forwarding metadata alone cannot authenticate the browser origin.
      const beforeOriginChecks = hits.length;
      for (const method of ["GET", "POST"]) {
        assert.equal((await send("/ha-mcp/", { method, headers: { ...headers, origin: "https://evil.example" } })).status, 403);
        assert.equal((await send("/ha-mcp/", { method, headers: { ...headers, "x-forwarded-host": "evil.example" } })).status, 403);
        for (const proto of ["http", "https"]) {
          assert.equal((await send("/ha-mcp/", { method, headers: {
            ...headers, "x-forwarded-proto": proto,
            origin: `${proto === "http" ? "https" : "http"}://ha.example:8443`,
          } })).status, 403, "Origin must match the forwarded scheme");
        }
      }
      const noOrigin = { ...headers }; delete noOrigin.origin;
      for (const proto of ["http", "https"]) {
        assert.equal((await send("/ha-mcp/", { method: "POST", headers: { ...noOrigin, "x-forwarded-proto": proto } })).status, 403);
      }
      assert.equal(hits.length, beforeOriginChecks);
      const navigationHeaders = { ...headers, "x-forwarded-host": "HA.example:443" };
      delete navigationHeaders.origin;
      assert.equal((await send("/ha-mcp/", { headers: navigationHeaders })).status, 303);
      assert.equal(hits.at(-1).headers["x-ha-mcp-external-origin"], "https://ha.example");
      assert.equal(hits.at(-1).headers.origin, undefined);
      navigationHeaders["x-forwarded-proto"] = "http";
      navigationHeaders["x-forwarded-host"] = "HA.example:80";
      assert.equal((await send("/ha-mcp/", { headers: navigationHeaders })).status, 303);
      assert.equal(hits.at(-1).headers["x-ha-mcp-external-origin"], "http://ha.example");
      assert.equal(hits.at(-1).headers.origin, undefined);

      const page = await send(`${prefix}/`);
      assert.equal(page.status, 200);
      assert.equal(page.body.includes("data-ha-ingress-runtime"), uiMode === "openchamber");
      assert.equal(page.body.includes("data-ha-mcp-setup"), setupEnabled);
      if (!setupEnabled) {
        disabledPages[uiMode] = page.body;
        if (uiMode === "terminal") {
          assert.equal(page.body, uiHtml, "disabled terminal HTML is byte-for-byte unchanged");
          assert.equal(page.headers.etag, '"ui"');
          assert.equal(Number(page.headers["content-length"]), Buffer.byteLength(uiHtml));
        }
      } else {
        assert.ok(page.body.includes(`href="${prefix}/ha-mcp/"`));
        assert.ok(page.body.includes('title="Home Assistant MCP status (opens in a new tab)"'));
        assert.ok(page.body.includes('target="_blank" rel="noopener noreferrer"'));
        assert.equal(page.body.replace(/<a data-ha-mcp-setup\b[^>]*>Home Assistant MCP status<\/a>/, ""), disabledPages[uiMode],
          "enabled HTML differs only by the setup link, preserving existing UI substitutions");
        assert.equal(page.headers.etag, undefined);
        assert.equal(page.headers["content-length"], undefined);
        assert.equal((await request(port, "/", { headers: {} })).body.includes("data-ha-mcp-setup"), false);
        assert.equal((await send("/", { headers: { ...headers, "x-ingress-path": '/bad/\"path' } })).body.includes("data-ha-mcp-setup"), false);
        if (uiMode === "openchamber") assert.ok(page.body.includes(`src="${prefix}/assets/test.js"`));
      }
      for (const url of ["/socket?arg=1", "/ha-mcp/authorize"]) {
        const result = await new Promise((resolve, reject) => {
          const socket = net.connect(port, "127.0.0.1", () => socket.write(
            `GET ${prefix}${url} HTTP/1.1\r\nHost: test\r\nX-Ingress-Path: ${prefix}\r\nX-Remote-User-Id: ${user}\r\nX-Forwarded-Proto: http\r\nX-Forwarded-Host: ha.example:8443\r\nOrigin: http://ha.example:8443\r\nX-Ha-Mcp-Ingress-Secret: forged\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
          let data = "";
          socket.on("data", (chunk) => { data += chunk; });
          socket.on("end", () => resolve(data)); socket.on("error", reject);
        });
        assert.match(result, url.startsWith("/ha-mcp") ? /403 Forbidden/ : /101 Switching Protocols/);
        if (url.startsWith("/socket")) assert.ok(result.endsWith(url));
      }
    }
  });
}

test("router implementation parity and service graph", () => {
  for (const file of ["ha-mcp-ingress.js", "openchamber-ingress-proxy.js"]) {
    assert.equal(fs.readFileSync(path.join(scripts("ha_opencode"), file), "utf8"), fs.readFileSync(path.join(scripts("ha_opencode_beta"), file), "utf8"));
  }
  for (const channel of ["ha_opencode", "ha_opencode_beta"]) {
    const services = path.resolve(scripts(channel), "../../../etc/s6-overlay/s6-rc.d");
    const run = fs.readFileSync(path.join(services, "ha-openchamber-ingress/run"), "utf8");
    assert.match(run, /OPENCHAMBER_INGRESS_PORT=8099/);
    assert.match(run, /OPENCHAMBER_UPSTREAM_PORT=8100/);
    assert.doesNotMatch(run, /sleep infinity|source \/data|curl/);
    assert.match(run, /bashio::config 'ha_mcp_server_enabled'/);
    assert.match(run, /HA_MCP_SETUP_ENABLED=false/);
    assert.match(run, /exec env -i PATH=/);
    assert.doesNotMatch(run.slice(run.indexOf("exec env -i")), /SUPERVISOR_TOKEN|HA_MCP_INGRESS_SECRET|NODE_PATH/);
    assert.ok(fs.existsSync(path.join(services, "ha-openchamber-ingress/dependencies.d/init-opencode")));
    assert.match(fs.readFileSync(path.join(services, "ha-opencode/run"), "utf8"), /-i lo \\\n\s+-p 8100/);
  }
});
