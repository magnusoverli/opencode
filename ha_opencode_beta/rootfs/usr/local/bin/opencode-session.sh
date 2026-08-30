#!/usr/bin/env bash
# =============================================================================
# OpenCode Session - Wrapper script that runs inside ttyd
# =============================================================================

# Which channel this is, so the banner says OpenCode or OpenCode Beta rather
# than leaving the user guessing which add-on the terminal belongs to.
# shellcheck source=/usr/local/lib/opencode/channel.sh
source /usr/local/lib/opencode/channel.sh

# Set up home directory for persistent storage
export HOME="/data"
export XDG_DATA_HOME="/data/.local/share"
export XDG_CONFIG_HOME="/data/.config"

# Load user-defined environment variables (written by init-opencode)
if [ -f /data/.env_vars ]; then
    source /data/.env_vars
fi

# Load discovered service variables (written by background discovery)
if [ -f /data/.env_vars_discovered ]; then
    source /data/.env_vars_discovered
fi

# Ensure SUPERVISOR_TOKEN is available for MCP server
# This is auto-injected by Home Assistant Supervisor
if [ -z "$SUPERVISOR_TOKEN" ]; then
    echo "Warning: SUPERVISOR_TOKEN not set. MCP integration may not work."
else
    # zigporter uses HA_TOKEN; derive it from the live Supervisor token without
    # persisting the token in /data/.env_vars.
    export HA_TOKEN="${SUPERVISOR_TOKEN}"
fi


# Ensure directories exist
mkdir -p "${HOME}/.local/share/opencode"
mkdir -p "${HOME}/.config/opencode"

# OpenCode/Bun may need to mmap native TUI files as executable. Use an app-owned
# temp directory instead of relying on /tmp mount flags.
export TMPDIR="${TMPDIR:-/data/.cache/opencode-tmp}"
mkdir -p "${TMPDIR}"
chmod 700 "${TMPDIR}" 2>/dev/null || true

# KDE Breeze-style colors
BLUE='\033[38;2;29;153;243m'
GREEN='\033[38;2;17;209;22m'
YELLOW='\033[38;2;246;116;0m'
CYAN='\033[38;2;26;188;156m'
WHITE='\033[38;2;252;252;252m'
GRAY='\033[38;2;127;140;141m'
BOLD='\033[1m'
NC='\033[0m'

# Read addon version and CPU mode written by init-opencode
CPU_MODE=$(cat /data/.cpu_mode 2>/dev/null || echo "unknown")
ADDON_VERSION=$(cat /data/.addon_version 2>/dev/null || echo "unknown")
ADDON_ACCESS_ENABLED=$(cat /data/.addon_access_enabled 2>/dev/null || echo "false")
USER_HOOKS_ENABLED=$(cat /data/.user_hooks_enabled 2>/dev/null || echo "false")
OPENCODE_VERSION=$(cat /data/.opencode_version 2>/dev/null || opencode --version 2>/dev/null || echo "unknown")
OPENCODE_V2_VERSION=$(cat /usr/local/share/opencode-v2-certified-version 2>/dev/null || echo "unknown")
if [ -f /run/opencode-v2/ready ]; then
    OPENCODE_V2_STATUS="staged privately"
else
    OPENCODE_V2_STATUS="inactive"
fi
CPU_INFO=""
if [ "${CPU_MODE}" = "baseline" ]; then
    CPU_INFO=" ${YELLOW}(baseline CPU mode)${NC}"
fi

# Refresh the decision-notes digest before the terminal session starts.
#
# The digest is otherwise only built at add-on start, but decisions.yaml belongs
# to the user and can be edited or deleted at any time. This catches those edits
# whenever the terminal session is created — note that ttyd runs this through
# `tmux new-session -A`, so reconnecting to a running session reattaches instead
# of re-running it; `ha-context refresh` is the way to apply an edit mid-session.
# Offline and file-local, so it costs milliseconds and cannot block start-up.
if [ -x /usr/local/bin/generate-home-context.mjs ] || [ -f /usr/local/bin/generate-home-context.mjs ]; then
    HOME_CONTEXT_ONLY=digest \
    OPENCODE_DECISION_NOTES="${OPENCODE_DECISION_NOTES:-true}" \
        node /usr/local/bin/generate-home-context.mjs >/dev/null 2>&1 || true
fi

# Change to Home Assistant config directory
cd /homeassistant

# Set up PATH. Only the certified runtime shipped in this image is on it:
# /data/.npm-global may still hold an OpenCode installed by an older version of
# the add-on, and it must never shadow the build this release was tested with.
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/data/.npm-global}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export OPENCODE_DISABLE_AUTOUPDATE=true

# Configure git if not already configured
if [ ! -f "${HOME}/.gitconfig" ]; then
    git config --global init.defaultBranch main 2>/dev/null || true
    git config --global safe.directory /homeassistant 2>/dev/null || true
fi

# Function to show welcome banner
show_banner() {
    clear
    echo ""
    echo -e "${BLUE}${BOLD}${ADDON_CHANNEL_LABEL}${NC} ${GRAY}v${ADDON_VERSION}${NC}${CPU_INFO}"
    echo -e "${GRAY}Current TUI: OpenCode V1 ${OPENCODE_VERSION}${NC}"
    echo -e "${GRAY}OpenCode V2: ${OPENCODE_V2_VERSION} (${OPENCODE_V2_STATUS}; this TUI is not attached yet)${NC}"
    echo -e "${GRAY}AI-powered coding agent for Home Assistant${NC}"
    echo ""
    echo -e "${GRAY}────────────────────────────────────────────────────────────${NC}"
    echo ""
}

# Function to show shell help (after exiting opencode)
show_shell_help() {
    echo ""
    echo -e "${GRAY}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "${WHITE}Dropped to shell.${NC} Working directory: ${CYAN}/homeassistant${NC}"
    echo ""
    echo -e "${BOLD}Commands${NC}"
    echo -e "  ${GREEN}opencode${NC}          Restart the AI coding agent"
    echo -e "  ${GREEN}ha-readonly${NC}       Investigate without changing anything (read-only session)"
    echo -e "  ${GREEN}ha-logs${NC} ${GRAY}<type>${NC}    View logs (core, error, supervisor, host)"
    echo -e "  ${GREEN}ha-mcp${NC} ${GRAY}<cmd>${NC}     MCP integration (enable, disable, status)"
    echo -e "  ${GREEN}ha-agent-eval${NC} ${GRAY}[args]${NC}  Run synthetic model tool-selection checks"
    echo -e "  ${GREEN}ha-context${NC} ${GRAY}<cmd>${NC} What OpenCode knows about your setup (show, refresh, reset)"
    echo -e "  ${GREEN}hab${NC} ${GRAY}<cmd>${NC}         HA admin CLI (entities, areas, dashboards, backups)"
    echo -e "  ${GREEN}zigporter${NC} ${GRAY}<cmd>${NC}   Zigbee tools (rename, inspect, stale, mesh)"
    if [ "${USER_HOOKS_ENABLED}" = "true" ]; then
        echo -e "  ${GREEN}ha-hooks${NC} ${GRAY}<cmd>${NC}   Your startup hooks (list, run, log)"
    fi
    echo ""
}

# Show initial banner
show_banner

echo -e "${WHITE}Working directory:${NC} ${CYAN}/homeassistant${NC}"
if [ "${ADDON_ACCESS_ENABLED}" = "true" ]; then
    echo -e "${WHITE}Add-on development:${NC} ${CYAN}/addons${NC} ${GRAY}and${NC} ${CYAN}/addon_configs${NC} ${YELLOW}(sensitive)${NC}"
fi
echo -e "${GRAY}First time? Use ${NC}${GREEN}/connect${NC} ${GRAY}inside OpenCode to add your AI provider${NC}"
echo -e "${GRAY}Only want to look? Exit and run ${NC}${GREEN}ha-readonly${NC} ${GRAY}— it cannot change anything${NC}"
echo -e "${GRAY}Add your own instructions in ${NC}${GREEN}AGENTS.local.md${NC} ${GRAY}— add-on updates never overwrite it${NC}"
if [ "${USER_HOOKS_ENABLED}" = "true" ]; then
    echo -e "${GRAY}Startup hooks are on — ${NC}${GREEN}ha-hooks list${NC} ${GRAY}shows what runs at start${NC}"
fi
echo -e "${GRAY}Copy: select text (auto-copies) · Paste: ${NC}${GREEN}Ctrl+V${NC}${GRAY} or right-click${NC}"
echo ""

# Launch OpenCode
opencode

# When opencode exits, show help and drop to bash
show_shell_help

# Start interactive bash shell
exec bash --login
