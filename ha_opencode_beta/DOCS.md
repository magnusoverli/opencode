# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

**You can install this alongside the stable OpenCode add-on.** Both appear in the sidebar (as "OpenCode" and "OpenCode Beta").

What is separate: each add-on has its own storage, so sessions, credentials, the OpenCode binary and generated context never mix. Decision notes are separate too — beta keeps its at `/config/opencode_beta/decisions.yaml`, and copies your existing notes there once on first start so nothing is lost. Anything you record while testing beta stays out of your stable sessions.

The beta add-on does not write to your configuration directory at all beyond its own notes. In particular it no longer deploys `AGENTS.md` there — that file belongs to the stable add-on, and beta keeps its own copy inside the add-on instead. If you previously ran beta on its own, it removes the copy it left behind, unless you edited it or the stable add-on has since taken it over.

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

- **OpenCode V2 terminal cutover**: Beta `3.0.0b8` uses OpenCode V2 `0.0.0-beta-18684` for the terminal by default. For broad HAOS compatibility, the server runs as root and edits `/homeassistant` directly, matching the proven V1 filesystem model. Its attached TUI still runs separately as UID `60001`. Certified V1 `1.18.25` remains available through the **OpenCode runtime** option.
- **Fresh V2 provider sign-in**: V1 sessions migrate into V2, but V1 provider credentials do not. Authenticate providers once with `/connect` in V2; the retained V1 credential remains untouched.
- **ESPHome 2026.8 support**: Device Builder migrations can be previewed as validated, hash-guarded candidates; structured DNS/mDNS/ICMP troubleshooting and bounded crash decoding are available; naturally completed log and job streams now finish immediately.
- **Startup hooks**: Your own `.sh` scripts, kept in your configuration directory, run once every time the add-on starts — the supported way to add a bridge or a small service without editing files inside the container, which never survives a restart. Off by default. See [Startup Hooks (Beta)](#startup-hooks-beta).
- **Home context**: Sessions now start knowing your installation. A generated **Install briefing** describes your setup (version, areas, entity counts, configuration layout, integrations), **decision notes** carry lasting decisions between sessions once you approve them, and `AGENTS.local.md` holds your own instructions where add-on updates cannot overwrite them. Both options default on and switch off independently. See [Home Context (Beta)](#home-context-beta).
- **OpenChamber interface mode**: New experimental `openchamber` interface mode starts the OpenChamber web UI behind Home Assistant Ingress, while the default `terminal` mode keeps the existing ttyd terminal unchanged.
- **Native Home Assistant MCP bridge**: Optional bridge from OpenCode to Home Assistant Core's native LLM MCP endpoint (`/api/mcp/<API ID>`, default `assist`) for testing the new native LLM/MCP platform when the running Home Assistant version supports it.
- **Compact Home Assistant context**: New `get_home_context` MCP tool gives agents focused area/domain/entity context with area and device metadata instead of broad state dumps.
- **Native LLM provider development guide**: New `get_ha_llm_development_guide` MCP tool helps custom integration authors build `<integration>/llm.py` tool providers aligned with Home Assistant's upstream architecture.
- **Serial device access**: Selected host UART/serial devices can be mapped into the add-on for USB flashing and adapter inspection workflows. Full Supervisor `uart` and `udev` manifest flags remain disabled by default because they are static permissions, not runtime user options.
- **Optional LAN server mode**: You can now enable an OpenCode server bound to `0.0.0.0` so other computers on your local network can connect directly.
- **Optional OpenChamber LAN web UI**: When using OpenCode V1 with `interface_mode: openchamber`, you can optionally publish OpenChamber on a mapped LAN port (`4097/tcp`) at the root path `/` for reverse proxies and tunnels.
- **LAN server CORS origins**: The LAN server can now allow-list specific browser origins (`--cors`), so browser-based OpenCode clients — not just the CLI — can connect to it directly. See [LAN Server Mode (Beta)](#lan-server-mode-beta) below.
- **PPQ private TEE models**: Opt-in encrypted proxy for PPQ private models running in remote TEEs. The proxy is internal-only and binds to `127.0.0.1` inside the add-on container.
- **Web terminal clipboard fixes**: Copying inside OpenCode now reaches the browser clipboard, plain `Ctrl+V` paste works, and macOS users can use `Option+drag` to select text while full-screen terminal apps capture the mouse.
- **Touch scrolling**: One-finger vertical drag gestures inside the terminal now scroll full-screen apps such as OpenCode on phones and tablets.
- **Certified OpenCode runtime**: The add-on ships one pinned, tested OpenCode build and always runs it. The `OpenCode update policy` option is gone, and no start-up path installs anything from npm. See [OpenCode Updates](#opencode-updates).
- **Home Assistant skills**: The detailed procedures — YAML work, troubleshooting, dashboards, Zigbee/ESPHome, development — now ship as OpenCode skills that are loaded only when the task needs them, instead of being pushed into every request. `AGENTS.md` keeps the consent and safety rules, which are always in force. See [Home Assistant Skills](#home-assistant-skills).
- **Read-only session**: Run `ha-readonly` for a session that can inspect and diagnose your installation but cannot change it — no file edits, no shell, no service calls, no configuration writes. Your normal OpenCode session is unchanged. Requires `interface_mode: terminal`. See [Read-Only Session](#read-only-session).
- **Sensitive file protection**: New **Restrict access to sensitive files** option (default on) denies the AI read access to `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, and `*.key`/`*.pem` files so their contents can't reach the model. Set it to `false` to restore fully unrestricted file access. See [Sensitive File Protection](#sensitive-file-protection).
- **Focus-friendly responses**: Optional action-first, concise, progress-aware response guidance for users who find long or unstructured responses difficult to act on. Disabled by default and available in both terminal and OpenChamber modes.
- **Browser provider sign-in in OpenChamber**: Providers whose browser OAuth method redirects to a loopback address (for example **ChatGPT Pro/Plus (browser)**) can now be connected from the OpenChamber UI. See [Connecting a provider with browser sign-in](#connecting-a-provider-with-browser-sign-in).

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

**To restore the previous, fully-permissive behavior,** set **Restrict access to sensitive files** to `false` and restart. You can also fine-tune paths via **Custom OpenCode configuration** using OpenCode's [permission rules](https://opencode.ai/docs/permissions/).

**Scope/limitation:** this guards OpenCode's file-read tool (the common accidental-exposure path). It does **not** restrict shell commands, so an explicit `cat secrets.yaml` can still read the file — treat it as a strong guardrail, not a hard sandbox.

## Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode configuration** if you need OpenCode's built-in snapshot/undo behavior.

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

## Read-Only Session

> **Requires `interface_mode: terminal`.** `ha-readonly` is a terminal command, and in `openchamber` mode the add-on does not start a terminal — so in that mode it is not available. There is no OpenChamber equivalent: OpenChamber drives one managed OpenCode server with one configuration, and a read-only *option* on that server would change your normal session rather than sit beside it, which is exactly what this feature avoids.

Sometimes you want to understand something, not change it. Run this in the terminal:

```
ha-readonly
```

This starts OpenCode with the `home-assistant-read-only` agent under a configuration overlay that:

- denies file edits, shell commands, subagents, and the LSP tool
- forces the Home Assistant MCP server into its `compact` profile, so service calls, configuration writes, updates, firmware, screenshots, `hab` and `zigporter` are not merely discouraged — they do not exist, and are rejected by the server even if something asks for one
- switches off the native Home Assistant MCP bridge, whose tools the profile does not filter
- denies reading `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, `*.key` and `*.pem` **regardless** of the **Restrict access to sensitive files** setting

Everything else is unchanged: the same provider, the same model, the same instructions, the same view of your configuration directory. The session ends with findings and a recommendation; exit and run `opencode` when you want to act on it.

There is no option to turn this on. It is a separate command, so your normal session keeps every capability it has today. `ha-readonly --print-config` prints the exact configuration the session runs under, if you would rather check than trust.

## MCP Tool Profiles

The built-in `homeassistant` MCP server can expose a narrower capability set through **MCP tool profile**. This changes the tool definitions supplied to the model and rejects hidden MCP calls before they reach Home Assistant; it does not change OpenCode filesystem access, terminal commands, or permissions. Restart the add-on after changing it.

| Profile | Includes | Excludes |
|---------|----------|----------|
| `compact` | Read-only entity state, history, diagnostics, templates, calendars, home context, and bounded Supervisor operations evidence | Config writes, device control, updates, screenshots, `hab`, and Zigbee administration |
| `configuration` | Everything in `compact`, plus current docs, syntax checks, validation, safe config writes, and decision notes | Device control, updates, screenshots, `hab`, and Zigbee administration |
| `full` | Every currently available built-in MCP tool | Nothing beyond separately disabled features |

`full` is the default and preserves current behavior. `get_agent_capabilities` reports the active profile, exposed tool count, and omitted count.

For local Ollama and other OpenAI-compatible models, configure an effective context window of at least 64K and restart or reload the model. The complete OpenCode prompt includes built-in tools, Home Assistant tools, instructions, and conversation history; a smaller context can silently truncate tool definitions even when a small standalone `curl` tool-call test succeeds. Use `ha-mcp tools` from the terminal, or ask OpenCode to run it with its shell tool in OpenChamber mode, to list what the MCP server objectively advertises. Asking the model which tools it has only tests model recall. If the command lists a tool that the model will not call, check the model server for prompt truncation and tool-parser errors.

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

The beta add-on ships one certified runtime for each selectable terminal path: V2 is the default, while V1 is a temporary rollback. Both are exact upstream versions pinned in the image, installed at build time, and verified during the build. The terminal banner shows which one is active.

There is no update policy to choose. OpenCode's own auto-updater is disabled (`OPENCODE_DISABLE_AUTOUPDATE=true`) and nothing in the add-on installs a rolling runtime, so either selectable path uses the exact build tested against this add-on. **A new OpenCode arrives with an add-on update**, after it has been through the beta channel.

If you used the old `latest` policy, an OpenCode may still exist under `/data/.npm-global`. It is left untouched but is no longer on `PATH` and is never used; the add-on logs a one-line notice about this at start-up. You can remove the now-unknown `opencode_update_policy` line from the Configuration tab at your convenience.

### Checking the runtime yourself

`opencode-smoke-test` verifies the whole chain in one go. Run it in the terminal, or in OpenChamber ask the session to run it with its shell tool. It checks both runtime pins, the selected runtime boundary, generated configuration, MCP and YAML language servers, OpenChamber Ingress patch, skills, and read-only overlay. Under V2 it also verifies direct `/homeassistant` access and authenticated native policy; under V1 rollback it verifies that the V2 managed runtime stayed inactive. It exits non-zero if anything fails, and it is worth attaching to a bug report.

The beta image also includes `opencode-v2-self-test`. It authenticates directly to the fixed private loopback V2 server inside one non-dumpable process without using proxy settings or following redirects, verifies the expected runtime guard and MCP state plus read-only permission outcomes, confirms that no approval prompt was created, and removes its temporary session even after a controlled cancellation. It never prints the server password or places it in a command argument or environment variable. The broader `opencode-smoke-test` runs this bounded check automatically when V2 is selected.

### CPU requirements

OpenCode is a Bun-compiled binary, so Bun's CPU floor applies: an x64 processor must support **SSE4.2** (the x86-64-v2 level — Intel Nehalem/2008 or newer, AMD Bulldozer/2011 or Jaguar/2013 or newer). Below that line every OpenCode binary exits immediately with `Illegal instruction (core dumped)` and no add-on setting changes it; the add-on detects this at start-up and says so in its log. ARM64 is unaffected.

The regular x64 build additionally requires **AVX2** (Haswell/2013 or newer), and the add-on falls back to OpenCode's *baseline* build when AVX2 is missing. Note that upstream currently publishes the regular AVX2 binary inside the baseline package ([anomalyco/opencode#33595](https://github.com/anomalyco/opencode/issues/33595)) — the two are byte-identical in the shipped versions, so baseline mode does not presently rescue a CPU without AVX2.

For x64 VM installs, make sure the guest can see AVX2 when the host supports it. Generic QEMU/KVM CPU models can hide AVX2 and force OpenCode's baseline binary unnecessarily.

## Native Home Assistant MCP Bridge (Beta)

Home Assistant has a native `llm` integration and native MCP endpoints for registered LLM APIs. PR [home-assistant/developers.home-assistant#3236](https://github.com/home-assistant/developers.home-assistant/pull/3236) documents the contract: every registered LLM API is exposed at `/api/mcp/<API ID>` once Home Assistant's MCP Server integration is set up. The built-in Assist API uses the API ID `assist`.

**Which Home Assistant version you need:** the `llm` integration, the per-domain LLM tool platforms, and the keyed `/api/mcp/<API ID>` endpoints all first ship in **Home Assistant 2026.8**. On 2026.7.x and earlier, Home Assistant serves only the configured `/api/mcp` endpoint and the legacy `/mcp_server/sse` transport. In every case the **MCP Server** integration must be added in Home Assistant first — the endpoints are not served otherwise.

When **Native Home Assistant MCP bridge (beta)** is on, the add-on adds a second OpenCode MCP server named `homeassistant_native` that forwards requests to the configured Home Assistant Core native endpoint through the Supervisor proxy. **Native MCP API ID** defaults to `assist`, which targets `/api/mcp/assist`. Set it to a custom API ID to test `/api/mcp/<your API ID>` for custom APIs registered inside Home Assistant. Leave it empty to target Home Assistant's configured `/api/mcp` endpoint instead.

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

## Runtime And Interface (Beta)

Select the **OpenCode runtime** first:

- `v2`: the default V2 runtime. V2 currently supports the terminal interface only.
- `v1`: the retained V1 runtime. V1 supports either the terminal or OpenChamber.

The **Interface (V1 only)** preference has two choices:

- `terminal`: uses the existing ttyd terminal and tmux session.
- `openchamber`: starts OpenChamber behind Home Assistant Ingress on the same sidebar entry.

Home Assistant's generated add-on form cannot dynamically disable one field from another. If V2 and OpenChamber are selected together, the add-on serves the V2 terminal and retains the OpenChamber preference for the next time V1 is selected.

The V2 server runs as root and accesses `/homeassistant` directly, matching the filesystem model used by the proven V1 runtime. The server and TUI start from a separate root-owned project directory, so `.opencode` content in your Home Assistant directory is not discovered as project plugins. The attached TUI has a separate UID `60001` and root-owned managed configuration.

Choose V1 when you want OpenChamber or when the V2 terminal cannot start, then save and restart the add-on. V1 leaves the V2 server, sidecar, broker, and proxy inactive. It preserves the original V1 state and never copies V2 sessions back into it. V1 is also required for the LAN server in this beta; removal is deferred until V2 has completed a real HAOS soak.

The two are exclusive: in `openchamber` mode no terminal is started, so the terminal commands (`ha-readonly`, `ha-logs`, `ha-mcp`, `ha-context`, `ha-hooks`, `hab`, `zigporter`, `opencode-smoke-test`) have no shell to run in. Most of them the OpenCode session can still run with its shell tool if you ask it to; [`ha-readonly`](#read-only-session) is the exception, because it replaces the session rather than running inside one.

To use OpenChamber:

1. In the add-on **Configuration** tab, set **OpenCode runtime** to `v1` and **Interface (V1 only)** to `openchamber`.
2. Save and restart the add-on.
3. Open **OpenCode Beta** from the Home Assistant sidebar.

Security and networking notes:

- OpenChamber is not exposed through a Home Assistant Network port by default.
- The OpenChamber process binds to `127.0.0.1` inside the container.
- A small first-party ingress proxy binds to internal port `8099`, accepts Home Assistant Ingress traffic, and forwards to OpenChamber locally.
- Home Assistant Ingress provides the browser authentication layer, so no separate OpenChamber UI password is configured for this mode.
- LAN access remains the separate opt-in **OpenCode LAN server** feature on port `4096`.

Known beta risk: OpenChamber is a root-hosted web app, so this beta includes a pinned bundle patch for Home Assistant's `/api/hassio_ingress/...` path. If the page loads but actions fail, switch **Interface (V1 only)** back to `terminal`, restart the add-on, and include logs when reporting the issue.

OpenChamber's own built-in update check is disabled in this add-on. OpenChamber is pinned and patched for Home Assistant Ingress when the add-on image is built, so an in-app self-update cannot persist or stay patched and would only hang the UI. OpenChamber is updated by updating the add-on — no "update available" prompt appears inside OpenChamber, and the Update button in **Settings → OpenChamber → About** reports no update.

### Connecting a provider with browser sign-in

Some providers offer a **browser** sign-in method (for example **ChatGPT Pro/Plus (browser)**) that sends you back to `http://localhost:<port>/auth/callback` after you sign in. That address is the add-on container, not the computer you are browsing from, so the final redirect always fails to load with a connection error. That is expected and does not mean the sign-in failed.

In **Settings → Providers**, copy the whole `http://localhost:...` URL from your browser's address bar, paste it into the **Paste authorization code** field, and select **Complete** — the add-on delivers it to OpenCode locally so the sign-in finishes. Pasting only the `code=` value from that URL works too. In `terminal` mode, use the provider's **headless** method instead, which shows a short code to enter on the provider's device-authorization page and needs no redirect at all.

The first V2 activation migrates sessions but does not copy V1 provider credentials because the V1 and V2 credential formats are not reliably compatible. Run `/connect` in the V2 terminal and authenticate each provider once; this does not change the retained V1 credential. If an earlier beta already copied credentials into your active V2 generation, they are preserved rather than deleted and the terminal shows a reminder to reconnect providers that return HTTP `401`.

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

LAN server sessions have no terminal prompt to answer an `ask` permission. To prevent an HTTP client from leaving a write tool call running forever, the add-on denies unmatched `edit: ask` rules in this mode only. The terminal and Ingress UI keep their normal confirmation prompts.

For a write-capable custom agent, grant only the directory it needs and deny the rest. OpenCode evaluates edit rules relative to `/homeassistant`; the add-on also accepts the documented absolute form and translates it for LAN sessions.

```yaml
permission:
  edit:
    "*": deny
    "docs/**": allow
```

The equivalent `"/homeassistant/docs/**": allow` works in LAN server mode after an add-on restart. An explicit `edit: allow` remains fully write-capable. The rule is applied when the server starts, so restart the add-on after adding or changing a custom agent file.

## OpenChamber LAN Web UI (Beta)

By default the OpenChamber web UI (`interface_mode: openchamber`) is served **only** through Home Assistant Ingress at `/api/hassio_ingress/<token>/`. That is the recommended path because Home Assistant provides the authentication layer.

If you instead want a clean root URL for a reverse proxy or tunnel — for example so `https://openchamber.example.com/` maps straight to a backend without an ingress-path redirect/rewrite — enable the OpenChamber LAN web UI. It publishes OpenChamber on a mappable network port and serves it at the root path `/`.

To enable it:

1. Set **OpenCode runtime** to `v1` and **Interface (V1 only)** to `openchamber`.
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

**Bridge Home Assistant's voice pipeline to OpenCode.** The use case this feature came from, and the most involved: a [Wyoming](https://github.com/rhasspy/wyoming) server that registers as a conversation agent and forwards what you say to OpenCode. It follows the same shape as the service above — a venv under `/data`, a `setsid` daemon, a `pgrep` guard — and additionally needs the **OpenCode LAN server** option turned on so the hook can reach OpenCode's API at `127.0.0.1:4096`. See [Talking to the add-on itself](#talking-to-the-add-on-itself).

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

**Node** — `npm install --prefix /data/mybridge <pkg>`. Never `npm install -g`: that prefix is shared with the add-on's own OpenCode updates and the two can corrupt each other.

Put your own files under `/data/<name>/`. Never `/data/.cache` — it is deleted on every start.

### Ports and reachability

Pick a port for your own service that the add-on is not already using. These are taken inside the container: `8099` (the interface behind Ingress), `3010` (OpenChamber), `4096` (OpenCode LAN server), `4097` (OpenChamber LAN), `4100` (private V2 server), `8787` (PPQ proxy). *Listening* on one of those from a hook breaks the add-on in a way that is hard to trace. **Connecting** to them is fine and expected — see below.

Your service is **not** reachable from your LAN. No port is mapped for it, and that is deliberate: a mapped port would put a service the add-on did not write, with no authentication in front of it, on your network.

It **is** reachable from Home Assistant Core and from other add-ons, at this container's hostname. Run `hostname` in the add-on terminal to see it — it differs between the stable and beta add-ons. That is what makes `rest_command`, a Wyoming service, or a custom integration endpoint work.

### Talking to the add-on itself

A hook can drive OpenCode through its own HTTP API, which is how the voice bridge in issue #66 works.

Turn on **OpenCode LAN server** in the Configuration tab. Despite the name, you do **not** have to map `4096/tcp` in Network settings — mapping is only for reaching it from another computer. Leave it unmapped and the server is reachable at `http://127.0.0.1:4096` from inside the container, which is all a hook needs, with nothing exposed to your network.

For Home Assistant itself, no extra option is needed: `SUPERVISOR_TOKEN` is already in the hook's environment and `http://supervisor/core` proxies to the Core API, so no long-lived access token is required.

```sh
# Home Assistant Core, through the Supervisor proxy
curl -fsSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    http://supervisor/core/api/config

# OpenCode's own API (needs the OpenCode LAN server option on)
curl -fsSL http://127.0.0.1:4096/app
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
