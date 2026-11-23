const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

const helper = readFileSync(join(__dirname, "../rootfs/opt/ttyd/reconnect.js"), "utf8");
function fixture(fetch = async () => Response.json({ token: "" })) {
  const timers = [], overlays = [], keys = [], urls = [];
  const Recovery = runInNewContext(`${helper}; HaTerminalReconnect`, {
    crypto: require("node:crypto").webcrypto, URL, AbortSignal, fetch,
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
  });
  const terminal = { reconnect: true, options: { tokenUrl: "/test/token" },
    overlayAddon: { showOverlay: text => overlays.push(text) }, dispose() {}, refreshToken: async () => {},
    terminal: { options: {}, reset() {}, onKey: fn => { keys.push(fn); return { dispose() {} }; } },
    connect: () => urls.push(new URL(policy.url("ws://localhost/test/ws?arg=ignored")).searchParams.getAll("arg")),
  };
  const policy = new Recovery(terminal);
  terminal.connect();
  return { policy, terminal, timers, overlays, keys, urls };
}

test("a masked normal close resumes only the previous page and output resets the backoff", async () => {
  const { policy, terminal, timers, urls } = fixture();
  const [[initial]] = urls;
  assert.match(initial, /^open-[a-f0-9]{32}$/);
  policy.output();
  policy.closed({ code: 1000 });
  assert.equal(timers[0].delay, 1000);
  await timers.shift().fn();
  assert.deepEqual(urls[1], [initial.replace("open-", "resume-")]);
  assert.equal(terminal.token, "");
  policy.closed({ code: 1006 }); // an upgrade alone isn't a working terminal
  assert.equal(timers[0].delay, 2000);
  await timers.shift().fn();
  policy.output();
  policy.closed({ code: 1000 });
  assert.equal(timers[0].delay, 1000);
});

test("refused reattachment stops; only manual Enter requests a new open", async () => {
  const { policy, timers, overlays, keys, urls } = fixture();
  policy.output();
  policy.closed({ code: 1000 });
  await timers.shift().fn();
  policy.closed({ code: 1000 }); // ended, replaced, or deliberately detached
  assert.equal(timers.length, 0);
  assert.equal(overlays.at(-1), "Press ⏎ to Reconnect");
  keys[0]({ domEvent: { key: "Enter" } });
  await Promise.resolve();
  assert.match(urls[2][0], /^open-/);
  assert.notEqual(urls[0][0], urls[2][0]);
});

test("initial failure and disabled reconnect remain manual", () => {
  for (const disabled of [true, false]) {
    const { policy, terminal, timers, keys } = fixture();
    if (disabled) { policy.output(); terminal.reconnect = false; }
    policy.closed({ code: 1006 });
    assert.equal(timers.length, 0);
    assert.equal(keys.length, 1);
  }
});

test("expired ingress stops automatic attempts and transient failures are bounded", async () => {
  for (const response of [new Response("", { status: 401 }), new Response("", { status: 403 }),
    new Response("<html>sign in</html>"), Response.json({ error: "unauthorized" })]) {
    const { policy, timers, overlays, urls } = fixture(async () => response);
    policy.output(); policy.closed({ code: 1000 });
    await timers.shift().fn();
    assert.equal(timers.length, 0);
    assert.match(overlays.at(-1), /Home Assistant/);
    assert.equal(urls.length, 1);
  }
  const { policy, timers, overlays } = fixture(async () => { throw Error("offline"); });
  policy.output(); policy.closed({ code: 1000 });
  for (const delay of [1000, 2000, 4000, 8000, 8000]) {
    assert.equal(timers[0].delay, delay);
    await timers.shift().fn();
  }
  assert.equal(timers.length, 0);
  assert.equal(overlays.at(-1), "Press ⏎ to Reconnect");
});
