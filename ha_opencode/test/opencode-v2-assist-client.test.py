"""Isolated checks for the Home Assistant Assist HTTP client."""

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

sys.dont_write_bytecode = True


class HomeAssistantError(Exception):
    pass


class ClientError(Exception):
    pass


class ServerDisconnectedError(ClientError):
    pass


class ClientConnectorError(ClientError):
    pass


class ClientTimeout:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientError = ClientError
aiohttp.ServerDisconnectedError = ServerDisconnectedError
aiohttp.ClientConnectorError = ClientConnectorError
aiohttp.ClientTimeout = ClientTimeout
aiohttp.ClientSession = object
sys.modules["aiohttp"] = aiohttp

ha = types.ModuleType("homeassistant")
ha_exceptions = types.ModuleType("homeassistant.exceptions")
ha_exceptions.HomeAssistantError = HomeAssistantError
sys.modules["homeassistant"] = ha
sys.modules["homeassistant.exceptions"] = ha_exceptions

source = (
    Path(__file__).resolve().parents[1]
    / "rootfs/opt/opencode-assist/custom_components/opencode_assist/client.py"
)
spec = importlib.util.spec_from_file_location("opencode_assist_client_candidate", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Content:
    def __init__(self, payload):
        self.payload = payload

    async def read(self, limit=-1):
        return self.payload[:limit]

    def __aiter__(self):
        async def iterate():
            for line in self.payload.splitlines(keepends=True):
                yield line
        return iterate()


class Response:
    def __init__(self, status, payload):
        self.status = status
        self.content = Content(payload)


class ResponseContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *_):
        return False


class Session:
    def __init__(self, response):
        self.response = response

    def request(self, *_args, **_kwargs):
        return ResponseContext(self.response)


async def main():
    logs = []
    module._log_diagnostic = lambda event, **fields: logs.append((event, fields))

    # Close immediately after yielding the terminal event. The success outcome
    # must already be set before control is yielded to the caller.
    success = module.AssistClient(
        Session(Response(200, b'{"type":"done"}\n')),
        "http://127.0.0.1:8768",
        "pairing-key",
    )
    stream = success.stream({"messages": []})
    assert (await anext(stream)) == {"type": "done"}
    await stream.aclose()
    success_end = [fields for event, fields in logs if event == "request_end"][-1]
    assert success_end["outcome"] == "success", success_end

    logs.clear()
    unavailable = module.AssistClient(
        Session(Response(503, b'{"error":"model_catalog_not_ready"}')),
        "http://127.0.0.1:8768",
        "pairing-key",
    )
    try:
        async for _event in unavailable.stream({"messages": []}):
            raise AssertionError("error response unexpectedly streamed an event")
    except module.AssistResponseError as error:
        assert error.status == 503
        assert error.error_code == "model_catalog_not_ready"
    else:
        raise AssertionError("expected classified readiness response error")

    failure_end = [fields for event, fields in logs if event == "request_end"][-1]
    assert failure_end["outcome"] == "assistant_error", failure_end
    request_error = [fields for event, fields in logs if event == "request_error"][-1]
    assert request_error["error_detail"] == "model_catalog_not_ready", request_error
    print("client checks passed: done outcome and safe readiness error mapping")


asyncio.run(main())
