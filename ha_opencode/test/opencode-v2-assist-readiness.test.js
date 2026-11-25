import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { createAssistService } from "../rootfs/opt/opencode-v2-homeassistant/assist-service.js";

const serviceSource = readFileSync(new URL(
  "../rootfs/opt/opencode-v2-homeassistant/assist-service.js",
  import.meta.url,
), "utf8");

test("production readiness deadline is 15 seconds and aborts in-flight catalog calls", () => {
  assert.match(serviceSource, /const READINESS_TIMEOUT_MS = 15_000;/);
  assert.match(serviceSource, /AbortSignal\.timeout\(readinessTimeoutMs\)/);
  assert.match(serviceSource, /signal: readinessSignal/);
});

const body = {
  system: "system",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  model: { id: "model-a", providerID: "provider-a" },
};

function makeHarness(overrides = {}) {
  const calls = [];
  const outputs = [];
  const selectedModel = {
    id: "model-a",
    providerID: "provider-a",
    enabled: true,
    capabilities: { input: ["text"], output: ["text"], tools: true },
  };
  const client = {
    plugin: {
      list: async (_input, _options) => {
        calls.push("plugin.list");
        return { data: [{ id: "homeassistant.assist", state: { status: "active" } }] };
      },
    },
    model: {
      list: async (_input, _options) => {
        calls.push("model.list");
        return { data: [selectedModel] };
      },
    },
    provider: {
      list: async (_input, _options) => {
        calls.push("provider.list");
        return { data: [{ id: "provider-a", activation: "enabled" }] };
      },
    },
    session: {
      create: async () => {
        calls.push("session.create");
        return { id: "session-a" };
      },
      update: async () => calls.push("session.update"),
      interrupt: async () => calls.push("session.interrupt"),
      remove: async () => calls.push("session.remove"),
    },
    rpc: () => ({
      prepare: async () => {
        calls.push("rpc.prepare");
        return { requestID: "a".repeat(36), permissions: [] };
      },
      start: async () => calls.push("rpc.start"),
      poll: async () => {
        calls.push("rpc.poll");
        return { events: overrides.streamEvents ?? [{ type: "done" }] };
      },
      release: async () => calls.push("rpc.release"),
      result: async () => ({ accepted: true }),
    }),
  };
  Object.assign(client.plugin, overrides.plugin);
  Object.assign(client.model, overrides.model);
  Object.assign(client.provider, overrides.provider);

  const service = createAssistService({
    client,
    authenticate: (header) => header === "Bearer test" ? "owner-a" : null,
    readinessTimeoutMs: overrides.timeoutMs ?? 100,
    readinessPollMs: overrides.pollMs ?? 1,
  });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.url = "/v1/requests";
  req.headers = {
    authorization: "Bearer test",
    "content-type": "application/json",
    "x-ha-assist-origin": "voice",
  };
  req.rawHeaders = ["authorization", "Bearer test", "content-type", "application/json"];
  const res = new (class extends EventEmitter {
    headersSent = false;
    destroyed = false;
    statusCode = 0;
    chunks = [];
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    }
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    }
    end(chunk = "") {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
    }
  })();
  const originalInfo = console.info;
  console.info = (line) => outputs.push(JSON.parse(line));
  return {
    calls, outputs, req, res, service,
    restoreLogger: () => { console.info = originalInfo; },
  };
}

test("waits for plugin and model availability before creating a session and logs done as success", async (t) => {
  let pluginCalls = 0;
  let modelCalls = 0;
  const harness = makeHarness({
    plugin: {
      list: async () => {
        pluginCalls++;
        return { data: pluginCalls < 2 ? [] : [{ id: "homeassistant.assist", state: { status: "active" } }] };
      },
    },
    model: {
      list: async () => {
        modelCalls++;
        return { data: modelCalls < 2 ? [] : [{
          id: "model-a",
          providerID: "provider-a",
          enabled: true,
          capabilities: { input: ["text"], output: ["text"], tools: true },
        }] };
      },
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 200);
  assert.ok(harness.calls.indexOf("session.create") > harness.calls.lastIndexOf("model.list"));
  assert.ok(harness.outputs.some((row) => row.event === "readiness_complete"));
  assert.equal(harness.outputs.findLast((row) => row.event === "request_end").outcome, "success");
});

test("returns assist_not_ready without creating a session when the plugin stays absent", async (t) => {
  const harness = makeHarness({
    timeoutMs: 30,
    plugin: { list: async () => ({ data: [] }) },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 503);
  assert.match(harness.res.chunks.join(""), /assist_not_ready/);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("returns model_catalog_not_ready when the requested model remains absent", async (t) => {
  const harness = makeHarness({
    timeoutMs: 30,
    model: { list: async () => ({ data: [] }) },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 503);
  assert.match(harness.res.chunks.join(""), /model_catalog_not_ready/);
  assert.equal(harness.calls.includes("session.create"), false);
  assert.equal(harness.calls.includes("provider.list"), false);
});

test("reports an explicitly failed Assist plugin without creating a session", async (t) => {
  const harness = makeHarness({
    plugin: {
      list: async () => ({ data: [{ id: "homeassistant.assist", state: { status: "failed" } }] }),
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 503);
  assert.match(harness.res.chunks.join(""), /assist_plugin_failed/);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("rejects only models whose returned metadata establishes incompatibility", async (t) => {
  const harness = makeHarness({
    model: {
      list: async () => ({ data: [{
        id: "model-a",
        providerID: "provider-a",
        enabled: true,
        capabilities: { input: ["image"], output: ["text"], tools: false },
      }] }),
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 400);
  assert.match(harness.res.chunks.join(""), /unsupported_model/);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("a transient model catalog service error retries and then proceeds when ready", async (t) => {
  let modelCalls = 0;
  const harness = makeHarness({
    model: {
      list: async () => {
        modelCalls++;
        if (modelCalls === 1) {
          throw Object.assign(new Error("catalog still initializing"), {
            _tag: "ServiceUnavailableError",
          });
        }
        return { data: [{
          id: "model-a",
          providerID: "provider-a",
          enabled: true,
          capabilities: { input: ["text"], output: ["text"], tools: true },
        }] };
      },
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 200);
  assert.equal(modelCalls, 2);
  assert.equal(harness.calls.filter((call) => call === "session.create").length, 1);
  assert.ok(harness.outputs.some((row) => row.event === "readiness_retry" && row.error_code === "unavailable"));
});

test("transient catalog service errors through the deadline return not-ready", async (t) => {
  let modelCalls = 0;
  const harness = makeHarness({
    timeoutMs: 35,
    model: {
      list: async () => {
        modelCalls++;
        throw Object.assign(new Error("catalog still initializing"), {
          _tag: "ServiceUnavailableError",
        });
      },
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.ok(modelCalls > 1);
  assert.equal(harness.res.statusCode, 503);
  assert.match(harness.res.chunks.join(""), /model_catalog_not_ready/);
  assert.equal(harness.calls.includes("session.create"), false);
  assert.equal(harness.calls.includes("provider.list"), false);
});

test("unrelated model-list errors fail immediately without session creation", async (t) => {
  let modelCalls = 0;
  const harness = makeHarness({
    timeoutMs: 1000,
    model: {
      list: async () => {
        modelCalls++;
        throw new Error("unrelated catalog failure");
      },
    },
  });
  t.after(harness.restoreLogger);
  const started = performance.now();

  await harness.service.handle(harness.req, harness.res);

  assert.ok(performance.now() - started < 250);
  assert.equal(modelCalls, 1);
  assert.equal(harness.res.statusCode, 502);
  assert.match(harness.res.chunks.join(""), /assist_unavailable/);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("request cancellation aborts readiness and never creates a session", async (t) => {
  let signal;
  let notifyStarted;
  const pluginStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const harness = makeHarness({
    timeoutMs: 1000,
    plugin: {
      list: (_input, options) => {
        signal = options.signal;
        notifyStarted();
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  });
  t.after(harness.restoreLogger);

  const pending = harness.service.handle(harness.req, harness.res);
  await pluginStarted;
  await harness.service.revoke("owner-a");
  await pending;

  assert.equal(signal.aborted, true);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("preserves allowlisted stream error codes in diagnostics", async (t) => {
  const harness = makeHarness({
    streamEvents: [{ type: "error", code: "generation_failed" }],
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  const terminal = harness.outputs.find((row) => row.event === "stream_terminal_event");
  assert.equal(terminal.error_code, "generation_failed");
});

test("classifies unknown stream error codes without logging their raw value", async (t) => {
  const rawCode = "private-provider-error-detail";
  const harness = makeHarness({
    streamEvents: [{ type: "error", code: rawCode }],
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  const terminal = harness.outputs.find((row) => row.event === "stream_terminal_event");
  assert.equal(terminal.error_code, "internal_error");
  assert.doesNotMatch(JSON.stringify(harness.outputs), new RegExp(rawCode));
});

test("bounds a hung plugin request and does not replay or create a session", async (t) => {
  const harness = makeHarness({
    timeoutMs: 25,
    plugin: {
      list: (_input, { signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  });
  t.after(harness.restoreLogger);
  const started = performance.now();

  await harness.service.handle(harness.req, harness.res);

  assert.ok(performance.now() - started < 250);
  assert.equal(harness.res.statusCode, 503);
  assert.match(harness.res.chunks.join(""), /assist_not_ready/);
  assert.equal(harness.calls.includes("session.create"), false);
});

test("redacts unexpected backend errors from the response and diagnostic logs", async (t) => {
  const harness = makeHarness({
    plugin: {
      list: async () => { throw new Error("sensitive backend payload"); },
    },
  });
  t.after(harness.restoreLogger);

  await harness.service.handle(harness.req, harness.res);

  assert.equal(harness.res.statusCode, 502);
  assert.match(harness.res.chunks.join(""), /assist_unavailable/);
  assert.doesNotMatch(JSON.stringify(harness.outputs), /sensitive backend payload/);
});
