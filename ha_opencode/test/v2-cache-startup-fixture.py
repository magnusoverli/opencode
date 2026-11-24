#!/usr/bin/env python3
"""Exercise the shipped PID-1 pre-init boundary in a disposable Docker volume."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def seed():
    spec = importlib.util.spec_from_file_location("legacy", "/usr/local/bin/opencode-legacy-data.py")
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    root = Path("/data")
    active = root / "v2/generations" / ("a" * 32)
    (active / "data/opencode").mkdir(parents=True)
    (active / "data/opencode/opencode.db").write_bytes(b"fixture-database-preserve")
    (root / "v2/work").mkdir()
    (root / "v2/current").write_text(active.name)
    (active / "generation.json").write_text(json.dumps({
        "format": legacy.migration_module().FORMAT, "generation": active.name,
        "status": "validated", "target_version": "2.4.1",
    }))
    expected = {}
    for name in ("aged", "young", "changed", "unrecorded"):
        cache = root / ".cache/opencode"
        cache.mkdir(parents=True)
        (cache / "entry").write_text(name)
        review = legacy.snapshot(cache)["revision"]
        result = legacy.quarantine_cache(root, review, in_use=lambda _: False)
        retired = Path(result["quarantine_path"])
        expected[name] = str(retired)
        receipt = root / legacy.RECEIPTS / f"{review}.json"
        if name != "young":
            value = json.loads(receipt.read_text())
            value["quarantined_at"] = int(time.time()) - legacy.RETENTION_SECONDS - 60
            receipt.write_text(json.dumps(value))
        if name == "changed":
            (retired / "entry").write_text("changed since review")
        if name == "unrecorded":
            receipt.unlink()
    cache.mkdir()
    (cache / "current").write_text("active cache preserve")
    (root / "test-expectations.json").write_text(json.dumps(expected))


def verify(expired):
    root = Path("/data")
    expected = json.loads((root / "test-expectations.json").read_text())
    for name, path in expected.items():
        assert Path(path).exists() == (not expired or name != "aged"), name
    assert (root / ".cache/opencode/current").read_text() == "active cache preserve"
    assert (root / "v2/generations" / ("a" * 32) / "data/opencode/opencode.db").read_bytes() == b"fixture-database-preserve"
    print("PID-1 startup expiry verified" if expired else "Live expiry refusal verified")


def run(image):
    volume = f"opencode-expiry-test-{uuid.uuid4().hex}"
    fixture = str(Path(__file__).resolve())
    subprocess.run(["docker", "volume", "create", volume], check=True, capture_output=True)
    try:
        with tempfile.TemporaryDirectory(prefix="opencode-expiry-") as temporary:
            init = Path(temporary) / "init"
            init.write_text("#!/usr/bin/python3\nimport runpy, sys\nsys.argv=['/fixture.py','verify']\nrunpy.run_path('/fixture.py',run_name='__main__')\n")
            init.chmod(0o755)
            common = ["docker", "run", "--rm", "--network", "none",
                      "--mount", f"type=volume,source={volume},target=/data",
                      "--mount", f"type=bind,source={fixture},target=/fixture.py,readonly",
                      "--tmpfs", "/homeassistant:rw,mode=0755"]
            subprocess.run([*common, "--entrypoint", "/usr/bin/python3", image, "-B", "/fixture.py", "seed"], check=True, timeout=30)
            refused = subprocess.run([*common, "--entrypoint", "/usr/bin/python3", image,
                                      "-I", "-B", "/usr/local/bin/opencode-legacy-data.py", "--startup-expire"],
                                     capture_output=True, text=True, timeout=30)
            assert refused.returncode != 0, "manual invocation must not expire data"
            subprocess.run([*common, "--entrypoint", "/usr/bin/python3", image, "-B", "/fixture.py", "verify-live"], check=True, timeout=30)
            result = subprocess.run([*common, "--mount", f"type=bind,source={init},target=/init,readonly",
                                     "--entrypoint", "/usr/local/bin/opencode-container-init", image],
                                    capture_output=True, text=True, timeout=45)
            assert result.returncode == 0, result.stdout + result.stderr
            assert "PID-1 startup expiry verified" in result.stdout, result.stdout + result.stderr
            assert '"removed": [".opencode-retired-' in result.stdout, result.stdout + result.stderr
            assert '"reason": "quarantine_changed"' in result.stdout, result.stdout
            assert '"reason": "unrecorded_quarantine"' in result.stdout, result.stdout
            print(result.stdout)
    finally:
        subprocess.run(["docker", "volume", "rm", volume], check=True, capture_output=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["seed"]:
        seed()
    elif sys.argv[1:] in (["verify"], ["verify-live"]):
        verify(sys.argv[1] == "verify")
    else:
        run(sys.argv[1])
