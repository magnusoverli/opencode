# Pinned OpenChamber security dependencies

Beta 3.5.0b0 keeps OpenChamber 2.5.3 source at the revision in `build.yaml`.
`patch-security-dependencies.cjs` merges `security-overrides.json` into that
checkout; `security.bun.lock` is its generated, committed Bun 1.4.4 lock.
Both build-time and production installs use this lock with `--frozen-lockfile`.

To refresh: start from that exact upstream revision, run the patcher, then
`bun install --lockfile-only --ignore-scripts` with the Dockerfile's pinned Bun.
Review the lock diff and regenerate the image; never resolve a fresh lock during
the image build. Git, relay, proxy, native and installed-browser checks qualify
these dependencies independently of upstream's release designation.

The 2.5.3 upgrade retains reviewed security overrides and vendor mitigations.
It updates qs, body-parser, follow-redirects, undici 6 and Zod to published fixes
for the current production findings. Its upstream proxy preserves streaming chunked framing and strips
transfer-encoding before replaying parsed bodies, replacing our old framing
patch. We still fix replay of empty parsed chunked JSON objects. The managed
backend patch follows upstream's injected-environment setter without exporting
the backend credential. Arabic and Hebrew join the Supervisor-owned update
notices (15 locales). Native image and installed-browser checks remain unverified;
prior qualification records cover older pins. Testing is proportional to changes,
not an exhaustive-matrix prerequisite for beta preparation.

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

OpenChamber 2.5.3 implements the named `simpleGit` export, own-key environment
propagation, app-owned prompt/index controls, read-only `GIT_OPTIONAL_LOCKS`, and
project-variable filtering upstream. The old 2.5.0 service rewrite is removed;
the dependency patcher instead checks the reviewed upstream policy anchors.
It also fixes one upstream test's missing fake-gh PATH setup/restoration; no
production enterprise-host trust behavior is changed or assertion skipped.
Project overrides cannot add executable or repository-location variables.
The retained dependency-level `patch-git-environment.cjs`
permits explicitly allowlisted inherited keys for compatibility callers, without
changing the upstream service's own-key policy. Unlisted keys are dropped and
own-key/argument security checks stay enabled. Production ESM regressions cover
the service and these guards.
