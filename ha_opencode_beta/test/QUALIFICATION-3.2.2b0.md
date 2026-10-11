# Beta 3.2.2b0 qualification — 2026-10-11

Scope: [#181](https://github.com/magnusoverli/opencode/issues/181), implemented in
[#182](https://github.com/magnusoverli/opencode/pull/182). Runtime source: `1d3a1e7`.

| Check | Result | Evidence |
| --- | --- | --- |
| Repository contracts, MCP suites, HA companion and production audit gates | Pass | [PR Checks](https://github.com/magnusoverli/opencode/actions/runs/38134612757) |
| Native amd64 and arm64 image boundaries | Pass | [Beta Image Checks](https://github.com/magnusoverli/opencode/actions/runs/38134612786) |
| Copy-on-write history migration | Pass | 13 cases, including real pinned conversions and failed-upgrade preservation; unknown work remains intact with bounded diagnostics |
| ESPHome placeholder round trips | Pass | Repeated shared sanitization, read/validate, migrate/update, invalid/moved/duplicated/missing tokens; controlled Device Builder fixture |
| Native YAML formatting | Pass | Pinned runtime preserves YAML by default, formats when enabled, honors explicit overrides and rejects read-only writes |
| Restricted TUI storage | Pass | Actual UID 60001 atomic replacement, retained state, root-owned config/plugin protection and symlink rejection |
| Supervisor upgrade from 3.2.1b2 | Pass | Installed exact candidate through a loopback registry; synthetic beta session/input and separate stable history retained |
| Installed TUI and restart | Pass | Real Settings save and recent-model selection; restricted-UID favourite fixture; exact preferences/state retained after Supervisor restart |
| Installed Core Ingress | Pass | Chromium session CRUD and built-UI continuation before/after page reload, with model execution disabled |
| Installed lifecycle | Pass | Shared sessions/policy, hardened credential process, absent-backend recovery, independent UI stop/start and persisted update-notice dismissal |
| Installed production packages | Pass with disclosed mitigation | Four npm trees: zero findings; OpenChamber: 179 package names / 185 versions, one vendor-mitigated braces advisory, zero unmitigated findings |

Candidate image identity:
`sha256:f48c60eebfafe86e4786c57bca56399a23e4ba154a393b172b287c489a3d83c0`.
This locally built candidate is distinct from the separately built public image.

## Coverage limits

- ESPHome checks use controlled fixtures, not firmware uploads or a physical device.
- Unknown migration artifacts are diagnosed and preserved, not automatically deleted.
- Package audits exclude OS packages and embedded browser code. The known braces
  advisory remains visible as vendor-mitigated; this is not a zero-finding audit.
- Public-relay phone pairing and external-model execution are not claimed here.
- Fresh-state behavior is covered by automated migration/image fixtures; the
  installed Home Assistant exercise uses the existing beta upgrade path.
- The isolated installation has no connected model provider, so pinned OpenCode
  hides the favourite action. Settings and recent-model selection use the real
  TUI; favourite persistence uses a controlled file written as the restricted UID.
