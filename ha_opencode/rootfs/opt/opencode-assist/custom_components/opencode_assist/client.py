"""Scoped add-on client. No OpenCode administrative API access."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from time import perf_counter
from urllib.parse import urlsplit
from uuid import uuid4

import aiohttp
from homeassistant.exceptions import HomeAssistantError

_LOGGER = logging.getLogger(__name__)
_SAFE_ERROR_CODES = frozenset(
    {
        "assist_not_ready",
        "assist_plugin_failed",
        "assist_unavailable",
        "browser_requests_denied",
        "busy",
        "event_stream_failed",
        "generation_failed",
        "invalid_json",
        "invalid_request",
        "invalid_result",
        "json_required",
        "model_catalog_not_ready",
        "not_found",
        "request_too_large",
        "rpc.unavailable",
        "unauthorized",
        "unknown_request",
        "unavailable",
        "unsupported_model",
    }
)
_SAFE_EVENT_TYPES = frozenset({"done", "error", "request", "text", "tool_call"})
_SAFE_ORIGINS = frozenset({"ai_task", "non_satellite", "voice"})


def _log_diagnostic(event: str, **fields) -> None:
    """Log bounded, content-free Assist diagnostics."""
    record = {
        "component": "opencode_assist",
        "event": event,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **fields,
    }
    _LOGGER.info(
        "opencode_assist_diag %s",
        json.dumps(record, separators=(",", ":"), sort_keys=True),
    )


async def _safe_response_error_code(response) -> str:
    """Read only a bounded, allowlisted code from an error response."""
    try:
        body = await response.content.read(4097)
        if len(body) > 4096:
            return "unclassified"
        data = json.loads(body)
    except (aiohttp.ClientError, TimeoutError, TypeError, ValueError):
        return "unclassified"

    code = data.get("error") if isinstance(data, dict) else None
    return code if isinstance(code, str) and code in _SAFE_ERROR_CODES else "unclassified"


def _safe_error_detail(error: BaseException) -> str:
    """Return a bounded category without exposing exception text."""
    if isinstance(error, AssistResponseError):
        return error.error_code
    if isinstance(error, AssistAuthError):
        return "pairing_rejected"
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, aiohttp.ServerDisconnectedError):
        return "server_disconnected"
    if isinstance(error, aiohttp.ClientConnectorError):
        return "connection_failed"
    if isinstance(error, aiohttp.ClientError):
        return "http_client_error"
    if isinstance(error, ValueError):
        return "invalid_event_or_json"
    if isinstance(error, HomeAssistantError):
        return "assistant_request_error"
    return "internal_error"


class AssistAuthError(HomeAssistantError):
    """The pairing credential was rejected or revoked."""


class AssistResponseError(HomeAssistantError):
    """A safe, classified non-success response from the companion."""

    def __init__(self, status: int, error_code: str) -> None:
        self.status = status
        self.error_code = error_code
        messages = {
            "assist_not_ready": "OpenCode Assist is still initializing",
            "assist_plugin_failed": "OpenCode Assist failed to initialize",
            "model_catalog_not_ready": "OpenCode Assist model catalog is still initializing",
            "unsupported_model": "The selected OpenCode Assist model is unsupported",
        }
        super().__init__(messages.get(error_code, "OpenCode Assist is unavailable"))


class AssistClient:
    """Use HA's managed HTTP session and keep active streams cancellable."""

    def __init__(self, session: aiohttp.ClientSession, url: str, key: str) -> None:
        parsed = urlsplit(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("Invalid add-on URL")
        self.session = session
        self.url = url.rstrip("/")
        self._key = key
        self._active: set[asyncio.Task] = set()

    async def close(self) -> None:
        """Cancel requests without closing HA's shared HTTP session."""
        tasks = list(self._active)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _request(
        self,
        method: str,
        path: str,
        *,
        request_id: str | None = None,
        request_origin: str | None = None,
        **kwargs,
    ):
        headers = {"Authorization": f"Bearer {self._key}"}
        if request_id is not None:
            headers["X-HA-Assist-Request-ID"] = request_id
        if request_origin in _SAFE_ORIGINS:
            headers["X-HA-Assist-Origin"] = request_origin
        return self.session.request(
            method, self.url + path, headers=headers,
            timeout=kwargs.pop("timeout", aiohttp.ClientTimeout(total=130, sock_read=130)),
            allow_redirects=False, **kwargs,
        )

    @staticmethod
    def _check(response, error_code: str = "unclassified") -> None:
        if response.status in (401, 403):
            raise AssistAuthError("OpenCode pairing must be renewed")
        if response.status != 200:
            if error_code in _SAFE_ERROR_CODES:
                raise AssistResponseError(response.status, error_code)
            raise HomeAssistantError("OpenCode Assist is unavailable")

    async def info(self) -> dict:
        try:
            async with self._request("GET", "/v1/info", timeout=aiohttp.ClientTimeout(total=10)) as response:
                self._check(response)
                data = await response.json()
                if data.get("version") != 1 or not isinstance(data.get("models"), list):
                    raise HomeAssistantError("Unsupported OpenCode Assist protocol")
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HomeAssistantError("Cannot connect to OpenCode Assist") from err

    async def onboard(self, pairing_key: str | None = None) -> dict:
        """Use a short-lived Supervisor bootstrap, never a user's HA token."""
        try:
            kwargs = {"json": {"key": pairing_key}} if pairing_key is not None else {}
            async with self._request("POST" if pairing_key is not None else "GET", "/v1/onboarding",
                                     timeout=aiohttp.ClientTimeout(total=10), **kwargs) as response:
                self._check(response)
                data = await response.json()
                if pairing_key is None:
                    if data.get("version") != 1 or not isinstance(data.get("models"), list):
                        raise HomeAssistantError("Unsupported OpenCode Assist protocol")
                elif data.get("paired") is not True:
                    raise HomeAssistantError("OpenCode Assist pairing failed")
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HomeAssistantError("Cannot complete OpenCode Assist onboarding") from err

    async def revoke(self) -> None:
        """Invalidate only this pairing when the HA entry is removed."""
        try:
            async with self._request("DELETE", "/v1/pairing", timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status != 401:  # Already revoked is also success.
                    self._check(response)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError("Cannot revoke the OpenCode pairing") from err

    async def stream(self, payload: dict, *, request_origin: str = "unknown"):
        task = asyncio.current_task()
        request_id = str(uuid4())
        request_origin = request_origin if request_origin in _SAFE_ORIGINS else "unknown"
        started_at = datetime.now(timezone.utc).isoformat()
        started = perf_counter()
        stage = "http_request"
        outcome = "error"
        first_event_logged = False
        self._active.add(task)
        complete = False
        _log_diagnostic(
            "request_start",
            request_id=request_id,
            request_origin=request_origin,
            started_at=started_at,
            stage=stage,
            active_count=len(self._active),
        )
        try:
            async with self._request(
                "POST",
                "/v1/requests",
                request_id=request_id,
                request_origin=request_origin,
                json=payload,
            ) as response:
                stage = "http_response"
                if response.status != 200:
                    error_code = await _safe_response_error_code(response)
                    _log_diagnostic(
                        "http_error",
                        request_id=request_id,
                        request_origin=request_origin,
                        stage=stage,
                        status=response.status,
                        error_code=error_code,
                        elapsed_ms=round((perf_counter() - started) * 1000),
                    )
                else:
                    error_code = "unclassified"
                    _log_diagnostic(
                        "http_response",
                        request_id=request_id,
                        request_origin=request_origin,
                        stage=stage,
                        status=response.status,
                        elapsed_ms=round((perf_counter() - started) * 1000),
                    )
                self._check(response, error_code)
                stage = "stream"
                async for line in response.content:
                    if len(line) > 262144:
                        raise HomeAssistantError("OpenCode response exceeds the limit")
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise HomeAssistantError("Invalid OpenCode event")
                    if not first_event_logged:
                        event_type = event.get("type")
                        _log_diagnostic(
                            "first_event",
                            request_id=request_id,
                            request_origin=request_origin,
                            stage=stage,
                            event_type=(
                                event_type
                                if isinstance(event_type, str)
                                and event_type in _SAFE_EVENT_TYPES
                                else "other"
                            ),
                            elapsed_ms=round((perf_counter() - started) * 1000),
                        )
                        first_event_logged = True
                    if event.get("type") == "error":
                        event_code = event.get("code")
                        _log_diagnostic(
                            "stream_error",
                            request_id=request_id,
                            request_origin=request_origin,
                            stage=stage,
                            error_code=(
                                event_code
                                if isinstance(event_code, str)
                                and event_code in _SAFE_ERROR_CODES
                                else "unclassified"
                            ),
                            elapsed_ms=round((perf_counter() - started) * 1000),
                        )
                        raise HomeAssistantError("OpenCode generation failed")
                    is_done = event.get("type") == "done"
                    if is_done:
                        complete = True
                        outcome = "success"
                    yield event
                    if is_done:
                        break
                if not complete:
                    raise HomeAssistantError("OpenCode stream ended unexpectedly")
        except AssistAuthError:
            stage = "authorization"
            outcome = "authorization_error"
            _log_diagnostic(
                "request_error",
                request_id=request_id,
                request_origin=request_origin,
                stage=stage,
                error_type="AssistAuthError",
                error_detail="pairing_rejected",
                elapsed_ms=round((perf_counter() - started) * 1000),
            )
            raise
        except HomeAssistantError as err:
            outcome = "assistant_error"
            _log_diagnostic(
                "request_error",
                request_id=request_id,
                request_origin=request_origin,
                stage=stage,
                error_type=type(err).__name__,
                error_detail=_safe_error_detail(err),
                elapsed_ms=round((perf_counter() - started) * 1000),
            )
            raise
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            outcome = "transport_or_decode_error"
            _log_diagnostic(
                "request_error",
                request_id=request_id,
                request_origin=request_origin,
                stage=stage,
                error_type=type(err).__name__,
                error_detail=_safe_error_detail(err),
                elapsed_ms=round((perf_counter() - started) * 1000),
            )
            raise HomeAssistantError("OpenCode stream failed") from err
        finally:
            self._active.discard(task)
            _log_diagnostic(
                "request_end",
                request_id=request_id,
                request_origin=request_origin,
                stage=stage,
                outcome=outcome,
                elapsed_ms=round((perf_counter() - started) * 1000),
                active_count=len(self._active),
            )

    async def result(self, request_id: str, call_id: str, result: dict) -> None:
        if len(request_id) != 36 or any(c not in "0123456789abcdef-" for c in request_id):
            raise HomeAssistantError("Invalid OpenCode request identifier")
        try:
            async with self._request("POST", f"/v1/requests/{request_id}/results",
                                     json={"callID": call_id, "result": result}, timeout=aiohttp.ClientTimeout(total=10)) as response:
                self._check(response)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError("OpenCode tool result delivery failed") from err
