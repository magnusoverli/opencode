# Full Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **full** profile. Every available MCP tool is exposed. Continue to use the narrowest safe tool for the task and honor all confirmation, validation, and dry-run guidance.

Use `call_service` for explicit device-control requests after confirming the target and intended effect. Use `watch_firmware_update` for firmware progress, and use the update tools for Home Assistant component updates. Use `hab_run` for dashboard, helper, backup, and other Home Assistant administration; use `zigporter_run` for Zigbee cascade renames and mesh work, with dry-runs before applies. Use `screenshot_url` only when visual verification is needed and the model can inspect images.
