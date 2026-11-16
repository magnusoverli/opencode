import { describe, expect, it } from "vitest";
import { prepareReadOnlyHabRequest, redactReadOnlyHabOutput } from "../lib/hab-read-only.js";

describe("pinned HAB read-only policy", () => {
  it.each([
    ["dashboard", "list"], ["dashboard", "get", "lovelace"],
    ["dashboard", "get", "my-dashboard"], ["helper", "types"],
    ["helper", "list"], ["helper", "list", "input_boolean", "--brief", "--limit", "10"],
  ])("allows reviewed read command %j", (...args) => {
    expect(prepareReadOnlyHabRequest({ args }).argv).toEqual(["--skip-update-check", "--json", ...args]);
  });
  it.each([
    ["dashboard", "patch", "lovelace", "--plan"], ["backup", "list"],
    ["helper", "create"], ["helper", "delete", "x"], ["auth", "status"],
    ["--config", "/private", "helper", "list"], ["helper", "list", "--config=/private"],
    ["helper", "list", "--verbose"], ["helper", "list", "--json=false"],
    ["dashboard", "get", "--help"], ["dashboard", "get", "../private"],
    ["helper", "list", "--output", "/private"], ["helper", "list", "--limit", "-1"],
    ["helper", "list", "--limit", "100000"], ["helper", "list", "--limit=10"],
    ["helper", "list", "--", "--config", "/private"], ["helper", "list", "x", "y"],
    ["dashboard", "list", "extra"], ["dash", "list"], ["schema", "--output", "file"],
  ])("rejects mutation and override attempts %j", (...args) => {
    expect(() => prepareReadOnlyHabRequest({ args })).toThrow();
  });
  it("rejects command strings and unknown request properties", () => {
    expect(() => prepareReadOnlyHabRequest({ command: "helper list" })).toThrow();
    expect(() => prepareReadOnlyHabRequest({ args: ["helper", "list"], executable: "/bin/sh" })).toThrow();
  });
  it("redacts JSON credential fields before returning or exporting output", () => {
    const result = redactReadOnlyHabOutput(JSON.stringify({ data: { password: "PRIVATE", headers: { Authorization: "PRIVATE" }, url: "https://user:PRIVATE@host" } }));
    expect(result).not.toContain("PRIVATE");
    expect(JSON.parse(result).data.password).toBe("<redacted>");
  });
});
