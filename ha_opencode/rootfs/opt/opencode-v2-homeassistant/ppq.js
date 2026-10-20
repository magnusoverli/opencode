import { Plugin, Model } from "@opencode/plugin";
import { isPrivateModel, readJsonResponse, validateModels } from "../ppq-private-runtime/catalog.js";

export const PPQ_PLUGIN_ID = "homeassistant.ppq-private";
const PROVIDER = "ppq-private";

export function createPpqSetup({ fetcher = fetch, interval = 60_000, schedule = setInterval, unschedule = clearInterval, warn = console.warn } = {}) {
  return async (ctx) => {
    const requested = ctx.options?.defaultModel;
    if (requested !== undefined && !isPrivateModel(requested)) throw new Error("Invalid PPQ default model");
    // Preserve an explicitly configured private default even if it has retired
    // or discovery is offline. Otherwise upstream can fall back to a public
    // provider. Label this one user-selected entry explicitly unavailable;
    // attempts still reach the proxy's live availability check and fail closed.
    const unavailable = () => requested ? [{ ...Model.Info.default(PROVIDER, requested),
      name: `PPQ ${requested.slice(8)} (Unavailable; select a current private model)`,
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      limit: { context: 32768, output: 8192 },
    }] : [];
    let models = unavailable();
    let disposed = false;
    let pending;
    const registration = await ctx.provider.transform((editor) => { editor.models.set(PROVIDER, models); });
    const refresh = () => pending ??= (async () => {
      try {
        const result = await readJsonResponse(await fetcher("http://127.0.0.1:8787/v1/models", {
          headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(12_000),
        }));
        const next = validateModels(result.data).map((m) => ({
          ...Model.Info.default(PROVIDER, m.id), name: m.name, modelID: m.id,
          capabilities: { ...Model.Info.default(PROVIDER, m.id).capabilities, ...m.capabilities },
          limit: { context: m.context_length, output: Math.min(8192, m.context_length) },
          // Unknown prices are not advertised as free.
          cost: m.cost ? [m.cost] : [],
        }));
        if (requested && !next.some((m) => m.id === requested)) next.push(...unavailable());
        if (!disposed && JSON.stringify(next) !== JSON.stringify(models)) {
          models = next;
          await ctx.provider.reload();
        }
      } catch {
        // The proxy owns bounded stale-cache policy. A 503 (including expired
        // cache) must not leave indefinitely stale models in OpenCode's picker.
        if (!disposed && models.length) { models = unavailable(); await ctx.provider.reload().catch(() => {}); }
        warn("PPQ private models unavailable; discovery will retry automatically. Existing sessions are unchanged.");
      }
    })().finally(() => { pending = undefined; });
    await refresh();
    const timer = schedule(refresh, interval);
    timer.unref?.();
    return async () => { disposed = true; unschedule(timer); await pending; await registration.dispose(); };
  };
}

export default Plugin.define({ id: PPQ_PLUGIN_ID, setup: createPpqSetup() });
