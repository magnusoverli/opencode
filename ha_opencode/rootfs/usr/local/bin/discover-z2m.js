#!/usr/bin/env node
// ==============================================================================
// Zigbee2MQTT Discovery Script
//
// Discovers the Zigbee2MQTT addon and outputs shell "export" statements for
// Z2M_URL and Z2M_MQTT_TOPIC. Used by init-opencode to auto-populate zigporter
// environment variables so Z2M commands work without manual configuration.
//
// Discovery approach:
//   1. List addons via Supervisor API, find one with "zigbee2mqtt" in the slug
//   2. Get addon info (hostname, ingress_port, options)
//   3. Build Z2M_URL from the internal Docker hostname + ingress port
//      (Z2M has no auth of its own — direct access works inside the Docker network)
//   4. Read MQTT base topic from addon options (defaults to "zigbee2mqtt")
//
// Exit codes:
//   0 = success (exports printed) or graceful skip (nothing printed)
//   1 = unexpected error
// ==============================================================================

const http = require("http");

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;

if (!SUPERVISOR_TOKEN) {
  // Cannot proceed without Supervisor token
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
// Main discovery flow
// ---------------------------------------------------------------------------
async function main() {
  // Step 1: Find Zigbee2MQTT addon
  const addonsData = await supervisorGet("/addons");
  const addons = addonsData.addons || addonsData;
  const z2m = (Array.isArray(addons) ? addons : []).find((a) =>
    a.slug &&
    a.slug.includes("zigbee2mqtt") &&
    !a.slug.includes("zigbee2mqtt_edge") &&
    (a.state === "started" || a.version)
  );
  if (!z2m) return; // Z2M not installed — nothing to do

  // Step 2: Get addon info
  const info = await supervisorGet(`/addons/${z2m.slug}/info`);

  if (info.state !== "started") return; // Z2M not running — skip

  // Step 3: Build Z2M URL from internal Docker hostname + ingress port
  // Inside the HA Docker network, addons are reachable by hostname.
  // Z2M has no authentication — direct HTTP access works.
  const hostname = info.hostname;
  const port = info.ingress_port;

  if (!hostname || !port) return; // Missing network info — skip

  const z2mUrl = `http://${hostname}:${port}`;

  // Step 4: Read MQTT base topic from addon options
  // The Z2M addon stores this in options.mqtt.base_topic or options.mqtt_base_topic
  let mqttTopic = "zigbee2mqtt"; // default
  if (info.options) {
    if (info.options.mqtt && info.options.mqtt.base_topic) {
      mqttTopic = info.options.mqtt.base_topic;
    } else if (info.options.mqtt_base_topic) {
      mqttTopic = info.options.mqtt_base_topic;
    }
  }

  // Output shell export statements (single-quoted to prevent expansion)
  const safeUrl = z2mUrl.replace(/'/g, "'\\''");
  const safeTopic = mqttTopic.replace(/'/g, "'\\''");
  process.stdout.write(`export Z2M_URL='${safeUrl}'\n`);
  process.stdout.write(`export Z2M_MQTT_TOPIC='${safeTopic}'\n`);
}

main().catch(() => {
  // Swallow all errors — this is best-effort discovery.
  // If it fails, Z2M-dependent zigporter commands won't work from shell,
  // but the user can always set z2m_url manually in the addon config.
});
