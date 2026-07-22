export function buildHaLlmDevelopmentGuide(args = {}) {
  const domain = String(args?.integration_domain || "example_domain")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_") || "example_domain";
  const toolClass = String(args?.tool_class || "ExampleStatusTool")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "") || "ExampleStatusTool";
  const apiClass = toolClass.endsWith("Tool")
    ? `${toolClass.slice(0, -4)}API`
    : `${toolClass}API`;

  return `# Home Assistant native LLM tool provider guide

Availability: the \`llm\` integration, the per-domain LLM tool platforms, and the keyed
\`/api/mcp/<API ID>\` endpoints first ship in **Home Assistant 2026.8**. None of this exists in
2026.7.x or earlier — on those releases only the configured \`/api/mcp\` endpoint and the legacy
\`/mcp_server/sse\` transport are served, and \`<integration>/llm.py\` is never loaded.

Upstream references:
- Architecture: home-assistant/architecture#1412
- Core plumbing: home-assistant/core#174253
- API ID passed to platforms: home-assistant/core#175572
- Assist migration: home-assistant/core#175659
- Keyed MCP endpoints: home-assistant/core#175570
- Tool schema conversion fix: home-assistant/core#176814 (issue #176762)
- Developer docs: home-assistant/developers.home-assistant#3201
- Current LLM API docs update: home-assistant/developers.home-assistant#3236

Use this when developing a Home Assistant integration or custom integration that should contribute
curated tools to Assist through \`<integration>/llm.py\`. This is different from OpenCode's own MCP
server: native HA LLM tools run inside Home Assistant and are consumed by Assist/native MCP when
available.

Checklist:
- Put the file at \`custom_components/${domain}/llm.py\` or \`homeassistant/components/${domain}/llm.py\`.
- Expose \`async_get_tools(hass, llm_context, api_id) -> LLMTools | None\` as a module-level \`@callback\`.
- No manifest change is needed. Home Assistant discovers \`llm.py\` for every loaded integration
  through \`LazyIntegrationPlatforms\`; core platforms such as \`light\` declare no \`llm\` dependency.
- Use \`api_id\` to return tools only for APIs your integration supports; return \`None\` otherwise.
  Compare against \`LLM_API_ASSIST\` rather than the literal string.
- Gate on exposure. Return \`None\` when \`llm_context.assistant\` is unset, and filter entities with
  \`async_should_expose(hass, llm_context.assistant, entity_id)\` so the assistant only ever sees what
  the user exposed to it.
- Prefer wrapping existing intents with \`IntentTool\` over hand-written tools. Twelve of the fifteen
  core platforms do exactly this, which keeps sentence support and tool support in sync.
- Keep prompt guidance next to the tools by returning \`LLMTools(tools=..., prompt=...)\`.
- Read tool arguments from \`tool_input.tool_args\`; request context lives on \`llm_context\`.
- Raise \`HomeAssistantError\` for expected tool failures; do not encode control-flow errors as success payloads.
- Keep destructive/admin tools out of Assist unless there is a clear approval model.
- Add tests for tool visibility, schema validation, success, and error paths.
- Once the MCP Server integration is set up, registered LLM APIs are exposed at \`/api/mcp/<API ID>\`.
- Home Assistant also exposes the MCP Server integration's configured API at \`/api/mcp\`; keyed custom API endpoints require admin access except for Assist.

## Tool parameter schema gotchas

Tool \`parameters\` are converted to JSON Schema by \`voluptuous_openapi\`. Custom function validators
have no type annotation it can read, so before home-assistant/core#176814 (Home Assistant 2026.8)
they serialized to an empty schema:

\`\`\`python
# Produces {"anyOf": [{}, {"items": {"type": "string"}, "type": "array"}]}
vol.Optional("domain"): vol.Any(cv.string, [cv.string])
\`\`\`

An empty member matches anything, so MCP clients that strictly compile tool parameters refuse the
union, fall back to sending raw arguments, and Home Assistant rejects the call with
\`extra keys not allowed @ data['__unparsedToolInput']\`. This is what broke \`GetLiveContext\` for
external clients on 2026.7.x.

Write schemas that convert cleanly on every release:

\`\`\`python
vol.Optional("domain"): vol.All(cv.ensure_list, [cv.string])  # array of strings
vol.Optional("include_details"): bool                          # plain types convert directly
vol.Optional("area"): selector.AreaSelector()                  # selectors have a serializer
\`\`\`

From 2026.8, \`selector_serializer\` also maps bare \`cv.string\`, \`cv.boolean\`, and
\`intent.non_empty_string\`, but only \`APIInstance.custom_serializer=selector_serializer\` activates
it — so prefer plain types and \`cv.ensure_list\` if your integration must support older cores.

## Preferred pattern: expose your intents

This mirrors \`homeassistant/components/light/llm.py\`.

\`\`\`python
from homeassistant.components.homeassistant import async_should_expose
from homeassistant.components.llm import LLMTools
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import intent
from homeassistant.helpers.llm import LLM_API_ASSIST, IntentTool, LLMContext, Tool

from .const import DOMAIN
from .intent import INTENT_DO_SOMETHING

# Intents owned by this integration that are exposed as LLM tools.
LLM_INTENTS = (INTENT_DO_SOMETHING,)


@callback
def async_get_tools(
    hass: HomeAssistant, llm_context: LLMContext, api_id: str
) -> LLMTools | None:
    """Return LLM tools for the integration's intents when its domain is exposed."""
    if api_id != LLM_API_ASSIST:
        return None

    if not llm_context.assistant:
        return None

    if not any(
        async_should_expose(hass, llm_context.assistant, state.entity_id)
        for state in hass.states.async_all(DOMAIN)
    ):
        return None

    tools: list[Tool] = [
        IntentTool(handler.intent_type, handler)
        for handler in intent.async_get(hass)
        if handler.intent_type in LLM_INTENTS
    ]
    return LLMTools(tools=tools)
\`\`\`

## Hand-written tool

Use this when the behavior does not map to an intent. Modeled on
\`homeassistant/components/llm/llm.py\`.

\`\`\`python
from __future__ import annotations

from typing import override

import voluptuous as vol

from homeassistant.components.llm import LLMTools
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.llm import LLM_API_ASSIST, LLMContext, Tool, ToolInput
from homeassistant.util.json import JsonObjectType


class ${toolClass}(Tool):
    """Example read-only LLM tool for ${domain}."""

    name = "${domain}_example_status"
    description = "Return a concise ${domain} status summary."
    parameters = vol.Schema({
        vol.Optional("include_details"): bool,
    })

    @override
    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Call the tool."""
        if "${domain}" not in hass.data:
            raise HomeAssistantError("${domain} is not loaded")

        result: JsonObjectType = {"success": True, "result": "${domain} is ready"}
        if tool_input.tool_args.get("include_details"):
            result["details"] = {
                "language": llm_context.language,
                "device_id": llm_context.device_id,
            }
        return result


@callback
def async_get_tools(
    hass: HomeAssistant,
    llm_context: LLMContext,
    api_id: str,
) -> LLMTools | None:
    """Return tools to expose to the LLM for this request."""
    if api_id != LLM_API_ASSIST:
        return None

    return LLMTools(
        tools=[${toolClass}()],
        prompt="Use ${toolClass} only when the user asks about ${domain} status.",
    )
\`\`\`

Full custom API notes:
- Use \`<integration>/llm.py\` with \`async_get_tools(...)\` when your integration contributes tools to an existing API such as \`assist\`.
- Create and register a custom \`llm.API\` only when your integration owns a distinct LLM API surface.
- Implement \`async_get_api_instance(self, llm_context) -> APIInstance\`; do not implement API-level \`async_get_tools\`.
- Instantiate \`llm.API\` with keyword arguments, including the required \`hass\`, \`id\`, and \`name\` fields.
- The registered API ID becomes its native MCP endpoint: \`/api/mcp/<API ID>\`.
- Set \`APIInstance.custom_serializer\` if your tool schemas need custom conversion for selectors or
  other voluptuous shapes. \`homeassistant.helpers.llm.selector_serializer\` is the one Assist uses.

Minimal custom API sketch:

\`\`\`python
from typing import override

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import llm
from homeassistant.helpers.llm import APIInstance, LLMContext, selector_serializer


class ${apiClass}(llm.API):
    """Custom ${domain} LLM API."""

    @override
    async def async_get_api_instance(self, llm_context: LLMContext) -> APIInstance:
        """Return the API instance for this request."""
        return APIInstance(
            api=self,
            api_prompt="Use these tools for ${domain}-specific requests.",
            llm_context=llm_context,
            tools=[${toolClass}()],
            custom_serializer=selector_serializer,
        )


async def async_setup_api(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Register the ${domain} LLM API."""
    unregister = llm.async_register_api(
        hass,
        ${apiClass}(
            hass=hass,
            id="${domain}",
            name=entry.title,
        ),
    )
    entry.async_on_unload(unregister)
\`\`\`

## Recent upstream changes to be aware of

- \`homeassistant/helpers/llm.py\` was roughly halved by home-assistant/core#176082 once the Assist
  API moved into the \`llm\` integration. Older blog posts and snippets that reach into its internals
  are stale.
- \`async_render_no_api_prompt\` is deprecated (home-assistant/core#176111).
- \`LLMContext.assistant\` is now a required, non-optional field (home-assistant/core#175553).
- Script tool aliasing moved into the \`script\` integration (home-assistant/core#176114).
`;
}
