import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Deliberately narrower than compact: no templates, logs, files, proxy tools,
// service calls, native MCP bridge, or tools added to compact in the future.
export const READ_TOOLS = Object.freeze([
  "get_states", "search_entities", "get_entity_details", "get_home_context",
  "get_areas", "get_devices", "get_calendars", "get_calendar_events",
]);
const allowed = new Set(READ_TOOLS);
// HA's 10-second budget also covers OAuth, fresh-child initialization and
// transport overhead. Execution must leave headroom; startup is not free.
export const CALL_TIMEOUT = 8000;
export const MAX_RESULT_BYTES = 1024 * 1024;

export function backendEnvironment(token) {
  if (!token) throw new Error("SUPERVISOR_TOKEN is required");
  return {
    ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""])),
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8",
    SUPERVISOR_TOKEN: token,
    HA_API_BASE_URL: "http://supervisor/core/api", SUPERVISOR_BASE_URL: "http://supervisor",
    OPENCODE_MCP_TOOL_PROFILE: "compact", OPENCODE_NATIVE_HA_MCP_ENABLED: "false",
    OPENCODE_DECISION_NOTES: "false", SCREENSHOT_ENABLED: "false",
  };
}

export async function openBackend(token) {
  const client = new Client({ name: "ha-facing-backend", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: backendEnvironment(token), stderr: "ignore", maxBufferSize: 2 * MAX_RESULT_BYTES,
  });
  try {
    await client.connect(transport, { timeout: CALL_TIMEOUT });
    return client;
  } catch {
    await transport.close();
    throw new Error("Read-only backend unavailable");
  }
}

export async function createReadServer(backend, { timeout = CALL_TIMEOUT } = {}) {
  const catalog = await backend.listTools({}, { timeout });
  const tools = catalog.tools.filter((tool) => allowed.has(tool.name)).map((tool) => ({
    ...tool,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
  if (tools.length !== READ_TOOLS.length || new Set(tools.map((tool) => tool.name)).size !== READ_TOOLS.length) {
    throw new Error("Read-only backend catalog mismatch");
  }
  const server = new Server({ name: "Home Assistant Read-Only", version: "1.0.0" }, {
    capabilities: { tools: { listChanged: false } },
  });
  let busy = false;
  let stopped = false;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!allowed.has(request.params.name)) throw new McpError(ErrorCode.InvalidParams, "Tool not permitted");
    if (stopped) throw new McpError(ErrorCode.InvalidRequest, "Read-only backend closed; reconnect");
    if (busy) throw new McpError(ErrorCode.InvalidRequest, "One call per session is permitted");
    if (Buffer.byteLength(JSON.stringify(request.params.arguments ?? {})) > 16384) {
      throw new McpError(ErrorCode.InvalidParams, "Arguments too large");
    }
    const args = request.params.arguments ?? {};
    for (const key of ["entity_id", "calendar_entity"]) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(args[key]))) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid entity identifier");
      }
    }
    if (request.params.name === "get_calendar_events") {
      const start = args.start === undefined ? Date.now() : Date.parse(args.start);
      const end = args.end === undefined ? Date.now() + 7 * 86400000 : Date.parse(args.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) {
        throw new McpError(ErrorCode.InvalidParams, "Calendar range must be at most 31 days");
      }
    }
    busy = true;
    try {
      const result = await backend.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }, undefined, {
        timeout, maxTotalTimeout: timeout, signal: extra.signal,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new Error("Result too large");
      // Do not relay backend error details, which may contain infrastructure data.
      if (result.isError) throw new Error("Backend tool failed");
      return result;
    } catch {
      // Cancellation on stable is not guaranteed to stop underlying work. Kill
      // this session's child rather than permit timed-out calls to accumulate.
      stopped = true;
      // SDK child termination may take four more seconds. Do not add that to
      // HA's response deadline, and refuse all further work on this backend.
      void backend.close().catch(() => {});
      return { isError: true, content: [{ type: "text", text: "Read failed or exceeded its bound; reconnect to retry." }] };
    } finally {
      busy = false;
    }
  });
  return server;
}
