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
2. **For focused home understanding**: Use `get_home_context` for compact area/domain/entity context before broad state dumps
3. **For entity details**: Use `get_entity_details` to understand relationships and device info
4. **For controlling devices**: Use `call_service` with appropriate domain/service — it also covers services that answer with data (`recorder.get_statistics`, `weather.get_forecasts`, `calendar.get_events`), returning their response without any extra argument
5. **For troubleshooting**: Use `diagnose_entity` for comprehensive analysis
6. **For overview**: Use `get_states` with `summarize: true` for human-readable summaries
7. **For agent capability status**: Use `get_agent_capabilities` to see this add-on's MCP surface and whether Home Assistant reports the native `llm` component or native `/api/mcp/<API ID>` endpoints
8. **For past decisions**: Use `recall_decisions` when a request may conflict with something the user already decided, or when you need the reasoning behind a note in the session digest. Use `remember_decision` only after the user has explicitly approved recording a lasting decision — never to log what you did.

### Compact MCP Output

Some tools return machine-readable JSON text with `summary`, `data`, and `meta` fields. If `meta.truncated` is true, do not treat the result as complete. Re-run the tool with narrower filters such as `entity_id`, `domain`, shorter time ranges, fewer log lines, or a more specific CLI command.

## Home Assistant Native LLM Platform

Home Assistant is adding a native `llm` integration, `<integration>/llm.py` platform, and native MCP endpoints such as `/api/mcp/<API ID>` so Core integrations and custom integrations can provide curated tools to Assist and other registered LLM APIs. The built-in Assist API uses `/api/mcp/assist`. Treat that as complementary to OpenCode MCP:

- Use `homeassistant_native` only when `get_agent_capabilities` reports its bridge as enabled and reachable. A reachable native endpoint alone does not expose native tools to OpenCode.
- Use OpenCode MCP tools for the working add-on surface: configuration editing, safe writes, validation, diagnostics, screenshots, updates, ESPHome, `hab`, Zigbee workflows, add-on development, and Home Assistant documentation lookup.
- Use `get_agent_capabilities` or read `ha://agent/capabilities` before discussing native LLM support. It reports the active MCP tool profile plus whether the native bridge is disabled, unavailable, or ready for OpenCode.
- Use `get_ha_llm_development_guide` when helping develop or review a custom integration's native `<integration>/llm.py` provider.
- If editing a custom integration's future `llm.py`, follow Home Assistant's upstream developer docs and keep changes scoped to the user's request.
- Do not assume the add-on can register tools directly with HA's native `llm` platform. Native tool registration is an internal Home Assistant integration/custom-integration platform; the add-on can consume configured native APIs through native MCP when Home Assistant exposes them.

## Add-on Development Folder Access

When enabled by the user, `/addons` and `/addon_configs` may be available for Home Assistant add-on development. Only inspect or modify these folders when the user explicitly asks. Treat `/addon_configs` as sensitive because it can contain configuration data for other add-ons.

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

### Supervisor Operations Diagnostics
Use these read-only tools before proposing any host, backup, repository, or Resolution change. They return bounded, privacy-preserving evidence and never apply a suggestion or modification.

| Tool | Purpose |
|------|---------|
| `get_supervisor_health` | Summarize Supervisor, host capacity, connectivity, Resolution counts, and job health |
| `get_supervisor_resolution` | Review Resolution issues and suggestions without applying them |
| `get_backup_posture` | Review backup age, size, protection, and contents without locations |
| `get_support_logs` | Read a bounded, credential-redacted Core, Supervisor, host, or app log window |
| `get_store_audit` | Review store apps and repositories with credential-bearing URL parts removed |
| `get_supervisor_metrics` | Read a briefly cached Core, Supervisor, or app resource snapshot |

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

The app pins **hab 1.7.2**. Prefer `hab_run(args=[...])`: each argument stays literal,
including JSON, templates, apostrophes and spaces. The legacy `command` string is
also accepted; pass exactly one form. The gateway defaults to JSON and disables
CLI update checks. Shell hab defaults to JSON when non-interactive, text otherwise.

Start with `args=["schema"]` for compact discovery, or use
`args=["schema","--index","--search","dashboard patch","--limit","10"]`.
Follow `next_offset` while `complete` is false; a page is not the whole catalog.
Request only the chosen command's schema: the gateway requests native `--compact`
by default and preserves payload/output contracts, schema versions and identities.
`args=["guide","list"]` returns a compact topic index; load one guide when needed.
Upstream schema annotations describe behavior, not permission grants.
Use `--brief`, `--count`, `--limit` and specific filters where the schema supports
them. The full gateway is available only in the full MCP profile.

Read before changing, choose the smallest resource-level operation, preview when
supported, apply with the standing approval rules, and read back. A `--plan` can
be a static description rather than a live diff or complete HA validation.
For dashboard fields, prefer `dashboard patch`: its `--plan` reads the current
config and returns an actual diff. Review it, then pass the same `base_revision`
to `--if-match` on apply. Exact JSON Pointer targets select objects; deep merges
preserve unrelated fields, supplied arrays replace, and `--remove` deletes fields.
Existing card/view `update --data` commands still replace the selected object.
Entity rename changes its friendly name, not its entity ID.

Patch `status: verified` confirms stored JSON; `noop` performs no save. On failures,
inspect `error.details.result.saved` and `.verified`: `saved: null` is uncertain,
not proof the write failed. No automatic retry; a conflict requires reinspection
and review of a new diff. Preview does not prove write permission or server acceptance;
read-back does not verify rendering, entity references or resources. HA has no atomic
conditional save, so an edit between the final read and save can still be overwritten.

Read the nested CLI `success`, `error`, `partial_result`, `warnings`,
`missing_sections` and `verification_commands`; process completion alone does not
verify the desired HA state. The default deadline is 60 seconds, including reload
waits; `timeout_seconds` allows 1–120. On timeout, cancellation or an output-limit
failure, inspect state before retrying a mutation. Prefer dedicated ESPHome tools
for long builds/uploads/logs. JSON streams are NDJSON, not one final envelope.

### When to Use hab_run vs Other MCP Tools

- **Use existing MCP tools** for: safe config writing, anomaly detection, entity diagnostics, firmware updates, history queries
- **Use hab_run** for: dashboard management, area/floor/zone/person/category CRUD, helper creation, todo and notification management, integration control, repair issues, event firing, template rendering, backups, blueprints, search. Automation/script/scene API CRUD is available when specifically needed; configuration edits default to YAML + `write_config_safe`. Check command help and supported payload/file options before using API CRUD; do not improvise JSON quoting or switch paths merely because YAML needs a reload.

### Common hab_run Commands

```
# Discover one command contract or workflow
hab_run(args=["schema", "--index", "--search", "dashboard patch", "--limit", "10"])
hab_run(args=["schema", "dashboard", "patch", "--compact"])
hab_run(args=["schema", "dashboard", "card", "update"])
hab_run(args=["guide", "dashboard"])

# Focused reads
hab_run(args=["entity", "list", "--domain", "light", "--brief", "--limit", "20"])
hab_run(args=["entity", "get", "light.living_room", "--related"])
hab_run(args=["automation", "list", "--brief"])
hab_run(args=["automation", "get", "my-automation"])
hab_run(args=["dashboard", "list", "--brief"])
hab_run(args=["dashboard", "card", "get", "my-dashboard", "home", "0", "--section", "0"])

# Preview a field-level edit; apply only after reviewing with approval
hab_run(args=["dashboard", "patch", "my-dashboard", "--target", "/views/0/cards/0", "--data", "{\"name\":\"Kitchen\"}", "--plan"])
# Replace the placeholder with the exact base_revision returned above
hab_run(args=["dashboard", "patch", "my-dashboard", "--target", "/views/0/cards/0", "--data", "{\"name\":\"Kitchen\"}", "--if-match", "sha256:<base_revision>"])

# Approved API actions that return data; MCP call_service is normally preferred
hab_run(args=["action", "call", "weather.get_forecasts", "--entity", "weather.home", "--data", "{\"type\":\"daily\"}", "--return-response"])

# Preview before approved creation
hab_run(args=["area", "create", "Kitchen", "--plan"])
hab_run(args=["person", "create", "Alice", "--plan"])
hab_run(args=["helper", "input-boolean", "create", "Guest Mode", "--plan"])

# To-do lists and notifications (writes require approval)
hab_run(args=["todo", "lists"])
hab_run(args=["todo", "items", "todo.shopping"])
hab_run(args=["todo", "add", "todo.shopping", "Buy milk", "--plan"])
hab_run(args=["todo", "complete", "todo.shopping", "item-uid", "--plan"])
hab_run(args=["notification", "list"])
hab_run(args=["notification", "create", "Backup done", "--title", "Status", "--plan"])

# Integration IDs come from the live list, not a guessed domain
hab_run(args=["integration", "list", "--domain", "hue"])
hab_run(args=["integration", "reload", "config-entry-id", "--plan"])
hab_run(args=["repairs", "list"])
# An approved ignore needs BOTH the issue domain and its ID:
hab_run(args=["repairs", "ignore", "integration_domain", "issue_id"])

# Templates remain a single literal argument
hab_run(args=["template", "render", "{{ states('sensor.temperature') }}"])
hab_run(args=["backup", "list", "--brief"])
hab_run(args=["backup", "create", "Pre-change", "--plan"])
hab_run(args=["system", "health"])
hab_run(args=["overview"])
```

Auth is pre-configured via Supervisor token — no login required.
Marketplace commands require HA 2026.11+; a command's presence does not establish
that the connected HA version or permissions support it. Consult live capabilities.

## zigporter_run Tool (Zigbee Toolkit)

The `zigporter_run` MCP tool provides access to zigporter — a Zigbee device management CLI for Home Assistant. It wraps the `zigporter` CLI as a native MCP tool.

### When to Use zigporter_run vs Other Tools

- **Use zigporter_run** for: cascade entity/device renames (patches automations, scripts, scenes, dashboards), Zigbee device inspection across integrations, stale device cleanup, Z2M device listing, mesh visualization
- **Use hab_run** for: entity friendly-name changes, dashboard CRUD, area management, helpers, backups
- **Use MCP tools** for: entity state queries, service calls, config writing, history, diagnostics

### Key difference: cascade rename

`hab entity rename` changes the friendly name only. The pinned CLI has no
`entity update` or `device update` command. Use zigporter's dry-run workflow for
entity-ID/cascade renames and inspect its documented template-reference limitations.

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

### Create or edit an automation

Load `home-assistant-configuration` for the canonical procedure, including custom
includes/packages and verification. Use structured MCP arguments, not shell JSON.
```
1. Read configuration.yaml and follow includes to the actual automation source
2. Read the complete source; preserve unrelated content and existing IDs
3. Discover relevant entities/services and draft the minimal change
4. write_config_safe(file_path=path, content=yaml, dry_run=true) -> Prevalidate
5. Show the draft; obtain approval for writing and automation.reload
6. write_config_safe(file_path=path, content=yaml) -> Stop if writing/validation fails
7. call_service(domain="automation", service="reload") -> Only if approved
8. Check reload result and affected entity with read-only tools; inspect errors if needed
9. Report saved/reloaded/load-verified separately; suggest a separate functional test
```

Reload stops running automation actions. Never trigger or enable an automation
just to verify loading. If reload is unapproved or `call_service` is unavailable
(for example in the `configuration` profile), report **saved, pending reload**.
Offer HA Developer Tools → YAML for a manual reload or the `full` profile after
an add-on restart; do not bypass the profile through shell/API calls.

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
