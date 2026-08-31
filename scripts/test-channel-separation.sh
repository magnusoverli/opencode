#!/usr/bin/env bash
# shellcheck disable=SC2016 # Marker searches intentionally contain literal shell expressions.
# Functional test for the per-channel AGENTS.md deployment logic.
#
# Extracts the real AGENTS block out of init-opencode/run and channel.sh,
# rewrites the absolute container paths onto a sandbox, and runs it. This tests
# the shipped code paths rather than a re-implementation of them.

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
    local chan="${REPO}/${addon}/rootfs/usr/local/lib/opencode/channel.sh"

    local start end
    start=$(grep -n 'AGENTS_TARGET="\${ADDON_AGENTS_FILE}"' "$init" | cut -d: -f1)
    end=$(grep -n 'agents_md_hash "\${AGENTS_TARGET}" > "\${AGENTS_HASH_FILE}"' "$init" | cut -d: -f1)
    end=$((end + 1))

    {
        echo '#!/usr/bin/env bash'
        # Stubs for the pieces the block leans on but does not own.
        printf '%s\n' 'bashio::log.info() { printf "      log: %s\n" "$*"; }'
        printf '%s\n' 'bashio::log.warning() { printf "      warn: %s\n" "$*"; }'
        echo 'HELP_STAMP_FRESH=false'
        echo 'HAB_VERSION=1.6.4'
        echo 'ZIGPORTER_VERSION=0.1.0'
        echo "ADDON_CHANNEL=${channel}"
        # channel.sh, with container paths rewritten onto the sandbox.
        sed -e "s#/homeassistant#${sb}/homeassistant#g" \
            -e "s#/data#${sb}/data#g" "$chan"
        # The AGENTS block itself, same rewrite.
        sed -n "${start},${end}p" "$init" \
            | sed -e "s#/homeassistant#${sb}/homeassistant#g" \
                  -e "s#/data#${sb}/data#g" \
                  -e "s#/opt/ha-mcp-server#${sb}/opt/ha-mcp-server#g"
    } > "${sb}/runner.sh"
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

echo "=== per-channel AGENTS.md deployment ==="

scenario "stable fresh install" stable ha_opencode setup_fresh
check "deploys AGENTS.md into the configuration directory" \
    "$([ -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "writes its ownership marker beside it" \
    "$([ -f "$SB/homeassistant/.opencode_agents_md.sha256" ] && echo 0 || echo 1)"
check "does not create a private copy in /data" \
    "$([ ! -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"

scenario "beta fresh install" beta ha_opencode_beta setup_fresh
check "does NOT write into the configuration directory" \
    "$([ ! -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "deploys its own copy under /data" \
    "$([ -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"
check "keeps its marker private too" \
    "$([ -f "$SB/data/.agents_md_hash" ] && echo 0 || echo 1)"

scenario "beta upgrading from the old scheme" beta ha_opencode_beta setup_beta_upgrade
check "removes its own leftover from the configuration directory" \
    "$([ ! -f "$SB/homeassistant/AGENTS.md" ] && echo 0 || echo 1)"
check "still deploys its private copy" \
    "$([ -f "$SB/data/context/AGENTS.md" ] && echo 0 || echo 1)"

scenario "beta alongside stable" beta ha_opencode_beta setup_beta_with_stable
check "leaves the stable add-on's file untouched" \
    "$(grep -q '^# stable instructions' "$SB/homeassistant/AGENTS.md" 2>/dev/null && echo 0 || echo 1)"

scenario "beta where the user edited AGENTS.md" beta ha_opencode_beta setup_beta_user_edited
check "never deletes a file it did not write" \
    "$(grep -q 'my own rules' "$SB/homeassistant/AGENTS.md" 2>/dev/null && echo 0 || echo 1)"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
