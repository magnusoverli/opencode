# Task 02 — OpenCode V2 2.0.21 runtime & migration guard fix in stable (ha_opencode)

## Goal

Bump the stable channel (`ha_opencode`) OpenCode V2 runtime from `2.0.13` to `2.0.21`. Fix the migration guard in `ha_opencode/rootfs/usr/local/bin/opencode-v2-migrate.py` by:
1. Setting `V2_UPGRADE_TARGET = "2.0.21"`
2. Adding `"2.0.13"` to `V2_UPGRADE_SOURCES` so existing stable installations upgrade seamlessly without `MigrationError: target_version_mismatch`.

Update all associated test literals and certified version files in `ha_opencode/`.

## Changes

1. **`ha_opencode/Dockerfile` line 83**: `ARG OPENCODE_V2_VERSION=2.0.21`.
2. **`ha_opencode/build.yaml`**: `OPENCODE_V2_VERSION: "2.0.21"`.
3. **`ha_opencode/rootfs/opt/opencode-v2-homeassistant/package.json`**: `"@opencode/cli"` and `"@opencode/plugin"` → `"2.0.21"`.
4. **Regenerate `ha_opencode/rootfs/opt/opencode-v2-homeassistant/package-lock.json`** via `npm install --package-lock-only --no-audit --no-fund`.
5. **`ha_opencode/rootfs/usr/local/bin/opencode-v2-migrate.py`**:
   - `V2_UPGRADE_SOURCES = {"0.0.0-beta-18684", "0.0.0-beta-19242", "2.0.13"}`
   - `V2_UPGRADE_TARGET = "2.0.21"`
6. **`ha_opencode/rootfs/opt/openchamber/patch-usage-model.cjs` line 49**: comment `2.0.13` → `2.0.21`.
7. Update version literals in `ha_opencode/test/`:
   - `opencode-v2-runtime.test.js`
   - `opencode-v2-migration.test.js` (`TARGET_VERSION = "2.0.21"`)
   - `v2-lan-fixture.mjs`
   - `v2-self-test-policy.py` (`VERSION = "2.0.21"`)
   - `v2-upgrade-acceptance.py` (`target_version == "2.0.21"`)
   - `managed-cli.test.py`

## Verification commands

```bash
(cd ha_opencode/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund && npm run verify:versions)

python3 ha_opencode/test/v2-upgrade-acceptance.py
python3 ha_opencode/test/v2-self-test-policy.py
node --test "ha_opencode/test/*.test.js"
```
