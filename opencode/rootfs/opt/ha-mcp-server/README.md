# Home Assistant MCP Server (Cutting Edge Edition v2.2)

A comprehensive Model Context Protocol (MCP) server implementing the latest MCP specification (2025-06-18) for deep integration between OpenCode and Home Assistant.

## Features Overview

| Category | Count | Description |
|----------|-------|-------------|
| **Tools** | 22 | Actions and queries with structured output |
| **Resources** | 9 + 4 templates | Browsable data exposed to the AI |
| **Prompts** | 6 | Pre-built guided workflows |
| **Intelligence** | Built-in | Anomaly detection, suggestions, semantic search |
| **Documentation** | Built-in | Live docs fetching, deprecation checks, syntax validation |

## Cutting-Edge MCP Features (v2.1)

This server implements the latest MCP specification features:

### 1. Structured Tool Output
All tools return both human-readable text AND structured JSON data:
```javascript
{
  content: [{ type: "text", text: "..." }],
  structuredContent: { /* typed JSON data */ }
}
```

### 2. Output Schemas
Tools define JSON Schema for their output, enabling:
- Response validation
- Type information for integrations
- Better IDE/tooling support

### 3. Tool Annotations
Safety and behavior hints for each tool:
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

### 4. Resource Links
Tools return links to related resources for follow-up:
```javascript
{
  content: [...],
  resourceLinks: [
    { uri: "ha://entity/light.living_room", name: "Living Room Light" }
  ]
}
```

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

## Version History

### v2.2.0 (Documentation Edition)
- Added documentation tools for keeping configurations current
- `get_integration_docs` - Fetch live documentation from Home Assistant website
- `get_breaking_changes` - Check for breaking changes affecting your HA version
- `check_config_syntax` - Validate YAML for deprecated patterns
- Built-in deprecation pattern database for common issues
- LLMs now guided to check docs before writing configuration

### v2.1.0 (Cutting Edge Edition)
- Implemented MCP spec 2025-06-18 features
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
