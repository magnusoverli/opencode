import { describe, it, expect, vi } from "vitest";

import {
  buildNativeMcpUrl,
  createJsonRpcError,
  forwardJsonRpcToNativeMcp,
  normalizeNativeMcpApiId,
  probeNativeMcpEndpoint,
} from "../lib/ha-native-mcp.js";

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
