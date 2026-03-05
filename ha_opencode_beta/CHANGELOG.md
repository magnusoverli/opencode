# Changelog

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
