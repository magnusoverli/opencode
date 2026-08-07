import { describe, expect, it, vi } from "vitest";

import {
  createSupervisorAppsClient,
  SUPERVISOR_APPS_FALLBACK_RETRY_MS,
} from "../lib/supervisor-apps.js";

function supervisorError(status, message = "unavailable") {
  return Object.assign(new Error(message), { status });
}

describe("Supervisor application API compatibility", () => {
  it("uses V2 application and store routes when the V2 list is available", async () => {
    const request = vi.fn(async (endpoint, method = "GET", body = null, timeoutMs) => {
      if (endpoint === "/v2/apps") return { apps: [{ slug: "esphome" }] };
      if (endpoint === "/v2/apps/self/info") return { slug: "local_ha_opencode_beta" };
      if (endpoint === "/v2/store/apps/esphome/changelog") return "changes";
      if (endpoint === "/v2/store/apps/esphome/update") {
        return { method, body, timeoutMs, job_id: "job-1" };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const client = createSupervisorAppsClient({ request });

    await expect(client.list()).resolves.toEqual([{ slug: "esphome" }]);
    await expect(client.info("self")).resolves.toEqual({ slug: "local_ha_opencode_beta" });
    await expect(client.changelog("esphome")).resolves.toBe("changes");
    await expect(client.update("esphome", { background: true }, 30000)).resolves.toMatchObject({
      job_id: "job-1",
      method: "POST",
      body: { background: true },
      timeoutMs: 30000,
    });

    expect(client.version).toBe("v2");
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/v2/apps",
      "/v2/apps/self/info",
      "/v2/store/apps/esphome/changelog",
      "/v2/store/apps/esphome/update",
    ]);
  });

  it("falls back to V1 only when the V2 capability route is absent", async () => {
    const onFallback = vi.fn();
    const request = vi.fn(async (endpoint) => {
      if (endpoint === "/v2/apps") throw supervisorError(404);
      if (endpoint === "/addons") return { addons: [{ slug: "esphome" }] };
      if (endpoint === "/addons/self/info") return { slug: "local_ha_opencode_beta" };
      if (endpoint === "/store/addons/esphome/changelog") return "changes";
      if (endpoint === "/store/addons/esphome/update") return { job_id: "job-1" };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const client = createSupervisorAppsClient({ request, onFallback });

    await expect(client.list()).resolves.toEqual([{ slug: "esphome" }]);
    await expect(client.info("self")).resolves.toEqual({ slug: "local_ha_opencode_beta" });
    await expect(client.changelog("esphome")).resolves.toBe("changes");
    await expect(client.update("esphome", { background: true })).resolves.toEqual({ job_id: "job-1" });

    expect(client.version).toBe("v1");
    expect(onFallback).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/v2/apps",
      "/addons",
      "/addons/self/info",
      "/store/addons/esphome/changelog",
      "/store/addons/esphome/update",
    ]);
  });

  it.each([401, 403, 500])("does not hide a V2 %s response behind V1", async (status) => {
    const request = vi.fn(async () => {
      throw supervisorError(status);
    });
    const client = createSupervisorAppsClient({ request });

    await expect(client.list()).rejects.toMatchObject({ status });
    expect(client.version).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not fall back when the V2 list response has the wrong shape", async () => {
    const request = vi.fn(async () => ({ addons: [] }));
    const client = createSupervisorAppsClient({ request });

    await expect(client.list()).rejects.toThrow("did not contain an 'apps' array");
    expect(client.version).toBeNull();
    expect(request).toHaveBeenCalledWith("/v2/apps");
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not confuse an app-specific V2 404 with an unavailable V2 API", async () => {
    const request = vi.fn(async (endpoint) => {
      if (endpoint === "/v2/apps") return { apps: [] };
      if (endpoint === "/v2/apps/missing/info") throw supervisorError(404, "app missing");
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const client = createSupervisorAppsClient({ request });

    await client.list();
    await expect(client.info("missing")).rejects.toMatchObject({ status: 404 });
    expect(client.version).toBe("v2");
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/v2/apps",
      "/v2/apps/missing/info",
    ]);
  });

  it("retries V2 after a latched fallback and reports recovery once", async () => {
    let clock = 0;
    let v2Available = false;
    const onFallback = vi.fn();
    const onRecovered = vi.fn();
    const request = vi.fn(async (endpoint) => {
      if (endpoint === "/v2/apps") {
        if (!v2Available) throw supervisorError(404);
        return { apps: [{ slug: "esphome" }] };
      }
      if (endpoint === "/addons") return { addons: [{ slug: "esphome" }] };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const client = createSupervisorAppsClient({
      request,
      now: () => clock,
      fallbackRetryMs: 1000,
      onFallback,
      onRecovered,
    });

    await expect(client.list()).resolves.toEqual([{ slug: "esphome" }]);
    await expect(client.list()).resolves.toEqual([{ slug: "esphome" }]);
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual(["/v2/apps", "/addons", "/addons"]);
    expect(onFallback).toHaveBeenCalledOnce();

    clock = 1000;
    v2Available = true;
    await expect(client.list()).resolves.toEqual([{ slug: "esphome" }]);
    expect(client.version).toBe("v2");
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(request.mock.calls.at(-1)[0]).toBe("/v2/apps");
  });

  it("uses the documented fallback retry interval by default", () => {
    expect(SUPERVISOR_APPS_FALLBACK_RETRY_MS).toBe(15 * 60 * 1000);
  });
});
