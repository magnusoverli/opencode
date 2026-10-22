// Exercise the real patched upstream runtime, including its injected-env setter.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const source = process.env.OPENCHAMBER_TEST_SOURCE || "/opt/openchamber-preview";
const load = (file) => import(pathToFileURL(path.join(source, "packages/web/server/lib/opencode", file)));
const { createHmrStateRuntime } = await load("hmr-state-runtime.js");
const { createOpenCodeAuthStateRuntime } = await load("auth-state-runtime.js");

test("managed backend uses the process-private credential without exporting it to child environments", async (t) => {
  const key = Symbol.for("ha.openchamber.credential");
  const previous = globalThis[key];
  t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
  globalThis[key] = "fixture-private-backend";
  const env = { OPENCODE_PASSWORD: "must-not-use-environment" };
  const hmr = createHmrStateRuntime({ globalThisLike: {}, os, processLike: { env }, stateKey: Symbol() });
  const state = hmr.getOrCreateHmrState();
  hmr.ensureUserProvidedOpenCodePassword(state);
  assert.equal(hmr.getUserProvidedOpenCodePassword(state), "fixture-private-backend");
  let password = null, authSource = null;
  const runtime = createOpenCodeAuthStateRuntime({
    crypto, process: { env },
    getAuthPassword: () => password, setAuthPassword: (value) => { password = value; },
    getAuthSource: () => authSource, setAuthSource: (value) => { authSource = value; },
    getUserProvidedPassword: () => hmr.getUserProvidedOpenCodePassword(state),
    syncToHmrState: () => {},
  });
  await runtime.ensureLocalOpenCodeServerPassword();
  assert.equal(password, "fixture-private-backend");
  assert.deepEqual(runtime.getOpenCodeAuthHeaders(), {
    Authorization: `Basic ${Buffer.from("opencode:fixture-private-backend").toString("base64")}`,
  });
  assert.deepEqual(env, { OPENCODE_PASSWORD: "must-not-use-environment" });
  delete globalThis[key];
  const missing = hmr.getOrCreateHmrState();
  missing.userProvidedOpenCodePassword = undefined;
  hmr.ensureUserProvidedOpenCodePassword(missing);
  assert.equal(hmr.getUserProvidedOpenCodePassword(missing), null, "never fall back to environment credentials");
});
