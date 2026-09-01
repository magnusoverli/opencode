# Changelog

## [Unreleased]

- Consolidated the V2 readiness and migration roadmaps, documented selectable V1 as retained for rollback, LAN, and OpenChamber, and clarified the root V2 shell credential boundary.

## 3.0.0b10

- Expanded `get_history` with fixed-window paging across all recorded state changes, compact state/timestamp pages, reusable continuation arguments, and complete-window numeric calculations instead of limiting analysis to the newest 200 events.

## 3.0.0b9

- Restored the optional `homeassistant_native` MCP in V2 through the credential-isolated sidecar, so enabling the bridge now shows both Home Assistant MCP servers as connected without exposing Supervisor credentials to the V2 server or shell.
- Prevented a harmless one-time V2 server restart by waiting for the credential broker socket during concurrent s6 startup.

## 3.0.0b8

- Stopped copying V1 provider credentials into new V2 state because the formats are not reliably compatible; migrated sessions remain available, V1 credentials stay untouched, and V2 now asks for a fresh `/connect` sign-in.

## 3.0.0b7

- Clarified the configuration page's V1/V2 choice and made OpenChamber an effective V1-only interface preference; V2 always serves the terminal without discarding the saved OpenChamber choice.
- Documented that provider credentials are copied from V1 only during initial V2 migration and must be reconnected in V2 if the provider rejects the migrated credential.

## 3.0.0b6

- Fixed the V2 self-test creating temporary model sessions that logged provider authorization errors; it now validates the active read-only rules without invoking a provider.

## 3.0.0b5

- Fixed V2 startup on HAOS by removing the unsupported ID-mapped mount and `SYS_ADMIN` requirement; the V2 server now uses `/homeassistant` directly as root, matching the proven V1 filesystem model.

## 3.0.0b4

- Added a bounded, non-dumpable live V2 policy self-test for native image and Supervisor acceptance without exposing the private server password to arguments, environment variables, proxies, or redirects.
- Made OpenCode V2 the default terminal runtime with an explicit V1 rollback option for this beta milestone.
- Added an ID-mapped Home Assistant workspace and a native TUI launcher so V2 can edit configuration as an unprivileged user without exposing server credentials to project plugins or inherited shell environments.
- Isolated the V2 TUI under a separate user, rejected project `.opencode` plugins in both launchers, and made V1 rollback bypass the V2 mount and services completely.

## 3.0.0b3

- Added a default-deny V2 read-only agent that permits ordinary file reads, path globbing, and compact diagnostic MCP tools while blocking content search, sensitive reads, mutations, and unknown actions.
- Made the official Home Assistant Supervisor devcontainer the default workflow and added repeatable app, s6, smoke-test, Home Assistant Core Ingress, and automatic sidecar crash-recovery acceptance.
- Standardized the container runtime on Node 24.15.0 while retaining Home Assistant's Supervisor-compatible Debian base.
- Moved staged V2 process-boundary checks into a bounded native amd64/arm64 CI fixture and removed dormant preview-client credential paths.

## 3.0.0b2

- Kept the root MCP proxy bound during sidecar startup while returning a clean 503 until backend readiness, and made startup logs and the terminal banner distinguish the active V1 TUI from staged V2.
- Hardened staged V2 credential delivery against PID reuse and stale readiness after abrupt sidecar exits.
- Clarified why the TUI still uses V1 and set gate-based targets for b4 to make V2 the default terminal runtime and b5 to remove V1 code from the beta image.

## 3.0.0b1

- Fixed the read-only session prompt normalization so the in-add-on smoke test no longer reports a false failure.
- Connected staged V2 to a separately supervised, authenticated Home Assistant MCP sidecar with boot-time process-inspection hardening and no caller secret in config, environment, logs, or shell subprocesses.
- Hardened staged V2 with a peer-validated credential broker, a root-retained sidecar listener, cancellable Home Assistant operations, redacted tool logging, and allowlisted non-dumpable process environments.

## 3.0.0b0

- Began the OpenCode V2 beta transition with an exact matched CLI/plugin build, isolated `/data/v2` state roots, and preserved V1 rollback data; stable remains on OpenCode V1 while parity work continues.
- Added fail-closed copy-on-write migration of beta V1 sessions and provider authentication into atomically activated V2 state generations.
- Fixed V1-to-V2 validation to follow the pinned message, attachment, tool, compaction, and credential projections exactly.
- Hardened V2 readiness and migration activation against probe state writes, incomplete session projection checks, ambiguous provider IDs, and unbounded image-fixture shutdown.
- Added a native ordered V2 safety policy and an authenticated, unprivileged private-loopback V2 service while keeping terminal, LAN, OpenChamber, and MCP traffic on the V1 rollback runtime until the remaining isolation gates pass.

## 2.5.3b4

- Updated OpenChamber to 1.21.0 and verified its Home Assistant Ingress patch against the published bundle, including its dynamically served runtime shim.

## 2.5.3b2

- Updated the certified OpenCode runtime to 1.18.25, improving Azure CLI/Entra ID, Bedrock, Cloudflare AI Gateway, and GitHub OIDC reliability.

## 2.5.3b1

- Removed OpenChamber's unsupported OpenCode runtime update notification; runtime upgrades continue through tested add-on releases.

## 2.5.3b0

- Updated the certified OpenCode runtime to 1.18.21, restoring responses after providers report an unknown finish reason.
- Added ESPHome 2026.8 Device Builder migration planning, structured connectivity and crash troubleshooting, correct terminal stream completion, and 1.12 protocol coverage.

## 2.5.2b0

- Updated Home Assistant Supervisor volume map types to remove legacy-schema warnings.

## 2.5.1b2

- Git remotes using SSH now work out of the box with the bundled OpenSSH client tools.

## 2.5.1b1

- ESPHome management now covers device lifecycle, adoption, board and metadata discovery, YAML search and includes, write-only secret/key workflows, version history, bounded logs, managed firmware jobs, build cleanup, serial provisioning, and remote-build pairing.

## 2.5.1b0

- ESPHome agents can now read, validate, create, and safely update Device Builder YAML through its native WebSocket API, with preview-first writes, stale-source checks, and post-write verification.

## 2.5.0b5

- **OpenChamber 1.18.3** — updates the web UI through the latest upstream release, including the security-related archive extraction update from 1.18.2, lower startup cost, and session/MCP fixes.

## 2.5.0b4

- **Local-model MCP diagnostics ([issue #99](https://github.com/magnusoverli/opencode/issues/99))** — `ha-mcp tools` now lists the server's objective tool surface, and the Ollama guidance explains the 64K context needed to avoid silently truncating tool definitions.

## 2.5.0b3

- **OpenChamber voice model downloads work ([issue #100](https://github.com/magnusoverli/opencode/issues/100))** — the image now includes bzip2 support so local dictation and TTS model archives can be extracted instead of failing with `tar exited with code 2`.

## 2.5.0b2

- **OpenChamber ingress survives abandoned browser streams ([issue #98](https://github.com/magnusoverli/opencode/issues/98))** — disconnecting during an HTTP or WebSocket response now tears down that request instead of crashing the ingress proxy and restarting the add-on.

## 2.5.0b1

Documentation only — the image is identical to 2.5.0b0.

- **`ha-readonly` is documented as needing terminal mode** — it is a terminal command, and `interface_mode: openchamber` starts no terminal, so in that mode it cannot be reached. The 2.5.0b0 documentation presented it as unconditionally available. The Interface Mode section now also lists which other terminal commands (`ha-logs`, `ha-mcp`, `ha-context`, `opencode-smoke-test`, `hab`, `zigporter`) the OpenCode session can still run through its shell tool when there is no terminal, and why `ha-readonly` is the one that cannot: it replaces a session rather than running inside one, and a read-only *option* on OpenChamber's single managed server would change your normal session instead of sitting beside it.

## 2.5.0b0

The runtime this add-on runs is now a decision someone made, not whatever npm had that morning — and the knowledge it carries is loaded when a task needs it instead of on every request. Plus a session that can look at your Home Assistant installation without being able to touch it.

- **A certified OpenCode runtime** — the add-on now ships one pinned OpenCode build (1.18.16) and runs only that one. The **OpenCode update policy** option is gone, and with it the background `npm install -g opencode-ai@latest` that could arrive with anything upstream had published that hour.

  The choice it offered was not really a choice. `bundled` meant a tested runtime; `latest` meant an untested one landing on your Home Assistant instance without warning, and it is the OpenCode version that decides whether this add-on's MCP servers, YAML language server, Prettier formatting, OpenChamber build and PPQ provider still work. A new OpenCode now arrives the way every other change does: in an add-on release, after a beta soak. The terminal banner names the version it certified, `OPENCODE_DISABLE_AUTOUPDATE` is always set, and the image build fails outright if npm resolves anything other than the pinned version.

  If you had `latest` set, nothing breaks. Any OpenCode previously installed under `/data/.npm-global` is left exactly where it is — it is your data — but it is no longer on `PATH` and is never used, and the add-on log says so once at start-up. You can delete the now-unknown `opencode_update_policy` line from the Configuration tab whenever you like.

- **Home Assistant knowledge as skills, loaded when it is needed** — `AGENTS.md` had grown to carry the whole YAML style guide, the `yq` reference, the documentation-currency workflow, every `zigporter` caveat and the firmware-update procedure, and all of it was pushed into the context of every request, including "what's the temperature in the kitchen".

  Those procedures now ship as five OpenCode skills — `home-assistant-configuration`, `home-assistant-troubleshooting`, `home-assistant-dashboard-ui`, `home-assistant-zigbee-esphome` and `home-assistant-development` — which OpenCode loads on demand, when the task actually calls for one. What stays in `AGENTS.md` is the part that has to be unconditional and is not a procedure at all: the consent and scope rules, the secret-handling rules, the off-limits internal directories, and a short map saying which skill covers what.

  The skills are deployed to `/data/.config/opencode/skills/`, and they are yours to edit. The add-on refreshes one only while your copy is byte-for-byte what it last wrote; the moment you change it, the update is skipped, the log says which file was kept, and it stays kept on every later start. That last part is the bit that is easy to get wrong, so it has a test.

- **`ha-readonly`: a session that cannot change anything** — investigating a problem and fixing it are different jobs, and only one of them should be able to write to your configuration. Run `ha-readonly` in the terminal for an OpenCode session that reads files, queries live state, history and logs, and ends with a recommendation. It needs `interface_mode: terminal`; `openchamber` mode starts no terminal, and there is no OpenChamber equivalent, because a read-only *option* on the one managed server would change your normal session instead of sitting beside it.

  It is not a prompt asking the model to behave. File edits, shell commands, subagents and the LSP tool are denied at the session and agent level; the Home Assistant MCP server is forced into its `compact` profile, so service calls, configuration writes, updates, firmware, screenshots, `hab` and `zigporter` are not present in the tool list and are rejected by the server even if something asks for one anyway; the native Home Assistant MCP bridge is switched off, because the profile does not filter its tools; and `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, `*.key` and `*.pem` are denied regardless of the **Restrict access to sensitive files** setting. `ha-readonly --print-config` prints exactly what the session runs under.

  Everything else is the same session you already have — same provider, same model, same view of your configuration. And your normal `opencode` session is untouched: there is no new option, no new default, nothing to turn back on. Investigate in `ha-readonly`, exit, and use OpenCode to make the change you decided on.

- **Checks that run before a release rather than during one** — the behavioural tests used to run only when a tag built an image, which is after the change is already on `main`. A pull-request workflow now runs the MCP server suite, the YAML language server suite, and a new set of contract tests covering the runtime pin, PATH precedence, the generated OpenCode configuration, skill and agent frontmatter, managed deployment, and the read-only overlay. `opencode-smoke-test` in the terminal verifies the same chain inside a real image — runtime version, MCP and LSP startup, the Ingress-patched OpenChamber bundle, deployed skills, and the read-only overlay — and a weekly workflow reports new upstream OpenCode releases without touching the pin. Bumping the certified runtime now has a checklist (`OPENCODE_UPGRADE_CHECKLIST.md`) rather than being a one-line edit.

- **OpenCode V2 readiness tracking** — maintainers now have a root-level compatibility checklist covering the upstream beta's migration work, current blockers, and release gates.
- **OpenCode V1 improvement roadmap** — maintainers now have a Home Assistant-focused plan for a certified runtime, on-demand skills, read-only diagnostics, and regression coverage.

## 2.4.2b5

- **OpenChamber restarts no longer leave port-holding orphan processes** — the server and Home Assistant Ingress proxy are now independently supervised, so restarting either cannot strand the other on ports 3010 or 8099.

## 2.4.2b4

- **Unambiguous history timestamps ([issue #94](https://github.com/magnusoverli/opencode/issues/94))** — history, logbook, and calendar queries now require caller-provided timestamps to include `Z` or a UTC offset, preventing Home Assistant local-time interpretation from silently shifting requested windows.

## 2.4.2b3

- **Supervisor operations diagnostics** — six new read-only tools provide bounded health, Resolution, backup posture, support-log, store-audit, and metrics evidence without exposing network addresses, backup locations, repository credentials, app options, or unredacted log secrets.

## 2.4.2b2

- **Supervisor apps API compatibility ([issue #90](https://github.com/magnusoverli/opencode/issues/90))** — Home Assistant update checks, app changelogs, ESPHome discovery, and startup service discovery now prefer the feature-gated Supervisor V2 apps API while safely retaining V1 add-ons API support.

## 2.4.2b1

- **Firefox terminal sizing ([issue #87](https://github.com/magnusoverli/opencode/issues/87))** — the Home Assistant Ingress terminal now reconciles an inconsistent Firefox pixel ratio with the actual terminal canvas, so high-DPI displays render at the full viewport width without affecting other browsers or page code.
- **OpenChamber 1.18.1** — updates the pinned web UI through the latest upstream release while preserving Home Assistant Ingress sign-in: browser OAuth providers with a container-local callback now show the paste-code flow, so the add-on can replay the failed localhost redirect inside the container instead of waiting for a browser redirect it cannot receive.

## 2.4.1b3

- **LAN custom agents can write their allowed files ([issue #92](https://github.com/magnusoverli/opencode/issues/92))** — scoped absolute edit rules now work in headless server sessions, while unapproved writes are denied instead of hanging indefinitely.

## 2.4.1b2

- **Sharper Home Assistant agent tools** — choose a compact, configuration, or full MCP tool profile to reduce irrelevant tool definitions; capability status now says whether the native MCP bridge is actually usable; and `ha-agent-eval` can score a real OpenAI-compatible model against safe synthetic tool-call scenarios without touching your Home Assistant instance.

## 2.4.1b1

- **Smaller installed image** — production images no longer include unused platform binaries, development artifacts, build toolchains, or the standalone PPQ proxy's optional OpenClaw peer tree; runtime features are unchanged.

## 2.4.1b0

One new thing: a supported place to put your own code.

- **Startup hooks ([issue #66](https://github.com/magnusoverli/opencode/issues/66), reported by [@ricardo-cabral-pt](https://github.com/ricardo-cabral-pt))** — everything inside this container except `/data` and your configuration directory is rebuilt from the image on every start. That is normally invisible, and then one day you want to add something to the add-on, and it isn't. The report that led to this one is worth reading: a working Wyoming bridge that turned Home Assistant's voice pipeline into an OpenCode conversation agent, rebuilt three times because each place it was put got erased — first `/data/.cache`, which this add-on deletes at every start; then a patched s6 service definition in `/etc`, which the image restores; then the pip packages it needed, for the same reason. The add-on was destroying the work and never saying so.

  There is now a folder in this add-on's own directory inside your configuration folder, `startup.d`, and every `.sh` file in it runs once, in filename order, each time the add-on starts. It is created with a README and a worked example the first time you turn the option on. Because it lives in the configuration directory rather than inside the container, you can edit hooks with File Editor, Samba or Studio Code Server — the tools you already have — and they survive restarts, updates and reinstalls.

  The contract is deliberately small, because the point of this is to get out of your way rather than to become a service manager. A hook runs as root with the add-on's environment, including the Supervisor token, so it can reach the Home Assistant API without a long-lived token. It must return; anything meant to outlive it is detached with `setsid`, which the shipped example demonstrates. A hook that fails is logged and never stops the next one. Nothing restarts what a hook starts, and the documentation says so rather than leaving you to find out.

  Off by default, and it stays genuinely off: an option missing from an older configuration reads back as the literal string `null`, so this one is an explicit allow-list rather than the "anything but false" test used elsewhere in start-up — a feature that runs arbitrary code does not get to enable itself. When it is on, the add-on log names every file it is about to run with its size and digest before running any of them, so a hook you did not put there is visible rather than silent. The sweep runs detached and de-prioritised, so a hook that hangs cannot delay the terminal or trip the health check, and two starts inside a minute skip hooks entirely so a bad one cannot hold the add-on in a restart loop. Turning the option off disables every hook without deleting anything.

  What it is actually for is broader than the report that prompted it, and the documentation now carries four worked examples rather than describing the mechanism in the abstract: a local git history of your configuration taken at every start, with a `.gitignore` that keeps `secrets.yaml` and Home Assistant's internal state out of it; reinstating a command-line tool that the rebuilt container would otherwise lose on every restart; a small HTTP service, standard library only, that Home Assistant can call through `rest_command`; and the voice bridge itself. A hook reaches Home Assistant's API through the Supervisor with no token setup at all, and — with the **OpenCode LAN server** option on — OpenCode's own API at `127.0.0.1:4096`, which does **not** require mapping the port in Network settings. That last point was wrong in the first draft of these documents, in the direction that would have blocked the original use case: the reserved ports are ports a hook must not *listen* on, and connecting to them is how you reach the add-on.

  New in the terminal: `ha-hooks list` (what exists, when each last ran, how it went), `ha-hooks run [name]` (try a change without restarting the add-on), and `ha-hooks log [name]`. Hook output is kept in the add-on's private `/data/hooks/`, mode `0600` and excluded from backups, because a hook's environment contains credentials and a backup travels.

  When the option is on, OpenCode itself is told how to write one — so "make me a startup hook that runs this at boot" works — and when it is off it is told nothing at all, so nobody pays for those instructions on every request or gets pointed at a feature they have not enabled.

## 2.3.9b3

Beta stops being a branch and becomes a real add-on, which is mostly invisible except for the one place the two channels had been quietly writing over each other. Plus a correction to what 2.3.9b2 told you about reaching Home Assistant's keyed MCP endpoints.

- **Beta is now built from its own source, not from stable's** — until now `ha_opencode_beta/` held no code at all. It was metadata, and both images were built from the same `ha_opencode/` directory; what made one of them "beta" was which git branch the tag happened to sit on. That worked, but it meant beta and stable could never differ except in time, every stable release had to be forward-merged into the beta branch or the next beta silently regressed it, and a bot had to copy beta's metadata back onto `main` after every release because Home Assistant only ever reads the default branch. Beta now has its own `Dockerfile` and its own `rootfs/`, both channels release from `main`, and a stable build cannot reach beta's code because the files are simply not in the directory it builds. This is the layout ESPHome and Frigate use. Nothing about the add-on you install changes; the machinery behind it got considerably less clever.
- **Decision notes are per channel now** — both add-ons mount the live configuration directory, and both were reading and writing `/config/opencode/decisions.yaml`. A note recorded while trying something out in beta was therefore injected into every stable session from then on, which is the opposite of what a beta channel is for. Beta now keeps its notes in `/config/opencode_beta/decisions.yaml`. On first start it copies your existing notes across, so nothing is lost — it copies rather than moves, because if you also run stable those notes are equally its own. If you want the two to diverge, they now can; if you want them to match, copy the file.
- **Beta no longer writes `AGENTS.md` into your configuration directory** — this was the sharpest way the two add-ons interfered. Only one file there can carry the name OpenCode looks for, and it finds it by convention from the working directory rather than from anything the add-on configures, so both channels deploying it meant whichever started last owned it. The two copies are not interchangeable: beta's tells the model that `call_service` returns service response data automatically, which is true of beta's build and false of stable's. A stable session that happened to read beta's file was being instructed to use a tool it does not have. Stable now owns that file outright; beta keeps its own copy inside the add-on and loads it the same way the home briefing and decision digest are loaded. If you have been running beta on its own, it removes the copy it left behind — but only when the file is still byte-for-byte what beta wrote, so an edited file, or one the stable add-on has taken over, is left alone. The remaining overlap runs the harmless way: a beta session may additionally pick up stable's file, which tells it less than it could know rather than something untrue.
- **The two add-ons stop mistaking each other for you** — each recorded "this is the copy I wrote" inside `/data`, which is private to each add-on, while the file it described was shared. So one would refresh `AGENTS.md`, the other would start, fail to recognise it, conclude *you* had edited it, take a `.bak` and then stop updating it for good. Stable's marker now lives beside the file at `/config/.opencode_agents_md.sha256`, which also means reinstalling the add-on no longer looks like a hand edit — `/data` is wiped on reinstall and your configuration directory is not.
- **The terminal banner says which channel you are in** — it read `OpenCode` in both add-ons, which was needlessly confusing with two of them installed. Beta says `OpenCode Beta`.
- **Ports were never actually in conflict** — worth stating plainly, since it looks like they should be. The `ports:` entries in an add-on's configuration are *container* ports and each add-on has its own network namespace, so both channels declaring 4096 and 4097 costs nothing. Only the host side can collide, it is unmapped by default, and Home Assistant will not let you assign the same host port twice. If you expose both add-ons' LAN ports, give them different host ports. The port descriptions now say so.
- **Keyed API IDs other than `assist` are reachable from the add-on — 2.3.9b2 said they might not be** — Home Assistant requires admin access for every keyed `/api/mcp/<API ID>` endpoint except Assist, and the previous release passed that on as a warning that an add-on may not clear the bar. It does clear it: the Supervisor calls Home Assistant Core as its own system user, and the `hassio` integration creates that user in the admin group. So a custom LLM API registered by your own integration is testable over `/api/mcp/<your API ID>` with no token and no extra configuration. The warning sent people looking for a permission problem that does not exist; an unknown-API-ID error now says plainly that the ID does not exist. `get_agent_capabilities` reports the access model as a field rather than leaving it to be inferred.
- **`/api/mcp` is a multi-API endpoint, and the documentation now says so** — the API selection in the Model Context Protocol Server integration is a multi-select, and Home Assistant passes the whole list to that endpoint. It was described throughout as serving "the configured API", singular, which understates it: leaving the add-on's API ID empty gives you every API you selected there, and the endpoint fallback can therefore widen the tool surface rather than narrow it.
- **The bridge sends the `MCP-Protocol-Version` header** — required of MCP clients from protocol revision 2025-06-18 onward. Home Assistant's streamable endpoint is stateless and does not read it today, but the Supervisor proxy forwards the header by name, so sending it costs nothing and keeps the bridge correct if Core starts enforcing it.

## 2.3.9b2

A crash with no explanation, an option that had stopped meaning what it said, and a native MCP bridge that finally meets the Home Assistant release it was written for.

- **A CPU too old for OpenCode now says so instead of crashing ([issue #86](https://github.com/magnusoverli/opencode/issues/86), reported by [@deanhalllincoln](https://github.com/deanhalllincoln))** — on an AMD G-T56N, `opencode --version` died with `Illegal instruction (core dumped)` and nothing anywhere explained why. OpenCode ships as a Bun-compiled binary, so Bun's CPU floor is OpenCode's, and Bun's oldest supported target — the x64 *baseline* build — still requires SSE4.2, the x86-64-v2 level. That processor is a 2011 Bobcat: it has SSE4a and POPCNT but neither SSE4.1 nor SSE4.2, so it sits below the floor and no published OpenCode binary can start on it. The add-on now checks for SSE4.2 at start-up and states that in the log, naming the CPU and the requirement, and the error raised when the binary then fails to execute points at the CPU instead of reporting a generic execution failure. Everything else still comes up, so the message is readable in the add-on log. This does not make OpenCode run on such hardware — nothing can — but it replaces a bare crash with a diagnosis.
- **The `baseline` CPU mode does not currently do what it promised** — the add-on detects missing AVX2 and selects `opencode-linux-x64-baseline` for it, which is the right thing to do, but upstream is publishing the regular AVX2 binary inside that package. For the shipped OpenCode versions the two are byte-identical: same SHA-256, tarballs differing only by the package name in `package.json`, and the "baseline" binary disassembles with AVX and SSE4.1 instructions still in it. The fallback is therefore inert, and machines with SSE4.2 but no AVX2 — Sandy Bridge and Ivy Bridge boxes, common enough as Home Assistant hosts — hit the same illegal instruction the option exists to avoid. The documentation and the option description claimed otherwise and now say what is true, and the start-up warning links the upstream report ([anomalyco/opencode#33595](https://github.com/anomalyco/opencode/issues/33595)). The option is kept rather than removed, because it starts working again the moment upstream publishes a genuine baseline build.
- **Minimum hardware is documented** — the README and the add-on documentation both state the SSE4.2 floor and the separate AVX2 distinction up front, instead of leaving it to be discovered by crashing.
- **The endpoint fallback no longer latches for the life of the add-on** — a bridge that fell back to `/api/mcp` on 2026.7 stayed there until someone restarted the add-on by hand. Upgrading Home Assistant is exactly the case that breaks: Core restarts, the add-on does not, so the keyed `/api/mcp/<API ID>` endpoint that the upgrade just made available would never be tried. The fallback is now retried periodically and picks the keyed endpoint up on its own, logging once when it does. The retry itself is silent — on a release that will never serve the keyed endpoint it runs for as long as the add-on does, and only the retry that succeeds is worth a log line.
- **An unknown API ID is reported instead of quietly serving a different one** — before 2026.8 a 404 on the keyed endpoint could only mean the endpoint did not exist, so falling back was always right. On 2026.8 it can also mean the endpoint exists and the API ID is wrong, and Home Assistant says so by name. Falling back there would serve the configured API in place of the one that was asked for and hide the mistake, so that case now returns an error naming the ID, with a note that keyed endpoints other than `assist` require admin access.
- **`get_agent_capabilities` still reports the crash risk on 2026.8** — known issues were filtered against a single version gate, so all three disappeared on 2026.8. Two of them are genuinely fixed there; the streamable-endpoint crash ([home-assistant/core#176734](https://github.com/home-assistant/core/issues/176734)) is not — its fix is still open upstream — and reporting no known issues while that risk is live was the opposite of what the field is for. Each issue is now filtered against the release that fixes it, and an issue with no fix anywhere is reported on every version, including versions the add-on cannot parse.
- **What you have to do to use the bridge is now written down** — it needs the **Model Context Protocol Server** integration added in Home Assistant (without it Home Assistant serves no `/api/mcp` routes at all) and the bridge option turned on followed by an add-on restart, since the option is read once at start-up. Neither requirement was documented, and the restart was not mentioned anywhere. The add-on documentation now gives the procedure, how to check it worked, and what the failure looks like if the integration is missing.

## 2.3.9b1

Two things users could not do, and a quieter one about what every request costs. The first two came in as issues with the diagnostic work already done; the third came out of chasing why a local model took two minutes to say hello.

- **Services that answer with data now work through `call_service` ([issue #82](https://github.com/magnusoverli/opencode/issues/82), reported by [@GuiPoM](https://github.com/GuiPoM))** — `recorder.get_statistics`, `weather.get_forecasts`, `calendar.get_events`, `todo.get_items` and every other response-capable service were unreachable through the MCP tool. Home Assistant requires `?return_response` on the REST call for them; `call_service` never sent it, and its schema rejected the argument outright, so the call came back as *"Service call requires responses but caller did not ask for responses"* with no way to comply. The flag cannot simply always be sent — Home Assistant answers 400 in **both** directions, so attaching it to `light.turn_on` would break every ordinary call. The decision is instead read from Home Assistant's own service catalog, where a service description carries a `response` key only when the service supports one. Services that must return data now get the flag automatically, with nothing asked of the caller, and the response is presented as the result rather than buried beside the changed-state dump that shares its envelope. `return_response: true` remains available for the smaller set whose response is optional, and `get_services` now marks which services in a domain answer with data, so that set is discoverable rather than guessed at. When the cached catalog disagrees with the running core — a freshly reloaded integration, say — Home Assistant's error names which way the flag was wrong, and the call is retried once on that basis instead of being handed back as a failure.
- **`hab action call --return-response` is now documented** — the flag has been in the bundled `hab` CLI all along, but nothing in the add-on's documentation or agent instructions mentioned it, which made the CLI path look as broken as the MCP one. The `hab` examples now show it, alongside the error you get without it.

- **Less of your context spent on the add-on's own plumbing** — three changes that cut what every request carries, and matter most on local models, where the whole prompt is re-read on your own hardware rather than absorbed by a provider's cache.
  - **Recording a decision no longer rewrites the system prompt mid-conversation.** The injected digest at `/data/context/decision-notes.md` is listed in OpenCode's `instructions`, and OpenCode re-reads every instruction file on *each request* rather than once per session — so `remember_decision` was editing the prompt underneath a live session. The digest is ordered newest-first and carries a note count, so a new note changed it at the top and discarded the cached prefix from there on, including the whole conversation so far. Superseding the last active note deleted the file outright. Recording a note now writes the notes file and nothing else; the digest is rebuilt by the generator that already owns it, at add-on start or on `ha-context refresh`. A new note is still in force immediately — it is in the conversation, and `recall_decisions` reads it live — it simply joins the standing context at the next rebuild, and the tool now says so. The digest's own completeness line is bounded to the rebuild it was written at for the same reason: it can now be older than the notes file, and "nothing has been left out" without that qualifier would be false in exactly the direction that causes damage — a decision the user made reading as a decision never made.
  - **MCP tool responses are no longer pretty-printed.** Indentation is whitespace only the model reads, and it is paid for again on every request the result stays in history. A 500-entity `get_states` payload measured roughly a quarter fewer characters compact. Nothing parses these blocks, and the plain-text output of `hab` and `zigporter` is unchanged — only the `--json` form, which was already a machine format, becomes compact.
  - **A `get_states` call with no domain is capped at 150 entities instead of 500.** At 500 it was the largest thing the add-on could put in a conversation — comparable to the whole system prompt — and it then stayed in history for the rest of the session. With the compact encoding above, the two changes together take that response from about 69,000 characters to about 15,500. Domain-filtered calls keep the old 500 ceiling: narrowing a query is the behaviour the instructions ask for, and it should not cost results. Either way the result is a slice of Home Assistant's own arbitrary ordering, which was true before and simply mattered less at 500; the response now says so plainly, so absence from a truncated list is not read as absence from the installation, and points at `summarize` for a complete per-domain census.

- **Direct file edits now ask before writing ([issue #81](https://github.com/magnusoverli/opencode/issues/81))** — this add-on points an AI agent at a live Home Assistant installation, and until now a newly installed add-on would edit configuration files without confirming anything first. Editing a file now asks for approval, as do in-place shell edits (`yq -i`, `sed -i`, `tee`) and removing or renaming files. Read-only commands are unaffected, so investigating a problem is as fluid as before. Writes through `write_config_safe` still do not prompt — they already validate, back up, and roll back automatically. Both directions remain configurable through **Custom OpenCode config**: `{"permission": {"edit": "allow", "bash": "allow"}}` restores the previous behaviour, and `{"default_agent": "plan"}` asks before every command instead, as suggested in the issue.

## 2.3.9b0

Two Home Assistant Core log errors, both reported with accurate root-cause analysis by [@JayMansel](https://github.com/JayMansel). Neither broke the feature it belonged to, which is why both went unnoticed for so long — they just made Core's log lie about your setup.

- **The screenshot tool no longer sends a second WebSocket authentication frame ([issue #74](https://github.com/magnusoverli/opencode/issues/74))** — every screenshot logged `Received invalid command: {'type': 'auth', 'access_token': '**REDACTED**'}` in Core. The tool authenticates the headless browser two ways at once: it injects the token into the frontend's `hassTokens` local storage entry, and it patches `WebSocket` to answer the `auth_required` handshake itself. The first normally succeeds, so the frontend answered the handshake *and* so did the interceptor — the existing guard only stopped the interceptor repeating itself, never the page. The connection was already authenticated by then, so screenshots worked and the error was the only symptom. The frontend now owns authentication and the interceptor is a genuine fallback: it watches outgoing frames and steps in only if the page has not authenticated shortly after the handshake, so installations where local storage auth fails are still covered.
- **The YAML language server no longer calls a Jinja function that does not exist ([issue #75](https://github.com/magnusoverli/opencode/issues/75))** — starting the LSP logged `Template variable error: 'devices' is undefined` and device ID completions never appeared. The cache warm-up asked Home Assistant for the device registry with `devices()`, but there is no all-device global to match `areas()`, `floors()` and `labels()`: Core registers only `device_entities`, `device_id`, `device_name`, `device_attr` and `is_device_attr`. The device list is now derived from the entities in `states`, which finds every device that owns at least one entity — entity-less devices are still missed, because the full registry is reachable only over the WebSocket API, which this REST-only client cannot call. Cache warm-up was also hardened: one failing registry used to discard the whole warm-up and report a single unattributed error, and now each lookup succeeds or fails on its own and the log names which one failed.

## 2.3.8b3

- **Native Home Assistant MCP bridge now works on today's Home Assistant, and is ready for 2026.8** — Home Assistant's native LLM platform (the `llm` integration, the per-domain tool platforms, and the keyed `/api/mcp/<API ID>` endpoints) all land in **2026.8**; none of it is in 2026.7.x or earlier. Until now the bridge targeted `/api/mcp/assist` unconditionally, so on every shipping Home Assistant it simply hit a 404. Three changes fix that and remove the sharp edges:
  - **Endpoint fallback** — the bridge now prefers the keyed `/api/mcp/<API ID>` endpoint and falls back to the configured `/api/mcp` endpoint when it answers 404, logging once whether the endpoint is missing entirely (pre-2026.8) or the API ID is unknown. Pin the choice with `HA_NATIVE_MCP_ENDPOINT_MODE=auto|keyed|configured`.
  - **Tool schema repair** — on Home Assistant 2026.7.x and earlier, tool parameters built from validators such as `cv.string` serialize to an empty `anyOf` member. MCP clients that strictly compile tool schemas cannot parse that, fall back to sending raw arguments, and Home Assistant rejects the call with `extra keys not allowed @ data['__unparsedToolInput']` — which made `GetLiveContext` unusable with any argument ([home-assistant/core#176762](https://github.com/home-assistant/core/issues/176762), fixed upstream by [#176814](https://github.com/home-assistant/core/pull/176814) for 2026.8). The bridge now repairs these schemas in transit; `HA_NATIVE_MCP_SANITIZE_SCHEMAS=0` disables the repair.
  - **Malformed-message guard** — every message is validated as JSON-RPC 2.0 before being forwarded, since malformed POSTs to `/api/mcp` have been reported to crash Home Assistant Core ([home-assistant/core#176734](https://github.com/home-assistant/core/issues/176734), fix still open upstream).
- **`get_agent_capabilities` explains what the running Home Assistant can actually do** — it now reports the minimum version for the native LLM platform, whether this instance meets it, and a `known_issues` list naming the upstream limitations that apply, so a stalled bridge reads as a known upstream gap rather than a broken configuration. The AI-component probe was also corrected: `lmstudio` is not a Home Assistant integration and has been dropped, `ovhcloud_ai_endpoints` was added, and conversation agents are now reported separately from AI task providers.
- **Native LLM development guide rewritten against the merged upstream code** — `get_ha_llm_development_guide` now leads with the exposure-gated `IntentTool` pattern that twelve of the fifteen core `llm.py` platforms use (including `async_should_expose` filtering), uses upstream's real import paths, states the 2026.8 requirement, documents the schema conversion pitfall above so tool authors avoid it, and flags the deprecations that make older snippets stale (`async_render_no_api_prompt`, the `helpers/llm.py` refactor in [#176082](https://github.com/home-assistant/core/pull/176082), and `LLMContext.assistant` becoming required).

## 2.3.8b2

Fixes for the screenshot tool, prompted by [issue #72](https://github.com/magnusoverli/opencode/issues/72), where a screenshot taken with a text-only model produced a reply that both declined to look at the picture and claimed it had been saved for later. The second half of that was our fault.

- **The tool no longer claims a screenshot was saved** — it reported *"captured successfully"* while writing nothing to disk, and the model repeated that back as advice to go and find the file in the Home Assistant UI. There is no file: the PNG exists only inside the tool result. The tool now says so, and tells the model what to do if the picture was withheld because the selected model cannot read images — say so plainly rather than describing a page it never saw. The tool description carries the same requirement up front, so a model can know before calling that the result depends on its own ability to accept images.
- **`private/qwen3-vl-30b` can finally receive images** — the add-on's own vision model for PPQ private mode was declared with `attachment: true`, which OpenCode does not read; image input is gated on a `modalities` field that was missing entirely, so the gate was shut and every screenshot reached the model as a rejection notice instead of a picture. All five private models now declare their modalities explicitly, so the block states what each model can actually do rather than relying on defaults.
- **Screenshots are no longer cut off by a 10-second deadline** — the Home Assistant MCP server's timeout applies to every tool call, not just the initial connection, while a screenshot costs a browser launch (1-4 seconds) plus page load plus the render wait, which the documentation itself put at 5-10 seconds. On slower hardware the call could lose that race and surface as an opaque timeout. The allowance is now 60 seconds.
- **The screenshot tool is hidden unless it can work** — it was advertised to the model even with the feature switched off or no access token set, so the model could call it and receive only setup instructions. It is now offered only when both are present, matching how the decision-note tools already behave.
- **Documentation and the option description now state the model requirement** — whether a screenshot is usable depends on the model you select, and no add-on setting changes that. The documentation now gives the current split (52 of 85 OpenCode Zen models accept image input; 33 do not, including every DeepSeek V4 model), names free alternatives that do work, and explains what a withheld image looks like.

## 2.3.8b1

Hardening pass over the home-context feature introduced in 2.3.8b0, prompted by testing feedback in [issue #63](https://github.com/magnusoverli/opencode/issues/63) and a full audit of the feature. One theme runs through most of it: **OpenCode must never be able to mistake a gap in its context for an absence in your installation** — a decision dropped for space, or a note a search failed to find, previously looked exactly like a decision that was never made, which is how a deliberate configuration gets "fixed".

- **The session digest can no longer drop a decision silently** — when more notes existed than fitted the ~500-token budget, the digest packed in what it could and appended a "some notes were omitted" line only if that line still fitted, which at ordinary note lengths it did not. Twenty notes of average length produced eleven in the prompt, nine gone, and nothing to say so. The digest is now assembled in two passes with the warning's space reserved up front, so it always states its own scope: either *"All 12 active notes are listed here — nothing has been left out"* or *"Listing 8 of 21 active notes — 13 did not fit here and are NOT shown below"*, followed by an instruction never to conclude from the list that no decision exists. Where the budget is too small even for that, it degrades to a single honest line rather than a truncated fragment.
- **Notes can be pinned** — without pinning, the oldest notes were the first to be dropped, and those are usually the ones that matter most: the constraint everyone has forgotten is the one most likely to be reversed by accident. Add `pin: true` to a note in `decisions.yaml`, or ask OpenCode to pin one when it proposes it, and it leads the digest and is the last to go. Up to 10 can be pinned.
- **Recall works from a plain question** — `recall_decisions` matched a single case-insensitive substring, so a note titled "TC71 privacy mode toggle is inverted" was found by `privacy` but not by `camera privacy` or `why is the camera toggle inverted`, and the model was told "no matching notes" — indistinguishable from "no such decision was ever made". Search is now term-scored across title, decision, rationale and references, with the count of what *matched* reported rather than the count that fitted the result limit, and an empty result now says how many notes exist and to look again before assuming nothing was decided.
- **The install briefing no longer loses whole sections in silence** — on an ordinary mid-size installation (18 areas, 34 integrations, 8 custom components) the briefing dropped Areas, Integrations and Add-on capabilities entirely, left a third of its budget unused, and said nothing about it. Sections now shrink to fit instead of vanishing whole — twelve of eighteen area names is worth far more than none — the configuration-layout bullets are ordered by what actually changes OpenCode's behaviour, and anything still left out is named, with a note that its absence is a gap in the briefing rather than a statement about your setup. Area names get a deliberate reservation, since they are the one thing OpenCode cannot guess and gets wrong most visibly.
- **Decision notes are now screened for credentials on the way *out*, not only on the way in** — the check ran when OpenCode wrote a note, but `decisions.yaml` is your file and is documented as hand-editable, so a token typed or pasted into it by hand reached the model in every session unchecked. Every note is now screened as the digest is built and as `recall_decisions` answers; anything credential-shaped is withheld from the model, named by id in the add-on log so you can fix it, and never echoed. `secrets.yaml` scanning now also reads block scalars, where certificates and private keys actually live, and a YAML syntax error no longer quotes the offending line back to the model — a file broken *because* a secret was pasted into it cannot be screened, so its contents stay out of the error.
- **Retiring many notes at once actually retires them** — `supersede_decision` and the `supersedes` field silently kept only the first 12 ids, so "retire these 15 and replace them with one policy" reported success while three retired constraints stayed active in every future session. All ids are now processed, and an unknown id is rejected rather than dropped.
- **Your `decisions.yaml` is treated as yours** — a status the add-on did not recognise (`status: retired`) was read as "active", quietly putting a decision you had retired back into the prompt; it is now reported as an error instead. Hand-written text longer than the tool's own limits is no longer truncated and written back shortened, and any extra keys you add to a note survive a rewrite. The file is written atomically, so an interrupted save can no longer leave it corrupt — which previously would have blocked every future note until repaired by hand.
- **Notes are dated by your clock** — dates were stamped in UTC, so a note recorded just after midnight in Europe was dated yesterday, and an evening note in the Americas was dated *tomorrow* and then sorted to the top of the digest permanently.
- **Editing or deleting notes no longer needs an add-on restart** — the digest was rebuilt only when OpenCode wrote a note or the add-on restarted, so a note you edited or deleted by hand kept being sent unchanged until a restart. It is now also rebuilt whenever the terminal session starts, and `ha-context refresh` applies an edit immediately. A `decisions.yaml` that cannot be parsed no longer silently removes your standing context either — OpenCode is told the file is unreadable and to help you fix it, rather than being left to conclude that nothing was ever decided.
- **The briefing waits for Home Assistant to finish starting** — Core reports `STARTING` until its integrations have loaded, and a snapshot taken then baked wrong entity counts into every session. It now waits for `RUNNING` before taking the snapshot, and a briefing written without live data now says plainly what is missing instead of presenting a configuration-only picture as complete. `ha-context refresh` no longer replaces a good briefing with a poorer one before it knows whether Home Assistant is reachable.
- **`ha-context` shows the whole picture** — it listed three of the four files sent to the model, omitting `AGENTS.md`, the largest of them. It now lists all four, each with a short note on what it may contain and who wrote it, which also answers a question raised in testing: an entity name can appear in the decision-notes digest (each note carries the entities attached to it) but never in the install briefing, which contains no entity names at all. `ha-context reset --notes` without `--yes` now refuses before deleting anything rather than after, `refresh` reads your actual add-on options instead of assuming both features are on, and `briefing`/`notes` explain themselves when the file does not exist instead of printing nothing.
- **The one-time `AGENTS.md` backup can no longer overwrite an earlier one**, which could have destroyed the only copy of rules a user had written.

Test coverage for this area grew from 220 to 283 cases, including the byte-budget guarantees, the truncation warnings, secret screening on the read path, and bulk supersede.

## 2.3.8b0

- **Sessions now start knowing your installation ([issue #63](https://github.com/magnusoverli/opencode/issues/63))** — every new session used to begin from zero, spending its first turns re-reading `configuration.yaml`, listing areas and searching for entities before it could help with anything. The add-on now writes an **install briefing** at every start and gives it to OpenCode up front: Home Assistant version, installation type and hardware, how your configuration is split up (`!include` layout, whether `packages/` is in use, and whether `automations.yaml` is owned by the UI editor and will be rewritten on save), your areas and floors by name, entity counts per domain, the integrations and device stacks actually in use, your custom components, and which add-on capabilities are switched on. The result is that OpenCode stops guessing at area and entity names and stops rediscovering the shape of your setup in every conversation. Two properties make this safe to leave on: it is **rebuilt from scratch on every start** rather than appended to, and capped at roughly 500 tokens, so it cannot grow into a per-request tax; and it is generated by the add-on rather than by the model, so it can summarise privileged sources without exposing them — `secrets.yaml` contents, access tokens and your coordinates are never included. Home Assistant Core is often still starting when the add-on comes up, so the briefing is written from your configuration files alone (which needs no running Core) and enriched a few moments later, saying so plainly while it is incomplete. Controlled by the new **Install briefing** option, on by default.
- **Your own instructions now survive add-on updates** — the documentation told you to add your rules to `/config/AGENTS.md`, and the add-on then overwrote that file on every update as long as it still contained its original `# Home Assistant OpenCode Rules` heading — which every customized copy did. Following the documented advice therefore lost your customizations at the next update, and the only way to keep them was to break the heading, which also opted you out of all future instruction updates. There is now a supported place for your own rules: **`/config/AGENTS.local.md`**, loaded at the start of every session alongside `AGENTS.md` and never written by the add-on. A commented example is placed at `/config/AGENTS.local.md.example` on first install; rename it to start using it, delete it to stop. `AGENTS.md` still takes precedence where the two conflict, so safety and approval rules cannot be overridden. Separately, `AGENTS.md` itself is no longer refreshed on a heading match: the add-on records a hash of exactly what it wrote and refreshes only a byte-for-byte match, leaving edited copies alone. The first time it cannot tell an edited file from an untouched one it saves a `.bak` copy before refreshing, so no version of the file is ever lost.
- **Decision notes carry the reasoning between sessions** — your YAML records *what* your setup does but cannot record *why*: that an integration was removed on purpose, that a toggle is inverted deliberately to match a vendor app, that some corner should be left alone. That is the knowledge that actually disappears between sessions, and re-explaining it every time is the cost this removes. OpenCode can now record such decisions in `/config/opencode/decisions.yaml` — but **only after you explicitly approve each one**, which keeps the feature consistent with the add-on's first rule about never changing anything without asking. The notes are plain YAML you own: readable in File Editor, editable by hand, included in your Home Assistant backups, and clean to diff if you keep `/config` under version control. Context cost stays flat by design rather than by hope: only the decision lines of *active* notes are injected, while rationale and retired notes stay in the file and are fetched on demand; active notes are capped at 40 and the injected digest at roughly 500 tokens; and a replaced decision is marked superseded rather than deleted, so it leaves the session digest while staying on the record. Notes containing a password, token or any value found in your `secrets.yaml` are rejected outright — a note reaches the model in every future session, so credentials have no business in one. Controlled by the new **Decision notes** option, on by default.
- **Three new MCP tools** — `remember_decision` (records a decision, and refuses unless you approved it), `recall_decisions` (the full notes including rationale and superseded history), and `supersede_decision` (retires notes that no longer apply). With **Decision notes** turned off they are not advertised to the model at all, rather than being offered and then failing. The tool documentation also now covers `zigporter_run`, which had been available but undocumented, bringing the documented count to 41.
- **New `ha-context` command** — `ha-context show` prints the exact context OpenCode is given about your setup, `ha-context status` summarises which files are in play and roughly what each costs in tokens, `ha-context refresh` regenerates on demand, and `ha-context reset` clears the generated files. Everything the add-on assembles about your home is a plain file you can read, and this is the shortest way to read it.

Thanks to [@tanc](https://github.com/tanc) for raising this in [issue #63](https://github.com/magnusoverli/opencode/issues/63), and to [@base1en](https://github.com/base1en) for designing and prototyping the file-based persistent-context pattern this is built on — including spotting that customizations added to `AGENTS.md` were being overwritten on add-on updates, which is fixed above. The bootstrap pattern @base1en adapted was shared by [Paul Hibbert](https://www.youtube.com/@PaulHibbert). This implementation differs from that prototype in one respect: rather than instructing the model to read a file at session start, the files are wired into OpenCode's native `instructions` mechanism, so they load deterministically instead of depending on the model choosing to read them — which matters most on the smaller local models this add-on is often pointed at.

## 2.3.7b1

- **Optional OpenChamber LAN web UI** — added a new `enable_openchamber_lan` option (only active when `interface_mode: openchamber`) that publishes the OpenChamber UI on a mappable network port (`4097/tcp`), mirroring the existing OpenCode LAN server on `4096/tcp`. It runs a second instance of the ingress proxy bound to `0.0.0.0` with the remote-address allowlist relaxed (via `OPENCHAMBER_ALLOW_ANY_REMOTE`) and serves the UI at the root path `/`, so reverse proxies and tunnels (e.g. Cloudflare Tunnel) can point straight at a backend without an ingress-path redirect/rewrite. Off by default; requires both enabling the option and mapping `4097/tcp` in Network settings. No Home Assistant Ingress auth sits in front of the mapped port, so it is intended for trusted networks or behind a reverse proxy / access control.

## 2.3.7b0

- **The Configuration tab is reorganised and rewritten** — the add-on had grown to 25 options rendered as one flat list, in an order that had drifted as features were added. Home Assistant's add-on Configuration tab supports no headings, no sections and no conditional fields, so ordering is the only grouping tool available, and it was no longer doing the job: **Focus-friendly responses** sat in the middle of the Home Assistant integration options, the two settings that govern what OpenCode is allowed to read (**Restrict access to sensitive files** and **Add-on folder guidance**) sat twelve fields apart, the PPQ provider options were filed with the LAN server under "remote access", and the niche Zigbee2MQTT and serial options sat ahead of everything else. Options are now ordered in eight deliberate blocks — presentation, Home Assistant integration, access control, runtime, network exposure, model providers, optional hardware, advanced — with every dependent field directly beneath the option it depends on, and the rarest and riskiest settings last. **No option was added, removed or renamed in the schema, and no default changed**, so your saved configuration carries over untouched.
- **Option labels and descriptions follow one house style** — the redundant "Enable" prefix is gone from the seven toggles that carried it (a switch already means enable/disable), so **Enable MCP integration** is now **MCP integration**, **Enable screenshot tool** is now **Screenshot tool**, and so on. Descriptions consistently call the assistant "OpenCode" instead of drifting between "the AI", "OpenCode" and "the model"; each one now names its dependency in the first sentence rather than burying it at the end; the four terminal-appearance options say plainly that they do nothing in `openchamber` mode; and the changelog voice ("the update *now* runs in the background"), the one-off restart instruction and the troubleshooting steps wedged into **Interface mode** have all moved out to the documentation where they belong.
- **Better guidance for two easily-mistaken fields** — **Zigbee2MQTT URL** previously offered `http://homeassistant.local:8099` as its example, which is the port *this* add-on serves its own ingress on rather than anything to do with Zigbee2MQTT; it now explains that the add-on discovers Zigbee2MQTT automatically, that the field is a manual override, and that the value should be the address you open the Z2M UI on. The `zigporter` error message carried the same misleading example and has been corrected too. The **Network** tab's caption for port 4096 now states that the port only serves traffic when the **OpenCode LAN server** option is enabled.

## 2.3.6b6

- **Browser provider sign-in no longer hangs on "Saving..." ([issue #54](https://github.com/magnusoverli/opencode/issues/54))** — connecting a provider from the OpenChamber UI with a browser OAuth method (for example **ChatGPT Pro/Plus (browser)**) never finished. OpenCode's browser methods start a callback listener on a loopback port *inside* the add-on container and send the browser to `http://localhost:<port>/auth/callback`; behind Home Assistant Ingress the browser runs on your own device, so that redirect lands nowhere and the pending sign-in request waits on the listener indefinitely — the pasted code is ignored for these methods. The ingress proxy now remembers the loopback redirect from the authorization step and replays it to the in-container listener when you paste the code, so the exchange completes and the provider is saved. Paste either the authorization code or the whole `http://localhost:...` URL your browser failed to open; the on-screen instructions now describe what actually happens instead of promising the window will close by itself. Providers that do not use a loopback callback are unaffected. In `terminal` mode, keep using the provider's **headless** method, which needs no redirect. Thanks to [@DennisSDUSA](https://github.com/DennisSDUSA) for the detailed report and to [@matrix2669](https://github.com/matrix2669) for the headless workaround.

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
