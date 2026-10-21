// Component tests for the OpenChamber ingress proxy's provider OAuth loopback
// bridge (issue #54). They spawn the proxy directly with fake upstream and OAuth
// listeners; the devcontainer acceptance harness covers Home Assistant Core Ingress.
//
// Run with: node --test ha_opencode_beta/test/openchamber-ingress-proxy.test.js
//
// This directory is outside rootfs/, so it is not copied into the add-on image.

const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PROXY_SCRIPT = path.join(__dirname, "..", "rootfs", "usr", "local", "bin", "openchamber-ingress-proxy.js");
const STABLE_PROXY_SCRIPT = path.join(__dirname, "..", "..", "ha_opencode", "rootfs", "usr", "local", "bin", "openchamber-ingress-proxy.js");
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

function nonLoopbackIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((details) => details
      && (details.family === "IPv4" || details.family === 4)
      && !details.internal
      && !details.address.startsWith("169.254."))
    .map((details) => details.address);
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

function waitFor(condition, message, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function requestThenAbort(port, requestText) {
  return new Promise((resolve, reject) => {
    let received = false;
    const client = net.connect(port, "127.0.0.1", () => client.write(requestText));
    client.once("data", () => {
      received = true;
      client.destroy();
      resolve();
    });
    client.on("error", (error) => {
      if (!received) reject(error);
    });
  });
}

async function requestFromNonLoopback(port, options) {
  for (const address of nonLoopbackIPv4Addresses()) {
    try {
      return await request(port, { ...options, host: address, localAddress: address });
    } catch (error) {
      if (!["EADDRNOTAVAIL", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(error.code)) {
        throw error;
      }
    }
  }
  return null;
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

  it("rewrites an armed loopback auto flow to code entry with actionable instructions", async () => {
    const response = await authorize();
    assert.equal(response.statusCode, 200);

    const payload = JSON.parse(response.body);
    assert.equal(payload.url, authorizeResponse.url, "the authorize URL must reach the UI unchanged");
    assert.equal(payload.method, "code");
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

  it("serves the ingress runtime shim with the active prefix", async () => {
    const response = await request(proxyPort, {
      method: "GET",
      path: `${INGRESS_PATH}/__openchamber_ingress_runtime.js`,
      headers: { "x-ingress-path": INGRESS_PATH },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^application\/javascript/);
    assert.match(response.body, new RegExp(`const configuredBasePath = "${INGRESS_PATH}";`));
    assert.match(response.body, /window\.__OPENCHAMBER_API_BASE_URL__/);
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

describe("openchamber ingress proxy: V2 OpenAI browser sign-in", () => {
  let proxy;
  let upstream;
  let listener;
  let proxyPort;
  let upstreamPort;
  let callbackPort;
  let authorizeResponse;
  let callbackStatus;
  let callbackDelay;
  let attemptStatus;
  let statusCode;
  let statusPaths;
  const hits = [];
  const state = "V2-STATE";

  before(async () => {
    listener = http.createServer((req, res) => {
      hits.push(new URL(req.url, `http://127.0.0.1:${callbackPort}`));
      setTimeout(() => res.writeHead(callbackStatus).end("ok"), callbackDelay);
    });
    await listen(listener, 0);
    callbackPort = listener.address().port;

    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/integration/openai/connect/oauth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: authorizeResponse }));
        return;
      }
      statusPaths.push(url.pathname + url.search);
      res.writeHead(statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { status: hits.length ? "complete" : attemptStatus } }));
    });
    upstreamPort = await freePort();
    await listen(upstream, upstreamPort);
    proxyPort = await freePort();
    proxy = spawn(process.execPath, [PROXY_SCRIPT], {
      env: { ...process.env, OPENCHAMBER_INGRESS_HOST: "127.0.0.1", OPENCHAMBER_INGRESS_PORT: String(proxyPort),
        OPENCHAMBER_UPSTREAM_HOST: "127.0.0.1", OPENCHAMBER_UPSTREAM_PORT: String(upstreamPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proxy.stderr.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy did not start")), 10000);
      proxy.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); }
      });
      proxy.once("error", reject);
    });
    proxy.stdout.resume();
  });

  after(async () => {
    if (proxy) proxy.kill();
    await close(upstream);
    await close(listener);
  });

  beforeEach(() => {
    hits.length = 0;
    callbackStatus = 200;
    callbackDelay = 0;
    attemptStatus = "pending";
    statusCode = 200;
    statusPaths = [];
    authorizeResponse = {
      attemptID: "test-attempt", mode: "auto",
      url: `https://auth.openai.com/oauth/authorize?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${callbackPort}/auth/callback`)}&state=${state}`,
      instructions: "This window will close automatically.",
    };
  });

  const connect = async (prefix = INGRESS_PATH, query = "") => {
    const connectBody = JSON.stringify({ methodID: "chatgpt-token-sharing" });
    return request(proxyPort, {
      method: "POST", path: `${prefix}/api/integration/openai/connect/oauth${query}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(connectBody),
        origin: `http://127.0.0.1:${proxyPort}`, host: `127.0.0.1:${upstreamPort}`,
        "x-ingress-path": prefix },
    }, connectBody);
  };
  const submit = (handoffUrl, callback, headers = {}) => {
    const body = new URLSearchParams({ callback }).toString();
    return request(proxyPort, {
      method: "POST", path: handoffUrl.pathname + handoffUrl.search,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body),
        origin: handoffUrl.origin, ...headers },
    }, body);
  };
  const callback = (query = `code=TEST-CODE&state=${state}`) => `http://127.0.0.1:${callbackPort}/auth/callback?${query}`;
  const handoff = async () => new URL(JSON.parse((await connect()).body).data.url);

  it("hands a dynamic-port browser flow off to a same-origin page, validates state and completes polling", async () => {
    const connected = await connect();
    assert.equal(connected.statusCode, 200);
    const attempt = JSON.parse(connected.body).data;
    assert.equal(attempt.mode, "auto");
    assert.equal(attempt.attemptID, "test-attempt");
    const handoffUrl = new URL(attempt.url);
    assert.equal(handoffUrl.origin, `http://127.0.0.1:${proxyPort}`);
    assert.equal(handoffUrl.pathname, `${INGRESS_PATH}/__ha_openai_oauth_bridge`);
    const handoff = await request(proxyPort, { path: handoffUrl.pathname + handoffUrl.search });
    assert.equal(handoff.statusCode, 200);
    assert.match(handoff.body, /Continue to OpenAI sign-in/);
    assert.match(handoff.body, /auth\.openai\.com/);
    assert.doesNotMatch(handoff.body, /test-attempt/);

    const wrong = await submit(handoffUrl, callback("code=WRONG&state=OTHER"));
    assert.equal(wrong.statusCode, 400);
    assert.equal(hits.length, 0);
    const wrongOrigin = await submit(handoffUrl, `http://localhost:${callbackPort}/auth/callback?code=WRONG&state=${state}`);
    assert.equal(wrongOrigin.statusCode, 400);
    assert.equal(hits.length, 0);
    const completed = await submit(handoffUrl, callback());
    assert.equal(completed.statusCode, 200);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].searchParams.get("code"), "TEST-CODE");
    assert.equal(hits[0].searchParams.get("state"), state);
    assert.doesNotMatch(completed.body, /TEST-CODE/);
    const status = await request(proxyPort, { path: `${INGRESS_PATH}/api/integration/openai/connect/oauth/test-attempt` });
    assert.equal(JSON.parse(status.body).data.status, "complete");
    assert.equal((await request(proxyPort, { path: handoffUrl.pathname + handoffUrl.search })).statusCode, 404);
    assert.equal((await submit(handoffUrl, callback())).statusCode, 404);
  });

  it("forwards the issued client_id for first-time ChatGPT registration, but no unrelated callback parameters", async () => {
    const url = await handoff();
    const completed = await submit(url, callback(`code=FIRST-CODE&state=${state}&client_id=oaiapp_fixture&scope=ignored&redirect_uri=https://evil.test`));
    assert.equal(completed.statusCode, 200);
    assert.equal(hits.length, 1);
    assert.deepEqual([...hits[0].searchParams], [["state", state], ["code", "FIRST-CODE"], ["client_id", "oaiapp_fixture"]]);
    assert.doesNotMatch(completed.body, /FIRST-CODE|oaiapp_fixture/);
    assert.equal(completed.headers["referrer-policy"], "same-origin");
    assert.match(completed.headers["cache-control"], /no-store/);
  });

  it("completes the rendered handoff using a real browser's form Origin and CSP", async t => {
    const executablePath = process.env.HA_ASSIST_BROWSER_EXECUTABLE || process.env.HA_MCP_BROWSER_EXECUTABLE;
    if (!executablePath) {
      assert.notEqual(process.env.HA_NATIVE_TESTS_REQUIRED, "1", "Native CI must exercise the browser handoff");
      t.skip("set HA_ASSIST_BROWSER_EXECUTABLE to exercise real browser form submission");
      return;
    }
    const puppeteer = require("../rootfs/opt/ha-mcp-server/node_modules/puppeteer-core");
    const browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const page = await browser.newPage();
      const url = await handoff();
      await page.goto(url.toString());
      await page.type("#callback", callback(`code=BROWSER-CODE&state=${state}&client_id=oaiapp_browser_fixture`));
      const [response] = await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      assert.equal(response.status(), 200);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].searchParams.get("client_id"), "oaiapp_browser_fixture");
      assert.match(await page.content(), /Callback received/);
      assert.doesNotMatch(await page.content(), /BROWSER-CODE|oaiapp_browser_fixture/);
    } finally {
      await browser.close();
    }
  });

  for (const port of [1455, 1457]) {
    it(`retains the legacy browser handoff on port ${port}`, async () => {
      const url = new URL(authorizeResponse.url);
      url.searchParams.set("redirect_uri", `http://localhost:${port}/auth/callback`);
      authorizeResponse.url = url.toString();
      assert.equal((await handoff()).pathname, `${INGRESS_PATH}/__ha_openai_oauth_bridge`);
    });
  }

  it("leaves the legacy device-code method and its automatic polling untouched", async () => {
    authorizeResponse.url = "https://auth.openai.com/codex/device";
    authorizeResponse.instructions = "Enter code: ABCD-12345";
    assert.deepEqual(JSON.parse((await connect()).body).data, authorizeResponse);
    assert.equal(hits.length, 0);
  });

  for (const redirect of [
    "http://127.attacker.test:35000/auth/callback", "http://example.test:35000/auth/callback",
    "http://127.0.0.1:80/auth/callback", "http://127.0.0.1:443/auth/callback",
    "http://127.0.0.1:35000/other", "https://127.0.0.1:35000/auth/callback",
    "http://user:pass@127.0.0.1:35000/auth/callback", "http://127.0.0.1:35000/auth/callback?query=yes",
    "http://127.0.0.1:35000/auth/callback#fragment",
  ]) {
    it(`does not arm an unsafe or unexpected upstream redirect: ${redirect}`, async () => {
      const url = new URL(authorizeResponse.url);
      url.searchParams.set("redirect_uri", redirect);
      authorizeResponse.url = url.toString();
      assert.deepEqual(JSON.parse((await connect()).body).data, authorizeResponse);
      assert.equal(hits.length, 0);
    });
  }

  for (const origin of ["https://auth.openai.com.evil.test", "https://auth.openai.com:444", "http://auth.openai.com", "https://user@auth.openai.com"]) {
    it(`does not arm an untrusted authorization origin: ${origin}`, async () => {
      authorizeResponse.url = authorizeResponse.url.replace("https://auth.openai.com", origin);
      assert.deepEqual(JSON.parse((await connect()).body).data, authorizeResponse);
    });
  }

  for (const mutate of [
    body => { delete body.attemptID; }, body => { body.attemptID = {}; },
    body => { body.url = body.url.replace(`&state=${state}`, ""); },
    body => { body.url += "&state=ANOTHER"; }, body => { body.url += "&redirect_uri=http://127.0.0.1:40000/auth/callback"; },
    body => { body.mode = "code"; },
  ]) {
    it(`does not arm malformed or non-auto attempts: ${mutate}`, async () => {
      mutate(authorizeResponse);
      assert.deepEqual(JSON.parse((await connect()).body).data, authorizeResponse);
    });
  }

  for (const change of [
    value => value.replace(String(callbackPort), String(callbackPort + 1)),
    value => value.replace("/auth/callback?", "/other?"),
    value => value.replace("127.0.0.1", "example.test"),
    value => value.replace("127.0.0.1", "user:pass@127.0.0.1"),
    value => value + "&state=ANOTHER", value => value + "&code=ANOTHER",
    value => value + "&client_id=one&client_id=two", value => value + "&client_id=", value => value + "#fragment",
    value => value.replace("code=TEST-CODE&", ""),
  ]) {
    it(`rejects a mismatched or ambiguous pasted callback: ${change}`, async () => {
      const url = await handoff();
      assert.equal((await submit(url, change(callback()))).statusCode, 400);
      assert.equal(hits.length, 0);
    });
  }

  for (const origin of ["https://evil.test", "null", ""]) {
    it(`rejects a cross-origin or missing-origin form submission: ${origin}`, async () => {
      const url = await handoff();
      assert.equal((await submit(url, callback(), { origin })).statusCode, 403);
      assert.equal(hits.length, 0);
    });
  }

  it("scopes each handoff to the ingress prefix that started it", async () => {
    const url = await handoff();
    url.pathname = url.pathname.replace("abc123", "different-session");
    assert.equal((await submit(url, callback())).statusCode, 404);
    assert.equal(hits.length, 0);
  });

  it("supports the authenticated LAN path without an ingress prefix", async () => {
    const url = new URL(JSON.parse((await connect("")).body).data.url);
    assert.equal(url.pathname, "/__ha_openai_oauth_bridge");
    assert.equal((await submit(url, callback())).statusCode, 200);
    assert.equal(hits.length, 1);
  });

  it("prevents concurrent submissions from replaying the same callback twice", async () => {
    const url = await handoff();
    callbackDelay = 100;
    const results = await Promise.all([submit(url, callback()), submit(url, callback())]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(hits.length, 1);
  });

  for (const terminal of ["cancelled", "expired", "failed", "complete"]) {
    it(`does not replay a callback after its exact attempt is ${terminal}`, async () => {
      const url = await handoff();
      attemptStatus = terminal;
      assert.equal((await submit(url, callback())).statusCode, 409);
      assert.equal(hits.length, 0);
      assert.equal((await submit(url, callback())).statusCode, 404);
    });
  }

  it("fails closed when attempt status is unavailable or no longer authenticated", async () => {
    const url = await handoff();
    statusCode = 401;
    assert.equal((await submit(url, callback())).statusCode, 409);
    assert.equal(hits.length, 0);
  });

  it("checks attempt status in the original project location, not the handoff page location", async () => {
    const query = "?location%5Bdirectory%5D=%2Fhomeassistant";
    const url = new URL(JSON.parse((await connect(INGRESS_PATH, query)).body).data.url);
    assert.equal((await submit(url, callback())).statusCode, 200);
    assert.deepEqual(statusPaths, [`/api/integration/openai/connect/oauth/test-attempt${query}`]);
    assert.equal(hits.length, 1);
  });

  it("reports callback-listener failures without reporting a successful sign-in", async () => {
    const url = await handoff();
    callbackStatus = 400;
    const result = await submit(url, callback());
    assert.equal(result.statusCode, 502);
    assert.doesNotMatch(result.body, /Callback received|TEST-CODE/);
  });
});

describe("openchamber ingress proxy: remote allowlist", () => {
  let proxy;
  let proxyPort;
  let upstream;
  let upstreamPort;

  before(async () => {
    upstream = http.createServer((req, res) => {
      const payload = Buffer.from("ok");
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(payload.length) });
      res.end(payload);
    });
    upstreamPort = await freePort();
    await listen(upstream, upstreamPort);
  });

  after(async () => {
    if (proxy) proxy.kill();
    await close(upstream);
  });

  const startProxy = async (extraEnv = {}) => {
    if (proxy) {
      proxy.kill();
      proxy = null;
    }

    proxyPort = await freePort();
    proxy = spawn(process.execPath, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        OPENCHAMBER_INGRESS_HOST: "0.0.0.0",
        OPENCHAMBER_INGRESS_PORT: String(proxyPort),
        OPENCHAMBER_UPSTREAM_HOST: "127.0.0.1",
        OPENCHAMBER_UPSTREAM_PORT: String(upstreamPort),
        OPENCHAMBER_ALLOW_ANY_REMOTE: "false",
        ...extraEnv,
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
  };

  it("blocks non-allowlisted remotes by default", async (t) => {
    await startProxy();

    const response = await requestFromNonLoopback(proxyPort, {
      method: "GET",
      path: "/api/provider",
      headers: {
        host: "example.invalid",
      },
    });

    if (!response) {
      t.skip("no usable non-loopback IPv4 interface available");
      return;
    }

    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Forbidden/);
  });

  it("allows non-allowlisted remotes only when OPENCHAMBER_ALLOW_ANY_REMOTE=true", async (t) => {
    await startProxy({ OPENCHAMBER_ALLOW_ANY_REMOTE: "true" });

    const response = await requestFromNonLoopback(proxyPort, {
      method: "GET",
      path: "/api/provider",
      headers: {
        host: "example.invalid",
      },
    });

    if (!response) {
      t.skip("no usable non-loopback IPv4 interface available");
      return;
    }

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "ok");
  });
});

describe("openchamber ingress proxy: disconnected clients", () => {
  let proxy;
  let proxyExit;
  let proxyPort;
  let upstream;
  let upstreamPort;
  let handleRequest;
  let handleUpgrade;

  beforeEach(async () => {
    handleRequest = (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok:${req.url}`);
    };
    handleUpgrade = (req, socket) => socket.destroy();
    upstream = http.createServer((req, res) => handleRequest(req, res));
    upstream.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));
    upstreamPort = await freePort();
    await listen(upstream, upstreamPort);

    proxyPort = await freePort();
    const startedProxy = spawn(process.execPath, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        OPENCHAMBER_INGRESS_HOST: "127.0.0.1",
        OPENCHAMBER_INGRESS_PORT: String(proxyPort),
        OPENCHAMBER_UPSTREAM_HOST: "127.0.0.1",
        OPENCHAMBER_UPSTREAM_PORT: String(upstreamPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proxy = startedProxy;
    proxyExit = null;
    startedProxy.once("exit", (code, signal) => {
      if (proxy === startedProxy) proxyExit = { code, signal };
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

  afterEach(async () => {
    if (proxy && proxy.exitCode === null) proxy.kill();
    await close(upstream);
  });

  const assertProxySurvived = async () => {
    const response = await request(proxyPort, {
      method: "GET",
      path: `${INGRESS_PATH}/still-alive`,
      headers: { "x-ingress-path": INGRESS_PATH },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "ok:/still-alive");
    assert.equal(proxyExit, null, `proxy exited after a client disconnect: ${JSON.stringify(proxyExit)}`);
  };

  it("cancels a streaming HTTP response when the client disconnects", async () => {
    let upstreamClosed = false;
    handleRequest = (req, res) => {
      if (req.url !== "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ok:${req.url}`);
        return;
      }

      const chunk = Buffer.alloc(64 * 1024, "x");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const interval = setInterval(() => res.write(chunk), 1);
      res.on("close", () => {
        clearInterval(interval);
        upstreamClosed = true;
      });
    };

    await requestThenAbort(
      proxyPort,
      `GET ${INGRESS_PATH}/stream HTTP/1.1\r\nHost: test\r\nx-ingress-path: ${INGRESS_PATH}\r\n\r\n`,
    );

    await waitFor(() => upstreamClosed, "proxy did not close the abandoned HTTP upstream response");
    await assertProxySurvived();
  });

  it("cancels a WebSocket tunnel when the client disconnects", async () => {
    let upstreamClosed = false;
    handleUpgrade = (req, socket) => {
      const chunk = Buffer.alloc(64 * 1024, "x");
      socket.on("error", () => {});
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      const interval = setInterval(() => socket.write(chunk), 1);
      socket.on("close", () => {
        clearInterval(interval);
        upstreamClosed = true;
      });
    };

    await requestThenAbort(
      proxyPort,
      `GET ${INGRESS_PATH}/socket HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-ingress-path: ${INGRESS_PATH}\r\n\r\n`,
    );

    await waitFor(() => upstreamClosed, "proxy did not close the abandoned WebSocket upstream socket");
    await assertProxySurvived();
  });
});

describe("openchamber ingress proxy: release parity", () => {
  it("keeps shared forwarding and Assist route protection identical across channels", () => {
    const stable = fs.readFileSync(STABLE_PROXY_SCRIPT, "utf8");
    const beta = fs.readFileSync(PROXY_SCRIPT, "utf8");
    assert.ok(beta.includes("/^\\/ha-(?:mcp|assist)(?:[/?]|$)/"));
    // Only the V2 OAuth handoff differs in beta. Keep every shared route,
    // allowlist, Assist boundary and forwarding byte identical to stable.
    const shared = source => source.replace(/function armV2OauthBridge\([\s\S]*?\n\/\/ Resolves to "skipped"/, '// Beta-only V2 OAuth handoff\n// Resolves to "skipped"');
    assert.notEqual(shared(beta), beta, "the OAuth-only comparison boundary must exist");
    assert.equal(shared(beta), shared(stable));
  });
});
