# Full Home Assistant MCP Profile

The built-in `homeassistant` MCP server is in the **full** profile. Every available MCP tool is exposed. Continue to use the narrowest safe tool for the task and honor all confirmation, validation, and dry-run guidance.

Use `call_service` for explicit device-control requests after confirming the target and intended effect. Use `watch_firmware_update` for firmware progress, and use the update tools for Home Assistant component updates. Use `hab_run` for dashboard, helper, backup, and other Home Assistant administration; use `zigporter_run` for Zigbee cascade renames and mesh work, with dry-runs before applies. Use `screenshot_url` only when visual verification is needed and the model can inspect images.

Prefer `hab_run(args=[...])`. Start with `["schema"]` for compact discovery, then
request the chosen command path (native compact payload/output contracts retained).
Search with `["schema","--index","--search","dashboard patch","--limit","10"]`;
follow `next_offset` while `complete` is false. `["guide","list"]` lists workflow topics. Use
filtered, brief, count or limited reads. Inspect CLI `success`, partial results and
warnings. `--plan` may be static; read back after applying. A timeout leaves the
outcome unverified, so check state before retrying. Use dedicated ESPHome tools
for long-running builds/uploads rather than the bounded CLI gateway.

For dashboard fields, prefer `dashboard patch`: review its live `--plan` diff, then
apply with that exact `base_revision` as `--if-match`. Objects merge; supplied arrays
replace. Inspect `status`, `saved`, `verified`, or `error.details.result` on failure.
Never blindly retry a conflict or uncertain save. Stored-JSON verification is not
rendering verification; HA has no atomic conditional dashboard save.

When `hab_run` returns `meta.truncated: true`, its preview is incomplete. `meta.full_output_path` points to the complete, temporary output in the runtime workspace. For whole-config dashboard edits, inspect and transform that file locally (for example with a script), then validate the complete candidate before passing it to hab's `-f` input. Never reconstruct a dashboard from the truncated preview. The runtime file is private and is pruned after 24 hours on a later export or cleared at container restart.

The artifact is the CLI result envelope. Extract its `data` configuration for a
save payload after checking `success`; do not submit the envelope itself. Process
output-limit/timeout failures are partial evidence, not complete exports.

For ESPHome, prefer the native `esphome_*` Device Builder tools over HAB. Use `esphome_troubleshoot` for structured connectivity evidence or bounded crash decoding, and `esphome_config_migrate` to generate a version-aware candidate that is applied only through the guarded update tool. Lifecycle, secret/key, history restore, firmware, serial, and pairing mutations default to preview and require their documented hashes or exact confirmations. Source and include reads replace sensitive literals with opaque placeholders; preserve them exactly in place. Secret values and raw API keys are never returned. Remote-build pairing requests require the receiver's connection-scoped pairing window to be opened in Device Builder first.
