#!/usr/bin/env node
// ==============================================================================
// ESPHome Discovery Script
//
// Discovers the ESPHome addon's ingress URL and creates an ingress session.
// Outputs shell "export" statements to stdout for sourcing into the environment.
//
// Used by init-opencode to pre-populate HAB_ESPHOME_URL and HAB_ESPHOME_SESSION
// so that `hab esphome *` commands work from the shell without MCP mediation.
//
// Exit codes:
//   0 = success (exports printed) or graceful skip (nothing printed)
//   1 = unexpected error
// ==============================================================================

const http = require("http");

// Load ws from the MCP server's node_modules (installed at image build time)
let WebSocket;
try {
  WebSocket = require("/opt/ha-mcp-server/node_modules/ws");
} catch {
  // ws not available — skip silently
  process.exit(0);
}

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_ACCESS_TOKEN = process.env.HA_ACCESS_TOKEN;

if (!SUPERVISOR_TOKEN || !HA_ACCESS_TOKEN) {
  // Cannot proceed without both tokens
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Supervisor API helper — GET only, returns unwrapped .data
// ---------------------------------------------------------------------------
function supervisorGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://supervisor${endpoint}`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(json.data !== undefined ? json.data : json);
        } catch (e) {
          reject(new Error(`JSON parse error on ${endpoint}: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Timeout on ${endpoint}`));
    });
  });
}

// ---------------------------------------------------------------------------
// HA Core API helper — GET via Supervisor proxy at http://supervisor/core/api
// ---------------------------------------------------------------------------
function haGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://supervisor/core/api${endpoint}`, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error on /core/api${endpoint}: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Timeout on /core/api${endpoint}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Create an ingress session via HA Core WebSocket API
// (REST session creation is rejected by the Supervisor — WS is the only path)
// ---------------------------------------------------------------------------
function createIngressSession(haCoreUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = haCoreUrl.replace(/^http/, "ws") + "/api/websocket";
    const ws = new WebSocket(wsUrl);
    let msgId = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 15000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({
            id: msgId++,
            type: "supervisor/api",
            endpoint: "/ingress/session",
            method: "post",
          }));
        } else if (msg.type === "auth_invalid") {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        } else if (msg.type === "result") {
          clearTimeout(timeout);
          ws.close();
          if (msg.success && msg.result?.session) {
            resolve(msg.result.session);
          } else {
            resolve(null);
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

// ---------------------------------------------------------------------------
// Main discovery flow (mirrors discoverESPHome() in the MCP server)
// ---------------------------------------------------------------------------
async function main() {
  // Step 1: Find ESPHome addon
  const addonsData = await supervisorGet("/addons");
  const addons = addonsData.addons || addonsData;
  const esphome = (Array.isArray(addons) ? addons : []).find((a) =>
    a.slug &&
    a.slug.includes("esphome") &&
    (a.state === "started" || a.state === "stopped" || a.version)
  );
  if (!esphome) return; // ESPHome not installed — nothing to do

  // Step 2: Get addon info (need ingress_entry)
  const info = await supervisorGet(`/addons/${esphome.slug}/info`);
  if (!info.ingress_entry) return;

  // Step 3: Discover HA Core URL
  const haConfig = await haGet("/config");
  let haCoreUrl = (haConfig.internal_url || haConfig.external_url || "").replace(/\/+$/, "");

  if (!haCoreUrl) {
    // Fallback: build URL from network/core info
    const [coreInfo, netInfo] = await Promise.all([
      supervisorGet("/core/info"),
      supervisorGet("/network/info"),
    ]);
    const port = coreInfo.port || 8123;
    const ssl = coreInfo.ssl || false;
    const ifaces = netInfo.interfaces || [];
    const primary = ifaces.find((i) => i.primary && i.connected);
    const iface = primary || ifaces.find((i) => i.connected);
    if (iface?.ipv4?.address?.[0]) {
      const ip = iface.ipv4.address[0].split("/")[0];
      haCoreUrl = `${ssl ? "https" : "http"}://${ip}:${port}`;
    }
  }

  if (!haCoreUrl) return;

  // Step 4: Create ingress session via WebSocket
  const session = await createIngressSession(haCoreUrl, HA_ACCESS_TOKEN);
  if (!session) return;

  // Step 5: Build final ingress URL
  const ingressPath = info.ingress_entry.startsWith("/")
    ? info.ingress_entry
    : `/${info.ingress_entry}`;
  const url = `${haCoreUrl}${ingressPath}`;

  // Output shell export statements (single-quoted to prevent expansion)
  const safeUrl = url.replace(/'/g, "'\\''");
  const safeSession = session.replace(/'/g, "'\\''");
  process.stdout.write(`export HAB_ESPHOME_URL='${safeUrl}'\n`);
  process.stdout.write(`export HAB_ESPHOME_SESSION='${safeSession}'\n`);
}

main().catch(() => {
  // Swallow all errors — this is best-effort discovery.
  // If it fails, hab esphome commands won't work from shell but
  // MCP-mediated hab commands still do their own runtime discovery.
});
