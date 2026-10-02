# Plan: update stable channel (ha_opencode) to OpenCode 2.0.21 and OpenChamber 2.1.0

## Goal

Retarget the upgrade work from `ha_opencode_beta` to **`ha_opencode` (stable channel)** as requested in the upstream review for PR #144 by maintainer `@magnusoverli`.

Update `ha_opencode` from version `3.0.10` to `3.0.11`, upgrading:
- Bundled OpenCode V2 CLI/plugin to `2.0.21`
- OpenChamber to `2.1.0` (`90726f9949da3408b2baf0f997e24bd71455946e`)
- Supporting pins: Node `24.21.0`, yq `v4.54.1`, Prettier `3.9.9`, tsx `4.23.15`, `@ai-sdk/openai-compatible` `3.0.62`
- Floating floors: `@modelcontextprotocol/sdk` `^1.31.0`, `ws` `^8.22.0`, `yaml` `^2.9.1`, `vscode-languageserver-textdocument` `^1.0.15`
- Migration guard in `ha_opencode/rootfs/usr/local/bin/opencode-v2-migrate.py`: set `V2_UPGRADE_TARGET = "2.0.21"` AND add `"2.0.13"` to `V2_UPGRADE_SOURCES` so existing stable users can migrate without encountering `MigrationError: target_version_mismatch`.

Clean up `ha_opencode_beta` back to pristine main state (reverting beta changes).

## Scope

**Touched (stable channel & CI workflow):**
- `ha_opencode/Dockerfile`
- `ha_opencode/build.yaml`
- `ha_opencode/config.yaml`
- `ha_opencode/DOCS.md`
- `ha_opencode/CHANGELOG.md`
- `ha_opencode/rootfs/opt/opencode-v2-homeassistant/package.json`
- `ha_opencode/rootfs/opt/opencode-v2-homeassistant/package-lock.json`
- `ha_opencode/rootfs/opt/ppq-private-runtime/package.json`
- `ha_opencode/rootfs/opt/ppq-private-runtime/package-lock.json`
- `ha_opencode/rootfs/opt/ha-mcp-server/package.json`
- `ha_opencode/rootfs/opt/ha-lsp-server/package.json`
- `ha_opencode/rootfs/opt/openchamber/patch-*`
- `ha_opencode/rootfs/usr/local/bin/opencode-v2-migrate.py`
- `ha_opencode/test/*`
- `.github/workflows/check-opencode-update.yaml`
- Revert all changes in `ha_opencode_beta/`

## Tasks

| # | Task | Depends on |
|---|---|---|
| 1 | Revert beta edits & switch branch to `stable/opencode-2.0.21` | — |
| 2 | OpenCode V2 2.0.21 runtime & migration guard fix in stable (`ha_opencode`) | 1 |
| 3 | Dependency pins & MCP/LSP floors in stable | 2 |
| 4 | OpenChamber v2.1.0 advance in stable & patch re-derivation | 2, 3 |
| 5 | Stable release identity `3.0.11`, CHANGELOG, DOCS & workflow PR push | 2, 3, 4 |

## Verification commands

```bash
# 1. Verify V2 pins match in stable
(cd ha_opencode/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund && npm run verify:versions)

# 2. Stable contract tests
node --test "ha_opencode/test/*.test.js"

# 3. Migration test from 2.0.13 -> 2.0.21
python3 ha_opencode/test/v2-upgrade-acceptance.py

# 4. Check add-on options
bash scripts/check-addon-options.sh ha_opencode ha_opencode_beta
```
