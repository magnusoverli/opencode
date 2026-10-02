# Task 05 — Stable release identity 3.0.11, CHANGELOG, DOCS & PR update

## Goal

Bump stable add-on version in `ha_opencode/config.yaml` to `3.0.11`, add release notes under `## 3.0.11` in `ha_opencode/CHANGELOG.md`, update `ha_opencode/DOCS.md`, run full project verification, and update PR #1 / PR #144.

## Changes

1. **`ha_opencode/config.yaml`**: `version: "3.0.11"`.
2. **`ha_opencode/CHANGELOG.md`**: Add `## 3.0.11` section with detailed release notes.
3. **`ha_opencode/DOCS.md`**: Update version references to `3.0.11` and OpenCode `2.0.21`.
4. Run full project verification commands.
5. Create/force-push commits onto branch `beta/opencode-2.0.20-openchamber-2.0.4` or new branch `stable/opencode-2.0.21-openchamber-2.1.0` and update PR #1 and PR #144.

## Verification commands

```bash
(cd ha_opencode/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund && npm run verify:versions)

python3 ha_opencode/test/v2-upgrade-acceptance.py
node --test "ha_opencode/test/*.test.js"
bash scripts/check-addon-options.sh ha_opencode ha_opencode_beta
```
