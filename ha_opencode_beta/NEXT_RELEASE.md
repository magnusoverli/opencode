# Next beta baseline: stable 3.5.3

Start the next beta from [`v3.5.3`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.3).
It promotes [`beta-v3.5.3b2`](https://github.com/magnusoverli/opencode/releases/tag/beta-v3.5.3b2),
which remains the latest published beta until the next beta is cut.

Both channels ship OpenCode 2.3.0, OpenChamber 2.7.2 and HAB 1.8.0.
Carry forward stable's V1 migration validation, terminal reconnection,
OpenChamber caching and history picker, decision-note diagnostics and LAN
configuration before adding new beta features.

Run `node --test ha_opencode_beta/test/stable-baseline.test.js` when preparing
the next beta. Preserve the beta add-on's slug, storage, sidecar identity,
update URLs and companion ownership.
