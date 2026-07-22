# Home Assistant MCP Server (Agent Capability Edition v2.8)

A comprehensive Model Context Protocol (MCP) server for deep integration between OpenCode and Home Assistant. It tracks current MCP server primitives and the latest published MCP specification (`2025-11-25`) while preserving compatibility with OpenCode's supported MCP client fields.

## Features Overview

| Category | Count | Description |
|----------|-------|-------------|
| **Tools** | 37 | Actions, queries, compact home context, config validation, HA-native LLM readiness, and admin workflows |
| **Resources** | 10 + 4 templates | Browsable data exposed to the AI |
| **Prompts** | 6 | Pre-built guided workflows |
| **Intelligence** | Built-in | Anomaly detection, suggestions, semantic search |
| **Documentation** | Built-in | Live docs fetching, deprecation checks, syntax validation |

## MCP Compatibility Features

This server keeps compatibility handling local to the add-on. It does not patch or upstream OpenCode's MCP client. Tool discovery and tool responses are filtered to the conservative fields OpenCode consumes today, while richer data is encoded as text JSON where useful.

### 1. Compatible Machine-Readable Output
Tools that benefit from structured data return JSON text with stable fields:
```javascript
{
  summary: "Returned 42 entities",
  data: [/* compact result data */],
  meta: {
    total: 42,
    returned: 42,
    truncated: false
  }
}
```

Newer MCP fields such as `structuredContent` and `resourceLinks` are intentionally kept out of tool responses until OpenCode consumes them reliably.

### 2. Strict Input Schemas
Tool input schemas use `additionalProperties: false` and bounded numeric arguments where practical so clients have clearer argument contracts.

### 3. Tool Annotations
Safety and behavior hints are maintained in the server definitions and reported through `get_agent_capabilities` compatibility metadata where relevant:
```javascript
{
  name: "call_service",
  annotations: {
    destructive: true,       // Modifies state
    idempotent: false,       // Not safe to retry
    requiresConfirmation: true  // Should prompt user
  }
}
```

| Annotation | Tools |
|------------|-------|
| `destructive` | `call_service`, `fire_event` |
| `readOnly` | All query tools |
| `idempotent` | All read-only tools |
| `requiresConfirmation` | `call_service` |

### 4. Bounded Large Outputs
Broad state listings, history, logbook, documentation, changelogs, CLI output, and ESPHome logs are capped and include truncation metadata. Re-run with narrower filters when `meta.truncated` is true.

### 5. Logging Capability
Server-side logging with configurable levels:
- `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`

### 6. Content Annotations
All content includes audience and priority hints:
```javascript
{
  type: "text",
  text: "...",
  annotations: {
    audience: ["user", "assistant"],
    priority: 0.9
  }
}
```

### 7. Human-Readable Titles
All tools, resources, and prompts include a `title` field for display.

## Tools

### State Management
| Tool | Title | Annotations |
|------|-------|-------------|
| `get_states` | Get Entity States | `readOnly`, `idempotent` |
| `search_entities` | Search Entities | `readOnly`, `idempotent` |
| `get_entity_details` | Get Entity Details | `readOnly`, `idempotent` |
| `get_home_context` | Get Home Context | `readOnly`, `idempotent` |

### Service Calls
| Tool | Title | Annotations |
|------|-------|-------------|
| `call_service` | Call Home Assistant Service | `destructive`, `requiresConfirmation` |
| `get_services` | List Available Services | `readOnly`, `idempotent` |

### History & Logging
| Tool | Title | Annotations |
|------|-------|-------------|
| `get_history` | Get Entity History | `readOnly`, `idempotent` |
| `get_logbook` | Get Activity Logbook | `readOnly`, `idempotent` |
| `get_error_log` | Get Error Log | `readOnly`, `idempotent` |

### Configuration
| Tool | Title | Annotations |
|------|-------|-------------|
| `get_config` | Get Home Assistant Configuration | `readOnly`, `idempotent` |
| `get_agent_capabilities` | Get Agent Capability Status | `readOnly`, `idempotent` |
| `get_ha_llm_development_guide` | Get HA Native LLM Development Guide | `readOnly`, `idempotent` |
| `get_areas` | List All Areas | `readOnly`, `idempotent` |
| `get_devices` | List Devices | `readOnly`, `idempotent` |
| `validate_config` | Validate Configuration | `readOnly`, `idempotent` |

### Events & Templates
| Tool | Title | Annotations |
|------|-------|-------------|
| `fire_event` | Fire Custom Event | `destructive` |
| `render_template` | Render Jinja2 Template | `readOnly`, `idempotent` |

### Calendars
| Tool | Title | Annotations |
|------|-------|-------------|
| `get_calendars` | List Calendars | `readOnly`, `idempotent` |
| `get_calendar_events` | Get Calendar Events | `readOnly`, `idempotent` |

### Intelligence
| Tool | Title | Annotations |
|------|-------|-------------|
| `detect_anomalies` | Detect Anomalies | `readOnly`, `idempotent` |
| `get_suggestions` | Get Automation Suggestions | `readOnly`, `idempotent` |
| `diagnose_entity` | Diagnose Entity | `readOnly`, `idempotent` |

### Documentation
| Tool | Title | Annotations |
|------|-------|-------------|
| `get_integration_docs` | Get Integration Documentation | `readOnly`, `idempotent` |
| `get_breaking_changes` | Get Breaking Changes | `readOnly`, `idempotent` |
| `check_config_syntax` | Check Configuration Syntax | `readOnly`, `idempotent` |

## Resources

### Static Resources
| URI | Title | Description |
|-----|-------|-------------|
| `ha://states/summary` | State Summary | Human-readable state overview |
| `ha://automations` | Automations List | All automations with status |
| `ha://scripts` | Scripts List | All available scripts |
| `ha://scenes` | Scenes List | All defined scenes |
| `ha://areas` | Areas List | All areas |
| `ha://config` | HA Configuration | Home Assistant config |
| `ha://agent/capabilities` | Agent Capabilities | OpenCode MCP capabilities and HA native LLM readiness |
| `ha://integrations` | Loaded Integrations | Component list |
| `ha://anomalies` | Detected Anomalies | Current issues |
| `ha://suggestions` | Automation Suggestions | Recommendations |

### Resource Templates
| URI Template | Title |
|--------------|-------|
| `ha://states/{domain}` | States by Domain |
| `ha://entity/{entity_id}` | Entity Details |
| `ha://area/{area_id}` | Area Details |
| `ha://history/{entity_id}` | Entity History |

## Prompts

| Prompt | Title | Description |
|--------|-------|-------------|
| `troubleshoot_entity` | Troubleshoot Entity | Guided diagnostics |
| `create_automation` | Create Automation | Step-by-step creation |
| `energy_audit` | Energy Audit | Usage analysis |
| `scene_builder` | Scene Builder | Scene creation |
| `security_review` | Security Review | Security audit |
| `morning_routine` | Morning Routine Designer | Routine automation |

## Enabling the MCP Server

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "homeassistant": {
      "type": "local",
      "command": ["node", "/opt/ha-mcp-server/index.js"],
      "enabled": true
    }
  }
}
```

Or use the CLI helper:
```bash
ha-mcp enable
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPERVISOR_TOKEN` | Auto-provided by Home Assistant app |
| `HA_NATIVE_MCP_API_ID` | Optional API ID for the native Home Assistant MCP proxy. Defaults to `assist`. Empty targets the configured `/api/mcp` endpoint. |
| `HA_NATIVE_MCP_ENDPOINT_MODE` | `auto` (default), `keyed`, or `configured`. `auto` prefers `/api/mcp/<API ID>` and falls back to `/api/mcp` when it answers 404 — which it always does before Home Assistant 2026.8. |
| `HA_NATIVE_MCP_SANITIZE_SCHEMAS` | Set to `0` to disable repair of Home Assistant tool schemas that strict MCP clients cannot compile (home-assistant/core#176762, fixed upstream in 2026.8). |
| `HA_NATIVE_MCP_BASE_URL` | Override the Supervisor Core API base URL. Defaults to `http://supervisor/core/api`. |
| `HA_NATIVE_MCP_TIMEOUT_MS` | Request timeout for the native MCP proxy. Defaults to `60000`. |

## Version History

### v2.8.0 (Agent Capability Edition)
- Added `get_agent_capabilities` read-only tool
- Added `ha://agent/capabilities` resource
- Reports OpenCode MCP capability counts and Home Assistant native `llm` / `/api/mcp/<API ID>` readiness
- Includes an optional stdio proxy for Home Assistant Core's native LLM MCP endpoint (`homeassistant_native` in OpenCode config, default API ID `assist`)
- Adds compact `get_home_context` and native `<integration>/llm.py` development guidance tools
- Documents the strategy for adopting HA-native LLM capabilities while preserving MCP workflows
- Targets the current MCP TypeScript SDK `1.29.x` line
- Adds server implementation description metadata
- Uses strict input schemas with `additionalProperties: false`, matching current MCP guidance
- Adds server-local compatibility metadata and compact `summary`/`data`/`meta` JSON text outputs for tools where structured parsing helps
- Caps large state, history, logbook, docs, changelog, CLI, and ESPHome log responses with truncation metadata

### v2.2.0 (Documentation Edition)
- Added documentation tools for keeping configurations current
- `get_integration_docs` - Fetch live documentation from Home Assistant website
- `get_breaking_changes` - Check for breaking changes affecting your HA version
- `check_config_syntax` - Validate YAML for deprecated patterns
- Built-in deprecation pattern database for common issues
- LLMs now guided to check docs before writing configuration

### v2.1.0 (Cutting Edge Edition)
- Added MCP 2025-06-18-era server metadata features while preserving OpenCode compatibility
- Added structured tool output with `outputSchema`
- Added tool annotations (`destructive`, `idempotent`, etc.)
- Added `title` fields to all tools, resources, prompts
- Added resource links in tool results
- Added logging capability
- Added content annotations (`audience`, `priority`)
- Updated SDK to ^1.25.0

### v2.0.0 (Enhanced Edition)
- Added MCP Resources (9 static + 4 templates)
- Added MCP Prompts (6 guided workflows)
- Added Intelligence Layer
- Added 9 new tools

### v1.0.0
- Initial release with 10 basic tools
