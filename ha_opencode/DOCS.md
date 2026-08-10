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
- **Home Context**: Sessions start knowing your installation — a generated briefing of your setup, your own instructions in `AGENTS.local.md`, and lasting decisions you have approved
- **Home Assistant Native LLM Readiness**: Detects HA's emerging native `llm` component and documents how OpenCode will adopt HA-native agent capabilities as they become available
- **Focus-friendly responses (Beta)**: Optional action-first, concise, progress-aware response guidance
- **Visual Verification**: Screenshot tool for verifying dashboard changes with AI vision
- **LSP Integration**: Intelligent YAML editing with entity autocomplete, hover info, and diagnostics
- **PPQ Private TEE Models (Beta)**: Optional encrypted proxy for PPQ private models running in remote TEEs. Included in stable releases, but still considered beta.
- **Serial Device Access**: Optionally map selected host serial devices into the add-on for USB flashing and adapter inspection workflows
- **Optional LAN Server Mode**: Attach from another computer on your local network using the OpenCode CLI
- **Startup Hooks**: Optional persistent shell scripts that run at add-on startup

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
- LAN access remains the separate opt-in **OpenCode LAN server** feature on port `4096`.

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
| **MCP integration** | `true` | Let OpenCode query entities and call services through its built-in Model Context Protocol server. |
| **MCP tool profile** | `full` | Select `compact` for read-only diagnostics, `configuration` to add documentation, validation, and safe config writes, or `full` for every tool. Smaller profiles reduce tool-selection ambiguity and prompt size for local models. |
| **LSP integration** | `true` | Give OpenCode live diagnostics, entity and service auto-completion, and validation while it edits Home Assistant YAML. |
| **Screenshot tool** | `false` | Requires the access token below. Lets OpenCode photograph Home Assistant pages in a headless browser to check dashboard changes. |
| **Home Assistant access token** | `""` | Long-lived access token for Home Assistant Core. Required by the screenshot tool and ESPHome commands. |
| **Native Home Assistant MCP bridge (beta)** | `false` | Adds an optional second MCP server for Home Assistant's native LLM MCP endpoint. Needs the MCP Server integration set up in Home Assistant; the keyed endpoints and native LLM tool platforms ship in Home Assistant 2026.8. |
| **Native MCP API ID** | `assist` | Applies only when the native bridge is on. The default `assist` targets `/api/mcp/assist`; leave empty to use the configured `/api/mcp` endpoint. |
| **Install briefing** | `true` | Give OpenCode a generated summary of your installation — version, areas, entity counts, configuration layout — so it does not rediscover them each session. See [Home Context](#home-context). |
| **Decision notes** | `true` | Let OpenCode carry lasting decisions between sessions, recorded only when you approve each one. See [Decision notes](#decision-notes). |

### Access Control

| Option | Default | Description |
|--------|---------|-------------|
| **Restrict access to sensitive files** | `true` | Deny OpenCode read access to secret and credential files so their contents cannot reach the model. See [Sensitive File Protection](#sensitive-file-protection). |
| **Add-on folder guidance** | `false` | Show guidance for working in the mounted `/addons` and `/addon_configs` folders. This is guidance only, not a filesystem permission boundary. |

### Focus-Friendly Responses (Beta)

Turn on **Focus-friendly responses (beta)** in the add-on **Configuration** tab to ask OpenCode for action-first, concise, progress-aware replies. This changes response wording only; it does not change permissions or safety confirmations.

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
| **CPU mode** | `auto` | Controls which OpenCode binary is used. `auto` detects your CPU capabilities automatically (recommended). `baseline` selects the build intended for older CPUs without AVX2; `regular` forces the standard build. See [CPU requirements](#cpu-requirements) — OpenCode needs SSE4.2 in every mode, and upstream currently ships the same binary in both packages, so `baseline` does not presently rescue a CPU without AVX2. |

### Network Exposure

| Option | Default | Description |
|--------|---------|-------------|
| **OpenCode LAN server** | `false` | Start an OpenCode server on internal port `4096` for clients on your local network. Map `4096/tcp` in the add-on Network settings. |
| **LAN server CORS origins** | `[]` | Exact browser origins allowed to call the LAN server directly. `opencode attach` does not need this. |
| **OpenChamber LAN web UI** | `false` | Publish OpenChamber on internal port `4097` at the root path. Only works with `interface_mode: openchamber`; map `4097/tcp` to reach it. |

### Model Providers

| Option | Default | Description |
|--------|---------|-------------|
| **PPQ private TEE models (beta)** | `false` | Start the internal PPQ private-mode encryption proxy. Requires **PPQ API key**. |
| **PPQ API key** | `""` | API key for PPQ private-mode models. Stored as a masked add-on option. |

### Optional Hardware

| Option | Default | Description |
|--------|---------|-------------|
| **Zigbee2MQTT URL** | `""` | Address of your Zigbee2MQTT frontend. Only needed when the Zigbee2MQTT add-on is not discovered automatically. |
| **Zigbee2MQTT base topic** | `zigbee2mqtt` | MQTT base topic that Zigbee2MQTT publishes on. |
| **Serial devices** | `[]` | Optional list of host UART/serial devices to map into the add-on. Use this for workflows that need direct serial access, such as local USB flashing or adapter inspection. See [Serial Devices](#serial-devices). |

### Advanced Options

| Option | Default | Description |
|--------|---------|-------------|
| **Environment variables** | `[]` | Define extra environment variables for OpenCode and the terminal shell. Critical system variables cannot be overridden. |
| **Custom OpenCode configuration** | `""` | A JSON object merged into OpenCode's configuration. See [OpenCode config docs](https://opencode.ai/docs/config) for the full schema. |
| **Startup hooks** | `false` | Run your own `.sh` scripts from the add-on's persistent `startup.d` folder. See [Startup Hooks](#startup-hooks). |

### Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode configuration** if you need OpenCode's built-in snapshot/undo behavior.

On low-memory hosts — for example a 4 GB Home Assistant Green running several other add-ons — keep **OpenCode update policy** on `bundled` (the default) so the add-on does no memory-heavy start-up install, and expect the agent itself to be memory-hungry during large tasks. 8 GB or more is recommended for comfortable use alongside other memory-heavy add-ons such as Matter Server, Music Assistant, and Whisper/Piper.

### Local Models (Ollama and similar)

Local models work, but the add-on sends a large system prompt on every request, and that cost lands entirely on your own hardware. Budget for it before choosing a model.

Every request carries roughly:

| Included on every request | Approximate size |
|---------------------------|------------------|
| OpenCode's agent prompt and built-in tools | varies by version |
| Home Assistant MCP tool definitions (41 tools) | ~25 KB |
| `AGENTS.md` from your configuration folder | ~35 KB |
| MCP core/profile guidance | compact and profile-specific |
| Install briefing | capped at ~500 tokens |
| `AGENTS.local.md`, if you use one | your own content |

In practice that is on the order of **25,000 tokens before you type anything**. A hosted provider absorbs this in a second or two. A local model on a Raspberry Pi or similar has to evaluate all of it on CPU first, so a one-word prompt can take minutes. This is prompt evaluation, not add-on overhead — comparing against a bare `curl` to your model will not reproduce it, because that request is a few hundred bytes.

To make local models usable:

- **Set the context window to fit.** Ollama defaults `num_ctx` to 4096. A 25,000-token prompt is silently truncated at that size, so the model loses most of its tools and instructions before it sees your message. Raise it (`OLLAMA_CONTEXT_LENGTH`, or `num_ctx` in the model's parameters) and expect higher memory use.
- **Turn off MCP integration** to remove the 41 tool definitions. This is the single largest saving, but OpenCode then loses the ability to query entities and call services — it becomes a file editor for your YAML rather than a Home Assistant agent.
- **Turn off Install briefing** for a smaller saving.
- **Choose a smaller MCP tool profile.** `compact` is a read-only diagnostic surface; `configuration` adds the safe configuration workflow without device control or admin commands. The default `full` profile preserves every existing capability. Profile changes take effect after restarting the add-on.
- **Use a model that supports tool calling**, and a large one. Small models (roughly under 7B) generally cannot drive a 41-tool agent loop reliably regardless of how fast they run — a common symptom is the model replying with a raw JSON envelope instead of normal text.
- **Do not run the model on the Home Assistant host** if you can avoid it. Inference competing with Home Assistant for CPU and RAM makes both worse.

If you want to shrink the prompt further, you can edit `/homeassistant/AGENTS.md` directly — the add-on keeps a file you have modified rather than overwriting it. The trade-off is that you stop receiving updates to those instructions. See [Resetting AGENTS.md to default](#resetting-agentsmd-to-default).

### OpenCode Updates

By default, **OpenCode update policy** is set to `bundled`: the add-on uses the OpenCode version shipped in its image and does no start-up install. This is the lowest-memory option and is recommended for systems with 4 GB RAM or limited free memory.

Set **OpenCode update policy** to `latest` to follow upstream OpenCode releases independently of add-on releases. The add-on starts immediately on the bundled (or an existing healthy persistent) binary, then refreshes `opencode-ai@latest` into `/data/.npm-global` **in the background**; the newer version becomes active for the next OpenCode session. The background update never blocks start-up, and it is skipped automatically when available memory is below ~1.5 GB so the install cannot push a low-memory host into swap-thrash. If an update is interrupted or produces a binary that will not run, the add-on discards it and keeps using the known-good bundled copy.

For x64 systems without visible AVX2 support, OpenCode selects its baseline binary. If this add-on runs in a VM on an AVX2-capable host, enable host CPU passthrough; generic QEMU/KVM CPU models can hide AVX2 and force the baseline binary unnecessarily. There is a known upstream baseline OOM issue tracked at `anomalyco/opencode#20988`.

#### CPU requirements

OpenCode is distributed as a Bun-compiled binary, so Bun's CPU floor is OpenCode's: an x64 processor must support **SSE4.2** — the x86-64-v2 level, meaning Intel Nehalem (2008) or newer, or AMD Bulldozer (2011) / Jaguar (2013) or newer. Below that line every published OpenCode binary exits immediately with `Illegal instruction (core dumped)`, and no add-on setting changes it. The add-on checks for SSE4.2 at start-up and states the reason in its log rather than leaving you with a bare crash. ARM64 (aarch64) is unaffected.

Above that floor there are two x64 builds. The regular build additionally requires **AVX2** (Intel Haswell, 2013, or newer); when AVX2 is not visible the add-on automatically selects OpenCode's *baseline* build. Two things to know about that fallback:

- **Upstream currently publishes the regular AVX2 binary inside the baseline package** ([anomalyco/opencode#33595](https://github.com/anomalyco/opencode/issues/33595)). For the OpenCode versions currently shipped, `opencode-linux-x64-baseline` and `opencode-linux-x64` are byte-identical, so baseline mode does not currently help a CPU that lacks AVX2. This is an upstream packaging problem the add-on cannot work around; the **CPU mode** option is kept because it starts working again the moment upstream publishes a genuine baseline build.
- If the add-on runs in a VM on an AVX2-capable host, enable host CPU passthrough — generic QEMU/KVM CPU models hide AVX2 and force baseline mode unnecessarily.

There is also a known upstream baseline OOM issue tracked at [anomalyco/opencode#20988](https://github.com/anomalyco/opencode/issues/20988).

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

### Startup Hooks

Startup hooks are the supported way to add your own script, bridge, or small service without editing the container. Turn on **Startup hooks** in the Configuration tab and restart the add-on. It creates an `startup.d` folder in this add-on's directory under your Home Assistant configuration folder, with a README and inert example; run `ha-hooks list` in the terminal to see its exact path.

Every `.sh` file in that folder runs as root, in filename order, each time the add-on starts. Keep a number prefix such as `10-` or `20-`; rename a file so it no longer ends in `.sh` to disable it. The add-on runs hooks but does not validate, supervise, or restart anything they start.

Use `ha-hooks list` to inspect hooks and their previous status, `ha-hooks run [name]` to test one without restarting, and `ha-hooks log [name]` to view output. A hook must return and is stopped after 15 minutes by default; use `# opencode-hook-timeout: <seconds>` in its first ten lines to change that, or `0` for no limit. Start an intended long-running process with `setsid`, redirect it to its own log, and guard it so a re-run does not start a second copy.

```sh
if pgrep -f "/data/mybridge/server.py" >/dev/null 2>&1; then exit 0; fi
setsid /data/venvs/mybridge/bin/python3 -u /data/mybridge/server.py \
    >/data/mybridge.log 2>&1 </dev/null &
```

Keep persistent dependencies and payload files under `/data`, not inside the container. A hook can reach Home Assistant through `http://supervisor/core` with its existing `SUPERVISOR_TOKEN`. It can reach OpenCode at `http://127.0.0.1:4096` when **OpenCode LAN server** is enabled; the port need not be mapped to the LAN for a hook to use it.

Security matters: hooks run with the add-on's credentials, including the Supervisor token and configured environment variables. Do not use `set -x`, review hook logs before sharing them, and leave the option off unless you intentionally want scripts in your configuration directory to execute. Hook logs are private to the add-on and excluded from backups. Turn **Startup hooks** off and restart to disable every hook if something goes wrong.

### Serial Devices

Serial access is disabled by default. To enable it, add one or more host serial devices to the `serial_devices` option in the add-on Configuration tab, then restart the add-on. Home Assistant Supervisor validates those paths and maps only the selected devices into the container.

OpenCode and terminal commands can then use paths such as `/dev/ttyUSB0`, `/dev/ttyACM0`, or stable `/dev/serial/by-id/...` paths when they are provided by the host. The selected paths are also exported as `OPENCODE_SERIAL_DEVICES` using `:` as the separator.

The Supervisor `uart` and `udev` manifest flags remain disabled by default. They are static add-on manifest permissions rather than regular user options, so they cannot be toggled from the add-on Configuration tab.

### LAN Server Mode

LAN server mode lets you attach to the Home Assistant-hosted OpenCode session from a terminal outside the Home Assistant UI.

To enable LAN access:

1. In the add-on **Configuration** tab, turn on **OpenCode LAN server**.
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

LAN server sessions have no terminal prompt to answer an `ask` permission. To prevent an HTTP client from leaving a write tool call running forever, the add-on denies unmatched `edit: ask` rules in this mode only. The terminal and Ingress UI keep their normal confirmation prompts.

For a write-capable custom agent, grant only the directory it needs and deny the rest. OpenCode evaluates edit rules relative to `/homeassistant`; the add-on also accepts the documented absolute form and translates it for LAN sessions.

```yaml
permission:
  edit:
    "*": deny
    "docs/**": allow
```

The equivalent `"/homeassistant/docs/**": allow` works in LAN server mode after an add-on restart. An explicit `edit: allow` remains fully write-capable. The rule is applied when the server starts, so restart the add-on after adding or changing a custom agent file.

#### Connecting a browser-based client (CORS)

`opencode attach` and other non-browser clients work without extra configuration. Browser-based clients that call the LAN server directly are subject to the browser's CORS policy. Without an allowed origin, a client may list providers and models but fail when sending chat messages or opening the event stream.

To allow a browser client:

1. Find the exact origin it uses, including scheme, host, and port, but no path.
2. Add that value under **LAN server CORS origins** in the add-on **Configuration** tab.
3. Save and restart the add-on.

For example: `http://192.168.1.20:8080`.

### OpenChamber LAN Web UI

By default the OpenChamber web UI (`interface_mode: openchamber`) is served **only** through Home Assistant Ingress at `/api/hassio_ingress/<token>/`. That is the recommended path because Home Assistant provides the authentication layer.

If you instead want a clean root URL for a reverse proxy or tunnel — for example so `https://openchamber.example.com/` maps straight to a backend without an ingress-path redirect — enable the OpenChamber LAN web UI. It publishes OpenChamber on a mappable network port and serves it at the root path `/`.

To enable it:

1. Set **Interface mode** to `openchamber`.
2. Turn on **OpenChamber LAN web UI**.
3. In the add-on **Network** settings, map `4097/tcp` to the host port you want to use.
4. Save and restart the add-on.

Then open the UI at:

```text
http://<home-assistant-host>:<mapped-host-port>/
```

Behind a Cloudflare Tunnel, point a public hostname straight at it (no redirect rule needed because it already serves at `/`):

```yaml
additional_hosts:
  - hostname: openchamber.example.com
    service: http://<home-assistant-host>:<mapped-host-port>
```

How it works:

- A second instance of the OpenChamber ingress proxy binds to `0.0.0.0:4097` and forwards to the same OpenChamber process on `127.0.0.1:3010`.
- Because the mapped port has no Home Assistant Ingress session, the proxy runs with `OPENCHAMBER_ALLOW_ANY_REMOTE=true` and serves the UI with an empty ingress path (root `/`).
- The default Ingress instance on `8099` is unchanged and keeps its strict `127.0.0.1` / Supervisor-only allowlist.

Security warning: there is **no Home Assistant login** in front of the mapped `4097/tcp` port. Anyone who can reach it can use OpenChamber, which has read/write access to your configuration. Only map it on trusted networks, and put it behind a reverse proxy, Cloudflare Access, or equivalent authentication before any remote exposure. Never expose the raw port directly to the internet.

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
| `ha-context status` | Show which context files OpenCode is given and what they cost |
| `ha-context show` | Print every context file OpenCode receives, with a note on what each may contain |
| `ha-context briefing` | Print the generated install briefing only |
| `ha-context notes` | Print your decision notes file only |
| `ha-context refresh` | Regenerate the install briefing and decision-notes digest now |
| `ha-context reset` | Delete the generated context files (rebuilt on refresh or restart) |
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

### MCP Tool Profiles

The built-in `homeassistant` MCP server can expose a narrower capability set through **MCP tool profile**. This changes the tool definitions supplied to the model and rejects hidden MCP calls before they reach Home Assistant; it does not alter filesystem access, terminal commands, or OpenCode permissions.

| Profile | Includes | Excludes |
|---------|----------|----------|
| `compact` | Read-only entity state, history, diagnostics, templates, calendars, and home context | Config writes, device control, updates, screenshots, `hab`, and Zigbee administration |
| `configuration` | Everything in `compact`, plus current docs, syntax checks, full validation, safe config writes, and decision notes | Device control, updates, screenshots, `hab`, and Zigbee administration |
| `full` | Every currently available built-in MCP tool | Nothing beyond separately disabled features such as screenshots without a token |

`full` is the default and preserves existing behavior. Restart the add-on after changing profiles. `get_agent_capabilities` reports the active profile, exposed tool count, and omitted count so an agent can explain what it can actually do.

### Home Assistant Native LLM Readiness

The current Home Assistant native LLM work is primarily an internal platform for Home Assistant integrations and custom integrations. It lets integrations expose an `<integration>/llm.py` file with an `async_get_tools(hass, llm_context, api_id) -> llm.LLMTools | None` hook. At the time of this add-on release, that platform is not a public external API that an add-on container can register with directly.

OpenCode supports the transition now by:

- Detecting whether the running Home Assistant instance reports the native `llm` component.
- Probing native MCP endpoints such as `/api/mcp/<API ID>` when available.
- Providing an opt-in native MCP bridge that remains explicitly marked beta while Home Assistant's API matures.
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

### Native Home Assistant MCP Bridge (Beta)

Home Assistant has a native `llm` integration and native MCP endpoints for registered LLM APIs: every registered LLM API is exposed at `/api/mcp/<API ID>` once Home Assistant's MCP Server integration is set up. The built-in Assist API uses the API ID `assist`.

**Which Home Assistant version you need:** the `llm` integration, the per-domain LLM tool platforms, and the keyed `/api/mcp/<API ID>` endpoints all first ship in **Home Assistant 2026.8**. On 2026.7.x and earlier, Home Assistant serves only the configured `/api/mcp` endpoint and the legacy `/mcp_server/sse` transport. In every case the **MCP Server** integration must be added in Home Assistant first — the endpoints are not served otherwise.

When **Native Home Assistant MCP bridge (beta)** is enabled, the add-on adds a second OpenCode MCP server named `homeassistant_native` that forwards requests to Home Assistant Core's native MCP endpoint through the Supervisor proxy. **Native MCP API ID** defaults to `assist`, which targets `/api/mcp/assist`; leave it empty to use the configured `/api/mcp` endpoint instead.

#### What you have to do

The bridge is **off by default**, and Home Assistant does not serve its MCP endpoints until you set the integration up. Two one-time steps, in this order:

1. **Add the Model Context Protocol Server integration in Home Assistant.** Go to **Settings → Devices & Services → Add Integration** and add **Model Context Protocol Server**. Until this exists, Home Assistant registers no `/api/mcp` routes at all and the bridge has nothing to talk to on any version.
2. **Turn on the bridge in the add-on and restart it.** Set **Native Home Assistant MCP bridge (beta)** to on in the add-on's Configuration tab, then restart the add-on. The setting is read once at start-up, so it does not take effect until the restart.

To confirm it worked, ask OpenCode to run `get_agent_capabilities`: it reports the detected Home Assistant version, bridge status, which endpoint resolved, and any upstream limitations that still apply. Use `homeassistant_native` only when the bridge status is `enabled_and_reachable`; a reachable endpoint with a disabled bridge is not exposed to OpenCode. In OpenCode you should then see a second MCP server named `homeassistant_native` alongside the built-in `homeassistant` one.

Nothing else is required. You do **not** need to change the API ID, set any environment variable, or supply an access token — the bridge authenticates with the Supervisor token. If you skip step 1, the bridge starts and every request fails with a 404, which `get_agent_capabilities` will report.

Once it is on, the bridge handles Home Assistant versions by itself and needs no further attention when you upgrade — including across the 2026.8 boundary, which it picks up without a restart.

#### Access model

`/api/mcp` serves **every** LLM API selected in the MCP Server integration — that setting is a multi-select — and needs no admin access. `/api/mcp/<API ID>` narrows to one registered LLM API and requires admin access for every ID except the built-in Assist API.

That admin requirement is not a wall for this add-on. The Supervisor calls Home Assistant Core as its own system user, which Home Assistant creates in the admin group, so **any registered API ID is reachable from here** — which is what makes testing a custom LLM API from your own integration practical. If the bridge reports an unknown API ID, the ID does not exist; it is not an access failure.

#### How the bridge adapts

- **Endpoint fallback.** If the keyed `/api/mcp/<API ID>` endpoint is not served — which is the case before 2026.8 — the bridge falls back to the configured `/api/mcp` endpoint and logs the reason once. It retries the keyed endpoint periodically, so upgrading Home Assistant to 2026.8 under a running add-on is picked up without a restart. If Home Assistant instead reports that the API ID is unknown, the bridge surfaces that error rather than silently serving a different API. Set `HA_NATIVE_MCP_ENDPOINT_MODE` to `keyed` or `configured` in **Environment variables** to pin one endpoint instead.
- **Tool schema repair.** Before Home Assistant 2026.8, tools whose parameters use validators such as `cv.string` produced a schema that strict MCP clients cannot compile; calls then failed with `extra keys not allowed @ data['__unparsedToolInput']`, which affected `GetLiveContext` in particular ([home-assistant/core#176762](https://github.com/home-assistant/core/issues/176762), fixed by [#176814](https://github.com/home-assistant/core/pull/176814)). The bridge repairs these schemas as they pass through. Set `HA_NATIVE_MCP_SANITIZE_SCHEMAS` to `0` to see the raw upstream schemas.
- **Malformed-message guard.** Every message is validated as JSON-RPC 2.0 before it is forwarded, because malformed POSTs to `/api/mcp` have been reported to crash Home Assistant Core ([home-assistant/core#176734](https://github.com/home-assistant/core/issues/176734)). This one is **not fixed in 2026.8** — the upstream fix is still open — so the guard applies on every version.

The regular `homeassistant` MCP server remains available and is the supported tool surface either way. The two are intentionally separate: `homeassistant_native` carries Home Assistant's curated native LLM tools, while `homeassistant` covers configuration editing, validation, admin and development workflows, screenshots, and updates.

### Model Tool Evaluation

`ha-agent-eval` is an opt-in developer command for comparing a real model's tool selection against fixed synthetic Home Assistant scenarios. It calls an OpenAI-compatible chat-completions endpoint, supplies mocked tool results, and never contacts Home Assistant or executes a real tool.

Set these environment variables, preferably through the add-on's **Environment variables** option:

```text
HA_AGENT_EVAL_BASE_URL=https://provider.example/v1
HA_AGENT_EVAL_MODEL=provider-model-id
HA_AGENT_EVAL_API_KEY=optional-for-local-or-tokenless-providers
```

Run `ha-agent-eval` to evaluate scenarios supported by the active MCP profile, or select one explicitly:

```bash
ha-agent-eval --profile compact
ha-agent-eval --scenario safe-configuration-validation
```

The command writes a JSON transcript and pass/fail score under `/data/evaluations/`, excluded from add-on backups, and exits non-zero when a scenario fails. It measures model function-calling behavior, not OpenCode's full prompt, provider configuration, or live Home Assistant integration.

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
2. Enable **"MCP integration"**
3. Save and restart the app

**Option 2: Via Command Line**

Run the following command in the terminal:

```bash
ha-mcp enable
```

Then restart OpenCode (exit and run `opencode` again).

---

## MCP Tools (41 Available)

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

### Decision Notes

| Tool | Description |
|------|-------------|
| `remember_decision` | Record a lasting decision or constraint about your setup so future sessions honor it. Only writes after you explicitly approve. Requires the `decision_notes_enabled` option. |
| `recall_decisions` | Read the full notes, including the rationale and superseded history that the session digest leaves out |
| `supersede_decision` | Retire notes that no longer apply. They stay in the file for the record but stop reaching new sessions. |

### CLI Gateways

| Tool | Description |
|------|-------------|
| `hab_run` | Run any [hab](https://github.com/balloob/home-assistant-build-cli) CLI command as a native MCP tool. Covers dashboard CRUD, area/floor/zone management, helpers, backups, blueprints, automation CRUD via API, and more. Pass the command without the `hab` prefix (e.g., `area list`, `dashboard list`). |
| `zigporter_run` | Run any zigporter CLI command as a native MCP tool. Covers Zigbee cascade renames, device inspection, stale-device cleanup, and mesh mapping. Pass the command without the `zigporter` prefix (e.g., `list-devices --json`). |

### Visual Verification

| Tool | Description |
|------|-------------|
| `screenshot_url` | Take a screenshot of any Home Assistant page for visual verification. Use after making dashboard changes via hab to verify the result. Requires the `screenshot_enabled` option and a Long-Lived Access Token, and a model that accepts image input — see [Visual Verification](#visual-verification-screenshots). |

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
4. Captures a PNG screenshot and returns it as an image part in the tool result
5. Only a model that accepts image input can actually see it — see below

Nothing is written to disk. The screenshot exists only inside that tool result; there is no file to open in the Home Assistant UI afterwards.

### Model requirements

**A screenshot is only useful if the model you have selected accepts image input.** This is a property of the model itself, not an add-on setting — no option here can give a text-only model sight.

Support is far from universal, and it does not follow price or recency: several of the fastest and cheapest models in common use are text-only, while most general-purpose flagship models accept images. Line-ups change often enough that any list printed here would be out of date within a release or two, so check the model you actually use:

- **[models.dev](https://models.dev)** is the catalogue OpenCode takes its model metadata from. Find your provider and model there; the entry states which input types it accepts.
- Otherwise, just try it. A model that cannot see the picture is told so explicitly, and will normally reply that it is unable to read images.

When a text-only model calls the tool, OpenCode replaces the image with a short notice saying the model cannot read it, so the model is told what happened rather than left to guess. If a reply describes your dashboard anyway, or claims the screenshot was saved somewhere, that reply is not based on the picture — switch to a model that accepts image input and try again.

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
- Each screenshot takes approximately 5-10 seconds (browser launch + page load + render wait), and longer on slower hardware such as a Raspberry Pi; the tool is allowed up to 60 seconds before it is timed out
- The tool is only offered to the model when **Screenshot tool** is enabled *and* a Long-Lived Access Token is set — with either missing it is not advertised at all
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
2. Set **"LSP integration"** to `false`
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

## Home Context

Every session starts with OpenCode knowing something about *your* installation, so it does not have to rediscover it from scratch each time. That context comes from four files, and you can read all of them.

| File | What it is | Who writes it |
|------|-----------|---------------|
| `/config/AGENTS.md` | The add-on's own instructions: consent rules, Home Assistant knowledge, YAML style | The add-on. Refreshed on update. |
| `/config/AGENTS.local.md` | **Your** standing instructions | You. The add-on never touches it. |
| Install briefing | A generated summary of your setup | The add-on, rebuilt on every start |
| Decision notes | Lasting decisions you have approved | OpenCode, only when you say yes |

Run `ha-context show` in the terminal to see exactly what is being sent, and `ha-context status` for a summary of what each file costs.

### Your own instructions (AGENTS.local.md)

To give OpenCode standing instructions of your own, create `/config/AGENTS.local.md`. It is loaded at the start of every session alongside the add-on's own instructions.

A commented example is placed at `/config/AGENTS.local.md.example` on first install — rename it (drop the `.example`) and edit.

```markdown
## About my setup

- All Zigbee devices go through Zigbee2MQTT, not ZHA
- The house has 3 floors: basement, main, upstairs
- New configuration goes in packages/, one file per feature

## How I want you to work

- Name entities <area>_<device>_<function>
- Always show me the diff before writing, even for one-line changes

## Leave these alone

- Anything under custom_components/ — those are managed through HACS
```

Things worth knowing:

- **Add-on updates never overwrite it.** This is the supported place for your customizations.
- **Delete the file to stop loading it.** There is no setting to turn it off.
- **`AGENTS.md` wins on conflict.** Safety rules and approval requirements stay in force.
- **It is sent with every request,** so keep it short and specific. Standing preferences are useful; a diary is not.
- **Never put secrets in it.** Reference them with `!secret` instead.

> **Editing `AGENTS.md` itself:** you can, but prefer `AGENTS.local.md`. The add-on refreshes `AGENTS.md` on update to keep its safety and syntax guidance current, and it only skips that refresh when it can see the file is unmodified. If you do edit it, your version is kept and you stop receiving instruction updates.
>
> **One exception, on the first start after updating to 2.3.8.** Before this version the add-on did not record what it had written, so an edited `AGENTS.md` and an untouched one are indistinguishable on that single boot. It therefore refreshes the file once and saves your previous copy alongside it as `AGENTS.md.bak` (an existing `.bak` is never overwritten). If you had customised it, move those rules into `AGENTS.local.md` — from then on your edits are detected and left alone.

### Install briefing

**Option: Install briefing** (default on)

At every start, the add-on writes a short summary of your installation and gives it to OpenCode:

- Home Assistant version, installation type, hardware, time zone, and unit system
- How your configuration is split up — `!include` layout, whether `packages/` is in use, and whether `automations.yaml` is managed by the UI editor
- Your areas and floors, by name
- Entity counts per domain (counts, not a dump of every entity)
- Integrations in use, device stacks (ZHA, Z-Wave JS, ESPHome, Zigbee2MQTT…), and any custom components
- Which add-on capabilities are actually switched on

This is why OpenCode can answer "which areas do I have?" without a round trip, and why it stops guessing at entity or area names.

Two properties keep it honest:

- **It cannot grow.** The briefing is rebuilt from scratch on every start and capped at roughly 500 tokens. It is not a log, and nothing accumulates in it.
- **It cannot leak.** It is generated by the add-on, not by the AI. Latitude, longitude, `secrets.yaml` contents, and access tokens are never included — the add-on reads what it needs and discards it. It contains **no individual entity names or states**, only counts per domain.
- **It says what it left out.** On a large installation not everything fits in 500 tokens. When a section has to be trimmed or omitted, the briefing names what is missing and tells OpenCode to read it from Home Assistant instead — so a gap in the briefing is never mistaken for something your installation does not have.

If Home Assistant Core is still starting when the add-on comes up, the briefing is written from your configuration files alone and enriched a few moments later. It says so plainly while that is the case, and it waits for Core to finish starting before taking its snapshot, so entity counts are not captured half-loaded.

### Decision notes

**Option: Decision notes** (default on)

Configuration files record *what* your setup does. They cannot record *why* — that an integration was removed on purpose, that a toggle is inverted deliberately, that some corner should be left alone. That reasoning is what gets lost between sessions, and re-explaining it is the tax this feature removes.

**Nothing is recorded unless you approve it.** OpenCode proposes a note, shows you the exact wording, and writes only after you agree. This matches how the rest of the add-on works — it does not change files behind your back, and this is a file.

Notes live in `/config/opencode/decisions.yaml` as plain YAML:

```yaml
version: 1
notes:
  - id: 2026-07-26-node-red-automations-are-off-limits
    date: 2026-07-26
    title: Node-RED automations are off limits
    decision: Do not migrate or edit the Node-RED flows.
    rationale: They are maintained outside Home Assistant and would be overwritten.
    integrations:
      - nodered
    status: active
```

You own that file: read it in File Editor, edit it, or delete it. It is included in your Home Assistant backups and diffs cleanly if you keep `/config` under version control.

**On context cost.** Each *active* note reaches the model as a single line — its date, title, decision, and any entities, files or integrations you attached to it. The rationale and any retired notes stay in the file and are fetched on demand. (If you see an entity name in `ha-context show` that you did not expect, this is where it comes from: the install briefing contains no entity names at all.) The injected digest is capped at roughly 500 tokens, and up to 40 active notes are stored. When a decision is replaced, the old note is marked superseded rather than deleted: it disappears from the session digest but stays in the file. That is how the cost stays flat instead of creeping up as notes accumulate.

**When there are more notes than fit.** The two limits above are different limits, and the digest one arrives first: depending on how long your notes are, somewhere between about four and eleven of them fit in 500 tokens. Nothing is lost when that happens — the rest stay in the file and in force, and OpenCode reads them with `recall_decisions`. The digest always states how many notes it is showing out of the total, so OpenCode is never left to assume the list is complete.

To keep a specific note in the digest regardless, pin it — add `pin: true` to it in the file, or ask OpenCode to pin it when it proposes the note:

```yaml
  - id: 2026-07-26-zwave-stick-not-to-be-re-added
    date: 2026-07-26
    title: The old Z-Wave stick was removed on purpose
    decision: Do not re-add the Z-Wave integration; the stick was retired.
    pin: true
    status: active
```

Pinned notes lead the digest and are the last to be dropped. Up to 10 can be pinned. Use it for the decisions where being forgotten would cause real damage — without a pin, the oldest notes are the first to fall out, and those are often the ones everyone has stopped thinking about.

**On safety.** Notes that contain a password, token, or any value found in your `secrets.yaml` are rejected outright. A note is sent to the model in every future session, so credentials have no business being in one.

To manage them from the terminal:

```bash
ha-context notes          # print the file
ha-context reset          # clear the generated context (notes are kept)
ha-context reset --notes --yes   # also delete your notes
```

### Turning it off

Both features are on by default and switch off independently in the **Configuration** tab. With **Install briefing** off, no briefing is generated or sent. With **Decision notes** off, the recording tools are not offered to the AI at all and no digest is sent; your existing `decisions.yaml` is left untouched.

### Resetting AGENTS.md to default

1. Delete or rename `/config/AGENTS.md`
2. Restart the app
3. A fresh default is created

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

Home context is split between the two locations on purpose:

| Location | Contents | Notes |
|----------|----------|-------|
| `/data/context/` | The generated install briefing and decision-notes digest | Rebuilt from scratch on every start, so editing them has no effect |
| `/config/AGENTS.local.md` | Your own instructions | Yours; never written by the add-on |
| `/config/opencode/decisions.yaml` | Your decision notes | Yours; included in Home Assistant config backups |

Nothing generated by the add-on leaves your Home Assistant instance except as part of the prompt sent to the AI provider you configured — which is exactly what the context is for. Run `ha-context show` to read it first.

## Security Notes

- This app has access to your Home Assistant configuration files (read/write)
- This app mounts `/addons` and `/addon_configs` for add-on development access. `/addon_configs` may contain sensitive data from other add-ons.
- This app can view system logs (Core, Supervisor, Host)
- When MCP is enabled, OpenCode can query entities and call services
- The generated home context never includes `secrets.yaml` contents, access tokens, or your latitude and longitude, and decision notes containing a credential are rejected. Run `ha-context show` to read exactly what is sent.
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

### Responses are very slow with a local model

Almost always prompt evaluation, not a fault. The add-on sends roughly 25,000 tokens of tools and instructions on every request, and your hardware has to process all of it before generating the first token. See [Local Models](#local-models-ollama-and-similar) for how to reduce it. Check your model server's context-window setting first — if the prompt is being truncated, quality suffers as well as speed.

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
