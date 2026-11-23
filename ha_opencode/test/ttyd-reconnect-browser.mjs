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
const env = { ...process.env, TMUX_TMPDIR: root };
const tmux = (...args) => spawnSync("tmux", args, { env, encoding: "utf8" });
const pane = () => tmux("display-message", "-p", "-t", "=opencode:", "#{pid}:#{session_id}:#{pane_pid}").stdout.trim();
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const ttyd = spawn("ttyd", ["-W", "--url-arg", "-i", "lo", "-p", String(port), "-I", "/opt/ttyd/index.html",
  "python3", "-I", "-c", `import runpy,sys; sys.exit(runpy.run_path('/opt/ttyd/tmux-client.py')['main'](sys.argv[1:], 'stty -echo; cat'))`],
{ env, stdio: "ignore" });
const prefix = "/api/hassio_ingress/terminal-fixture";
const upstreams = new Set();
const upgradedClients = new Set();
let upgrades = 0;
const maskClose = new WeakSet();
const proxy = createServer((req, res) => {
  const next = request({ host: "127.0.0.1", port, path: req.url.slice(prefix.length) || "/", method: req.method, headers: req.headers },
    reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  next.on("error", () => res.destroy()); req.pipe(next);
});
proxy.on("upgrade", (req, socket, head) => {
  upgrades++;
  upgradedClients.add(socket);
  socket.once("close", () => upgradedClients.delete(socket));
  const next = connect(port, "127.0.0.1", () => {
    next.write(`${req.method} ${req.url.slice(prefix.length)} HTTP/1.1\r\n`);
    for (const [key, value] of Object.entries(req.headers)) next.write(`${key}: ${value}\r\n`);
    next.write("\r\n"); if (head.length) next.write(head);
    next.pipe(socket, { end: false }); socket.pipe(next);
  });
  upstreams.add(next);
  next.on("error", () => socket.destroy());
  next.on("close", () => {
    upstreams.delete(next);
    if (maskClose.has(next) && !socket.destroyed) socket.end(Buffer.from([0x88, 2, 3, 232])); // HA reports 1000
    else socket.destroy();
  });
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
        this.addEventListener("close", e => { window.__ttydLastClose = e.code; });
        this.addEventListener("message", e => { if (new Uint8Array(e.data)[0] === 48) this.testHasPtyOutput = true; });
      }
    };
  });
  await page.goto(`http://127.0.0.1:${proxy.address().port}${prefix}/`);
  await page.waitForFunction(() => window.term?.rows > 0 && window.__ttydSocket.testHasPtyOutput);
  await page.keyboard.type("BEFORE_DISCONNECT\n");
  const contains = text => page.waitForFunction(needle => {
    const buffer = window.term?.buffer.active;
    return buffer && Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString()).join("\n").includes(needle);
  }, { timeout: 15000 }, text);
  await contains("BEFORE_DISCONNECT");
  const identity = pane();
  assert.match(identity, /^\d+:\$\d+:\d+$/);
  // Inject the reported error-before-close sequence, then sever the real
  // transport. TCP teardown alone does not reliably emit an error in Chromium.
  // No Enter key is sent to dismiss the overlay; the tmux session must survive.
  await page.evaluate(() => window.__ttydSocket.dispatchEvent(new Event("error")));
  for (const socket of upstreams) socket.destroy();
  await page.waitForFunction(() => window.__ttydConnections >= 2 && window.__ttydSocket.testHasPtyOutput,
    { timeout: 15000 });
  assert.ok(upgrades >= 2, "must automatically reconnect through the Ingress path");
  await contains("BEFORE_DISCONNECT");
  await page.keyboard.type("AFTER_DISCONNECT\n");
  await contains("AFTER_DISCONNECT");
  assert.equal(pane(), identity);
  for (const socket of upstreams) { maskClose.add(socket); socket.destroy(); }
  await page.waitForFunction(() => window.__ttydLastClose === 1000 && window.__ttydConnections === 3 && window.__ttydSocket.testHasPtyOutput);
  await contains("AFTER_DISCONNECT");
  await page.keyboard.type("AFTER_MASKED_CLOSE\n");
  await contains("AFTER_MASKED_CLOSE");
  assert.equal(pane(), identity);
  const manual = () => page.waitForFunction(() => document.body.innerText.includes("to Reconnect"), { timeout: 12000 });
  assert.equal(tmux("detach-client", "-s", "opencode").status, 0);
  await manual();
  assert.equal(tmux("list-clients").stdout.trim(), "");
  await page.keyboard.press("Enter"); // deliberate, may open/attach again
  await contains("AFTER_MASKED_CLOSE");
  // Wait for fresh PTY output rather than an old screen buffer.
  await page.waitForFunction(() => window.__ttydConnections >= 5 && window.__ttydSocket.testHasPtyOutput);
  await page.keyboard.type("MANUAL_REATTACH\n");
  await contains("MANUAL_REATTACH");
  assert.equal(tmux("kill-session", "-t", "opencode").status, 0);
  await manual();
  assert.notEqual(tmux("has-session", "-t", "opencode").status, 0);
  assert.equal(tmux("new-session", "-d", "-s", "opencode", "cat").status, 0);
  const refused = await page.evaluate(() => new Promise((resolve, reject) => {
    const url = window.__ttydSocket.url;
    if (!new URL(url).searchParams.get("arg")?.startsWith("resume-")) return reject(Error("expected resume URL"));
    const socket = new WebSocket(url, "tty");
    const timer = setTimeout(() => { socket.close(); reject(Error("stale page attached")); }, 5000);
    socket.binaryType = "arraybuffer";
    let output = false;
    socket.onopen = () => socket.send(new TextEncoder().encode(JSON.stringify({ AuthToken: "", columns: 80, rows: 24 })));
    socket.onmessage = e => { if (new Uint8Array(e.data)[0] === 48) output = true; };
    socket.onclose = () => { clearTimeout(timer); resolve(!output); };
  }));
  assert.ok(refused);
  assert.equal(tmux("list-clients").stdout.trim(), "");
} finally {
  console.log("Cleanup: closing test proxy and upgraded sockets");
  const closed = new Promise(resolve => proxy.close(resolve));
  for (const socket of upgradedClients) socket.destroy();
  for (const socket of upstreams) socket.destroy();
  proxy.closeAllConnections();
  await closed;
  console.log("Cleanup: closing browser");
  await browser?.close();
  console.log("Cleanup: stopping tmux and ttyd");
  tmux("kill-server");
  if (ttyd.exitCode === null && ttyd.signalCode === null) {
    const exited = once(ttyd, "exit");
    const force = setTimeout(() => ttyd.kill("SIGKILL"), 3000);
    try { ttyd.kill(); await exited; } finally { clearTimeout(force); }
  }
  await rm(root, { recursive: true, force: true });
}
console.log("PASS: both Ingress losses reattach; detach, exit and session replacement do not");
