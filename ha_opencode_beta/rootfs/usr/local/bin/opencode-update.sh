#!/usr/bin/env bash
# =============================================================================
# OpenCode - Background runtime updater
#
# Launched detached from the init oneshot (only when opencode_update_policy is
# "latest" and there is memory headroom) so a slow or failing
# `npm install -g opencode-ai@latest` can never gate the ingress health check
# or OOM the container during start-up.
#
# The freshly installed runtime becomes active for the *next* OpenCode session
# (sessions resolve `opencode` from PATH, which prefers /data/.npm-global/bin).
# A broken install is discarded so sessions keep using the known-good bundled
# binary rather than a launcher whose native target is missing.
# =============================================================================
set -u

export HOME="/data"
export XDG_DATA_HOME="/data/.local/share"
export XDG_CONFIG_HOME="/data/.config"
export NPM_CONFIG_PREFIX="/data/.npm-global"
export TMPDIR="/data/.cache/opencode-tmp"
export PATH="${NPM_CONFIG_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

opencode_log() { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
# shellcheck source=/usr/local/lib/opencode/runtime.sh
source /usr/local/lib/opencode/runtime.sh

runtime_package="${NPM_CONFIG_PREFIX}/lib/node_modules/opencode-ai"
persistent_bin="${NPM_CONFIG_PREFIX}/bin/opencode"
cpu_mode="$(cat /data/.cpu_mode 2>/dev/null || echo regular)"

# Single-flight: never let two updates (e.g. after a restart) run concurrent
# npm installs on a memory-constrained host. A dead PID in the lock is ignored,
# so a killed updater never blocks future runs.
LOCK="/data/.opencode-update.pid"
if [ -f "${LOCK}" ] && kill -0 "$(cat "${LOCK}" 2>/dev/null)" 2>/dev/null; then
    opencode_log "Another OpenCode update is already running; exiting"
    exit 0
fi
echo $$ > "${LOCK}"
trap 'rm -f "${LOCK}"' EXIT

opencode_log "Starting background OpenCode update: npm install -g opencode-ai@latest"
if timeout 300 npm install -g opencode-ai@latest --loglevel=error; then
    opencode_select_package_binary "${runtime_package}" "${cpu_mode}" || true
    if opencode_bin_runs "${persistent_bin}"; then
        version="$("${persistent_bin}" --version 2>/dev/null || echo unknown)"
        printf '%s\n' "${version}" > /data/.opencode_version
        opencode_log "Background update complete: OpenCode ${version} is active for new sessions"
    else
        opencode_log "Updated runtime does not execute; removing it so sessions keep the bundled binary"
        rm -rf "${runtime_package}" "${persistent_bin}"
    fi
else
    opencode_log "Background update failed or timed out after 300s; keeping the current runtime"
fi
