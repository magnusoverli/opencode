"""Translate HA ChatLog to a request-scoped model conversation."""

from contextlib import aclosing

import probatio

from homeassistant.components import conversation
from homeassistant.const import CONF_MODEL
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm
from homeassistant.helpers.entity import Entity

from .client import AssistAuthError


def history_payload(chat_log):
    system = []
    messages = []
    for content in chat_log.content:
        if content.role == "system":
            system.append(content.content)
            continue
        if getattr(content, "attachments", None):
            raise HomeAssistantError("Attachments are not supported by this adapter")
        if isinstance(content, conversation.ToolResultContent):
            messages.append({"role": "tool", "content": [{"type": "tool-result", "id": content.tool_call_id,
                "name": content.tool_name, "result": {"type": "error" if content.result.error else "json", "value": content.result.data}}]})
            continue
        parts = [{"type": "text", "text": content.content}] if content.content else []
        for call in getattr(content, "tool_calls", None) or []:
            parts.append({"type": "tool-call", "id": call.id, "name": call.tool_name, "input": call.tool_args})
        if parts:
            messages.append({"role": content.role, "content": parts})
    return "\n\n".join(system), messages


def conversation_request_origin(user_input):
    """Classify only origins established by Home Assistant conversation metadata."""
    if not hasattr(user_input, "satellite_id"):
        return "unknown"
    satellite_id = user_input.satellite_id
    if isinstance(satellite_id, str) and satellite_id:
        return "voice"
    return "unknown"


class OpenCodeEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry, subentry):
        self.entry = entry
        self.subentry = subentry
        self._attr_unique_id = subentry.subentry_id
        self._attr_name = subentry.title

    async def async_run_chat(self, chat_log, extra_prompt="", *, request_origin="unknown"):
        client = self.entry.runtime_data.client
        system, messages = history_payload(chat_log)
        provider, model = self.subentry.data[CONF_MODEL].split("/", 1)
        tools = []
        if chat_log.llm_api:
            tools = [{"name": tool.name, "description": tool.description or "", "parameters": probatio.to_openapi(
                tool.parameters, custom_serializer=chat_log.llm_api.custom_serializer, openapi_version="3.1.0")}
                for tool in chat_log.llm_api.tools]
        payload = {"model": {"providerID": provider, "id": model}, "system": system + extra_prompt,
                   "messages": messages, "tools": tools}
        request_id = None
        allowed = {tool["name"] for tool in tools}

        async def deltas():
            nonlocal request_id
            yield {"role": "assistant"}
            async with aclosing(client.stream(payload, request_origin=request_origin)) as stream:
                async for event in stream:
                    match event.get("type"):
                        case "request":
                            request_id = event["id"]
                        case "text":
                            yield {"content": event["text"]}
                        case "tool_call":
                            if not request_id or event["name"] not in allowed:
                                raise HomeAssistantError("OpenCode requested an unselected tool")
                            yield {"tool_calls": [llm.ToolInput(id=event["id"], tool_name=event["name"], tool_args=event["arguments"])]}
                            # Flush the call before awaiting its HA-owned result.
                            yield {"role": "assistant"}
                        case "done":
                            break
                        case _:
                            raise HomeAssistantError("Unexpected OpenCode stream event")
        try:
            async with aclosing(deltas()) as stream:
                async for content in chat_log.async_add_delta_content_stream(self.entity_id, stream):
                    if isinstance(content, conversation.ToolResultContent):
                        await client.result(request_id, content.tool_call_id, {"data": content.result.data, "error": content.result.error})
        except AssistAuthError:
            self.entry.async_start_reauth(self.hass)
            raise
