#!/usr/bin/env node
// ==============================================================================
// Service Discovery Script (Zigbee2MQTT + ESPHome)
//
// Discovers the Zigbee2MQTT addon (Z2M_URL, Z2M_MQTT_TOPIC) and the ESPHome
// addon's ingress URL/session (HAB_ESPHOME_URL, HAB_ESPHOME_SESSION) in one
// pass, sharing a single Supervisor /addons fetch. Writes shell "export"
// statements to /data/.env_vars_discovered for sourcing by shells/services.
//
// Launched detached from init-opencode so boot never blocks on discovery.
// Both discoveries are best-effort: failures leave their exports absent and
// MCP-mediated commands still do their own runtime discovery.
//
// Environment:
//   SUPERVISOR_TOKEN  required
//   HA_ACCESS_TOKEN   enables ESPHome discovery (ingress session needs it)
//   DISCOVER_Z2M      set to "false" to skip Z2M (manual z2m_url configured)
//
// Exit codes:
//   0 = success or graceful skip
//   1 = unexpected error
// ==============================================================================

const http = require("http");
const fs = require("fs");

const OUTPUT_FILE = "/data/.env_vars_discovered";
// LAN calls to the Supervisor — keep timeouts short
const REQUEST_TIMEOUT_MS = 3000;
const WS_TIMEOUT_MS = 8000;

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_ACCESS_TOKEN = process.env.HA_ACCESS_TOKEN;
const DISCOVER_Z2M = process.env.DISCOVER_Z2M !== "false";

// Load ws from the MCP server's node_modules (installed at image build time)
let WebSocket = null;
try {
  WebSocket = require("/opt/ha-mcp-server/node_modules/ws");
} catch {
  // ws not available — ESPHome discovery will be skipped
}

if (!SUPERVISOR_TOKEN) {
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
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
    }, WS_TIMEOUT_MS);

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

// Single-quote a value for safe shell sourcing
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Zigbee2MQTT discovery — returns export lines (or [] on skip)
// ---------------------------------------------------------------------------
async function discoverZ2M(addons) {
  const z2m = addons.find((a) =>
    a.slug &&
    a.slug.includes("zigbee2mqtt") &&
    !a.slug.includes("zigbee2mqtt_edge") &&
    (a.state === "started" || a.version)
  );
  if (!z2m) return [];

  const info = await supervisorGet(`/addons/${z2m.slug}/info`);
  if (info.state !== "started") return [];

  // Inside the HA Docker network, addons are reachable by hostname.
  // Z2M has no authentication — direct HTTP access works.
  const hostname = info.hostname;
  const port = info.ingress_port;
  if (!hostname || !port) return [];

  // The Z2M addon stores the MQTT base topic in options.mqtt.base_topic
  // or options.mqtt_base_topic
  let mqttTopic = "zigbee2mqtt";
  if (info.options) {
    if (info.options.mqtt && info.options.mqtt.base_topic) {
      mqttTopic = info.options.mqtt.base_topic;
    } else if (info.options.mqtt_base_topic) {
      mqttTopic = info.options.mqtt_base_topic;
    }
  }

  return [
    `export Z2M_URL=${shellQuote(`http://${hostname}:${port}`)}`,
    `export Z2M_MQTT_TOPIC=${shellQuote(mqttTopic)}`,
  ];
}

// ---------------------------------------------------------------------------
// ESPHome discovery — returns export lines (or [] on skip)
// (mirrors discoverESPHome() in the MCP server)
// ---------------------------------------------------------------------------
async function discoverESPHome(addons) {
  const esphome = addons.find((a) =>
    a.slug &&
    a.slug.includes("esphome") &&
    (a.state === "started" || a.state === "stopped" || a.version)
  );
  if (!esphome) return [];

  const [info, haConfig] = await Promise.all([
    supervisorGet(`/addons/${esphome.slug}/info`),
    haGet("/config"),
  ]);
  if (!info.ingress_entry) return [];

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

  if (!haCoreUrl) return [];

  const session = await createIngressSession(haCoreUrl, HA_ACCESS_TOKEN);
  if (!session) return [];

  const ingressPath = info.ingress_entry.startsWith("/")
    ? info.ingress_entry
    : `/${info.ingress_entry}`;

  return [
    `export HAB_ESPHOME_URL=${shellQuote(`${haCoreUrl}${ingressPath}`)}`,
    `export HAB_ESPHOME_SESSION=${shellQuote(session)}`,
  ];
}

// ---------------------------------------------------------------------------
// Main — one shared /addons fetch, both discoveries concurrent
// ---------------------------------------------------------------------------
async function main() {
  const wantZ2M = DISCOVER_Z2M;
  const wantESPHome = !!(HA_ACCESS_TOKEN && WebSocket);
  if (!wantZ2M && !wantESPHome) return;

  const addonsData = await supervisorGet("/addons");
  const addonsRaw = addonsData.addons || addonsData;
  const addons = Array.isArray(addonsRaw) ? addonsRaw : [];

  const results = await Promise.allSettled([
    wantZ2M ? discoverZ2M(addons) : Promise.resolve([]),
    wantESPHome ? discoverESPHome(addons) : Promise.resolve([]),
  ]);

  const lines = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (lines.length > 0) {
    fs.writeFileSync(OUTPUT_FILE, lines.join("\n") + "\n", { mode: 0o600 });
    fs.chmodSync(OUTPUT_FILE, 0o600);
  }
}

main().catch(() => {
  // Swallow all errors — this is best-effort discovery
});
