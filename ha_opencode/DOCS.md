# OpenCode

OpenCode is an AI-powered coding agent that helps you edit and manage your Home Assistant configuration directly from your browser.

## Upstream Attribution

This independent Home Assistant add-on redistributes and integrates
[OpenCode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, under the
MIT License. It is not made by, affiliated with, or endorsed by the OpenCode
team or Anomaly. The complete OpenCode notice is included in the add-on image
at `/usr/share/doc/ha-opencode/NOTICE` and in this repository's
[`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md).

## Features

- **AI-Powered Editing**: Use natural language to modify your Home Assistant configuration
- **Modern Terminal**: Beautiful web-based terminal with 10 theme options
- **OpenChamber Web UI**: Optional graphical interface for OpenCode, served through the same sidebar entry
- **Log Access**: View Home Assistant Core, Supervisor, and host logs
- **Ingress Support**: Access directly from the Home Assistant sidebar
- **Provider Agnostic**: Works with Anthropic, OpenAI, Google, and 70+ other AI providers
- **MCP Integration**: Deep Home Assistant integration with Tools, Resources, Prompts, and Intelligence
- **Home Assistant Native LLM Readiness**: Detects HA's emerging native `llm` component and documents how OpenCode will adopt HA-native agent capabilities as they become available
- **Visual Verification**: Screenshot tool for verifying dashboard changes with AI vision
- **LSP Integration**: Intelligent YAML editing with entity autocomplete, hover info, and diagnostics
- **PPQ Private TEE Models (Beta)**: Optional encrypted proxy for PPQ private models running in remote TEEs. Included in stable releases, but still considered beta.
- **Serial Device Access**: Optionally map selected host serial devices into the add-on for USB flashing and adapter inspection workflows
- **Optional LAN Server Mode**: Attach from another computer on your local network using the OpenCode CLI

## Configuration

Configure the app from the **Configuration** tab in the app page.

The options below appear in the same order and groups as the Configuration tab.

### Interface Mode

| Option | Default | Description |
|--------|---------|-------------|
| **Interface mode** | `terminal` | Choose the browser interface shown in the sidebar: the classic `terminal` or the `openchamber` web UI. |

The add-on can show either the terminal interface or the OpenChamber web UI in the Home Assistant sidebar.

Modes:

- `terminal`: default. Uses the ttyd terminal and tmux session.
- `openchamber`: serves the OpenChamber web UI behind Home Assistant Ingress on the same sidebar entry.

To switch to OpenChamber:

1. In the add-on **Configuration** tab, set **Interface mode** to `openchamber`.
2. Save and restart the add-on.
3. Open **OpenCode** from the Home Assistant sidebar.

Security and networking notes:

- OpenChamber is not exposed through a Home Assistant Network port.
- The OpenChamber process binds to `127.0.0.1` inside the container.
- A small first-party ingress proxy binds to internal port `8099`, accepts Home Assistant Ingress traffic, and forwards to OpenChamber locally.
- Home Assistant Ingress provides the browser authentication layer, so no separate OpenChamber UI password is needed.
- LAN access remains the separate opt-in **Enable OpenCode LAN server** feature on port `4096`.

If OpenChamber misbehaves (for example after an update), switch **Interface mode** back to `terminal`, restart the add-on, and include logs when reporting the issue.

OpenChamber's own built-in update check is disabled in this add-on. OpenChamber is pinned and patched for Home Assistant Ingress when the add-on image is built, so an in-app self-update cannot persist or stay patched and would only hang the UI. OpenChamber is updated by updating the add-on — no "update available" prompt appears inside OpenChamber, and the Update button in **Settings → OpenChamber → About** reports no update.

### Terminal Appearance

| Option | Default | Description |
|--------|---------|-------------|
| **Terminal theme** | `breeze` | Color scheme for the terminal. Options: `breeze`, `catppuccin_mocha`, `catppuccin_latte`, `dracula`, `nord`, `tokyo_night`, `one_dark`, `solarized_dark`, `solarized_light`, `gruvbox_dark`. See [Theme Previews](#theme-previews). |
| **Font size** | `14` | Terminal font size in pixels (10-24). |
| **Cursor style** | `block` | Cursor appearance: `block`, `underline`, or `bar`. |
| **Cursor blinking** | `false` | Whether the cursor should blink. |

### Home Assistant Integration

| Option | Default | Description |
|--------|---------|-------------|
| **Enable MCP integration** | `true` | Enable the Model Context Protocol (MCP) server for deep Home Assistant integration. Includes 37 tools, 14 resources, 6 guided prompts, and an intelligence layer for anomaly detection, config validation, and automation suggestions. |
| **Enable LSP integration** | `true` | Enable the Language Server Protocol (LSP) server for intelligent YAML editing. Provides entity/service autocomplete, hover documentation, diagnostics for unknown entities, and go-to-definition for !include tags. |
| **Restrict access to sensitive files** | `true` | Deny the AI read access to secret/credential files (`secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, `*.key`, `*.pem`) so their contents cannot reach the model. Everything else stays readable. Set to `false` to restore fully unrestricted file access. See [Sensitive File Protection](#sensitive-file-protection). |
| **Enable screenshot tool** | `false` | Enable visual verification of dashboards and UI pages. Uses headless Chromium to capture screenshots that vision-capable AI models can analyze. Requires the access token below. See [Visual Verification](#visual-verification-screenshots). |
| **Home Assistant access token** | `""` | A long-lived access token for direct communication with Home Assistant Core. Required for ESPHome integration and the screenshot tool. Create one in the Home Assistant UI under Profile → Long-lived access tokens. |

### Sensitive File Protection

By default (**Restrict access to sensitive files** = `true`), the add-on adds an OpenCode `permission.read` rule that blocks the AI's file-**read** tool from opening files that typically hold secrets or credentials, so their contents can't be pulled into the model's context:

- `secrets.yaml` (and any path ending in `secrets.yaml`)
- the `.storage/` directory (auth/refresh tokens, cloud, application credentials)
- the `.cloud/` directory (Nabu Casa cloud)
- the `ssl/` directory, and any `*.key` / `*.pem` files

Everything else stays fully readable, and this doesn't change how the agent edits normal configuration that *references* secrets via `!secret` — it never needs the secret's value to do that. The Home Assistant MCP tools are unaffected; they read live state through the API, not these files.

**To restore the previous, fully-permissive behavior,** set **Restrict access to sensitive files** to `false` and restart the add-on. You can also fine-tune individual paths — re-allow one, add more denials, or extend the same protection to the edit tool — via **Custom OpenCode configuration** using OpenCode's [permission rules](https://opencode.ai/docs/permissions/).

**Scope/limitation:** this guards OpenCode's structured file-read tool, which is the common path for accidental exposure. It does **not** restrict shell commands, so an explicit `cat secrets.yaml` in the terminal can still read the file. Treat it as a strong guardrail against inadvertent leaks, not a hard sandbox.

### OpenCode Runtime

| Option | Default | Description |
|--------|---------|-------------|
| **OpenCode update policy** | `bundled` | Controls how OpenCode itself is updated. `bundled` (default) uses the OpenCode version shipped in the add-on image — the lowest-memory option. `latest` follows upstream OpenCode releases, refreshed in the background so it never delays start-up and skipped automatically on low-memory systems. See [OpenCode Updates](#opencode-updates). |
| **CPU mode** | `auto` | Controls which OpenCode binary is used. `auto` detects your CPU capabilities automatically (recommended). `baseline` forces the baseline binary for older CPUs without AVX2 support. `regular` forces the standard binary. |

### Zigbee2MQTT and Serial Devices

| Option | Default | Description |
|--------|---------|-------------|
| **Zigbee2MQTT URL** | `""` | Optional URL for Zigbee2MQTT, used by zigporter commands such as `list-z2m` and `network-map --backend z2m`. Include `http://` or `https://`, for example `http://homeassistant.local:8099`. Host/IP-only values are treated as `http://`. |
| **Zigbee2MQTT base topic** | `zigbee2mqtt` | MQTT base topic used by Zigbee2MQTT. |
| **Serial devices** | `[]` | Optional list of host UART/serial devices to map into the add-on. Use this for workflows that need direct serial access, such as local USB flashing or adapter inspection. See [Serial Devices](#serial-devices). |

### Privacy and Remote Access

| Option | Default | Description |
|--------|---------|-------------|
| **Enable PPQ private TEE models (beta)** | `false` | Start an internal PPQ private-mode encryption proxy and add it as an OpenCode provider. Requires **PPQ API key**. This feature should still be considered beta. See [PPQ Private TEE Models (Beta)](#ppq-private-tee-models-beta). |
| **PPQ API key** | `""` | API key for PPQ private-mode models. Stored as a masked add-on option and exported only to the internal PPQ proxy service. Only needed for the PPQ feature. |
| **Enable OpenCode LAN server** | `false` | Start an OpenCode server on internal port `4096` so clients on your local network can attach with the OpenCode CLI. Also requires mapping `4096/tcp` in the add-on Network settings. See [LAN Server Mode](#lan-server-mode). |

### Advanced Options

| Option | Default | Description |
|--------|---------|-------------|
| **Enable add-on folder guidance** | `false` | Shows terminal guidance for Home Assistant add-on development folders. The add-on mounts `/addons` and `/addon_configs` for development access; `/addon_configs` may contain sensitive add-on data. This is guidance only, not a hard filesystem permission boundary. |
| **Environment variables** | `[]` | Define custom environment variables that are available to OpenCode and the terminal shell. Each entry has a `name` and `value`. Useful for provider credentials or configuration that must be set as environment variables (e.g. `AZURE_RESOURCE_NAME`, `OPENAI_API_KEY`). Critical system variables (`HOME`, `PATH`, `SUPERVISOR_TOKEN`, etc.) cannot be overridden. |
| **Custom OpenCode configuration** | `""` | Paste a JSON object to customize OpenCode's own configuration (providers, keybindings, etc.). This is merged with the add-on's built-in config. Leave empty for defaults. See [OpenCode config docs](https://opencode.ai/docs/config) for the full schema. |

### Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode configuration** if you need OpenCode's built-in snapshot/undo behavior.

On low-memory hosts — for example a 4 GB Home Assistant Green running several other add-ons — keep **OpenCode update policy** on `bundled` (the default) so the add-on does no memory-heavy start-up install, and expect the agent itself to be memory-hungry during large tasks. 8 GB or more is recommended for comfortable use alongside other memory-heavy add-ons such as Matter Server, Music Assistant, and Whisper/Piper.

### OpenCode Updates

By default, **OpenCode update policy** is set to `bundled`: the add-on uses the OpenCode version shipped in its image and does no start-up install. This is the lowest-memory option and is recommended for systems with 4 GB RAM or limited free memory.

Set **OpenCode update policy** to `latest` to follow upstream OpenCode releases independently of add-on releases. The add-on starts immediately on the bundled (or an existing healthy persistent) binary, then refreshes `opencode-ai@latest` into `/data/.npm-global` **in the background**; the newer version becomes active for the next OpenCode session. The background update never blocks start-up, and it is skipped automatically when available memory is below ~1.5 GB so the install cannot push a low-memory host into swap-thrash. If an update is interrupted or produces a binary that will not run, the add-on discards it and keeps using the known-good bundled copy.

For x64 systems without visible AVX2 support, OpenCode selects its baseline binary. If this add-on runs in a VM on an AVX2-capable host, enable host CPU passthrough; generic QEMU/KVM CPU models can hide AVX2 and force the baseline binary unnecessarily. There is a known upstream baseline OOM issue tracked at `anomalyco/opencode#20988`.

#### Environment Variables Example

To set environment variables for an Azure OpenAI provider, add entries in the Configuration tab:

| Name | Value |
|------|-------|
| `AZURE_RESOURCE_NAME` | `my-azure-resource` |
| `AZURE_API_KEY` | `sk-...` |

After saving and restarting the add-on, these variables will be available in the terminal and to OpenCode. You can then use `/connect` inside OpenCode to configure your provider.

> **Note:** Environment variable values are stored on disk inside the container and are excluded from Home Assistant backups. However, they are visible in the add-on's Configuration tab. Treat them with the same care as any stored credential.

### PPQ Private TEE Models (Beta)

PPQ private mode routes OpenCode requests through a local encryption proxy before forwarding them to PPQ's private inference API. The proxy verifies the remote enclave, encrypts the request locally, and decrypts the response locally.

This feature is included in stable releases, but should still be considered beta while provider behavior and proxy integration are validated.

Flow:

```text
OpenCode -> 127.0.0.1:8787 PPQ proxy -> PPQ API -> remote TEE
```

To enable PPQ private models:

1. Get a PPQ API key from PPQ.
2. In the add-on **Configuration** tab, set **Enable PPQ Private TEE Models (Beta)** to `true`.
3. Paste the key into **PPQ API key**. Alternatively, set `PPQ_API_KEY` through **Environment variables** if you manage credentials that way.
4. Save and restart the add-on.
5. In OpenCode, select the `PPQ Private (TEE)` provider and one of the `private/...` models.

Security notes:

- The proxy binds only to `127.0.0.1:8787` inside the add-on container.
- No Home Assistant network port is exposed for PPQ private mode.
- The preferred PPQ API key path is the masked add-on option; `PPQ_API_KEY` in **Environment variables** is also supported for advanced setups.
- The PPQ API key is not logged.
- The proxy package is pinned at image build time; the add-on does not run `npx latest` at startup.

Bundled model IDs come from the pinned `ppq-private-mode` package version:

| Model ID | Description |
|----------|-------------|
| `private/kimi-k2-5` | Recommended fast general model, 262K context window |
| `private/deepseek-r1-0528` | Reasoning and analysis |
| `private/gpt-oss-120b` | Budget-friendly general use |
| `private/llama3-3-70b` | Open-source tasks |
| `private/qwen3-vl-30b` | Vision and text, 262K context window |

### Serial Devices

Serial access is disabled by default. To enable it, add one or more host serial devices to the `serial_devices` option in the add-on Configuration tab, then restart the add-on. Home Assistant Supervisor validates those paths and maps only the selected devices into the container.

OpenCode and terminal commands can then use paths such as `/dev/ttyUSB0`, `/dev/ttyACM0`, or stable `/dev/serial/by-id/...` paths when they are provided by the host. The selected paths are also exported as `OPENCODE_SERIAL_DEVICES` using `:` as the separator.

The Supervisor `uart` and `udev` manifest flags remain disabled by default. They are static add-on manifest permissions rather than regular user options, so they cannot be toggled from the add-on Configuration tab.

### LAN Server Mode

LAN server mode lets you attach to the Home Assistant-hosted OpenCode session from a terminal outside the Home Assistant UI.

To enable LAN access:

1. In the add-on **Configuration** tab, set **Enable OpenCode LAN server** to `true`.
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

### Theme Previews

- **Breeze** - KDE Konsole default, clean and professional
- **Catppuccin Mocha** - Soothing pastel dark theme
- **Catppuccin Latte** - Light pastel theme for bright environments
- **Dracula** - Popular dark theme with vibrant colors
- **Nord** - Arctic, bluish color palette
- **Tokyo Night** - Dark theme inspired by Tokyo city lights
- **One Dark** - Atom editor's iconic dark theme
- **Solarized Dark** - Precision colors for dark backgrounds
- **Solarized Light** - Precision colors for light backgrounds
- **Gruvbox Dark** - Retro groove color scheme

## Getting Started

### 1. Open the App

Click on **OpenCode** in the Home Assistant sidebar to open the terminal.

### 2. Configure Your AI Provider

OpenCode needs an AI provider to function. Run the following command inside OpenCode:

```
opencode
```

Then use the `/connect` command to add your AI provider:

```
/connect
```

Follow the prompts to authenticate with your preferred provider:
- **Anthropic** (Claude) - Recommended
- **OpenAI** (GPT-4)
- **Google** (Gemini)
- **OpenCode Zen** - Curated models optimized for coding
- And many more...

#### Browser Sign-In (ChatGPT and Other OAuth Providers)

Some providers offer a **browser** sign-in method that sends you back to `http://localhost:<port>/auth/callback` once you have signed in. That address is the add-on container, not the computer you are browsing from, so the final redirect always fails to load with a connection error. That is expected here and does not mean the sign-in failed.

- **OpenChamber interface**: after signing in, copy the whole `http://localhost:...` URL from your browser's address bar, paste it into the **Paste authorization code** field, and select **Complete**. The add-on hands it to OpenCode locally so the sign-in finishes. Pasting only the `code=` value from that URL works too.
- **Terminal interface**: use the provider's **headless** method instead (for example **ChatGPT Pro/Plus (headless)**). It shows a short code to enter on the provider's device-authorization page and needs no redirect at all.

If a browser sign-in still does not complete, check the add-on log for `OAuth loopback bridge` lines and include them when reporting the issue.

### 3. Start Coding!

Once connected, you can ask OpenCode to help with your Home Assistant configuration:

```
Help me create an automation that turns on the lights when motion is detected
```

```
Review my configuration.yaml for any issues
```

```
Add a template sensor for my energy usage
```

## Copy and Paste

The web terminal supports the system clipboard in both directions:

**Copying out of the terminal**

- **Inside OpenCode**: select text with the mouse (or use OpenCode's copy keybinds) — the selection is sent to your clipboard automatically.
- **In the shell**: click and drag to select — the text is copied the moment you release (a ✂ icon flashes to confirm).
- **While a full-screen app captures the mouse** (OpenCode, `htop`, etc.) you can always force a browser-side selection with **Shift+drag** (Windows/Linux) or **Option+drag** (macOS).

> **Note:** Browsers only allow silent clipboard writes on secure (HTTPS) connections. If you access Home Assistant over plain HTTP (e.g. `http://homeassistant.local:8123`), copying inside OpenCode shows a **"📋 Copy to clipboard"** button in the corner of the terminal instead — click it once to complete the copy. Shell drag-to-copy works without the extra click either way.

**Pasting into the terminal**

- **Ctrl+V** (or **Cmd+V** on macOS)
- **Right-click → Paste**, **Ctrl+Shift+V**, or **Shift+Insert** also work

In the Home Assistant companion apps the embedded browser is more restricted than a regular browser; if a paste shortcut does nothing there, use the right-click/long-press paste menu.

**Touch scrolling**

On phones and tablets, one-finger vertical drag gestures inside the terminal are translated to terminal scroll events so full-screen apps such as OpenCode can scroll without a separate mobile mode.

## Helper Commands

The app includes helper commands:

| Command | Description |
|---------|-------------|
| `ha-logs core` | View Home Assistant Core logs |
| `ha-logs error` | View Home Assistant error log (or Core journal logs when Supervisor disables the error-log file) |
| `ha-logs supervisor` | View Supervisor logs |
| `ha-logs host` | View host system logs |
| `ha-logs core 200` | View last 200 lines of Core logs |
| `ha-mcp enable` | Enable Home Assistant MCP integration |
| `ha-mcp disable` | Disable Home Assistant MCP integration |
| `ha-mcp status` | Check MCP integration status |
| `ha-mcp test` | Test MCP server connection |
| `hab --help` | Show hab CLI help (Home Assistant Builder) |
| `hab entity list` | List all entities via hab CLI |
| `hab area list` | List all areas via hab CLI |

## Home Assistant Builder CLI (hab)

The app includes [hab](https://github.com/balloob/home-assistant-build-cli) (Home Assistant Builder), a CLI utility designed for AI agents to manage Home Assistant configurations. It is pre-authenticated via the Supervisor token and outputs JSON by default.

### What hab Provides

`hab` covers the full admin area of Home Assistant via REST and WebSocket APIs:

| Command Group | Description |
|---------------|-------------|
| `hab entity` | List entities, get entity state |
| `hab action` | Call Home Assistant actions/services |
| `hab automation` | Create, list, get, update, delete automations |
| `hab script` | Create, list, get, update, delete scripts |
| `hab dashboard` | Manage dashboards, views, sections, cards |
| `hab area` | Create, list, delete areas |
| `hab floor` | Manage floors |
| `hab zone` | Manage zones |
| `hab label` | Manage labels |
| `hab helper` | Create and manage helper entities (input_boolean, counter, timer, etc.) |
| `hab backup` | Create and restore backups |
| `hab calendar` | Manage calendar events |
| `hab blueprint` | Manage blueprints |
| `hab system` | System info, health checks |
| `hab device` | Device management |
| `hab group` | Manage entity groups |
| `hab search` | Search for items and relationships |

### How hab Complements MCP

Both tools are available and each has strengths:

| Feature | MCP Server | hab CLI |
|---------|------------|---------|
| **Safe config writing** | Primary (validated pipeline) | N/A |
| **Anomaly detection** | Primary | N/A |
| **Entity diagnostics** | Primary | N/A |
| **Firmware updates** | Primary (real-time monitoring) | N/A |
| **Dashboard CRUD** | N/A | Primary |
| **Area/floor/zone CRUD** | Read-only | Full CRUD |
| **Helper management** | N/A | Primary |
| **Backup/restore** | N/A | Primary |
| **Blueprint management** | N/A | Primary |
| **Automation CRUD** | Via config files | Via API |

### Usage Examples

```bash
# List all light entities
hab entity list --domain light

# Get a specific entity state
hab entity get sensor.living_room_temperature

# Call an action
hab action call light.turn_on --entity light.living_room --data '{"brightness": 200}'

# Create an automation from a YAML file
hab automation create my-automation -f automation.yaml

# Create an automation with inline YAML
hab automation create my-automation <<'EOF'
alias: Motion Light
trigger:
  - platform: state
    entity_id: binary_sensor.motion
    to: "on"
action:
  - service: light.turn_on
    target:
      entity_id: light.living_room
EOF

# Human-readable output
hab entity list --text
```

Run `hab --help` or `hab <command> --help` for complete documentation.

---

## Home Assistant MCP Integration

The app includes an enhanced MCP (Model Context Protocol) server that provides deep integration between OpenCode and Home Assistant. This is a comprehensive implementation featuring **Tools**, **Resources**, **Prompts**, and an **Intelligence Layer**.

OpenCode's MCP server remains the complete working agent surface for this add-on today. Home Assistant is also developing a native `llm` integration and `<integration>/llm.py` platform so Core integrations and custom integrations can contribute curated LLM tools to Assist. OpenCode is designed to complement that work, not compete with it: as HA-native LLM capabilities become stable and accessible, this add-on will follow them closely and use them where they help users.

### Home Assistant Native LLM Readiness

The current Home Assistant native LLM work is primarily an internal platform for Home Assistant integrations and custom integrations. It lets integrations expose an `<integration>/llm.py` file with an `async_get_tools(hass, llm_context, api_id) -> llm.LLMTools | None` hook. At the time of this add-on release, that platform is not a public external API that an add-on container can register with directly.

OpenCode supports the transition now by:

- Detecting whether the running Home Assistant instance reports the native `llm` component.
- Probing native MCP endpoints such as `/api/mcp/<API ID>` when available.
- Testing an opt-in native MCP bridge first in the beta channel before stable exposure.
- Exposing this status through the `get_agent_capabilities` MCP tool and the `ha://agent/capabilities` resource.
- Providing `get_home_context` for compact area/domain/entity understanding without dumping every state.
- Providing `get_ha_llm_development_guide` for custom integration authors building native `<integration>/llm.py` providers.
- Keeping all existing MCP, LSP, `hab`, screenshot, ESPHome, update, and Zigbee functionality active while HA's native platform matures.
- Providing a strong environment for custom integration authors to edit and test future `<custom_component>/llm.py` providers.

Long-term plan:

- Use HA-native LLM tools for core Assist/entity-control capabilities when Home Assistant makes them stable and accessible.
- Keep OpenCode MCP focused on add-on-specific and power-user workflows: safe config writing, validation, filesystem-aware edits, admin/dev tasks, screenshots, firmware/update flows, and troubleshooting.
- Evaluate a companion custom integration or public API bridge if Home Assistant's native LLM platform remains integration-only and does not expose a direct add-on API.
- Keep the add-on aligned with Home Assistant's architecture decisions so users who want to test agent-focused HA features have a first-class workbench and so OpenCode can become a premium consumer of HA-native LLM capabilities as they become available.

### MCP Capabilities Overview

| Capability | Count | Description |
|------------|-------|-------------|
| **Tools** | 37 | Actions, queries, compact home context, config validation, HA-native LLM readiness, device management, screenshots, and hab CLI |
| **Resources** | 10 + 4 templates | Browsable data exposed to the AI |
| **Prompts** | 6 | Pre-built guided workflows for common tasks |
| **Intelligence** | Built-in | Anomaly detection, suggestions, semantic search |

### MCP Compatibility and Compact Responses

OpenCode's MCP server keeps compatibility handling local to this add-on. It does not patch or upstream changes to OpenCode's MCP client. Tool discovery exposes the conservative fields OpenCode consumes today, while runtime capability details are available from `get_agent_capabilities`.

For newer MCP-style structured data, tools return machine-readable JSON text with stable `summary`, `data`, and `meta` fields where that helps agents parse results. Large responses such as broad state listings, history, logbook, documentation, changelogs, CLI output, and ESPHome logs are capped and include truncation metadata so agents can filter or retry more narrowly instead of consuming unbounded output.

### Enabling MCP Integration

**Option 1: Via Configuration (Recommended)**

1. Go to the app **Configuration** tab
2. Enable **"Enable MCP Home Assistant Integration"**
3. Save and restart the app

**Option 2: Via Command Line**

Run the following command in the terminal:

```bash
ha-mcp enable
```

Then restart OpenCode (exit and run `opencode` again).

---

## MCP Tools (37 Available)

### State Management

| Tool | Description |
|------|-------------|
| `get_states` | Get entity states (all, by domain, or specific). Supports semantic summaries. |
| `search_entities` | Semantic search - find entities by natural language ("bedroom lights", "motion sensors") |
| `get_entity_details` | Deep dive into an entity including device/area relationships |
| `get_home_context` | Compact area/domain/entity-filtered context with registry-derived area and device metadata |

### Service Calls

| Tool | Description |
|------|-------------|
| `call_service` | Call any HA service (turn on lights, run scripts, set temperatures, etc.) |
| `get_services` | List available services, optionally by domain |

### History & Logging

| Tool | Description |
|------|-------------|
| `get_history` | Get historical state data for trend analysis and debugging |
| `get_logbook` | Get activity timeline showing what happened |
| `get_error_log` | Retrieve Home Assistant error log |

### Configuration & Validation

| Tool | Description |
|------|-------------|
| `get_config` | Get HA configuration (location, units, version, components) |
| `get_agent_capabilities` | Report OpenCode MCP capabilities, native `llm` readiness, native MCP endpoint status, and likely native AI provider components |
| `get_ha_llm_development_guide` | Show upstream references, checklist, and starter template for native `<integration>/llm.py` providers |
| `get_areas` | List all defined areas with IDs and names |
| `get_devices` | List devices, optionally filtered by area |
| `validate_config` | Validate configuration files before restarting |
| `write_config_safe` | **Safe config writer** — writes YAML with automatic validation, backup/restore, template checking, and deprecation scanning. See [Safe Config Writing](#safe-config-writing) below. |
| `check_config_syntax` | Analyze YAML for deprecated syntax patterns and suggest modern alternatives |

### Events & Templates

| Tool | Description |
|------|-------------|
| `fire_event` | Fire custom events to trigger automations |
| `render_template` | Render Jinja2 templates using HA's template engine |

### Calendars

| Tool | Description |
|------|-------------|
| `get_calendars` | List all calendar entities |
| `get_calendar_events` | Get events from a calendar within a time range |

### Intelligence Tools

| Tool | Description |
|------|-------------|
| `detect_anomalies` | Scan for issues: low batteries, unusual readings, open doors, etc. |
| `get_suggestions` | Get automation and optimization suggestions based on your setup |
| `diagnose_entity` | Run diagnostics on a problematic entity |

### Documentation & Breaking Changes

| Tool | Description |
|------|-------------|
| `get_integration_docs` | Fetch live documentation for any HA integration directly from home-assistant.io |
| `get_breaking_changes` | Check for breaking changes that may affect your configuration after an update |

### Update Management

| Tool | Description |
|------|-------------|
| `get_available_updates` | Check for available updates across Core, OS, Supervisor, and all apps |
| `get_addon_changelog` | View an app's changelog before updating |
| `update_component` | Start an update for Core, OS, Supervisor, or an app |
| `get_update_progress` | Monitor an in-progress update by job ID |
| `get_running_jobs` | List all active Supervisor jobs |

### ESPHome Integration

| Tool | Description |
|------|-------------|
| `esphome_list_devices` | List all ESPHome devices with their status |
| `esphome_compile` | Compile an ESPHome device configuration |
| `esphome_upload` | Upload compiled firmware to an ESPHome device |

### Firmware Updates

| Tool | Description |
|------|-------------|
| `watch_firmware_update` | Monitor or start firmware updates (ESPHome, WLED, Zigbee) with real-time progress |

### hab CLI Gateway

| Tool | Description |
|------|-------------|
| `hab_run` | Run any [hab](https://github.com/balloob/home-assistant-build-cli) CLI command as a native MCP tool. Covers dashboard CRUD, area/floor/zone management, helpers, backups, blueprints, automation CRUD via API, and more. Pass the command without the `hab` prefix (e.g., `area list`, `dashboard list`). |

### Visual Verification

| Tool | Description |
|------|-------------|
| `screenshot_url` | Take a screenshot of any Home Assistant page for visual verification. Use after making dashboard changes via hab to verify the result. Requires the `screenshot_enabled` option and a Long-Lived Access Token. Returns a PNG image that vision-capable AI models can analyze. |

---

## MCP Resources

Resources provide browsable context that the AI can access proactively:

### Static Resources

| URI | Description |
|-----|-------------|
| `ha://states/summary` | Human-readable summary of all entity states (Markdown) |
| `ha://automations` | All automations with current state and last triggered time |
| `ha://scripts` | All available scripts |
| `ha://scenes` | All defined scenes |
| `ha://areas` | All areas with entity information |
| `ha://config` | Home Assistant configuration details |
| `ha://agent/capabilities` | OpenCode MCP capability catalog and Home Assistant native LLM readiness status |
| `ha://integrations` | List of loaded integrations/components |
| `ha://anomalies` | Currently detected anomalies and issues |
| `ha://suggestions` | Current automation/optimization suggestions |

### Resource Templates

| URI Template | Description |
|--------------|-------------|
| `ha://states/{domain}` | States for a specific domain (e.g., `ha://states/light`) |
| `ha://entity/{entity_id}` | Detailed info for a specific entity |
| `ha://area/{area_id}` | All entities and devices in an area |
| `ha://history/{entity_id}` | 24-hour history for an entity |

---

## MCP Prompts (Guided Workflows)

Prompts are pre-built workflows that guide the AI through complex tasks:

### Available Prompts

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `troubleshoot_entity` | `entity_id`, `problem_description` | Guided troubleshooting - analyzes state, history, relationships, and logs |
| `create_automation` | `goal` | Step-by-step automation creation with entity discovery |
| `energy_audit` | (none) | Comprehensive energy usage analysis and optimization suggestions |
| `scene_builder` | `area`, `mood` | Interactive scene creation assistant |
| `security_review` | (none) | Security setup audit - locks, sensors, cameras, alarm systems |
| `morning_routine` | `wake_time` | Design a morning routine automation |

### Using Prompts

Simply ask OpenCode to use a prompt:

```
Help me troubleshoot my kitchen motion sensor - it's not detecting motion
```

```
Create an automation to turn off all lights at midnight
```

```
Do an energy audit of my home
```

```
Build a movie night scene for the living room
```

---

## Intelligence Layer

The MCP server includes built-in intelligence for smarter assistance:

### Anomaly Detection

Automatically detects and flags:
- **Low battery devices** (< 20%)
- **Unusual temperature readings** (outside normal ranges)
- **Humidity anomalies** (< 10% or > 95%)
- **Doors/windows open too long** (> 4 hours)
- **Lights on during daytime** (10 AM - 4 PM)
- **Unavailable/unknown entities**

### Semantic Search

Find entities using natural language:
- "bedroom lights"
- "temperature sensors"
- "front door"
- "motion detectors in the garage"

### Entity Relationships

Understands connections between:
- Entities and their parent devices
- Devices and their areas
- Related entities (same device or area)

### Automation Suggestions

Analyzes your setup and suggests:
- **Motion-activated lighting** based on motion sensors and lights in the same area
- **Security alerts** for doors/windows left open
- **Climate optimization** using thermostats and temperature sensors
- **Energy monitoring** alerts for power consumption

---

## Safe Config Writing

The `write_config_safe` MCP tool provides a complete validation pipeline when writing Home Assistant YAML configuration files. Instead of blind file writes, every change goes through multiple safety checks — including content protection against accidental data loss — with automatic rollback on failure.

### Validation Pipeline

When you (or the AI agent) write configuration through `write_config_safe`, the following steps happen automatically:

1. **Path security** — Resolves the target path and blocks writes outside the config directory (no traversal attacks, no writes to `.storage/`, `deps/`, `tts/`, etc.)
2. **Deprecation scan** — Checks the YAML content against known deprecation patterns sourced from:
   - A bundled pattern library (20+ patterns covering entity namespaces, MQTT changes, YAML config removal, etc.)
   - Remote pattern updates fetched from GitHub (cached for 1 hour)
   - Your instance's live **Repairs** issues (via the HA WebSocket API)
   - The public **HA Alerts** feed (integration-level advisories with version ranges)
3. **Structural validation** — Verifies that automations have `trigger` + `action`, scripts have `sequence`, template sensors have `state`, and other structural requirements are met
4. **Jinja2 template validation** — Extracts all `{{ }}` and `{% %}` blocks and validates them against HA's template rendering engine. Templates containing runtime-only variables (`trigger.*`, `this.*`, `context.*`, etc.) are skipped since they can't be validated outside their execution context
5. **Content protection** — Compares the new content against the existing file to prevent accidental data loss:
   - **List-entry reduction** — For `automations.yaml`, `scripts.yaml`, and `scenes.yaml`, blocks writes that would reduce the number of top-level list entries
   - **Top-level key preservation** — For mapping-based files like `configuration.yaml`, blocks writes that would remove existing top-level keys
   - **Significant size reduction** — For all files, blocks writes that would reduce the file by more than 50% by line count
   - All three checks can be bypassed with `confirm_deletions: true` for intentional removals
6. **File write with backup** — Creates a `.bak` copy of the existing file before writing the new content. The backup is retained even after a successful write as a recovery point
7. **HA Core config check** — Calls Home Assistant's configuration validation API to catch errors that static analysis can't
8. **Auto-restore on failure** — If the config check fails, the backup is automatically restored and the error is reported

### Dry Run Mode

Pass `dry_run: true` to run the full validation pipeline without actually writing the file. This is useful for checking whether proposed changes would pass validation before committing to them.

```
Check if this automation YAML is valid without saving it
```

### What Gets Reported

The tool returns a structured result with:

- **`success`** — Whether the write (or dry run) passed all checks
- **`deprecations`** — Any deprecated patterns found, with descriptions and suggested replacements
- **`structuralIssues`** — Missing required keys or structural problems
- **`templateErrors`** — Jinja2 template syntax or rendering errors
- **`configCheckResult`** — Output from HA Core's config validation
- **`backupPath`** — Path to the backup file (if a write occurred)

---

## Visual Verification (Screenshots)

The `screenshot_url` MCP tool lets the AI visually verify changes to dashboards and other HA frontend pages. After creating or modifying a dashboard view via `hab`, the AI can take a screenshot to confirm the result looks correct.

### How It Works

1. A headless Chromium browser launches inside the add-on container
2. It authenticates with the HA frontend using your Long-Lived Access Token
3. Navigates to the requested page and waits for it to render
4. Captures a PNG screenshot and returns it to the AI model
5. Vision-capable AI models (Claude, GPT-4o, Gemini, etc.) can analyze the image

### Setup

1. Go to **Settings → Add-ons → OpenCode → Configuration**
2. Enable **"Screenshot tool"**
3. Set a **Long-Lived Access Token** (create one at Profile → Long-Lived Access Tokens)
4. Restart the add-on

### Usage Examples

```
Create a new dashboard for the living room and show me what it looks like
```

```
Take a screenshot of my energy dashboard
```

```
Add a weather card to the overview and verify it looks right
```

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url_path` | (required) | HA page path (e.g., `/lovelace/0`, `/energy`, `/dashboard-name/0`) |
| `width` | `1280` | Viewport width in pixels |
| `height` | `720` | Viewport height in pixels |
| `wait_seconds` | `3` | Wait time for dynamic content to render (max 15) |
| `full_page` | `false` | Capture the full scrollable page |

### Notes

- The screenshot tool adds Chromium to the container image, increasing its size
- Each screenshot takes approximately 5-10 seconds (browser launch + page load + render wait)
- Screenshots are only taken when the AI explicitly calls the tool — no background processes
- The Long-Lived Access Token is the same one used for ESPHome tools

---

## Example Usage

### Basic Queries

```
What's the state of all lights?
```

```
Show me all temperature sensors
```

```
Find motion detectors in the house
```

### Device Control

```
Turn on the living room lights
```

```
Set the thermostat to 72 degrees
```

```
Run the goodnight script
```

### Analysis & Diagnostics

```
Are there any anomalies in my home?
```

```
What automations do you suggest for my setup?
```

```
Diagnose why the garage door sensor isn't working
```

### History & Debugging

```
Show me the temperature history for the last 24 hours
```

```
What happened in the logbook today?
```

```
Check the error log for issues
```

### Guided Workflows

```
Help me create an automation that turns on lights when I get home
```

```
Do an energy audit and suggest ways to save power
```

```
Review my security setup
```

```
Design a morning routine for 7 AM
```

---

---

## LSP Integration (Intelligent YAML Editing)

The app includes a Language Server Protocol (LSP) server that provides intelligent editing features for Home Assistant YAML configuration files. This is **enabled by default** because it only reads data and doesn't modify anything.

### What is LSP?

LSP (Language Server Protocol) is a standard that enables smart editor features like:
- Autocomplete suggestions
- Hover documentation
- Go-to-definition
- Error diagnostics

The OpenCode LSP server connects to your Home Assistant instance and provides context-aware assistance while you edit YAML files.

### LSP Features

#### Entity ID Autocomplete

When typing `entity_id:`, you get suggestions from all entities in your Home Assistant:

```yaml
automation:
  - trigger:
      - platform: state
        entity_id: # <-- Type here and get all your entities!
```

The autocomplete shows:
- Entity ID (e.g., `light.living_room`)
- Friendly name (e.g., "Living Room Light")
- Current state (e.g., "on")
- Device class if available

#### Service Autocomplete

When typing `service:` or `action:`, you get all available services:

```yaml
action:
  - service: # <-- Type here to see all services!
    target:
      entity_id: light.living_room
```

Service completions include:
- Full service name (e.g., `light.turn_on`)
- Description
- Available fields/parameters

#### Area & Device Completion

Complete area and device IDs:

```yaml
action:
  - service: light.turn_on
    target:
      area_id: # <-- Suggests all your areas
```

#### Jinja2 Template Completion

Inside `{{ }}` templates, get function completions:

```yaml
sensor:
  - platform: template
    sensors:
      living_room_temp:
        value_template: "{{ states('sensor.temperature') }}"
        #                   ^ Autocomplete Jinja functions and entities
```

Available completions:
- `states('entity_id')` - Get entity state
- `is_state('entity_id', 'state')` - Check state
- `state_attr('entity_id', 'attr')` - Get attribute
- `now()`, `today_at()`, `as_timestamp()` - Time functions
- `area_entities('area')`, `device_entities('device')` - Relationship functions

#### Hover Information

Hover over entity IDs to see detailed information:

```yaml
entity_id: sensor.living_room_temperature
#          ^ Hover here to see:
#            - Friendly name: "Living Room Temperature"
#            - State: "21.5"
#            - Unit: "°C"
#            - All attributes
```

Hover over Jinja2 templates to see the **live rendered result**:

```yaml
value_template: "{{ states('sensor.temperature') | float }}"
#               ^ Hover to see: "21.5"
```

#### Diagnostics (Warnings & Errors)

The LSP shows warnings for potential issues:

**Unknown Entity Warning:**
```yaml
entity_id: sensor.does_not_exist
#          ~~~~~~~~~~~~~~~~~~~~~~
#          ⚠ Unknown entity: sensor.does_not_exist
```

**Unknown Service Warning:**
```yaml
service: light.invalid_service
#        ~~~~~~~~~~~~~~~~~~~~~
#        ⚠ Unknown service: light.invalid_service
```

**Missing Include Error:**
```yaml
automation: !include missing_file.yaml
#                    ~~~~~~~~~~~~~~~~~
#                    ❌ Include file not found: missing_file.yaml
```

**Deprecation Warning:**
```yaml
automation:
  - trigger:
      - platform: state
        entity_id: binary_sensor.front_door
    action:
      - service: notify.mobile_app
        #~~~~~~~~
        # ⚠ Deprecated: "service" is deprecated, use "action" instead (since 2024.x)
```

Deprecation patterns are loaded from a bundled pattern library and refreshed from GitHub in the background. Warnings appear as yellow squigglies in the editor as you type.

#### Go-to-Definition

Click on `!include` references to jump to the included file:

```yaml
automation: !include automations.yaml
#                    ~~~~~~~~~~~~~~~~
#                    Ctrl+Click to open automations.yaml
```

Also works with `!secret`:
```yaml
api_key: !secret api_key
#               ~~~~~~~~
#               Ctrl+Click to open secrets.yaml
```

### Trigger & Condition Completion

When editing automations, get completions for:

**Trigger Platforms:**
```yaml
trigger:
  - platform: # state, numeric_state, time, sun, zone, mqtt, webhook...
```

**Condition Types:**
```yaml
condition:
  - condition: # state, numeric_state, time, sun, zone, template, and, or, not...
```

**Action Keys:**
```yaml
action:
  - service:     # Service to call
    target:      # Target entities/areas/devices
    data:        # Service parameters
  - delay:       # Delay before next action
  - wait_template: # Wait for condition
  - choose:      # Conditional branching
  - repeat:      # Repeat actions
```

### Configuration

LSP is enabled by default. To disable it:

1. Go to the app **Configuration** tab
2. Set **"Enable LSP Home Assistant Integration"** to `false`
3. Restart the app

### Technical Notes

- The LSP server caches entity/service data for 60 seconds for performance
- Cache is automatically refreshed when stale
- Works even without Home Assistant connection (limited features)
- YAML syntax validation is always available

---

## Working Directory

OpenCode starts in the `/homeassistant` directory, which is your Home Assistant configuration folder. This includes:

- `configuration.yaml`
- `automations.yaml`
- `scripts.yaml`
- `scenes.yaml`
- Custom components in `custom_components/`
- And all other configuration files

When add-on folder guidance is enabled, the terminal also highlights `/addons` and `/addon_configs` for Home Assistant add-on development. These folders are mounted into the container for development access. Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

## Customizing AI Instructions (AGENTS.md)

The app creates an `AGENTS.md` file in your Home Assistant config directory (`/homeassistant/AGENTS.md`) on first install. This file contains instructions that guide how OpenCode behaves when working with your Home Assistant setup.

### Default Instructions Include:

- **User consent rules** - The AI won't make changes without your explicit approval
- **Home Assistant knowledge** - File structure, YAML syntax, automation patterns
- **Safety guidelines** - Protection for secrets, backup reminders, validation checks
- **MCP awareness** - How to use MCP tools when available

### Customizing the Instructions

You can edit `AGENTS.md` to add your own rules or context:

1. Open **File Editor** (or VS Code Server app)
2. Navigate to `/config/AGENTS.md`
3. Add your customizations

**Example additions:**

```markdown
## My Home Setup

- I use Zigbee2MQTT for all Zigbee devices
- My house has 3 floors: basement, main, upstairs
- Prefer MQTT automations over native HA automations
- Always use packages for new configuration

## Coding Preferences

- Use descriptive entity_id names with room prefix
- Add comments explaining automation logic
- Prefer template sensors over Node-RED
```

### Resetting to Default

If you want to restore the default `AGENTS.md`:

1. Delete or rename the existing file
2. Restart the app
3. A fresh default will be created

## Tips

### Validating Configuration

After making changes, you can ask OpenCode to validate your configuration:

```
Check if my configuration is valid
```

With MCP enabled, OpenCode calls the validation API directly and reports any errors.

For a more thorough check, ask OpenCode to use the safe config writer which runs the full validation pipeline (deprecation scan, structural checks, template validation, and HA Core config check):

```
Write this automation to automations.yaml using safe config writing
```

```
Dry-run validate my configuration.yaml without saving
```

See [Safe Config Writing](#safe-config-writing) for full details on the validation pipeline.

### Viewing Logs

If something isn't working, check the logs:

```
Show me the recent error logs
```

Or use the helper command:

```bash
ha-logs error
```

On Supervisor-based installations, the file-backed error log is unavailable. In that case, `ha-logs error` and the `get_error_log` MCP tool automatically return recent Core journal logs instead.

### Git Integration

OpenCode works well with git. If you version control your configuration:

```
Show me what files have changed
```

```
Commit my changes with a descriptive message
```

### Using Semantic Summaries

Instead of raw JSON data, ask for summaries:

```
Give me a summary of all entity states
```

This returns a human-readable overview organized by domain, including any detected anomalies.

## Data Storage

Your OpenCode sessions and API credentials are stored in `/data/` within the app. This data:

- **Is backed up** when you create a Home Assistant backup
- **Persists** across app restarts and updates
- **Is private** to your Home Assistant instance

## Security Notes

- This app has access to your Home Assistant configuration files (read/write)
- This app mounts `/addons` and `/addon_configs` for add-on development access. `/addon_configs` may contain sensitive data from other add-ons.
- This app can view system logs (Core, Supervisor, Host)
- When MCP is enabled, OpenCode can query entities and call services
- Access is protected by Home Assistant authentication via ingress
- Only users with access to the OpenCode panel can use this app

## Troubleshooting

### OpenCode won't start

Check if you have enough memory. If the terminal shows `Killed`, check host logs for the Linux OOM killer:

```bash
ha-logs host 300 | grep -i "out of memory\|oom\|opencode"
```

OpenCode can use significant memory on larger Home Assistant installations. This add-on disables OpenCode snapshots by default and ignores noisy internal paths to reduce memory pressure, but systems with limited RAM or full swap may still need more available memory. On 4 GB systems, make sure **OpenCode update policy** is set to `bundled` (the default) so the add-on does not run a memory-heavy update at start-up.

### Can't connect to AI provider

1. Make sure you have internet access
2. Run `/connect` again to re-authenticate
3. Check that your API key or subscription is valid

### Terminal not loading

1. Try refreshing the page
2. Clear your browser cache
3. Check the app logs in the Home Assistant Supervisor

### Copy/paste not working

1. See the [Copy and Paste](#copy-and-paste) section for the supported shortcuts
2. On plain HTTP connections, copying inside OpenCode requires clicking the "📋 Copy to clipboard" button that appears — browsers forbid silent clipboard writes without HTTPS
3. To copy from full-screen apps that capture the mouse, hold **Shift** while dragging (**Option** on macOS)
4. The companion apps' embedded browser is more restricted than a regular browser — if shortcuts fail there, open Home Assistant in a normal browser

### MCP not working

1. Make sure MCP is enabled: `ha-mcp status`
2. Restart OpenCode after enabling MCP
3. Test the connection: `ha-mcp test`
4. Check that the app has API access (it should by default)

### Entity not found in MCP queries

1. Verify the entity exists in Home Assistant
2. Check the exact entity_id spelling
3. Use `search_entities` to find entities by name

### Changes not taking effect

After modifying configuration files, you may need to:

1. Validate: **Developer Tools** > **YAML** > **Check Configuration**
2. Reload: **Developer Tools** > **YAML** > **Reload** the relevant domain
3. Or restart Home Assistant for major changes

## Support

- [OpenCode Documentation](https://opencode.ai/docs)
- [OpenCode Discord](https://opencode.ai/discord)
- [GitHub Issues](https://github.com/magnusoverli/opencode/issues)

## License

This app is released into the public domain under the Unlicense.
