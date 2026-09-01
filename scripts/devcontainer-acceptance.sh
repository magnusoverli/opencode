#!/usr/bin/env bash

set -Eeuo pipefail

app=${1:-}
case "${app}" in
    ha_opencode | ha_opencode_beta) ;;
    *)
        printf 'Usage: %s {ha_opencode|ha_opencode_beta}\n' "${0##*/}" >&2
        exit 2
        ;;
esac

workspace=${WORKSPACE_DIRECTORY:-$(git rev-parse --show-toplevel)}
slug="local_${app}"
container="app_${slug}"
expected_node=$(awk -F '"' '/^  NODE_VERSION:/ { print $2; exit }' "${workspace}/${app}/build.yaml")

fail() {
    echo "Acceptance failed: $*" >&2
    exit 1
}

wait_for_mcp_status() {
    local expected=$1
    local status
    for _attempt in $(seq 1 100); do
        status=$(docker exec "${container}" sh -c \
            "curl -sS -o /dev/null --connect-timeout 1 --max-time 2 -X POST -w '%{http_code}' http://127.0.0.1:8765/mcp" \
            2>/dev/null || true)
        [ "${status}" = "${expected}" ] && return 0
        sleep 0.1
    done
    fail "expected MCP status ${expected}, got ${status:-unset}"
}

wait_for_sidecar_replacement() {
    local old_pid=$1
    local current_pid
    for _attempt in $(seq 1 100); do
        current_pid=$(docker exec "${container}" awk 'NR == 1 { print $1 }' \
            /run/opencode-v2/mcp-sidecar.ready 2>/dev/null || true)
        case "${current_pid}" in
            '' | *[!0-9]*) ;;
            *)
                if [ "${current_pid}" != "${old_pid}" ]; then
                    printf '%s\n' "${current_pid}"
                    return 0
                fi
                ;;
        esac
        sleep 0.1
    done
    fail "s6 did not replace the crashed sidecar process"
}

wait_for_v2_tui() {
    local current_pid
    for _attempt in $(seq 1 100); do
        current_pid=$(docker exec "${container}" pgrep -f \
            '^/usr/local/bin/opencode2 --server http://127.0.0.1:4100$' 2>/dev/null || true)
        if [[ "${current_pid}" =~ ^[0-9]+$ ]]; then
            printf '%s\n' "${current_pid}"
            return 0
        fi
        sleep 0.1
    done
    fail "the V2 terminal launcher did not attach to the private server"
}

sidecar_recovery_pending=false
tui_pid=""
mount_test=""
cleanup() {
    if [ -n "${tui_pid}" ]; then
        docker exec "${container}" kill "${tui_pid}" >/dev/null 2>&1 || true
    fi
    if [ -n "${mount_test}" ]; then
        docker exec "${container}" rm -f "/homeassistant/${mount_test}" >/dev/null 2>&1 || true
    fi
    if [ "${sidecar_recovery_pending}" = true ]; then
        docker exec "${container}" s6-svc -u /run/service/ha-opencode-v2-mcp-sidecar \
            >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || fail "docker is unavailable; run inside the Home Assistant devcontainer"
command -v ha >/dev/null || fail "Home Assistant CLI is unavailable; run inside the Home Assistant devcontainer"
command -v jq >/dev/null || fail "jq is unavailable"

info=$(ha --raw-json apps info "${slug}")
[ "$(jq -r '.result' <<<"${info}")" = ok ] || fail "Supervisor cannot inspect ${slug}"
[ "$(jq -r '.data.state' <<<"${info}")" = started ] || fail "${slug} is not started"
[ "$(jq -r '.data.ingress' <<<"${info}")" = true ] || fail "${slug} does not expose Ingress"

[ "$(docker inspect --format '{{.State.Status}}' "${container}")" = running ] \
    || fail "${container} is not running"
[ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" = healthy ] \
    || fail "${container} is not healthy"
[ "$(docker exec "${container}" node --version)" = "v${expected_node}" ] \
    || fail "${container} does not run Node ${expected_node}"

if [ "${app}" = ha_opencode_beta ]; then
    [ "$(docker exec "${container}" stat -c '%u:%g:%a' /run/opencode-v2/workspace)" = 0:0:755 ] \
        || fail "the V2 project workspace is not root-owned"
    docker exec "${container}" runuser -u opencode-v2 -- test -x /run/opencode-v2/workspace \
        || fail "the V2 migration user cannot traverse the project workspace"
    docker exec "${container}" runuser -u opencode-v2-tui -- test -x /run/opencode-v2/workspace \
        || fail "the V2 TUI cannot traverse its project workspace"
    if docker exec "${container}" runuser -u opencode-v2-tui -- \
        touch /run/opencode-v2/workspace/.opencode >/dev/null 2>&1; then
        fail "UID 60001 can modify the root-owned V2 project workspace"
    fi
    [ "$(jq -r '.data.options.terminal_runtime' <<<"${info}")" = v2 ] \
        || fail "the beta terminal runtime is not V2"
    [ "$(docker exec "${container}" cat /run/opencode-v2-homeassistant.ready)" = "/homeassistant" ] \
        || fail "the V2 workspace readiness marker is invalid"

    pid1_cap_bnd=$(docker exec "${container}" awk '/^CapBnd:/ { print $2 }' /proc/1/status)
    [ $((16#${pid1_cap_bnd} & (1 << 21))) -eq 0 ] \
        || fail "PID 1 unexpectedly has SYS_ADMIN"

    mount_test=".opencode-v2-acceptance-$$"
    docker exec "${container}" sh -c \
        'printf "%s\n" v2-write-ok > "$1"' sh "/homeassistant/${mount_test}"
    [ "$(docker exec "${container}" cat "/homeassistant/${mount_test}")" = v2-write-ok ] \
        || fail "a V2 workspace write was not visible through /homeassistant"
    docker exec "${container}" rm -f "/homeassistant/${mount_test}"
    docker exec "${container}" test ! -e "/homeassistant/${mount_test}" \
        || fail "the V2 workspace write fixture was not removed"
    mount_test=""
fi

services=(ha-opencode ha-opencode-server ha-openchamber ha-openchamber-ingress ha-openchamber-lan)
if [ "${app}" = ha_opencode_beta ]; then
    services+=(
        ha-opencode-v2-credential-broker
        ha-opencode-v2-mcp-proxy
        ha-opencode-v2-mcp-sidecar
        ha-opencode-v2-server
    )
fi
for service in "${services[@]}"; do
    state=$(docker exec "${container}" s6-svstat "/run/service/${service}")
    [[ "${state}" == up* ]] || fail "s6 service ${service} is not up: ${state}"
done

docker exec -e OPENCODE_DISABLE_AUTOUPDATE=true "${container}" \
    /usr/local/bin/opencode-smoke-test
docker exec "${container}" curl -fsS --max-time 10 http://127.0.0.1:8099/ >/dev/null

ingress_entry=$(jq -r '.data.ingress_entry' <<<"${info}")
ingress_token=${ingress_entry#/api/hassio_ingress/}
session_json=$(docker exec homeassistant sh -c \
    'curl -fsS --max-time 10 -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" -H "Content-Type: application/json" -d "{}" http://supervisor/ingress/session')
ingress_session=$(jq -r '.data.session // .session // empty' <<<"${session_json}")
[ -n "${ingress_session}" ] || fail "Home Assistant could not create an Ingress session"
docker exec -e INGRESS_SESSION="${ingress_session}" -e INGRESS_TOKEN="${ingress_token}" \
    homeassistant sh -c \
    'curl -fsS --max-time 10 -H "Cookie: ingress_session=${INGRESS_SESSION}" "http://127.0.0.1:8123/api/hassio_ingress/${INGRESS_TOKEN}/"' \
    >/dev/null

if [ "${app}" = ha_opencode_beta ] && [ "$(jq -r '.data.options.mcp_enabled' <<<"${info}")" = true ]; then
    wait_for_mcp_status 401
    old_sidecar_pid=$(docker exec "${container}" awk 'NR == 1 { print $1 }' /run/opencode-v2/mcp-sidecar.ready)
    case "${old_sidecar_pid}" in
        '' | *[!0-9]*) fail "sidecar ready marker has an invalid PID" ;;
    esac

    # Set the fallback before sending SIGKILL so an interrupted command cannot
    # leave the service administratively down.
    sidecar_recovery_pending=true
    docker exec "${container}" s6-svc -k /run/service/ha-opencode-v2-mcp-sidecar
    proxy_state=$(docker exec "${container}" s6-svstat /run/service/ha-opencode-v2-mcp-proxy)
    [[ "${proxy_state}" == up* ]] || fail "root MCP proxy stopped with its sidecar"

    new_sidecar_pid=$(wait_for_sidecar_replacement "${old_sidecar_pid}")
    wait_for_mcp_status 401
    docker exec -e SIDECAR_PID="${new_sidecar_pid}" "${container}" sh -c 'kill -0 "${SIDECAR_PID}"'
    sidecar_state=$(docker exec "${container}" s6-svstat /run/service/ha-opencode-v2-mcp-sidecar)
    [[ "${sidecar_state}" == up* ]] || fail "s6 sidecar service did not recover: ${sidecar_state}"
    sidecar_recovery_pending=false
fi

if [ "${app}" = ha_opencode_beta ]; then
    [ "$(docker exec "${container}" stat -c '%u:%g:%a' /run/opencode-v2/tui \
        /run/opencode-v2/tui/config /run/opencode-v2/tui/config/opencode)" = \
        $'0:0:755\n0:0:755\n0:0:755' ] \
        || fail "the V2 TUI managed-config ancestry is not root-owned"
    [ "$(docker exec "${container}" stat -c '%u:%g:%a' \
        /run/opencode-v2/tui/config/opencode/opencode.json)" = 0:0:444 ] \
        || fail "the V2 TUI managed config is not immutable to its runtime user"
    [ "$(docker exec "${container}" stat -c '%u:%g:%a' /run/opencode-v2/tui/home \
        /run/opencode-v2/tui/data /run/opencode-v2/tui/state /run/opencode-v2/tui/cache)" = \
        $'60001:60001:700\n60001:60001:700\n60001:60001:700\n60001:60001:700' ] \
        || fail "the V2 TUI writable roots are not confined to UID 60001"
    if docker exec "${container}" pgrep -f \
        '^/usr/local/bin/opencode2 --server http://127.0.0.1:4100$' >/dev/null 2>&1; then
        fail "a V2 TUI was already running before the attachment test"
    fi
    docker exec -dt "${container}" /usr/local/bin/opencode-v2-tui-launch /run/opencode-v2 >/dev/null
    tui_pid=$(wait_for_v2_tui)
    [ "$(docker exec "${container}" awk '/^Uid:/ { print $2":"$3":"$4 }' "/proc/${tui_pid}/status")" = \
        "60001:60001:60001" ] || fail "the attached V2 TUI is not running as UID 60001"
    [ "$(docker exec "${container}" awk '/^Gid:/ { print $2":"$3":"$4 }' "/proc/${tui_pid}/status")" = \
        "60001:60001:60001" ] || fail "the attached V2 TUI is not running as GID 60001"
    [ "$(docker exec "${container}" awk '/^NoNewPrivs:/ { print $2 }' "/proc/${tui_pid}/status")" = 1 ] \
        || fail "the attached V2 TUI does not enforce no-new-privileges"
    [ "$(docker exec "${container}" awk '/^CapBnd:/ { print $2 }' "/proc/${tui_pid}/status")" = \
        0000000000000000 ] || fail "the attached V2 TUI retained capabilities"
    if docker exec "${container}" readlink "/proc/${tui_pid}/cwd" >/dev/null 2>&1; then
        fail "the attached V2 TUI working directory remains externally inspectable"
    fi
    if docker exec "${container}" runuser -u opencode-v2-tui -- \
        cat "/proc/${tui_pid}/environ" >/dev/null 2>&1; then
        fail "UID 60001 can inspect the attached V2 TUI credential environment"
    fi
    docker exec "${container}" kill "${tui_pid}"
    tui_pid=""
fi

trap - EXIT INT TERM
echo "Home Assistant devcontainer acceptance passed (${slug})"
