# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG NODE_VERSION=24.15.0

# Home Assistant does not publish a Node-specific Debian base. Keep its s6 and
# Bashio runtime as the final base, and copy an exact official Node toolchain in.
FROM node:${NODE_VERSION}-trixie-slim AS node-runtime

## Build hab CLI from source (pinned release)
# Pinned to the build host's platform — Go cross-compiles via GOARCH below,
# so this stage never needs to run under emulation
FROM --platform=$BUILDPLATFORM golang:1.24-trixie AS hab-builder

ARG BUILD_ARCH
ARG HAB_VERSION=1.6.4
RUN git clone --depth 1 --branch "${HAB_VERSION}" https://github.com/balloob/home-assistant-build-cli.git /src
WORKDIR /src

# Cross-compile for the target architecture
RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac \
    && GOARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /hab .

## Stage 2: Main add-on image
FROM $BUILD_FROM AS runtime

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
ARG NODE_VERSION
# Release-channel identity for paths shared through /homeassistant. Stable and
# beta now contain different OpenCode generations, but still use this one value
# rather than scattering channel-specific paths through the image.
ARG ADDON_CHANNEL=stable
ARG TTYD_VERSION=1.7.7
# Certified OpenCode runtime. This is a hard pin, never a range or a dist-tag:
# the add-on ships exactly one OpenCode build, it is the only one any session
# can run, and it changes only through a tested add-on release. build.yaml
# carries the same value and is what CI reads; the two are asserted equal by
# test/runtime-contract.test.js so a half-done bump cannot ship.
ARG OPENCODE_VERSION=1.18.25
# OpenCode V2 and its plugin API are one matched, exact beta build. V1 remains
# installed temporarily as the rollback runtime while the 3.0.0b0 state
# migration is implemented; no V2 process may use the V1 data roots.
ARG OPENCODE_V2_VERSION=0.0.0-beta-18684
ARG OPENCHAMBER_VERSION=1.21.0
ARG PPQ_PROXY_VERSION=0.1.0
ARG TSX_VERSION=4.20.6
ARG YQ_VERSION=v4.53.3

# Environment for better Node.js performance
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Carried into every process in the container. Shell code reads it via
# /usr/local/lib/opencode/channel.sh; Node code reads process.env.ADDON_CHANNEL.
ENV ADDON_CHANNEL=${ADDON_CHANNEL}

RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac

# Install the exact supported Node runtime without replacing Home Assistant's
# Supervisor-compatible base image. npm is shipped with the official Node image.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s node /usr/local/bin/nodejs

# Install system dependencies in a single layer
# - git: Required by OpenCode for version control operations
# - openssh-client: Provides ssh, ssh-keygen, and ssh-keyscan for Git SSH remotes
# - jq: JSON processing for helper scripts
# - curl/ca-certificates: For downloading ttyd
# - bzip2: Required by system tar to extract OpenChamber voice models
# - procps: Provides pgrep for health check
# - tmux: Session persistence to prevent multiple OpenCode instances
# - chromium: Headless browser for screenshot_url MCP tool (visual verification)
# - g++/make: native fallback builds for OpenChamber dependencies on all arches
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bzip2 \
        ca-certificates \
        chromium \
        curl \
        git \
        jq \
        libatomic1 \
        openssh-client \
        passwd \
        procps \
        python3 \
        python3-venv \
        tmux \
    && command -v ssh >/dev/null \
    && command -v ssh-keygen >/dev/null \
    && command -v ssh-keyscan >/dev/null \
    && command -v setpriv >/dev/null \
    && test "$(command -v node)" = /usr/local/bin/node \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && npm --version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

# OpenCode V2 conversion runs without root access to retained V1 state or
# Supervisor secrets. The eventual V2 runtime uses this same process identity.
RUN groupadd --gid 60000 opencode-v2 \
    && useradd --uid 60000 --gid opencode-v2 --no-create-home --no-log-init \
        --home-dir /nonexistent --shell /usr/sbin/nologin opencode-v2 \
    && test "$(id -u opencode-v2)" = 60000 \
    && test "$(id -g opencode-v2)" = 60000

# Chromium path for puppeteer-core (used by screenshot MCP tool)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install ttyd from GitHub releases (not in Debian repos)
RUN ARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64") \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ARCH}" -o /usr/bin/ttyd \
    && chmod +x /usr/bin/ttyd

# Install yq (mikefarah) from GitHub releases (static Go binary, not in Debian repos).
# This is the agent's YAML read/query/convert tool: unlike PyYAML or Ruby's YAML, it
# tolerates Home Assistant's custom tags (!include, !secret, !include_dir_*, !env_var,
# !input) instead of crashing on them. Release asset names use Debian arch (amd64/arm64).
# The trailing version assertion fails the build on a truncated/HTML-error download and
# guards against a colliding non-mikefarah "yq" (e.g. the PyPI jq-wrapper) shadowing it.
RUN ARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version | grep -q mikefarah

# Copy hab CLI binary built from source (pinned release)
# A CLI designed for AI agents to manage HA via REST/WebSocket APIs
COPY --from=hab-builder /hab /usr/local/bin/hab

# Install zigporter CLI in an isolated Python virtual environment
# A Zigbee toolkit for cascade-rename, device inspection, and mesh mapping
RUN python3 -m venv /opt/zigporter-venv \
    && /opt/zigporter-venv/bin/pip install --no-cache-dir zigporter \
    && ln -s /opt/zigporter-venv/bin/zigporter /usr/local/bin/zigporter

# Install OpenCode, OpenChamber, Prettier, and the PPQ private-mode proxy globally
# - OpenCode: AI coding agent (certified pin; see OPENCODE_VERSION above)
# - OpenChamber: browser UI for OpenCode (pinned; patched below for HA Ingress)
# - Prettier: Code formatter for YAML files, configured for HA conventions
# - ppq-private-mode: local OpenAI-compatible encryption proxy for PPQ TEE models
# - tsx: pinned runtime for the PPQ package's TypeScript entrypoint
# Build tools are needed only while npm installs native dependencies. Peer
# dependencies are omitted because ppq-private-mode is run as a standalone
# proxy, not loaded as an OpenClaw plugin.
#
# The trailing assertion fails the build when the resolved OpenCode is not the
# certified one. A dist-tag or range slipping into OPENCODE_VERSION would
# otherwise publish an image whose runtime nobody tested, and the mismatch would
# surface for the first time on a user's machine. The version is also recorded
# on disk so runtime code can name the certified build without shelling out.
COPY rootfs/opt/opencode-v2-homeassistant/non-dumpable.c /tmp/opencode-v2-non-dumpable.c
COPY rootfs/opt/opencode-v2-homeassistant/secure-launcher.c /tmp/opencode-v2-secure-launcher.c
COPY rootfs/opt/opencode-v2-homeassistant/credential-broker.c /tmp/opencode-v2-credential-broker.c
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make \
    && cc -shared -fPIC -O2 -Wall -Werror \
        -o /usr/local/lib/opencode-v2-non-dumpable.so /tmp/opencode-v2-non-dumpable.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-launch /tmp/opencode-v2-secure-launcher.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-credential-broker /tmp/opencode-v2-credential-broker.c \
    && rm -f /tmp/opencode-v2-non-dumpable.c /tmp/opencode-v2-secure-launcher.c /tmp/opencode-v2-credential-broker.c \
    && npm install -g --omit=dev --omit=peer --no-audit --no-fund \
        opencode-ai@${OPENCODE_VERSION} \
        @openchamber/web@${OPENCHAMBER_VERSION} \
        prettier \
        ppq-private-mode@${PPQ_PROXY_VERSION} \
        tsx@${TSX_VERSION} \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get purge -y --auto-remove g++ make \
    && INSTALLED=$(node -e "console.log(require('/usr/local/lib/node_modules/opencode-ai/package.json').version)") \
    && if [ "${INSTALLED}" != "${OPENCODE_VERSION}" ]; then \
        echo "OPENCODE_VERSION is ${OPENCODE_VERSION} but the installed runtime is ${INSTALLED}" >&2; \
        exit 1; \
    fi \
    && printf '%s\n' "${OPENCODE_VERSION}" > /usr/local/share/opencode-certified-version

# Copy package.json files first for better layer caching
# Changes to server code won't invalidate npm install cache
COPY rootfs/opt/opencode-v2-homeassistant/package*.json /opt/opencode-v2-homeassistant/
COPY rootfs/opt/ha-mcp-server/package*.json /opt/ha-mcp-server/
COPY rootfs/opt/ha-lsp-server/package*.json /opt/ha-lsp-server/

# Install the locked V2 runtime plus MCP and LSP dependencies in parallel.
# The V2 package lock is committed; matching CLI/plugin pins are also asserted
# by its verify:versions script and the add-on runtime contract tests.
RUN set -e; \
    (cd /opt/opencode-v2-homeassistant && npm ci --omit=dev --no-audit --no-fund) & V2_INSTALL_PID=$!; \
    (cd /opt/ha-mcp-server && npm install --omit=dev --no-audit --no-fund) & MCP_INSTALL_PID=$!; \
    (cd /opt/ha-lsp-server && npm install --omit=dev --no-audit --no-fund) & LSP_INSTALL_PID=$!; \
    wait "${V2_INSTALL_PID}"; \
    wait "${MCP_INSTALL_PID}"; \
    wait "${LSP_INSTALL_PID}" \
    && V2_INSTALLED=$(node -e "console.log(require('/opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli/package.json').version)") \
    && V2_PLUGIN=$(node -e "console.log(require('/opt/opencode-v2-homeassistant/node_modules/@opencode-ai/plugin/package.json').version)") \
    && if [ "${V2_INSTALLED}" != "${OPENCODE_V2_VERSION}" ] || [ "${V2_PLUGIN}" != "${OPENCODE_V2_VERSION}" ]; then \
        echo "OPENCODE_V2_VERSION is ${OPENCODE_V2_VERSION} but CLI=${V2_INSTALLED} plugin=${V2_PLUGIN}" >&2; \
        exit 1; \
    fi \
    && if [ "${BUILD_ARCH}" = "aarch64" ]; then \
        test -x /opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli-linux-arm64/bin/opencode2; \
    else \
        test -x /opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli-linux-x64/bin/opencode2 \
        && test -x /opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli-linux-x64-baseline/bin/opencode2; \
    fi \
    && ln -sf /opt/opencode-v2-homeassistant/node_modules/@opencode-ai/cli/bin/opencode2.exe /usr/local/bin/opencode2 \
    && opencode2 --version \
    && printf '%s\n' "${OPENCODE_V2_VERSION}" > /usr/local/share/opencode-v2-certified-version \
    && npm cache clean --force \
    && find /opt/ha-mcp-server/node_modules /opt/ha-lsp-server/node_modules \
        -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
    && OPENCODE_ARCH=$([ "${BUILD_ARCH}" = "aarch64" ] && echo "arm64" || echo "x64") \
    && if [ "${OPENCODE_ARCH}" = "arm64" ]; then \
        find /usr/local/lib/node_modules/opencode-ai/node_modules -mindepth 1 -maxdepth 1 -type d \
            ! -name "opencode-linux-arm64" -exec rm -rf {} +; \
    else \
        find /usr/local/lib/node_modules/opencode-ai/node_modules -mindepth 1 -maxdepth 1 -type d \
            ! -name "opencode-linux-x64" ! -name "opencode-linux-x64-baseline" -exec rm -rf {} +; \
    fi \
    && rm -rf /usr/local/lib/node_modules/ppq-private-mode/node_modules/openclaw \
    && find /usr/local/lib/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

# Copy root filesystem (server code, scripts, etc.)
COPY rootfs /

# OpenChamber is a generic root-hosted web app. Patch the pinned bundle so its
# static assets and runtime API URLs resolve under Home Assistant's Ingress path.
RUN node /opt/openchamber/patch-ingress.js

# Make scripts executable and create runtime directories
RUN chmod +x /usr/local/bin/* \
    && chmod +x /opt/openchamber/patch-ingress.js \
    && chmod +x /etc/s6-overlay/s6-rc.d/init-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-credential-broker/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/connect \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-ingress/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-lan/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ppq-private-proxy/run \
    && chmod +x /etc/profile.d/hab-esphome.sh \
    && chmod +x /etc/profile.d/zigporter-z2m.sh \
    && mkdir -p /data/.local/share/opencode /data/.config/opencode

# Exercise the exact in-image V1 -> V2 database and credential conversion. The
# source hash assertion proves the coordinator only touches its private copy.
RUN set -eu; \
    MIGRATION_TEST_ROOT=$(mktemp -d); \
    chmod 711 "${MIGRATION_TEST_ROOT}"; \
    V1_ROOT="${MIGRATION_TEST_ROOT}/v1"; \
    mkdir -p "${V1_ROOT}/home" "${V1_ROOT}/config" "${V1_ROOT}/data" "${V1_ROOT}/state" "${V1_ROOT}/cache" "${MIGRATION_TEST_ROOT}/workspace"; \
    (cd "${MIGRATION_TEST_ROOT}/workspace" && \
        HOME="${V1_ROOT}/home" \
        XDG_CONFIG_HOME="${V1_ROOT}/config" \
        XDG_DATA_HOME="${V1_ROOT}/data" \
        XDG_STATE_HOME="${V1_ROOT}/state" \
        XDG_CACHE_HOME="${V1_ROOT}/cache" \
        OPENCODE_DISABLE_AUTOUPDATE=true \
            exec opencode serve --hostname 127.0.0.1 --port 18098) >/tmp/v1-migration-server.log 2>&1 & \
    V1_SERVER_PID=$!; \
    V1_READY=false; \
    for i in $(seq 1 100); do \
        if curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:18098/global/health >/dev/null; then V1_READY=true; break; fi; \
        sleep 0.1; \
    done; \
    if [ "${V1_READY}" != true ]; then cat /tmp/v1-migration-server.log >&2; kill -KILL "${V1_SERVER_PID}" 2>/dev/null || true; exit 1; fi; \
    curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
        -d '{"title":"V2 image migration fixture"}' \
        http://127.0.0.1:18098/session >/dev/null; \
    kill "${V1_SERVER_PID}"; \
    for i in $(seq 1 100); do \
        if ! kill -0 "${V1_SERVER_PID}" 2>/dev/null; then break; fi; \
        sleep 0.1; \
    done; \
    if kill -0 "${V1_SERVER_PID}" 2>/dev/null; then kill -KILL "${V1_SERVER_PID}"; fi; \
    wait "${V1_SERVER_PID}" || true; \
    python3 -c 'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); sid=db.execute("select id from session limit 1").fetchone()[0]; mid="msg_migrationfixture000000000001"; db.execute("insert into message (id,session_id,time_created,time_updated,data) values (?,?,?,?,?)",(mid,sid,1,1,json.dumps({"role":"user","time":{"created":1},"agent":"build","model":{"providerID":"anthropic","modelID":"fixture"}}))); db.execute("insert into part (id,message_id,session_id,time_created,time_updated,data) values (?,?,?,?,?,?)",("prt_migrationfixture000000000001",mid,sid,1,1,json.dumps({"type":"text","text":"migration fixture"}))); db.commit(); db.close()' "${V1_ROOT}/data/opencode/opencode.db"; \
    chmod 700 "${V1_ROOT}/data/opencode"; \
    printf '%s\n' '{"anthropic":{"type":"api","key":"image-migration-fixture"}}' > "${V1_ROOT}/data/opencode/auth.json"; \
    chmod 600 "${V1_ROOT}/data/opencode/auth.json"; \
    V1_HASH=$(sha256sum "${V1_ROOT}/data/opencode/opencode.db" | cut -d' ' -f1); \
    AUTH_HASH=$(sha256sum "${V1_ROOT}/data/opencode/auth.json" | cut -d' ' -f1); \
    timeout --signal=TERM --kill-after=10s 180s python3 /usr/local/bin/opencode-v2-migrate.py prepare \
        --root "${MIGRATION_TEST_ROOT}/v2" \
        --source-data "${V1_ROOT}/data/opencode" \
        --v2-bin /usr/local/bin/opencode2 \
        --runtime-user opencode-v2 \
        --target-version "${OPENCODE_V2_VERSION}" \
        --timeout 120 >/tmp/v2-migration-result.json; \
    test "${V1_HASH}" = "$(sha256sum "${V1_ROOT}/data/opencode/opencode.db" | cut -d' ' -f1)"; \
    test "${AUTH_HASH}" = "$(sha256sum "${V1_ROOT}/data/opencode/auth.json" | cut -d' ' -f1)"; \
    test -s "${MIGRATION_TEST_ROOT}/v2/current"; \
    MIGRATED_GENERATION=$(cat "${MIGRATION_TEST_ROOT}/v2/current"); \
    runuser -u opencode-v2 -- test -r "${MIGRATION_TEST_ROOT}/v2/generations/${MIGRATED_GENERATION}/data/opencode/opencode.db"; \
    if runuser -u opencode-v2 -- test -r "${V1_ROOT}/data/opencode/opencode.db"; then exit 1; fi; \
    test "$(jq -r '.status' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = activated; \
    test "$(jq -r '.source.session_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.target.session_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.source.message_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.source.part_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.source.content_part_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.target.message_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.target.validated_content_part_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    test "$(jq -r '.target.provider_auth_count' "${MIGRATION_TEST_ROOT}/v2/migration.json")" = 1; \
    HOME="${V1_ROOT}/home" \
    XDG_CONFIG_HOME="${V1_ROOT}/config" \
    XDG_DATA_HOME="${V1_ROOT}/data" \
    XDG_STATE_HOME="${V1_ROOT}/state" \
    XDG_CACHE_HOME="${V1_ROOT}/cache" \
    OPENCODE_DISABLE_AUTOUPDATE=true \
        timeout --signal=TERM --kill-after=5s 30s opencode db --format json 'select count(*) as count from session' \
        | jq -e '.[0].count == 1' >/dev/null; \
    rm -f /tmp/v1-migration-server.log /tmp/v2-migration-result.json; \
    rm -rf "${MIGRATION_TEST_ROOT}"

# Build the custom ttyd index page (served via -I at runtime): ttyd's page is
# a single self-contained HTML file compiled into the binary, so dump it from
# a briefly-running instance and inject local browser-side fixes for clipboard,
# touch scrolling, and iframe auto-fit. The injector fails the build if the page
# could not be dumped or has an unexpected layout.
RUN set -e; \
    ttyd -p 18099 -i lo bash & \
    TTYD_PID=$!; \
    ok=0; \
    for i in $(seq 1 50); do \
        if curl -fsS -o /tmp/ttyd-index.html http://127.0.0.1:18099/; then ok=1; break; fi; \
        sleep 0.2; \
    done; \
    kill "$TTYD_PID"; \
    [ "$ok" = "1" ]; \
    python3 /opt/ttyd/inject-clipboard.py /tmp/ttyd-index.html /opt/ttyd/index.html /opt/ttyd/clipboard.js /opt/ttyd/touch-scroll.js /opt/ttyd/resize-fit.js; \
    rm -f /tmp/ttyd-index.html

# Native CI explicitly selects this target for Linux component boundary fault
# injection on both supported architectures. It is not part of ordinary local image builds;
# the Supervisor devcontainer separately covers the shipped s6 service graph.
FROM runtime AS boundary-test
RUN --mount=type=bind,source=test/v2-boundary-fixture.sh,target=/tmp/v2-boundary-fixture.sh,readonly \
    OPENCODE_V2_VERSION="${OPENCODE_V2_VERSION}" \
    timeout --signal=TERM --kill-after=10s 240s \
    bash /tmp/v2-boundary-fixture.sh

FROM runtime AS final

# Set working directory to HA config (mounted at runtime)
WORKDIR /homeassistant

# Health check - verify the active ingress service is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8099/ > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="OpenCode" \
    io.hass.description="AI coding agent for editing Home Assistant configuration" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"
