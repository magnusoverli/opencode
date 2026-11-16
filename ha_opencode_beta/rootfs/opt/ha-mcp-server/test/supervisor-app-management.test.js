import { describe, expect, it, vi } from "vitest";
import { createSupervisorAppManager } from "../lib/supervisor-app-management.js";

function fixture() {
  // Independently copied UI shape from Supervisor 2026.10.3 apps/options.py,
  // UiOptions. /info never exposes the raw manifest schema mapping.
  let info = { slug: "other", name: "Example", state: "started", version: "1", options: { enabled: false, endpoint: "PRIVATE", password: "PRIVATE", nested: { token: "PRIVATE", count: 1 } }, schema: [
    { name: "enabled", type: "boolean", required: true },
    { name: "endpoint", type: "string", required: true },
    { name: "password", type: "string", format: "password", required: true },
    { name: "nested", type: "schema", optional: true, multiple: false, schema: [
      { name: "token", type: "string", required: true }, { name: "count", type: "integer", required: true },
    ] },
  ] };
  const apps = { info: vi.fn(async () => structuredClone(info)),
    validateOptions: vi.fn(async () => ({ valid: true })),
    setOptions: vi.fn(async (_slug, options) => { info.options = options; }),
    lifecycle: vi.fn(async (_slug, action) => { info.state = action === "stop" ? "stopped" : "started"; }) };
  const manager = createSupervisorAppManager({ apps, selfSlug: async () => "our_app" });
  return { apps, manager, change: fn => fn(info) };
}

describe("Supervisor app previews and verified application", () => {
  it("reports names and explicit unset/withheld states with narrowly visible log levels", async () => {
    const f = fixture();
    f.change(info => {
      info.options.log_level = "info";
      info.options.ignore_pattern = "PRIVATE";
      info.schema.push(
        { name: "log_level", type: "select", options: ["debug", "info", "warning"] },
        { name: "ignore_pattern", type: "string" },
        { name: "optional", type: "string", optional: true },
      );
    });
    const data = await f.manager.inspect("other");
    expect(data.name).toBe("Example");
    expect(data.options.log_level).toBe("info");
    expect(data.options.ignore_pattern).toBe("<withheld>");
    expect(data.option_states.entries).toContainEqual({ path: ["optional"], state: "unset" });
    expect(data.option_states.entries).toContainEqual({ path: ["ignore_pattern"], state: "withheld" });
    expect(data.option_states.entries).toContainEqual({ path: ["log_level"], state: "visible", value: "info" });
    expect(JSON.stringify(data)).not.toContain("PRIVATE");
    f.change(info => { delete info.name; });
    expect((await f.manager.inspect("other")).name).toBe("other");
  });
  it("does not trust arbitrary enums, free text, password formats or sensitive ancestors", async () => {
    const f = fixture();
    for (const field of [
      { type: "string" }, { type: "select", options: ["PRIVATE", "info"] },
      { type: "select", options: ["info"], format: "password" },
      { type: "select", options: ["info"], multiple: true },
      { type: "select", options: ["debug"] },
    ]) {
      f.change(info => {
        info.options.log_level = "info";
        info.schema = [{ name: "log_level", ...field }];
      });
      expect((await f.manager.inspect("other")).options.log_level).toBe("<withheld>");
    }
    f.change(info => {
      info.options = { token: 1234, password: { log_level: "info" }, array: ["PRIVATE"] };
      info.schema = [];
    });
    const inspected = await f.manager.inspect("other");
    expect(inspected.options).toEqual({ token: "<withheld>", password: "<withheld>", array: "<withheld>" });
    expect(JSON.stringify(inspected)).not.toMatch(/1234|PRIVATE/);
  });
  it("binds a redacted before/after diff to review while preserving hidden values", async () => {
    const f = fixture();
    f.change(info => {
      info.options.log_level = "info";
      info.options.ignore_pattern = "PRIVATE_BEFORE";
      info.schema.push(
        { name: "log_level", type: "select", options: ["debug", "info"] },
        { name: "ignore_pattern", type: "string" },
        { name: "limit", type: "integer", optional: true },
      );
    });
    const inspected = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: inspected.revision,
      changes: { enabled: true, log_level: "debug", ignore_pattern: "PRIVATE_AFTER", limit: 5, nested: { count: 2 } } });
    expect(plan.diff).toEqual([
      { path: ["enabled"], before: { state: "visible", value: false }, after: { state: "visible", value: true } },
      { path: ["log_level"], before: { state: "visible", value: "info" }, after: { state: "visible", value: "debug" } },
      { path: ["ignore_pattern"], before: { state: "withheld" }, after: { state: "withheld" } },
      { path: ["limit"], before: { state: "unset" }, after: { state: "visible", value: 5 } },
      { path: ["nested", "count"], before: { state: "visible", value: 1 }, after: { state: "visible", value: 2 } },
    ]);
    expect(plan.review.diff).toEqual(plan.diff);
    expect(JSON.stringify(plan)).not.toContain("PRIVATE");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
    expect(f.apps.lifecycle).not.toHaveBeenCalled();
    const changed = structuredClone(plan.review);
    changed.diff[0].after.value = false;
    expect((await f.manager.apply(plan.preview_id, changed)).status).toBe("review_mismatch");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
    const retry = await f.manager.preview({ slug: "other", expected_revision: inspected.revision, changes: { log_level: "debug" } });
    expect((await f.manager.apply(retry.preview_id, retry.review)).status).toBe("saved");
    expect(f.apps.setOptions.mock.calls[0][1].ignore_pattern).toBe("PRIVATE_BEFORE");
  });
  it("bounds inspection and refuses a diff that cannot be fully reviewed", async () => {
    const f = fixture();
    f.change(info => {
      info.options = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field${i}`, false]));
      info.schema = Object.keys(info.options).map(name => ({ name, type: "boolean" }));
    });
    const inspected = await f.manager.inspect("other");
    expect(inspected.option_states.entries).toHaveLength(256);
    expect(inspected.option_states.truncated).toBe(true);
    const changes = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field${i}`, true]));
    await expect(f.manager.preview({ slug: "other", expected_revision: inspected.revision, changes })).rejects.toThrow("smaller change");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
    expect(f.apps.validateOptions).not.toHaveBeenCalled();
  });
  it("includes an empty-object addition but omits unchanged scalar values from the diff", async () => {
    const f = fixture();
    f.change(info => {
      info.schema.push({ name: "optional", type: "schema", schema: [] });
    });
    const inspected = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: inspected.revision,
      changes: { optional: {}, enabled: false } });
    expect(plan.diff).toEqual([
      { path: ["optional"], before: { state: "unset" }, after: { state: "withheld" } },
    ]);
    expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("saved");
    expect(f.apps.setOptions.mock.calls[0][1].optional).toEqual({});
  });
  it("returns redacted options and opaque revisions, not secret-derived plain hashes", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    expect(JSON.stringify(data)).not.toContain("PRIVATE");
    expect(data.revision).toMatch(/^[a-f0-9]{64}$/);
  });
  it("validates the merged proposal, preserves omitted nested secrets and applies once", async () => {
    const f = fixture(); const inspected = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: inspected.revision, changes: { enabled: true, nested: { count: 2 } } });
    expect(JSON.stringify(plan)).not.toContain("PRIVATE");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
    expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("saved");
    expect(f.apps.setOptions.mock.calls[0][1].nested.token).toBe("PRIVATE");
    expect((await f.manager.apply(plan.preview_id)).status).toBe("preview_unavailable");
  });
  it("rejects stale inspection and changes occurring after preview", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: true } });
    f.change(info => { info.options.enabled = true; });
    expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("conflict");
    await expect(f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: false } })).rejects.toThrow();
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
  it("does not expose Supervisor validation exceptions or validation messages", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    f.apps.validateOptions.mockResolvedValue({ valid: false, message: "PRIVATE" });
    await expect(f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: true } })).rejects.toThrow("validation failed");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
  it.each(["password", "api_key", "token"])("requires manual secret editing for %s", async key => {
    const f = fixture(); const data = await f.manager.inspect("other");
    await expect(f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { [key]: "PRIVATE" } })).rejects.toThrow();
  });
  it("blocks current-app lifecycle and fails closed when self identity is unavailable", async () => {
    const f = fixture();
    await expect(f.manager.preview({ slug: "our_app", action: "restart" })).rejects.toThrow();
    const manager = createSupervisorAppManager({ apps: f.apps, selfSlug: async () => null });
    await expect(manager.preview({ slug: "other", action: "stop" })).rejects.toThrow();
    expect(f.apps.lifecycle).not.toHaveBeenCalled();
  });
  it("reports uncertain mutation outcomes without replaying or leaking the exception", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: true } });
    f.apps.setOptions.mockRejectedValue(new Error("PRIVATE"));
    const result = await f.manager.apply(plan.preview_id, plan.review);
    expect(result.status).toBe("outcome_unknown"); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect((await f.manager.apply(plan.preview_id)).status).toBe("preview_unavailable");
  });
  it("binds approval review to the exact preview and rejects substituted review", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: true } });
    expect((await f.manager.apply(plan.preview_id, { ...plan.review, slug: "another" })).status).toBe("review_mismatch");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
  it("supports confirmed lifecycle actions with no implicit option save", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, action: "stop" });
    expect(plan.review).toMatchObject({ name: "Example", before_state: "started", expected_state: "stopped" });
    expect((await f.manager.apply(plan.preview_id, plan.review)).verified).toBe(true);
    expect(f.apps.lifecycle).toHaveBeenCalledWith("other", "stop");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
  it("reports acknowledged startup as in progress without claiming completion or retrying (#199)", async () => {
    const f = fixture(); const data = await f.manager.inspect("other");
    const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, action: "restart" });
    expect(plan.note).toContain("restart operation");
    expect(plan.note).not.toContain("No restart is implied");
    f.apps.lifecycle.mockImplementation(async () => { f.change(info => { info.state = "startup"; }); });
    const result = await f.manager.apply(plan.preview_id, plan.review);
    expect(result).toMatchObject({ status: "in_progress", saved: null, verified: false, active: null, observed_state: "startup" });
    expect(f.apps.lifecycle).toHaveBeenCalledTimes(1);
    expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("preview_unavailable");
    f.change(info => { info.state = "started"; });
    expect((await f.manager.inspect("other")).state).toBe("started");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
  it("does not label failed or unknown lifecycle outcomes as in progress", async () => {
    for (const state of ["error", "stopped"]) {
      const f = fixture(); const data = await f.manager.inspect("other");
      const plan = await f.manager.preview({ slug: "other", expected_revision: data.revision, action: "restart" });
      f.apps.lifecycle.mockImplementation(async () => { f.change(info => { info.state = state; }); });
      expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("outcome_unknown");
    }
  });
  it("expires previews and does not accept guessed or cross-instance IDs", async () => {
    const f = fixture(); let clock = 1;
    const manager = createSupervisorAppManager({ apps: f.apps, selfSlug: async () => "our_app", now: () => clock });
    const data = await manager.inspect("other");
    const plan = await manager.preview({ slug: "other", expected_revision: data.revision, changes: { enabled: true } });
    expect((await f.manager.apply(plan.preview_id, plan.review)).status).toBe("preview_unavailable");
    clock += 300000;
    expect((await manager.apply(plan.preview_id, plan.review)).status).toBe("preview_unavailable");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
  });
});
