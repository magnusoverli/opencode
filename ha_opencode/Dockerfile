# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:trixie
ARG BUILD_ARCH

## Stage 1: Build hab CLI from source (main branch)
FROM golang:1.24-trixie AS hab-builder

ARG BUILD_ARCH
RUN git clone --depth 1 https://github.com/balloob/home-assistant-build-cli.git /src
WORKDIR /src

# Cross-compile for the target architecture
RUN GOARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /hab .

## Stage 2: Main add-on image
FROM $BUILD_FROM

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
ARG TTYD_VERSION=1.7.7
ARG OPENCODE_VERSION=latest

# Environment for better Node.js performance
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Install system dependencies in a single layer
# - nodejs/npm: Required for OpenCode
# - git: Required by OpenCode for version control operations
# - jq: JSON processing for helper scripts
# - curl/ca-certificates: For downloading ttyd
# - procps: Provides pgrep for health check
# - tmux: Session persistence to prevent multiple OpenCode instances
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        nodejs \
        npm \
        procps \
        tmux \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd from GitHub releases (not in Debian repos)
RUN ARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64") \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ARCH}" -o /usr/bin/ttyd \
    && chmod +x /usr/bin/ttyd

# Copy hab CLI binary built from source (main branch)
# A CLI designed for AI agents to manage HA via REST/WebSocket APIs
COPY --from=hab-builder /hab /usr/local/bin/hab

# Install OpenCode and Prettier globally
# - OpenCode: AI coding agent (pin version in build.yaml for reproducible builds)
# - Prettier: Code formatter for YAML files, configured for HA conventions
RUN npm install -g opencode-ai@${OPENCODE_VERSION} prettier \
    && npm cache clean --force

# Copy package.json files first for better layer caching
# Changes to server code won't invalidate npm install cache
COPY rootfs/opt/ha-mcp-server/package*.json /opt/ha-mcp-server/
COPY rootfs/opt/ha-lsp-server/package*.json /opt/ha-lsp-server/

# Install MCP and LSP dependencies in parallel
RUN (cd /opt/ha-mcp-server && npm install --omit=dev) & \
    (cd /opt/ha-lsp-server && npm install --omit=dev) & \
    wait && npm cache clean --force

# Copy root filesystem (server code, scripts, etc.)
COPY rootfs /

# Make scripts executable and create runtime directories
RUN chmod +x /usr/local/bin/* \
    && chmod +x /etc/s6-overlay/s6-rc.d/init-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode/run \
    && chmod +x /etc/profile.d/hab-esphome.sh \
    && mkdir -p /data/.local/share/opencode /data/.config/opencode

# Set working directory to HA config (mounted at runtime)
WORKDIR /homeassistant

# Health check - verify ttyd is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep ttyd > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="OpenCode" \
    io.hass.description="AI coding agent for editing Home Assistant configuration" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"
