import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import runtimeGuard, {
  RUNTIME_GUARD_PLUGIN_ID,
  createRuntimeGuardSetup,
  setProcessNonDumpable,
} from "../rootfs/opt/opencode-v2-homeassistant/runtime-guard.js";

const SENSITIVE_NAMES = [
  "OPENCODE_SERVER_PASSWORD",
  "SUPERVISOR_TOKEN",
  "HA_TOKEN",
  "HA_ACCESS_TOKEN",
  "OPENCODE_MCP_CALLER_SECRET",
  "OPENCODE_MCP_SIDECAR_SECRET_FILE",
  "HOME_ASSISTANT_SIDECAR_AUTHORIZATION",
  "LD_PRELOAD",
];

afterEach(() => {
  for (const name of SENSITIVE_NAMES) delete process.env[name];
  delete process.env.OPENCODE_MCP_TOOL_PROFILE;
});

describe("OpenCode V2 runtime guard", () => {
  it("sets PR_SET_DUMPABLE on the final Linux process and closes libc", async () => {
    const calls = [];
    await setProcessNonDumpable({
      platform: "linux",
      loadFfi: async () => ({
        FFIType: { int: "int" },
        dlopen(name, symbols) {
          calls.push(["open", name, symbols]);
          return {
            symbols: {
              prctl(...args) {
                calls.push(["prctl", ...args]);
                return 0;
              },
            },
            close() {
              calls.push(["close"]);
            },
          };
        },
      }),
    });

    assert.equal(calls[0][0], "open");
    assert.equal(calls[0][1], "libc.so.6");
    assert.deepEqual(calls[1], ["prctl", 4, 0, 0, 0, 0]);
    assert.deepEqual(calls[2], ["close"]);
  });

  it("fails closed when process inspection cannot be disabled", async () => {
    await assert.rejects(
      setProcessNonDumpable({
        platform: "linux",
        loadFfi: async () => ({
          FFIType: { int: "int" },
          dlopen: () => ({ symbols: { prctl: () => -1 }, close() {} }),
        }),
      }),
      /could not disable same-UID process inspection/,
    );
  });

  it("hardens before scrubbing the parent and every shell child", async () => {
    const calls = [];
    let shellHook;
    for (const name of SENSITIVE_NAMES) process.env[name] = `${name}-sentinel`;
    process.env.OPENCODE_MCP_TOOL_PROFILE = "compact";

    const cleanup = await createRuntimeGuardSetup({
      harden: async () => calls.push("harden"),
    })({
      shell: {
        async hook(name, callback) {
          calls.push(name);
          shellHook = callback;
          return { async dispose() { calls.push("dispose"); } };
        },
      },
    });

    assert.deepEqual(calls, ["harden", "create.before"]);
    for (const name of SENSITIVE_NAMES) assert.equal(process.env[name], undefined);
    assert.equal(process.env.OPENCODE_MCP_TOOL_PROFILE, "compact");

    const input = { env: Object.fromEntries(SENSITIVE_NAMES.map((name) => [name, "sentinel"])) };
    input.env.PATH = "/usr/bin";
    shellHook(input);
    assert.deepEqual(input.env, { PATH: "/usr/bin" });

    await cleanup();
    assert.deepEqual(calls, ["harden", "create.before", "dispose"]);
  });

  it("keeps a stable first-party plugin contract", () => {
    assert.equal(RUNTIME_GUARD_PLUGIN_ID, "homeassistant.runtime-guard");
    assert.equal(runtimeGuard.id, RUNTIME_GUARD_PLUGIN_ID);
    assert.equal(typeof runtimeGuard.setup, "function");
  });
});
