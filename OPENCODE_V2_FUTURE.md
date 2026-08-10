# OpenCode V2 Readiness

This document records confirmed OpenCode 2.0 beta changes that affect this Home Assistant add-on. It is a preparation checklist, not a release commitment.

## Status

- Upstream stable is OpenCode v1.18.16. This add-on must remain on the V1 runtime in production.
- **V1 runtime governance is in place.** The add-on ships one certified V1 build, pinned in `Dockerfile` and `build.yaml` and asserted equal by `test/runtime-contract.test.js`; the image build fails if npm resolves anything else; no runtime path installs from npm; and OpenCode's own auto-update is disabled everywhere a session can start. A runtime change is now a deliberate act with a checklist ([`OPENCODE_UPGRADE_CHECKLIST.md`](OPENCODE_UPGRADE_CHECKLIST.md)) rather than a background install.
- **Regression coverage is in place.** `pr-checks.yaml` runs the MCP server suite, the YAML language server suite and the add-on contract tests on every pull request; `opencode-smoke-test` verifies the assembled image on a real Home Assistant instance; `check-opencode-update.yaml` reports new upstream releases weekly without changing a pin. That is the harness a V2 evaluation would be run against — it does not shorten the gate list below.
- V2 remains deferred. Nothing above satisfies a release gate; they make the gates checkable.
- OpenCode 2.0 is an active beta, installed separately as `opencode2` from `@opencode-ai/cli@next`.
- Upstream has not announced a general-availability date. Its migration guide warns that beta data, APIs, configuration, and plugin APIs may change.

Sources: [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1), [V2 config](https://opencode.ai/v2/docs/config), [upstream 2.0 branch](https://github.com/anomalyco/opencode/tree/2.0).

## Required Compatibility Work

1. Add a CI-only V2 smoke-test lane. Install and invoke `opencode2` independently of the certified V1 runtime; never make V2 the default runtime or update target while it is beta. The certified pin is the production runtime and a V2 lane must not touch it.
2. Keep generating the V1 configuration shape for production. V2 is intended to normalize supported V1 configuration in memory, so use the existing configuration as the first test input.
3. Add an explicit V2 configuration fixture only after V1 compatibility is verified. Translate:
   - `mcp.<name>` to `mcp.servers.<name>`.
   - `enabled` to inverse `disabled`.
   - one MCP `timeout` to `timeout.catalog` and `timeout.execution`.
   - `permission` to ordered `permissions`, including `bash` to `shell`, `task` to `subagent`, and `write`/`patch` to `edit`.
   - `agent`/`mode` to `agents`, `provider` to `providers`, and singular config fields such as `snapshot` to `snapshots`.
4. Test both Home Assistant MCP servers, their enablement state, tool profiles, and timeouts. The add-on's stdio MCP boundary should remain the supported integration surface.
5. Test the injected PPQ custom provider. Upstream has an open V2 compatibility report for custom providers declared using the V1 form.
6. Isolate any OpenCode HTTP/SDK client use behind one adapter before adopting V2. V2 intentionally changes its server API and clients.
7. Do not migrate OpenChamber until it explicitly supports V2. The add-on pins and patches its current V1-compatible distribution for Home Assistant Ingress.

## Current V2 Blockers

- **LSP:** V2 accepts `lsp` configuration but does not start servers, expose an LSP tool, or return diagnostics. This would regress the HA YAML language server.
- **Formatters:** V2 accepts formatter configuration but does not run formatter commands. This would regress the Prettier workflow.
- **Configured instructions:** V2 accepts configured instruction paths but does not load them. `AGENTS.md` remains the active mechanism.
- **Plugins:** the V1 plugin API is intentionally incompatible, while V2's replacement is beta.
- **TUI configuration:** V2 replaces layered `tui.json(c)` files with one global `cli.json` file.
- **Session sharing:** configuration is accepted but sharing is not implemented.

Sources: [V2 LSP](https://opencode.ai/v2/docs/lsp), [V2 plugin API](https://opencode.ai/v2/docs/build/plugins), [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1).

## Release Gates

Do not offer V2 to Home Assistant users until all of the following are true:

1. Upstream publishes a stable V2 release and supported distribution suitable for the add-on image.
2. V2 has a working LSP runtime and formatter execution, verified with the HA YAML LSP and Prettier.
3. All generated configuration, MCP profiles, native MCP bridge, PPQ provider, terminal ingress, LAN server, and OpenChamber paths pass automated smoke tests.
4. V1 session/config migration is demonstrated on a copy of persistent add-on data, with rollback documented.
5. Plan/read-only modes enforce non-mutation for Home Assistant configuration work.
6. The V2 server/client contract and any plugins used by the add-on are stable and tested.

## Risks To Recheck

- [#41081](https://github.com/anomalyco/opencode/issues/41081): custom V1 provider configuration may not work in V2.
- [#41346](https://github.com/anomalyco/opencode/issues/41346): V1 session-data migration failure report.
- [#41476](https://github.com/anomalyco/opencode/issues/41476): Plan mode mutation report.

Review this document when upstream releases V2, resolves a listed blocker, or changes the V2 migration guide.
