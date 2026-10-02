// Exact preview-source patches: app supervision, credentials and Ingress HTTP.
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
function patch(file, before, after) {
  const target = path.join(root, "packages/web/server/lib/opencode", file);
  const source = fs.readFileSync(target, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Unexpected preview source: ${file}`);
  fs.writeFileSync(target, source.replace(before, after));
}
patch("hmr-state-runtime.js", `    const initialPassword = [processLike.env.OPENCODE_PASSWORD, processLike.env.OPENCODE_SERVER_PASSWORD]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0) || '';`, `    const initialPassword = globalThis[Symbol.for("ha.openchamber.credential")] || '';`);
patch("auth-state-runtime.js", "process.env.OPENCODE_SERVER_PASSWORD = normalized;",
  "// The HA app keeps this credential in process-owned state only.");
patch("lifecycle.js", "const startOpenCode = async () => {",
  `const startOpenCode = async () => {
    throw new Error('OpenCode is managed by Home Assistant; use the app controls');`);
// Core/Supervisor Ingress streams POST bodies using chunked transfer encoding.
// Express consumes those chunks; the preview serializes the parsed body again.
// That new fixed-length body must not retain the incoming transfer framing.
patch("proxy.js", "if (!hasParsedBodyValue(req.body) && originalContentLength <= 0) return null;",
  "if (!hasParsedBodyValue(req.body) && originalContentLength <= 0 && !req.headers?.['transfer-encoding']) return null;");
patch("proxy.js", "proxyReq.setHeader('content-length', String(body.length));",
  "proxyReq.removeHeader('transfer-encoding');\n    proxyReq.setHeader('content-length', String(body.length));");
// LAN authentication is scoped to one app activation. init recreates this
// private runtime directory on restart, invalidating cookies and paired clients
// together while retaining all persistent UI settings and conversation data.
patch("../../index.js", "const REMOTE_CLIENTS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'remote-clients.json');",
  "const REMOTE_CLIENTS_FILE_PATH = path.join(process.env.OPENCHAMBER_AUTH_DIR || OPENCHAMBER_DATA_DIR, 'remote-clients.json');");
patch("../../index.js", "const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'client-pairing-sessions.json');",
  "const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(process.env.OPENCHAMBER_AUTH_DIR || OPENCHAMBER_DATA_DIR, 'client-pairing-sessions.json');");
patch("../ui-auth/ui-auth.js", "const JWT_SECRET_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jwt-secret');",
  "const JWT_SECRET_FILE = path.join(process.env.OPENCHAMBER_AUTH_DIR || OPENCHAMBER_DATA_DIR, 'jwt-secret');");
console.log("OpenChamber uses the app-owned backend and process-private authentication");
