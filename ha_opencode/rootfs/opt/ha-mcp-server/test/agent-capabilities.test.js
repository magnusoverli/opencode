import { describe, it, expect } from "vitest";
import { buildAgentCapabilities } from "../lib/agent-capabilities.js";

describe("buildAgentCapabilities", () => {
  it("reports native LLM as detected when the llm component is loaded", () => {
    const capabilities = buildAgentCapabilities({
      haConfig: { version: "2026.7.0", components: ["conversation", "llm"] },
      tools: [{ name: "get_states" }, { name: "get_agent_capabilities" }],
      resources: [{ uri: "ha://config" }],
      resourceTemplates: [{ uriTemplate: "ha://states/{domain}" }],
      prompts: [{ name: "create_automation" }],
    });

    expect(capabilities.home_assistant.version).toBe("2026.7.0");
    expect(capabilities.home_assistant.native_llm_component.detected).toBe(true);
    expect(capabilities.home_assistant.native_llm_component.status).toBe("detected");
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
    expect(capabilities.roadmap.next.length).toBeGreaterThan(0);
  });
});
