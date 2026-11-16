const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { routeHaMcp } = require("../rootfs/usr/local/bin/ha-mcp-ingress.js");

const base = "/api/hassio_ingress/fixture";
function request({ path = "/ha-mcp/", remote = "172.30.32.2", method = "GET", lan = false, user = "a".repeat(32) } = {}) {
  const headers = { "x-remote-user-id": user, "x-forwarded-host": "ha.example",
    "x-forwarded-proto": "https", "x-ingress-path": base };
  if (method === "POST") headers.origin = "https://ha.example";
  const req = { method, headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: remote } };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  assert.equal(routeHaMcp(req, res, { ingressPath: base, upstreamPath: path, lan }), true);
  return res;
}

test("trusted setup navigation canonicalizes the bare path, never POST or untrusted traffic (#214)", () => {
  const response = request({ path: "/ha-mcp" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, base + "/ha-mcp/");
  for (const options of [{ remote: "127.0.0.1" }, { lan: true }, { user: "" }, { method: "POST" }]) {
    assert.equal(request({ path: "/ha-mcp", ...options }).status, 403);
  }
});

test("missing setup service gives actionable bounded HTML without weakening its boundary (#214)", t => {
  const original = fs.lstatSync;
  let inspected = 0;
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    if (path === "/run/ha-facing-mcp") { inspected++; throw new Error("private filesystem detail"); }
    return original(path, ...args);
  });
  assert.equal(request({ remote: "127.0.0.1" }).status, 403);
  assert.equal(inspected, 0);
  const response = request();
  assert.equal(response.status, 503);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.headers["content-security-policy"], /default-src 'none'/);
  assert.match(response.body, /MCP Access is enabled/);
  assert.match(response.body, /separate from the Home Assistant tools/);
  assert.doesNotMatch(response.body, /private filesystem detail|<script/);
  assert.equal(request({ method: "POST" }).body, "MCP setup unavailable\n");
});
