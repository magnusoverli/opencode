#!/usr/bin/env bash
# =============================================================================
# Release-channel identity
#
# Both channels use OpenCode V2. Channel identity enters through ADDON_CHANNEL
# and is centralised here because
# both add-ons share the live /homeassistant workspace.
#
# Sourced, not executed.
#
# Why any of this exists: /data is a per-add-on volume and is already fully
# isolated, but /homeassistant is the live Home Assistant configuration
# directory and is mounted by BOTH add-ons. Anything the add-on writes there is
# shared, so each channel needs to know which parts are its own.
# =============================================================================

# The build arg reaches every process as an environment variable. The init
# oneshot also persists it, which is what interactive shells fall back to: ttyd
# sessions are spawned through a login shell and a stripped environment would
# otherwise silently label a beta terminal as stable.
if [ -z "${ADDON_CHANNEL:-}" ] && [ -r /data/.addon_channel ]; then
    ADDON_CHANNEL="$(cat /data/.addon_channel 2>/dev/null || true)"
fi

# Default to stable. A missing value must not silently make a stable image
# behave like beta — that failure puts beta's experimental notes into a stable
# user's context, which is the thing this whole split exists to prevent.
ADDON_CHANNEL="${ADDON_CHANNEL:-stable}"

case "${ADDON_CHANNEL}" in
    stable|beta) ;;
    *)
        echo "WARNING: unknown ADDON_CHANNEL '${ADDON_CHANNEL}' - treating as stable" >&2
        ADDON_CHANNEL="stable"
        ;;
esac

# -----------------------------------------------------------------------------
# Historical instruction ownership metadata
#
# Managed V2 loads its packaged global file from /run/opencode-v2/config/opencode.
# Both channels explicitly load user rules from /homeassistant/AGENTS.local.md.
# These legacy paths remain available to administrative scripts; they are not
# active instruction sources. Beta never modifies the shared stable AGENTS.md.
# -----------------------------------------------------------------------------

if [ "${ADDON_CHANNEL}" = "beta" ]; then
    # User-facing name; matches config.yaml's `name:` for this channel.
    ADDON_CHANNEL_LABEL="OpenCode Beta"
    # This channel's own corner of the configuration directory. Separate so a
    # note recorded while testing beta is not injected into every stable
    # session, and so uninstalling one channel cannot take the other's data.
    ADDON_STATE_DIR="/homeassistant/opencode_beta"
    # Retired beta copy; only exact app-owned bytes may be removed.
    ADDON_AGENTS_FILE="/data/context/AGENTS.md"
    ADDON_AGENTS_MARKER="/data/.agents_md_hash"
    ADDON_AGENTS_IN_CONFIG_DIR=false
else
    ADDON_CHANNEL_LABEL="OpenCode"
    ADDON_STATE_DIR="/homeassistant/opencode"
    ADDON_AGENTS_FILE="/homeassistant/AGENTS.md"
    # Beside the file it describes, not in /data. /data is wiped when the
    # add-on is reinstalled while the configuration directory is not, so a
    # marker in /data would make a reinstall look like a hand edit and leave a
    # spurious .bak behind.
    ADDON_AGENTS_MARKER="/homeassistant/.opencode_agents_md.sha256"
    ADDON_AGENTS_IN_CONFIG_DIR=true
fi

export ADDON_CHANNEL ADDON_CHANNEL_LABEL ADDON_STATE_DIR
export ADDON_AGENTS_FILE ADDON_AGENTS_MARKER ADDON_AGENTS_IN_CONFIG_DIR
