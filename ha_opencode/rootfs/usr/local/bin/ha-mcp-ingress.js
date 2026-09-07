const fs = require("node:fs");
const http = require("node:http");

// This boundary is independent of the UI's loopback/LAN allowlist.
function routeHaMcp(req, res, { ingressPath, upstreamPath, lan = false }) {
  const pathname = upstreamPath.split("?", 1)[0];
  if (pathname !== "/ha-mcp" && !pathname.startsWith("/ha-mcp/")) return false;
  const reject = (status) => {
    res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(status === 503 ? "MCP setup unavailable\n" : "Forbidden\n");
  };
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const user = req.headers["x-remote-user-id"];
  const host = req.headers["x-forwarded-host"];
  const proto = req.headers["x-forwarded-proto"];
  let origin;
  try {
    if (proto !== "http" && proto !== "https") throw new Error();
    if (typeof host !== "string" || /[\s,/@\\?#%]/.test(host)) throw new Error();
    origin = new URL(`${proto}://${host}`);
    if (!origin.hostname || origin.username || origin.password) throw new Error();
  } catch { reject(403); return true; }
  // Reject duplicate security metadata rather than selecting one interpretation.
  const securityHeaders = ["x-remote-user-id", "x-forwarded-host", "x-forwarded-proto", "x-ingress-path", "origin"];
  const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  if (lan || remote !== "172.30.32.2"
      || securityHeaders.some((name) => names.filter((entry) => entry === name).length > 1)
      || typeof user !== "string" || !/^[a-f0-9]{32}$/.test(user)
      // Core can retain caller-supplied forwarding headers. This origin is only
      // a candidate: browser Origin and the service's bound nonce must agree.
      || ((req.method === "POST" || req.headers.origin !== undefined) && req.headers.origin !== origin.origin)
      || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(ingressPath)
      || req.headers["x-ingress-path"] !== ingressPath
      || !["/ha-mcp/", "/ha-mcp/authorize"].includes(pathname)) {
    reject(403); return true;
  }
  let secret;
  let fd;
  try {
    const directory = fs.lstatSync("/run/ha-facing-mcp");
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o077)) throw new Error();
    fd = fs.openSync("/run/ha-facing-mcp/ingress-secret", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size !== 43) throw new Error();
    secret = fs.readFileSync(fd, "utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error();
  } catch { reject(503); return true; }
  finally { if (fd !== undefined) fs.closeSync(fd); }

  const headers = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-ha-mcp-")) delete headers[name];
  }
  // Never let hop-by-hop header nominations remove the trusted IPC metadata.
  delete headers.connection;
  delete headers.upgrade;
  delete headers["proxy-connection"];
  headers.host = "127.0.0.1:8767";
  headers["x-ha-mcp-ingress-secret"] = secret;
  headers["x-ha-mcp-user-id"] = user;
  headers["x-ha-mcp-external-origin"] = origin.origin;
  headers["x-ha-mcp-external-path"] = ingressPath + pathname;
  const upstream = http.request({ host: "127.0.0.1", port: 8767, path: upstreamPath, method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.on("error", () => res.destroy());
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else reject(503);
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  req.on("aborted", () => upstream.destroy());
  req.on("error", () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
  return true;
}

module.exports = { routeHaMcp };
