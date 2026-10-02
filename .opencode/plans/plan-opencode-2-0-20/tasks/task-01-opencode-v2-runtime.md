# Task 01 — Bump the OpenCode V2 runtime to 2.0.20 (beta)

## Goal

Move the beta channel's bundled OpenCode V2 runtime from `2.0.13` to `2.0.20` so that all four
places that assert the pin agree: the `Dockerfile` ARG, the `build.yaml` CI pin, the two
`package.json` dependencies, and the committed `package-lock.json`. Also confirm that the
OpenChamber usage patch's 2.0.13 model-selection assumption still holds.

## Pre-existing state — read this first

An interrupted builder run already applied a partial `2.0.18` bump. The working tree is **not** a
clean baseline. Current state:

| File | Already changed to |
|---|---|
| `ha_opencode_beta/Dockerfile` | `ARG OPENCODE_V2_VERSION=2.0.18` |
| `ha_opencode_beta/build.yaml` | `OPENCODE_V2_VERSION: "2.0.18"` |
| `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json` | cli + plugin `2.0.18` |
| `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package-lock.json` | regenerated for 2.0.18 |
| `ha_opencode_beta/rootfs/opt/openchamber/patch-usage-model.cjs` | **not** touched — the check below was never done |

Your job is to carry all four from `2.0.18` up to `2.0.20`, not to start from `2.0.13`. Confirm the
actual current values with `git diff` before editing rather than assuming.

## Changes

1. **`ha_opencode_beta/Dockerfile` line 83** — set `ARG OPENCODE_V2_VERSION=2.0.20`. Change nothing
   else in the file. The other lines mentioning `${OPENCODE_V2_VERSION}` (254-259, 270, 313, 343) are
   variable references and must stay as-is.

2. **`ha_opencode_beta/build.yaml`** — set the `args` entry `OPENCODE_V2_VERSION: "2.0.20"`. Keep the
   `# The only OpenCode runtime in this channel; CLI and plugin pins must match.` comment above it.

3. **`ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json`** — in `dependencies`, set
   both `"@opencode/cli"` and `"@opencode/plugin"` to `"2.0.20"`. They must stay equal to each other.
   Leave `prettier`, `vscode-jsonrpc` and the entire `devDependencies` block alone — later work owns those.

4. **Regenerate `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package-lock.json`**
   deterministically from the updated `package.json` using a lockfile-only install, e.g.
   `npm install --package-lock-only --no-audit --no-fund`. Do NOT run a plain `npm install` in that
   directory: it would also rewrite `devDependencies` resolution and add unrelated diff noise.
   The lockfile is tracked in git, so the regeneration is a real committed change. Note
   `@opencode/plugin` pulls in `@opencode/ai`, `@opencode/util`, `@opencode/client`, `@opencode/schema`
   and `@opencode/protocol` — all of those should resolve to `2.0.20` in the regenerated lock.

5. **`ha_opencode_beta/rootfs/opt/openchamber/patch-usage-model.cjs` line 49** — this line currently
   names `2.0.13` ("Match OpenCode 2.0.13's active / creation-time / ID selection"). The bump now
   crosses **seven** releases: 2.0.14 through 2.0.20.
   - Read the surrounding code so you understand what rule it implements.
   - Then check the actual upstream sources for a change to how a session's active model is selected,
     and whether creation-time ordering / session ID selection changed across 2.0.13 → 2.0.20. Diff the
     `2.0.13` and `2.0.20` tags of https://github.com/anomalyco/opencode, or compare the installed
     package trees. Be concrete about which files you looked at.
   - If the behaviour is unchanged: just update the comment so it names `2.0.20` instead of a stale
     version. Do not alter the logic.
   - If the behaviour DID change: STOP. Do not attempt a fix. Report this as a blocker describing
     exactly what changed and what the patch would need to do. That would be a behavioural change to
     the OpenChamber Usage view, not a comment edit, and it needs its own task.

6. **The certified-version literals.** The pin is not only asserted in the four files above; it is
   hardcoded in one piece of **shipped runtime code** and in six test files. All are in scope. Change
   the ones that mean "the version currently certified by this add-on" to `2.0.20`:

   | File | Line | Kind |
   |---|---|---|
   | `rootfs/usr/local/bin/opencode-v2-migrate.py` | 34 | **shipped runtime — read the warning** |
   | `rootfs/usr/local/bin/opencode-v2-migrate.py` | 657 | comment about V1 message tie-breaking |
   | `test/opencode-v2-runtime.test.js` | 84 | test assertion, **currently failing** |
   | `test/opencode-v2-migration.test.js` | 33 | `TARGET_VERSION` |
   | `test/v2-lan-fixture.mjs` | 33 | test assertion |
   | `test/v2-self-test-policy.py` | 19 | `VERSION` passed to `exercise_policy` |
   | `test/v2-upgrade-acceptance.py` | 67 | test assertion |
   | `test/managed-cli.test.py` | 27, 29, 53, 62 | four assertions |

   **Do not change** `ha_opencode_beta/CHANGELOG.md` lines 65 and 70. Those are historical entries
   describing what b21/b22 shipped; editing them would falsify the record. `DOCS.md:27` is
   current-state documentation and belongs to Task 04, not here.

   **Migration guard warning — read this before editing line 34.** `V2_UPGRADE_TARGET` is a
   fail-closed safety assertion, not a version string. It is enforced at
   `opencode-v2-migrate.py:1758`:
   ```python
   if (prior.get("target_version") not in V2_UPGRADE_SOURCES
           or args.target_version != V2_UPGRADE_TARGET):
       raise MigrationError("target_version_mismatch")
   ```
   It sits directly under a comment stating the intent: *"Shipped beta generations whose native V2
   schema is covered by the upgrade fixture. Unknown builds and downgrades must not open a user's
   database."* Left at `2.0.13` while the runtime ships `2.0.20`, this raises `target_version_mismatch`
   and **breaks V1→V2 migration outright for beta users** — a functional regression, not a test
   failure.

   So discharge the certification it represents before changing it:
   - Confirm the V1→V2 schema mapping the upgrade fixture depends on is still valid at 2.0.20: the
     `SOURCE_SESSION_COLUMNS` set and the upgrade write path must match what `@opencode/cli@2.0.20`
     actually creates. Check the upstream `2.0.13` and `2.0.20` tags for schema or migration changes
     in the V2 session/message tables — not just the credential-selection query that step 5 covers.
   - Separately re-verify the line 657 claim, that OpenCode sorts equal-timestamp V1 messages by
     `id.localeCompare()`, still holds at 2.0.20. The upgrade path depends on that ordering.

   If the schema or the tie-break rule **did** change, **STOP** and report a blocker instead of
   bumping the constant: that would mean the upgrade fixture is no longer valid for 2.0.20, which is
   a migration-correctness project of its own.

   Note that `opencode-v2-self-test` reads the certified version dynamically from
   `/usr/local/share/opencode-v2-certified-version` (written by the Dockerfile), so it needs no edit —
   only the test that feeds it a hardcoded `VERSION` does.

## File scope

Only these may be modified:
- `ha_opencode_beta/Dockerfile`
- `ha_opencode_beta/build.yaml`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package-lock.json`
- `ha_opencode_beta/rootfs/opt/openchamber/patch-usage-model.cjs`
- `ha_opencode_beta/rootfs/usr/local/bin/opencode-v2-migrate.py`
- `ha_opencode_beta/test/opencode-v2-runtime.test.js`
- `ha_opencode_beta/test/opencode-v2-migration.test.js`
- `ha_opencode_beta/test/v2-lan-fixture.mjs`
- `ha_opencode_beta/test/v2-self-test-policy.py`
- `ha_opencode_beta/test/v2-upgrade-acceptance.py`
- `ha_opencode_beta/test/managed-cli.test.py`

Do not touch `ha_opencode/**` (stable), `ha_opencode_beta/CHANGELOG.md`, `ha_opencode_beta/DOCS.md`, or
any `package*.json` outside `opencode-v2-homeassistant`. Do not commit.

## Dependencies

None. This is the first task.

## Verification commands

Run these from the repository root and make sure they all pass:

```bash
# The pins agree and the lock resolves to 2.0.20
(cd ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund \
  && npm run verify:versions \
  && node -p "require('./node_modules/@opencode/cli/package.json').version" \
  && node -p "require('./node_modules/@opencode/plugin/package.json').version")
# both should print 2.0.20; verify:versions prints
# "OpenCode V2 pins matching official CLI/plugin 2.0.20"

# build.yaml and the Dockerfile ARG agree on 2.0.20
bash -c 'b=$(sed -n "s/^[[:space:]]*OPENCODE_V2_VERSION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode_beta/build.yaml);
a=$(sed -n "s/^ARG OPENCODE_V2_VERSION=\(.*\)$/\1/p" ha_opencode_beta/Dockerfile);
echo "build.yaml=$b dockerfile=$a"; [ "$b" = "2.0.20" ] && [ "$a" = "2.0.20" ]'

# The full beta contract suite, including the runtime pin contract
node --test "ha_opencode_beta/test/*.test.js"

# No stale intermediate pin left in the beta channel, and stable is untouched
! grep -rn "2\.0\.1[3-9]" ha_opencode_beta/Dockerfile ha_opencode_beta/build.yaml \
    ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json
git diff --quiet -- ha_opencode/ && echo "stable clean"

# No 2.0.13 literal survives outside the two historical CHANGELOG entries
grep -rn "2\.0\.13" ha_opencode_beta/ \
  --exclude=CHANGELOG.md --exclude=DOCS.md --exclude-dir=node_modules \
  | grep . && { echo "ERROR: stale 2.0.13 literal remains"; exit 1; } || echo "no stale 2.0.13"
grep -c "2\.0\.13" ha_opencode_beta/CHANGELOG.md   # still 2 — historical, must be untouched
```

**One pre-existing failure is out of scope and is not yours to fix:**
`openchamber-editor-lsp.test.js` fails with `Cannot find module 'express'` because
`ha_opencode_beta/rootfs/opt/ha-mcp-server/` has no `node_modules` in this environment. It fails
identically on clean `HEAD` (verified by stashing), so it is environmental and pre-existing. Report
it, do not chase it. The Python suites (`managed-cli.test.py`, `v2-self-test-policy.py`,
`v2-upgrade-acceptance.py`) are not run by `node --test`; run them explicitly so their updated
literals are actually exercised:

```bash
for f in managed-cli.test.py v2-self-test-policy.py v2-upgrade-acceptance.py; do
  echo "== $f"; python3 "ha_opencode_beta/test/$f" 2>&1 | tail -5
done
```

If `node --test` fails, report the failing test and its output rather than weakening the test or
reverting the bump.

## Response

Report status as one of `complete`, `partial`, `blocked`, or `escalate`, and include:
- the files you changed with a one-line description each
- the output of the verification commands (especially `verify:versions` and the `node --test` summary line)
- your finding on the `patch-usage-model.cjs` model-selection check: did the 2.0.13 → 2.0.20 rule
  change or not, which files you inspected, and what evidence you based that on
- confirmation that no `2.0.18` remnant remains
- the certified-version literal sweep: every file you changed, and the reasoning for each
- **the migration-guard certification**: whether the V1→V2 schema mapping and the `id.localeCompare()`
  tie-break still hold at 2.0.20, which upstream files you diffed, and your evidence
- the `node --test` summary line, plus the three Python suites' results
- anything you deliberately did not change
