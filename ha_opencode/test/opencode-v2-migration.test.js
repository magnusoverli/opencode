import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ADDON_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATOR = join(ADDON_ROOT, "rootfs", "usr", "local", "bin", "opencode-v2-migrate.py");
const VALIDATION_FIXTURE = join(ADDON_ROOT, "test", "fixtures", "opencode-v2-validation.py");
const V2_BIN = join(
  ADDON_ROOT,
  "rootfs",
  "opt",
  "opencode-v2-homeassistant",
  "node_modules",
  "@opencode",
  "cli",
  "bin",
  "opencode.exe",
);
const TARGET_VERSION = "2.0.21";
const PREVIOUS_VERSION = "0.0.0-beta-18684";
const PREVIOUS_BIN = join(ADDON_ROOT, "rootfs", "opt", "opencode-v2-homeassistant",
  "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe");
const AUTH_SECRET = "migration-test-secret-must-not-leak";

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("Python is required for OpenCode V2 migration tests");
}

function runMigrator(python, args) {
  return spawnSync(python, [MIGRATOR, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqliteTableCounts(python, database) {
  const code = [
    "import json, sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "names = [r[0] for r in c.execute(\"select name from sqlite_master where type='table' order by name\")]",
    "print(json.dumps({n: c.execute('select count(*) from \\\"' + n + '\\\"').fetchone()[0] for n in names}))",
    "c.close()",
  ].join("; ");
  const result = spawnSync(python, ["-c", code, database], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("OpenCode V2 copy-on-write migration", () => {
  let python;
  let sandbox;

  before(async () => {
    python = findPython();
    sandbox = await mkdtemp(join(tmpdir(), "opencode-v2-migration-"));
  });

  after(async () => {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reports a missing V1 root as a fresh migration source", () => {
    const source = join(sandbox, "missing-source");
    const result = runMigrator(python, ["inventory", "--source-data", source]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      database: false,
      database_bytes: 0,
      database_sidecars: false,
      legacy_json_store: false,
      provider_auth: false,
      provider_auth_count: 0,
      session_count: 0,
      message_count: 0,
      part_count: 0,
      content_part_count: 0,
    });
  });

  it("accepts a database and WAL above the old 16 GiB cap but still rejects files beyond 32 GiB", async () => {
    const source = join(sandbox, "sparse-large-source");
    const database = join(source, "opencode.db");
    const wal = join(source, "opencode.db-wal");
    await mkdir(source);
    try {
      // Sparse files test the preflight boundary without allocating or copying
      // a customer's multi-gigabyte database; inventory only stats these files.
      await writeFile(database, "");
      await writeFile(wal, "");
      await truncate(database, 17 * 1024 ** 3);
      await truncate(wal, 1024 ** 3);
      const accepted = runMigrator(python, ["inventory", "--source-data", source]);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(JSON.parse(accepted.stdout).database_bytes, 18 * 1024 ** 3);

      await truncate(database, 32 * 1024 ** 3);
      const refused = runMigrator(python, ["inventory", "--source-data", source]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /database_too_large/);
      assert.match(refused.stderr, /limit_bytes=34359738368/);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("fails closed on dropped content, wrong ownership, and unexpected credentials", () => {
    const result = spawnSync(python, [VALIDATION_FIXTURE], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "ok");
    assert.doesNotMatch(result.stdout + result.stderr, /secret|duplicate text/);
  });

  it("activates a real pinned conversion with exact message, session, and watermark projections", async () => {
    const seedSource = join(sandbox, "message-seed-source");
    const seedRoot = join(sandbox, "message-seed-root");
    await mkdir(seedSource, { recursive: true });
    const seed = runMigrator(python, [
      "prepare",
      "--root",
      seedRoot,
      "--source-data",
      seedSource,
      "--v2-bin",
      V2_BIN,
      "--target-version",
      TARGET_VERSION,
      "--timeout",
      "30",
    ]);
    assert.equal(seed.status, 0, seed.stderr);
    const seedGeneration = JSON.parse(seed.stdout).generation;
    const seedDatabase = join(seedRoot, "generations", seedGeneration, "data", "opencode", "opencode.db");

    const source = join(sandbox, "message-source");
    const sourceDatabase = join(source, "opencode.db");
    await mkdir(source, { recursive: true });
    await copyFile(seedDatabase, sourceDatabase);
    const setup = [
      "import json, sqlite3, sys",
      "c = sqlite3.connect(sys.argv[1])",
      "c.executescript(\"\"\"",
      "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);",
      "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);",
      "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);",
      "DELETE FROM kv WHERE key = 'migration.v1-v2';",
      "DELETE FROM migration WHERE id = '20260805200742_import_legacy_credentials';",
      "\"\"\")",
      "c.execute(\"INSERT INTO session (id, project_id, slug, directory, title, version, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\", ('ses_review', 'missing-project', 'review', '/tmp/review', 'Review', '1', json.dumps({'keep': True}), 99, 98, 97, 96, 95, 94, json.dumps({'messageID': 'old'}), json.dumps([{'permission': '*', 'pattern': '*', 'action': 'deny'}]), 1, 2, 3, 4))",
      "message_id = 'msg_000000000040aaaaaaaaaaaaaa'",
      "c.execute('INSERT INTO message VALUES (?,?,?,?,?)', (message_id, 'ses_review', 10, 11, sys.argv[2]))",
      "c.execute('INSERT INTO part VALUES (?,?,?,?,?,?)', ('prt_review', message_id, 'ses_review', 10, 11, sys.argv[3]))",
      "c.commit()",
      "c.close()",
    ].join("\n");
    const setupResult = spawnSync(
      python,
      [
        "-c",
        setup,
        sourceDatabase,
        JSON.stringify({
          role: "user",
          time: { created: 10 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        }),
        JSON.stringify({ type: "text", text: "hello" }),
      ],
      { encoding: "utf8" },
    );
    assert.equal(setupResult.status, 0, setupResult.stderr);
    const auth = join(source, "auth.json");
    await writeFile(
      auth,
      JSON.stringify({
        "anthropic/": { type: "api", key: "e2e-auth-secret", metadata: { region: "us" } },
        openai: {
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: 10,
          accountId: "account",
          enterpriseUrl: "https://enterprise",
        },
        "builtin/": { type: "wellknown", key: "origin", token: "wellknown-token" },
      }),
    );
    const sourceBefore = hash(await readFile(sourceDatabase));
    const authBefore = hash(await readFile(auth));

    const root = join(sandbox, "message-v2");
    const result = runMigrator(python, [
      "prepare",
      "--root",
      root,
      "--source-data",
      source,
      "--v2-bin",
      V2_BIN,
      "--target-version",
      TARGET_VERSION,
      "--timeout",
      "30",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /e2e-auth-secret|wellknown-token/);
    assert.equal(hash(await readFile(sourceDatabase)), sourceBefore);
    assert.equal(hash(await readFile(auth)), authBefore);

    const generation = JSON.parse(result.stdout).generation;
    const database = join(root, "generations", generation, "data", "opencode", "opencode.db");
    const inspect = spawnSync(
      python,
      [
        "-c",
        [
          "import json,sqlite3,sys",
          "c=sqlite3.connect(sys.argv[1])",
          "message=c.execute(\"SELECT type,data FROM session_message WHERE id='msg_000000000040aaaaaaaaaaaaaa'\").fetchone()",
          "session=c.execute(\"SELECT project_id,metadata,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,revert,permission,agent,model,time_created,time_updated,time_compacting,time_archived,fork_session_id,fork_boundary,time_idle,time_viewed,idle_outcome,time_suspended,resume_attempts FROM session_v2 WHERE id='ses_review'\").fetchone()",
          "sequence=c.execute(\"SELECT seq,owner_id FROM event_sequence WHERE aggregate_id='ses_review'\").fetchone()",
          "credentials=c.execute('SELECT count(*) FROM credential').fetchone()[0]",
          "print(json.dumps([[message[0],json.loads(message[1])],[session[0],json.loads(session[1]),*session[2:9],json.loads(session[9]),session[10],json.loads(session[11]),*session[12:]],[*sequence],credentials]))",
          "c.close()",
        ].join("; "),
        database,
      ],
      { encoding: "utf8" },
    );
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.deepEqual(JSON.parse(inspect.stdout), [
      ["user", { text: "hello", time: { created: 10 } }],
      [
        "global",
        { keep: true },
        0,
        0,
        0,
        0,
        0,
        0,
        null,
        [{ action: "*", resource: "*", effect: "deny" }],
        "build",
        { id: "claude", providerID: "anthropic", variant: "default" },
        1,
        2,
        null,
        4,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
      ],
      [0, null],
      0,
    ]);
  });

  it("ignores hardlinked credential input without reading it", async () => {
    const source = join(sandbox, "hardlink-source");
    const auth = join(source, "auth.json");
    await mkdir(source, { recursive: true });
    await writeFile(auth, JSON.stringify({ test: { type: "api", key: AUTH_SECRET } }));
    await link(auth, join(sandbox, "hardlinked-auth.json"));

    const result = runMigrator(python, ["inventory", "--source-data", source]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).provider_auth, false);
    assert.doesNotMatch(result.stderr, new RegExp(AUTH_SECRET));
  });

  it("ignores auth-only V1 input without disclosing or changing it", async () => {
    const source = join(sandbox, "auth-only-source");
    const root = join(sandbox, "auth-only-v2");
    const auth = join(source, "auth.json");
    await mkdir(source, { recursive: true });
    await writeFile(auth, JSON.stringify({ anthropic: { type: "api", key: AUTH_SECRET } }));
    const sourceBefore = hash(await readFile(auth));

    const result = runMigrator(python, [
      "prepare",
      "--root",
      root,
      "--source-data",
      source,
      "--v2-bin",
      V2_BIN,
      "--target-version",
      TARGET_VERSION,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(AUTH_SECRET));
    const journalText = await readFile(join(root, "migration.json"), "utf8");
    const journal = JSON.parse(journalText);
    assert.equal(journal.status, "activated");
    assert.equal(journal.source.provider_auth, false);
    assert.equal(journal.source.provider_auth_count, 0);
    assert.equal(journal.target.provider_auth_count, 0);
    assert.doesNotMatch(journalText, new RegExp(AUTH_SECRET));
    assert.equal(hash(await readFile(auth)), sourceBefore);
    const database = join(root, "generations", journal.generation, "data", "opencode", "opencode.db");
    assert.equal(sqliteTableCounts(python, database).credential, 0);
  });

  it("rejects orphan SQLite sidecars instead of activating empty state", async () => {
    const source = join(sandbox, "orphan-sidecar-source");
    const root = join(sandbox, "orphan-sidecar-v2");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "opencode.db-wal"), "not-a-standalone-database");

    const result = runMigrator(python, [
      "prepare",
      "--root",
      root,
      "--source-data",
      source,
      "--v2-bin",
      V2_BIN,
      "--target-version",
      TARGET_VERSION,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /orphan_database_sidecar/);
    await assert.rejects(readFile(join(root, "current")));
  });

  it("activates one idempotent private generation for a fresh install", async () => {
    const source = join(sandbox, "fresh-source");
    const root = join(sandbox, "v2");
    const orphanWork = "0".repeat(32);
    const staleProbe = ".runtime-probe.deadbeef";
    await mkdir(source, { recursive: true });
    await Promise.all([
      mkdir(join(root, "work", orphanWork), { recursive: true }),
      mkdir(join(root, "work", staleProbe), { recursive: true }),
      mkdir(join(root, "generations"), { recursive: true }),
    ]);
    await writeFile(join(root, "work", orphanWork, "credential-copy"), AUTH_SECRET);
    await writeFile(join(root, "work", staleProbe, "probe-copy"), AUTH_SECRET);
    const args = [
      "prepare",
      "--root",
      root,
      "--source-data",
      source,
      "--v2-bin",
      V2_BIN,
      "--target-version",
      TARGET_VERSION,
      "--timeout",
      "30",
    ];

    const first = runMigrator(python, args);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, new RegExp(AUTH_SECRET));
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.status, "activated");
    assert.match(firstResult.generation, /^[a-f0-9]{32}$/);

    const current = (await readFile(join(root, "current"), "utf8")).trim();
    assert.equal(current, firstResult.generation);
    const generation = join(root, "generations", current);
    const journalText = await readFile(join(root, "migration.json"), "utf8");
    const journal = JSON.parse(journalText);
    assert.equal(journal.status, "activated");
    assert.equal(journal.source.provider_auth, false);
    assert.equal(journal.source.provider_auth_count, 0);
    assert.equal(journal.source.session_count, 0);
    assert.equal(journal.source.message_count, 0);
    assert.equal(journal.source.part_count, 0);
    assert.equal(journal.source.content_part_count, 0);
    assert.equal(journal.target.provider_auth_count, 0);
    assert.equal(journal.target.session_count, 0);
    assert.equal(journal.target.message_count, 0);
    assert.equal(journal.target.validated_content_part_count, 0);
    assert.doesNotMatch(journalText, new RegExp(AUTH_SECRET));
    const database = join(generation, "data", "opencode", "opencode.db");
    await readFile(database);
    const counts = sqliteTableCounts(python, database);
    assert.ok(counts.migration > 0);
    assert.equal(counts.credential, 0);
    assert.equal(counts.session_v2, 0);
    assert.deepEqual(await readdir(join(root, "generations")), [current]);

    const addCredential = spawnSync(
      python,
      [
        "-c",
        "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); info=c.execute('pragma table_info(credential)').fetchall(); base={'id':'v2-auth','integration_id':'anthropic','label':'API key','value':json.dumps({'type':'key','key':sys.argv[2]}),'connector_id':None,'method_id':None}; cols=[r[1] for r in info]; vals=[base[n] if n in base else (0 if r[3] and 'INT' in r[2].upper() else '' if r[3] else None) for r,n in zip(info,cols)]; c.execute(f\"insert into credential ({','.join(cols)}) values ({','.join('?'*len(cols))})\",vals); c.commit(); c.close()",
        database,
        AUTH_SECRET,
      ],
      { encoding: "utf8" },
    );
    assert.equal(addCredential.status, 0, addCredential.stderr);

    await rm(join(root, "migration.json"));
    const second = runMigrator(python, args);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), {
      status: "already_activated",
      generation: current,
    });
    const repairedJournal = JSON.parse(await readFile(join(root, "migration.json"), "utf8"));
    assert.equal(repairedJournal.status, "activated");
    assert.equal(repairedJournal.generation, current);
    assert.equal(sqliteTableCounts(python, database).credential, 1);
    assert.deepEqual(await readdir(join(root, "generations")), [current]);
    assert.deepEqual(await readdir(join(root, "work")), [".migration.lock"]);

    const incompatibleArgs = [...args];
    incompatibleArgs[incompatibleArgs.indexOf("--target-version") + 1] = "0.0.0-beta-incompatible";
    const incompatible = runMigrator(python, incompatibleArgs);
    assert.equal(incompatible.status, 1);
    assert.match(incompatible.stderr, /target_version_mismatch/);
    assert.equal((await readFile(join(root, "current"), "utf8")).trim(), current);
    assert.deepEqual(await readdir(join(root, "generations")), [current]);
  });

  it("does not replace unidentified existing generations with a fresh empty installation", async () => {
    const root = join(sandbox, "missing-current");
    const existing = join(root, "generations", "1".repeat(32));
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "database-copy"), AUTH_SECRET);
    const result = runMigrator(python, ["prepare", "--root", root, "--source-data", join(sandbox, "no-source"),
      "--v2-bin", V2_BIN, "--target-version", TARGET_VERSION]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /generations_present_without_current/);
    assert.equal(await readFile(join(existing, "database-copy"), "utf8"), AUTH_SECRET);
    await assert.rejects(readFile(join(root, "current")), { code: "ENOENT" });
  });

  it("preserves failed-upgrade input and keeps only validated active state after a successful forward upgrade", async () => {
    const root = join(sandbox, "upgrade-v2");
    const source = join(sandbox, "upgrade-v1");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), AUTH_SECRET);
    const previousArgs = ["prepare", "--root", root, "--source-data", source,
      "--v2-bin", PREVIOUS_BIN, "--target-version", PREVIOUS_VERSION, "--timeout", "30"];
    const initial = runMigrator(python, previousArgs);
    assert.equal(initial.status, 0, initial.stderr);
    const previous = JSON.parse(initial.stdout).generation;
    const previousRoot = join(root, "generations", previous);
    const database = join(previousRoot, "data", "opencode", "opencode.db");
    const seed = spawnSync(python, ["-c", [
      "import json,sqlite3,sys",
      "c=sqlite3.connect(sys.argv[1])",
      "c.execute(\"INSERT OR IGNORE INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?)\", ('global','/',1,1,'[]'))",
      "c.execute(\"INSERT INTO credential (id,integration_id,label,value,time_created,time_updated) VALUES (?,?,?,?,?,?)\", ('v2-auth','anthropic','API key',json.dumps({'type':'key','key':sys.argv[2]}),1,1))",
      "c.execute(\"INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated,permission) VALUES (?,?,?,?,?,?,?,?,?)\", ('ses_upgrade','global','upgrade','/tmp/upgrade','Preserved conversation','2',1,2,json.dumps([{'action':'shell','resource':'*','effect':'deny'}])))",
      "c.execute(\"INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)\", ('msg_upgrade','ses_upgrade','user',0,1,2,json.dumps({'text':'Keep this conversation','time':{'created':1}})))",
      "c.commit()", "c.close()",
    ].join("; "), database, AUTH_SECRET], { encoding: "utf8" });
    assert.equal(seed.status, 0, seed.stderr);
    await writeFile(join(previousRoot, "state", "retained-state"), "keep me");
    const before = hash(await readFile(database));
    const markerBefore = await readFile(join(previousRoot, "generation.json"), "utf8");
    const args = ["prepare", "--root", root, "--source-data", source,
      "--v2-bin", V2_BIN, "--target-version", TARGET_VERSION, "--timeout", "30"];

    const failing = [...args];
    failing[failing.indexOf("--v2-bin") + 1] = join(sandbox, "missing-runtime");
    const failed = runMigrator(python, failing);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /missing_v2_runtime/);
    assert.equal((await readFile(join(root, "current"), "utf8")).trim(), previous);
    assert.equal(hash(await readFile(database)), before);
    assert.equal(await readFile(join(previousRoot, "generation.json"), "utf8"), markerBefore);

    const upgraded = runMigrator(python, args);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.doesNotMatch(upgraded.stdout + upgraded.stderr, new RegExp(AUTH_SECRET));
    const result = JSON.parse(upgraded.stdout);
    assert.equal(result.status, "upgraded");
    assert.notEqual(result.generation, previous);
    const current = join(root, "generations", result.generation);
    assert.equal(sqliteTableCounts(python, join(current, "data", "opencode", "opencode.db")).credential, 1);
    assert.equal(sqliteTableCounts(python, join(current, "data", "opencode", "opencode.db")).session_message, 1);
    assert.equal(await readFile(join(current, "state", "retained-state"), "utf8"), "keep me");
    await assert.rejects(readFile(database), { code: "ENOENT" });
    assert.equal(await readFile(join(source, "auth.json"), "utf8"), AUTH_SECRET);
    const marker = JSON.parse(await readFile(join(current, "generation.json"), "utf8"));
    assert.equal(marker.previous_generation, undefined);
    assert.equal(marker.target_version, TARGET_VERSION);

    const restarted = runMigrator(python, args);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).generation, result.generation);
    assert.deepEqual(await readdir(join(root, "generations")), [result.generation]);
    const downgrade = runMigrator(python, previousArgs);
    assert.equal(downgrade.status, 1);
    assert.match(downgrade.stderr, /target_version_mismatch/);
    assert.equal((await readFile(join(root, "current"), "utf8")).trim(), result.generation);
  });
});
