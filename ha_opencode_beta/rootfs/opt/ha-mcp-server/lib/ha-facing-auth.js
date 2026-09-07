import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, lstatSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";

export const SCOPE = "ha:read";
export const ACCESS_SECONDS = 900;
const REFRESH_MS = 30 * 86400000;
export const opaque = () => randomBytes(32).toString("base64url");
export const digest = (value) => createHash("sha256").update(value).digest("base64url");
export function equal(a, b) {
  return typeof a === "string" && typeof b === "string" && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
export function requireThat(condition, status = 400, code = "invalid_request") {
  if (!condition) throw new HttpError(status, code);
}

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 500, "unsafe_state_path");
  if (process.platform !== "win32") {
    requireThat(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 500, "unsafe_state_permissions");
  }
}

// Linux abstract sockets are released by the kernel even after SIGKILL. A
// persistent lock file would strand authentication after an unclean shutdown.
export async function acquireStateLock(directory) {
  requireThat(process.platform === "linux", 500, "linux_required");
  const lock = createServer((socket) => socket.destroy());
  await new Promise((resolveLock, reject) => {
    lock.once("error", reject);
    lock.listen(`\0ha-facing-mcp-${digest(resolve(directory))}`, () => {
      lock.removeListener("error", reject); resolveLock();
    });
  });
  return () => new Promise((done) => lock.close(done));
}

// Synchronous, atomic updates keep code and refresh exchanges serialized.
// The launcher holds acquireStateLock for the full store lifetime.
export function openState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const path = join(directory, "oauth.json");
  let data;
  try {
    privatePath(path);
    data = JSON.parse(readFileSync(path, "utf8"));
    requireThat(data.version === 1 && Array.isArray(data.grants), 500, "invalid_state");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = { version: 1, client: null, grants: [] };
  }
  return {
    data,
    healthy: true,
    save() {
      requireThat(this.healthy, 503, "state_unavailable");
      try {
        const temp = `${path}.${opaque()}.tmp`;
        const fd = openSync(temp, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, path);
        if (process.platform !== "win32") {
          const dir = openSync(directory, constants.O_RDONLY);
          try { fsyncSync(dir); } finally { closeSync(dir); }
        }
      } catch (error) { this.healthy = false; throw error; }
    },
    close() {},
  };
}

export function createIngressSecret(path) {
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const secret = opaque();
  const temp = `${path}.${opaque()}.tmp`;
  writeFileSync(temp, secret, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
  return secret;
}

export function verifyAdministrator(token, userId) {
  if (!/^[a-f0-9]{32}$/.test(userId)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new WebSocket("ws://supervisor/core/websocket", { maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.terminate(); resolve(value);
    };
    const timer = setTimeout(() => finish(false), 5000);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (message.type === "auth_ok") socket.send(JSON.stringify({ id: 1, type: "config/auth/list" }));
        else if (message.type === "auth_invalid") finish(false);
        else if (message.type === "result" && message.id === 1) {
          const user = message.success && Array.isArray(message.result) && message.result.find((item) => item.id === userId);
          finish(Boolean(user && user.is_active === true && user.system_generated === false &&
            (user.is_owner === true || user.group_ids?.includes("system-admin"))));
        }
      } catch { finish(false); }
    });
  });
}

export function createAuthorization(state, resource, { now = Date.now } = {}) {
  const codes = new Map();
  const forms = new Map();
  const prune = (map) => { for (const [key, value] of map) if (value.expires <= now()) map.delete(key); };
  function form(user, origin, path, action, payload = {}) {
    prune(forms);
    requireThat(forms.size < 64, 429, "too_many_requests");
    const nonce = opaque();
    forms.set(digest(nonce), { user, origin, path, action, payload, expires: now() + 300000 });
    return nonce;
  }
  function consumeForm(nonce, user, origin, path, action) {
    prune(forms);
    const key = digest(nonce || "");
    const item = forms.get(key);
    requireThat(item && item.user === user && item.origin === origin && item.path === path && item.action === action, 403, "invalid_csrf");
    forms.delete(key);
    return item.payload;
  }
  function validateRedirect(uri) {
    let url;
    try { url = new URL(uri); } catch { throw new HttpError(400, "invalid_redirect_uri"); }
    // The canonical callback is also a CSP form-action source. Reject CSP
    // delimiters rather than allowing a registered hostname to inject policy.
    requireThat(url.protocol === "https:" && !/[;'\s]/.test(url.href) && !url.username && !url.password && !url.hash && !url.search &&
      (url.href === "https://my.home-assistant.io/redirect/oauth" || url.pathname === "/auth/external/callback"), 400, "invalid_redirect_uri");
    return uri;
  }
  function provision(redirect, authorizationUrl) {
    requireThat(state.healthy !== false, 503, "state_unavailable");
    validateRedirect(redirect);
    const secret = opaque();
    state.data.client = { id: opaque(), secretHash: digest(secret), redirect, authorizationUrl };
    state.data.grants = [];
    codes.clear(); forms.clear(); state.save();
    return { client_id: state.data.client.id, client_secret: secret };
  }
  function authenticate(params) {
    requireThat(state.healthy !== false, 503, "state_unavailable");
    const client = state.data.client;
    requireThat(client && params.client_id === client.id && equal(digest(params.client_secret || ""), client.secretHash), 401, "invalid_client");
    return client;
  }
  function authorizationRequest(params) {
    const client = state.data.client;
    requireThat(client && params.client_id === client.id && params.redirect_uri === client.redirect);
    requireThat(params.response_type === "code" && params.scope === SCOPE && typeof params.state === "string" && params.state.length > 0 && params.state.length <= 4096);
    requireThat(!params.resource || params.resource === resource, 400, "invalid_target");
    if (params.code_challenge !== undefined || params.code_challenge_method !== undefined) {
      requireThat(params.code_challenge_method === "S256" && /^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || ""));
    }
    return { clientId: client.id, redirect: client.redirect, state: params.state, challenge: params.code_challenge };
  }
  function approve(request, user) {
    requireThat(state.healthy !== false, 503, "state_unavailable");
    requireThat(request.clientId === state.data.client?.id);
    prune(codes);
    requireThat(codes.size < 64, 429, "too_many_requests");
    const code = opaque();
    codes.set(digest(code), { ...request, user, expires: now() + 60000 });
    const redirect = new URL(request.redirect);
    redirect.searchParams.set("code", code); redirect.searchParams.set("state", request.state);
    return redirect.href;
  }
  function issue(grant) {
    const access = opaque(); const refresh = opaque();
    grant.accessHash = digest(access); grant.refreshHash = digest(refresh);
    grant.accessExpires = now() + ACCESS_SECONDS * 1000;
    state.save();
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_SECONDS, scope: SCOPE };
  }
  function exchange(params) {
    const client = authenticate(params);
    requireThat(!params.resource || params.resource === resource, 400, "invalid_target");
    requireThat(!params.scope || params.scope === SCOPE, 400, "invalid_scope");
    state.data.grants = state.data.grants.filter((grant) => grant.expires > now());
    if (params.grant_type === "authorization_code") {
      prune(codes);
      const key = digest(params.code || ""); const code = codes.get(key);
      requireThat(code && code.clientId === client.id, 400, "invalid_grant");
      codes.delete(key); // A failed exchange consumes the code too.
      requireThat(params.redirect_uri === code.redirect, 400, "invalid_grant");
      if (code.challenge) requireThat(/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier || "") && equal(digest(params.code_verifier), code.challenge), 400, "invalid_grant");
      else requireThat(params.code_verifier === undefined, 400, "invalid_grant");
      requireThat(state.data.grants.length < 32, 429, "too_many_grants");
      const grant = { id: opaque(), clientId: client.id, user: code.user, expires: now() + REFRESH_MS };
      state.data.grants.push(grant);
      return issue(grant);
    }
    requireThat(params.grant_type === "refresh_token", 400, "unsupported_grant_type");
    const hash = digest(params.refresh_token || "");
    const grant = state.data.grants.find((item) => item.clientId === client.id && equal(item.refreshHash, hash));
    requireThat(grant, 400, "invalid_grant");
    return issue(grant);
  }
  function verify(token) {
    if (state.healthy === false) return null;
    const hash = digest(token || "");
    return state.data.grants.find((grant) => grant.clientId === state.data.client?.id && grant.expires > now() && grant.accessExpires > now() && equal(grant.accessHash, hash)) || null;
  }
  function revoke(params) {
    authenticate(params);
    const hash = digest(params.token || "");
    state.data.grants = state.data.grants.filter((grant) => !equal(grant.accessHash, hash) && !equal(grant.refreshHash, hash));
    state.save();
  }
  return { form, consumeForm, provision, authenticate, authorizationRequest, approve, exchange, verify, revoke };
}
