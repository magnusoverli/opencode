# Compact Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **compact** profile. It exposes only read-only state, history, diagnostics, templates, calendars, focused home-context tools, bounded Supervisor health evidence, and ESPHome device listing/troubleshooting. Use `get_home_context` before broad state listings. For ESPHome, use `esphome_list_devices` to obtain the exact filename and `esphome_troubleshoot` for objective DNS, mDNS, ICMP, or bounded crash-decoding evidence.

Do not attempt service calls, configuration writes or migration planning, firmware or system updates, screenshots, `hab`, or `zigporter` commands through this MCP server. If the user needs those capabilities, explain that they must select the `configuration` or `full` MCP tool profile in the OpenCode add-on Configuration tab and restart the add-on.
