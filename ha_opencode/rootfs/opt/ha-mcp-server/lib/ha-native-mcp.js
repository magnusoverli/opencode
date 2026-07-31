const DEFAULT_SUPERVISOR_API = "http://supervisor/core/api";

export const NATIVE_MCP_ASSIST_API_ID = "assist";
export const NATIVE_MCP_PROTOCOL_VERSION = "2025-11-25";

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
  } catch (error) {
    if (id === undefined) return null;
    return createJsonRpcError(id, -32000, "Home Assistant native MCP request failed", {
      message: error?.message || String(error),
    });
  }
}
