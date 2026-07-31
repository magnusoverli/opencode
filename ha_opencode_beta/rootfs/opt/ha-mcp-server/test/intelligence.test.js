import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectAnomaly,
  searchEntities,
  generateSuggestions,
  generateStateSummary,
} from "../lib/intelligence.js";

// ---------------------------------------------------------------------------
// detectAnomaly
// ---------------------------------------------------------------------------

describe("detectAnomaly", () => {
  it("returns null for a normal entity", () => {
    const state = {
      entity_id: "light.living_room",
      state: "off",
      attributes: {},
    };
    expect(detectAnomaly(state)).toBeNull();
  });

  it("detects low battery", () => {
    const state = {
      entity_id: "sensor.door_battery",
      state: "15",
      attributes: { battery_level: 15 },
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.severity).toBe("warning");
    expect(result.reason).toContain("15%");
  });

  it("ignores battery at 20% or above", () => {
    const state = {
      entity_id: "sensor.door_battery",
      state: "20",
      attributes: { battery_level: 20 },
    };
    expect(detectAnomaly(state)).toBeNull();
  });

  it("detects unusual celsius temperature", () => {
    const state = {
      entity_id: "sensor.outdoor_temp",
      state: "55",
      attributes: { device_class: "temperature", unit_of_measurement: "\u00b0C" },
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.reason).toContain("55");
  });

  it("detects unusual fahrenheit temperature", () => {
    const state = {
      entity_id: "sensor.outdoor_temp",
      state: "130",
      attributes: { device_class: "temperature", unit_of_measurement: "\u00b0F" },
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.reason).toContain("130");
  });

  it("accepts normal celsius temperature", () => {
    const state = {
      entity_id: "sensor.outdoor_temp",
      state: "22",
      attributes: { device_class: "temperature", unit_of_measurement: "\u00b0C" },
    };
    expect(detectAnomaly(state)).toBeNull();
  });

  it("detects unusual humidity", () => {
    const state = {
      entity_id: "sensor.bathroom_humidity",
      state: "5",
      attributes: { device_class: "humidity" },
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.reason).toContain("5%");
  });

  it("accepts normal humidity", () => {
    const state = {
      entity_id: "sensor.bathroom_humidity",
      state: "55",
      attributes: { device_class: "humidity" },
    };
    expect(detectAnomaly(state)).toBeNull();
  });

  it("detects door open for extended period", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const state = {
      entity_id: "binary_sensor.front_door",
      state: "on",
      attributes: { device_class: "door" },
      last_changed: fiveHoursAgo,
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.severity).toBe("info");
    expect(result.reason).toContain("hours");
  });

  it("ignores a door open for less than 4 hours", () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const state = {
      entity_id: "binary_sensor.front_door",
      state: "on",
      attributes: { device_class: "door" },
      last_changed: oneHourAgo,
    };
    expect(detectAnomaly(state)).toBeNull();
  });

  it("detects light on during daytime", () => {
    // We fake the clock to noon
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0));

    const state = {
      entity_id: "light.kitchen",
      state: "on",
      attributes: {},
    };
    const result = detectAnomaly(state);
    expect(result).not.toBeNull();
    expect(result.reason).toContain("daytime");

    vi.useRealTimers();
  });

  it("ignores light on during evening", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 5, 15, 21, 0, 0));

    const state = {
      entity_id: "light.kitchen",
      state: "on",
      attributes: {},
    };
    expect(detectAnomaly(state)).toBeNull();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// searchEntities
// ---------------------------------------------------------------------------

describe("searchEntities", () => {
  const states = [
    {
      entity_id: "light.living_room",
      state: "on",
      attributes: { friendly_name: "Living Room Light" },
    },
    {
      entity_id: "light.kitchen",
      state: "off",
      attributes: { friendly_name: "Kitchen Light" },
    },
    {
      entity_id: "sensor.outdoor_temp",
      state: "22",
      attributes: { friendly_name: "Outdoor Temperature", device_class: "temperature" },
    },
    {
      entity_id: "binary_sensor.front_door",
      state: "off",
      attributes: { friendly_name: "Front Door", device_class: "door" },
    },
  ];

  it("returns entities matching the query", () => {
    const results = searchEntities(states, "kitchen");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity_id).toBe("light.kitchen");
  });

  it("ranks friendly_name matches higher", () => {
    const results = searchEntities(states, "living room");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity_id).toBe("light.living_room");
  });

  it("returns empty array for no matches", () => {
    const results = searchEntities(states, "garage");
    expect(results).toEqual([]);
  });

  it("limits results to 20", () => {
    // Create 30 matching entities
    const many = Array.from({ length: 30 }, (_, i) => ({
      entity_id: `light.room_${i}`,
      state: "on",
      attributes: { friendly_name: `Room ${i} Light` },
    }));
    const results = searchEntities(many, "light");
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("handles multi-word queries", () => {
    const results = searchEntities(states, "outdoor temperature");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity_id).toBe("sensor.outdoor_temp");
  });
});

// ---------------------------------------------------------------------------
// generateSuggestions
// ---------------------------------------------------------------------------

describe("generateSuggestions", () => {
  it("suggests motion-activated lighting when motion sensor and light share area", () => {
    const states = [
      {
        entity_id: "binary_sensor.hallway_motion",
        state: "off",
        attributes: { device_class: "motion", area_id: "hallway", friendly_name: "Hallway Motion" },
      },
      {
        entity_id: "light.hallway",
        state: "off",
        attributes: { area_id: "hallway", friendly_name: "Hallway Light" },
      },
    ];
    const suggestions = generateSuggestions(states);
    expect(suggestions.some(s => s.type === "motion_light")).toBe(true);
  });

  it("suggests security alert when door/window sensors exist", () => {
    const states = [
      {
        entity_id: "binary_sensor.front_door",
        state: "off",
        attributes: { device_class: "door" },
      },
    ];
    const suggestions = generateSuggestions(states);
    expect(suggestions.some(s => s.type === "security_alert")).toBe(true);
  });

  it("suggests climate optimization when thermostat and temp sensor exist", () => {
    const states = [
      {
        entity_id: "climate.living_room",
        state: "heat",
        attributes: {},
      },
      {
        entity_id: "sensor.outdoor_temp",
        state: "22",
        attributes: { device_class: "temperature" },
      },
    ];
    const suggestions = generateSuggestions(states);
    expect(suggestions.some(s => s.type === "climate_optimization")).toBe(true);
  });

  it("suggests energy monitoring when power/energy sensors exist", () => {
    const states = [
      {
        entity_id: "sensor.grid_power",
        state: "1500",
        attributes: { device_class: "power" },
      },
    ];
    const suggestions = generateSuggestions(states);
    expect(suggestions.some(s => s.type === "energy_monitoring")).toBe(true);
  });

  it("returns empty when no patterns match", () => {
    const states = [
      { entity_id: "sensor.cpu", state: "30", attributes: {} },
    ];
    expect(generateSuggestions(states)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateStateSummary
// ---------------------------------------------------------------------------

describe("generateStateSummary", () => {
  it("produces a markdown summary with domain counts", () => {
    const states = [
      { entity_id: "light.one", state: "on", attributes: {} },
      { entity_id: "light.two", state: "off", attributes: {} },
      { entity_id: "sensor.temp", state: "22", attributes: {} },
    ];
    const summary = generateStateSummary(states);
    expect(summary).toContain("## Home Assistant State Summary");
    expect(summary).toContain("**light**");
    expect(summary).toContain("2 entities");
    expect(summary).toContain("1 on");
  });

  it("lists unavailable entities", () => {
    const states = [
      { entity_id: "sensor.broken", state: "unavailable", attributes: {} },
    ];
    const summary = generateStateSummary(states);
    expect(summary).toContain("Unavailable");
    expect(summary).toContain("sensor.broken");
  });

  it("lists anomalies", () => {
    const states = [
      {
        entity_id: "sensor.battery",
        state: "5",
        attributes: { battery_level: 5 },
      },
    ];
    const summary = generateStateSummary(states);
    expect(summary).toContain("Anomalies");
    expect(summary).toContain("sensor.battery");
  });
});
