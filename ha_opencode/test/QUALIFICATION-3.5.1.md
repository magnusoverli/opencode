# Stable 3.5.1 promotion

## Source and retained stable behavior

Promotes the combined implementation from `beta-v3.5.1b4` (`e40f3fe`), after
reconciling stable 3.5.0 fixes into beta and publishing that combined beta.
Stable identity, storage, companion ownership, native MCP provenance, runtime
pins, Zigporter compatibility overlay, HAB registry-cache handling and
project-upgrade preservation are retained.

The promotion includes V2 configuration/schema/policy consolidation, default-off
MCP Code Mode, instruction ownership cleanup, guarded cache quarantine and
seven-day cold-start expiry, ingress channel identity and `ha-context` fixes.
Stable preserves historical shared instructions and markers for user review.

## Qualification

- Local native-runtime checks passed: 39 tests covering context delivery and
  hard-deny enforcement, full-catalogue direct/Code Mode requests, read-only
  preview to Build approval in both modes, and provider configuration.
- Local focused configuration, external MCP, retirement and stable-promotion
  assertions passed; two platform/root-only cases require Linux CI.
- Skills initially failed on the Windows checkout's CRLF frontmatter; all 20
  passed against the exact LF Git snapshot used by Linux builds.
- Local Docker startup was unavailable. Native AMD64/ARM64 builds, rendered
  OpenChamber acceptance and real PID-1 expiry checks are release gates in CI.
- Stable's rendered browser fixture now uses its actual launcher and asserts
  `ha-opencode-stable`, while preserving seeded beta entries.
- Shared shell coverage now checks preservation of historical instructions in
  both channels. Root-only legacy-data checks run for stable as well as beta.

The b4 source passed all ten PR-check jobs (run `44076915163`) and both native
architecture checks (run `44076915217`); release build `44077948718` also passed.
Shared runtime/build files now match b4 except narrowly verified channel identity
and one instruction-ownership comment. The baseline test compares normalized
content for these exceptions rather than skipping entire files.

CI run records on the stable release commit provide the final pass/fail evidence.
Publication requires the PR checks and both stable native image checks to pass.

## Evidence limits

The user explicitly requested promotion of b4. No installed b4 self-test report
was supplied in this conversation, so this promotion does not claim new installed
acceptance. Complete
Supervisor upgrade/rollback preservation and installed terminal/OpenChamber
approval UI qualification remain pending. Synthetic Code Mode request sizes
are not real-model accuracy, latency or token-cost benchmarks.
