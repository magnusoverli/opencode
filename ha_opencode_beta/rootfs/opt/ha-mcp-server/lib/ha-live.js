/**
 * Live Home Assistant lookups for the install briefing.
 *
 * Used by the boot-time context generator, which runs as its own detached
 * process so add-on start-up never waits on Home Assistant. The MCP server has
 * its own long-lived client for interactive work; this module deliberately
 * keeps a small, single-shot implementation instead of sharing that state.
 *
 * Every function resolves to `null` rather than throwing: the briefing is a
 * best-effort artifact, and a Home Assistant that is still starting up is the
 * normal case, not an error.
 */

import WebSocket from "ws";

const SUPERVISOR_CORE_API = "http://supervisor/core/api";
const SUPERVISOR_API = "http://supervisor";
const SUPERVISOR_WEBSOCKET = "ws://supervisor/core/websocket";

const DEFAULT_TIMEOUT_MS = 15000;

async function getJson(url, token, timeoutMs) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** `/api/config` — version, time zone, unit system, and run state. */
export function fetchCoreConfig(token, options = {}) {
  return getJson(`${SUPERVISOR_CORE_API}/config`, token, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** Supervisor `/info` — installation type and hardware, for sizing advice. */
export async function fetchSupervisorInfo(token, options = {}) {
  const payload = await getJson(`${SUPERVISOR_API}/info`, token, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return payload?.data ?? null;
}

/** `/api/states` — used only for per-domain counts, never stored verbatim. */
export function fetchStates(token, options = {}) {
  return getJson(`${SUPERVISOR_CORE_API}/states`, token, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/**
 * Run a single Home Assistant WebSocket command.
 *
 * The registries (areas, floors, entities) are not exposed over REST, so this
 * is the only way to read them without an admin long-lived token.
 */
export function fetchRegistry(commandType, token, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let socket;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    const timer = setTimeout(() => settle(null), timeoutMs);

    try {
      socket = new WebSocket(options.url ?? SUPERVISOR_WEBSOCKET);
    } catch {
      settle(null);
      return;
    }

    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return; // wait for a well-formed frame or the timeout
      }

      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (message.type === "auth_ok") {
        socket.send(JSON.stringify({ id: 1, type: commandType }));
      } else if (message.type === "auth_invalid") {
        settle(null);
      } else if (message.type === "result") {
        settle(message.success ? message.result : null);
      }
    });

    socket.on("error", () => settle(null));
    socket.on("close", () => settle(null));
  });
}

/**
 * Collect everything the briefing needs from a running Home Assistant.
 *
 * Reports which pieces are missing so the briefing can say so plainly rather
 * than presenting a partial picture as complete.
 */
export async function collectLiveFacts(token, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [config, supervisorInfo, states, areas, floors, entityRegistry] = await Promise.all([
    fetchCoreConfig(token, { timeoutMs }),
    fetchSupervisorInfo(token, { timeoutMs }),
    fetchStates(token, { timeoutMs }),
    fetchRegistry("config/area_registry/list", token, { timeoutMs }),
    // Floors arrived in Home Assistant 2024.4; older cores simply return null.
    fetchRegistry("config/floor_registry/list", token, { timeoutMs }),
    fetchRegistry("config/entity_registry/list", token, { timeoutMs }),
  ]);

  const degraded = [];
  if (!config) degraded.push("Home Assistant version and settings");
  if (!areas) degraded.push("areas");
  if (!Array.isArray(states)) degraded.push("entity inventory");
  if (!entityRegistry) degraded.push("integrations");

  return {
    config,
    supervisorInfo,
    states: Array.isArray(states) ? states : null,
    areas: Array.isArray(areas) ? areas : null,
    floors: Array.isArray(floors) ? floors : null,
    entityRegistry: Array.isArray(entityRegistry) ? entityRegistry : null,
    degraded,
    /** True when nothing at all came back — Core is very likely still starting. */
    offline: !config && !areas && !Array.isArray(states) && !entityRegistry,
  };
}
