import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { buildManagedConfig } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

const ADDON_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = join(ADDON_ROOT, "rootfs", "opt", "opencode-v2-homeassistant");
const CLI = join(PACKAGE_ROOT, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe");
const PLUGIN = join(PACKAGE_ROOT, "plugin.js");
const PLUGIN_API = join(PACKAGE_ROOT, "node_modules", "@opencode-ai", "plugin", "dist", "promise", "index.js");
const HOME_PLUGIN_ID = "home.plugin.must-not-load";
const SENTINEL = "supervisor-token-must-not-appear";
const SERVER_PASSWORD = "v2-beta-test-server-password";
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

describe("real OpenCode V2 readiness probe", () => {
  it("confines version-probe writes to scrubbed disposable roots", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "opencode-v2-version-probe-"));
    try {
      const v1 = join(sandbox, "v1");
      const probe = join(sandbox, "v2", "work", ".runtime-probe.test");
      const v1Roots = {
        home: join(v1, "home"),
        config: join(v1, "config"),
        data: join(v1, "data"),
        state: join(v1, "state"),
        cache: join(v1, "cache"),
      };
      const probeRoots = {
        home: join(probe, "home"),
        config: join(probe, "config"),
        data: join(probe, "data"),
        state: join(probe, "state"),
        cache: join(probe, "cache"),
      };
      const workspace = join(probe, "workspace");
      const temporary = join(probe, "tmp");
      await Promise.all([
        ...Object.values(v1Roots).map((path) => mkdir(path, { recursive: true })),
        ...Object.values(probeRoots).map((path) => mkdir(path, { recursive: true })),
        mkdir(workspace, { recursive: true }),
        mkdir(temporary, { recursive: true }),
      ]);
      await Promise.all(Object.entries(v1Roots).map(([name, path]) => (
        writeFile(join(path, `${name}.sentinel`), `${name}-unchanged`)
      )));
      const inherited = {
        ...processEnv(),
        HOME: v1Roots.home,
        XDG_CONFIG_HOME: v1Roots.config,
        XDG_DATA_HOME: v1Roots.data,
        XDG_STATE_HOME: v1Roots.state,
        XDG_CACHE_HOME: v1Roots.cache,
        SUPERVISOR_TOKEN: SENTINEL,
      };
      const env = {
        HOME: probeRoots.home,
        USERPROFILE: probeRoots.home,
        XDG_CONFIG_HOME: probeRoots.config,
        XDG_DATA_HOME: probeRoots.data,
        XDG_STATE_HOME: probeRoots.state,
        XDG_CACHE_HOME: probeRoots.cache,
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        PATH: inherited.PATH,
        LANG: "C.UTF-8",
        USER: "opencode-v2",
        LOGNAME: "opencode-v2",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      };
      for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
        if (inherited[name]) env[name] = inherited[name];
      }

      const result = spawnSync(CLI, ["--version"], {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout.trim(), /(?:^|\sv?)0\.0\.0-beta-18684$/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SENTINEL));
      for (const [name, path] of Object.entries(v1Roots)) {
        assert.deepEqual(await readdir(path), [`${name}.sentinel`]);
        assert.equal(await readFile(join(path, `${name}.sentinel`), "utf8"), `${name}-unchanged`);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

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
      mkdir(join(home, ".opencode", "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, "opencode.json"), JSON.stringify({
        username: "project-config-must-not-load",
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })),
      writeFile(join(home, ".opencode", "plugins", "home.js"), [
        `import { Plugin } from ${JSON.stringify(pathToFileURL(PLUGIN_API).href)};`,
        `export default Plugin.define({ id: ${JSON.stringify(HOME_PLUGIN_ID)}, async setup() { return async () => {}; } });`,
        "",
      ].join("\n")),
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
    await writeFile(configPath, JSON.stringify(buildManagedConfig({
      pluginEnabled: true,
      pluginPackage: pathToFileURL(PLUGIN).href,
      mcpEndpoint: sidecarEndpoint,
    }), null, 2));

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
    assert.equal(pluginResponse.data.some((item) => item.id === HOME_PLUGIN_ID), false);
    assert.equal(mcpResponse.data.find((item) => item.name === "homeassistant").status.status, "failed");
    assert.equal((output.match(/loading plugin/g) ?? []).length, 1, output);
    assert.doesNotMatch(output, new RegExp(SENTINEL));
    assert.doesNotMatch(output, new RegExp(SERVER_PASSWORD));
  });

  it("loads the ordered native V2 policy only from the managed document", async () => {
    const response = await pollJson(
      `${baseUrl}/api/config`,
      (body) => Array.isArray(body),
      () => output,
    );
    const documents = response.filter((entry) => entry.type === "document");

    assert.equal(documents.length, 1);
    assert.match(documents[0].path, /managed-opencode\.json$/);
    assert.equal(documents[0].info.username, undefined);
    assert.deepEqual(documents[0].info.permissions, buildManagedConfig({
      restrictSensitiveFiles: true,
    }).permissions);
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
