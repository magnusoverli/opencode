#!/usr/bin/env bash
# =============================================================================
# OpenCode runtime helpers
#
# Shared by the init oneshot (init-opencode/run) and the in-image smoke test
# (opencode-smoke-test) so the "which runtime is certified / pick the right
# native binary / verify it runs" logic lives in exactly one place and the
# paths can never drift.
#
# Sourced, not executed. Callers may define opencode_log() before sourcing to
# route messages (e.g. through bashio); it defaults to plain stdout, which is
# captured in the add-on log.
# =============================================================================

if ! declare -F opencode_log >/dev/null 2>&1; then
    opencode_log() { printf '%s\n' "$*"; }
fi

# Where the image records the OpenCode version it was built and certified
# against. Written by the Dockerfile after it has verified that the resolved
# npm install really is that version, so reading it never needs the network and
# never depends on the package tree still being intact.
OPENCODE_CERTIFIED_VERSION_FILE="${OPENCODE_CERTIFIED_VERSION_FILE:-/usr/local/share/opencode-certified-version}"
OPENCODE_V2_CERTIFIED_VERSION_FILE="${OPENCODE_V2_CERTIFIED_VERSION_FILE:-/usr/local/share/opencode-v2-certified-version}"

# The certified version, falling back to the installed package's own metadata
# so an image built before the marker existed still reports something useful.
opencode_certified_version() {
    if [ -r "${OPENCODE_CERTIFIED_VERSION_FILE}" ]; then
        local recorded
        recorded=$(cat "${OPENCODE_CERTIFIED_VERSION_FILE}" 2>/dev/null)
        if [ -n "${recorded}" ]; then
            printf '%s\n' "${recorded}"
            return 0
        fi
    fi
    opencode_package_version "/usr/local/lib/node_modules/opencode-ai"
}

# The exact V2 beta integrated into this beta add-on. V2 lives in its own
# package and state roots; this helper does not fall back to the V1 marker.
opencode_v2_certified_version() {
    if [ -r "${OPENCODE_V2_CERTIFIED_VERSION_FILE}" ]; then
        local recorded
        recorded=$(cat "${OPENCODE_V2_CERTIFIED_VERSION_FILE}" 2>/dev/null)
        if [ -n "${recorded}" ]; then
            printf '%s\n' "${recorded}"
            return 0
        fi
    fi
    opencode_package_version "/opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli"
}

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

# Select the V2 package's native binary for the deployment CPU rather than the
# image-builder CPU. npm installs both x64 variants, but its postinstall picks
# one while the image is built; that choice is not safe to carry to another
# host with a different AVX2 capability.
opencode_select_v2_package_binary() {
    local package_root="$1"
    local mode="$2"
    local machine package_name source_binary
    local target_binary="${package_root}/node_modules/@opencode-ai/cli/bin/opencode2.exe"

    machine=$(uname -m)
    case "${machine}" in
        x86_64)
            if [ "${mode}" = "baseline" ]; then
                package_name="cli-linux-x64-baseline"
            else
                package_name="cli-linux-x64"
            fi
            ;;
        aarch64|arm64)
            package_name="cli-linux-arm64"
            mode="regular"
            ;;
        *)
            opencode_log "Unknown architecture ${machine}; leaving OpenCode V2 package binary unchanged"
            return 0
            ;;
    esac
    source_binary="${package_root}/node_modules/@opencode-ai/${package_name}/bin/opencode2"

    if [ ! -x "${source_binary}" ]; then
        opencode_log "OpenCode V2 ${mode} binary not found at ${source_binary}; V2 stays inactive"
        return 1
    fi

    rm -f "${target_binary}"
    if ! ln "${source_binary}" "${target_binary}" 2>/dev/null; then
        cp "${source_binary}" "${target_binary}"
    fi
    chmod +x "${target_binary}"
    opencode_log "OpenCode V2 package binary selected: ${mode} (${source_binary})"
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

# Execute the V2 readiness/version probe once, with no inherited V1 or
# credential-bearing environment. V2 may initialise state for even this simple
# command, so every writable root and the working directory are disposable.
opencode_v2_remove_probe() {
    local probe_root="$1"
    local work_root="$2"
    case "${probe_root}" in
        "${work_root}"/.runtime-probe.*) ;;
        *) return 1 ;;
    esac
    if [ -L "${probe_root}" ] || { [ -e "${probe_root}" ] && [ ! -d "${probe_root}" ]; }; then
        return 1
    fi
    rm -rf -- "${probe_root}"
}

opencode_v2_probe_version() {
    local bin="$1"
    local work_root="${2:-${OPENCODE_V2_WORK_ROOT:-/data/v2/work}}"
    local probe_root output status

    [ -n "${bin}" ] || return 1
    [ -x "${bin}" ] || return 1
    work_root="${work_root%/}"
    case "${work_root}" in
        /*) ;;
        *) return 1 ;;
    esac
    [ -d "${work_root}" ] || return 1
    [ ! -L "${work_root}" ] || return 1

    probe_root=$(mktemp -d "${work_root}/.runtime-probe.XXXXXXXX") || return 1
    case "${probe_root}" in
        "${work_root}"/.runtime-probe.*) ;;
        *) return 1 ;;
    esac
    if ! mkdir -p \
            "${probe_root}/home" \
            "${probe_root}/config" \
            "${probe_root}/data" \
            "${probe_root}/state" \
            "${probe_root}/cache" \
            "${probe_root}/tmp" \
            "${probe_root}/workspace" \
        || ! chmod 700 "${probe_root}" "${probe_root}"/*; then
        opencode_v2_remove_probe "${probe_root}" "${work_root}" || true
        return 1
    fi

    output=$(
        cd "${probe_root}/workspace" &&
        env -i \
            HOME="${probe_root}/home" \
            XDG_CONFIG_HOME="${probe_root}/config" \
            XDG_DATA_HOME="${probe_root}/data" \
            XDG_STATE_HOME="${probe_root}/state" \
            XDG_CACHE_HOME="${probe_root}/cache" \
            TMPDIR="${probe_root}/tmp" \
            PATH="/usr/local/bin:/usr/bin:/bin" \
            LANG="C.UTF-8" \
            USER="opencode-v2" \
            LOGNAME="opencode-v2" \
            OPENCODE_DISABLE_AUTOUPDATE="true" \
            OPENCODE_DISABLE_PROJECT_CONFIG="1" \
            OPENCODE_DISABLE_EXTERNAL_SKILLS="1" \
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS="1" \
            "${bin}" --version 2>/dev/null
    )
    status=$?

    opencode_v2_remove_probe "${probe_root}" "${work_root}" || return 1
    [ "${status}" -eq 0 ] || return 1
    output="${output%$'\r'}"
    [[ "${output}" != *$'\n'* ]] || return 1
    if [[ "${output}" =~ ^([[:alnum:]_.-]+[[:space:]]+)?v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
        printf '%s\n' "${BASH_REMATCH[2]}"
        return 0
    fi
    return 1
}
