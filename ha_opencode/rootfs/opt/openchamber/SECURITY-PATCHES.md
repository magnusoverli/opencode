# Pinned OpenChamber security dependencies

The stable app keeps OpenChamber 2.5.0 source at the revision in `build.yaml`.
`patch-security-dependencies.cjs` merges `security-overrides.json` into that
checkout; `security.bun.lock` is its generated, committed Bun 1.4.3 lock.
Both build-time and production installs use this lock with `--frozen-lockfile`.

To refresh: start from that exact upstream revision, run the patcher, then
`bun install --lockfile-only --ignore-scripts` with the Dockerfile's pinned Bun.
Review the lock diff and regenerate the image; never resolve a fresh lock during
the image build. Git, relay, proxy, native and installed-browser checks qualify
these dependencies independently of upstream's release designation.

The 2.5.0 upgrade retains the explicit security overrides and Git 4 compatibility
patches. Its upstream proxy now preserves streaming chunked framing and strips
transfer-encoding before replaying parsed bodies, replacing our old framing
patch. We still fix replay of empty parsed chunked JSON objects. The managed
backend patch follows upstream's injected-environment setter without exporting
the backend credential. Arabic and Hebrew join the Supervisor-owned update
notices (15 locales). Native image and installed-browser checks must qualify
this candidate before release; prior qualification records cover older pins.

## Visible vendor mitigation

`braces@3.0.3` has no published version fixing **GHSA-vfj7-8cjw-p6xm**.
`patch-braces-depth.cjs` bounds parser nesting and recursive compile, expand and
stringify walkers to 64 levels. The regression exercises deeply nested patterns
below the existing character limit, direct AST inputs, ordinary nested braces,
ranges and the proxy's glob matching. Invalid excessive nesting raises a bounded
`SyntaxError` rather than exhausting the JavaScript stack.

The package retains its real version. `audit-installed.mjs` reports the advisory
as **vendor-mitigated**, checks all four patched file hashes, and fails on other
reported advisories. A vendor-mitigated finding is not a zero-finding audit.
Remove the mitigation only after adopting and testing an upstream fix.

`patch-proxy-deprecation.cjs` separately replaces `http-proxy@1.18.1`'s two
deprecated `util._extend` calls with `Object.assign`. Actual proxy tests run with
`--throw-deprecation`; this change is not presented as an advisory remediation.

Audit scope is installed package metadata. OS packages and JavaScript embedded
inside built browser bundles require separate scanners.

## Git 4 environment compatibility

The Git service uses the named `simpleGit` export and explicitly allows app-owned
prompt/index controls, read-only `GIT_OPTIONAL_LOCKS`, and unchanged server
environment keys. Project overrides cannot add executable or repository-location
variables. `patch-git-environment.cjs`
lets the ESM runtime retain inherited keys only when explicitly allowlisted;
unlisted keys are dropped and own-key/argument security checks stay enabled.
Upstream Git tests and production ESM regressions cover this compatibility patch.
