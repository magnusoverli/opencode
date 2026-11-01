/** Supervisor 2026.10.3 APIApps: validate the full options body, POST
 * {options: ...}, then read back. Supervisor has no atomic If-Match contract.
 * Previews are process-local, single-use and expire on restart or after 5 min.
 */
import { createHmac, randomBytes } from "node:crypto";

const sensitive = /password|passwd|token|secret|api[_-]?key|authorization|cookie|private[_-]?key/i;
const object = value => value && typeof value === "object" && !Array.isArray(value);
function canonical(value, depth = 0) {
  if (depth > 32) throw new Error("App options exceed the supported nesting bound.");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (object(value)) {
    if (Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Unsafe app option key.");
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  return value;
}
function redact(value, depth = 0) {
  if (depth > 32) return "<depth limit>";
  // Arbitrary app schemas may use unrecognizable credential names. Withhold all
  // option strings, not just fields conventionally named password or token.
  if (typeof value === "string") return "<redacted string>";
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, depth + 1)]));
  return value;
}
function merge(base, changes, schema) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(changes)) {
    // /info returns UiOptions' list of {name,type,format,schema,multiple},
    // not the manifest's raw {key: 'str'|'password'|...} mapping.
    const field = Array.isArray(schema) ? schema.find(node => node?.name === key) : undefined;
    if (!field) throw new Error("Unrecognized app option; use the app Configuration tab.");
    if (sensitive.test(key) || field.format === "password") throw new Error("Edit credential options manually in the app Configuration tab.");
    if (field.multiple === true) throw new Error("Array options require manual configuration.");
    if (object(value)) {
      if (field.type !== "schema" || !Array.isArray(field.schema)) throw new Error("Expected a scalar option, not an object merge.");
      if (base[key] !== undefined && !object(base[key])) throw new Error("Cannot replace an option's type through a merge preview.");
      result[key] = merge(base[key] ?? {}, value, field.schema);
    } else {
      // Whole-array replacement can silently discard nested credentials. Keep
      // this first surface deliberately limited to object merges and scalars.
      if (Array.isArray(value) || value === null) throw new Error("Array replacement and option deletion require manual configuration.");
      result[key] = value;
    }
  }
  return result;
}

export function createSupervisorAppManager({ apps, selfSlug, now = Date.now } = {}) {
  const key = randomBytes(32);
  const plans = new Map();
  const busy = new Set();
  const revision = info => createHmac("sha256", key).update(JSON.stringify(canonical({
    options: info.options, schema: info.schema, version: info.version, state: info.state,
  }))).digest("hex");

  function slug(value) {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)) throw new Error("Invalid app slug.");
    return value;
  }
  async function read(value) {
    let info;
    try { info = await apps.info(slug(value)); } catch { throw new Error("App information unavailable; inspect Supervisor permissions and availability."); }
    if (!object(info) || !object(info.options) || (info.schema !== null && !Array.isArray(info.schema)) || info.slug !== value || JSON.stringify(info.options).length > 262144) throw new Error("Incomplete or oversized app options; no preview can be created.");
    canonical(info.options);
    return info;
  }
  async function guard(value) {
    const self = await selfSlug();
    if (!self || value === "self" || value === self) throw new Error("Current-app mutation is prohibited or current-app identity is unavailable.");
  }
  async function inspect(value) {
    const info = await read(value);
    return { slug: value, state: info.state, version: info.version, revision: revision(info), options: redact(info.options),
      option_keys: (info.schema ?? []).slice(0, 256).map(node => node.name),
      note: "All option strings are withheld. Omitted fields are preserved; credentials, arrays and deletions require manual editing." };
  }
  async function valid(value, options) {
    let result;
    try { result = await apps.validateOptions(value, options); } catch { throw new Error("Supervisor option validation failed or is unavailable; no mutation was sent."); }
    if (result?.valid !== true) throw new Error("Supervisor option validation failed; review the proposal locally. No mutation was sent.");
  }
  async function preview({ slug: value, expected_revision, changes, action = "options" }) {
    slug(value); await guard(value);
    const info = await read(value);
    if (expected_revision !== revision(info)) throw new Error("App inspection is stale; inspect again before proposing changes.");
    if (!["options", "start", "stop", "restart"].includes(action)) throw new Error("Unsupported app operation.");
    let next;
    if (action === "options") {
      if (!object(changes) || !Object.keys(changes).length || JSON.stringify(changes).length > 65536) throw new Error("Provide a bounded object of option changes.");
      canonical(changes);
      next = merge(info.options, changes, info.schema);
      await valid(value, next);
    } else if (changes !== undefined) throw new Error("Lifecycle operations do not accept option changes.");
    for (const [id, plan] of plans) if (plan.expires <= now()) plans.delete(id);
    if (plans.size >= 100) throw new Error("Too many pending app previews; wait for expiry.");
    const id = randomBytes(24).toString("hex");
    const review = { slug: value, action, ...(next ? { changes: redact(changes) } : {}) };
    plans.set(id, { slug: value, action, revision: revision(info), next, review, expires: now() + 300000 });
    return { preview_id: id, slug: value, action, expires_in: 300,
      review,
      ...(next ? { changes: redact(changes) } : {}),
      note: "Review supplied values before approval. Application rechecks the source, but Supervisor has no atomic conditional save. No restart is implied by saving options." };
  }
  async function apply(id, review) {
    const plan = plans.get(id);
    plans.delete(id); // An uncertain operation must never be replayed blindly.
    if (!plan || plan.expires <= now()) return { status: "preview_unavailable", saved: false };
    if (JSON.stringify(canonical(review)) !== JSON.stringify(canonical(plan.review))) return { status: "review_mismatch", saved: false };
    if (busy.has(plan.slug)) return { status: "busy", saved: false };
    busy.add(plan.slug);
    let sent = false;
    try {
      await guard(plan.slug);
      if (revision(await read(plan.slug)) !== plan.revision) return { status: "conflict", saved: false };
      if (plan.action === "options") await valid(plan.slug, plan.next);
      if (revision(await read(plan.slug)) !== plan.revision) return { status: "conflict", saved: false };
      sent = true;
      if (plan.action === "options") await apps.setOptions(plan.slug, plan.next);
      else await apps.lifecycle(plan.slug, plan.action);
      const after = await read(plan.slug);
      const verified = plan.action === "options"
        ? JSON.stringify(canonical(after.options)) === JSON.stringify(canonical(plan.next))
        : after.state === (plan.action === "stop" ? "stopped" : "started");
      return { status: verified ? "saved" : "outcome_unknown", saved: verified ? true : null, verified,
        active: plan.action === "options" ? null : verified,
        note: plan.action === "options" ? "Options saved; app restart/application remains separate." : "Observed lifecycle state; inspect app logs for readiness." };
    } catch {
      return { status: sent ? "outcome_unknown" : "rejected", saved: sent ? null : false,
        note: "Inspect current app state before retrying. No automatic retry or rollback was attempted." };
    } finally { busy.delete(plan.slug); }
  }
  return { inspect, preview, apply };
}
