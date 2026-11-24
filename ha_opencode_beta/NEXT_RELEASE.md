# Beta 3.5.4b2 baseline: stable 3.5.3

[`beta-v3.5.4b0`](https://github.com/magnusoverli/opencode/releases/tag/beta-v3.5.4b0)
starts from [`v3.5.3`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.3).
It adds optional HTTPS aliases for the two reverse-proxied LAN frontends (#221).

Beta 3.5.4b1 adds OpenCode CLI/plugin 2.4.0, OpenChamber 2.8.0, HAB 1.10.0 and agent guidance for its command catalog.
Beta 3.5.4b2 corrects V1 history validation for generated legacy-tool notices (#230).
The published 3.5.4b0 and stable 3.5.3 images still contain 2.3.0, 2.7.2 and 1.8.0.
Carry forward stable's V1 migration validation, terminal reconnection,
OpenChamber caching and history picker, decision-note diagnostics and LAN
configuration before adding new beta features.

Run `node --test ha_opencode_beta/test/stable-baseline.test.js` when preparing
the next beta. Preserve the beta add-on's slug, storage, sidecar identity,
update URLs and companion ownership.
