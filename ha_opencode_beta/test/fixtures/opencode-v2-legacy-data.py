import importlib.util
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[2] / "rootfs/usr/local/bin/opencode-legacy-data.py"
spec = importlib.util.spec_from_file_location("legacy", source)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class LegacyData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cache = self.root / ".cache/opencode"
        self.cache.mkdir(parents=True)
        (self.cache / "entry").write_text("disposable")
        self.user = self.root / ".config/opencode/agents"
        self.user.mkdir(parents=True)
        (self.user / "mine.md").write_text("USER_CONTENT_NEVER_PRINT")
        self.original = self.root / ".local/share/opencode"
        self.original.mkdir(parents=True)
        (self.original / "auth.json").write_text("SECRET_NEVER_PRINT")
        (self.root / "v2/work").mkdir(parents=True)
        current = "a" * 32
        self.active = self.root / "v2/generations" / current
        (self.active / "data/opencode").mkdir(parents=True)
        with closing(sqlite3.connect(self.active / "data/opencode/opencode.db")) as db:
            db.execute("create table evidence (value text)")
            db.commit()
        (self.root / "v2/current").write_text(current)
        (self.active / "generation.json").write_text(json.dumps({
            "format": legacy.migration_module().FORMAT, "generation": current,
            "status": "validated", "target_version": "2.3.0",
        }))

    def review(self):
        return legacy.snapshot(self.cache)["revision"]

    def test_metadata_only_and_unknown_not_empty(self):
        result = legacy.inspect(self.root)
        text = json.dumps(result)
        self.assertNotIn("SECRET_NEVER_PRINT", text)
        self.assertNotIn("USER_CONTENT_NEVER_PRINT", text)
        self.assertTrue(result["items"][0]["quarantine_supported"])
        self.assertFalse(result["items"][0]["cleanup_supported"])
        self.assertFalse(result["items"][3]["cleanup_supported"])
        self.assertFalse(result["items"][3]["quarantine_supported"])
        (self.root / "v2/current").write_text("invalid")
        result = legacy.inspect(self.root)
        self.assertEqual(result["active_v2"]["status"], "unverified")
        self.assertFalse(result["items"][0]["cleanup_supported"])
        self.assertFalse(result["items"][0]["quarantine_supported"])

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux cleanup")
    def test_quarantine_preserves_cache_original_and_active_data(self):
        database = self.active / "data/opencode/opencode.db"
        before = database.read_bytes()
        result = legacy.quarantine_cache(self.root, self.review(), in_use=lambda _: False)
        self.assertEqual(result["status"], "quarantined")
        self.assertEqual(result["bytes_reclaimed"], 0)
        self.assertEqual((Path(result["quarantine_path"]) / "entry").read_text(), "disposable")
        self.assertFalse(self.cache.exists())
        self.assertEqual(database.read_bytes(), before)
        self.assertEqual((self.original / "auth.json").read_text(), "SECRET_NEVER_PRINT")
        self.assertEqual((self.user / "mine.md").read_text(), "USER_CONTENT_NEVER_PRINT")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux cleanup")
    def test_stale_in_use_and_missing_active_state_refused(self):
        review = self.review()
        (self.cache / "entry").write_text("changed")
        with self.assertRaisesRegex(ValueError, "cache_changed"):
            legacy.clean_cache(self.root, review, in_use=lambda _: False)
        with self.assertRaisesRegex(ValueError, "in_use"):
            legacy.clean_cache(self.root, self.review(), in_use=lambda _: True)
        (self.root / "v2/current").unlink()
        with self.assertRaises(ValueError):
            legacy.clean_cache(self.root, self.review(), in_use=lambda _: False)
        self.assertTrue(self.cache.exists())

    @unittest.skipUnless(sys.platform == "linux", "Linux links")
    def test_symlink_hardlink_and_unknown_sizes(self):
        link = self.cache / "linked"
        link.symlink_to(self.user)
        item = legacy.inspect(self.root)["items"][0]
        self.assertEqual(item["status"], "unverified")
        self.assertNotIn("bytes", item)
        self.assertFalse(item["cleanup_supported"])
        self.assertFalse(item["quarantine_supported"])
        link.unlink()
        os.link(self.cache / "entry", link)
        self.assertEqual(legacy.inspect(self.root)["items"][0]["status"], "unverified")

    @unittest.skipUnless(sys.platform == "linux", "Linux mount evidence")
    def test_same_device_nested_mount_is_not_a_cleanup_target(self):
        nested = self.cache / "bind"
        nested.mkdir()
        (nested / "unrelated").write_text("keep")
        with mock.patch.object(legacy, "open", return_value=io.StringIO(
                f"1 1 0:1 / {nested} rw - tmpfs tmpfs rw\n"), create=True):
            with self.assertRaisesRegex(ValueError, "nested_mount"):
                legacy.snapshot(self.cache)
        self.assertEqual((nested / "unrelated").read_text(), "keep")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux process evidence")
    def test_actual_open_cache_file_is_in_use(self):
        with (self.cache / "entry").open():
            self.assertTrue(legacy.cache_in_use(self.cache))

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux cleanup")
    def test_post_quarantine_change_is_retained(self):
        calls = []
        def racing(path):
            calls.append(path)
            if len(calls) == 2:
                (path / "entry").write_text("writer still active")
                return True
            return False
        with self.assertRaisesRegex(ValueError, "quarantined"):
            legacy.clean_cache(self.root, self.review(), in_use=racing)
        retired = list((self.root / ".cache").glob(".opencode-retired-*"))
        self.assertEqual(len(retired), 1)
        self.assertEqual((retired[0] / "entry").read_text(), "writer still active")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux cleanup")
    def test_transient_writer_during_quarantine_process_scan_is_retained(self):
        calls = []
        def racing(path):
            calls.append(path)
            if len(calls) == 2:
                # The write closes before the scan returns "not in use".
                (path / "entry").write_text("transient writer completed")
            return False
        with self.assertRaisesRegex(ValueError, "quarantined"):
            legacy.clean_cache(self.root, self.review(), in_use=racing)
        retired = list((self.root / ".cache").glob(".opencode-retired-*"))
        self.assertEqual(len(retired), 1)
        self.assertEqual((retired[0] / "entry").read_text(), "transient writer completed")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux quarantine")
    def test_write_after_final_snapshot_is_preserved_even_when_not_detected(self):
        review = self.review()
        actual_snapshot = legacy.snapshot
        retired_reads = []
        def racing_snapshot(path):
            result = actual_snapshot(path)
            if path.name.startswith(".opencode-retired-"):
                retired_reads.append(path)
                if len(retired_reads) == 2:
                    # A final revision check cannot close the TOCTOU window.
                    (path / "entry").write_text("write after last observation")
            return result
        with mock.patch.object(legacy, "snapshot", side_effect=racing_snapshot):
            result = legacy.clean_cache(self.root, review, in_use=lambda _: False)
        self.assertEqual(result["status"], "quarantined")
        self.assertEqual(result["bytes_reclaimed"], 0)
        self.assertEqual((Path(result["quarantine_path"]) / "entry").read_text(),
                         "write after last observation")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux quarantine")
    def test_recreated_cache_and_existing_quarantine_are_not_overwritten(self):
        review = self.review()
        calls = []
        def recreate(path):
            calls.append(path)
            if len(calls) == 2:
                self.cache.mkdir()
                (self.cache / "new").write_text("new active cache")
            return False
        result = legacy.quarantine_cache(self.root, review, in_use=recreate)
        self.assertEqual((self.cache / "new").read_text(), "new active cache")
        self.assertEqual((Path(result["quarantine_path"]) / "entry").read_text(), "disposable")
        new_review = self.review()
        existing = self.cache.with_name(f".opencode-retired-{new_review}")
        existing.mkdir()
        (existing / "keep").write_text("previous quarantine")
        with self.assertRaisesRegex(ValueError, "existing_quarantine"):
            legacy.quarantine_cache(self.root, new_review, in_use=lambda _: False)
        self.assertEqual((existing / "keep").read_text(), "previous quarantine")
        self.assertEqual((self.cache / "new").read_text(), "new active cache")


unittest.main()
