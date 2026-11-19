# Beta 3.5.2b0 release baseline

| Field | Value |
| --- | --- |
| Beta release | [`beta-v3.5.2b0`](https://github.com/magnusoverli/opencode/releases/tag/beta-v3.5.2b0) |
| Stable baseline | [`v3.5.1`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.1) |
| Baseline commit | `edcc91b9570e6cfe6a7a2782a6413e5bd7069b4e` |
| Stable multi-architecture image | `ghcr.io/magnusoverli/ha_opencode:3.5.1` |
| Stable image digest | `sha256:f8fedde2b6d992d240305d2d86c4ac0cf284313d7e998c6d1aff0dc65c00c8b4` |
| Previous beta | `3.5.1b4` |

## Implementation baseline

This series starts from the complete stable 3.5.1 implementation, including
Zigporter compatibility, HAB cache handling, project-upgrade preservation, native
V2 policies/configuration, instruction cleanup, guarded cache expiry and browser
channel isolation. Runtime pins remain OpenCode 2.3.0, OpenChamber 2.7.2 and
HAB 1.8.0. [PR #223](https://github.com/magnusoverli/opencode/pull/223) adds
opt-in support for the OpenCode desktop renderer on the API LAN frontend.

`test/stable-baseline.test.js` checks every stable tracked runtime/build/compat
file against beta. The reviewed runtime substitutions cover beta's sidecar identity
and decision-note directory, MCP/LSP pattern-update URLs, companion owner and
native MCP migration provenance, and the LAN configuration and proxy changes
for desktop access. These are exact substitutions, not whole-file
exemptions. Beta retains its own manifest, AppArmor profile, labels, history and
channel-specific test expectations.

## Verification

The release tag identifies the source for both AMD64 and ARM64 images. See
[issue #222](https://github.com/magnusoverli/opencode/issues/222) for the
reported desktop setup; the proxy regression test does not exercise Electron
against an installed Home Assistant instance.
