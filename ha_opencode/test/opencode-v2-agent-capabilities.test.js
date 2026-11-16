import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateAgentCapabilities, registerAgentCapabilityContext } from "../rootfs/opt/opencode-v2-homeassistant/agent-capability-context.js";

const server = { mcp: { scope: "configured_server_catalogue", tools: 70, tool_names: ["supervisor_app_apply"] } };
const capabilities = "homeassistant_get_agent_capabilities";
async function fixture() {
  const hooks = {}, disposed = [];
  let time = 1000;
  const register = async (name, callback) => {
    hooks[name] = callback;
    return { async dispose() { disposed.push(name); } };
  };
  const registration = await registerAgentCapabilityContext({
    session: { hook: register }, tool: { hook: register },
  }, { now: () => time });
  const context = (sessionID, agent, names) => hooks.context({
    sessionID, agent, tools: Object.fromEntries(names.map(name => [name, {}])),
  });
  const before = (sessionID, agent, id = "call") => hooks["execute.before"]({ tool: capabilities, sessionID, agent, id });
  const after = (sessionID, agent, id = "call") => {
    const event = { tool: capabilities, status: "completed", sessionID, agent, id,
      result: { content: [{ type: "text", text: JSON.stringify(server) }], metadata: { retained: true } } };
    hooks["execute.after"](event);
    return JSON.parse(event.result.content[0].text);
  };
  return { context, before, after, hooks, registration, disposed, tick: ms => { time += ms; } };
}

test("capabilities separate the shared catalogue from the runtime-filtered agent snapshot", async () => {
  const f = await fixture();
  f.context("reader", "home-assistant-read-only", [capabilities, "homeassistant_supervisor_app_inspect", "homeassistant_supervisor_app_preview", "read"]);
  f.before("reader", "home-assistant-read-only");
  const result = f.after("reader", "home-assistant-read-only");
  assert.equal(result.mcp.tools, 70);
  assert.deepEqual(result.mcp.current_agent.tool_names, ["get_agent_capabilities", "supervisor_app_inspect", "supervisor_app_preview"]);
  assert.equal(result.mcp.current_agent.agent_id, "home-assistant-read-only");
  assert.equal(result.mcp.current_agent.tools, 3);
  assert.equal(result.mcp.current_agent.status, "observed");
  await f.registration.dispose();
  assert.deepEqual(f.disposed, ["execute.after", "execute.before", "context"]);
});

test("parallel sessions, switching agents and in-flight context changes do not mix capability lists", async () => {
  const f = await fixture();
  f.context("one", "build", [capabilities, "homeassistant_supervisor_app_apply", "homeassistant_native_GetState"]);
  f.context("two", "reader", [capabilities]);
  f.before("one", "build");
  f.before("two", "reader");
  f.context("one", "reader", [capabilities]);
  const build = f.after("one", "build").mcp.current_agent;
  assert.equal(build.tool_names.includes("supervisor_app_apply"), true);
  assert.deepEqual(build.native_tool_names, ["homeassistant_native_GetState"]);
  assert.equal(build.native_tools, 1);
  assert.deepEqual(f.after("two", "reader").mcp.current_agent.tool_names, ["get_agent_capabilities"]);
  f.before("one", "reader", "new");
  assert.deepEqual(f.after("one", "reader", "new").mcp.current_agent.tool_names, ["get_agent_capabilities"]);
  f.before("one", "build", "wrong-agent");
  assert.equal(f.after("one", "build", "wrong-agent").mcp.current_agent.status, "unknown");
});

test("direct, stale, oversized and evicted contexts are unknown rather than guessed from the server profile", async () => {
  const f = await fixture();
  assert.equal(f.after("none", "build").mcp.current_agent.status, "unknown");
  f.context("one", "reader", [capabilities]);
  f.tick(300001);
  f.before("one", "reader");
  assert.equal(f.after("one", "reader").mcp.current_agent.status, "unknown");
  f.context("one", "reader", [capabilities, ...Array.from({ length: 513 }, (_, i) => `homeassistant_tool_${i}`)]);
  f.before("one", "reader");
  assert.equal(f.after("one", "reader").mcp.current_agent.status, "unknown");
  for (let i = 0; i < 129; i++) f.context(`session${i}`, "reader", [capabilities]);
  f.before("session0", "reader");
  assert.equal(f.after("session0", "reader").mcp.current_agent.status, "unknown");
});

test("captured tool lists do not change through references retained by another context hook", async () => {
  const f = await fixture();
  const tools = { [capabilities]: {}, homeassistant_supervisor_app_inspect: {} };
  f.hooks.context({ sessionID: "one", agent: "reader", tools });
  tools.homeassistant_supervisor_app_apply = {};
  f.before("one", "reader");
  assert.deepEqual(f.after("one", "reader").mcp.current_agent.tool_names, ["get_agent_capabilities", "supervisor_app_inspect"]);
});

test("annotation preserves unrelated results, attachments and metadata without accepting tool arguments as context", () => {
  const result = { content: [{ type: "text", text: "plain text" }, { type: "file", uri: "fixture:one" }], metadata: { kept: true } };
  assert.deepEqual(annotateAgentCapabilities(result, null), result);
  const annotated = annotateAgentCapabilities({ content: JSON.stringify(server), metadata: { kept: true } }, null);
  assert.equal(JSON.parse(annotated.content).mcp.current_agent.status, "unknown");
  assert.deepEqual(annotated.metadata, { kept: true });
});
