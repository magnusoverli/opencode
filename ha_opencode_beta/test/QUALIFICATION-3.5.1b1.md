# Beta 3.5.1b1: qualification findings

## Scope and acceptance

Follow-up to the operator's 3.5.1b0 self-test report. Full release acceptance
remains incomplete; this beta addresses its two confirmed source findings.
Code Mode remains default-off. No installed app settings, services or retained
data were changed during this follow-up.

| Finding | Resolution |
| --- | --- |
| A transient writer during the post-quarantine process scan could be missed and its data deleted | Remove live deletion. Preserve reviewed cache in quarantine, recheck metadata after the scan, and report zero immediately reclaimed bytes. Only recorded, unchanged data can expire after seven days at verified cold startup. |
| Tool descriptions/instructions incorrectly claim HAB 1.7.2 is pinned | Instructions now identify 1.8.0; tool descriptions and rejection messages refer to the app's pinned HAB without duplicating a version. Historical allowlist review provenance and older schema fixtures remain intact. |

## Behavioral contract

- `opencode legacy-data quarantine-cache --review <revision>` preserves the
  directory at `/data/.cache/.opencode-retired-<revision>`.
- `clean-cache` remains a compatibility alias with the same quarantine behavior.
  Neither live command deletes files or immediately reclaims disk space.
- Successful output reports `status: "quarantined"`, `quarantine_path`,
  `reviewed_bytes` and `bytes_reclaimed: 0`. Inventory exposes
  `quarantine_supported` and always reports `cleanup_supported: false`.
- If post-quarantine observations detect changes or fail, the directory remains
  available for inspection. Existing quarantines and recreated cache directories
  are preserved.
- Metadata checks and process scans do not freeze writers or guarantee an idle,
  immutable quarantine. A final snapshot is not an atomic deletion guard.
- The approved compromise is seven-day expiry of recorded, unchanged quarantines
  at a verified cold startup, before s6 launches any app services. The helper must
  be a child of the real container PID-1 entrypoint, with only those two processes
  present. A manual/live invocation is rejected. Host/admin access to the private
  volume is trusted not to write concurrently.
- Root-owned receipts record quarantine time and exact revision. Changed,
  unrecorded, linked, future-dated or unsafe candidates are retained. Interrupted
  removal disarms the receipt before deletion so any remainder is not retried.
- Logging includes removed directory names, logical bytes removed and skip
  reasons; bounded failure does not block app startup.

## Local evidence

- Added the reported transient-writer regression first and ran it against the
  unchanged b0 implementation in a Linux root container: **failed as reported**
  (`ValueError not raised`; 7 existing tests passed).
- After the fix: **10 Linux tests passed, zero skipped**, including a write
  after the last snapshot, recreated cache, existing quarantine, stale review,
  original/active data preservation, open file, links and same-device mount cases.
- After adding the approved startup-retention policy: **16 Linux tests passed,
  zero skipped**. Added grace-period boundary, changed data with restored mtime,
  invalid/missing receipts, clock rollback, extra-process refusal, interrupted
  deletion and manual/live expiry refusal. These supersede rather than add to
  the earlier ten-test count.
- **39 HAB Vitest tests passed** across `hab-cli.test.js` and
  `hab-read-only.test.js`. The initial PowerShell `npm` invocation was blocked
  by execution policy; `npm.cmd` ran the actual Vitest suite successfully.
- Pinned-runtime full MCP catalogue test passed for direct and mixed Code Mode
  after the description edits.
- Local native AMD64 boundary image passed, including all 16 expiry/quarantine
  tests. A disposable Docker volume then verified the actual PID-1 entrypoint:
  aged unchanged quarantine removed, young/changed/unrecorded data and active
  state preserved, and manual expiry rejected. The fixture volume was removed.
- Both modified workflow files passed actionlint.
- `git diff --check` passed.

Reproduction from the repository root, using the existing b0 test image only
as the Linux interpreter/runtime environment and mounting the current source:

```powershell
docker run --rm --entrypoint python3 --mount 'type=bind,source=C:\Users\me513\opencode,target=/repo,readonly' --workdir /repo ha-opencode-beta:3.5.1b0-boundary -B ha_opencode_beta/test/fixtures/opencode-v2-legacy-data.py -v
npm.cmd test --prefix ha_opencode_beta/rootfs/opt/ha-mcp-server -- test/hab-read-only.test.js test/hab-cli.test.js
```

Publication requires the candidate's full PR checks and native AMD64/ARM64 image
checks. Both image and release workflows now run a disposable-volume test of
the shipped PID-1 entrypoint before a stub `/init`: old recorded data is removed,
young/changed/unrecorded data and active state survive, and manual expiry is
refused. Exact workflow results are available on the release commit.

## Remaining installed acceptance

The supplied b0 report established bounded installed identity, native generated
configuration, read-only HA workflows and legacy inventory. It did not establish
actual terminal/OpenChamber approval UI, complete upgrade preservation or paired
real-model performance. Its detailed artifacts were reported under
`/data/v2/cache/opencode/qualification-3.5.1b0/`; they were not independently
retrieved during this source-fix session.

Those gaps remain open for b1. Fixture results and image qualification do not
establish installed acceptance or justify stable promotion.
