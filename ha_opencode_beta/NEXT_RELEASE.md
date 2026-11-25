# Beta 3.5.5b2: backup and restore

The 3.5.5 beta series starts at the published [stable 3.5.4 release](https://github.com/magnusoverli/opencode/releases/tag/v3.5.4).
`3.5.5b0` carries the same runtime, including HTTPS aliases, the V1 migration
fix, OpenCode 2.4.1, OpenChamber 2.8.0 and HAB 1.10.0.

`3.5.5b1` keeps those runtime pins and introduces cold backups. In a real
Supervisor 2026.11.0 restore, OpenChamber loaded the restored session and
synthesized speech from the restored Piper model without network access.
`3.5.5b2` excludes the generated CLI log directory after the same test
exposed a root-owned restored log. Before promotion exercise both the CLI and
OpenChamber after restore. Run `uv run ha_opencode_beta/test/backup-restore.py`
for the offline archive contract.

Run `node --test ha_opencode_beta/test/stable-baseline.test.js` when preparing
the next beta. Preserve the beta add-on's slug, storage, sidecar identity,
update URLs and companion ownership.
