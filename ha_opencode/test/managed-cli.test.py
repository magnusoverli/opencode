import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ADDON = Path(__file__).resolve().parents[1]
MODULE = runpy.run_path(str(ADDON / "rootfs/usr/local/bin/opencode"))
MAIN = MODULE["main"]
GLOBALS = MAIN.__globals__


class ManagedCliTest(unittest.TestCase):
    def invoke(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            result = MAIN(args)
        return result, output.getvalue()

    def test_version_is_metadata_only(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "version"
            marker.write_text("2.0.21\n")
            with patch.dict(GLOBALS, VERSION_FILE=str(marker)), patch("os.execv") as execute:
                self.assertEqual(self.invoke(["--version"]), (0, "opencode v2.0.21\n"))
                execute.assert_not_called()

    def test_service_management_cannot_start_a_daemon(self):
        with patch("os.execv") as execute:
            for args in (["service", "start"], ["service", "restart"], ["serve"], ["upgrade"], ["uninstall"]):
                self.assertEqual(self.invoke(args)[0], 2)
            execute.assert_not_called()

    def test_terminal_and_api_use_only_the_confined_launcher(self):
        for args in ([], ["api", "GET", "/api/info"], ["run", "hello"], ["--session", "ses_fixture"]):
            with patch("os.execv") as execute:
                self.invoke(args)
                execute.assert_called_once_with(MODULE["LAUNCHER"], [MODULE["LAUNCHER"], MODULE["RUNTIME_ROOT"], *args])

    def test_status_is_non_starting_when_ready_or_unavailable(self):
        class Failure(Exception):
            pass
        requested = []
        class Client:
            def __init__(self, url, password):
                self.url = url
            def request(self, path):
                requested.append((self.url, path))
                return {"version": "2.0.21", "private": "must-not-be-printed"}
        policy = {
            "Reporter": lambda _: None, "SelfTestError": Failure,
            "harden_process": lambda _: None,
            "read_runtime_material": lambda *_: (bytearray(b"fixture"), True, False),
            "ApiClient": Client,
        }
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "version"
            marker.write_text("2.0.21")
            with patch.dict(GLOBALS, VERSION_FILE=str(marker)), patch("os.geteuid", return_value=0), patch("runpy.run_path", return_value=policy), patch("os.execv") as execute, patch("subprocess.Popen", side_effect=AssertionError("status spawned a process")):
                code, output = self.invoke(["service", "status"])
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(output)["state"], "running")
                self.assertNotIn("must-not-be-printed", output)
                self.assertEqual(requested, [(MODULE["SERVER_URL"], "/api/info")])
                with patch.object(Client, "request", side_effect=Failure("unavailable")):
                    code, output = self.invoke(["status"])
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(output)["state"], "unavailable")
                execute.assert_not_called()

    def test_readonly_prints_the_native_agent_policy(self):
        config = subprocess.check_output(["node", str(ADDON / "rootfs/opt/opencode-v2-homeassistant/managed-config.js")], text=True)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "managed.json").write_text(config)
            with patch.dict(GLOBALS, RUNTIME_ROOT=directory), patch("os.execv") as execute:
                code, output = self.invoke(["readonly", "--print-config"])
                self.assertEqual(code, 0)
                policy = json.loads(output)
                self.assertEqual(policy["agent"], "home-assistant-read-only")
                self.assertEqual(policy["policy"]["permissions"][0], {"action": "*", "resource": "*", "effect": "deny"})
                execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
