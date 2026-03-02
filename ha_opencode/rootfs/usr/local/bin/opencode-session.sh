#!/usr/bin/env bash
# =============================================================================
# OpenCode Session - Wrapper script that runs inside ttyd
# =============================================================================

# Set up home directory for persistent storage
export HOME="/data"
export XDG_DATA_HOME="/data/.local/share"
export XDG_CONFIG_HOME="/data/.config"

# Load user-defined environment variables (written by init-opencode)
if [ -f /data/.env_vars ]; then
    source /data/.env_vars
fi

# Ensure SUPERVISOR_TOKEN is available for MCP server
# This is auto-injected by Home Assistant Supervisor
if [ -z "$SUPERVISOR_TOKEN" ]; then
    echo "Warning: SUPERVISOR_TOKEN not set. MCP integration may not work."
fi

# Ensure directories exist
mkdir -p "${HOME}/.local/share/opencode"
mkdir -p "${HOME}/.config/opencode"

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
CPU_INFO=""
if [ "${CPU_MODE}" = "baseline" ]; then
    CPU_INFO=" ${YELLOW}(baseline CPU mode)${NC}"
    case $(uname -m) in
        x86_64)
            export OPENCODE_BIN_PATH="/usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode"
            ;;
        aarch64|arm64)
            if [ -x "/usr/local/lib/node_modules/opencode-linux-arm64-baseline/bin/opencode" ]; then
                export OPENCODE_BIN_PATH="/usr/local/lib/node_modules/opencode-linux-arm64-baseline/bin/opencode"
            else
                export OPENCODE_BIN_PATH="/usr/local/lib/node_modules/opencode-ai/bin/opencode"
            fi
            ;;
    esac
fi

# Change to Home Assistant config directory
cd /homeassistant

# Set up PATH - ensure node, npm globals, and standard bins are available
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Configure git if not already configured
if [ ! -f "${HOME}/.gitconfig" ]; then
    git config --global init.defaultBranch main 2>/dev/null || true
    git config --global safe.directory /homeassistant 2>/dev/null || true
fi

# Function to show welcome banner
show_banner() {
    clear
    echo ""
    echo -e "${BLUE}${BOLD}OpenCode${NC} ${GRAY}v${ADDON_VERSION}${NC}${CPU_INFO}"
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
    echo -e "  ${GREEN}ha-logs${NC} ${GRAY}<type>${NC}    View logs (core, error, supervisor, host)"
    echo -e "  ${GREEN}ha-mcp${NC} ${GRAY}<cmd>${NC}     MCP integration (enable, disable, status)"
    echo -e "  ${GREEN}hab${NC} ${GRAY}<cmd>${NC}         HA admin CLI (entities, areas, dashboards, backups)"
    echo ""
}

# Show initial banner
show_banner

echo -e "${WHITE}Working directory:${NC} ${CYAN}/homeassistant${NC}"
echo -e "${GRAY}First time? Use ${NC}${GREEN}/connect${NC} ${GRAY}inside OpenCode to add your AI provider${NC}"
echo -e "${GRAY}Customize AI behavior by editing ${NC}${GREEN}AGENTS.md${NC} ${GRAY}in your config folder${NC}"
echo ""

# Launch OpenCode
opencode

# When opencode exits, show help and drop to bash
show_shell_help

# Start interactive bash shell
exec bash --login
