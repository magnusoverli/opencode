import { mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error("unsafe_discovery_state");
  }
}

export function createDiscoveryPublisher({ enabled, token, directory = "/data/ha-facing-mcp",
  secretPath = "/run/ha-facing-mcp/ingress-secret", statusUrl = "http://127.0.0.1:8767/ha-mcp/status",
  supervisorUrl = "http://supervisor/discovery", fetchImpl = fetch,
}) {
  const path = join(directory, "discovery.json");
  function load() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    try {
      privatePath(path);
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (typeof data.uuid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.uuid)) throw new Error("invalid_discovery_uuid");
      return data;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function syncDirectory() {
    if (process.platform === "win32") return;
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function save(data) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path); syncDirectory();
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  async function request(url, options, signal) {
    return fetchImpl(url, { ...options, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  }
  return {
    async tick(signal) {
      const previous = load();
      if (!enabled) {
        if (!previous) return true;
        // Keep the UUID (and intent) until Supervisor confirms removal, including across restarts.
        if (!previous.pendingDelete) save({ ...previous, pendingDelete: true });
        if (!token) throw new Error("supervisor_token_required");
        const response = await request(`${supervisorUrl}/${encodeURIComponent(previous.uuid)}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        }, signal);
        if (!response.ok && response.status !== 404) throw new Error("discovery_delete_failed");
        if (response.status !== 404) {
          const result = await response.json();
          if (result.result !== "ok") throw new Error("discovery_delete_failed");
        }
        unlinkSync(path); syncDirectory();
        return true;
      }
      privatePath(secretPath);
      const secret = readFileSync(secretPath, "utf8").trim();
      if (!secret) throw new Error("ingress_secret_required");
      const readiness = await request(statusUrl, { headers: { "X-HA-MCP-Ingress-Secret": secret } }, signal);
      if (!readiness.ok) throw new Error("readiness_failed");
      const status = await readiness.json();
      if (status.ready !== true) return false;
      const url = new URL(status.url);
      if (url.protocol !== "http:" || !url.hostname || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
        throw new Error("invalid_discovery_url");
      }
      if (!token) throw new Error("supervisor_token_required");
      const response = await request(supervisorUrl, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ service: "mcp", config: { url: url.href } }),
      }, signal);
      if (!response.ok) throw new Error("discovery_publish_failed");
      const result = await response.json();
      const uuid = result.data?.uuid;
      if (result.result !== "ok" || typeof uuid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(uuid)) {
        throw new Error("invalid_discovery_response");
      }
      save({ uuid });
      return true;
    },
  };
}

export async function runDiscoveryPublisher(publisher, { signal, wait = sleep,
  warn = () => console.error("HA-facing MCP discovery unavailable; retrying."),
} = {}) {
  let retry = 1000;
  while (!signal?.aborted) {
    let ready = false;
    try { ready = await publisher.tick(signal); }
    catch { if (!signal?.aborted) warn(); }
    if (signal?.aborted) break;
    const delay = ready ? 300000 : retry;
    retry = ready ? 1000 : Math.min(retry * 2, 60000);
    try { await wait(delay, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
