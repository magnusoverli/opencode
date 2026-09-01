import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startAuthenticatedStreamableHttp } from "../lib/authenticated-streamable-http.js";

const SECRET = "a".repeat(64);
const openListeners = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.allSettled(openListeners.splice(0).map((listener) => listener.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function startTestServer({ callDelayMs = 0, callHandler, jsonRpcHandlers = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ha-mcp-http-"));
  temporaryDirectories.push(directory);
  const secretFile = join(directory, "secret");
  await writeFile(secretFile, `${SECRET}\n`, { mode: 0o600 });
  await chmod(secretFile, 0o600);

  const mcpServer = new Server(
    { name: "transport-test", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "test_tool",
        description: "Transport test tool",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "test_tool") throw new Error("Unknown tool");
    if (callHandler) return callHandler(request, extra);
    if (callDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, callDelayMs));
    return { content: [{ type: "text", text: "complete" }] };
  });

  const listener = await startAuthenticatedStreamableHttp(mcpServer, {
    secretFile,
    host: "127.0.0.1",
    port: 0,
    jsonRpcHandlers,
  });
  openListeners.push(listener);
  return `http://${listener.host}:${listener.port}`;
}

function initializeRequest() {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    }),
  };
}

describe("authenticated Streamable HTTP transport", () => {
  it("rejects missing and incorrect bearer authorization", async () => {
    const baseUrl = await startTestServer();
    const missing = await fetch(`${baseUrl}/mcp`, initializeRequest());
    const wrong = await fetch(`${baseUrl}/mcp`, {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${"b".repeat(64)}` },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("initializes and lists tools through the authenticated SDK client", async () => {
    const baseUrl = await startTestServer();
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const result = await client.listTools();
    await client.close();

    expect(client.getServerVersion()?.name).toBe("transport-test");
    expect(result.tools.map((tool) => tool.name)).toEqual(["test_tool"]);
  });

  it("serves an independent authenticated stateless native MCP route", async () => {
    const nativeMessages = [];
    const nativeHandler = vi.fn(async (message, context) => {
      nativeMessages.push({
        method: message.method,
        requestedProtocolVersion: message.params?.protocolVersion,
        headerProtocolVersion: context.protocolVersion,
      });
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "homeassistant-native", version: "1" },
          },
        };
      }
      if (message.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "HassTurnOn", inputSchema: { type: "object" } }] },
        };
      }
      return null;
    });
    const baseUrl = await startTestServer({
      jsonRpcHandlers: { "/native-mcp": nativeHandler },
    });
    const missing = await fetch(`${baseUrl}/native-mcp`, initializeRequest());
    const nativeClient = new Client({ name: "native-vitest", version: "1.0.0" });
    const nativeTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/native-mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });
    const regularClient = new Client({ name: "regular-vitest", version: "1.0.0" });
    const regularTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    expect(missing.status).toBe(401);
    await Promise.all([nativeClient.connect(nativeTransport), regularClient.connect(regularTransport)]);
    expect((await nativeClient.listTools()).tools.map((tool) => tool.name)).toEqual(["HassTurnOn"]);
    expect((await regularClient.listTools()).tools.map((tool) => tool.name)).toEqual(["test_tool"]);
    await Promise.all([nativeClient.close(), regularClient.close()]);
    const initialization = nativeMessages.find(({ method }) => method === "initialize");
    const toolsList = nativeMessages.find(({ method }) => method === "tools/list");
    expect(initialization).toBeDefined();
    expect(toolsList).toBeDefined();
    expect(toolsList.headerProtocolVersion).toBe(initialization.requestedProtocolVersion);
  });

  it("keeps authenticated tool calls open beyond the former socket timeout", async () => {
    const baseUrl = await startTestServer({ callDelayMs: 15_250 });
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const result = await client.callTool({ name: "test_tool", arguments: {} });
    await client.close();

    expect(result.content).toEqual([{ type: "text", text: "complete" }]);
  }, 20_000);

  it("delivers cancellation while an authenticated tool call is running", async () => {
    let startedResolve;
    let abortedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const aborted = new Promise((resolve) => { abortedResolve = resolve; });
    const baseUrl = await startTestServer({
      callHandler: (_request, extra) => new Promise((resolve) => {
        startedResolve();
        extra.signal.addEventListener("abort", () => {
          abortedResolve();
          resolve({ content: [{ type: "text", text: "cancelled" }] });
        }, { once: true });
      }),
    });
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });
    const controller = new AbortController();

    await client.connect(transport);
    const call = client.callTool(
      { name: "test_tool", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort("test cancellation");

    await expect(call).rejects.toThrow(/test cancellation/);
    await expect(aborted).resolves.toBeUndefined();
    await client.close();
  });

  it("cancels active work before waiting for HTTP shutdown", async () => {
    let startedResolve;
    let abortedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const aborted = new Promise((resolve) => { abortedResolve = resolve; });
    const baseUrl = await startTestServer({
      callHandler: (_request, extra) => new Promise((resolve) => {
        startedResolve();
        extra.signal.addEventListener("abort", () => {
          abortedResolve();
          resolve({ content: [{ type: "text", text: "stopped" }] });
        }, { once: true });
      }),
    });
    const listener = openListeners.at(-1);
    const client = new Client({ name: "shutdown-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const call = client.callTool({ name: "test_tool", arguments: {} });
    await started;
    const closing = listener.close();

    await expect(aborted).resolves.toBeUndefined();
    await closing;
    await expect(call).rejects.toThrow();
  });

  it("replaces a closed local client session without restarting the sidecar", async () => {
    const baseUrl = await startTestServer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = new Client({ name: `vitest-${attempt}`, version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
      });
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      await client.close();
    }
  });

  it("rejects the wrong path and every Origin header", async () => {
    const baseUrl = await startTestServer();
    const authorized = {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}` },
    };
    const wrongPath = await fetch(`${baseUrl}/mcp/`, authorized);
    const origin = await fetch(`${baseUrl}/mcp`, {
      ...authorized,
      headers: { ...authorized.headers, origin: "http://localhost" },
    });

    expect(wrongPath.status).toBe(404);
    expect(origin.status).toBe(403);
  });

  it("does not disclose the bearer secret in responses or logs", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${"c".repeat(64)}` },
    });
    const disclosureSurface = [
      await response.text(),
      JSON.stringify(Object.fromEntries(response.headers)),
      ...errorLog.mock.calls.flat().map(String),
    ].join("\n");

    expect(disclosureSurface).not.toContain(SECRET);
    expect(disclosureSurface).not.toContain("c".repeat(64));
  });
});
