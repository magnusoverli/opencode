# Home Assistant MCP Integration

Use the `homeassistant` MCP server for live Home Assistant information. Its advertised tool list is authoritative: never attempt a tool that is not listed, and do not offer a capability merely because it appears in older documentation.

## Read-Only Work

- For finding entities, use `search_entities` before broad state listings.
- For focused home understanding, use `get_home_context` before broad `get_states` calls.
- Use `get_entity_details` for device and area relationships.
- Use `diagnose_entity`, history, and error logs for troubleshooting without changing the installation.
- Use `get_agent_capabilities` to check the active MCP tool profile and native-MCP routing before discussing agent capabilities.

Some tools return compact JSON with `summary`, `data`, and `meta`. If `meta.truncated` is true, narrow the next query rather than treating the result as complete.

## Native Home Assistant MCP

`homeassistant_native` is separate from `homeassistant`. Use it only when `get_agent_capabilities` reports the native bridge as `enabled_and_reachable`; an endpoint that is merely reachable is not exposed to OpenCode. Use native tools for curated Assist/entity-control behavior and the built-in MCP server for its advertised configuration, diagnostic, and administrative capabilities.

## Safety

The Home Assistant configuration directory is live. Follow the standing approval, secret-handling, and validation rules in `AGENTS.md`. Do not access Home Assistant internal state directories directly when an MCP or `hab` interface exists.
