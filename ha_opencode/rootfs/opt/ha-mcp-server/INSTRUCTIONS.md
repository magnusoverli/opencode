# Home Assistant MCP Integration

You have access to the Home Assistant MCP server which provides deep integration with Home Assistant. Use these tools proactively to help users with their smart home.

## When to Use MCP Tools

### Always use MCP tools when the user asks about:
- Entity states ("What's the temperature?", "Are the lights on?")
- Controlling devices ("Turn on the lights", "Set thermostat to 72")
- Automations ("Create an automation that...")
- Troubleshooting ("Why isn't my sensor working?")
- Home status ("What's happening in my home?")
- **Updates and firmware** ("Update the sensor", "Check for updates", "What needs updating?")

### Preferred Tool Selection

1. **For finding entities**: Use `search_entities` with natural language queries before `get_states`
2. **For entity details**: Use `get_entity_details` to understand relationships and device info
3. **For controlling devices**: Use `call_service` with appropriate domain/service
4. **For troubleshooting**: Use `diagnose_entity` for comprehensive analysis
5. **For overview**: Use `get_states` with `summarize: true` for human-readable summaries

## Update Management

### Firmware Updates (ESPHome, WLED, Zigbee, etc.)
**ALWAYS use `watch_firmware_update` for device firmware updates.** This tool provides:
- Real-time visual progress timeline with timestamps
- Automatic polling until completion
- Optional `start_update: true` to initiate the update
- Clear success/failure status with version info

```
# Update a device with real-time monitoring
watch_firmware_update(entity_id="update.garage_sensor_firmware", start_update=true)
```

### System Updates (Core, OS, Supervisor, Apps)
Use these tools for Home Assistant system updates:

| Tool | Purpose |
|------|---------|
| `get_available_updates` | Check what updates are available |
| `get_addon_changelog` | View app changelog before updating |
| `update_component` | Start an update (returns job_id) |
| `get_update_progress` | Monitor update progress by job_id |
| `get_running_jobs` | List all active Supervisor jobs |

```
# Check for updates
get_available_updates()

# Update Home Assistant Core
update_component(component="core", backup=true)

# Monitor the update
get_update_progress(job_id="...")
```

## Intelligence Features

### Anomaly Detection
Proactively use `detect_anomalies` when:
- User asks about home status
- User reports something isn't working
- Before suggesting automations

### Automation Suggestions
Use `get_suggestions` when:
- User wants to automate something
- User asks for optimization ideas
- After reviewing their setup

### Semantic Search
The `search_entities` tool understands natural language:
- "bedroom lights" finds light.bedroom_*
- "motion sensors" finds binary_sensor.*motion*
- "front door" finds relevant door sensors

## Documentation Currency (CRITICAL)

Your training data may be outdated. Home Assistant releases monthly updates with breaking changes.

### ALWAYS Check Docs Before Writing Configuration
Use the documentation tools proactively:

| Tool | When to Use |
|------|-------------|
| `get_integration_docs` | **Before writing ANY integration config** |
| `get_breaking_changes` | When config stopped working, or checking compatibility |
| `check_config_syntax` | Before presenting YAML to user |
| `write_config_safe` | **ALWAYS use this to write config files** — blocks accidental content loss (see below) |

### Common Deprecations to Watch For
- **Template sensors**: `platform: template` under `sensor:` -> use top-level `template:`
- **Entity namespace**: `entity_namespace:` is deprecated -> use `unique_id`
- **Time/date sensors**: `platform: time_date` -> use template sensors
- **White value**: `white_value` in lights -> use `white`
- **MQTT legacy platform**: `platform: mqtt` under `sensor:` -> use top-level `mqtt:` key
- **Direct state access**: `states.sensor.x.state` -> use `states('sensor.x')`
- **entity_id in data**: `data: entity_id:` -> use `target: entity_id:`
- **hassio service domain**: `hassio.` services -> use `homeassistant.` domain

### MANDATORY Workflow for Configuration Tasks

**Use `write_config_safe` as the primary tool for writing configuration files.** This tool automatically validates before committing to disk and restores the original file if validation fails.

```
1. get_config()                                        -> Know the HA version
2. get_integration_docs("name")                        -> Get CURRENT syntax
3. read_file(path)                                     -> Read the EXISTING file content first
4. Draft config: include ALL existing content + new changes
5. write_config_safe(path, yaml, dry_run=true)         -> Pre-validate everything
6. If errors: fix and repeat step 5
7. Show user the validated config and get approval
8. write_config_safe(path, yaml)                       -> Write for real (validated + backed up)
```

**CRITICAL: Always read the target file BEFORE writing to it.** The draft must include all existing content plus your changes. Never write only the new content — this will overwrite and destroy existing configuration.

The `write_config_safe` tool performs these checks automatically:
- **Content protection** — blocks writes that would remove list entries, drop top-level keys, or significantly shrink the file
- **Deprecation scanning** — 20+ patterns, auto-updated from GitHub between add-on releases
- **Jinja2 template validation** — sends every template through HA's own engine
- **Structural validation** — checks for missing required keys in automations, scripts, etc.
- **YAML lint checks** — tabs, comma-separated entity lists, etc.
- **HA Repair issues** — queries your installation's active repair/deprecation warnings via HA Core's repairs API
- **HA Alerts** — checks alerts.home-assistant.io for known integration issues affecting your config
- **Full HA config validation** — calls HA Core's check_config (same as `ha core check`)
- **Automatic backup/restore** — if validation fails after writing, restores the original file
- **Backup retention** — `.bak` files are kept as a recovery point even after successful writes

**If validation fails, the original file is automatically restored. The multi-layered validation pipeline is designed to prevent invalid config from reaching your HA instance.**

### How Validation Data Stays Current

The validation system uses multiple data sources that update automatically:
1. **Bundled patterns** — Ship with the add-on, always available offline
2. **GitHub remote patterns** — Fetched hourly from the repo, allowing pattern updates between add-on releases
3. **HA Core config check** — Always reflects your exact HA version's validation rules
4. **HA Repairs API** — Live deprecation warnings specific to your installation
5. **HA Alerts feed** — Global integration issues from alerts.home-assistant.io

### Legacy Workflow (still available)
For quick checks without writing files, you can still use:
```
1. check_config_syntax(yaml)       -> Catch deprecations (regex-based, fast)
2. validate_config()               -> Full HA check (validates on-disk files)
3. get_error_log(lines=100)        -> Read errors if validation fails
```

**Never rely solely on training data for YAML syntax. Always verify with docs.**

## Guided Workflows (Prompts)

Use these prompts for complex tasks:
- `troubleshoot_entity` - When debugging entity issues
- `create_automation` - When building new automations
- `energy_audit` - For energy optimization
- `scene_builder` - For creating scenes
- `security_review` - For security analysis
- `morning_routine` - For routine automations

## Best Practices

1. **Check before changing**: Use `get_states` before `call_service` to verify current state
2. **Always read before writing**: Read the existing file first, then include ALL existing content plus your changes
3. **Always use write_config_safe**: This is the safest way to write config — it validates, protects against content loss, and auto-restores on failure
4. **Pre-validate with dry_run**: Use `write_config_safe(path, yaml, dry_run=true)` before presenting config to the user
4. **Use history for debugging**: Use `get_history` when troubleshooting intermittent issues
5. **Leverage relationships**: Use `get_entity_details` to find related entities
6. **Be specific with services**: Always specify `entity_id` in the target for `call_service`
7. **Verify syntax is current**: Use `get_integration_docs` before writing configuration
8. **Check for deprecations**: The LSP and `write_config_safe` catch these automatically, but `check_config_syntax` is available for quick ad-hoc checks

## hab_run Tool (Home Assistant Builder)

The `hab_run` MCP tool provides access to the full Home Assistant admin CLI. It wraps the `hab` (Home Assistant Builder) CLI as a native MCP tool.

### When to Use hab_run vs Other MCP Tools

- **Use existing MCP tools** for: safe config writing, anomaly detection, entity diagnostics, firmware updates, template rendering, history queries
- **Use hab_run** for: dashboard management, area/floor/zone CRUD, helper creation, automation CRUD via API, backups, blueprints, script management, search

### Common hab_run Commands

```
# List entities
hab_run(command="entity list --domain light")
hab_run(command="entity get light.living_room")

# Call actions
hab_run(command='action call light.turn_on --entity light.living_room --data \'{"brightness": 200}\'')

# Manage automations
hab_run(command="automation list")
hab_run(command="automation get my-automation")

# Manage dashboards
hab_run(command="dashboard list")

# Manage areas
hab_run(command="area list")
hab_run(command="area create Kitchen")

# Manage helpers
hab_run(command='helper create input_boolean --name "Guest Mode"')

# Backups
hab_run(command="backup list")
hab_run(command="backup create")

# System info
hab_run(command="system info")
hab_run(command="system health")

# See all available commands
hab_run(command="help")
```

The tool returns structured JSON output from hab. Auth is pre-configured via Supervisor token.

## zigporter_run Tool (Zigbee Toolkit)

The `zigporter_run` MCP tool provides access to zigporter — a Zigbee device management CLI for Home Assistant. It wraps the `zigporter` CLI as a native MCP tool.

### When to Use zigporter_run vs Other Tools

- **Use zigporter_run** for: cascade entity/device renames (patches automations, scripts, scenes, dashboards), Zigbee device inspection across integrations, stale device cleanup, Z2M device listing, mesh visualization
- **Use hab_run** for: simple entity/device renames (single registry update, no cascade), dashboard CRUD, area management, helpers, backups
- **Use MCP tools** for: entity state queries, service calls, config writing, history, diagnostics

### Key difference: cascade rename

`hab` can rename an entity or device in the HA registry, but references in automations, scripts, scenes, and dashboards are NOT updated. `zigporter` patches ALL references atomically — this is its unique value.

### Common zigporter_run Commands

```
# List all HA devices with structured output
zigporter_run(command="list-devices --json")

# List Zigbee2MQTT devices (requires Z2M config)
zigporter_run(command="list-z2m --json")

# Inspect a device (by name, entity ID, or IEEE address)
zigporter_run(command='inspect "Kitchen Plug" --json')
zigporter_run(command="inspect sensor.kitchen_plug --json")

# Preview a cascade entity rename (dry-run, no --apply)
zigporter_run(command="rename-entity light.old_name light.new_name")

# Apply a cascade entity rename
zigporter_run(command="rename-entity light.old_name light.new_name --apply")

# Preview a cascade device rename
zigporter_run(command='rename-device "Old Name" "New Name"')

# Apply a cascade device rename
zigporter_run(command='rename-device "Old Name" "New Name" --apply')

# Manage stale/offline devices
zigporter_run(command='stale "Offline Device" --action remove')
zigporter_run(command='stale "Offline Device" --action ignore')
zigporter_run(command='stale "Offline Device" --action mark-stale --note "Replaced"')

# Fix post-migration entity suffix conflicts
zigporter_run(command='fix-device "Migrated Device" --apply')

# Check HA + Z2M connectivity
zigporter_run(command="check")

# Zigbee mesh as a text table
zigporter_run(command="network-map --format table")
```

### Important: Rename safety

1. **Always dry-run first**: Omit `--apply` to see the full diff before committing
2. **Jinja2 templates are NOT patched**: After a rename, zigporter prints warnings listing automations/scripts that contain `{{ states('old.id') }}` patterns — inform the user these need manual review
3. **Do NOT use the `migrate` command** — it requires physical device interaction (factory resets, button presses) and is not suitable for AI-driven workflows

The tool returns structured JSON when `--json` is used, or diff/confirmation text for rename operations. Auth is pre-configured via Supervisor token.

## Example Patterns

### Turn on a light
```
1. search_entities("living room light")
2. call_service(domain="light", service="turn_on", target={entity_id: "light.living_room"})
```

### Check home status
```
1. get_states(summarize=true)
2. detect_anomalies()
```

### Troubleshoot an entity
```
1. diagnose_entity(entity_id="sensor.problem_sensor")
2. get_history(entity_id="sensor.problem_sensor")
3. get_error_log(lines=50)
```

### Create an automation
```
1. search_entities() to find relevant entities
2. get_services() to understand available services
3. read_file("automations.yaml")                              -> Read ALL existing automations
4. Draft automation YAML including ALL existing + new
5. write_config_safe("automations.yaml", yaml, dry_run=true)  -> Pre-validate
6. Show user and get approval
7. write_config_safe("automations.yaml", yaml)                -> Write safely
```

### Write configuration for an integration (IMPORTANT!)
```
1. get_config()                              -> Check HA version
2. get_integration_docs(integration="mqtt")  -> Get current syntax
3. read_file(path)                           -> Read the EXISTING file content
4. Draft config: include ALL existing content + new changes
5. write_config_safe(path, yaml, dry_run=true)  -> Pre-validate (deprecations + templates + HA check)
6. If errors: fix and repeat step 5
7. Present validated config to user
8. write_config_safe(path, yaml)             -> Write for real (auto backup + validation)
```

### User reports "config stopped working after update"
```
1. get_config()                              -> Check current HA version
2. get_breaking_changes(integration="...")   -> Check for relevant changes
3. get_error_log(lines=100)                  -> Look for deprecation warnings
4. Review their configuration
5. Suggest updates based on breaking changes
```

### Update a device firmware (ESPHome, WLED, Zigbee, etc.)
```
1. watch_firmware_update(entity_id="update.device_firmware", start_update=true)
   -> Single tool call handles everything: starts update, monitors progress, reports result
```

### Check and install system updates
```
1. get_available_updates()                   -> See what's available
2. update_component(component="core")        -> Start update, get job_id
3. get_update_progress(job_id="...")         -> Monitor progress
```
