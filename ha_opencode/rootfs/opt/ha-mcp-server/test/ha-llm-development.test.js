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
    expect(guide).toContain("class MyTool(Tool)");
    expect(guide).toContain("api_id: str");
    expect(guide).toContain("LLMTools | None");
    expect(guide).toContain("tool_input.tool_args");
    expect(guide).toContain("/api/mcp/<API ID>");
    expect(guide).toContain("/api/mcp");
    expect(guide).toContain("require admin access except for Assist");
    expect(guide).toContain("async_get_api_instance");
    expect(guide).toContain("custom_serializer");
  });

  it("states the Home Assistant release that first ships the platform", () => {
    const guide = buildHaLlmDevelopmentGuide();

    expect(guide).toContain("Home Assistant 2026.8");
    expect(guide).toContain("2026.7.x or earlier");
  });

  it("uses the upstream import idiom rather than the components.llm namespace", () => {
    const guide = buildHaLlmDevelopmentGuide();

    expect(guide).toContain("from homeassistant.components.llm import LLMTools");
    expect(guide).toContain("from homeassistant.helpers.llm import LLM_API_ASSIST, IntentTool, LLMContext, Tool");
    expect(guide).not.toContain("llm.LLMTools | None");
  });

  it("leads with the exposure-gated IntentTool pattern", () => {
    const guide = buildHaLlmDevelopmentGuide();

    expect(guide).toContain("async_should_expose");
    expect(guide).toContain("IntentTool(handler.intent_type, handler)");
    expect(guide).toContain("if api_id != LLM_API_ASSIST");
    expect(guide).toContain("No manifest change is needed");
  });

  it("documents the schema conversion gotcha that breaks strict MCP clients", () => {
    const guide = buildHaLlmDevelopmentGuide();

    expect(guide).toContain("home-assistant/core#176814");
    expect(guide).toContain("__unparsedToolInput");
    expect(guide).toContain("vol.All(cv.ensure_list, [cv.string])");
  });

  it("flags the deprecations and refactors that make older snippets stale", () => {
    const guide = buildHaLlmDevelopmentGuide();

    expect(guide).toContain("async_render_no_api_prompt");
    expect(guide).toContain("home-assistant/core#176082");
    expect(guide).toContain("LLMContext.assistant");
  });
});
