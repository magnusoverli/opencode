import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageYaml } from "./fixtures/safe-write-package.js";

const fixtures = [];
afterEach(async () => {
  for (const { client, root } of fixtures.splice(0)) {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(existing = null, state = {}) {
  const root = await mkdtemp(join(tmpdir(), "ha-safe-write-"));
  const target = join(root, "config/packages/synthetic.yaml");
  await mkdir(join(root, "config/packages"), { recursive: true });
  await writeFile(join(root, "state.json"), JSON.stringify(state));
  await writeFile(join(root, "trace.jsonl"), "");
  if (existing !== null) await writeFile(target, existing);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./fixtures/safe-write-preload.mjs", import.meta.url).href, fileURLToPath(new URL("../index.js", import.meta.url))],
    env: { PATH: process.env.PATH, HOME: root, SUPERVISOR_TOKEN: "synthetic-fixture-token", SAFE_WRITE_FIXTURE_ROOT: root, OPENCODE_MCP_TOOL_PROFILE: "configuration", HA_API_BASE_URL: "http://synthetic.invalid/api" },
    stderr: "pipe",
  });
  const client = new Client({ name: "safe-write-test", version: "1.0.0" });
  fixtures.push({ client, root });
  await client.connect(transport);
  return {
    target,
    call: async (args = {}) => {
      const result = await client.callTool({ name: "write_config_safe", arguments: { file_path: "packages/synthetic.yaml", content: packageYaml, ...args } }, undefined, { timeout: 10000 });
      return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    },
    trace: async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

describe("safe-write MCP integration (synthetic filesystem and HA)", () => {
  it("passes a real package dry run with template validation and no filesystem mutations", async () => {
    const f = await fixture();
    const result = await f.call({ dry_run: true, validate_templates: true });
    expect(result).toContain("PASSED - Safe to write");
    expect(result).not.toContain("Structural Error");
    expect(result).not.toContain("Structural Warnings");
    const trace = await f.trace();
    expect(trace.filter(event => event.operation === "template")).toHaveLength(2);
    expect(trace.every(event => event.operation === "template")).toBe(true);
    await expect(access(f.target)).rejects.toThrow();
    await expect(access(f.target + ".bak")).rejects.toThrow();
  });

  it("retains backup, template baseline memoization and authoritative HA validation on an approved write", async () => {
    const original = packageYaml.replace("synthetic_nested", "synthetic_original");
    const f = await fixture(original);
    expect(await f.call({ dry_run: true })).toContain("PASSED");
    expect(await f.call()).toContain("Safe Config Write - SUCCESS");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect(await readFile(f.target + ".bak", "utf8")).toBe(original);
    const operations = (await f.trace()).map(event => event.operation);
    expect(operations).toEqual(["copyFileSync", "writeFileSync", "check_config"]);
  });

  it("does not render or resolve Jinja-looking HA reference arguments during a dry run", async () => {
    const f = await fixture();
    const content = packageYaml.replace('state: "{{ trigger.to_state.state }}"', 'state: !secret "synthetic_{{ not_jinja }}"');
    expect(await f.call({ content, dry_run: true })).toContain("PASSED");
    const trace = await f.trace();
    expect(trace).toHaveLength(1);
    expect(trace[0].operation).toBe("template");
    expect(trace[0].template).toContain("is_state");
  });

  it("passes standard standalone file context to preflight before either dry-run or actual write", async () => {
    const f = await fixture();
    const args = { file_path: "automations.yaml", content: '- alias: "Missing triggers and actions"\n' };
    expect(await f.call({ ...args, dry_run: true })).toContain("FAILED - Fix errors");
    expect(await f.call(args)).toContain("Safe Config Write - REFUSED");
    expect(await f.trace()).toEqual([]);
  });

  it.each(["automation: [broken", 'automation:\n  - alias: "Missing trigger and actions"\n'])(
    "refuses malformed structures before any backup/write even with confirm_deletions: %s", async content => {
      const f = await fixture(packageYaml);
      expect(await f.call({ content, confirm_deletions: true })).toContain("Safe Config Write - REFUSED");
      expect(await readFile(f.target, "utf8")).toBe(packageYaml);
      expect((await f.trace()).some(event => /FileSync|mkdirSync|check_config/.test(event.operation))).toBe(false);
    },
  );

  it("still blocks changed Jinja syntax errors and destructive content replacement", async () => {
    const f = await fixture(packageYaml);
    const content = packageYaml.replace("trigger.to_state.state", "BROKEN");
    const templateResult = await f.call({ content });
    expect(templateResult).toContain("REFUSED");
    expect(templateResult).toContain("Template Error");
    const deletionResult = await f.call({ content: "template: []\n" });
    expect(deletionResult).toContain("REFUSED");
    expect(deletionResult).toContain("Top-Level Key Removal Blocked");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).every(event => event.operation === "template")).toBe(true);
  });

  it("does not write when the backup cannot be created", async () => {
    const f = await fixture(packageYaml, { backupFailure: true });
    expect(await f.call()).toContain("Could not create backup");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).map(event => event.operation)).toEqual(["copyFileSync"]);
  });

  it.each(["invalid", "unavailable"])("restores the prior file or removes a new file when HA check is %s", async check => {
    for (const original of [null, packageYaml.replace("synthetic_nested", "synthetic_original")]) {
      const f = await fixture(original, { check });
      expect(await f.call()).toContain("Safe Config Write - FAILED");
      if (original === null) await expect(access(f.target)).rejects.toThrow();
      else {
        expect(await readFile(f.target, "utf8")).toBe(original);
        expect(await readFile(f.target + ".bak", "utf8")).toBe(original);
      }
      expect((await f.trace()).some(event => event.operation === "check_config")).toBe(true);
    }
  });
});
