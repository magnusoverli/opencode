# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

**You can install this alongside the stable OpenCode add-on.** Both will appear in the sidebar (as "OpenCode" and "OpenCode Beta") and operate independently.

## Current Beta Changes

- **Beta baseline reset**: `1.9.0b0` is based on the current stable OpenCode add-on release and does not include beta-only feature changes yet.
- **Serial device access**: Selected host UART/serial devices can be mapped into the add-on for USB flashing and adapter inspection workflows. Full Supervisor `uart` and `udev` manifest flags remain disabled by default because they are static permissions, not runtime user options.
- **Optional LAN server mode**: You can now enable an OpenCode server bound to `0.0.0.0` so other computers on your local network can connect directly.

## Add-on Folder Access

OpenCode mounts `/addons` and `/addon_configs` for Home Assistant add-on development access. Enable **Add-on Folder Guidance** in the add-on configuration and restart to show these paths in the terminal. This option updates guidance, but the mounts are static add-on metadata and are not a hard filesystem permission boundary.

Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

## Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode Configuration (JSON)** if you need OpenCode's built-in snapshot/undo behavior.

## Zigbee2MQTT URL

If you configure `z2m_url` for zigporter commands, use a full URL such as `http://homeassistant.local:8099`. Host/IP-only values are accepted and treated as `http://`.

## LAN Server Mode (Beta)

LAN server mode lets you attach to the Home Assistant-hosted OpenCode session from a terminal outside the Home Assistant UI.

To enable LAN access:

1. In the add-on **Configuration** tab, set **Enable OpenCode LAN Server** to `true`.
2. In the add-on **Network** settings, map `4096/tcp` to the host port you want to use.
3. Save and restart the add-on.

On the secondary computer, use `opencode attach` with your Home Assistant host IP and configured port:

```bash
opencode attach http://<home-assistant-ip>:<mapped-host-port>
```

Example, if you mapped `4096/tcp` to host port `4096`:

```bash
opencode attach http://192.168.1.50:4096
```

The add-on log shows the current Home Assistant port mapping when the server starts, for example `Home Assistant port mapping: 4096/tcp -> 3443`. If OpenCode also prints `opencode server listening on http://0.0.0.0:4096`, that is the internal container listener, not the URL to use from another computer. Use your Home Assistant host and the mapped host port instead.

Security warning: enabling this service and mapping the port exposes an OpenCode server on your LAN. Only use this on trusted networks, restrict access with your network/firewall controls, and never expose the port to the internet or untrusted networks.

## Reporting Issues

If you encounter problems with the beta, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the add-on logs (Settings > Add-ons > OpenCode Beta > Log) in your report.
