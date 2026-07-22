const DEFAULT_SUPERVISOR_API = "http://supervisor/core/api";

export const NATIVE_MCP_ASSIST_API_ID = "assist";
export const NATIVE_MCP_PROTOCOL_VERSION = "2025-11-25";

/**
 * Endpoint selection for the native MCP bridge.
 *
 * - `auto`: prefer the keyed `/api/mcp/<API ID>` endpoint and fall back to the
 *   configured `/api/mcp` endpoint if it answers 404. Keyed endpoints only
 *   exist from Home Assistant 2026.8 (home-assistant/core#175570), so on every
 *   earlier release the fallback is what makes the bridge usable at all.
 * - `keyed`: only ever use `/api/mcp/<API ID>`.
 * - `configured`: only ever use `/api/mcp`.
 */
export const NATIVE_MCP_ENDPOINT_MODES = ["auto", "keyed", "configured"];
export const DEFAULT_NATIVE_MCP_ENDPOINT_MODE = "auto";

export function normalizeNativeMcpEndpointMode(mode = DEFAULT_NATIVE_MCP_ENDPOINT_MODE) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return NATIVE_MCP_ENDPOINT_MODES.includes(normalized)
    ? normalized
    : DEFAULT_NATIVE_MCP_ENDPOINT_MODE;
}

export function normalizeNativeMcpApiId(apiId = NATIVE_MCP_ASSIST_API_ID, { allowBaseEndpoint = false } = {}) {
  const normalized = String(apiId ?? "").trim();
  if (!normalized && allowBaseEndpoint) return null;
  return normalized || NATIVE_MCP_ASSIST_API_ID;
}

export function buildNativeMcpUrl({
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId,
} = {}) {
  const normalizedBase = String(baseUrl).replace(/\/+$/, "");
  if (!apiId) return `${normalizedBase}/mcp`;
  return `${normalizedBase}/mcp/${encodeURIComponent(apiId)}`;
}

export function createNativeMcpInitializeMessage(id = "opencode-native-mcp-probe") {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: NATIVE_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "opencode-home-assistant",
        version: "1.0.0",
      },
    },
  };
}

export function createJsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error,
  };
}

export async function requestNativeMcp({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId = null,
  message,
  timeoutMs = 60000,
} = {}) {
  if (!supervisorToken) {
    throw new Error("SUPERVISOR_TOKEN is required for Home Assistant native MCP");
  }
  if (!message || typeof message !== "object") {
    throw new Error("A JSON-RPC message object is required");
  }

  const endpoint = buildNativeMcpUrl({ baseUrl, apiId });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supervisorToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      // Keep the raw text for diagnostics; callers decide how to handle it.
    }
  }

  return {
    endpoint,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    json,
  };
}

export async function probeNativeMcpEndpoint({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId,
  timeoutMs = 5000,
} = {}) {
  const endpoint = buildNativeMcpUrl({ baseUrl, apiId });
  const probe = {
    endpoint,
    api_id: apiId || null,
    available: false,
    reachable: false,
    authorized: false,
    http_status: null,
    status: "unknown",
    detail: "Not checked yet.",
  };

  if (!supervisorToken) {
    return {
      ...probe,
      status: "missing_token",
      detail: "SUPERVISOR_TOKEN is not available to probe Home Assistant native MCP.",
    };
  }

  try {
    const response = await requestNativeMcp({
      fetchImpl,
      supervisorToken,
      baseUrl,
      apiId,
      message: createNativeMcpInitializeMessage(),
      timeoutMs,
    });

    const detail = response.text ? response.text.slice(0, 500) : response.statusText;
    const result = response.json?.result || {};

    if (response.ok && response.json?.result) {
      return {
        ...probe,
        available: true,
        reachable: true,
        authorized: true,
        http_status: response.status,
        status: "available",
        detail: "Native Home Assistant MCP endpoint accepted an initialize request.",
        server_info: result.serverInfo || null,
        protocol_version: result.protocolVersion || null,
      };
    }

    if (response.ok && response.json?.error) {
      return {
        ...probe,
        reachable: true,
        authorized: true,
        http_status: response.status,
        status: "jsonrpc_error",
        detail: response.json.error.message || "Native Home Assistant MCP endpoint returned a JSON-RPC error.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ...probe,
        reachable: true,
        authorized: false,
        http_status: response.status,
        status: "unauthorized",
        detail: detail || "Home Assistant rejected the Supervisor token for this endpoint.",
      };
    }

    if (response.status === 404) {
      return {
        ...probe,
        reachable: true,
        authorized: true,
        http_status: response.status,
        status: "not_found",
        detail: detail || "Native Home Assistant MCP endpoint was not found.",
      };
    }

    return {
      ...probe,
      reachable: true,
      authorized: true,
      http_status: response.status,
      status: "unexpected_response",
      detail: detail || "Native Home Assistant MCP endpoint returned an unexpected response.",
    };
  } catch (error) {
    return {
      ...probe,
      status: error?.name === "TimeoutError" ? "timeout" : "request_error",
      detail: error?.message || String(error),
    };
  }
}

function mapNativeMcpResponse(response, id) {
  if (response.status === 202) return null;
  if (response.ok && response.json) return response.json;

  if (id === undefined) return null;

  return createJsonRpcError(
    id,
    -32000,
    `Home Assistant native MCP request failed with HTTP ${response.status}`,
    {
      endpoint: response.endpoint,
      status: response.status,
      body: response.text?.slice(0, 1000) || response.statusText,
    }
  );
}

export async function forwardJsonRpcToNativeMcp({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId = NATIVE_MCP_ASSIST_API_ID,
  message,
  timeoutMs = 60000,
} = {}) {
  const id = message?.id;

  try {
    const response = await requestNativeMcp({
      fetchImpl,
      supervisorToken,
      baseUrl,
      apiId: normalizeNativeMcpApiId(apiId, { allowBaseEndpoint: true }),
      message,
      timeoutMs,
    });

    return mapNativeMcpResponse(response, id);
  } catch (error) {
    if (id === undefined) return null;
    return createJsonRpcError(id, -32000, "Home Assistant native MCP request failed", {
      message: error?.message || String(error),
    });
  }
}

/**
 * Validate a client message before it is forwarded to Home Assistant.
 *
 * Home Assistant Core has crashed on malformed POSTs to `/api/mcp`
 * (home-assistant/core#176734, fix still open at the time of writing), so the
 * bridge rejects anything that is not a well-formed JSON-RPC 2.0 message rather
 * than passing it through. JSON-RPC batches (arrays) are rejected too: MCP
 * dropped batching, and Home Assistant validates one message per request.
 */
export function validateJsonRpcMessage(message) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { valid: false, id: null, reason: "Message must be a JSON-RPC object" };
  }

  const id = message.id ?? null;

  if (message.jsonrpc !== "2.0") {
    return { valid: false, id, reason: "Message must set jsonrpc to \"2.0\"" };
  }

  if (typeof message.method === "string" && message.method.length > 0) {
    return { valid: true, id, reason: null };
  }

  if ("method" in message) {
    return { valid: false, id, reason: "Message method must be a non-empty string" };
  }

  const isResponse = "result" in message
    || (typeof message.error === "object" && message.error !== null);
  if (isResponse && message.id !== undefined) {
    return { valid: true, id, reason: null };
  }

  return { valid: false, id, reason: "Message must be a JSON-RPC request, notification, or response" };
}

function isUnknownLlmApiResponse(response) {
  return typeof response?.text === "string" && response.text.includes("Unknown LLM API");
}

/**
 * Create a stateful forwarder that negotiates which native MCP endpoint to use.
 *
 * The negotiated choice is latched for the lifetime of the forwarder so a
 * long-lived bridge process does not re-probe a missing keyed endpoint on
 * every single request.
 */
export function createNativeMcpForwarder({
  fetchImpl = fetch,
  supervisorToken,
  baseUrl = DEFAULT_SUPERVISOR_API,
  apiId = NATIVE_MCP_ASSIST_API_ID,
  endpointMode = DEFAULT_NATIVE_MCP_ENDPOINT_MODE,
  timeoutMs = 60000,
  onEndpointFallback = null,
} = {}) {
  const mode = normalizeNativeMcpEndpointMode(endpointMode);
  const configuredApiId = normalizeNativeMcpApiId(apiId, { allowBaseEndpoint: true });
  let activeApiId = mode === "configured" ? null : configuredApiId;
  let fellBack = false;

  async function request(message, requestApiId) {
    return requestNativeMcp({
      fetchImpl,
      supervisorToken,
      baseUrl,
      apiId: requestApiId,
      message,
      timeoutMs,
    });
  }

  return {
    get endpointMode() {
      return mode;
    },
    get activeApiId() {
      return activeApiId;
    },
    get endpoint() {
      return buildNativeMcpUrl({ baseUrl, apiId: activeApiId });
    },
    async send(message) {
      const id = message?.id;

      try {
        let response = await request(message, activeApiId);

        const canFallBack = mode === "auto" && activeApiId && !fellBack;
        if (canFallBack && response.status === 404) {
          fellBack = true;
          activeApiId = null;
          onEndpointFallback?.({
            from: response.endpoint,
            to: buildNativeMcpUrl({ baseUrl, apiId: null }),
            api_id: configuredApiId,
            reason: isUnknownLlmApiResponse(response)
              ? "unknown_llm_api_id"
              : "keyed_endpoint_unavailable",
          });
          response = await request(message, activeApiId);
        }

        return mapNativeMcpResponse(response, id);
      } catch (error) {
        if (id === undefined) return null;
        return createJsonRpcError(id, -32000, "Home Assistant native MCP request failed", {
          message: error?.message || String(error),
        });
      }
    },
  };
}
