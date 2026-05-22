# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

**You can install this alongside the stable OpenCode add-on.** Both will appear in the sidebar (as "OpenCode" and "OpenCode Beta") and operate independently.

## Current Beta Changes

- **ESPHome connectivity fix**: MCP tools and hab CLI now route through the Supervisor ingress proxy, fixing the HTTP 403/connection-refused errors when communicating with the ESPHome dashboard from within the addon.
- **Optional LAN server mode**: You can now enable an OpenCode server bound to `0.0.0.0` so other computers on your local network can connect directly.

## LAN Server Mode (Beta)

You can enable direct LAN access for remote OpenCode clients from the add-on **Configuration** tab:

- **Enable OpenCode LAN Server**: `true`/`false` (default `false`)
- **OpenCode LAN Server Port**: TCP port (default `4096`)

Connection URL format:

```text
http://<home-assistant-ip>:4096
```

Use this only on trusted networks.

## Reporting Issues

If you encounter problems with the beta, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the add-on logs (Settings > Add-ons > OpenCode Beta > Log) in your report.
