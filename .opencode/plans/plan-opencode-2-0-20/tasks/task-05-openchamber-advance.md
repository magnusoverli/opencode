# Task 05 — Advance OpenChamber to v2.0.4 (beta)

## Goal

Move the beta channel's OpenChamber source pin from revision `9fba129` (2026-09-19, which carries
web package version **1.24.2**) to the `v2.0.4` release, by re-deriving every patch anchor that the
363-commit gap breaks, and by making the declared version identity honest.

The five patch scripts are exact-match anchored and **throw on any source drift by design** — the
comment in `patch-app-updates.cjs` says so explicitly ("source drift must fail builds"). So this task
is not a version edit: it is an iterative re-derivation where the Docker build is the test.

## Target

`OPENCHAMBER_REVISION` becomes `a5b7ee80a3c306eae7d9966de9be00a6168b2bab` — the commit behind the
`v2.0.4` tag. Pin the commit sha, not the tag name: the Dockerfile fetches
`--depth 1 origin "${OPENCHAMBER_REVISION}"` and then asserts `git rev-parse HEAD` equals it, so a
sha works and is reproducible, whereas `main` would move under the build.

## Changes

1. **`ha_opencode_beta/Dockerfile` line 13** — `ARG OPENCHAMBER_REVISION=9fba129ddf968df1e5fb6916b84d3ceb35493198`
   becomes `a5b7ee80a3c306eae7d9966de9be00a6168b2bab`.

2. **`ha_opencode_beta/build.yaml`** — the `OPENCHAMBER_REVISION` entry must match exactly.

3. **Version label — see the decision below.** `OPENCHAMBER_VERSION` (Dockerfile line 84, build.yaml)
   currently reads `2.0.0-preview.8` even though the pinned source is really **1.24.2**. That label is
   self-assigned, written to `/usr/local/share/openchamber-certified-version`, and read by nothing.
   The plan's recommendation is to make it honest:
   - set it to `2.0.4`, matching the real upstream release being pinned, and
   - relax the contract in `ha_opencode_beta/test/runtime-contract.test.js:98` from
     `^2\.\d+\.\d+-preview\.\d+$` to `^2\.\d+\.\d+(?:-preview\.\d+)?$`.

   This is a deliberate contract change, not an accident. The `-preview.N` convention existed because
   the pin was a 1.x-era preview; now that a real stable release is pinned, a preview label would
   repeat exactly the mismatch this task is fixing. The relaxed regex still enforces `2.x.y`.
   If you would rather not touch the test, the alternative is `2.0.4-preview.1` — say which you
   prefer rather than inventing a third option.

4. **`ha_opencode_beta/test/fixtures/openchamber-update-notices.json` line 2** — `"revision"` becomes
   the new sha. `test/openchamber-app-updates.test.js:138-140` compares this fixture against the
   Dockerfile ARG and fails with "Refresh the independent notice fixture when changing the preview pin".

5. **Re-derive the patch anchors.** Fetch the target tree shallowly and run each patch against it to
   see the real failures, rather than guessing which ones broke. Known-suspect anchors:

   | Patch | Anchor that will likely fail | What to do |
   |---|---|---|
   | `patch-app-updates.cjs` | locale set: **v2.0.4 adds Dutch** (`nl.ts`, `nl.settings.ts`) | The script iterates every `*.ts` in `packages/ui/src/lib/i18n/messages` and throws `Unreviewed update-notice locale: ${locale}` for any file containing the update key that was not reviewed. Add correct Dutch `opencodeUpdate.toast.available.manualDescription` / equivalent strings to the fixture's `messages`, and re-check `pending.length !== Object.keys(messages).length` (`Missing preview update-notice locale`). |
   | `patch-editor-lsp.cjs` | `packages/ui/src/components/views/FilesView.tsx` and `packages/web/server/lib/opencode/bootstrap-runtime.js` (exact-match `stage()` anchors, plus the `'Editor LSP auth mount changed'` assertion) | Re-derive each `before`/`after` pair from the v2.0.4 source. The `ha-editor-lsp/*` files this script copies in are add-on-owned, so the copy step is safe, but the two host-file anchors must match new code. |
   | `patch-usage-model.cjs` | `selectionSource: "auto",` must occur exactly 3 times; `Unexpected preview model-selection boundary` | Re-derive. This patch also carries the `2.0.13` comment that Task 01 already revisits — after Task 01 that comment reads `2.0.20`; keep whatever Task 01 settled on. |
   | `patch-managed-backend.cjs` | `server/lib/opencode/*`, `../../index.js` (`REMOTE_CLIENTS_FILE_PATH`, `CLIENT_PAIRING_SESSIONS_FILE_PATH`), `../ui-auth/ui-auth.js` (`JWT_SECRET_FILE`) | Re-derive. The semantic goal is unchanged: route those three paths through `process.env.OPENCHAMBER_AUTH_DIR` so LAN credentials land in the add-on's secured location. |
   | `patch-ingress.js` | operates on built `dist/` output, not source | Runs after the web build; re-validate against the new bundle shape. |

   When re-deriving an anchor, keep the patch's existing failure behaviour. Do not replace an
   exact-match `throw` with a silent no-op to make the build pass — that would defeat the drift
   detection the design depends on.

6. **Do not weaken the build gates.** `Dockerfile` lines 46-53 run, after patching: a `node-pty` spawn
   smoke test, an `import("./packages/web/server/index.js")` smoke test,
   `(cd packages/ui && bun test src/stores/useConfigStore.test.ts)`, `node --test` on the two
   openchamber fixtures, and the `patch-app-updates` / `patch-ingress` / `patch-managed-backend`
   invocations. Leave all of them intact.

7. **Amend the beta changelog.** `ha_opencode_beta/CHANGELOG.md`'s `## 3.0.0b23` section was written
   by Task 04 without mentioning OpenChamber. Add an entry recording the advance to OpenChamber
   `2.0.4` and, in user-facing terms, what it brings — the upstream release notes for v2.0.1 through
   v2.0.4 are at https://github.com/openchamber/openchamber/releases (file-tree diff, per-session
   permission modes, compaction UI, enterprise mode). Describe outcomes, not commit shas. If the
   declared label changed, say so plainly rather than leaving a version that no longer matches
   anything a user can look up.

## File scope

- `ha_opencode_beta/Dockerfile` (lines 13 and 84 only)
- `ha_opencode_beta/build.yaml`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-app-updates.cjs`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-editor-lsp.cjs`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-ingress.js`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-managed-backend.cjs`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-usage-model.cjs`
- `ha_opencode_beta/test/fixtures/openchamber-update-notices.json`
- `ha_opencode_beta/test/runtime-contract.test.js` (only the line 98 regex, if you take the label decision)
- `ha_opencode_beta/CHANGELOG.md` (amend the `## 3.0.0b23` section only)

**Do not touch `ha_opencode/**`.** The five patch scripts and the fixture exist there as byte-identical
copies (verified by md5), and stable must stay on `9fba129` — that is the entire point of the channel split.
Do not add a lockfile for openchamber; it is fetched by revision and built with `bun --frozen-lockfile`
against upstream's own committed lock. Do not commit.

## Dependencies

Tasks 01-04. This runs last, and deliberately: the OpenCode runtime bump changes the model-selection
semantics that `patch-usage-model.cjs` encodes, so re-deriving that patch before the runtime is settled
would mean doing it twice.

## Verification commands

The authoritative gate is a Docker image build, because that is what runs the patch scripts, the bun
suite and the import smoke tests. Run what is feasible locally first, then rely on CI for the build.

```bash
# Fetch the target tree and prove each patch actually applies against it.
# This is the real test of the task: the patches throw on drift, so a clean
# application at the new sha is the deliverable.
WORK=$(mktemp -d)
git init -q "$WORK" && git -C "$WORK" remote add origin https://github.com/openchamber/openchamber.git
git -C "$WORK" -c http.version=HTTP/1.1 fetch -q --depth 1 origin a5b7ee80a3c306eae7d9966de9be00a6168b2bab
git -C "$WORK" checkout -q --detach FETCH_HEAD

P=ha_opencode_beta/rootfs/opt/openchamber
node "$P/patch-app-updates.cjs"     "$WORK"
node "$P/patch-usage-model.cjs"     "$WORK"
node "$P/patch-editor-lsp.cjs"      "$WORK"
node "$P/patch-managed-backend.cjs" "$WORK"
# all four must exit 0 with no "Unexpected preview source" / "Unreviewed ... locale" error

# The pinned revision and the declared label agree everywhere
bash -c 'r=$(sed -n "s/^ARG OPENCHAMBER_REVISION=\(.*\)$/\1/p" ha_opencode_beta/Dockerfile);
b=$(sed -n "s/^[[:space:]]*OPENCHAMBER_REVISION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode_beta/build.yaml);
f=$(jq -r .revision ha_opencode_beta/test/fixtures/openchamber-update-notices.json);
echo "dockerfile=$r build.yaml=$b fixture=$f";
[ "$r" = "$b" ] && [ "$r" = "$f" ] && [ "$r" = "a5b7ee80a3c306eae7d9966de9be00a6168b2bab" ]'

# The label matches the real upstream release it now pins
grep -n 'OPENCHAMBER_VERSION' ha_opencode_beta/Dockerfile ha_opencode_beta/build.yaml

# Beta contract tests, including the app-updates fixture check and the runtime contract
node --test "ha_opencode_beta/test/*.test.js"

# Stable is completely untouched: same revision, same label, same patch bytes
grep -q "ARG OPENCHAMBER_REVISION=9fba129ddf968df1e5fb6916b84d3ceb35493198" ha_opencode/Dockerfile
grep -q 'OPENCHAMBER_VERSION: "2.0.0-preview.8"' ha_opencode/build.yaml
git diff --quiet -- ha_opencode/ && echo "stable clean"

rm -rf "$WORK"
```

If `node --test` fails, report the failing test and its output rather than adjusting the test to match
whatever the patches now produce.

## Response

Report status as one of `complete`, `partial`, `blocked`, or `escalate`, and include:
- which patch anchors actually broke at the new sha, and which ones did not
- what you changed for each one, and whether the semantic intent was preserved
- whether the Dutch locale needed new translations, and what you wrote
- which version-label option you took and, if you relaxed the regex, the exact before/after
- the output of `node --test "ha_opencode_beta/test/*.test.js"`
- explicit confirmation that `ha_opencode/**` is byte-for-byte unchanged
- anything you deliberately did not change, and any patch behaviour you had to alter to make it apply
