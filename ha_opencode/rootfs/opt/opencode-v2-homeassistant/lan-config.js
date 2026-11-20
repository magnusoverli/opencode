import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { directSubnet, loadDirectTls } from "./direct-lan.js";

class LanOptionsError extends Error {}

function parseOrigin(value, field, allowHttp) {
  try {
    const url = new URL(value);
    if (!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new LanOptionsError(`${field} must be an ${allowHttp ? "HTTP or HTTPS" : "HTTPS"} origin without a path, credentials, query or fragment`); }
}

export function parseLanOptions(options) {
  const apiEnabled = options.enable_server === true;
  const uiEnabled = options.enable_openchamber_lan === true;
  if (!apiEnabled && !uiEnabled) return { apiEnabled, uiEnabled };
  const problems = new Set();
  const subnet = options.server_direct_subnet ?? "";
  const direct = apiEnabled && subnet !== "";
  const clients = direct ? directSubnet(subnet) : null;
  if (direct && !clients) problems.add("server_direct_subnet must be a private IPv4 network in CIDR notation, for example 192.168.5.0/24");
  if (direct && options.server_desktop_app !== true) problems.add("server_direct_subnet requires server_desktop_app: true");
  function origin(value, field, allowHttp = false) {
    try { return parseOrigin(value, field, allowHttp); }
    catch (error) {
      if (!(error instanceof LanOptionsError)) throw error;
      problems.add(error.message);
    }
  }
  if (uiEnabled && options.interface_mode !== "openchamber") problems.add("enable_openchamber_lan requires interface_mode: openchamber");
  const password = options.lan_password;
  if (typeof password !== "string" || password.length < 16 || password.length > 256 || password.trim() !== password || /[\x00-\x1f\x7f]/.test(password)) {
    problems.add("lan_password must contain 16–256 characters with no control characters or surrounding whitespace");
  }
  const proxies = options.lan_trusted_proxies ?? [];
  if (!Array.isArray(proxies) || ((!direct || uiEnabled) && !proxies.length) || proxies.length > 16 || proxies.some((ip) => typeof ip !== "string" || !isIP(ip))) {
    problems.add("lan_trusted_proxies must list 1–16 exact reverse-proxy IP addresses (no hostnames, wildcards or CIDRs)");
  }
  const origins = options.cors_origins ?? [];
  const validList = Array.isArray(origins) && origins.length <= 32;
  if (!validList) problems.add("cors_origins must be a list of at most 32 HTTPS origins");
  const nativeApps = options.openchamber_lan_native_apps ?? false;
  if (typeof nativeApps !== "boolean") problems.add("openchamber_lan_native_apps must be true or false");
  const desktopApps = options.server_desktop_app ?? false;
  if (typeof desktopApps !== "boolean") problems.add("server_desktop_app must be true or false");
  const apiOrigin = apiEnabled ? origin(options.server_public_url, "server_public_url", direct) : null;
  if (direct && apiOrigin && clients) {
    const host = new URL(apiOrigin).hostname;
    if (isIP(host) !== 4 || !clients.check(host, "ipv4")) problems.add("server_public_url must use the HA host's IPv4 address inside server_direct_subnet");
  }
  const uiOrigin = uiEnabled ? origin(options.openchamber_public_url, "openchamber_public_url") : null;
  const corsOrigins = apiEnabled && validList ? origins.map((value) => origin(value, "cors_origins")) : [];
  if (problems.size) throw new LanOptionsError([...problems].join("\n"));
  return {
    apiEnabled, uiEnabled, password, proxies, apiOrigin, uiOrigin, corsOrigins,
    directSubnet: direct ? subnet : null,
    nativeApps: uiEnabled && nativeApps,
    desktopApps: apiEnabled && desktopApps,
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
    const checkOnly = process.argv[2] === "--check" && process.argv.length === 4;
    if (!checkOnly && !(process.argv[2] === "--write" && process.argv.length === 5)) throw new Error("Invalid LAN staging arguments");
    const config = parseLanOptions(JSON.parse(readFileSync(process.argv[3], "utf8")));
    if (config.directSubnet && new URL(config.apiOrigin).protocol === "https:") {
      let tls;
      try { tls = loadDirectTls(process.env.ADDON_CHANNEL, config.apiOrigin); }
      catch { throw new LanOptionsError("server_direct_subnet requires lan-tls/server.pem and lan-tls/server-key.pem in the channel's configuration directory: use a current certificate for the HA IP and its matching unencrypted key"); }
      if (!checkOnly) {
        const directory = dirname(process.argv[4]);
        for (const [name, value] of [["direct-cert", tls.cert], ["direct-key", tls.key]]) {
          writeFileSync(join(directory, name), value, { mode: 0o600, flag: "wx" });
        }
      }
    }
    if (!checkOnly) writeFileSync(process.argv[4], JSON.stringify(config), { mode: 0o600, flag: "wx" });
    // Native UI cookies, passkeys and paired-client tokens expire at app restart.
    // Keep authentication state separate from persistent sessions/settings.
    if (!checkOnly && config.uiEnabled) {
      mkdirSync("/run/opencode-v2/openchamber-auth", { mode: 0o700 });
      chmodSync("/run/opencode-v2/openchamber-auth", 0o700);
    }
  } catch (error) {
    // Never include parser input or an option value in diagnostics.
    const message = error instanceof LanOptionsError ? error.message : "Unable to read or prepare the managed LAN configuration";
    console.error(message);
    process.exitCode = 1;
  }
}
