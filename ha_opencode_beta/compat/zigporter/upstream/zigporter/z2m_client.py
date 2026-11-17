"""Zigbee2MQTT HTTP ingress client with three-tier auth fallback.

The client targets the Z2M HTTP API exposed through the Home Assistant
Supervisor ingress proxy. When direct ingress access is unavailable it
falls back to the HA WebSocket API for device queries and the
``mqtt.publish`` service for control commands.
"""

import asyncio
import json
import os
import time
from typing import Any

import httpx

from zigporter.utils import normalize_ieee, parse_z2m_ieee_identifier

# Seconds to wait for a Z2M network-map response before giving up.
# Large meshes need ~10 s per router; 600 s covers ~60 routers.
# Override via the Z2M_NETWORK_MAP_TIMEOUT env var (in seconds).
_NETWORK_MAP_TIMEOUT = int(os.environ.get("Z2M_NETWORK_MAP_TIMEOUT", "600"))


class Z2MClient:
    """Zigbee2MQTT client.

    Auth strategy for ingress requests:
      1. Try the request with ``Authorization: Bearer <token>`` directly.
         Works when HA ingress forwards the header (some reverse-proxy setups).
      2. If the response is not JSON, exchange the Bearer token for an ingress
         session cookie via ``POST /api/hassio/ingress/session`` and retry.
      3. If the session exchange fails (no Supervisor, proxy blocks the path,
         non-admin token), fall back to HA-native APIs:
         - Device listing / lookup: HA device registry via WebSocket
         - permit_join / rename: ``mqtt.publish`` service call via WebSocket

    The ``mqtt_topic`` parameter (default ``"zigbee2mqtt"``) must match the
    base topic configured in Z2M. Override via the ``Z2M_MQTT_TOPIC`` env var.
    """

    def __init__(
        self,
        ha_url: str | None,
        ha_token: str | None,
        z2m_url: str,
        verify_ssl: bool = True,
        mqtt_topic: str = "zigbee2mqtt",
        z2m_frontend_token: str | None = None,
    ) -> None:
        """
        Args:
            ha_url: Base URL of the Home Assistant instance
                (e.g. ``"http://homeassistant.local:8123"``). Optional — pass
                ``None`` or ``""`` for standalone Z2M mode (no HA).
            ha_token: Long-lived HA access token. Used for ingress session
                exchange and as the fallback HA-native client credential.
                Optional in standalone mode.
            z2m_url: Full ingress URL for the Z2M add-on or standalone Z2M
                instance (e.g. ``"http://z2m-host:8080"``).
            verify_ssl: Set to ``False`` to disable TLS certificate verification
                for self-signed certificates.
            mqtt_topic: Z2M base MQTT topic. Must match the ``base_topic``
                setting in your Z2M configuration (default: ``"zigbee2mqtt"``).
            z2m_frontend_token: Optional Z2M frontend auth token
                (``frontend.auth_token`` in Z2M config). Used for direct
                WebSocket auth in standalone mode.
        """
        self._ha_url = (ha_url or "").rstrip("/")
        self._ha_token = ha_token or ""
        self._z2m_url = z2m_url.rstrip("/")
        self._verify_ssl = verify_ssl
        self._mqtt_topic = mqtt_topic
        self._z2m_frontend_token = z2m_frontend_token
        self._session_token: str | None = None
        self._ha_client_instance: Any = None

    # ------------------------------------------------------------------
    # Ingress HTTP path
    # ------------------------------------------------------------------

    async def _get_ingress_session(self) -> str:
        """Exchange the HA Bearer token for an ingress session cookie."""
        async with httpx.AsyncClient(verify=self._verify_ssl) as client:
            resp = await client.post(
                f"{self._ha_url}/api/hassio/ingress/session",
                headers={
                    "Authorization": f"Bearer {self._ha_token}",
                    "Content-Type": "application/json",
                },
                json={},
            )
            if resp.status_code == 401:
                raise RuntimeError(
                    "Could not create an ingress session (401). "
                    "Falling back to HA device-registry and MQTT service calls."
                )
            resp.raise_for_status()
            data = resp.json()
            return data["data"]["session"] if "data" in data else data["session"]

    async def _session_headers(self) -> dict[str, str]:
        if not self._session_token:
            self._session_token = await self._get_ingress_session()
        return {"Cookie": f"ingress_session={self._session_token}"}

    @staticmethod
    def _is_json_response(resp: httpx.Response) -> bool:
        return "application/json" in resp.headers.get("content-type", "")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Execute an HTTP request with 3-tier auth fallback (Bearer → session cookie → refresh)."""
        bearer = {"Authorization": f"Bearer {self._ha_token}"}
        url = f"{self._z2m_url}{path}"
        async with httpx.AsyncClient(verify=self._verify_ssl) as client:
            resp = await client.request(method, url, headers=bearer, **kwargs)
            if resp.status_code not in (401, 403) and self._is_json_response(resp):
                resp.raise_for_status()
                return resp.json()

            # Bearer not accepted — fall back to ingress session cookie
            headers = await self._session_headers()
            resp = await client.request(method, url, headers=headers, **kwargs)
            if resp.status_code == 401:
                self._session_token = None
                headers = await self._session_headers()
                resp = await client.request(method, url, headers=headers, **kwargs)
            resp.raise_for_status()
            return resp.json()

    async def _get(self, path: str) -> Any:
        return await self._request("GET", path)

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        return await self._request("POST", path, json=body)

    # ------------------------------------------------------------------
    # HA-native fallback path
    # ------------------------------------------------------------------

    def _ha_client(self) -> Any:
        if self._ha_client_instance is None:
            from zigporter.ha_client import HAClient

            self._ha_client_instance = HAClient(self._ha_url, self._ha_token, self._verify_ssl)
        return self._ha_client_instance

    async def _get_devices_via_ha(self) -> list[dict[str, Any]]:
        """Get Z2M devices from the HA device registry.

        Z2M registers each device with an MQTT-platform identifier of the form
        ``zigbee2mqtt_0x<ieee_hex>``.  We filter for those and reconstruct the
        same dict shape that the Z2M REST API returns.
        """
        registry = await self._ha_client().get_device_registry()
        devices = []
        for entry in registry:
            ieee_hex = None
            for platform, identifier in entry.get("identifiers", []):
                if platform == "mqtt":
                    ieee_hex = parse_z2m_ieee_identifier(identifier)
                    if ieee_hex:
                        break
            if ieee_hex is None:
                continue

            manufacturer = entry.get("manufacturer") or ""
            model = entry.get("model") or ""
            devices.append(
                {
                    "ieee_address": f"0x{ieee_hex}",
                    "friendly_name": entry.get("name_by_user")
                    or entry.get("name")
                    or f"0x{ieee_hex}",
                    "type": "EndDevice",
                    "manufacturer": manufacturer,
                    "model_id": model,
                    "definition": {"vendor": manufacturer, "model": model},
                    "power_source": "",
                    "supported": True,
                }
            )
        return devices

    async def _mqtt_publish(self, topic: str, payload: str) -> None:
        """Publish an MQTT message via HA's ``mqtt.publish`` service."""
        await self._ha_client().call_service(
            "mqtt", "publish", {"topic": topic, "payload": payload}
        )

    async def _get_network_map_via_mqtt(
        self, timeout: int = _NETWORK_MAP_TIMEOUT
    ) -> dict[str, Any]:
        """Fetch the Z2M network map via HA WebSocket MQTT subscribe+publish.

        Used when the Z2M HTTP REST API is unavailable (Z2M 2.x removed it).
        Opens a single HA WebSocket connection, subscribes to the response topic,
        publishes the map request, then waits up to ``timeout`` seconds for Z2M
        to reply (default: ``_NETWORK_MAP_TIMEOUT``).  Large meshes with many
        routers require longer timeouts — Z2M polls each router sequentially.
        """
        ha = self._ha_client()
        response_topic = f"{self._mqtt_topic}/bridge/response/networkmap"
        request_topic = f"{self._mqtt_topic}/bridge/request/networkmap"

        async with ha._ws_session() as ws:
            # Send both commands before reading any responses so that we
            # dispatch by id/type in a single loop.  This avoids an ordering
            # assumption: if HA buffers an early event before the publish ACK,
            # the sequential read approach would misinterpret it.

            # 1. Subscribe to the networkmap response topic (id=1)
            await ws.send(json.dumps({"id": 1, "type": "mqtt/subscribe", "topic": response_topic}))

            # 2. Publish the network map request via call_service (id=2)
            await ws.send(
                json.dumps(
                    {
                        "id": 2,
                        "type": "call_service",
                        "domain": "mqtt",
                        "service": "publish",
                        "service_data": {
                            "topic": request_topic,
                            "payload": json.dumps({"type": "raw"}),
                        },
                    }
                )
            )

            # 3. Process all messages: validate ACKs and wait for the Z2M response event.
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"Timed out after {timeout}s waiting for Z2M network map")
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    raise RuntimeError(f"Timed out after {timeout}s waiting for Z2M network map")

                msg = json.loads(raw)
                msg_id = msg.get("id")
                msg_type = msg.get("type")

                # Validate subscribe ACK (id=1, type=result)
                if msg_id == 1 and msg_type == "result":
                    if not msg.get("success"):
                        raise RuntimeError(f"mqtt/subscribe failed: {msg}")
                    continue

                # Validate publish ACK (id=2, type=result)
                if msg_id == 2 and msg_type == "result":
                    if not msg.get("success"):
                        raise RuntimeError(f"mqtt.publish call_service failed: {msg}")
                    continue

                # Network map response event arrives on subscription id=1
                if msg_type != "event" or msg_id != 1:
                    continue

                event = msg.get("event", {})
                payload_str = event.get("payload", "{}")
                try:
                    payload = json.loads(payload_str)
                except (json.JSONDecodeError, ValueError):
                    continue

                if payload.get("status") == "ok":
                    # Z2M wraps the data in a "value" key for raw maps
                    data = payload.get("data", {})
                    inner = data.get("value", data)
                    return {"data": inner}

                if payload.get("status") == "error":
                    raise RuntimeError(f"Z2M network map error: {payload.get('error', 'unknown')}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_devices(self) -> list[dict[str, Any]]:
        """Return the full Z2M device list."""
        try:
            return await self._get("/api/devices")
        except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError):
            return await self._get_devices_via_ha()

    async def get_device_by_ieee(self, ieee: str) -> dict[str, Any] | None:
        """Find a Z2M device by IEEE address. Returns None if not found."""
        devices = await self.get_devices()
        target = normalize_ieee(ieee)
        for device in devices:
            if normalize_ieee(device.get("ieee_address", "")) == target:
                return device
        return None

    async def enable_permit_join(self, seconds: int = 120) -> None:
        """Open the Z2M network for new devices to join."""
        try:
            await self._post("/api/permit_join", {"time": seconds, "device": None})
        except RuntimeError:
            await self._mqtt_publish(
                f"{self._mqtt_topic}/bridge/request/permit_join",
                json.dumps({"time": seconds}),
            )

    async def disable_permit_join(self) -> None:
        """Close the Z2M network to new joiners."""
        try:
            await self._post("/api/permit_join", {"time": 0, "device": None})
        except RuntimeError:
            await self._mqtt_publish(
                f"{self._mqtt_topic}/bridge/request/permit_join",
                json.dumps({"time": 0}),
            )

    async def get_network_map(self, timeout: int = _NETWORK_MAP_TIMEOUT) -> dict[str, Any]:
        """Return the raw Z2M network map (nodes + links).

        When no HA URL is configured (standalone Z2M mode), connects directly
        to the Z2M frontend WebSocket at ``<z2m_url>/api``.

        Otherwise, tries the Z2M HTTP REST endpoint first. Z2M 2.x removed
        that endpoint, so falls back to subscribing to the MQTT response topic
        and publishing the request via HA's WebSocket ``call_service`` API.

        ``timeout`` controls how long to wait for Z2M to respond via MQTT.
        Large meshes with many routers need more time — Z2M scans each router
        sequentially, so allow ~10 s per router.
        """
        if not self._ha_url:
            return await self._get_network_map_via_z2m_ws(timeout=timeout)
        try:
            return await self._get("/api/networkmap?type=raw")
        except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError):
            return await self._get_network_map_via_mqtt(timeout=timeout)

    async def _get_network_map_via_z2m_ws(
        self, timeout: int = _NETWORK_MAP_TIMEOUT
    ) -> dict[str, Any]:
        """Fetch Z2M network map via direct Z2M frontend WebSocket (standalone, no HA).

        Connects to ws://<z2m-host>/api — Z2M's built-in frontend WebSocket.
        Optionally authenticates via ?token=<z2m_frontend_token> if set.

        Note: the Z2M frontend WS protocol uses bare topic names (e.g.
        ``bridge/request/networkmap``), without the MQTT base-topic prefix.
        This differs from the HA MQTT path which uses the full topic
        (``zigbee2mqtt/bridge/request/networkmap``).
        """
        import ssl as _ssl  # noqa: PLC0415

        import websockets  # noqa: PLC0415

        ws_url = (
            self._z2m_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
            + "/api"
        )
        if self._z2m_frontend_token:
            ws_url += f"?token={self._z2m_frontend_token}"

        ssl_ctx: _ssl.SSLContext | None = None
        if ws_url.startswith("wss://") and not self._verify_ssl:
            ssl_ctx = _ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = _ssl.CERT_NONE

        # Z2M frontend WS uses bare topics (no MQTT base-topic prefix).
        response_topic = "bridge/response/networkmap"
        request_topic = "bridge/request/networkmap"

        try:
            ws_conn = websockets.connect(ws_url, ssl=ssl_ctx)
        except Exception as exc:
            raise RuntimeError(
                f"Could not connect to Z2M WebSocket at {ws_url.split('?')[0]}: {exc}"
            ) from exc

        try:
            async with ws_conn as ws:
                await ws.send(
                    json.dumps(
                        {
                            "topic": request_topic,
                            "payload": {"type": "raw", "routes": True},
                        }
                    )
                )

                deadline = time.monotonic() + timeout
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RuntimeError(
                            f"Timed out after {timeout}s waiting for Z2M network map"
                        )
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    except asyncio.TimeoutError:
                        raise RuntimeError(
                            f"Timed out after {timeout}s waiting for Z2M network map"
                        )

                    msg = json.loads(raw)
                    if msg.get("topic") != response_topic:
                        continue

                    payload = msg.get("payload", {})
                    if isinstance(payload, str):
                        payload = json.loads(payload)

                    if payload.get("status") == "ok":
                        data = payload.get("data", {})
                        return {"data": data.get("value", data)}

                    if payload.get("status") == "error":
                        raise RuntimeError(
                            f"Z2M network map error: {payload.get('error', 'unknown')}"
                        )
        except (OSError, Exception) as exc:
            if isinstance(exc, RuntimeError):
                raise
            raise RuntimeError(
                f"Could not connect to Z2M WebSocket at {ws_url.split('?')[0]}: {exc}"
            ) from exc

    async def remove_device(self, friendly_name: str, force: bool = True) -> None:
        """Remove a device from Z2M by friendly name (HTTP fallback -> MQTT)."""
        try:
            await self._post("/api/device/remove", {"id": friendly_name, "force": force})
        except (RuntimeError, httpx.HTTPStatusError, httpx.RequestError):
            await self._mqtt_publish(
                f"{self._mqtt_topic}/bridge/request/device/remove",
                json.dumps({"id": friendly_name, "force": force}),
            )

    async def rename_device(self, current_name: str, new_name: str) -> None:
        """Rename a Z2M device by its current friendly name."""
        try:
            await self._post("/api/device", {"id": current_name, "rename": new_name})
        except RuntimeError:
            # homeassistant_rename=True also updates HA entity IDs
            await self._mqtt_publish(
                f"{self._mqtt_topic}/bridge/request/device/rename",
                json.dumps({"from": current_name, "to": new_name, "homeassistant_rename": True}),
            )

    async def wait_for_interview(
        self,
        ieee: str,
        timeout: int = 300,
        on_event: Any = None,
    ) -> tuple[str, dict[str, Any] | None]:
        """Subscribe to Z2M bridge events and wait for device interview completion.

        Subscribes to ``zigbee2mqtt/bridge/event`` via HA WebSocket and streams
        events until the target device's interview completes, fails, or the
        timeout expires.

        ``on_event(event_type, data)`` is called for every bridge event received
        so the caller can display status updates or detect unexpected joiners.

        Returns a tuple ``(status, data)``:

        - ``("successful", data)`` — interview completed (or device re-announced)
        - ``("failed", data)``    — interview failed
        - ``("timeout", None)``   — timed out without a result
        """
        target = normalize_ieee(ieee)
        event_topic = f"{self._mqtt_topic}/bridge/event"
        ha = self._ha_client()
        deadline = time.monotonic() + timeout

        async with ha._ws_session() as ws:
            await ws.send(json.dumps({"id": 1, "type": "mqtt/subscribe", "topic": event_topic}))

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return "timeout", None

                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 2.0))
                except asyncio.TimeoutError:
                    continue

                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    continue

                # Validate subscribe ACK
                if msg.get("id") == 1 and msg.get("type") == "result":
                    if not msg.get("success"):
                        raise RuntimeError(f"mqtt/subscribe to bridge/event failed: {msg}")
                    continue

                if msg.get("type") != "event" or msg.get("id") != 1:
                    continue

                try:
                    payload = json.loads(msg.get("event", {}).get("payload", "{}"))
                except (json.JSONDecodeError, ValueError):
                    continue

                event_type = payload.get("type")
                data = payload.get("data") or {}

                if on_event is not None:
                    on_event(event_type, data)

                event_ieee = normalize_ieee(data.get("ieee_address", ""))
                if event_ieee != target:
                    continue

                # A device_announce means the device is already paired and working.
                if event_type == "device_announce":
                    return "successful", data

                if event_type == "device_interview":
                    interview_status = data.get("status")
                    if interview_status == "successful":
                        return "successful", data
                    if interview_status == "failed":
                        return "failed", data
