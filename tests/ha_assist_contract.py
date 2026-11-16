"""Run inside the pinned HA image; uses actual HA classes and no live HA instance."""

import asyncio
import contextvars
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import UUID

import aiohttp
import probatio
from aiohasupervisor import SupervisorError
from homeassistant import loader
from homeassistant.components import conversation, ai_task, persistent_notification
from aiohasupervisor.models import Discovery
from homeassistant.config_entries import ConfigEntries, ConfigSubentry, ConfigEntryState, FlowType
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import ConfigEntryError, HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er, llm
from homeassistant.helpers.translation import async_get_translations
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from homeassistant.components.hassio.discovery import HassIODiscovery

from custom_components.opencode_assist.client import AssistClient, AssistAuthError
from custom_components.opencode_assist.config_flow import OpenCodeFlow, OpenCodeSubentryFlow
from custom_components.opencode_assist.conversation import OpenCodeConversation
from custom_components.opencode_assist.ai_task import OpenCodeTask
from custom_components.opencode_assist.entity import history_payload
from custom_components.opencode_assist import async_setup_entry, async_unload_entry, async_remove_entry
from custom_components.opencode_assist.diagnostics import async_get_config_entry_diagnostics
from custom_components.opencode_assist.supervisor import AppDiscovery, async_discover_apps


class FixtureTool(llm.Tool):
    name = "FixtureRead"
    description = "Read the fixture using HA's trusted context"
    parameters = probatio.Schema({probatio.Required("name"): str})

    def __init__(self, calls):
        self.calls = calls

    async def async_call(self, hass, tool_input, llm_context):
        self.parameters(tool_input.tool_args)
        self.calls.append((tool_input.tool_args, llm_context))
        return llm.ToolResult(data={"answer": "from HA"}, error=False)


class FixtureAPI(llm.API):
    async def async_get_api_instance(self, llm_context):
        raise NotImplementedError


class ContractTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(os.environ.get("HA_ASSIST_TEST_VERSION") == "2026.11.1", "HA November contract")
    async def test_november_cached_tools_keep_current_caller_context(self):
        entity = self.entity()
        log, calls = self.log(tools=True)
        api = log.llm_api
        log.llm_api = None
        first = llm.LLMContext(platform="opencode_assist", context=Context(user_id="trusted-user"),
            language="en", assistant="conversation", device_id="trusted-device", agent_id=entity.entity_id)
        second = llm.LLMContext(platform="opencode_assist", context=Context(user_id="trusted-user"),
            language="en", assistant="conversation", device_id="trusted-device", agent_id=entity.entity_id)
        with patch.object(llm, "async_get_api", AsyncMock(return_value=api)) as get_api, \
             patch.object(self.hass, "auth", SimpleNamespace(async_get_user=AsyncMock(return_value=None)), create=True):
            await log.async_provide_llm_data(first, ["fixture"], "First instructions")
            prompt = log.content[0].content
            await log.async_provide_llm_data(second, ["fixture"], "Changed instructions")
        get_api.assert_awaited_once()
        self.assertEqual(log.content[0].content, prompt)
        async def stream(payload):
            self.assertIn("First instructions", payload["system"])
            yield {"type": "request", "id": "a" * 36}
            yield {"type": "tool_call", "id": "call1", "name": "FixtureRead", "arguments": {"name": "Fixture"}}
            yield {"type": "text", "text": "Done"}
            yield {"type": "done"}
        self.client.stream = stream
        await entity.async_run_chat(log)
        self.assertIs(calls[0][1].context, second.context)

    @unittest.skipUnless(os.environ.get("HA_ASSIST_TEST_VERSION") == "2026.11.1", "HA November contract")
    async def test_november_admin_api_refuses_nonadmin_before_tools(self):
        entity = self.entity()
        entity.subentry = ConfigSubentry(data=MappingProxyType({"model": "fixture/coding", "llm_hass_api": ["fixture-admin"]}),
            subentry_type="conversation", title="Admin fixture", unique_id=None)
        log, _ = self.log()
        api = FixtureAPI(hass=self.hass, id="fixture-admin", name="Admin", requires_admin=True)
        self.addCleanup(llm.async_register_api(self.hass, api))
        context = llm.LLMContext(platform="opencode_assist", context=Context(user_id="user"),
            language="en", assistant="conversation", device_id=None)
        user = SimpleNamespace(as_llm_context=Mock(return_value=context), extra_system_prompt=None)
        with patch.object(self.hass, "auth", SimpleNamespace(async_get_user=AsyncMock(return_value=SimpleNamespace(is_admin=False))), create=True), \
             patch.object(api, "async_get_api_instance", AsyncMock()) as instance, \
             patch.object(entity, "async_run_chat", AsyncMock()) as run_chat:
            result = await entity._async_handle_message(user, log)
            self.assertEqual(result.response.error_code.value, "unknown")
            instance.assert_not_awaited()
            run_chat.assert_not_awaited()

    @unittest.skipUnless(os.environ.get("HA_ASSIST_TEST_VERSION") == "2026.11.1", "HA November contract")
    async def test_november_merged_tool_names_roundtrip_through_companion(self):
        entity = self.entity()
        log, first_calls = self.log(tools=True)
        first = log.llm_api.api
        second = FixtureAPI(hass=self.hass, id="second", name="Second")
        second_calls = []
        context = log.llm_api.llm_context
        with patch.object(first, "async_get_api_instance", AsyncMock(return_value=log.llm_api)), \
             patch.object(second, "async_get_api_instance", AsyncMock(return_value=llm.APIInstance(
                 second, "Second instructions", context, [FixtureTool(second_calls)]))):
            log.llm_api = await llm.MergedAPI([first, second]).async_get_api_instance(context)
        async def stream(payload):
            self.assertEqual([tool["name"] for tool in payload["tools"]], ["fixture__FixtureRead", "second__FixtureRead"])
            yield {"type": "request", "id": "a" * 36}
            yield {"type": "tool_call", "id": "call1", "name": "second__FixtureRead", "arguments": {"name": "Fixture"}}
            yield {"type": "text", "text": "Done"}
            yield {"type": "done"}
        self.client.stream = stream
        await entity.async_run_chat(log)
        self.assertEqual(first_calls, [])
        self.assertEqual(len(second_calls), 1)
        self.assertIs(second_calls[0][1].context, context.context)
        _, messages = history_payload(log)
        result = next(message for message in messages if message["role"] == "tool")
        self.assertEqual(result["content"][0]["name"], "second__FixtureRead")

    @unittest.skipUnless(os.environ.get("HA_ASSIST_TEST_VERSION") == "2026.11.1", "HA November contract")
    async def test_november_native_mcp_readonly_filters_listing_and_dispatch(self):
        from homeassistant.components.mcp_server.server import async_get_api_instance
        log, calls = self.log(tools=True)
        read = FixtureTool(calls)
        read.annotations = llm.ToolAnnotations(read_only=True)
        write = FixtureTool(calls)
        write.name = "FixtureWrite"
        write.annotations = llm.ToolAnnotations(read_only=False)
        def instance(*_):
            return llm.APIInstance(log.llm_api.api, "Fixture", log.llm_api.llm_context, [read, write])
        with patch.object(llm, "async_get_api", AsyncMock(side_effect=instance)):
            configured = await async_get_api_instance(self.hass, ["fixture"], log.llm_api.llm_context, True)
            keyed = await async_get_api_instance(self.hass, "fixture", log.llm_api.llm_context, False)
        self.assertEqual([tool.name for tool in configured.tools], ["FixtureRead"])
        self.assertEqual([tool.name for tool in keyed.tools], ["FixtureRead", "FixtureWrite"])
        with self.assertRaisesRegex(HomeAssistantError, 'Tool "FixtureWrite" not found'):
            await configured.async_call_tool(llm.ToolInput(id="blocked", tool_name="FixtureWrite", tool_args={"name": "Fixture"}))
        self.assertEqual(calls, [])

    @unittest.skipUnless(os.environ.get("HA_ASSIST_TEST_VERSION") == "2026.11.1", "HA November contract")
    async def test_november_failed_turn_retained_and_parallel_turn_rejected(self):
        from homeassistant.components.conversation.chat_log import async_get_chat_log, ConversationBusyError
        entity = self.entity()
        session = SimpleNamespace(conversation_id="november-fixture", async_on_cleanup=Mock())
        user = SimpleNamespace(agent_id=entity.entity_id, text="Original question")
        async def competing_turn():
            with async_get_chat_log(self.hass, session, user):
                self.fail("Concurrent turn must be rejected")
        async def stream(_payload):
            raise HomeAssistantError("Synthetic provider unavailable")
            yield  # Keep the same async-generator contract as the real client.
        self.client.stream = stream
        with self.assertRaisesRegex(HomeAssistantError, "Synthetic provider unavailable"):
            with async_get_chat_log(self.hass, session, user) as log:
                with self.assertRaises(ConversationBusyError):
                    await asyncio.create_task(competing_turn(), context=contextvars.Context())
                await entity.async_run_chat(log)
        with async_get_chat_log(self.hass, session) as retained:
            self.assertTrue(any(item.role == "user" and item.content == user.text for item in retained.content))
            self.assertGreater(len(retained.content), 2)
            system, messages = history_payload(retained)
            self.assertTrue(any(message["role"] == "user" for message in messages))

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hass = HomeAssistant(self.temp.name)
        self.client = SimpleNamespace(info=AsyncMock(return_value={"version": 1, "models": [{"providerID": "fixture", "id": "coding", "name": "Fixture", "tools": True}]}), result=AsyncMock(), close=AsyncMock())
        self.entry = SimpleNamespace(runtime_data=SimpleNamespace(client=self.client, info={"version": 1, "conversation": True, "generate_data": True}), subentries={}, async_start_reauth=AsyncMock())

    async def asyncTearDown(self):
        await self.hass.async_stop()
        self.temp.cleanup()

    def entity(self, cls=OpenCodeConversation):
        subentry = ConfigSubentry(data=MappingProxyType({"model": "fixture/coding"}), subentry_type="conversation" if cls is OpenCodeConversation else "ai_task_data", title="Fixture", unique_id=None)
        self.entry.subentries[subentry.subentry_id] = subentry
        entity = cls(self.entry, subentry)
        entity.hass = self.hass
        entity.entity_id = "conversation.fixture" if cls is OpenCodeConversation else "ai_task.fixture"
        return entity

    def log(self, tools=False):
        log = conversation.ChatLog(self.hass, "fixture-conversation", content=[conversation.SystemContent("Only HA's system prompt"), conversation.UserContent("Fixture question")])
        calls = []
        if tools:
            context = llm.LLMContext(platform="opencode_assist", context=Context(user_id="trusted-user"), language="en", assistant="conversation", device_id="trusted-device")
            log.llm_api = llm.APIInstance(FixtureAPI(hass=self.hass, id="fixture", name="Fixture"), "Only selected tools", context, [FixtureTool(calls)])
        return log, calls

    async def test_actual_chatlog_executes_tool_with_original_context(self):
        entity = self.entity()
        log, calls = self.log(tools=True)
        async def stream(payload):
            self.assertEqual([tool["name"] for tool in payload["tools"]], ["FixtureRead"])
            self.assertEqual(payload["system"], "Only HA's system prompt")
            yield {"type": "request", "id": "a" * 36}
            yield {"type": "text", "text": "Checking "}
            yield {"type": "tool_call", "id": "call1", "name": "FixtureRead", "arguments": {"name": "Fixture"}}
            self.client.result.assert_awaited_once_with("a" * 36, "call1", {"data": {"answer": "from HA"}, "error": False})
            yield {"type": "text", "text": "Finished"}
            yield {"type": "done"}
        self.client.stream = stream
        await asyncio.wait_for(entity.async_run_chat(log), 5)
        self.assertEqual(calls[0][0], {"name": "Fixture"})
        self.assertEqual(calls[0][1].context.user_id, "trusted-user")
        self.assertEqual(calls[0][1].device_id, "trusted-device")
        self.assertEqual(log.content[-1].content, "Finished")
        _, messages = history_payload(log)
        self.assertEqual(messages[2]["role"], "tool")
        self.assertEqual(messages[2]["content"][0]["result"], {"type": "json", "value": {"answer": "from HA"}})

    async def test_unselected_tool_fails_and_closes_stream(self):
        entity = self.entity()
        log, _ = self.log()
        closed = asyncio.Event()
        async def stream(payload):
            try:
                yield {"type": "request", "id": "a" * 36}
                yield {"type": "tool_call", "id": "call1", "name": "NotSelected", "arguments": {}}
            finally:
                closed.set()
        self.client.stream = stream
        with self.assertRaises(HomeAssistantError):
            await entity.async_run_chat(log)
        self.assertTrue(closed.is_set())
        self.client.result.assert_not_awaited()

    async def test_structured_data_is_validated(self):
        entity = self.entity(OpenCodeTask)
        task = ai_task.GenDataTask("fixture", "Return data", structure=probatio.Schema({probatio.Required("count"): int}))
        for answer, valid in [("{\"count\":3}", True), ("{\"count\":\"bad\"}", False), ("not json", False)]:
            log, _ = self.log()
            async def stream(payload):
                self.assertIn("count", payload["system"])
                yield {"type": "request", "id": "a" * 36}
                yield {"type": "text", "text": answer}
                yield {"type": "done"}
            self.client.stream = stream
            if valid:
                result = await entity._async_generate_data(task, log)
                self.assertEqual(result.data, {"count": 3})
            else:
                with self.assertRaises(HomeAssistantError):
                    await entity._async_generate_data(task, log)

    async def test_subentry_schema(self):
        self.entry.state = ConfigEntryState.LOADED
        subflow = OpenCodeSubentryFlow()
        subflow.hass = self.hass
        subflow.handler = ("fixture", "conversation")
        subflow.context = {"source": "user"}
        with patch.object(subflow, "_get_entry", return_value=self.entry), patch("custom_components.opencode_assist.config_flow.llm.async_get_apis", return_value=[SimpleNamespace(id="assist", name="Assist")]):
            form = await subflow.async_step_user()
            values = form["data_schema"]({"model": "fixture/coding"})
            self.assertEqual(values["llm_hass_api"], [])
            invalid = await subflow.async_step_user({"model": "fixture/coding", "llm_hass_api": ["removed-api"]})
            self.assertEqual(invalid["errors"]["base"], "unknown_api")
            created = await subflow.async_step_user({"model": "fixture/coding", "llm_hass_api": ["assist"]})
            self.assertEqual(created["type"], "create_entry")

    async def test_unload_and_redacted_diagnostics(self):
        self.entity()
        hass = SimpleNamespace(config_entries=SimpleNamespace(async_unload_platforms=AsyncMock(return_value=True)))
        self.assertTrue(await async_unload_entry(hass, self.entry))
        self.client.close.assert_awaited_once()
        self.entry.data = {"url": "http://private-address", "api_key": "secret-value"}
        output = json.dumps(await async_get_config_entry_diagnostics(hass, self.entry))
        self.assertNotIn("secret-value", output)
        self.assertNotIn("private-address", output)
        self.client.revoke = AsyncMock()
        with patch("custom_components.opencode_assist.async_get_clientsession", return_value=None), patch("custom_components.opencode_assist.AssistClient", return_value=self.client):
            await async_remove_entry(hass, self.entry)
        self.client.revoke.assert_awaited_once()

    @unittest.skipUnless(os.environ.get("ASSIST_FIXTURE_NOTIFICATION"), "Run scripts/test-ha-assist-core.mjs for the worker's notification payload")
    async def test_restart_notification_service_replaces_duplicates_and_clears_on_core_restart(self):
        data = json.loads(os.environ["ASSIST_FIXTURE_NOTIFICATION"])
        await persistent_notification.async_setup(self.hass, {})
        for _ in range(2):
            await self.hass.services.async_call("persistent_notification", "create", data, blocking=True)
        def notifications(hass):
            connection = SimpleNamespace(send_message=Mock())
            persistent_notification.websocket_get_notifications(hass, connection, {"id": 1, "type": "persistent_notification/get"})
            return connection.send_message.call_args.args[0]["result"]
        self.assertEqual(len(notifications(self.hass)), 1)
        self.assertIn("Restart Home Assistant Core", notifications(self.hass)[0]["message"])
        await self.hass.async_stop()
        restarted = HomeAssistant(self.temp.name)
        try:
            await persistent_notification.async_setup(restarted, {})
            self.assertEqual(notifications(restarted), [])
        finally:
            await restarted.async_stop()

    @unittest.skipUnless(os.environ.get("ASSIST_FIXTURE_URL"), "Run scripts/test-ha-assist-core.mjs for pinned OpenCode + HA transport")
    async def test_real_opencode_transport_and_followup(self):
        async with aiohttp.ClientSession() as session:
            bootstrap = AssistClient(session, os.environ["ASSIST_FIXTURE_URL"], os.environ["ASSIST_FIXTURE_BOOTSTRAP"])
            self.assertTrue((await bootstrap.onboard())["models"])
            await bootstrap.onboard("a" * 43)
            await bootstrap.onboard("a" * 43)  # Identical retry after a lost response.
            client = AssistClient(session, os.environ["ASSIST_FIXTURE_URL"], "a" * 43)
            info = await client.info()
            self.assertEqual(info["version"], 1)
            self.entry.runtime_data.client = client
            entity = self.entity()
            log, calls = self.log(tools=True)
            await asyncio.wait_for(entity.async_run_chat(log), 20)
            self.assertEqual(len(calls), 1)
            self.assertIn("from HA", log.content[-1].content)
            log.content.append(conversation.UserContent("Follow up"))
            await asyncio.wait_for(entity.async_run_chat(log), 20)
            self.assertEqual(len(calls), 1)
            self.assertIn("from HA", log.content[-1].content)
            pending_log, _ = self.log(tools=True)
            started = asyncio.Event()
            cancelled = asyncio.Event()
            class PendingTool(FixtureTool):
                async def async_call(self, hass, tool_input, llm_context):
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
            pending_log.llm_api.tools = [PendingTool([])]
            pending = asyncio.create_task(entity.async_run_chat(pending_log))
            await asyncio.wait_for(started.wait(), 10)
            await client.close()
            self.assertTrue(pending.cancelled())
            self.assertTrue(cancelled.is_set())
            bad = AssistClient(session, os.environ["ASSIST_FIXTURE_URL"], "revoked")
            with self.assertRaises(AssistAuthError):
                await bad.info()
            await client.revoke()
            with self.assertRaises(AssistAuthError):
                await client.info()
            with self.assertRaises(AssistAuthError):
                await bootstrap.onboard("a" * 43)


class OnboardingContracts(unittest.IsolatedAsyncioTestCase):
    """Use Core's real config-entry and subentry managers; mock external I/O only."""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hass = HomeAssistant(self.temp.name)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        await self.hass.config_entries.async_initialize()
        self.app = AppDiscovery("fixture_beta", "OpenCode Beta", "http://fixture-beta:8768", "b" * 43, int(time.time() * 1000) + 600000)
        self.info = {"version": 1, "models": [{"providerID": "fixture", "id": "coding", "name": "Fixture", "tools": True}]}
        self.client = SimpleNamespace(onboard=AsyncMock(return_value=self.info), info=AsyncMock(return_value=self.info))
        self.patches = [
            patch("homeassistant.config_entries._async_get_flow_handler", return_value=OpenCodeFlow),
            patch("homeassistant.config_entries._support_single_config_entry_only", return_value=False),
            patch.object(self.hass.config_entries, "async_setup", side_effect=self.setup_entry),
            patch.object(self.hass.config_entries, "async_reload", return_value=True),
            patch("custom_components.opencode_assist.config_flow.async_discover_apps", return_value=[self.app]),
            patch("custom_components.opencode_assist.config_flow.async_get_clientsession", return_value=None),
            patch("custom_components.opencode_assist.config_flow.AssistClient", return_value=self.client),
            patch("custom_components.opencode_assist.config_flow.llm.async_get_apis", return_value=[SimpleNamespace(id="assist", name="Assist")]),
        ]
        self.mocks = [item.start() for item in self.patches]

    async def setup_entry(self, entry_id):
        entry = self.hass.config_entries.async_get_entry(entry_id)
        entry.runtime_data = SimpleNamespace(client=self.client, info=self.info)
        entry._async_set_state(self.hass, ConfigEntryState.LOADED, None)
        return True

    async def asyncTearDown(self):
        await self.hass.async_stop()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def start(self, source="hassio"):
        data = HassioServiceInfo(config={"url": "http://untrusted", "bootstrap": "untrusted"}, name="Untrusted", slug=self.app.slug, uuid="f" * 32) if source == "hassio" else None
        return await self.hass.config_entries.flow.async_init("opencode_assist", context={"source": source}, data=data)

    async def create(self, entity_type="conversation"):
        menu = await self.start()
        self.assertEqual(menu["step_id"], "choose_entity")
        self.assertEqual(menu["type"], "menu")
        self.client.onboard.assert_not_awaited()
        form = await self.hass.config_entries.flow.async_configure(menu["flow_id"], {"next_step_id": entity_type})
        self.assertEqual(form["step_id"], "hassio_confirm")
        self.client.onboard.assert_not_awaited()
        return await self.hass.config_entries.flow.async_configure(form["flow_id"], {})

    async def test_discovery_confirmation_chains_real_model_api_flow(self):
        result = await self.create()
        self.assertEqual(result["type"], "create_entry")
        entry = result["result"]
        self.assertEqual(entry.unique_id, "supervisor:fixture_beta")
        self.assertEqual(entry.data["url"], self.app.url)
        self.assertEqual(entry.data["addon_slug"], self.app.slug)
        key = entry.data["api_key"]
        self.assertEqual(len(key), 43)
        self.assertNotIn(self.app.bootstrap, str(entry.data))
        self.client.onboard.assert_awaited_with(key)
        self.mocks[6].assert_called_with(None, self.app.url, self.app.bootstrap)
        self.assertEqual(result["next_flow"][0], FlowType.CONFIG_SUBENTRIES_FLOW)
        next_id = result["next_flow"][1]
        form = await self.hass.config_entries.subentries.async_configure(next_id)
        values = form["data_schema"]({"model": "fixture/coding"})
        self.assertEqual(values["llm_hass_api"], [])
        completed = await self.hass.config_entries.subentries.async_configure(next_id, values)
        self.assertEqual(completed["type"], "create_entry")
        self.assertEqual(len(entry.subentries), 1)
        calls = self.client.onboard.await_count
        rediscovered = await self.start()
        self.assertEqual(rediscovered["reason"], "already_configured")
        self.assertEqual(self.client.onboard.await_count, calls)
        self.assertEqual(entry.data["api_key"], key)
        self.assertEqual(len(self.hass.config_entries.async_entries("opencode_assist")), 1)

    async def test_ai_task_chaining_and_supervisor_start_from_add_integration(self):
        menu = await self.start("user")
        self.assertEqual(menu["step_id"], "choose_entity")
        form = await self.hass.config_entries.flow.async_configure(menu["flow_id"], {"next_step_id": "ai_task_data"})
        self.assertEqual(form["step_id"], "hassio_confirm")
        result = await self.hass.config_entries.flow.async_configure(form["flow_id"], {})
        form = await self.hass.config_entries.subentries.async_configure(result["next_flow"][1])
        values = form["data_schema"]({"model": "fixture/coding"})
        self.assertNotIn("llm_hass_api", values)
        await self.hass.config_entries.subentries.async_configure(form["flow_id"], values)
        self.assertEqual(next(iter(result["result"].subentries.values())).subentry_type, "ai_task_data")
        entry = result["result"]
        data, previous = dict(entry.data), dict(entry.subentries)
        self.client.onboard.reset_mock()
        # Reopening Add integration is not the same action as Add conversation
        # agent on the existing integration page. It must preserve that pairing.
        repeated = await self.start("user")
        self.assertEqual(repeated["reason"], "already_configured")
        # Choosing AI tasks first never excludes adding conversation later.
        additional = await self.hass.config_entries.subentries.async_init(
            (entry.entry_id, "conversation"), context={"source": "user"})
        additional_values = additional["data_schema"]({"model": "fixture/coding"})
        self.assertEqual(additional_values["llm_hass_api"], [])
        await self.hass.config_entries.subentries.async_configure(additional["flow_id"], additional_values)
        self.assertEqual({subentry.subentry_type for subentry in entry.subentries.values()}, {"ai_task_data", "conversation"})
        self.assertEqual(dict(entry.data), data)
        for subentry_id, subentry in previous.items():
            self.assertIs(entry.subentries[subentry_id], subentry)
        self.assertEqual(len(self.hass.config_entries.async_entries("opencode_assist")), 1)
        self.client.onboard.assert_not_awaited()

    async def test_conversation_first_then_ai_task_uses_existing_pairing(self):
        created = await self.create()
        entry = created["result"]
        await self.hass.config_entries.subentries.async_configure(created["next_flow"][1], {"model": "fixture/coding", "llm_hass_api": []})
        data, previous = dict(entry.data), dict(entry.subentries)
        self.client.onboard.reset_mock()
        additional = await self.hass.config_entries.subentries.async_init(
            (entry.entry_id, "ai_task_data"), context={"source": "user"})
        values = additional["data_schema"]({"model": "fixture/coding"})
        self.assertNotIn("llm_hass_api", values)
        completed = await self.hass.config_entries.subentries.async_configure(additional["flow_id"], values)
        self.assertEqual(completed["type"], "create_entry")
        self.assertEqual({subentry.subentry_type for subentry in entry.subentries.values()}, {"ai_task_data", "conversation"})
        self.assertEqual(dict(entry.data), data)
        for subentry_id, subentry in previous.items():
            self.assertIs(entry.subentries[subentry_id], subentry)
        self.assertEqual(len(self.hass.config_entries.async_entries("opencode_assist")), 1)
        self.client.onboard.assert_not_awaited()

    async def test_duplicate_types_are_rejected_but_both_remain_configurable(self):
        created = await self.create()
        entry = created["result"]
        await self.hass.config_entries.subentries.async_configure(created["next_flow"][1], {"model": "fixture/coding", "llm_hass_api": []})
        task = await self.hass.config_entries.subentries.async_init((entry.entry_id, "ai_task_data"), context={"source": "user"})
        await self.hass.config_entries.subentries.async_configure(task["flow_id"], {"model": "fixture/coding"})
        data, ids = dict(entry.data), set(entry.subentries)
        self.client.onboard.reset_mock()
        for subentry in list(entry.subentries.values()):
            kind = subentry.subentry_type
            self.assertEqual(subentry.unique_id, kind)
            # Older companions wrote no unique IDs. The type guard must also
            # recognize those existing services without rewriting their data.
            self.hass.config_entries.async_update_subentry(entry, subentry, unique_id=None)
            self.client.info.reset_mock()
            duplicate = await self.hass.config_entries.subentries.async_init((entry.entry_id, kind), context={"source": "user"})
            self.assertEqual(duplicate["type"], "abort")
            self.assertEqual(duplicate["reason"], "already_configured")
            self.client.info.assert_not_awaited()
            self.assertTrue(entry.supported_subentry_types[kind]["supports_reconfigure"])
            form = await self.hass.config_entries.subentries.async_init((entry.entry_id, kind),
                context={"source": "reconfigure", "subentry_id": subentry.subentry_id})
            self.assertEqual(form["type"], "form")
            values = {"model": "fixture/coding"}
            if kind == "conversation":
                values.update(llm_hass_api=["assist"], prompt="Changed fixture instructions")
            result = await self.hass.config_entries.subentries.async_configure(form["flow_id"], values)
            self.assertEqual(result["reason"], "reconfigure_successful")
            self.assertEqual(dict(entry.subentries[subentry.subentry_id].data), values)
        self.assertEqual(set(entry.subentries), ids)
        self.assertEqual(dict(entry.data), data)
        self.client.onboard.assert_not_awaited()

    async def test_concurrent_forms_create_only_one_of_each_type(self):
        created = await self.create("ai_task_data")
        entry = created["result"]
        self.hass.config_entries.subentries.async_abort(created["next_flow"][1])
        for kind in ("conversation", "ai_task_data"):
            first = await self.hass.config_entries.subentries.async_init((entry.entry_id, kind), context={"source": "user"})
            second = await self.hass.config_entries.subentries.async_init((entry.entry_id, kind), context={"source": "user"})
            ready, release = asyncio.Event(), asyncio.Event()
            started = 0
            async def delayed_info():
                nonlocal started
                started += 1
                if started == 2:
                    ready.set()
                await release.wait()
                return self.info
            self.client.info.side_effect = delayed_info
            pending = [asyncio.create_task(self.hass.config_entries.subentries.async_configure(
                form["flow_id"], {"model": "fixture/coding"})) for form in (first, second)]
            try:
                await asyncio.wait_for(ready.wait(), 5)
                release.set()
                results = await asyncio.wait_for(asyncio.gather(*pending), 5)
            finally:
                release.set()
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                self.client.info.side_effect = None
            self.assertEqual(sorted(result["type"] for result in results), ["abort", "create_entry"])
            self.assertEqual(next(result for result in results if result["type"] == "abort")["reason"], "already_configured")
            self.assertEqual(len(entry.get_subentries_of_type(kind)), 1)
        self.assertEqual(len(entry.subentries), 2)

    async def test_removed_type_can_be_added_again_without_repairing(self):
        dr.async_setup(self.hass)
        await dr.async_load(self.hass, load_empty=True)
        await er.async_load(self.hass, load_empty=True)
        created = await self.create("ai_task_data")
        entry = created["result"]
        await self.hass.config_entries.subentries.async_configure(created["next_flow"][1], {"model": "fixture/coding"})
        original = next(iter(entry.subentries.values()))
        key = entry.data["api_key"]
        self.client.onboard.reset_mock()
        self.hass.config_entries.async_remove_subentry(entry, original.subentry_id)
        form = await self.hass.config_entries.subentries.async_init((entry.entry_id, "ai_task_data"), context={"source": "user"})
        result = await self.hass.config_entries.subentries.async_configure(form["flow_id"], {"model": "fixture/coding"})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(len(entry.subentries), 1)
        self.assertNotIn(original.subentry_id, entry.subentries)
        self.assertEqual(entry.data["api_key"], key)
        self.client.onboard.assert_not_awaited()

    async def test_ha_loads_labels_for_integration_page_and_subentry_actions(self):
        # HA's frontend reads initiate_flow and entry_type, NOT a subentry title.
        # Go through Core's custom-integration translation loader so missing or
        # misnested shipped keys cannot pass as they did in the flow-only tests.
        loader.async_setup(self.hass)
        labels = await async_get_translations(self.hass, "en", "config_subentries", {"opencode_assist"})
        for kind, name in (("conversation", "conversation agent"), ("ai_task_data", "AI data task")):
            prefix = f"component.opencode_assist.config_subentries.{kind}"
            self.assertEqual(labels[f"{prefix}.initiate_flow.user"], f"Add {name}")
            self.assertEqual(labels[f"{prefix}.initiate_flow.reconfigure"], f"Reconfigure {name}")
            self.assertTrue(labels[f"{prefix}.entry_type"])
            self.assertIn("Configure", labels[f"{prefix}.abort.already_configured"])
        config = await async_get_translations(self.hass, "en", "config", {"opencode_assist"})
        self.assertEqual(config["component.opencode_assist.config.initiate_flow.user"], "Add app connection")
        guidance = config["component.opencode_assist.config.abort.already_configured"]
        self.assertIn("/config/integrations/integration/opencode_assist", guidance)
        self.assertIn("Add conversation agent", guidance)
        self.assertIn("Add AI data task", guidance)
        integration = await loader.async_get_integration(self.hass, "opencode_assist")
        path = Path(integration.file_path)
        self.assertEqual(json.loads((path / "strings.json").read_text()), json.loads((path / "translations/en.json").read_text()))

    async def test_backend_lost_before_subentry_keeps_entry_without_broken_next_flow(self):
        self.client.info.side_effect = HomeAssistantError("fixture offline")
        result = await self.create()
        self.assertEqual(result["type"], "create_entry")
        self.assertNotIn("next_flow", result)
        self.assertEqual(len(self.hass.config_entries.async_entries("opencode_assist")), 1)

    async def test_ha_serves_bundled_brand_images_with_dark_and_hidpi_fallbacks(self):
        from collections import deque
        from aiohttp.test_utils import make_mocked_request
        from homeassistant.components.brands import BrandsIntegrationView
        from homeassistant.components.http import KEY_AUTHENTICATED

        loader.async_setup(self.hass)
        integration = await loader.async_get_integration(self.hass, "opencode_assist")
        self.assertTrue(integration.has_branding)
        self.hass.data["brands"] = deque()
        view = BrandsIntegrationView(self.hass)
        brand = Path(integration.file_path) / "brand"
        with patch.object(view, "_get_image_data", side_effect=AssertionError("Local branding must not fetch the CDN")):
            for kind in ("icon", "logo"):
                for variant in (kind, f"dark_{kind}", f"{kind}@2x", f"dark_{kind}@2x"):
                    request = make_mocked_request("GET", f"/api/brands/integration/opencode_assist/{variant}.png")
                    request[KEY_AUTHENTICATED] = True
                    response = await view.get(request, "opencode_assist", f"{variant}.png")
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.content_type, "image/png")
                    self.assertEqual(response.body, (brand / f"{kind}.png").read_bytes())

    async def test_refresh_after_expiry_empty_models_and_lost_pairing_response(self):
        menu = await self.start()
        form = await self.hass.config_entries.flow.async_configure(menu["flow_id"], {"next_step_id": "conversation"})
        flow_id = form["flow_id"]
        self.client.onboard.side_effect = AssistAuthError("expired")
        result = await self.hass.config_entries.flow.async_configure(flow_id, {})
        self.assertEqual(result["errors"]["base"], "discovery_expired")
        self.app.bootstrap = "c" * 43
        self.client.onboard.side_effect = None
        self.client.onboard.return_value = {"version": 1, "models": []}
        result = await self.hass.config_entries.flow.async_configure(flow_id, {})
        self.assertEqual(result["errors"]["base"], "no_models")
        self.assertTrue(all(not call.args for call in self.client.onboard.await_args_list))
        self.client.onboard.side_effect = [self.info, HomeAssistantError("response lost")]
        result = await self.hass.config_entries.flow.async_configure(flow_id, {})
        self.assertEqual(result["errors"]["base"], "cannot_connect")
        attempted_key = self.client.onboard.await_args.args[0]
        self.app.bootstrap = "d" * 43
        self.client.onboard.side_effect = None
        self.client.onboard.return_value = self.info
        result = await self.hass.config_entries.flow.async_configure(flow_id, {})
        self.assertEqual(result["result"].data["api_key"], attempted_key)
        self.mocks[6].assert_called_with(None, self.app.url, "d" * 43)

    async def test_no_app_retry_multiple_apps_and_parallel_discovery(self):
        self.mocks[4].return_value = []
        form = await self.start("user")
        self.assertEqual(form["errors"]["base"], "no_apps")
        self.mocks[4].return_value = [self.app]
        form = await self.hass.config_entries.flow.async_configure(form["flow_id"], {})
        self.assertEqual(form["step_id"], "choose_entity")
        duplicate = await self.start()
        self.assertEqual(duplicate["reason"], "already_in_progress")
        self.hass.config_entries.flow.async_abort(form["flow_id"])
        self.mocks[4].return_value = [self.app, AppDiscovery("second", "Second", "http://second:8768", "e" * 43, self.app.expires_at)]
        form = await self.start("user")
        self.assertEqual(form["step_id"], "supervisor")
        form = await self.hass.config_entries.flow.async_configure(form["flow_id"], {"addon_slug": self.app.slug})
        self.assertEqual(form["step_id"], "choose_entity")
        self.client.onboard.assert_not_awaited()

    async def test_reauth_and_reconfigure_renew_in_place_without_subentry_loss(self):
        created = await self.create()
        entry = created["result"]
        await self.hass.config_entries.subentries.async_configure(created["next_flow"][1], {"model": "fixture/coding", "llm_hass_api": []})
        subentries = dict(entry.subentries)
        for source in ("reauth", "reconfigure"):
            key = entry.data["api_key"]
            self.client.onboard.reset_mock()
            form = await self.hass.config_entries.flow.async_init("opencode_assist", context={"source": source, "entry_id": entry.entry_id}, data=dict(entry.data) if source == "reauth" else None)
            self.assertEqual(form["step_id"], "hassio_confirm")
            self.client.onboard.assert_not_awaited()
            result = await self.hass.config_entries.flow.async_configure(form["flow_id"], {})
            self.assertEqual(result["type"], "abort")
            self.assertNotEqual(entry.data["api_key"], key)
            self.assertEqual(dict(entry.subentries), subentries)
            self.assertEqual(len(self.hass.config_entries.async_entries("opencode_assist")), 1)

    async def test_discovery_withdrawal_keeps_entry_and_legacy_setup_has_no_migration(self):
        result = await self.create()
        entry = result["result"]
        supervisor = SimpleNamespace(discovery=SimpleNamespace(get=AsyncMock(side_effect=SupervisorError("gone"))))
        with patch("homeassistant.components.hassio.discovery.get_supervisor_client", return_value=supervisor):
            discovery = HassIODiscovery(self.hass)
            await discovery.async_process_del({"service": "opencode_assist", "uuid": "f" * 32})
        self.assertIs(self.hass.config_entries.async_get_entry(entry.entry_id), entry)
        legacy = SimpleNamespace(data={"url": self.app.url, "api_key": "old"})
        with self.assertRaises(ConfigEntryError):
            await async_setup_entry(self.hass, legacy)
        flow = OpenCodeFlow()
        flow.hass = self.hass
        with patch.object(flow, "_get_reauth_entry", return_value=legacy):
            self.assertEqual((await flow.async_step_reauth(legacy.data))["reason"], "legacy_pairing")
        self.assertFalse(hasattr(flow, "async_step_manual"))

    async def test_supervisor_metadata_is_authoritative_and_expired_or_redirected_urls_are_rejected(self):
        message = Discovery(addon=self.app.slug, service="opencode_assist", uuid=UUID("f" * 32), config={
            "version": 1, "url": self.app.url, "bootstrap": self.app.bootstrap, "expires_at": self.app.expires_at})
        client = SimpleNamespace(discovery=SimpleNamespace(list=AsyncMock(return_value=[message])),
            addons=SimpleNamespace(addon_info=AsyncMock(return_value=SimpleNamespace(hostname="fixture-beta", name="OpenCode Beta"))))
        with patch("custom_components.opencode_assist.supervisor.is_hassio", return_value=True), patch("custom_components.opencode_assist.supervisor.get_supervisor_client", return_value=client):
            apps = await async_discover_apps(self.hass)
            self.assertEqual(apps[0].slug, self.app.slug)
            self.assertNotIn(self.app.bootstrap, repr(apps[0]))
            for field, value in (("url", "http://attacker:8768"), ("expires_at", 1), ("bootstrap", "invalid"), ("version", 2)):
                old = message.config[field]
                message.config[field] = value
                self.assertEqual(await async_discover_apps(self.hass), [])
                message.config[field] = old
            client.discovery.list.side_effect = SupervisorError("fixture only")
            with self.assertRaises(HomeAssistantError):
                await async_discover_apps(self.hass)


if __name__ == "__main__":
    unittest.main(verbosity=2)
