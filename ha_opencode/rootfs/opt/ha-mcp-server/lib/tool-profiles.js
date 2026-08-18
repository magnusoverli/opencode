/**
 * The Home Assistant MCP surface is useful, but its full schema is expensive
 * for local models. Profiles deliberately remove capabilities rather than
 * merely telling the model not to use them.
 */

const COMPACT_TOOL_NAMES = [
  "get_states",
  "search_entities",
  "get_entity_details",
  "get_home_context",
  "get_services",
  "get_history",
  "get_logbook",
  "get_config",
  "get_agent_capabilities",
  "get_areas",
  "get_devices",
  "get_error_log",
  "get_supervisor_health",
  "get_supervisor_resolution",
  "get_backup_posture",
  "get_support_logs",
  "get_store_audit",
  "get_supervisor_metrics",
  "render_template",
  "get_calendars",
  "get_calendar_events",
  "detect_anomalies",
  "get_suggestions",
  "diagnose_entity",
];

const CONFIGURATION_TOOL_NAMES = [
  ...COMPACT_TOOL_NAMES,
  "get_ha_llm_development_guide",
  "get_integration_docs",
  "get_breaking_changes",
  "check_config_syntax",
  "validate_config",
  "write_config_safe",
  "esphome_list_devices",
  "esphome_config_read",
  "esphome_config_validate",
  "esphome_config_update",
  "esphome_config_create",
  "esphome_boards",
  "esphome_device_metadata",
  "esphome_yaml_search",
  "esphome_file",
  "remember_decision",
  "recall_decisions",
  "supersede_decision",
];

export const TOOL_PROFILES = Object.freeze({
  compact: Object.freeze({
    name: "compact",
    title: "Compact diagnostics",
    description: "Read-only state, history, diagnostics, and focused home context.",
    toolNames: new Set(COMPACT_TOOL_NAMES),
  }),
  configuration: Object.freeze({
    name: "configuration",
    title: "Configuration",
    description: "Compact diagnostics plus documentation, validation, safe configuration writes, and decision notes.",
    toolNames: new Set(CONFIGURATION_TOOL_NAMES),
  }),
  full: Object.freeze({
    name: "full",
    title: "Full",
    description: "Every Home Assistant MCP capability, including control, administration, updates, firmware, and visual verification.",
    toolNames: null,
  }),
});

export const TOOL_PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

export function normalizeToolProfile(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TOOL_PROFILES[normalized] ? normalized : "full";
}

export function getToolProfile(value) {
  return TOOL_PROFILES[normalizeToolProfile(value)];
}

export function filterToolsForProfile(tools, profile) {
  const selected = getToolProfile(profile);
  if (!selected.toolNames) return [...tools];
  return tools.filter((tool) => selected.toolNames.has(tool.name));
}

export function isToolAllowedInProfile(name, profile) {
  const selected = getToolProfile(profile);
  return !selected.toolNames || selected.toolNames.has(name);
}

export function profileDisabledToolMessage(name, profile) {
  const selected = getToolProfile(profile);
  return (
    `The '${name}' tool is unavailable in the ${selected.name} MCP tool profile. ` +
    `Select the full profile in the OpenCode add-on Configuration tab to use it.`
  );
}
