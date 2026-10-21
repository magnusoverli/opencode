# Global ARGs (available in FROM instructions)
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie
ARG NODE_VERSION=24.21.0

# Home Assistant does not publish a Node-specific Debian base. Keep its s6 and
# Bashio runtime as the final base, and copy an exact official Node toolchain in.
FROM node:${NODE_VERSION}-trixie-slim AS node-runtime

# OpenChamber's web release is independently pinned; its desktop CLI is never
# installed. Build with the reviewed security lock, on the target's native runner.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS openchamber-bun
FROM node-runtime AS openchamber-builder
ARG OPENCHAMBER_REVISION=ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 g++ make \
    && rm -rf /var/lib/apt/lists/*
COPY --from=openchamber-bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/openchamber-preview
RUN git init \
    && git remote add origin https://github.com/openchamber/openchamber.git \
    && git -c http.version=HTTP/1.1 fetch --depth 1 origin "${OPENCHAMBER_REVISION}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${OPENCHAMBER_REVISION}" \
    && test "$(bun --version)" = 1.4.3
COPY rootfs/opt/openchamber/patch-security-dependencies.cjs rootfs/opt/openchamber/security-overrides.json /tmp/
RUN node /tmp/patch-security-dependencies.cjs /opt/openchamber-preview
COPY rootfs/opt/openchamber/security.bun.lock /opt/openchamber-preview/bun.lock
COPY rootfs/opt/openchamber/patch-git-environment.cjs /tmp/patch-git-environment.cjs
# Patch translated guidance in source so the built frontend uses app-owned updates.
COPY rootfs/opt/openchamber/patch-app-updates.cjs /tmp/patch-app-updates.cjs
RUN node /tmp/patch-app-updates.cjs /opt/openchamber-preview
COPY rootfs/opt/openchamber/patch-editor-lsp.cjs /tmp/patch-editor-lsp.cjs
COPY rootfs/opt/openchamber/editor-lsp /tmp/editor-lsp
RUN node /tmp/patch-editor-lsp.cjs /opt/openchamber-preview
COPY rootfs/opt/openchamber/patch-agent-settings.cjs /tmp/patch-agent-settings.cjs
COPY rootfs/opt/openchamber/agent-settings /tmp/agent-settings
RUN node /tmp/patch-agent-settings.cjs /opt/openchamber-preview
COPY rootfs/opt/openchamber/patch-usage-model.cjs /tmp/patch-usage-model.cjs
RUN node /tmp/patch-usage-model.cjs /opt/openchamber-preview
COPY rootfs/opt/openchamber/patch-workspace-recovery.cjs /tmp/patch-workspace-recovery.cjs
COPY rootfs/opt/openchamber/workspace-recovery /tmp/workspace-recovery
RUN node /tmp/patch-workspace-recovery.cjs /opt/openchamber-preview
# Skip desktop/mobile lifecycle scripts; explicitly build only the SDK/web assets.
RUN bun install --frozen-lockfile --ignore-scripts \
    && node /tmp/patch-git-environment.cjs /opt/openchamber-preview/packages/web \
    && bun run --cwd packages/sdk build \
    && bun run --cwd packages/ui type-check \
    && bun run --cwd packages/web build
RUN --mount=type=bind,source=test/openchamber-model-fixture.cjs,target=/tmp/openchamber-model-fixture.cjs,readonly \
    --mount=type=bind,source=test/openchamber-model-regressions.inc.ts,target=/tmp/openchamber-model-regressions.inc.ts,readonly \
    --mount=type=bind,source=test/openchamber-usage.mjs,target=/tmp/openchamber-usage.mjs,readonly \
    node /tmp/openchamber-model-fixture.cjs /opt/openchamber-preview \
    && (cd packages/ui && bun test src/stores/useConfigStore.test.ts && bun test src/lib/runtime-url.test.ts) \
    && node --test /tmp/openchamber-usage.mjs
RUN --mount=type=bind,source=test/openchamber-workspace-gate.test.tsx,target=/opt/openchamber-preview/packages/ui/src/components/auth/WorkspaceRecoveryGate.test.tsx,readonly \
    cd packages/ui && bun test src/components/auth/WorkspaceRecoveryGate.test.tsx
RUN timeout --signal=TERM --kill-after=10s 180s bun run --cwd packages/web test server/lib/git
COPY rootfs/opt/openchamber/patch-ingress.js /tmp/patch-ingress.cjs
RUN node /tmp/patch-ingress.cjs /opt/openchamber-preview/packages/web
COPY rootfs/opt/openchamber/patch-managed-backend.cjs /tmp/patch-managed-backend.cjs
RUN node /tmp/patch-managed-backend.cjs /opt/openchamber-preview/packages/web
RUN rm -rf node_modules packages/*/node_modules \
    && bun install --frozen-lockfile --production --ignore-scripts \
        --filter @openchamber/web --filter @openchamber/sdk
RUN node /tmp/patch-git-environment.cjs /opt/openchamber-preview/packages/web
COPY rootfs/opt/openchamber/patch-proxy-deprecation.cjs /tmp/patch-proxy-deprecation.cjs
RUN node /tmp/patch-proxy-deprecation.cjs /opt/openchamber-preview/packages/web
COPY rootfs/opt/openchamber/patch-braces-depth.cjs /tmp/patch-braces-depth.cjs
RUN node /tmp/patch-braces-depth.cjs /opt/openchamber-preview/packages/web
COPY rootfs/opt/openchamber/audit-installed.mjs /tmp/audit-openchamber.mjs
RUN node /tmp/audit-openchamber.mjs
RUN node -e 'require("./packages/web/node_modules/node-pty").spawn("/bin/true", []).onExit(e => process.exit(e.exitCode))' \
    && node --input-type=module -e 'await import("./packages/web/server/index.js"); process.exit(0)'
RUN --mount=type=bind,source=test/openchamber-request-body.mjs,target=/tmp/openchamber-request-body.mjs,readonly \
    --mount=type=bind,source=test/openchamber-managed-backend.mjs,target=/tmp/openchamber-managed-backend.mjs,readonly \
    --mount=type=bind,source=test/openchamber-security.mjs,target=/tmp/openchamber-security.mjs,readonly \
    --mount=type=bind,source=test/openchamber-lan-auth.mjs,target=/tmp/openchamber-lan-auth.mjs,readonly \
    --mount=type=bind,source=test/openchamber-relay-host.mjs,target=/tmp/openchamber-relay-host.mjs,readonly \
    node --throw-deprecation --test /tmp/openchamber-security.mjs /tmp/openchamber-request-body.mjs /tmp/openchamber-managed-backend.mjs /tmp/openchamber-lan-auth.mjs /tmp/openchamber-relay-host.mjs

## Build hab CLI from source (pinned release)
# Pinned to the build host's platform — Go cross-compiles via GOARCH below,
# so this stage never needs to run under emulation
FROM --platform=$BUILDPLATFORM golang:1.24-trixie AS hab-builder

ARG BUILD_ARCH
ARG HAB_VERSION=1.7.2
ARG HAB_REVISION=0bc138c6ab9f1bbe87914a0ffccbb038c0767e82
RUN git clone --depth 1 --branch "${HAB_VERSION}" https://github.com/balloob/home-assistant-build-cli.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "${HAB_REVISION}"
WORKDIR /src

# Cross-compile for the target architecture
RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH:-unset}" >&2; exit 1;; esac \
    && GOARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${HAB_VERSION}" -o /hab .

## Stage 2: Main add-on image
FROM $BUILD_FROM AS runtime

# Build arguments
ARG BUILD_VERSION
ARG BUILD_ARCH
ARG NODE_VERSION
# Release-channel identity for paths shared through /homeassistant. Stable and
# beta use separate release trees, but still use this one value
# rather than scattering channel-specific paths through the image.
ARG ADDON_CHANNEL=stable
ARG TTYD_VERSION=1.7.7
# One pinned V2 runtime and its matching plugin API. No V1 runtime is installed.
ARG OPENCODE_V2_VERSION=2.1.2
ARG OPENCHAMBER_VERSION=2.5.0
ARG TINFOIL_VERSION=1.2.1
ARG TSX_VERSION=4.23.15
ARG YQ_VERSION=v4.54.1
ARG ZIGPORTER_VERSION=1.4.2

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
# Supervisor secrets. The interactive server runs as root for HAOS filesystem
# compatibility; this dedicated identity remains the migration boundary.
RUN groupadd --gid 60000 opencode-v2 \
    && useradd --uid 60000 --gid opencode-v2 --no-create-home --no-log-init \
        --home-dir /nonexistent --shell /usr/sbin/nologin opencode-v2 \
    && test "$(id -u opencode-v2)" = 60000 \
    && test "$(id -g opencode-v2)" = 60000 \
    && groupadd --gid 60001 opencode-v2-tui \
    && useradd --uid 60001 --gid opencode-v2-tui --no-create-home --no-log-init \
        --home-dir /nonexistent --shell /usr/sbin/nologin opencode-v2-tui \
    && test "$(id -u opencode-v2-tui)" = 60001 \
    && test "$(id -g opencode-v2-tui)" = 60001

# Chromium path for puppeteer-core (used by screenshot MCP tool)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install ttyd from GitHub releases (not in Debian repos)
RUN ARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64") \
    && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 10 --max-time 120 \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ARCH}" -o /usr/bin/ttyd \
    && chmod +x /usr/bin/ttyd

# Install yq (mikefarah) from GitHub releases (static Go binary, not in Debian repos).
# This is the agent's YAML read/query/convert tool: unlike PyYAML or Ruby's YAML, it
# tolerates Home Assistant's custom tags (!include, !secret, !include_dir_*, !env_var,
# !input) instead of crashing on them. Release asset names use Debian arch (amd64/arm64).
# The trailing version assertion fails the build on a truncated/HTML-error download and
# guards against a colliding non-mikefarah "yq" (e.g. the PyPI jq-wrapper) shadowing it.
RUN ARCH=$([ "$BUILD_ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") \
    && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 10 --max-time 120 \
        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version | grep -q mikefarah

# Copy hab CLI binary built from source (pinned release)
# A CLI designed for AI agents to manage HA via REST/WebSocket APIs
COPY --from=hab-builder /hab /usr/local/bin/hab

# Install zigporter CLI in an isolated Python virtual environment
# A Zigbee toolkit for cascade-rename, device inspection, and mesh mapping
RUN python3 -m venv /opt/zigporter-venv \
    && /opt/zigporter-venv/bin/pip install --no-cache-dir "zigporter==${ZIGPORTER_VERSION}" \
    && /opt/zigporter-venv/bin/zigporter --version

# Install the PPQ private-mode SDK. Prettier is in the V2 lock;
# OpenChamber is built independently from its pinned preview source above.
# - tinfoil: attestation and encrypted transport for the image-owned PPQ adapter
# - tsx: pinned TypeScript launcher retained for user tooling
# Build tools are needed only while npm installs native dependencies. Peer
# dependencies are omitted because the SDK is used by a standalone
# proxy, not loaded as an OpenClaw plugin.
#
# The V2 package and binary pins are verified separately below.
COPY rootfs/opt/opencode-v2-homeassistant/non-dumpable.c /tmp/opencode-v2-non-dumpable.c
COPY rootfs/opt/opencode-v2-homeassistant/secure-launcher.c /tmp/opencode-v2-secure-launcher.c
COPY rootfs/opt/opencode-v2-homeassistant/credential-broker.c /tmp/opencode-v2-credential-broker.c
COPY rootfs/opt/opencode-v2-homeassistant/container-init.c /tmp/opencode-container-init.c
COPY rootfs/opt/opencode-v2-homeassistant/tui-launcher.c /tmp/opencode-v2-tui-launcher.c
COPY rootfs/opt/opencode-v2-homeassistant/external-mcp-launcher.c /tmp/opencode-v2-external-mcp-launcher.c
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make \
    && cc -shared -fPIC -O2 -Wall -Werror \
        -o /usr/local/lib/opencode-v2-non-dumpable.so /tmp/opencode-v2-non-dumpable.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-launch /tmp/opencode-v2-secure-launcher.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-credential-broker /tmp/opencode-v2-credential-broker.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-container-init /tmp/opencode-container-init.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-tui-launch /tmp/opencode-v2-tui-launcher.c \
    && cc -O2 -Wall -Wextra -Werror \
        -o /usr/local/bin/opencode-v2-external-mcp-launch /tmp/opencode-v2-external-mcp-launcher.c \
    && rm -f /tmp/opencode-v2-non-dumpable.c /tmp/opencode-v2-secure-launcher.c \
        /tmp/opencode-v2-credential-broker.c /tmp/opencode-container-init.c \
        /tmp/opencode-v2-tui-launcher.c /tmp/opencode-v2-external-mcp-launcher.c \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get purge -y --auto-remove g++ make

# Copy package.json files first for better layer caching
# Changes to server code won't invalidate npm install cache
COPY rootfs/opt/opencode-v2-homeassistant/package*.json /opt/opencode-v2-homeassistant/
COPY rootfs/opt/ha-mcp-server/package*.json /opt/ha-mcp-server/
COPY rootfs/opt/ha-lsp-server/package*.json /opt/ha-lsp-server/
COPY rootfs/opt/ppq-private-runtime/package*.json /opt/ppq-private-runtime/

# PPQ runs standalone; its OpenClaw peer is intentionally not installed. Lock
# the complete tree rather than resolving moving transitive dependencies on each
# image build. Overrides retain the AI SDK tree already qualified in b20.
RUN cd /opt/ppq-private-runtime \
    && npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund \
    && test "$(node -p 'require("./node_modules/tinfoil/package.json").version')" = "${TINFOIL_VERSION}" \
    && test "$(node -p 'require("./node_modules/tsx/package.json").version')" = "${TSX_VERSION}" \
    && test ! -e node_modules/openclaw \
    && ln -sf /opt/ppq-private-runtime/node_modules/tsx/dist/cli.mjs /usr/local/bin/tsx \
    && ln -sf /opt/ppq-private-runtime/proxy.js /usr/local/bin/ppq-private-proxy \
    && tsx --version \
    && node --input-type=module --eval 'import("tinfoil").then(crypto => { if (typeof crypto.SecureClient !== "function") process.exit(1); })' \
    && npm cache clean --force

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
    && V2_INSTALLED=$(node -e "console.log(require('/opt/opencode-v2-homeassistant/node_modules/@opencode/cli/package.json').version)") \
    && V2_PLUGIN=$(node -e "console.log(require('/opt/opencode-v2-homeassistant/node_modules/@opencode/plugin/package.json').version)") \
    && if [ "${V2_INSTALLED}" != "${OPENCODE_V2_VERSION}" ] || [ "${V2_PLUGIN}" != "${OPENCODE_V2_VERSION}" ]; then \
        echo "OPENCODE_V2_VERSION is ${OPENCODE_V2_VERSION} but CLI=${V2_INSTALLED} plugin=${V2_PLUGIN}" >&2; \
        exit 1; \
    fi \
    && if [ "${BUILD_ARCH}" = "aarch64" ]; then \
        test -x /opt/opencode-v2-homeassistant/node_modules/@opencode/cli-linux-arm64/bin/opencode; \
    else \
        test -x /opt/opencode-v2-homeassistant/node_modules/@opencode/cli-linux-x64/bin/opencode \
        && test -x /opt/opencode-v2-homeassistant/node_modules/@opencode/cli-linux-x64-baseline/bin/opencode; \
    fi \
    && mkdir -p /usr/local/libexec \
    && ln -sf /opt/opencode-v2-homeassistant/node_modules/@opencode/cli/bin/opencode.exe /usr/local/libexec/opencode-v2 \
    && /usr/local/libexec/opencode-v2 --version \
    && ln -sf /opt/opencode-v2-homeassistant/node_modules/prettier/bin/prettier.cjs /usr/local/bin/prettier \
    && printf '%s\n' "${OPENCODE_V2_VERSION}" > /usr/local/share/opencode-v2-certified-version \
    && npm cache clean --force \
    && find /opt/ha-mcp-server/node_modules /opt/ha-lsp-server/node_modules \
        -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
    && find /opt/ppq-private-runtime/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && find /usr/local/lib/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.pdb' \) -delete \
    && test ! -e /usr/local/lib/node_modules/opencode-ai

# Only production dependencies, web assets/server and the SDK enter the image.
# Neither the build toolchain nor desktop/mobile applications are shipped.
COPY --from=openchamber-builder /opt/openchamber-preview/node_modules /opt/openchamber-preview/node_modules
COPY --from=openchamber-builder /opt/openchamber-preview/packages/web /opt/openchamber-preview/packages/web
COPY --from=openchamber-builder /opt/openchamber-preview/packages/sdk /opt/openchamber-preview/packages/sdk
COPY --from=openchamber-builder /opt/openchamber-preview/LICENSE /opt/openchamber-preview/LICENSE
RUN test "$(node -p 'require("/opt/openchamber-preview/packages/web/package.json").version')" = "${OPENCHAMBER_VERSION}" \
    && printf '%s\n' "${OPENCHAMBER_VERSION}" > /usr/local/share/openchamber-certified-version

# Copy root filesystem (server code, scripts, etc.)
COPY rootfs /

# Verify the LAN native-app flow against the pinned UI's actual authentication.
RUN --mount=type=bind,source=test/v2-ui-lan-fixture.mjs,target=/tmp/v2-ui-lan-fixture.mjs,readonly \
    timeout --signal=TERM --kill-after=5s 45s node /tmp/v2-ui-lan-fixture.mjs

# Make scripts executable and create runtime directories
RUN python3 -c 'import json; from pathlib import Path; p = Path("/opt/opencode-assist/custom_components/opencode_assist"); m = json.loads((p / "manifest.json").read_text()); assert m["domain"] == "opencode_assist" and m["version"]; assert (p / "config_flow.py").is_file()' \
    && chmod +x /usr/local/bin/* \
    && chmod +x /opt/ppq-private-runtime/proxy.js \
    && chmod +x /opt/openchamber/patch-ingress.js \
    && chmod +x /etc/s6-overlay/s6-rc.d/init-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-lsp/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-sidecar/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-credential-broker/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/connect \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-ingress/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-openchamber-lan/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-opencode-server/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-facing-mcp/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ha-assist/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ppq-private-proxy/run \
    && chmod +x /etc/profile.d/hab-esphome.sh \
    && chmod +x /etc/profile.d/zigporter-z2m.sh \
    && mkdir -p /data/.local/share/opencode /data/.config/opencode

# Verify forward import of synthetic legacy data with only the pinned V2 binary.
RUN --mount=type=bind,source=test/v2-forward-fixture.py,target=/tmp/v2-forward-fixture.py,readonly \
    timeout --signal=TERM --kill-after=10s 180s \
    python3 /tmp/v2-forward-fixture.py --version "${OPENCODE_V2_VERSION}"

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
RUN --network=none --mount=type=bind,source=test/hab-cli-fixture.mjs,target=/tmp/hab-cli-fixture.mjs,readonly \
    timeout --signal=TERM --kill-after=10s 120s node /tmp/hab-cli-fixture.mjs

RUN --network=none --mount=type=bind,source=test/v2-openchamber-browser.mjs,target=/tmp/v2-openchamber-browser.mjs,readonly \
    timeout --signal=TERM --kill-after=10s 180s node /tmp/v2-openchamber-browser.mjs

RUN --mount=type=bind,source=test/v2-boundary-fixture.sh,target=/tmp/v2-boundary-fixture.sh,readonly \
    --mount=type=bind,source=test/v2-caller-secret-plugin.js,target=/tmp/v2-caller-secret-plugin.js,readonly \
    --mount=type=bind,source=test/v2-caller-secret-native.py,target=/tmp/v2-caller-secret-native.py,readonly \
    --mount=type=bind,source=test/v2-provider-startup-fixture.mjs,target=/tmp/v2-provider-startup-fixture.mjs,readonly \
    --mount=type=bind,source=test/v2-zigbee-fixture.mjs,target=/tmp/v2-zigbee-fixture.mjs,readonly \
    --mount=type=bind,source=test/v2-lan-fixture.mjs,target=/tmp/v2-lan-fixture.mjs,readonly \
    OPENCODE_V2_VERSION="${OPENCODE_V2_VERSION}" \
    timeout --signal=TERM --kill-after=10s 240s \
    bash /tmp/v2-boundary-fixture.sh \
    && timeout --signal=TERM --kill-after=10s 60s node /tmp/v2-zigbee-fixture.mjs

RUN --mount=type=bind,source=test,target=/tmp/ha-assist/test,readonly \
    ln -s / /tmp/ha-assist/rootfs \
    && PYTHONDONTWRITEBYTECODE=1 python3 /tmp/ha-assist/test/assist-install.test.py \
    && timeout --signal=TERM --kill-after=10s 120s node --test \
        /tmp/ha-assist/test/opencode-v2-assist-adapter.test.js \
        /tmp/ha-assist/test/opencode-v2-assist-discovery.test.js \
        /tmp/ha-assist/test/opencode-v2-assist-notification.test.js \
        /tmp/ha-assist/test/opencode-v2-assist-lifecycle.test.js \
        /tmp/ha-assist/test/opencode-v2-assist-service.test.js

RUN --mount=type=bind,source=test,target=/tmp/mcp-startup/test,readonly \
    ln -s / /tmp/mcp-startup/rootfs \
    && node --test /tmp/mcp-startup/test/opencode-v2-mcp-config.test.js \
        /tmp/mcp-startup/test/opencode-v2-mcp-startup.test.js

FROM runtime AS final

ENTRYPOINT ["/usr/local/bin/opencode-container-init"]

# Set working directory to HA config (mounted at runtime)
WORKDIR /homeassistant

# Health check - verify the active ingress service is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS --max-time 5 http://127.0.0.1:8099/ > /dev/null && opencode status > /dev/null || exit 1

# Labels for Home Assistant
LABEL \
    io.hass.name="OpenCode" \
    io.hass.description="AI coding agent for editing Home Assistant configuration" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"
