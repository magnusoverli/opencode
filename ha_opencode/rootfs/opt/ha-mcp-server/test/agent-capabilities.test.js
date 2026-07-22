import { describe, it, expect } from "vitest";
import { buildAgentCapabilities, meetsHaVersion } from "../lib/agent-capabilities.js";

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

  it("reports the upstream limitations of Home Assistant releases before 2026.8", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.7.3", components: ["conversation", "mcp_server"] },
    });

    const { known_issues: knownIssues } = capabilities.home_assistant.native_mcp;
    expect(knownIssues.map((issue) => issue.id)).toEqual([
      "keyed_endpoints_unavailable",
      "tool_schema_anyof_empty",
      "streamable_endpoint_crash_risk",
    ]);
    expect(capabilities.home_assistant.native_llm_platform.version_supported).toBe(false);
    expect(capabilities.home_assistant.native_llm_platform.minimum_version).toBe("2026.8.0");
  });

  it("reports no known issues once Home Assistant 2026.8 is running", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.8.0", components: ["conversation", "llm"] },
    });

    expect(capabilities.home_assistant.native_mcp.known_issues).toEqual([]);
    expect(capabilities.home_assistant.native_llm_platform.version_supported).toBe(true);
  });

  it("stays silent about known issues when the version cannot be parsed", () => {
    const capabilities = buildAgentCapabilities({ haConfig: { components: [] } });

    expect(capabilities.home_assistant.native_mcp.known_issues).toEqual([]);
    expect(capabilities.home_assistant.native_llm_platform.version_supported).toBeNull();
  });

  it("separates conversation agents from AI task providers", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: {
        version: "2026.8.0",
        components: ["conversation", "wyoming", "anthropic", "ovhcloud_ai_endpoints"],
      },
    });

    const { native_ai_components: ai } = capabilities.home_assistant;
    expect(ai.conversation_agents).toEqual(["anthropic", "ovhcloud_ai_endpoints", "wyoming"]);
    expect(ai.ai_task_providers).toEqual(["anthropic"]);
    // lmstudio is not a Home Assistant integration and must not be probed for.
    expect(ai.known_components_checked).not.toContain("lmstudio");
    expect(ai.known_components_checked).toContain("ovhcloud_ai_endpoints");
  });
});

describe("meetsHaVersion", () => {
  it("compares Home Assistant version strings", () => {
    expect(meetsHaVersion("2026.8.0", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2026.8.1", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2026.9.0", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2027.1.0", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2026.7.3", "2026.8.0")).toBe(false);
    expect(meetsHaVersion("2025.12.4", "2026.8.0")).toBe(false);
  });

  it("treats pre-releases of the target version as meeting it", () => {
    expect(meetsHaVersion("2026.8.0b0", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2026.8.0.dev0", "2026.8.0")).toBe(true);
    expect(meetsHaVersion("2026.7.0b4", "2026.8.0")).toBe(false);
  });

  it("returns null for versions it cannot parse", () => {
    expect(meetsHaVersion("unknown", "2026.8.0")).toBeNull();
    expect(meetsHaVersion(undefined, "2026.8.0")).toBeNull();
  });
});
