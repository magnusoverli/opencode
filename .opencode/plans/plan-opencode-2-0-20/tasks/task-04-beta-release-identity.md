# Task 04 — Cut the beta release identity: 3.0.0b23

## Goal

Give the beta channel a new version number and record what changed, so the updated runtime is
publishable and users can see which build carries OpenCode 2.0.20.

## Changes

1. **`ha_opencode_beta/config.yaml` line 4** — `version: "3.0.0b22"` becomes
   `version: "3.0.0b23"`. Change nothing else in the file. In particular do not touch
   `name`, `slug` or `image`; those are the channel's identity and are not part of a version bump.

2. **`ha_opencode_beta/CHANGELOG.md`** — there is an existing `## [Unreleased]` section at the
   top holding two unreleased entries. Do not delete or move those entries. Add a new
   `## 3.0.0b23` heading **below** the `## [Unreleased]` block and **above** `## 3.0.0b22`, and
   give it entries covering:
   - the OpenCode runtime bump `2.0.13` -> `2.0.20` (CLI and plugin, kept in lockstep);
   - the refreshed pins, naming them so a future reader can see the delta: Node `24.15.0` -> `24.21.0`,
     yq `v4.53.3` -> `v4.54.1`, Prettier `3.9.8` -> `3.9.9`, tsx `4.20.6` -> `4.23.15`,
     `@ai-sdk/openai-compatible` `3.0.53` -> `3.0.60`;
   - the raised dependency floors: `@modelcontextprotocol/sdk` `1.29` -> `1.31`, `ws`
     `8.18` -> `8.22.0`, `yaml` -> `2.9.1`, `vscode-languageserver-textdocument` `1.0.12` -> `1.0.15`;
   - the majors that were deliberately **not** taken, and why, so nobody re-litigates them next
     release: `vscode-jsonrpc` stays at `8.2.1` because 9.x removed the `vscode-jsonrpc/node.js`
     subpath that `lsp-client.js` imports; `vscode-languageserver` stays at `9.x` for the same
     reason; `puppeteer-core` stays at `24.x` because the add-on drives the Debian trixie system
     chromium rather than a bundled Chrome; `zod` stays at `3.x` because it is only a transitive
     dependency of the MCP SDK and is never imported; `vitest` stays at `3.x`;
     `ppq-private-mode` stays at `0.1.0` despite `0.7.0` being available; the OpenChamber
     source revision is unchanged **at the time this task runs** — Task 05 advances it separately,
     so leave that clause out of this changelog entry rather than writing something Task 05
     will invalidate. If Task 05 later amends this section, that is the expected order.

   Match the existing changelog voice: short, user-facing sentences, no commit hashes, no
   issue numbers unless a real one applies.

3. **`ha_opencode_beta/DOCS.md` line 27** — it reads "Beta `3.0.0b16` pins the CLI and plugin to
   OpenCode `2.0.13`". Update it so it names the new beta version and `2.0.20`. Note this line
   was already stale (it said `b16` while the channel was at `b22`), so correct it to `b23`.

4. **Leave `README.md` alone.** The `hooks/pre-commit` version-shield hook watches
   `ha_opencode/config.yaml` only, not the beta config, so no shield regeneration is expected
   or wanted here.

5. **Leave `PLAN.md` alone.** Its pins describe the stable channel's state and are updated by
   whatever work eventually moves stable; this plan does not touch stable.

## File scope

- `ha_opencode_beta/config.yaml`
- `ha_opencode_beta/CHANGELOG.md`
- `ha_opencode_beta/DOCS.md`

## Dependencies

Tasks 01, 02 and 03. The changelog must describe the actual final state of the pins, so it can
only be written once the bumps are settled.

## Verification commands

```bash
# Version bumped and identity otherwise intact
grep -q '^version: "3.0.0b23"' ha_opencode_beta/config.yaml
grep -q '^name: "OpenCode Beta"' ha_opencode_beta/config.yaml
grep -q '^slug: "ha_opencode_beta"' ha_opencode_beta/config.yaml
grep -q '^image: "ghcr.io/magnusoverli/ha_opencode_beta"' ha_opencode_beta/config.yaml
! grep -q '3\.0\.0b22"' ha_opencode_beta/config.yaml

# The changelog has the new section in the right place and kept the unreleased entries
grep -n '^## ' ha_opencode_beta/CHANGELOG.md | head -5
# expect: [Unreleased] then 3.0.0b23 then 3.0.0b22
grep -q '## 3.0.0b23' ha_opencode_beta/CHANGELOG.md
grep -q 'Restore device and entity room assignments' ha_opencode_beta/CHANGELOG.md
grep -q 'external_mcp_config' ha_opencode_beta/CHANGELOG.md

# Docs no longer name the old runtime or the stale beta number
! grep -n '2\.0\.13' ha_opencode_beta/DOCS.md
! grep -n '3\.0\.0b16' ha_opencode_beta/DOCS.md
grep -n '2\.0\.20' ha_opencode_beta/DOCS.md

# Stable channel and the shared docs are untouched
git diff --quiet -- ha_opencode/ && echo "stable clean"
git diff --quiet -- README.md PLAN.md repository.yaml && echo "shared docs clean"
```
