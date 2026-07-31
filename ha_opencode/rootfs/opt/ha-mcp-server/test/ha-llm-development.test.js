import { describe, it, expect } from "vitest";

import { buildHaLlmDevelopmentGuide } from "../lib/ha-llm-development.js";

describe("Home Assistant LLM development guide", () => {
  it("includes upstream references and sanitizes template names", () => {
    const guide = buildHaLlmDevelopmentGuide({
      integration_domain: "My Integration!",
      tool_class: "My Tool!",
    });

    expect(guide).toContain("home-assistant/architecture#1412");
    expect(guide).toContain("home-assistant/core#174253");
    expect(guide).toContain("home-assistant/developers.home-assistant#3236");
    expect(guide).toContain("custom_components/my_integration_/llm.py");
    expect(guide).toContain("class MyTool(llm.Tool)");
    expect(guide).toContain("api_id: str");
    expect(guide).toContain("llm.LLMTools | None");
    expect(guide).toContain("tool_input.tool_args");
    expect(guide).toContain("/api/mcp/<API ID>");
    expect(guide).toContain("/api/mcp");
    expect(guide).toContain("require admin access except for Assist");
    expect(guide).toContain("async_get_api_instance");
    expect(guide).toContain("custom_serializer");
  });
});
