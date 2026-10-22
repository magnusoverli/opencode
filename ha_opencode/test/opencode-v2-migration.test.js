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
const TARGET_VERSION = "2.1.2";
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
      "c.execute(\"INSERT INTO session (id, project_id, slug, directory, title, version, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\", ('ses_review', 'missing-project', 'review', '/homeassistant', 'Review', '1', json.dumps({'keep': True}), 99, 98, 97, 96, 95, 94, json.dumps({'messageID': 'old'}), json.dumps([{'permission': '*', 'pattern': '*', 'action': 'deny'}]), 1, 2, 3, 4))",
      "message_id = 'msg_000000000040aaaaaaaaaaaaaa'",
      "assistant_id = 'msg_000000000041aaaaaaaaaaaaaa'",
      "c.execute('INSERT INTO message VALUES (?,?,?,?,?)', (message_id, 'ses_review', 10, 11, sys.argv[2]))",
      "c.execute('INSERT INTO message VALUES (?,?,?,?,?)', (assistant_id, 'ses_review', 20, 21, sys.argv[4]))",
      "c.execute('INSERT INTO part VALUES (?,?,?,?,?,?)', ('prt_review', message_id, 'ses_review', 10, 11, sys.argv[3]))",
      "c.execute('INSERT INTO part VALUES (?,?,?,?,?,?)', ('prt_tool', assistant_id, 'ses_review', 20, 21, sys.argv[5]))",
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
        JSON.stringify({
          role: "assistant",
          time: { created: 20, completed: 21 },
          parentID: "msg_000000000040aaaaaaaaaaaaaa",
          modelID: "claude",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/review", root: "/tmp/review" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        JSON.stringify({
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/tmp/review/test.txt" },
            output: "fixture",
            title: "Read",
            metadata: {},
            time: { start: 20, end: 21 },
          },
        }),
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
    const prepareArgs = [
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
    const result = runMigrator(python, prepareArgs);
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
          "placement=c.execute(\"SELECT project_id,directory FROM session_v2 WHERE id='ses_review'\").fetchone()",
          "notice=c.execute(\"SELECT type,data FROM session_message WHERE session_id='ses_review' AND type='system'\").fetchone()",
          "credentials=c.execute('SELECT count(*) FROM credential').fetchone()[0]",
          "print(json.dumps([[message[0],json.loads(message[1])],[session[0],json.loads(session[1]),*session[2:9],json.loads(session[9]),session[10],json.loads(session[11]),*session[12:]],[*sequence],[*placement],[notice[0],json.loads(notice[1])],credentials]))",
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
        "4367e1ff78860babd3300c32613d92cb06a1125b",
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
      [2, null],
      ["4367e1ff78860babd3300c32613d92cb06a1125b", "/run/opencode-v2/workspace"],
      [
        "system",
        {
          text: "The available tools have changed.\n\nThe `read` tool now takes `path` instead of `filePath`.",
          time: { created: 20 },
        },
      ],
      0,
    ]);

    const generationMarker = join(root, "generations", generation, "generation.json");
    const marker = JSON.parse(await readFile(generationMarker, "utf8"));
    delete marker.workspace_projection;
    await writeFile(generationMarker, JSON.stringify(marker));
    const regressPlacement = spawnSync(
      python,
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE session_v2 SET project_id='global',directory='/homeassistant' WHERE id='ses_review'\"); c.commit(); c.close()",
        database,
      ],
      { encoding: "utf8" },
    );
    assert.equal(regressPlacement.status, 0, regressPlacement.stderr);

    const repair = runMigrator(python, prepareArgs);
    assert.equal(repair.status, 0, repair.stderr);
    const repairedGeneration = JSON.parse(repair.stdout).generation;
    assert.notEqual(repairedGeneration, generation);
    assert.equal(JSON.parse(repair.stdout).status, "repaired");
    assert.deepEqual(await readdir(join(root, "generations")), [repairedGeneration]);
    const repairedDatabase = join(root, "generations", repairedGeneration, "data", "opencode", "opencode.db");
    const repairedPlacement = spawnSync(
      python,
      [
        "-c",
        "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(\"SELECT project_id,directory FROM session_v2 WHERE id='ses_review'\").fetchone())); c.close()",
        repairedDatabase,
      ],
      { encoding: "utf8" },
    );
    assert.equal(repairedPlacement.status, 0, repairedPlacement.stderr);
    assert.deepEqual(JSON.parse(repairedPlacement.stdout), [
      "4367e1ff78860babd3300c32613d92cb06a1125b",
      "/run/opencode-v2/workspace",
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

    let current = (await readFile(join(root, "current"), "utf8")).trim();
    assert.equal(current, firstResult.generation);
    let generation = join(root, "generations", current);
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
    let database = join(generation, "data", "opencode", "opencode.db");
    await readFile(database);
    const counts = sqliteTableCounts(python, database);
    assert.ok(counts.migration > 0);
    assert.equal(counts.credential, 0);
    assert.equal(counts.session_v2, 0);
    assert.deepEqual(await readdir(join(root, "generations")), [current]);

    const markerPath = join(generation, "generation.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    delete marker.workspace_projection;
    await writeFile(markerPath, JSON.stringify(marker));
    const repair = runMigrator(python, args);
    assert.equal(repair.status, 0, repair.stderr);
    const repairResult = JSON.parse(repair.stdout);
    assert.equal(repairResult.status, "repaired");
    assert.notEqual(repairResult.generation, current);
    current = repairResult.generation;
    generation = join(root, "generations", current);
    database = join(generation, "data", "opencode", "opencode.db");
    assert.deepEqual(await readdir(join(root, "generations")), [current]);
    assert.equal(sqliteTableCounts(python, database).session_v2, 0);

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

  it("repairs only a missing converter home and rejects missing persistent state", async () => {
    const root = join(sandbox, "missing-home");
    const args = ["prepare", "--root", root, "--source-data", join(sandbox, "absent-home-source"),
      "--v2-bin", V2_BIN, "--target-version", TARGET_VERSION, "--timeout", "30"];
    const initial = runMigrator(python, args);
    assert.equal(initial.status, 0, initial.stderr);
    const old = join(root, "generations", JSON.parse(initial.stdout).generation);
    const before = hash(await readFile(join(old, "data", "opencode", "opencode.db")));
    await writeFile(join(old, "state", "retained"), "keep state");
    await rm(join(old, "home"), { recursive: true });
    // Keep the workspace marker: scaffold repair must not depend on its absence.
    const repaired = runMigrator(python, args);
    assert.equal(repaired.status, 0, repaired.stderr);
    const result = JSON.parse(repaired.stdout);
    assert.equal(result.status, "repaired");
    const current = join(root, "generations", result.generation);
    assert.deepEqual(await readdir(join(current, "home")), []);
    assert.equal(await readFile(join(current, "state", "retained"), "utf8"), "keep state");
    assert.equal(hash(await readFile(join(current, "data", "opencode", "opencode.db"))), before);
    const restarted = runMigrator(python, args);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), { status: "already_activated", generation: result.generation });

    await rm(join(current, "home"), { recursive: true });
    await writeFile(join(current, "home"), "not a directory");
    const invalidHome = runMigrator(python, args);
    assert.equal(invalidHome.status, 1);
    assert.match(invalidHome.stderr, /unsafe_path_type/);
    assert.equal(await readFile(join(current, "home"), "utf8"), "not a directory");
    await rm(join(current, "home"));
    await rm(join(current, "state"), { recursive: true });
    const missingState = runMigrator(python, args);
    assert.equal(missingState.status, 1);
    assert.match(missingState.stderr, /missing_generation_state.*state/);
    assert.equal((await readFile(join(root, "current"), "utf8")).trim(), result.generation);
    assert.equal(hash(await readFile(join(current, "data", "opencode", "opencode.db"))), before);
    assert.deepEqual(await readdir(join(root, "work")), [".migration.lock"]);
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

  for (const [version, binary] of [[PREVIOUS_VERSION, PREVIOUS_BIN],
    ["2.0.13", join(ADDON_ROOT, "rootfs/opt/opencode-v2-homeassistant/node_modules/opencode-previous/bin/opencode.exe")],
    ["2.0.22", join(ADDON_ROOT, "rootfs/opt/opencode-v2-homeassistant/node_modules/opencode-beta-previous/bin/opencode.exe")],
    ["2.0.26", join(ADDON_ROOT, "rootfs/opt/opencode-v2-homeassistant/node_modules/opencode-upgrade-previous/bin/opencode.exe")]]) {
  it(`preserves failed-upgrade input and validated state when upgrading ${version}`, async () => {
    const root = join(sandbox, `upgrade-v2-${version}`);
    const source = join(sandbox, `upgrade-v1-${version}`);
    await mkdir(source);
    await writeFile(join(source, "auth.json"), AUTH_SECRET);
    const previousArgs = ["prepare", "--root", root, "--source-data", source,
      "--v2-bin", binary, "--target-version", version, "--timeout", "30"];
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
      "c.execute(\"INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated,permission) VALUES (?,?,?,?,?,?,?,?,?)\", ('ses_upgrade','global','upgrade','/homeassistant','Preserved conversation','2',1,2,json.dumps([{'action':'shell','resource':'*','effect':'deny'}])))",
      "c.execute(\"INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)\", ('ses_other','global','other','/tmp/other','Other project','2',3,4))",
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
    assert.equal(marker.workspace_projection, "/run/opencode-v2/workspace");
    assert.equal(marker.target.relocated_session_count, 1);
    const placement = spawnSync(python, ["-c", [
      "import json,sqlite3,sys",
      "c=sqlite3.connect(sys.argv[1])",
      "print(json.dumps(c.execute('SELECT id,project_id,directory,permission FROM session_v2 ORDER BY id').fetchall()))",
      "c.close()",
    ].join("; "), join(current, "data", "opencode", "opencode.db")], { encoding: "utf8" });
    assert.equal(placement.status, 0, placement.stderr);
    const sessions = JSON.parse(placement.stdout);
    assert.deepEqual(sessions[0], ["ses_other", "global", "/tmp/other", null]);
    assert.deepEqual(sessions[1].slice(0, 3), [
      "ses_upgrade", "4367e1ff78860babd3300c32613d92cb06a1125b", "/run/opencode-v2/workspace",
    ]);
    assert.deepEqual(JSON.parse(sessions[1][3]), [{ action: "shell", resource: "*", effect: "deny" }]);

    const restarted = runMigrator(python, args);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).generation, result.generation);
    assert.deepEqual(await readdir(join(root, "generations")), [result.generation]);
    const downgrade = runMigrator(python, previousArgs);
    assert.equal(downgrade.status, 1);
    assert.match(downgrade.stderr, /target_version_mismatch/);
    assert.equal((await readFile(join(root, "current"), "utf8")).trim(), result.generation);
  });
  }
});
