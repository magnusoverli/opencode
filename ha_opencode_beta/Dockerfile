# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG BUILD_ARCH

## Stage 1: Build hab CLI from source (pinned release)
# Pinned to the build host's platform — Go cross-compiles via GOARCH below,
# so this stage never needs to run under emulation
FROM --platform=$BUILDPLATFORM golang:1.24-trixie AS hab-builder

ARG BUILD_ARCH
ARG HAB_VERSION=1.6.4
RUN git clone --depth 1 --branch "${HAB_VERSION}" https://github.com/balloob/home-assistant-build-cli.git /src
WORKDIR /src

# Cross-compile for the target architecture
RUN GOARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /hab .

## Stage 2: Main add-on image
FROM $BUILD_FROM

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
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

# Install system dependencies in a single layer
# - nodejs/npm: Required for OpenCode
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
        nodejs \
        openssh-client \
        npm \
        passwd \
        procps \
        python3 \
        python3-venv \
        tmux \
    && command -v ssh >/dev/null \
    && command -v ssh-keygen >/dev/null \
    && command -v ssh-keyscan >/dev/null \
    && command -v setpriv >/dev/null \
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
    && find /usr/local/lib/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete

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

# Exercise the exact privilege boundary used by the staged s6 launcher. This is
# intentionally an image-build check: Windows unit tests cannot prove Linux
# effective IDs, capability sets, no_new_privs, or root-owned path denial.
RUN set -eu; \
    if [ "${BUILD_ARCH}" = "aarch64" ]; then \
        echo 'Skipping architecture-neutral V2 boundary fixture on arm64; native compilation and pinned binary startup were verified in earlier layers'; \
        exit 0; \
    fi; \
    BOUNDARY_ROOT=$(mktemp -d); \
    RUNTIME_ROOT="${BOUNDARY_ROOT}/runtime"; \
    GENERATION_ROOT="${BOUNDARY_ROOT}/generation"; \
    CACHE_ROOT="${BOUNDARY_ROOT}/cache"; \
    FIXTURE_ATTEMPTS=100; \
    FIXTURE_DELAY=0.1; \
    mkdir -p "${BOUNDARY_ROOT}/private" "${RUNTIME_ROOT}/home" "${RUNTIME_ROOT}/config/opencode" "${RUNTIME_ROOT}/workspace" "${RUNTIME_ROOT}/clients" "${GENERATION_ROOT}/data" "${GENERATION_ROOT}/state" "${CACHE_ROOT}"; \
    chmod 711 "${BOUNDARY_ROOT}"; \
    chmod 700 "${BOUNDARY_ROOT}/private"; \
    chmod 755 "${RUNTIME_ROOT}" "${RUNTIME_ROOT}/home" "${RUNTIME_ROOT}/config" "${RUNTIME_ROOT}/config/opencode" "${RUNTIME_ROOT}/workspace"; \
    chmod 700 "${RUNTIME_ROOT}/clients"; \
    chown -R 60000:60000 "${GENERATION_ROOT}" "${CACHE_ROOT}"; \
    printf '%s\n' private > "${BOUNDARY_ROOT}/private/sentinel"; \
    printf '%064d' 0 > "${RUNTIME_ROOT}/sidecar-secret"; \
    printf '%064d' 1 > "${RUNTIME_ROOT}/server-password"; \
    chmod 600 "${RUNTIME_ROOT}/sidecar-secret" "${RUNTIME_ROOT}/server-password"; \
    cp /opt/ha-mcp-server/AGENTS.md "${RUNTIME_ROOT}/config/opencode/AGENTS.md"; \
    node /opt/opencode-v2-homeassistant/managed-config.js --plugin-enabled true \
        --mcp-endpoint http://127.0.0.1:18765/mcp > "${RUNTIME_ROOT}/managed.json"; \
    start_sidecar() { \
        rm -f "${RUNTIME_ROOT}/mcp-sidecar.ready"; \
        env -i HOME=/data USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
            SUPERVISOR_TOKEN=image-fixture-token OPENCODE_MCP_TOOL_PROFILE=compact \
            OPENCODE_MCP_TRANSPORT=streamable-http OPENCODE_MCP_SIDECAR_SOCKET="${RUNTIME_ROOT}/mcp-sidecar.sock" OPENCODE_MCP_SIDECAR_PUBLIC_HOST=127.0.0.1:18765 \
            OPENCODE_MCP_SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" OPENCODE_MCP_SIDECAR_READY_FILE="${RUNTIME_ROOT}/mcp-sidecar.ready" LD_PRELOAD=/usr/local/lib/opencode-v2-non-dumpable.so \
            node /opt/ha-mcp-server/index.js >>"${BOUNDARY_ROOT}/sidecar.log" 2>&1 & \
        SIDECAR_PID=$!; \
    }; \
    V2_RUNTIME_ROOT="${RUNTIME_ROOT}" s6-tcpserver -q -c 16 127.0.0.1 18765 \
        /bin/bash /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/connect >"${BOUNDARY_ROOT}/proxy.log" 2>&1 & \
    PROXY_PID=$!; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        EARLY_STATUS=$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:18765/mcp 2>/dev/null || true); \
        [ "${EARLY_STATUS}" = "503" ] && break; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${EARLY_STATUS:-}" != "503" ]; then printf 'early proxy status: %s\n' "${EARLY_STATUS:-unset}"; cat "${BOUNDARY_ROOT}/proxy.log"; exit 1; fi; \
    echo 'V2 boundary fixture: proxy pre-readiness passed'; \
    if runuser -u opencode-v2 -- python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",18765))'; then exit 1; fi; \
    start_sidecar; \
    SIDECAR_MARKER_READY=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        if [ -f "${RUNTIME_ROOT}/mcp-sidecar.ready" ] && [ -S "${RUNTIME_ROOT}/mcp-sidecar.sock" ]; then SIDECAR_MARKER_READY=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${SIDECAR_MARKER_READY}" != true ]; then cat "${BOUNDARY_ROOT}/sidecar.log"; kill "${SIDECAR_PID}" 2>/dev/null || true; exit 1; fi; \
    SIDECAR_READY=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        if [ "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:18765/mcp 2>/dev/null || true)" = "401" ]; then SIDECAR_READY=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${SIDECAR_READY}" != true ]; then cat "${BOUNDARY_ROOT}/sidecar.log" "${BOUNDARY_ROOT}/proxy.log"; kill "${SIDECAR_PID}" 2>/dev/null || true; exit 1; fi; \
    echo 'V2 boundary fixture: sidecar readiness passed'; \
    PROC_CAPTURE="${CACHE_ROOT}/proc-capture"; \
    PROC_STOP="${CACHE_ROOT}/proc-stop"; \
    : > "${PROC_CAPTURE}"; \
    chown 60000:60000 "${PROC_CAPTURE}"; \
    runuser -u opencode-v2 -- env -i PATH=/usr/local/bin:/usr/bin:/bin PROC_CAPTURE="${PROC_CAPTURE}" PROC_STOP="${PROC_STOP}" \
        sh -c 'while [ ! -e "${PROC_STOP}" ]; do for status in /proc/[0-9]*/status; do pid=${status#/proc/}; pid=${pid%/status}; [ "$(awk '\''/^Uid:/ {print $2}'\'' "${status}" 2>/dev/null || true)" = 60000 ] || continue; cat "/proc/${pid}/cmdline" "/proc/${pid}/environ" "/proc/${pid}/fd/3" >> "${PROC_CAPTURE}" 2>/dev/null || true; done; done' & \
    POLLER_PID=$!; \
    /usr/local/bin/opencode-v2-credential-broker "${RUNTIME_ROOT}" >"${BOUNDARY_ROOT}/broker.log" 2>&1 & \
    BROKER_PID=$!; \
    /usr/local/bin/opencode-v2-credential-broker "${RUNTIME_ROOT}" client >"${BOUNDARY_ROOT}/client-broker.log" 2>&1 & \
    CLIENT_BROKER_PID=$!; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do [ -S "${RUNTIME_ROOT}/credential.sock" ] && break; sleep "${FIXTURE_DELAY}"; done; \
    test -S "${RUNTIME_ROOT}/credential.sock"; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do [ -S "${RUNTIME_ROOT}/client-credential.sock" ] && break; sleep "${FIXTURE_DELAY}"; done; \
    test -S "${RUNTIME_ROOT}/client-credential.sock"; \
    echo 'V2 boundary fixture: credential brokers ready'; \
    runuser -u opencode-v2 -- python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("'"${RUNTIME_ROOT}"'/client-credential.sock"); assert s.recv(1) == b""'; \
    echo 'V2 boundary fixture: unauthorized client denied'; \
    /usr/local/bin/opencode-v2-launch "${RUNTIME_ROOT}" "${GENERATION_ROOT}" "${CACHE_ROOT}" 4100 >"${BOUNDARY_ROOT}/v2.log" 2>&1 & \
    SECURE_PID=$!; \
    HTTP_READY=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        if [ "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -w '%{http_code}' -u opencode:$(cat "${RUNTIME_ROOT}/server-password") http://127.0.0.1:4100/global/health 2>/dev/null || true)" = "200" ]; then HTTP_READY=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${HTTP_READY}" != "true" ]; then cat "${BOUNDARY_ROOT}/v2.log"; kill "${SECURE_PID}" || true; exit 1; fi; \
    echo 'V2 boundary fixture: server ready'; \
    kill -0 "${BROKER_PID}"; \
    test ! -e "${RUNTIME_ROOT}/v2.pid"; \
    test "$(awk '/^Uid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "60000:60000:60000"; \
    test "$(awk '/^Gid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "60000:60000:60000"; \
    grep -q '^NoNewPrivs:[[:space:]]*1' "/proc/${SECURE_PID}/status"; \
    grep -q '^CapBnd:[[:space:]]*0000000000000000' "/proc/${SECURE_PID}/status"; \
    if runuser -u opencode-v2 -- cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then cat "${BOUNDARY_ROOT}/v2.log"; kill "${SECURE_PID}" || true; exit 1; fi; \
    if runuser -u opencode-v2 -- test -r "${BOUNDARY_ROOT}/private/sentinel"; then exit 1; fi; \
    V2_READY=false; \
    PLUGIN_RESPONSE=; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        PLUGIN_RESPONSE=$(curl -fsS --connect-timeout 1 --max-time 2 -u opencode:$(cat "${RUNTIME_ROOT}/server-password") http://127.0.0.1:4100/api/plugin 2>/dev/null || true); \
        if printf '%s' "${PLUGIN_RESPONSE}" | jq -e '.data[] | select(.id == "homeassistant.runtime-guard" and .status == "active")' >/dev/null 2>&1; then V2_READY=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${V2_READY}" != "true" ]; then cat "${BOUNDARY_ROOT}/v2.log"; kill "${SECURE_PID}" || true; exit 1; fi; \
    curl -fsS --max-time 2 -u opencode:$(cat "${RUNTIME_ROOT}/server-password") http://127.0.0.1:4100/api/health >/dev/null; \
    echo 'V2 boundary fixture: runtime guard ready'; \
    if ! /usr/local/bin/opencode-v2-launch --client "${RUNTIME_ROOT}" "${GENERATION_ROOT}" "${CACHE_ROOT}" --probe >"${BOUNDARY_ROOT}/client-probe.json"; then \
        cat "${BOUNDARY_ROOT}/client-broker.log"; \
        find "${RUNTIME_ROOT}/clients" -mindepth 1 -maxdepth 1 -printf '%M %u:%g %f\n'; \
        exit 1; \
    fi; \
    if ! jq -e '.version == "0.0.0-beta-18684"' "${BOUNDARY_ROOT}/client-probe.json" >/dev/null; then cat "${BOUNDARY_ROOT}/client-probe.json"; exit 1; fi; \
    test -z "$(find "${RUNTIME_ROOT}/clients" -mindepth 1 -maxdepth 1 -print -quit)"; \
    echo 'V2 boundary fixture: authenticated client passed'; \
    touch "${PROC_STOP}"; \
    wait "${POLLER_PID}"; \
    if grep -F -f "${RUNTIME_ROOT}/server-password" "${PROC_CAPTURE}"; then exit 1; fi; \
    if grep -F -f "${RUNTIME_ROOT}/sidecar-secret" "${PROC_CAPTURE}"; then exit 1; fi; \
    test ! -e "/proc/${SECURE_PID}/fd/3"; \
    if tr '\0' '\n' < "/proc/${SECURE_PID}/cmdline" | grep -F -f "${RUNTIME_ROOT}/server-password"; then exit 1; fi; \
    echo 'V2 boundary fixture: process isolation passed'; \
    SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" node --input-type=module -e 'import { readFileSync } from "node:fs"; import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"; import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"; const secret=readFileSync(process.env.SIDECAR_SECRET_FILE,"utf8").trim(); const client=new Client({name:"image-fixture",version:"1"}); const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18765/mcp"),{requestInit:{headers:{authorization:`Bearer ${secret}`}}}); await client.connect(transport); const tools=await client.listTools(); if (!tools.tools.some((tool)=>tool.name==="get_states")) process.exit(1); await client.close();'; \
    kill "${SIDECAR_PID}"; \
    wait "${SIDECAR_PID}"; \
    test ! -e "${RUNTIME_ROOT}/mcp-sidecar.ready"; \
    test "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:18765/mcp 2>/dev/null || true)" = "503"; \
    echo 'V2 boundary fixture: sidecar shutdown passed'; \
    kill -0 "${PROXY_PID}"; \
    if runuser -u opencode-v2 -- python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",18765))'; then exit 1; fi; \
    start_sidecar; \
    SIDECAR_MARKER_READY=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        if [ -f "${RUNTIME_ROOT}/mcp-sidecar.ready" ] && [ -S "${RUNTIME_ROOT}/mcp-sidecar.sock" ]; then SIDECAR_MARKER_READY=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${SIDECAR_MARKER_READY}" != true ]; then cat "${BOUNDARY_ROOT}/sidecar.log"; exit 1; fi; \
    SIDECAR_RESTARTED=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        if [ "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:18765/mcp 2>/dev/null || true)" = "401" ]; then SIDECAR_RESTARTED=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${SIDECAR_RESTARTED}" != "true" ]; then cat "${BOUNDARY_ROOT}/sidecar.log" "${BOUNDARY_ROOT}/proxy.log"; exit 1; fi; \
    MCP_RECONNECTED=false; \
    for _attempt in $(seq 1 "${FIXTURE_ATTEMPTS}"); do \
        MCP_RESPONSE=$(curl -fsS --connect-timeout 1 --max-time 2 -u opencode:$(cat "${RUNTIME_ROOT}/server-password") http://127.0.0.1:4100/api/mcp 2>/dev/null || true); \
        if printf '%s' "${MCP_RESPONSE}" | jq -e '.data[] | select(.name == "homeassistant" and .status.status == "connected")' >/dev/null 2>&1; then MCP_RECONNECTED=true; break; fi; \
        sleep "${FIXTURE_DELAY}"; \
    done; \
    if [ "${MCP_RECONNECTED}" != "true" ]; then cat "${BOUNDARY_ROOT}/sidecar.log" "${BOUNDARY_ROOT}/proxy.log" "${BOUNDARY_ROOT}/v2.log"; exit 1; fi; \
    echo 'V2 boundary fixture: sidecar reconnect passed'; \
    if ! kill -0 "${PROXY_PID}" 2>/dev/null; then cat "${BOUNDARY_ROOT}/proxy.log"; exit 1; fi; \
    kill -KILL "${SIDECAR_PID}"; \
    test -e "${RUNTIME_ROOT}/mcp-sidecar.ready"; \
    test "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:18765/mcp 2>/dev/null || true)" = "503"; \
    kill -0 "${PROXY_PID}"; \
    wait "${SIDECAR_PID}" || true; \
    echo 'V2 boundary fixture: abrupt sidecar death passed'; \
    if runuser -u opencode-v2 -- cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then cat "${BOUNDARY_ROOT}/v2.log"; kill "${SECURE_PID}" || true; exit 1; fi; \
    kill "${SECURE_PID}" 2>/dev/null || true; \
    wait "${SECURE_PID}" || true; \
    kill "${PROXY_PID}" 2>/dev/null || true; \
    kill "${BROKER_PID}" 2>/dev/null || true; \
    kill "${CLIENT_BROKER_PID}" 2>/dev/null || true; \
    wait "${PROXY_PID}" || true; \
    wait "${BROKER_PID}" || true; \
    wait "${CLIENT_BROKER_PID}" || true; \
    rm -rf "${BOUNDARY_ROOT}"

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
