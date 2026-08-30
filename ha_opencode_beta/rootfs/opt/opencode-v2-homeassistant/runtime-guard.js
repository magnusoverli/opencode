import { Plugin } from "@opencode-ai/plugin";
import { scrubParentEnvironment, scrubShellEnvironment } from "./plugin.js";

export const RUNTIME_GUARD_PLUGIN_ID = "homeassistant.runtime-guard";
const PR_SET_DUMPABLE = 4;

export async function setProcessNonDumpable({
  platform = process.platform,
  loadFfi = () => import("bun:ffi"),
} = {}) {
  if (platform !== "linux") return;

  const { dlopen, FFIType } = await loadFfi();
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.int, FFIType.int, FFIType.int, FFIType.int, FFIType.int],
      returns: FFIType.int,
    },
  });
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      throw new Error("OpenCode V2 could not disable same-UID process inspection");
    }
  } finally {
    libc.close();
  }
}

export function createRuntimeGuardSetup({ harden = setProcessNonDumpable } = {}) {
  return async function setup(ctx) {
    await harden();
    scrubParentEnvironment();
    const shellRegistration = await ctx.shell.hook("create.before", scrubShellEnvironment);
    return async () => {
      await shellRegistration.dispose();
    };
  };
}

export default Plugin.define({
  id: RUNTIME_GUARD_PLUGIN_ID,
  setup: createRuntimeGuardSetup(),
});
