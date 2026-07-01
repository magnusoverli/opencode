/**
 * Agent capability reporting helpers.
 *
 * Keeps Home Assistant native LLM readiness separate from the MCP server
 * transport so it can be tested without a running Home Assistant instance.
 */

const TOOL_HIGHLIGHTS = [
  "safe_config_writing",
  "runtime_state_queries",
  "home_assistant_admin_cli",
  "yaml_lsp_context",
  "visual_verification",
  "firmware_update_monitoring",
  "zigbee_management",
];

const ROADMAP_NOW = [
  "Use OpenCode MCP as the primary external agent surface for Home Assistant configuration, diagnostics, admin workflows, and visual verification.",
  "Detect whether the running Home Assistant instance exposes the native llm component.",
  "Help users and custom integration authors develop and test <integration>/llm.py tool providers from inside OpenCode.",
];

const ROADMAP_NEXT = [
  "Track Home Assistant's llm integration, Assist tool consumption, and developer documentation closely as they land.",
  "Prefer native Home Assistant LLM tools for core Assist/entity control when they become stable and accessible.",
  "Position OpenCode as a premium consumer of HA-native LLM capabilities for users testing agent-focused Home Assistant features.",
  "Keep MCP tools for OpenCode-specific, add-on, admin, development, validation, and safety workflows that Home Assistant Core does not intend to expose through Assist.",
  "Evaluate a companion custom integration or public API bridge if Home Assistant does not expose native LLM tools directly to add-ons.",
];

export function buildAgentCapabilities({
  haConfig = {},
  tools = [],
  resources = [],
  resourceTemplates = [],
  prompts = [],
} = {}) {
  const components = Array.isArray(haConfig.components) ? haConfig.components : [];
  const nativeLlmDetected = components.includes("llm");

  return {
    surface: {
      name: "OpenCode Home Assistant MCP",
      role: "Primary external agent surface for this add-on",
      compatibility: "Additive to Home Assistant's native LLM platform; does not replace Assist.",
    },
    home_assistant: {
      version: haConfig.version || "unknown",
      native_llm_component: {
        component: "llm",
        detected: nativeLlmDetected,
        status: nativeLlmDetected ? "detected" : "not_detected",
        meaning: nativeLlmDetected
          ? "This Home Assistant instance reports the native llm integration as loaded."
          : "This Home Assistant instance does not report the native llm integration yet.",
      },
      external_native_llm_api: {
        available_to_addons: false,
        note: "Home Assistant's initial llm work is an internal integration platform for HA integrations/custom integrations, not an external add-on API.",
      },
    },
    mcp: {
      tools: tools.length,
      resources: resources.length,
      resource_templates: resourceTemplates.length,
      prompts: prompts.length,
      tool_names: tools.map((tool) => tool.name).filter(Boolean),
      highlights: TOOL_HIGHLIGHTS,
      client_compatibility: {
        scope: "Server-local compatibility only; this add-on does not patch or upstream changes to OpenCode's MCP client.",
        list_tools_fields: ["name", "description", "inputSchema"],
        call_tool_fields: ["content", "isError"],
        structured_data_strategy: "Machine-readable summary/data/meta JSON is returned as text content because structuredContent/resourceLinks are kept out of tool responses for OpenCode compatibility.",
        intentionally_stripped_fields: ["title", "annotations", "outputSchema", "structuredContent", "resourceLinks"],
      },
    },
    strategy: {
      current: "Keep existing MCP functionality as the complete working tool surface while Home Assistant's native LLM platform matures.",
      native_first_when_possible: "Adopt Home Assistant native LLM capabilities when they are stable and accessible, without dropping MCP functionality users depend on.",
      boundaries: "Native Assist tools are expected to be curated for conversation/control; OpenCode MCP remains focused on configuration editing, validation, admin/dev tasks, and safety workflows.",
    },
    roadmap: {
      now: ROADMAP_NOW,
      next: ROADMAP_NEXT,
    },
  };
}
