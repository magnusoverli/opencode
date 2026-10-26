# Withdrawn 3.3.3: project metadata during V2 upgrade

## Reproduction and cause

The reported startup stops at `v2_upgrade_records_changed`; the managed server
never becomes ready, so OpenChamber's repeated attachment failures are downstream
symptoms. The separate Assist ownership refusal must not be bypassed or used as
a reason to overwrite a user-managed companion.

The native converter starts OpenCode's project sweep as well as schema migration.
An idle, unarchived project's missing directory causes the sweep to set
`project.time_archived`. It can also adopt another surviving main checkout by
changing `project.worktree`. The app's runtime-only managed workspace is not yet
mounted during conversion, so the exact preservation check can reject an otherwise
valid private upgrade copy. Prior fixtures used only the always-present global
project and missed this case.

Adding an unavailable project to the real 2.1.2-to-2.1.4 integration test reproduced
the identical failure before the fix. No installed Home Assistant data was read
or changed during this investigation.

## Narrow fix

Restore only existing projects' canonical directory and archive timestamp from
the read-only pre-conversion snapshot into the private candidate. Preserve
session permissions as before, then run the unchanged exact-record, integrity,
foreign-key and source-immutability checks before atomic activation. Do not skip
tables, relax record comparisons, clear user history, change runtime pins, or
modify beta. Missing records and unrelated metadata changes still fail closed.

## Regression coverage

- Actual native startup sweep on synthetic unavailable, available and already
  archived projects, followed by exact validation after restoration.
- Canonical-directory preservation plus rejection of changed project names,
  timestamps and deleted records.
- Real supported prior runtimes, including 2.1.2, now contain unavailable projects;
  all their existing project fields must survive the full generation upgrade.
- Injected post-conversion corruption on a 2.1.2 upgrade leaves the active
  database, generation pointer and marker unchanged, cleans the candidate, and
  permits a clean retry; restart and downgrade-refusal checks remain in place.
- The new fixture is included in the network-disabled native amd64/arm64
  `boundary-test` image target, not only local/PR tests.
- The native fixture waits up to ten seconds for the asynchronous sweep before
  stopping its synthetic converter, so readiness cannot race away the fault.
  The first native run exposed that fixture timing issue; the production
  converter's readiness/cleanup behavior was not changed to address it.

Local migration suite: **17 passed**. Full stable contracts: **532 passed,
12 skipped**, with isolated HOME/XDG/Git configuration and CI's 022 umask.
The first broad local run used the host's group-writable umask and three
agent-storage safety tests rejected their fixtures; no product check was relaxed.
Candidate commit: `5f1d69d0e960d535229b05f028355aaa2dd81c01`.

- [Native image CI](https://github.com/magnusoverli/opencode/actions/runs/40293341062):
  passed on amd64 and arm64, including the network-disabled project-sweep fixture.
- [Shared PR checks](https://github.com/magnusoverli/opencode/actions/runs/40293341085):
  passed, including both channels' MCP suites, dependency audits, full contracts,
  root privilege boundaries, companion packaging and functional shell tests.
  The preceding candidate's unchanged beta MCP test hit a 20-second timeout;
  no beta test, timeout or audit policy was changed to obtain the green result.

3.3.4 release preparation changes only the manifest version and release
documentation; executable source matches this validated candidate. Verify the
tagged builds, both public architecture images, version/latest manifests,
architecture aliases and all release assets after publication. Installed
Supervisor upgrade acceptance remains separate and unperformed. 3.3.3 stays
withdrawn; no live Home Assistant state was modified here.
