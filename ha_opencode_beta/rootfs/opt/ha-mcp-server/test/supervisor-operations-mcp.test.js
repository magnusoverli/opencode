import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const TIMEOUT_MS = 20_000;
const children = new Set();
const requests = [];
let mockServer;
let mockWebSocketServer;
let supervisorBaseUrl;
let backupAgentsUnavailable = false;
const jobFixtures = [
  { uuid: "empty-errors", name: "empty-errors", done: true, errors: [], progress: 100,
    child_jobs: [{ name: "successful-child", done: true, errors: [], progress: 100 }] },
  { uuid: "null-errors", name: "null-errors", done: true, errors: null, progress: 100 },
  { uuid: "omitted-errors", name: "omitted-errors", done: true, progress: 100 },
  { uuid: "actual-failure", name: "actual-failure", done: true, errors: [{ message: "Fixture failure" }], progress: 100,
    child_jobs: [{ name: "failed-child", done: true, errors: [{ message: "Child failure" }], progress: 100 }] },
  { uuid: "still-running", name: "still-running", done: false, errors: [], progress: 50 },
];

function sendJson(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ result: "ok", data }));
}

function sendText(response, text) {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(text);
}

function supervisorResponse(request, response) {
  requests.push(request.url);
  const job = jobFixtures.find((item) => request.url === `/jobs/${item.uuid}`);
  if (job) return sendJson(response, job);
  switch (request.url.split("?")[0]) {
    case "/v2/apps":
      return sendJson(response, { apps: [] });
    case "/v2/apps/self/info":
      return sendJson(response, { slug: "opencode" });
    case "/v2/apps/other/info":
      return sendJson(response, { slug: "other", name: "Example App", state: "started", version: "1",
        options: { enabled: false, log_level: "info", secret: "private-option" },
        schema: [{ name: "enabled", type: "boolean" },
          { name: "log_level", type: "select", options: ["info", "debug"] },
          { name: "secret", type: "string", format: "password" }] });
    case "/v2/apps/other/options/validate":
      return sendJson(response, { valid: true });
    case "/supervisor/info":
      return sendJson(response, { version: "2026.07.5", healthy: true, supported: true, ip_address: "192.168.5.33" });
    case "/host/info":
      return sendJson(response, { hostname: "private-host", operating_system: "Home Assistant OS", disk_total: 100, disk_used: 20, disk_free: 80 });
    case "/network/info":
      return sendJson(response, {
        host_internet: true,
        supervisor_internet: true,
        interfaces: [{ interface: "eth0", connected: true, primary: true, mac: "aa:bb:cc", ipv4: { address: ["192.168.5.33/24"] } }],
      });
    case "/resolution/info":
      return sendJson(response, {
        issues: [{ type: "disk", context: "system", reference: "private-reference" }],
        unhealthy: [],
        unsupported: [],
        suggestions: [{ type: "repair", context: "system", auto: false, reference: "private-suggestion" }],
        checks: [{ slug: "check_disk", enabled: true }],
      });
    case "/jobs/info":
      return sendJson(response, { jobs: jobFixtures });
    case "/backups/info":
      return sendJson(response, {
        days_until_stale: 4,
        backups: [{ slug: "backup-1", date: "2026-08-01T00:00:00Z", size_bytes: 10, locations: ["/backup/private"], content: { addons: [] } }],
      });
    case "/store":
      return sendJson(response, {
        addons: [{ slug: "app", name: "App", installed: true, available: true, update_available: true, version: "1", version_latest: "2" }],
        repositories: [{ slug: "repo", name: "Repo", source: "https://user:password@example.test/repo?token=private" }],
      });
    case "/supervisor/stats":
      return sendJson(response, { cpu_percent: 12.5, memory_usage: 10, memory_limit: 20, internal_token: "private" });
    case "/core/logs":
      return sendText(response, "normal line\nSUPERVISOR_TOKEN=private-token-value\nAuthorization: Bearer private-bearer-value");
    case "/host/logs":
      response.writeHead(500, { "content-type": "text/plain" });
      return response.end("password=host-error-secret");
    default:
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ result: "error", message: "not found" }));
  }
}

beforeAll(async () => {
  mockServer = createServer(supervisorResponse);
  mockWebSocketServer = new WebSocketServer({ server: mockServer, path: "/core/websocket" });
  mockWebSocketServer.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "auth_ok" }));
      } else if (message.type === "backup/info") {
        socket.send(JSON.stringify(backupAgentsUnavailable
          ? { id: message.id, type: "result", success: false, error: { message: "unavailable" } }
          : { id: message.id, type: "result", success: true, result: { backups: [{
            backup_id: "backup-1", agents: { "cloud.cloud": {}, "hassio.local": {} },
          }] } }));
      }
    });
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address();
  supervisorBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => mockWebSocketServer.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
});

function callMcp(profile, toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        SUPERVISOR_BASE_URL: supervisorBaseUrl,
        OPENCODE_MCP_TOOL_PROFILE: profile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let buffer = "";
    const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for MCP response")), TIMEOUT_MS);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      children.delete(child);
      child.kill();
      callback(value);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: toolName, arguments: args },
          })}\n`);
        } else if (message.id === 2) {
          finish(resolve, message.result ?? message.error);
        }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
    })}\n`);
  });
}

function callMcpSequence(profile, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        SUPERVISOR_BASE_URL: supervisorBaseUrl,
        OPENCODE_MCP_TOOL_PROFILE: profile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let buffer = "";
    let current = 0;
    const results = [];
    const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for MCP sequence")), TIMEOUT_MS);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      children.delete(child);
      child.kill();
      callback(value);
    };
    const sendNext = () => {
      const call = typeof calls[current] === "function" ? calls[current](results) : calls[current];
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: current + 2,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments || {} },
      })}\n`);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          sendNext();
        } else if (message.id === current + 2) {
          results.push(message.result ?? message.error);
          current += 1;
          if (current === calls.length) finish(resolve, results);
          else sendNext();
        }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
    })}\n`);
  });
}

function parsePayload(result) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

describe("Supervisor operations MCP tools", () => {
  for (const profile of ["compact", "configuration"]) {
    it(`executes inspection and preview in ${profile} but rejects apply before Supervisor`, async () => {
      const before = requests.length;
      const [inspection, preview, application] = await callMcpSequence(profile, [
        { name: "supervisor_app_inspect", arguments: { slug: "other" } },
        results => ({ name: "supervisor_app_preview", arguments: { slug: "other",
          expected_revision: parsePayload(results[0]).revision,
          changes: { enabled: true, log_level: "debug" } } }),
        results => ({ name: "supervisor_app_apply", arguments: {
          preview_id: parsePayload(results[1]).preview_id, review: parsePayload(results[1]).review } }),
      ]);
      expect(parsePayload(inspection).name).toBe("Example App");
      expect(parsePayload(preview).diff).toContainEqual({
        path: ["log_level"], before: { state: "visible", value: "info" }, after: { state: "visible", value: "debug" },
      });
      expect(application.isError).toBe(true);
      expect(JSON.stringify(application)).toContain("profile");
      expect(JSON.stringify([inspection, preview])).not.toContain("private-option");
      const reached = requests.slice(before);
      expect(reached).toContain("/v2/apps/other/options/validate");
      expect(reached.some(url => /\/(options|start|stop|restart)$/.test(url))).toBe(false);
    }, TIMEOUT_MS + 5_000);
  }
  it("serves the six read-only tools in the compact profile", async () => {
    const compact = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, SUPERVISOR_TOKEN: "test-token", OPENCODE_MCP_TOOL_PROFILE: "compact" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      let buffer = "";
      const timeout = setTimeout(() => finish(reject, new Error("timed out waiting for tool list")), TIMEOUT_MS);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        children.delete(child);
        child.kill();
        callback(value);
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
          } else if (message.id === 2) {
            finish(resolve, message.result);
          }
        }
      });
      child.on("error", (error) => finish(reject, error));
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
      })}\n`);
    });
    const names = compact.tools.map((tool) => tool.name);
    for (const name of ["get_supervisor_health", "get_supervisor_resolution", "get_backup_posture", "get_support_logs", "get_store_audit", "get_supervisor_metrics"]) {
      expect(names).toContain(name);
    }
  }, TIMEOUT_MS + 5_000);

  it("wires every tool to bounded, redacted Supervisor projections", async () => {
    const health = parsePayload(await callMcp("full", "get_supervisor_health"));
    const resolution = parsePayload(await callMcp("full", "get_supervisor_resolution", { limit: 1 }));
    const backups = parsePayload(await callMcp("full", "get_backup_posture", { limit: 1 }));
    const logs = parsePayload(await callMcp("full", "get_support_logs", { source: "core", lines: 10 }));
    const store = parsePayload(await callMcp("full", "get_store_audit", { limit: 1 }));
    const metrics = parsePayload(await callMcp("full", "get_supervisor_metrics", { component: "supervisor" }));

    expect(health.data.supervisor.version).toBe("2026.07.5");
    expect(resolution.data.issues.returned).toBe(1);
    expect(backups.data.backups[0].slug).toBe("backup-1");
    expect(backups.data.backups[0].location_count).toBe(2);
    expect(logs.data.log).toContain("normal line");
    expect(store.data.repositories.items[0].source).toBe("https://example.test/repo");
    expect(metrics.data.metrics.cpu_percent).toBe(12.5);

    const rendered = JSON.stringify({ health, resolution, backups, logs, store, metrics });
    for (const secret of ["192.168.5.33", "private-host", "private-reference", "/backup/private", "password@example", "private-token-value", "private-bearer-value", "internal_token"]) {
      expect(rendered).not.toContain(secret);
    }
  }, TIMEOUT_MS + 5_000);

  it("reports an unknown count when Core backup-agent data is unavailable", async () => {
    backupAgentsUnavailable = true;
    try {
      const backups = parsePayload(await callMcp("full", "get_backup_posture", { limit: 1 }));
      expect(backups.data.backups[0].location_count).toBeNull();
    } finally {
      backupAgentsUnavailable = false;
    }
  }, TIMEOUT_MS + 5_000);

  it("rejects an app-log traversal before it reaches Supervisor", async () => {
    const before = requests.length;
    const result = await callMcp("full", "get_support_logs", { source: "addon", addon_slug: "../private", lines: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("valid Supervisor app slug");
    expect(requests).toHaveLength(before);
  }, TIMEOUT_MS + 5_000);

  it("reports consistent job outcomes across health, listings, progress and child jobs", async () => {
    const [healthResult, listing, ...progress] = await callMcpSequence("full", [
      { name: "get_supervisor_health" }, { name: "get_running_jobs" },
      ...jobFixtures.map((job) => ({ name: "get_update_progress", arguments: { job_id: job.uuid } })),
    ]);
    expect(parsePayload(healthResult).data.jobs).toEqual({ total: 5, active: 1, completed: 4, failed: 1 });
    const text = listing.content[0].text;
    for (const name of ["empty-errors", "null-errors", "omitted-errors"]) {
      expect(text.split("\n").find((line) => line.includes(`| ${name} |`))).toContain("Success");
    }
    expect(text.split("\n").find((line) => line.includes("| actual-failure |"))).toContain("Failed");
    for (let i = 0; i < progress.length; i++) {
      const response = progress[i];
      const failed = i === 3;
      expect(response.isError).not.toBe(true);
      expect(response.content[0].text).toContain(i === 4 ? "In Progress" : failed ? "Failed" : "Completed");
      expect(response.content[0].text.includes("## Errors")).toBe(failed);
      expect(JSON.parse(response.content[1].text).meta.has_errors).toBe(failed);
    }
    const successfulChild = progress[0].content[0].text.split("\n").find((line) => line.includes("successful-child"));
    const failedChild = progress[3].content[0].text.split("\n").find((line) => line.includes("failed-child"));
    expect(successfulChild).toContain("âœ…");
    expect(failedChild).toContain("âŒ");
  }, TIMEOUT_MS + 5_000);

  it("coalesces repeat metrics reads within one MCP session", async () => {
    const before = requests.filter((url) => url === "/supervisor/stats").length;
    const [first, second] = await callMcpSequence("full", [
      { name: "get_supervisor_metrics", arguments: { component: "supervisor" } },
      { name: "get_supervisor_metrics", arguments: { component: "supervisor" } },
    ]);

    expect(parsePayload(first).meta.cached).toBe(false);
    expect(parsePayload(second).meta.cached).toBe(true);
    expect(requests.filter((url) => url === "/supervisor/stats")).toHaveLength(before + 1);
  }, TIMEOUT_MS + 5_000);

  it("redacts credentials from a Supervisor error before returning it", async () => {
    const result = await callMcp("full", "get_support_logs", { source: "host", lines: 1 });

    expect(result.isError).toBe(true);
    const rendered = JSON.stringify(result);
    expect(rendered).toContain("<redacted>");
    expect(rendered).not.toContain("host-error-secret");
  }, TIMEOUT_MS + 5_000);
});
