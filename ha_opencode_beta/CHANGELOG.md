# Changelog

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
