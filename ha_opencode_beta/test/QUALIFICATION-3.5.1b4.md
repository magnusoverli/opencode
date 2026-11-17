# Beta 3.5.1b4: reconcile the stable baseline

## Purpose

Stable 3.5.0 and beta 3.5.1b3 shared a Git branch but not a fully synchronized
implementation. This beta carries the combined candidate for stable 3.5.1.
Stable remains at 3.5.0; the paused stable preparation was archived locally and
removed from the active changes before preparing this beta.

## Reconciliation

| Area | Carried into beta from stable |
| --- | --- |
| Zigporter 1.4.2 | Reviewed compatibility overlay, source provenance and behavioral tests |
| HAB | Registry/state-cache invalidation, in-flight-read protection, 1.8.0 guidance and native fixtures |
| V2 upgrades | Private-copy project placement/archive preservation, 2.1.4 upgrade source and corruption/retention coverage |
| OpenChamber | Expanded upstream trust checks and retained historical patch regression fixtures |

All 3.5.1b0–b3 runtime changes remain. The reconciliation preserves beta's
sidecar identity, decision-note root, companion ownership, native MCP startup
provenance, pattern-refresh URLs and browser namespace.

`stable-baseline.test.js` inventories stable's tracked runtime/build/compatibility
files and requires matching beta files outside a documented divergence list.
It also compares the entire migration and MCP integration sources after narrowly
normalizing intentional native-update, channel-URL and HAB-description differences.
The shared CI job runs this check even on stable-only changes. Remaining
exceptions need semantic review; an allowlist alone cannot prove behavior.

## Local evidence

- Baseline, channel-pattern and historical Git-helper checks: 13 passed.
- HAB request/cache behavior: 23 Vitest tests passed, including in-flight
  invalidation and failed-load handling. An initial invocation under Node's test
  runner was corrected to the project's Vitest runner.
- Full migration checks and native image qualification are required before
  publication. Linux-only and actual PID-1 checks are enforced by CI.
- Local Docker was unavailable; no local native-image pass is claimed.

Release-commit CI records provide the final native AMD64/ARM64 and contract
results, including the project-upgrade fixture, Zigporter compatibility tests,
rendered pinned OpenChamber behavior and real PID-1 cache expiry.

## Installed acceptance before stable promotion

After backing up and updating the beta app, verify retained history, accounts,
custom agents/skills, terminal preferences and decision notes; browser navigation
between stable and beta; and read-only preview followed by normal approved Build
execution. Complete installed upgrade/rollback preservation remains unverified.
Synthetic Code Mode fixtures are not real-model accuracy or performance results.
Successful automated checks publish this beta, not stable 3.5.1.
