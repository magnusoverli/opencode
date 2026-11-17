#!/usr/bin/env bash
# shellcheck disable=SC2016 # Marker searches intentionally contain literal shell expressions.
# Functional test for per-channel historical instruction preservation.
#
# Exercises the shipped retirement helper in a sandbox. Both channels use a
# packaged global instruction source rather than deploying shared AGENTS.md.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/opencode-channel-test"
PASS=0
FAIL=0

check() { # description, condition-result
    if [ "$2" = "0" ]; then printf '    PASS  %s\n' "$1"; PASS=$((PASS+1))
    else printf '    FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); fi
}

build_runner() { # channel, addon_dir -> writes $SB/runner.sh
    local channel="$1" addon="$2" sb="$3"
    local init="${REPO}/${addon}/rootfs/etc/s6-overlay/s6-rc.d/init-opencode/run"
    # Check the wiring as well as running the exact helper implementation.
    grep -q 'node /usr/local/bin/retire-opencode-instructions.mjs' "$init" || exit 1
    if grep -q 'AGENTS_TARGET=' "$init"; then
        echo "Unexpected shared instruction deployment in $addon" >&2
        exit 1
    fi
    printf 'node --input-type=module -e '\''import {pathToFileURL} from "node:url"; const {retireInstructions}=await import(pathToFileURL(process.argv[1])); await retireInstructions(process.argv[2]);'\'' "%s" "%s"\n' \
        "${REPO}/${addon}/rootfs/usr/local/bin/retire-opencode-instructions.mjs" "${sb}/data" > "${sb}/runner.sh"
}

scenario() { # name, channel, addon_dir, setup_fn
    local name="$1" channel="$2" addon="$3" setup="$4"
    local sb
    sb="${WORK}/$(echo "$name" | tr ' /' '__')"
    rm -rf "$sb"; mkdir -p "$sb/homeassistant" "$sb/data" "$sb/opt/ha-mcp-server"

    # The in-image instruction file this channel would deploy.
    printf '# %s instructions\n<!-- HAB_LIVE_HELP_START -->\n<!-- HAB_LIVE_HELP_END -->\n' \
        "$channel" > "$sb/opt/ha-mcp-server/AGENTS.md"

    printf '\n  %s (%s)\n' "$name" "$channel"
    "$setup" "$sb"
    build_runner "$channel" "$addon" "$sb"
    bash "${sb}/runner.sh" >/dev/null 2>&1
    SB="$sb"
}

# --- scenarios ---------------------------------------------------------------

setup_fresh() { :; }

setup_beta_upgrade() { # beta already deployed to the config dir under the old scheme
    local sb="$1"
    printf '# beta instructions (old)\n' > "$sb/homeassistant/AGENTS.md"
    sha256sum "$sb/homeassistant/AGENTS.md" | cut -d' ' -f1 > "$sb/data/.agents_md_hash"
}

setup_beta_with_stable() { # stable owns the file; beta's legacy marker does not match
    local sb="$1"
    printf '# stable instructions\n' > "$sb/homeassistant/AGENTS.md"
    printf 'a_hash_from_when_beta_last_wrote_something_else\n' > "$sb/data/.agents_md_hash"
}

setup_beta_user_edited() {
    local sb="$1"
    printf '# beta instructions\n# ...and my own rules\n' > "$sb/homeassistant/AGENTS.md"
    printf 'stale_hash_not_matching\n' > "$sb/data/.agents_md_hash"
}

echo "=== per-channel instruction preservation ==="

scenario "stable fresh install" stable ha_opencode setup_fresh
check "does not deploy a redundant shared instruction copy" \
    "$([ ! -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "does not create a redundant shared ownership marker" \
    "$([ ! -f "$SB/homeassistant/.opencode_agents_md.sha256" ] && echo 0 || echo 1)"
check "does not create a private copy in /data" \
    "$([ ! -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"

scenario "beta fresh install" beta ha_opencode_beta setup_fresh
check "does NOT write into the configuration directory" \
    "$([ ! -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "does not create an unused private instruction copy" \
    "$([ ! -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"
check "does not create a redundant ownership marker" \
    "$([ ! -f "$SB/data/.agents_md_hash" ] && echo 0 || echo 1)"

scenario "beta upgrading from the old scheme" beta ha_opencode_beta setup_beta_upgrade
check "preserves shared historical instructions for operator review" \
    "$([ -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "does not recreate a retired private copy" \
    "$([ ! -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"

scenario "beta alongside stable" beta ha_opencode_beta setup_beta_with_stable
check "leaves the stable add-on's file untouched" \
    "$(grep -q '^# stable instructions' "$SB/homeassistant/AGENTS.md" 2>/dev/null && echo 0 || echo 1)"

scenario "beta where the user edited AGENTS.md" beta ha_opencode_beta setup_beta_user_edited
check "never deletes a file it did not write" \
    "$(grep -q 'my own rules' "$SB/homeassistant/AGENTS.md" 2>/dev/null && echo 0 || echo 1)"

scenario "stable upgrading with historical instructions" stable ha_opencode setup_beta_user_edited
check "preserves customized shared instructions on stable upgrade" \
    "$(grep -q 'my own rules' "$SB/homeassistant/AGENTS.md" 2>/dev/null && echo 0 || echo 1)"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
