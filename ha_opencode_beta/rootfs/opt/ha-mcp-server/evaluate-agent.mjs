#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  normalizeChatCompletionsEndpoint,
  normalizeEvaluationProfile,
  parseToolCall,
  scenarioAppliesToProfile,
  scoreScenario,
  toOpenAiTools,
} from "./lib/agent-evaluation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = join(__dirname, "evaluation", "scenarios.json");
const DEFAULT_OUTPUT_DIR = "/data/evaluations";

function usage() {
  console.log(`Usage: ha-agent-eval [--profile compact|configuration|full] [--scenario ID] [--out PATH]

Calls an OpenAI-compatible chat-completions endpoint against fixed synthetic Home
Assistant scenarios. It never contacts Home Assistant or executes a real tool.

Required environment:
  HA_AGENT_EVAL_BASE_URL   Provider base URL or /v1/chat/completions endpoint
  HA_AGENT_EVAL_MODEL      Model ID

Optional environment:
  HA_AGENT_EVAL_API_KEY    Sent as a Bearer token when set
  HA_AGENT_EVAL_TEMPERATURE  Sampling temperature (default: 0)

By default, output is written under /data/evaluations/.`);
}

function parseArgs(argv) {
  const options = { profile: process.env.OPENCODE_MCP_TOOL_PROFILE || "full", scenarios: [], out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--profile" || value === "--scenario" || value === "--out") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--profile") options.profile = next;
      if (value === "--scenario") options.scenarios.push(next);
      if (value === "--out") options.out = next;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  const requestedProfile = String(options.profile).trim().toLowerCase();
  options.profile = normalizeEvaluationProfile(options.profile);
  if (requestedProfile && requestedProfile !== options.profile) {
    throw new Error("--profile must be compact, configuration, or full");
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function messageForTranscript(message) {
  return {
    content: message?.content ?? "",
    tool_calls: (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    })),
  };
}

async function requestCompletion({ endpoint, apiKey, model, messages, tools, temperature }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Provider returned a non-JSON chat-completions response");
  }
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error("Provider response did not contain choices[0].message");
  return message;
}

async function runScenario(scenario, provider) {
  const messages = [
    {
      role: "system",
      content:
        "You are evaluating Home Assistant tool selection. Use only the supplied tools, call tools before answering when needed, and never claim an action was performed unless a tool result says so.",
    },
    { role: "user", content: scenario.prompt },
  ];
  const transcript = { id: scenario.id, title: scenario.title, calls: [], turns: [] };
  let finalText = "";

  for (let turn = 0; turn < 5; turn += 1) {
    const message = await requestCompletion({ ...provider, messages, tools: toOpenAiTools(scenario) });
    transcript.turns.push(messageForTranscript(message));
    const toolCalls = message.tool_calls ?? [];
    if (!toolCalls.length) {
      finalText = message.content ?? "";
      break;
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
    for (const toolCall of toolCalls) {
      const parsed = parseToolCall(toolCall);
      transcript.calls.push(parsed);
      const response = parsed.valid && scenario.tool_responses[parsed.name]
        ? scenario.tool_responses[parsed.name]
        : { error: parsed.valid ? `Unknown synthetic tool: ${parsed.name}` : "Tool arguments were not valid JSON." };
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(response),
      });
    }
  }

  transcript.final_response = finalText;
  transcript.score = scoreScenario(scenario, transcript.calls, finalText);
  return transcript;
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const baseUrl = process.env.HA_AGENT_EVAL_BASE_URL;
  const model = process.env.HA_AGENT_EVAL_MODEL;
  if (!baseUrl || !model) throw new Error("HA_AGENT_EVAL_BASE_URL and HA_AGENT_EVAL_MODEL are required");

  const scenariosDocument = JSON.parse(await readFile(SCENARIOS_PATH, "utf8"));
  const selected = options.scenarios.length
    ? scenariosDocument.scenarios.filter((scenario) => options.scenarios.includes(scenario.id))
    : scenariosDocument.scenarios;
  if (!selected.length) throw new Error("No scenarios matched the requested scenario ID");
  if (options.scenarios.length && options.scenarios.length !== selected.length) {
    throw new Error("One or more requested scenario IDs do not exist");
  }
  const requested = selected.filter((scenario) => scenarioAppliesToProfile(scenario, options.profile));
  if (!requested.length) throw new Error(`No selected scenarios are available in the ${options.profile} profile`);

  const endpoint = normalizeChatCompletionsEndpoint(baseUrl);
  const provider = {
    endpoint,
    apiKey: process.env.HA_AGENT_EVAL_API_KEY,
    model,
    temperature: Number(process.env.HA_AGENT_EVAL_TEMPERATURE ?? 0),
  };
  const results = [];
  for (const scenario of requested) {
    console.log(`Running ${scenario.id}...`);
    results.push(await runScenario(scenario, provider));
  }

  const passed = results.filter((result) => result.score.passed).length;
  const report = {
    version: scenariosDocument.version,
    created_at: new Date().toISOString(),
    profile: options.profile,
    provider: { endpoint, model },
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
  const output = options.out || join(DEFAULT_OUTPUT_DIR, `ha-agent-eval-${timestamp()}.json`);
  await writeReport(output, report);
  console.log(`Result: ${passed}/${results.length} scenarios passed`);
  console.log(`Report: ${output}`);
  if (passed !== results.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`ha-agent-eval: ${error.message}`);
  process.exitCode = 1;
});
