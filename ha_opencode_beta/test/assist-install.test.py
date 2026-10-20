"""Exercise real filesystem publication and failure paths without HA config."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr, redirect_stdout


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("assist_install", ROOT / "rootfs/opt/opencode-assist/install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "ha"
        self.config.mkdir()
        self.source = self.root / "bundle"
        shutil.copytree(installer.SOURCE, self.source, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.target = self.config / "custom_components/opencode_assist"

    def tearDown(self):
        self.temp.cleanup()

    def install(self):
        return installer.install(self.config, self.source)

    def upgrade_bundle(self):
        (self.source / "client.py").write_text("# new bundled client\n")
        manifest = json.loads((self.source / "manifest.json").read_text())
        manifest["version"] = "0.1.0b99"
        (self.source / "manifest.json").write_text(json.dumps(manifest))

    def snapshot(self):
        return {str(p.relative_to(self.target)): p.read_bytes() for p in self.target.rglob("*") if p.is_file()}

    def test_install_idempotence_and_restart_record(self):
        result = self.install()
        self.assertEqual(result["action"], "installed")
        self.assertEqual(installer.files_in(self.target, installed=True), installer.files_in(self.source))
        inode = self.target.stat().st_ino
        timestamp = (self.target / "client.py").stat().st_mtime_ns
        again = self.install()
        self.assertEqual(again, {**result, "action": "unchanged"})
        self.assertEqual(self.target.stat().st_ino, inode)
        self.assertEqual((self.target / "client.py").stat().st_mtime_ns, timestamp)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)
        installer.status_file(self.root / "status.json", result)
        self.assertEqual(json.loads((self.root / "status.json").read_text()), result)
        self.assertEqual((self.root / "status.json").stat().st_mode & 0o777, 0o600)

    def test_atomic_update_removes_stale_managed_files(self):
        (self.source / "obsolete.py").write_text("# old release")
        self.install()
        old = self.snapshot()
        self.upgrade_bundle()
        (self.source / "obsolete.py").unlink()
        (self.target / "__pycache__").mkdir()
        (self.target / "__pycache__/client.cpython-314.pyc").write_bytes(b"ha cache")
        real_rename = installer.atomic_rename

        def exchange(fd, stage, target, flags):
            self.assertEqual(flags, 2)
            self.assertEqual((self.target / "client.py").read_bytes(), old["client.py"])
            self.assertTrue((self.target / "obsolete.py").exists())
            real_rename(fd, stage, target, flags)
            self.assertEqual((self.target / "client.py").read_text(), "# new bundled client\n")
            self.assertFalse((self.target / "obsolete.py").exists())

        with patch.object(installer, "atomic_rename", side_effect=exchange):
            result = self.install()
        self.assertEqual(result["action"], "updated")
        self.assertEqual(result["version"], "0.1.0b99")
        self.assertFalse(list(self.target.parent.glob(".opencode-assist-staging-*")))

    def test_service_private_umask_still_installs_readable_ha_code(self):
        mask = os.umask(0o077)
        try:
            self.install()
        finally:
            os.umask(mask)
        for path in [self.target.parent, self.target, self.target / "translations"]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.target / "translations/en.json").stat().st_mode & 0o777, 0o644)

    def test_manual_zip_install_is_not_adopted_even_if_identical(self):
        self.target.parent.mkdir()
        shutil.copytree(self.source, self.target)
        before = self.snapshot()
        with self.assertRaisesRegex(installer.InstallError, "user-managed"):
            self.install()
        self.assertEqual(self.snapshot(), before)

    def test_other_channel_install_is_preserved(self):
        with patch.object(installer, "OWNER", "ha_opencode"):
            self.install()
        before = self.snapshot()
        self.upgrade_bundle()
        with self.assertRaisesRegex(installer.InstallError, "user-managed"):
            self.install()
        self.assertEqual(self.snapshot(), before)

    def test_cli_records_conflict_and_recovers_after_manual_copy_is_moved(self):
        self.target.parent.mkdir()
        shutil.copytree(self.source, self.target)
        before = self.snapshot()
        status = self.root / "status.json"
        installer.status_file(status, {"action": "installed", "version": "old"})
        args = ["install.py", "--config", str(self.config), "--status-file", str(status)]
        with patch("sys.argv", args), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(installer.main(), 1)
            self.assertEqual(json.loads(status.read_text()), {"action": "blocked", "reason": "unmanaged"})
            self.assertEqual(self.snapshot(), before)
            backup = self.config / "opencode-assist-backup"
            self.target.rename(backup)
            self.assertEqual(installer.main(), 0)
            self.assertEqual(json.loads(status.read_text())["action"], "installed")
            self.assertEqual(installer.files_in(backup), before)
            (self.target / "client.py").write_text("# local edit")
            self.assertEqual(installer.main(), 1)
            self.assertEqual(json.loads(status.read_text()), {"action": "blocked", "reason": "modified"})
            self.assertEqual((self.target / "client.py").read_text(), "# local edit")

    def test_cli_failure_status_omits_exception_details(self):
        status = self.root / "status.json"
        args = ["install.py", "--config", str(self.config), "--status-file", str(status)]
        with patch("sys.argv", args), patch.object(installer, "install", side_effect=OSError("private details")), \
                redirect_stderr(io.StringIO()):
            self.assertEqual(installer.main(), 1)
        self.assertEqual(json.loads(status.read_text()), {"action": "blocked", "reason": "installation_failed"})

    def test_local_edits_and_extra_files_are_preserved(self):
        for name in ["client.py", "personal.py", "empty-directory"]:
            with self.subTest(name=name):
                self.install()
                path = self.target / name
                if name == "empty-directory":
                    path.mkdir()
                else:
                    path.write_text("user content")
                before = self.snapshot()
                with self.assertRaisesRegex(installer.InstallError, "local edits|extra directories"):
                    self.install()
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(path.exists())
                shutil.rmtree(self.target)

    def test_failed_exchange_preserves_complete_previous_install(self):
        self.install()
        before = self.snapshot()
        self.upgrade_bundle()
        with patch.object(installer, "atomic_rename", side_effect=installer.InstallError("unsupported filesystem")):
            with self.assertRaisesRegex(installer.InstallError, "unsupported filesystem"):
                self.install()
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.target.parent.glob(".opencode-assist-staging-*")))

    def test_first_install_race_never_replaces_new_manual_directory(self):
        real_rename = installer.atomic_rename

        def race(fd, stage, target, flags):
            self.target.mkdir()
            (self.target / "user.py").write_text("manual")
            self.assertEqual(flags, 1)
            real_rename(fd, stage, target, flags)

        with patch.object(installer, "atomic_rename", side_effect=race):
            with self.assertRaisesRegex(installer.InstallError, "Atomic companion installation failed"):
                self.install()
        self.assertEqual(self.snapshot(), {"user.py": b"manual"})

    def test_symlinks_hardlinks_and_invalid_state_are_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        for where in [self.config / "custom_components", self.target]:
            with self.subTest(where=where):
                where.parent.mkdir(exist_ok=True)
                where.symlink_to(outside, target_is_directory=True)
                with self.assertRaises(installer.InstallError):
                    self.install()
                where.unlink()
        self.install()
        (self.target / "client.py").unlink()
        (outside / "secret").write_text("untouched")
        (self.target / "client.py").symlink_to(outside / "secret")
        with self.assertRaises(OSError):
            self.install()
        (self.target / "client.py").unlink()
        os.link(outside / "secret", self.target / "client.py")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual((outside / "secret").read_text(), "untouched")


if __name__ == "__main__":
    unittest.main(verbosity=2)
