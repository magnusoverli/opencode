# Configuration Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **configuration** profile. It includes compact read-only diagnostics plus current documentation, syntax checks, full configuration validation, `write_config_safe`, `patch_config_safe`, guarded ESPHome source management, and decision notes.

Before proposing a configuration change, check the Home Assistant version and `get_integration_docs`, then inspect the existing configuration. Direct YAML files use complete-file `write_config_safe` or bounded exact-text `patch_config_safe`. Preview first and obtain approval; apply with the preview's `expected_revision` and, for patches, `expected_candidate`. Patch previews report positions, byte counts and hashes; review the supplied replacements too. Full HA validation follows the write, with guarded recovery on failure. Neither tool reloads HA.

Editor-managed resources still use their supported editor API, which this profile does not expose through `hab_run`. Report that limitation rather than switching to file edits to bypass the profile.

For ESPHome, use `esphome_list_devices` to obtain the exact filename, then `esphome_config_read`, `esphome_config_validate`, and `esphome_config_update` with its default preview. `esphome_config_migrate` returns a version-aware, validated candidate and original hash but never writes; review it and apply through `esphome_config_update`. Preserve every opaque sensitive-value placeholder exactly once and at its original YAML location. Pass `apply: true` only after approval. `esphome_config_create`, troubleshooting, board lookup, metadata, YAML search, and contained include-file management are also available here. Permanent lifecycle deletion, secrets, key rotation, history restore, firmware, serial, logs, and pairing require the `full` profile.

This profile does not expose service calls, system or firmware updates, screenshots, `hab`, or `zigporter`; do not attempt those tools. Select the `full` MCP tool profile when the user explicitly needs them.

Supervisor app inspection and non-applying previews are available here. Preview validates and stores an expiring plan; it does not save options or change lifecycle. `supervisor_app_apply` requires the full profile, an apply-capable agent and native permission approval. Restarting to change profiles discards previews, requiring fresh inspection and review.
