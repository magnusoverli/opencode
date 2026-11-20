import { BlockList, isIPv4 } from "node:net";
import { constants, openSync, closeSync, readFileSync, fstatSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";

// Require a canonical subnet entirely inside RFC 1918 space. The listener is
// in a bridged container: its own interface/netmask is not the user's LAN.
export function directSubnet(value) {
  if (typeof value !== "string") return null;
  const match = /^([\d.]+)\/([1-9]\d?)$/.exec(value);
  if (!match || !isIPv4(match[1])) return null;
  const [a, b, c, d] = match[1].split(".").map(Number);
  const prefix = Number(match[2]);
  const min = a === 10 ? 8 : a === 172 && b >= 16 && b <= 31 ? 12 : a === 192 && b === 168 ? 16 : 33;
  if (prefix < min || prefix > 32 || (((a * 256 + b) * 256 + c) * 256 + d) % (2 ** (32 - prefix))) return null;
  const list = new BlockList();
  list.addSubnet(match[1], prefix, "ipv4");
  return list;
}

// Only read the two fixed files under the selected channel, never traverse a
// workspace symlink or block on a FIFO. Private key bytes never enter options.
export function loadDirectTls(channel, origin) {
  const fds = [];
  const open = (path, flags) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | flags);
    fds.push(fd);
    return fd;
  };
  try {
    const state = open(`/homeassistant/${channel === "beta" ? "opencode_beta" : "opencode"}`, constants.O_DIRECTORY);
    const dir = open(`/proc/self/fd/${state}/lan-tls`, constants.O_DIRECTORY);
    const read = name => {
      const fd = open(`/proc/self/fd/${dir}/${name}`, constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 16384) throw new Error();
      return readFileSync(fd, "utf8");
    };
    const cert = read("server.pem");
    const key = read("server-key.pem");
    validateDirectTls(cert, key, origin);
    return { cert, key };
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
  }
}

export function validateDirectTls(cert, key, origin) {
  const leaf = new X509Certificate(cert);
  if (!leaf.checkIP(new URL(origin).hostname) || Date.now() < Date.parse(leaf.validFrom) || Date.now() >= Date.parse(leaf.validTo)) throw new Error("Certificate does not cover the address or current date");
  createSecureContext({ cert, key, minVersion: "TLSv1.2" });
}
