# Task 02 — Refresh the pinned dependencies (beta)

## Goal

Bump every remaining beta pin to its latest compatible version, and confirm the pins that are
already latest are left alone. Regenerate the `ppq-private-runtime` lock so the `tsx` and
`@ai-sdk/openai-compatible` bumps are actually locked.

## Changes

Apply exactly these bumps, in the beta channel only:

| Pin | From | To | Kind | Where |
|---|---|---|---|---|
| `NODE_VERSION` | `24.15.0` | `24.21.0` | minor, same LTS line | `Dockerfile` line 3 and the `build.yaml` args entry |
| `YQ_VERSION` | `v4.53.3` | `v4.54.1` | **minor** — see note | `Dockerfile` line 87 and the `build.yaml` args entry |
| `prettier` | `3.9.8` | `3.9.9` | patch | `opencode-v2-homeassistant/package.json` dependencies |
| `tsx` | `4.20.6` | `4.23.15` | minor | `ppq-private-runtime/package.json` dependencies |
| `@ai-sdk/openai-compatible` | `3.0.53` | `3.0.60` | patch | `ppq-private-runtime/package.json` overrides |

**yq note.** `v4.53.3` is currently pinned and is over three months old (`v4.53.3` published
2026-06-06). The target `v4.54.1` (2026-09-29) is a **minor** release, not a patch — the original
plan assumed `v4.53.6`, which is itself already two months old. yq is the agent's YAML read/query/convert
tool and is load-bearing: it must tolerate Home Assistant's custom tags (`!include`, `!secret`,
`!include_dir_*`, `!env_var`, `!input`) instead of crashing on them, and the add-on's own validation
pipeline depends on it. The Dockerfile's `yq --version | grep -q mikefarah` assertion only proves
provenance, not flag compatibility. Treat the minor bump as real: after changing it, sanity-check that
the pinned yq still handles HA custom tags rather than assuming it.

1. **`ha_opencode_beta/Dockerfile`** — update `ARG NODE_VERSION` (line 3) to `24.21.0`,
   `ARG YQ_VERSION` (line 87) to `v4.54.1`, **and `ARG TSX_VERSION` (line 86) to `4.23.15`**.
   Leave `ARG BUILD_FROM` (line 2), the `oven/bun` image with its sha256 digest (line 11),
   `HAB_VERSION` (line 61), `PPQ_PROXY_VERSION` (line 85), `TTYD_VERSION` (line 81) and
   `ZIGPORTER_VERSION` (line 88) untouched; those were re-verified on 2026-09-30 as already at their
   latest published versions (bun 1.4.2, hab 1.6.4, ttyd 1.7.7, zigporter 1.4.2), and
   `PPQ_PROXY_VERSION` is held back.

   **`TSX_VERSION` is part of this task — do not skip it.** It was missed by the first version of this
   contract. `tsx` is under a **four-way lockstep** enforced in two independent places:
   - `Dockerfile:236` (build time):
     `test "$(node -p 'require("./node_modules/tsx/package.json").version')" = "${TSX_VERSION}"` —
     fails the image build
   - `test/runtime-contract.test.js:116-123`, which for `["tsx", "TSX_VERSION"]` asserts the
     Dockerfile ARG, `package.json`, the lock and `build.yaml` are all equal

   So bumping only `package.json` breaks both the build and the contract suite. All four must move
   together. (`PPQ_PROXY_VERSION` / `ppq-private-mode` is the same mechanism but stays at `0.1.0`.)

2. **`ha_opencode_beta/build.yaml`** — update the matching `args` entries for `NODE_VERSION`,
   `YQ_VERSION` **and `TSX_VERSION`** so they stay identical to the Dockerfile ARG defaults.

3. **`ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json`** — bump `prettier`
   to `3.9.9` in `dependencies`. Regenerate this tree's `package-lock.json` with the same
   lockfile-only approach used in Task 01, so the lock picks up prettier 3.9.9 and keeps
   `@opencode/cli` / `@opencode/plugin` at **2.0.20**.

4. **`ha_opencode_beta/rootfs/opt/ppq-private-runtime/package.json`** — bump `tsx` to
   `4.23.15` in `dependencies` and `@ai-sdk/openai-compatible` to `3.0.60` in `overrides`.
   Leave `ppq-private-mode` at `0.1.0` and `tinfoil` at `1.2.1`: the former is the held-back
   0.x major, the latter is already latest. Then regenerate
   `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package-lock.json` with a lockfile-only
   install. Keep the `overrides` block present; the `tinfoil` override is what stops a moving
   transitive dependency from breaking the build.

5. **Verify, do not "fix"** — the Dockerfile asserts `tsx --version` at build time and evals
   the PPQ proxy surface (`proxy.startProxy`, `tinfoil.SecureClient`) and asserts
   `require("./node_modules/ppq-private-mode/package.json").version` equals `${PPQ_PROXY_VERSION}`.
   These must still hold. They are build-time, so confirm by reading the Dockerfile assertions
   and by running the same `node -p` version checks locally rather than a full image build.

## File scope

- `ha_opencode_beta/Dockerfile`
- `ha_opencode_beta/build.yaml`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package.json`
- `ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/package-lock.json`
- `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package.json`
- `ha_opencode_beta/rootfs/opt/ppq-private-runtime/package-lock.json`

Do not touch `ha_opencode/**` (stable) or `ha-mcp-server` / `ha-lsp-server` (Task 03).

## Dependencies

Task 01. The `opencode-v2-homeassistant` lock is regenerated again here, so it must already
carry 2.0.20 or this task will silently revert it.

## Verification commands

```bash
# Docker/yq pins align between the two files and hit the intended versions
bash -c 'for k in NODE_VERSION YQ_VERSION; do
  b=$(sed -n "s/^[[:space:]]*$k:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode_beta/build.yaml)
  a=$(sed -n "s/^ARG $k=\(.*\)$/\1/p" ha_opencode_beta/Dockerfile)
  echo "$k build.yaml=$b dockerfile=$a"; [ "$b" = "$a" ] || exit 1; done'
# NODE_VERSION 24.21.0 and YQ_VERSION v4.54.1, both agreeing

# The V2 lock still resolves 2.0.20 and now carries prettier 3.9.9
(cd ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant \
  && npm ci --no-audit --no-fund \
  && npm run verify:versions \
  && node -p "require('./node_modules/@opencode/cli/package.json').version" \
  && node -p "require('./node_modules/prettier/package.json').version")
# 2.0.20 then 3.9.9

# The PPQ lock is internally consistent with its package.json, and the held-back pins did not move
node -e 'const fs=require("fs"),d="ha_opencode_beta/rootfs/opt/ppq-private-runtime/";
const p=JSON.parse(fs.readFileSync(d+"package.json")),l=JSON.parse(fs.readFileSync(d+"package-lock.json"));
for(const k of Object.keys(p.dependencies))
  if(l.packages["node_modules/"+k].version!==p.dependencies[k]) throw new Error(k+" lock drift");
if(p.dependencies["ppq-private-mode"]!=="0.1.0") throw new Error("ppq-private-mode must stay 0.1.0");
if(p.overrides.tinfoil!=="1.2.1") throw new Error("tinfoil override must stay 1.2.1");
console.log("ppq lock consistent:",JSON.stringify(p.dependencies),JSON.stringify(p.overrides));'
# expects tsx 4.23.15, ppq-private-mode 0.1.0, tinfoil 1.2.1, @ai-sdk/openai-compatible 3.0.60

# All four TSX_VERSION lockstep sites agree
bash -c 'a=$(sed -n "s/^ARG TSX_VERSION=\(.*\)$/\1/p" ha_opencode_beta/Dockerfile);
b=$(sed -n "s/^[[:space:]]*TSX_VERSION:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ha_opencode_beta/build.yaml);
p=$(node -p "require(\"./ha_opencode_beta/rootfs/opt/ppq-private-runtime/package.json\").dependencies.tsx");
l=$(node -p "require(\"./ha_opencode_beta/rootfs/opt/ppq-private-runtime/package-lock.json\").packages[\"node_modules/tsx\"].version");
echo "dockerfile=$a build.yaml=$b package=$p lock=$l";
[ "$a" = "$b" ] && [ "$a" = "$p" ] && [ "$a" = "$l" ] && [ "$a" = "4.23.15" ]'

# Already-latest pins are untouched, and the runtime contract still holds
grep -q "oven/bun:1.4.2-slim@sha256:cb3bbbb0" ha_opencode_beta/Dockerfile
grep -q "ARG TTYD_VERSION=1.7.7" ha_opencode_beta/Dockerfile
grep -q "ARG HAB_VERSION=1.6.4" ha_opencode_beta/Dockerfile
grep -q "ARG ZIGPORTER_VERSION=1.4.2" ha_opencode_beta/Dockerfile
node --test "ha_opencode_beta/test/*.test.js"

git diff --quiet -- ha_opencode/ && echo "stable clean"
```
