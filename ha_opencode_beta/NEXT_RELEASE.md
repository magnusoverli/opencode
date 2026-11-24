# Beta 3.5.5b0 baseline: stable 3.5.4

The 3.5.5 beta series starts at the published [stable 3.5.4 release](https://github.com/magnusoverli/opencode/releases/tag/v3.5.4).
`3.5.5b0` carries the same runtime, including HTTPS aliases, the V1 migration
fix, OpenCode 2.4.1, OpenChamber 2.8.0 and HAB 1.10.0.

Run `node --test ha_opencode_beta/test/stable-baseline.test.js` when preparing
the next beta. Preserve the beta add-on's slug, storage, sidecar identity,
update URLs and companion ownership.
