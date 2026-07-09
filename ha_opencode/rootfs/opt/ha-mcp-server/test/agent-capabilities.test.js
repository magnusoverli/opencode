import { describe, it, expect } from "vitest";
import { buildAgentCapabilities } from "../lib/agent-capabilities.js";

describe("buildAgentCapabilities", () => {
  it("reports native LLM as detected when the llm component is loaded", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.7.0", components: ["conversation", "llm", "ollama"] },
      nativeMcp: {
        configured_api_id: "assist",
        configured: {
          api_id: "assist",
          available: true,
          status: "available",
          endpoint: "http://supervisor/core/api/mcp/assist",
        },
        assist: {
          available: true,
          status: "available",
          endpoint: "http://supervisor/core/api/mcp/assist",
        },
        base: {
          available: false,
          status: "not_found",
          endpoint: "http://supervisor/core/api/mcp",
        },
      },
      tools: [{ name: "get_states" }, { name: "get_agent_capabilities" }],
      resources: [{ uri: "ha://config" }],
      resourceTemplates: [{ uriTemplate: "ha://states/{domain}" }],
      prompts: [{ name: "create_automation" }],
    });

    expect(capabilities.home_assistant.version).toBe("2026.7.0");
    expect(capabilities.home_assistant.native_llm_component.detected).toBe(true);
    expect(capabilities.home_assistant.native_llm_component.status).toBe("detected");
    expect(capabilities.home_assistant.external_native_llm_api.available_to_addons).toBe(true);
    expect(capabilities.home_assistant.external_native_llm_api.configured_api_id).toBe("assist");
    expect(capabilities.home_assistant.native_mcp.status).toBe("configured_api_available");
    expect(capabilities.home_assistant.native_mcp.recommended_mode).toBe("hybrid_native_llm_api_plus_opencode_mcp");
    expect(capabilities.home_assistant.native_mcp.configured_endpoint_status).toBe("available");
    expect(capabilities.home_assistant.native_mcp.assist_endpoint_status).toBe("available");
    expect(capabilities.home_assistant.native_ai_components.loaded).toContain("ollama");
    expect(capabilities.mcp.tools).toBe(2);
    expect(capabilities.mcp.resources).toBe(1);
    expect(capabilities.mcp.resource_templates).toBe(1);
    expect(capabilities.mcp.prompts).toBe(1);
    expect(capabilities.mcp.tool_names).toContain("get_agent_capabilities");
    expect(capabilities.mcp.client_compatibility.call_tool_fields).toEqual(["content", "isError"]);
  });

  it("reports native LLM as not detected by default", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { components: ["conversation"] },
    });

    expect(capabilities.home_assistant.version).toBe("unknown");
    expect(capabilities.home_assistant.native_llm_component.detected).toBe(false);
    expect(capabilities.home_assistant.native_llm_component.status).toBe("not_detected");
    expect(capabilities.home_assistant.external_native_llm_api.available_to_addons).toBe(false);
    expect(capabilities.home_assistant.external_native_llm_api.configured_api_id).toBe("assist");
    expect(capabilities.home_assistant.native_mcp.status).toBe("not_available");
    expect(capabilities.home_assistant.native_mcp.recommended_mode).toBe("opencode_mcp_only");
    expect(capabilities.home_assistant.native_ai_components.loaded).toEqual([]);
    expect(capabilities.roadmap.next.length).toBeGreaterThan(0);
  });

  it("reports configured custom native MCP API availability", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.7.0", components: ["conversation", "llm"] },
      nativeMcp: {
        configured_api_id: "my_custom_api",
        configured: {
          api_id: "my_custom_api",
          available: true,
          status: "available",
          endpoint: "http://supervisor/core/api/mcp/my_custom_api",
        },
        assist: {
          api_id: "assist",
          available: false,
          status: "not_found",
          endpoint: "http://supervisor/core/api/mcp/assist",
        },
      },
    });

    expect(capabilities.home_assistant.external_native_llm_api.available_to_addons).toBe(true);
    expect(capabilities.home_assistant.external_native_llm_api.configured_api_id).toBe("my_custom_api");
    expect(capabilities.home_assistant.native_mcp.status).toBe("configured_api_available");
    expect(capabilities.home_assistant.native_mcp.configured_endpoint_status).toBe("available");
    expect(capabilities.home_assistant.native_mcp.assist_endpoint_status).toBe("not_found");
  });

  it("reports configured catch-all native MCP endpoint availability", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.7.0", components: ["conversation", "llm"] },
      nativeMcp: {
        configured_api_id: null,
        configured_endpoint_mode: "configured_api",
        configured: {
          api_id: null,
          available: true,
          status: "available",
          endpoint: "http://supervisor/core/api/mcp",
        },
      },
    });

    expect(capabilities.home_assistant.external_native_llm_api.available_to_addons).toBe(true);
    expect(capabilities.home_assistant.external_native_llm_api.configured_api_id).toBeNull();
    expect(capabilities.home_assistant.external_native_llm_api.configured_endpoint_mode).toBe("configured_api");
    expect(capabilities.home_assistant.native_mcp.configured_endpoint_status).toBe("available");
    expect(capabilities.home_assistant.native_mcp.configured_endpoint_mode).toBe("configured_api");
  });
});
