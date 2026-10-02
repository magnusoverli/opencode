import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import http from "node:http";
import { createLanProxy } from "/opt/opencode-v2-homeassistant/lan-proxy.js";

const backendPassword = await readFile(path.join(process.argv[2], "server-password"), "utf8");
const password = "fixture-independent-lan-password";
const proxy = createLanProxy({ mode: "api", origin: "https://code.fixture.test", proxies: ["127.0.0.1"],
  password, backendPassword, upstreamPort: Number(process.argv[3]) });
try {
  proxy.server.listen(0, "127.0.0.1");
  await once(proxy.server, "listening");
  // Use the HTTP client so the test can represent a reverse proxy's preserved
  // Host header; fetch intentionally replaces a user-supplied Host.
  const request = (headers) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: proxy.server.address().port, path: "/api/info", headers,
      signal: AbortSignal.timeout(5000) }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
  const headers = { host: "code.fixture.test", "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.1" };
  assert.equal((await request(headers)).status, 401);
  headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const result = await request(headers);
  assert.equal(result.status, 200);
  const text = result.text;
  assert.ok(text.includes("2.0.21"));
  assert.ok(!text.includes(backendPassword) && !text.includes(password));
  headers.origin = "https://untrusted.fixture.test";
  assert.equal((await request(headers)).status, 403);
  console.log("Native V2 API reached through separate LAN authentication; untrusted browser origin rejected");
} finally {
  await proxy.close();
}
