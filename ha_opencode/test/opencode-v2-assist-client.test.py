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
ha.__path__ = []
ha_exceptions = types.ModuleType("homeassistant.exceptions")
ha_exceptions.HomeAssistantError = HomeAssistantError
sys.modules["homeassistant"] = ha
sys.modules["homeassistant.exceptions"] = ha_exceptions

components = types.ModuleType("homeassistant.components")
components.__path__ = []
conversation = types.ModuleType("homeassistant.components.conversation")
ai_task = types.ModuleType("homeassistant.components.ai_task")


class StubEntity:
    pass


class StubConversationEntity(StubEntity):
    pass


class StubAITaskEntity(StubEntity):
    pass


class ToolResultContent:
    pass


class AssistantContent:
    def __init__(self, content):
        self.content = content


class GenDataTaskResult:
    def __init__(self, conversation_id, data):
        self.conversation_id = conversation_id
        self.data = data


conversation.ConversationEntity = StubConversationEntity
conversation.ConversationEntityFeature = types.SimpleNamespace(CONTROL=1)
conversation.ConverseError = type("ConverseError", (Exception,), {})
conversation.ToolResultContent = ToolResultContent
conversation.AssistantContent = AssistantContent
conversation.async_get_result_from_chat_log = lambda *_args: "conversation-result"
ai_task.AITaskEntity = StubAITaskEntity
ai_task.AITaskEntityFeature = types.SimpleNamespace(GENERATE_DATA=1)
ai_task.GenDataTaskResult = GenDataTaskResult
components.conversation = conversation
components.ai_task = ai_task
ha.components = components
sys.modules["homeassistant.components"] = components
sys.modules["homeassistant.components.conversation"] = conversation
sys.modules["homeassistant.components.ai_task"] = ai_task

const = types.ModuleType("homeassistant.const")
const.CONF_MODEL = "model"
const.CONF_LLM_HASS_API = "llm_hass_api"
const.CONF_PROMPT = "prompt"
const.MATCH_ALL = "*"
sys.modules["homeassistant.const"] = const

helpers = types.ModuleType("homeassistant.helpers")
helpers.__path__ = []
helpers_llm = types.ModuleType("homeassistant.helpers.llm")
helpers_llm.ToolInput = object
helpers_llm.selector_serializer = object()
helpers_entity = types.ModuleType("homeassistant.helpers.entity")
helpers_entity.Entity = StubEntity
helpers.llm = helpers_llm
helpers.entity = helpers_entity
ha.helpers = helpers
sys.modules["homeassistant.helpers"] = helpers
sys.modules["homeassistant.helpers.llm"] = helpers_llm
sys.modules["homeassistant.helpers.entity"] = helpers_entity

probatio = types.ModuleType("probatio")
probatio.to_openapi = lambda *args, **kwargs: {}
sys.modules["probatio"] = probatio

source = (
    Path(__file__).resolve().parents[1]
    / "rootfs/opt/opencode-assist/custom_components/opencode_assist/client.py"
)
spec = importlib.util.spec_from_file_location("opencode_assist_client_candidate", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

package_name = "opencode_assist_test"
package = types.ModuleType(package_name)
package.__path__ = [str(source.parent)]
sys.modules[package_name] = package
sys.modules[f"{package_name}.client"] = module


def load_integration_module(name):
    path = source.parent / f"{name}.py"
    module_spec = importlib.util.spec_from_file_location(f"{package_name}.{name}", path)
    loaded = importlib.util.module_from_spec(module_spec)
    sys.modules[module_spec.name] = loaded
    module_spec.loader.exec_module(loaded)
    return loaded


entity_module = load_integration_module("entity")
conversation_module = load_integration_module("conversation")
task_module = load_integration_module("ai_task")


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
        self.calls = []

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
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

    logs.clear()
    for origin in ("voice", "ai_task", "non_satellite"):
        origin_session = Session(Response(200, b'{"type":"done"}\n'))
        origin_client = module.AssistClient(origin_session, "http://127.0.0.1:8768", "pairing-key")
        async for _event in origin_client.stream({"messages": []}, request_origin=origin):
            pass
        origin_headers = origin_session.calls[0][1]["headers"]
        assert origin_headers["X-HA-Assist-Origin"] == origin, origin_headers

    fallback_session = Session(Response(200, b'{"type":"done"}\n'))
    fallback_client = module.AssistClient(fallback_session, "http://127.0.0.1:8768", "pairing-key")
    async for _event in fallback_client.stream({"messages": []}, request_origin="untrusted"):
        pass
    fallback_headers = fallback_session.calls[0][1]["headers"]
    assert "X-HA-Assist-Origin" not in fallback_headers, fallback_headers
    start_log = [fields for event, fields in logs if event == "request_start"][-1]
    assert start_log["request_origin"] == "unknown", start_log

    await origin_caller_checks()
    await entity_to_client_check()
    print("client checks passed: readiness mapping, safe headers, origin propagation, and unknown fallback")


async def origin_caller_checks():
    classify = entity_module.conversation_request_origin
    assert classify(types.SimpleNamespace(satellite_id="assist_satellite.office")) == "voice"
    assert classify(types.SimpleNamespace(satellite_id=None)) == "unknown"
    assert classify(types.SimpleNamespace()) == "unknown"
    assert classify(types.SimpleNamespace(satellite_id=[])) == "unknown"

    captured = []
    original = entity_module.OpenCodeEntity.async_run_chat

    async def capture_origin(self, chat_log, extra_prompt="", *, request_origin="unknown"):
        captured.append(request_origin)

    entity_module.OpenCodeEntity.async_run_chat = capture_origin
    try:
        async def provide_llm_data(*_args):
            return None

        chat_log = types.SimpleNamespace(async_provide_llm_data=provide_llm_data)

        async def run_conversation(satellite_id_marker):
            attributes = {"as_llm_context": lambda _domain: None, "extra_system_prompt": None}
            if satellite_id_marker is not _MISSING:
                attributes["satellite_id"] = satellite_id_marker
            user_input = types.SimpleNamespace(**attributes)
            entity = object.__new__(conversation_module.OpenCodeConversation)
            entity.subentry = types.SimpleNamespace(data={})
            return await entity._async_handle_message(user_input, chat_log)

        await run_conversation("assist_satellite.office")
        await run_conversation(None)
        await run_conversation(_MISSING)

        task_entity = object.__new__(task_module.OpenCodeTask)
        task_chat_log = types.SimpleNamespace(
            content=[conversation.AssistantContent("ok")],
            conversation_id="conversation-1",
        )
        task = types.SimpleNamespace(structure=None)
        await task_entity._async_generate_data(task, task_chat_log)
    finally:
        entity_module.OpenCodeEntity.async_run_chat = original

    assert captured == ["voice", "unknown", "unknown", "ai_task"], captured


_MISSING = object()


async def entity_to_client_check():
    captured = []

    class RecordingClient:
        def stream(self, _payload, *, request_origin="unknown"):
            captured.append(request_origin)

            async def events():
                yield {"type": "done"}

            return events()

    entity = object.__new__(entity_module.OpenCodeEntity)
    entity.entry = types.SimpleNamespace(
        runtime_data=types.SimpleNamespace(client=RecordingClient())
    )
    entity.subentry = types.SimpleNamespace(data={"model": "provider/model"})
    entity.entity_id = "conversation.test"

    class ChatLog:
        content = []
        llm_api = None

        async def async_add_delta_content_stream(self, _entity_id, deltas):
            async for delta in deltas:
                yield delta

    await entity.async_run_chat(ChatLog(), request_origin="voice")
    assert captured == ["voice"], captured


asyncio.run(main())
