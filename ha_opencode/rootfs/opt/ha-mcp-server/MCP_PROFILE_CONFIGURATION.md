# Configuration Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **configuration** profile. It includes compact read-only diagnostics plus current documentation, syntax checks, full configuration validation, `write_config_safe`, guarded ESPHome source management, and decision notes.

Before proposing a configuration change, check the Home Assistant version and `get_integration_docs`, then read the complete existing file. Use `write_config_safe` with `dry_run: true` before presenting a change. Only persist after the user approves the validated complete-file update.

For ESPHome, use `esphome_list_devices` to obtain the exact filename, then `esphome_config_read`, `esphome_config_validate`, and `esphome_config_update` with its default preview. Pass `apply: true` only after approval. `esphome_config_create` follows the same preview-first contract.

This profile does not expose service calls, system or firmware updates, screenshots, `hab`, or `zigporter`; do not attempt those tools. Select the `full` MCP tool profile when the user explicitly needs them.
