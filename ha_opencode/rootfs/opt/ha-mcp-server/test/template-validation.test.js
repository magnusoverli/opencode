import { describe, expect, it, vi } from "vitest";

import { extractTemplateScalars, validateConfigTemplates } from "../lib/template-validation.js";

const existing = `- alias: Arriving home
  actions:
    - variables:
        location_tag: >-
          {% if is_state('person.test', 'home') %}
            home
          {% else %}
            away
          {% endif %}
        minutes_out: "{{ (as_timestamp(now()) - 123) / 60 }}"
        is_long: "{{ minutes_out | int >= 20 }}"
`;

describe("config template pre-validation", () => {
  it("does not render HA reference arguments, while retaining ordinary and explicitly typed string templates", () => {
    const content = 'secret: !secret "synthetic_{{ reference }}"\ninclude: !include "synthetic_{{ filename }}.yaml"\ninput: !input "synthetic_{{ input }}"\nplain: "{{ 1 + 1 }}"\ntyped: !!str "{{ 2 + 2 }}"\n';
    expect(extractTemplateScalars(content)).toEqual(["{{ 1 + 1 }}", "{{ 2 + 2 }}"]);
  });

  it("extracts complete folded Jinja scalars after YAML parsing", () => {
    const templates = extractTemplateScalars(existing);
    expect(templates).toHaveLength(3);
    expect(templates[0]).toContain("{% if is_state");
    expect(templates[0]).toContain("{% endif %}");
    expect(templates[0]).not.toContain(">-");
  });

  it("skips unchanged templates but validates a newly edited scalar", async () => {
    const render = vi.fn(async () => "ok");
    const edited = existing.replace("20 }}", "30 }}");
    const results = await validateConfigTemplates(edited, { previousContent: existing, render });
    expect(results.map(({ status }) => status)).toEqual(["skipped", "skipped", "valid"]);
    expect(render).toHaveBeenCalledExactlyOnceWith("{{ minutes_out | int >= 30 }}");
  });

  it("does not reject a new runtime-only variable when HA cannot render it alone", async () => {
    const render = vi.fn(async () => {
      throw new Error("HA API error (400): Error rendering template: UndefinedError: 'minutes_out' is undefined");
    });
    const results = await validateConfigTemplates('value: "{{ minutes_out | int >= 20 }}"', { render });
    expect(results).toMatchObject([{ status: "skipped" }]);
  });

  it("blocks changed Jinja syntax errors, including with runtime variables", async () => {
    const render = vi.fn(async () => {
      throw new Error("HA API error (400): Error rendering template: TemplateSyntaxError: Unexpected end of template");
    });
    const results = await validateConfigTemplates('value: "{% if trigger.id %}ok"', { previousContent: existing, render });
    expect(results).toMatchObject([{ status: "error" }]);
    expect(render).toHaveBeenCalledExactlyOnceWith("{% if trigger.id %}ok");
  });

  it("does not treat API failures as missing runtime context", async () => {
    const results = await validateConfigTemplates('value: "{{ 1 + 1 }}"', {
      render: async () => { throw new Error("HA API error (503): unavailable"); },
    });
    expect(results).toMatchObject([{ status: "error" }]);
  });
});
