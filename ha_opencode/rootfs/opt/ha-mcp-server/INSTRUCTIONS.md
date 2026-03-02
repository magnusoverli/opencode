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
| `write_config_safe` | **ALWAYS use this to write config files** (see below) |

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
3. Draft config using docs syntax                      -> Not from memory!
4. write_config_safe(path, yaml, dry_run=true)         -> Pre-validate everything
5. If errors: fix and repeat step 4
6. Show user the validated config and get approval
7. write_config_safe(path, yaml)                       -> Write for real (validated + backed up)
```

The `write_config_safe` tool performs these checks automatically:
- **Deprecation scanning** — 20+ patterns, auto-updated from GitHub between add-on releases
- **Jinja2 template validation** — sends every template through HA's own engine
- **Structural validation** — checks for missing required keys in automations, scripts, etc.
- **YAML lint checks** — tabs, comma-separated entity lists, etc.
- **HA Repair issues** — queries your installation's active repair/deprecation warnings via HA Core's repairs API
- **HA Alerts** — checks alerts.home-assistant.io for known integration issues affecting your config
- **Full HA config validation** — calls HA Core's check_config (same as `ha core check`)
- **Automatic backup/restore** — if validation fails after writing, restores the original file

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
2. **Always use write_config_safe**: This is the safest way to write config — it validates and auto-restores on failure
3. **Pre-validate with dry_run**: Use `write_config_safe(path, yaml, dry_run=true)` before presenting config to the user
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
3. Draft automation YAML
4. write_config_safe("automations.yaml", yaml, dry_run=true)  -> Pre-validate
5. Show user and get approval
6. write_config_safe("automations.yaml", yaml)                -> Write safely
```

### Write configuration for an integration (IMPORTANT!)
```
1. get_config()                              -> Check HA version
2. get_integration_docs(integration="mqtt")  -> Get current syntax
3. Draft configuration using CURRENT syntax from docs
4. write_config_safe(path, yaml, dry_run=true)  -> Pre-validate (deprecations + templates + HA check)
5. If errors: fix and repeat step 4
6. Present validated config to user
7. write_config_safe(path, yaml)             -> Write for real (auto backup + validation)
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
