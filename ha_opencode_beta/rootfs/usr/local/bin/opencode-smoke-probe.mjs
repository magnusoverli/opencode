#!/usr/bin/env node
/**
 * Start one of the add-on's stdio servers, hold a real conversation with it,
 * and print a single word or number for `opencode-smoke-test` to check.
 *
 * The point is to exercise the actual protocol rather than "does the process
 * stay alive": a server that starts and then fails to answer `initialize` looks
 * healthy to a process check and is completely broken in a session.
 *
 * Probes:
 *   mcp                   -> number of tools advertised by the MCP server
 *   mcp-compact-reject    -> "rejected" if the compact profile refuses call_service
 *   lsp                   -> "ok" if the HA YAML language server answers initialize
 *
 * Never hangs: every probe is bounded and kills its child.
 */

import { spawn } from "child_process";

const TIMEOUT_MS = Number(process.env.SMOKE_PROBE_TIMEOUT_MS || 30000);
const MCP_SERVER = process.env.SMOKE_PROBE_MCP || "/opt/ha-mcp-server/index.js";
const LSP_SERVER = process.env.SMOKE_PROBE_LSP || "/opt/ha-lsp-server/server.js";

function withChild(command, args, env, drive) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    child.on("error", () => finish("spawn-failed"));
    child.on("exit", () => finish("exited"));
    drive(child, finish);
  });
}

/** Newline-delimited JSON-RPC, as MCP servers speak over stdio. */
function mcpProbe({ profile, call }) {
  return withChild(process.execPath, [MCP_SERVER], {
    SUPERVISOR_TOKEN: process.env.SUPERVISOR_TOKEN || "smoke-test",
    OPENCODE_MCP_TOOL_PROFILE: profile,
    OPENCODE_DECISION_NOTES: "false",
  }, (child, finish) => {
    let buffer = "";
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send(call
            ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: call }
            : { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (call) {
            finish(message.result?.isError ? "rejected" : "accepted");
          } else {
            finish(String(message.result?.tools?.length ?? 0));
          }
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opencode-smoke-test", version: "1" },
      },
    });
  });
}

/** Content-Length framed JSON-RPC, as the Language Server Protocol requires. */
function lspProbe() {
  return withChild(process.execPath, [LSP_SERVER, "--stdio"], {
    SUPERVISOR_TOKEN: process.env.SUPERVISOR_TOKEN || "smoke-test",
  }, (child, finish) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.slice(0, headerEnd);
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
        if (!Number.isFinite(length)) return finish("bad-header");
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return;
        const body = buffer.slice(bodyStart, bodyStart + length);
        buffer = buffer.slice(bodyStart + length);
        let message;
        try {
          message = JSON.parse(body);
        } catch {
          return finish("bad-body");
        }
        if (message.id === 1) {
          finish(message.result?.capabilities ? "ok" : "no-capabilities");
          return;
        }
      }
    });

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: "file:///homeassistant",
        capabilities: {},
        workspaceFolders: null,
      },
    });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  });
}

const probe = process.argv[2];
let result;
switch (probe) {
  case "mcp":
    result = await mcpProbe({ profile: "full" });
    break;
  case "mcp-compact-reject":
    result = await mcpProbe({
      profile: "compact",
      call: { name: "call_service", arguments: { domain: "light", service: "turn_on" } },
    });
    break;
  case "lsp":
    result = await lspProbe();
    break;
  default:
    console.error("usage: opencode-smoke-probe.mjs mcp|mcp-compact-reject|lsp");
    process.exit(2);
}

console.log(result);
process.exit(0);
