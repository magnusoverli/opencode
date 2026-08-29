import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe");
const PLUGIN = join(ROOT, "plugin.js");
const SENTINEL = "supervisor-token-must-not-appear";
const SERVER_PASSWORD = "v2-spike-server-password";
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64")}`;
const HOME_ASSISTANT_SECRET_KEYS = Object.freeze([
  "SUPERVISOR_TOKEN",
  "HA_TOKEN",
  "HA_ACCESS_TOKEN",
  "HOME_ASSISTANT_TOKEN",
  "HAB_ESPHOME_TOKEN",
  "HAB_ESPHOME_SESSION",
  "HAB_ESPHOME_URL",
  "PPQ_API_KEY",
  "Z2M_URL",
]);

async function availablePort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  server.close();
  await once(server, "close");
  assert.ok(port);
  return port;
}

async function pollJson(url, predicate, logs) {
  const deadline = Date.now() + 15_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Authorization: AUTHORIZATION } });
      if (response.ok) {
        const body = await response.json();
        if (predicate(body)) return body;
      } else {
        lastError = new Error(`${response.status} ${response.statusText}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  assert.fail(`Timed out polling ${url}: ${lastError ?? "predicate did not match"}\n${logs()}`);
}

async function pollStatus(url, predicate, logs, headers = {}) {
  const deadline = Date.now() + 15_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (predicate(response)) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  assert.fail(`Timed out polling ${url}: ${lastError ?? "predicate did not match"}\n${logs()}`);
}

async function stopProcessTree(child) {
  if (!child) return;

  if (globalThis.process.platform === "win32") {
    if (hasExited(child)) return;
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    await waitForExit(child, 5_000);
    return;
  }

  if (processGroupExists(child.pid)) signalProcessGroup(child.pid, "SIGTERM");
  await waitForExit(child, 5_000);
  if (processGroupExists(child.pid)) {
    signalProcessGroup(child.pid, "SIGKILL");
  }
  await waitForProcessGroupExit(child.pid, 5_000);
  assert.equal(processGroupExists(child.pid), false, "OpenCode V2 process group did not stop");
}

async function waitForExit(child, timeout) {
  const deadline = Date.now() + timeout;
  while (!hasExited(child) && Date.now() < deadline) await delay(50);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalProcessGroup(pid, signal) {
  try {
    globalThis.process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(pid) {
  try {
    globalThis.process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (processGroupExists(pid) && Date.now() < deadline) await delay(50);
}

describe("real OpenCode V2 plugin loader", () => {
  let sandbox;
  let workspace;
  let env;
  let serverProcess;
  let sidecarServer;
  let output = "";
  let baseUrl;

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "opencode-v2-ha-plugin-"));
    const configHome = join(sandbox, "config");
    const configDirectory = join(configHome, "opencode");
    const home = join(sandbox, "home");
    workspace = join(sandbox, "workspace");

    await Promise.all([
      mkdir(configDirectory, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);

    sidecarServer = createHttpServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"test sidecar has no MCP transport"}');
    });
    sidecarServer.listen(0, "127.0.0.1");
    await once(sidecarServer, "listening");
    const sidecarAddress = sidecarServer.address();
    assert.ok(typeof sidecarAddress === "object" && sidecarAddress);
    const sidecarEndpoint = `http://127.0.0.1:${sidecarAddress.port}/mcp`;

    const configPath = join(sandbox, "managed-opencode.json");
    await writeFile(configPath, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      plugins: [{
        package: pathToFileURL(PLUGIN).href,
        options: {
          endpoint: sidecarEndpoint,
          timeouts: { startup: 100, catalog: 100, execution: 100 },
        },
      }],
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    }, null, 2));

    const credentialBearingEnvironment = { ...processEnv() };
    for (const key of HOME_ASSISTANT_SECRET_KEYS) credentialBearingEnvironment[key] = SENTINEL;
    env = {
      ...withoutHomeAssistantCredentials(credentialBearingEnvironment),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_STATE_HOME: join(sandbox, "state"),
      XDG_CACHE_HOME: join(sandbox, "cache"),
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    };
    for (const key of HOME_ASSISTANT_SECRET_KEYS) assert.equal(env[key], undefined);

    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(CLI, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "debug",
    ], {
      cwd: workspace,
      env,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.on("data", (chunk) => { output += chunk; });
    serverProcess.stderr.on("data", (chunk) => { output += chunk; });

    await pollStatus(`${baseUrl}/api/health`, (response) => response.status === 401, () => output);
    const wrongPassword = `Basic ${Buffer.from("opencode:wrong-password").toString("base64")}`;
    const wrongResponse = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: wrongPassword },
    });
    assert.equal(wrongResponse.status, 401);
    await pollJson(`${baseUrl}/api/health`, () => true, () => output);
  });

  after(async () => {
    await stopProcessTree(serverProcess);
    assert.ok(hasExited(serverProcess), `OpenCode V2 server did not stop\n${output}`);
    if (sidecarServer) {
      sidecarServer.closeAllConnections();
      sidecarServer.close();
      await once(sidecarServer, "close");
    }
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("loads the pinned plugin and reconciles its MCP transform", async () => {
    const pluginResponse = await pollJson(
      `${baseUrl}/api/plugin`,
      (body) => body.data?.some((item) => item.id === "homeassistant.mcp" && item.status === "active"),
      () => output,
    );
    const mcpResponse = await pollJson(
      `${baseUrl}/api/mcp`,
      (body) => body.data?.some(
        (item) => item.name === "homeassistant" && item.status.status === "failed",
      ),
      () => output,
    );

    assert.equal(
      pluginResponse.data.filter((item) => item.id === "homeassistant.mcp").length,
      1,
    );
    assert.equal(mcpResponse.data.find((item) => item.name === "homeassistant").status.status, "failed");
    assert.equal((output.match(/loading plugin/g) ?? []).length, 1, output);
    assert.doesNotMatch(output, new RegExp(SENTINEL));
    assert.doesNotMatch(output, new RegExp(SERVER_PASSWORD));
  });

  it("loads the native V2 deny policy only from the managed document", async () => {
    const response = await pollJson(
      `${baseUrl}/api/config`,
      (body) => Array.isArray(body),
      () => output,
    );
    const documents = response.filter((entry) => entry.type === "document");

    assert.equal(documents.length, 1);
    assert.match(documents[0].path, /managed-opencode\.json$/);
    assert.deepEqual(documents[0].info.permissions, [
      { action: "*", resource: "*", effect: "deny" },
    ]);
  });
});

function processEnv() {
  return globalThis.process.env;
}

function withoutHomeAssistantCredentials(input) {
  const output = { ...input };
  for (const key of HOME_ASSISTANT_SECRET_KEYS) delete output[key];
  return output;
}
