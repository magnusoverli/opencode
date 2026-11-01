#!/usr/bin/env python3
"""Read-only path diagnostics; run without root or an installed native runtime."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
from types import SimpleNamespace
import stat

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / "rootfs/usr/local/bin"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PathDiagnostics(unittest.TestCase):
    def test_diagnose_does_not_create_missing_roots_or_read_unknown_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "absent"
            command = [sys.executable, "-B", str(SOURCE / "opencode-v2-migrate.py"), "diagnose",
                       "--root", str(root), "--source-data", str(Path(temporary) / "source")]
            result = subprocess.run(command, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(root.exists())
            self.assertEqual(list(Path(temporary).iterdir()), [])
            work = root / "work"
            unknown = work / "unified_original_interval_v2_validation_compat_2"
            unknown.mkdir(parents=True)
            (root / "generations").mkdir()
            (unknown / "private").write_text("PRIVATE-CONTENT")
            result = subprocess.run(command, text=True, capture_output=True, timeout=5)
            self.assertIn(unknown.name, result.stdout)
            self.assertNotIn("PRIVATE-CONTENT", result.stdout + result.stderr)
            self.assertEqual((unknown / "private").read_text(), "PRIVATE-CONTENT")
            self.assertFalse((root / "migration.json").exists())
            self.assertFalse((work / ".migration.lock").exists())

    def test_only_bounded_root_owned_directory_variants_are_repairable(self):
        state = load("opencode-v2-tui-state")
        def info(uid, gid, mode):
            return SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFDIR | mode)
        self.assertTrue(state.repairable_directory(info(0, 0, 0o700), 60001, 60001, 0o700))
        self.assertTrue(state.repairable_directory(info(0, 0, 0o750), 0, 60001, 0o1770))
        self.assertTrue(state.repairable_directory(info(0, 60001, 0o1750), 0, 60001, 0o1770))
        self.assertTrue(state.repairable_directory(info(0, 60001, 0o750), 0, 60001, 0o1770))
        self.assertFalse(state.repairable_directory(info(0, 60001, 0o1770), 0, 60001, 0o1770))
        for uid, gid, mode in ((1000, 1000, 0o700), (0, 0, 0o777), (0, 1234, 0o750), (0, 0, 0o1777)):
            self.assertFalse(state.repairable_directory(info(uid, gid, mode), 60001, 60001, 0o700))

    def test_directory_type_failure_names_path_without_content(self):
        migration = load("opencode-v2-migrate")
        with tempfile.TemporaryDirectory() as temporary:
            invalid = Path(temporary) / "home"
            invalid.write_text("PRIVATE-CONTENT")
            with self.assertRaises(migration.MigrationError) as raised:
                migration.ensure_plain_directory(invalid)
            self.assertIn("expected=directory", raised.exception.details)
            self.assertIn("type=file", raised.exception.details)
            self.assertTrue(any("home" in item for item in raised.exception.details))
            self.assertNotIn("PRIVATE-CONTENT", str(raised.exception.details))
            self.assertEqual(invalid.read_text(), "PRIVATE-CONTENT")

    def test_file_type_failure_does_not_follow_symlink(self):
        migration = load("opencode-v2-migrate")
        with tempfile.TemporaryDirectory() as temporary:
            link = Path(temporary) / "current"
            link.symlink_to("PRIVATE-TARGET")
            with self.assertRaises(migration.MigrationError) as raised:
                migration.ensure_plain_file(link)
            self.assertIn("type=symlink", raised.exception.details)
            self.assertNotIn("PRIVATE-TARGET", str(raised.exception.details))
            self.assertTrue(link.is_symlink())

    def test_control_characters_and_long_names_are_bounded(self):
        migration = load("opencode-v2-migrate")
        with tempfile.TemporaryDirectory() as temporary:
            invalid = Path(temporary) / ("\x1b[31m" + "x" * 160)
            invalid.write_text("PRIVATE")
            with self.assertRaises(migration.MigrationError) as raised:
                migration.ensure_plain_directory(invalid)
            details = " ".join(raised.exception.details)
            self.assertNotIn("\x1b", details)
            self.assertLess(len(details), 512)

    def test_tui_failure_has_expected_and_observed_identity(self):
        state = load("opencode-v2-tui-state")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config"
            path.mkdir(mode=0o700)
            with self.assertRaises(ValueError) as raised:
                state.directory(path, 60001, 60001, 0o1770)
            message = str(raised.exception)
            self.assertIn("config", message)
            self.assertIn("expected=directory", message)
            self.assertIn("mode=0700", message)
            self.assertIn("expected_mode=1770", message)


if __name__ == "__main__":
    unittest.main()
