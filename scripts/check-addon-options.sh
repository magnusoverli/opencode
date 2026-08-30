#!/bin/bash
# Verify that every simple bashio::config key read by an add-on exists in both
# the options and schema blocks of that add-on's own config.yaml.

set -euo pipefail

if [ "$#" -eq 0 ]; then
    set -- ha_opencode ha_opencode_beta
fi

status=0
for addon in "$@"; do
    if [ ! -d "${addon}/rootfs" ] || [ ! -f "${addon}/config.yaml" ]; then
        echo "error: ${addon} is not a complete add-on directory" >&2
        status=1
        continue
    fi

    undeclared=""
    while IFS= read -r key; do
        [ -n "${key}" ] || continue
        if [ "$(grep -cE "^[[:space:]]+${key}:" "${addon}/config.yaml")" -lt 2 ]; then
            undeclared="${undeclared}  ${key}"$'\n'
        fi
    done < <(
        grep -rhoE "bashio::config '[a-z0-9_]+" "${addon}/rootfs" \
            --exclude-dir=node_modules 2>/dev/null \
            | sed "s/bashio::config '//" | sort -u
    )

    if [ -n "${undeclared}" ]; then
        echo "error: ${addon} reads options missing from its own options/schema blocks:" >&2
        printf '%s' "${undeclared}" >&2
        status=1
    else
        echo "OK: ${addon} declares every option its rootfs reads"
    fi
done

exit "${status}"
