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
| #216 | Beta normalizes local file references to descriptors before upstream config expansion. External validation is isolated from bundled/native registration. Both reference formats, delayed resolution, invalid external config, and Linux file-identity checks pass. Commit `729c272`; beta image CI passed. Stable backport withdrawn. | Candidate once beta PR checks pass; OAuth startup race currently blocks that workflow. |
