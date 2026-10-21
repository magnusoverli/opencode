# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

Beta **3.2.4b4** is based on released **stable 3.2.3**, with pinned OpenCode `2.1.2`
and OpenChamber `2.5.0`, stable's desktop/mobile workspace recovery, and live PPQ
private-model discovery. The unrelated post-3.2.3 Zigporter compatibility patch
is not included. Beta keeps its own app identity and persistent storage; installing
beta does not transfer stable conversations or sign-ins. HA 2026.10 integration includes native LLM API discovery, prompt/context
forwarding and an experimental native Assist/AI data-task adapter. The roadmap
is tracked in [#45](https://github.com/magnusoverli/opencode/issues/45).

OpenChamber uses immutable commit `ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd`, built
with Bun `1.4.3` and the reviewed security lock. This beta refreshes the private-backend,
Git and translated update-notice patches and uses upstream's streaming-proxy fix.
This version fixes OpenAI browser sign-in for dynamic callback ports and first-time
client registration, and adds callback-free legacy device-code guidance in
OpenChamber. It retains parser-based safe-write validation, guarded global Markdown
agent imports and the opt-in for remote TTS/STT servers. Installed Supervisor
upgrade/rollback, real Wyoming/Piper/Whisper speech, public relay pairing and
account-backed encrypted inference remain unverified. Stable remains unchanged.

### Experimental native Assist and AI data tasks

The beta can act as a model backend for HA through the optional
[OpenCode Assist companion](rootfs/opt/opencode-assist/custom_components/opencode_assist/README.md).
**3.2.0b2:** the Supervisor-only setup below replaces the experimental manual
pairing used in **3.2.0b1**. Enable `ha_assist_enabled` and
restart the app to install it into HA's `custom_components` directory. It is off
by default. **Restart Home Assistant (Core) after installation or an update**;
restarting only the app cannot load the new code. A Core restart interrupts HA
and Assist temporarily; it is never triggered automatically.

**3.2.0b3:** setup includes a brief description beneath each
entity choice and explains that both types can be added, one at a time. After a
companion install/update, an HA notification provides the version and Core-restart
instructions. The app retries delivery if HA is unavailable and avoids repeating
delivered notices on app restarts. HA clears the notification on Core restart;
dismiss a delayed reminder if you already restarted after its installation time.

After restarting Core, open **Settings → Devices & services** and configure
the discovered **OpenCode Assist** app. Choose whether to create a conversation
agent or AI data task and confirm the connection; HA then opens model/API selection
automatically. **No URL or key needs copying.** Starting from **Add integration →
OpenCode Assist** uses the same Supervisor discovery flow.

**3.2.0b6** removes the redundant Assist setup header from both Ingress interfaces.
Use Home Assistant's discovered integration or **Add integration** for setup.
Companion **0.1.0b7** also includes the add-on icon and logo, served locally by HA.
Restart **Home Assistant Core** after the app updates the companion, then refresh
the integration page to load the branding.

API choices come from HA's current registry and default to none; select Assist
explicitly for home control. Select the resulting conversation entity in your
Assist pipeline, or the AI task entity for `ai_task.generate_data`. To add the
other type, open **Settings → Devices & services → OpenCode Assist** and use its
add-entity buttons (also in the existing app connection's overflow menu). Both
share the current pairing, with independent model settings. Starting **Add
integration** again attempts a second app connection. This is independent of the
app's outgoing native-MCP option.

**Voice needs separate speech engines.** OpenCode supplies the conversation
agent, not speech-to-text or text-to-speech. Empty speech selectors mean HA has
no suitable speech engines configured. Use Home Assistant Cloud, or install and
start **Whisper** and **Piper**, then add their discovered **Wyoming Protocol**
integrations in **Settings → Devices & services**. Select them alongside the
OpenCode conversation agent in **Settings → Voice assistants**. Whisper supports
open-ended conversations; Speech-to-Phrase is intended for a limited set of home
control commands. Assist text chat works without speech engines. See
[HA's local voice setup](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/).

**3.2.0b4:** the integration page now labels these buttons **Add
conversation agent** and **Add AI data task**; 3.2.0b3 omitted their translation
keys, leaving the add-entity controls unlabeled. Repeat setup now explains the
correct path and links to the existing integration. Once paired, the app's setup
page opens that integration directly instead of starting another connection flow.

**3.2.0b5:** each app connection allows one conversation agent and one AI data
task. Use **Configure** to edit an existing service. HA 2026.10 keeps the Add buttons
visible because the same type declaration also enables Configure; trying to add
an existing type shows guidance and creates no duplicate. Removing a service
allows it to be added again. Existing duplicates from earlier versions are retained.

The installer atomically installs or updates only an unmodified app-managed
copy. A manual installation (including the 3.2.0b0 ZIP) or edited files produce a
clear conflict in the app log and prevent Assist from starting. Back up and move
the conflicting directory out of `custom_components` before opting into app
management, then restart the app and Core. Disabling the option withdraws discovery
and stops the adapter, keeping installed files, pairing and HA configuration.
Code is bundled in the image, not downloaded at startup; the separate release ZIP
contains the same companion sources.

If setup reports an installation conflict, back up
`/homeassistant/custom_components/opencode_assist` (often shown as
`/config/custom_components/opencode_assist` in other HA tools), then move the
whole folder outside `custom_components`, for example into a backup folder in
the HA configuration directory. Remove any old manually paired OpenCode Assist
entry in HA; those experimental entries are not migrated. Restart the app with
`ha_assist_enabled` enabled, confirm successful installation in its log, then
restart Core and configure the discovered app. Review any local code changes
before reapplying them to an app-managed installation.

Supervisor discovery exchanges an expiring, single-use bootstrap token; HA creates
and stores its scoped pairing key, while the app persists only its digest. Ordinary
restarts and rediscovery preserve the pairing. Renew it through HA's reauthentication
or Reconfigure flow. Removing the integration revokes it when the app is reachable;
if removed while offline, the next confirmed setup replaces the old key. If no app
is discovered, check that Assist is enabled and its installation succeeded, restart
Core after companion updates, and retry when Supervisor and OpenCode are ready.

HA owns the ChatLog, caller context and selected tool execution. The adapter
streams model text and returns structured calls to HA in isolated disposable
sessions. Pairing is revocable and separate from inbound read-only MCP access.
Text and schema-validated JSON tasks are supported; images and attachments are
not advertised. Internal ports 8768/8769 must remain unpublished. The companion
README covers provider usage, pairing replacement, removal and data handling.

Contract tests use OpenCode 2.0.22 and actual HA 2026.10.0b0 ChatLog/config-flow
classes in the official HA image. Full supervised installation and Assist-pipeline
acceptance remain pending, as does crash-recovery retention qualification. A
worker/runtime crash can leave a temporary session behind.

**You can install this alongside the stable OpenCode add-on.** Both appear in the sidebar (as "OpenCode" and "OpenCode Beta").

What is separate: each add-on has its own storage, so sessions, credentials, the OpenCode binary and generated context never mix. Decision notes are separate too — beta keeps its at `/config/opencode_beta/decisions.yaml`, and copies your existing notes there once on first start so nothing is lost. Anything you record while testing beta stays out of your stable sessions.

Beta keeps its generated instructions inside the app and its decision notes in its own directory. It does not deploy the stable app's managed `AGENTS.md`. User-approved configuration edits still affect the shared Home Assistant configuration. If you previously ran beta on its own, it removes the `AGENTS.md` copy it left behind, unless you edited it or the stable add-on has since taken it over.

What is shared, because it is your Home Assistant configuration directory and both add-ons work in it: your actual configuration files, and `AGENTS.local.md` — your own instructions, which neither add-on ever writes and both always load.

The `4096`/`4097` ports listed under Network are *container* ports and do not clash between the two add-ons. If you expose both add-ons' LAN ports, give each a different host port.

## Upstream Attribution

This independent Home Assistant add-on redistributes and integrates
[OpenCode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode, under the
MIT License. It is not made by, affiliated with, or endorsed by the OpenCode
team or Anomaly. The complete OpenCode notice is included in the add-on image
at `/usr/share/doc/ha-opencode/NOTICE` and in this repository's
[`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md).

## Current Beta Changes

- **3.2.1b1 qualification**: Pins OpenCode CLI/plugin `2.0.26`, OpenChamber `2.2.0` and Puppeteer `25.13.0`. Upgrade tests include existing `2.0.22` generations. Qualification checks the versioned image installed through Supervisor, its actual image ID, production npm audits, `/data` temporary-directory regressions, and Chromium screenshots.
- **3.2.1b0 recovery qualification**: Validate the OpenCode 2.0.22 legacy-tool notice, repair migrated `/homeassistant` placement before first-startup activation, and recover an older generation's missing converter home. Recovery uses validated private copies; existing V1 data is retained. Beta and stable have separate storage, so installing beta does not import or repair stable history. Keep a Home Assistant app/data backup before testing an upgrade.
- **Opt-in relay reconnection**: `openchamber_relay_host` restores passive reconnection with LAN web UI disabled. LAN-enabled clients still expire at restart; see [OpenChamber Relay Hosting](#openchamber-relay-hosting).
- **Stable 3.1.0 baseline**: Includes stable's complete large-HAB-output exports, runtime-aware template validation, 32 GiB history-migration preflight and startup progress messages.
- **Native LLM API discovery**: `get_agent_capabilities` and `ha://agent/capabilities` query `llm/api/list` on each check, show registered IDs/names, and diagnose the configured selection without changing it. The development guide targets HA `2026.10.0b0`.
- **OpenChamber session creation fix**: Beta `3.0.0b19` fixes HTTP 400 errors when creating sessions or sending JSON requests through Home Assistant Ingress. A first message and free-model reply have been verified through the actual browser UI and Core Ingress.
- **Official V2 runtime**: Beta `3.2.0b6` pins the CLI and plugin to OpenCode `2.0.22` using the official `@opencode` packages.
- **Forward state upgrades**: Earlier V2 data upgrades through a validated private copy, preserving conversations, sign-ins and permissions. Successful upgrades remove obsolete generations; failed conversion preserves its input and reports an error. There is no application runtime fallback or rollback selector.
- **V2-only runtime**: Beta `3.0.0b18` runs one pinned OpenCode V2 server. V1 and the runtime selector have been removed. The server runs as root for Home Assistant filesystem compatibility; its attached terminal runs as UID `60001`.
- **Managed CLI**: `opencode` and `opencode2` address the same V2 server. `opencode status`, `opencode service status`, and `opencode api GET /api/info` inspect the existing server without starting another daemon.
- **YAML language assistance**: The `ha_yaml_*` tools provide credentialed HA diagnostics, completion, hover and definitions through a supervised language-server worker. Whole-file YAML formatting is opt-in.
- **Fresh V2 provider sign-in**: V1 sessions migrate into V2, but V1 provider credentials do not. Authenticate providers once with `/connect` in V2; the retained V1 credential remains untouched.
- **Native Home Assistant MCP in V2**: Enabling the optional native bridge adds `homeassistant_native` alongside `homeassistant`. The sidecar keeps the Supervisor token out of inherited V2 environment, managed config, logs, and model context. Because allowed V2 shell commands run as container root, they remain trusted code rather than an OS-isolated boundary.
- **Complete entity history**: `get_history` can page through every recorded state change as compact value/timestamp pairs and reports complete-window numeric summaries while preserving the bounded newest-200 default.
- **ESPHome 2026.8 support**: Device Builder migrations can be previewed as validated, hash-guarded candidates; structured DNS/mDNS/ICMP troubleshooting and bounded crash decoding are available; naturally completed log and job streams now finish immediately.
- **Startup hooks**: Your own `.sh` scripts, kept in your configuration directory, run once every time the add-on starts — the supported way to add a bridge or a small service without editing files inside the container, which never survives a restart. Off by default. See [Startup Hooks (Beta)](#startup-hooks-beta).
- **Home context**: Sessions now start knowing your installation. A generated **Install briefing** describes your setup (version, areas, entity counts, configuration layout, integrations), **decision notes** carry lasting decisions between sessions once you approve them, and `AGENTS.local.md` holds your own instructions where add-on updates cannot overwrite them. Both options default on and switch off independently. See [Home Context (Beta)](#home-context-beta).
- **OpenChamber V2**: The web interface is built from pinned release `2.1.0` source and its dependency lock. It attaches to the same app-owned V2 backend as the terminal, with independently supervised UI lifecycle and Ingress-adapted assets.
- **Home Assistant native tools**: Independently enabled on new installations, using HA's configured `/api/mcp` catalogue; upgrades preserve effective enabled/disabled state and migrate legacy Assist selections once.
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
- **Provider sign-in**: Real provider/OAuth flows in the new V2 preview still need qualification. See [Connecting a provider with browser sign-in](#connecting-a-provider-with-browser-sign-in).

## Startup and history troubleshooting

| Symptom | What to check |
| --- | --- |
| Custom configuration could not be prepared; sidecar inactive | Read the first `opencode_config` or `external_mcp_config` error. Correct that option and restart; the sidecar waits for successful configuration staging. Reinstalling is not required. |
| `opencode-container-init` rejects `/homeassistant` | The failure is before migration. The log now identifies a missing mount, a symlink/file, or the observed versus required numeric UID/GID. Include that metadata and your installation type in the report; do not recursively change configuration ownership. |
| `event_sequence_mismatch` on V1 conversion | Beta 3.2.1b0 accounts for the compatibility notice added by OpenCode 2.0.22. Let startup finish; if validation still fails, report the error and structural counts without sharing databases or credentials. Do not reset the database. |
| An older activated generation lacks `home` | Beta 3.2.1b0 reconstructs this converter directory in a validated private copy. Missing required state/database instead produces `missing_generation_state` or `missing_generation_database`; retain the data and report the error rather than creating an empty database. |
| Migrated sessions appear missing | Beta 3.2.1b0 places exact `/homeassistant` sessions in the managed UI project, including existing V2 upgrades. Other locations remain separate. Ctrl+A switches to all projects in the picker; Ctrl+O can search across locations. The pinned picker still lists at most 50 root sessions and does not paginate or list child sessions. |

### Custom agents

OpenChamber **Settings > Agents** saves global user agents persistently under
`/data/.config/opencode/agents/`. Saves and deletes succeed only after the managed
backend confirms activation. Existing Markdown definitions in `agents/`, `agent/`,
`modes/` and `mode/` are imported at startup; nested names such as `team/reviewer`
are supported. Manual file edits require an add-on restart; UI edits activate live.
Deleting a built-in agent override restores its native defaults.

Use native V2 frontmatter (`description`, `model`, `mode`, `hidden`, `disabled`,
`color`, `steps`, `request`, `permissions`) and put the system prompt in the
Markdown body. Limits: 64 agents, 64 KiB per file, 1 MiB total, four name segments.
Files must be regular, single-link files owned by root, with no group/other write
access; symlinks, YAML aliases/tags and file/environment substitutions are refused.
Invalid files are not imported, and a live refresh retains the last validated
definition rather than applying malformed content. If activation fails, the UI
attempts to restore the previous saved file without replacing a newer edit and
reports whether backend rollback was verified.

Managed Home Assistant and maintenance agents cannot be overridden. Sensitive-file
denials and required confirmations cannot be relaxed; stricter user denials remain
effective. Global JSON configuration/plugins and project `.opencode/agents` are
not imported, and project-scoped UI saves fail explicitly. This does not enable
OpenChamber's separate callback/tool integration. Use **Home Assistant Read Only**
for the add-on's supported audit policy.

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

Set **Restrict access to sensitive files** to `false` to remove the normal agent's sensitive-file read rules. The read-only agent retains its own restrictions. The supported native `opencode_config` subset is validated before activation and does not accept direct managed-policy overrides. Opting into [third-party plugins](#third-party-plugins-beta) loads trusted backend code that is not constrained by these tool permissions; see [Custom Providers and Configuration](#custom-providers-and-configuration-beta).

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
access is not enabled by this integration. Rendered live-HA completion and
diagnostic refresh passed on amd64; disabled-worker, ARM and HAOS qualification
remain part of the beta readiness plan.
The editor transport requires browser `Sec-Fetch-Site: same-origin` metadata to
validate requests across Ingress's TLS-terminating proxies. Use HTTPS (or a
localhost browser origin); browsers that omit this metadata, commonly on plain
HTTP LAN origins, receive an unavailable result rather than weakening the origin
check. Agent `ha_yaml_*` tools do not have this browser restriction.

Native `.yaml`/`.yml` edits preserve unrelated formatting by default. Enable
`yaml_formatting` to run pinned Prettier after edits, honoring `.prettierrc`.
An explicit `"formatter": false` in `opencode_config` disables every formatter;
explicit `"formatter": true` opts into YAML formatting as well and overrides
the add-on setting. Existing explicit preferences are retained on upgrades.
The targeted setting leaves other formatters and YAML diagnostics available.
Formatting does not reload Home Assistant or replace configuration validation.
The read-only agent denies edits and LSP dispatch.

### Terminal preferences

TUI Settings, favourites and recent-model/client state are stored privately in
this app's `/data/opencode-tui` and survive restarts and image updates. Stable
and beta have separate `/data` mounts. Existing ephemeral preferences are copied
when still available; files already lost by an earlier container replacement
cannot be recovered. The managed server configuration remains root-owned.
Persistent CLI preferences cannot enable custom TUI plugins.

## Desktop Browser Tools versus HA Screenshots

OpenCode's model-facing `browser` tools require a browser attached by the
OpenCode desktop app, as described in the [V2 Tools guide](https://opencode.ai/v2/docs/tools).
Opening OpenChamber through Ingress does not attach that desktop browser. The
packaged Chromium used by the optional HA `screenshot_url` tool is a separate
capability. Desktop-browser attachment to the beta app's managed server is not
yet qualified; do not expose a Chromium debugging port as a workaround.

For Home Assistant 2026.10 app pages, use `/app/<slug>` for the app UI and
`/config/app/<slug>/info` for its information page. Older `/hassio/ingress/...`
and `/hassio/addon/...` frontend paths can return 404. Use the path from the
current Home Assistant UI and its final direct internal origin.

### Beta dependency audit scope

Qualification audits the installed OpenCode, MCP, YAML LSP and PPQ npm trees,
plus OpenChamber's actual installed packages. The latter uses explicit security
overrides and a committed lock. The unpatched upstream `braces@3.0.3` advisory
has a tested vendor depth-limit mitigation and remains visible in reports;
it is not described as a zero-finding audit. See
[security patch provenance](rootfs/opt/openchamber/SECURITY-PATCHES.md).
OS packages and JavaScript embedded in browser bundles are outside these audits.

### Pasting dashboard screenshots

In **OpenChamber**, paste an image into the chat composer with Ctrl+V (Cmd+V on
macOS), or choose **Add attachment → Attach files** and select a saved screenshot.
Confirm that an attachment preview appears and choose a model that accepts images.
If pasting fails, report your browser/device, interface mode and whether file
attachment works. The **browser terminal** currently supports text paste only;
it does not transport clipboard images into the remote TUI. The optional HA
screenshot tool captures a page separately and does not enable image paste.

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

### Safe-write YAML preflight

`write_config_safe` parses YAML before checking automation, script and template
structures. Nested lists, multiline values, anchors/merge keys, package files and
inline `homeassistant.packages` no longer depend on regex block splitting. Standard
root `automations.yaml` and `scripts.yaml` also get their standalone checks;
arbitrary include-file layouts are not guessed from a basename.

Home Assistant references (`!secret`, `!env_var`, `!input` and `!include*`) remain
opaque during structural preflight: it never reads their files or values.
Malformed YAML, duplicate keys, invalid automation structures and unsafe alias
graphs block writing. Missing script sequences or template sensor states retain
their existing warning severity. Bounds are 1 MiB of source, 64 levels, 50,000
parsed/expanded nodes, alias expansion limited to 100, and fewer than 100 issues;
exceeding a bound blocks the write rather than silently truncating validation.

A passed dry run is **preflight only**, not proof that Home Assistant will load
the configuration. Template rendering, deletion protection, backup creation and
the post-write HA configuration check remain in place; a failed/unavailable HA
check restores the backup or removes a newly created file. Reload still requires
separate approval. Parser and mocked-HA tests do not replace installed HA
acceptance testing.

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

The beta Home Assistant MCP plugin obtains its caller credential from the V2
server's non-dumpable native bootstrap library. The credential broker still
delivers it once to the authenticated server process; subsequent plugin
activations copy it from process-owned memory. No caller credential is stored in
plugin options, written to the environment, or handed to shell subprocesses.

This replaces the earlier FD-3 handoff, which could fail on a second activation
with `EAGAIN: resource temporarily unavailable, read` after descriptor reuse
(#112). Reloads of the local plugin module also use the same native holder.
Updating requires a beta app restart so the matching native library and plugin
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

The beta app ships one certified OpenCode V2 runtime, installed at build time and
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

Home Assistant's MCP Server is **built into Core**: no separate download or add-on is needed, but it must be enabled. On **HA 2026.10+**, go to **Settings → System → AI** and enable **Model Context Protocol**. This sets up the existing MCP Server integration; it is not a new, separate server.

OpenCode's own bundled `homeassistant` MCP supplies configuration, validation, diagnostics and administration tools independently of HA's native server. The optional bridge adds `homeassistant_native`; it complements, rather than replaces, those bundled tools.

### Which URL in HA's AI settings?

**New installations use “Your MCP API” (`/api/mcp`) by default.** Startup persists and verifies native settings before activation. Upgrades retain effective enabled/disabled state, with the one-time selection migration below. The add-on builds the URL and authenticates through Supervisor; no URL or access token needs to be pasted.

| Entry in HA's MCP card | Endpoint | How it relates to this app |
| --- | --- | --- |
| **Your MCP API** | `/api/mcp` | Combines HA's selected LLM APIs. Choose `home_assistant` under **Native tool selection** (new-install default). |
| **Assist** | `/api/mcp/assist` | Choose `assist` for focused home-control and context tools; explicit choices are retained. |
| **Home Assistant Read-Only** (when enabled and connected) | `/api/mcp/mcp-<app-slug>` | This app's read-only tools made available through HA. Created by **Expose read-only MCP to Home Assistant**, the opposite-direction connection; not the native bridge's default target. |

On new HA 2026.10 MCP Server setups, **Your MCP API** exposes all registered LLM APIs by default, including APIs added later; older setups retain their selections. It can include the app's read-only API as well. A larger catalogue can mean more tools and overlap, but does not automatically grant unrestricted HA administration. Choose `assist` for focused home control or `home_assistant` for HA's combined selection. Save and restart after changes. See [Expose Read-Only MCP to Home Assistant](#expose-read-only-mcp-to-home-assistant) for the reverse connection.

Home Assistant has a native `llm` integration and native MCP endpoints for registered LLM APIs. PR [home-assistant/developers.home-assistant#3236](https://github.com/home-assistant/developers.home-assistant/pull/3236) documents the contract: every registered LLM API is exposed at `/api/mcp/<API ID>` once Home Assistant's MCP Server integration is set up. The built-in Assist API uses the API ID `assist`.

**Which Home Assistant version you need:** the `llm` integration, the per-domain LLM tool platforms, and the keyed `/api/mcp/<API ID>` endpoints all first ship in **Home Assistant 2026.8**. On 2026.7.x and earlier, Home Assistant serves only the configured `/api/mcp` endpoint and the legacy `/mcp_server/sse` transport. In every case the **MCP Server** integration must be added in Home Assistant first — the endpoints are not served otherwise.

When **Home Assistant native tools (beta)** is on, the add-on registers `homeassistant_native` independently of bundled tools and external MCP servers. An authenticated sidecar forwards to Core through Supervisor, keeping the Supervisor token out of inherited V2 environment, managed config, logs and model context. The normal V2 server and allowed shell commands run as container root, so shell remains trusted code, not an OS isolation boundary. Choose `custom` and enter **Custom native API ID** to select `/api/mcp/<ID>`; this field is ignored for other selections. Disabled bundled routes reject stale clients too. HAB remains available through `homeassistant_hab_run` only when bundled tools are on with the Full profile.

### What you have to do

Native tools are **on for new installations**, but Home Assistant does not serve MCP until you enable its server. Upgrades do not automatically turn on a previously disabled connection:

1. **Enable Home Assistant's built-in MCP Server.** On **HA 2026.10+**, go to **Settings → System → AI** and enable **Model Context Protocol**. If it is already enabled, do not add it again. On older versions, use **Settings → Devices & Services → Add Integration → Model Context Protocol Server**. Until the integration is set up, the bridge has nothing to talk to.
2. **Review the add-on settings and restart it.** Enable **Home Assistant native tools (beta)** (`native_ha_mcp_enabled`) if previously off. Choose `home_assistant`, `assist`, or `custom` under **Native tool selection** (`native_ha_mcp_selection`). Custom uses `native_ha_mcp_api_id`. Settings take effect at startup; native-only operation does not require bundled tools.

When bundled tools are enabled, `get_agent_capabilities` reports the detected HA version, native enablement, endpoint initialization probes and upstream limitations. With bundled tools disabled, check `homeassistant_native` in OpenCode's `/mcps` view instead. Initialization/connection alone does not prove catalogue loading or execution: verify an appropriate read-only native tool next. Native-only installations do not show `homeassistant`; this is intentional.

### Upgrade policy: Assist to HA-configured MCP

Startup identifies fresh versus legacy data before rewriting version markers,
journals the migration privately in `/data/.native-mcp-state.json`, saves settings
through Supervisor and verifies readback. Native settings intentionally have no
manifest defaults because Supervisor merges defaults into saved options. A fresh
installation resolves to enabled/`home_assistant`; unknown pre-existing data is
treated conservatively as legacy. Stable and beta have separate `/data` volumes.

The upgrade makes a **one-time** change for existing installations using the
old Assist selection (including the implicit default). It targets
**Your MCP API**, `/api/mcp` (without a trailing slash), reached through
`http://supervisor/core/api/mcp`. Custom API selections are not replaced.
Migration uses the effective selection after legacy endpoint overrides: a
custom override is preserved, while an Assist override is migrated even if a
different, unused API ID is stored in the options.

| Existing native setting | Migration result |
| --- | --- |
| API ID `assist`, or old implicit Assist default | HA-configured `/api/mcp`; native enabled/disabled state retained |
| Empty API ID, already following HA configuration | Stays on `/api/mcp`; enabled/disabled state retained |
| Custom API ID | Keeps the custom ID and existing endpoint/fallback policy; enabled/disabled state retained |
| Native disabled, including effective native-off because bundled MCP was disabled | Remains off; a legacy Assist selection is updated without enabling the connection |
| Explicit Assist/custom selection made after migration | Preserved on later restarts and updates; migration is not repeated |

**Scope implication:** `/api/mcp` follows the APIs selected in Home Assistant's
MCP Server configuration. It is not guaranteed to contain Assist and can expose
more or different tools than the old Assist-only endpoint. When **Expose all LLM
APIs** is enabled, APIs registered later can also appear. Review that selection
in HA before upgrading if you require a narrowly scoped catalogue. The upgrade
does not enable HA's MCP Server, change its selected APIs or **Require admin**
setting, enable reverse sharing, or automatically turn on a disabled native
connection. See the [official Home Assistant MCP Server documentation](https://www.home-assistant.io/integrations/mcp_server/)
for HA-side API selection and access settings.

You can deliberately select **Assist** again using **Native tool
selection** and restart the app; that explicit choice will be retained. The
custom API ID field is used only with **Custom**. A preserved legacy custom API
may retain its pre-existing fallback to `/api/mcp` on HA versions without keyed
endpoints; this upgrade does not introduce a new fallback or replace its saved
custom selection. Newly selected specific APIs use strict keyed endpoints.

Startup reports the verified Assist-to-configured change once. Persisted
selection becomes authoritative so consumed legacy endpoint overrides cannot
undo it on restart; `HA_NATIVE_MCP_ENDPOINT_MODE` is reserved from custom
`env_vars`. Custom compatibility is retained in the journal and retired when
the selection changes. No HA-side API configuration is modified.

If the journal, Supervisor save or readback fails, **native stays off for that
boot**, with a warning; ordinary bundled tools remain available. Interrupted
saves resume on restart. Observable concurrent edits are detected, but Supervisor
does not offer atomic compare-and-swap. An interrupted migration with conflicting
native edits requires review rather than overwriting the edit. Keep the private
journal with your app backup; do not delete it as routine troubleshooting.

**Rollback:** back up beta app data/options before upgrading. For an older beta,
restore that backup: older manifests do not understand `native_ha_mcp_selection`.
Do not copy beta's journal into stable or claim a downgrade preserves the new
settings automatically. Installed Supervisor upgrade acceptance remains a
separate qualification step; automated fixtures are not a live HA upgrade test.

### Finding and checking API IDs

On **HA 2026.9+**, the capability tool and `ha://agent/capabilities` resource also
query the admin-only `llm/api/list` WebSocket command through Supervisor. Each
check reads the current registry; no credentials or additional access token are
needed. The query works independently of whether the native bridge is enabled.

| Report field under `home_assistant.native_mcp` | Meaning |
| --- | --- |
| `api_discovery.apis` | Registered API IDs and display names in HA registration order; not a list of successfully tested MCP endpoints |
| `api_discovery.status` | `available`, `unsupported`, `unauthorized`, `timeout`, `unavailable`, or `invalid_response`; an unavailable list does not mean an API is missing |
| `selected_api.status` | `registered`, `unknown_api`, `not_checked`, or `configured_endpoint` when the saved API ID is empty |
| `configured_endpoint_status` | Separate initialization probe of the saved endpoint |

For an `unknown_api`, select `custom` and enter a returned ID in **Custom native API ID**,
save, and restart the app. Discovery never changes that option automatically.
On older HA releases or when `llm` is not loaded, discovery reports its limitation
while the existing endpoint probes remain available. Prefer `assist` for ordinary
home control; select custom APIs deliberately.

Nothing else is required. You do **not** need to change the API ID, set any environment variable, or supply an access token — the bridge authenticates with the Supervisor token. If you skip step 1, the bridge starts and every request fails with a 404, which `get_agent_capabilities` will report.

The configured selection follows HA's MCP configuration. Preserved legacy custom selections with fallback retry keyed endpoints periodically; newly selected Assist/custom APIs require HA 2026.8+ keyed support.

Access model from Home Assistant Core: `/api/mcp` serves the selected LLM APIs,
or every registered API when **Expose all LLM APIs** is enabled. Admin access
depends on **Require admin**. New HA 2026.10 MCP Server entries default to all
APIs and admin-only access; existing entries retain their selection and access
setting. `/api/mcp/<API ID>` serves one registered API and requires admin except
for `assist`. **The configured endpoint's selection does not restrict keyed
endpoints.** Adding another API later can broaden the configured endpoint when
the all-APIs option is enabled.

That admin requirement is not a wall for this add-on. The Supervisor calls Home Assistant Core as its own system user, which Home Assistant creates in the admin group, so **any registered API ID is reachable from here** — which is what makes testing a custom LLM API from your own integration practical. If the bridge reports an unknown API ID, the ID does not exist; it is not an access failure.

The bridge adapts itself to what your Home Assistant actually serves:

- **Endpoint policy.** `home_assistant` uses only `/api/mcp`. Newly selected Assist/custom APIs use only their keyed endpoint and never fall back to a broader catalogue. A preserved legacy custom API can retain its old fallback when keyed endpoints are not served, logging the reason and periodically retrying the keyed endpoint. Unknown API errors are surfaced, not replaced. Use **Native tool selection**, not a new endpoint-mode environment override.
- **Tool schema repair.** Before Home Assistant 2026.8, `GetLiveContext` used a schema that strict MCP clients could not compile, leading to `extra keys not allowed @ data['__unparsedToolInput']` ([home-assistant/core#176762](https://github.com/home-assistant/core/issues/176762), fixed by [#176814](https://github.com/home-assistant/core/pull/176814)). The bridge repairs that legacy unprefixed tool only. Modern and custom schemas, including required parameters and intentionally unconstrained unions, pass through unchanged. Set `HA_NATIVE_MCP_SANITIZE_SCHEMAS` to `0` to disable the repair.
- **Malformed-message guard.** Every message is validated as JSON-RPC 2.0 before it is forwarded, because malformed POSTs to `/api/mcp` have been reported to crash Home Assistant Core ([home-assistant/core#176734](https://github.com/home-assistant/core/issues/176734)). This one is **not fixed in 2026.8** — the upstream fix is still open — so the guard applies on every version.

Run `get_agent_capabilities` to see what the running instance supports; it reports the detected version, the endpoint status, and any known upstream limitations that apply to it. OpenCode's regular `homeassistant` MCP server remains the supported tool surface either way.

The two MCP servers are intentionally separate:

- `homeassistant_native`: Home Assistant's selected LLM API tools from `/api/mcp` by default on new installations, or a specific keyed Assist/custom endpoint when explicitly selected.
- `homeassistant`: OpenCode's add-on tools for configuration editing, validation, diagnostics, screenshots, updates, ESPHome, Zigbee, add-on development, and documentation lookup.

A native tool rejection must not trigger an automatic retry through the broader
administrative service tools. Native tool names are discovered from HA (for
example `homeassistant__GetLiveContext`), rather than assumed from older prompts.

### Native prompts and current context

Once `homeassistant_native` has connected and its catalog has loaded, use HA's
own prompt or request current context through the native tools:

| Surface | How to use it |
| --- | --- |
| Selected API prompt | Select its command in OpenCode; the built-in API appears as `/homeassistant_native:Assist`. Custom/combined API names come from HA and may be normalized by OpenCode. |
| Current home context | Ask OpenCode to use the native context tool advertised by the selected API. HA 2026.10 Assist uses `homeassistant__GetLiveContext`; OpenCode adds its server prefix. |
| Assist snapshot resource | Resource-capable clients can read `homeassistant://assist/context-snapshot` when HA lists it. APIs without the live-context tool do not expose it. In the pinned runtime, use the native context tool for model-driven reads. |

The bridge adds concise usage guidance at initialization and preserves HA's
instructions. It does not fetch or cache prompts, entity lists or snapshots at
connection time. Prompt retrieval and context reads remain on demand; refresh
context for a new current-state question. Content already included in a session
is a snapshot, not a live subscription.

Tool titles, annotations, required arguments and `isError` results are retained.
Annotations do not grant permissions: the app's read-only agent continues to deny
native tools. The bridge preserves supplied request metadata but does not invent
a room/device identity. Native errors should be reported rather than retried
through broader administrative tools.

Local candidate qualification uses the pinned OpenCode `2.1.2` process, the app's MCP
registration/forwarding code, and controlled HA/provider fixtures. It covers
prompt consumption, resource discovery, fresh native context calls, required
argument validation and read-only policy. Resource reads/cancellation also have
bridge-level tests. Live HA `2026.10.0b0`, UI resource-reader behavior and native
image acceptance remain release checks.

## Runtime And Interface (Beta)

Choose `terminal` or `openchamber` in **Interface**, save and restart, then open
**OpenCode Beta** from the Home Assistant sidebar. Both interfaces use the same
pinned V2 backend and session history through Home Assistant Ingress.
If `3.2.1b1` reports `session.prompt failed (400): Expected object`
in OpenChamber, update to `3.2.1b2`. Selecting `terminal`, saving and restarting
also provides a temporary workaround.
The error is caused by streamed prompt forwarding through the OpenChamber proxy;
it does not require resetting or migrating the session database.
The server and terminal start from a root-owned project directory, so `.opencode`
content in `/homeassistant` is not discovered as project plugins. The root server
accesses HA files directly; the attached terminal runs as UID `60001`.

For large storage-mode dashboards, `hab_run` keeps its inline preview at 20,000
characters. If `meta.truncated` is true, `meta.full_output_path` is the complete
result in a private file under the runtime workspace. Inspect and transform that
file before a whole-config dashboard write; never reconstruct from the preview.
Files older than 24 hours are pruned on subsequent exports, and container restart
clears them.

The beta bundles **hab 1.7.1**, pinned to source
`41edb473ebf2eab1502c3f3075a3b0c91ec0eff7`. Its `hab_run` tool accepts literal
`args` arrays as well as legacy `command` strings. It returns compact command
schemas and guide indexes on demand, defaults to JSON and preserves large
results up to a 16 MiB process-output bound. The default deadline is 60 seconds
(configurable to 120); a timeout or output-limit failure does not prove a
mutation failed to apply. Use read-back verification before retrying. Dedicated
ESPHome tools handle long-running firmware work.

Large artifacts retain the CLI envelope; extract the successful result's `data`
for a dashboard save. A CLI `--plan` can be a static preview, so inspect current
configuration and verify the applied result. Marketplace commands require HA
2026.11+. CLI updates are delivered with app updates.

OpenChamber is built from release `2.1.0`, source commit
`90726f9949da3408b2baf0f997e24bd71455946e`. Its web package reports upstream
version `2.1.0`; the immutable source identifies this release. Its client
dependencies are independent of the app's backend pin.

The UI binds to `127.0.0.1:3010` behind the app's Ingress proxy. Its backend
credential stays in process memory, and it receives no Supervisor token. Stopping
the UI leaves the V2 backend running. Updates arrive through app images; the
web interface cannot start or upgrade a separate backend. There is no V1 runtime selector.

Browser startup, shared history/policy and independent UI stop/start have passed
amd64 devcontainer acceptance. Full streaming/reconnect, provider/OAuth, UI editing
and ARM/HAOS qualification remain pending.

### Connecting a provider with browser sign-in

Starting with `3.2.0b6`, OpenChamber's **Usage** panel reads the active provider
credentials through the managed OpenCode API, rather than reading its database
directly. Retained V1 sign-ins are never used.
OpenCode owns OAuth refresh. If Usage reports expired authorization after an idle
period, send a chat message and refresh Usage; reconnect OpenAI if chat also fails.
This warning concerns provider quota access, not saved conversation history.

New OpenChamber chats remember the last-used available model in that browser.
This takes precedence over the new-chat model defaults; those defaults are used
when no remembered model is available. The configured agent still applies, and
existing sessions keep their own selections.

Connect OpenAI directly in **OpenChamber → Settings → Providers → OpenAI**;
there is no need to switch interfaces or restart the app:

- **Codex device code (legacy)** avoids localhost callbacks. Open the verification
  link, enter the displayed code, and approve access. Keep the OpenChamber sign-in
  screen open; it polls automatically and refreshes the provider after approval.
  This is the legacy Codex authentication route, not the newer ChatGPT sign-in;
  model availability and supported features may differ.
- **Sign in with ChatGPT** is the newer method. Its sign-in link opens the app's
  handoff page: continue to OpenAI and approve access. If the browser cannot open
  the localhost callback, copy its **full URL**, including all query parameters,
  from the address bar into the original handoff page and select **Complete
  sign-in**. OpenChamber detects completion automatically. The handoff supports
  this method's dynamic callback port and first-time client registration.
- **Codex browser (legacy)** also uses the handoff, but retains the older Codex
  browser authentication route. It is not silently substituted for ChatGPT login.

OpenAI login/consent remains necessary. The browser's localhost refers to your
own device, not the HA container; automatic redirects for the newer method need
upstream remote-hosted callback support. Do not edit the callback hostname or
forward its port. Callback URLs contain temporary authorization secrets: paste
them only into the matching handoff, never into chat, logs or issue reports.
Cancel abandoned attempts in OpenChamber and start again if a handoff expires.
OpenCode owns credential storage and token refresh for every method. Other
providers may have different callback requirements.

The first V2 activation migrates sessions but does not copy legacy V1 provider
credentials because the formats are incompatible. Authenticate each provider
once. Existing V2 credentials, including those copied by an earlier beta, are
preserved; reconnect providers that return HTTP `401`.

Upgrading from OpenCode `2.0.13` validates a private copy of the existing V2 state
before activation, preserving conversations, provider sign-ins and session permissions.

## Expose Read-Only MCP to Home Assistant

This optional server lets **Home Assistant use tools from this app**. It is the
opposite direction from the native Home Assistant MCP bridge and does not turn
OpenCode into a conversation agent. It works independently of local MCP enablement
and the conversation interface.
The private V2 MCP sidecar is unchanged and never advertised to Home Assistant.

Automatic app discovery ships in **Home Assistant 2026.10** ([Core PR #180378](https://github.com/home-assistant/core/pull/180378)) and is absent from 2026.9.1. Once connected, this app's API can appear as **Home Assistant Read-Only** under **Individual MCP APIs** on HA's **Settings → System → AI** page. This is not the Assist endpoint used by the native bridge by default. Existing OpenCode functionality is unchanged on older versions.

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

An already provisioned OAuth client from beta 3.0.0b11 is detected at startup and
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

## LAN Server Mode (Beta)

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

Compatible V2 clients use `/api/info` for server health. A client requesting
`/global/health` needs its exact build/protocol checked: allowing that path alone
would return the backend's HTML fallback, not a V2 health response.

Save options and **restart the app** to activate or rotate LAN credentials. Invalid
enabled-LAN settings fail managed activation with an option-specific error. If
upgrading with an old enabled LAN option, configure these required settings or
disable LAN before starting. Leaving both LAN options disabled requires no LAN
configuration.

## OpenChamber LAN Web UI (Beta)

Set `interface_mode: openchamber`, enable `enable_openchamber_lan`, and configure
`openchamber_public_url` plus the shared LAN password/proxy settings above. Point
your HTTPS proxy at mapped `4097/tcp`. Sign in using OpenChamber's native password
screen; enabling this mode also requires that login through HA Ingress.

To use the OpenChamber desktop or mobile app instead of a browser, also enable
`openchamber_lan_native_apps`, then add the server in the app using
`openchamber_public_url`. The app signs in from outside the page, so the strict
same-origin rule would otherwise refuse it. This option additionally accepts
requests without an `Origin` header, as used by the desktop login process,
and OpenChamber's packaged app origins `openchamber-ui://app`,
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

## OpenChamber Relay Hosting

Set `interface_mode: openchamber` and enable `openchamber_relay_host` to let the
managed instance automatically reconnect to its configured relay when an active
relay-paired client or pending pairing needs it. The default endpoint is the
third-party service `wss://relay.openchamber.dev/ws`. With LAN web UI disabled,
relay identity and pairing records persist in `/data/.config/openchamber`, so
paired devices can reconnect after app restarts and updates without pairing again.

**LAN web UI limitation:** when `enable_openchamber_lan` is enabled, client
authentication remains scoped to one app activation. Clients must pair again after
a restart, even with relay hosting enabled. This option does not change LAN cookie,
password-rotation or paired-token expiration behavior.

The option defaults to `false`, disabling passive hosting; explicitly creating a
relay pairing can still start hosting through OpenChamber's existing behavior.
There is one managed OpenChamber server. The LAN service proxies to it rather than
running a second relay host; the upstream `relay-host.lock` protects its identity
from competing local hosts. Environment scrubbing and the non-dumpable preload
remain in place, but do not restrict outbound network destinations.

## OpenChamber Custom Speech Servers

With `interface_mode: openchamber`, enable `openchamber_allow_remote_speech` and
**restart the app** to use a trusted custom OpenAI-compatible server for
text-to-speech (TTS), speech-to-text (STT), or both. The option defaults to `false`;
leaving it disabled preserves upstream's local-host restriction.

Then enter the server URL, model, voice and any required speech API key in
OpenChamber's voice settings. For a speech gateway in another Home Assistant app,
use its internal DNS name and container port, for example
`http://<gateway-app-dns-name>:8555/v1/`. Requests originate from OpenChamber's
container, not your browser. This does not require enabling the LAN web UI,
publishing a new port, a startup-hook proxy, or forwarding general `env_vars`.

**Trust and privacy:** this permits arbitrary HTTP(S) speech destinations, not
only Home Assistant apps or your LAN. Those servers receive the text/recordings
you submit and any speech credentials configured for them. HTTP does not encrypt
that traffic. The option does not restrict speech to a private/TEE model provider.
URL-embedded credentials and non-HTTP(S) schemes remain rejected, and upstream
enterprise restrictions still apply. Managed service bindings, authentication,
environment isolation and backend credentials are unchanged. General
OpenChamber environment-variable passthrough is intentionally unsupported.

Microphone capture still requires browser/device permissions and a secure UI
context (normally HTTPS); this option does not bypass those requirements. The
upstream speech path has been exercised with a synthetic server; actual
Wyoming/Piper/Whisper playback and recording remain to be qualified.

## PPQ Private TEE Models (Beta)

Enable **PPQ private TEE models** and set the PPQ key privately in the app options.
The app starts its private-only proxy on internal loopback port `8787` and discovers
native `ppq-private` models from PPQ's public live catalog. Select one explicitly; enabling the option does not
switch existing sessions or override an explicit default model. The upstream PPQ
key stays with the proxy, not the V2 backend. Missing keys leave this provider
inactive with a warning; selecting a PPQ default without its prerequisites stops
activation with an actionable error.

With the key configured in the app options, use `/models`, not `/connect`: the
upstream key belongs to the private proxy. Beta 3.2.4b1 fixes the misleading
`Missing key ... cost ... cache` error in the model-list/API-key dialog. Existing
catalog caches are upgraded in memory; no manual deletion or key re-entry is needed.

Published input, output and cache token prices are retained. Missing cache rates
use ordinary input pricing as an estimate, not a free discount; models without
overall pricing remain unknown rather than advertised as free. Actual PPQ billing
is authoritative. Every registered model is validated against the pinned native
OpenCode schema before being exposed to the UI.

Search `/models` for **PPQ** and select a currently listed private model. IDs keep
the form `ppq-private/private/<model-id>`; the app does not maintain a fixed list
or silently replace retired models in existing sessions or explicit defaults.
An unavailable explicit default remains labeled **Unavailable** so OpenCode
cannot silently fall back to a non-private provider; choose a current model.

The proxy refreshes the catalog every ten minutes on demand; OpenCode checks it
every minute. Temporary catalog outages use a validated on-disk cache for at most
24 hours, with a warning. Without a usable catalog, models remain unavailable and
discovery retries automatically. The local `/v1/models` endpoint and inference
validation use the same catalog. Successful empty catalogs remove retired models.

Only `private/*` chat models marked end-to-end encrypted by PPQ are eligible.
Matching public Tinfoil metadata supplies tool/image capabilities where PPQ omits
them; otherwise defaults are conservative (text only, no advertised tools).
Catalog requests contain no credentials or prompts. Inference uses the pinned
Tinfoil SDK's attested encrypted transport, never PPQ's ordinary inference API.

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

The **Custom OpenCode configuration** option accepts a JSON object, not JSONC.
Supported native root fields are `$schema`, `model`, `default_agent`,
`providers`, boolean `formatter`, `compaction`, `media`, `tool_output` and `websearch`.
Nested settings are checked against the pinned native V2 schema. Unsupported
fields and invalid values stop V2 activation for that boot, preserving the saved
options for correction. Direct permissions, agents, snapshots, LSP, runtime
selection and integration policy overrides are unsupported here. Native `plugins`
entries are accepted only when **Enable third-party plugins** is on; otherwise
they are ignored without changing the saved options. See [Third-party plugins](#third-party-plugins-beta).

Supported legacy `provider` entries are converted in memory at startup, without
rewriting saved options: `npm: "@ai-sdk/openai-compatible"` uses the built-in V2
compatible runtime, `options` becomes `settings` (with `headers` and `body`
separated), and `api` becomes `settings.baseURL`. Model `id`, `tool_call`,
`modalities`, token limits, cache pricing and variant maps are retained in their
V2 forms. Built-in provider overlays may omit `npm`. Other legacy packages or
unsupported model fields require explicit native conversion; no arbitrary npm
provider code is loaded. Keep each entry entirely legacy or native, and do not define the
same provider in both maps. The converted result must pass all native schema,
credential and managed-policy checks.

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

### Third-party plugins (Beta)

**Enable third-party plugins** (`custom_plugins_enabled`) is **off by default**.
This is a thin opt-in to [upstream OpenCode V2 plugin loading](https://opencode.ai/v2/docs/plugins),
not an add-on plugin manager or a promise of compatibility with any particular
plugin, including Magic Context. The add-on does not curate packages, install
plugins itself, or implement an updater.

Enable the option, add native V2 `plugins` entries to **Custom OpenCode
configuration**, save and **restart the app**. Merge this into your existing
JSON rather than replacing unrelated settings:

```json
{
  "plugins": [
    "opencode-example-plugin@1.2.0",
    {
      "package": "/data/plugins/my-plugin",
      "options": { "enabled": true }
    }
  ]
}
```

The package and local path above are illustrative; choose a real V2-compatible
plugin and follow its documentation. Native string/object entries, package
specifications, options and enable/disable selectors pass through to upstream
after the bundled entries. Upstream's loader owns installation, caching,
version checks, reloads and errors. Exact versions/commit pins are recommended;
unpinned versions follow the bundled upstream runtime's behavior. Changing the
saved package specification and restarting is the durable way to select a new
version. The add-on does not update or pin it for you, and an app upgrade can
change upstream compatibility or loader behavior.

**Configuration and persistence:** saved add-on options survive restarts and
updates and regenerate `/run/opencode-v2/managed.json` at every start. Edits to
generated `/run` configuration are not durable; do not rely on an upstream CLI
installer/setup wizard changing another config file to register your plugin.
Project config/discovery restrictions remain unchanged: placing a plugin under
`/homeassistant/.opencode/plugins` does not enable it. Configure local plugins by
absolute paths under a persistent directory such as `/data/plugins/my-plugin`;
relative paths resolve from the generated configuration, not `/homeassistant`.
The backend's XDG cache root is persistent `/data/v2/cache`; upstream owns the
package-cache layout. This cache is excluded from backups and can be rebuilt. Plugin-specific configuration
and data must use persistent paths supported by that plugin. The server's HOME
and config directory are under temporary `/run`; do not assume a plugin's
default settings or memory files there will survive. No plugin-specific storage
migration or recovery is provided. Client/TUI-only plugin configuration is
separate and is not enabled by this backend option.

**Trust and support:** third-party plugins execute as **root-level code inside
the backend**, not as sandboxed AI tools. Tool permissions, sensitive-file read
restrictions and the read-only agent do not constrain direct plugin code. A
plugin can read files/credentials, access the network, retain or transmit home
data, change behavior or policy, and interfere with bundled context/MCP/LSP
plugins. Upstream selectors can also disable bundled entries. Background model
calls may add costs. Only enable code you trust; plugin-specific compatibility,
privacy, updates and behavior are your responsibility. Generic plugin loading
does not mean any particular third-party plugin has been tested by this add-on.

**Recovery:** turn **Enable third-party plugins** off in the Home Assistant app
options, save and restart. Saved `plugins` entries are ignored before their
validation/loading, even if an entry is malformed, and are not deleted. Bundled
plugin entries are generated normally. This bypasses custom loading, but cannot
undo files, data or other changes a plugin already made. Invalid JSON or unrelated
invalid configuration still needs correction. Reproduce add-on issues with this
option off before reporting them; report plugin-specific failures upstream.

### Lemonade Server (local models)

[Lemonade Server](https://github.com/lemonade-sdk/lemonade) serves an
OpenAI-compatible API. It does not need a `/connect` sign-in or an API key when
your server is unauthenticated. In **Custom OpenCode configuration**, use the
following JSON, replacing the address, model ID, and example model capabilities
and limits with your server's actual values:

```json
{
  "model": "lemonade/your-model-id",
  "providers": {
    "lemonade": {
      "name": "Lemonade Server",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://192.0.2.10:13305/v1" },
      "models": {
        "your-model-id": {
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 65536, "output": 8192 }
        }
      }
    }
  }
}
```

Find the exact installed model ID at Lemonade's `/v1/models`. The add-on runs
in a container, so `localhost` in `baseURL` means the add-on, **not** the PC
running Lemonade. Lemonade defaults to `localhost:13305`; make it reachable on
a trusted private network and use that host's address (with `/v1`). Do not
expose an unauthenticated server to the public internet. If you enabled
authentication, add `"apiKey": "{env:LEMONADE_API_KEY}"` under `settings` and
set `LEMONADE_API_KEY` privately in the add-on's **Environment variables**;
otherwise omit both. Do not set `tools: true` unless the selected model
supports tool calls, and use its real context/output limits rather than the
illustrative values above.

For smaller local models, consider **MCP tool profile → compact** in the add-on
options, then restart. It reduces the prompt and limits Home Assistant MCP
tools to read-only diagnostics; choose `configuration` or `full` if you need
their additional tools. Set an effective model context window of at least 64K
to avoid truncating tools and instructions (see [MCP Tool Profiles](#mcp-tool-profiles)).

### External MCP servers

Use **External MCP configuration** for additional MCP servers. This is separate
from `opencode_config` so MCP registration and tool permissions remain explicitly
configured; it does not enable third-party plugins. The
option accepts a JSON object with `servers` and optional ordered `permissions`.
External tools default to `ask`; later permission entries override that default.

During a 2.x upgrade, compatible legacy `mcp` and `permission` fields in the
add-on's `opencode_config` option are read automatically. Project-level files
such as `/homeassistant/opencode.json` are not imported by this MCP option.
Conversation history has its own validated migration; V1 provider credentials
are not imported. To migrate project-defined servers, copy each supported definition into
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
accepted. External servers can remain enabled when **Home Assistant MCP
integration** is disabled; external-only registration does not acquire the Home
Assistant sidecar credential. The same plugin owns these independent registrations. A
runtime error in an external definition, secret or executable is reported in the
log and skips the external registrations without removing the bundled Home
Assistant MCP servers. A Home Assistant credential failure likewise does not
remove successfully registered external servers.

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

**New in this beta: you can add your own code to the add-on, and it survives.**

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

If you encounter problems with the beta, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the add-on logs (Settings > Add-ons > OpenCode Beta > Log) in your report.
