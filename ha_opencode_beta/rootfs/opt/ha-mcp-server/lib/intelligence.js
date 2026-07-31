/**
 * Intelligence Layer - Semantic Analysis & Summaries
 *
 * Pure functions for anomaly detection, entity search,
 * suggestion generation, and state summarization.
 */

/**
 * Detect anomalies in a single entity state.
 * Returns an anomaly descriptor or null.
 */
export function detectAnomaly(state) {
  const { entity_id, state: value, attributes } = state;
  const [domain] = entity_id.split(".");

  // Battery low
  if (attributes?.battery_level !== undefined && attributes.battery_level < 20) {
    return { entity_id, reason: `Low battery (${attributes.battery_level}%)`, severity: "warning" };
  }

  // Temperature sensors out of normal range
  if (domain === "sensor" && attributes?.device_class === "temperature") {
    const temp = parseFloat(value);
    if (!isNaN(temp)) {
      const unit = attributes.unit_of_measurement || "°C";
      const isCelsius = unit.includes("C");
      const normalMin = isCelsius ? -10 : 14;
      const normalMax = isCelsius ? 50 : 122;
      if (temp < normalMin || temp > normalMax) {
        return { entity_id, reason: `Unusual temperature: ${value}${unit}`, severity: "warning" };
      }
    }
  }

  // Humidity out of range
  if (domain === "sensor" && attributes?.device_class === "humidity") {
    const humidity = parseFloat(value);
    if (!isNaN(humidity) && (humidity < 10 || humidity > 95)) {
      return { entity_id, reason: `Unusual humidity: ${value}%`, severity: "warning" };
    }
  }

  // Door/window sensors open for extended period
  if ((domain === "binary_sensor") &&
      (attributes?.device_class === "door" || attributes?.device_class === "window") &&
      value === "on") {
    const lastChanged = new Date(state.last_changed);
    const hoursOpen = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60);
    if (hoursOpen > 4) {
      return { entity_id, reason: `Open for ${hoursOpen.toFixed(1)} hours`, severity: "info" };
    }
  }

  // Lights on during day (basic heuristic)
  if (domain === "light" && value === "on") {
    const hour = new Date().getHours();
    if (hour >= 10 && hour <= 16) {
      return { entity_id, reason: "Light on during daytime", severity: "info" };
    }
  }

  return null;
}

/**
 * Search entities semantically against a text query.
 * Returns top 20 results sorted by relevance score.
 */
export function searchEntities(states, query) {
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/);

  const results = states.map(state => {
    let score = 0;
    const searchText = [
      state.entity_id,
      state.attributes?.friendly_name || "",
      state.attributes?.device_class || "",
      state.state,
    ].join(" ").toLowerCase();

    for (const term of terms) {
      if (searchText.includes(term)) {
        score += 1;
        if ((state.attributes?.friendly_name || "").toLowerCase().includes(term)) {
          score += 2;
        }
        if (state.entity_id.includes(term)) {
          score += 1;
        }
      }
    }

    return { state, score };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(r => ({
      entity_id: r.state.entity_id,
      state: r.state.state,
      friendly_name: r.state.attributes?.friendly_name,
      device_class: r.state.attributes?.device_class,
      score: r.score,
    }));

  return results;
}

/**
 * Generate automation suggestions based on entity states.
 */
export function generateSuggestions(states) {
  const suggestions = [];

  const motionSensors = states.filter(s =>
    s.attributes?.device_class === "motion" ||
    s.entity_id.includes("motion")
  );
  const lights = states.filter(s => s.entity_id.startsWith("light."));

  for (const motion of motionSensors) {
    const areaId = motion.attributes?.area_id;
    if (areaId) {
      const areaLights = lights.filter(l => l.attributes?.area_id === areaId);
      if (areaLights.length > 0) {
        suggestions.push({
          type: "motion_light",
          title: "Motion-Activated Lighting",
          description: `Create automation: When ${motion.attributes?.friendly_name || motion.entity_id} detects motion, turn on ${areaLights.map(l => l.attributes?.friendly_name || l.entity_id).join(", ")}`,
          trigger_entity: motion.entity_id,
          action_entities: areaLights.map(l => l.entity_id),
        });
      }
    }
  }

  const openings = states.filter(s =>
    s.attributes?.device_class === "door" ||
    s.attributes?.device_class === "window"
  );
  if (openings.length > 0) {
    suggestions.push({
      type: "security_alert",
      title: "Security Alert Automation",
      description: `Create notification when doors/windows are left open for extended periods`,
      entities: openings.map(o => o.entity_id).slice(0, 5),
    });
  }

  const thermostats = states.filter(s => s.entity_id.startsWith("climate."));
  const tempSensors = states.filter(s => s.attributes?.device_class === "temperature");
  if (thermostats.length > 0 && tempSensors.length > 0) {
    suggestions.push({
      type: "climate_optimization",
      title: "Climate Optimization",
      description: "Create automations to adjust thermostat based on occupancy or outdoor temperature",
      climate_entities: thermostats.map(t => t.entity_id),
      sensor_entities: tempSensors.map(s => s.entity_id).slice(0, 3),
    });
  }

  const powerSensors = states.filter(s =>
    s.attributes?.device_class === "power" ||
    s.attributes?.device_class === "energy"
  );
  if (powerSensors.length > 0) {
    suggestions.push({
      type: "energy_monitoring",
      title: "Energy Usage Alerts",
      description: "Create alerts for unusual energy consumption patterns",
      entities: powerSensors.map(p => p.entity_id).slice(0, 5),
    });
  }

  return suggestions;
}

/**
 * Generate a human-readable Markdown summary of entity states.
 */
export function generateStateSummary(states) {
  const byDomain = {};
  const anomalies = [];
  const unavailable = [];

  for (const state of states) {
    const [domain] = state.entity_id.split(".");
    if (!byDomain[domain]) {
      byDomain[domain] = { count: 0, on: 0, off: 0, entities: [] };
    }
    byDomain[domain].count++;
    byDomain[domain].entities.push(state);

    if (state.state === "on") byDomain[domain].on++;
    if (state.state === "off") byDomain[domain].off++;
    if (state.state === "unavailable" || state.state === "unknown") {
      unavailable.push(state.entity_id);
    }

    // Detect anomalies
    const anomaly = detectAnomaly(state);
    if (anomaly) anomalies.push(anomaly);
  }

  const lines = ["## Home Assistant State Summary\n"];

  // Domain overview
  lines.push("### By Domain");
  for (const [domain, info] of Object.entries(byDomain).sort((a, b) => b[1].count - a[1].count)) {
    let detail = `${info.count} entities`;
    if (info.on > 0 || info.off > 0) {
      detail += ` (${info.on} on, ${info.off} off)`;
    }
    lines.push(`- **${domain}**: ${detail}`);
  }

  // Unavailable entities
  if (unavailable.length > 0) {
    lines.push("\n### Unavailable/Unknown Entities");
    for (const id of unavailable.slice(0, 10)) {
      lines.push(`- ${id}`);
    }
    if (unavailable.length > 10) {
      lines.push(`- ... and ${unavailable.length - 10} more`);
    }
  }

  // Anomalies
  if (anomalies.length > 0) {
    lines.push("\n### Potential Anomalies Detected");
    for (const a of anomalies.slice(0, 5)) {
      lines.push(`- **${a.entity_id}**: ${a.reason}`);
    }
  }

  return lines.join("\n");
}
