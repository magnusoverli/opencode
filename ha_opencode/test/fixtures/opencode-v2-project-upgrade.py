#!/usr/bin/env python3
"""Exercise converter startup maintenance using only synthetic project state."""

import importlib.util
from pathlib import Path
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


def expect_mismatch(before, after):
    try:
        MIGRATOR.validate_v2_upgrade(before, after)
    except MIGRATOR.MigrationError as error:
        assert error.code == "v2_upgrade_records_changed", error.code
    else:
        raise AssertionError("changed user records were accepted")


def qualify(binary):
    with tempfile.TemporaryDirectory(prefix="opencode-v2-project-upgrade-") as temporary:
        root = Path(temporary)
        candidate = root / "candidate"
        for leaf in ("home", "config", "data", "state", "cache"):
            (candidate / leaf).mkdir(parents=True)
        MIGRATOR.convert_candidate(candidate, binary, 30, None)
        database = candidate / "data/opencode/opencode.db"
        connection = sqlite3.connect(database)
        # Missing paths reproduce the app's runtime-only workspace being absent
        # while its private upgrade copy is checked. Existing archives stay set.
        for project, directory, archived in (
            ("missing", str(root / "unavailable"), None),
            ("available", str(root), None),
            ("archived", str(root / "archived"), 123),
        ):
            connection.execute(
                "INSERT INTO project (id,worktree,name,time_created,time_updated,time_active,time_archived,sandboxes) "
                "VALUES (?,?,?,1,2,3,?,'[]')",
                (project, directory, "Retained project", archived),
            )
        connection.commit()
        connection.close()
        baseline = root / "before.db"
        MIGRATOR.snapshot_database(database, baseline)
        baseline_bytes = baseline.read_bytes()

        MIGRATOR.convert_candidate(candidate, binary, 30, None)
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT time_archived FROM project WHERE id='missing'"
            ).fetchone()[0] is not None, "real converter did not exercise startup archive sweep"
        expect_mismatch(baseline, database)
        MIGRATOR.restore_project_maintenance(baseline, database)
        MIGRATOR.validate_database(database)
        MIGRATOR.validate_v2_upgrade(baseline, database)
        assert baseline.read_bytes() == baseline_bytes

        # The sweep can also adopt a surviving main checkout. Restore only its
        # placement/archive fields; names, timestamps and records stay checked.
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE project SET worktree='/synthetic-replacement' WHERE id='missing'")
        MIGRATOR.restore_project_maintenance(baseline, database)
        MIGRATOR.validate_v2_upgrade(baseline, database)
        for statement in (
            "UPDATE project SET name='Changed' WHERE id='missing'",
            "UPDATE project SET time_updated=999 WHERE id='missing'",
            "DELETE FROM project WHERE id='missing'",
        ):
            with sqlite3.connect(database) as connection:
                connection.execute(statement)
                connection.commit()
            MIGRATOR.restore_project_maintenance(baseline, database)
            expect_mismatch(baseline, database)
            # Restore the synthetic baseline for the next independent injection.
            with sqlite3.connect(baseline.resolve().as_uri() + "?mode=ro", uri=True) as source:
                with sqlite3.connect(database) as target:
                    source.backup(target)
        MIGRATOR.validate_v2_upgrade(baseline, database)


if __name__ == "__main__":
    qualify(Path(sys.argv[1]).resolve())
    print("ok")
