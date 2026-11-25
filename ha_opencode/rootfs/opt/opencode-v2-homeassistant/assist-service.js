import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AssistRpc } from "./assist-rpc.js";

export class AssistError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const requireValue = (value, status, code) => { if (!value) throw new AssistError(status, code); };
const ASSIST_PLUGIN_ID = "homeassistant.assist";
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_POLL_MS = 250;
const SAFE_ERROR_CODES = new Set([
  "assist_not_ready", "assist_plugin_failed", "assist_unavailable",
  "browser_requests_denied", "busy", "event_stream_failed",
  "generation_failed", "invalid_json", "invalid_request", "invalid_result",
  "json_required", "model_catalog_not_ready", "not_found",
  "request_too_large", "rpc.unavailable", "unauthorized", "unknown_request",
  "unavailable", "unsupported_model",
]);
const SAFE_ORIGINS = new Set(["ai_task", "non_satellite", "voice"]);

function safeErrorCode(candidate) {
  return typeof candidate === "string" && SAFE_ERROR_CODES.has(candidate)
    ? candidate : "internal_error";
}

function isServiceUnavailableError(error) {
  return typeof error === "object" && error !== null
    && error._tag === "ServiceUnavailableError";
}

function diagnosticContext(req) {
  const suppliedID = req.headers["x-ha-assist-request-id"];
  const suppliedOrigin = req.headers["x-ha-assist-origin"];
  return {
    requestID: typeof suppliedID === "string" && /^[A-Za-z0-9-]{1,64}$/.test(suppliedID)
      ? suppliedID : randomUUID(),
    origin: SAFE_ORIGINS.has(suppliedOrigin) ? suppliedOrigin : "unknown",
    started: performance.now(),
    startedAt: new Date().toISOString(),
    stage: "request_received",
    stageTimes: {},
    inFlight: 0,
  };
}

function safeError(error) {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name)
    ? error.name : "Error";
  const candidate = error instanceof AssistError ? error.message : (error?.type ?? error?.code);
  return {
    errorType: name,
    errorCode: safeErrorCode(candidate),
  };
}

function logDiagnostic(context, event, details = {}) {
  console.info(JSON.stringify({
    component: "ha_assist",
    event,
    timestamp: new Date().toISOString(),
    request_id: context.requestID,
    origin: context.origin,
    in_flight: context.inFlight,
    ...details,
  }));
}

async function timedStage(context, stage, operation) {
  context.stage = stage;
  const started = performance.now();
  logDiagnostic(context, "stage_start", { stage });
  try {
    const result = await operation();
    const elapsedMs = Math.round(performance.now() - started);
    context.stageTimes[stage] = (context.stageTimes[stage] ?? 0) + elapsedMs;
    logDiagnostic(context, "stage_complete", { stage, elapsed_ms: elapsedMs });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    context.stageTimes[stage] = (context.stageTimes[stage] ?? 0) + elapsedMs;
    logDiagnostic(context, "stage_error", {
      stage, elapsed_ms: elapsedMs, ...safeError(error),
    });
    throw error;
  }
}

function supportsAssistantRequest(model, tools) {
  return model.enabled !== false
    && model.capabilities?.input?.includes("text")
    && model.capabilities?.output?.includes("text")
    && (!tools.length || model.capabilities?.tools === true);
}

export async function readAssistJson(req, limit = 524288) {
  requireValue(req.headers["content-type"]?.split(";")[0] === "application/json", 415, "json_required");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= limit, 413, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new AssistError(400, "invalid_json"); }
}
export function assistJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

// Fixed-purpose facade: never forward caller paths, headers, sessions, file
// attachments, agents or permissions to the privileged OpenCode API.
export function createAssistService({
  client, authenticate, revokePairing, directory,
  readinessTimeoutMs = READINESS_TIMEOUT_MS,
  readinessPollMs = READINESS_POLL_MS,
}) {
  const active = new Map();
  const starting = new Set();
  let closing = false;
  const rpc = client.rpc(AssistRpc);
  // Use the server's managed workspace, just like the RPC plugin. /homeassistant
  // is a different OpenCode location and may not have the managed provider/model
  // configuration or private Assist agent. Tests may use an explicit location.
  const location = directory === undefined ? undefined : { directory };
  async function models() {
    const result = await client.model.list({ location });
    return result.data.filter((model) => model.enabled !== false && model.capabilities?.input?.includes("text") && model.capabilities?.output?.includes("text"))
      .map((model) => ({ id: model.id, providerID: model.providerID, name: model.name,
        tools: model.capabilities.tools === true }));
  }
  async function info() {
    return { version: 1, conversation: true, generate_data: true, streaming: true,
      attachments: false, generate_image: false, models: await models() };
  }
  async function waitForReadiness(body, context, signal) {
    const deadline = performance.now() + readinessTimeoutMs;
    const deadlineSignal = AbortSignal.timeout(readinessTimeoutMs);
    const readinessSignal = AbortSignal.any([signal, deadlineSignal]);
    let polls = 0;
    let assistStatus = "not_seen";
    let modelStatus = "not_seen";
    const readinessTimes = { plugin_list_ms: 0, model_list_ms: 0 };

    logDiagnostic(context, "readiness_wait_start", {
      stage: "readiness",
      timeout_ms: readinessTimeoutMs,
    });

    while (performance.now() < deadline && !deadlineSignal.aborted) {
      signal.throwIfAborted();
      polls++;
      try {
        if (assistStatus !== "active") {
          context.stage = "plugin_list";
          const pluginStarted = performance.now();
          const pluginList = await client.plugin.list(
            { location },
            { signal: readinessSignal },
          );
          readinessTimes.plugin_list_ms += Math.round(performance.now() - pluginStarted);
          const plugins = Array.isArray(pluginList?.data) ? pluginList.data : [];
          const assistPlugin = plugins.find((plugin) => plugin.id === ASSIST_PLUGIN_ID);
          assistStatus = assistPlugin?.state?.status ?? "not_seen";

          if (assistStatus === "failed") {
            logDiagnostic(context, "readiness_failed", {
              stage: "assist_plugin",
              polls,
              assist_status: assistStatus,
              readiness_times_ms: readinessTimes,
              elapsed_ms: Math.round(performance.now() - context.started),
            });
            throw new AssistError(503, "assist_plugin_failed");
          }
        }

        if (assistStatus === "active") {
          context.stage = "model_list";
          const modelStarted = performance.now();
          let catalog;
          try {
            catalog = await client.model.list(
              { location },
              { signal: readinessSignal },
            );
          } finally {
            readinessTimes.model_list_ms += Math.round(performance.now() - modelStarted);
          }
          const entries = Array.isArray(catalog?.data) ? catalog.data : [];
          const selected = entries.find((model) =>
            model.id === body.model?.id && model.providerID === body.model?.providerID);

          if (selected) {
            modelStatus = "found";
            if (!supportsAssistantRequest(selected, body.tools)) {
              logDiagnostic(context, "readiness_failed", {
                stage: "model_validation",
                polls,
                assist_status: assistStatus,
                model_status: "unsupported",
                readiness_times_ms: readinessTimes,
                elapsed_ms: Math.round(performance.now() - context.started),
              });
              throw new AssistError(400, "unsupported_model");
            }

            logDiagnostic(context, "readiness_complete", {
              polls,
              assist_status: assistStatus,
              model_status: modelStatus,
              readiness_times_ms: readinessTimes,
              elapsed_ms: Math.round(performance.now() - context.started),
            });
            context.stage = "readiness_complete";
            return selected;
          }

          modelStatus = "missing";
          // OpenCode 2.4.1's model.list endpoint only returns models from
          // available providers. An absent model does not prove it is invalid.
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (deadlineSignal.aborted) break;
        if (context.stage !== "model_list" || !isServiceUnavailableError(error)) {
          throw error;
        }
        modelStatus = "unavailable";
        logDiagnostic(context, "readiness_retry", {
          stage: "model_list",
          polls,
          error_code: "unavailable",
          elapsed_ms: Math.round(performance.now() - context.started),
        });
      }

      if (performance.now() >= deadline) break;
      try {
        await delay(readinessPollMs, undefined, { signal: readinessSignal });
      } catch (error) {
        if (signal.aborted) throw error;
        if (deadlineSignal.aborted) break;
        throw error;
      }
    }

    if (signal.aborted) signal.throwIfAborted();
    const code = assistStatus === "active" ? "model_catalog_not_ready" : "assist_not_ready";
    logDiagnostic(context, "readiness_timeout", {
      polls,
      assist_status: assistStatus,
      model_status: modelStatus,
      readiness_times_ms: readinessTimes,
      error_code: code,
      elapsed_ms: Math.round(performance.now() - context.started),
    });
    throw new AssistError(503, code);
  }

  async function cleanup(request) {
    if (request.closing) return request.closing;
    request.abort.abort();
    request.closing = (async () => {
      if (request.id) await rpc.release({ requestID: request.id }).catch(() => {});
      else await client.session.interrupt({ sessionID: request.sessionID }).catch(() => {});
      await client.session.remove({ sessionID: request.sessionID }).catch(() => {});
      active.delete(request.id);
    })();
    return request.closing;
  }
  async function revoke(owner) {
      for (const pending of starting) if (pending.owner === owner) pending.abort.abort();
      await Promise.all([...active.values()].filter((r) => r.owner === owner).map(cleanup));
  }
  return {
    info,
    revoke,
    async close() {
      closing = true;
      for (const pending of starting) pending.abort.abort();
      await Promise.all([...active.values()].map(cleanup));
    },
    async handle(req, res) {
      let request;
      let reservation;
      let diagnostics;
      let outcome = "pre_stream_failure";
      try {
        requireValue(!closing, 503, "unavailable");
        requireValue(!req.headers.origin, 403, "browser_requests_denied");
        requireValue(req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "authorization").length === 1, 401, "unauthorized");
        const owner = authenticate(req.headers.authorization);
        requireValue(owner, 401, "unauthorized");
        const path = req.url;
        if (req.method === "DELETE" && path === "/v1/pairing" && revokePairing) {
          revokePairing(owner);
          await revoke(owner);
          assistJson(res, 200, { revoked: true }); return;
        }
        if (req.method === "GET" && path === "/v1/info") {
          assistJson(res, 200, await info()); return;
        }
        const match = /^\/v1\/requests\/([a-f0-9-]{36})\/results$/.exec(path);
        if (req.method === "POST" && match) {
          const current = active.get(match[1]);
          requireValue(current && current.owner === owner && !current.closing, 404, "unknown_request");
          const body = await readAssistJson(req);
          requireValue(typeof body.callID === "string" && body.result && typeof body.result === "object", 400, "invalid_result");
          await rpc.result({ requestID: current.id, callID: body.callID, result: body.result });
          assistJson(res, 200, { accepted: true }); return;
        }
        requireValue(req.method === "POST" && path === "/v1/requests", 404, "not_found");
        diagnostics = diagnosticContext(req);
        requireValue(active.size + starting.size < 8, 429, "busy");
        reservation = { owner, abort: new AbortController() };
        starting.add(reservation);
        diagnostics.inFlight = active.size + starting.size;
        logDiagnostic(diagnostics, "request_start", {
          stage: "request_accepted",
          started_at: diagnostics.startedAt,
        });
        res.once("close", () => reservation.abort.abort());
        const body = await timedStage(diagnostics, "request_validation", () => readAssistJson(req));
        requireValue(body && typeof body === "object" && Object.keys(body).every((key) => ["system", "messages", "tools", "model"].includes(key)), 400, "invalid_request");
        requireValue(Array.isArray(body.tools) && Array.isArray(body.messages) && typeof body.system === "string", 400, "invalid_request");
        const model = await waitForReadiness(body, diagnostics, reservation.abort.signal);
        const session = await timedStage(
          diagnostics,
          "session_create",
          () => client.session.create({
            title: "Home Assistant request",
            location,
            agent: "home-assistant-assist",
            model: { id: model.id, providerID: model.providerID },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          }),
        );
        request = { sessionID: session.id, owner, abort: reservation.abort };
        request.abort.signal.throwIfAborted();
        const prepared = await timedStage(
          diagnostics,
          "rpc_prepare",
          () => rpc.prepare({ sessionID: session.id, system: body.system, messages: body.messages, tools: body.tools }),
        );
        request.id = prepared.requestID;
        active.set(request.id, request);
        starting.delete(reservation);
        diagnostics.inFlight = active.size + starting.size;
        request.abort.signal.throwIfAborted();
        await timedStage(
          diagnostics,
          "session_permissions",
          () => client.session.update({ sessionID: session.id, permissions: prepared.permissions }),
        );
        await timedStage(diagnostics, "provider_start", () => rpc.start({ requestID: request.id }));
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        outcome = "streaming";
        res.write(JSON.stringify({ type: "request", id: request.id }) + "\n");
        const deadline = AbortSignal.timeout(125000);
        const signal = AbortSignal.any([deadline, request.abort.signal]);
        let done = false;
        let polls = 0;
        const streamingStarted = performance.now();
        diagnostics.stage = "streaming";
        while (!done) {
          const { events } = await rpc.poll({ requestID: request.id }, { signal });
          polls++;
          for (const event of events) {
            if (event.type === "error" || event.type === "done") {
              outcome = event.type === "done" ? "success" : "stream_error";
              logDiagnostic(diagnostics, "stream_terminal_event", {
                stage: "streaming",
                event_type: event.type,
                error_code: event.type === "error" ? safeErrorCode(event.code) : undefined,
                polls,
                elapsed_ms: Math.round(performance.now() - streamingStarted),
              });
            }
            if (!res.write(JSON.stringify(event) + "\n")) await once(res, "drain", { signal });
            if (event.type === "done" || event.type === "error") { done = true; break; }
          }
        }
        res.end();
      } catch (error) {
        if (diagnostics) {
          if (outcome === "streaming") outcome = "stream_error";
          const errorDetails = safeError(error);
          logDiagnostic(diagnostics, "request_error", {
            stage: diagnostics.stage,
            status: error instanceof AssistError ? error.status : (res.headersSent ? 200 : 502),
            ...errorDetails,
            in_flight: active.size + starting.size,
            elapsed_ms: Math.round(performance.now() - diagnostics.started),
          });
        }
        if (!res.headersSent) assistJson(res, error instanceof AssistError ? error.status : 502,
          { error: error instanceof AssistError ? error.message : "assist_unavailable" });
        else if (!res.destroyed) res.end(JSON.stringify({ type: "error", code: "generation_failed" }) + "\n");
      } finally {
        if (reservation) starting.delete(reservation);
        if (request) await cleanup(request);
        if (diagnostics) {
          diagnostics.inFlight = active.size + starting.size;
          logDiagnostic(diagnostics, "request_end", {
            stage: diagnostics.stage,
            outcome,
            stage_times_ms: diagnostics.stageTimes,
            elapsed_ms: Math.round(performance.now() - diagnostics.started),
          });
        }
      }
    },
  };
}
