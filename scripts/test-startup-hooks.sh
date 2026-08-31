#!/usr/bin/env bash
# Focused security and lifecycle checks for the shipped startup-hook runner.

set -Eeuo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
channel=${1:-beta}
case "${channel}" in
    stable) addon=ha_opencode ;;
    beta) addon=ha_opencode_beta ;;
    *) printf 'Usage: %s [stable|beta]\n' "${0##*/}" >&2; exit 2 ;;
esac

runner_src="${repo}/${addon}/rootfs/usr/local/bin/opencode-run-hooks"
cli_src="${repo}/${addon}/rootfs/usr/local/bin/ha-hooks"
channel_src="${repo}/${addon}/rootfs/usr/local/lib/opencode/channel.sh"
# The Home Assistant devcontainer mounts /tmp with noexec; /var/tmp remains an
# executable ephemeral location there and on GitHub's Linux runners.
work=$(mktemp -d "/var/tmp/opencode-hooks-test.XXXXXX")
sb=""
hooks_dir=""
state_dir=""
trap 'rm -rf "${work}"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    grep -q -- "$2" <<<"$1" || fail "$3"
}

assert_not_contains() {
    if grep -q -- "$2" <<<"$1"; then
        fail "$3"
    fi
}

build_sandbox() {
    local name=$1
    sb="${work}/${name}"
    rm -rf "${sb}"
    mkdir -p \
        "${sb}/data" \
        "${sb}/homeassistant" \
        "${sb}/opt/ha-mcp-server" \
        "${sb}/usr/local/lib/opencode"

    sed \
        -e "s#/homeassistant#${sb}/homeassistant#g" \
        -e "s#/data#${sb}/data#g" \
        "${channel_src}" > "${sb}/usr/local/lib/opencode/channel.sh"
    sed \
        -e "s#/homeassistant#${sb}/homeassistant#g" \
        -e "s#/data#${sb}/data#g" \
        -e "s#/opt/ha-mcp-server#${sb}/opt/ha-mcp-server#g" \
        -e "s#/usr/local/lib/opencode#${sb}/usr/local/lib/opencode#g" \
        "${runner_src}" > "${sb}/runner"
    sed \
        -e "s#/homeassistant#${sb}/homeassistant#g" \
        -e "s#/data#${sb}/data#g" \
        -e "s#/usr/local/lib/opencode#${sb}/usr/local/lib/opencode#g" \
        -e "s#/usr/local/bin/opencode-run-hooks#${sb}/runner#g" \
        "${cli_src}" > "${sb}/ha-hooks"
    chmod +x "${sb}/runner" "${sb}/ha-hooks"

    if [ "${channel}" = beta ]; then
        hooks_dir="${sb}/homeassistant/opencode_beta/startup.d"
    else
        hooks_dir="${sb}/homeassistant/opencode/startup.d"
    fi
    state_dir="${sb}/data/hooks"
    mkdir -p "${hooks_dir}"
    printf 'true\n' > "${sb}/data/.user_hooks_enabled"
}

run_hooks() {
    ADDON_CHANNEL="${channel}" "${sb}/runner" "$@" 2>&1
}

run_cli() {
    ADDON_CHANNEL="${channel}" "${sb}/ha-hooks" "$@" 2>&1
}

printf '=== startup-hook security (%s) ===\n' "${addon}"

build_sandbox redirected-environment
printf '#!/usr/bin/env bash\necho CORRECT_HOOK\n' > "${hooks_dir}/10-real.sh"
mkdir -p "${sb}/redirected"
printf '%s\n' \
    'export MODE=all' \
    "export HOOKS_DIR=${sb}/redirected" \
    "export STATE_DIR=${sb}/redirected" \
    > "${sb}/data/.env_vars"
output=$(run_hooks --manifest)
assert_contains "${output}" '10-real.sh' "environment variables redirected the hook manifest"
assert_not_contains "${output}" ': running (timeout' "environment variables changed manifest mode"
output=$(run_hooks)
assert_contains "${output}" '10-real.sh: ok' "environment variables redirected hook execution"
[ -d "${state_dir}" ] || fail "hook state was not written to the protected state directory"
[ -z "$(find "${sb}/redirected" -mindepth 1 -print -quit)" ] \
    || fail "environment variables redirected hook state"

build_sandbox symlink-folder
rm -rf "${hooks_dir}"
mkdir -p "${sb}/redirected"
printf '#!/usr/bin/env bash\necho PWNED\n' > "${sb}/redirected/10-pwned.sh"
ln -s "${sb}/redirected" "${hooks_dir}"
output=$(run_hooks)
assert_contains "${output}" 'is a symlink' "symlinked hook directory was not refused"
assert_not_contains "${output}" '10-pwned.sh: ok' "hook ran through a symlinked directory"

build_sandbox timeout
printf '#!/usr/bin/env bash\n# opencode-hook-timeout: 1\nsleep 30\n' > "${hooks_dir}/10-hang.sh"
printf '#!/usr/bin/env bash\necho AFTER_TIMEOUT\n' > "${hooks_dir}/20-after.sh"
output=$(run_hooks)
assert_contains "${output}" '10-hang.sh: timed out' "hung hook was not bounded"
assert_contains "${output}" '20-after.sh: ok' "hook sweep stopped after a timeout"

build_sandbox restart-loop
printf '#!/usr/bin/env bash\necho BOOT_HOOK\n' > "${hooks_dir}/10-boot.sh"
output=$(run_hooks --boot)
assert_contains "${output}" '10-boot.sh: ok' "first boot sweep did not run"
output=$(run_hooks --boot)
assert_contains "${output}" 'restart loop' "immediate second boot sweep was not blocked"
output=$(run_hooks)
assert_contains "${output}" '10-boot.sh: ok' "restart breaker blocked a manual sweep"

build_sandbox filename-collision
printf '#!/usr/bin/env bash\necho FROM_SPACE\n' > "${hooks_dir}/10-a b.sh"
printf '#!/usr/bin/env bash\necho FROM_UNDERSCORE\nexit 7\n' > "${hooks_dir}/10-a_b.sh"
output=$(run_hooks)
assert_contains "${output}" '10-a b.sh: ok' "space-containing hook did not run"
[ "$(grep -rl FROM_SPACE "${state_dir}" | wc -l)" = 1 ] || fail "space-containing hook has ambiguous logs"
[ "$(grep -rl FROM_UNDERSCORE "${state_dir}" | wc -l)" = 1 ] || fail "underscore hook has ambiguous logs"
[ "$(grep -rl FROM_SPACE "${state_dir}")" != "$(grep -rl FROM_UNDERSCORE "${state_dir}")" ] \
    || fail "distinct hook names collided in state storage"

build_sandbox cli-option
printf '#!/usr/bin/env bash\necho SAFE\n' > "${hooks_dir}/10-safe.sh"
set +e
output=$(run_cli run --boot)
status=$?
set -e
[ "${status}" -ne 0 ] || fail "ha-hooks accepted a runner option as a hook name"
assert_contains "${output}" 'is not a hook name' "ha-hooks option refusal was not actionable"
[ ! -e "${state_dir}/.last_run" ] || fail "ha-hooks option injection stamped the restart breaker"

build_sandbox disabled
printf '#!/usr/bin/env bash\necho DISABLED\n' > "${hooks_dir}/10-disabled.sh"
rm -f "${sb}/data/.user_hooks_enabled"
rm -rf "${hooks_dir}"
output=$(run_hooks)
assert_contains "${output}" 'turned off' "disabled hook runner did not explain its state"
[ ! -e "${hooks_dir}" ] || fail "disabled hook runner created the configuration directory"

printf 'Startup-hook security checks passed (%s)\n' "${addon}"
