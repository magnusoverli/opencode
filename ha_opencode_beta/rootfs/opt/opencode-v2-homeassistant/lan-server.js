import { readLanConfig, readRuntimeFile } from "./lan-config.js";
import { createLanProxy } from "./lan-proxy.js";

try {
  const mode = process.argv[2];
  if (process.getuid() !== 0 || !["api", "ui"].includes(mode)) throw new Error();
  const config = readLanConfig();
  if (!config[mode === "api" ? "apiEnabled" : "uiEnabled"]) throw new Error();
  const backendPassword = mode === "api" ? readRuntimeFile("server-password", 64) : null;
  if (mode === "api" && !/^[a-f0-9]{64}$/.test(backendPassword)) throw new Error();
  const direct = mode === "api" && Boolean(config.directSubnet);
  const directProtocol = direct ? new URL(config.apiOrigin).protocol : null;
  const tls = directProtocol === "https:" ? { cert: readRuntimeFile("direct-cert"), key: readRuntimeFile("direct-key") } : undefined;
  const proxy = createLanProxy({ ...config, mode, origin: mode === "api" ? config.apiOrigin : config.uiOrigin,
    backendPassword, upstreamPort: mode === "api" ? 4100 : 3010, tls });
  proxy.server.on("error", () => { console.error("Managed LAN listener could not start"); process.exit(1); });
  proxy.server.listen(mode === "api" ? 4096 : 4097, "0.0.0.0", () => console.log(`Managed ${mode} LAN frontend ready; ${direct ? `direct ${directProtocol.slice(0, -1).toUpperCase()} for configured subnet` : "HTTPS reverse proxy required"}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await proxy.close(); process.exit(0); });
} catch {
  console.error("LAN startup refused; check the LAN options and managed runtime readiness");
  process.exit(1);
}
