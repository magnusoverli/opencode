"""Native Assist conversation entity with HA-managed tools and context."""

from homeassistant.components import conversation
from homeassistant.const import CONF_LLM_HASS_API, CONF_PROMPT, MATCH_ALL

from .const import DOMAIN
from .entity import OpenCodeEntity, conversation_request_origin

PARALLEL_UPDATES = 0


async def async_setup_entry(hass, entry, async_add_entities):
    for subentry in entry.subentries.values():
        if subentry.subentry_type == "conversation":
            async_add_entities([OpenCodeConversation(entry, subentry)], config_subentry_id=subentry.subentry_id)


class OpenCodeConversation(conversation.ConversationEntity, OpenCodeEntity):
    _attr_supports_streaming = True

    def __init__(self, entry, subentry):
        super().__init__(entry, subentry)
        if subentry.data.get(CONF_LLM_HASS_API):
            self._attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    @property
    def supported_languages(self):
        return MATCH_ALL

    async def _async_handle_message(self, user_input, chat_log):
        try:
            await chat_log.async_provide_llm_data(user_input.as_llm_context(DOMAIN),
                self.subentry.data.get(CONF_LLM_HASS_API), self.subentry.data.get(CONF_PROMPT), user_input.extra_system_prompt)
        except conversation.ConverseError as err:
            return err.as_conversation_result()
        await self.async_run_chat(
            chat_log,
            request_origin=conversation_request_origin(user_input),
        )
        return conversation.async_get_result_from_chat_log(user_input, chat_log)
