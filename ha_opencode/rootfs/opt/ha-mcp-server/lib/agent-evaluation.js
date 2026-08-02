/**
 * Small, provider-neutral checks for real model tool selection.
 *
 * The runner supplies synthetic tool responses, never connects to Home
 * Assistant, and records enough detail to compare models or prompts locally.
 */

const PROFILE_ORDER = ["compact", "configuration", "full"];

export function normalizeEvaluationProfile(value) {
  const profile = String(value ?? "").trim().toLowerCase();
  return PROFILE_ORDER.includes(profile) ? profile : "full";
}

export function scenarioAppliesToProfile(scenario, profile) {
  const minimum = normalizeEvaluationProfile(scenario.minimum_profile);
  return PROFILE_ORDER.indexOf(minimum) <= PROFILE_ORDER.indexOf(normalizeEvaluationProfile(profile));
}

export function normalizeChatCompletionsEndpoint(value) {
  const endpoint = new URL(value);
  const path = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = path.endsWith("/chat/completions")
    ? path
    : `${path.endsWith("/v1") ? path : `${path}/v1`}/chat/completions`;
  return endpoint.toString();
}

export function toOpenAiTools(scenario) {
  return scenario.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function parseToolCall(toolCall) {
  const name = toolCall?.function?.name;
  const rawArguments = toolCall?.function?.arguments ?? "{}";
  try {
    const argumentsValue = JSON.parse(rawArguments);
    return { name, arguments: argumentsValue, rawArguments, valid: true };
  } catch {
    return { name, arguments: null, rawArguments, valid: false };
  }
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

export function scoreScenario(scenario, calls, finalText = "") {
  const expected = scenario.expect ?? {};
  const available = new Set(scenario.tools.map((tool) => tool.name));
  const names = calls.map((call) => call.name);
  const checks = [];

  for (const name of expected.required_tools ?? []) {
    checks.push({
      name: `called:${name}`,
      passed: names.includes(name),
    });
  }

  for (const name of expected.forbidden_tools ?? []) {
    checks.push({
      name: `not_called:${name}`,
      passed: !names.includes(name),
    });
  }

  for (const assertion of expected.arguments ?? []) {
    const matchingCall = calls.find((call) =>
      call.name === assertion.tool && call.valid && valueAtPath(call.arguments, assertion.path) === assertion.equals,
    );
    checks.push({
      name: `argument:${assertion.tool}.${assertion.path}`,
      passed: Boolean(matchingCall),
    });
  }

  const invalidCalls = calls.filter((call) => !call.valid || !available.has(call.name));
  checks.push({ name: "valid_tool_calls", passed: invalidCalls.length === 0 });
  checks.push({ name: "final_response", passed: Boolean(String(finalText).trim()) });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    invalid_calls: invalidCalls.map(({ name, rawArguments, valid }) => ({ name, rawArguments, valid })),
  };
}
