#!/usr/bin/env bash
# Same channel contract checks locally and on GitHub's Linux runners.
set -euo pipefail
cd "$(dirname "$0")/.."
channel="${1:-beta}"
case "$channel" in
  beta) addon=ha_opencode_beta ;;
  stable) addon=ha_opencode ;;
  *) echo "Usage: bash scripts/ci-checks.sh beta|stable [contracts|image]" >&2; exit 2 ;;
esac
case "${2:-contracts}" in
  image)
    arch="$(uname -m)"
    case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=aarch64 ;; *) exit 2 ;; esac
    exec docker build --target boundary-test --progress=plain \
      --build-arg "BUILD_ARCH=$arch" --build-arg "ADDON_CHANNEL=$channel" "$addon"
    ;;
  contracts) ;;
  *) exit 2 ;;
esac
export HA_NATIVE_TESTS_REQUIRED=1
export HA_ASSIST_BROWSER_EXECUTABLE="${HA_ASSIST_BROWSER_EXECUTABLE:-/usr/bin/google-chrome}"
export HA_EDITOR_TEST_DEPS
HA_EDITOR_TEST_DEPS="$(mktemp -d)"
trap 'rm -rf "$HA_EDITOR_TEST_DEPS"' EXIT
npm ci --include=dev --prefix "$addon/rootfs/opt/opencode-v2-homeassistant" --no-audit --no-fund
npm run verify:versions --prefix "$addon/rootfs/opt/opencode-v2-homeassistant"
npm install --ignore-scripts --prefix "$addon/rootfs/opt/ha-mcp-server" --no-audit --no-fund
npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund \
  --prefix "$addon/rootfs/opt/ppq-private-runtime"
for component in opencode-v2-homeassistant ha-mcp-server ppq-private-runtime; do
  npm audit --omit=dev --audit-level=low --prefix "$addon/rootfs/opt/$component"
done
npm install --prefix "$HA_EDITOR_TEST_DEPS" --ignore-scripts --no-audit --no-fund \
  @codemirror/autocomplete@6.20.3 @codemirror/lint@6.9.7 \
  @codemirror/state@6.7.1 @codemirror/view@6.43.9 \
  typescript@5.9.3 jsdom@26.1.0 express@5.2.1
cp "$addon/rootfs/opt/openchamber/editor-lsp/"editor* "$HA_EDITOR_TEST_DEPS/"
"$HA_EDITOR_TEST_DEPS/node_modules/.bin/tsc" --noEmit --strict --module esnext \
  --moduleResolution bundler --target ES2022 --lib ES2022,DOM "$HA_EDITOR_TEST_DEPS/editor.ts"
node --test "$addon/test/"*.test.js
if [ "$channel" = stable ]; then
  HA_DEPENDENCY_TEST_ADDON=ha_opencode node --test ha_opencode_beta/test/opencode-v2-dependency-security.test.js
fi
root=()
if [ "$(id -u)" -ne 0 ]; then root=(sudo); fi
for suite in external-mcp mcp-startup tui-state provider-environment; do
  "${root[@]}" env HA_NATIVE_TESTS_REQUIRED=1 "$(command -v node)" --test \
    "$addon/test/opencode-v2-$suite.test.js"
done
bash scripts/check-addon-options.sh "$addon"
bash scripts/test-startup-hooks.sh "$channel"
