---
name: home-assistant-zigbee-esphome
description: Work with Zigbee and ESPHome devices — inspect a device across ZHA/Zigbee2MQTT/Home Assistant, rename an entity or device so every automation and dashboard reference follows, clean up stale or post-migration devices, map the Zigbee mesh, and monitor a firmware update to completion. Load this for any Zigbee, ZHA, Z2M, zigporter, ESPHome, or device-firmware request.
metadata:
  owner: ha-opencode-addon
---

# Zigbee and ESPHome devices

## Firmware updates

Use **`watch_firmware_update`** for device firmware — ESPHome, WLED, Zigbee, and
anything else exposing an `update.*` entity. One call starts the update,
monitors progress in real time, and reports the result:

```
watch_firmware_update(entity_id="update.device_firmware", start_update=true)
```

Do not poll `get_states` in a loop instead; this tool exists because that
pattern burns context and misses the failure modes.

System updates (Core, OS, Supervisor, add-ons) are a different path:

```
1. get_available_updates()               -> what needs updating
2. update_component(component="core")    -> start, returns job_id
3. get_update_progress(job_id="...")     -> monitor
```

Ask before starting either. A firmware update can brick a device on a bad
power supply, and a Core update takes the instance offline. Check
`get_backup_posture` first when the update is a large one.

## Inspecting a device

`zigporter inspect "Device Name" --json` (or `zigporter inspect sensor.entity_id
--json`) is the one command that cross-references ZHA, Zigbee2MQTT and the Home
Assistant registry at once — use it before concluding anything about a Zigbee
device. `zigporter list-devices --json` inventories everything;
`zigporter list-z2m --json` needs the Z2M URL configured in the add-on settings.

For the signal-quality picture, `zigporter network-map --format table` prints the
mesh in the terminal, and `zigporter network-map --output mesh.svg` writes an
SVG. Weak `lqi`, a device routing through a distant parent, or a router that has
gone offline explain a large share of "the sensor keeps dropping out" reports.

`zigporter check` verifies connectivity before you trust any of the above.

## Renaming — the thing zigporter is for

`hab entity update` and `hab device update` rename **one thing** and leave every
reference to the old ID dangling. `zigporter` cascades: it patches automations,
scripts, scenes and every Lovelace dashboard in one atomic pass.

```
zigporter rename-entity light.old_id light.new_id      # dry run (the default)
zigporter rename-entity light.old_id light.new_id --apply
zigporter rename-device "Old Name" "New Name" --apply
```

**Always run the dry run first and show the user the diff.** Renames touch
every dashboard in the installation; this is not a change to apply on a guess.

**Hard limitation:** renames do **not** patch Jinja2 template expressions —
`{{ states('light.old_id') }}` keeps the old ID. zigporter prints a warning
listing the affected files. Tell the user explicitly that those need a manual
pass, and offer to grep for the old ID afterwards:

```
grep -rn "old_id" /homeassistant --include=*.yaml
```

## Cleanup

- `zigporter stale "Device" --action remove` — drop a device that is gone.
  `--action ignore` keeps it but stops it being reported.
- `zigporter fix-device "Device" --apply` — repair entity IDs after a migration
  (ZHA to Z2M, or a re-pair) left duplicates like `sensor.kitchen_temp_2`.

Both are destructive to the registry. Dry-run, show the plan, get approval.

## Never do this

`zigporter migrate` is interactive and requires someone to physically press a
button on the device. It must not be run by an agent. If the user wants to
migrate, walk them through running it themselves.

## ESPHome

ESPHome device configuration lives in the ESPHome add-on, not in
`/homeassistant`. Use the native MCP source tools, which reach Device Builder's
`/ws` API through Home Assistant Ingress. They need the long-lived access token
configured in the add-on settings; without it they report a setup error rather
than failing silently.

For an existing device, always follow this sequence:

1. `esphome_list_devices` to get the exact `configuration` filename.
2. `esphome_config_read` to read the complete YAML and its SHA-256.
3. `esphome_config_validate` or `esphome_config_update` with the default
   `apply: false` to validate the complete candidate.
4. Show the user the intended change and wait for approval.
5. Call `esphome_config_update` with the same `expected_sha256` and
   `apply: true`.

Use `esphome_config_create` with its default preview before applying a new
configuration. Never use these tools for `secrets.yaml`; they reject it by
design. Source and include reads replace sensitive literals with opaque
placeholders; preserve each placeholder exactly once and at its original YAML
location. Use `esphome_secrets` only for key-name/fingerprint reads and
write-only changes; secret values and raw API keys are never returned.

Use `esphome_device_lifecycle` for adoption, ignore/unignore, clone, config-only
rename, archive/unarchive, and confirmed permanent delete. Use
`esphome_firmware` for managed compile/install jobs, status, cancellation,
cleanup, and online rename; use `esphome_logs` for bounded logs and
`esphome_serial` for ports, chip detection, and backend-attached provisioning.
`esphome_pairing` manages remote-build pairing between Device Builder instances,
not interactive browser Web Serial. Open the receiver's pairing window in the
Device Builder UI first; MCP does not open that connection-scoped lease.

Do not use the broken HAB legacy source commands (`config-read`,
`config-write`, `config-patch`, `create`, or `info`) against Device Builder
2026.6 and newer.

For an ESPHome device that has gone unavailable, check the Wi-Fi signal entity
and the device's uptime entity before assuming a firmware problem — a device
rebooting every few minutes is a power or Wi-Fi issue, not a flash.

Use `--json` on every zigporter listing and inspection command; the human-
readable output is meant for people, and parsing it wastes tokens and invites
mistakes.
