# Changelog

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
