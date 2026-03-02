# Home Assistant LSP Server

A Language Server Protocol (LSP) server for intelligent Home Assistant YAML configuration editing.

## Features

### Completions
- **Entity IDs**: Autocomplete from all entities in your Home Assistant instance
- **Services**: Autocomplete all available services with documentation
- **Areas & Devices**: Complete area_id and device_id values
- **Jinja2 Functions**: Complete Jinja2 template functions and entity references
- **Trigger Platforms**: Complete automation trigger platforms
- **Condition Types**: Complete condition types
- **YAML Keys**: Context-aware key completions for automations, triggers, actions

### Hover Information
- **Entity Details**: See current state, attributes, device class, and more
- **Service Documentation**: See service descriptions and available fields
- **Template Preview**: Live-render Jinja2 templates to see results

### Diagnostics
- **Unknown Entities**: Warning when referencing non-existent entity_id
- **Unknown Services**: Warning when calling non-existent service
- **Missing Includes**: Error when !include references missing file
- **YAML Syntax**: Basic YAML syntax validation

### Navigation
- **Go-to-Definition**: Jump to !include file references
- **Secret References**: Navigate to secrets.yaml from !secret tags

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    OpenCode Editor                   │
│                         │                            │
│                         │ LSP Protocol (stdio)       │
│                         ▼                            │
│  ┌───────────────────────────────────────────────┐  │
│  │            HA LSP Server (Node.js)            │  │
│  │                                               │  │
│  │  ┌─────────────┐  ┌─────────────────────────┐ │  │
│  │  │   YAML      │  │  Home Assistant Client  │ │  │
│  │  │  Analyzer   │  │                         │ │  │
│  │  │             │  │  - States Cache         │ │  │
│  │  │  - Context  │  │  - Services Cache       │ │  │
│  │  │  - Refs     │  │  - Areas Cache          │ │  │
│  │  │  - Includes │  │  - Devices Cache        │ │  │
│  │  └─────────────┘  └───────────┬─────────────┘ │  │
│  │                               │               │  │
│  └───────────────────────────────┼───────────────┘  │
│                                  │                   │
└──────────────────────────────────┼───────────────────┘
                                   │
                                   │ HTTP API
                                   ▼
                    ┌─────────────────────────────┐
                    │   Home Assistant Supervisor  │
                    │   http://supervisor/core/api │
                    └─────────────────────────────┘
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPERVISOR_TOKEN` | Yes* | Home Assistant Supervisor token. Auto-provided in app environment. |

*Without SUPERVISOR_TOKEN, the LSP runs in limited mode with only YAML syntax validation.

## API Endpoints Used

The LSP server uses these Home Assistant API endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/states` | GET | Fetch all entity states |
| `/api/services` | GET | Fetch available services |
| `/api/template` | POST | Render Jinja2 templates, get areas/devices |
| `/api/config` | GET | Get HA configuration |

## Caching Strategy

- **Cache TTL**: 60 seconds
- **Stale-while-revalidate**: Returns stale data on API errors
- **Warm on start**: Pre-fetches all data on initialization

## LSP Capabilities

```json
{
  "textDocumentSync": "Incremental",
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": [".", ":", " ", "\"", "'", "/"]
  },
  "hoverProvider": true,
  "definitionProvider": true,
  "diagnosticProvider": {
    "interFileDependencies": false,
    "workspaceDiagnostics": false
  }
}
```

## File Types

The LSP server handles:
- `*.yaml`
- `*.yml`

## Usage with OpenCode

Configure in `opencode.json`:

```json
{
  "lsp": {
    "yaml": {
      "command": ["node", "/opt/ha-lsp-server/server.js"],
      "filetypes": ["yaml", "yml"],
      "enabled": true
    }
  }
}
```

## Development

### Dependencies

```json
{
  "vscode-languageserver": "^9.0.1",
  "vscode-languageserver-textdocument": "^1.0.12",
  "yaml": "^2.4.5"
}
```

### Running Standalone

```bash
export SUPERVISOR_TOKEN="your-token"
node server.js
```

### Debug Logging

The server logs to stderr. To see logs:

```bash
node server.js 2>&1 | tee lsp.log
```

## Limitations

- Does not validate YAML against Home Assistant schemas (only syntax)
- Template preview requires SUPERVISOR_TOKEN
- Entity/service validation requires SUPERVISOR_TOKEN
- No support for multi-root workspaces

## License

MIT
