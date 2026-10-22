# Stable 3.3.1 migration-fix candidate — 2026-10-22

## Scope

Issue [#195](https://github.com/magnusoverli/opencode/issues/195) is a false
`message_projection_mismatch` during V1 conversion. The actual pinned OpenCode
2.1.2 converter stores nonempty retained context as `metadata.recent` and omits
metadata when no context is retained. The add-on expected a top-level `recent`
field in both cases. Completed manual compactions are affected as well as
automatic compactions.

Both channel validators now match that exact format. Comparison remains strict;
the change neither rewrites V1 history nor accepts either representation
indiscriminately. OpenCode CLI/plugin 2.1.2, OpenChamber 2.5.0, channel identities
and separate storage are unchanged. Only stable's candidate version is bumped;
beta carries the same fix under Unreleased without a beta release.

## Local evidence

- The new real-converter regression fails with `message_projection_mismatch`
  against unmodified 3.3.0 before applying the production fix.
- Both complete migration suites pass: **15 stable + 15 beta tests**, including
  native V2 upgrades from the four previously covered runtime versions.
- Broader focused migration/readiness/runtime-guard/state-isolation/startup-error
  and runtime-contract checks pass: **77 stable + 73 beta tests** in total
  (including the migration tests and stable promotion contracts).
- The new fixture migrates four synthetic V1 sessions: automatic/manual
  compaction, each with/without retained context. It checks the complete converted
  compaction data, summary text, reason, timestamps, session/message/part counts
  and byte-identical original source database.
- Changed/missing summaries, changed reasons, dropped/changed retained context,
  empty metadata and legacy top-level context are rejected. A deliberately
  corrupted conversion fails without activation or source changes; retrying the
  same failed root succeeds. Restart reuses the activated generation.
- Channel separation: **10 checks passed**. Stable/beta startup-hook harnesses,
  option-declaration checks and matching CLI/plugin pin verification passed.
- The fixture is wired into both Docker `boundary-test` targets and explicitly
  included in each filtered build context. It runs against the image's actual
  pinned binary with networking disabled and a bounded timeout.

## Pending release gates / limits

- Full GitHub PR checks and target-native amd64/arm64 image builds have **not**
  been run for this candidate. Docker/Podman are unavailable locally. Adding a
  fixture to those targets is not evidence that the image builds passed.
- An installed Home Assistant Supervisor upgrade, Ingress/browser acceptance and
  affected-host verification have **not** been performed. No live Home Assistant
  configuration, user history or provider credentials were accessed.
- GitHub publishing credentials, SSH identities and Git author configuration are
  unavailable. This candidate is not committed, pushed, tagged or published.
  Run the release gates before publishing `v3.3.1` through the existing workflows.
- Keep original data and take a backup before updating the existing stable app.
  Failed migrations retry from preserved V1 data; no journal/database deletion is
  required. History manually deleted as a workaround requires backup recovery.
