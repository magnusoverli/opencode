// Serialized into the pre-module browser bootstrap: keep this function closed
// over only its arguments. HA Ingress paths share an origin, not app storage.
function installBrowserStorageScope(window, namespace) {
  if (window.__HA_OPENCODE_STORAGE_SCOPE__) return;
  const prefix = `${namespace}:`;
  const stores = new Map();
  for (const name of ["localStorage", "sessionStorage"]) {
    let raw;
    try { raw = window[name]; } catch { continue; } // Preserve browser denial.
    if (!raw) continue;
    const keys = () => {
      const result = [];
      for (let i = 0; i < raw.length; i++) {
        const key = raw.key(i);
        if (key?.startsWith(prefix)) result.push(key.slice(prefix.length));
      }
      return result;
    };
    const scoped = {
      getItem: key => raw.getItem(prefix + String(key)),
      setItem: (key, value) => raw.setItem(prefix + String(key), String(value)),
      removeItem: key => raw.removeItem(prefix + String(key)),
      clear: () => { for (const key of keys()) raw.removeItem(prefix + key); },
      key: index => keys()[Number(index) >>> 0] ?? null,
      get length() { return keys().length; },
    };
    Object.defineProperty(window, name, { configurable: true, get: () => scoped });
    stores.set(raw, scoped);
  }
  // Another stable/HA iframe must not inject its unscoped state through native
  // storage events. Same-channel tabs still receive logical (unprefixed) keys.
  window.addEventListener("storage", event => {
    const scoped = stores.get(event.storageArea);
    if (!scoped) return;
    if (typeof event.key !== "string" || !event.key.startsWith(prefix)) {
      event.stopImmediatePropagation();
      return;
    }
    Object.defineProperty(event, "key", { value: event.key.slice(prefix.length) });
    Object.defineProperty(event, "storageArea", { value: scoped });
  }, true);
  window.__HA_OPENCODE_STORAGE_SCOPE__ = namespace;
}

module.exports = { installBrowserStorageScope };
