#!/usr/bin/env bash
# shellcheck disable=SC2016 # Inner sh and JavaScript expand their own variables.

set -Eeuo pipefail

: "${OPENCODE_V2_VERSION:?OPENCODE_V2_VERSION is required}"

BOUNDARY_ROOT=$(mktemp -d)
RUNTIME_ROOT="${BOUNDARY_ROOT}/runtime"
GENERATION_ROOT="${BOUNDARY_ROOT}/generation"
CACHE_ROOT="${BOUNDARY_ROOT}/cache"
PROXY_PORT=18765
NATIVE_PORT=18123
SERVER_PORT=4100
SIDECAR_PID=""
NATIVE_PID=""
PROXY_PID=""
BROKER_PID=""
SECURE_PID=""
PROVIDER_PID=""

cleanup() {
    local status=$?
    trap - EXIT INT TERM ERR
    set +e
    if [ "${status}" -ne 0 ]; then
        for log in native sidecar proxy broker v2 provider; do
            if [ -s "${BOUNDARY_ROOT}/${log}.log" ]; then
                printf '\n--- %s.log ---\n' "${log}" >&2
                cat "${BOUNDARY_ROOT}/${log}.log" >&2
            fi
        done
    fi
    for pid in "${SIDECAR_PID}" "${NATIVE_PID}" "${SECURE_PID}" "${PROXY_PID}" "${BROKER_PID}" "${PROVIDER_PID}"; do
        [ -n "${pid}" ] && kill "${pid}" 2>/dev/null
    done
    for pid in "${SIDECAR_PID}" "${NATIVE_PID}" "${SECURE_PID}" "${PROXY_PID}" "${BROKER_PID}" "${PROVIDER_PID}"; do
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

start_sidecar() {
    rm -f "${RUNTIME_ROOT}/mcp-sidecar.ready"
    env -i HOME=/data USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
        SUPERVISOR_TOKEN=image-fixture-token OPENCODE_MCP_TOOL_PROFILE=full \
        OPENCODE_MCP_ENABLED="${1:-true}" \
        OPENCODE_MCP_TRANSPORT=streamable-http \
        OPENCODE_MCP_SIDECAR_SOCKET="${RUNTIME_ROOT}/mcp-sidecar.sock" \
        OPENCODE_MCP_SIDECAR_PUBLIC_HOST="127.0.0.1:${PROXY_PORT}" \
        OPENCODE_MCP_SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" \
        OPENCODE_MCP_SIDECAR_READY_FILE="${RUNTIME_ROOT}/mcp-sidecar.ready" \
        OPENCODE_NATIVE_HA_MCP_ENABLED=true \
        HA_API_BASE_URL="http://127.0.0.1:${NATIVE_PORT}/api" \
        HA_NATIVE_MCP_API_ID=assist HA_NATIVE_MCP_ENDPOINT_MODE=keyed \
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
printf '%s\n' "${GENERATION_ROOT}" > "${RUNTIME_ROOT}/ready"
printf '%s\n' true > "${RUNTIME_ROOT}/mcp-enabled"
printf '%s\n' true > "${RUNTIME_ROOT}/native-mcp-enabled"
printf '%s\n' false > "${RUNTIME_ROOT}/lsp-enabled"
chmod 600 "${RUNTIME_ROOT}/sidecar-secret" "${RUNTIME_ROOT}/server-password"
chmod 600 "${RUNTIME_ROOT}/ready" "${RUNTIME_ROOT}/mcp-enabled" "${RUNTIME_ROOT}/native-mcp-enabled"
chmod 600 "${RUNTIME_ROOT}/lsp-enabled"
cp /opt/ha-mcp-server/AGENTS.md "${RUNTIME_ROOT}/config/opencode/AGENTS.md"
mkdir "${RUNTIME_ROOT}/reload-plugin"
cp /tmp/v2-caller-secret-plugin.js "${RUNTIME_ROOT}/reload-plugin/index.js"
# Bun canonicalizes query-string imports of file modules. Distinct physical
# copies exercise independent module generations through the public host API.
cp /opt/opencode-v2-homeassistant/external-mcp.js "${RUNTIME_ROOT}/reload-plugin/external-mcp.js"
cp /opt/opencode-v2-homeassistant/agent-capability-context.js "${RUNTIME_ROOT}/reload-plugin/agent-capability-context.js"
for generation in 0 1 2; do
    cp /opt/opencode-v2-homeassistant/plugin.js "${RUNTIME_ROOT}/reload-plugin/generation-${generation}.js"
done
printf '%s\n' '{"type":"module"}' > "${RUNTIME_ROOT}/reload-plugin/package.json"
node /tmp/v2-provider-startup-fixture.mjs serve "${RUNTIME_ROOT}" >"${BOUNDARY_ROOT}/provider.log" 2>&1 &
PROVIDER_PID=$!
wait_for_status 200 "http://127.0.0.1:18766/health"
for _attempt in $(seq 1 100); do
    [ -f "${RUNTIME_ROOT}/provider-fixture.ready" ] && break
    sleep 0.1
done
test -f "${RUNTIME_ROOT}/provider-fixture.ready"
node /opt/opencode-v2-homeassistant/managed-config.js --restrict-sensitive-files false --plugin-enabled true \
    --plugin-package "${RUNTIME_ROOT}/reload-plugin" \
    --mcp-endpoint "http://127.0.0.1:${PROXY_PORT}/mcp" --native-mcp-enabled true \
    --native-mcp-endpoint "http://127.0.0.1:${PROXY_PORT}/native-mcp" \
    --options-file "${RUNTIME_ROOT}/provider-options.json" \
    --environment-output "${RUNTIME_ROOT}/provider-env" \
    --external-mcp-output "${RUNTIME_ROOT}/external-mcp-enabled" \
    > "${RUNTIME_ROOT}/managed.json"
chown root:root "${RUNTIME_ROOT}/provider-env" "${RUNTIME_ROOT}/external-mcp-enabled"
chmod 600 "${RUNTIME_ROOT}/provider-env" "${RUNTIME_ROOT}/external-mcp-enabled"

NATIVE_PORT="${NATIVE_PORT}" node --input-type=module -e \
    'import { createServer } from "node:http"; const server=createServer((request,response)=>{ if(request.url==="/health"){response.writeHead(200).end("ok");return;} if(request.method!=="POST"||request.url!=="/api/mcp/assist"){response.writeHead(404).end();return;} if(request.headers.authorization!=="Bearer image-fixture-token"){response.writeHead(401).end();return;} let body=""; request.on("data",(chunk)=>{body+=chunk;}); request.on("end",()=>{const message=JSON.parse(body); let result=null; if(message.method==="initialize") result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fixture-native",version:"1"}}; if(message.method==="tools/list") result={tools:[{name:"HassTurnOn",description:"Fixture native tool",inputSchema:{type:"object",additionalProperties:false}}]}; if(result) response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result})); else response.writeHead(202).end();});}); server.listen(Number(process.env.NATIVE_PORT),"127.0.0.1");' \
    >"${BOUNDARY_ROOT}/native.log" 2>&1 &
NATIVE_PID=$!
wait_for_status 200 "http://127.0.0.1:${NATIVE_PORT}/health"

mkdir "${RUNTIME_ROOT}/workspace/.opencode"
if /usr/local/bin/opencode-v2-launch "${RUNTIME_ROOT}" "${GENERATION_ROOT}" \
    "${CACHE_ROOT}" "${SERVER_PORT}" "${RUNTIME_ROOT}/workspace" >/dev/null 2>&1; then
    echo "V2 server accepted project .opencode content" >&2
    exit 1
fi
rmdir "${RUNTIME_ROOT}/workspace/.opencode"

V2_RUNTIME_ROOT="${RUNTIME_ROOT}" s6-tcpserver -q -c 16 127.0.0.1 "${PROXY_PORT}" \
    /bin/bash /etc/s6-overlay/s6-rc.d/ha-opencode-v2-mcp-proxy/connect \
    >"${BOUNDARY_ROOT}/proxy.log" 2>&1 &
PROXY_PID=$!
wait_for_status 503 "http://127.0.0.1:${PROXY_PORT}/mcp" POST
wait_for_status 503 "http://127.0.0.1:${PROXY_PORT}/native-mcp" POST
if runuser -u opencode-v2 -- python3 -c \
    "import socket; s=socket.socket(); s.bind(('127.0.0.1',${PROXY_PORT}))" \
    >/dev/null 2>&1; then
    echo "UID 60000 replaced the root proxy listener" >&2
    exit 1
fi

start_sidecar
wait_for_status 401 "http://127.0.0.1:${PROXY_PORT}/mcp" POST
wait_for_status 401 "http://127.0.0.1:${PROXY_PORT}/native-mcp" POST

/usr/local/bin/opencode-v2-credential-broker "${RUNTIME_ROOT}" \
    >"${BOUNDARY_ROOT}/broker.log" 2>&1 &
BROKER_PID=$!
for _attempt in $(seq 1 100); do
    [ -S "${RUNTIME_ROOT}/credential.sock" ] && break
    sleep 0.1
done
test -S "${RUNTIME_ROOT}/credential.sock"

python3 /tmp/v2-caller-secret-native.py "${RUNTIME_ROOT}"

/usr/local/bin/opencode-v2-launch "${RUNTIME_ROOT}" "${GENERATION_ROOT}" \
    "${CACHE_ROOT}" "${SERVER_PORT}" "${RUNTIME_ROOT}/workspace" >"${BOUNDARY_ROOT}/v2.log" 2>&1 &
SECURE_PID=$!
wait_for_status 401 "http://127.0.0.1:${SERVER_PORT}/api/info"
kill -0 "${BROKER_PID}"
test ! -e "${RUNTIME_ROOT}/v2.pid"
test "$(awk '/^Uid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "0:0:0"
test "$(awk '/^Gid:/ {print $2":"$3":"$4}' "/proc/${SECURE_PID}/status")" = "0:0:0"
grep -q '^NoNewPrivs:[[:space:]]*1' "/proc/${SECURE_PID}/status"
if cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then
    echo "The root V2 server environment remains inspectable" >&2
    exit 1
fi

OPENCODE_V2_SELF_TEST_RUNTIME_ROOT="${RUNTIME_ROOT}" \
OPENCODE_V2_SELF_TEST_BASE_URL="http://127.0.0.1:${SERVER_PORT}" \
    /usr/local/bin/opencode-v2-self-test --quiet
if cat "/proc/${SECURE_PID}/environ" >/dev/null 2>&1; then
    echo "The activated root V2 server environment remains inspectable" >&2
    exit 1
fi

grep -q 'V2 caller credential module-reload regression passed' "${BOUNDARY_ROOT}/v2.log"
node /tmp/v2-provider-startup-fixture.mjs verify "${RUNTIME_ROOT}" "${SERVER_PORT}"
node /tmp/v2-lan-fixture.mjs "${RUNTIME_ROOT}" "${SERVER_PORT}"
if grep -qF 'fixture-startup-provider-key' "${BOUNDARY_ROOT}/v2.log"; then
    echo "Provider credential appeared in runtime logs" >&2
    exit 1
fi
if tr '\0' '\n' < "/proc/${SECURE_PID}/cmdline" \
    | grep -F -f "${RUNTIME_ROOT}/server-password" >/dev/null; then exit 1; fi

SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" \
SIDECAR_URL="http://127.0.0.1:${PROXY_PORT}/mcp" \
SIDECAR_NATIVE_URL="http://127.0.0.1:${PROXY_PORT}/native-mcp" node --input-type=module -e \
    'import { readFileSync } from "node:fs"; import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"; import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"; const secret=readFileSync(process.env.SIDECAR_SECRET_FILE,"utf8").trim(); async function list(url,name){const client=new Client({name,version:"1"}); const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${secret}`}}}); await client.connect(transport); const tools=(await client.listTools()).tools; await client.close(); return tools;} const tools=await list(process.env.SIDECAR_URL,"image-fixture"); if (!tools.some((tool)=>tool.name==="get_states")||!tools.some((tool)=>tool.name==="call_service")) process.exit(1); const nativeTools=await list(process.env.SIDECAR_NATIVE_URL,"image-native-fixture"); if (!nativeTools.some((tool)=>tool.name==="HassTurnOn")) process.exit(1);'

# Reuse the real sidecar/proxy with bundled tools disabled. Old authenticated
# clients must not retain /mcp access while the native catalogue still loads.
kill "${SIDECAR_PID}"
wait "${SIDECAR_PID}" || true
SIDECAR_PID=""
start_sidecar false
wait_for_status 404 "http://127.0.0.1:${PROXY_PORT}/mcp" POST
wait_for_status 401 "http://127.0.0.1:${PROXY_PORT}/native-mcp" POST
SIDECAR_SECRET_FILE="${RUNTIME_ROOT}/sidecar-secret" \
SIDECAR_URL="http://127.0.0.1:${PROXY_PORT}/mcp" \
SIDECAR_NATIVE_URL="http://127.0.0.1:${PROXY_PORT}/native-mcp" node --input-type=module -e \
    'import { readFileSync } from "node:fs"; import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"; import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"; const headers={authorization:`Bearer ${readFileSync(process.env.SIDECAR_SECRET_FILE,"utf8").trim()}`}; if ((await fetch(process.env.SIDECAR_URL,{method:"POST",headers})).status!==404) throw new Error("Disabled bundled route remained accessible"); const client=new Client({name:"image-native-only-fixture",version:"1"}); await client.connect(new StreamableHTTPClientTransport(new URL(process.env.SIDECAR_NATIVE_URL),{requestInit:{headers}})); if (!(await client.listTools()).tools.some(({name})=>name==="HassTurnOn")) throw new Error("Native-only catalogue missing"); await client.close();'

echo "V2 Linux boundary fixture passed (${OPENCODE_V2_VERSION}, including native-only sidecar)"
