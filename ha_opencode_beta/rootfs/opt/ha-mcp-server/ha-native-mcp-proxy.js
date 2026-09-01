#!/usr/bin/env node
import readline from "readline";

import {
  createJsonRpcError,
  DEFAULT_NATIVE_MCP_ENDPOINT_MODE,
  NATIVE_MCP_ASSIST_API_ID,
  normalizeNativeMcpApiId,
  normalizeNativeMcpEndpointMode,
} from "./lib/ha-native-mcp.js";
import { createNativeMcpHandler } from "./lib/native-mcp-handler.js";

const SUPERVISOR_API = process.env.HA_NATIVE_MCP_BASE_URL || "http://supervisor/core/api";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const API_ID = normalizeNativeMcpApiId(
  process.env.HA_NATIVE_MCP_API_ID ?? process.argv[2] ?? NATIVE_MCP_ASSIST_API_ID,
  { allowBaseEndpoint: true }
);
const ENDPOINT_MODE = normalizeNativeMcpEndpointMode(
  process.env.HA_NATIVE_MCP_ENDPOINT_MODE ?? DEFAULT_NATIVE_MCP_ENDPOINT_MODE
);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.HA_NATIVE_MCP_TIMEOUT_MS || "60000", 10);
// Repairs Home Assistant <= 2026.7 tool schemas that strict MCP clients cannot
// compile. Set to 0 to see the raw upstream schemas.
const SANITIZE_SCHEMAS = process.env.HA_NATIVE_MCP_SANITIZE_SCHEMAS !== "0";

function log(level, message, extra = {}) {
  console.error(JSON.stringify({
    level,
    logger: "ha-native-mcp-proxy",
    message,
    api_id: API_ID,
    endpoint_mode: ENDPOINT_MODE,
    ...extra,
    timestamp: new Date().toISOString(),
  }));
}

if (!SUPERVISOR_TOKEN) {
  log("error", "SUPERVISOR_TOKEN is required");
  process.exit(1);
}

const handleNativeMcp = createNativeMcpHandler({
  supervisorToken: SUPERVISOR_TOKEN,
  baseUrl: SUPERVISOR_API,
  apiId: API_ID,
  endpointMode: ENDPOINT_MODE,
  timeoutMs: REQUEST_TIMEOUT_MS,
  sanitizeSchemas: SANITIZE_SCHEMAS,
  onLog: log,
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

log("info", "Home Assistant native MCP stdio proxy started", {
  schema_sanitizer: SANITIZE_SCHEMAS ? "enabled" : "disabled",
});

let queue = Promise.resolve();
function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleLine(line) {
  const raw = line.trim();
  if (!raw) return;

  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    write(createJsonRpcError(null, -32700, "Parse error", {
      message: error?.message || String(error),
    }));
    return;
  }

  // Never forward a malformed message: Home Assistant Core has crashed on them
  // (home-assistant/core#176734).
  const response = await handleNativeMcp(message);
  if (!response) return;
  write(response);
}

rl.on("line", (line) => {
  queue = queue.then(() => handleLine(line)).catch((error) => {
    log("error", "Failed to process native MCP message", {
      error: error?.message || String(error),
    });
  });
});

rl.on("close", () => {
  log("info", "Home Assistant native MCP stdio proxy stopped");
});
