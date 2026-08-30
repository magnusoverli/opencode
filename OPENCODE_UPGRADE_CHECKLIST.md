# OpenCode V1 Stable Runtime Maintenance Checklist

The stable add-on ships one certified OpenCode V1 build. Changing it is a
deliberate act, not a dependency bump. Beta targets V2 from `3.0.0b0` and no
longer serves as a V1 soak channel.

Work through it against a candidate stable V1 image on a real Home Assistant
instance before publishing. Nothing here is automated, because every item is a
place where an upstream change has broken this add-on before and the failure was
only visible to a person using it.

Related: [`OPENCODE_V2_FUTURE.md`](OPENCODE_V2_FUTURE.md) governs beta's V2
runtime. This checklist does **not** cover V2.

## 1. Bump the pin

- [ ] `ha_opencode/Dockerfile` — `ARG OPENCODE_VERSION=<exact version>`
- [ ] `ha_opencode/build.yaml` — `OPENCODE_VERSION: "<same exact version>"`
- [ ] Exact version only. Never `latest`, never a range. The two must match —
      `ha_opencode/test/runtime-contract.test.js` fails otherwise, and so
      does the image build if npm resolves something else.
- [ ] Read upstream's release notes for everything between the old pin and the
      new one. Config-schema, permission, MCP, LSP and formatter changes are the
      ones that reach this add-on.

## 2. Build and boot

- [ ] Stable image builds for **both** `amd64` and `aarch64`.
- [ ] Add-on starts; the log shows `Certified OpenCode version: <version>` and
      an `Effective OpenCode version` that matches it.
- [ ] No warning about the runtime resolving outside `/usr/local/bin/opencode`.
- [ ] Ingress panel loads.

## 3. Automated in-image checks

Run inside the add-on terminal — or, in `openchamber` mode where there is no
terminal, ask the OpenCode session to run it with its shell tool:

```
opencode-smoke-test
```

It covers the certified version and PATH precedence, the generated
configuration contract, MCP server startup and compact-profile rejection, the HA
YAML language server, the Ingress-patched OpenChamber bundle, the deployed
skills, and the read-only overlay `ha-readonly` builds. **Every check must
pass.**

## 4. Sessions

- [ ] **Terminal** (`interface_mode: terminal`): banner correct, OpenCode starts,
      a prompt gets a reply.
- [ ] **OpenChamber** (`interface_mode: openchamber`): UI loads through Ingress,
      assets resolve (no 404s in the browser console), a session runs.
- [ ] **LAN mode**: `enable_server: true` with `4096/tcp` mapped — `opencode
      attach` from another machine connects and runs a prompt.
- [ ] **OpenChamber LAN**: `enable_openchamber_lan: true` with `4097/tcp` mapped
      — the UI loads at the root path.
- [ ] **Read-only** (`ha-readonly`, terminal mode only): starts, banner shown, an
      entity can be inspected, and an attempted edit / shell command / service
      call is refused.

## 5. Provider sign-in

- [ ] `/connect` completes for at least one API-key provider.
- [ ] A browser-OAuth provider (for example ChatGPT Pro/Plus) completes from
      **OpenChamber**, which is the path that has broken before.
- [ ] An existing `auth.json` still works after the upgrade — do not only test a
      fresh sign-in.

## 6. MCP

- [ ] `mcp_tool_profile: full` — tool list is complete; `call_service`,
      `write_config_safe`, `hab_run`, `screenshot_url` all dispatch.
- [ ] `mcp_tool_profile: configuration` — writes and docs present, control tools
      absent.
- [ ] `mcp_tool_profile: compact` — read-only tools only; a hidden tool is
      rejected with the profile message rather than silently failing.
- [ ] `native_ha_mcp_enabled: true` against an HA build with
      `/api/mcp/assist` — the bridge connects and its tools appear.
- [ ] `mcp_enabled: false` — no MCP tools, and nothing errors at start-up.

## 7. Language server, formatting and skills

- [ ] Open a YAML file with a bad entity ID — a diagnostic appears.
- [ ] Entity/service autocomplete returns suggestions.
- [ ] Saving a YAML file reformats it with Prettier.
- [ ] `skill` tool lists the five `home-assistant-*` skills, and loading one
      returns its content.
- [ ] Edit a deployed skill by hand, restart the add-on, confirm the edit
      survives and the log says the update was skipped.

## 8. PPQ private mode

- [ ] `ppq_private_enabled: true` with a key — the proxy starts, the
      `PPQ Private (TEE)` provider is offered, and a private model replies.
- [ ] With the option on and **no** key — the add-on still starts and warns.

## 9. Home Assistant work, end to end

- [ ] Read a configuration file, propose an automation, write it with
      `write_config_safe`, reload the domain.
- [ ] Diagnose an unavailable entity and get a recommendation.
- [ ] `hab entity list --json` and `zigporter list-devices --json` both run.
- [ ] Take a screenshot of a dashboard (`screenshot_enabled: true` plus a token).

## 10. Upgrade path

- [ ] Install the previous stable, then upgrade to the candidate stable over it. Sessions,
      auth, decision notes and `AGENTS.md` customisations all survive.
- [ ] With a persisted legacy `opencode_update_policy: latest` in the saved
      options, the log shows the migration notice, `/data/.npm-global` is left
      alone, and the certified runtime is what runs.

## 11. Soak

- [ ] Leave the candidate stable running for several days of ordinary use.
- [ ] Re-read the add-on log for anything new: repeated warnings, crashed
      services, a watchdog restart.

Only then publish a stable V1 maintenance release. Do not copy the V2 beta tree
over stable; `scripts/promote-beta-to-stable.sh` deliberately refuses to run.
