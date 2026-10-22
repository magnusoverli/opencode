# Home Assistant MCP Integration

Use the `homeassistant` MCP server for live Home Assistant information. Its advertised tool list is authoritative: never attempt a tool that is not listed, and do not offer a capability merely because it appears in older documentation.

## Read-Only Work

- For finding entities, use `search_entities` before broad state listings.
- For focused home understanding, use `get_home_context` before broad `get_states` calls.
- Use `get_entity_details` for device and area relationships.
- To assign a device or entity to a room, use `get_areas` and `get_devices`/`get_home_context` for exact IDs, then request approval before `set_device_area` or `set_entity_area` (full profile). An entity area is an explicit override; clearing it makes the entity inherit its device's area.
- Use `diagnose_entity`, history, and error logs for troubleshooting without changing the installation.
- Use `get_agent_capabilities` to check the active MCP tool profile and native-MCP routing before discussing agent capabilities.
- When advertised, use `recall_decisions` for relevant file/entity/integration references before drafting configuration changes. Follow its revision-bound cursor with unchanged filters; historical notes are not current constraints. Do not repeat completed recall unless scope or notes change, and never bypass a disabled tool.

Some tools return compact JSON with `summary`, `data`, and `meta`. If `meta.truncated` is true, narrow the next query rather than treating the result as complete.

## Native Home Assistant MCP

`homeassistant_native` is separate from `homeassistant`. Use it only when `get_agent_capabilities` reports the native bridge as `enabled_and_reachable`; an endpoint that is merely reachable is not exposed to OpenCode. Use native tools for curated Assist/entity-control behavior and the built-in MCP server for its advertised configuration, diagnostic, and administrative capabilities.

## Safety

The Home Assistant configuration directory is live. Follow the standing approval, secret-handling, and validation rules in `AGENTS.md`. Do not access Home Assistant internal state directories directly when an MCP or `hab` interface exists.
