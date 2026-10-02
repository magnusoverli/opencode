# Task 03 — Raise the floor on the unlocked floating ranges (beta)

## Goal

Bring the beta channel's `ha-mcp-server` and `ha-lsp-server` dependencies up to date. Neither
tree has a committed lockfile and the Dockerfile installs them with `npm install`, so their caret
ranges already float to the newest matching version at image build time. This task raises the
declared floor so the declared intent matches what actually gets installed.

## Changes

1. **`ha_opencode_beta/rootfs/opt/ha-mcp-server/package.json`** — in `dependencies`:
   - `@modelcontextprotocol/sdk`: `^1.29.0` to `^1.31.0` (two minors; re-verified 2026-09-30)
   - `ws`: `^8.18.0` to `^8.22.0`
   - `yaml`: `^2.9.0` to `^2.9.1`

   Leave `puppeteer-core` at `^24.0.0` and `zod` at `^3.25.0` — both are in the held-back list.
   Leave `vitest` at `^3.1.1` in `devDependencies`. Do not add a lockfile to this tree: the
   Dockerfile deliberately uses `npm install` here, and adding one would change the build's
   resolution behaviour, which is outside this task.

   Note that SDK 1.31.0 still declares `zod: ^3.25 || ^4.0` (verified), so leaving `zod` at
   `^3.25.0` remains valid.

2. **`ha_opencode_beta/rootfs/opt/ha-lsp-server/package.json`** — in `dependencies`:
   - `yaml`: `^2.4.5` to `^2.9.1`
   - `vscode-languageserver-textdocument`: `^1.0.12` to `^1.0.15`

   Leave `vscode-languageserver` at `^9.0.1` and `vitest` at `^3.1.1`. Do not add a lockfile.

3. **Do not touch `zod`.** It is declared in `ha-mcp-server/package.json` but is never imported
   anywhere in that tree or in `ha-lsp-server`; it is only a transitive dependency of
   `@modelcontextprotocol/sdk`, which accepts `zod: ^3.25 || ^4.0` in 1.29.0, 1.30.1 and 1.31.0.
   Do not "clean it up" by removing it either — that is a separate decision, and removing a
   declared dependency is out of scope. Just leave the line as it is.

4. **Confirm the MCP server's own suite still passes** against the raised SDK floor. The two
   SDK minor bumps (1.29 → 1.31) are the only behavioural risk here; if `npm test` in
   `ha_opencode_beta/rootfs/opt/ha-mcp-server` fails, report the failure rather than pinning
   back to `^1.29.0` without saying so.

## File scope

- `ha_opencode_beta/rootfs/opt/ha-mcp-server/package.json`
- `ha_opencode_beta/rootfs/opt/ha-lsp-server/package.json`

Do not touch the `ha_opencode/` copies of either server (stable), and do not add or modify any
`package-lock.json` in this task.

## Dependencies

Task 01. Independent of Task 02 in practice, but sequenced after it so the beta dependency set is
settled before the release identity is cut in Task 04.

## Verification commands

```bash
# The intended floors are in place and the held-back majors did not move
node -e 'const fs=require("fs");
const m=JSON.parse(fs.readFileSync("ha_opencode_beta/rootfs/opt/ha-mcp-server/package.json"));
const l=JSON.parse(fs.readFileSync("ha_opencode_beta/rootfs/opt/ha-lsp-server/package.json"));
const want={"@modelcontextprotocol/sdk":"^1.31.0","ws":"^8.22.0","yaml":"^2.9.1",
            "puppeteer-core":"^24.0.0","zod":"^3.25.0"};
for(const [k,v] of Object.entries(want)) if(m.dependencies[k]!==v) throw new Error(`mcp ${k}=${m.dependencies[k]} want ${v}`);
const wantL={"yaml":"^2.9.1","vscode-languageserver-textdocument":"^1.0.15","vscode-languageserver":"^9.0.1"};
for(const [k,v] of Object.entries(wantL)) if(l.dependencies[k]!==v) throw new Error(`lsp ${k}=${l.dependencies[k]} want ${v}`);
if(m.devDependencies.vitest!=="^3.1.1") throw new Error("mcp vitest moved");
if(l.devDependencies.vitest!=="^3.1.1") throw new Error("lsp vitest moved");
console.log("floors raised, majors held");'

# Each raised range actually resolves to something installable
(cd ha_opencode_beta/rootfs/opt/ha-mcp-server && npm install --no-audit --no-fund && npm test)
(cd ha_opencode_beta/rootfs/opt/ha-lsp-server && npm install --no-audit --no-fund && npm test)

# No lockfile was introduced, and stable's copies are untouched
! ls ha_opencode_beta/rootfs/opt/ha-mcp-server/package-lock.json
! ls ha_opencode_beta/rootfs/opt/ha-lsp-server/package-lock.json
git diff --quiet -- ha_opencode/ && echo "stable clean"
```
