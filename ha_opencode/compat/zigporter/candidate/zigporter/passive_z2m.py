"""Bounded receive-only Z2M frontend reader. No MQTT application messages sent."""
import asyncio
import copy
import json
import ssl
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit, urlencode

import websockets
from zigporter.utils import parse_z2m_ieee_identifier


class PassiveReadError(RuntimeError):
    pass


def websocket_url(base, token=None):
    parts = urlsplit(base)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('Expected a frontend HTTP(S) base URL without credentials or query')
    return urlunsplit(('wss' if parts.scheme == 'https' else 'ws', parts.netloc,
                      parts.path.rstrip('/') + '/api', urlencode({'token': token}) if token else '', ''))


async def read_devices(base, *, token=None, duration=2.0, max_frames=4096):
    """Observe cached initial frames and updates for a bounded interval.

    Receipt time is NOT device report time. No subscription, map, refresh or
    control payload is sent. Unknown telemetry stays unknown.
    """
    if not 0 < duration <= 30 or not 1 <= max_frames <= 10000:
        raise ValueError('Invalid collection bounds')
    url = websocket_url(base, token)
    # HA's HA_VERIFY_SSL setting does not govern this separate transport.
    tls = {'ssl': ssl.create_default_context()} if url.startswith('wss://') else {}
    inventory = None
    observations = {}
    started = time.monotonic()
    try:
        async with asyncio.timeout(duration):
            async with websockets.connect(url, open_timeout=duration, close_timeout=0.2,
                                          max_size=1048576, max_queue=16,
                                          ping_interval=None, **tls) as ws:
                for _ in range(max_frames):
                    raw = await ws.recv()
                    if not isinstance(raw, str):
                        continue
                    try:
                        message = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    if not isinstance(message, dict):
                        continue
                    topic, payload = message.get('topic'), message.get('payload')
                    if topic == 'bridge/devices' and isinstance(payload, list):
                        inventory = []
                        seen = set()
                        for d in payload:
                            if not isinstance(d, dict) or not isinstance(d.get('ieee_address'), str):
                                continue
                            ieee = parse_z2m_ieee_identifier(d['ieee_address'])
                            if not ieee or ieee in seen:
                                continue
                            if not isinstance(d.get('friendly_name'), (str, type(None))):
                                continue
                            seen.add(ieee)
                            inventory.append(copy.deepcopy(d))
                    elif isinstance(topic, str) and not topic.startswith('bridge/'):
                        # Keep only diagnostic fields, never configuration or arbitrary state.
                        if topic.endswith('/availability'):
                            value = payload.get('state') if isinstance(payload, dict) else payload
                            if value in ('online', 'offline'):
                                observations.setdefault(topic[:-13], {})['availability'] = value
                        elif isinstance(payload, dict):
                            kept = {}
                            lqi = payload.get('linkquality')
                            if isinstance(lqi, (int, float)) and not isinstance(lqi, bool) and 0 <= lqi <= 255:
                                kept['linkquality'] = lqi
                            last_seen = payload.get('last_seen')
                            if isinstance(last_seen, (str, int, float)) and not isinstance(last_seen, bool):
                                kept['last_seen'] = last_seen
                            if kept:
                                observations.setdefault(topic, {}).update(kept)
                # A frame flood must not masquerade as a completed sample.
                raise PassiveReadError('Z2M passive read frame limit reached')
    except TimeoutError:
        pass
    except asyncio.CancelledError:
        raise
    except PassiveReadError:
        raise
    except Exception:
        # Do not leak token-bearing URLs, frames or server exception text.
        raise PassiveReadError('Z2M passive connection failed (authentication, network or protocol); no command sent') from None
    if inventory is None:
        raise PassiveReadError('Z2M inventory not received within collection window')
    received = datetime.now(timezone.utc).isoformat()
    for device in inventory:
        telemetry = {}
        for key in (device.get('ieee_address'), device.get('friendly_name')):
            if isinstance(key, str):
                telemetry.update(observations.get(key, {}))
        device['_diagnostics'] = {
            'source': 'z2m_frontend_websocket', 'received_at': received,
            'collection_seconds': round(time.monotonic() - started, 3),
            'freshness': 'cached_or_streamed; receipt does not prove a new device report',
            'last_seen': telemetry.get('last_seen'), 'linkquality': telemetry.get('linkquality'),
            'availability': telemetry.get('availability'), 'parent': None, 'routes': None,
        }
    return inventory
