def device_display_name(entry: dict) -> str:
    """Return a human-readable name for a device or entity registry entry."""
    return entry.get("name_by_user") or entry.get("name") or entry.get("id", "?")


def ieee_to_colon(normalized: str) -> str:
    """Convert 16-char normalized hex IEEE to colon-separated format for ZHA services."""
    return ":".join(normalized[i : i + 2] for i in range(0, 16, 2))


def normalize_ieee(ieee: str) -> str:
    """Normalize an IEEE address to a 16-char lowercase hex string (no separators or prefix)."""
    s = ieee.lower().replace(":", "").replace("-", "")
    if s.startswith("0x"):
        s = s[2:]
    return s.zfill(16)


def parse_z2m_ieee_identifier(identifier: str) -> str | None:
    """Extract a strict 16-char IEEE hex string from a Z2M-style identifier.

    Accepted forms:
    - zigbee2mqtt_0x0011223344556677
    - zigbee2mqtt_0011223344556677
    - 0x0011223344556677
    - 0011223344556677
    - 00:11:22:33:44:55:66:77
    """
    s = identifier.strip().lower()
    if s.startswith("zigbee2mqtt_"):
        s = s[len("zigbee2mqtt_") :]
    s = s.replace(":", "").replace("-", "")
    if s.startswith("0x"):
        s = s[2:]
    if len(s) != 16:
        return None
    if any(c not in "0123456789abcdef" for c in s):
        return None
    return s
