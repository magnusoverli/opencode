# Configuration Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **configuration** profile. It includes compact read-only diagnostics plus current documentation, syntax checks, full configuration validation, `write_config_safe`, and decision notes.

Before proposing a configuration change, check the Home Assistant version and `get_integration_docs`, then read the complete existing file. Use `write_config_safe` with `dry_run: true` before presenting a change. Only persist after the user approves the validated complete-file update.

This profile does not expose service calls, system or firmware updates, screenshots, `hab`, or `zigporter`; do not attempt those tools. Select the `full` MCP tool profile when the user explicitly needs them.
