import { describe, it, expect, vi } from "vitest";

import {
  buildNativeMcpUrl,
  createJsonRpcError,
  createNativeMcpForwarder,
  createNativeMcpInitializeMessage,
  forwardJsonRpcToNativeMcp,
  NATIVE_MCP_PROTOCOL_VERSION,
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

  it("reports an unknown LLM API ID instead of falling back to a different API", async () => {
    // Home Assistant >= 2026.8 answers 404 with this body when the endpoint
    // exists but the ID does not. Falling back would serve the configured API
    // in its place and hide the misconfiguration.
    const fetchImpl = vi.fn(async () => new Response("Unknown LLM API 'nope'", { status: 404 }));
    const onEndpointFallback = vi.fn();

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "nope",
      onEndpointFallback,
    });

    const response = await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onEndpointFallback).not.toHaveBeenCalled();
    expect(response.error.message).toContain("'nope'");
    expect(response.error.data.api_id).toBe("nope");
    expect(forwarder.activeApiId).toBe("nope");
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

  it("retries the keyed endpoint after the latch ages out", async () => {
    // Upgrading Home Assistant to 2026.8 restarts Core but not the add-on, so a
    // bridge that fell back on 2026.7 has to find the keyed endpoint by itself.
    // A Response body can only be read once, so each call gets a fresh one.
    let firstCall = true;
    const fetchImpl = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        return new Response("404: Not Found", { status: 404 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} });
    });
    const onEndpointRecovered = vi.fn();
    let clock = 0;

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      fallbackRetryMs: 1000,
      now: () => clock,
      onEndpointRecovered,
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(forwarder.activeApiId).toBeNull();

    // Still inside the retry window: stays on the configured endpoint.
    clock = 999;
    await forwarder.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(onEndpointRecovered).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe("http://supervisor/core/api/mcp");

    // Past the window: the keyed endpoint is tried again, and now answers.
    clock = 1000;
    await forwarder.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(onEndpointRecovered).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe("http://supervisor/core/api/mcp/assist");
    expect(forwarder.activeApiId).toBe("assist");
  });

  it("reports the fallback once, not on every retry", async () => {
    // A Home Assistant that never gains the keyed endpoint keeps failing the
    // retry. Reporting each one would log forever on every 2026.7 install.
    const fetchImpl = vi.fn(async (url) => (
      String(url).endsWith("/mcp/assist")
        ? new Response("404: Not Found", { status: 404 })
        : jsonResponse({ jsonrpc: "2.0", id: 1, result: {} })
    ));
    const onEndpointFallback = vi.fn();
    const onEndpointRecovered = vi.fn();
    let clock = 0;

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      fallbackRetryMs: 1000,
      now: () => clock,
      onEndpointFallback,
      onEndpointRecovered,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock = attempt * 1000;
      await forwarder.send({ jsonrpc: "2.0", id: attempt, method: "tools/list" });
    }

    expect(onEndpointFallback).toHaveBeenCalledOnce();
    expect(onEndpointRecovered).not.toHaveBeenCalled();
    // Every request still resolved on the configured endpoint.
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe("http://supervisor/core/api/mcp");
  });

  it("reports the fallback again after a recovery and a second outage", async () => {
    const responses = [
      new Response("404: Not Found", { status: 404 }),               // keyed gone
      jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),           // configured
      jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }),           // keyed back
      new Response("404: Not Found", { status: 404 }),               // keyed gone again
      jsonResponse({ jsonrpc: "2.0", id: 3, result: {} }),           // configured
    ];
    const fetchImpl = vi.fn(async () => responses.shift());
    const onEndpointFallback = vi.fn();
    const onEndpointRecovered = vi.fn();
    let clock = 0;

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      fallbackRetryMs: 1000,
      now: () => clock,
      onEndpointFallback,
      onEndpointRecovered,
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    clock = 1000;
    await forwarder.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    clock = 2000;
    await forwarder.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    expect(onEndpointRecovered).toHaveBeenCalledOnce();
    expect(onEndpointFallback).toHaveBeenCalledTimes(2);
  });

  it("keeps the fallback latched forever when the retry is disabled", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("404: Not Found", { status: 404 }))
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    let clock = 0;

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      fallbackRetryMs: 0,
      now: () => clock,
    });

    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    clock = 10 ** 9;
    await forwarder.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(forwarder.activeApiId).toBeNull();
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe("http://supervisor/core/api/mcp");
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

  it("sends the MCP protocol version header the spec requires", async () => {
    // Home Assistant does not read this header today, but the Supervisor proxy
    // forwards it by name, so the bridge stays correct if Core starts enforcing
    // it. The declared version must match what initialize declares.
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));

    await forwardJsonRpcToNativeMcp({
      fetchImpl,
      supervisorToken: "token",
      apiId: "assist",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    const { headers } = fetchImpl.mock.calls[0][1];
    expect(headers["MCP-Protocol-Version"]).toBe(NATIVE_MCP_PROTOCOL_VERSION);
    expect(createNativeMcpInitializeMessage().params.protocolVersion).toBe(
      NATIVE_MCP_PROTOCOL_VERSION
    );
  });

  it("does not blame add-on access for an unknown LLM API ID", async () => {
    // Keyed endpoints other than 'assist' require admin, which reads as a wall
    // for an add-on and is not one: the Supervisor calls Core as its own admin
    // system user. Telling the user access might be the problem would send them
    // hunting for a permission fix that does not exist.
    const fetchImpl = vi.fn(async () => new Response("Unknown LLM API 'nope'", { status: 404 }));

    const forwarder = createNativeMcpForwarder({
      fetchImpl,
      supervisorToken: "token",
      apiId: "nope",
    });

    const { hint } = (await forwarder.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).error.data;

    expect(hint).toMatch(/reachable from an add-on/);
    expect(hint).not.toMatch(/may not be able to reach/);
  });
});
