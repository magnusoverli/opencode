import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js";
import puppeteer from "puppeteer-core";
import { openState, acquireStateLock, createAuthorization, createIngressSecret, digest, SCOPE } from "../lib/ha-facing-auth.js";
import { backendEnvironment, openBackend, READ_TOOLS, createReadServer, MAX_RESULT_BYTES, CALL_TIMEOUT } from "../lib/ha-facing-backend.js";
import { startHaFacing } from "../lib/ha-facing-http.js";
import { launch } from "../ha-facing-mcp.js";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const RESOURCE = "http://addon-test:8766/mcp";
const ORIGIN = "https://ha.example";
const BASE = "/api/hassio_ingress/session-token/ha-mcp/";
const CALLBACK = "https://my.home-assistant.io/redirect/oauth";
const USER = "a".repeat(32);
const IPC_SECRET = "i".repeat(43);

// Node fetch ignores Host overrides on some releases. Exercise the actual
// virtual-host boundary, including the SDK, using a small buffered test fetch.
function coreFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: Object.fromEntries(new Headers(options.headers)), signal: options.signal }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject); req.end(options.body);
  });
}

function stateFile() {
  const directory = mkdtempSync(join(tmpdir(), "ha-facing-"));
  const state = openState(directory);
  cleanup.push(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  return { state, directory };
}
function fakeBackend() {
  return {
    listTools: vi.fn(async () => ({ tools: [...READ_TOOLS, "call_service", "render_template", "write_config_safe"].map((name) => ({ name, inputSchema: { type: "object" } })) })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "read result" }] })),
    close: vi.fn(async () => {}),
  };
}
function formNonce(text) { return /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(text)[1]; }
async function fixture() {
  const { state, directory } = stateFile();
  const backends = [];
  const admin = vi.fn(async (id) => id === USER);
  const service = await startHaFacing({ state, resourceUrl: RESOURCE, ingressSecret: IPC_SECRET,
    verifyAdmin: admin, backendFactory: async () => { const backend = fakeBackend(); backends.push(backend); return backend; },
    coreHost: "127.0.0.1", corePort: 0, ipcPort: 0,
  });
  cleanup.push(() => service.close());
  const core = (path, options = {}) => coreFetch(`http://127.0.0.1:${service.corePort}${path}`, {
    ...options, redirect: "manual", headers: { host: "addon-test:8766", ...options.headers },
  });
  const ipc = (path = "/ha-mcp/", options = {}) => fetch(`http://127.0.0.1:${service.ipcPort}${path}`, {
    ...options, redirect: "manual", headers: {
      "x-ha-mcp-ingress-secret": IPC_SECRET, "x-ha-mcp-user-id": USER,
      "x-ha-mcp-external-origin": ORIGIN,
      "x-ha-mcp-external-path": BASE + (path.startsWith("/ha-mcp/authorize") ? "authorize" : ""),
      ...options.headers,
    },
  });
  const post = (values) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams(values).toString() });
  const tokenPost = (values) => ({ ...post(values), headers: { "content-type": "application/x-www-form-urlencoded" } });
  async function provision() {
    const page = await ipc();
    const nonce = formNonce(await page.text());
    const response = await ipc("/ha-mcp/", post({ csrf: nonce, redirect_uri: CALLBACK, action: "provision", approved: "yes" }));
    expect(response.status).toBe(200);
    const content = await response.text();
    const values = [...content.matchAll(/<dd><code>([^<]+)<\/code><\/dd>/g)].map((match) => match[1]);
    return { client_id: values[0], client_secret: values[1] };
  }
  async function authorize(client, extra = {}, decision = "approve") {
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", scope: SCOPE, state: "opaque-state", ...extra });
    const response = await ipc(`/ha-mcp/authorize?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("content-security-policy")).toContain(`form-action 'self' ${CALLBACK};`);
    const nonce = formNonce(await response.text());
    const consent = await ipc("/ha-mcp/authorize", post({ csrf: nonce, decision }));
    expect(consent.status).toBe(303);
    expect(consent.headers.get("referrer-policy")).toBe("no-referrer");
    return new URL(consent.headers.get("location"));
  }
  async function tokens(client, extra = {}) {
    const redirect = await authorize(client, extra.code_challenge ? { code_challenge: extra.code_challenge, code_challenge_method: "S256" } : {});
    const response = await core("/token", tokenPost({ ...client, grant_type: "authorization_code", code: redirect.searchParams.get("code"), redirect_uri: CALLBACK, ...extra }));
    expect(response.status).toBe(200);
    return response.json();
  }
  return { state, directory, service, backends, admin, core, ipc, post, tokenPost, provision, authorize, tokens };
}

describe("HA-facing OAuth HTTP boundary", () => {
  it("defaults off without inspecting credentials or starting a listener", async () => {
    expect(await launch({})).toBeNull();
    expect(await launch({ HA_MCP_ENABLED: "false" })).toBeNull();
  });
  it("refuses forged ingress identity and fails closed on administrator lookup", async () => {
    const f = await fixture();
    expect((await f.ipc("/ha-mcp/", { headers: { "x-ha-mcp-ingress-secret": "wrong" } })).status).toBe(403);
    expect(f.admin).not.toHaveBeenCalled();
    expect((await f.ipc("/ha-mcp/", { headers: { "x-ha-mcp-user-id": "b".repeat(32) } })).status).toBe(403);
    f.admin.mockRejectedValueOnce(new Error("Core unavailable"));
    expect((await f.ipc()).status).toBe(500);
    expect((await f.ipc("/ha-mcp/", { headers: { "x-ha-mcp-external-origin": "http://ha.example" } })).status).toBe(403);
    expect((await f.core("/ha-mcp/" )).status).toBe(404);
  });
  it("requires explicit CSRF-bound setup and never persists the client secret", async () => {
    const f = await fixture();
    expect((await (await f.ipc("/ha-mcp/status")).json()).ready).toBe(false);
    const nonce = formNonce(await (await f.ipc()).text());
    const values = { csrf: nonce, redirect_uri: CALLBACK, action: "provision", approved: "yes" };
    const crossOrigin = f.post(values); crossOrigin.headers.origin = "https://evil.example";
    expect((await f.ipc("/ha-mcp/", crossOrigin)).status).toBe(403);
    crossOrigin.headers.origin = "null";
    expect((await f.ipc("/ha-mcp/", crossOrigin)).status).toBe(403);
    expect((await f.ipc("/ha-mcp/", f.post({ ...values, approved: "no" }))).status).toBe(400);
    expect((await f.ipc("/ha-mcp/", f.post(values))).status).toBe(403);
    const client = await f.provision();
    expect(client.client_secret).toHaveLength(43);
    expect(readFileSync(join(f.directory, "oauth.json"), "utf8")).not.toContain(client.client_secret);
    const page = await f.ipc();
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await page.text()).not.toContain(client.client_secret);
    expect((await (await f.ipc("/ha-mcp/status")).json()).ready).toBe(true);
  });
  it("advertises real metadata and only provisioned client_secret_post, not DCR or public clients", async () => {
    const f = await fixture(); await f.provision();
    const unauth = await f.core("/mcp");
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    const metadata = await (await f.core("/.well-known/oauth-authorization-server")).json();
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}${BASE}authorize`);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["client_secret_post"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.registration_endpoint).toBeUndefined();
    expect((await f.core("/mcp", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await f.core("/mcp", { headers: { host: "evil.example" } })).status).toBe(403);
  });
  it("supports HA non-PKCE confidential exchange, single-use codes, rotating refresh and revocation", async () => {
    const f = await fixture(); const client = await f.provision();
    const target = await f.authorize(client);
    expect(target.searchParams.get("state")).toBe("opaque-state");
    const params = { ...client, grant_type: "authorization_code", code: target.searchParams.get("code"), redirect_uri: CALLBACK };
    expect((await f.core("/token", f.tokenPost({ ...params, client_secret: "wrong" }))).status).toBe(401);
    const result = await f.core("/token", f.tokenPost(params));
    const tokens = await result.json(); expect(tokens.expires_in).toBe(900);
    expect((await f.core("/token", f.tokenPost(params))).status).toBe(400);
    const refresh = { ...client, grant_type: "refresh_token", refresh_token: tokens.refresh_token };
    const rotated = await (await f.core("/token", f.tokenPost(refresh))).json();
    expect(rotated.access_token).not.toBe(tokens.access_token);
    expect((await f.core("/token", f.tokenPost(refresh))).status).toBe(400);
    expect((await f.core("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await f.core("/revoke", f.tokenPost({ ...client, token: rotated.refresh_token }))).status).toBe(200);
    expect((await f.core("/mcp", { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401);
  });
  it("enforces PKCE S256 when supplied and rejects redirect, scope, resource and parameter ambiguity", async () => {
    const f = await fixture(); const client = await f.provision();
    const verifier = "v".repeat(43);
    const redirect = await f.authorize(client, { code_challenge: digest(verifier), code_challenge_method: "S256" });
    const params = { ...client, grant_type: "authorization_code", code: redirect.searchParams.get("code"), redirect_uri: CALLBACK };
    expect((await f.core("/token", f.tokenPost(params))).status).toBe(400);
    const valid = await f.tokens(client, { code_challenge: digest(verifier), code_verifier: verifier });
    expect(valid.access_token).toHaveLength(43);
    const base = { client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", scope: SCOPE, state: "s" };
    for (const extra of [{ redirect_uri: `${CALLBACK}/` }, { scope: "ha:write" }, { resource: "http://other/mcp" }, { code_challenge: "x", code_challenge_method: "plain" }]) {
      const response = await f.ipc(`/ha-mcp/authorize?${new URLSearchParams({ ...base, ...extra })}`);
      expect(response.status).toBe(400); expect(response.headers.get("location")).toBeNull();
    }
    expect((await f.ipc(`/ha-mcp/authorize?${new URLSearchParams(base)}&client_id=other`)).status).toBe(400);
    const denied = await f.authorize(client, {}, "deny");
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.has("code")).toBe(false);
  });
  it("replays identical SDK initialization without renegotiating or relaxing session authentication", async () => {
    const f = await fixture(); const credentials = await f.provision(); const tokens = await f.tokens(credentials);
    let initial;
    const client = new Client({ name: "ha-repeat", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.service.corePort}/mcp`), {
      requestInit: { headers: { host: "addon-test:8766", authorization: `Bearer ${tokens.access_token}` } },
      fetch: async (url, options) => {
        const request = options.body && JSON.parse(options.body);
        const response = await coreFetch(url, options);
        if (request?.method === "initialize" && !initial) initial = { params: request.params, result: (await response.clone().json()).result };
        return response;
      },
    });
    await client.connect(transport); cleanup.push(() => client.close());
    const sessionId = transport.sessionId;
    const repeated = await client.request({ method: "initialize", params: initial.params }, InitializeResultSchema);
    expect(repeated).toEqual(initial.result);
    await client.notification({ method: "notifications/initialized" });
    expect(transport.sessionId).toBe(sessionId);
    expect(f.backends).toHaveLength(1);
    expect(f.backends[0].listTools).toHaveBeenCalledOnce();
    for (const changes of [{ protocolVersion: "changed" }, { clientInfo: { name: "different", version: "1" } }, { capabilities: { roots: { listChanged: true } } }]) {
      await expect(client.request({ method: "initialize", params: { ...initial.params, ...changes } }, InitializeResultSchema)).rejects.toThrow("initialize_mismatch");
    }
    const repeat = { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "mcp-session-id": sessionId,
      "mcp-protocol-version": initial.result.protocolVersion, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "repeat", method: "initialize", params: initial.params }) };
    expect((await f.core("/mcp", { ...repeat, headers: { ...repeat.headers, "mcp-protocol-version": "wrong" } })).status).toBe(400);
    expect((await f.core("/mcp", { ...repeat, headers: { ...repeat.headers, authorization: "Bearer invalid" } })).status).toBe(401);
    const other = await f.tokens(credentials);
    expect((await f.core("/mcp", { ...repeat, headers: { ...repeat.headers, authorization: `Bearer ${other.access_token}` } })).status).toBe(404);
    expect((await f.core("/mcp", { ...repeat, body: JSON.stringify({ ...JSON.parse(repeat.body), jsonrpc: "1.0" }) })).status).toBe(400);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOLS);
    expect((await client.callTool({ name: "get_states", arguments: {} })).isError).not.toBe(true);
  });
  it.skipIf(!process.env.HA_MCP_BROWSER_EXECUTABLE)("submits real browser forms with authentic Origin and follows the cross-origin OAuth callback", async () => {
    const f = await fixture();
    const browser = await puppeteer.launch({ executablePath: process.env.HA_MCP_BROWSER_EXECUTABLE, headless: true });
    cleanup.push(async () => {
      // Some system Chromium builds keep a background process after closing
      // the last window. Bound cleanup of this test's own child process.
      const timer = setTimeout(() => browser.process()?.kill("SIGKILL"), 3000);
      try { await browser.close(); } finally { clearTimeout(timer); }
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(5000);
    const posts = []; const callbacks = []; const failures = [];
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      (async () => {
        const url = new URL(request.url());
        if (url.origin === ORIGIN && url.pathname.startsWith(BASE)) {
          const headers = request.headers();
          if (request.method() === "POST") posts.push(headers.origin);
          // Simulate only the authenticated Ingress hop. In particular, never
          // invent or replace the browser's Origin (including Origin:null).
          const response = await f.ipc(`/ha-mcp/${url.pathname.slice(BASE.length)}${url.search}`, {
            method: request.method(), body: request.postData(), headers: {
              ...(headers.origin ? { origin: headers.origin } : {}),
              ...(headers["content-type"] ? { "content-type": headers["content-type"] } : {}),
            },
          });
          await request.respond({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
        } else if (url.origin === new URL(CALLBACK).origin && url.pathname === new URL(CALLBACK).pathname) {
          callbacks.push({ url, referer: request.headers().referer });
          await request.respond({ status: 200, contentType: "text/html", body: "<p>OAuth callback reached</p>" });
        } else await request.abort();
      })().catch((error) => { failures.push(error); void request.abort().catch(() => {}); });
    });
    await page.goto(`${ORIGIN}${BASE}`);
    await page.click('input[name="approved"]');
    await Promise.all([page.waitForNavigation(), page.click('button[name="action"]')]);
    const values = await page.$$eval("dd code", (nodes) => nodes.map((node) => node.textContent));
    expect(values).toHaveLength(2);
    const client = { client_id: values[0], client_secret: values[1] };
    const authorizeUrl = `${ORIGIN}${BASE}authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", scope: SCOPE, state: "browser-state" })}`;
    for (const decision of ["approve", "deny"]) {
      await page.goto(authorizeUrl);
      await Promise.all([page.waitForNavigation(), page.click(`button[value="${decision}"]`)]);
      expect(await page.content()).toContain("OAuth callback reached");
    }
    expect(failures).toEqual([]);
    expect(posts).toEqual([ORIGIN, ORIGIN, ORIGIN]);
    expect(callbacks).toHaveLength(2);
    expect(callbacks.every((callback) => callback.referer === undefined)).toBe(true);
    expect(callbacks[0].url.searchParams.get("state")).toBe("browser-state");
    expect(callbacks[1].url.searchParams.get("error")).toBe("access_denied");
    const exchange = await f.core("/token", f.tokenPost({ ...client, grant_type: "authorization_code", redirect_uri: CALLBACK, code: callbacks[0].url.searchParams.get("code") }));
    expect(exchange.status).toBe(200);
  }, 20000);
  it("isolates SDK sessions, filters list AND execution, and revokes live sessions on replacement", async () => {
    const f = await fixture(); const credentials = await f.provision();
    const first = await f.tokens(credentials); const second = await f.tokens(credentials);
    async function connect(token) {
      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.service.corePort}/mcp`), {
        fetch: coreFetch,
        requestInit: { headers: { host: "addon-test:8766", authorization: `Bearer ${token}` } },
      });
      await client.connect(transport); cleanup.push(() => client.close());
      return { client, transport };
    }
    const a = await connect(first.access_token); const b = await connect(second.access_token);
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOLS);
    await expect(a.client.callTool({ name: "call_service", arguments: {} })).rejects.toThrow("Tool not permitted");
    await expect(a.client.callTool({ name: "get_states", arguments: { entity_id: "../../config" } })).rejects.toThrow("Invalid entity identifier");
    expect(f.backends[0].callTool).not.toHaveBeenCalled();
    await a.client.callTool({ name: "get_states", arguments: {} });
    expect(f.backends[0].callTool).toHaveBeenCalledOnce();
    expect(f.backends[1].callTool).not.toHaveBeenCalled();
    const stolen = await f.core("/mcp", { method: "POST", headers: {
      authorization: `Bearer ${second.access_token}`, "mcp-session-id": a.transport.sessionId, "content-type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) });
    expect(stolen.status).toBe(404);
    await f.provision();
    expect(f.backends.every((backend) => backend.close.mock.calls.length > 0)).toBe(true);
    expect((await f.core("/mcp", { headers: { authorization: `Bearer ${first.access_token}` } })).status).toBe(401);
  });
});

describe("HA-facing local bounds and persistence", () => {
  it("fails closed after a persistence failure rather than serving uncommitted credentials", () => {
    const { state, directory } = stateFile();
    const auth = createAuthorization(state, RESOURCE);
    const client = auth.provision(CALLBACK, `${ORIGIN}${BASE}authorize`);
    rmSync(directory, { recursive: true, force: true });
    expect(() => auth.provision(CALLBACK, `${ORIGIN}${BASE}authorize`)).toThrow();
    expect(state.healthy).toBe(false);
    expect(auth.verify("unissued-token")).toBeNull();
    expect(() => auth.authenticate(client)).toThrow("state_unavailable");
  });
  it("persists grants across restart and expires codes/tokens", () => {
    const { state, directory } = stateFile();
    let clock = 100000;
    const auth = createAuthorization(state, RESOURCE, { now: () => clock });
    const credentials = auth.provision(CALLBACK, `${ORIGIN}${BASE}authorize`);
    const request = auth.authorizationRequest({ client_id: credentials.client_id, redirect_uri: CALLBACK, response_type: "code", scope: SCOPE, state: "s" });
    const oldCode = new URL(auth.approve(request, USER)).searchParams.get("code");
    clock += 60001;
    expect(() => auth.exchange({ ...credentials, grant_type: "authorization_code", code: oldCode, redirect_uri: CALLBACK })).toThrow("invalid_grant");
    const code = new URL(auth.approve(request, USER)).searchParams.get("code");
    const tokens = auth.exchange({ ...credentials, grant_type: "authorization_code", code, redirect_uri: CALLBACK });
    const restored = { data: JSON.parse(readFileSync(join(directory, "oauth.json"), "utf8")), save() {} };
    expect(createAuthorization(restored, RESOURCE, { now: () => clock }).verify(tokens.access_token)).toBeTruthy();
    clock += 900001;
    expect(auth.verify(tokens.access_token)).toBeNull();
    clock += 31 * 86400000;
    expect(() => auth.exchange({ ...credentials, grant_type: "refresh_token", refresh_token: tokens.refresh_token })).toThrow("invalid_grant");
    if (process.platform !== "win32") expect(statSync(join(directory, "oauth.json")).mode & 0o077).toBe(0);
  });
  it("rotates private ingress secrets and rejects symlink state directories", () => {
    const { directory } = stateFile();
    const secret = join(directory, "ipc", "secret");
    expect(createIngressSecret(secret)).not.toBe(createIngressSecret(secret));
    if (process.platform !== "win32") {
      expect(statSync(secret).mode & 0o077).toBe(0);
      const link = join(directory, "link"); symlinkSync(directory, link);
      expect(() => openState(link)).toThrow("unsafe_state_path");
    }
  });
  it("does not inherit optional credentials, bridges, profiles or Node preload options", () => {
    const env = backendEnvironment("supervisor-test");
    expect(env.OPENCODE_MCP_TOOL_PROFILE).toBe("compact");
    expect(env.OPENCODE_NATIVE_HA_MCP_ENABLED).toBe("false");
    for (const key of ["HA_ACCESS_TOKEN", "NODE_OPTIONS", "OPENCODE_CONFIG_CONTENT", "HA_MCP_ENABLED"]) expect(env[key]).toBeUndefined();
  });
  it.skipIf(process.platform !== "linux")("exclusively locks runtime state without a stale disk lock", async () => {
    const { directory } = stateFile();
    const unlock = await acquireStateLock(directory);
    try { await expect(acquireStateLock(directory)).rejects.toThrow(); } finally { await unlock(); }
    await (await acquireStateLock(directory))();
  });
  it.skipIf(process.platform !== "linux")("handshakes the real stdio server with the fixed Linux compact environment", async () => {
    const backend = await openBackend("unit-test-not-a-real-token");
    try {
      const server = await createReadServer(backend);
      await server.close();
    } finally { await backend.close(); }
  });
  it("expires single-use CSRF forms and binds them to user, origin and ingress session", () => {
    const { state } = stateFile(); let clock = 100;
    const auth = createAuthorization(state, RESOURCE, { now: () => clock });
    expect(() => auth.provision("https://bad;policy/auth/external/callback", `${ORIGIN}${BASE}authorize`)).toThrow("invalid_redirect_uri");
    const nonce = auth.form(USER, ORIGIN, BASE, "setup");
    expect(() => auth.consumeForm(nonce, "other", ORIGIN, BASE, "setup")).toThrow("invalid_csrf");
    expect(() => auth.consumeForm(nonce, USER, "https://other", BASE, "setup")).toThrow("invalid_csrf");
    expect(() => auth.consumeForm(nonce, USER, ORIGIN, "/other/", "setup")).toThrow("invalid_csrf");
    clock += 300001;
    expect(() => auth.consumeForm(nonce, USER, ORIGIN, BASE, "setup")).toThrow("invalid_csrf");
  });
  it("terminates a timed-out SDK backend instead of accumulating unfinished calls", async () => {
    const upstream = new Server({ name: "slow", version: "1" }, { capabilities: { tools: {} } });
    upstream.setRequestHandler(ListToolsRequestSchema, fakeBackend().listTools);
    upstream.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
    const backend = new Client({ name: "backend", version: "1" });
    const [upClient, upServer] = InMemoryTransport.createLinkedPair();
    await upstream.connect(upServer); await backend.connect(upClient);
    const closed = vi.spyOn(backend, "close");
    const server = await createReadServer(backend, { timeout: 30 });
    const client = new Client({ name: "test", version: "1" });
    const [front, back] = InMemoryTransport.createLinkedPair();
    await server.connect(back); await client.connect(front);
    cleanup.push(async () => { await client.close(); await server.close(); await upstream.close(); });
    const result = await client.callTool({ name: "get_states", arguments: {} });
    expect(result.isError).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });
  it("bounds concurrent calls and suppresses oversized/error output", async () => {
    expect(CALL_TIMEOUT).toBeLessThanOrEqual(8000);
    const backend = fakeBackend();
    const server = await createReadServer(backend);
    const client = new Client({ name: "test", version: "1" });
    const [front, back] = InMemoryTransport.createLinkedPair();
    await server.connect(back); await client.connect(front);
    cleanup.push(async () => { await client.close(); await server.close(); });
    let finish;
    backend.callTool.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = client.callTool({ name: "get_states", arguments: {} });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(client.callTool({ name: "get_states", arguments: {} })).rejects.toThrow("One call per session");
    finish({ content: [{ type: "text", text: "ok" }] }); await first;
    expect(backend.callTool.mock.calls[0][2]).toMatchObject({ timeout: CALL_TIMEOUT, maxTotalTimeout: CALL_TIMEOUT });
    backend.close.mockImplementationOnce(() => new Promise(() => {}));
    backend.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(MAX_RESULT_BYTES + 1) }] });
    const result = await client.callTool({ name: "get_states", arguments: {} });
    expect(result.isError).toBe(true); expect(JSON.stringify(result).length).toBeLessThan(200);
    expect(backend.close).toHaveBeenCalledOnce();
    await expect(client.callTool({ name: "get_states", arguments: {} })).rejects.toThrow("Read-only backend closed");
  });
});
