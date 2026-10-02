# Task 03 — Dependency pins & MCP/LSP floors in stable (ha_opencode)

## Goal

Refresh low-risk dependency pins and raise unlocked floors in `ha_opencode`:
- Node: `24.21.0` (from `24.15.0`)
- yq: `v4.54.1` (from `v4.53.3`)
- Prettier: `3.9.9` (from `3.9.8`)
- tsx: `4.23.15` (from `4.20.6`)
- `@ai-sdk/openai-compatible`: `3.0.62` (from `3.0.53`)
- `@modelcontextprotocol/sdk`: `^1.31.0` (from `^1.29.0`)
- `ws`: `^8.22.0` (from `^8.18.0`)
- `yaml`: `^2.9.1` (from `^2.9.0` / `^2.4.5`)
- `vscode-languageserver-textdocument`: `^1.0.15` (from `^1.0.12`)

## Changes

1. **`ha_opencode/Dockerfile`**:
   - `ARG NODE_VERSION=24.21.0`
   - `ARG YQ_VERSION=v4.54.1`
   - `ARG TSX_VERSION=4.23.15`
2. **`ha_opencode/build.yaml`**:
   - `NODE_VERSION: "24.21.0"`
   - `YQ_VERSION: "v4.54.1"`
   - `TSX_VERSION: "4.23.15"`
3. **`ha_opencode/rootfs/opt/opencode-v2-homeassistant/package.json`**:
   - `"prettier": "3.9.9"`
   - Regenerate `package-lock.json`
4. **`ha_opencode/rootfs/opt/ppq-private-runtime/package.json`**:
   - `"tsx": "4.23.15"`
   - `"overrides": { "@ai-sdk/openai-compatible": "3.0.62" }`
   - Regenerate `package-lock.json`
5. **`ha_opencode/rootfs/opt/ha-mcp-server/package.json`**:
   - `"@modelcontextprotocol/sdk": "^1.31.0"`
   - `"ws": "^8.22.0"`
   - `"yaml": "^2.9.1"`
6. **`ha_opencode/rootfs/opt/ha-lsp-server/package.json`**:
   - `"yaml": "^2.9.1"`
   - `"vscode-languageserver-textdocument": "^1.0.15"`

## Verification commands

```bash
bash -c 'a=$(sed -n "s/^ARG TSX_VERSION=\(.*\)$/\1/p" ha_opencode/Dockerfile);
b=$(sed -n "s/^[[:space:]]*TSX_VERSION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode/build.yaml);
p=$(node -p "require(\"./ha_opencode/rootfs/opt/ppq-private-runtime/package.json\").dependencies.tsx");
[ "$a" = "$b" ] && [ "$a" = "$p" ] && [ "$a" = "4.23.15" ] && echo "TSX LOCKSTEP OK"'

(cd ha_opencode/rootfs/opt/ha-mcp-server && npm install --no-audit --no-fund && npm test)
(cd ha_opencode/rootfs/opt/ha-lsp-server && npm install --no-audit --no-fund && npm test)
rm -f ha_opencode/rootfs/opt/ha-mcp-server/package-lock.json ha_opencode/rootfs/opt/ha-lsp-server/package-lock.json
node --test "ha_opencode/test/*.test.js"
```
