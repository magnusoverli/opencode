# Wrapper for hab: show a clear error when ESPHome commands are used
# without a configured access token, instead of letting hab fail cryptically.
hab() {
    if [ "$1" = "esphome" ] && [ -z "$HA_ACCESS_TOKEN" ]; then
        echo "Error: ESPHome tools require a Long-Lived Access Token." >&2
        echo "" >&2
        echo "To configure:" >&2
        echo "  1. Go to your Home Assistant Profile page (click your user icon)" >&2
        echo "  2. Scroll to Long-Lived Access Tokens and create one" >&2
        echo "  3. Go to Settings -> Add-ons -> OpenCode -> Configuration" >&2
        echo "  4. Paste the token into the 'access_token' field" >&2
        echo "  5. Restart the OpenCode add-on (with ESPHome already running)" >&2
        return 1
    fi
    command hab "$@"
}
