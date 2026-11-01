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
    expect((await f.manager.apply(plan.preview_id, plan.review)).verified).toBe(true);
    expect(f.apps.lifecycle).toHaveBeenCalledWith("other", "stop");
    expect(f.apps.setOptions).not.toHaveBeenCalled();
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
