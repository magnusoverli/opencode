# 3.2.4b2 runtime upgrade qualification

Initial candidate checked 2026-10-21; prepared for beta 3.2.4b2, not stable
promotion. Published 3.2.4b1 qualification remains historical; stable is unchanged.

## Immutable inputs

- Official npm `@opencode/cli/latest` and `@opencode/plugin/latest`: **2.1.2**.
  GitHub's latest release endpoint still names V1; it is not the V2 package pin.
- [OpenChamber v2.5.0](https://github.com/openchamber/openchamber/releases/tag/v2.5.0):
  `ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd`.
- Bun **1.4.3**, matching upstream's packageManager. Multi-architecture image:
  `oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288`.
- Regenerated committed npm and Bun locks; both frozen Bun development and
  filtered production installs succeed. Security override versions are retained.

## Patch review

- Follow the new injected-environment password setter without exporting the
  backend credential. Reject source drift before writing any managed-backend file.
- Remove the superseded proxy-framing patch: upstream now preserves streaming
  chunked bodies and removes transfer-encoding on parsed-body replay. Retain the
  fix for empty parsed chunked objects; test actual HTTP forwarding, not strings.
- Allow app-owned `GIT_OPTIONAL_LOCKS` for upstream's read-only status operations;
  keep Git 4's argument, executable and project-environment guards.
- Patch all 15 update-notice locales, including Arabic/Hebrew. Independently
  compare the captured fixture values with the exact upstream commit.
- Editor, Usage/model selection, workspace-recovery and built Ingress patches
  apply to the new source. Existing security vendor patches remain required.
- Enable guarded copy-on-write upgrades from the shipped 2.0.26 generation;
  retain older covered sources and reject unknown builds/downgrades.

## Passed locally (Windows)

- Real 2.1.2 native MCP first-session integration, plugin, readiness, provider,
  PPQ pricing/catalog/default/inference-fixture, context, custom-plugin and YAML
  formatting tests; focused add-on contracts and Python self-test policy.
- All **14** migration cases, including previous 2.0.13, 2.0.22 and 2.0.26
  generations, preserve conversations/credentials/permissions and failure input.
- OpenChamber's own **2.0.32 client** against backend **2.1.2** passes the same
  real model-list, credential refresh, PPQ pricing/default and controlled provider
  fixtures (`OPENCHAMBER_TEST_SOURCE=<patched-checkout>` on
  `opencode-v2-provider-runtime.test.js`). No SDK override is needed for these cases.
- SDK build, UI/web type-checks, web production build and built Ingress patch.
- **9** upstream OpenCode version-compatibility tests.
- **149** upstream config-store/runtime-URL tests and **6** workspace-gate tests.
- **17** focused upstream Git status/environment tests after the allowlist fix.
- A second fresh source extraction plus frozen production install passes all
  **7** actual-source proxy, private-backend, LAN-auth, Usage and security cases.
- Runtime production npm audit: **0 vulnerabilities**. OpenChamber filtered
  production audit: **174 package names / 180 name-version pairs**, **0 unmitigated**
  findings and **1 visible vendor-mitigated braces advisory**
  (`GHSA-vfj7-8cjw-p6xm`), with patched-file hashes verified.

## Initial candidate limitations and release gates

- No local Docker daemon: native amd64/arm64 image checks, native PTY/startup,
  Linux privilege/filesystem boundaries and in-image browser/relay acceptance
  must run in CI. Installed Supervisor upgrade and public relay pairing remain
  unverified. At initial candidate review, no images, tags or releases had been
  published; native Linux CI remains a mandatory release gate.
- The broad Windows beta suite is not green: Linux-style private-directory
  preconditions fail (`Unsafe Assist state directory`), and that broad run timed
  out. Focused portable suites above pass; this does not replace Linux CI.
- The broad upstream Git/GitHub/GitLab run also has failing path/mode, command
  quoting and mocked GitHub-account cases, and times out after 420 seconds on
  Windows. Only the focused Git checks above are qualified locally; the complete
  native Linux Git gate must pass before release.
- Production metadata auditing excludes OS packages and embedded browser code.
  The full upstream development workspace audit reports additional findings;
  it is not a zero-finding audit and is not covered by the production result.
