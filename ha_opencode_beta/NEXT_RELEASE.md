# Beta 3.5.3b1 release baseline

| Field | Value |
| --- | --- |
| Beta release | [`beta-v3.5.3b1`](https://github.com/magnusoverli/opencode/releases/tag/beta-v3.5.3b1) |
| Stable baseline | [`v3.5.2`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.2) |
| Baseline commit | `f10db183cfd5add64a6d728c02b8d7ee6c45546c` |
| Previous beta | `3.5.3b0` |

## Implementation baseline

This beta builds on direct LAN access and startup validation from b0. It addresses
terminal reconnection (#224), OpenChamber asset caching (#225), migrated-session
discovery (#226), and pinned decision-note omission reporting (#227). Runtime pins remain
OpenCode 2.3.0, OpenChamber 2.7.2 and HAB 1.8.0.

`test/stable-baseline.test.js` checks every stable tracked runtime/build/compat
file against beta. The reviewed runtime substitutions cover beta's sidecar identity
and decision-note directory, MCP/LSP pattern-update URLs, companion owner and
native MCP migration provenance. These are exact substitutions, not whole-file
exemptions. Beta retains its own manifest, AppArmor profile, labels, history and
channel-specific test expectations.

## Verification

Targeted tests cover Chrome cache revalidation, sidebar selection against the
pinned OpenChamber source, digest overflow and recall, and masked WebSocket
closure through the tagged Home Assistant handlers. Linux ttyd/tmux tests
verified reattachment and refusal after deliberate detach or exit. Installed
Home Assistant Green verification remains pending.

LAN regression tests cover direct HTTP and HTTPS, password authentication,
subnet checks, and startup without certificate files for HTTP. They exercise
the frontend with real sockets, not Electron against an installed HA system.
