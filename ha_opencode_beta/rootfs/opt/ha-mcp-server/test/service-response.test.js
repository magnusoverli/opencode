import { describe, it, expect } from "vitest";
import {
  RESPONSE_SUPPORT,
  buildServiceCallPath,
  listResponseCapableServices,
  planServiceCall,
  readAffectedEntities,
  readResponseMismatch,
  readServiceResponseSupport,
  splitServiceCallResult,
} from "../lib/service-response.js";

// Shaped like GET /api/services: one entry per domain, services keyed by name.
const CATALOG = [
  {
    domain: "recorder",
    services: {
      // SupportsResponse.ONLY
      get_statistics: { name: "Get statistics", response: { optional: false } },
      purge: { name: "Purge" },
    },
  },
  {
    domain: "weather",
    services: {
      get_forecasts: { name: "Get forecasts", response: { optional: false } },
    },
  },
  {
    domain: "conversation",
    services: {
      // SupportsResponse.OPTIONAL
      process: { name: "Process", response: { optional: true } },
    },
  },
  {
    domain: "light",
    services: {
      turn_on: { name: "Turn on", fields: {} },
    },
  },
];

describe("readServiceResponseSupport", () => {
  it("reads a mandatory response as ONLY", () => {
    expect(readServiceResponseSupport(CATALOG, "recorder", "get_statistics")).toBe(RESPONSE_SUPPORT.ONLY);
  });

  it("reads an optional response as OPTIONAL", () => {
    expect(readServiceResponseSupport(CATALOG, "conversation", "process")).toBe(RESPONSE_SUPPORT.OPTIONAL);
  });

  it("reads a service with no response key as NONE", () => {
    expect(readServiceResponseSupport(CATALOG, "light", "turn_on")).toBe(RESPONSE_SUPPORT.NONE);
    expect(readServiceResponseSupport(CATALOG, "recorder", "purge")).toBe(RESPONSE_SUPPORT.NONE);
  });

  it("distinguishes an unknown service from one that returns nothing", () => {
    expect(readServiceResponseSupport(CATALOG, "recorder", "not_a_service")).toBe(RESPONSE_SUPPORT.UNKNOWN);
    expect(readServiceResponseSupport(CATALOG, "no_such_domain", "whatever")).toBe(RESPONSE_SUPPORT.UNKNOWN);
  });

  it("reports UNKNOWN when the catalog is missing or malformed", () => {
    expect(readServiceResponseSupport(null, "light", "turn_on")).toBe(RESPONSE_SUPPORT.UNKNOWN);
    expect(readServiceResponseSupport({}, "light", "turn_on")).toBe(RESPONSE_SUPPORT.UNKNOWN);
  });
});

describe("planServiceCall", () => {
  it("asks for a response automatically when the service requires one", () => {
    // The issue's case: the caller passes nothing and the call still works.
    expect(planServiceCall(RESPONSE_SUPPORT.ONLY, undefined)).toEqual({ returnResponse: true, note: null });
  });

  it("leaves optional responses opt-in but says they exist", () => {
    const plan = planServiceCall(RESPONSE_SUPPORT.OPTIONAL, undefined);
    expect(plan.returnResponse).toBe(false);
    expect(plan.note).toMatch(/return_response: true/);
  });

  it("does not ask for a response on an ordinary service call", () => {
    expect(planServiceCall(RESPONSE_SUPPORT.NONE, undefined)).toEqual({ returnResponse: false, note: null });
  });

  it("honours an explicit request on an optional service", () => {
    expect(planServiceCall(RESPONSE_SUPPORT.OPTIONAL, true)).toEqual({ returnResponse: true, note: null });
  });

  it("drops an explicit request that Home Assistant would reject, with a note", () => {
    const plan = planServiceCall(RESPONSE_SUPPORT.NONE, true);
    expect(plan.returnResponse).toBe(false);
    expect(plan.note).toMatch(/no response data/);
  });

  it("overrides an explicit refusal that would make the call impossible", () => {
    const plan = planServiceCall(RESPONSE_SUPPORT.ONLY, false);
    expect(plan.returnResponse).toBe(true);
    expect(plan.note).toMatch(/always returns data/);
  });

  it("sends nothing extra when the catalog could not answer", () => {
    // Home Assistant's own 400 drives the retry instead of a guess here.
    expect(planServiceCall(RESPONSE_SUPPORT.UNKNOWN, undefined)).toEqual({ returnResponse: false, note: null });
    expect(planServiceCall(RESPONSE_SUPPORT.UNKNOWN, true)).toEqual({ returnResponse: true, note: null });
  });
});

describe("buildServiceCallPath", () => {
  it("appends the flag only when a response is wanted", () => {
    expect(buildServiceCallPath("light", "turn_on", false)).toBe("/services/light/turn_on");
    expect(buildServiceCallPath("recorder", "get_statistics", true))
      .toBe("/services/recorder/get_statistics?return_response");
  });

  it("encodes the path segments", () => {
    expect(buildServiceCallPath("my domain", "odd/name", false)).toBe("/services/my%20domain/odd%2Fname");
  });
});

describe("readResponseMismatch", () => {
  it("recognises a missing flag from Home Assistant's wording", () => {
    const message = "HA API error (400): Service call requires responses but caller did not ask for " +
      "responses. Add ?return_response to query parameters.";
    expect(readResponseMismatch(message)).toBe(true);
  });

  it("recognises an unwanted flag from Home Assistant's wording", () => {
    const message = "HA API error (400): Service does not support responses. Remove return_response from request.";
    expect(readResponseMismatch(message)).toBe(false);
  });

  it("ignores unrelated failures", () => {
    expect(readResponseMismatch("HA API error (400): Entity light.nope not found")).toBeNull();
    expect(readResponseMismatch("HA API error (401): Unauthorized")).toBeNull();
    expect(readResponseMismatch(undefined)).toBeNull();
  });
});

describe("splitServiceCallResult", () => {
  it("reads the wrapped shape returned with return_response", () => {
    const split = splitServiceCallResult({
      changed_states: [{ entity_id: "sensor.power" }],
      service_response: { "sensor.power": [{ start: 0, mean: 1 }] },
    });

    expect(split.hasResponse).toBe(true);
    expect(split.serviceResponse).toEqual({ "sensor.power": [{ start: 0, mean: 1 }] });
    expect(split.changedStates).toHaveLength(1);
  });

  it("reads the bare array returned without it", () => {
    const split = splitServiceCallResult([{ entity_id: "light.kitchen" }]);

    expect(split.hasResponse).toBe(false);
    expect(split.serviceResponse).toBeNull();
    expect(split.changedStates).toEqual([{ entity_id: "light.kitchen" }]);
  });

  it("survives an empty or unexpected body", () => {
    expect(splitServiceCallResult(null)).toEqual({
      changedStates: [],
      serviceResponse: null,
      hasResponse: false,
    });
    expect(splitServiceCallResult("")).toEqual({
      changedStates: [],
      serviceResponse: null,
      hasResponse: false,
    });
  });

  it("keeps a null response that was genuinely returned", () => {
    const split = splitServiceCallResult({ changed_states: [], service_response: null });
    expect(split.hasResponse).toBe(true);
    expect(split.serviceResponse).toBeNull();
  });
});

describe("readAffectedEntities", () => {
  it("de-duplicates while keeping returned order", () => {
    const entities = readAffectedEntities([
      { entity_id: "light.a" },
      { entity_id: "light.b" },
      { entity_id: "light.a" },
    ]);
    expect(entities).toEqual(["light.a", "light.b"]);
  });

  it("skips entries without an entity_id", () => {
    expect(readAffectedEntities([{}, { entity_id: "" }, { entity_id: "light.a" }])).toEqual(["light.a"]);
    expect(readAffectedEntities(null)).toEqual([]);
  });
});

describe("listResponseCapableServices", () => {
  it("lists only the services that answer with data", () => {
    const recorder = CATALOG.find((entry) => entry.domain === "recorder");
    expect(listResponseCapableServices(recorder.services)).toEqual(["get_statistics"]);
  });

  it("returns nothing for a domain with no response services", () => {
    const light = CATALOG.find((entry) => entry.domain === "light");
    expect(listResponseCapableServices(light.services)).toEqual([]);
    expect(listResponseCapableServices(undefined)).toEqual([]);
  });
});
