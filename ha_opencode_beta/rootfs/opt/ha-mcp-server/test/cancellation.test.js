import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createOperationSignal,
  runCancellableExecFile,
  withRequestSignal,
} from "../lib/cancellation.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const cleanups = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("production operation cancellation", () => {
  it("composes a request cancellation with an operation deadline", async () => {
    const controller = new AbortController();
    const operation = withRequestSignal(controller.signal, () => createOperationSignal(60_000));
    controller.abort("cancelled by client");

    expect(operation.signal.aborted).toBe(true);
    expect(operation.signal.reason.message).toContain("cancelled by client");
    operation.cleanup();
  });

  it("terminates a running CLI when its request is cancelled", async () => {
    const controller = new AbortController();
    const running = withRequestSignal(controller.signal, () => runCancellableExecFile(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 60_000, killGraceMs: 25 },
    ));
    controller.abort("cancelled CLI");

    await expect(running).rejects.toThrow(/cancelled CLI/);
  });

  it("aborts the production Home Assistant fetch behind a cancelled MCP call", async () => {
    let requestStarted;
    let requestClosed;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const closed = new Promise((resolve) => { requestClosed = resolve; });
    const api = createServer((request) => {
      requestStarted();
      request.once("close", requestClosed);
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => api.close(resolve)));

    const address = api.address();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        SUPERVISOR_TOKEN: "test-token",
        HA_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        OPENCODE_MCP_TOOL_PROFILE: "full",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "cancellation-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const controller = new AbortController();
    const call = client.callTool(
      { name: "get_states", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort("cancelled HA request");

    await expect(call).rejects.toThrow(/cancelled HA request/);
    await expect(closed).resolves.toBeUndefined();
  });
});
