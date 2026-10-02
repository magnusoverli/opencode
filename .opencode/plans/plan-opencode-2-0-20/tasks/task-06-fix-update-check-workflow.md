# Task 06 — Repair the read-only OpenCode update check (both channels now track V2)

## Goal

Fix `.github/workflows/check-opencode-update.yaml`, which currently fails on every scheduled run. It was written
against a two-stream world — "stable follows V1 (`opencode-ai`), beta follows V2 (`@opencode/cli`)" — that no
longer exists. Stable 3.0 adopted the V2 runtime, so **both channels now pin the same package**.

The job is read-only by design and must stay that way: it reports drift, it never bumps a pin and never opens a PR.

## Why it fails today

`STABLE_BUILD` and `STABLE_ARG` are extracted with `sed` patterns for `OPENCODE_VERSION`:

```bash
STABLE_BUILD=$(sed -n 's/^[[:space:]]*OPENCODE_VERSION:[[:space:]]*"\([^"]*\)".*/\1/p' ha_opencode/build.yaml)
STABLE_ARG=$(sed -n 's/^ARG OPENCODE_VERSION=\(.*\)$/\1/p' ha_opencode/Dockerfile)
```

`ha_opencode/build.yaml` has no `OPENCODE_VERSION` key and `ha_opencode/Dockerfile` has no such ARG, so both
resolve to the empty string and the guard loop hits `error: OpenCode runtime pin not found` and exits 1.

That absence is **deliberate and contract-tested**, not an oversight: `runtime-contract.test.js:106-111`
("ships no V1 CLI or runtime selector") asserts `assert.doesNotMatch(buildYaml, /OPENCODE_VERSION:/)` and
`assert.doesNotMatch(dockerfile, /opencode-ai@|ARG OPENCODE_VERSION=/)`. Do not "fix" this by reintroducing a
V1 pin.

## Changes

All edits are confined to `.github/workflows/check-opencode-update.yaml`. No add-on pin file is modified — the
job only *reads* `ha_opencode/` and `ha_opencode_beta/`, so the stable channel stays untouched.

1. **Pin extraction** — read `OPENCODE_V2_VERSION` from *both* channels, and keep the two independent sources per
   channel (`build.yaml` for CI, `Dockerfile` ARG for a local `docker build`), because comparing them is the
   drift check that makes the job useful:
   - `STABLE_BUILD` ← `OPENCODE_V2_VERSION` in `ha_opencode/build.yaml`
   - `STABLE_ARG` ← `ARG OPENCODE_V2_VERSION=` in `ha_opencode/Dockerfile`
   - `BETA_BUILD` / `BETA_ARG` — already correct, leave as-is

   Update the inline comment above them, which currently claims stable follows V1 and beta follows V2. It should
   say both channels follow the official V2 package and that no V1 runtime is shipped.

2. **Drop the V1 registry lookup.** The step currently fetches `https://registry.npmjs.org/opencode-ai` and derives
   `V1_LATEST` / `V1_PUBLISHED`. Since the add-on ships no V1 runtime, comparing a V1 pin against it is misleading —
   it would report a stable pin as "behind" on a package that is not installed. Remove the `opencode-ai` fetch, its
   two error checks, and its outputs. Keep the `@opencode/cli` fetch, its error check, and `V2_LATEST` /
   `V2_PUBLISHED`. If you judge that a V1 line still carries informational value, keep it clearly labelled as
   *not shipped by this add-on* — but do not let it drive a warning.

3. **Summary table** — rebuild it around the two channels' V2 pins against the single `@opencode/cli` latest. One
   row per channel, showing the certified pin and the latest release with its npm link and publish date. Drop the
   `Latest V1` row.

4. **Drift check** — keep the existing per-channel `build.yaml` vs `Dockerfile` comparison, which is still correct
   and still the most valuable thing this job does. Both channels now use the same variable names, so make sure
   the two comparisons remain independent rather than collapsing into one.

5. **Status lines** — replace the three V1/V2 status messages with per-channel ones: warn for each channel whose
   pin differs from the latest `@opencode/cli`, and keep a single all-clear line when both match. Preserve the
   existing wording intent, including the instruction to "re-run the complete V2 compatibility lane before changing
   the pin" — that guidance is still exactly right and is the reason this job exists.

## File scope

- `.github/workflows/check-opencode-update.yaml`

Nothing else. In particular do not touch `ha_opencode/**`, `ha_opencode_beta/**`, any Dockerfile, any
`build.yaml`, or any test. Do not commit.

## Dependencies

None. Independent of Tasks 01-05, which are complete. This touches no pin those tasks set.

## Verification commands

The workflow only runs on GitHub, so verify by exercising its shell logic locally against the real files.

```bash
# The corrected extraction finds non-empty, equal pins in both channels
bash -c 'for c in ha_opencode ha_opencode_beta; do
  b=$(sed -n "s/^[[:space:]]*OPENCODE_V2_VERSION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" $c/build.yaml)
  a=$(sed -n "s/^ARG OPENCODE_V2_VERSION=\(.*\)$/\1/p" $c/Dockerfile)
  echo "$c build.yaml=$b dockerfile=$a"
  [ -n "$b" ] && [ -n "$a" ] && [ "$b" = "$a" ] || { echo "FAIL: $c"; exit 1; }
done'
# ha_opencode 2.0.13 / 2.0.13, ha_opencode_beta 2.0.20 / 2.0.20 — both non-empty and equal

# No reference to the removed V1 pin or package remains in the workflow
! grep -n "OPENCODE_VERSION=" .github/workflows/check-opencode-update.yaml
! grep -n "registry.npmjs.org/opencode-ai" .github/workflows/check-opencode-update.yaml
grep -n "OPENCODE_V2_VERSION" .github/workflows/check-opencode-update.yaml

# YAML is still valid and the job/schedule are intact
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/check-opencode-update.yaml'));
print('schedule:', d[True]['schedule']); print('job:', list(d['jobs'])); print('steps:', len(d['jobs']['check-opencode-update']['steps']))"

# Still read-only: it must not bump a pin or open a PR
! grep -nE "gh pr create|git push|--target main|npm version" .github/workflows/check-opencode-update.yaml

# The add-on pins are untouched by this task
git diff --quiet -- ha_opencode/ ha_opencode_beta/ && echo "add-on pins untouched"
```

## Response

Report `complete` / `partial` / `blocked` / `escalate` with:
- the file changed and a summary of each edit
- whether you kept or dropped the V1 registry line, and why
- the output of every verification command
- confirmation that the job is still read-only and that no add-on pin file changed
