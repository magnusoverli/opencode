# Eleven-issue beta 3.5.0b1 qualification

Date: 2026-11-01. Baseline: `09dd405`.
Scope: #195, #197, #198, #199, #200, #202, #203, #205, #206, #207, #208.
Issues #45 and #90 are excluded. Stable source and release version are unchanged.
The user authorized beta 3.5.0b1 publication and the runtime-pin upgrade; see
`QUALIFICATION-runtime-2.2.5-openchamber-2.5.3.md` for its separate current evidence.
Publication uses the tag-triggered release/image workflows. No issue closures
are authorized or implied by this release.

## Release status: authorized beta 3.5.0b1

The user authorized the corrected beta after 3.5.0b0's image build failure.
Native amd64/arm64 image boundary checks passed in run `41299753856` after the
fixture corrections. See the runtime qualification's CI follow-up for evidence;
full release image publication is separate from these successful boundary checks.
This local evidence is not a claim that all reports are resolved. CI image
publication is separate from the local results; unavailable installed-system,
real-account and physical-client acceptance remains explicitly unverified.

User policy update: exhaustive testing and a complete installed-system/hardware
acceptance matrix are no longer mandatory prerequisites for beta preparation.
Use focused checks proportional to each change. Unperformed checks below remain
unverified, not passed; that does not by itself make them mandatory release gates.
Known unresolved reports and publication authorization are separate concerns.

## Independent research and implementation decisions

### #197 / #206: terminal client-state identity

- Inspected the shipped preparer/launcher and history around `5f31185`. The
  preparer never reconciled existing identities; its first revision already had
  strict checks. There is no evidence that the reported root-owned tree was
  created by a particular historical app version.
- Implemented descriptor-based reconciliation only for bounded root-owned 0700
  state and safe configuration identities, including interrupted mkdir/umask
  and fchown/fchmod states, plus fixed known preference files. No recursive
  ownership changes, managed-source overwrites or link
  traversal. Client-created 0644 preferences remain supported inside protected
  directories.
- Added path/identity diagnostics; the native launcher distinguishes missing
  markers from unsafe files and bounds/escapes paths.
- Reproduced the reported ownership layout and exercised root/non-root client
  boundaries in a disposable rootless-user-namespace chroot, with the source and
  toolchain read-only. The root TUI fixture passed, including sticky-directory
  managed-source protection, atomic preference writes and symlink rejection.
- Affected-host upgrade acceptance remains unavailable.

### #202 / #207: unknown migration work and unsafe types

- Current migration code does not generate the reported
  `unified_original_interval_v2_validation_compat_2` work entry. Its provenance is
  not known, so no deletion, automatic relocation or allowlist bypass was added.
- Added metadata to directory/file/tree failures and a read-only `diagnose`
  command that does not prepare state, connect to SQLite or change journals.
- Regression tests cover wrong types, dangling symlinks, diagnostic escaping,
  bounded paths and unchanged private contents.
- These are diagnostic improvements, not verified repairs of either host.
  Exact affected-path/provenance evidence is still required.

### #198: safe-write transactions

- Confirmed direct production writes, reused backups and inaccurate restoration
  claims in the original implementation.
- Independently checked HA Core **2026.10.4**,
  `homeassistant/components/config/core.py`, `CheckConfigView.post`: the API calls
  `async_check_ha_config_file` on the running HA instance and does not accept
  staged content. Moving that call before replacement would not validate the
  proposal. Full isolated HA validation is not implemented or claimed.
- Added expected-source revisions, bounded no-follow reads, same-filesystem
  staged replacement, flushing, backup/integrity verification, a cross-process
  filesystem lock and persistent recovery journals/copies.
- Recovery refuses observable subsequent edits. Interrupted/uncertain outcomes
  retain the lock and records; no unsafe automatic recovery or pruning occurs.
  Recovery storage is bounded at 256 entries / 256 MiB.
- Updated tool schema, responses and agent/operator guidance. Actual writes now
  require the dry run's unchanged `expected_revision`. Sensitive read rules
  protect recovery copies; this is not a shell sandbox.
- Synthetic unit and MCP tests cover conflicts, external edits, failed backup,
  writes/fsync, rollback failure, invalid/unavailable HA checks, linked paths,
  protected recovery records and lock contention across validation. Separate
  child-process SIGKILL tests before commit and during validation verify retained
  recovery copies and a lock that blocks a fresh writer after restart. Reviewed
  new files use exclusive hard-link installation, so a concurrently created
  destination is not overwritten.
- Local locks coordinate cooperating writers, not unrelated editors or the
  unchanged stable writer. No universal atomic compare-and-swap is claimed.
- Installed HA validation, operator recovery acceptance and filesystem
  qualification remain unverified.

### #203: read-only HAB

- Reviewed **HAB 1.7.2**, commit
  `0bc138c6ab9f1bbe87914a0ffccbb038c0767e82`, specifically
  `cmd/dashboard_get.go`, `dashboard_list.go`, `helper_list.go`, `helper_types.go`
  and `root.go`. Read handlers use inventory/config reads; global configuration
  and output flags are a separate policy surface.
- Added a default-deny literal-argument policy for those four read paths only.
  Rejects aliases, global overrides, unreviewed flags, writes/exports and --plan.
- Gateway stays full-profile only and separately permissionable. Existing compact
  and managed read-only surfaces are not broadened. Redaction occurs before
  inline or large-output export, including exact known service credentials.
- Policy/bypass tests pass; actual pinned HAB endpoint execution and installed
  permission UX still require qualification.

### #199: Supervisor app management

- Reviewed Supervisor **2026.10.3**, commit
  `ca2273e2a7ae061a7377658fb704a0b919330fb8`:
  `supervisor/api/apps.py`, route registration in `supervisor/api/__init__.py`,
  and `supervisor/apps/model.py` / `options.py`.
- Confirmed /info returns **UiOptions descriptor arrays**, not raw manifest
  schema mappings. Tests use independently checked descriptors including nested
  schemas and password formats. Validation accepts a bare full options body;
  save accepts `{options: ...}`. Neither provides atomic If-Match.
- Added redacted inspection and keyed opaque revisions; all option strings are
  withheld. Object merges preserve omitted nested credentials. Credential edits,
  arrays and deletion are deliberately unsupported in this first surface.
- Previews expire after five minutes/restart. Application requires the exact
  preview/review, revalidates and rechecks source state, consumes the preview
  before mutation and verifies readback without blind retries or rollback.
- Added a mandatory managed native ask for the apply tool; custom-agent policy
  inherits its existing protection against broad allows relaxing managed asks.
  The pinned-native agent round-trip also verifies that an explicit custom allow
  is constrained to ask, recovery-copy reads remain denied, and the managed
  read-only agent cannot invoke application.
- Current-app mutation is prohibited, with failure closed if self identity is
  unavailable. Shared adapter extensions are only those required for this feature.
- Synthetic tests pass; actual Supervisor API/permission-dialog acceptance remains
  unverified. Do not claim atomic concurrency control or full application readiness.

### #205: LAN pairing

- Reviewed pinned OpenCode **2.1.2** and **2.1.4** server pairing/auth handlers.
  `ServerAuth.issueSession` signs timestamp-based tokens using the backend
  password; there is no per-device revocation registry. Therefore simply
  allowing redemption or forwarding these tokens cannot meet the requirement.
- Implemented a separate LAN-only authority matching the native wire contract:
  POST /api/pair, GET /auth/connect/{code} -> {token}, Basic opencode:<token>.
  Browser cookies also terminate locally. Only validated LAN sessions cause
  backend-credential injection; the backend credential/session is never issued
  to devices.
- Codes are single-use/five-minute; device tokens are unique, digest-stored,
  individually revocable and expire after 30 days. Worker/app restart revokes all.
  Administrator-only inventory/revocation routes expose IDs/timestamps, not tokens.
- Preserved socket-peer, TLS, authority/origin and forwarding-header checks.
  Cookie-authenticated mutations require the public origin. Native OpenChamber
  mode is unchanged and separate.
- Unit/proxy tests cover redemption/replay, expiry, capacity, separate revocation,
  token/header isolation, cookies and existing HTTP/WebSocket trust boundaries.
  Device-authenticated SSE/WebSocket tests confirm individual revocation closes
  both active connections and denies later requests.
- Real iOS/macOS client pairing, client-specific stream authentication,
  revocation/reconnection and installed reverse-proxy acceptance remain unverified.

### #208: OAuth registration versus model availability

- Reviewed upstream issue #55353 and PR #55379, plus tagged
  `packages/server/src/handlers/integration.ts`. The list handler awaits plugin
  activation; the OAuth connect handler does not in the inspected pin.
- Reviewed `packages/core/src/plugin/provider/chatgpt.ts` and `openai.ts` at the
  relevant pins: newer token sharing and legacy Codex credentials have distinct
  methods, eligibility/catalog and endpoint routing.
- OpenChamber's pinned source at
  `ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd` directly started OAuth on the scoped
  SDK. The source patch now awaits integration list on that **same client** first,
  without retrying authorization or changing credential ownership.
- Patched real upstream UI passes production TypeScript checking and all six
  synthetic hook tests with Bun **1.4.3**, including activation failure/no attempt.
  The build order checks production source before mounting the Bun test fixture.
- A new isolated pinned-native-runtime test starts/cancels token-sharing OAuth
  after same-location activation without opening a provider URL or using an
  account; it confirms no credential is created.
- This mitigates a confirmed cold-start path, not the original report's claimed
  persistent registry failure or its remaining account/model rejection. Real
  ChatGPT completion, refresh, supported model inference and restart acceptance
  remain unavailable. No credential/database/cache edits were made.

### #200: custom local inference

- Existing provider conversion/schema validation already supports compatible
  provider configuration; the monolithic example also contained incompatible
  permission/MCP configuration, not just inference settings.
- Added an inference-only native V2 ProsperoAI recipe with exact model reference,
  separate credential setup, optional keyless configuration and context/tool
  compatibility warnings. Optional search MCP is documented separately.
- Added pinned-schema tests for keyed and keyless recipes. Existing pinned
  custom-provider routing fixtures exercise controlled compatible endpoints.
- Reporter-specific ProsperoAI/PS5 inference remains unverified.

### #195: delivered compaction fix

- Re-ran the real pinned converter regressions covering automatic/manual
  compaction with/without retained context and preserved original source history.
- No rewrite or history-deletion workaround added. Operator guidance identifies
  the existing fix and data-preserving retry. No GitHub closure was performed.

## Environment and recorded checks

- Downloaded checksum-verified local Node toolchains under /tmp/opencode; initial
  checks used 24.15.0 (CI pin). Final tests target 24.21.0 (beta image pin).
- Installed beta's runtime lock, MCP dependencies and the exact standalone
  private-encryption tree locally. Dependency remediation below changes only the
  reviewed transitive runtime security pair and its lock; OpenCode pins remain
  unchanged.
- Focused diagnostics/migration suite: 18 passed, including all pinned compaction
  cases. Root TUI boundary: passed in isolated rootless namespace/chroot.
- Strict C syntax check: `gcc -Wall -Wextra -Werror -fsyntax-only` passed.
- Operator example/config tests and patched upstream UI typecheck/hook tests pass.
- Channel-separation harness: 10 passed; option-declaration checks pass for both
  channels. Stable files remain unchanged.
- Complete suites before the dependency remediation: beta contracts **532 passed,
  11 skipped, 0 failed** (543 tests); MCP **798 passed, 4 skipped** (802 tests),
  all 48 files passed. Logs: `/tmp/opencode/beta-contracts-final.txt` and
  `/tmp/opencode/beta-mcp-final.txt`. These are not a claim of a full-suite rerun
  after the dependency change; subsequent verification is deliberately focused.

## Dependency remediation

- The 24 moderate findings were two underlying advisories propagated through
  dependent packages, not 24 independent vulnerabilities:
  [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
  (glob cancellation bypass, fixed in 14.0.2) and
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
  (minimatch globparts amplification, fixed in 11.0.1).
- npm's "no fix available" meant no automatic compatible-range update, not no
  published fix. Reviewed upstream changelogs and actual consumers before pinning
  the pair via beta-local overrides. Glob 14 and minimatch 11 must move together:
  older glob relies on regex/internal methods removed by minimatch 11. All other
  installed consumers use retained matching/scan APIs. No brace-expansion-only
  override, advisory suppression or forced audit repair was used.
- Lock changes upgrade glob 13.0.5 -> 14.0.2, minimatch 10.2.5 -> 11.0.1 and
  glob's path-scurry dependency 2.0.2 -> 3.0.0. The old nested glob 10/minimatch 9
  branch and its obsolete dependencies are removed. OpenCode CLI/plugin remain
  **2.1.2** at that stage; those lock entries were byte-for-byte unchanged. The
  subsequently authorized **2.2.5** upgrade is recorded separately and retains
  the audited glob/minimatch security pair.
- `npm audit --omit=dev --audit-level=low`: **0 vulnerabilities**, both in the
  working tree and a clean `npm ci --omit=dev` installation from the changed lock.
  MCP and private-encryption production audits were also rerun: **0 vulnerabilities**
  each. These results cover the audited npm trees, not embedded native-binary
  internals or OS packages.
- Focused checks cover locked versions, CommonJS/ESM consumers, brace expansion,
  OpenCode scans/ignores/dotfiles, workspace discovery, npm-packlist/pacote/cache,
  TUF delegated paths, rimraf glob deletion, cancellation and bounded minimatch
  amplification. Existing plugin, readiness, custom-plugin and native MCP smoke
  checks exercise the unchanged OpenCode pin with the new JavaScript dependencies.
- Combined focused run on Node **24.21.0**: **30 passed, 0 failed, 0 skipped**.
  Log: `/tmp/opencode/beta-dependency-focused.txt`. Matching CLI/plugin pin check
  and `git diff --check` pass. No CI audit/test checks were disabled; stable and
  release metadata remain unchanged.

## Known unresolved reports and unavailable evidence

1. No affected-host filesystem evidence for definitive #202/#207 repair.
2. #208 account/model rejection remains unresolved; no provider account is
   available for completion, refresh or inference acceptance.
3. Docker/Podman and native ARM64 execution are unavailable locally: image builds,
   in-image boundary fixtures and final artifact validation are not established.
4. No installed Supervisor/HA acceptance environment is available for lifecycle,
   configuration validation, upgrade, Ingress and rollback checks.
5. Physical native clients for #205 acceptance are unavailable.
6. Synthetic process-kill preservation is tested; operator-led recovery of a real
   installation is not established. Final installed/in-image integration remains
   unverified rather than an automatic exhaustive-testing prerequisite.

Do not report unresolved issues or unperformed checks as completed. Release
publication and issue closure still require approval.
