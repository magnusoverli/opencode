# Beta 3.5.3b0 release baseline

| Field | Value |
| --- | --- |
| Beta release | [`beta-v3.5.3b0`](https://github.com/magnusoverli/opencode/releases/tag/beta-v3.5.3b0) |
| Stable baseline | [`v3.5.2`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.2) |
| Baseline commit | `f10db183cfd5add64a6d728c02b8d7ee6c45546c` |
| Previous beta | `3.5.2b0` |

## Implementation baseline

This beta adds direct HTTP and HTTPS for the desktop app on a configured private
IPv4 subnet, and checks LAN settings before services start. Runtime pins remain
OpenCode 2.3.0, OpenChamber 2.7.2 and HAB 1.8.0.

`test/stable-baseline.test.js` checks every stable tracked runtime/build/compat
file against beta. The reviewed runtime substitutions cover beta's sidecar identity
and decision-note directory, MCP/LSP pattern-update URLs, companion owner and
native MCP migration provenance. These are exact substitutions, not whole-file
exemptions. Beta retains its own manifest, AppArmor profile, labels, history and
channel-specific test expectations.

## Verification

LAN regression tests cover direct HTTP and HTTPS, password authentication,
subnet checks, and startup without certificate files for HTTP. They exercise
the frontend with real sockets, not Electron against an installed HA system.
