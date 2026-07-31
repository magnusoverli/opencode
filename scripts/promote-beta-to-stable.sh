#!/bin/bash
# Promote the beta channel's code to stable.
#
# Channels are folders, not branches. ha_opencode_beta/ and ha_opencode/ are
# each a complete add-on; what makes one of them "beta" is the ADDON_CHANNEL
# build arg its workflow passes, never anything written inside rootfs/. That is
# what lets promotion be a straight copy.
#
# Copied (the code):        Dockerfile, rootfs/, test/, .dockerignore
# Never copied (identity):  config.yaml, build.yaml, translations/, DOCS.md,
#                           CHANGELOG.md, icon.png, logo.png
#
# The metadata stays put because it carries the slug, image, version, panel
# title and per-channel pins. Copying it would publish beta's identity as
# stable — the exact failure this split exists to prevent.
#
# Usage:
#   scripts/promote-beta-to-stable.sh --check   # report drift, change nothing
#   scripts/promote-beta-to-stable.sh           # copy beta's code onto stable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BETA="ha_opencode_beta"
STABLE="ha_opencode"

# The code half of an add-on folder. Everything else is channel identity.
CODE_PATHS=(Dockerfile .dockerignore rootfs test)

CHECK_ONLY=false
if [ "${1:-}" = "--check" ]; then
    CHECK_ONLY=true
elif [ $# -gt 0 ]; then
    echo "error: unknown argument '$1' (expected --check or nothing)" >&2
    exit 2
fi

for path in "${CODE_PATHS[@]}"; do
    if [ ! -e "${BETA}/${path}" ]; then
        echo "error: ${BETA}/${path} is missing — is the beta add-on complete?" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Report what differs
# ---------------------------------------------------------------------------
echo "Comparing ${BETA} -> ${STABLE} (code only)"
echo

drift=0
for path in "${CODE_PATHS[@]}"; do
    if diff -r -q "${STABLE}/${path}" "${BETA}/${path}" \
        --exclude=node_modules >/dev/null 2>&1; then
        printf '  %-16s identical\n' "${path}"
    else
        printf '  %-16s DIFFERS\n' "${path}"
        drift=1
    fi
done

echo
# Per-channel pins are deliberately not copied, but a stale stable pin after
# promotion is a real and easy mistake — surface it rather than hide it.
for pin in OPENCHAMBER_VERSION; do
    beta_pin=$(sed -n "s/^[[:space:]]*${pin}:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "${BETA}/build.yaml" || true)
    stable_pin=$(sed -n "s/^[[:space:]]*${pin}:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "${STABLE}/build.yaml" || true)
    if [ -n "${beta_pin}" ] && [ "${beta_pin}" != "${stable_pin}" ]; then
        echo "note: ${pin} differs — beta=${beta_pin} stable=${stable_pin}"
        echo "      This is a per-channel pin and is NOT copied. If the new"
        echo "      OpenChamber is what you soaked in beta, edit"
        echo "      ${STABLE}/build.yaml by hand."
        echo
    fi
done

if [ "${drift}" = "0" ]; then
    echo "Stable already carries beta's code. Nothing to promote."
    exit 0
fi

if [ "${CHECK_ONLY}" = "true" ]; then
    echo "Run without --check to copy beta's code onto stable."
    exit 0
fi

# ---------------------------------------------------------------------------
# Refuse to work on a dirty tree
# ---------------------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
    echo "error: working tree is not clean." >&2
    echo "       Promotion overwrites ${STABLE}/ wholesale; commit or stash first" >&2
    echo "       so the change is reviewable and revertable." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Copy
# ---------------------------------------------------------------------------
for path in "${CODE_PATHS[@]}"; do
    # Delete first. A merge-style copy leaves behind files that beta deleted,
    # and stable would keep shipping them forever.
    rm -rf "${STABLE:?}/${path}"
    cp -r "${BETA}/${path}" "${STABLE}/${path}"
    echo "  copied ${path}"
done

echo
echo "Verifying the copy..."
for path in "${CODE_PATHS[@]}"; do
    if ! diff -r -q "${STABLE}/${path}" "${BETA}/${path}" --exclude=node_modules >/dev/null; then
        echo "error: ${path} still differs after copying — refusing to claim success." >&2
        exit 1
    fi
done
echo "  code is identical across channels"

# A channel string baked into rootfs would survive this copy and mislabel the
# other channel. Cheap to assert, and the whole design rests on it.
#
# Comment lines are excluded. What matters is a channel name the code acts on,
# and prose that merely mentions one is not that -- the case that surfaced on
# the first real promotion is index.js explaining why the add-on slug cannot be
# a literal, naming both channels' slugs to make the point. Failing on an
# explanation of the rule the guard enforces trains people to bypass the guard.
channel_leaks=$(grep -rn --exclude-dir=node_modules --exclude-dir=test \
    -e 'ADDON_CHANNEL=[\"'\'']\?beta' -e 'ha_opencode_beta' \
    "${STABLE}/rootfs" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|#|<!--)' || true)

if [ -n "${channel_leaks}" ]; then
    echo "${channel_leaks}" >&2
    echo >&2
    echo "error: stable's rootfs names the beta channel (shown above)." >&2
    echo "       Channel identity must come from the ADDON_CHANNEL build arg." >&2
    exit 1
fi

cat <<'EOF'

Done. Still to do by hand:

  1. Write the "## <version>" section in ha_opencode/CHANGELOG.md
  2. Bump the beta line in ha_opencode_beta/CHANGELOG.md if you are starting a
     new one
  3. Commit, push to main, then tag:  git tag v<version> && git push origin v<version>

The version in ha_opencode/config.yaml is written by CI when the tag builds —
do not set it by hand.
EOF
