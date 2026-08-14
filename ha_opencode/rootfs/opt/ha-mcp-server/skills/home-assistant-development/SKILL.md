---
name: home-assistant-development
description: Develop code for Home Assistant rather than configuration — a custom integration under custom_components/, a Home Assistant add-on in /addons, a native LLM tool provider (llm.py) exposed through Home Assistant's llm platform and native MCP endpoints, or an MCP server. Load this when the request is about writing Python, an add-on Dockerfile or config.yaml, an integration manifest, or LLM/MCP plumbing.
metadata:
  owner: ha-opencode-addon
---

# Developing for Home Assistant

This is code, not configuration. The consent rules still apply, and so does the
rule that `.storage/` and the other internal directories are off-limits.

## Custom integrations

A custom integration lives at `custom_components/<domain>/` and needs at least
`manifest.json` and `__init__.py`. `manifest.json` carries `domain`, `name`,
`version`, `documentation`, `dependencies`, `codeowners`, `requirements`, and
`iot_class` — Home Assistant refuses to load an integration whose manifest is
incomplete, and the error appears only in the log.

Points worth checking against the running version, because they change:

- Config-flow vs YAML setup — new integrations are config-flow only.
- `async_setup_entry` / `async_unload_entry` and the coordinator pattern
  (`DataUpdateCoordinator`) for anything that polls.
- Entity naming: `_attr_has_entity_name` and `_attr_name` interact in a way that
  has changed more than once.
- `hass.config_entries.async_forward_entry_setups` — the plural, awaited form.

**Any change under `custom_components/` needs a full Home Assistant restart.**
There is no reload for integration code. Say so, and ask.

Read the current developer documentation rather than recalling API shapes —
`get_integration_docs` covers user-facing configuration, and
<https://developers.home-assistant.io> is the reference for the code side.

## Native LLM tool providers

Home Assistant has a native `llm` platform: Core and custom integrations expose
curated tools through `<integration>/llm.py` and register an LLM API. Newer
builds also serve those APIs over native MCP at `/api/mcp/<API ID>` — the
built-in Assist API is `/api/mcp/assist`.

- `get_ha_llm_development_guide` returns the upstream references and a starter
  template for writing an `llm.py` provider. Use it before writing one.
- `get_agent_capabilities` (or the `ha://agent/capabilities` resource) reports
  whether the running instance actually has the native `llm` component and which
  native MCP endpoints answer.
- This add-on **cannot** register tools with Home Assistant's `llm` platform.
  Registration is internal to integrations and custom integrations. What the
  add-on can do is *consume* a configured native LLM API over native MCP, which
  is what the optional `homeassistant_native` MCP server does.
- Native tools are curated by Home Assistant and are the better choice for
  requests that fit the configured API. The add-on's own MCP server is for
  configuration editing, safe writes, validation, admin and development
  workflows, screenshots, updates, ESPHome, `hab`, Zigbee, and documentation
  lookup.

## Home Assistant add-ons

Add-on folder access is off unless the user enabled it. When it is on,
`/addons` holds local add-on sources and `/addon_configs` holds **other add-ons'
configuration, including their credentials** — treat it as sensitive, read it
only when the user asks, and never copy values out of it.

An add-on is a `config.yaml` manifest plus a `Dockerfile` plus a rootfs. Things
that bite:

- `config.yaml` `options:` and `schema:` must declare the same keys, in the same
  order, or an option silently reads back as the string `"null"`.
- `map:` entries decide what the container can see; `homeassistant_config`,
  `addons`, `all_addon_configs`, `share`, `ssl`, `media`.
- `hassio_api` / `hassio_role` / `homeassistant_api` gate Supervisor access.
  Ask for the least that works.
- s6-overlay services under `rootfs/etc/s6-overlay/s6-rc.d/`. A failing
  `oneshot` takes the whole container down by default — never let optional
  functionality decide whether the add-on boots.
- Reading an option with bashio returns the literal string `"null"` for an
  undeclared or absent key, not an empty string. Guard accordingly.

Rebuilding a local add-on is done from the Home Assistant UI or
`hab`; there is no path from this container that rebuilds an add-on image.

## MCP servers

An MCP server for Home Assistant is an ordinary stdio JSON-RPC process. What
matters in practice:

- Advertise only the tools that are actually usable in the current
  configuration. A tool that can only ever return a setup error costs
  tool-list tokens on every request and invites a call that must fail.
- Reject a disabled tool at dispatch as well as hiding it from the list. A
  client may have a stale tool list.
- Keep responses compact. Pretty-printed JSON is whitespace the model pays for
  on every turn the result stays in history.
- Bound anything that can grow — logs, history, state dumps — and say in the
  response that it was truncated.

The add-on's own server is at `/opt/ha-mcp-server/`; its tests
(`npm test` in that directory) are the fastest way to see the expected shapes.

## Testing

Home Assistant integration tests use `pytest` with `pytest-homeassistant-custom-component`.
They do not run inside this add-on container — there is no Home Assistant Python
environment here. Write them, and tell the user to run them in a checkout on a
development machine. Do not claim a test passed that you could not run.
