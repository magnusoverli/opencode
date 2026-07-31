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
  "Detect whether the running Home Assistant instance exposes the native llm component and native MCP endpoints.",
  "Help users and custom integration authors develop and test <integration>/llm.py tool providers from inside OpenCode.",
];

const ROADMAP_NEXT = [
  "Track Home Assistant's llm integration, Assist tool consumption, and developer documentation closely as they land.",
  "Prefer native Home Assistant LLM tools for core Assist/entity control when they become stable and accessible.",
  "Position OpenCode as a premium consumer of HA-native LLM capabilities for users testing agent-focused Home Assistant features.",
  "Keep MCP tools for OpenCode-specific, add-on, admin, development, validation, and safety workflows that Home Assistant Core does not intend to expose through Assist.",
  "Evaluate a companion custom integration or public API bridge if Home Assistant does not expose native LLM tools directly to add-ons.",
];

const KNOWN_NATIVE_AI_COMPONENTS = [
  "anthropic",
  "google_generative_ai_conversation",
  "llama_cpp",
  "litellm",
  "lmstudio",
  "ollama",
  "open_router",
  "openai_conversation",
];

export function buildAgentCapabilities({
  haConfig = {},
  nativeMcp = {},
  tools = [],
  resources = [],
  resourceTemplates = [],
  prompts = [],
} = {}) {
  const components = Array.isArray(haConfig.components) ? haConfig.components : [];
  const nativeLlmDetected = components.includes("llm");
  const nativeConfiguredMcp = nativeMcp.configured || nativeMcp.assist || null;
  const nativeConfiguredMcpAvailable = nativeConfiguredMcp?.available === true;
  const nativeConfiguredMcpStatus = nativeConfiguredMcp?.status || "not_checked";
  const configuredApiId = nativeMcp.configured_api_id !== undefined
    ? nativeMcp.configured_api_id
    : nativeConfiguredMcp?.api_id ?? "assist";
  const configuredEndpointMode = nativeMcp.configured_endpoint_mode || (configuredApiId ? "keyed_api" : "configured_api");
  const nativeAssistMcpStatus = nativeMcp.assist?.status || "not_checked";
  const nativeBaseMcpStatus = nativeMcp.base?.status || "not_checked";
  const loadedNativeAiComponents = KNOWN_NATIVE_AI_COMPONENTS.filter((component) => components.includes(component));
  const recommendedMode = nativeConfiguredMcpAvailable
    ? "hybrid_native_llm_api_plus_opencode_mcp"
    : "opencode_mcp_only";

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
        available_to_addons: nativeConfiguredMcpAvailable,
        configured_api_id: configuredApiId || null,
        configured_endpoint_mode: configuredEndpointMode,
        note: nativeConfiguredMcpAvailable
          ? "Home Assistant's native LLM API is reachable through the configured native MCP endpoint. Use it for Assist/entity-control behavior where appropriate and keep OpenCode MCP for add-on/admin/dev workflows."
          : "Home Assistant's native llm platform may be internal-only or unavailable on this instance. Keep using OpenCode MCP as the working external agent surface.",
      },
      native_mcp: {
        upstream: nativeMcp.upstream || {
          llm_docs_pr: "home-assistant/developers.home-assistant#3236",
          keyed_endpoint_pr: "home-assistant/core#175570",
          endpoint_pattern: "/api/mcp/<API ID>",
          configured_endpoint: "/api/mcp",
          assist_api_id: "assist",
        },
        status: nativeConfiguredMcpAvailable
          ? "configured_api_available"
          : nativeLlmDetected
            ? "llm_detected_native_mcp_unavailable"
            : "not_available",
        recommended_mode: recommendedMode,
        configured_api_id: configuredApiId || null,
        configured_endpoint_mode: configuredEndpointMode,
        base_endpoint_status: nativeBaseMcpStatus,
        configured_endpoint_status: nativeConfiguredMcpStatus,
        assist_endpoint_status: nativeAssistMcpStatus,
        base_endpoint: nativeMcp.base || null,
        configured_endpoint: nativeConfiguredMcp,
        assist_endpoint: nativeMcp.assist || null,
        guidance: nativeConfiguredMcpAvailable
          ? "Prefer the configured Home Assistant native MCP API for curated native LLM tools. Prefer OpenCode MCP for configuration editing, validation, diagnostics, screenshots, updates, ESPHome, Zigbee, add-on development, and other admin/dev workflows."
          : "Native Home Assistant MCP is not available yet; use OpenCode MCP for all Home Assistant work and check again after upgrading Home Assistant.",
      },
      native_ai_components: {
        known_components_checked: KNOWN_NATIVE_AI_COMPONENTS,
        loaded: loadedNativeAiComponents,
        meaning: loadedNativeAiComponents.length > 0
          ? "This Home Assistant instance reports one or more native AI/conversation provider components as loaded."
          : "No known native AI/conversation provider components were found in the loaded component list.",
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
