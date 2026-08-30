#!/usr/bin/env bash
# =============================================================================
# Release-channel identity
#
# Stable remains on OpenCode V1 while this beta tree integrates V2. Channel
# identity still enters through ADDON_CHANNEL and is centralised here because
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
# Where this channel's instruction file goes
#
# Only ONE file in the configuration directory can be called AGENTS.md, and
# OpenCode finds it by convention from the working directory rather than from
# anything we configure. Both channels deploying it therefore means the add-on
# that started most recently owns it — and the two copies are not
# interchangeable. Beta's documents capabilities that only beta's build ships
# (`call_service` returning service response data, for one), so a stable
# session reading beta's copy is told to use a tool it does not have.
#
# The rule is: stable owns /homeassistant/AGENTS.md. Beta keeps its own copy
# inside its private /data and has OpenCode load it through `instructions`, so
# it never writes to the configuration directory at all.
#
# That leaves the leak asymmetric in the only direction that is harmless. A
# stable session now only ever reads stable's instructions. A beta session
# additionally picks up stable's file through the working directory when both
# add-ons are installed, which under-describes beta rather than mis-describing
# it.
# -----------------------------------------------------------------------------

if [ "${ADDON_CHANNEL}" = "beta" ]; then
    # User-facing name; matches config.yaml's `name:` for this channel.
    ADDON_CHANNEL_LABEL="OpenCode Beta"
    # This channel's own corner of the configuration directory. Separate so a
    # note recorded while testing beta is not injected into every stable
    # session, and so uninstalling one channel cannot take the other's data.
    ADDON_STATE_DIR="/homeassistant/opencode_beta"
    # Private to this add-on, and listed in OpenCode's `instructions` because
    # nothing outside the working directory is discovered automatically.
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
