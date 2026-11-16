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
4. Read the existing configuration before drafting. A complete-file replacement
   requires the full original; an exact-text patch requires the affected text and
   enough surrounding context to review the intended change.

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

## Choose the editing route by resource ownership

- **Editor-managed automations, scripts and scenes:** use their supported editor
  API through advertised `hab_run` commands. Preserve the complete individual
  resource, not a fragment. No separate whole-file `write_config_safe` replacement
  is required for an editor-resource save.
- **Direct YAML-file edits**, including packages and non-editor includes: use
  complete-file `write_config_safe` or reviewed exact-text `patch_config_safe`,
  preserving unrelated content.
- Determine ownership first. A filename or file size alone does not establish
  editor ownership. If the required tool is missing or the profile is restricted,
  report the limitation; never bypass it with raw API requests or credential-bearing
  shell commands.

### Editor-resource saves

1. Discover the exact automation/script/scene command and payload contract with
   `hab_run` schema discovery. Do not assume scene commands share automation or
   script contracts. Read the complete resource and retain its identifiers.
2. Retain a recoverable backup, draft the minimal change in that complete resource,
   validate it using the supported contract, and preserve unrelated resources.
3. Show the change and request approval, including any automatic reload caused by
   the editor save. Do not treat save approval alone as reload consent.
4. Use supported revision guards where available. Otherwise reread immediately
   before saving and stop for reconciliation if the resource changed. This is
   best-effort concurrency checking, not atomic stale-resource protection.
5. Save through the advertised editor command. Inspect errors and uncertain
   outcomes before retrying. Read back the stored resource and verify native
   activation with read-only runtime evidence. Do not blindly issue an additional
   domain-wide reload. Do not trigger or enable an automation as verification.
6. Report saved, activated/reloaded, and verified separately; identify pending or
   uncertain steps. If native activation did not occur, obtain approval before a
   separately supported reload.

## Writing YAML files safely

`write_config_safe` and `patch_config_safe` are the sanctioned direct-file write
paths. Both use the same pipeline, which validates, backs up, blocks
writes that would drop list entries or top-level keys or shrink a file
suspiciously, and attempts verified recovery on failure. Recovery can fail: inspect
the transaction result and never claim restoration merely because it was attempted.

```
1. get_config()                                -> installed version
2. get_integration_docs("template")            -> current syntax
3. read the existing file                      -> ALL of it
4. draft: existing content + your change
5. write_config_safe(path, yaml, dry_run=true) -> pre-validate
6. fix and repeat 5 until clean
7. show the user, wait for approval
8. write_config_safe(file_path=path, content=yaml,
   expected_revision=<source revision from step 5>) -> write for real
```

**Never pass partial content to `write_config_safe`.** Read first, include everything
that was already there. It blocks the worst cases, but the draft you show the user
must already be complete. For a bounded change, use the patch workflow instead:

1. Read the affected YAML and surrounding context. Choose unique exact `old_text`
   matches and their replacement `new_text`; all matches refer to the original
   file, not the result of earlier edits. Empty replacement text means deletion.
2. Preview with `patch_config_safe(file_path=path, edits=[...])`. Dry-run is the
   default. It permits up to 20 non-overlapping edits, each with at most 16 KiB of
   combined old/new UTF-8 text. The complete candidate must fit the existing
   1 MiB YAML preflight limit; patching does not bypass parser complexity limits.
3. Review the exact supplied replacements and the preview's source lines, byte
   counts, **Source Revision** and **Candidate SHA-256**. The preview metadata
   is not a rendered diff or proof of full HA validation. Obtain approval.
4. Apply the same edits with `dry_run: false`, `expected_revision` set to the
   reviewed source hash, and `expected_candidate` set to the reviewed candidate
   hash. Do not refresh hashes silently after a conflict.
5. Inspect the transaction result, read back, then perform only the separately
   approved reload/restart and verification. Patching never reloads HA.

Patching preserves unrelated bytes, comments and formatting without reserializing
YAML. It refuses missing files, ambiguous/overlapping matches, invalid UTF-8,
secrets and hidden/internal paths. Content-loss checks still require
`confirm_deletions: true` for approved removals they would otherwise block.
Editor-managed resources still use their supported editor API.

The dry run returns a source revision, not proof of full HA validation of the
proposed content. Actual writes require that unchanged revision. A conflict needs
a fresh read, dry run and approval; do not silently refresh the revision. Full HA
validation runs against live files after atomic replacement. A recovery-required
or uncertain outcome needs local inspection before retrying. Never delete the
writer lock or recovery copies to bypass an unresolved transaction.

If the required safe-write tool is not present, the add-on is running a reduced
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

Use `yq` for read-only queries or preparing a draft, never in-place writes
(`yq -i`). Direct file changes must go through complete-file `write_config_safe`
or reviewed exact-text `patch_config_safe`.
Custom tags stick to overwritten values, and serialization can strip blank
separator lines: inspect the complete draft and its tags before approval.

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

Choose the route by ownership as described above. Editor-managed automations
follow the editor-resource workflow. The following steps apply to **direct YAML
automation files**, including packages and non-editor includes.

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
6. Write the approved content with `write_config_safe`, passing the dry run's
   unchanged `expected_revision`. If writing or validation
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

For a bounded direct-YAML edit, the exact-text patch workflow above may replace
the complete-file drafting, preview and write steps. Preserve IDs, ownership
checks, separately approved reload and verification in either case.

For editor-managed resources, follow the editor-resource workflow above rather
than requiring a second whole-file write. Never guess payload flags or improvise
shell escaping.

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
