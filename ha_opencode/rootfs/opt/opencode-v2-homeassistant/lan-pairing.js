/** LAN-only authority. Backend password-signed sessions lack individual
 * revocation, so never distribute or accept them at this boundary. Native
 * OpenCode expects POST /api/pair and GET /auth/connect/{code} -> {token}, then
 * Basic opencode:<token>. Browser cookies terminate here, not at the backend.
 */
import { createHash, randomBytes } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
export const LAN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function createLanPairing({ now = Date.now, onRevoke = () => {} } = {}) {
  const codes = new Map();
  const sessions = new Map();
  const tokens = new Map();
  function revoke(id) {
    const session = sessions.get(id);
    if (!session) return false;
    clearTimeout(session.timer);
    tokens.delete(session.digest);
    sessions.delete(id);
    onRevoke(id);
    return true;
  }
  function prune() {
    for (const [code, entry] of codes) if (entry.expires <= now()) codes.delete(code);
    for (const [id, session] of sessions) if (session.expires <= now()) revoke(id);
  }
  function schedule(session) {
    const remaining = session.expires - now();
    if (remaining <= 0) { revoke(session.id); return; }
    session.timer = setTimeout(() => schedule(session), Math.min(remaining, 2147483647));
    session.timer.unref?.();
  }
  function issue(origin) {
    prune();
    if (codes.size >= 100 || sessions.size >= 1000) return null;
    const code = randomBytes(16).toString("base64url");
    codes.set(digest(code), { origin, expires: now() + 300000 });
    return { code, expires_in: 300 };
  }
  function consume(code, origin) {
    prune();
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(code)) return null;
    const key = digest(code);
    const entry = codes.get(key);
    if (!entry || entry.origin !== origin) return null;
    codes.delete(key);
    if (entry.expires <= now() || sessions.size >= 1000) return null;
    const token = randomBytes(32).toString("base64url");
    const session = { id: randomBytes(12).toString("hex"), origin, digest: digest(token), created: now(), expires: now() + LAN_SESSION_TTL_MS };
    sessions.set(session.id, session); tokens.set(session.digest, session.id);
    schedule(session);
    return { token, id: session.id };
  }
  function authenticate(token, cookieOrigin) {
    prune();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const id = tokens.get(digest(token));
    if (cookieOrigin !== undefined && sessions.get(id)?.origin !== cookieOrigin) return null;
    return id ?? null;
  }
  return { issue, consume, authenticate, revoke,
    list() { prune(); return [...sessions.values()].map(({ id, created, expires }) => ({ id, created, expires })); },
    close() { for (const id of [...sessions.keys()]) revoke(id); codes.clear(); },
  };
}
