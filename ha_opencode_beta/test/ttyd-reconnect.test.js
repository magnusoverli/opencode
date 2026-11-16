const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

// Pinned upstream minified handlers; independent of the replacement strings.
const source = `class Terminal {
constructor(){this.opened=false;this.reconnect=true;this.doReconnect=true;this.haReconnectAttempts=0}
connect(){this.error=(()=>this.doReconnect=!1)}
initListeners(){} dispose(){}
onSocketOpen(){this.opened=true;this.doReconnect=this.reconnect,this.initListeners()}
onSocketClose(e){const{refreshToken:t,connect:i,doReconnect:s,overlayAddon:r}=this;if(r.showOverlay("Connection Closed"),this.dispose(),1e3!==e.code&&s)r.showOverlay("Reconnecting..."),t().then(i);else{const{terminal:e}=this,s=e.onKey((e=>{"Enter"===e.domEvent.key&&(s.dispose(),r.showOverlay("Reconnecting..."),t().then(i))}));r.showOverlay("Press ⏎ to Reconnect")}}
}; globalThis.Terminal=Terminal;`;

function patched(t, input = source) {
  const root = mkdtempSync(join(tmpdir(), "ttyd-reconnect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, "input.html"), to = join(root, "output.html"), script = join(root, "empty.js");
  writeFileSync(from, `<body><script>${input}</script></body>`);
  writeFileSync(script, "");
  const python = ["python3", "python"].find(name => spawnSync(name, ["--version"]).status === 0);
  assert.ok(python, "Python is required");
  const result = spawnSync(python, [join(__dirname, "../rootfs/opt/ttyd/inject-clipboard.py"), from, to, script], { encoding: "utf8" });
  return { result, output: existsSync(to) ? readFileSync(to, "utf8") : null };
}

test("ttyd retries established socket errors with bounded backoff and no synthetic input (#218)", async t => {
  const { result, output } = patched(t);
  assert.equal(result.status, 0, result.stderr);
  const timers = [], overlays = [], keys = [];
  const context = { setTimeout: (fn, delay) => timers.push({ fn, delay }) };
  runInNewContext(output.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const terminal = new context.Terminal();
  terminal.overlayAddon = { showOverlay: text => overlays.push(text) };
  terminal.terminal = { onKey: fn => { keys.push(fn); return { dispose() {} }; } };
  let connections = 0, tokens = 0;
  terminal.refreshToken = async () => { tokens++; };
  terminal.connect(); const onError = terminal.error;
  terminal.connect = () => { connections++; };
  terminal.onSocketOpen();
  for (let attempt = 0; attempt < 5; attempt++) {
    onError(); terminal.onSocketClose({ code: 1006 });
    const timer = timers.shift();
    assert.equal(timer.delay, [1000, 2000, 4000, 8000, 8000][attempt]);
    await timer.fn();
  }
  assert.equal(connections, 5);
  assert.equal(tokens, 5);
  onError(); terminal.onSocketClose({ code: 1006 });
  assert.equal(timers.length, 0);
  assert.equal(overlays.at(-1), "Press ⏎ to Reconnect");
  await keys.at(-1)({ domEvent: { key: "Enter" } });
  assert.equal(terminal.haReconnectAttempts, 0);
  terminal.onSocketOpen(); onError(); terminal.onSocketClose({ code: 1006 });
  assert.equal(timers.shift().delay, 1000);
});

test("initial failures, normal closes and disabled reconnect remain manual", t => {
  const { result, output } = patched(t);
  assert.equal(result.status, 0, result.stderr);
  for (const [opened, reconnect, code] of [[false, true, 1006], [true, true, 1000], [true, false, 1006]]) {
    const overlays = [];
    const context = { setTimeout: () => assert.fail("must not reconnect") };
    runInNewContext(output.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    const terminal = new context.Terminal();
    terminal.opened = opened; terminal.reconnect = reconnect;
    terminal.overlayAddon = { showOverlay: text => overlays.push(text) };
    terminal.terminal = { onKey: () => ({ dispose() {} }) };
    terminal.connect(); terminal.error(); terminal.onSocketClose({ code });
    assert.equal(overlays.at(-1), "Press ⏎ to Reconnect");
  }
});

test("upstream reconnect drift fails before writing an index", t => {
  const { result, output } = patched(t, source.replace("this.doReconnect=!1", "this.doReconnect=false"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected pinned ttyd reconnect source/);
  assert.equal(output, null);
});
