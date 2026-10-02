# Task 04 — OpenChamber v2.1.0 advance in stable (ha_opencode)

## Goal

Advance `ha_opencode` OpenChamber source pin from `9fba129` (1.24.2) to commit `90726f9949da3408b2baf0f997e24bd71455946e` (release `v2.1.0`). Re-derive all 5 source patches and update `OPENCHAMBER_VERSION` to `2.1.0`.

## Changes

1. **`ha_opencode/Dockerfile`**:
   - `ARG OPENCHAMBER_REVISION=90726f9949da3408b2baf0f997e24bd71455946e`
   - `ARG OPENCHAMBER_VERSION=2.1.0`
2. **`ha_opencode/build.yaml`**:
   - `OPENCHAMBER_REVISION: "90726f9949da3408b2baf0f997e24bd71455946e"`
   - `OPENCHAMBER_VERSION: "2.1.0"`
3. **`ha_opencode/test/runtime-contract.test.js`**:
   - Relax `OPENCHAMBER_VERSION` regex line 98 to `/^2\.\d+\.\d+(?:-preview\.\d+)?$/`
4. **`ha_opencode/test/fixtures/openchamber-update-notices.json`**:
   - Set `"revision": "90726f9949da3408b2baf0f997e24bd71455946e"`
   - Add `"nl"` locale string if required by `patch-app-updates.cjs`
5. **Re-derive source patch anchors** in `ha_opencode/rootfs/opt/openchamber/`:
   - `patch-app-updates.cjs`
   - `patch-usage-model.cjs`
   - `patch-editor-lsp.cjs`
   - `patch-managed-backend.cjs`

## Verification commands

```bash
WORK=$(mktemp -d)
git init -q "$WORK" && git -C "$WORK" remote add origin https://github.com/openchamber/openchamber.git
git -C "$WORK" -c http.version=HTTP/1.1 fetch -q --depth 1 origin 90726f9949da3408b2baf0f997e24bd71455946e
git -C "$WORK" checkout -q --detach FETCH_HEAD

P=ha_opencode/rootfs/opt/openchamber
for s in patch-app-updates.cjs patch-usage-model.cjs patch-editor-lsp.cjs patch-managed-backend.cjs; do
  printf '%-28s ' "$s"
  node "$P/$s" "$WORK" && echo OK || echo "ECHEC"
done

node --test "ha_opencode/test/*.test.js"
rm -rf "$WORK"
```
