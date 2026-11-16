import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const puppeteer = createRequire("/opt/ha-mcp-server/package.json")("puppeteer-core");

const root = await mkdtemp("/tmp/ttyd-reconnect-");
const socketPath = `${root}/tmux.sock`;
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const ttyd = spawn("ttyd", ["-W", "-i", "lo", "-p", String(port), "-I", "/opt/ttyd/index.html",
  "tmux", "-S", socketPath, "new-session", "-A", "-s", "fixture", "sh -c 'stty -echo; cat'"],
{ stdio: "ignore" });
const prefix = "/api/hassio_ingress/terminal-fixture";
const upstreams = new Set();
let upgrades = 0;
const proxy = createServer((req, res) => {
  const next = request({ host: "127.0.0.1", port, path: req.url.slice(prefix.length) || "/", method: req.method, headers: req.headers },
    reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  next.on("error", () => res.destroy()); req.pipe(next);
});
proxy.on("upgrade", (req, socket, head) => {
  upgrades++;
  const next = connect(port, "127.0.0.1", () => {
    next.write(`${req.method} ${req.url.slice(prefix.length)} HTTP/1.1\r\n`);
    for (const [key, value] of Object.entries(req.headers)) next.write(`${key}: ${value}\r\n`);
    next.write("\r\n"); if (head.length) next.write(head);
    next.pipe(socket); socket.pipe(next);
  });
  upstreams.add(next);
  next.on("error", () => socket.destroy());
  next.on("close", () => { upstreams.delete(next); socket.destroy(); });
  socket.on("error", () => next.destroy()); socket.on("close", () => next.destroy());
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch {}
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, "ttyd must start");
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args); window.__ttydSocket = this;
        window.__ttydConnections = (window.__ttydConnections || 0) + 1;
      }
    };
  });
  await page.goto(`http://127.0.0.1:${proxy.address().port}${prefix}/`);
  await page.waitForFunction(() => window.term?.rows > 0);
  await page.keyboard.type("BEFORE_DISCONNECT\n");
  const contains = text => page.waitForFunction(needle => {
    const buffer = window.term?.buffer.active;
    return buffer && Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString()).join("\n").includes(needle);
  }, { timeout: 15000 }, text);
  await contains("BEFORE_DISCONNECT");
  // Inject the reported error-before-close sequence, then sever the real
  // transport. TCP teardown alone does not reliably emit an error in Chromium.
  // No Enter key is sent to dismiss the overlay; the tmux session must survive.
  await page.evaluate(() => window.__ttydSocket.dispatchEvent(new Event("error")));
  for (const socket of upstreams) socket.destroy();
  await page.waitForFunction(() => window.__ttydConnections >= 2 && window.__ttydSocket.readyState === WebSocket.OPEN,
    { timeout: 15000 });
  assert.ok(upgrades >= 2, "must automatically reconnect through the Ingress path");
  await contains("BEFORE_DISCONNECT");
  await page.keyboard.type("AFTER_DISCONNECT\n");
  await contains("AFTER_DISCONNECT");
  assert.equal(spawnSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).stdout.trim(), "fixture");
  console.log("PASS: abrupt Ingress socket loss reconnects automatically and preserves tmux state/input");
} finally {
  await browser?.close();
  for (const socket of upstreams) socket.destroy();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  if (ttyd.exitCode === null) { const exited = once(ttyd, "exit"); ttyd.kill(); await exited; }
  await rm(root, { recursive: true, force: true });
}
