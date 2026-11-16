// Supervisor UiOptions uses {type:"select", options:[...]} for list(...) fields.
// A schema or innocuous key name alone is not evidence that free text is safe.
export const sensitiveOption = /password|passwd|token|secret|api[_-]?key|authorization|cookie|private[_-]?key/i;
const LOG_LEVELS = new Set(["trace", "debug", "info", "notice", "warn", "warning", "error", "fatal", "critical", "off"]);
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fieldFor = (schema, name) => Array.isArray(schema) ? schema.find(field => field?.name === name) : undefined;
const privateField = (path, field) => path.some(key => sensitiveOption.test(key)) || field?.format === "password";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAX_FIELDS = 256;

function visibleString(value, field, path) {
  return path.at(-1) === "log_level" && field?.type === "select" && field.multiple !== true &&
    Array.isArray(field.options) && field.options.length > 0 && field.options.length <= LOG_LEVELS.size &&
    field.options.every(option => LOG_LEVELS.has(option)) && field.options.includes(value);
}

export function optionView(value, field, path, present = true) {
  if (!present) return { state: "unset" };
  if (privateField(path, field)) return { state: "withheld" };
  if (typeof value === "string") {
    return visibleString(value, field, path) ? { state: "visible", value } : { state: "withheld" };
  }
  // Composite values are inspected through their children, never echoed in a diff.
  if (object(value) || Array.isArray(value)) return { state: "withheld" };
  return { state: "visible", value };
}

export function redactOptions(options, schema, path = []) {
  return Object.fromEntries(Object.entries(options).map(([key, value]) => {
    const field = fieldFor(schema, key), nextPath = [...path, key];
    if (privateField(nextPath, field)) return [key, "<withheld>"];
    if (object(value)) return [key, redactOptions(value, field?.schema, nextPath)];
    const view = optionView(value, field, nextPath);
    return [key, view.state === "visible" ? view.value : "<withheld>"];
  }));
}

export function inspectOptionStates(options, schema) {
  const entries = [];
  let truncated = false;
  const walk = (values, fields, path = [], depth = 0) => {
    if (depth > 32) { truncated = true; return; }
    const names = new Set([
      ...Object.keys(values ?? {}),
      ...(Array.isArray(fields) ? fields.filter(field => typeof field?.name === "string").map(field => field.name) : []),
    ]);
    for (const name of names) {
      if (entries.length === MAX_FIELDS) { truncated = true; return; }
      const field = fieldFor(fields, name), nextPath = [...path, name];
      const value = values?.[name], present = own(values, name);
      if (present && object(value) && !privateField(nextPath, field) && Object.keys(value).length) {
        walk(value, field?.schema, nextPath, depth + 1);
      } else {
        entries.push({ path: nextPath, ...optionView(value, field, nextPath, present) });
      }
    }
  };
  walk(options, schema);
  return { entries, truncated };
}

export function optionDiff(before, after, changes, schema, path = []) {
  const entries = [];
  const walk = (previous, next, requested, fields, prefix) => {
    for (const [name, value] of Object.entries(requested)) {
      const field = fieldFor(fields, name), nextPath = [...prefix, name];
      if (object(value) && Object.keys(value).length) {
        walk(previous?.[name], next?.[name], value, field?.schema, nextPath);
      } else if (!own(previous, name) || !same(previous[name], next[name])) {
        if (entries.length === MAX_FIELDS) throw new Error("Too many changed option fields; preview a smaller change.");
        entries.push({
          path: nextPath,
          before: optionView(previous?.[name], field, nextPath, own(previous, name)),
          after: optionView(next[name], field, nextPath),
        });
      }
    }
  };
  walk(before, after, changes, schema, path);
  return entries;
}
