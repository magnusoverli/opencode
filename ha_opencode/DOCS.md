# OpenCode

Your Home Assistant configuration assistant, powered by OpenCode V2. Use the
terminal or OpenChamber web workspace with one shared, app-managed backend.

## Upgrading from 2.x

1. **Create a Home Assistant backup** containing the OpenCode app and your Home
   Assistant configuration before updating through Supervisor.
2. **Review advanced options.** If LAN access is enabled, configure the LAN
   password, trusted HTTPS proxy and public URL options described below, or disable
   LAN access first. Review `opencode_config` against the supported V2 subset;
   invalid or unsupported settings stop activation with an explanatory error.
3. **Allow the first startup to finish.** Stable conversation history is converted
   into a private V2 generation and activated only after validation. Large
   databases can take several minutes; Ingress may show 502 while the migration
   runs. Wait for `OpenCode V2 copy-on-write state generation is ready` and the
   server startup log, or for a migration error, before restarting. Successful
   preparation starts the services in the same boot without a manual restart.
   Failed conversion preserves its input; read the app log before retrying.
4. **Reconnect providers with `/connect`.** V1 browser/OAuth credentials are not
   imported. Provider API keys supplied through app options are handled separately.

The stable app keeps its identity and `/data` volume. Decision notes and startup
hooks remain under `/config/opencode/`; edited instructions and `AGENTS.local.md`
are preserved. Beta has separate storage: its conversations and sign-ins are not
automatically moved into stable.

**Recovery:** there is no runtime rollback selector. To return to 2.x, restore
the pre-upgrade Home Assistant backup, including the prior app version and data.
Do not point V1 at converted V2 state. Updates to bundled components are delivered
through Home Assistant Supervisor.

If startup reports `session_projection_mismatch`, the add-on preserves the old
state and does not start the V2 server. In versions with field diagnostics, the
add-on log also names the session columns that differ (without showing their
values); include the error and field names when reporting a failure. A corrected
app update retries migration on restart. Do not delete the old database or the
migration journal to force startup.

**Current limitations:** user-added custom skills may survive restart without
appearing in the V2 skill catalog; shipped Home Assistant skills are available.
The former browser-terminal quit overlay is not included in V2; use the terminal's
own exit action. OpenChamber uses a pinned upstream V2 preview. PPQ account-backed
private inference has not completed live qualification.

Stable and beta can run side by side. They share Home Assistant configuration
files and `AGENTS.local.md`, but keep separate app data and decision notes. Stable
owns the managed `/config/AGENTS.md`. Give each app different host ports if you
expose both sets of LAN frontends.

## Upstream Attribution

This independent Home Assistant add-on redistributes and integrates
[OpenCode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, under the
MIT License. It is not made by, affiliated with, or endorsed by the OpenCode
team or Anomaly. The complete OpenCode notice is included in the add-on image
at `/usr/share/doc/ha-opencode/NOTICE` and in this repository's
[`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md).

## OpenCode 3.0 at a glance

- **Official V2 runtime**: CLI and plugin are pinned to OpenCode `2.0.13` using the official `@opencode` packages.
- **Forward state upgrades**: Earlier V2 data upgrades through a validated private copy, preserving conversations, sign-ins and permissions. Successful upgrades remove obsolete generations; failed conversion preserves its input and reports an error. There is no application runtime fallback or rollback selector.
- **V2-only runtime**: One pinned OpenCode V2 server replaces V1 and the runtime selector. The server runs as root for Home Assistant filesystem compatibility; its attached terminal runs as UID `60001`.
- **Managed CLI**: `opencode` and `opencode2` address the same V2 server. `opencode status`, `opencode service status`, and `opencode api GET /api/info` inspect the existing server without starting another daemon.
- **YAML language assistance**: The `ha_yaml_*` tools provide credentialed HA diagnostics, completion, hover and definitions through a supervised language-server worker. Approved native YAML writes use pinned Prettier formatting.
- **Fresh V2 provider sign-in**: V1 sessions migrate into V2, but V1 provider credentials do not. Authenticate providers once with `/connect` in V2; the retained V1 credential remains untouched.
- **Native Home Assistant MCP in V2**: Enabling the optional native bridge adds `homeassistant_native` alongside `homeassistant`. The sidecar keeps the Supervisor token out of inherited V2 environment, managed config, logs, and model context. Because allowed V2 shell commands run as container root, they remain trusted code rather than an OS-isolated boundary.
- **Complete entity history**: `get_history` can page through every recorded state change as compact value/timestamp pairs and reports complete-window numeric summaries while preserving the bounded newest-200 default.
- **ESPHome 2026.8 support**: Device Builder migrations can be previewed as validated, hash-guarded candidates; structured DNS/mDNS/ICMP troubleshooting and bounded crash decoding are available; naturally completed log and job streams now finish immediately.
- **Startup hooks**: Your own `.sh` scripts, kept in your configuration directory, run once every time the add-on starts — the supported way to add a bridge or a small service without editing files inside the container, which never survives a restart. Off by default. See [Startup Hooks (Beta)](#startup-hooks-beta).
- **Home context**: Sessions now start knowing your installation. A generated **Install briefing** describes your setup (version, areas, entity counts, configuration layout, integrations), **decision notes** carry lasting decisions between sessions once you approve them, and `AGENTS.local.md` holds your own instructions where add-on updates cannot overwrite them. Both options default on and switch off independently. See [Home Context (Beta)](#home-context-beta).
- **OpenChamber V2 preview**: The web interface is built from pinned preview `2.0.0-preview.8` source and its dependency lock. It attaches to the same app-owned V2 backend as the terminal, with independently supervised UI lifecycle and Ingress-adapted assets.
- **Native Home Assistant MCP bridge**: Optional bridge from OpenCode to Home Assistant Core's native LLM MCP endpoint (`/api/mcp/<API ID>`, default `assist`) for testing the new native LLM/MCP platform when the running Home Assistant version supports it.
- **Compact Home Assistant context**: New `get_home_context` MCP tool gives agents focused area/domain/entity context with area and device metadata instead of broad state dumps.
- **Native LLM provider development guide**: New `get_ha_llm_development_guide` MCP tool helps custom integration authors build `<integration>/llm.py` tool providers aligned with Home Assistant's upstream architecture.
- **Serial device access**: Selected host UART/serial devices can be mapped into the add-on for USB flashing and adapter inspection workflows. Full Supervisor `uart` and `udev` manifest flags remain disabled by default because they are static permissions, not runtime user options.
- **LAN and PPQ compatibility**: LAN frontends require a trusted HTTPS reverse proxy and separate LAN password. PPQ registers native private models when enabled with a key; select a private model explicitly. Actual upstream encryption/private-inference acceptance remains pending.
- **Web terminal clipboard fixes**: Copying inside OpenCode now reaches the browser clipboard, plain `Ctrl+V` paste works, and macOS users can use `Option+drag` to select text while full-screen terminal apps capture the mouse.
- **Touch scrolling**: One-finger vertical drag gestures inside the terminal now scroll full-screen apps such as OpenCode on phones and tablets.
- **Certified OpenCode runtime**: The app ships one pinned V2 build. Runtime upgrades arrive through app images. See [OpenCode Updates](#opencode-updates).
- **Home Assistant skills**: The detailed procedures — YAML work, troubleshooting, dashboards, Zigbee/ESPHome, development — now ship as OpenCode skills that are loaded only when the task needs them, instead of being pushed into every request. `AGENTS.md` keeps the consent and safety rules, which are always in force. See [Home Assistant Skills](#home-assistant-skills).
- **Read-only session**: Run `ha-readonly` for a session that can inspect and diagnose your installation but cannot change it — no file edits, no shell, no service calls, no configuration writes. Requires a provider/model that accepts the custom read-only agent; the default free-tier model rejects it. See [Read-Only Session](#read-only-session).
- **Sensitive file protection**: New **Restrict access to sensitive files** option (default on) denies the AI read access to `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, and `*.key`/`*.pem` files so their contents can't reach the model. Set it to `false` to restore fully unrestricted file access. See [Sensitive File Protection](#sensitive-file-protection).
- **Focus-friendly responses**: Optional action-first, concise, progress-aware response guidance for users who find long or unstructured responses difficult to act on. Disabled by default and available in both terminal and OpenChamber modes.
- **Provider sign-in**: OpenAI OAuth has been verified on amd64 HAOS. See [Connecting a provider with browser sign-in](#connecting-a-provider-with-browser-sign-in).

## Home Context (Beta)

Four files decide what OpenCode knows about your installation before you type anything. Run `ha-context show` in the terminal to read every one of them, and `ha-context status` to see what each costs.

| File | What it is | Who writes it |
|------|-----------|---------------|
| `/config/AGENTS.md` | The add-on's own instructions | The add-on, refreshed on update |
| `/config/AGENTS.local.md` | **Your** standing instructions | You; the add-on never touches it |
| `/data/context/home-briefing.md` | Generated summary of your setup | The add-on, rebuilt on every start |
| `/config/opencode/decisions.yaml` | Lasting decisions you approved | OpenCode, only when you say yes |

**Your own instructions.** Create `/config/AGENTS.local.md` for standing preferences — "all Zigbee goes through Zigbee2MQTT", "new config goes in `packages/`", "always show me the diff first". A commented example lands at `/config/AGENTS.local.md.example` on first install. Add-on updates never overwrite it, `AGENTS.md` still wins on conflict, and deleting the file turns it off.

This also fixes a real problem: `AGENTS.md` used to be refreshed on every add-on update whenever it still carried its original heading, which quietly discarded customizations added to it. The add-on now compares the file against what it last wrote and leaves edited copies alone, keeping a `.bak` copy the first time it cannot tell.

**Install briefing** (option, default on). Regenerated at every start: Home Assistant version and installation type, how your configuration is split up (including whether `automations.yaml` is UI-managed), your areas and floors by name, entity counts per domain, integrations and device stacks, and your custom components. It is rebuilt rather than appended to and capped at roughly 500 tokens, so it cannot grow. It is produced by the add-on, not the AI, and never contains `secrets.yaml` values, tokens, or your coordinates.

**Decision notes** (option, default on). Configuration records *what*; notes record *why* — that an integration was removed deliberately, that a toggle is inverted on purpose, that some corner should be left alone. OpenCode proposes a note and writes it only after you approve. Notes are plain YAML in `/config/opencode/decisions.yaml`. Each active note is injected as one line — date, title, decision, and any entities, files or integrations attached to it; rationale and retired notes stay in the file and are fetched on demand via `recall_decisions`. The digest is capped at roughly 500 tokens and up to 40 active notes are stored, so when there are more notes than fit the digest says how many it is showing and the rest stay in force in the file — add `pin: true` to a note to keep it in the digest. Replaced notes are marked superseded rather than deleted, so the per-request cost stays flat. Notes containing a credential or a value from your `secrets.yaml` are rejected.

Adds three MCP tools: `remember_decision`, `recall_decisions`, `supersede_decision`. With the option off, they are not offered to the AI at all and your existing notes file is left untouched.

## Focus-Friendly Response Mode (Beta)

Turn on **Focus-friendly responses (beta)** in the add-on **Configuration** tab and restart the add-on. The mode shapes OpenCode responses to lead with the next action or result, number multi-step work, show progress, keep ordinary lists short, and end with one concrete next step.

This is an output-formatting preference, not a medical feature. It does not diagnose ADHD, create a health profile, change model access, grant permissions, or bypass confirmations. Home Assistant safety requirements remain in effect: proposed changes, validation results, backups, destructive-action warnings, and explicit approval are still required. Ask for an explanation or walkthrough when you want more detail.

## Add-on Folder Access

OpenCode mounts `/addons` and `/addon_configs` for Home Assistant add-on development access. Turn on **Add-on folder guidance** in the add-on configuration and restart to show these paths in the terminal. This option updates guidance, but the mounts are static add-on metadata and are not a hard filesystem permission boundary.

Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

## Sensitive File Protection

By default (**Restrict access to sensitive files** = `true`), the add-on adds an OpenCode `permission.read` rule that blocks the AI's file-**read** tool from opening secret/credential files — `secrets.yaml` (any path ending in `secrets.yaml`), the `.storage/` and `.cloud/` directories, the `ssl/` directory, and any `*.key`/`*.pem` files — so their contents can't be pulled into the model's context. Everything else stays readable, and the agent can still edit normal config that *references* secrets via `!secret`. The Home Assistant MCP tools are unaffected; they read live state through the API.

Set **Restrict access to sensitive files** to `false` to remove the normal agent's sensitive-file read rules. The read-only agent retains its own restrictions. The supported native `opencode_config` subset is validated before activation and cannot override managed permissions, plugins or integration policy; see [Custom Providers and Configuration](#custom-providers-and-configuration-beta).

**Scope/limitation:** this guards OpenCode's file-read tool (the common accidental-exposure path). It does **not** restrict shell commands, so an explicit `cat secrets.yaml` can still read the file — treat it as a strong guardrail, not a hard sandbox.

## Resource Usage

Filesystem snapshots remain disabled by app policy to reduce memory and disk pressure. This is separate from LSP and formatting. File watching ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs and the Home Assistant database. Snapshot overrides through raw custom configuration are not currently supported.

## V2 YAML Language Assistance and Formatting

With **LSP integration** enabled, these agent tools use a real HA YAML language server:

- `ha_yaml_status`: verify the worker's authenticated Home Assistant connection.
- `ha_yaml_diagnostics`: syntax, entity, service and include diagnostics.
- `ha_yaml_completions`: suggestions at a zero-based line/UTF-16 character position.
- `ha_yaml_hover` and `ha_yaml_definition`: language-server information and definitions.

Pass a YAML path inside `/homeassistant`, or supply optional in-memory `text` to
check a draft without writing it. Sensitive files and symlink traversal are
rejected. Home Assistant credentials stay in the root-only worker; the V2 process
communicates through a Unix socket. This works independently of MCP enablement.
Include diagnostics and definitions are also confined to that workspace without
following symlinks. Sensitive/hidden targets are rejected before probing whether
they exist; `!secret` definitions never probe or return secret-file locations.

The managed config still has `lsp: false` because V2 has no native LSP runner;
the `homeassistant.lsp` plugin owns the agent integration. OpenChamber's editable
YAML views also request diagnostics and completion for unsaved drafts inside
`/homeassistant` through authenticated Ingress. Read-only and sensitive-file
views do not dispatch these requests. Diagnostics are debounced; edits, file
switches and closed views cancel outstanding work, and stale results are ignored.
The editor reports unavailable language assistance rather than treating an LSP
outage as a clean document. This assistance does not save files or reload HA;
normal editor save controls and approval policies remain separate. LAN editor
access is not enabled by this integration.
The editor transport requires browser `Sec-Fetch-Site: same-origin` metadata to
validate requests across Ingress's TLS-terminating proxies. Use HTTPS (or a
localhost browser origin); browsers that omit this metadata, commonly on plain
HTTP LAN origins, receive an unavailable result rather than weakening the origin
check. Agent `ha_yaml_*` tools do not have this browser restriction.

Approved native `.yaml`/`.yml` writes use pinned Prettier and honor the file's
`.prettierrc` preferences. Formatting does not reload Home Assistant or replace
configuration validation. The read-only agent denies edits and LSP dispatch.

## Desktop Browser Tools versus HA Screenshots

OpenCode's model-facing `browser` tools require a browser attached by the
OpenCode desktop app, as described in the [V2 Tools guide](https://opencode.ai/v2/docs/tools).
Opening OpenChamber through Ingress does not attach that desktop browser. The
packaged Chromium used by the optional HA `screenshot_url` tool is a separate
capability. Desktop-browser attachment to the app's managed server is not
yet qualified; do not expose a Chromium debugging port as a workaround.

## Home Assistant Skills

The add-on ships five skills that hold the detailed procedure for each kind of Home Assistant work. OpenCode loads a skill on demand, when the task calls for it, so none of them costs anything on a request that does not need it.

| Skill | Covers |
|-------|--------|
| `home-assistant-configuration` | Writing and changing YAML: automations, scripts, scenes, templates, integrations, packages. Checking current integration docs first, the HA YAML style guide, `yq`, safe writes, validation, backups, and whether a change needs a reload or a restart |
| `home-assistant-troubleshooting` | Diagnosing a problem without changing anything: bounded state, history, logbook and log queries, and ending with a recommendation |
| `home-assistant-dashboard-ui` | Lovelace dashboards, views, cards, themes, and verifying the result with a screenshot |
| `home-assistant-zigbee-esphome` | Zigbee/ZHA/Z2M inspection, cascade renames, stale-device cleanup, mesh maps, ESPHome, and firmware updates |
| `home-assistant-development` | Custom integrations, add-ons, native `llm.py` tool providers, and MCP servers |

What stays in `AGENTS.md` — and therefore loads in every session — is the part that has to be unconditional: the consent and scope rules, the secret-handling rules, the off-limits internal directories, and a short map of which skill covers what.

The skills are deployed to `/data/.config/opencode/skills/`, where OpenCode discovers them. **You can edit them.** The add-on refreshes a skill at start-up only when your copy is byte-for-byte what it last wrote; once you change one, it is yours, the update is skipped, and the add-on log says so. Delete your edited copy if you later want the shipped version back.

## Editing automations: saved versus active

The bundled `home-assistant-configuration` skill guides the agent through locating
the automation source (including custom includes/packages), preserving existing
automations and IDs, prevalidating the draft, and saving with `write_config_safe`.
You can ask: “Use the configuration skill to edit this automation, then explain
the reload and verification steps.”

Saving YAML does not apply it to the running instance. The agent should request
approval for both the write and `automation.reload`, then verify loading with
read-only tools. A domain reload avoids a Core restart but stops currently
running automation actions. The final response should distinguish **saved**,
**reloaded**, and **load verified**; testing the automation's actions is separate
and requires approval.

The `configuration` MCP profile supports safe writes but omits `call_service`, so
the agent must leave the change **pending reload**. Reload Automations in
Home Assistant's **Developer Tools → YAML**, or choose the `full` MCP profile and
restart the add-on to let the agent perform an approved reload. If a reload fails,
the agent should report that and inspect relevant errors, rather than report the
edit as complete or switch to shell/API editing.

Updated bundled guidance takes effect after an add-on restart and a new OpenCode
session. User-edited skill copies are preserved by updates; review those copies
if an older customized procedure is still being loaded.

## Read-Only Session

Select `home-assistant-read-only` through `/agents` in the V2 terminal. From an
app root shell, this helper creates and attaches to a read-only session on the
same managed V2 server:

```
ha-readonly
```

The native agent policy:

- denies file edits, shell commands, subagents, and the LSP tool
- permits the compact diagnostic MCP tool subset and denies mutating/unknown tools before dispatch, without changing the shared server's configured profile
- denies the native Home Assistant MCP namespace
- denies reading `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, `*.key` and `*.pem` **regardless** of the **Restrict access to sensitive files** setting

The session uses the managed server's V2 data and provider connections; choose
its model normally. `ha-readonly --print-config` prints the native agent policy.
Other sessions retain their own agents and policy.

### Free-tier model compatibility

Normal **Build** sessions work with the tested free model, `opencode/big-pickle`.
The same model rejects the custom `home-assistant-read-only` agent with:

> OpenCode's free tier can only be used from within OpenCode

This response comes from the free-tier provider, even though the app is running
OpenCode. We treat it as an accepted provider compatibility restriction, rather
than an app defect requiring a workaround. For read-only investigations, select
a provider/model that accepts custom agents. The read-only permissions remain
in force; normal Build chat does not require a fix for this restriction.

## MCP Tool Profiles

The built-in `homeassistant` MCP server can expose a narrower capability set through **MCP tool profile**. This changes the tool definitions supplied to the model and rejects hidden MCP calls before they reach Home Assistant; it does not change OpenCode filesystem access, terminal commands, or permissions. Restart the add-on after changing it.

| Profile | Includes | Excludes |
|---------|----------|----------|
| `compact` | Read-only entity state, history, diagnostics, templates, calendars, home context, and bounded Supervisor operations evidence | Config writes, device control, updates, screenshots, `hab`, and Zigbee administration |
| `configuration` | Everything in `compact`, plus current docs, syntax checks, validation, safe config writes, and decision notes | Device control, updates, screenshots, `hab`, and Zigbee administration |
| `full` | Every currently available built-in MCP tool | Nothing beyond separately disabled features |

`full` is the default and preserves current behavior. `get_agent_capabilities` reports the active profile, exposed tool count, and omitted count.

For local Ollama and other OpenAI-compatible models, configure an effective context window of at least 64K and restart or reload the model. The complete OpenCode prompt includes built-in tools, Home Assistant tools, instructions, and conversation history; a smaller context can silently truncate tool definitions even when a small standalone `curl` tool-call test succeeds. Use `ha-mcp tools` from the terminal, or ask OpenCode to run it with its shell tool in OpenChamber mode, to list what the MCP server objectively advertises. Asking the model which tools it has only tests model recall. If the command lists a tool that the model will not call, check the model server for prompt truncation and tool-parser errors.

## MCP Plugin Reload Reliability

The Home Assistant MCP plugin obtains its caller credential from the V2
server's non-dumpable native bootstrap library. The credential broker still
delivers it once to the authenticated server process; subsequent plugin
activations copy it from process-owned memory. No caller credential is stored in
plugin options, written to the environment, or handed to shell subprocesses.

This replaces the earlier FD-3 handoff, which could fail on a second activation
with `EAGAIN: resource temporarily unavailable, read` after descriptor reuse
(#112). Reloads of the local plugin module also use the same native holder.
Updating requires an app restart so the matching native library and plugin
load together; changing only the JavaScript in a running older image is not
sufficient.

## Model Tool Evaluation


`ha-agent-eval` is an opt-in developer command that calls a real OpenAI-compatible chat-completions endpoint against fixed synthetic Home Assistant scenarios. It supplies mocked tool results and never contacts Home Assistant or executes a real tool.

Configure these environment variables through the add-on's **Environment variables** option:

```text
HA_AGENT_EVAL_BASE_URL=https://provider.example/v1
HA_AGENT_EVAL_MODEL=provider-model-id
HA_AGENT_EVAL_API_KEY=optional-for-local-or-tokenless-providers
```

Run `ha-agent-eval` to evaluate scenarios supported by the active MCP profile, or use `ha-agent-eval --profile compact` or `ha-agent-eval --scenario safe-configuration-validation`. Reports are written under `/data/evaluations/`, excluded from backups, and the command exits non-zero when any scenario fails. It evaluates model function-calling behavior, not OpenCode's full prompt or a live Home Assistant system.

The add-on does no memory-heavy start-up install, so it runs on low-memory hosts such as a 4 GB Home Assistant Green alongside several other add-ons. 8 GB or more is recommended for comfortable use alongside other memory-heavy add-ons such as Matter Server, Music Assistant, and Whisper/Piper.

## OpenCode Updates

The app ships one pinned OpenCode V2 runtime, installed at build time and
verified against its exact pin. The terminal, API client and status commands all
refer to the same managed server. V1 and runtime rollback are not available.
The `opencode2` command remains supported throughout 3.x as an alias of `opencode`;
it does not select a different runtime or start another server.

OpenCode's auto-updater is disabled. **A new OpenCode arrives with an app update.**
Home Assistant Supervisor updates the packaged OpenCode and OpenChamber components
together. A newer upstream OpenCode release does not mean an app update is available;
check the OpenCode app's page in Home Assistant for available app updates.
Use the Home Assistant app controls to manage the service; upstream service-manager
commands that could start another daemon are rejected by the app's CLI.

If you used the old `latest` policy, an OpenCode may still exist under `/data/.npm-global`. It is left untouched but is no longer on `PATH` and is never used; the add-on logs a one-line notice about this at start-up. You can remove the now-unknown `opencode_update_policy` line from the Configuration tab at your convenience.

### Checking the runtime yourself

`opencode-smoke-test` checks the public/private V2 runtime paths, managed server
health, authenticated policy, context/MCP/LSP plugin state, workspace, credentialed
LSP connection, formatter configuration and Ingress. Incomplete integrations are
reported as skipped. It exits non-zero when a required check fails.

`opencode-v2-self-test` authenticates directly to the fixed conversation server
without proxies or redirects and checks configured plugins and read-only rules.
It creates no model session or approval prompt and never prints the server
password or places it in arguments/environment variables. `opencode status` and
`opencode service status` are non-starting checks of that same server.

### CPU requirements

OpenCode is a Bun-compiled binary, so Bun's CPU floor applies: an x64 processor must support **SSE4.2** (the x86-64-v2 level — Intel Nehalem/2008 or newer, AMD Bulldozer/2011 or Jaguar/2013 or newer). Below that line every OpenCode binary exits immediately with `Illegal instruction (core dumped)` and no add-on setting changes it; the add-on detects this at start-up and says so in its log. ARM64 is unaffected.

The regular x64 build additionally requires **AVX2** (Haswell/2013 or newer), and the add-on falls back to OpenCode's *baseline* build when AVX2 is missing. Note that upstream currently publishes the regular AVX2 binary inside the baseline package ([anomalyco/opencode#33595](https://github.com/anomalyco/opencode/issues/33595)) — the two are byte-identical in the shipped versions, so baseline mode does not presently rescue a CPU without AVX2.

For x64 VM installs, make sure the guest can see AVX2 when the host supports it. Generic QEMU/KVM CPU models can hide AVX2 and force OpenCode's baseline binary unnecessarily.

## Native Home Assistant MCP Bridge (Beta)

Home Assistant has a native `llm` integration and native MCP endpoints for registered LLM APIs. PR [home-assistant/developers.home-assistant#3236](https://github.com/home-assistant/developers.home-assistant/pull/3236) documents the contract: every registered LLM API is exposed at `/api/mcp/<API ID>` once Home Assistant's MCP Server integration is set up. The built-in Assist API uses the API ID `assist`.

**Which Home Assistant version you need:** the `llm` integration, the per-domain LLM tool platforms, and the keyed `/api/mcp/<API ID>` endpoints all first ship in **Home Assistant 2026.8**. On 2026.7.x and earlier, Home Assistant serves only the configured `/api/mcp` endpoint and the legacy `/mcp_server/sse` transport. In every case the **MCP Server** integration must be added in Home Assistant first — the endpoints are not served otherwise.

When **Native Home Assistant MCP bridge (beta)** is on, the add-on adds a second OpenCode MCP server named `homeassistant_native` that forwards requests to the configured Home Assistant Core native endpoint through the Supervisor proxy. In V2, this uses a second authenticated sidecar route, keeping the Supervisor token out of inherited V2 environment, managed config, logs, and model context. The normal V2 server and allowed shell commands run as container root, so shell is trusted code and not an OS isolation boundary against root-owned runtime files. **Native MCP API ID** defaults to `assist`, which targets `/api/mcp/assist`. Set it to a custom API ID to test `/api/mcp/<your API ID>` for custom APIs registered inside Home Assistant. Leave it empty to target Home Assistant's configured `/api/mcp` endpoint instead.

### What you have to do

The bridge is **off by default**, and Home Assistant does not serve its MCP endpoints until you set the integration up. Two one-time steps, in this order:

1. **Add the Model Context Protocol Server integration in Home Assistant.** Go to **Settings → Devices & Services → Add Integration** and add **Model Context Protocol Server**. Until this exists, Home Assistant registers no `/api/mcp` routes at all and the bridge has nothing to talk to on any version.
2. **Turn on the bridge in the add-on and restart it.** Set **Enable native Home Assistant MCP bridge** to on in the add-on's Configuration tab, then restart the add-on. The setting is read once at start-up, so it does not take effect until the restart.

To confirm it worked, ask OpenCode to run `get_agent_capabilities`: it reports the detected Home Assistant version, bridge status, which endpoint resolved, and any upstream limitations that still apply. Use `homeassistant_native` only when the bridge status is `enabled_and_reachable`; a reachable endpoint with a disabled bridge is not exposed to OpenCode. In OpenCode you should then see a second MCP server named `homeassistant_native` alongside the built-in `homeassistant` one.

Nothing else is required. You do **not** need to change the API ID, set any environment variable, or supply an access token — the bridge authenticates with the Supervisor token. If you skip step 1, the bridge starts and every request fails with a 404, which `get_agent_capabilities` will report.

Once it is on, the bridge handles Home Assistant versions by itself and needs no further attention when you upgrade — including across the 2026.8 boundary, which it picks up without a restart.

Access model from Home Assistant Core: `/api/mcp` serves **every** LLM API selected in the MCP Server integration — that setting is a multi-select — and needs no admin access. `/api/mcp/<API ID>` narrows to one registered LLM API and requires admin access for every ID except the built-in Assist API.

That admin requirement is not a wall for this add-on. The Supervisor calls Home Assistant Core as its own system user, which Home Assistant creates in the admin group, so **any registered API ID is reachable from here** — which is what makes testing a custom LLM API from your own integration practical. If the bridge reports an unknown API ID, the ID does not exist; it is not an access failure.

The bridge adapts itself to what your Home Assistant actually serves:

- **Endpoint fallback.** If the keyed `/api/mcp/<API ID>` endpoint is not served — which is the case before 2026.8 — the bridge falls back to the configured `/api/mcp` endpoint and logs the reason once. It retries the keyed endpoint periodically, so upgrading Home Assistant to 2026.8 under a running add-on is picked up without a restart. If Home Assistant instead reports that the API ID is unknown, the bridge surfaces that error rather than silently serving a different API. Set `HA_NATIVE_MCP_ENDPOINT_MODE` to `keyed` or `configured` in **Environment variables** to pin one endpoint instead.
- **Tool schema repair.** Before Home Assistant 2026.8, tools whose parameters use validators such as `cv.string` produced a schema that strict MCP clients cannot compile; calls then failed with `extra keys not allowed @ data['__unparsedToolInput']`, which affected `GetLiveContext` in particular ([home-assistant/core#176762](https://github.com/home-assistant/core/issues/176762), fixed by [#176814](https://github.com/home-assistant/core/pull/176814)). The bridge repairs these schemas as they pass through. Set `HA_NATIVE_MCP_SANITIZE_SCHEMAS` to `0` to see the raw upstream schemas.
- **Malformed-message guard.** Every message is validated as JSON-RPC 2.0 before it is forwarded, because malformed POSTs to `/api/mcp` have been reported to crash Home Assistant Core ([home-assistant/core#176734](https://github.com/home-assistant/core/issues/176734)). This one is **not fixed in 2026.8** — the upstream fix is still open — so the guard applies on every version.

Run `get_agent_capabilities` to see what the running instance supports; it reports the detected version, the endpoint status, and any known upstream limitations that apply to it. OpenCode's regular `homeassistant` MCP server remains the supported tool surface either way.

The two MCP servers are intentionally separate:

- `homeassistant_native`: Home Assistant's curated native LLM API tools from the configured `/api/mcp/<API ID>` endpoint when available.
- `homeassistant`: OpenCode's add-on tools for configuration editing, validation, diagnostics, screenshots, updates, ESPHome, Zigbee, add-on development, and documentation lookup.

## Runtime and Interface

Choose `terminal` or `openchamber` in **Interface**, save and restart, then open
**OpenCode** from the Home Assistant sidebar. Both interfaces use the same
pinned V2 backend and session history through Home Assistant Ingress.
The server and terminal start from a root-owned project directory, so `.opencode`
content in `/homeassistant` is not discovered as project plugins. The root server
accesses HA files directly; the attached terminal runs as UID `60001`.

For large storage-mode dashboards, `hab_run` keeps its inline preview at 20,000
characters. If `meta.truncated` is true, `meta.full_output_path` is the complete
result in a private file under the runtime workspace. Use the agent's server-side
tools to inspect and transform that file before a whole-config dashboard write;
never save a reconstruction from the preview. Files older than 24 hours are
pruned on subsequent exports, and a container restart clears them.

OpenChamber is built from preview `2.0.0-preview.8`, source commit
`9fba129ddf968df1e5fb6916b84d3ceb35493198`. Its web package reports upstream
version `1.24.2`; the immutable source identifies this V2 preview. Its client
dependencies are independent of the app's backend pin.

The UI binds to `127.0.0.1:3010` behind the app's Ingress proxy. Its backend
credential stays in process memory, and it receives no Supervisor token. Stopping
the UI leaves the V2 backend running. Updates arrive through app images; the
preview cannot start or upgrade a separate backend. There is no V1 runtime selector.

Browser startup, shared history/policy and independent UI stop/start have passed
amd64 devcontainer acceptance. Full streaming/reconnect, provider/OAuth, UI editing
and ARM/HAOS qualification remain pending.

### Connecting a provider with browser sign-in

OpenChamber's **Usage** panel reads the same active V2
credential database as the managed backend, rather than retained V1 sign-ins.
OpenCode owns OAuth refresh. If Usage reports expired authorization after an idle
period, send a chat message and refresh Usage; reconnect OpenAI if chat also fails.
This warning concerns provider quota access, not saved conversation history.

New OpenChamber chats remember the last-used available model in that browser.
This takes precedence over the new-chat model defaults; those defaults are used
when no remembered model is available. The configured agent still applies, and
existing sessions keep their own selections.

In OpenChamber, select **ChatGPT Pro/Plus (browser)** to sign in with OpenAI.
The sign-in link opens a handoff page: continue to OpenAI, then, if the browser
cannot open the `localhost` callback, copy its full URL from the address bar
into the handoff page and select **Complete sign-in**. Return to OpenChamber;
it will finish connecting automatically. You can also use `/connect` in the
terminal and choose **ChatGPT Pro/Plus (headless)** for a device-code flow.
Other providers may have different callback requirements.

The first V2 activation migrates sessions but does not copy legacy V1 provider
credentials because the formats are incompatible. Authenticate each provider
once. Existing V2 credentials, including those copied by an earlier beta, are
preserved; reconnect providers that return HTTP `401`.

## Expose Read-Only MCP to Home Assistant

This optional server lets **Home Assistant use tools from this app**. It is the
opposite direction from the native Home Assistant MCP bridge and does not turn
OpenCode into a conversation agent. It works independently of local MCP enablement
and the conversation interface.
The private V2 MCP sidecar is unchanged and never advertised to Home Assistant.

Automatic app discovery requires [Core PR #180378](https://github.com/home-assistant/core/pull/180378),
merged into the **2026.10 development line** and absent from 2026.9.1. The expected
first stable release is 2026.10.0; verify the shipped Core release before relying
on discovery. Existing OpenCode functionality is unchanged on older versions.

### Setup

1. Enable **Expose read-only MCP to Home Assistant** (`ha_mcp_server_enabled`) and restart the app. The option is off by default. No Network port mapping is needed.
2. On a supporting Core version, confirm the discovered **Model Context Protocol** integration in **Settings > Devices & Services**. This is the MCP client integration, not **Model Context Protocol Server**.
3. Select the resulting LLM API in your compatible conversation agent. Discovery does not automatically enable tools in every agent.

**HTTP and HTTPS Home Assistant browser access both work.** New and previously
unprovisioned installations use trusted-host access: no OAuth client registration,
credential copying, callback configuration, or visit to a setup page is required.
Publication begins automatically after service readiness, even if the installed
Core does not yet support discovery. A supporting Core version is still needed
to show the discovery confirmation.

No MCP badge or link is added to the app UI. The optional administrator status
page remains at `/ha-mcp/` beneath the app's authenticated Ingress base URL; it is
not part of onboarding. On older MCP-capable Core versions, the endpoint shown
there can be used for manual client setup, but that does not test discovery.

Stable and beta have independent state and discovered APIs. Discovery-owned
API IDs are `mcp-<full-app-slug>`, remaining stable across reinstallations with the
same slug. An existing manually configured entry with the same URL is not
automatically converted to discovery ownership.

### Access and Lifecycle

The fixed catalogue contains `get_states`, `search_entities`, `get_entity_details`,
`get_home_context`, `get_areas`, `get_devices`, `get_calendars`, and
`get_calendar_events`. Listing and execution both enforce this allowlist. Calendar
ranges, request/result sizes, session counts, and execution time are bounded.
There is no shell, file editing, service control, update, log, template, screenshot,
or native-MCP forwarding tool. These reads are **installation-wide**, not limited
by Assist's exposed-entity settings, and can reveal occupancy or other private data.

The MCP listener uses **unencrypted internal HTTP** on port 8766. Trusted-host
mode accepts only the actual socket peer matching the host gateway reported by
Supervisor. Ordinary sibling containers and forged forwarding headers are
rejected, but **other host-networked apps and host processes can also read the
exposed data without credentials**. This is a network trust boundary, not unique
Core identity or per-user authorization. Enable it only on a trusted installation.
Do not publish or reverse-proxy this port. Port 8767 is loopback-only admin IPC.
The backend retains its privileged Supervisor token; the allowlist is not an OS
sandbox. HTTP browser traffic is unencrypted too; HTTPS remains preferable where
available, but is not required.

Disable the option and restart to close the listener and withdraw discovery;
failed Supervisor withdrawal is retried. Normal restarts preserve registration
and the chosen access mode. Removing only the HA integration does not close the
trusted-host listener; disable the app option to remove network access.
Supervisor publication means only that the announcement was accepted, not that
the user connected it. Uninstall cleanup depends on Supervisor reaching Core;
after an outage, remove any stale integration manually if necessary.

### Existing OAuth Installations

An already provisioned OAuth client is detected at startup and
**remains in OAuth mode**, including after disabling/re-enabling the option. It is
not silently converted to credential-free access. New/unprovisioned installations
use trusted-host mode automatically; malformed stored state fails closed.

Existing OAuth users retain client-secret authentication, 15-minute access tokens,
rotating 30-day refresh grants, and administrator consent. The retained setup page
at `/ha-mcp/` beneath the app's authenticated Ingress base URL allows credential
replacement. HTTP or HTTPS Ingress is
accepted with exact-origin CSRF checks; direct callbacks must use the exact HA
`/auth/external/callback` URL, or HTTPS My Home Assistant. Changing the external
origin/path requires reprovisioning and updating HA application credentials.
Reprovisioning revokes old grants; removing an approving user does not itself
revoke an issued grant. HTTP does not encrypt consent or OAuth codes.

## Zigbee2MQTT URL

The add-on discovers a running Zigbee2MQTT add-on automatically, so **Zigbee2MQTT URL** is only needed as a manual override. Set it to the same address and port you open the Zigbee2MQTT UI on, including the scheme — for example `http://192.168.1.20:8080`. Host/IP-only values are accepted and treated as `http://`.

## LAN Server Mode

Enable `enable_server` to serve an authenticated frontend on `4096`. It attaches
to the existing managed backend on loopback `4100`; it does not start a second
OpenCode instance. This is shared administrator access with the same sessions and
permissions as Ingress, not separate users or a read-only account.

| Option | Required setting |
| --- | --- |
| `lan_password` | A separate 16–256 character password, entered privately in app options |
| `lan_trusted_proxies` | Exact IP addresses of the nearest reverse proxy as seen by the app |
| `server_public_url` | Public HTTPS origin, for example `https://code.example.com` |
| `cors_origins` | Additional exact HTTPS browser origins, if needed; no wildcard |

Map `4096/tcp` for your reverse proxy. The proxy must terminate HTTPS, preserve
the public `Host`, overwrite `X-Forwarded-Proto` with `https`, and overwrite
`X-Forwarded-For` with the single connecting client's IP. It must not append an
untrusted incoming forwarding chain. If it sends `X-Forwarded-Host`, that must
match the public host too. Allow WebSocket upgrades and unbuffered SSE responses.
Restrict the mapped port to the proxy; forwarding headers alone do not authenticate
an untrusted socket peer. Direct HTTP/browser access to the mapped port is refused.

Use HTTP Basic authentication with username `opencode` and your **LAN password**
in compatible remote V2 clients. Keep the password in the client's private
credential settings, not a URL or command argument. The app's internal backend
credential is never distributed. Browser preflight does not authorize API calls;
every actual API request still needs authentication.

Save options and **restart the app** to activate or rotate LAN credentials. Invalid
enabled-LAN settings fail managed activation with an option-specific error. If
upgrading with an old enabled LAN option, configure these required settings or
disable LAN before starting. Leaving both LAN options disabled requires no LAN
configuration.

## OpenChamber LAN Web UI

Set `interface_mode: openchamber`, enable `enable_openchamber_lan`, and configure
`openchamber_public_url` plus the shared LAN password/proxy settings above. Point
your HTTPS proxy at mapped `4097/tcp`. Sign in using OpenChamber's native password
screen; enabling this mode also requires that login through HA Ingress.

To use the OpenChamber desktop or mobile app instead of a browser, also enable
`openchamber_lan_native_apps`, then add the server in the app using
`openchamber_public_url`. The app signs in from outside the page, so the strict
same-origin rule would otherwise refuse it. This option additionally accepts
requests without an `Origin` header (non-browser clients; browsers always send
one on writes) and OpenChamber's packaged app origins `openchamber-ui://app`,
`capacitor://localhost` and `https://localhost`, and passes through the CORS
headers OpenChamber returns for them. Other origins remain refused, and the
native password or paired-client token is still required. It has no effect on
the API frontend. The desktop app's "Home network only" pairing stays
unavailable because OpenChamber listens on loopback inside the app.

Native UI sessions and paired-client tokens are scoped to one app activation.
Every app restart, including a password change, invalidates them and closes
existing streams; sign in or pair again. Conversation history, UI settings and
provider credentials remain persistent. The editor LSP bridge and HA inbound-MCP
Ingress routes are not exposed on the LAN frontends.

## PPQ Private TEE Models (Beta)

Enable **PPQ private TEE models** and set the PPQ key privately in the app options.
The app starts the pinned proxy on internal loopback port `8787` and registers
native `ppq-private` models. Select one explicitly; enabling the option does not
switch existing sessions or override an explicit default model. The upstream PPQ
key stays with the proxy, not the V2 backend. Missing keys leave this provider
inactive with a warning; selecting a PPQ default without its prerequisites stops
activation with an actionable error.

| Model selection ID | Display name |
| --- | --- |
| `ppq-private/private/kimi-k2-5` | Kimi K2.5 (Private) |
| `ppq-private/private/deepseek-r1-0528` | DeepSeek R1 (Private) |
| `ppq-private/private/gpt-oss-120b` | GPT-OSS 120B (Private) |
| `ppq-private/private/llama3-3-70b` | Llama 3.3 70B (Private) |
| `ppq-private/private/qwen3-vl-30b` | Qwen3-VL 30B (Private) |

Controlled V2 tests verify routing to the local proxy endpoint. Startup does not
certify proxy readiness, upstream availability, encryption or private inference;
those require real PPQ acceptance before stable promotion.

## Zigbee diagnostics in V2

Use the full-profile `zigporter_run` MCP tool for commands such as `check` and
`inspect "Device Name" --json`. It supplies credentials inside the sidecar;
the agent shell does not inherit Home Assistant credentials. The packaged CLI
uses explicit service environment settings, skips interactive first-run setup,
and ignores project/global `.env` files. No credential file needs to be created.

`check` is migration preflight: missing Zigbee2MQTT configuration on a ZHA-only
installation is an incomplete migration prerequisite, not evidence that HA/ZHA
is broken. Z2M reachability checks do not prove authentication and never receive
the Supervisor token. The MCP tool retains its execution deadline and cancellation.

## Custom Providers and Configuration (Beta)

The **Custom OpenCode configuration** option accepts a JSON object, not JSONC or
V1 provider syntax. Supported root fields are `$schema`, `model`, `default_agent`,
`providers`, boolean `formatter`, `compaction`, `media`, `tool_output` and `websearch`.
Nested settings are checked against the pinned native V2 schema. Unsupported
fields and invalid values stop V2 activation for that boot, preserving the saved
options for correction. Managed permissions, agents, plugins, snapshots, LSP,
runtime selection and integration policy cannot be overridden here.

For example, configure `CUSTOM_API_KEY` privately in **Environment variables**,
then paste this JSON into **Custom OpenCode configuration**, replacing the example
endpoint and model ID with your provider's values:

```json
{
  "model": "custom/chat",
  "providers": {
    "custom": {
      "name": "Custom provider",
      "package": "@opencode/ai/providers/openai-compatible",
      "env": ["CUSTOM_API_KEY"],
      "settings": {
        "baseURL": "https://provider.example/v1",
        "apiKey": "{env:CUSTOM_API_KEY}"
      },
      "models": {
        "chat": { "modelID": "your-model-id", "name": "Custom chat" }
      }
    }
  }
}
```

Only documented built-in provider packages are accepted; external packages and
`{file:...}` substitutions are rejected. An explicit `{env:...}` reference must
resolve to a configured, nonempty supported key. Provider `env` declarations
without keys produce a warning so native account sign-in remains possible.

Backend environment forwarding currently supports uppercase, non-reserved
`*_API_KEY` variables only. HA, Supervisor, PPQ and managed-policy names are
reserved. Other variables retain separate shell/service handling and generate
a warning; cloud credential chains and general environment parity remain under
development. Ordinary provider keys are not isolated from backend subprocesses.
Do not paste keys into chat. Native `/connect` account setup remains available.

### External MCP servers

Use **External MCP configuration** for additional MCP servers. This is separate
from `opencode_config` so managed plugins and permissions remain locked. The
option accepts a JSON object with `servers` and optional ordered `permissions`.
External tools default to `ask`; later permission entries override that default.

During a 2.x upgrade, compatible legacy `mcp` and `permission` fields in the
add-on's `opencode_config` option are read automatically. Project-level files
such as `/homeassistant/opencode.json`, old sessions and provider authentication
are not imported. To migrate those servers, copy each supported definition into
**External MCP configuration**, move credential values to the MCP secrets
directory, and replace local `sh -c` wrappers with direct executable commands.
Reconnect provider accounts separately. After activation, move any automatically
imported definitions to this dedicated option at your convenience; configuring
both locations at once is rejected.

Remote headers other than `Accept`, `Content-Type`, `Host` and `User-Agent` must
use a `secret_file` descriptor with an optional non-secret `prefix`. Local values
under `environment` must reference a single-line file under
`/data/.config/opencode/mcp-secrets`. That directory must be root-owned `0700`;
each secret must be a root-owned, singly linked `0600` regular file. Local MCP
executables must be root-owned, singly linked `0755` regular files directly under
the root-owned `0755` `/data/.config/opencode/bin` directory. Each enabled local
server runs under its own unprivileged numeric identity with only a minimal
baseline and its explicitly declared environment. Put secret-file references in
`environment` and intentionally non-secret values in `literal_environment`.
Direct shell commands, symlinks and inherited provider keys are rejected or
removed; a secured executable may itself be an interpreter script. The numeric
identity and scrubbed environment are credential boundaries, not a filesystem or
network sandbox. A local server can still read files available to its identity,
including world-readable Home Assistant files, and can access the network. Only
install trusted local MCP executables.

```json
{
  "servers": {
    "infrastructure": {
      "type": "remote",
      "url": "https://mcp.example.test/mcp",
      "headers": {
        "Authorization": {
          "secret_file": "infrastructure-token",
          "prefix": "Bearer "
        }
      }
    },
    "metrics": {
      "type": "local",
      "command": [
        "/data/.config/opencode/bin/metrics-mcp",
        "--read-only"
      ],
      "environment": {
        "METRICS_API_TOKEN": "{file:/data/.config/opencode/mcp-secrets/metrics-token}"
      },
      "literal_environment": {
        "METRICS_URL": "https://metrics.example.test"
      }
    }
  },
  "permissions": {
    "infrastructure_*": "ask",
    "infrastructure_get_*": "allow",
    "infrastructure_list_*": "allow",
    "metrics_*": "allow"
  }
}
```

Server names may contain letters, digits, underscores and hyphens. `homeassistant`
and `homeassistant_native` are reserved. Remote URLs cannot contain credentials.
HTTPS is required unless `"allow_insecure": true` explicitly accepts plaintext
HTTP on a trusted private path; compatible legacy HTTP entries receive that flag
during migration. At most 16 servers and 512 permission entries are
accepted. Disable **Home Assistant MCP integration** only after removing every
external server; the same credential-isolated plugin owns both registrations. A
runtime error in an external definition, secret or executable is reported in the
log and skips the external registrations without removing the bundled Home
Assistant MCP servers.

### Web search selection

Set a search provider in **Custom OpenCode configuration** and configure its key
privately in **Environment variables**, then restart the app:

```json
{
  "websearch": { "provider": "tavily" }
}
```

| Provider | Configuration ID | Environment variable |
| --- | --- | --- |
| Exa | `exa` | `EXA_API_KEY` |
| Firecrawl | `firecrawl` | `FIRECRAWL_API_KEY` |
| Parallel | `parallel` | `PARALLEL_API_KEY` |
| Tavily | `tavily` | `TAVILY_API_KEY` |

Native `/connect` sign-in is also supported; selecting a provider does not create
credentials or confirm its availability. Use `"random"` to select from available
providers, or `"websearch": false` to remove the search tool. Omitting the setting
retains native provider selection. This changes search selection only; managed
permissions and the read-only agent's restrictions still apply. Provider-specific
URLs or keys inside `websearch` are not supported. A successful web fetch is not
evidence that search authentication, cancellation or upstream service access works.

## Startup Hooks (Beta)

**Add your own code to the app and keep it across updates.**

Everything inside the add-on container except `/data` and your Home Assistant configuration directory is rebuilt from the image every time the add-on starts. That is normally invisible — until you want to add something of your own, at which point it is not. This arrived as [issue #66](https://github.com/magnusoverli/opencode/issues/66), where [@ricardo-cabral-pt](https://github.com/ricardo-cabral-pt) built a working bridge that let Home Assistant's voice pipeline talk to OpenCode, and then had to rebuild it three times because every place he put it was erased: first a cache folder the add-on deletes at every start, then a service definition the container image restores, then the Python packages it depended on. The work was fine. The add-on kept throwing it away without saying so.

Startup hooks are the supported place to put it. Turn on **Startup hooks (beta)** in the Configuration tab and restart, and the add-on creates a `startup.d` folder in its own directory inside your Home Assistant configuration folder, seeded with a README and a worked example. Every `.sh` file you put there runs once, in filename order, each time the add-on starts.

Because the folder lives in your configuration directory rather than inside the container, you can edit hooks with File Editor, Samba or Studio Code Server — the tools you already have — and they survive restarts, updates and reinstalls.

This is deliberately a small contract. The add-on runs your scripts and stays out of the way; it does not validate them, supervise them, or restart anything they start.

### What people use this for

Four things that are hard or impossible without it. Each one is a complete hook — drop it in `startup.d` and it works.

**Keep a local git history of your configuration.** A snapshot at every add-on start, so "what did I change last week" has an answer.

```sh
#!/usr/bin/env bash
set -euo pipefail
cd /homeassistant

# Never commit secrets or Home Assistant's own internal state. This is written
# once; edit it afterwards and the hook leaves your version alone.
if [ ! -f .gitignore ]; then
    printf '%s\n' 'secrets.yaml' '.storage/' '.cloud/' 'ssl/' '*.key' '*.pem' \
        '*.db*' '*.log' 'tts/' 'backups/' 'deps/' '__pycache__/' > .gitignore
fi

# Settings passed per command rather than written to a global config file, so
# running this at every start cannot accumulate anything.
git_cmd=(git -c safe.directory=/homeassistant
             -c user.email=opencode@local -c user.name=OpenCode)

[ -d .git ] || "${git_cmd[@]}" init -q
"${git_cmd[@]}" add -A
if "${git_cmd[@]}" commit -q -m "config snapshot $(date -Iseconds)" >/dev/null 2>&1; then
    echo "Snapshot taken."
else
    echo "Nothing has changed since the last snapshot."
fi
echo "Browse it with: git -C /homeassistant log --oneline"
```

This stays on your machine. If you later add a remote, check `.gitignore` first — a pushed `secrets.yaml` is a bad day.

**Add a tool you want in every terminal session.** The container is rebuilt at each start, so anything you install by hand disappears. A hook reinstates it every time — here, a YAML linter:

```sh
#!/usr/bin/env bash
set -euo pipefail
VENV=/data/venvs/tools
[ -x "${VENV}/bin/yamllint" ] || {
    python3 -m venv "${VENV}"
    "${VENV}/bin/pip" install --quiet --upgrade yamllint
}
# /usr/local/bin is rebuilt at every start, which is why this is re-linked here.
ln -sf "${VENV}/bin/yamllint" /usr/local/bin/yamllint
echo "yamllint ready: yamllint /homeassistant/automations.yaml"
```

**Run a small service Home Assistant can call.** Anything Home Assistant can reach over HTTP becomes available to your automations through `rest_command`. This one needs no dependencies at all — it is Python's standard library:

```sh
#!/usr/bin/env bash
set -euo pipefail
APP=/data/refresher
PORT=9123

mkdir -p "${APP}"
if [ ! -f "${APP}/server.py" ]; then
    cat > "${APP}/server.py" <<'PY'
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            subprocess.run(["/usr/local/bin/ha-context", "refresh"],
                           check=False, timeout=60)
        except Exception as err:
            # Answer anyway. An unhandled error here becomes a 500 and a
            # traceback, and Home Assistant logs a failed rest_command.
            print(f"refresh failed: {err}", flush=True)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass  # keep the log for real problems only

HTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()
PY
fi

# Without this, every add-on start would leave another copy running and the
# second one would fail with "address already in use".
if pgrep -f "${APP}/server.py" >/dev/null 2>&1; then
    echo "Already running."
    exit 0
fi

setsid python3 -u "${APP}/server.py" "${PORT}" >/data/refresher.log 2>&1 </dev/null &
echo "Listening on $(hostname):${PORT} — its log is /data/refresher.log"
```

Then in `configuration.yaml`, using the hostname the hook printed:

```yaml
rest_command:
  opencode_refresh_context:
    url: "http://<the hostname>:9123/"
    method: post
```

**Bridge Home Assistant's voice pipeline to OpenCode.** A custom Wyoming bridge
can use the same venv/background-service pattern, but an existing V1 bridge needs
adaptation to V2's API. Use the managed client described below; the old unauthenticated
`127.0.0.1:4096` endpoint is unavailable.

### The rules

- A hook is a file ending in `.sh`. Rename it to anything else (`20-thing.sh.off`) to stop it running — there is no separate enable flag.
- Hooks run in filename order, so use a number prefix: `10-`, `20-`, `30-`.
- Each runs as `bash <file>`, as root. The executable bit is not needed, because files written over Samba usually lose it.
- **A hook must return.** It is killed after 15 minutes. Put `# opencode-hook-timeout: <seconds>` in the first 10 lines to change that, or `0` for no limit.
- A hook that fails is logged and does not stop the next one.
- Windows (CRLF) line endings are detected and worked around, with a warning.

### Anything that keeps running

A server started in the foreground is killed when the hook is. Detach it so it leaves the hook's process group, give it its own log, and check first so a re-run does not start a second copy:

```sh
if pgrep -f "/data/mybridge/server.py" >/dev/null 2>&1; then exit 0; fi
setsid /data/venvs/mybridge/bin/python3 -u /data/mybridge/server.py \
    >/data/mybridge.log 2>&1 </dev/null &
```

Nothing restarts it if it dies. The add-on is not a service manager.

### Dependencies that survive a restart

Only `/data` persists, so install into it.

**Python** — use a virtual environment and call it by full path:

```sh
[ -d /data/venvs/mybridge ] || python3 -m venv /data/venvs/mybridge
/data/venvs/mybridge/bin/pip install --quiet wyoming aiohttp
```

Do not use `pip install --user`: that path contains the Python version number, so it disappears the next time the add-on image moves to a newer Python. There is no compiler-headers package in the image, so prefer packages that publish wheels.

**Node** — `npm install --prefix /data/mybridge <pkg>`. Keep hook dependencies
separate from the app's image-managed packages.

Put your own files under `/data/<name>/`. Never `/data/.cache` — it is deleted on every start.

### Ports and reachability

Pick a port for your own service that the add-on is not already using. These are taken inside the container: `8099` (the interface behind Ingress), `3010` (OpenChamber), `4096` (OpenCode LAN server), `4097` (OpenChamber LAN), `4100` (private V2 server), `8787` (PPQ proxy). *Listening* on one of those from a hook breaks the add-on in a way that is hard to trace. **Connecting** to them is fine and expected — see below.

Your service is **not** reachable from your LAN. No port is mapped for it, and that is deliberate: a mapped port would put a service the add-on did not write, with no authentication in front of it, on your network.

It **is** reachable from Home Assistant Core and from other add-ons, at this container's hostname. Run `hostname` in the add-on terminal to see it — it differs between the stable and beta add-ons. That is what makes `rest_command`, a Wyoming service, or a custom integration endpoint work.

### Talking to the add-on itself

A hook can drive OpenCode through its own HTTP API, which is how the voice bridge in issue #66 works.

Use `opencode api` from an app root shell. It authenticates to the existing V2
server and never starts one. Startup hooks run before service readiness, so a
background bridge must wait until `opencode status` succeeds.

For Home Assistant itself, no extra option is needed: `SUPERVISOR_TOKEN` is already in the hook's environment and `http://supervisor/core` proxies to the Core API, so no long-lived access token is required.

```sh
# Home Assistant Core, through the Supervisor proxy
curl -fsSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    http://supervisor/core/api/config

# OpenCode's existing managed API (after service readiness)
opencode api GET /api/info
```

### Seeing what happened

| Command | Description |
|---------|-------------|
| `ha-hooks list` | What hooks exist, their digests, when each last ran and how it went |
| `ha-hooks run` | Run every hook now, without restarting the add-on |
| `ha-hooks run 20-thing.sh` | Run just one |
| `ha-hooks log 20-thing.sh` | What that hook printed |
| `ha-hooks log` | The whole last start-up sweep |

A hook's log is wiped at the start of each run, so anything you leave running in the background should write to its own file instead.

The add-on log names every hook it is about to run, with its size and digest, before running anything.

### If it goes wrong

Turn **Startup hooks (beta)** off and restart. Nothing in `startup.d` runs while it is off, so that always gets you back to a working add-on.

Hooks are also skipped automatically when the add-on restarts within a minute of the last hook run, which breaks the common case of a hook that crashes the add-on on every start. A hook that takes longer than a minute to reach the crash can still loop, so turning the option off is the reliable way out rather than the last resort.

### Security notes

- Hooks run as root with the add-on's environment, which includes the Supervisor token and any keys you configured. Their output can therefore contain credentials — do not use `set -x`, and read a hook log before pasting it into a bug report.
- Hook logs live in the add-on's private `/data/hooks/`, mode `0600`, and are excluded from backups.
- The `startup.d` folder is inside your Home Assistant configuration directory, which means anything else that can write there — File Editor, Samba, Studio Code Server — can add a hook. That is the trade for being able to edit hooks with the tools you already use. The option is off by default for exactly this reason, and the add-on log lists the digest of every file it runs.
- The beta and stable add-ons use separate folders, and neither runs the other's hooks.

## Reporting Issues

If you encounter problems, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the app logs (Settings > Apps > OpenCode > Log) in your report.
