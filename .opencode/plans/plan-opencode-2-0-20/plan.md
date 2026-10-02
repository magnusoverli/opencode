# Plan: update the beta add-on to OpenCode 2.0.20, refresh its pins, advance OpenChamber

> **Revised 2026-09-30** after a version re-check. The original plan targeted OpenCode `2.0.18`
> and yq `v4.53.6`; both moved during planning. `2.0.18` → `2.0.20` and yq `v4.53.6` → `v4.54.1`
> (a **minor** bump, not the patch the original plan assumed). `@modelcontextprotocol/sdk` also moved
> `1.30.1` → `1.31.0` and `@ai-sdk/openai-compatible` `3.0.57` → `3.0.60`. All other pins verified
> unchanged.
>
> **Revised again 2026-09-30** to add Task 05 (OpenChamber `9fba129` → `v2.0.4`). OpenChamber was
> originally listed as held back; a follow-up check found the pin actually carries web package
> version **1.24.2**, not the `2.0.0-preview.8` the add-on declares, and is **363 commits /
> 300 files** behind. OpenChamber v2.0.0 is the release that natively targets OpenCode 2, so the
> add-on currently runs an OpenCode 2 agent behind a 1.x web UI, held there by five local patches.
> That is a real gap, so it became a task rather than a footnote.

## Goal

Move the **beta channel only** (`ha_opencode_beta`, currently `3.0.0b22`) from the bundled
OpenCode V2 runtime `2.0.13` to `2.0.20`, and refresh the remaining pinned dependencies
in that channel to their latest compatible versions. Bump the beta add-on version to
`3.0.0b23` and record the change in the changelog so the channel stays publishable.

The stable channel (`ha_opencode`) is deliberately **not** touched: `scripts/promote-beta-to-stable.sh`
is intentionally disabled and states that each stable change needs its own reviewed
identity, migration and release-note handling.

## Scope

**Touched (beta channel only):**

- `ha_opencode_beta/Dockerfile`
- `ha_opencode_beta/build.yaml`
- `ha_opencode_beta/config.yaml`
- `ha_opencode_beta/DOCS.md`
- `ha_opencode_beta/CHANGELOG.md`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package-lock.json`
- `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package.json`
- `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package-lock.json`
- `ha_opencode_beta/rootfs/opt/ha-mcp-server/package.json`
- `ha_opencode_beta/rootfs/opt/ha-lsp-server/package.json`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-usage-model.cjs` (comment/behaviour re-check only)
- `ha_opencode_beta/rootfs/opt/openchamber/patch-{app-updates,editor-lsp,ingress,managed-backend,usage-model}.*`
- `ha_opencode_beta/test/fixtures/openchamber-update-notices.json`
- `ha_opencode_beta/test/runtime-contract.test.js` (the single OpenChamber version regex, Task 05 only)

**Explicitly out of scope:** `ha_opencode/**` (stable), `PLAN.md`, `repository.yaml`, and every
`.github/workflows/*` file. `README.md` is untouched because the pre-commit version shield hook
only reacts to `ha_opencode/config.yaml`, not the beta config.

## Reasoning

The pin is asserted in four places per channel (`Dockerfile` ARG, `build.yaml` args,
`package.json` dependencies, committed `package-lock.json`). `ha_opencode/test/runtime-contract.test.js:145-150`
requires the Dockerfile and build.yaml pins to match the two `package.json` dependencies, and the
Dockerfile itself hard-fails the build when the resolved version differs from the pin. So the
version bump is only correct when all four move together, which is why Task 1 is a single atomic task.

A full dependency refresh was requested. That request spans patch bumps and major upgrades with
very different risk profiles, so this plan separates them: Tasks 1-3 do the refresh, and the held-back
majors are listed explicitly under **Risks** with the reason and the evidence for each, rather than
being silently skipped or silently performed.

Three findings shaped the task split:

1. `ha_opencode/rootfs/opt/openchamber/patch-usage-model.cjs:49` documents that it matches
   "OpenCode 2.0.13's active / creation-time / ID selection". Moving to 2.0.20 means crossing
   **seven** releases (2.0.14 through 2.0.20), so the re-check in Task 1 spans a wider diff than the
   original five-release plan assumed. If that rule changed, it is a behavioural change to the Usage
   view, not a comment edit, and Task 1 stops rather than guessing.
2. `vscode-jsonrpc` 9.x removed the `vscode-jsonrpc/node.js` subpath in favour of `vscode-jsonrpc/node`.
   Both `lsp-client.js:7` and `ha-lsp-server/test/stdio-completions.test.js:5` import the `.js` form,
   so that upgrade is a code migration rather than a version bump. It is held back, not done.
3. yq's `v4.53.6` → `v4.54.1` is a **minor** release, not the patch the original plan assumed
   (`v4.53.6` was published 2026-08-20; `v4.54.1` on 2026-09-29). yq is a static Go binary that reads
   and transforms the user's Home Assistant YAML, tolerating HA's custom tags, so a minor bump is
   treated as a real (if small) change and is called out in Task 2 rather than filed under "patch".

## References

| File | Role |
|---|---|
| `ha_opencode_beta/Dockerfile` | `ARG OPENCODE_V2_VERSION` (line 83) and every other pin (lines 3, 11, 13, 58, 61, 81-88); fails the build on pin/resolve mismatch (lines 254-259) |
| `ha_opencode_beta/build.yaml` | CI-read pin mirror; must match the Dockerfile ARG defaults |
| `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json` | Locked V2 runtime deps; feeds `npm ci` |
| `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/scripts/verify-versions.js` | Asserts CLI/plugin pins match the lock |
| `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package.json` | Standalone PPQ proxy + tsx; locked |
| `ha_opencode_beta/rootfs/opt/ha-mcp-server/package.json` | Unlocked (`npm install`), caret ranges float at build time |
| `ha_opencode_beta/rootfs/opt/ha-lsp-server/package.json` | Unlocked (`npm install`), caret ranges float at build time |
| `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/lsp-client.js` | Imports `vscode-jsonrpc/node.js` (line 7) |
| `ha_opencode/test/runtime-contract.test.js` | Cross-channel contract; also runs against beta via `CHANNEL` |
| `scripts/check-addon-options.sh` | Per-channel add-on option validation |
| `.github/workflows/pr-checks.yaml` | Authoritative list of CI checks (lines 33-82) |

## Tasks

| # | Task | Depends on |
|---|---|---|
| 1 | Bump the OpenCode V2 runtime to 2.0.20 across all four beta pins | — |
| 2 | Refresh the low-risk pinned dependencies in the beta channel | 1 |
| 3 | Raise the floor on the unlocked floating ranges (MCP + LSP servers) | 1 |
| 4 | Beta release identity: `3.0.0b23`, changelog, docs | 1, 2, 3 |
| 5 | Advance OpenChamber to `v2.0.4` and re-derive its five patch anchors | 1, 2, 3, 4 |

Task 05 runs last on purpose: the OpenCode bump changes the model-selection semantics that
`patch-usage-model.cjs` encodes, so re-deriving that patch before the runtime is settled would mean
doing it twice. Task 04 (changelog) precedes it so the release note can describe the final pin set;
its OpenChamber entry must be amended when Task 05 lands.

## Risks

### Held back deliberately (require a code migration, not a version bump)

| Dependency | Pinned | Latest | Why held back |
|---|---|---|---|
| `vscode-jsonrpc` | 8.2.1 | 9.0.3 | **9.x removed the `./node.js` export subpath** (8.2.1 has no `exports` field; 9.0.3 exposes only `.`, `./node`, `./browser`). `lsp-client.js:7` and `ha-lsp-server/test/stdio-completions.test.js:5` both import `vscode-jsonrpc/node.js` and would break. Needs a source change plus LSP acceptance testing. |
| `vscode-languageserver` | ^9.0.1 | 10.1.2 | Major, and it is the package that pulls `vscode-jsonrpc` 9. Must move in lockstep with the change above. |
| `puppeteer-core` | ^24.0.0 | 25.12.0 | Major. The add-on drives the **Debian trixie system chromium (154.0.8037.57)** via `PUPPETEER_EXECUTABLE_PATH`, not a bundled Chrome, so a puppeteer major risks a CDP mismatch in the screenshot MCP tool. `^24.0.0` already resolves to the current 24.43.1. |
| `zod` | ^3.25.0 | 4.6.5 | `zod` is **never imported** by `ha-mcp-server` or `ha-lsp-server`; it is only a transitive dependency of `@modelcontextprotocol/sdk`, which declares `zod: ^3.25 || ^4.0` in 1.29.0, 1.30.1 **and** 1.31.0 (re-verified). Bumping to 4 forces a major across the tree for no gain. Left at `^3.25.0`. |
| `vitest` | ^3.1.1 | 5.0.2 | Two majors, and it is a devDependency excluded by `npm ci --omit=dev`, so it never reaches the image. Its own tests are the MCP/LSP suites. |
| `ppq-private-mode` | 0.1.0 | 0.7.0 | Six breaking minors in a `0.x` line (semver-breaking throughout; 0.6.0 at plan time, now 0.7.0). The Dockerfile asserts the proxy API surface at build time (`startProxy`, `tinfoil.SecureClient`); a 0.1 → 0.7 jump is the highest-risk item in this plan and deserves its own task. |

> `OPENCHAMBER_REVISION` was originally listed here. It is no longer held back — it is Task 05, for
> the reasons in **OpenChamber** below.

### OpenChamber (Task 05)

| | Pinned | Target |
|---|---|---|
| `OPENCHAMBER_REVISION` | `9fba129` (2026-09-19) | `a5b7ee8` = tag `v2.0.4` (2026-09-28) |
| Actual web package version at that pin | **1.24.2** | **2.0.4** |
| Declared `OPENCHAMBER_VERSION` label | `2.0.0-preview.8` | `2.0.4` (see below) |
| Distance | — | **363 commits, 300 files** |

Findings that shape this task:

- **The declared label is wrong today.** `OPENCHAMBER_VERSION=2.0.0-preview.8` does not describe the
  pinned source, which is OpenChamber 1.24.2. The label is self-assigned, written to
  `/usr/local/share/openchamber-certified-version`, and **read by nothing** in the add-on — unlike its
  V2 counterpart `opencode-v2-certified-version`, which `runtime.sh` and `opencode-v2-self-test` do read.
  Task 05's recommendation is to set the label to the real `2.0.4` and relax
  `runtime-contract.test.js:98` from `^2\.\d+\.\d+-preview\.\d+$` to `^2\.\d+\.\d+(?:-preview\.\d+)?$`.
  The alternative, `2.0.4-preview.1`, leaves the test untouched but keeps a label that misdescribes
  the pin. **This is the one decision in the plan that changes an existing contract assertion.**
- **The add-on is running an OpenCode 2 agent behind an OpenCode 1.x web UI.** OpenChamber v2.0.0
  ("OpenChamber now runs on OpenCode 2") is the release that adopted the runtime this add-on already
  ships. The current arrangement works only because five local patches bridge the two.
- **All five patches are exact-match anchored and throw on drift by design**
  (`patch-app-updates.cjs` states "source drift must fail builds"). They are therefore a drift
  *detector*, so a failed build after this bump is the mechanism working, not a regression. The task
  forbids replacing those throws with silent no-ops.
- **One failure is predictable:** v2.0.4 adds a Dutch locale (`nl.ts`, `nl.settings.ts`).
  `patch-app-updates.cjs` scans every `*.ts` under `packages/ui/src/lib/i18n/messages` and throws
  `Unreviewed update-notice locale` for any file containing the update key that was not reviewed, so
  the build fails until Dutch strings exist. Other likely breaks: the `FilesView.tsx` and
  `bootstrap-runtime.js` anchors in `patch-editor-lsp.cjs`, and the
  `selectionSource: "auto",` (exactly 3 occurrences) assertion in `patch-usage-model.cjs`.
- **The authoritative gate is a Docker image build**, because that is what runs the patches, the bun
  suite and the import smoke tests. The task's local verification proves each patch applies cleanly at
  the new sha, which is the real deliverable; the image build is left to CI.
- Stable must stay on `9fba129`. The five patch scripts and the update-notices fixture exist in
  `ha_opencode/` as byte-identical copies (verified by md5), so this stays cleanly beta-only.

### The pin is a certification, not just a string (discovered during Task 01)

Task 01's original file scope was wrong. `OPENCODE_V2_VERSION` is not only asserted in four
places — it is **hardcoded in shipped runtime code and six test files**, and one of those is a
fail-closed safety guard:

`ha_opencode_beta/rootfs/usr/local/bin/opencode-v2-migrate.py:34` sets `V2_UPGRADE_TARGET = "2.0.13"`,
enforced at line 1758:
```python
if (prior.get("target_version") not in V2_UPGRADE_SOURCES
        or args.target_version != V2_UPGRADE_TARGET):
    raise MigrationError("target_version_mismatch")
```
Under a comment reading *"Shipped beta generations whose native V2 schema is covered by the upgrade
fixture. Unknown builds and downgrades must not open a user's database."* With the runtime at 2.0.20
and the guard at 2.0.13, this raises `target_version_mismatch` and **breaks V1→V2 migration outright
for beta users**. It is a certification that the 2.0.20 V2 schema is still covered by the upgrade
fixture, so Task 01 requires discharging that check before bumping it, and stopping if the schema or
the `id.localeCompare()` tie-break rule changed.

Test-side literals that mean "currently certified version" and must move with the pin:
`test/opencode-v2-runtime.test.js:84` (fails without the edit), `test/opencode-v2-migration.test.js:33`,
`test/v2-lan-fixture.mjs:33`, `test/v2-self-test-policy.py:19`, `test/v2-upgrade-acceptance.py:67`,
`test/managed-cli.test.py:27,29,53,62`. The first three Python suites are **not** run by
`node --test`, so a literal there fails silently — Task 01 runs them explicitly.

By contrast `CHANGELOG.md:65,70` must **not** be edited: those are historical entries describing what
b21/b22 shipped. `opencode-v2-self-test` needs no edit either — it reads the certified version
dynamically from `/usr/local/share/opencode-v2-certified-version`.

**Correction to the record — the "pre-existing failure" was an environment artifact.** Tasks 01 and 02
both reported `openchamber-editor-lsp.test.js` failing with `Cannot find module 'express'`, and this
plan recorded it as a pre-existing, out-of-scope defect. That was wrong. The test needs
`ha_opencode_beta/rootfs/opt/ha-mcp-server/node_modules`, which simply was not installed in this
working environment. Task 03 installed that tree as part of its legitimate work, and the failure
disappeared: the file is 9/9 green and the beta suite went from **242 tests / 238 pass / 1 fail** to
**250 tests / 247 pass / 0 fail**. The extra 8 tests are the editor-LSP ones that had been silently
unrunnable. CI was never affected — `pr-checks.yaml` has a dedicated job that runs
`npm install` in that tree before `npm test`. Net effect: the plan's local baseline was weaker than
believed for Tasks 01-02, and the suite is only now fully exercised.

### `TSX_VERSION` is a four-way lockstep (found during Task 02)

`tsx` cannot move alone. `Dockerfile:236` asserts the installed version equals `${TSX_VERSION}` and
fails the image build otherwise; `test/runtime-contract.test.js:116-123` independently asserts the
Dockerfile ARG, `package.json`, the lock and `build.yaml` are all equal, for both `tsx` and
`ppq-private-mode`. The original Task 02 contract said "Dockerfile lines 3 and 87 only" and so
excluded the `TSX_VERSION` sites — the builder escalated rather than widening its own scope, which
was correct. Note this is the same failure shape as `V2_UPGRADE_TARGET` in Task 01: **pins in this
repo are enforced in more places than the pin files suggest.** Any future pin change needs all
sites moved together, including the test-enforced ones.

### Lockfile delta is real, not surgical (measured during Task 01 review)

The first builder report characterised the `opencode-v2-homeassistant` lockfile regen as "surgically
clean: exactly 20 changed entries, all `@opencode/*`, zero keys added/removed". That was wrong, and
the corrected measurement matters for later tasks:

- lock keys **315 → 317**; 13 added, 11 removed
- **62** version changes, of which only 20 are `@opencode/*`

What moved: 20 `@opencode/*` entries 2.0.13 → 2.0.20, plus the arrival of an AWS SDK / Smithy tree and
an OpenTelemetry tree, `ws`, `undici`, `@types/node`, `fast-check`, `lru-cache`; and the **removal**
of `protobufjs` + its 10 `@protobufjs/*` deps + `long`. Root cause: `@opencode/util@2.0.20` added
five direct dependencies — `@opentelemetry/api-logs`, `@opentelemetry/resources`,
`@opentelemetry/sdk-logs`, `@opentelemetry/sdk-metrics`, `open` — and dropped `protobufjs`.

**Telemetry risk assessed and cleared.** An OpenTelemetry SDK plus `exporter-trace-otlp-http` in an
add-on whose pitch is "nothing exposed on the network" deserves a check rather than a shrug. The
export is fail-closed: `node_modules/@opencode/util/dist/observability/otlp.js` returns `[]` /
`Layer.empty` when `!options?.endpoint`, so no exporter is constructed. The add-on sets no
`OTEL_*` variable anywhere in `rootfs`, `config.yaml` or the Dockerfile, and exposes no telemetry
option. The dependency ships in the image but is inert. Worth a changelog line, not a gate.

### Already latest, no change needed (re-verified 2026-09-30)
`bun` 1.4.2, `ttyd` 1.7.7, `hab` (`home-assistant-build-cli`) 1.6.4, `zigporter` 1.4.2, `tinfoil` 1.2.1,
`prettier` 3.9.9, `tsx` 4.23.15, `ws` 8.22.0, `yaml` 2.9.1, `vscode-languageserver-textdocument` 1.0.15,
`puppeteer-core` 25.12.0 (latest overall, but a major is held back so the pin stays in the 24.x line),
Node `v24.21.0`.

### Regression watch list

- **OpenCode 2.0.20 is under 24h old** (published 2026-09-29 21:05 UTC) and the jump from the pinned
  2.0.13 spans seven releases. The add-on's own contract tests would be the first validation of it.
  This was an explicit user decision. `2.0.19` (2026-09-29 04:31) is the fallback if 2.0.20 regresses.
- **Model selection in OpenChamber** — `patch-usage-model.cjs` encodes 2.0.13 session/model selection.
  Re-check in Task 1 and watch `ha_opencode_beta/test/openchamber-usage.mjs` in Task 2.
- **yq v4.53.6 → v4.54.1 (minor)** — reads and transforms user YAML including HA's custom tags. The
  Dockerfile asserts `yq --version | grep -q mikefarah`, which only proves provenance, not flag
  compatibility. Accepted as an explicit user decision.
- **Node 24.15.0 -> 24.21.0** — stays on the Node 24 LTS line, so `runtime-contract.test.js`'s `^24\.\d+\.\d+$` assertion still holds. Low risk, but it is the pin used for the *runtime* Node, not just the build.
- **Prettier 3.9.8 -> 3.9.9** — the shipped formatter is symlinked from the V2 lock and backs the format-tool path (`opencode-v2-formatter-runtime.test.js`).
- **tsx 4.20.6 -> 4.23.15** — pinned runtime for the PPQ TypeScript entrypoint; requires regenerating the `ppq-private-runtime` lock and the Dockerfile asserts `tsx --version`.
- **MCP SDK 1.29.0 -> 1.31.0** — two minors, the only behavioural risk in Task 3. Its `zod` constraint is unchanged, so Task 3's held-back-`zod` reasoning still holds.
- **Pre-existing, unrelated:** `.github/workflows/check-opencode-update.yaml:29-32` greps for `OPENCODE_VERSION` in the *stable* channel, but stable now uses `OPENCODE_V2_VERSION` (see `runtime-contract.test.js:106-111`, "ships no V1 CLI or runtime selector"). That step resolves to an empty string and the job exits 1, so the weekly update check is currently broken. Out of scope here; worth a separate fix.

### Partially-applied work already in the tree

An interrupted builder run left the beta channel pinned to `2.0.18` in `Dockerfile`, `build.yaml`,
`package.json` and `package-lock.json`. Task 1 must retarget those to `2.0.20` rather than assume a
clean baseline. `patch-usage-model.cjs` was **not** reached and still needs its check.

## Verification commands

Run after all four tasks, from the repository root. These mirror `.github/workflows/pr-checks.yaml`.

```bash
# 1. Locked V2 dependency tree resolves and the CLI/plugin pins agree
(cd ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund && npm run verify:versions)

# 2. Beta contract tests (includes the runtime pin + channel contracts)
node --test "ha_opencode_beta/test/*.test.js"

# 3. Per-channel add-on option validation
bash scripts/check-addon-options.sh ha_opencode ha_opencode_beta

# 4. No pin drift between build.yaml and the Dockerfile ARGs
bash -c 'for c in ha_opencode ha_opencode_beta; do
  b=$(sed -n "s/^[[:space:]]*OPENCODE_V2_VERSION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" $c/build.yaml)
  a=$(sed -n "s/^ARG OPENCODE_V2_VERSION=\(.*\)$/\1/p" $c/Dockerfile)
  echo "$c build.yaml=$b dockerfile=$a"; [ "$b" = "$a" ] || exit 1; done'

# 5. Stable is untouched by this plan
git diff --stat -- ha_opencode/ | tee /dev/stderr | grep -q . && { echo "ERROR: stable channel modified"; exit 1; } || echo "stable channel clean"

# 6. PPQ lock and the PPQ package tree still agree
node -e 'const fs=require("fs"),d="ha_opencode_beta/rootfs/opt/ppq-private-runtime/";
const p=JSON.parse(fs.readFileSync(d+"package.json")),l=JSON.parse(fs.readFileSync(d+"package-lock.json"));
for(const k of Object.keys(p.dependencies)) if(l.packages["node_modules/"+k].version!==p.dependencies[k]) throw new Error(k);
console.log("ppq lock consistent")'

# 7. OpenChamber pin and declared label agree across Dockerfile, build.yaml and the fixture
bash -c 'r=$(sed -n "s/^ARG OPENCHAMBER_REVISION=\(.*\)$/\1/p" ha_opencode_beta/Dockerfile);
b=$(sed -n "s/^[[:space:]]*OPENCHAMBER_REVISION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode_beta/build.yaml);
f=$(jq -r .revision ha_opencode_beta/test/fixtures/openchamber-update-notices.json);
echo "dockerfile=$r build.yaml=$b fixture=$f"; [ "$r" = "$b" ] && [ "$r" = "$f" ] || exit 1'

# 8. Stable still on the old OpenChamber revision, byte-for-byte
grep -q "ARG OPENCHAMBER_REVISION=9fba129ddf968df1e5fb6916b84d3ceb35493198" ha_opencode/Dockerfile
git diff --quiet -- ha_opencode/ && echo "stable clean"
```
