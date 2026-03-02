# OpenCode

OpenCode is an AI-powered coding agent that helps you edit and manage your Home Assistant configuration directly from your browser.

## Features

- **AI-Powered Editing**: Use natural language to modify your Home Assistant configuration
- **Modern Terminal**: Beautiful web-based terminal with 10 theme options
- **Log Access**: View Home Assistant Core, Supervisor, and host logs
- **Ingress Support**: Access directly from the Home Assistant sidebar
- **Provider Agnostic**: Works with Anthropic, OpenAI, Google, and 70+ other AI providers
- **MCP Integration**: Deep Home Assistant integration with Tools, Resources, Prompts, and Intelligence
- **LSP Integration**: Intelligent YAML editing with entity autocomplete, hover info, and diagnostics

## Configuration

Configure the app from the **Configuration** tab in the app page.

### Feature Options

| Option | Default | Description |
|--------|---------|-------------|
| **Enable MCP Home Assistant Integration** | `true` | Enable the Model Context Protocol (MCP) server for deep Home Assistant integration. Includes 32 tools, 13 resources, 6 guided prompts, and an intelligence layer for anomaly detection, config validation, and automation suggestions. |
| **Enable LSP Home Assistant Integration** | `true` | Enable the Language Server Protocol (LSP) server for intelligent YAML editing. Provides entity/service autocomplete, hover documentation, diagnostics for unknown entities, and go-to-definition for !include tags. |

### Terminal Appearance

| Option | Default | Description |
|--------|---------|-------------|
| **Terminal Theme** | `breeze` | Color scheme for the terminal. Options: `breeze`, `catppuccin_mocha`, `catppuccin_latte`, `dracula`, `nord`, `tokyo_night`, `one_dark`, `solarized_dark`, `solarized_light`, `gruvbox_dark` |
| **Font Size** | `14` | Terminal font size in pixels (10-24) |
| **Cursor Style** | `block` | Cursor appearance: `block`, `underline`, or `bar` |
| **Blinking Cursor** | `false` | Whether the cursor should blink |

### Advanced Options

| Option | Default | Description |
|--------|---------|-------------|
| **CPU Mode** | `auto` | Controls which OpenCode binary is used. `auto` detects your CPU capabilities automatically (recommended). `baseline` forces the baseline binary for older CPUs without AVX2 support. `regular` forces the standard binary. |
| **Environment Variables** | `[]` | Define custom environment variables that are available to OpenCode and the terminal shell. Each entry has a `name` and `value`. Useful for provider credentials or configuration that must be set as environment variables (e.g. `AZURE_RESOURCE_NAME`, `OPENAI_API_KEY`). Changes take effect after restarting the add-on. Critical system variables (`HOME`, `PATH`, `SUPERVISOR_TOKEN`, etc.) cannot be overridden. |
| **Custom OpenCode Configuration (JSON)** | `""` | Paste a JSON object to customize OpenCode's own configuration (providers, keybindings, etc.). This is merged with the add-on's built-in config. Leave empty for defaults. See [OpenCode config docs](https://opencode.ai/docs/config) for the full schema. |

#### Environment Variables Example

To set environment variables for an Azure OpenAI provider, add entries in the Configuration tab:

| Name | Value |
|------|-------|
| `AZURE_RESOURCE_NAME` | `my-azure-resource` |
| `AZURE_API_KEY` | `sk-...` |

After saving and restarting the add-on, these variables will be available in the terminal and to OpenCode. You can then use `/connect` inside OpenCode to configure your provider.

> **Note:** Environment variable values are stored on disk inside the container and are excluded from Home Assistant backups. However, they are visible in the add-on's Configuration tab. Treat them with the same care as any stored credential.

### Theme Previews

- **Breeze** - KDE Konsole default, clean and professional
- **Catppuccin Mocha** - Soothing pastel dark theme
- **Catppuccin Latte** - Light pastel theme for bright environments
- **Dracula** - Popular dark theme with vibrant colors
- **Nord** - Arctic, bluish color palette
- **Tokyo Night** - Dark theme inspired by Tokyo city lights
- **One Dark** - Atom editor's iconic dark theme
- **Solarized Dark** - Precision colors for dark backgrounds
- **Solarized Light** - Precision colors for light backgrounds
- **Gruvbox Dark** - Retro groove color scheme

## Getting Started

### 1. Open the App

Click on **OpenCode** in the Home Assistant sidebar to open the terminal.

### 2. Configure Your AI Provider

OpenCode needs an AI provider to function. Run the following command inside OpenCode:

```
opencode
```

Then use the `/connect` command to add your AI provider:

```
/connect
```

Follow the prompts to authenticate with your preferred provider:
- **Anthropic** (Claude) - Recommended
- **OpenAI** (GPT-4)
- **Google** (Gemini)
- **OpenCode Zen** - Curated models optimized for coding
- And many more...

### 3. Start Coding!

Once connected, you can ask OpenCode to help with your Home Assistant configuration:

```
Help me create an automation that turns on the lights when motion is detected
```

```
Review my configuration.yaml for any issues
```

```
Add a template sensor for my energy usage
```

## Helper Commands

The app includes helper commands:

| Command | Description |
|---------|-------------|
| `ha-logs core` | View Home Assistant Core logs |
| `ha-logs error` | View Home Assistant error log |
| `ha-logs supervisor` | View Supervisor logs |
| `ha-logs host` | View host system logs |
| `ha-logs core 200` | View last 200 lines of Core logs |
| `ha-mcp enable` | Enable Home Assistant MCP integration |
| `ha-mcp disable` | Disable Home Assistant MCP integration |
| `ha-mcp status` | Check MCP integration status |
| `ha-mcp test` | Test MCP server connection |

## Home Assistant MCP Integration

The app includes an enhanced MCP (Model Context Protocol) server that provides deep integration between OpenCode and Home Assistant. This is a comprehensive implementation featuring **Tools**, **Resources**, **Prompts**, and an **Intelligence Layer**.

### MCP Capabilities Overview

| Capability | Count | Description |
|------------|-------|-------------|
| **Tools** | 32 | Actions, queries, config validation, and device management |
| **Resources** | 9 + 4 templates | Browsable data exposed to the AI |
| **Prompts** | 6 | Pre-built guided workflows for common tasks |
| **Intelligence** | Built-in | Anomaly detection, suggestions, semantic search |

### Enabling MCP Integration

**Option 1: Via Configuration (Recommended)**

1. Go to the app **Configuration** tab
2. Enable **"Enable MCP Home Assistant Integration"**
3. Save and restart the app

**Option 2: Via Command Line**

Run the following command in the terminal:

```bash
ha-mcp enable
```

Then restart OpenCode (exit and run `opencode` again).

---

## MCP Tools (32 Available)

### State Management

| Tool | Description |
|------|-------------|
| `get_states` | Get entity states (all, by domain, or specific). Supports semantic summaries. |
| `search_entities` | Semantic search - find entities by natural language ("bedroom lights", "motion sensors") |
| `get_entity_details` | Deep dive into an entity including device/area relationships |

### Service Calls

| Tool | Description |
|------|-------------|
| `call_service` | Call any HA service (turn on lights, run scripts, set temperatures, etc.) |
| `get_services` | List available services, optionally by domain |

### History & Logging

| Tool | Description |
|------|-------------|
| `get_history` | Get historical state data for trend analysis and debugging |
| `get_logbook` | Get activity timeline showing what happened |
| `get_error_log` | Retrieve Home Assistant error log |

### Configuration & Validation

| Tool | Description |
|------|-------------|
| `get_config` | Get HA configuration (location, units, version, components) |
| `get_areas` | List all defined areas with IDs and names |
| `get_devices` | List devices, optionally filtered by area |
| `validate_config` | Validate configuration files before restarting |
| `write_config_safe` | **Safe config writer** — writes YAML with automatic validation, backup/restore, template checking, and deprecation scanning. See [Safe Config Writing](#safe-config-writing) below. |
| `check_config_syntax` | Analyze YAML for deprecated syntax patterns and suggest modern alternatives |

### Events & Templates

| Tool | Description |
|------|-------------|
| `fire_event` | Fire custom events to trigger automations |
| `render_template` | Render Jinja2 templates using HA's template engine |

### Calendars

| Tool | Description |
|------|-------------|
| `get_calendars` | List all calendar entities |
| `get_calendar_events` | Get events from a calendar within a time range |

### Intelligence Tools

| Tool | Description |
|------|-------------|
| `detect_anomalies` | Scan for issues: low batteries, unusual readings, open doors, etc. |
| `get_suggestions` | Get automation and optimization suggestions based on your setup |
| `diagnose_entity` | Run diagnostics on a problematic entity |

### Documentation & Breaking Changes

| Tool | Description |
|------|-------------|
| `get_integration_docs` | Fetch live documentation for any HA integration directly from home-assistant.io |
| `get_breaking_changes` | Check for breaking changes that may affect your configuration after an update |

### Update Management

| Tool | Description |
|------|-------------|
| `get_available_updates` | Check for available updates across Core, OS, Supervisor, and all apps |
| `get_addon_changelog` | View an app's changelog before updating |
| `update_component` | Start an update for Core, OS, Supervisor, or an app |
| `get_update_progress` | Monitor an in-progress update by job ID |
| `get_running_jobs` | List all active Supervisor jobs |

### ESPHome Integration

| Tool | Description |
|------|-------------|
| `esphome_list_devices` | List all ESPHome devices with their status |
| `esphome_compile` | Compile an ESPHome device configuration |
| `esphome_upload` | Upload compiled firmware to an ESPHome device |

### Firmware Updates

| Tool | Description |
|------|-------------|
| `watch_firmware_update` | Monitor or start firmware updates (ESPHome, WLED, Zigbee) with real-time progress |

---

## MCP Resources

Resources provide browsable context that the AI can access proactively:

### Static Resources

| URI | Description |
|-----|-------------|
| `ha://states/summary` | Human-readable summary of all entity states (Markdown) |
| `ha://automations` | All automations with current state and last triggered time |
| `ha://scripts` | All available scripts |
| `ha://scenes` | All defined scenes |
| `ha://areas` | All areas with entity information |
| `ha://config` | Home Assistant configuration details |
| `ha://integrations` | List of loaded integrations/components |
| `ha://anomalies` | Currently detected anomalies and issues |
| `ha://suggestions` | Current automation/optimization suggestions |

### Resource Templates

| URI Template | Description |
|--------------|-------------|
| `ha://states/{domain}` | States for a specific domain (e.g., `ha://states/light`) |
| `ha://entity/{entity_id}` | Detailed info for a specific entity |
| `ha://area/{area_id}` | All entities and devices in an area |
| `ha://history/{entity_id}` | 24-hour history for an entity |

---

## MCP Prompts (Guided Workflows)

Prompts are pre-built workflows that guide the AI through complex tasks:

### Available Prompts

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `troubleshoot_entity` | `entity_id`, `problem_description` | Guided troubleshooting - analyzes state, history, relationships, and logs |
| `create_automation` | `goal` | Step-by-step automation creation with entity discovery |
| `energy_audit` | (none) | Comprehensive energy usage analysis and optimization suggestions |
| `scene_builder` | `area`, `mood` | Interactive scene creation assistant |
| `security_review` | (none) | Security setup audit - locks, sensors, cameras, alarm systems |
| `morning_routine` | `wake_time` | Design a morning routine automation |

### Using Prompts

Simply ask OpenCode to use a prompt:

```
Help me troubleshoot my kitchen motion sensor - it's not detecting motion
```

```
Create an automation to turn off all lights at midnight
```

```
Do an energy audit of my home
```

```
Build a movie night scene for the living room
```

---

## Intelligence Layer

The MCP server includes built-in intelligence for smarter assistance:

### Anomaly Detection

Automatically detects and flags:
- **Low battery devices** (< 20%)
- **Unusual temperature readings** (outside normal ranges)
- **Humidity anomalies** (< 10% or > 95%)
- **Doors/windows open too long** (> 4 hours)
- **Lights on during daytime** (10 AM - 4 PM)
- **Unavailable/unknown entities**

### Semantic Search

Find entities using natural language:
- "bedroom lights"
- "temperature sensors"
- "front door"
- "motion detectors in the garage"

### Entity Relationships

Understands connections between:
- Entities and their parent devices
- Devices and their areas
- Related entities (same device or area)

### Automation Suggestions

Analyzes your setup and suggests:
- **Motion-activated lighting** based on motion sensors and lights in the same area
- **Security alerts** for doors/windows left open
- **Climate optimization** using thermostats and temperature sensors
- **Energy monitoring** alerts for power consumption

---

## Safe Config Writing

The `write_config_safe` MCP tool provides a complete validation pipeline when writing Home Assistant YAML configuration files. Instead of blind file writes, every change goes through multiple safety checks with automatic rollback on failure.

### Validation Pipeline

When you (or the AI agent) write configuration through `write_config_safe`, the following steps happen automatically:

1. **Path security** — Resolves the target path and blocks writes outside the config directory (no traversal attacks, no writes to `.storage/`, `deps/`, `tts/`, etc.)
2. **Deprecation scan** — Checks the YAML content against known deprecation patterns sourced from:
   - A bundled pattern library (20+ patterns covering entity namespaces, MQTT changes, YAML config removal, etc.)
   - Remote pattern updates fetched from GitHub (cached for 1 hour)
   - Your instance's live **Repairs** issues (via the HA WebSocket API)
   - The public **HA Alerts** feed (integration-level advisories with version ranges)
3. **Structural validation** — Verifies that automations have `trigger` + `action`, scripts have `sequence`, template sensors have `state`, and other structural requirements are met
4. **Jinja2 template validation** — Extracts all `{{ }}` and `{% %}` blocks and validates them against HA's template rendering engine. Templates containing runtime-only variables (`trigger.*`, `this.*`, `context.*`, etc.) are skipped since they can't be validated outside their execution context
5. **File write with backup** — Creates a timestamped `.bak` copy of the existing file before writing the new content
6. **HA Core config check** — Calls Home Assistant's configuration validation API to catch errors that static analysis can't
7. **Auto-restore on failure** — If the config check fails, the backup is automatically restored and the error is reported

### Dry Run Mode

Pass `dry_run: true` to run the full validation pipeline without actually writing the file. This is useful for checking whether proposed changes would pass validation before committing to them.

```
Check if this automation YAML is valid without saving it
```

### What Gets Reported

The tool returns a structured result with:

- **`success`** — Whether the write (or dry run) passed all checks
- **`deprecations`** — Any deprecated patterns found, with descriptions and suggested replacements
- **`structuralIssues`** — Missing required keys or structural problems
- **`templateErrors`** — Jinja2 template syntax or rendering errors
- **`configCheckResult`** — Output from HA Core's config validation
- **`backupPath`** — Path to the backup file (if a write occurred)

---

## Example Usage

### Basic Queries

```
What's the state of all lights?
```

```
Show me all temperature sensors
```

```
Find motion detectors in the house
```

### Device Control

```
Turn on the living room lights
```

```
Set the thermostat to 72 degrees
```

```
Run the goodnight script
```

### Analysis & Diagnostics

```
Are there any anomalies in my home?
```

```
What automations do you suggest for my setup?
```

```
Diagnose why the garage door sensor isn't working
```

### History & Debugging

```
Show me the temperature history for the last 24 hours
```

```
What happened in the logbook today?
```

```
Check the error log for issues
```

### Guided Workflows

```
Help me create an automation that turns on lights when I get home
```

```
Do an energy audit and suggest ways to save power
```

```
Review my security setup
```

```
Design a morning routine for 7 AM
```

---

---

## LSP Integration (Intelligent YAML Editing)

The app includes a Language Server Protocol (LSP) server that provides intelligent editing features for Home Assistant YAML configuration files. This is **enabled by default** because it only reads data and doesn't modify anything.

### What is LSP?

LSP (Language Server Protocol) is a standard that enables smart editor features like:
- Autocomplete suggestions
- Hover documentation
- Go-to-definition
- Error diagnostics

The OpenCode LSP server connects to your Home Assistant instance and provides context-aware assistance while you edit YAML files.

### LSP Features

#### Entity ID Autocomplete

When typing `entity_id:`, you get suggestions from all entities in your Home Assistant:

```yaml
automation:
  - trigger:
      - platform: state
        entity_id: # <-- Type here and get all your entities!
```

The autocomplete shows:
- Entity ID (e.g., `light.living_room`)
- Friendly name (e.g., "Living Room Light")
- Current state (e.g., "on")
- Device class if available

#### Service Autocomplete

When typing `service:` or `action:`, you get all available services:

```yaml
action:
  - service: # <-- Type here to see all services!
    target:
      entity_id: light.living_room
```

Service completions include:
- Full service name (e.g., `light.turn_on`)
- Description
- Available fields/parameters

#### Area & Device Completion

Complete area and device IDs:

```yaml
action:
  - service: light.turn_on
    target:
      area_id: # <-- Suggests all your areas
```

#### Jinja2 Template Completion

Inside `{{ }}` templates, get function completions:

```yaml
sensor:
  - platform: template
    sensors:
      living_room_temp:
        value_template: "{{ states('sensor.temperature') }}"
        #                   ^ Autocomplete Jinja functions and entities
```

Available completions:
- `states('entity_id')` - Get entity state
- `is_state('entity_id', 'state')` - Check state
- `state_attr('entity_id', 'attr')` - Get attribute
- `now()`, `today_at()`, `as_timestamp()` - Time functions
- `area_entities('area')`, `device_entities('device')` - Relationship functions

#### Hover Information

Hover over entity IDs to see detailed information:

```yaml
entity_id: sensor.living_room_temperature
#          ^ Hover here to see:
#            - Friendly name: "Living Room Temperature"
#            - State: "21.5"
#            - Unit: "°C"
#            - All attributes
```

Hover over Jinja2 templates to see the **live rendered result**:

```yaml
value_template: "{{ states('sensor.temperature') | float }}"
#               ^ Hover to see: "21.5"
```

#### Diagnostics (Warnings & Errors)

The LSP shows warnings for potential issues:

**Unknown Entity Warning:**
```yaml
entity_id: sensor.does_not_exist
#          ~~~~~~~~~~~~~~~~~~~~~~
#          ⚠ Unknown entity: sensor.does_not_exist
```

**Unknown Service Warning:**
```yaml
service: light.invalid_service
#        ~~~~~~~~~~~~~~~~~~~~~
#        ⚠ Unknown service: light.invalid_service
```

**Missing Include Error:**
```yaml
automation: !include missing_file.yaml
#                    ~~~~~~~~~~~~~~~~~
#                    ❌ Include file not found: missing_file.yaml
```

**Deprecation Warning:**
```yaml
automation:
  - trigger:
      - platform: state
        entity_id: binary_sensor.front_door
    action:
      - service: notify.mobile_app
        #~~~~~~~~
        # ⚠ Deprecated: "service" is deprecated, use "action" instead (since 2024.x)
```

Deprecation patterns are loaded from a bundled pattern library and refreshed from GitHub in the background. Warnings appear as yellow squigglies in the editor as you type.

#### Go-to-Definition

Click on `!include` references to jump to the included file:

```yaml
automation: !include automations.yaml
#                    ~~~~~~~~~~~~~~~~
#                    Ctrl+Click to open automations.yaml
```

Also works with `!secret`:
```yaml
api_key: !secret api_key
#               ~~~~~~~~
#               Ctrl+Click to open secrets.yaml
```

### Trigger & Condition Completion

When editing automations, get completions for:

**Trigger Platforms:**
```yaml
trigger:
  - platform: # state, numeric_state, time, sun, zone, mqtt, webhook...
```

**Condition Types:**
```yaml
condition:
  - condition: # state, numeric_state, time, sun, zone, template, and, or, not...
```

**Action Keys:**
```yaml
action:
  - service:     # Service to call
    target:      # Target entities/areas/devices
    data:        # Service parameters
  - delay:       # Delay before next action
  - wait_template: # Wait for condition
  - choose:      # Conditional branching
  - repeat:      # Repeat actions
```

### Configuration

LSP is enabled by default. To disable it:

1. Go to the app **Configuration** tab
2. Set **"Enable LSP Home Assistant Integration"** to `false`
3. Restart the app

### Technical Notes

- The LSP server caches entity/service data for 60 seconds for performance
- Cache is automatically refreshed when stale
- Works even without Home Assistant connection (limited features)
- YAML syntax validation is always available

---

## Working Directory

OpenCode starts in the `/homeassistant` directory, which is your Home Assistant configuration folder. This includes:

- `configuration.yaml`
- `automations.yaml`
- `scripts.yaml`
- `scenes.yaml`
- Custom components in `custom_components/`
- And all other configuration files

## Customizing AI Instructions (AGENTS.md)

The app creates an `AGENTS.md` file in your Home Assistant config directory (`/homeassistant/AGENTS.md`) on first install. This file contains instructions that guide how OpenCode behaves when working with your Home Assistant setup.

### Default Instructions Include:

- **User consent rules** - The AI won't make changes without your explicit approval
- **Home Assistant knowledge** - File structure, YAML syntax, automation patterns
- **Safety guidelines** - Protection for secrets, backup reminders, validation checks
- **MCP awareness** - How to use MCP tools when available

### Customizing the Instructions

You can edit `AGENTS.md` to add your own rules or context:

1. Open **File Editor** (or VS Code Server app)
2. Navigate to `/config/AGENTS.md`
3. Add your customizations

**Example additions:**

```markdown
## My Home Setup

- I use Zigbee2MQTT for all Zigbee devices
- My house has 3 floors: basement, main, upstairs
- Prefer MQTT automations over native HA automations
- Always use packages for new configuration

## Coding Preferences

- Use descriptive entity_id names with room prefix
- Add comments explaining automation logic
- Prefer template sensors over Node-RED
```

### Resetting to Default

If you want to restore the default `AGENTS.md`:

1. Delete or rename the existing file
2. Restart the app
3. A fresh default will be created

## Tips

### Validating Configuration

After making changes, you can ask OpenCode to validate your configuration:

```
Check if my configuration is valid
```

With MCP enabled, OpenCode calls the validation API directly and reports any errors.

For a more thorough check, ask OpenCode to use the safe config writer which runs the full validation pipeline (deprecation scan, structural checks, template validation, and HA Core config check):

```
Write this automation to automations.yaml using safe config writing
```

```
Dry-run validate my configuration.yaml without saving
```

See [Safe Config Writing](#safe-config-writing) for full details on the validation pipeline.

### Viewing Logs

If something isn't working, check the logs:

```
Show me the recent error logs
```

Or use the helper command:

```bash
ha-logs error
```

### Git Integration

OpenCode works well with git. If you version control your configuration:

```
Show me what files have changed
```

```
Commit my changes with a descriptive message
```

### Using Semantic Summaries

Instead of raw JSON data, ask for summaries:

```
Give me a summary of all entity states
```

This returns a human-readable overview organized by domain, including any detected anomalies.

## Data Storage

Your OpenCode sessions and API credentials are stored in `/data/` within the app. This data:

- **Is backed up** when you create a Home Assistant backup
- **Persists** across app restarts and updates
- **Is private** to your Home Assistant instance

## Security Notes

- This app has access to your Home Assistant configuration files (read/write)
- This app can view system logs (Core, Supervisor, Host)
- When MCP is enabled, OpenCode can query entities and call services
- Access is protected by Home Assistant authentication via ingress
- Only users with access to the OpenCode panel can use this app

## Troubleshooting

### OpenCode won't start

Check if you have enough memory. OpenCode requires at least 256MB of RAM, 512MB recommended.

### Can't connect to AI provider

1. Make sure you have internet access
2. Run `/connect` again to re-authenticate
3. Check that your API key or subscription is valid

### Terminal not loading

1. Try refreshing the page
2. Clear your browser cache
3. Check the app logs in the Home Assistant Supervisor

### MCP not working

1. Make sure MCP is enabled: `ha-mcp status`
2. Restart OpenCode after enabling MCP
3. Test the connection: `ha-mcp test`
4. Check that the app has API access (it should by default)

### Entity not found in MCP queries

1. Verify the entity exists in Home Assistant
2. Check the exact entity_id spelling
3. Use `search_entities` to find entities by name

### Changes not taking effect

After modifying configuration files, you may need to:

1. Validate: **Developer Tools** > **YAML** > **Check Configuration**
2. Reload: **Developer Tools** > **YAML** > **Reload** the relevant domain
3. Or restart Home Assistant for major changes

## Support

- [OpenCode Documentation](https://opencode.ai/docs)
- [OpenCode Discord](https://opencode.ai/discord)
- [GitHub Issues](https://github.com/magnusoverli/ha_opencode/issues)

## License

This app is released into the public domain under the Unlicense.
