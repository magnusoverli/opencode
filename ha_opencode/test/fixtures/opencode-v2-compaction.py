#!/usr/bin/env python3
"""Qualify compaction projection against the actual pinned V2 converter."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


sys.dont_write_bytecode = True
ADDON_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "opencode_v2_migrate", ADDON_ROOT / "rootfs/usr/local/bin/opencode-v2-migrate.py"
)
MIGRATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATOR)


def expect_mismatch(callback):
    try:
        callback()
    except MIGRATOR.MigrationError as error:
        assert error.code == "message_projection_mismatch", error.code
    else:
        raise AssertionError("corrupted compaction was accepted")


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def qualify(binary, version):
    with tempfile.TemporaryDirectory(prefix="opencode-v2-compaction-") as temporary:
        root = Path(temporary)
        source = root / "source"
        source.mkdir()

        def args(destination):
            return argparse.Namespace(
                root=destination, source_data=source, retained_root=[],
                v2_bin=binary, runtime_user=None, target_version=version, timeout=30,
            )

        # Obtain the pinned runtime's native schema, as in the Node migration
        # integration test, then add synthetic V1 tables for its real converter.
        seed_root = root / "seed"
        seed = MIGRATOR.prepare(args(seed_root))
        source_database = source / "opencode.db"
        shutil.copyfile(
            seed_root / "generations" / seed["generation"] / "data/opencode/opencode.db",
            source_database,
        )
        connection = sqlite3.connect(source_database)
        try:
            connection.executescript("""
                CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
                CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
                CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
                DELETE FROM kv WHERE key = 'migration.v1-v2';
                DELETE FROM migration WHERE id = '20260805200742_import_legacy_credentials';
            """)
            expected = {}
            for index, (auto, retained) in enumerate(((True, True), (True, False), (False, True), (False, False))):
                session = f"ses_compaction_{index}"
                connection.execute(
                    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
                    (session, "global", session, "/homeassistant", "Compaction fixture", "1", 1, 5),
                )
                ids = [f"msg_{index * 10 + offset:012d}aaaaaaaaaaaaaa" for offset in range(1, 5)]
                user, assistant, compact, summary = ids
                for offset, message in enumerate(ids, 1):
                    value = {
                        "role": "user", "time": {"created": offset}, "agent": "build",
                        "model": {"providerID": "fixture", "modelID": "fixture"},
                    }
                    if message in (assistant, summary):
                        value = {
                            "role": "assistant", "time": {"created": offset, "completed": offset + 1},
                            "parentID": user if message == assistant else compact,
                            "modelID": "fixture", "providerID": "fixture", "agent": "build",
                            "mode": "build" if message == assistant else "compaction",
                            "path": {"cwd": "/homeassistant", "root": "/homeassistant"},
                            "cost": 0,
                            "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                            **({"summary": True} if message == summary else {}),
                        }
                    connection.execute("INSERT INTO message VALUES (?,?,?,?,?)", (message, session, offset, offset + 1, json.dumps(value)))
                for offset, (message, part) in enumerate((
                    (user, {"type": "text", "text": "question"}),
                    (assistant, {"type": "text", "text": "answer"}),
                    (compact, {"type": "compaction", "auto": auto, **({"tail_start_id": user} if retained else {})}),
                    (summary, {"type": "text", "text": "summary"}),
                )):
                    connection.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (f"prt_{index}_{offset}", message, session, 1, 2, json.dumps(part)))
                expected[compact] = {
                    "status": "completed", "reason": "auto" if auto else "manual", "summary": "summary",
                    **({"metadata": {"recent": "[User]: question\n\n[Assistant]: answer"}} if retained else {}),
                    "time": {"created": 3},
                }
            connection.commit()
        finally:
            connection.close()

        before = fingerprint(source_database)
        destination = root / "migration"
        result = MIGRATOR.prepare(args(destination))
        assert result["status"] == "activated"
        assert result["target"]["session_count"] == 4
        assert result["target"]["message_count"] == 12
        assert result["target"]["validated_content_part_count"] == 12
        assert fingerprint(source_database) == before
        target_database = destination / "generations" / result["generation"] / "data/opencode/opencode.db"
        target = sqlite3.connect(target_database)
        try:
            actual = {
                message: json.loads(raw)
                for message, raw in target.execute("SELECT id,data FROM session_message WHERE type='compaction'")
            }
            assert actual == expected
            for message, original in expected.items():
                mutations = [
                    {**original, "summary": "changed"},
                    {key: value for key, value in original.items() if key != "summary"},
                    {**original, "reason": "manual" if original["reason"] == "auto" else "auto"},
                    {**original, "recent": original.get("metadata", {}).get("recent", "")},
                    {**original, "metadata": {"recent": "changed"}},
                    {**original, "metadata": {"recent": ""}},
                    {**original, "metadata": {}},
                ]
                if "metadata" in original:
                    mutations.append({key: value for key, value in original.items() if key != "metadata"})
                    mutations.append({
                        **{key: value for key, value in original.items() if key != "metadata"},
                        "recent": original["metadata"]["recent"],
                    })
                for changed in mutations:
                    target.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(changed), message))
                    target.commit()
                    expect_mismatch(lambda: MIGRATOR.validate_session_projection(source_database, target_database))
                target.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(original), message))
                target.commit()
        finally:
            target.close()
        assert MIGRATOR.validate_session_projection(source_database, target_database) == (4, 12, 12)

        # Simulate a validation failure before activation, then retry from the
        # unchanged V1 data. A failed migration journal must not block recovery.
        retry_root = root / "retry"
        converter = MIGRATOR.convert_candidate

        def corrupted_conversion(candidate, *arguments):
            converter(candidate, *arguments)
            database = sqlite3.connect(candidate / "data/opencode/opencode.db")
            try:
                message = next(iter(expected))
                changed = {**expected[message], "metadata": {"recent": "changed"}}
                database.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(changed), message))
                database.commit()
            finally:
                database.close()

        MIGRATOR.convert_candidate = corrupted_conversion
        try:
            expect_mismatch(lambda: MIGRATOR.prepare(args(retry_root)))
        finally:
            MIGRATOR.convert_candidate = converter
        assert json.loads((retry_root / "migration.json").read_text())["status"] == "failed"
        assert not (retry_root / "current").exists()
        assert not list((retry_root / "generations").iterdir())
        assert fingerprint(source_database) == before
        assert MIGRATOR.prepare(args(retry_root))["status"] == "activated"
        restarted = MIGRATOR.prepare(args(destination))
        assert restarted["status"] == "already_activated"
        assert restarted["generation"] == result["generation"]
        assert fingerprint(source_database) == before


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("version")
    options = parser.parse_args()
    qualify(options.binary.resolve(), options.version)
    print("ok")
