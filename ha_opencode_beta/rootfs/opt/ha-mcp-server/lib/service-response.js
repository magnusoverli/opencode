/**
 * Response-capable Home Assistant service calls.
 *
 * Home Assistant rejects a service call with HTTP 400 in *both* directions:
 * omitting `?return_response` for a service that always returns data, and
 * passing it for a service that returns none. A caller therefore cannot simply
 * always ask for a response — it has to know what the service supports before
 * it builds the request.
 *
 * `GET /api/services` carries that answer. A service description gains a
 * `response` key only when the service supports one, and `response.optional` is
 * false when the response is mandatory. These helpers read that catalog, turn a
 * caller's intent into the right request, and recognise the two mismatch errors
 * so a stale catalog can be recovered from instead of surfaced as a failure.
 */

/** What a service does with response data, as reported by the catalog. */
export const RESPONSE_SUPPORT = {
  /** Returns nothing; sending the flag is an error. */
  NONE: "none",
  /** Returns data only when asked. */
  OPTIONAL: "optional",
  /** Always returns data; omitting the flag is an error. */
  ONLY: "only",
  /** The catalog could not answer — usually because it failed to load. */
  UNKNOWN: "unknown",
};

/**
 * Read what `domain.service` supports from a `GET /api/services` catalog.
 *
 * Returns UNKNOWN rather than NONE for a service that is missing entirely, so
 * callers can tell "this service returns nothing" apart from "this catalog
 * could not answer" and pick their fallback accordingly.
 */
export function readServiceResponseSupport(catalog, domain, service) {
  if (!Array.isArray(catalog)) return RESPONSE_SUPPORT.UNKNOWN;

  const entry = catalog.find((item) => item?.domain === domain);
  const description = entry?.services?.[service];
  if (!description || typeof description !== "object") return RESPONSE_SUPPORT.UNKNOWN;

  const response = description.response;
  if (!response || typeof response !== "object") return RESPONSE_SUPPORT.NONE;

  // `optional: false` is Home Assistant's encoding of SupportsResponse.ONLY.
  return response.optional === false ? RESPONSE_SUPPORT.ONLY : RESPONSE_SUPPORT.OPTIONAL;
}

/**
 * Decide whether a call should ask for response data.
 *
 * `requested` is the caller's explicit `return_response`; pass undefined to let
 * the catalog decide. Services that *must* return data get the flag
 * automatically — that is the case a caller cannot reasonably be expected to
 * know about, and the one this exists to fix. Optional responses stay opt-in so
 * an ordinary `light.turn_on` keeps the result shape callers already handle.
 *
 * Returns the flag to send plus a note to surface when the decision differs
 * from what was asked for, so an overridden request is never silent.
 */
export function planServiceCall(support, requested) {
  if (requested === true) {
    if (support === RESPONSE_SUPPORT.NONE) {
      return {
        returnResponse: false,
        note: "This service returns no response data, so return_response was not sent.",
      };
    }
    return { returnResponse: true, note: null };
  }

  if (requested === false) {
    // Refusing the flag on a response-only service makes the call impossible;
    // sending it anyway is the only reading that produces a result.
    if (support === RESPONSE_SUPPORT.ONLY) {
      return {
        returnResponse: true,
        note: "This service always returns data, so return_response was sent despite return_response: false.",
      };
    }
    return { returnResponse: false, note: null };
  }

  if (support === RESPONSE_SUPPORT.ONLY) {
    return { returnResponse: true, note: null };
  }

  if (support === RESPONSE_SUPPORT.OPTIONAL) {
    return {
      returnResponse: false,
      note: "This service can also return data — pass return_response: true to receive it.",
    };
  }

  return { returnResponse: false, note: null };
}

/** Build the REST path for a service call, with or without the response flag. */
export function buildServiceCallPath(domain, service, returnResponse) {
  const path = `/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  return returnResponse ? `${path}?return_response` : path;
}

/**
 * Recognise Home Assistant's two `return_response` mismatch errors.
 *
 * Returns the flag value that would have worked, or null when the failure is
 * something else. Lets a caller retry once when its cached catalog is behind
 * the running core — a reloaded or newly added integration is the usual cause.
 */
export function readResponseMismatch(message) {
  const text = String(message ?? "");
  if (!/return_response/i.test(text)) return null;

  if (/requires responses/i.test(text) || /add \??return_response/i.test(text)) return true;
  if (/does not support responses/i.test(text) || /remove \??return_response/i.test(text)) return false;

  return null;
}

/**
 * Normalise a service-call result into changed states and response data.
 *
 * With `?return_response` Home Assistant wraps the body as
 * `{changed_states, service_response}`; without it the body is a bare array of
 * changed states. Both shapes collapse to one thing for callers to read.
 */
export function splitServiceCallResult(result) {
  if (Array.isArray(result)) {
    return { changedStates: result, serviceResponse: null, hasResponse: false };
  }

  if (result && typeof result === "object" && "changed_states" in result) {
    return {
      changedStates: Array.isArray(result.changed_states) ? result.changed_states : [],
      serviceResponse: result.service_response ?? null,
      hasResponse: "service_response" in result,
    };
  }

  return { changedStates: [], serviceResponse: null, hasResponse: false };
}

/** Entity IDs touched by a call, in returned order and de-duplicated. */
export function readAffectedEntities(changedStates) {
  if (!Array.isArray(changedStates)) return [];

  const seen = new Set();
  for (const state of changedStates) {
    const entityId = state?.entity_id;
    if (typeof entityId === "string" && entityId) seen.add(entityId);
  }
  return [...seen];
}

/**
 * Names of the services in one domain that can return response data.
 *
 * Feeds the `get_services` index, where the per-service schemas are dropped:
 * without this the one field that tells an agent it needs `return_response`
 * would be invisible until it queried the domain in full.
 */
export function listResponseCapableServices(servicesForDomain) {
  if (!servicesForDomain || typeof servicesForDomain !== "object") return [];

  return Object.entries(servicesForDomain)
    .filter(([, description]) => description && typeof description === "object" && description.response)
    .map(([name]) => name);
}
