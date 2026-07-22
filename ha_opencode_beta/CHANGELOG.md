# Changelog

## 2.3.6b5

- **Quieter add-on log** — ttyd logged every accepted HTTP connection at libwebsockets NOTICE level, so the container health check (which probes `http://127.0.0.1:8099/` every 30 seconds) produced a repeating three-line burst (`__lws_lc_tag` / `HTTP /` / `__lws_lc_untag`) — roughly 4,300 lines a day of noise that buried real messages. ttyd now runs at log level `ERR|WARN` (`-d 3`), so genuine errors and warnings still surface while the per-probe chatter is gone.

## 2.3.6b4

- **Terminal now fits the Home Assistant iframe ([issue #56](https://github.com/magnusoverli/opencode/issues/56))** — the ingress terminal kept its initial oversized dimensions and overflowed on the right and top (for example, `Ctrl+P`'s "Session" header sat above the visible area), and toggling the HA sidebar did not reflow it. ttyd 1.7.7 re-fits the terminal only from a window `resize` event, but Home Assistant resizes the add-on iframe from its own JavaScript without ever firing one. A small injected browser-side script now watches the viewport with a `ResizeObserver` and calls ttyd's `window.term.fit()` on the iframe-driven size changes that `resize` misses, so the terminal reflows to the available space on load and when the sidebar toggles. Thanks to [@fmjensen](https://github.com/fmjensen) for the detailed report and root-cause analysis.

## 2.3.6b3

- **Supervisor-safe Home Assistant logs ([issue #57](https://github.com/magnusoverli/opencode/issues/57))** — `ha-logs error` and the MCP `get_error_log` tool returned a 404 on Home Assistant instances running under Supervisor, which disables the file-backed `/api/error_log` endpoint in favor of journald. Both now fall back to Core's journal logs when the file-backed endpoint is unavailable. Thanks to [@GuiPoM](https://github.com/GuiPoM) for reporting it.
- **Home Assistant configuration directory no longer prompts every session** — OpenCode now persistently allows the mounted `/homeassistant` configuration directory, so normal configuration work no longer asks for external-directory permission on every session. Sensitive-file read protection (**Restrict access to sensitive files**) remains in effect regardless.

## 2.3.6b2

- **Optional focus-friendly response mode** — added a disabled-by-default **Focus-friendly response mode** option that applies action-first, numbered, progress-aware response guidance to both the terminal and OpenChamber interfaces. It changes response formatting only and preserves Home Assistant approval, validation, and safety requirements. Inspired by [@ayghri's `i-have-adhd`](https://github.com/ayghri/i-have-adhd); thanks to Ayoub Ghriss for publishing the upstream skill.

## 2.3.6b1

- **OpenChamber updated to 1.16.2** — bumped the pinned `@openchamber/web` from 1.14.0 to the latest 1.16.2, and reworked the Home Assistant Ingress bundle patcher (`patch-ingress.js`) so it no longer breaks on OpenChamber's minified-name drift. The four required patches (runtime URL builder, API URL builder, API path classifier, service-worker) now match the bundle structurally and reuse the captured minifier names instead of hardcoding them, so the patch is validated to apply cleanly across 1.14.x through 1.16.2 and is more resilient to future version bumps. The bundle still binds to `127.0.0.1` behind the first-party ingress proxy as before.

## 2.3.6b0

- **Stop OpenChamber's built-in updater from hanging the UI** — OpenChamber ships a self-update check ("update available", plus an Update button in Settings → About), but OpenChamber is pinned and patched for Home Assistant Ingress at image build time, so an in-app update cannot persist across restarts or stay Ingress-patched — it just hung the UI on "Waiting for server...". The add-on now points OpenChamber's update-check API (`OPENCHAMBER_UPDATE_API_URL`) at a local canned "no update" endpoint served by the ingress proxy, so the update notification no longer appears and the update action reports "No update available" instead of hanging. OpenChamber is updated by updating the add-on.

## 2.3.5b1

- **OpenCode attribution and license notices** - added a clear upstream credit, MIT notice, non-affiliation statement, and in-image notice for the OpenCode software distributed by this add-on.
- **Hardened file access: sensitive files are read-protected by default (#53)** — a new **Restrict access to sensitive files** option (default on) adds an OpenCode `permission.read` deny rule for `secrets.yaml`, the `.storage/` and `.cloud/` directories, the `ssl/` directory, and `*.key`/`*.pem` files, so their contents cannot be read into the model's context. Everything else stays readable and normal `!secret`-based config editing is unaffected. Set the option to `false` to restore the previous fully-permissive behavior. Note: this guards OpenCode's file-read tool, not shell commands. Thanks @ChristopherBull for the suggestion.
- **Fixed PPQ Private (TEE) proxy failing to start (#34)** — the `ppq-private-proxy` service resolved its entrypoint with `npm root -g` *after* sourcing `NPM_CONFIG_PREFIX=/data/.npm-global`, so it looked for `ppq-private-mode` in the persistent OpenCode prefix instead of the image's global modules and crashed with `ERR_MODULE_NOT_FOUND`. The lookup is now isolated from that override, and a missing package logs a clear error instead of a raw Node stack trace. The PPQ provider's models also carry explicit `id` fields now so OpenCode addresses them correctly. Thanks to @iBobik for diagnosing and fixing this.

## 2.3.5b0

- **Fixed the low-memory start-up crash loop (issue #51)** — on 4 GB devices (for example a Home Assistant Green) the boot-time `npm install -g opencode-ai@latest` could exhaust RAM, make Supervisor unresponsive, and leave the add-on in a watchdog crash loop (repeated exit code 137). Two changes remove this. The default **OpenCode update policy** is now `bundled`, so a fresh install runs entirely on the OpenCode shipped in the image with no start-up download. When you opt into `latest`, the ingress terminal now comes up immediately on the bundled (or an existing healthy persistent) binary while the update runs in a detached background process — off the health-check critical path — that is skipped automatically when free memory is below ~1.5 GB, so the npm spike can no longer push a low-memory host into swap-thrash. An interrupted or non-working update is now discarded instead of shadowing the working bundled binary, which also fixes the related `/data/.npm-global/bin/opencode: cannot execute: required file not found` failure.

## 2.3.4b1

- **Native Home Assistant MCP readiness and bridge** — `get_agent_capabilities` now probes Home Assistant Core's native MCP endpoints, including the configured `/api/mcp` or `/api/mcp/<API ID>` endpoint and `/api/mcp/assist`, and reports whether OpenCode should use regular MCP only or a hybrid native-LLM-API/OpenCode-MCP mode. Added opt-in beta options for **Enable native Home Assistant MCP bridge** and **Native Home Assistant MCP API ID**. The bridge creates a second OpenCode MCP server (`homeassistant_native`) proxying to Home Assistant's native MCP endpoint when the running Home Assistant version supports it. The API ID defaults to `assist`, can target custom APIs registered inside Home Assistant, and can be left empty to target the configured `/api/mcp` endpoint. The bridge is disabled by default and does not replace OpenCode's built-in MCP tools.
- **Better Home Assistant context and native LLM development support** — added `get_home_context` for compact area/domain/entity-scoped understanding with registry-derived area/device metadata, plus `get_ha_llm_development_guide` for upstream references, checklist, and a starter template for native `<integration>/llm.py` tool providers.

## 2.3.4b0

- **LAN server CORS support** — added a **LAN server CORS origins** option that passes one or more `--cors <origin>` flags to `opencode serve`. Browser-based clients that connect to the LAN server directly (rather than the OpenCode CLI) are blocked by the browser's same-origin policy without this: for example, the OpenChamber VS Code Extension's `openchamber.apiUrl` pointed at this add-on's LAN server could list providers/models (fetched outside the browser) but never received chat responses, because the message-send and event-stream requests are made from a browser webview and were silently blocked. `opencode serve` has no environment-variable equivalent for `--cors`, so this could not be worked around with the existing **Environment variables** option. The new option is empty by default and changes nothing for `opencode attach` or other non-browser clients. Fixes [#44](https://github.com/magnusoverli/opencode/issues/44).

## 2.3.2b1

- **Fix OpenChamber 1.14.0 Vite preload assets under ingress** — patch the newer Vite modulepreload helper that rewrote `assets/...` dependency entries back to root `/assets/...`, causing 404s and stylesheet MIME errors in Home Assistant Ingress.

## 2.3.2b0

- **OpenChamber updated to 1.14.0** — bumped the pinned `@openchamber/web` package and carried forward the Home Assistant ingress patching. Upstream 1.14.0 no longer emits the older Vite preload asset helper, so the patcher now treats that helper as optional while still enforcing the API path, API URL, runtime URL, service worker, and root asset rewrites.
- **Configuration UI polish** — options are now grouped and ordered the way they render in the Configuration tab (interface first, then appearance, Home Assistant integration, runtime, integrations, privacy/network, advanced). Labels follow Home Assistant's sentence-case convention with parallel naming for toggles, descriptions use one consistent style for quoting and punctuation, and stable/beta wording drift was eliminated. Also adds the missing `.env_vars_discovered` backup exclusion on the beta channel.

## 2.3.0b8

- **OpenChamber updated to 1.13.9** — bumped the pinned `@openchamber/web` version. All five Home Assistant ingress patches are still required and carry forward unchanged in effect; upstream 1.13.9 does not fix any of the ingress issues this add-on patches around. Verified end-to-end against an emulated Supervisor ingress with a headless browser: no URL re-prefixing, no `text/html` API responses, clean bootstrap.
- **Ingress patch resilience** — the API URL builder patch now matches the minified statement structurally and reuses the captured helper names instead of hardcoding them (`qo`/`Jo` in 1.13.8 became `mn`/`Sn` in 1.13.9). Minifier-assigned names drift between upstream releases; this removes one recurring source of build breakage on future version bumps.
- **Upstream font change** — OpenChamber 1.13.9 no longer bundles self-hosted IBM Plex webfonts, so the UI falls back to the system font stack. Cosmetic upstream change, not an add-on regression; it also removes the font-404 class of ingress bug entirely.

## 2.3.0b7

- **Fix OpenChamber API calls resolving to HTML under ingress** — patch the app's API path classifier so URLs already carrying the `/api/hassio_ingress/...` base are not prefixed again. The ingress base itself starts with `/api/`, so every client fetch layer re-detected already-prefixed URLs as API paths and stacked additional prefixes; requests then reached OpenChamber with a residual ingress prefix, fell onto its `/api` → OpenCode proxy mount, and OpenCode answered with its web UI HTML. This fixes "Request is not supported by this version of OpenCode Server (Server responded with text/html)" during bootstrap and the failures loading sessions, providers, agents, commands, git status, and the filesystem home directory.
- **Fix IBM Plex font 404s under ingress** — rewrite CSS font URLs to same-directory references instead of `assets/...`-relative ones. URLs inside a stylesheet resolve against the stylesheet's own location (`.../assets/`), so the previous rewrite produced `/assets/assets/...` requests that 404'd.

## 2.3.0b6

- **Fix OpenChamber persistent install bypassing ingress patches** — always launch the bundled image OpenChamber binary patched at build time, even when the add-on's `latest` OpenCode update policy puts `/data/.npm-global/bin` first on `PATH`. This prevents an older persistent `@openchamber/web` install from serving root `/assets/...` URLs under Home Assistant ingress.
- **Harden OpenChamber ingress cache cleanup** — rewrite root asset URLs in proxied HTML/CSS/JS responses, serve a no-op unregistering service worker under ingress, and send no-store headers for rewritten OpenChamber app resources.

## 2.3.0b5

- **Fix remaining OpenChamber ingress API and font routing** — patch CSS font URLs so IBM Plex fonts load through Home Assistant ingress, and add a runtime fetch guard that keeps root `/api`, `/auth`, and `/health` requests under `/api/hassio_ingress/...` before OpenChamber initializes.

## 2.3.0b4

- **Fix OpenChamber dynamic asset loading under ingress** — patch OpenChamber's Vite preload helper and remaining worker/icon asset literals so dynamically loaded CSS, chunks, and workers stay under Home Assistant's `/api/hassio_ingress/...` path instead of requesting `/assets/...` from the HA root.

## 2.3.0b3

- **Fix empty OpenChamber ingress response** — request identity encoding from the upstream OpenChamber server and decode/strip compression headers when rewriting HTML, preventing Home Assistant from receiving an empty `content-encoding: deflate` page.

## 2.3.0b2

- **Fix OpenChamber under stripped Home Assistant ingress paths** — load the ingress runtime through a relative external script, derive `/api/hassio_ingress/...` in the browser instead of relying on proxy headers, and inject the ingress `<base>` tag before OpenChamber modules/CSS resolve.

## 2.3.0b1

- **Fix OpenChamber ingress blank page** — serve the Home Assistant ingress runtime as an external same-origin script instead of injecting inline JavaScript, add an ingress-aware `<base>` tag at proxy time, and keep OpenChamber asset/API paths under `/api/hassio_ingress/...` for CSP-compatible loading.

## 2.3.0b0

- **Experimental OpenChamber interface mode** — added a beta-only `interface_mode` option. The default `terminal` mode keeps the existing ttyd/tmux sidebar terminal unchanged; `openchamber` starts the pinned `@openchamber/web` UI behind Home Assistant Ingress.
- **Ingress-safe OpenChamber runtime** — OpenChamber binds only to `127.0.0.1` inside the container, with a first-party ingress proxy on internal port `8099` forwarding authenticated Home Assistant Ingress traffic. No OpenChamber LAN port is exposed by default.
- **Pinned bundle adaptation** — patches the pinned OpenChamber web bundle at image build time so root-hosted assets, API calls, SSE, and websockets resolve under Home Assistant's `/api/hassio_ingress/...` path.

## 2.1.1b1

- **Terminal and runtime hardening** — `SUPERVISOR_TOKEN` is no longer persisted as `HA_TOKEN` in `/data/.env_vars`, OpenCode uses an app-managed executable temp directory for native TUI files, and the web terminal now translates one-finger touch drags into scroll events for mobile/tablet use.

## 2.1.1b0

- **OpenCode runtime update policy** — added a `latest`/`bundled` update policy. By default the add-on installs `opencode-ai@latest` into persistent add-on data and uses that before the bundled fallback, while `bundled` disables OpenCode self-update and uses the image version only. Baseline CPU mode now logs VM CPU passthrough guidance and the known upstream baseline OOM issue.

## 2.0.3b7

- **Web terminal clipboard fixes** — copying inside OpenCode now reaches the browser clipboard via OSC 52 support through tmux and a custom ttyd page, with a one-click fallback on plain HTTP. Plain `Ctrl+V` paste now works, and macOS users can use `Option+drag` to select text while full-screen terminal apps capture the mouse.

## 2.0.3b6

- **Lower MCP server memory** — `puppeteer-core` is now loaded on first screenshot use instead of at startup, saving ~28 MB of resident memory per MCP server process when the screenshot tool is unused (the default).

## 2.0.3b5

- **Native ARM64 builds** — the aarch64 image now builds on GitHub's native `ubuntu-24.04-arm` runners instead of QEMU emulation, cutting ARM build times from ~20 minutes to roughly amd64 speed. The QEMU setup step is removed from the build workflows.
- **Cross-platform hab build stage** — the hab CLI builder stage is pinned to the build platform and cross-compiles via `GOARCH`, so it runs natively regardless of target architecture.
- No add-on functionality changes.

## 2.0.3b4

- **Node 24-ready CI** — all GitHub Actions in the build and release workflows bumped to Node 24 runtimes (checkout v6, docker setup-qemu/setup-buildx/login v4, build-push v7, action-gh-release v3) ahead of GitHub's enforced runtime switch on June 16, 2026. No add-on functionality changes — the image is rebuilt from the same source as 2.0.3b3.

## 2.0.3b3

Performance release — startup, MCP tool, and YAML LSP latency.

- **Faster startup** — Zigbee2MQTT/ESPHome discovery now runs in the background instead of blocking boot, AGENTS.md help injection only re-runs after add-on updates, the baseline OpenCode binary ships in the image (amd64), and user env vars are processed in a single pass.
- **Faster MCP tools** — timeouts on all API and documentation fetches, 10-minute backoff for failed remote fetches (removes up to 15 s per config write on offline installs), concurrent template validation with dry-run result reuse in `write_config_safe`, cached ESPHome discovery and ingress sessions, a short-lived entity state cache, WebSocket registry calls for areas/devices instead of slow Jinja templates, a persistent screenshot browser, and compact, capped output for large responses.
- **Faster YAML LSP** — completion documentation resolves lazily and space no longer triggers completion (far smaller payloads on large installs), HA fetches time out and serve cached data while refreshing in the background, and diagnostics debounce per document with stale results dropped.
- **Fixes** — `get_error_log` returned 404 due to a doubled API path; service hover in the YAML LSP was unreachable; editing one file no longer cancels another file's pending diagnostics.
- **Behavior** — unfiltered `get_services` now returns a domain/service index (pass `domain` for full schemas); `get_history` defaults to minimal responses (pass `minimal: false` for full attributes).
- **Smaller image** — checked-in dev `node_modules` are no longer baked into the Docker image.

## 2.0.3b2

- **GitHub Release image assets** — multi-arch build workflows now attach `container-images.md` and `image-manifest.txt` to the matching GitHub Release after publishing the GHCR image manifest, making the published image references and manifest details visible from the release page.

## 2.0.3b1

- **Multi-arch image publishing** — migrated the beta add-on to Home Assistant's preferred generic multi-arch image style (`ghcr.io/magnusoverli/ha_opencode_beta`) while keeping legacy arch-specific image aliases for compatibility.
- **Multi-arch Debian base image** — switched from architecture-prefixed Home Assistant Debian base images to `ghcr.io/home-assistant/base-debian:trixie`, which resolves to the same Debian Trixie amd64/arm64 platform images.

## 2.0.3b0

- **PPQ private TEE models** — added an opt-in internal PPQ private-mode proxy, pinned at image build time, with a masked PPQ API key option and an OpenCode custom provider for PPQ private models. The proxy binds only to `127.0.0.1` inside the container and is not exposed through Home Assistant networking.

## 2.0.0b1

- Mask the Home Assistant access token field in the add-on configuration UI.

## 2.0.0b0

- **Optional LAN server mode** — added an opt-in beta setting that starts an OpenCode server on fixed internal port `4096`, with Home Assistant Network settings controlling any host port mapping. This allows remote clients to connect with `opencode attach` when the port is explicitly mapped.

## 1.9.0b1

- Improve Zigbee2MQTT URL configuration by documenting the required `http://` or `https://` scheme and automatically treating host/IP-only `z2m_url` values as `http://`.
- Add Home Assistant add-on development folder access by mounting `/addons` and `/addon_configs`, with an opt-in guidance setting and security warnings.

## 1.9.0b0

- Reset the beta channel baseline to the current stable OpenCode add-on release.
- No beta-only feature changes are included in this baseline release.

## 1.7.3b0

- **Fix: screenshot_url no longer always times out** — `waitUntil: "networkidle0"` was used for page navigation, which waits for zero active network connections. The HA frontend keeps a persistent WebSocket open (`/api/websocket`) for the lifetime of the page, so this condition was never satisfied and every screenshot timed out after 30 seconds. Changed to `waitUntil: "load"`, which fires once the page and its subresources are fetched and ignores ongoing connections. Dynamic content rendering is already handled by the existing `wait_seconds` delay. Fixes [#19](https://github.com/magnusoverli/opencode/issues/19)

## 1.7.0b7

- **Fix: screenshot tool now authenticates correctly** — the previous approach only used localStorage with an empty `refresh_token` (falsy in JS), causing the HA frontend to show the login page instead of the dashboard. Now uses three complementary auth strategies:
  1. localStorage injection with non-empty `refresh_token`
  2. WebSocket monkey-patch that auto-responds to `auth_required`
  3. HTTP request interception adding `Authorization` header to HA server requests (token is not sent to external URLs)

## 1.7.0b6

- **Fix: screenshot_enabled config option and translation now synced to main** — the release workflow was only sed-bumping the version in config.yaml without syncing schema changes or translations. Now syncs the entire `ha_opencode_beta/` directory from the tagged commit to main
- This is the same Docker image as b5 — only the repository metadata sync is fixed

## 1.7.0b5

- **Fix: screenshot_enabled option now visible in Configuration UI** — was missing a translation entry in `translations/en.yaml`, causing HA to hide it
- Updated access token description to mention screenshot tool

## 1.7.0b4

- **New `screenshot_url` MCP tool** — visual verification of HA frontend pages using headless Chromium. After making dashboard changes via hab, the AI can take a screenshot and analyze it with vision. Requires `screenshot_enabled` option and a Long-Lived Access Token (opt-in, disabled by default)
- **`discoverHACoreUrl()` utility** — extracted HA Core URL discovery into a reusable function (used by both screenshot and ESPHome features)
- Chromium and puppeteer-core added to container image
- MCP server bumped to v2.7.0 (34 tools)
- Beta release workflow updated to use `dev` branch

## 1.7.0b2

- **write_config_safe: generalized content protection** — blocks writes that
  would remove top-level keys from mapping files (e.g. `configuration.yaml`)
  or significantly shrink any config file. Addresses [#14](https://github.com/magnusoverli/opencode/issues/14)
- `.bak` files are now retained after successful writes as a recovery point

## 1.6.1b16

- **Fix `hab esphome` commands from shell** — root cause: `HAB_ESPHOME_URL` and
  `HAB_ESPHOME_SESSION` were never set in the shell environment. The MCP server
  discovers these at runtime for its own `hab_run` tool, but shell users got
  "authentication failed" because hab had no ESPHome credentials.
- New `discover-esphome.js` startup script replicates the MCP server's 5-step
  ESPHome discovery flow (find addon → get ingress entry → resolve HA Core URL →
  create WebSocket ingress session → build final URL) and writes the resulting
  `HAB_ESPHOME_URL` and `HAB_ESPHOME_SESSION` exports to `/data/.env_vars`
- Discovery runs at addon startup (best-effort) — if ESPHome is not installed,
  not running, or the access token is missing/invalid, it skips silently
- Picks up latest HAB CLI from main branch (built from source at image build time)

## 1.6.1b15

- **Final beta before stable release**
- Picks up latest HAB CLI changes from main branch (built from source at
  image build time) — includes upstream improvements for addon support
- AGENTS.md: safer automation editing workflow — AI must now read and
  preserve all existing automations before writing, with explicit warning
  against overwriting `automations.yaml`

## 1.6.1b14

- Fix doubled ingress path in URL construction — `ingress_entry` from the
  Supervisor already contains `/api/hassio_ingress/<token>`, so the code was
  producing `http://host:8123/api/hassio_ingress//api/hassio_ingress/<token>/...`
  which returned 404. Now correctly appends the entry path directly to the
  HA Core base URL.

## 1.6.1b13

- Enhanced error reporting for ESPHome device requests
  - On failure: shows full URL, HTTP status, response body, headers sent,
    plus all discovery steps and constructed ingress URL
  - On success: shows ingress URL and URL source in device list output
  - This will reveal whether the 404 is from HA Core's ingress proxy or ESPHome

## 1.6.1b12

- Fix ESPHome addon detection — Supervisor `/addons` API does not set
  `installed: true`; check `state` and `version` fields instead
  - This was the root cause of the MCP tool reporting "not installed"
    even though ESPHome was running
- Discovery now proceeds past addon detection to attempt the full ingress flow

## 1.6.1b11

- Add detailed step-by-step diagnostics to ESPHome discovery
  - `discoverESPHome()` now returns structured diagnostics showing exactly which
    step failed (addon lookup, addon info, access token, URL discovery, network
    fallback, WebSocket session creation)
  - `esphome_list_devices` tool shows full discovery step trace on failure
  - `esphome_compile` and `esphome_upload` show step summary on failure
  - `hab_run` logs step detail for ESPHome pre-discovery failures
  - No more generic "not installed or not accessible" — the exact failure point
    and all intermediate data (interfaces, URLs, slugs) are surfaced

## 1.6.1b10

- Test with HAB CLI reverted to known working state
  - No HAB CLI changes — using upstream as-is
  - MCP server unchanged from b9 (network fallback + WebSocket session creation)
  - Isolates whether the b9 500 errors were caused by HAB CLI changes

## 1.6.1b8

- Simplify HAB CLI changes — revert all discovery-path code, keep only
  `GetESPHomeClient` env var handling (HA_ACCESS_TOKEN + HAB_ESPHOME_SESSION)
  since the MCP server handles all URL/session discovery

## 1.6.1b7

- Support "automatic" internal_url setting (most common HA default)
  - When `/api/config` returns `internal_url: null`, fall back to discovering the
    host's LAN IP from Supervisor's `/network/info` (primary connected interface)
    and Core port from `/core/info`
  - No longer requires manually setting internal_url in HA Network settings

## 1.6.1b6

- Use WebSocket for ingress session creation (REST path rejected by Supervisor)
  - REST `POST /api/hassio/ingress/session` is always rejected — only the WebSocket
    `supervisor/api` command works (HA Core makes the call with its own credentials)
  - MCP server: new `createIngressSessionViaWebSocket()` function
  - HAB CLI: delegates to `discoverESPHomeViaWebSocket()` (same path as external CLI)
  - Still uses `internal_url` from `/api/config` + long-lived access token

## 1.6.1b5

- Use HA Core's real LAN URL instead of Docker-internal hostnames
  - Auto-discovers `internal_url` from `/api/config` (e.g. `http://192.168.1.100:8123`)
  - Routes ingress through the same URL path the external CLI uses
  - Docker hostnames (`homeassistant`, `supervisor`) don't work for ingress from addon containers

## 1.6.1b4

- Add `access_token` config option for HA Core long-lived access token
  - Required for ESPHome ingress (SUPERVISOR_TOKEN is not accepted by HA Core directly)
  - Create at: HA UI → Profile → Long-Lived Access Tokens
  - Paste into addon Configuration → `access_token`
- Use HA access token for all HA Core direct calls (session creation + ingress requests)
- Clear error message when access token is missing and ESPHome tools are used

## 1.6.1b3

- Bypass Supervisor proxy entirely for ESPHome ingress
  - Route directly to HA Core at `http://homeassistant:8123` (Docker internal hostname)
  - Session: `POST http://homeassistant:8123/api/hassio/ingress/session`
  - Requests: `http://homeassistant:8123/api/hassio_ingress/{entry}/...`
  - Matches the code path that works from outside HA with a long-lived token

## 1.6.1b2

- Fix ESPHome ingress session creation (was returning 403)
  - Route session creation and requests through HA Core proxy instead of Supervisor directly
  - Session: `POST /core/api/hassio/ingress/session`
  - Requests: `/core/api/hassio_ingress/{entry}/...`

## 1.6.1b1

- Fix ESPHome addon connectivity from OpenCode
  - Route MCP tools and hab CLI through Supervisor ingress proxy
  - ESPHome dashboard requests now originate from Supervisor IP (allowed by nginx)
  - Add ingress session authentication for proxied requests
- Bump hassio_role to manager for ingress session creation
