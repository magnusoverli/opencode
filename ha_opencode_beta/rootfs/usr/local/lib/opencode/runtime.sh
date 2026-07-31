#!/usr/bin/env bash
# =============================================================================
# OpenCode runtime helpers
#
# Shared by the init oneshot (init-opencode/run) and the background updater
# (opencode-update.sh) so the "pick the right native binary / verify it runs"
# logic lives in exactly one place and the two paths can never drift.
#
# Sourced, not executed. Callers may define opencode_log() before sourcing to
# route messages (e.g. through bashio); it defaults to plain stdout, which is
# captured in the add-on log.
# =============================================================================

if ! declare -F opencode_log >/dev/null 2>&1; then
    opencode_log() { printf '%s\n' "$*"; }
fi

# Print the version recorded in a package's package.json, or a sentinel
# ("not-installed" / "unknown") when it cannot be read.
opencode_package_version() {
    local package_dir="$1"
    if [ -f "${package_dir}/package.json" ]; then
        node -e "console.log(require('${package_dir}/package.json').version)" 2>/dev/null || echo "unknown"
    else
        echo "not-installed"
    fi
}

# Link the architecture-appropriate native binary into the package launcher
# target (bin/opencode.exe). Returns non-zero and leaves the package untouched
# if the expected native binary is absent (e.g. an optional dependency that
# npm skipped), so callers can fall back instead of exposing a broken launcher.
opencode_select_package_binary() {
    local package_dir="$1"
    local mode="$2"
    local machine source_binary
    local target_binary="${package_dir}/bin/opencode.exe"

    machine=$(uname -m)

    case "${machine}" in
        x86_64)
            if [ "${mode}" = "baseline" ]; then
                source_binary="${package_dir}/node_modules/opencode-linux-x64-baseline/bin/opencode"
            else
                source_binary="${package_dir}/node_modules/opencode-linux-x64/bin/opencode"
            fi
            ;;
        aarch64|arm64)
            source_binary="${package_dir}/node_modules/opencode-linux-arm64/bin/opencode"
            mode="regular"
            ;;
        *)
            opencode_log "Unknown architecture ${machine}; leaving OpenCode package binary unchanged"
            return 0
            ;;
    esac

    if [ ! -x "${source_binary}" ]; then
        opencode_log "OpenCode ${mode} binary not found at ${source_binary}; leaving package binary unchanged"
        return 1
    fi

    mkdir -p "$(dirname "${target_binary}")"
    rm -f "${target_binary}"
    if ! ln "${source_binary}" "${target_binary}" 2>/dev/null; then
        cp "${source_binary}" "${target_binary}"
    fi
    chmod +x "${target_binary}"
    opencode_log "OpenCode package binary selected: ${mode} (${source_binary})"
}

# Verify that an opencode launcher actually executes. This catches the
# half-installed case where the launcher (npm bin symlink) is present but its
# native target is missing — the "cannot execute: required file not found"
# failure users hit when a boot-time install was killed mid-way. A missing
# symlink target makes `[ -x ]` false, so no doomed exec is attempted.
opencode_bin_runs() {
    local bin="$1"
    [ -n "${bin}" ] || return 1
    [ -x "${bin}" ] || return 1
    "${bin}" --version >/dev/null 2>&1
}
