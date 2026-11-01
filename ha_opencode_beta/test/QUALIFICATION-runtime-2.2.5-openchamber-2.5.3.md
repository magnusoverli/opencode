# Beta 3.5.0b1 runtime refresh: OpenCode 2.2.5 / OpenChamber 2.5.3

Checked 2026-11-01. The user authorized commit, push and release as beta 3.5.0b1.
This updates beta only, not stable. Publication uses the tag-triggered release
and native image workflows; local results below do not claim remote CI success.
Historical qualification for 2.1.2/2.5.0 is not reused as proof of this release.

## Release CI follow-up: 3.5.0b0 blocked

The prerelease notes and optional companion were published, but both native
container builds failed before any image push. The existing release tag remains
unchanged.

- Build Beta run `41298416271`: amd64 and aarch64 each recorded **1336 passed,
  4 skipped, 1 failed** in the upstream Git suites. The option-like remote test
  assumed `fetch` created a remote `HEAD`; Debian Git 2.47 does not. Restore that
  fixture precondition explicitly, leaving every assertion enabled.
- PR Checks run `41298403509`: beta contract tests found a stale version-probe
  assertion for 2.1.2 instead of 2.2.5. Correct that exact expectation.
- Reproduced the remote-HEAD failure using an isolated extracted Debian Git
  **2.47.3**. With the fixture correction, its complete service file passes
  **297 tests / 3 skipped**. The full Git/GitHub suite on host Git **2.56.0**
  passes **1337 tests / 4 skipped** in a scrubbed environment and disposable HOME.
- A broader run using extracted Debian Git also hit two HTTPS tests because the
  extracted executable lacks host `libcurl-gnutls.so.4`; this is a local test
  environment limitation, not a passing full Debian suite or a production result.
- The corrected runtime probe plus new source-patcher precondition/drift tests
  pass **4/4**. The patcher validates both fixture anchors before writing files;
  production Git behavior and trust checks are unchanged.
- Logs: `/tmp/opencode/git247-unpatched-remote-fixture.txt`,
  `/tmp/opencode/git247-patched-service.txt`,
  `/tmp/opencode/git247-patched-suite.txt`,
  `/tmp/opencode/git256-patched-suite.txt`.

Native amd64 and arm64 boundary image checks subsequently passed in run
`41299753856` on corrected commit `8f5eb6e`. Its PR workflow's beta contracts,
beta audits and root boundaries passed; the later stable audit failed, which is
outside this beta-only scope and is not described as a passing full PR workflow.
No stable dependency changes were made to mask that result.

The user then authorized the corrected release as **3.5.0b1**. Build caches are
shared with native image checks, and release-only version labels no longer
invalidate runtime/boundary layers. Workflow YAML and **38** focused contracts
pass locally; actual release build-time savings are not yet measured. Successful
boundary checks are not proof that release image publication has completed.

## Verified upstream inputs

- Official npm `@opencode/cli/latest` and `@opencode/plugin/latest`: **2.2.5**.
  GitHub release `v2.2.5`, published 2026-10-30, source commit
  `9bbb8ce18c80f099e0e448775f59d965ead40a21`.
- Latest OpenChamber release **v2.5.3**, published 2026-10-28, immutable source
  commit `95af6769797693bf049f4e6a801e373b5220447b`.
- OpenChamber now requires OpenCode >=2.2.0 and uses its own **2.2.0 client/schema**.
  Do not override its SDK merely to match the backend's patch version.
- Upstream package manager: **Bun 1.4.4**. Docker multi-architecture index checked
  for amd64/arm64:
  `oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`.
- Beta retains Node **24.21.0**. OpenCode/plugin package and lock, Docker ARGs,
  build.yaml and the migration target are aligned. Generated npm/Bun locks are
  committed-source candidates; image builds still use frozen installs.

## Compatibility changes

- Preserve Home Assistant Ingress adaptations: origin-root assets/API routing,
  double-prefix prevention, service-worker suppression, CSS/font paths and the
  module-relative terminal WebAssembly URL. The patch applies successfully to
  the actual rebuilt 2.5.3 web bundle, not only synthetic fixtures.
- Preserve private-backend credentials/supervision, chunked request replay,
  activation-scoped LAN authentication, managed agents, provider guidance and
  Supervisor-owned update notices. All 15 notice anchors match the new source.
- Rebase editor memo dependencies without losing upstream's new translation and
  import-link dependencies. Preserve the new FireworksProvider around mobile
  content while adding workspace recovery only to the browser, not native login.
- Use upstream's new Git 4 service environment policy instead of applying the
  obsolete 2.5.0 import/allowlist rewrite. The patcher asserts reviewed policy
  anchors; the existing allowlisted inherited-environment dependency shim remains
  for compatibility callers. Argument and executable/environment guards remain on.
- Retain same-client OAuth activation warmup and cancellation semantics. The new
  upstream UI also fixes provider integration-location selection. Real account
  eligibility/inference for #208 remains unverified, not declared fixed.
- Add prior shipped OpenCode **2.1.2** as a copy-on-write upgrade source, using a
  development-only exact binary alias for the regression.
- Independently inspected upstream migration
  `20261025154125_drop_session_pending`: it drops the obsolete pending projection.
  The preservation guard permits that missing table only if the source was empty
  and the exact native migration was recorded. A nonempty table fails with
  `v2_upgrade_pending_input`; original state is preserved, not silently discarded.
  Unknown schema loss remains rejected. No live databases were inspected/changed.

## Focused results

- Clean runtime `npm ci --omit=dev`, production audit and executable version:
  **0 vulnerabilities**, **opencode v2.2.5**. Matching CLI/plugin pin check passes.
- Migration suite: **17 passed**, including real pinned compaction conversion,
  upgrades from beta-18684/2.0.13/2.0.22/2.0.26/**2.1.2**, source preservation,
  permissions, workspace placement, restart/downgrade refusal and pending-table
  removal guards. Log: `/tmp/opencode/migration-2.2.5.txt`.
- Native MCP/provider/agent/OAuth/dependency checks: **13 passed**. Separately,
  OpenChamber's own **2.2.0 client** works against backend **2.2.5** in the
  controlled provider/PPQ fixture. Logs: `/tmp/opencode/runtime-2.2.5-focused.txt`
  and `/tmp/opencode/openchamber-2.2.0-client-2.2.5-backend.txt`.
- Frozen Bun install, SDK/built-in-extension build, UI type-check and web production
  build pass. Final security-refreshed build:
  `/tmp/opencode/openchamber-2.5.3-build.txt`. The built Ingress patch passes.
- Patched real-source OAuth/workspace hook tests: **19 passed**. Model store with
  add-on regressions: **134 passed**; runtime URL tests: **15 passed**, each in its
  own Bun process as in Docker to avoid shared mocked runtime state.
- Clean frozen filtered production install passes **8** actual-source
  proxy/private-backend/LAN/relay/Git/security checks plus the separate **Usage**
  credential-selection check. These are local/synthetic, not real relay/account
  acceptance. Log: `/tmp/opencode/openchamber-2.5.3-production-tests.txt`.
- The existing build's broad `server/lib/git` filter also selects GitHub/GitLab/
  Gitea suites. In an isolated HOME/environment it recorded **1336 passed,
  4 skipped, 1 failed**: one upstream enterprise-account test forgot to put its
  own fake `gh` executable on PATH. The patcher now supplies/restores that exact
  test-only precondition, without changing production trust or skipping assertions.
  The corrected Octokit file independently passes **15 tests**. No full broad
  rerun after that fixture-only correction is claimed. Logs:
  `/tmp/opencode/openchamber-2.5.3-git-isolated.txt` and
  `/tmp/opencode/openchamber-2.5.3-github-fixture.txt`.
- Pin/source-patch contracts and focused configuration/provider-doc/LAN checks
  pass; the latter run has **25 passed, 0 failed**. Stable files are unchanged and
  `git diff --check` passes.

## Security lock refresh

The old carried OpenChamber security pins had nine newly reported advisories.
Reviewed GitHub advisory ranges and published same-major fixes before updating:

- qs **6.16.1**: GHSA-6pq8-jhm2-2vcw.
- body-parser **2.4.0**: GHSA-27r3-jxmh-p828.
- follow-redirects **1.16.2**: GHSA-mrwp-f3q8-3g9p.
- undici 6 **6.29.1**: GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c,
  GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm and GHSA-9fm3-97px-rjf6.
- Zod **4.6.7**: GHSA-mrhx-c7xc-m3w5.

Final installed OpenChamber production audit: **174 package names / 181
name-version pairs, 0 reported advisories, 0 unmitigated**. The fail-closed auditor
and retained braces depth mitigation are not disabled. Scope excludes OS packages
and JavaScript embedded in browser/native binaries. Report:
`/tmp/opencode/openchamber-2.5.3-audit.json`.

## Limitations

Testing is proportional to the changes, per the user's revised policy; a complete
acceptance matrix is not a prerequisite for beta preparation. Docker/native ARM64
image execution, installed Supervisor and physical mobile/account acceptance are
unverified. Known #202/#207 host evidence and #208 account/model issues remain
separate. No missing evidence is described as passed.

An initial upstream Git test run inherited the host credential helper and exposed
a credential in failure output. The generated log was scrubbed and the user was
notified to rotate/revoke it if real. Subsequent Git checks use an empty environment
and disposable HOME/XDG roots; do not run credential-helper fixtures against host
configuration. This incident is not presented as an upstream authentication bug.
