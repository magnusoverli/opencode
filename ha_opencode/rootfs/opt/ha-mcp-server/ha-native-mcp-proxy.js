#!/usr/bin/env node
import readline from "readline";

import {
  createJsonRpcError,
  forwardJsonRpcToNativeMcp,
  NATIVE_MCP_ASSIST_API_ID,
  normalizeNativeMcpApiId,
} from "./lib/ha-native-mcp.js";

const SUPERVISOR_API = process.env.HA_NATIVE_MCP_BASE_URL || "http://supervisor/core/api";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const API_ID = normalizeNativeMcpApiId(
  process.env.HA_NATIVE_MCP_API_ID ?? process.argv[2] ?? NATIVE_MCP_ASSIST_API_ID,
  { allowBaseEndpoint: true }
);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.HA_NATIVE_MCP_TIMEOUT_MS || "60000", 10);

function log(level, message, extra = {}) {
  console.error(JSON.stringify({
    level,
    logger: "ha-native-mcp-proxy",
    message,
    api_id: API_ID,
    endpoint_mode: API_ID ? "keyed_api" : "configured_api",
    ...extra,
    timestamp: new Date().toISOString(),
  }));
}

if (!SUPERVISOR_TOKEN) {
  log("error", "SUPERVISOR_TOKEN is required");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

log("info", "Home Assistant native MCP stdio proxy started");

let queue = Promise.resolve();

async function handleLine(line) {
  const raw = line.trim();
  if (!raw) return;

  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(createJsonRpcError(null, -32700, "Parse error", {
      message: error?.message || String(error),
    }))}\n`);
    return;
  }

  const response = await forwardJsonRpcToNativeMcp({
    supervisorToken: SUPERVISOR_TOKEN,
    baseUrl: SUPERVISOR_API,
    apiId: API_ID,
    message,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
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
