import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "http";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "evaluate-agent.mjs");
const temporaryDirectories = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

function responseFor(request) {
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  const toolResults = request.messages.filter((message) => message.role === "tool").length;
  const toolCall = (name, argumentsValue) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `${name}-${toolResults}`, type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } }],
  });

  if (user.includes("current state of the kitchen light")) {
    return toolResults ? { role: "assistant", content: "The kitchen light is on." } : toolCall("get_home_context", { entity_id: "light.kitchen" });
  }
  if (user.includes("kitchen temperature sensor")) {
    return toolResults ? { role: "assistant", content: "The sensor has not checked in recently." } : toolCall("diagnose_entity", { entity_id: "sensor.kitchen_temperature" });
  }
  return toolResults === 0
    ? toolCall("get_integration_docs", { integration: "template" })
    : toolResults === 1
      ? toolCall("write_config_safe", { file_path: "packages/weather.yaml", content: "template: []", dry_run: true })
      : { role: "assistant", content: "The configuration dry run passed." };
}

function runRunner(environment, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, "--out", output], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ha-agent-eval runner", () => {
  it("runs synthetic scenarios through an OpenAI-compatible provider and writes a report", async () => {
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: responseFor(JSON.parse(body)) }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const directory = await mkdtemp(join(tmpdir(), "ha-agent-eval-"));
    temporaryDirectories.push(directory);

    try {
      const output = join(directory, "report.json");
      const result = await runRunner({
        HA_AGENT_EVAL_BASE_URL: `http://127.0.0.1:${port}`,
        HA_AGENT_EVAL_MODEL: "synthetic-model",
      }, output);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("3/3 scenarios passed");
      const report = JSON.parse(await readFile(output, "utf8"));
      expect(report.summary).toEqual({ total: 3, passed: 3, failed: 0 });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
