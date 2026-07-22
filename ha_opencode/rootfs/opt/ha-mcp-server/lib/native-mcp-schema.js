/**
 * Repair helpers for tool input schemas served by Home Assistant native MCP.
 *
 * Home Assistant builds tool schemas from voluptuous validators. Before
 * home-assistant/core#176814 (first released in 2026.8), `voluptuous_openapi`
 * serialized custom function validators such as `cv.string` to an empty schema,
 * so a wrapper like `vol.Any(cv.string, [cv.string])` produced:
 *
 *   {"anyOf": [{}, {"type": "array", "items": {"type": "string"}}]}
 *
 * An empty subschema matches anything, and MCP clients that strictly compile
 * tool parameters refuse to compile the union. They then fall back to sending
 * the raw arguments wrapped in `__unparsedToolInput`, which Home Assistant
 * rejects with `extra keys not allowed @ data['__unparsedToolInput']`. See
 * home-assistant/core#176762.
 *
 * Dropping the empty member restores a schema clients can compile without
 * changing what the server accepts: the empty member added no constraint. On
 * Home Assistant 2026.8 and later the schemas already arrive clean and these
 * helpers are a no-op.
 */

const COMBINATOR_KEYS = ["anyOf", "oneOf", "allOf"];
const CHILD_SCHEMA_KEYS = ["items", "additionalProperties", "contains", "not", "propertyNames"];
const CHILD_SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"];
const CHILD_SCHEMA_LIST_KEYS = ["prefixItems"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptySchema(value) {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Recursively remove empty `{}` members from schema combinators.
 *
 * Returns a new schema; the input is never mutated. `repaired` counts how many
 * combinators were changed, so callers can log whether the workaround was
 * actually needed on this Home Assistant version.
 */
export function sanitizeToolInputSchema(schema) {
  let repaired = 0;

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;

    const result = {};
    for (const [key, value] of Object.entries(node)) {
      if (COMBINATOR_KEYS.includes(key) && Array.isArray(value)) {
        result[key] = value;
        continue;
      }
      if (CHILD_SCHEMA_KEYS.includes(key)) {
        result[key] = walk(value);
        continue;
      }
      if (CHILD_SCHEMA_LIST_KEYS.includes(key) && Array.isArray(value)) {
        result[key] = value.map(walk);
        continue;
      }
      if (CHILD_SCHEMA_MAP_KEYS.includes(key) && isPlainObject(value)) {
        result[key] = Object.fromEntries(
          Object.entries(value).map(([childKey, childValue]) => [childKey, walk(childValue)])
        );
        continue;
      }
      result[key] = value;
    }

    for (const key of COMBINATOR_KEYS) {
      if (!Array.isArray(result[key])) continue;

      const members = result[key].map(walk);
      const kept = members.filter((member) => !isEmptySchema(member));

      if (kept.length === members.length) {
        result[key] = members;
        continue;
      }

      repaired += 1;

      if (kept.length === 0) {
        // Every branch was unconstrained, so the combinator said nothing.
        delete result[key];
        continue;
      }

      if (kept.length > 1) {
        result[key] = kept;
        continue;
      }

      // A single surviving branch is the schema. Inline it, but never let it
      // overwrite sibling annotations such as `description` that Home Assistant
      // sets next to the combinator.
      delete result[key];
      const [only] = kept;
      if (isPlainObject(only)) {
        for (const [inlineKey, inlineValue] of Object.entries(only)) {
          if (!(inlineKey in result)) result[inlineKey] = inlineValue;
        }
      }
    }

    return result;
  }

  const sanitized = walk(schema);
  return { schema: sanitized, repaired };
}

/**
 * Repair the `inputSchema` of every tool in a `tools/list` result.
 *
 * Returns the (possibly rewritten) result plus how many tools were changed.
 * Anything that is not a recognizable tool list is passed through untouched so
 * an unexpected payload shape can never break the bridge.
 */
export function sanitizeToolsListResult(result) {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) {
    return { result, repairedTools: 0, repairedToolNames: [] };
  }

  let repairedTools = 0;
  const repairedToolNames = [];
  const tools = result.tools.map((tool) => {
    if (!isPlainObject(tool) || !isPlainObject(tool.inputSchema)) return tool;

    const { schema, repaired } = sanitizeToolInputSchema(tool.inputSchema);
    if (!repaired) return tool;

    repairedTools += 1;
    if (tool.name) repairedToolNames.push(tool.name);
    return { ...tool, inputSchema: schema };
  });

  if (repairedTools === 0) {
    return { result, repairedTools: 0, repairedToolNames: [] };
  }

  return {
    result: { ...result, tools },
    repairedTools,
    repairedToolNames,
  };
}
