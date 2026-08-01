#!/usr/bin/env bash
# Functional test for the startup-hook runner.
#
# Runs the shipped opencode-run-hooks against a sandbox, with the container's
# absolute paths rewritten onto it — the same approach as
# test-channel-separation.sh, so the code under test is the code that ships
# rather than a re-implementation of it.
#
#   scripts/test-startup-hooks.sh [stable|beta]
#
# Defaults to beta, which is where the feature lives.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL="${1:-beta}"
case "${CHANNEL}" in
    beta)   ADDON="ha_opencode_beta" ;;
    stable) ADDON="ha_opencode" ;;
    *)      echo "usage: $0 [stable|beta]" >&2; exit 2 ;;
esac

RUNNER_SRC="${REPO}/${ADDON}/rootfs/usr/local/bin/opencode-run-hooks"
CLI_SRC="${REPO}/${ADDON}/rootfs/usr/local/bin/ha-hooks"
CHANNEL_SRC="${REPO}/${ADDON}/rootfs/usr/local/lib/opencode/channel.sh"
SEED_SRC="${REPO}/${ADDON}/rootfs/opt/ha-mcp-server/startup-hooks"

if [ ! -f "${RUNNER_SRC}" ]; then
    echo "SKIP: ${ADDON} has no startup-hook runner (feature not in this channel yet)"
    exit 0
fi

WORK="${TMPDIR:-/tmp}/opencode-hooks-test"
PASS=0
FAIL=0
SB=""

check() { # description, condition-result
    if [ "$2" = "0" ]; then printf '    PASS  %s\n' "$1"; PASS=$((PASS + 1))
    else printf '    FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); fi
}

# Build a sandboxed copy of the runner: same code, container paths rewritten.
build_sandbox() { # name
    SB="${WORK}/$(printf '%s' "$1" | tr ' /' '__')"
    rm -rf "${SB}"
    mkdir -p "${SB}/data" "${SB}/homeassistant" "${SB}/opt/ha-mcp-server" \
             "${SB}/usr/local/lib/opencode"

    sed -e "s#/homeassistant#${SB}/homeassistant#g" \
        -e "s#/data#${SB}/data#g" \
        "${CHANNEL_SRC}" > "${SB}/usr/local/lib/opencode/channel.sh"

    sed -e "s#/homeassistant#${SB}/homeassistant#g" \
        -e "s#/data#${SB}/data#g" \
        -e "s#/opt/ha-mcp-server#${SB}/opt/ha-mcp-server#g" \
        -e "s#/usr/local/lib/opencode#${SB}/usr/local/lib/opencode#g" \
        "${RUNNER_SRC}" > "${SB}/runner"
    chmod +x "${SB}/runner"

    if [ -f "${CLI_SRC}" ]; then
        sed -e "s#/homeassistant#${SB}/homeassistant#g" \
            -e "s#/data#${SB}/data#g" \
            -e "s#/usr/local/lib/opencode#${SB}/usr/local/lib/opencode#g" \
            -e "s#/usr/local/bin/opencode-run-hooks#${SB}/runner#g" \
            "${CLI_SRC}" > "${SB}/ha-hooks"
        chmod +x "${SB}/ha-hooks"
    fi

    if [ -d "${SEED_SRC}" ]; then
        cp -r "${SEED_SRC}" "${SB}/opt/ha-mcp-server/startup-hooks"
    fi

    # Stable and beta put startup.d in different places; ask channel.sh rather
    # than hardcoding either.
    HOOKS_DIR="$(
        ADDON_CHANNEL="${CHANNEL}"
        # shellcheck disable=SC1090
        source "${SB}/usr/local/lib/opencode/channel.sh"
        printf '%s/startup.d' "${ADDON_STATE_DIR}"
    )"
    mkdir -p "${HOOKS_DIR}"
    STATE_DIR="${SB}/data/hooks"

    # The runner gates on this itself, not just in its callers.
    printf 'true\n' > "${SB}/data/.user_hooks_enabled"
}

run_hooks() { # extra args
    ADDON_CHANNEL="${CHANNEL}" "${SB}/runner" "$@" 2>&1
}

cli() { # ha-hooks args
    ADDON_CHANNEL="${CHANNEL}" "${SB}/ha-hooks" "$@" 2>&1
}

hook_status() { # name -> "<epoch> <rc> <secs>"
    cat "${STATE_DIR}/$1.status" 2>/dev/null || echo ""
}

hook_rc() { # name
    local s; s="$(hook_status "$1")"
    printf '%s' "$(echo "${s}" | awk '{print $2}')"
}

echo "=== startup hooks (${ADDON}) ==="

# -----------------------------------------------------------------------------
printf '\n  empty directory\n'
build_sandbox "empty"
OUT="$(run_hooks)"
check "does not fail when there is nothing to run" "$([ $? -eq 0 ] && echo 0 || echo 1)"
check "says so rather than staying silent" \
    "$(echo "${OUT}" | grep -q "no startup hooks" && echo 0 || echo 1)"
check "the manifest is silent when there is nothing to list" \
    "$([ -z "$(run_hooks --manifest)" ] && echo 0 || echo 1)"
check "seeds the README" \
    "$([ -f "${HOOKS_DIR}/README.md" ] && echo 0 || echo 1)"
check "substitutes the real folder into the README" \
    "$(grep -q "startup.d" "${HOOKS_DIR}/README.md" 2>/dev/null && ! grep -q '@@HOOKS_DIR@@' "${HOOKS_DIR}/README.md" 2>/dev/null && echo 0 || echo 1)"
check "seeds the inert example" \
    "$([ -f "${HOOKS_DIR}/10-example.sh.example" ] && echo 0 || echo 1)"
check "the example is inert (does not end in .sh)" \
    "$([ ! -f "${HOOKS_DIR}/10-example.sh" ] && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  ordering, isolation and exit codes\n'
build_sandbox "ordering"
printf '#!/usr/bin/env bash\necho FIRST\n'            > "${HOOKS_DIR}/10-a.sh"
printf '#!/usr/bin/env bash\necho SECOND\nexit 3\n'   > "${HOOKS_DIR}/20-b.sh"
printf '#!/usr/bin/env bash\necho THIRD\n'           > "${HOOKS_DIR}/30-c.sh"
OUT="$(run_hooks)"
check "runs every hook" \
    "$([ "$(echo "${OUT}" | grep -c ': running (timeout')" = "3" ] && echo 0 || echo 1)"
check "runs them in filename order" \
    "$(echo "${OUT}" | grep ': running (timeout' | head -1 | grep -q '10-a.sh' && echo 0 || echo 1)"
check "a failing hook does not stop the next one" \
    "$(echo "${OUT}" | grep -q '30-c.sh: ok' && echo 0 || echo 1)"
check "records exit 0 for a hook that succeeded" \
    "$([ "$(hook_rc 10-a.sh)" = "0" ] && echo 0 || echo 1)"
check "records the real exit code of a hook that failed" \
    "$([ "$(hook_rc 20-b.sh)" = "3" ] && echo 0 || echo 1)"
check "reports the failure rather than swallowing it" \
    "$(echo "${OUT}" | grep -q 'WARNING.*20-b.sh: exited 3' && echo 0 || echo 1)"
check "captures hook output to its own log" \
    "$(grep -q FIRST "${STATE_DIR}/10-a.sh.log" 2>/dev/null && echo 0 || echo 1)"
check "keeps each hook's output in its own file" \
    "$(! grep -q FIRST "${STATE_DIR}/20-b.sh.log" 2>/dev/null && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  what counts as a hook\n'
build_sandbox "selection"
printf '#!/usr/bin/env bash\necho RUN\n'   > "${HOOKS_DIR}/10-real.sh"
printf '#!/usr/bin/env bash\necho NOPE\n'  > "${HOOKS_DIR}/20-off.sh.disabled"
printf '#!/usr/bin/env bash\necho NOPE\n'  > "${HOOKS_DIR}/30-example.sh.example"
printf '#!/usr/bin/env bash\necho NOPE\n'  > "${HOOKS_DIR}/.40-hidden.sh"
printf ''                                  > "${HOOKS_DIR}/50-empty.sh"
printf '#!/usr/bin/env python3\nprint(1)\n' > "${HOOKS_DIR}/60-python.sh"
mkdir -p "${HOOKS_DIR}/70-adirectory.sh"
OUT="$(run_hooks)"
check "runs a plain .sh file" \
    "$(echo "${OUT}" | grep -q '10-real.sh: ok' && echo 0 || echo 1)"
check "ignores a renamed (.disabled) hook" \
    "$(! echo "${OUT}" | grep -q '20-off' && echo 0 || echo 1)"
check "ignores the shipped .example" \
    "$(! echo "${OUT}" | grep -q '30-example' && echo 0 || echo 1)"
check "ignores a dotfile" \
    "$(! echo "${OUT}" | grep -q '40-hidden' && echo 0 || echo 1)"
check "ignores a directory that ends in .sh" \
    "$(! echo "${OUT}" | grep -q '70-adirectory' && echo 0 || echo 1)"
check "skips an empty file instead of reporting an error" \
    "$(echo "${OUT}" | grep -q '50-empty.sh: empty file, skipped' && echo 0 || echo 1)"
check "refuses a non-shell shebang with an actionable message" \
    "$(echo "${OUT}" | grep -q '60-python.sh: only shell hooks' && echo 0 || echo 1)"
check "does not try to run the refused hook anyway" \
    "$([ "$(hook_rc 60-python.sh)" = "-" ] && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  a file saved on Windows\n'
build_sandbox "crlf"
printf '#!/usr/bin/env bash\r\necho CRLF_OK\r\n' > "${HOOKS_DIR}/10-crlf.sh"
OUT="$(run_hooks)"
check "warns about CRLF line endings" \
    "$(echo "${OUT}" | grep -q 'CRLF' && echo 0 || echo 1)"
check "runs it anyway instead of failing cryptically" \
    "$([ "$(hook_rc 10-crlf.sh)" = "0" ] && echo 0 || echo 1)"
check "the hook actually produced its output" \
    "$(grep -q CRLF_OK "${STATE_DIR}/10-crlf.sh.log" 2>/dev/null && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  a hook that hangs\n'
build_sandbox "timeout"
printf '#!/usr/bin/env bash\n# opencode-hook-timeout: 1\nsleep 30\n' > "${HOOKS_DIR}/10-hang.sh"
printf '#!/usr/bin/env bash\necho AFTER\n'                            > "${HOOKS_DIR}/20-after.sh"
START=$(date +%s)
OUT="$(run_hooks)"
ELAPSED=$(( $(date +%s) - START ))
check "honours the per-hook timeout comment" \
    "$([ "${ELAPSED}" -lt 20 ] && echo 0 || echo 1)"
check "reports the timeout as a timeout" \
    "$(echo "${OUT}" | grep -q '10-hang.sh: timed out' && echo 0 || echo 1)"
check "says how to start something long-running instead" \
    "$(echo "${OUT}" | grep -q 'setsid' && echo 0 || echo 1)"
check "keeps going after killing it" \
    "$(echo "${OUT}" | grep -q '20-after.sh: ok' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  running one hook by name\n'
build_sandbox "single"
printf '#!/usr/bin/env bash\necho A\n' > "${HOOKS_DIR}/10-a.sh"
printf '#!/usr/bin/env bash\necho B\n' > "${HOOKS_DIR}/20-b.sh"
OUT="$(run_hooks 20-b.sh)"
check "runs the named hook" \
    "$(echo "${OUT}" | grep -q '20-b.sh: ok' && echo 0 || echo 1)"
check "leaves the others alone" \
    "$(! echo "${OUT}" | grep -q '10-a.sh' && echo 0 || echo 1)"
OUT="$(run_hooks 99-nope.sh)"
check "says so when the name does not exist" \
    "$(echo "${OUT}" | grep -q 'no such hook' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  restart-loop breaker\n'
build_sandbox "breaker"
printf '#!/usr/bin/env bash\necho RUN\n' > "${HOOKS_DIR}/10-a.sh"
OUT="$(run_hooks --boot)"
check "runs on the first start" \
    "$(echo "${OUT}" | grep -q '10-a.sh: ok' && echo 0 || echo 1)"
OUT="$(run_hooks --boot)"
check "skips when the add-on restarts immediately" \
    "$(echo "${OUT}" | grep -q 'restart loop' && echo 0 || echo 1)"
OUT="$(run_hooks)"
check "a manual run is not blocked by the breaker" \
    "$(echo "${OUT}" | grep -q '10-a.sh: ok' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  manifest\n'
build_sandbox "manifest"
printf '#!/usr/bin/env bash\necho A\n' > "${HOOKS_DIR}/10-a.sh"
OUT="$(run_hooks --manifest)"
check "names the file" \
    "$(echo "${OUT}" | grep -q '10-a.sh' && echo 0 || echo 1)"
check "includes a digest so an unexpected hook is visible" \
    "$(echo "${OUT}" | grep -qE 'sha256 [0-9a-f]{12}' && echo 0 || echo 1)"
check "does not run anything" \
    "$([ ! -f "${STATE_DIR}/10-a.sh.status" ] && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  refuses a redirected hook folder\n'
build_sandbox "symlink"
rm -rf "${HOOKS_DIR}"
if ln -s "${SB}/elsewhere" "${HOOKS_DIR}" 2>/dev/null; then
    mkdir -p "${SB}/elsewhere"
    printf '#!/usr/bin/env bash\necho PWNED\n' > "${SB}/elsewhere/10-x.sh"
    OUT="$(run_hooks)"
    check "will not run hooks through a symlinked folder" \
        "$(echo "${OUT}" | grep -q 'symlink' && echo 0 || echo 1)"
    check "and runs nothing" \
        "$(! echo "${OUT}" | grep -q '10-x.sh: ok' && echo 0 || echo 1)"
else
    printf '    SKIP  symlink test (cannot create symlinks here — run on Linux to cover it)\n'
fi

# The neighbouring guard in ensure_hooks_dir, which needs no symlink support.
printf '\n  refuses a hook folder that is not a folder\n'
build_sandbox "notadir"
rm -rf "${HOOKS_DIR}"
printf 'i am a file\n' > "${HOOKS_DIR}"
OUT="$(run_hooks)"
check "will not proceed when startup.d is a regular file" \
    "$(echo "${OUT}" | grep -q 'not a directory' && echo 0 || echo 1)"
check "and does not overwrite it" \
    "$(grep -q 'i am a file' "${HOOKS_DIR}" 2>/dev/null && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  the option is the gate\n'
build_sandbox "gate"
printf '#!/usr/bin/env bash\necho SHOULD_NOT_RUN\n' > "${HOOKS_DIR}/10-a.sh"
rm -f "${SB}/data/.user_hooks_enabled"
rm -rf "${HOOKS_DIR}"
OUT="$(run_hooks)"
check "runs nothing when the option is off" \
    "$(! echo "${OUT}" | grep -q '10-a.sh' && echo 0 || echo 1)"
check "says why rather than failing silently" \
    "$(echo "${OUT}" | grep -q 'turned off' && echo 0 || echo 1)"
check "does not create a folder in the configuration directory when off" \
    "$([ ! -d "${HOOKS_DIR}" ] && echo 0 || echo 1)"
printf 'false\n' > "${SB}/data/.user_hooks_enabled"
OUT="$(run_hooks)"
check "an explicit false is also off" \
    "$(echo "${OUT}" | grep -q 'turned off' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  the user cannot redirect the sweep through env_vars\n'
build_sandbox "envvars"
printf '#!/usr/bin/env bash\necho RAN\n' > "${HOOKS_DIR}/10-a.sh"
# Exactly what the add-on's Environment variables option writes.
cat > "${SB}/data/.env_vars" <<EOF
export MODE=production
export HOOKS_DIR=/tmp/somewhere-else
export STATE_DIR=/tmp/elsewhere
EOF
OUT="$(run_hooks --manifest)"
check "--manifest still only lists, even with MODE hijacked" \
    "$(! echo "${OUT}" | grep -q ': running (timeout' && echo 0 || echo 1)"
check "and still lists the right hook" \
    "$(echo "${OUT}" | grep -q '10-a.sh' && echo 0 || echo 1)"
OUT="$(run_hooks)"
check "the sweep uses the add-on's folder, not the user's override" \
    "$(echo "${OUT}" | grep -q '10-a.sh: ok' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  running one hook obeys the same rules\n'
build_sandbox "named-run-filters"
printf '#!/usr/bin/env bash\necho REAL\n' > "${HOOKS_DIR}/10-real.sh"
printf '#!/usr/bin/env bash\necho OFF\n'  > "${HOOKS_DIR}/20-off.sh.off"
printf '#!/usr/bin/env bash\necho HID\n'  > "${HOOKS_DIR}/.30-hidden.sh"
printf 'not a hook\n'                     > "${HOOKS_DIR}/notes.txt"
OUT="$(run_hooks 20-off.sh.off)"
check "refuses a hook disabled by renaming" \
    "$(echo "${OUT}" | grep -q 'no such hook' && echo 0 || echo 1)"
OUT="$(run_hooks .30-hidden.sh)"
check "refuses a dotfile" \
    "$(echo "${OUT}" | grep -q 'no such hook' && echo 0 || echo 1)"
OUT="$(run_hooks notes.txt)"
check "refuses a file that is not a .sh" \
    "$(echo "${OUT}" | grep -q 'no such hook' && echo 0 || echo 1)"
check "and leaves no state behind for it" \
    "$([ ! -f "${STATE_DIR}/notes.txt.status" ] && echo 0 || echo 1)"
OUT="$(run_hooks 10-real.sh)"
check "still runs a real one" \
    "$(echo "${OUT}" | grep -q '10-real.sh: ok' && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  names that map to the same filename\n'
build_sandbox "collision"
printf '#!/usr/bin/env bash\necho FROM_SPACE\n'    > "${HOOKS_DIR}/10-a b.sh"
printf '#!/usr/bin/env bash\necho FROM_US\nexit 7\n' > "${HOOKS_DIR}/10-a_b.sh"
OUT="$(run_hooks)"
check "runs both" \
    "$([ "$(echo "${OUT}" | grep -c ': running (timeout')" = "2" ] && echo 0 || echo 1)"
check "does not report the successful one as failed" \
    "$(echo "${OUT}" | grep -q '10-a b.sh: ok' && echo 0 || echo 1)"
check "keeps their logs apart" \
    "$([ "$(grep -rl FROM_SPACE "${STATE_DIR}" 2>/dev/null | wc -l)" = "1" ] \
       && [ "$(grep -rl FROM_US "${STATE_DIR}" 2>/dev/null | wc -l)" = "1" ] \
       && [ "$(grep -rl FROM_SPACE "${STATE_DIR}" 2>/dev/null)" != "$(grep -rl FROM_US "${STATE_DIR}" 2>/dev/null)" ] \
       && echo 0 || echo 1)"

# -----------------------------------------------------------------------------
printf '\n  the shipped example\n'
build_sandbox "example"
if [ -f "${SB}/opt/ha-mcp-server/startup-hooks/10-example.sh.example" ]; then
    cp "${SB}/opt/ha-mcp-server/startup-hooks/10-example.sh.example" "${HOOKS_DIR}/10-example.sh"
    OUT="$(run_hooks)"
    check "runs as shipped without editing" \
        "$([ "$(hook_rc 10-example.sh)" = "0" ] && echo 0 || echo 1)"
    check "its timeout directive is inert until uncommented" \
        "$(echo "${OUT}" | grep -q '10-example.sh: running (timeout 900s)' && echo 0 || echo 1)"
    sed -i 's/^## opencode-hook-timeout: 1800/# opencode-hook-timeout: 1800/' "${HOOKS_DIR}/10-example.sh"
    OUT="$(run_hooks 10-example.sh)"
    check "and takes effect when one '#' is removed, as the file says" \
        "$(echo "${OUT}" | grep -q '10-example.sh: running (timeout 1800s)' && echo 0 || echo 1)"
else
    printf '    SKIP  example not present\n'
fi

# -----------------------------------------------------------------------------
printf '\n  ha-hooks\n'
build_sandbox "cli"
if [ ! -x "${SB}/ha-hooks" ]; then
    printf '    SKIP  ha-hooks not present\n'
else
    printf '#!/usr/bin/env bash\necho GOOD\n'          > "${HOOKS_DIR}/10-ok.sh"
    printf '#!/usr/bin/env bash\nexit 4\n'              > "${HOOKS_DIR}/20-bad.sh"
    printf ''                                          > "${HOOKS_DIR}/30-empty.sh"
    printf '#!/usr/bin/env python3\nprint(1)\n'         > "${HOOKS_DIR}/40-py.sh"
    run_hooks >/dev/null

    OUT="$(cli list)"
    check "list reports a successful hook as ok" \
        "$(echo "${OUT}" | grep -A1 '10-ok.sh' | grep -q 'ok' && echo 0 || echo 1)"
    check "list reports the real exit code of a failure" \
        "$(echo "${OUT}" | grep -q 'exit 4' && echo 0 || echo 1)"
    check "list distinguishes an empty hook from a refused one" \
        "$(echo "${OUT}" | grep -q 'skipped' && echo "${OUT}" | grep -q 'refused' && echo 0 || echo 1)"
    check "list shows a digest for each hook" \
        "$(echo "${OUT}" | grep -qE 'sha256 [0-9a-f]{12}' && echo 0 || echo 1)"
    check "list reports the feature as on" \
        "$(echo "${OUT}" | grep -q 'Status' && echo 0 || echo 1)"

    OUT="$(cli log 10-ok.sh)"
    check "log prints that hook's output" \
        "$(echo "${OUT}" | grep -q 'GOOD' && echo 0 || echo 1)"
    OUT="$(cli log 99-missing.sh)"
    check "log says so for a hook with no log" \
        "$(echo "${OUT}" | grep -q 'No log for' && echo 0 || echo 1)"

    cli run --boot >/dev/null 2>&1
    check "run refuses an option where a hook name belongs" \
        "$([ $? -ne 0 ] && echo 0 || echo 1)"
    OUT="$(cli run --boot)"
    check "and says why" \
        "$(echo "${OUT}" | grep -q 'is not a hook name' && echo 0 || echo 1)"

    OUT="$(cli)"
    check "bare ha-hooks prints usage" \
        "$(echo "${OUT}" | grep -q 'Usage: ha-hooks' && echo 0 || echo 1)"
    cli nonsense >/dev/null 2>&1
    check "an unknown command exits non-zero" \
        "$([ $? -ne 0 ] && echo 0 || echo 1)"

    printf 'false\n' > "${SB}/data/.user_hooks_enabled"
    OUT="$(cli run)"
    check "run refuses when the option is off" \
        "$(echo "${OUT}" | grep -q 'turned off' && echo 0 || echo 1)"
    OUT="$(cli list)"
    check "list still works when the option is off" \
        "$(echo "${OUT}" | grep -q '10-ok.sh' && echo 0 || echo 1)"

    # A sandbox with nothing set up at all: the state every user starts from.
    build_sandbox "cli-virgin"
    rm -rf "${HOOKS_DIR}" "${SB}/data/hooks" "${SB}/data/.user_hooks_enabled"
    OUT="$(cli list)"
    check "list works before the feature has ever been enabled" \
        "$(echo "${OUT}" | grep -q 'off' && echo 0 || echo 1)"
    OUT="$(cli log)"
    check "log with no argument is graceful with no sweep yet" \
        "$([ -n "${OUT}" ] && echo 0 || echo 1)"
fi

printf '\n=== %d passed, %d failed ===\n' "${PASS}" "${FAIL}"
[ "${FAIL}" = "0" ]
