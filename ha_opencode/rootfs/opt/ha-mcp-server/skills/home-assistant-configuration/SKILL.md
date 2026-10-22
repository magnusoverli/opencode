---
name: home-assistant-configuration
description: Write or change Home Assistant YAML — automations, scripts, scenes, templates, integrations, packages, helpers. Covers checking current integration documentation before writing, the mandatory HA YAML style guide, reading and querying YAML with yq, safe writes through write_config_safe, validation, backups, and whether a change needs a reload or a restart. Load this before editing any file under /homeassistant.
metadata:
  owner: ha-opencode-addon
---

# Home Assistant configuration work

The consent rules in `AGENTS.md` apply to everything here: show the change,
wait for explicit approval, change nothing else.

## Before you write anything

Home Assistant ships a release every month, with new options, deprecations and
breaking changes. Training data goes stale fast, so verify syntax against the
running version rather than recalling it.

1. `get_config` — which Home Assistant version is this?
2. `get_integration_docs("<integration>")` — current YAML syntax and examples.
3. `get_breaking_changes` — when something stopped working after an update.
4. Read the existing file in full. Every write replaces the whole file.

When decision recall is advertised, call `recall_decisions` for the relevant
`file`, `entity` or `integration` before drafting. Use focused `query` wording
when references are missing; follow `next_cursor` with unchanged filters/limit
until relevant pages are complete. A revision change requires a fresh lookup.
Do not repeat completed recall unless scope or notes change, and do not treat
superseded notes as current instructions. This does not approve a write.

Frequently-changed areas worth double-checking:

- Template sensors: `platform: template` under `sensor:` is deprecated — use the
  top-level `template:` key.
- MQTT: `platform: mqtt` under a domain key is deprecated — use top-level `mqtt:`.
- Service targeting: `entity_id` at action level or inside `data:` is deprecated
  — use `target:`.
- Direct state access: `states.sensor.x.state` is fragile — use `states('sensor.x')`.
- Many integrations moved from YAML to UI-only configuration.

## Writing safely

`write_config_safe` is the sanctioned write path. It validates, backs up, blocks
writes that would drop list entries or top-level keys or shrink a file
suspiciously, and restores on failure.

```
1. get_config()                                -> installed version
2. get_integration_docs("template")            -> current syntax
3. read the existing file                      -> ALL of it
4. draft: existing content + your change
5. write_config_safe(path, yaml, dry_run=true) -> pre-validate
6. fix and repeat 5 until clean
7. show the user, wait for approval
8. write_config_safe(path, yaml)               -> write for real
```

**Never write partial content to a config file.** Read first, include everything
that was already there. `write_config_safe` blocks the worst cases, but the
draft you show the user must already be complete.

If the `write_config_safe` tool is not present, the add-on is running a reduced
MCP tool profile. Say so rather than falling back to shell redirection.

## Reading and querying YAML from the shell

Use **`yq`** (the mikefarah Go tool, on `PATH`). It tolerates Home Assistant's
custom tags — `!include`, `!secret`, `!env_var`, `!input`, `!include_dir_*`.
**PyYAML and Ruby's YAML crash on the first `!include`**, so do not reach for
`python3 -c "import yaml"`.

```
yq '.homeassistant.latitude' configuration.yaml   # nested value
yq '.automation | tag' configuration.yaml         # the tag itself -> !include
yq 'keys' configuration.yaml                      # top-level keys
yq -o=json '.' configuration.yaml | jq '.sensor'  # pipe into jq
```

Output and JSON conversion strip tags — `!secret home_latitude` prints as
`home_latitude`. Use `| tag` when the tag matters. **Never round-trip a file
through JSON and back**; every `!include`/`!secret` is lost permanently.

Prefer `write_config_safe` or the editor for changes. `yq -i` is for quick,
low-risk edits only, with two caveats:

1. **A custom tag sticks to the value you overwrite.**
   `yq -i '.homeassistant.latitude = 52.37'` on a `!secret` node yields the
   corrupt `latitude: !secret 52.37`. Reset the tag in the same expression:
   ```
   yq -i '(.homeassistant.latitude tag = "") | .homeassistant.latitude = 52.37' configuration.yaml
   ```
   To *add* a secret reference:
   `yq -i '.http.api_key = "my_api_key" | .http.api_key tag = "!secret"' configuration.yaml`
2. **`yq -i` strips blank separator lines** across the whole file. Nothing is
   lost, but diffs get noisy. Use the editor when a clean diff matters.

`yq` only proves the YAML parses. To validate a Home Assistant *configuration*
— resolving `!include`/`!secret`, checking integration schemas — use
`check_config_syntax` or `write_config_safe`.

## YAML style guide (mandatory)

All YAML written or modified MUST follow the official
[Home Assistant YAML style guide](https://developers.home-assistant.io/docs/documenting/yaml-style-guide/).
Prettier is configured here and auto-formats on save, but it only enforces a
subset — the rules marked `*` are yours to apply.

- **Indentation**: 2 spaces. Tabs forbidden.
- **Booleans** `*`: lowercase `true` / `false` only. Never `Yes`, `On`, `TRUE`.
- **Strings**: double quotes. No single quotes. **Exceptions** (leave unquoted):
  entity IDs, area IDs, device IDs, platform types, trigger/condition types,
  action names, device classes, event names, attribute names, and fixed-set
  values such as `mode`.
- **Sequences** `*`: block style, indented under their key. No `[1, 2, 3]`, and
  no list items sitting at the key's own indent.
- **Mappings** `*`: block style. No `{ key: val }`.
- **Null** `*`: implicit — just `key:` with no value. Never `null` or `~`.
- **Comments**: `# ` then a capital, indented to the current level.
- **Multiline**: literal `|` or folded `>`. Avoid `\n` inside quoted strings.
  Prefer no-chomp (`|`, `>`) unless you need strip (`|-`, `>-`).
- **Templates**: double quotes outside, single inside. Use `states()`,
  `state_attr()`, `is_state()` — not `states.sensor.x.state`. Split long
  templates over multiple lines with `>-`.
- **Service targets** `*`: always `target:`. Never `entity_id` at action level
  or inside `data:`.
- **Scalar vs list** `*`: a single value stays a scalar; do not wrap it in a
  list, and never use a comma-separated string.
- **List of mappings** `*`: properties that accept a mapping or a list of them
  (`actions`, `conditions`) always take a list, even for one item.

```yaml
# Good
actions:
  - action: light.turn_on
    target:
      entity_id: light.living_room
    data:
      brightness: 200
      message: "Hello!"

# Bad
actions:
  action: "light.turn_on"
  entity_id: light.living_room
```

## What lives where

- `configuration.yaml` — main file
- `automations.yaml`, `scripts.yaml`, `scenes.yaml`, `groups.yaml`,
  `customize.yaml` — split config, usually UI-managed
- `secrets.yaml` — never display, never copy a value out of it
- `packages/` — package-based splits; `blueprints/`; `themes/`; `www/` (served
  at `/local/`); `custom_components/`
- `.storage/`, `.cloud/`, `deps/`, `tts/`, `home-assistant_v2.db`,
  `home-assistant.log` — off-limits, use MCP tools instead

Know the `!include` family: `!include`, `!include_dir_named`,
`!include_dir_list`, `!include_dir_merge_named`, `!include_dir_merge_list`.
Use anchors (`&name`) and aliases (`*name`) for DRY configuration, and packages
when a feature spans several domains.

## Creating or editing an automation

Use YAML + `write_config_safe` as the default, including for UI-managed
automations. A reload is a normal part of applying YAML, not a reason to switch
to API editing or hand-built JSON/shell commands.

1. Read `configuration.yaml` and follow its automation includes or packages to
   find the actual source file. Do not assume everything is in `automations.yaml`.
2. Read the whole source file. Preserve unrelated content and existing automation
   IDs; give a new automation a unique ID. Identify the affected runtime entity
   from its ID/current state, not by guessing an entity ID from its alias.
3. Identify the trigger, conditions, and entities (`search_entities` /
   `get_home_context`). Draft the minimal change in the complete file.
4. Prevalidate with `write_config_safe(file_path=..., content=..., dry_run=true)`.
   Fix validation failures before proceeding. A dry run does not persist or apply
   the change.
5. Show the draft and explain that `automation.reload` applies it without a Core
   restart, but stops currently running automation actions. Ask for approval of
   the write and reload together; approval of only the write is not reload consent.
6. Write the approved content with `write_config_safe`. If writing or validation
   fails, stop and report the failure; do not reload. If the source changed since
   it was read, reread it and reconcile the draft before writing.
7. Once the write succeeds and reload is approved, use the structured MCP call
   `call_service(domain="automation", service="reload")`. Do not construct shell
   JSON for this. If `call_service` is missing (the `configuration` profile omits
   it), report **saved, pending reload** and explain that the user can reload
   automations in HA's Developer Tools → YAML, or enable the `full` profile and
   restart the add-on. Never work around a reduced profile through shell/API calls.
8. Check the service result, then use `get_entity_details` for the affected entity
   (or a bounded `get_states` query for domain `automation` to locate a new one).
   Check relevant `get_error_log` entries if it is missing, unavailable, or the
   reload failed. An existing entity alone does not prove the new YAML loaded:
   combine the reload result with runtime evidence. Do not enable a disabled
   automation or trigger its actions as verification without separate approval.
9. Report **saved**, **reloaded**, and **load verified** separately, including any
   pending/failed step. Successful loading is not proof of behaviour; suggest a
   separate user-approved functional test.

If API editing is specifically required, check `hab automation --help` and the
subcommand's help for supported payload/file options first. Do not guess flags
or repeatedly improvise escaping. Preserve the same approval and verification
requirements.

Triggers: state, time, time_pattern, event, webhook, mqtt, template, zone,
device, numeric_state. Conditions: state, numeric_state, time, template, zone,
and/or/not. Actions: service calls, `delay`, `wait_template`, `choose`,
`repeat`, `if/then/else`. Trigger variables (`trigger.to_state`,
`trigger.from_state`, `trigger.entity_id`) and `continue_on_error` are worth
reaching for.

## Applying the change

Ask before doing any of these, and say plainly which one is needed:

| Change | What it takes |
|---|---|
| `automations.yaml`, `scripts.yaml`, `scenes.yaml` | Reload that domain — no restart |
| Template entities, most helper YAML | Reload the domain |
| `configuration.yaml` integration blocks | Usually a **restart** |
| New custom component in `custom_components/` | **Restart** |
| `secrets.yaml` values | Restart whatever reads them |

A restart drops every automation mid-run and takes the instance offline for a
minute or more. Never restart without asking, and say why it is needed.

Before anything large: `hab backup create`, or `get_backup_posture` to check how
recent the last backup is. Validate first with `check_config_syntax` or
`validate_config` — a failed restart on a broken configuration is the one
outcome worth real effort to avoid.
