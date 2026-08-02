import { describe, expect, it } from "vitest";
import {
  normalizeChatCompletionsEndpoint,
  parseToolCall,
  scenarioAppliesToProfile,
  scoreScenario,
  toOpenAiTools,
} from "../lib/agent-evaluation.js";

const scenario = {
  minimum_profile: "configuration",
  tools: [
    { name: "get_integration_docs", description: "Docs", parameters: { type: "object" } },
    { name: "write_config_safe", description: "Validate", parameters: { type: "object" } },
  ],
  expect: {
    required_tools: ["get_integration_docs", "write_config_safe"],
    forbidden_tools: ["call_service"],
    arguments: [{ tool: "write_config_safe", path: "dry_run", equals: true }],
  },
};

describe("agent evaluation helpers", () => {
  it("normalizes common OpenAI-compatible endpoint forms", () => {
    expect(normalizeChatCompletionsEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(normalizeChatCompletionsEndpoint("https://example.test/v1")).toBe("https://example.test/v1/chat/completions");
    expect(normalizeChatCompletionsEndpoint("https://example.test/v1/chat/completions")).toBe("https://example.test/v1/chat/completions");
  });

  it("keeps scenarios within the selected MCP profile", () => {
    expect(scenarioAppliesToProfile(scenario, "compact")).toBe(false);
    expect(scenarioAppliesToProfile(scenario, "configuration")).toBe(true);
    expect(scenarioAppliesToProfile(scenario, "full")).toBe(true);
  });

  it("converts synthetic tools and parses a tool call", () => {
    expect(toOpenAiTools(scenario)[0]).toMatchObject({ type: "function", function: { name: "get_integration_docs" } });
    expect(parseToolCall({ function: { name: "write_config_safe", arguments: '{"dry_run":true}' } })).toMatchObject({
      name: "write_config_safe",
      arguments: { dry_run: true },
      valid: true,
    });
  });

  it("scores required tools, safe arguments, and a final response", () => {
    const result = scoreScenario(scenario, [
      { name: "get_integration_docs", valid: true, arguments: {} },
      { name: "write_config_safe", valid: true, arguments: { dry_run: true } },
    ], "The dry run passed.");
    expect(result.passed).toBe(true);
  });

  it("fails missing, malformed, or unknown tool calls", () => {
    const result = scoreScenario(scenario, [
      { name: "unknown", valid: false, rawArguments: "{" },
    ], "");
    expect(result.passed).toBe(false);
    expect(result.invalid_calls).toHaveLength(1);
  });
});
