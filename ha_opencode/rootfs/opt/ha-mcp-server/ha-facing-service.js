import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDiscoveryPublisher, runDiscoveryPublisher } from "./ha-facing-discovery.js";

export async function runService(env = process.env, {
  launch = async (settings) => (await import("./ha-facing-mcp.js")).launch(settings),
  publish = runDiscoveryPublisher, signals = process,
} = {}) {
  const controller = new AbortController();
  let deadline;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    deadline = setTimeout(() => process.exit(1), 10000).unref();
  };
  signals.on("SIGTERM", stop); signals.on("SIGINT", stop);
  let server;
  try {
    const enabled = env.HA_MCP_ENABLED === "true";
    if (enabled) server = await launch(env);
    if (!controller.signal.aborted) await publish(createDiscoveryPublisher({ enabled,
      token: env.SUPERVISOR_TOKEN, directory: env.HA_MCP_STATE_DIR,
    }), { signal: controller.signal });
  } finally {
    controller.abort();
    try { await server?.close(); }
    finally {
      clearTimeout(deadline);
      signals.removeListener("SIGTERM", stop); signals.removeListener("SIGINT", stop);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runService().catch(() => {
    console.error("HA-facing MCP service failed; check private state and Supervisor access.");
    process.exitCode = 1;
  });
}
