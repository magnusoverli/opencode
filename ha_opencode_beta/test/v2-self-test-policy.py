"""Focused policy regression; run with python (or py) test/v2-self-test-policy.py."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import types
import unittest
from unittest.mock import patch


ADDON = Path(__file__).resolve().parents[1]
# Windows cannot import resource; no Linux hardening or main() is exercised here.
with patch.dict(sys.modules, {"resource": types.ModuleType("resource")} if os.name == "nt" else {}):
    POLICY = runpy.run_path(str(ADDON / "rootfs/usr/local/bin/opencode-v2-self-test"))
EXERCISE = POLICY["exercise_policy"]
VERSION = "0.0.0-beta-19242"
AGENT = POLICY["READ_ONLY_AGENT"]


class PolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(subprocess.check_output([
            "node", str(ADDON / "rootfs/opt/opencode-v2-homeassistant/managed-config.js"),
            "--plugin-enabled", "false", "--native-mcp-enabled", "false",
        ], text=True))

    def exercise(self, plugins, mcp=False):
        requests = []

        class Client:
            def request(client, path, **kwargs):
                requests.append((path, kwargs))
                if kwargs:
                    self.assertEqual((path, kwargs), ("/api/health", {
                        "expected": 401, "authenticated": False, "decode": False,
                    }))
                    return None
                return {
                    "/api/health": {"healthy": True, "version": VERSION},
                    "/api/plugin": {"data": plugins},
                    "/api/mcp": {"data": [{"name": "homeassistant", "status": {"status": "connected"}}] if mcp else []},
                    f"/api/agent/{AGENT}": {"data": {"id": AGENT, **self.config["agents"][AGENT]}},
                }[path]

        reporter = POLICY["Reporter"](True)
        with patch.object(POLICY["time"], "sleep"):
            EXERCISE(Client(), VERSION, mcp, False, reporter)
        self.assertEqual(requests[-1][0], f"/api/agent/{AGENT}")
        self.assertEqual(reporter.passed, 26 + (2 if mcp else 0))

    def test_nested_active_completes_policy_with_generated_permissions(self):
        self.exercise([{"id": "homeassistant.runtime-guard", "state": {"status": "active"}}])

    def test_both_plugins_use_nested_state(self):
        self.exercise([
            {"id": name, "state": {"status": "active"}}
            for name in ("homeassistant.runtime-guard", "homeassistant.mcp")
        ], mcp=True)

    def test_invalid_or_legacy_state_fails_closed(self):
        for state in (None, "active", [], {}, {"type": "active"}, {"status": "inactive"}):
            with self.subTest(state=state), self.assertRaisesRegex(POLICY["SelfTestError"], "timed out waiting for Home Assistant V2 runtime guard"):
                self.exercise([{"id": "homeassistant.runtime-guard", "status": "active", "state": state}])
        with self.assertRaises(POLICY["SelfTestError"]):
            self.exercise([None, {"id": "homeassistant.runtime-guard", "status": "active"}])


if __name__ == "__main__":
    unittest.main()
