import { describe, it, expect, vi } from "vitest";

import {
  buildNativeMcpUrl,
  createJsonRpcError,
  createNativeMcpForwarder,
  forwardJsonRpcToNativeMcp,
  normalizeNativeMcpApiId,
  normalizeNativeMcpEndpointMode,
  probeNativeMcpEndpoint,
  validateJsonRpcMessage,
} from "../lib/ha-native-mcp.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Home Assistant native MCP helpers", () => {
  it("builds base and keyed native MCP URLs", () => {
    expect(buildNativeMcpUrl({ baseUrl: "http://supervisor/core/api/" })).toBe(
      "http://supervisor/core/api/mcp"
    );
    expect(buildNativeMcpUrl({ baseUrl: "http://supervisor/core/api", apiId: "assist" })).toBe(
      "http://supervisor/core/api/mcp/assist"
    );
    expect(buildNativeMcpUrl({ baseUrl: "http://supervisor/core/api", apiId: "custom api" })).toBe(
      "http://supervisor/core/api/mcp/custom%20api"
    );
  });

  it("normalizes configured native MCP API IDs", () => {
    expect(normalizeNativeMcpApiId(" custom_api ")).toBe("custom_api");
    expect(normalizeNativeMcpApiId("")).toBe("assist");
    expect(normalizeNativeMcpApiId("", { allowBaseEndpoint: true })).toBeNull();
    expect(normalizeNativeMcpApiId(null)).toBe("assist");
  });

  it("reports an available native MCP endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "opencode-native-mcp-probe",
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "Home Assistant", version: "2026.7.0" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const probe = await probeNativeMcpEndpoint({
      fetchImpl,
      supervisorToken: "token",
      baseUrl: "http://supervisor/core/api",
      apiId: "assist",
    });

    expect(probe.available).toBe(true);
    expect(probe.status).toBe("available");
    expect(probe.endpoint).toBe("http://supervisor/core/api/mcp/assist");
    expect(probe.server_info.name).toBe("Home Assistant");
  });

  it("reports missing native MCP endpoint as not found", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unknown LLM API", { status: 404 }));

    const probe = await probeNativeMcpEndpoint({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
    });

    expect(probe.available).toBe(false);
    expect(probe.reachable).toBe(true);
    expect(probe.status).toBe("not_found");
    expect(probe.http_status).toBe(404);
  });

  it("does not treat JSON-RPC errors as available", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "opencode-native-mcp-probe",
      error: { code: -32601, message: "Method not found" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const probe = await probeNativeMcpEndpoint({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
    });

    expect(probe.available).toBe(false);
    expect(probe.status).toBe("jsonrpc_error");
    expect(probe.detail).toBe("Method not found");
  });

  it("forwards JSON-RPC requests to native MCP", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const response = await forwardJsonRpcToNativeMcp({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(response.result.tools).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("converts HTTP failures to JSON-RPC errors for requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("Nope", { status: 500 }));

    const response = await forwardJsonRpcToNativeMcp({
      fetchImpl,
      supervisorToken: "token",
      message: { jsonrpc: "2.0", id: "abc", method: "tools/list" },
    });

    expect(response.error.code).toBe(-32000);
    expect(response.id).toBe("abc");
    expect(response.error.data.status).toBe(500);
  });

  it("creates JSON-RPC errors", () => {
    expect(createJsonRpcError(null, -32700, "Parse error")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });
});

describe("native MCP endpoint negotiation", () => {
  it("normalizes endpoint modes and defaults unknown values to auto", () => {
    expect(normalizeNativeMcpEndpointMode("KEYED")).toBe("keyed");
    expect(normalizeNativeMcpEndpointMode(" configured ")).toBe("configured");
    expect(normalizeNativeMcpEndpointMode("nonsense")).toBe("auto");
    expect(normalizeNativeMcpEndpointMode()).toBe("auto");
  });

  it("falls back to the configured endpoint when the keyed one is missing", async () => {
    // Home Assistant <= 2026.7 has no /api/mcp/<API ID> view at all.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("404: Not Found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    const onEndpointFallback = vi.fn();

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      baseUrl: "http://supervisor/core/api",
      apiId: "assist",
      onEndpointFallback,
    });

    const response = await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response.result.tools).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://supervisor/core/api/mcp/assist");
    expect(fetchImpl.mock.calls[1][0]).toBe("http://supervisor/core/api/mcp");
    expect(onEndpointFallback).toHaveBeenCalledOnce();
    expect(onEndpointFallback.mock.calls[0][0].reason).toBe("keyed_endpoint_unavailable");
    expect(forwarder.activeApiId).toBeNull();
  });

  it("distinguishes an unknown LLM API ID from a missing keyed endpoint", async () => {
    // Home Assistant >= 2026.8 answers 404 with this body for a bad API ID.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("Unknown LLM API 'nope'", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    const onEndpointFallback = vi.fn();

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "nope",
      onEndpointFallback,
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(onEndpointFallback.mock.calls[0][0].reason).toBe("unknown_llm_api_id");
  });

  it("latches the fallback so later requests skip the keyed endpoint", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("404: Not Found", { status: 404 }))
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await forwarder.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2][0]).toBe("http://supervisor/core/api/mcp");
  });

  it("does not fall back in keyed mode", async () => {
    const fetchImpl = vi.fn(async () => new Response("404: Not Found", { status: 404 }));

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      endpointMode: "keyed",
    });

    const response = await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(response.error.data.status).toBe(404);
  });

  it("uses the configured endpoint directly in configured mode", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      endpointMode: "configured",
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(fetchImpl.mock.calls[0][0]).toBe("http://supervisor/core/api/mcp");
    expect(forwarder.activeApiId).toBeNull();
  });

  it("returns 202 notifications as no response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));

    const forwarder = createNativeMcpForwarder({ fetchImpl, supervisorToken: "token" });
    const response = await forwarder.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(response).toBeNull();
  });
});

describe("JSON-RPC message validation", () => {
  it("accepts requests, notifications and responses", () => {
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }).valid).toBe(true);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).valid).toBe(true);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: {} }).valid).toBe(true);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }).valid).toBe(true);
  });

  it("rejects the malformed payloads that can crash Home Assistant Core", () => {
    // home-assistant/core#176734: bare and malformed POSTs to /api/mcp.
    expect(validateJsonRpcMessage(null).valid).toBe(false);
    expect(validateJsonRpcMessage("hello").valid).toBe(false);
    expect(validateJsonRpcMessage({}).valid).toBe(false);
    expect(validateJsonRpcMessage({ jsonrpc: "1.0", method: "tools/list" }).valid).toBe(false);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", method: "" }).valid).toBe(false);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", method: 42 }).valid).toBe(false);
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", id: 1 }).valid).toBe(false);
  });

  it("rejects JSON-RPC batches, which MCP no longer uses", () => {
    const result = validateJsonRpcMessage([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/JSON-RPC object/);
  });

  it("reports the message id so the error can be correlated", () => {
    expect(validateJsonRpcMessage({ jsonrpc: "2.0", id: "abc" }).id).toBe("abc");
  });
});
