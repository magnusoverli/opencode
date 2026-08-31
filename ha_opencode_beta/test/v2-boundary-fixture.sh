#!/usr/bin/env bash
# shellcheck disable=SC2016 # Inner sh and JavaScript expand their own variables.

set -Eeuo pipefail

: "${OPENCODE_V2_VERSION:?OPENCODE_V2_VERSION is required}"

BOUNDARY_ROOT=$(mktemp -d)
RUNTIME_ROOT="${BOUNDARY_ROOT}/runtime"
GENERATION_ROOT="${BOUNDARY_ROOT}/generation"
CACHE_ROOT="${BOUNDARY_ROOT}/cache"
PROXY_PORT=18765
SERVER_PORT=4100
SIDECAR_PID=""
PROXY_PID=""
POLLER_PID=""
BROKER_PID=""
SECURE_PID=""
PROC_STOP="${CACHE_ROOT}/proc-stop"

cleanup() {
    local status=$?
    trap - EXIT INT TERM ERR
    set +e
    if [ "${status}" -ne 0 ]; then
        for log in sidecar proxy broker v2; do
            if [ -s "${BOUNDARY_ROOT}/${log}.log" ]; then
                printf '\n--- %s.log ---\n' "${log}" >&2
                cat "${BOUNDARY_ROOT}/${log}.log" >&2
            fi
        done
    fi
    touch "${PROC_STOP}" 2>/dev/null
    for pid in "${SIDECAR_PID}" "${SECURE_PID}" "${PROXY_PID}" "${BROKER_PID}" "${POLLER_PID}"; do
        [ -n "${pid}" ] && kill "${pid}" 2>/dev/null
    done
    for pid in "${SIDECAR_PID}" "${SECURE_PID}" "${PROXY_PID}" "${BROKER_PID}" "${POLLER_PID}"; do
        [ -n "${pid}" ] && wait "${pid}" 2>/dev/null
    done
    rm -rf "${BOUNDARY_ROOT}"
    return "${status}"
}
trap cleanup EXIT INT TERM

report_error() {
    local status=$?
    trap - ERR
    printf 'Boundary fixture failed at line %s (status %s): %s\n' \
        "${BASH_LINENO[0]}" "${status}" "${BASH_COMMAND}" >&2
    return "${status}"
}
trap report_error ERR

wait_for_status() {
    local expected=$1
    local url=$2
    local method=${3:-GET}
    local status
    for _attempt in $(seq 1 100); do
        status=$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 \
            -X "${method}" -w '%{http_code}' "${url}" 2>/dev/null || true)
        [ "${status}" = "${expected}" ] && return 0
        sleep 0.1
    done
    printf 'Expected HTTP %s from %s, got %s\n' "${expected}" "${url}" "${status:-unset}" >&2
    return 1
}

wait_for_api_match() {
    local path=$1
    local filter=$2
    local response
    for _attempt in $(seq 1 100); do
        response=$(curl -fsS --connect-timeout 1 --max-time 2 \
            -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
            "http://127.0.0.1:${SERVER_PORT}${path}" 2>/dev/null || true)
        if printf '%s' "${response}" | jq -e "${filter}" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.1
    done
    printf 'Expected API match %s from %s, got: %s\n' \
        "${filter}" "${path}" "${response:-empty response}" >&2
    return 1
}

assert_permission_effect() {
    local session_id=$1
    local action=$2
    local resource=$3
    local expected=$4
    local payload response
    payload=$(jq -cn --arg action "${action}" --arg resource "${resource}" \
        '{action:$action,resources:[$resource],agent:"home-assistant-read-only"}')
    response=$(curl -fsS --connect-timeout 1 --max-time 5 \
        -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
        -H 'Content-Type: application/json' -d "${payload}" \
        "http://127.0.0.1:${SERVER_PORT}/api/session/${session_id}/permission")
    if ! printf '%s' "${response}" | jq -e --arg expected "${expected}" \
        '.data.effect == $expected' >/dev/null; then
        printf 'Expected %s permission for %s %s, got: %s\n' \
            "${expected}" "${action}" "${resource}" "${response}" >&2
        return 1
    fi
}

start_sidecar() {
    rm -f "${RUNTIME_ROOT}/mcp-sidecar.ready"
    env -i HOME=/data USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
        SUPERVISOR_TOKEN=image-fixture-token OPENCODE_MCP_TOOL_PROFILE=full \
        OPENCODE_MCP_TRANSPORT=streamable-http \
        OPENCODE_MCP_SIDECAR_SOCKET="${RUNTIME_ROOT}/mcp-sidecar.sock" \
        OPENCODE_MCP_SIDECAR_PUBLIC_HOST="127.0.0.1:${PROXY_PORT}" \
        OPENCODE_MCP_SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" \
        OPENCODE_MCP_SIDECAR_READY_FILE="${RUNTIME_ROOT}/mcp-sidecar.ready" \
        LD_PRELOAD=/usr/local/lib/opencode-v2-non-dumpable.so \
        node /opt/ha-mcp-server/index.js >>"${BOUNDARY_ROOT}/sidecar.log" 2>&1 &
    SIDECAR_PID=$!
}

mkdir -p "${BOUNDARY_ROOT}/private" "${RUNTIME_ROOT}/home" \
    "${RUNTIME_ROOT}/config/opencode" "${RUNTIME_ROOT}/workspace" \
    "${GENERATION_ROOT}/data" "${GENERATION_ROOT}/state" "${CACHE_ROOT}"
chmod 711 "${BOUNDARY_ROOT}"
chmod 700 "${BOUNDARY_ROOT}/private"
chmod 755 "${RUNTIME_ROOT}" "${RUNTIME_ROOT}/home" "${RUNTIME_ROOT}/config" \
    "${RUNTIME_ROOT}/config/opencode" "${RUNTIME_ROOT}/workspace"
chown -R 60000:60000 "${GENERATION_ROOT}" "${CACHE_ROOT}"
printf '%s\n' private > "${BOUNDARY_ROOT}/private/sentinel"
printf '%064d' 0 > "${RUNTIME_ROOT}/sidecar-secret"
printf '%064d' 1 > "${RUNTIME_ROOT}/server-password"
chmod 600 "${RUNTIME_ROOT}/sidecar-secret" "${RUNTIME_ROOT}/server-password"
cp /opt/ha-mcp-server/AGENTS.md "${RUNTIME_ROOT}/config/opencode/AGENTS.md"
node /opt/opencode-v2-homeassistant/managed-config.js --restrict-sensitive-files false --plugin-enabled true \
    --mcp-endpoint "http://127.0.0.1:${PROXY_PORT}/mcp" > "${RUNTIME_ROOT}/managed.json"

V2_RUNTIME_ROOT="${RUNTIME_ROOT}" s6-tcpserver -q -c 16 127.0.0.1 "${PROXY_PORT}" \
    /bin/bash /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/connect \
    >"${BOUNDARY_ROOT}/proxy.log" 2>&1 &
PROXY_PID=$!
wait_for_status 503 "http://127.0.0.1:${PROXY_PORT}/mcp" POST
if runuser -u opencode-v2 -- python3 -c \
    "import socket; s=socket.socket(); s.bind(('127.0.0.1',${PROXY_PORT}))" \
    >/dev/null 2>&1; then
    echo "UID 60000 replaced the root proxy listener" >&2
    exit 1
fi

start_sidecar
wait_for_status 401 "http://127.0.0.1:${PROXY_PORT}/mcp" POST

PROC_CAPTURE="${CACHE_ROOT}/proc-capture"
: > "${PROC_CAPTURE}"
chown 60000:60000 "${PROC_CAPTURE}"
runuser -u opencode-v2 -- env -i PATH=/usr/local/bin:/usr/bin:/bin \
    PROC_CAPTURE="${PROC_CAPTURE}" PROC_STOP="${PROC_STOP}" \
    sh -c 'while [ ! -e "${PROC_STOP}" ]; do for status in /proc/[0-9]*/status; do pid=${status#/proc/}; pid=${pid%/status}; [ "$(awk '\''/^Uid:/ {print $2}'\'' "${status}" 2>/dev/null || true)" = 60000 ] || continue; cat "/proc/${pid}/cmdline" "/proc/${pid}/environ" "/proc/${pid}/fd/3" >> "${PROC_CAPTURE}" 2>/dev/null || true; done; done' &
POLLER_PID=$!

/usr/local/bin/opencode-v2-credential-broker "${RUNTIME_ROOT}" \
    >"${BOUNDARY_ROOT}/broker.log" 2>&1 &
BROKER_PID=$!
for _attempt in $(seq 1 100); do
    [ -S "${RUNTIME_ROOT}/credential.sock" ] && break
    sleep 0.1
done
test -S "${RUNTIME_ROOT}/credential.sock"

/usr/local/bin/opencode-v2-launch "${RUNTIME_ROOT}" "${GENERATION_ROOT}" \
    "${CACHE_ROOT}" "${SERVER_PORT}" >"${BOUNDARY_ROOT}/v2.log" 2>&1 &
SECURE_PID=$!
for _attempt in $(seq 1 100); do
    if [ "$(curl -sS -o /dev/null --connect-timeout 1 --max-time 2 \
        -w '%{http_code}' -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
        "http://127.0.0.1:${SERVER_PORT}/global/health" 2>/dev/null || true)" = "200" ]; then
        break
    fi
    sleep 0.1
done
curl -fsS --max-time 2 -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
    "http://127.0.0.1:${SERVER_PORT}/global/health" >/dev/null
kill -0 "${BROKER_PID}"
test ! -e "${RUNTIME_ROOT}/v2.pid"
test "$(awk '/^Uid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "60000:60000:60000"
test "$(awk '/^Gid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "60000:60000:60000"
grep -q '^NoNewPrivs:[[:space:]]*1' "/proc/${SECURE_PID}/status"
grep -q '^CapBnd:[[:space:]]*0000000000000000' "/proc/${SECURE_PID}/status"
if runuser -u opencode-v2 -- cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then
    echo "UID 60000 can inspect the staged server environment" >&2
    exit 1
fi
if runuser -u opencode-v2 -- test -r "${BOUNDARY_ROOT}/private/sentinel"; then
    echo "UID 60000 can read a root-private fixture path" >&2
    exit 1
fi

wait_for_api_match /api/plugin \
    '.data[] | select(.id == "homeassistant.runtime-guard" and .status == "active")'
wait_for_api_match /api/plugin \
    '.data[] | select(.id == "homeassistant.mcp" and .status == "active")'
wait_for_api_match /api/agent/home-assistant-read-only \
    '.data as $agent
     | ($agent.id == "home-assistant-read-only" and $agent.mode == "primary")
       and any($agent.permissions[]; .action == "*" and .resource == "*" and .effect == "deny")
       and any($agent.permissions[]; .action == "read" and .resource == "*" and .effect == "allow")
       and any($agent.permissions[]; .action == "glob" and .resource == "*" and .effect == "allow")
       and any($agent.permissions[]; .action == "homeassistant_*" and .resource == "*" and .effect == "deny")
       and any($agent.permissions[]; .action == "homeassistant_get_states" and .resource == "*" and .effect == "allow")
       and (["homeassistant_call_service", "homeassistant_write_config_safe", "homeassistant_remember_decision"]
         | all(. as $action
           | all($agent.permissions[]; .action != $action or .effect != "allow")))
       and any($agent.permissions[]; .action == "read" and .resource == "*secrets.yaml" and .effect == "deny")'

SESSION_RESPONSE=$(curl -fsS --connect-timeout 1 --max-time 5 \
    -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
    -H 'Content-Type: application/json' \
    -d '{"title":"V2 read-only permission fixture","agent":"home-assistant-read-only"}' \
    "http://127.0.0.1:${SERVER_PORT}/api/session")
SESSION_ID=$(printf '%s' "${SESSION_RESPONSE}" | jq -r '.data.id // empty')
case "${SESSION_ID}" in ses_*) ;; *) echo "V2 permission fixture did not create a session" >&2; exit 1 ;; esac
for action in edit shell subagent lsp grep future_native_action homeassistant_call_service homeassistant_write_config_safe homeassistant_future_mutation; do
    assert_permission_effect "${SESSION_ID}" "${action}" "*" deny
done
assert_permission_effect "${SESSION_ID}" read /homeassistant/configuration.yaml allow
assert_permission_effect "${SESSION_ID}" glob '**/*.yaml' allow
assert_permission_effect "${SESSION_ID}" external_directory /homeassistant/configuration.yaml allow
assert_permission_effect "${SESSION_ID}" homeassistant_get_states "*" allow
for resource in \
    /homeassistant/secrets.yaml \
    /homeassistant/.storage/core.config \
    /homeassistant/.cloud/account \
    /homeassistant/ssl/certificate \
    /homeassistant/private.key \
    /homeassistant/private.pem; do
    assert_permission_effect "${SESSION_ID}" read "${resource}" deny
done
curl -fsS --max-time 2 -u "opencode:$(cat "${RUNTIME_ROOT}/server-password")" \
    "http://127.0.0.1:${SERVER_PORT}/api/health" >/dev/null
if runuser -u opencode-v2 -- cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then
    echo "UID 60000 can inspect the activated server environment" >&2
    exit 1
fi

touch "${PROC_STOP}"
wait "${POLLER_PID}"
POLLER_PID=""
if grep -F -f "${RUNTIME_ROOT}/server-password" "${PROC_CAPTURE}" >/dev/null; then exit 1; fi
if grep -F -f "${RUNTIME_ROOT}/sidecar-secret" "${PROC_CAPTURE}" >/dev/null; then exit 1; fi
test ! -e "/proc/${SECURE_PID}/fd/3"
if tr '\0' '\n' < "/proc/${SECURE_PID}/cmdline" \
    | grep -F -f "${RUNTIME_ROOT}/server-password" >/dev/null; then exit 1; fi

SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" \
SIDECAR_URL="http://127.0.0.1:${PROXY_PORT}/mcp" node --input-type=module -e \
    'import { readFileSync } from "node:fs"; import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"; import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"; const secret=readFileSync(process.env.SIDECAR_SECRET_FILE,"utf8").trim(); const client=new Client({name:"image-fixture",version:"1"}); const transport=new StreamableHTTPClientTransport(new URL(process.env.SIDECAR_URL),{requestInit:{headers:{authorization:`Bearer ${secret}`}}}); await client.connect(transport); const tools=await client.listTools(); if (!tools.tools.some((tool)=>tool.name==="get_states")) process.exit(1); if (!tools.tools.some((tool)=>tool.name==="call_service")) process.exit(1); await client.close();'

echo "V2 Linux boundary fixture passed (${OPENCODE_V2_VERSION})"
