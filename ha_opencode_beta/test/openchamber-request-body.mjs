// Runs against the actual pinned/patched preview during its image build.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, request } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const source = process.env.OPENCHAMBER_TEST_SOURCE || "/opt/openchamber-preview";
const { registerOpenCodeProxy } = await import(pathToFileURL(path.join(source, "packages/web/server/lib/opencode/proxy.js")));
const require = createRequire(path.join(source, "packages/web/package.json"));
const express = require("express");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

for (const parsed of [false, true]) {
test(`preview forwards ${parsed ? 'parsed' : 'streaming'} chunked and fixed-length JSON with unambiguous framing`, { timeout: 10000 }, async (t) => {
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      path: req.url, body: body.toString(), length: req.headers["content-length"],
      transfer: req.headers["transfer-encoding"], authenticated: req.headers.authorization === "Bearer synthetic-fixture",
    }));
  });
  const port = await listen(upstream);
  const app = express();
  if (parsed) app.use(express.json());
  registerOpenCodeProxy(app, {
    fs, os, path, OPEN_CODE_READY_GRACE_MS: 1000, LONG_REQUEST_TIMEOUT_MS: 2000,
    getRuntime: () => ({ openCodePort: port, isOpenCodeReady: true, openCodeNotReadySince: 0 }),
    getOpenCodeAuthHeaders: () => ({ Authorization: "Bearer synthetic-fixture" }),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:${port}${route}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  const proxy = createServer(app);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await Promise.all([proxy, upstream].map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  });
  for (const [route, payload] of [
    ["/api/session", { agent: "build", title: "Home Assistant — test ✓" }],
    ["/api/session/ses_fixture/prompt", { text: "Continue — ✓", resume: false }],
    ["/api/session/ses_fixture/command", { command: "fixture", arguments: "" }],
    ["/api/session/ses_fixture/interrupt", {}],
  ]) {
    const body = Buffer.from(JSON.stringify(payload));
    for (const chunked of [false, true]) {
      const response = await new Promise((resolve, reject) => {
        const req = request({
          host: "127.0.0.1", port: proxyPort, path: route, method: "POST",
          headers: { "Content-Type": "application/json", ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": body.length }) },
        }, async (res) => {
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() });
          } catch (error) { reject(error); }
        });
        req.on("error", reject);
        req.write(body.subarray(0, 1));
        req.end(body.subarray(1));
      });
      assert.equal(response.status, 200, `${chunked ? "Chunked" : "Fixed-length"} JSON must reach the backend`);
      const actual = JSON.parse(response.text);
      assert.equal(actual.path, route);
      if (parsed || !chunked) {
        assert.equal(actual.transfer, undefined);
        assert.equal(Number(actual.length), body.length);
      } else {
        assert.equal(actual.transfer, 'chunked');
        assert.equal(actual.length, undefined);
      }
      assert.deepEqual(JSON.parse(actual.body), payload);
      assert.equal(actual.authenticated, true);
    }
  }
});
}
