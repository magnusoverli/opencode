# Open-issue bug sweep

Reviewed all 21 open issues and every comment on 2026-11-16. This is a local
engineering ledger; no issue comments, replies, labels or closures are requested.
All fixes target beta only. Stable receives them through eventual beta promotion,
not backports. Stable changes from the first sweep commit are reverted.
Feature requests are excluded, but concrete defects in their follow-up comments
remain in scope. Passing automated checks do not establish affected-host or
real-account acceptance.

| Issue | Classification | Work / current evidence |
| --- | --- | --- |
| #219 | Feature | Exclude installation-specific editing-policy delegation. |
| #218 | Bug | Investigate ttyd ingress disconnect/reconnect and input recovery. |
| #217 | Bug, duplicate family | V1 session path preservation; current beta has private-copy placement restoration; verify reported cases. |
| #216 | Bug | External MCP file references expanded before validation; isolate external failures from bundled MCP. |
| #215 | Guidance defect | Separate existing editor-API operations from direct YAML safe writes; remove contradictory in-place editing advice. |
| #214 | Bug | Reproduce real MCP discovery of `hab_run`; compare advertised and registered tools. |
| #212 | Feature | Exclude graphify bundling. |
| #211 | Bug, duplicate family | Project/path projection preservation; same family as #217. |
| #209 | Bug / usability | OAuth callback handoff discoverability and browser launch behavior. |
| #208 | Bug | Activation race fixed in current beta and verified without an account; investigate missing handoff and account-specific model rejection separately. |
| #207 | Needs evidence | Beta has path/type diagnostics. No affected filesystem evidence establishes which unsafe path can be repaired; retain safety checks and data. |
| #206 | Bug, duplicate family | TUI state ownership; targeted repair and diagnostics already in beta; verify regression coverage. |
| #205 | Compatibility / documentation defect | Verify native pairing exchange/auth contract and documented device listing/revocation. Exclude tunnel feature. |
| #203 | Feature with follow-up | Exclude expanding tool access. Check existing read-only tool discovery and profile guidance against reported compact configuration. |
| #202 | Needs evidence | Unknown migration artifact is named, but provenance/content is not established; preserve it, review diagnostics and recovery guidance. |
| #200 | Support, resolved by reporter | Existing remote-provider configuration docs/tests; no new provider feature. |
| #199 | Feature with bugs | Exclude additional capabilities. Investigate restart `outcome_unknown`, misleading restart-preview text, incomplete store audit and incorrect first-run cross-channel state. Preserve credential redaction and permission boundaries. |
| #197 | Bug, duplicate family | Same targeted TUI identity/ownership work as #206. |
| #195 | Previously fixed bug | Compaction metadata migration already covered in stable/beta; verify regression coverage, do not remove history. |
| #90 | Upstream watchlist | Compatibility layer already shipped; no concrete new regression reported. |
| #45 | Feature / upstream watchlist | Exclude platform roadmap and new UI capabilities. |

## Verification approach

Reproduce before changing behavior; keep failure and data-preservation assertions.
Use the shared channel contract runner and native image boundary target, then
monitor affected GitHub CI runs. Record fixes and evidence here as work completes.

## Closure ledger

“Candidate” means the repository fix and regression tests are ready; it does
not mean the fix has shipped to affected installations. No issues are closed
or replied to by this sweep.

| Issue | Fix / verification | Closure status |
| --- | --- | --- |
| #216 | Beta normalizes local file references to descriptors before upstream config expansion. External validation is isolated from bundled/native registration. Both reference formats, delayed resolution, invalid external config, and Linux file-identity checks pass. Fix `729c272`, stable backport withdrawn by `08005fd`; verified in `b34272e`. | Ready for closure as fixed in beta; release availability should be stated when closing. |
| #215 | Resource-ownership routing now distinguishes editor-resource saves from whole-file YAML replacement; removes the in-place yq exception while retaining consent, backups, validation, revision checks and activation verification. Fix `32c109d`; regression and CI pass in `b34272e`. | Ready for closure as fixed in beta; release availability should be stated when closing. |
| #218 | Established ttyd socket errors now get five delayed reconnect attempts; initial failures, normal closure and explicit disable remain manual. Error-before-close browser fixture fails against old image and passes against patched image, preserving tmux and usable input. Fix `32c109d`; native AMD64/ARM64 CI passes in `b34272e`. | Fix verified for the input/reconnect defect. Recommend affected-host confirmation before closing: underlying recurring disconnect cause remains unverified. |
| #214 | Full real MCP catalog reaches a mock model through pinned OpenCode, including `hab_run`, with no dropped tools. | Catalog symptom no longer reproduces on beta. Keep open pending separate HA-MCP side-panel verification. |
| #208 | Reproduced intermittent empty integration catalog after plugin activation. Exact production readiness sequence passed 30 cold starts; UI waits before a single authorization attempt. | Partial fix. Real-account model rejection and handoff acceptance remain unverified; not ready to close. |
| #209 | Existing beta handoff/guidance tests and new readiness work cover startup, not real-account/browser acceptance. | Keep open pending handoff verification. |
| #199 | Acknowledged lifecycle requests observed in startup return in_progress, not completion; no replay. Preview text is action-specific. Store audit pages all 117 fixture entries and preserves redaction. 24 Supervisor tests and pagination regression pass. | Partial fix; cross-app first-run state and remaining reported UX defects need review. New capability requests remain excluded. |
| #205 | Existing HTTP tests verify Basic device auth, browser cookie redemption, independent revocation and stream closure (14 tests passed). Docs now specify Accept negotiation, cookie name, unsupported token transports and device-management endpoints. | Repository/API fix candidate after CI. Native-client acceptance remains unverified. |
| #197, #206 | Existing beta targeted TUI repair passes the root Linux identity/preference suite. No stable backport. | Existing beta fix candidates; affected-host acceptance has not been collected. |
| #211, #217 | Existing beta private-copy placement restoration passes real pinned conversion with exact session/message/watermark projection checks. | Existing beta fix candidates; retained user databases were not supplied. |
| #195 | Compaction migration is covered by the native boundary image fixture, which passed. | Existing fix candidate. |
| #207, #202 | Beta diagnostics identify path/type metadata and preserve unknown files. No evidence establishes a safe repair for the reported installation. | Blocked on affected-path/provenance evidence; do not close. |
| #203 | Reporter selected compact; the shipped read-only HAB gateway is explicitly full-profile. Their external ha-readonly server is installation-specific. | Feature request / profile mismatch; no reproducible beta defect established. |

### Current batch verification

- Full Linux MCP suite: 48 files passed, 801 tests passed, 3 skipped.
- Native AMD64 boundary-test image passed, including the new real ttyd browser
  error-before-close test and existing desktop/mobile workspace recovery.
- OAuth production readiness sequence: 30 consecutive isolated cold starts passed.
- Stable tree has no net changes relative to the pre-sweep commit `057a4a5`.
- Test harness follow-ups: `94bdd57` bounds beta file concurrency; `b34272e`
  waits for MCP connection readiness before checking model tool publication.
  The corrected catalog test passed ten consecutive isolated runs.
- Verified code commit: `b34272ef84c88e4d2604a94e8948043640c5f747`.
- GitHub PR Checks: all 10 jobs passed,
  https://github.com/magnusoverli/opencode/actions/runs/43827876043 .
- GitHub Beta Image Checks: native AMD64 and ARM64 boundary jobs passed,
  https://github.com/magnusoverli/opencode/actions/runs/43827876001 .
- Stable restoration: native AMD64 and ARM64 passed,
  https://github.com/magnusoverli/opencode/actions/runs/43825420858 .
- No release was published and no issue was commented on, relabeled or closed.
