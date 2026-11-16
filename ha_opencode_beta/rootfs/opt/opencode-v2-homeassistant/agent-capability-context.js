// Observe the runtime's permission-filtered model tools rather than duplicating
// its permission evaluator or accepting a caller-supplied agent/profile claim.
const CAPABILITIES_TOOL = "homeassistant_get_agent_capabilities";
const TTL_MS = 5 * 60 * 1000;
const MAX_CONTEXTS = 128;
const MAX_TOOLS = 512;
const NOTE = "Snapshot of tools offered at the OpenCode model-context hook for this agent. Later plugin changes and per-call permissions may further restrict execution; listed tools are not authorization or proof of successful execution.";

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CONTEXTS) map.delete(map.keys().next().value);
}

function projectContext(context) {
  if (!context) return {
    status: "unknown",
    note: "No fresh matching model-context snapshot is available for this call. The server catalogue is not the active agent's tool list.",
  };
  return {
    status: "observed",
    agent_id: context.agent,
    source: "opencode_model_context",
    observed_at: new Date(context.time).toISOString(),
    tools: context.bundled.length,
    tool_names: context.bundled,
    native_tools: context.native.length,
    native_tool_names: context.native,
    note: NOTE,
  };
}

export function annotateAgentCapabilities(result, context) {
  const rewrite = text => {
    if (typeof text !== "string") return text;
    try {
      const data = JSON.parse(text);
      if (data?.mcp?.scope !== "configured_server_catalogue") return text;
      return JSON.stringify({ ...data, mcp: { ...data.mcp, current_agent: projectContext(context) } });
    } catch { return text; }
  };
  return {
    ...result,
    content: typeof result.content === "string" ? rewrite(result.content)
      : Array.isArray(result.content)
        ? result.content.map(item => item.type === "text" ? { ...item, text: rewrite(item.text) } : item)
        : result.content,
  };
}

export async function registerAgentCapabilityContext(ctx, { now = Date.now } = {}) {
  // Older hosts/test adapters still get truthful server-only/unknown reporting.
  if (!ctx.session?.hook || !ctx.tool?.hook) return null;
  const contexts = new Map(), calls = new Map(), registrations = [];
  const fresh = value => value && now() - value.time >= 0 && now() - value.time < TTL_MS;
  try {
    registrations.push(await ctx.session.hook("context", event => {
      // Keep only tool metadata, not prompts, home data or model messages.
      for (const [key, value] of contexts) if (!fresh(value)) contexts.delete(key);
      const names = Object.keys(event.tools ?? {}).filter(name => name.startsWith("homeassistant_"));
      boundedSet(contexts, event.sessionID, {
        agent: event.agent, names: names.length <= MAX_TOOLS ? names : null, time: now(),
      });
    }));
    registrations.push(await ctx.tool.hook("execute.before", event => {
      if (event.tool !== CAPABILITIES_TOOL) return;
      for (const [key, value] of calls) if (!fresh(value)) calls.delete(key);
      const observed = contexts.get(event.sessionID);
      let snapshot = null;
      if (fresh(observed) && observed.agent === event.agent && observed.names) {
        const names = observed.names;
        const native = names.filter(name => name.startsWith("homeassistant_native_")).sort();
        const bundled = names.filter(name => name.startsWith("homeassistant_") &&
          !name.startsWith("homeassistant_native_")).map(name => name.slice("homeassistant_".length)).sort();
        if (bundled.length + native.length <= MAX_TOOLS && bundled.includes("get_agent_capabilities")) {
          snapshot = { agent: observed.agent, time: observed.time, bundled, native };
        }
      }
      boundedSet(calls, JSON.stringify([event.sessionID, event.id]), { agent: event.agent, snapshot, time: now() });
    }));
    registrations.push(await ctx.tool.hook("execute.after", event => {
      if (event.tool !== CAPABILITIES_TOOL) return;
      const key = JSON.stringify([event.sessionID, event.id]), call = calls.get(key);
      calls.delete(key);
      if (event.status !== "completed") return;
      const snapshot = fresh(call) && call.agent === event.agent && fresh(call.snapshot) ? call.snapshot : null;
      event.result = annotateAgentCapabilities(event.result, snapshot);
    }));
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose();
    throw error;
  }
  return { async dispose() {
    contexts.clear();
    calls.clear();
    for (const registration of registrations.reverse()) await registration.dispose();
  } };
}
