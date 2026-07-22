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
  "Work around the Home Assistant <= 2026.7 limitations that stop an external MCP client from using native LLM tools: no keyed /api/mcp/<API ID> endpoint, and tool schemas that strict clients cannot compile.",
];

const ROADMAP_NEXT = [
  "Validate the native MCP bridge against Home Assistant 2026.8, the first release that carries the llm integration, the domain tool platforms, and the keyed /api/mcp/<API ID> endpoints.",
  "Prefer native Home Assistant LLM tools for core Assist/entity control once 2026.8 is released and reachable from the add-on.",
  "Position OpenCode as a premium consumer of HA-native LLM capabilities for users testing agent-focused Home Assistant features.",
  "Keep MCP tools for OpenCode-specific, add-on, admin, development, validation, and safety workflows that Home Assistant Core does not intend to expose through Assist.",
  "Confirm whether Supervisor-proxied add-on requests count as admin, which decides whether keyed API IDs other than 'assist' are reachable at all.",
];

// Home Assistant releases that expose the native LLM platform to external MCP
// clients. Everything below this is missing the keyed endpoints
// (home-assistant/core#175570) and the tool-schema fix
// (home-assistant/core#176814).
const MIN_VERSION_NATIVE_LLM_PLATFORM = "2026.8.0";

// Integrations that register a conversation agent.
const KNOWN_CONVERSATION_COMPONENTS = [
  "anthropic",
  "cloud",
  "google_generative_ai_conversation",
  "litellm",
  "llama_cpp",
  "ollama",
  "open_router",
  "openai_conversation",
  "ovhcloud_ai_endpoints",
  "wyoming",
];

// Integrations that provide an AI task entity.
const KNOWN_AI_TASK_COMPONENTS = [
  "anthropic",
  "cloud",
  "google_generative_ai_conversation",
  "ollama",
  "open_router",
  "openai_conversation",
];

const KNOWN_NATIVE_AI_COMPONENTS = [
  ...new Set([...KNOWN_CONVERSATION_COMPONENTS, ...KNOWN_AI_TASK_COMPONENTS]),
].sort();

/**
 * Compare a reported Home Assistant version against a `YYYY.M.P` baseline.
 *
 * Home Assistant versions carry suffixes such as `2026.8.0b3` or
 * `2026.8.0.dev0`; the numeric prefix is what matters here. A pre-release of
 * the target version counts as meeting it, because the platform work is
 * present in the betas. Returns null when the version cannot be parsed, so
 * callers can stay silent rather than guess.
 */
export function meetsHaVersion(version, minimum) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? "").trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
  };

  const current = parse(version);
  const target = parse(minimum);
  if (!current || !target) return null;

  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== target[index]) return current[index] > target[index];
  }
  return true;
}

/**
 * Upstream defects that change what the bridge can do on this Home Assistant.
 *
 * Reported so an agent reading `get_agent_capabilities` can tell a known
 * upstream limitation apart from a broken local configuration.
 */
function buildNativeMcpKnownIssues(version) {
  const meets = meetsHaVersion(version, MIN_VERSION_NATIVE_LLM_PLATFORM);
  if (meets === null || meets === true) return [];

  return [
    {
      id: "keyed_endpoints_unavailable",
      upstream: "home-assistant/core#175570",
      fixed_in: MIN_VERSION_NATIVE_LLM_PLATFORM,
      impact: `Home Assistant ${version} does not serve /api/mcp/<API ID>; only the configured /api/mcp endpoint exists.`,
      mitigation: "The bridge detects the 404 and falls back to /api/mcp automatically. A 404 on the keyed endpoint here is expected, not a misconfiguration.",
    },
    {
      id: "tool_schema_anyof_empty",
      upstream: "home-assistant/core#176762 (fixed by #176814)",
      fixed_in: MIN_VERSION_NATIVE_LLM_PLATFORM,
      impact: "Tool schemas built from validators such as cv.string serialize to an empty anyOf member. Strict MCP clients cannot compile them, send __unparsedToolInput instead, and Home Assistant rejects the call with \"extra keys not allowed\". GetLiveContext is affected.",
      mitigation: "The bridge repairs affected tool schemas in tools/list responses. Set HA_NATIVE_MCP_SANITIZE_SCHEMAS=0 to see the raw upstream schemas.",
    },
    {
      id: "streamable_endpoint_crash_risk",
      upstream: "home-assistant/core#176734",
      fixed_in: null,
      impact: "A malformed or empty POST to /api/mcp has been reported to crash Home Assistant Core.",
      mitigation: "The bridge validates every message as JSON-RPC 2.0 before forwarding it, so a malformed client message is rejected locally.",
    },
  ];
}

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
  const loadedConversationComponents = KNOWN_CONVERSATION_COMPONENTS.filter((component) => components.includes(component));
  const loadedAiTaskComponents = KNOWN_AI_TASK_COMPONENTS.filter((component) => components.includes(component));
  const recommendedMode = nativeConfiguredMcpAvailable
    ? "hybrid_native_llm_api_plus_opencode_mcp"
    : "opencode_mcp_only";
  const haVersion = haConfig.version || "unknown";
  const knownIssues = buildNativeMcpKnownIssues(haVersion);
  const meetsPlatformVersion = meetsHaVersion(haVersion, MIN_VERSION_NATIVE_LLM_PLATFORM);

  return {
    surface: {
      name: "OpenCode Home Assistant MCP",
      role: "Primary external agent surface for this add-on",
      compatibility: "Additive to Home Assistant's native LLM platform; does not replace Assist.",
    },
    home_assistant: {
      version: haVersion,
      native_llm_platform: {
        minimum_version: MIN_VERSION_NATIVE_LLM_PLATFORM,
        version_supported: meetsPlatformVersion,
        meaning: meetsPlatformVersion === null
          ? "The Home Assistant version could not be parsed, so native LLM platform support is unknown."
          : meetsPlatformVersion
            ? "This Home Assistant is new enough to carry the llm integration, the per-domain LLM tool platforms, and the keyed /api/mcp/<API ID> endpoints."
            : `The native LLM platform (llm integration, per-domain tool platforms, keyed /api/mcp/<API ID> endpoints) first ships in Home Assistant ${MIN_VERSION_NATIVE_LLM_PLATFORM}. This instance runs ${haVersion}.`,
      },
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
        known_issues: knownIssues,
        guidance: nativeConfiguredMcpAvailable
          ? "Prefer the configured Home Assistant native MCP API for curated native LLM tools. Prefer OpenCode MCP for configuration editing, validation, diagnostics, screenshots, updates, ESPHome, Zigbee, add-on development, and other admin/dev workflows."
          : "Native Home Assistant MCP is not available yet; use OpenCode MCP for all Home Assistant work and check again after upgrading Home Assistant.",
      },
      native_ai_components: {
        known_components_checked: KNOWN_NATIVE_AI_COMPONENTS,
        loaded: loadedNativeAiComponents,
        conversation_agents: loadedConversationComponents,
        ai_task_providers: loadedAiTaskComponents,
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
