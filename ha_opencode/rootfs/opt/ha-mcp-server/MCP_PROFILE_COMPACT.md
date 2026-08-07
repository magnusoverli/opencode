# Compact Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **compact** profile. It exposes only read-only state, history, diagnostics, templates, calendars, focused home-context tools, and bounded Supervisor health, Resolution, backup, support-log, store-audit, and metrics evidence. Use `get_home_context` before broad state listings.

Do not attempt service calls, configuration writes, firmware or system updates, screenshots, `hab`, or `zigporter` commands through this MCP server. If the user needs those capabilities, explain that they must select the `configuration` or `full` MCP tool profile in the OpenCode add-on Configuration tab and restart the add-on.
