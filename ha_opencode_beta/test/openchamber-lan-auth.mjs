// Actual pinned native auth implementation, isolated from any user settings.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const source = process.env.OPENCHAMBER_TEST_SOURCE || "/opt/openchamber-preview";
const { createRemoteClientAuthRuntime } = await import(pathToFileURL(path.join(source, "packages/web/server/lib/client-auth/remote-clients.js")));
const authModule = pathToFileURL(path.join(source, "packages/web/server/lib/ui-auth/ui-auth.js")).href;
const req = (body = {}, headers = {}) => ({ body, headers: { host: "code.example.test", "x-forwarded-proto": "https", ...headers }, secure: true, ip: "192.0.2.10", path: "/auth/session", method: "POST" });
function response() {
  return { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    type() { return this; }, send(value) { this.body = value; return this; },
  };
}

test("native UI login and paired credentials expire at app activation without changing persistent settings", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ha-native-lan-auth-"));
  const data = path.join(root, "persistent");
  const auth = path.join(root, "runtime-auth");
  await fs.mkdir(data);
  await fs.mkdir(auth, { mode: 0o700 });
  await fs.writeFile(path.join(data, "settings.json"), '{"fixture":"preserve"}');
  process.env.OPENCHAMBER_DATA_DIR = data;
  process.env.OPENCHAMBER_AUTH_DIR = auth;
  const controllers = [];
  try {
    const activate = async (generation, password) => {
      const { createUiAuth } = await import(`${authModule}?activation=${generation}`);
      const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(auth, "remote-clients.json") });
      const controller = createUiAuth({ password, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
      controllers.push(controller);
      return controller;
    };
    const first = await activate(1, "fixture-first-password");
    const wrong = response();
    await first.handleSessionCreate(req({ password: "wrong" }), wrong);
    assert.equal(wrong.statusCode, 401);
    const login = response();
    await first.handleSessionCreate(req({ password: "fixture-first-password", issueClientToken: true }), login);
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.authenticated, true);
    const cookie = login.headers["set-cookie"];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const oldCookie = cookie.split(";")[0];
    const oldBearer = `Bearer ${login.body.clientToken}`;
    assert.ok(login.body.clientToken);
    for (const headers of [{ cookie: oldCookie }, { authorization: oldBearer }]) {
      const status = response();
      await first.handleSessionStatus(req({}, headers), status);
      assert.equal(status.body.authenticated, true);
    }
    await fs.access(path.join(auth, "jwt-secret"));
    await assert.rejects(fs.access(path.join(data, "jwt-secret")));
    first.dispose();
    await fs.rm(auth, { recursive: true });
    await fs.mkdir(auth, { mode: 0o700 });
    const second = await activate(2, "fixture-rotated-password");
    for (const headers of [{ cookie: oldCookie }, { authorization: oldBearer }]) {
      const status = response();
      await second.handleSessionStatus(req({}, headers), status);
      assert.equal(status.statusCode, 401);
      assert.equal(status.body.authenticated, false);
    }
    const oldLogin = response();
    await second.handleSessionCreate(req({ password: "fixture-first-password" }), oldLogin);
    assert.equal(oldLogin.statusCode, 401);
    const newLogin = response();
    await second.handleSessionCreate(req({ password: "fixture-rotated-password" }), newLogin);
    assert.equal(newLogin.body.authenticated, true);
    assert.equal(await fs.readFile(path.join(data, "settings.json"), "utf8"), '{"fixture":"preserve"}');
  } finally {
    for (const controller of controllers) controller.dispose();
    delete process.env.OPENCHAMBER_DATA_DIR;
    delete process.env.OPENCHAMBER_AUTH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
