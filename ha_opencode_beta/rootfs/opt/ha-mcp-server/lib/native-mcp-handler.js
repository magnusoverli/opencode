import {
  createJsonRpcError,
  createNativeMcpForwarder,
  DEFAULT_NATIVE_MCP_ENDPOINT_MODE,
  NATIVE_MCP_ASSIST_API_ID,
  validateJsonRpcMessage,
} from "./ha-native-mcp.js";
import { sanitizeToolsListResult } from "./native-mcp-schema.js";

export function createNativeMcpHandler({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl,
  apiId = NATIVE_MCP_ASSIST_API_ID,
  endpointMode = DEFAULT_NATIVE_MCP_ENDPOINT_MODE,
  timeoutMs = 60_000,
  sanitizeSchemas = true,
  onLog = () => {},
} = {}) {
  if (!supervisorToken) throw new Error("SUPERVISOR_TOKEN is required");

  let loggedSchemaRepair = false;
  const forwarder = createNativeMcpForwarder({
    fetchImpl,
    supervisorToken,
    baseUrl,
    apiId,
    endpointMode,
    timeoutMs,
    onEndpointFallback: (details) => onLog("info", "Native MCP fell back to the configured endpoint", details),
    onEndpointRecovered: (details) => onLog("info", "Native MCP recovered its keyed endpoint", details),
  });
  const activeRequests = new Map();

  function requestKey(id) {
    return `${typeof id}:${String(id)}`;
  }

  return async function handleNativeMcp(message, { signal, protocolVersion } = {}) {
    const validation = validateJsonRpcMessage(message);
    if (!validation.valid) {
      return createJsonRpcError(validation.id, -32600, "Invalid Request", {
        reason: validation.reason,
      });
    }

    const effectiveProtocolVersion = protocolVersion
      ?? (message.method === "initialize" ? message.params?.protocolVersion : undefined);
    if (message.method === "notifications/cancelled") {
      const active = activeRequests.get(requestKey(message.params?.requestId));
      active?.abort("MCP request cancelled");
      return forwarder.send(message, { signal, protocolVersion: effectiveProtocolVersion });
    }

    const tracksRequest = message.id !== undefined && typeof message.method === "string";
    const key = tracksRequest ? requestKey(message.id) : null;
    if (key && activeRequests.has(key)) {
      return createJsonRpcError(message.id, -32600, "Duplicate in-flight request ID");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    if (key) activeRequests.set(key, controller);

    let response;
    try {
      response = await forwarder.send(message, {
        signal: controller.signal,
        protocolVersion: effectiveProtocolVersion,
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      if (key && activeRequests.get(key) === controller) activeRequests.delete(key);
    }
    if (!response || message.method !== "tools/list" || !sanitizeSchemas) return response;

    const sanitized = sanitizeToolsListResult(response.result);
    if (!sanitized.repairedTools) return response;
    if (!loggedSchemaRepair) {
      loggedSchemaRepair = true;
      onLog("info", "Repaired Home Assistant native MCP tool schemas", {
        repaired_tools: sanitized.repairedTools,
        tools: sanitized.repairedToolNames,
      });
    }
    return { ...response, result: sanitized.result };
  };
}
