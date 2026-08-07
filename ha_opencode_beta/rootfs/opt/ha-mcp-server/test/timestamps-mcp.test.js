import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const TIMEOUT_MS = 20_000;
const children = new Set();
const requests = [];
let coreServer;
let coreBaseUrl;

function coreResponse(request, response) {
  requests.push(request.url);
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url.startsWith("/history/period/")) return response.end(JSON.stringify([[]]));
  if (request.url.startsWith("/logbook/")) return response.end(JSON.stringify([]));
  if (request.url.startsWith("/calendars/")) return response.end(JSON.stringify([]));
  response.writeHead(404, { "content-type": "application/json" });
  return response.end(JSON.stringify({ message: "not found" }));
}

beforeAll(async () => {
  coreServer = createServer(coreResponse);
  await new Promise((resolve) => coreServer.listen(0, "127.0.0.1", resolve));
  coreBaseUrl = `http://127.0.0.1:${coreServer.address().port}`;
});

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => coreServer.close(resolve));
});

function callMcp(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        HA_API_BASE_URL: coreBaseUrl,
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

function parsePayload(result) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

function mostRecentRequest() {
  return new URL(requests.at(-1), coreBaseUrl);
}

describe("timezone-aware MCP history tools", () => {
  it("passes explicit UTC and offset timestamps through to every REST endpoint", async () => {
    const history = parsePayload(await callMcp("get_history", {
      entity_id: "sensor.temperature",
      start_time: "2026-08-07T04:00:00+02:00",
      end_time: "2026-08-07T05:00:00-07:00",
    }));
    let request = mostRecentRequest();
    expect(decodeURIComponent(request.pathname)).toBe("/history/period/2026-08-07T04:00:00+02:00");
    expect(request.searchParams.get("end_time")).toBe("2026-08-07T05:00:00-07:00");
    expect(history.meta).toMatchObject({
      input_time_requirement: "RFC 3339 timestamp with Z or UTC offset",
      response_time_reference: "UTC",
    });

    const logbook = parsePayload(await callMcp("get_logbook", {
      start_time: "2026-08-07T04:00:00Z",
      end_time: "2026-08-07T05:00:00+02:00",
    }));
    request = mostRecentRequest();
    expect(decodeURIComponent(request.pathname)).toBe("/logbook/2026-08-07T04:00:00Z");
    expect(request.searchParams.get("end_time")).toBe("2026-08-07T05:00:00+02:00");
    expect(logbook.meta.response_time_reference).toBe("UTC");

    await callMcp("get_calendar_events", {
      calendar_entity: "calendar.family",
      start: "2026-08-07T04:00:00+02:00",
      end: "2026-08-07T05:00:00Z",
    });
    request = mostRecentRequest();
    expect(request.pathname).toBe("/calendars/calendar.family");
    expect(request.searchParams.get("start")).toBe("2026-08-07T04:00:00+02:00");
    expect(request.searchParams.get("end")).toBe("2026-08-07T05:00:00Z");
  }, TIMEOUT_MS + 5_000);

  it("rejects every naive timestamp before making an HTTP request", async () => {
    const cases = [
      ["get_history", { entity_id: "sensor.temperature", start_time: "2026-08-07T04:00:00" }],
      ["get_logbook", { end_time: "2026-08-07T05:00:00" }],
      ["get_calendar_events", { calendar_entity: "calendar.family", start: "2026-08-07T04:00:00" }],
    ];

    for (const [toolName, args] of cases) {
      const before = requests.length;
      const result = await callMcp(toolName, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("timezone-aware RFC 3339 timestamp");
      expect(requests).toHaveLength(before);
    }
  }, TIMEOUT_MS + 10_000);

  it("keeps generated defaults in UTC", async () => {
    await callMcp("get_logbook");
    expect(decodeURIComponent(mostRecentRequest().pathname).split("/").at(-1)).toMatch(/Z$/);

    await callMcp("get_calendar_events", { calendar_entity: "calendar.family" });
    const request = mostRecentRequest();
    expect(request.searchParams.get("start")).toMatch(/Z$/);
    expect(request.searchParams.get("end")).toMatch(/Z$/);
  }, TIMEOUT_MS + 5_000);
});
