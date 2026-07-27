import { describe, it, expect } from "vitest";

import {
  sanitizeToolInputSchema,
  sanitizeToolsListResult,
} from "../lib/native-mcp-schema.js";

// The exact shape Home Assistant <= 2026.7 served for GetLiveContext.
// Reported in home-assistant/core#176762, fixed upstream by #176814.
const GET_LIVE_CONTEXT_SCHEMA = {
  type: "object",
  properties: {
    domain: {
      anyOf: [{}, { items: { type: "string" }, type: "array" }],
      description: "Filter entities by domain, e.g. light or climate.",
    },
    name: {
      anyOf: [{}, { items: { type: "string" }, type: "array" }],
      description: "Filter entities by name.",
    },
  },
};

describe("native MCP tool schema sanitizer", () => {
  it("repairs the GetLiveContext schema that broke strict MCP clients", () => {
    const { schema, repaired } = sanitizeToolInputSchema(GET_LIVE_CONTEXT_SCHEMA);

    expect(repaired).toBe(2);
    expect(schema.properties.domain).toEqual({
      description: "Filter entities by domain, e.g. light or climate.",
      items: { type: "string" },
      type: "array",
    });
    expect(schema.properties.name.anyOf).toBeUndefined();
    expect(schema.properties.name.type).toBe("array");
  });

  it("does not mutate the input schema", () => {
    const input = structuredClone(GET_LIVE_CONTEXT_SCHEMA);
    sanitizeToolInputSchema(input);
    expect(input).toEqual(GET_LIVE_CONTEXT_SCHEMA);
  });

  it("leaves an already-clean schema untouched", () => {
    const clean = {
      type: "object",
      properties: {
        domain: { type: "array", items: { type: "string" } },
        area: { anyOf: [{ type: "string" }, { type: "array" }] },
      },
      required: ["domain"],
    };

    const { schema, repaired } = sanitizeToolInputSchema(clean);

    expect(repaired).toBe(0);
    expect(schema).toEqual(clean);
  });

  it("keeps sibling annotations when inlining the surviving branch", () => {
    const { schema } = sanitizeToolInputSchema({
      anyOf: [{}, { type: "string", description: "inner" }],
      description: "outer",
    });

    // The combinator's own description wins; it is the one Home Assistant set
    // for the parameter.
    expect(schema.description).toBe("outer");
    expect(schema.type).toBe("string");
    expect(schema.anyOf).toBeUndefined();
  });

  it("keeps multiple surviving branches as a union", () => {
    const { schema, repaired } = sanitizeToolInputSchema({
      anyOf: [{}, { type: "string" }, { type: "number" }],
    });

    expect(repaired).toBe(1);
    expect(schema.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("drops a combinator whose branches are all empty", () => {
    const { schema, repaired } = sanitizeToolInputSchema({
      anyOf: [{}, {}],
      description: "unconstrained",
    });

    expect(repaired).toBe(1);
    expect(schema).toEqual({ description: "unconstrained" });
  });

  it("repairs nested schemas under items, prefixItems and $defs", () => {
    const { schema, repaired } = sanitizeToolInputSchema({
      type: "object",
      properties: {
        list: { type: "array", items: { oneOf: [{}, { type: "string" }] } },
        tuple: { prefixItems: [{ allOf: [{}, { type: "number" }] }] },
      },
      $defs: { helper: { anyOf: [{}, { type: "boolean" }] } },
    });

    expect(repaired).toBe(3);
    expect(schema.properties.list.items.type).toBe("string");
    expect(schema.properties.tuple.prefixItems[0].type).toBe("number");
    expect(schema.$defs.helper.type).toBe("boolean");
  });

  it("passes through values that are not schemas", () => {
    expect(sanitizeToolInputSchema(null).schema).toBeNull();
    expect(sanitizeToolInputSchema("nope").schema).toBe("nope");
    expect(sanitizeToolInputSchema(undefined).repaired).toBe(0);
  });
});

describe("native MCP tools/list sanitizer", () => {
  it("repairs affected tools and reports their names", () => {
    const { result, repairedTools, repairedToolNames } = sanitizeToolsListResult({
      tools: [
        { name: "GetLiveContext", inputSchema: GET_LIVE_CONTEXT_SCHEMA },
        { name: "GetDateTime", inputSchema: { type: "object", properties: {} } },
      ],
    });

    expect(repairedTools).toBe(1);
    expect(repairedToolNames).toEqual(["GetLiveContext"]);
    expect(result.tools[0].inputSchema.properties.domain.anyOf).toBeUndefined();
    expect(result.tools[1].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("returns the original result object when nothing needed repair", () => {
    const original = { tools: [{ name: "GetDateTime", inputSchema: { type: "object" } }] };
    const { result, repairedTools } = sanitizeToolsListResult(original);

    expect(repairedTools).toBe(0);
    expect(result).toBe(original);
  });

  it("passes through payloads that are not tool lists", () => {
    expect(sanitizeToolsListResult({ content: [] }).repairedTools).toBe(0);
    expect(sanitizeToolsListResult(null).result).toBeNull();
  });
});
