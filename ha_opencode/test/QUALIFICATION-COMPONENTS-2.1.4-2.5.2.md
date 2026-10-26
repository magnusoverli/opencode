# Stable OpenCode 2.1.4 / OpenChamber 2.5.2 qualification

## Pins and scope — 2026-10-26

- Official `@opencode/cli` and `@opencode/plugin`: **2.1.4**, matching npm's stable
  `latest` tags when checked. CLI, client/schema contracts and the committed npm
  lock align. No plugin API adaptation was needed by the exercised integration.
- OpenChamber **2.5.2**, release source
  `c4919abc1e7a0a3beeaa126666487806bf79cfe0`.
- Bun **1.4.4**, matching upstream's package manager, with a committed frozen lock
  and multi-architecture builder image pinned by manifest digest.
- Prepared for stable **3.3.2**, retaining the approved hab 1.8.0 changes. Beta
  and running installations are untouched; the release tag triggers native CI.

## Reviewed patches

- Updated the editor source anchor for 2.5.2's translation/import-link dependencies
  without removing those upstream dependencies or weakening edit restrictions.
- Retained app-owned backend lifecycle and private credentials, empty parsed-body
  replay, Ingress URL/assets/terminal WASM fixes, persistent agent settings,
  workspace recovery, provider sign-in guidance and last-model selection.
- Preserved upstream folder-trust assessment, proxy and server fetch guards. Added
  its upstream trust suite to the native build's Git compatibility lane.
- Git credential fallback preserves explicit system/global config controls while
  removing repository and injected per-command selectors. Its enterprise-account
  test uses the fixture CLI and restores PATH even if lookup fails.
- Refreshed body-parser to 2.4.0, undici 6.x to 6.29.1 and Zod 4 to 4.6.6 for four
  reported advisories; retained the other security overrides and vendor patches.

## Local checks

| Check | Evidence |
|---|---|
| Stable add-on contracts | 531 passed, 12 skipped across all `test/*.test.js`; includes real pinned CLI/plugin registration and native MCP/provider/agent flows |
| Copy-on-write migration | 16 passed, including V1 compactions and upgrades from beta-18684, 2.0.13, 2.0.22, 2.0.26 and currently shipped 2.1.2; checks credentials, messages, permissions, failed conversion, restart and downgrade refusal |
| Exact clean OpenChamber source | All source patches apply; patched manifest and changed editor/Git anchors match the tested checkout |
| SDK build | Passed |
| UI type check | Passed with final security dependencies, 3,123 files across two projects |
| Web build / Ingress | Final security-refreshed frontend built successfully; the Ingress, relative asset and terminal WASM patch applies to its generated bundle |
| Upstream Git / GitHub / folder trust | 1,354 passed, 4 skipped across 57 files in a scrubbed environment |
| UI selection / runtime URLs | 134 and 15 passed in separate Bun processes (the same isolation used in Docker) |
| Workspace recovery / provider sign-in | 13 and 5 component cases passed |
| Production runtime fixtures | 9 passed on the final production dependency layout: Git guards, braces depth mitigation, streaming/parsed request framing, private backend credentials, Usage refresh, LAN auth expiry and relay persistence |
| Production dependency audit | 174 package names / 181 name-version pairs, zero reported advisories at check time; OpenCode's production npm audit also reports zero |
| Production native module / server import | node-pty spawned `/bin/true`; patched web server imported successfully on Linux amd64 |

The checks use Node 24.22.0 on Linux amd64, not the full pinned Node 24.21.0 app
image. UI component fixtures are mounted only after the production type check in
Docker; local validation follows that ordering. Root/compiler/browser-dependent
contracts and upstream explicitly skipped cases are not counted as passed.
The audit covers installed package metadata, not OS packages or embedded browser
code. Retained vendor mitigations remain independently regression-tested even
when the advisory service reports no finding.

## Remaining release checks

- Complete the native amd64 and arm64 `boundary-test` image builds, including the
  existing browser, privilege-boundary, startup and hab fixtures. No complete image
  build or arm64 execution was available locally.
- Perform installed Supervisor fresh-install, same-stable update, Ingress/browser
  continuation, and backup-based rollback acceptance. No live HA was changed.
- Folder trust is an extra UI gate, not a CLI/shell sandbox; preserve the backend's
  managed policy. Worktree archives remove their working directories and need
  deliberate user action. Review memory snapshots for secrets before sharing.
