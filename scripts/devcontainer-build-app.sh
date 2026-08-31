#!/usr/bin/env bash

set -Eeuo pipefail

app=${1:-}
case "${app}" in
    ha_opencode)
        channel=stable
        ;;
    ha_opencode_beta)
        channel=beta
        ;;
    *)
        printf 'Usage: %s {ha_opencode|ha_opencode_beta}\n' "${0##*/}" >&2
        exit 2
        ;;
esac

workspace=${WORKSPACE_DIRECTORY:-$(git rev-parse --show-toplevel)}
app_dir="${workspace}/${app}"

case "$(uname -m)" in
    x86_64)
        ha_arch=amd64
        ;;
    aarch64 | arm64)
        ha_arch=aarch64
        ;;
    *)
        printf 'Unsupported development architecture: %s\n' "$(uname -m)" >&2
        exit 1
        ;;
esac

version=$(awk -F '"' '/^version: / { print $2; exit }' "${app_dir}/config.yaml")
image=$(awk -F '"' '/^image: / { print $2; exit }' "${app_dir}/config.yaml")
build_from=$(awk -v arch="${ha_arch}" '$1 == arch ":" { print $2; exit }' "${app_dir}/build.yaml")

if [ -z "${version}" ] || [ -z "${image}" ] || [ -z "${build_from}" ]; then
    echo "Cannot resolve version, image, or ${ha_arch} base image for ${app}" >&2
    exit 1
fi

build_args=(
    --build-arg "BUILD_FROM=${build_from}"
    --build-arg "BUILD_VERSION=${version}"
    --build-arg "BUILD_ARCH=${ha_arch}"
    --build-arg "ADDON_CHANNEL=${channel}"
)
while IFS= read -r build_arg; do
    build_args+=(--build-arg "${build_arg}")
done < <(
    awk '
        /^args:/ { in_args=1; next }
        in_args && /^[^ ]/ { exit }
        in_args && /^  [A-Z0-9_]+:/ {
            key=$1
            sub(/:$/, "", key)
            value=$2
            gsub(/^"|"$/, "", value)
            print key "=" value
        }
    ' "${app_dir}/build.yaml"
)

echo "Building ${image}:${version} from ${app} for ${ha_arch}"
docker build "${build_args[@]}" --tag "${image}:${version}" "${app_dir}"
