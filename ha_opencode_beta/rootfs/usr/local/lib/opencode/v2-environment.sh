#!/usr/bin/env bash
# Isolated OpenCode V2 roots. V1 keeps its historical /data/.config and
# /data/.local paths untouched so migration can operate on private copies and a
# V1 beta image can still roll back safely.

OPENCODE_V2_ROOT="${OPENCODE_V2_ROOT:-/data/v2}"
OPENCODE_V2_GENERATIONS_ROOT="${OPENCODE_V2_ROOT}/generations"
OPENCODE_V2_CURRENT_FILE="${OPENCODE_V2_ROOT}/current"
OPENCODE_V2_CACHE_HOME="${OPENCODE_V2_CACHE_HOME:-${OPENCODE_V2_ROOT}/cache}"
OPENCODE_V2_WORK_ROOT="${OPENCODE_V2_WORK_ROOT:-${OPENCODE_V2_ROOT}/work}"

opencode_v2_require_directory() {
    local path="$1"
    if [ -L "${path}" ] || { [ -e "${path}" ] && [ ! -d "${path}" ]; }; then
        printf 'Unsafe OpenCode V2 directory: %s\n' "${path}" >&2
        return 1
    fi
    mkdir -p -- "${path}"
    if [ -L "${path}" ] || [ ! -d "${path}" ]; then
        printf 'Unsafe OpenCode V2 directory after creation: %s\n' "${path}" >&2
        return 1
    fi
}

opencode_v2_prepare_directories() {
    local old_umask status=0
    old_umask=$(umask)
    umask 077
    for path in \
        "${OPENCODE_V2_ROOT}" \
        "${OPENCODE_V2_GENERATIONS_ROOT}" \
        "${OPENCODE_V2_CACHE_HOME}" \
        "${OPENCODE_V2_CACHE_HOME}/opencode" \
        "${OPENCODE_V2_WORK_ROOT}"; do
        if ! opencode_v2_require_directory "${path}"; then
            status=1
            break
        fi
    done
    if [ "${status}" -eq 0 ] && ! chmod 700 \
            "${OPENCODE_V2_ROOT}" \
            "${OPENCODE_V2_GENERATIONS_ROOT}" \
            "${OPENCODE_V2_CACHE_HOME}" \
            "${OPENCODE_V2_WORK_ROOT}"; then
        status=1
    fi
    umask "${old_umask}"
    return "${status}"
}

opencode_v2_select_generation() {
    local generation
    [ -f "${OPENCODE_V2_CURRENT_FILE}" ] || return 1
    [ ! -L "${OPENCODE_V2_CURRENT_FILE}" ] || return 1
    [ "$(stat -c '%h' "${OPENCODE_V2_CURRENT_FILE}" 2>/dev/null)" = "1" ] || return 1
    generation=$(tr -d '\r\n' < "${OPENCODE_V2_CURRENT_FILE}")
    [[ "${generation}" =~ ^[a-f0-9]{32}$ ]] || return 1
    OPENCODE_V2_GENERATION_ROOT="${OPENCODE_V2_GENERATIONS_ROOT}/${generation}"
    [ -d "${OPENCODE_V2_GENERATION_ROOT}" ] || return 1
    [ ! -L "${OPENCODE_V2_GENERATION_ROOT}" ] || return 1
    OPENCODE_V2_HOME="${OPENCODE_V2_GENERATION_ROOT}/home"
    OPENCODE_V2_CONFIG_HOME="${OPENCODE_V2_GENERATION_ROOT}/config"
    OPENCODE_V2_DATA_HOME="${OPENCODE_V2_GENERATION_ROOT}/data"
    OPENCODE_V2_STATE_HOME="${OPENCODE_V2_GENERATION_ROOT}/state"
    for path in \
        "${OPENCODE_V2_HOME}" \
        "${OPENCODE_V2_CONFIG_HOME}" \
        "${OPENCODE_V2_DATA_HOME}" \
        "${OPENCODE_V2_STATE_HOME}"; do
        [ -d "${path}" ] || return 1
        [ ! -L "${path}" ] || return 1
    done
}

opencode_v2_export_environment() {
    opencode_v2_select_generation || return 1
    export HOME="${OPENCODE_V2_HOME}"
    export XDG_CONFIG_HOME="${OPENCODE_V2_CONFIG_HOME}"
    export XDG_DATA_HOME="${OPENCODE_V2_DATA_HOME}"
    export XDG_STATE_HOME="${OPENCODE_V2_STATE_HOME}"
    export XDG_CACHE_HOME="${OPENCODE_V2_CACHE_HOME}"
}
