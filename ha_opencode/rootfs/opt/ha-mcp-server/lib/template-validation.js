import { parseDocument, visit } from "yaml";

// Inspect parsed scalar values, not individual Jinja tags: an {% if %} block
// and its {% endif %} must be rendered together, with YAML folding applied.
export function extractTemplateScalars(content) {
  const document = parseDocument(content);
  if (document.errors.length) return [];

  const templates = new Set();
  visit(document, {
    Scalar(_, node) {
      // HA tag arguments name deferred references, not Jinja to execute here.
      if (node.tag?.startsWith("!")) return;
      if (typeof node.value === "string" && /\{[{%]/.test(node.value)) {
        templates.add(node.value);
      }
    },
  });
  return [...templates];
}

export async function validateConfigTemplates(content, { previousContent = null, render }) {
  const previous = new Set(previousContent === null ? [] : extractTemplateScalars(previousContent));
  const templates = extractTemplateScalars(content);
  const truncate = (text) => text.substring(0, 100) + (text.length > 100 ? "..." : "");
  const validateOne = async (template) => {
    if (previous.has(template)) {
      return { template: truncate(template), status: "skipped", reason: "Unchanged template in the existing file." };
    }

    try {
      const rendered = await render(template);
      return { template: truncate(template), status: "valid", result: String(rendered).substring(0, 200) };
    } catch (error) {
      const message = error.message || String(error);
      // The REST template endpoint renders immediately, without automation
      // variables. A render-time error does not establish invalid syntax.
      if (/HA API error \(400\):.*Error rendering template:/s.test(message) &&
          !/TemplateSyntaxError|TemplateAssertionError/.test(message)) {
        return { template: truncate(template), status: "skipped", reason: "Rendering needs runtime context." };
      }
      return { template: truncate(template), status: "error", error: message };
    }
  };

  const results = [];
  for (let i = 0; i < templates.length; i += 5) {
    results.push(...await Promise.all(templates.slice(i, i + 5).map(validateOne)));
  }
  return results;
}
