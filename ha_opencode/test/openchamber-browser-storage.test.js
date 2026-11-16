const assert = require("node:assert/strict");
const { test } = require("node:test");
const { installBrowserStorageScope } = require("../rootfs/usr/local/bin/openchamber-browser-storage.js");

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
function windowWith(raw, session = storage()) {
  const listeners = [];
  return { localStorage: raw, sessionStorage: session, listeners,
    addEventListener: (name, fn) => { if (name === "storage") listeners.push(fn); } };
}

test("beta ignores stable workspace/model/session pointers without deleting them (#199)", () => {
  const raw = storage({ lastDirectory: "/stable-only", lastSession: "stable-session", selectedModel: "stable/model", hassTokens: "unrelated-fixture" });
  const beta = windowWith(raw);
  installBrowserStorageScope(beta, "ha-opencode-beta");
  for (const key of ["lastDirectory", "lastSession", "selectedModel", "hassTokens"]) assert.equal(beta.localStorage.getItem(key), null);
  beta.localStorage.setItem("lastDirectory", "/homeassistant");
  beta.localStorage.setItem("selectedModel", "beta/model");
  assert.equal(raw.getItem("lastDirectory"), "/stable-only");
  assert.equal(raw.getItem("selectedModel"), "stable/model");
  assert.equal(raw.getItem("hassTokens"), "unrelated-fixture");
  const reopened = windowWith(raw);
  installBrowserStorageScope(reopened, "ha-opencode-beta");
  assert.equal(reopened.localStorage.getItem("lastDirectory"), "/homeassistant");
  assert.equal(reopened.localStorage.getItem("selectedModel"), "beta/model");
  reopened.localStorage.clear();
  assert.equal(reopened.localStorage.length, 0);
  assert.equal(raw.getItem("lastSession"), "stable-session");
});

test("isolates session storage and keeps namespaced key enumeration/idempotence", () => {
  const raw = storage(), session = storage({ draft: "stable-draft" });
  const beta = windowWith(raw, session);
  installBrowserStorageScope(beta, "ha-opencode-beta");
  beta.sessionStorage.setItem("draft", "beta-draft");
  beta.localStorage.setItem("a", 123);
  installBrowserStorageScope(beta, "ha-opencode-beta");
  assert.equal(beta.localStorage.getItem("a"), "123");
  assert.equal(beta.localStorage.key(0), "a");
  assert.equal(beta.localStorage.length, 1);
  assert.equal(beta.sessionStorage.getItem("draft"), "beta-draft");
  assert.equal(session.getItem("draft"), "stable-draft");
  beta.sessionStorage.removeItem("draft");
  assert.equal(session.getItem("draft"), "stable-draft");
});

test("rejects cross-app storage events and translates same-channel events", () => {
  const raw = storage(), beta = windowWith(raw);
  installBrowserStorageScope(beta, "ha-opencode-beta");
  const event = key => ({ key, storageArea: raw, stopped: false, stopImmediatePropagation() { this.stopped = true; } });
  for (const key of ["lastDirectory", "ha-opencode-stable:lastDirectory", null]) {
    const other = event(key); beta.listeners[0](other); assert.equal(other.stopped, true);
  }
  const own = event("ha-opencode-beta:lastDirectory");
  beta.listeners[0](own);
  assert.equal(own.stopped, false);
  assert.equal(own.key, "lastDirectory");
  assert.equal(own.storageArea, beta.localStorage);
});

test("preserves browser storage denial instead of reading an unscoped fallback", () => {
  const blocked = { addEventListener() {} };
  Object.defineProperty(blocked, "localStorage", { get() { throw new Error("blocked"); } });
  installBrowserStorageScope(blocked, "ha-opencode-beta");
  assert.throws(() => blocked.localStorage, /blocked/);
});
