#!/usr/bin/env python3
"""Seed/verify synthetic state for a stopped devcontainer beta app upgrade."""

import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import sys


mode, data_path, evidence_path = sys.argv[1:]
root = Path(data_path) / "v2"
evidence = Path(evidence_path)
generation = (root / "current").read_text().strip()
directory = root / "generations" / generation
database = directory / "data" / "opencode" / "opencode.db"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if mode == "seed":
    connection = sqlite3.connect(database)
    try:
        assert connection.execute("SELECT count(*) FROM session_v2").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM credential").fetchone()[0] == 0
        credential = json.dumps({"type": "key", "key": secrets.token_hex(32)})
        connection.execute(
            "INSERT OR IGNORE INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?)",
            ("global", "/", 1, 1, "[]"),
        )
        connection.execute(
            "INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated,permission) VALUES (?,?,?,?,?,?,?,?,?)",
            ("ses_upgrade_acceptance", "global", "upgrade-acceptance", "/homeassistant", "Upgrade acceptance", "2", 1, 2,
             json.dumps([{"action": "shell", "resource": "*", "effect": "deny"}])),
        )
        connection.execute(
            "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
            ("msg_upgrade_acceptance", "ses_upgrade_acceptance", "user", 0, 1, 2,
             json.dumps({"text": "Retain this devcontainer conversation", "time": {"created": 1}})),
        )
        connection.execute(
            "INSERT INTO credential (id,integration_id,label,value,time_created,time_updated) VALUES (?,?,?,?,?,?)",
            ("upgrade-fixture", "upgrade-fixture", "Synthetic upgrade fixture", credential, 1, 1),
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchone() is None
        connection.commit()
    finally:
        connection.close()
    evidence.write_text(json.dumps({
        "generation": generation,
        "database_hash": digest(database),
        "marker_hash": digest(directory / "generation.json"),
        "credential_hash": hashlib.sha256(credential.encode()).hexdigest(),
    }))
    evidence.chmod(0o600)
    print("Seeded synthetic conversation, credential, and session restriction in the earlier beta generation")
elif mode == "verify":
    expected = json.loads(evidence.read_text())
    assert generation != expected["generation"]
    previous = root / "generations" / expected["generation"]
    assert not previous.exists()
    marker = json.loads((directory / "generation.json").read_text())
    assert "previous_generation" not in marker
    assert marker["target_version"] == "2.0.21"
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        credential = connection.execute("SELECT value FROM credential WHERE id='upgrade-fixture'").fetchone()[0]
        assert hashlib.sha256(credential.encode()).hexdigest() == expected["credential_hash"]
        message = connection.execute("SELECT data FROM session_message WHERE id='msg_upgrade_acceptance'").fetchone()[0]
        assert json.loads(message)["text"] == "Retain this devcontainer conversation"
        permission = connection.execute("SELECT permission FROM session_v2 WHERE id='ses_upgrade_acceptance'").fetchone()[0]
        assert json.loads(permission) == [{"action": "shell", "resource": "*", "effect": "deny"}]
    finally:
        connection.close()
    print("Verified upgraded conversation, credential, session restriction, and removal of obsolete generations")
else:
    raise SystemExit("Expected seed or verify")
