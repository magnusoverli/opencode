import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openState, acquireStateLock, createIngressSecret, verifyAdministrator, requireThat, selectAuthMode, resolveCorePeer } from "./lib/ha-facing-auth.js";
import { openBackend, createReadServer } from "./lib/ha-facing-backend.js";
import { startHaFacing } from "./lib/ha-facing-http.js";

// Launch contract (both channels): HA_MCP_ENABLED=true; SUPERVISOR_TOKEN;
// HA_MCP_STATE_DIR=/data/ha-facing-mcp; optional HA_MCP_HOSTNAME (otherwise
// GET http://supervisor/addons/self/info). HA_MCP_PORT=8766 and
// HA_MCP_INGRESS_PORT=8767 are internal-only ports, never host mappings.
// IPC secret: /run/ha-facing-mcp/ingress-secret, regenerated on every start.
// Auth mode is fixed at startup: provisioned client => OAuth; otherwise trust
// only the private IPv4 host gateway reported by authenticated GET /core/info.
// Discovery is owned by the parent: publish ONLY after authenticated IPC
// GET /ha-mcp/status returns ready:true. Never log the authorization URL,
// request queries, headers, credentials, code, token or state file contents.
export async function launch(env = process.env) {
  if (env.HA_MCP_ENABLED !== "true") return null;
  requireThat(process.platform !== "win32" && process.getuid() === 0, 500, "root_required");
  requireThat(Boolean(env.SUPERVISOR_TOKEN), 500, "supervisor_token_required");
  let hostname = env.HA_MCP_HOSTNAME;
  if (!hostname) {
    const response = await fetch("http://supervisor/addons/self/info", {
      headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` }, signal: AbortSignal.timeout(5000), redirect: "error",
    });
    requireThat(response.ok, 500, "supervisor_unavailable");
    hostname = (await response.json()).data?.hostname;
  }
  requireThat(typeof hostname === "string" && /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(hostname) && hostname.length <= 63, 500, "invalid_hostname");
  const port = Number(env.HA_MCP_PORT || 8766); const ipcPort = Number(env.HA_MCP_INGRESS_PORT || 8767);
  requireThat([port, ipcPort].every((value) => Number.isInteger(value) && value >= 1024 && value <= 65535) && port !== ipcPort, 500, "invalid_port");
  const directory = env.HA_MCP_STATE_DIR || "/data/ha-facing-mcp";
  const unlock = await acquireStateLock(directory);
  let state;
  try {
    state = openState(directory);
    const authMode = selectAuthMode(state);
    const trustedPeer = authMode === "trusted_host" ? await resolveCorePeer(env.SUPERVISOR_TOKEN) : undefined;
    const probe = await openBackend(env.SUPERVISOR_TOKEN);
    try { await (await createReadServer(probe)).close(); } finally { await probe.close(); }
    const ingressSecret = createIngressSecret("/run/ha-facing-mcp/ingress-secret");
    const listener = await startHaFacing({ state, resourceUrl: `http://${hostname}:${port}/mcp`, ingressSecret,
      verifyAdmin: (id) => verifyAdministrator(env.SUPERVISOR_TOKEN, id), backendFactory: () => openBackend(env.SUPERVISOR_TOKEN),
      corePort: port, ipcPort, authMode, trustedPeer,
    });
    return { async close() { await listener.close(); state.close(); await unlock(); } };
  } catch (error) { state?.close(); await unlock(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await launch();
    if (service) {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(1), 10000).unref();
        await service.close(); clearTimeout(deadline);
      };
      process.on("SIGTERM", stop); process.on("SIGINT", stop);
    }
  } catch {
    console.error("HA-facing MCP refused startup; check root ownership, state lock, Supervisor access and port configuration.");
    process.exitCode = 1;
  }
}
