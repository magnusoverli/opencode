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
            "status": "validated", "target_version": "2.4.1",
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

    def expiry_fixture(self):
        result = legacy.quarantine_cache(self.root, self.review(), in_use=lambda _: False)
        retired = Path(result["quarantine_path"])
        review = retired.name.removeprefix(".opencode-retired-")
        receipt = self.root / legacy.RECEIPTS / f"{review}.json"
        recorded = json.loads(receipt.read_text())
        return retired, receipt, recorded["quarantined_at"]

    def expire_at(self, timestamp):
        # Only the startup identity guard is substituted in these disposable
        # root fixtures; the production entrypoint is tested separately.
        with mock.patch.object(legacy, "require_cold_start"), mock.patch.object(legacy.time, "time", return_value=timestamp):
            return legacy.expire_quarantines(self.root)

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_expiry_waits_seven_days_then_removes_only_recorded_quarantine(self):
        retired, receipt, created = self.expiry_fixture()
        self.cache.mkdir()
        (self.cache / "current").write_text("active cache")
        before = (self.active / "data/opencode/opencode.db").read_bytes()
        early = self.expire_at(created + legacy.RETENTION_SECONDS - 1)
        self.assertEqual(early["preserved"][0]["reason"], "within_grace_period")
        self.assertTrue(retired.exists())
        result = self.expire_at(created + legacy.RETENTION_SECONDS)
        self.assertEqual(result["removed"], [retired.name])
        self.assertEqual(result["removed_bytes"], len("disposable"))
        self.assertFalse(retired.exists())
        self.assertFalse(receipt.exists())
        self.assertEqual((self.cache / "current").read_text(), "active cache")
        self.assertEqual((self.original / "auth.json").read_text(), "SECRET_NEVER_PRINT")
        self.assertEqual((self.user / "mine.md").read_text(), "USER_CONTENT_NEVER_PRINT")
        self.assertEqual((self.active / "data/opencode/opencode.db").read_bytes(), before)
        self.assertEqual(self.expire_at(created + legacy.RETENTION_SECONDS)["removed"], [])

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_changed_quarantine_is_preserved_even_if_mtime_and_size_restored(self):
        retired, _, created = self.expiry_fixture()
        target = retired / "entry"
        before = target.stat()
        target.write_text("DIFFERENT!")
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        result = self.expire_at(created + legacy.RETENTION_SECONDS)
        self.assertEqual(result["preserved"][0]["reason"], "quarantine_changed")
        self.assertEqual(target.read_text(), "DIFFERENT!")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_unrecorded_quarantine_and_invalid_receipts_are_never_adopted(self):
        retired, receipt, created = self.expiry_fixture()
        original = receipt.read_bytes()
        for data in [b"{", b'{"format":1,"revision":"../outside","quarantined_at":1}', original.replace(b'"format": 1', b'"format": true')]:
            receipt.write_bytes(data)
            self.assertEqual(self.expire_at(created + legacy.RETENTION_SECONDS)["removed"], [])
            self.assertTrue(retired.exists())
        receipt.unlink()
        result = self.expire_at(created + legacy.RETENTION_SECONDS)
        self.assertEqual(result["preserved"][0]["reason"], "unrecorded_quarantine")
        self.assertTrue(retired.exists())

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_unsafe_receipt_clock_rollback_and_late_process_block_expiry(self):
        retired, receipt, created = self.expiry_fixture()
        self.assertEqual(self.expire_at(created - 1)["preserved"][0]["reason"], "clock_before_quarantine")
        receipt.chmod(0o666)
        self.assertEqual(self.expire_at(created + legacy.RETENTION_SECONDS)["removed"], [])
        receipt.chmod(0o600)
        with mock.patch.object(legacy, "require_cold_start", side_effect=[None, ValueError("other_processes_present")]), \
                mock.patch.object(legacy.time, "time", return_value=created + legacy.RETENTION_SECONDS):
            result = legacy.expire_quarantines(self.root)
        self.assertEqual(result["preserved"][0]["reason"], "other_processes_present")
        self.assertTrue(receipt.exists())
        self.assertTrue(retired.exists())

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_interrupted_removal_disarms_receipt_and_preserves_remainder(self):
        retired, receipt, created = self.expiry_fixture()
        with mock.patch.object(legacy.shutil, "rmtree") as remove:
            remove.avoids_symlink_attacks = True
            remove.side_effect = OSError("interrupted")
            result = self.expire_at(created + legacy.RETENTION_SECONDS)
        self.assertEqual(result["removed_bytes"], 0)
        self.assertTrue(retired.exists())
        self.assertFalse(receipt.exists())
        self.assertEqual(self.expire_at(created + legacy.RETENTION_SECONDS)["preserved"][0]["reason"], "unrecorded_quarantine")

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "root Linux expiry")
    def test_live_invocation_cannot_expire_data(self):
        retired, receipt, _ = self.expiry_fixture()
        with self.assertRaises(ValueError):
            legacy.expire_quarantines(self.root)
        self.assertTrue(retired.exists())
        self.assertTrue(receipt.exists())


unittest.main()
