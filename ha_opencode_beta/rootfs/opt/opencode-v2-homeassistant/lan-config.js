import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export function httpsOrigin(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error(`${field} must be an HTTPS origin without a path, credentials, query or fragment`); }
}

export function parseLanOptions(options) {
  const apiEnabled = options.enable_server === true;
  const uiEnabled = options.enable_openchamber_lan === true;
  if (!apiEnabled && !uiEnabled) return { apiEnabled, uiEnabled };
  if (uiEnabled && options.interface_mode !== "openchamber") throw new Error("enable_openchamber_lan requires interface_mode: openchamber");
  const password = options.lan_password;
  if (typeof password !== "string" || password.length < 16 || password.length > 256 || password.trim() !== password || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error("lan_password must contain 16–256 characters with no control characters or surrounding whitespace");
  }
  const proxies = options.lan_trusted_proxies;
  if (!Array.isArray(proxies) || !proxies.length || proxies.length > 16 || proxies.some((ip) => typeof ip !== "string" || !isIP(ip))) {
    throw new Error("lan_trusted_proxies must list 1–16 exact reverse-proxy IP addresses (no hostnames, wildcards or CIDRs)");
  }
  const origins = options.cors_origins ?? [];
  if (!Array.isArray(origins) || origins.length > 32) throw new Error("cors_origins must be a list of at most 32 HTTPS origins");
  const nativeApps = options.openchamber_lan_native_apps ?? false;
  if (typeof nativeApps !== "boolean") throw new Error("openchamber_lan_native_apps must be true or false");
  return {
    apiEnabled, uiEnabled, password, proxies,
    apiOrigin: apiEnabled ? httpsOrigin(options.server_public_url, "server_public_url") : null,
    uiOrigin: uiEnabled ? httpsOrigin(options.openchamber_public_url, "openchamber_public_url") : null,
    corsOrigins: apiEnabled ? origins.map((origin) => httpsOrigin(origin, "cors_origins")) : [],
    nativeApps: uiEnabled && nativeApps,
  };
}

// Same root-owned, no-follow runtime boundary used for the backend credential.
export function readRuntimeFile(name, maxBytes = 16384) {
  if (!/^[a-z-]+(?:\.json)?$/.test(name)) throw new Error("Invalid runtime filename");
  const root = openSync("/run/opencode-v2", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fd;
  try {
    const directory = fstatSync(root);
    if (directory.uid !== 0 || (directory.mode & 0o022)) throw new Error("Unsafe runtime directory");
    fd = openSync(`/proc/self/fd/${root}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.size > maxBytes || (info.mode & 0o777) !== 0o600) throw new Error("Unsafe runtime file");
    return readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(root);
  }
}

export const readLanConfig = () => JSON.parse(readRuntimeFile("lan.json"));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== "--write" || process.argv.length !== 5) throw new Error("Invalid LAN staging arguments");
    const config = parseLanOptions(JSON.parse(readFileSync(process.argv[3], "utf8")));
    writeFileSync(process.argv[4], JSON.stringify(config), { mode: 0o600, flag: "wx" });
    // Native UI cookies, passkeys and paired-client tokens expire at app restart.
    // Keep authentication state separate from persistent sessions/settings.
    if (config.uiEnabled) {
      mkdirSync("/run/opencode-v2/openchamber-auth", { mode: 0o700 });
      chmodSync("/run/opencode-v2/openchamber-auth", 0o700);
    }
  } catch (error) {
    // Never include parser input or an option value in diagnostics.
    const message = /^(lan_|cors_origins|server_public_url|openchamber_public_url|enable_openchamber_lan|openchamber_lan_native_apps)/.test(error.message)
      ? error.message : "Unable to stage the managed LAN configuration";
    console.error(message);
    process.exitCode = 1;
  }
}
