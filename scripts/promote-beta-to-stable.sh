#!/bin/bash
# Mechanical beta-to-stable promotion is intentionally disabled. Beta targets
# OpenCode V2 from 3.0.0b0 while stable remains on the certified V1 runtime.

set -euo pipefail

cat >&2 <<'EOF'
error: beta-to-stable copying is disabled.

ha_opencode_beta targets OpenCode V2 while ha_opencode remains on V1. Copying
the beta Dockerfile, rootfs, or tests over stable would bypass the V2 migration,
rollback, and parity gates. Stable V2 adoption requires its own reviewed plan.

Use scripts/check-addon-options.sh for per-channel option validation.
EOF
exit 1
