#!/usr/bin/env python3
"""Exercise exact pinned V1-to-V2 projection checks with SQLite fixtures."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile


sys.dont_write_bytecode = True
ADDON_ROOT = Path(__file__).resolve().parents[2]
MIGRATOR_PATH = ADDON_ROOT / "rootfs" / "usr" / "local" / "bin" / "opencode-v2-migrate.py"
SPEC = importlib.util.spec_from_file_location("opencode_v2_migrate", MIGRATOR_PATH)
MIGRATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATOR)


def expect_error(code, callback):
    try:
        callback()
    except MIGRATOR.MigrationError as error:
        if error.code != code:
            raise AssertionError(f"expected {code}, got {error.code}") from error
    else:
        raise AssertionError(f"expected {code}")


def user_message():
    return {
        "role": "user",
        "time": {"created": 999},
        "agent": "build",
        "model": {"providerID": "provider", "modelID": "model"},
    }


def assistant_message(parent_id, **overrides):
    value = {
        "role": "assistant",
        "time": {"created": 998, "completed": 997},
        "parentID": parent_id,
        "modelID": "model",
        "providerID": "provider",
        "mode": "build",
        "agent": "build",
        "path": {"cwd": "/tmp/test", "root": "/tmp/test"},
        "cost": 1,
        "tokens": {
            "total": 10,
            "input": 2,
            "output": 3,
            "reasoning": 4,
            "cache": {"read": 5, "write": 6},
        },
    }
    value.update(overrides)
    return value


def add_message(connection, message_id, session_id, created, value):
    connection.execute(
        "INSERT INTO message VALUES (?,?,?,?,?)",
        (message_id, session_id, created, created + 1, json.dumps(value)),
    )


def add_part(connection, part_id, message_id, session_id, value):
    connection.execute(
        "INSERT INTO part VALUES (?,?,?,?,?,?)",
        (part_id, message_id, session_id, 1, 2, json.dumps(value)),
    )


def add_target(connection, message_id, session_id, kind, sequence, created, data, updated=None):
    assert "id" not in data and "type" not in data
    connection.execute(
        "INSERT INTO session_message VALUES (?,?,?,?,?,?,?)",
        (message_id, session_id, kind, sequence, created, created + 1 if updated is None else updated, json.dumps(data)),
    )


def target_data(connection, message_id):
    return json.loads(connection.execute("SELECT data FROM session_message WHERE id=?", (message_id,)).fetchone()[0])


def set_target_data(connection, message_id, value):
    connection.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(value), message_id))
    connection.commit()


def add_session(connection, session_id, **overrides):
    value = {
        "id": session_id,
        "project_id": "global",
        "workspace_id": f"workspace-{session_id}",
        "parent_id": None,
        "slug": session_id,
        "directory": f"/tmp/{session_id}",
        "path": f"path/{session_id}",
        "title": f"Title {session_id}",
        "version": "1",
        "share_url": f"https://share.invalid/{session_id}",
        "summary_additions": 1,
        "summary_deletions": 2,
        "summary_files": 3,
        "summary_diffs": json.dumps([{"file": f"{session_id}.txt"}]),
        "metadata": json.dumps({"session": session_id}),
        "cost": 99,
        "tokens_input": 98,
        "tokens_output": 97,
        "tokens_reasoning": 96,
        "tokens_cache_read": 95,
        "tokens_cache_write": 94,
        "revert": json.dumps({"messageID": "old"}),
        "permission": json.dumps([{"permission": "*", "pattern": "*", "action": "deny"}]),
        "agent": None,
        "model": None,
        "time_created": 100,
        "time_updated": 101,
        "time_compacting": 102,
        "time_archived": 103,
    }
    value.update(overrides)
    columns = MIGRATOR.SOURCE_SESSION_COLUMNS
    connection.execute(
        f"INSERT INTO session ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        tuple(value[column] for column in columns),
    )
    return value


def add_target_session(connection, source, *, project_id=None, **projection):
    value = {
        **source,
        "project_id": source["project_id"] if project_id is None else project_id,
        "cost": 0,
        "tokens_input": 0,
        "tokens_output": 0,
        "tokens_reasoning": 0,
        "tokens_cache_read": 0,
        "tokens_cache_write": 0,
        "revert": None,
        "time_compacting": None,
    }
    value.update(projection)
    if isinstance(value["model"], dict):
        value["model"] = json.dumps(value["model"])
    columns = MIGRATOR.SOURCE_SESSION_COLUMNS
    connection.execute(
        f"INSERT INTO session_v2 ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        tuple(value[column] for column in columns),
    )
    return value


with tempfile.TemporaryDirectory(prefix="opencode-v2-validation-") as temporary:
    source_path = Path(temporary) / "source.db"
    target_path = Path(temporary) / "target.db"
    source = sqlite3.connect(source_path)
    target = sqlite3.connect(target_path)
    try:
        source.executescript(
            """
            CREATE TABLE project (id TEXT PRIMARY KEY);
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                workspace_id TEXT,
                parent_id TEXT,
                slug TEXT NOT NULL,
                directory TEXT NOT NULL,
                path TEXT,
                title TEXT,
                version TEXT NOT NULL,
                share_url TEXT,
                summary_additions INTEGER,
                summary_deletions INTEGER,
                summary_files INTEGER,
                summary_diffs TEXT,
                metadata TEXT,
                cost REAL NOT NULL,
                tokens_input INTEGER NOT NULL,
                tokens_output INTEGER NOT NULL,
                tokens_reasoning INTEGER NOT NULL,
                tokens_cache_read INTEGER NOT NULL,
                tokens_cache_write INTEGER NOT NULL,
                revert TEXT,
                permission TEXT,
                agent TEXT,
                model TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_compacting INTEGER,
                time_archived INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
            """
        )
        target.executescript(
            """
            CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                workspace_id TEXT,
                parent_id TEXT,
                fork_session_id TEXT,
                fork_boundary TEXT,
                slug TEXT NOT NULL,
                directory TEXT NOT NULL,
                path TEXT,
                title TEXT,
                version TEXT NOT NULL,
                share_url TEXT,
                summary_additions INTEGER,
                summary_deletions INTEGER,
                summary_files INTEGER,
                summary_diffs TEXT,
                metadata TEXT,
                cost REAL NOT NULL,
                tokens_input INTEGER NOT NULL,
                tokens_output INTEGER NOT NULL,
                tokens_reasoning INTEGER NOT NULL,
                tokens_cache_read INTEGER NOT NULL,
                tokens_cache_write INTEGER NOT NULL,
                revert TEXT,
                permission TEXT,
                agent TEXT,
                model TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_idle INTEGER,
                time_viewed INTEGER,
                idle_outcome TEXT,
                time_compacting INTEGER,
                time_archived INTEGER,
                time_suspended INTEGER,
                resume_attempts INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE event_sequence (
                aggregate_id TEXT PRIMARY KEY,
                seq INTEGER NOT NULL,
                owner_id TEXT
            );
            CREATE TABLE credential (
                id TEXT PRIMARY KEY,
                integration_id TEXT,
                label TEXT NOT NULL,
                value TEXT NOT NULL,
                connector_id TEXT,
                method_id TEXT
            );
            CREATE TABLE kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
            """
        )
        source.execute("INSERT INTO project VALUES ('global')")
        source.execute("INSERT INTO project VALUES ('project-known')")

        # User projection: exact file conversion, external placeholders, mentions,
        # and an adjacent deterministic synthetic row.
        user_session = "ses_user"
        user_id = "msg_000000000004aaaaaaaaaaaaaa"
        synthetic_id = "msg_000000000004ST20Jh98kGJtjL"
        user_source = add_session(
            source,
            user_session,
            project_id="project-known",
            agent="preserved-agent",
            model=json.dumps({"id": "selected", "providerID": "selected-provider", "variant": "selected"}),
        )
        add_message(source, user_id, user_session, 2, user_message())
        add_part(source, "usr_01", user_id, user_session, {"type": "text", "text": "prompt"})
        add_part(source, "usr_02", user_id, user_session, {"type": "text", "text": "hidden", "synthetic": True})
        add_part(
            source,
            "usr_03",
            user_id,
            user_session,
            {"type": "file", "mime": "text/plain", "filename": "inline.txt", "url": "data:text/plain,hello%20world"},
        )
        add_part(
            source,
            "usr_04",
            user_id,
            user_session,
            {"type": "file", "mime": "text/plain", "filename": "missing.txt", "url": "file:///missing.txt"},
        )
        add_part(
            source,
            "usr_05",
            user_id,
            user_session,
            {"type": "agent", "name": "review", "source": {"value": "@review", "start": 2, "end": 9}},
        )
        user_target = {
            "text": "prompt\n\n[Attachment unavailable after migration: missing.txt (text/plain)]",
            "files": [
                {
                    "data": "aGVsbG8gd29ybGQ=",
                    "mime": "text/plain",
                    "source": {"type": "inline"},
                    "name": "inline.txt",
                }
            ],
            "agents": [{"name": "review", "mention": {"text": "@review", "start": 2, "end": 9}}],
            "time": {"created": 2},
        }
        add_target(target, user_id, user_session, "user", 0, 2, user_target)
        add_target(target, synthetic_id, user_session, "synthetic", 1, 2, {"text": "hidden", "time": {"created": 2}})

        # Assistant projection: interrupted tools, complete attachments, compacted
        # output, partial error output, snapshots, usage, finish, and mapped error.
        tool_session = "ses_tools"
        parent_id = "msg_000000000008aaaaaaaaaaaaaa"
        assistant_id = "msg_000000000009aaaaaaaaaaaaaa"
        tool_source = add_session(source, tool_session, project_id="missing-project")
        add_message(source, parent_id, tool_session, 10, user_message())
        add_message(
            source,
            assistant_id,
            tool_session,
            20,
            assistant_message(
                parent_id,
                variant="fast",
                finish="new-provider-value",
                cost=2.5,
                error={"name": "ProviderAuthError", "data": {"providerID": "provider", "message": "auth"}},
            ),
        )
        add_part(source, "tool_01", assistant_id, tool_session, {"type": "tool", "callID": "pending", "tool": "read", "state": {"status": "pending", "input": {"a": 1}, "raw": "{}"}})
        add_part(source, "tool_02", assistant_id, tool_session, {"type": "tool", "callID": "running", "tool": "read", "state": {"status": "running", "input": {"b": 2}, "metadata": {"phase": "read"}, "time": {"start": 30}}})
        add_part(
            source,
            "tool_03",
            assistant_id,
            tool_session,
            {
                "type": "tool",
                "callID": "completed",
                "tool": "read",
                "metadata": {"provider": True},
                "state": {
                    "status": "completed",
                    "input": {"c": 3},
                    "output": "done",
                    "title": "Read",
                    "metadata": {"result": True},
                    "time": {"start": 31, "end": 32},
                    "attachments": [{"type": "file", "mime": "text/plain", "filename": "out.txt", "url": "file:///out.txt"}],
                },
            },
        )
        add_part(source, "tool_04", assistant_id, tool_session, {"type": "tool", "callID": "compacted", "tool": "read", "state": {"status": "completed", "input": {}, "output": "secret", "title": "Read", "metadata": {}, "time": {"start": 33, "end": 34, "compacted": 35}, "attachments": []}})
        add_part(source, "tool_05", assistant_id, tool_session, {"type": "tool", "callID": "failed", "tool": "read", "state": {"status": "error", "input": {"e": 5}, "error": "boom", "metadata": {"output": "partial"}, "time": {"start": 36, "end": 37}}})
        add_part(source, "tool_06", assistant_id, tool_session, {"type": "reasoning", "text": "think", "metadata": {"provider": 1}, "time": {"start": 21, "end": 22}})
        add_part(source, "tool_07", assistant_id, tool_session, {"type": "text", "text": "answer", "metadata": {"separator": True}})
        add_part(source, "tool_08", assistant_id, tool_session, {"type": "step-start", "snapshot": "snap_start"})
        add_part(source, "tool_09", assistant_id, tool_session, {"type": "patch", "hash": "snap_patch", "files": ["a.ts", "b.ts"]})
        add_part(source, "tool_10", assistant_id, tool_session, {"type": "step-finish", "reason": "stop", "snapshot": "snap_end", "cost": 99, "tokens": {"input": 99, "output": 99, "reasoning": 99, "cache": {"read": 99, "write": 99}}})
        add_target(target, parent_id, tool_session, "user", 0, 10, {"text": "", "time": {"created": 10}})
        assistant_target = {
            "agent": "build",
            "model": {"providerID": "provider", "id": "model", "variant": "fast"},
            "content": [
                {"type": "tool", "id": "pending", "name": "read", "state": {"status": "error", "input": {"a": 1}, "error": {"type": "tool.interrupted", "message": "Tool execution was interrupted before V2 migration"}}, "time": {"created": 20}},
                {"type": "tool", "id": "running", "name": "read", "state": {"status": "error", "input": {"b": 2}, "error": {"type": "tool.interrupted", "message": "Tool execution was interrupted before V2 migration"}, "metadata": {"phase": "read"}}, "time": {"created": 30}},
                {"type": "tool", "id": "completed", "name": "read", "providerState": {"provider": True}, "state": {"status": "completed", "input": {"c": 3}, "content": [{"type": "text", "text": "done"}, {"type": "file", "uri": "file:///out.txt", "mime": "text/plain", "name": "out.txt"}], "metadata": {"result": True}}, "time": {"created": 31, "completed": 32}},
                {"type": "tool", "id": "compacted", "name": "read", "state": {"status": "completed", "input": {}, "content": [{"type": "text", "text": "[Old tool result content cleared]"}], "metadata": {}}, "time": {"created": 33, "completed": 34}},
                {"type": "tool", "id": "failed", "name": "read", "state": {"status": "error", "input": {"e": 5}, "error": {"type": "tool.execution", "message": "boom"}, "content": [{"type": "text", "text": "partial"}], "metadata": {"output": "partial"}}, "time": {"created": 36, "completed": 37}},
                {"type": "reasoning", "text": "think", "state": {"provider": 1}, "time": {"created": 21, "completed": 22}},
                {"type": "text", "text": "answer", "state": {"separator": True}},
            ],
            "snapshot": {"start": "snap_start", "end": "snap_end", "files": ["a.ts", "b.ts"]},
            "finish": "unknown",
            "cost": 2.5,
            "tokens": {"input": 2, "output": 3, "reasoning": 4, "cache": {"read": 5, "write": 6}},
            "error": {"type": "provider.auth", "message": "auth"},
            "time": {"created": 20, "completed": 21},
        }
        add_target(target, assistant_id, tool_session, "assistant", 1, 20, assistant_target)

        # Subtask-only traffic is intentionally omitted.
        subtask_session = "ses_subtask"
        subtask_id = "msg_000000000020aaaaaaaaaaaaaa"
        task_id = "msg_000000000021aaaaaaaaaaaaaa"
        subtask_source = add_session(source, subtask_session)
        add_message(source, subtask_id, subtask_session, 1, user_message())
        add_message(source, task_id, subtask_session, 2, assistant_message(subtask_id))
        add_part(source, "sub_01", subtask_id, subtask_session, {"type": "subtask", "prompt": "work", "description": "work", "agent": "build"})
        add_part(source, "sub_02", task_id, subtask_session, {"type": "tool", "callID": "task", "tool": "task", "state": {"status": "pending", "input": {}, "raw": "{}"}})

        # A user/summary pair collapses into one compaction while its retained
        # tail remains as ordinary messages.
        compaction_session = "ses_compaction"
        tail_user = "msg_000000000025aaaaaaaaaaaaaa"
        tail_assistant = "msg_000000000026aaaaaaaaaaaaaa"
        compact_id = "msg_000000000027aaaaaaaaaaaaaa"
        summary_id = "msg_000000000028aaaaaaaaaaaaaa"
        compaction_source = add_session(source, compaction_session)
        add_message(source, tail_user, compaction_session, 1, user_message())
        add_message(source, tail_assistant, compaction_session, 2, assistant_message(tail_user))
        add_message(source, compact_id, compaction_session, 3, user_message())
        add_message(source, summary_id, compaction_session, 4, assistant_message(compact_id, summary=True))
        add_part(source, "cmp_01", tail_user, compaction_session, {"type": "text", "text": "question"})
        add_part(source, "cmp_02", tail_assistant, compaction_session, {"type": "text", "text": "answer"})
        add_part(source, "cmp_03", compact_id, compaction_session, {"type": "compaction", "auto": True, "tail_start_id": tail_user})
        add_part(source, "cmp_04", summary_id, compaction_session, {"type": "text", "text": "summary"})
        add_target(target, tail_user, compaction_session, "user", 0, 1, {"text": "question", "time": {"created": 1}})
        add_target(
            target,
            tail_assistant,
            compaction_session,
            "assistant",
            1,
            2,
            {
                "agent": "build",
                "model": {"providerID": "provider", "id": "model", "variant": "default"},
                "content": [{"type": "text", "text": "answer"}],
                "cost": 1,
                "tokens": {"input": 2, "output": 3, "reasoning": 4, "cache": {"read": 5, "write": 6}},
                "time": {"created": 2, "completed": 3},
            },
        )
        add_target(
            target,
            compact_id,
            compaction_session,
            "compaction",
            2,
            3,
            {
                "status": "completed",
                "reason": "auto",
                "summary": "summary",
                "recent": "[User]: question\n\n[Assistant]: answer",
                "time": {"created": 3},
            },
            updated=5,
        )

        add_target_session(
            target,
            user_source,
            agent="preserved-agent",
            model={"id": "selected", "providerID": "selected-provider", "variant": "selected"},
        )
        add_target_session(
            target,
            tool_source,
            project_id="global",
            agent="build",
            model={"id": "model", "providerID": "provider", "variant": "default"},
            cost=2.5,
            tokens_input=2,
            tokens_output=3,
            tokens_reasoning=4,
            tokens_cache_read=5,
            tokens_cache_write=6,
        )
        add_target_session(
            target,
            subtask_source,
            cost=1,
            tokens_input=2,
            tokens_output=3,
            tokens_reasoning=4,
            tokens_cache_read=5,
            tokens_cache_write=6,
        )
        add_target_session(
            target,
            compaction_source,
            agent="build",
            model={"id": "model", "providerID": "provider", "variant": "default"},
            cost=2,
            tokens_input=4,
            tokens_output=6,
            tokens_reasoning=8,
            tokens_cache_read=10,
            tokens_cache_write=12,
        )
        for session_id, watermark in (
            (user_session, 1),
            (tool_session, 1),
            (subtask_session, -1),
            (compaction_session, 2),
        ):
            target.execute(
                "INSERT INTO event_sequence VALUES (?,?,NULL)",
                (session_id, watermark),
            )

        source.execute(
            "INSERT INTO kv VALUES (?,?,?,?)",
            ("wellknown:sources", json.dumps(["existing", 1]), 1, 1),
        )
        credentials = {
            "anthropic/": {"type": "api", "key": "credential-sentinel", "metadata": {"region": "us"}},
            "openai": {"type": "oauth", "refresh": "refresh", "access": "access", "expires": 10, "accountId": "account", "enterpriseUrl": "https://enterprise"},
            "opencode": {"type": "oauth", "refresh": "device-refresh", "access": "device-access", "expires": 20},
            "builtin/": {"type": "wellknown", "key": "origin-key", "token": "wellknown-token"},
        }
        credential_rows = [
            ("cred_api", "anthropic", "API key", {"type": "key", "key": "credential-sentinel", "metadata": {"region": "us"}}),
            ("cred_openai", "openai", "OAuth", {"type": "oauth", "methodID": "chatgpt-browser", "refresh": "refresh", "access": "access", "expires": 10, "metadata": {"accountID": "account", "enterpriseUrl": "https://enterprise"}}),
            ("cred_device", "opencode", "OAuth", {"type": "oauth", "methodID": "device", "refresh": "device-refresh", "access": "device-access", "expires": 20}),
            ("cred_builtin", "builtin", "API key", {"type": "key", "key": "wellknown-token"}),
        ]
        for credential_id, integration_id, label, value in credential_rows:
            target.execute(
                "INSERT INTO credential VALUES (?,?,?,?,?,?)",
                (credential_id, integration_id, label, json.dumps(value), None, None),
            )
        target.execute(
            "INSERT INTO kv VALUES (?,?,?,?)",
            ("wellknown:sources", json.dumps(["existing", "builtin"]), 1, 1),
        )
        source.commit()
        target.commit()

        expected_parts = 17
        source_before = source_path.read_bytes()
        assert MIGRATOR.synthetic_id(user_id, {user_id}) == synthetic_id
        assert MIGRATOR.source_content_part_count(source_path) == expected_parts
        assert MIGRATOR.validate_session_projection(source_path, target_path) == (4, 7, expected_parts)
        assert MIGRATOR.validate_credentials(target_path, credentials, source_path) == 4
        assert source_path.read_bytes() == source_before

        # Every copied or transformed session field is checked against the same
        # decoded source rows used to validate its projected messages.
        session_mutations = {
            "project_id": "wrong-project",
            "workspace_id": "wrong-workspace",
            "parent_id": "wrong-parent",
            "fork_session_id": "wrong-fork",
            "fork_boundary": json.dumps({"messageID": "wrong"}),
            "slug": "wrong-slug",
            "directory": "/wrong",
            "path": "wrong/path",
            "title": "Wrong title",
            "version": "wrong-version",
            "share_url": "https://wrong.invalid",
            "summary_additions": 9,
            "summary_deletions": 9,
            "summary_files": 9,
            "summary_diffs": json.dumps([]),
            "metadata": json.dumps({"wrong": True}),
            "permission": json.dumps([]),
            "agent": "wrong-agent",
            "model": json.dumps({"id": "wrong", "providerID": "wrong"}),
            "cost": 1,
            "tokens_input": 1,
            "tokens_output": 1,
            "tokens_reasoning": 1,
            "tokens_cache_read": 1,
            "tokens_cache_write": 1,
            "revert": json.dumps({}),
            "time_created": 1,
            "time_updated": 1,
            "time_idle": 1,
            "time_viewed": 1,
            "idle_outcome": "wrong-outcome",
            "time_compacting": 1,
            "time_archived": 1,
            "time_suspended": 1,
            "resume_attempts": 1,
        }
        for column, changed in session_mutations.items():
            original = target.execute(
                f"SELECT {column} FROM session_v2 WHERE id=?", (user_session,)
            ).fetchone()[0]
            target.execute(
                f"UPDATE session_v2 SET {column}=? WHERE id=?", (changed, user_session)
            )
            target.commit()
            expect_error(
                "session_projection_mismatch",
                lambda: MIGRATOR.validate_session_projection(source_path, target_path),
            )
            target.execute(
                f"UPDATE session_v2 SET {column}=? WHERE id=?", (original, user_session)
            )
            target.commit()

        target.execute(
            "UPDATE event_sequence SET seq=99 WHERE aggregate_id=?", (user_session,)
        )
        target.commit()
        expect_error(
            "event_sequence_mismatch",
            lambda: MIGRATOR.validate_session_projection(source_path, target_path),
        )
        target.execute(
            "UPDATE event_sequence SET seq=1, owner_id='wrong' WHERE aggregate_id=?",
            (user_session,),
        )
        target.commit()
        expect_error(
            "event_sequence_mismatch",
            lambda: MIGRATOR.validate_session_projection(source_path, target_path),
        )
        target.execute(
            "UPDATE event_sequence SET owner_id=NULL WHERE aggregate_id=?", (user_session,)
        )
        target.commit()

        # Persisted message data must not duplicate SQL-owned identity fields.
        value = target_data(target, user_id)
        value["type"] = "user"
        set_target_data(target, user_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, user_id, user_target)

        value = target_data(target, user_id)
        value.pop("files")
        set_target_data(target, user_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, user_id, user_target)

        value = target_data(target, assistant_id)
        value["content"][2]["state"]["content"].pop()
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        value = target_data(target, assistant_id)
        value["content"][0]["state"] = {"status": "streaming", "input": "{}"}
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        value = target_data(target, assistant_id)
        value["content"][3]["state"]["content"] = [{"type": "text", "text": "secret"}]
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        value = target_data(target, assistant_id)
        value["content"][4]["state"].pop("content")
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        value = target_data(target, assistant_id)
        value.pop("error")
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        value = target_data(target, assistant_id)
        value.pop("agent")
        set_target_data(target, assistant_id, value)
        expect_error("message_projection_mismatch", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        set_target_data(target, assistant_id, assistant_target)

        original_part = source.execute("SELECT data FROM part WHERE id='tool_07'").fetchone()[0]
        source.execute("UPDATE part SET data=? WHERE id='tool_07'", (json.dumps({"type": "future"}),))
        source.commit()
        expect_error("invalid_source_part", lambda: MIGRATOR.validate_session_projection(source_path, target_path))
        source.execute("UPDATE part SET data=? WHERE id='tool_07'", (original_part,))
        source.commit()

        # Exact credential root values, method, integration ownership, and KV
        # origin mapping all fail closed when independently corrupted.
        original_api = target.execute("SELECT value FROM credential WHERE id='cred_api'").fetchone()[0]
        target.execute(
            "UPDATE credential SET value=? WHERE id='cred_api'",
            (json.dumps({"type": "key", "key": "wrong", "metadata": {"key": "credential-sentinel", "metadata": {"region": "us"}}}),),
        )
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE credential SET value=? WHERE id='cred_api'", (original_api,))

        target.execute("UPDATE credential SET integration_id='wrong', label='anthropic' WHERE id='cred_api'")
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE credential SET integration_id='anthropic', label='API key' WHERE id='cred_api'")

        original_oauth = target.execute("SELECT value FROM credential WHERE id='cred_openai'").fetchone()[0]
        value = json.loads(original_oauth)
        value["methodID"] = "oauth"
        target.execute("UPDATE credential SET value=? WHERE id='cred_openai'", (json.dumps(value),))
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE credential SET value=? WHERE id='cred_openai'", (original_oauth,))

        value = json.loads(original_oauth)
        value["metadata"] = {"accountId": "account", "enterpriseUrl": "https://enterprise"}
        target.execute("UPDATE credential SET value=? WHERE id='cred_openai'", (json.dumps(value),))
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE credential SET value=? WHERE id='cred_openai'", (original_oauth,))

        original_builtin = target.execute("SELECT value FROM credential WHERE id='cred_builtin'").fetchone()[0]
        target.execute(
            "UPDATE credential SET value=? WHERE id='cred_builtin'",
            (json.dumps({"type": "key", "key": "origin-key"}),),
        )
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE credential SET value=? WHERE id='cred_builtin'", (original_builtin,))

        target.execute("UPDATE kv SET value=? WHERE key='wellknown:sources'", (json.dumps(["existing"]),))
        target.commit()
        expect_error("provider_auth_mismatch", lambda: MIGRATOR.validate_credentials(target_path, credentials, source_path))
        target.execute("UPDATE kv SET value=? WHERE key='wellknown:sources'", (json.dumps(["existing", "builtin"]),))
        target.commit()
        assert MIGRATOR.validate_credentials(target_path, credentials, source_path) == 4

        auth_source = Path(temporary) / "auth.json"
        auth_target = Path(temporary) / "auth-copy.json"
        auth_source.write_text(json.dumps(credentials), encoding="utf-8")
        assert MIGRATOR.copy_provider_auth(auth_source, auth_target) == credentials
        invalid_auth = Path(temporary) / "invalid-auth.json"
        invalid_auth.write_text(json.dumps({"provider": {"type": "api", "key": "secret", "metadata": {"bad": 1}}}), encoding="utf-8")
        expect_error("invalid_provider_auth", lambda: MIGRATOR.read_provider_auth(invalid_auth))
        empty_provider = Path(temporary) / "empty-provider.json"
        empty_provider.write_text(
            json.dumps({"///": {"type": "api", "key": "secret"}}), encoding="utf-8"
        )
        expect_error("invalid_provider_auth_id", lambda: MIGRATOR.read_provider_auth(empty_provider))
        colliding_providers = Path(temporary) / "colliding-providers.json"
        colliding_providers.write_text(
            json.dumps(
                {
                    "provider": {"type": "api", "key": "first"},
                    "provider/": {"type": "api", "key": "second"},
                }
            ),
            encoding="utf-8",
        )
        expect_error(
            "provider_auth_id_collision",
            lambda: MIGRATOR.read_provider_auth(colliding_providers),
        )
    finally:
        source.close()
        target.close()

    candidate = Path(temporary) / "candidate"
    (candidate / "cache").mkdir(parents=True)
    snapshot_path = Path(temporary) / "snapshot.db"
    validation_path = Path(temporary) / "validation.db"
    source_before = source_path.read_bytes()
    MIGRATOR.cold_snapshot(
        {"database": source_path},
        candidate,
        snapshot_path,
        validation_path,
    )
    assert snapshot_path.is_file()
    assert validation_path.is_file()
    assert source_path.read_bytes() == source_before

print("ok")
