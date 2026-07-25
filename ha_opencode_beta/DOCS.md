# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

**You can install this alongside the stable OpenCode add-on.** Both will appear in the sidebar (as "OpenCode" and "OpenCode Beta") and operate independently.

## Upstream Attribution

This independent Home Assistant add-on redistributes and integrates
[OpenCode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, under the
MIT License. It is not made by, affiliated with, or endorsed by the OpenCode
team or Anomaly. The complete OpenCode notice is included in the add-on image
at `/usr/share/doc/ha-opencode/NOTICE` and in this repository's
[`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md).

## Current Beta Changes

- **OpenChamber interface mode**: New experimental `openchamber` interface mode starts the OpenChamber web UI behind Home Assistant Ingress, while the default `terminal` mode keeps the existing ttyd terminal unchanged.
- **Native Home Assistant MCP bridge**: Optional bridge from OpenCode to Home Assistant Core's native LLM MCP endpoint (`/api/mcp/<API ID>`, default `assist`) for testing the new native LLM/MCP platform when the running Home Assistant version supports it.
- **Compact Home Assistant context**: New `get_home_context` MCP tool gives agents focused area/domain/entity context with area and device metadata instead of broad state dumps.
- **Native LLM provider development guide**: New `get_ha_llm_development_guide` MCP tool helps custom integration authors build `<integration>/llm.py` tool providers aligned with Home Assistant's upstream architecture.
- **Serial device access**: Selected host UART/serial devices can be mapped into the add-on for USB flashing and adapter inspection workflows. Full Supervisor `uart` and `udev` manifest flags remain disabled by default because they are static permissions, not runtime user options.
- **Optional LAN server mode**: You can now enable an OpenCode server bound to `0.0.0.0` so other computers on your local network can connect directly.
- **Optional OpenChamber LAN web UI**: When using `interface_mode: openchamber`, you can optionally publish OpenChamber on a mapped LAN port (`4097/tcp`) at the root path `/` for reverse proxies and tunnels.
- **LAN server CORS origins**: The LAN server can now allow-list specific browser origins (`--cors`), so browser-based OpenCode clients — not just the CLI — can connect to it directly. See [LAN Server Mode (Beta)](#lan-server-mode-beta) below.
- **PPQ private TEE models**: Opt-in encrypted proxy for PPQ private models running in remote TEEs. The proxy is internal-only and binds to `127.0.0.1` inside the add-on container.
- **Web terminal clipboard fixes**: Copying inside OpenCode now reaches the browser clipboard, plain `Ctrl+V` paste works, and macOS users can use `Option+drag` to select text while full-screen terminal apps capture the mouse.
- **Touch scrolling**: One-finger vertical drag gestures inside the terminal now scroll full-screen apps such as OpenCode on phones and tablets.
- **OpenCode update policy**: Use only the image-bundled OpenCode (`bundled`, default, lowest memory use) or keep OpenCode updated to the newest release in the background (`latest`, skipped automatically on low-memory systems).
- **Sensitive file protection**: New **Restrict access to sensitive files** option (default on) denies the AI read access to `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, and `*.key`/`*.pem` files so their contents can't reach the model. Set it to `false` to restore fully unrestricted file access. See [Sensitive File Protection](#sensitive-file-protection).
- **Focus-friendly responses**: Optional action-first, concise, progress-aware response guidance for users who find long or unstructured responses difficult to act on. Disabled by default and available in both terminal and OpenChamber modes.
- **Browser provider sign-in in OpenChamber**: Providers whose browser OAuth method redirects to a loopback address (for example **ChatGPT Pro/Plus (browser)**) can now be connected from the OpenChamber UI. See [Connecting a provider with browser sign-in](#connecting-a-provider-with-browser-sign-in).

## Focus-Friendly Response Mode (Beta)

Turn on **Focus-friendly responses (beta)** in the add-on **Configuration** tab and restart the add-on. The mode shapes OpenCode responses to lead with the next action or result, number multi-step work, show progress, keep ordinary lists short, and end with one concrete next step.

This is an output-formatting preference, not a medical feature. It does not diagnose ADHD, create a health profile, change model access, grant permissions, or bypass confirmations. Home Assistant safety requirements remain in effect: proposed changes, validation results, backups, destructive-action warnings, and explicit approval are still required. Ask for an explanation or walkthrough when you want more detail.

## Add-on Folder Access

OpenCode mounts `/addons` and `/addon_configs` for Home Assistant add-on development access. Turn on **Add-on folder guidance** in the add-on configuration and restart to show these paths in the terminal. This option updates guidance, but the mounts are static add-on metadata and are not a hard filesystem permission boundary.

Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

## Sensitive File Protection

By default (**Restrict access to sensitive files** = `true`), the add-on adds an OpenCode `permission.read` rule that blocks the AI's file-**read** tool from opening secret/credential files — `secrets.yaml` (any path ending in `secrets.yaml`), the `.storage/` and `.cloud/` directories, the `ssl/` directory, and any `*.key`/`*.pem` files — so their contents can't be pulled into the model's context. Everything else stays readable, and the agent can still edit normal config that *references* secrets via `!secret`. The Home Assistant MCP tools are unaffected; they read live state through the API.

**To restore the previous, fully-permissive behavior,** set **Restrict access to sensitive files** to `false` and restart. You can also fine-tune paths via **Custom OpenCode configuration** using OpenCode's [permission rules](https://opencode.ai/docs/permissions/).

**Scope/limitation:** this guards OpenCode's file-read tool (the common accidental-exposure path). It does **not** restrict shell commands, so an explicit `cat secrets.yaml` can still read the file — treat it as a strong guardrail, not a hard sandbox.

## Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode configuration** if you need OpenCode's built-in snapshot/undo behavior.

On low-memory hosts — for example a 4 GB Home Assistant Green running several other add-ons — keep **OpenCode update policy** on `bundled` (the default) so the add-on does no memory-heavy start-up install. 8 GB or more is recommended for comfortable use alongside other memory-heavy add-ons such as Matter Server, Music Assistant, and Whisper/Piper.

## OpenCode Updates

By default, **OpenCode update policy** is set to `bundled`: the add-on uses the OpenCode version shipped in its image and does no start-up install — the lowest-memory option, recommended for systems with 4 GB RAM or limited free memory.

Set the policy to `latest` to follow upstream OpenCode releases. The add-on starts immediately on the bundled (or an existing healthy persistent) binary, then refreshes `opencode-ai@latest` into `/data/.npm-global` **in the background**; the newer version becomes active for the next OpenCode session. The background update never blocks start-up and is skipped automatically when available memory is below ~1.5 GB. An interrupted or non-working update is discarded so the add-on keeps using the known-good bundled copy.

For x64 VM installs, make sure the guest can see AVX2 when the host supports it. Generic QEMU/KVM CPU models can hide AVX2 and force OpenCode's baseline binary.

## Native Home Assistant MCP Bridge (Beta)

Home Assistant is adding a native `llm` integration and native MCP endpoints for registered LLM APIs. PR [home-assistant/developers.home-assistant#3236](https://github.com/home-assistant/developers.home-assistant/pull/3236) documents the contract: every registered LLM API is exposed at `/api/mcp/<API ID>` once Home Assistant's MCP Server integration is set up. The built-in Assist API uses the API ID `assist`.

When **Native Home Assistant MCP bridge (beta)** is on, the add-on adds a second OpenCode MCP server named `homeassistant_native` that forwards requests to the configured Home Assistant Core native endpoint through the Supervisor proxy. **Native MCP API ID** defaults to `assist`, which targets `/api/mcp/assist`. Set it to a custom API ID to test `/api/mcp/<your API ID>` for custom APIs registered inside Home Assistant. Leave it empty to target Home Assistant's configured `/api/mcp` endpoint instead.

Access model from Home Assistant Core: `/api/mcp` serves the API selected in the MCP Server integration and does not require admin access. `/api/mcp/<API ID>` selects a specific registered LLM API by ID and requires admin access except for the built-in Assist API.

Use this only with a Home Assistant version that includes the native keyed MCP endpoint. If the endpoint is not available yet, `get_agent_capabilities` will report the current status and OpenCode's regular `homeassistant` MCP server remains the supported tool surface.

The two MCP servers are intentionally separate:

- `homeassistant_native`: Home Assistant's curated native LLM API tools from the configured `/api/mcp/<API ID>` endpoint when available.
- `homeassistant`: OpenCode's add-on tools for configuration editing, validation, diagnostics, screenshots, updates, ESPHome, Zigbee, add-on development, and documentation lookup.

## Interface Mode (Beta)

The beta add-on can show either the existing terminal interface or the experimental OpenChamber web UI in the Home Assistant sidebar.

Modes:

- `terminal`: default. Uses the existing ttyd terminal and tmux session.
- `openchamber`: starts OpenChamber behind Home Assistant Ingress on the same sidebar entry.

To test OpenChamber:

1. In the add-on **Configuration** tab, set **Interface mode** to `openchamber`.
2. Save and restart the add-on.
3. Open **OpenCode Beta** from the Home Assistant sidebar.

Security and networking notes:

- OpenChamber is not exposed through a Home Assistant Network port by default.
- The OpenChamber process binds to `127.0.0.1` inside the container.
- A small first-party ingress proxy binds to internal port `8099`, accepts Home Assistant Ingress traffic, and forwards to OpenChamber locally.
- Home Assistant Ingress provides the browser authentication layer, so no separate OpenChamber UI password is configured for this mode.
- LAN access remains the separate opt-in **OpenCode LAN server** feature on port `4096`.

Known beta risk: OpenChamber is a root-hosted web app, so this beta includes a pinned bundle patch for Home Assistant's `/api/hassio_ingress/...` path. If the page loads but actions fail, switch **Interface mode** back to `terminal`, restart the add-on, and include logs when reporting the issue.

OpenChamber's own built-in update check is disabled in this add-on. OpenChamber is pinned and patched for Home Assistant Ingress when the add-on image is built, so an in-app self-update cannot persist or stay patched and would only hang the UI. OpenChamber is updated by updating the add-on — no "update available" prompt appears inside OpenChamber, and the Update button in **Settings → OpenChamber → About** reports no update.

### Connecting a provider with browser sign-in

Some providers offer a **browser** sign-in method (for example **ChatGPT Pro/Plus (browser)**) that sends you back to `http://localhost:<port>/auth/callback` after you sign in. That address is the add-on container, not the computer you are browsing from, so the final redirect always fails to load with a connection error. That is expected and does not mean the sign-in failed.

In **Settings → Providers**, copy the whole `http://localhost:...` URL from your browser's address bar, paste it into the **Paste authorization code** field, and select **Complete** — the add-on delivers it to OpenCode locally so the sign-in finishes. Pasting only the `code=` value from that URL works too. In `terminal` mode, use the provider's **headless** method instead, which shows a short code to enter on the provider's device-authorization page and needs no redirect at all.

## Zigbee2MQTT URL

The add-on discovers a running Zigbee2MQTT add-on automatically, so **Zigbee2MQTT URL** is only needed as a manual override. Set it to the same address and port you open the Zigbee2MQTT UI on, including the scheme — for example `http://192.168.1.20:8080`. Host/IP-only values are accepted and treated as `http://`.

## LAN Server Mode (Beta)

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

## OpenChamber LAN Web UI (Beta)

By default the OpenChamber web UI (`interface_mode: openchamber`) is served **only** through Home Assistant Ingress at `/api/hassio_ingress/<token>/`. That is the recommended path because Home Assistant provides the authentication layer.

If you instead want a clean root URL for a reverse proxy or tunnel — for example so `https://openchamber.example.com/` maps straight to a backend without an ingress-path redirect/rewrite — enable the OpenChamber LAN web UI. It publishes OpenChamber on a mappable network port and serves it at the root path `/`.

To enable it:

1. Set **Interface mode** to `openchamber`.
2. Set **Enable OpenChamber LAN web UI** to `true`.
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

### Connecting a browser-based client (CORS)

`opencode attach` and other non-browser clients work out of the box with the steps above. Browser-based clients that call the LAN server directly — for example the [OpenChamber VS Code Extension](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber)'s `openchamber.apiUrl` setting, or any other web/VS Code UI pointed at this server instead of its own local instance — are subject to the browser's CORS policy. Without an allowed origin, this can look like a partial connection: the client may still list providers/models, but sending a chat message or opening the event stream silently gets no response.

To fix this:

1. In the client, find the exact origin it's making requests from (scheme + host + port, no path). Your browser's developer tools Network tab will show this as the `Origin` request header, or as the URL of the page/webview hosting the client.
2. In the add-on **Configuration** tab, add that origin under **LAN server CORS origins**, for example `http://192.168.1.20:8080`.
3. Save and restart the add-on.

This option only adds `--cors <origin>` flags to the OpenCode server; it does not change anything else about LAN server mode, and leaving it empty preserves the existing `opencode attach` behavior exactly.

## PPQ Private TEE Models (Beta)

PPQ private mode routes OpenCode requests through a local encryption proxy before forwarding them to PPQ's private inference API. The proxy verifies the remote enclave, encrypts the request locally, and decrypts the response locally.

To enable PPQ private models:

1. Get a PPQ API key from PPQ.
2. In the add-on **Configuration** tab, turn on **PPQ private TEE models (beta)**.
3. Paste the key into **PPQ API Key**. Alternatively, set `PPQ_API_KEY` through **Environment Variables** if you manage credentials that way.
4. Save and restart the add-on.
5. In OpenCode, select the `PPQ Private (TEE)` provider and one of the `private/...` models.

Security notes:

- The proxy binds only to `127.0.0.1:8787` inside the add-on container.
- No Home Assistant network port is exposed for PPQ private mode.
- The PPQ API key is not logged.
- The proxy package is pinned at image build time; the add-on does not run `npx latest` at startup.

Bundled model IDs come from the pinned `ppq-private-mode` package version: `private/kimi-k2-5`, `private/deepseek-r1-0528`, `private/gpt-oss-120b`, `private/llama3-3-70b`, and `private/qwen3-vl-30b`.

## Reporting Issues

If you encounter problems with the beta, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the add-on logs (Settings > Add-ons > OpenCode Beta > Log) in your report.
