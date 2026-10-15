# Zigporter 1.4.2 compatibility fix

Build-time, hash-checked replacement of three package modules. Rejects unexpected source versions before mutation. No runtime patch hook, credential file, add-on permission change or release version bump.

The passive frontend WebSocket reader receives inventory and cached device state without sending application messages. Registry fallback skips malformed/non-pair identifiers and labels its limited provenance. Missing last-seen/availability remain unknown; it does not request a network map or prove parent/routes. Zigbee2MQTT TLS verification is independent of Home Assistant verification.

The regression suite includes the original HomeKit triple crash, malformed identifiers, bounded passive reads, transport failures and provenance. Remove/reassess this overlay when updating Zigporter. Maintainers may prefer upstreaming the package fix rather than carrying this overlay.

Only synthetic fixtures are included. No user network addresses, tokens, chats, backup archives or deployment-specific image metadata belong in this directory.
