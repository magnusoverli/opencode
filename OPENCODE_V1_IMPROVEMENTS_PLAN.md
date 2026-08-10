# OpenCode V1 Improvements Plan

This plan covers approved OpenCode V1 changes that improve Home Assistant task quality, context relevance, reliability, safety, or user experience. It deliberately excludes V2 adoption, which remains governed by [OpenCode V2 Readiness](OPENCODE_V2_FUTURE.md).

## Scope

1. Run a certified, pinned OpenCode runtime.
2. Deliver Home Assistant knowledge through on-demand Agent Skills.
3. Provide an explicit read-only Home Assistant diagnostics session.
4. Test the supported runtime and Home Assistant integration paths before release.

The opt-in runtime `latest` updater will be removed. Both channels will use a pinned, certified runtime and receive upgrades through tested add-on releases.

## 1. Pin And Certify OpenCode

Implement in `ha_opencode_beta/` first.

1. Pin `OPENCODE_VERSION` to a concrete V1 release in `Dockerfile` and make `build.yaml` the CI-read source for that pin.
2. Update `.github/workflows/build-beta.yaml` to pass the pinned OpenCode version, as it already does for OpenChamber.
3. Remove the background `opencode-ai@latest` installer, persistent-runtime PATH precedence, and the `opencode_update_policy` option.
4. Treat a persisted legacy `opencode_update_policy: latest` value as bundled, log a migration notice, and leave `/data/.npm-global` untouched.
5. Always set `OPENCODE_DISABLE_AUTOUPDATE=true` and show the certified OpenCode version in the terminal banner.
6. Remove update-policy strings from beta configuration, translations, and documentation.
7. Add a weekly read-only upstream-version check so maintainers can deliberately evaluate new releases.

Acceptance criteria:

- The built image installs only the configured OpenCode version.
- No runtime path executes `npm install -g opencode-ai@latest`.
- Existing persistent runtime data cannot override the bundled executable.
- Upgrading an existing add-on with `latest` configured continues safely on the bundled runtime.

## 2. Add Compatibility And Release Coverage

1. Add a PR-triggered CI workflow; current behavioural checks run too late on tag/manual image builds.
2. Run MCP `npm test`, YAML LSP tests, and existing service/proxy tests in beta CI.
3. Add runtime-contract coverage for the version pin, bundled PATH precedence, disabled auto-update, and generated OpenCode configuration.
4. Add an image smoke test for `opencode --version`, generated MCP configuration, local MCP startup, HA YAML LSP startup, and the Ingress-patched OpenChamber launch path.
5. Create a maintainer upgrade checklist covering terminal and OpenChamber sessions, provider sign-in, all MCP profiles, YAML diagnostics, formatting, PPQ, native MCP, and LAN mode.

Acceptance criteria:

- A pull request cannot ship an unpinned OpenCode runtime or break the generated configuration contract.
- Each pinned runtime is validated before beta publication.
- Regression evidence is available before stable promotion.

## 3. Deliver On-Demand Home Assistant Skills

1. Package skills in the image and deploy them into OpenCode's global skill discovery path under `/data/.config/opencode/skills/`.
2. Update untouched add-on-owned skills while preserving user-modified copies and logging a warning rather than overwriting them.
3. Retain consent, scope, secret-handling, and sensitive-directory rules in `AGENTS.md` so they remain unconditional.
4. Move detailed optional workflows into these skills:
   - `home-assistant-configuration`: integration docs, safe YAML changes, validation, backup, reload, and restart guidance.
   - `home-assistant-troubleshooting`: bounded diagnostics, entity state/history/log investigation, and recommendation-only outcomes.
   - `home-assistant-dashboard-ui`: Lovelace workflow and screenshot-based verification.
   - `home-assistant-zigbee-esphome`: firmware monitoring, safe device inspection, rename constraints, and mesh work.
   - `home-assistant-development`: custom integrations, add-ons, native LLM tools, and MCP development.
5. Keep a concise capability map in `AGENTS.md` so the appropriate skill remains discoverable without injecting every procedure into every request.
6. Extend agent-evaluation scenarios with configuration and diagnostic tasks to measure expected tool selection and bounded-query behaviour.

Acceptance criteria:

- Skills are detected by the pinned OpenCode runtime.
- Core safety rules remain loaded in every session.
- Optional workflow guidance is loaded only when relevant.
- Evaluation and beta testing show equal or better Home Assistant tool selection and task completion.

## 4. Add A Read-Only Home Assistant Session

1. Add a `home-assistant-read-only` primary agent with denials for `edit`, `bash`, `task`, and `lsp`.
2. Enforce sensitive-file read denials in this agent regardless of normal add-on settings.
3. Add a final OpenCode configuration overlay and `ha-readonly` launcher.
4. Force the existing `compact` MCP profile so hidden control, updates, configuration writes, `hab`, and Zigbee administration tools are omitted and server-rejected.
5. Disable `homeassistant_native` in the overlay because native tools are not filtered by the compact MCP profile.
6. Preserve normal sessions: do not make this the default agent and do not add a global option that changes existing workflows.
7. Add `ha-readonly` to terminal help and document its purpose: investigate and diagnose there; exit and use normal OpenCode only for approved changes.

Acceptance criteria:

- `ha-readonly` can inspect and diagnose Home Assistant state.
- It cannot edit files, run shell commands, access restricted files, invoke native MCP, call services, or write configuration.
- Normal OpenCode sessions retain the user's selected MCP profile and all existing capabilities.

## 5. Test The Read-Only Contract

1. Add MCP tests proving compact-profile discovery and dispatch rejection for mutating tools.
2. Add tests for agent and skill frontmatter, managed deployment, overlay content, native-MCP disablement, and denied permissions.
3. Run an image-level beta test using `ha-readonly` to verify capabilities and rejected mutation attempts.
4. Run normal-session regression tests to verify no capability loss.

## 6. Release Sequence

1. Implement runtime, skills, agent, overlays, tests, documentation, and changelog updates in `ha_opencode_beta/`.
2. Publish and soak a beta release against the acceptance criteria above.
3. Promote `rootfs/`, Dockerfile, and tests with `scripts/promote-beta-to-stable.sh`.
4. Manually mirror stable-specific `config.yaml`, translations, documentation, and changelog changes.
5. Update `OPENCODE_V2_FUTURE.md` to note that V1 runtime governance and regression coverage are in place; keep V2 deferred until its release gates are satisfied.

## Key Files

- Runtime: `ha_opencode_beta/Dockerfile`, `build.yaml`, `rootfs/etc/s6-overlay/s6-rc.d/init-opencode/run`, `rootfs/usr/local/bin/opencode-session.sh`, and `rootfs/usr/local/bin/opencode-update.sh`.
- Configuration: `rootfs/opt/ha-mcp-server/opencode-ha.json`.
- New skills, agent, overlay, and launcher: `ha_opencode_beta/rootfs/opt/ha-mcp-server/` and `ha_opencode_beta/rootfs/usr/local/bin/`.
- Tests: `rootfs/opt/ha-mcp-server/test/`, `rootfs/opt/ha-lsp-server/test/`, root `test/`, and a new CI workflow.
- User-facing material: `config.yaml`, `translations/en.yaml`, `DOCS.md`, and `CHANGELOG.md` in each channel.
