# Unreleased beta dependency refresh

## CI follow-up

- Shared channel contracts now use `scripts/ci-checks.sh`; beta/stable jobs
  run independently and changed-file selection has regression coverage.
- PR Checks passed all ten jobs on `c464e28`, including both channels' audits,
  full contracts, MCP suites and actual Home Assistant companion checks.
- OpenCode 2.3.0 requires `plugin.list()` to await activation before OAuth;
  `integration.list()` alone can return an empty list during cold startup.
- Mobile routing can reject selection of a historical session whose folder is
  missing and return to a draft. Recovery now keeps read-only, unscoped URL
  evidence independently; it does not move or select the stored session.
- The corrected native amd64 `boundary-test` build passed. Its browser fixture
  also passed independently with an explicit post-mobile history-location check.
  AMD64/ARM64 GitHub reruns for the final correction are pending.

Upstream versions checked 2026-11-15:

| Component | Previous beta | Candidate | Evidence |
| --- | --- | --- | --- |
| OpenCode CLI/plugin | 2.2.5 | 2.3.0 | Both npm `latest` endpoints |
| OpenChamber | 2.5.3 | 2.7.2 | GitHub latest release; commit `1a151518c95cc5ff3578bab593d2f96862ff3bb8` |
| HAB | 1.7.2 | 1.8.0 | GitHub latest release; commit `f200a763798bc2a305c7fe0fad58dc0946e07861` |

OpenChamber's own client/schema are 2.3.0. Its package manager remains Bun
1.4.4, and Node 24.21.0 satisfies its declared engine requirement.

## Changes

- Align build arguments, runtime dependencies, migration target and test fixtures.
- Regenerate npm and Bun locks using the package managers, retaining security
  overrides and upstream Bun patches.
- Verify upstream's enterprise-account PATH and option-like remote HEAD test
  fixes rather than applying obsolete fixture patches.
- Rebase the usage-expiry message patch to the upstream literal Unicode text.
- Cover upgrades from the previously shipped 2.2.5 runtime using an exact
  development-only binary alias.
- Keep the candidate unreleased; published release history is unchanged.

## Evidence and limits

- npm lock resolution: zero reported vulnerabilities.
- OpenChamber frozen Bun install succeeds on Windows.
- All source-stage Home Assistant patchers apply to the actual pinned checkout.
- Security patcher regression tests: 3 passed, including no-write-on-drift.
- Whole-workspace Bun production audit reports 28 advisories, including mobile,
  Electron and UI dependency paths. This is not a clean production-image audit;
  the image's installed-package audit is a separate mandatory build step.
- Initial Linux amd64 image build reached the OpenChamber web build, then failed with
  SIGKILL / `ResourceExhausted: cannot allocate memory`. Docker reported
  2,058,289,152 bytes of RAM. SDK build and UI type-check completed before
  the web build; image qualification is incomplete.
- The concurrent Linux test setup was killed during `npm ci`, before tests ran.
  Retry with more Docker memory and serialized heavy workloads. The retry
  command must omit the nonexistent `test/openchamber-usage.test.js`; actual
  usage checks live in `test/openchamber-usage.mjs` and run in the image build.
- After increasing Docker RAM to 8 GB, the amd64 image build completed and
  exported `ha-opencode-beta:dependency-refresh`, image ID
  `sha256:3b0235f12d2dd1be1be05ace5236228c95f5bae4b80da9a551e4de3a02ac9095`.
  All mandatory Dockerfile checks passed, including UI type-check/build,
  Home Assistant patch fixtures, forward migration and LAN authentication.
- Upstream Git suite: 1,614 passed, 4 skipped (62 test files).
- Installed OpenChamber production dependency audit: zero unmitigated and
  zero vendor-mitigated advisories reported. This scoped result does not
  supersede the whole-workspace/browser dependency findings above.
- Focused Linux contracts initially passed 59/61 checks, including all prior
  V2 upgrade sources through 2.2.5. Two real V1 conversion tests detected a
  `path` projection mismatch. Upstream 2.3.0's
  `packages/core/src/database/v1-migration.bun.ts` now resolves global session
  ownership/path against the converter's filesystem. Restore original
  project/directory/path from the read-only baseline into the private copy
  before managed-workspace relocation. Exact projection validation is retained.
  The corrected Linux contract run passed **61/61**, with no skips, including
  real compaction/history conversion and all supported V2 upgrade sources.
- Final amd64 rebuild with the migration fix completed successfully:
  `sha256:bc386cafaf7dd2cd5482e524301cac692f5ce9bcfedbaf919923e081a6ade4d6`.
  The real runtime readiness/scrubbed-environment test also passed (1/1).
- Installed Supervisor upgrade, ARM64, real provider accounts and physical
  mobile-client acceptance have not been run for these pins.
