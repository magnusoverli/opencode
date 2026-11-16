import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageYaml } from "./fixtures/safe-write-package.js";
import { createHash } from "node:crypto";

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
    patch: async (args) => {
      const result = await client.callTool({ name: "patch_config_safe", arguments: { file_path: "packages/synthetic.yaml", ...args } }, undefined, { timeout: 10000 });
      return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    },
    call: async (args = {}) => {
      let revision = "missing";
      try { revision = createHash("sha256").update(await readFile(target)).digest("hex"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const result = await client.callTool({ name: "write_config_safe", arguments: { file_path: "packages/synthetic.yaml", content: packageYaml, expected_revision: revision, ...args } }, undefined, { timeout: 10000 });
      return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    },
    trace: async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

describe("safe-write MCP integration (synthetic filesystem and HA)", () => {
  // Adapted from @jameswgm87's PR #213, with additional failure-path coverage.
  const patchEdits = [{ old_text: "synthetic_nested", new_text: "synthetic_changed" }];
  const patchedYaml = packageYaml.replace("synthetic_nested", "synthetic_changed");
  const sha256 = content => createHash("sha256").update(content).digest("hex");
  const patchApply = {
    edits: patchEdits, dry_run: false,
    expected_revision: sha256(packageYaml), expected_candidate: sha256(patchedYaml),
  };

  it("previews and applies an exact hash-guarded patch with a verified backup", async () => {
    const f = await fixture(packageYaml);
    const preview = await f.patch({ edits: patchEdits });
    expect(preview).toContain("PASSED");
    expect(preview).toContain(patchApply.expected_revision);
    expect(preview).toContain(patchApply.expected_candidate);
    expect(preview).toContain("Edit 1: source line");
    expect(preview).not.toContain("synthetic_changed");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).every(event => event.operation === "template")).toBe(true);
    expect(await f.patch(patchApply)).toContain("SUCCESS");
    expect(await readFile(f.target, "utf8")).toBe(patchedYaml);
    const trace = await f.trace();
    const backup = trace.find(event => event.operation === "open_write" && event.path.endsWith(".bak"));
    expect(await readFile(join(f.target, "../..", backup.path.slice("/homeassistant/".length)), "utf8")).toBe(packageYaml);
    expect(trace.some(event => event.operation === "renameSync" && event.to.endsWith("synthetic.yaml"))).toBe(true);
    expect(trace.filter(event => event.operation === "check_config")).toHaveLength(1);
  });

  it("requires the reviewed source and candidate, including unchanged edits", async () => {
    const f = await fixture(packageYaml);
    expect(await f.patch({ ...patchApply, expected_revision: undefined })).toContain("missing or stale source revision");
    expect(await f.patch({ ...patchApply, expected_revision: "0".repeat(64) })).toContain("stale source revision");
    expect(await f.patch({ ...patchApply, expected_candidate: undefined })).toContain("candidate_revision_mismatch");
    expect(await f.patch({ ...patchApply, expected_candidate: "0".repeat(64) })).toContain("candidate_revision_mismatch");
    expect(await f.patch({ ...patchApply, edits: [{ old_text: "synthetic_nested", new_text: "other_change" }] })).toContain("candidate_revision_mismatch");
    await f.patch({ edits: patchEdits });
    await writeFile(f.target, packageYaml + "# external edit\n");
    expect(await f.patch(patchApply)).toContain("stale source revision");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml + "# external edit\n");
    expect((await f.trace()).every(event => event.operation === "template")).toBe(true);
  });

  it.each(["invalid", "unavailable"])("restores the original when patch HA validation is %s", async check => {
    const f = await fixture(packageYaml, { check });
    const result = await f.patch(patchApply);
    expect(result).toContain("restored");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
  });

  it("reports failed patch recovery without claiming restoration", async () => {
    const f = await fixture(packageYaml, { check: "invalid", rollbackFailure: true });
    const result = await f.patch(patchApply);
    expect(result).toContain("recovery_required");
    expect(result).not.toContain("original state restored");
    expect(await readFile(f.target, "utf8")).toBe(patchedYaml);
  });

  it("refuses patch writes if the recovery copy cannot be created", async () => {
    const f = await fixture(packageYaml, { backupFailure: true });
    expect(await f.patch(patchApply)).toContain("backup_or_journal_failed");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).some(event => event.operation === "check_config")).toBe(false);
  });

  it("refuses restricted paths, missing files, ambiguous matches and no-op edits", async () => {
    const f = await fixture("a: one\nb: one\n");
    const edits = [{ old_text: "one", new_text: "two" }];
    expect(await f.patch({ edits })).toContain("match_not_unique");
    for (const file_path of ["secrets.yaml", "packages/secrets.yml", "packages/.hidden.yaml", "packages/source.json"]) {
      expect(await f.patch({ file_path, edits })).toContain("restricted path");
    }
    expect(await f.patch({ file_path: "packages/missing.yaml", edits })).toContain("missing file");
    expect(await f.patch({ edits: [{ old_text: "a: one", new_text: "a: one" }] })).toContain("no_change");
    expect(await readFile(f.target, "utf8")).toBe("a: one\nb: one\n");
    expect(await f.trace()).toEqual([]);
  });

  it("refuses invalid UTF-8 without a lossy rewrite", async () => {
    const bytes = Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a]);
    const f = await fixture(bytes);
    expect(await f.patch({ edits: [{ old_text: "a:", new_text: "b:" }] })).toContain("invalid_utf8");
    expect(await readFile(f.target)).toEqual(bytes);
    expect(await f.trace()).toEqual([]);
  });

  it("retains structural, template and deletion checks for patches", async () => {
    const f = await fixture(packageYaml);
    for (const edits of [
      [{ old_text: packageYaml, new_text: "automation: [broken" }],
      [{ old_text: "trigger.to_state.state", new_text: "BROKEN" }],
      [{ old_text: packageYaml, new_text: "template: []\n" }],
    ]) {
      const candidate = packageYaml.replace(edits[0].old_text, edits[0].new_text);
      expect(await f.patch({ ...patchApply, edits, expected_candidate: sha256(candidate) })).toContain("REFUSED");
    }
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).every(event => event.operation === "template")).toBe(true);
    const edits = [{ old_text: packageYaml, new_text: "template: []\n" }];
    expect(await f.patch({ ...patchApply, edits, expected_candidate: sha256("template: []\n"), confirm_deletions: true })).toContain("SUCCESS");
  });

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
    const trace = await f.trace();
    const backup = trace.find(event => event.operation === "open_write" && event.path.endsWith(".bak"));
    expect(await readFile(join(f.target, "../..", backup.path.slice("/homeassistant/".length)), "utf8")).toBe(original);
    expect(trace.some(event => event.operation === "renameSync" && event.to.endsWith("synthetic.yaml"))).toBe(true);
    expect(trace.filter(event => event.operation === "check_config")).toHaveLength(1);
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
    expect(await f.call()).toContain("backup_or_journal_failed");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).some(event => event.operation === "check_config")).toBe(false);
  });

  it.each(["invalid", "unavailable"])("restores the prior file or removes a new file when HA check is %s", async check => {
    for (const original of [null, packageYaml.replace("synthetic_nested", "synthetic_original")]) {
      const f = await fixture(original, { check });
      expect(await f.call()).toContain("Safe Config Write - FAILED");
      if (original === null) await expect(access(f.target)).rejects.toThrow();
      else {
        expect(await readFile(f.target, "utf8")).toBe(original);
        expect((await f.trace()).some(event => event.operation === "open_write" && event.path.endsWith(".bak"))).toBe(true);
      }
      expect((await f.trace()).some(event => event.operation === "check_config")).toBe(true);
    }
  });

  it("reports failed rollback as recovery required, never as restored", async () => {
    const f = await fixture(packageYaml.replace("synthetic_nested", "synthetic_original"), { check: "invalid", rollbackFailure: true });
    const result = await f.call();
    expect(result).toContain("recovery_required");
    expect(result).not.toContain("original state restored");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
  });

  it("refuses missing and stale source revisions before a production write", async () => {
    const f = await fixture(packageYaml);
    expect(await f.call({ expected_revision: undefined })).toContain("expected_revision_required");
    expect(await f.call({ expected_revision: "0".repeat(64) })).toContain("conflict");
    expect(await readFile(f.target, "utf8")).toBe(packageYaml);
    expect((await f.trace()).some(event => event.operation === "check_config")).toBe(false);
  });
});
