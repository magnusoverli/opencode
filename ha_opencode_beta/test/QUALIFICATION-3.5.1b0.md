# Beta 3.5.1b0: V2 consolidation

## Subsequent self-test

The operator's later self-test found a reproducible transient-writer cache
deletion race and stale HAB version guidance. Full acceptance was not
established. See [the b1 follow-up](QUALIFICATION-3.5.1b1.md) for the corrections
and remaining installed-acceptance gaps; the original evidence below is
historical and is not a full-release acceptance claim.

## Finding disposition

| Audit finding | Implementation / decision |
| --- | --- |
| Code Mode disabled | Default-off `mcp_code_mode`, independent external `codemode`, real pinned-runtime mixed-tool qualification. Capability/apply tools remain direct because nested calls bypass per-tool hooks. |
| Restricted native configuration | Native hard-deny policies added; strict whole-generated-document validation. Keep approval compilation, process/credential boundaries and project isolation. Policies cannot prompt or sandbox plugins. |
| Duplicate instructions/help injection | One packaged managed global file. Remove obsolete deployment/help code; exact-owned beta copy retirement preserves edits/shared files. Dynamic context remains bounded and refreshed. |
| Legacy generated settings | Native `update: "disable"` throughout runtime generation; exact-byte client config upgrade preserves preferences. |
| Contradictory/stale guidance | Correct actual workspace, read-only agent availability, rollback meaning, skill discovery and upstream URLs. |
| Retained original data | Metadata-only inventory plus explicit reviewed disposable-cache cleanup. Retain history/accounts, user packages and active customization roots. |
| Necessary compatibility | Keep late V1 conversion, V2 upgrades, old input adapters, historical dev-only runtimes, `opencode2` alias and HA LSP integration. |

## Automated evidence

- Local pinned OpenCode 2.3.0: direct and Code Mode read-only inspection/preview,
  attempted read-only apply exclusion, Build handoff, separate approval and one
  approved save. Synthetic Supervisor/model fixtures; no live HA mutations.
- Actual full bundled MCP catalogue, synthetic OpenAI-compatible provider:
  direct request 81 tools / 65,532 tool-schema bytes / 102,084 whole-request bytes;
  mixed Code Mode 15 tools / 16,988 tool-schema bytes / 57,130 whole-request bytes.
  The same initial prompt was used in fresh sessions, with production
  direct-review exceptions. These are serialized request bytes, not token
  counts, real-model accuracy, latency, recurring costs or installed performance.
- Local LF-normalized Linux container: **153 tests passed, zero skipped**,
  including pinned runtime behavior, native read-policy denial despite an allow,
  client config upgrade, custom agent activation and root-only cleanup tests.
  Ten functional channel-separation checks and both option-schema checks passed.
- The same catalogue fixture on Linux measured 81 direct tools / 65,524
  tool-schema bytes / 74,591 whole-request bytes versus mixed Code Mode's
  15 / 16,980 / 29,637. Platform/runtime context changes absolute request sizes;
  do not extrapolate either fixture into a universal token-savings percentage.
- Linux contracts, root-only filesystem/cleanup fixtures and native AMD64/ARM64
  image boundary checks: results recorded after CI qualification.
- Local native AMD64 `boundary-test` image built successfully, including
  browser, caller-credential, LSP, Zigbee, Assist and MCP startup contracts.

## Installed acceptance still due

| Area | Check |
| --- | --- |
| Existing beta upgrade | Preferences, history and provider sign-ins preserved; edited legacy rules retained. |
| Code Mode real models | Representative YAML edits, entity diagnosis and Supervisor review on hosted and smaller/local models; total input/output tokens, tool errors, latency and correctness across repeated runs. |
| UI approval | Confirm direct apply prompt and read-only exclusion through actual terminal/OpenChamber clients with Code Mode enabled. |
| Cache administration | Inspect real retained storage and inaccessible-process handling; no installed cleanup claimed. |

Keep Code Mode default-off until real-model evidence supports a default change.
No user-account inference benchmark or installed cleanup is implied by CI.
