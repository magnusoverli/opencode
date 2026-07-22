// Integration tests for the OpenChamber ingress proxy's provider OAuth loopback
// bridge (issue #54). The proxy is spawned exactly as the s6 service runs it and
// driven over real HTTP against a fake OpenChamber upstream and a fake
// in-container OAuth callback listener.
//
// Run with: node --test ha_opencode/test/
//
// This directory is outside rootfs/, so it is not copied into the add-on image.

const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PROXY_SCRIPT = path.join(__dirname, "..", "rootfs", "usr", "local", "bin", "openchamber-ingress-proxy.js");
const INGRESS_PATH = "/api/hassio_ingress/abc123";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function postJson(port, urlPath, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return request(port, {
    method: "POST",
    path: urlPath,
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
      "x-ingress-path": INGRESS_PATH,
    },
  }, body);
}

describe("openchamber ingress proxy: provider OAuth loopback bridge", () => {
  let proxy;
  let proxyPort;
  let upstream;
  let upstreamPort;
  let callbackListener;
  let callbackPort;

  // Set by each test before it drives the proxy.
  let authorizeResponse;
  // Emulates OpenCode: the callback POST only completes once the in-container
  // loopback listener has actually received the authorization code.
  let callbackBlocksOnLoopback;
  let loopbackHits;
  let forwardedCallbackBodies;
  let pendingCallbackResponses;

  const releasePendingCallbacks = () => {
    for (const res of pendingCallbackResponses.splice(0)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
    }
  };

  before(async () => {
    callbackPort = await freePort();
    callbackListener = http.createServer((req, res) => {
      loopbackHits.push(new URL(req.url, `http://localhost:${callbackPort}`));
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
      releasePendingCallbacks();
    });
    await listen(callbackListener, callbackPort);

    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.endsWith("/oauth/authorize")) {
        const payload = Buffer.from(JSON.stringify(authorizeResponse));
        res.writeHead(200, { "content-type": "application/json", "content-length": String(payload.length) });
        res.end(payload);
        return;
      }
      if (url.pathname.endsWith("/oauth/callback")) {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          forwardedCallbackBodies.push(Buffer.concat(chunks).toString("utf8"));
          if (callbackBlocksOnLoopback && loopbackHits.length === 0) {
            pendingCallbackResponses.push(res);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("true");
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname, method: req.method }));
    });
    upstreamPort = await freePort();
    await listen(upstream, upstreamPort);

    proxyPort = await freePort();
    proxy = spawn(process.execPath, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        OPENCHAMBER_INGRESS_HOST: "127.0.0.1",
        OPENCHAMBER_INGRESS_PORT: String(proxyPort),
        OPENCHAMBER_UPSTREAM_HOST: "127.0.0.1",
        OPENCHAMBER_UPSTREAM_PORT: String(upstreamPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proxy.stderr.resume();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy did not start")), 10000);
      proxy.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      proxy.once("error", reject);
    });
    proxy.stdout.resume();
  });

  after(async () => {
    if (proxy) proxy.kill();
    await close(upstream);
    await close(callbackListener);
  });

  beforeEach(() => {
    loopbackHits = [];
    forwardedCallbackBodies = [];
    pendingCallbackResponses = [];
    callbackBlocksOnLoopback = false;
    authorizeResponse = {
      url: `https://auth.example.com/oauth/authorize?client_id=app_test&redirect_uri=${
        encodeURIComponent(`http://localhost:${callbackPort}/auth/callback`)
      }&state=STATE-FROM-AUTHORIZE&code_challenge=abc`,
      method: "auto",
      instructions: "Complete authorization in your browser. This window will close automatically.",
    };
  });

  const authorize = (provider = "openai") =>
    postJson(proxyPort, `${INGRESS_PATH}/api/provider/${provider}/oauth/authorize`, { method: 0 });

  const callback = (code, provider = "openai") =>
    postJson(proxyPort, `${INGRESS_PATH}/api/provider/${provider}/oauth/callback`, { method: 0, code });

  it("passes the authorize response through and rewrites the misleading instructions", async () => {
    const response = await authorize();
    assert.equal(response.statusCode, 200);

    const payload = JSON.parse(response.body);
    assert.equal(payload.url, authorizeResponse.url, "the authorize URL must reach the UI unchanged");
    assert.equal(payload.method, "auto");
    assert.match(payload.instructions, /cannot reach this add-on/);
    assert.match(payload.instructions, new RegExp(`http://localhost:${callbackPort}/auth/callback`));
  });

  it("unblocks a pending callback by replaying the redirect to the in-container listener", async () => {
    callbackBlocksOnLoopback = true;
    await authorize();

    const response = await callback("AUTH-CODE-123");

    assert.equal(response.statusCode, 200, "the callback must complete instead of hanging");
    assert.equal(loopbackHits.length, 1);
    assert.equal(loopbackHits[0].pathname, "/auth/callback");
    assert.equal(loopbackHits[0].searchParams.get("code"), "AUTH-CODE-123");
    assert.equal(loopbackHits[0].searchParams.get("state"), "STATE-FROM-AUTHORIZE");
    assert.deepEqual(
      JSON.parse(forwardedCallbackBodies[0]),
      { method: 0, code: "AUTH-CODE-123" },
      "the callback body must still be forwarded upstream verbatim",
    );
  });

  it("accepts the whole failed redirect URL and prefers the state it carries", async () => {
    await authorize();

    const pasted = `http://localhost:${callbackPort}/auth/callback?code=URL-CODE-456&state=STATE-FROM-BROWSER`;
    const response = await callback(pasted);

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 1);
    assert.equal(loopbackHits[0].searchParams.get("code"), "URL-CODE-456");
    assert.equal(loopbackHits[0].searchParams.get("state"), "STATE-FROM-BROWSER");
  });

  it("accepts a pasted query string fragment", async () => {
    await authorize();

    const response = await callback("code=QUERY-CODE-789&state=STATE-FROM-QUERY");

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits[0].searchParams.get("code"), "QUERY-CODE-789");
    assert.equal(loopbackHits[0].searchParams.get("state"), "STATE-FROM-QUERY");
  });

  it("does not replay when the provider redirects somewhere the browser can reach", async () => {
    authorizeResponse.url = "https://auth.example.com/oauth/authorize"
      + `?redirect_uri=${encodeURIComponent("https://console.example.com/oauth/callback")}&state=REMOTE`;
    await authorize();

    const response = await callback("SOME-CODE");

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 0);
    assert.equal(forwardedCallbackBodies.length, 1, "the callback is still forwarded unchanged");
  });

  it("does not replay for methods that consume the pasted code themselves", async () => {
    authorizeResponse.method = "code";
    await authorize();

    const response = await callback("SOME-CODE");

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 0);
  });

  it("leaves the instructions alone when nothing is armed", async () => {
    authorizeResponse.method = "code";
    const response = await authorize();

    assert.equal(JSON.parse(response.body).instructions, authorizeResponse.instructions);
  });

  it("forwards a callback for a provider that never authorized", async () => {
    const response = await callback("ORPHAN-CODE", "anthropic");

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 0);
    assert.deepEqual(JSON.parse(forwardedCallbackBodies[0]), { method: 0, code: "ORPHAN-CODE" });
  });

  it("forwards a callback with no code without replaying anything", async () => {
    await authorize();

    const response = await postJson(
      proxyPort,
      `${INGRESS_PATH}/api/provider/openai/oauth/callback`,
      { method: 0 },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 0);
    assert.deepEqual(JSON.parse(forwardedCallbackBodies[0]), { method: 0 });
  });

  it("keeps proxying ordinary requests", async () => {
    const response = await request(proxyPort, {
      method: "GET",
      path: `${INGRESS_PATH}/api/provider`,
      headers: { "x-ingress-path": INGRESS_PATH },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { path: "/api/provider", method: "GET" });
  });

  it("bridges without an ingress path prefix", async () => {
    await postJson(proxyPort, "/api/provider/openai/oauth/authorize", { method: 0 });
    const response = await postJson(proxyPort, "/api/provider/openai/oauth/callback", {
      method: 0,
      code: "DIRECT-CODE",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(loopbackHits.length, 1);
    assert.equal(loopbackHits[0].searchParams.get("code"), "DIRECT-CODE");
  });

  it("still forwards the callback when the listener is gone", async () => {
    const deadPort = await freePort();
    authorizeResponse.url = "https://auth.example.com/oauth/authorize"
      + `?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${deadPort}/auth/callback`)}&state=DEAD`;
    await authorize();

    const response = await callback("CODE-WITH-NO-LISTENER");

    assert.equal(response.statusCode, 200, "a failed replay must not swallow the request");
    assert.deepEqual(JSON.parse(forwardedCallbackBodies[0]), { method: 0, code: "CODE-WITH-NO-LISTENER" });
  });

  it("reaches a listener bound to IPv6 loopback only", async (t) => {
    const ipv6Port = await freePort();
    const hits = [];
    const ipv6Listener = http.createServer((req, res) => {
      hits.push(new URL(req.url, "http://localhost"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
    });

    try {
      await new Promise((resolve, reject) => {
        ipv6Listener.once("error", reject);
        ipv6Listener.listen(ipv6Port, "::1", resolve);
      });
    } catch {
      t.skip("IPv6 loopback unavailable");
      return;
    }

    try {
      authorizeResponse.url = "https://auth.example.com/oauth/authorize"
        + `?redirect_uri=${encodeURIComponent(`http://localhost:${ipv6Port}/auth/callback`)}&state=V6`;
      await authorize();

      const response = await callback("IPV6-CODE");

      assert.equal(response.statusCode, 200);
      assert.equal(hits.length, 1, "the replay must fall back to ::1 when 127.0.0.1 refuses");
      assert.equal(hits[0].searchParams.get("code"), "IPV6-CODE");
      assert.equal(hits[0].searchParams.get("state"), "V6");
    } finally {
      await close(ipv6Listener);
    }
  });
});
