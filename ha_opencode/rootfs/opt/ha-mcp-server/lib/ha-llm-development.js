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

Upstream references:
- Architecture: home-assistant/architecture#1412
- Core plumbing: home-assistant/core#174253
- Assist migration: home-assistant/core#175659
- Developer docs: home-assistant/developers.home-assistant#3201
- Current LLM API docs update: home-assistant/developers.home-assistant#3236

Use this when developing a Home Assistant integration or custom integration that should contribute curated tools to Assist through \`<integration>/llm.py\`. This is different from OpenCode's own MCP server: native HA LLM tools run inside Home Assistant and are consumed by Assist/native MCP when available.

Checklist:
- Put the file at \`custom_components/${domain}/llm.py\` or \`homeassistant/components/${domain}/llm.py\`.
- Expose \`async_get_tools(hass, llm_context, api_id) -> llm.LLMTools | None\`.
- Use \`api_id\` to return tools only for APIs your integration supports; return \`None\` otherwise.
- Return only tools that are relevant for the current \`llm_context\`.
- Keep prompt guidance next to the tools by returning \`llm.LLMTools(prompt=...)\`.
- Read tool arguments from \`tool_input.tool_args\`; request context lives on \`llm_context\`.
- Raise \`HomeAssistantError\` for expected tool failures; do not encode control-flow errors as success payloads.
- Keep destructive/admin tools out of Assist unless there is a clear approval model.
- Add tests for tool visibility, schema validation, success, and error paths.
- Once the MCP Server integration is set up, registered LLM APIs are exposed at \`/api/mcp/<API ID>\`.
- Home Assistant also exposes the MCP Server integration's configured API at \`/api/mcp\`; keyed custom API endpoints require admin access except for Assist.

Starter template:

\`\`\`python
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import llm
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.llm import LLMContext, ToolInput
from homeassistant.util.json import JsonObjectType


class ${toolClass}(llm.Tool):
    """Example read-only LLM tool for ${domain}."""

    name = "${domain}_example_status"
    description = "Return a concise ${domain} status summary."
    parameters = vol.Schema({
        vol.Optional("include_details"): bool,
    })

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
) -> llm.LLMTools | None:
    """Return tools to expose to the LLM for this request."""
    if api_id != "assist":
        return None

    return llm.LLMTools(
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
- Set \`APIInstance.custom_serializer\` if your tool schemas need custom conversion for selectors or other voluptuous shapes.

Minimal custom API sketch:

\`\`\`python
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import llm
from homeassistant.helpers.llm import APIInstance, LLMContext


class ${apiClass}(llm.API):
    """Custom ${domain} LLM API."""

    async def async_get_api_instance(self, llm_context: LLMContext) -> APIInstance:
        """Return the API instance for this request."""
        return APIInstance(
            api=self,
            api_prompt="Use these tools for ${domain}-specific requests.",
            llm_context=llm_context,
            tools=[${toolClass}()],
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
`;
}
