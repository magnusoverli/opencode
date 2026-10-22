import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { readLanConfig, readRuntimeFile } from "../opencode-v2-homeassistant/lan-config.js";
import { AGENT_SETTINGS_KEY, createAgentSettingsBridge } from "../opencode-v2-homeassistant/agent-settings.js";

// s6 starts Node with the app's native non-dumpable constructor before any secret
// is read. Only the preview's process-owned auth state receives this credential.
const key = Symbol.for("ha.openchamber.credential");
function credential() {
  const root = openSync("/run/opencode-v2", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fd;
  const bytes = Buffer.alloc(65);
  try {
    const directory = fstatSync(root);
    if (directory.uid !== 0 || (directory.mode & 0o022)) throw new Error();
    fd = openSync(`/proc/self/fd/${root}/server-password`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.size !== 64 || (info.mode & 0o777) !== 0o600) throw new Error();
    const length = readSync(fd, bytes);
    const password = bytes.subarray(0, length).toString("utf8");
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error();
    return password;
  } finally {
    bytes.fill(0);
    if (fd !== undefined) closeSync(fd);
    closeSync(root);
  }
}

try {
  if (process.getuid() !== 0 || process.env.OPENCODE_HOST !== "http://127.0.0.1:4100" || process.env.OPENCODE_SKIP_START !== "true") throw new Error();
  globalThis[key] = credential();
  const base = JSON.parse(readRuntimeFile("agents-base.json", 4 * 1024 * 1024));
  globalThis[AGENT_SETTINGS_KEY] = createAgentSettingsBridge({ password: globalThis[key], base });
  // init publishes this root-owned marker only after activating a validated V2
  // generation. OpenChamber reads credentials through that backend's API.
  const generation = readRuntimeFile("ready", 128).trim();
  if (!/^\/data\/v2\/generations\/[a-f0-9]{32}$/.test(generation)) throw new Error();
  const lan = readLanConfig();
  if (lan.uiEnabled) process.env.OPENCHAMBER_AUTH_DIR = "/run/opencode-v2/openchamber-auth";
  const { startWebUiServer } = await import("/opt/openchamber-preview/packages/web/server/index.js");
  delete globalThis[key];
  await startWebUiServer({ port: 3010, host: "127.0.0.1", ...(lan.uiEnabled ? { uiPassword: lan.password } : {}) });
} catch {
  delete globalThis[key];
  console.error("OpenChamber could not attach to the managed V2 backend; inspect the app status");
  process.exit(1);
}
