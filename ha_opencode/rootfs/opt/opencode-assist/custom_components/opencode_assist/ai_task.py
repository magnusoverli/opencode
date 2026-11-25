"""Text and schema-validated AI data tasks."""

import json
import probatio

from homeassistant.components import ai_task, conversation
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm

from .entity import OpenCodeEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(hass, entry, async_add_entities):
    for subentry in entry.subentries.values():
        if subentry.subentry_type == "ai_task_data":
            async_add_entities([OpenCodeTask(entry, subentry)], config_subentry_id=subentry.subentry_id)


class OpenCodeTask(ai_task.AITaskEntity, OpenCodeEntity):
    _attr_supported_features = ai_task.AITaskEntityFeature.GENERATE_DATA

    async def _async_generate_data(self, task, chat_log):
        extra = ""
        if task.structure:
            schema = probatio.to_openapi(task.structure, custom_serializer=llm.selector_serializer, openapi_version="3.1.0")
            extra = "\nReturn only a JSON object matching this schema, without Markdown: " + json.dumps(schema)
        await self.async_run_chat(chat_log, extra, request_origin="ai_task")
        last = chat_log.content[-1]
        if not isinstance(last, conversation.AssistantContent) or last.content is None:
            raise HomeAssistantError("OpenCode returned no answer")
        data = last.content
        if task.structure:
            try:
                data = task.structure(json.loads(data))
            except (ValueError, probatio.Invalid) as err:
                raise HomeAssistantError("OpenCode returned invalid structured data") from err
        return ai_task.GenDataTaskResult(conversation_id=chat_log.conversation_id, data=data)
