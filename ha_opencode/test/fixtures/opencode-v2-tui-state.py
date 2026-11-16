#!/usr/bin/env python3
"""Exercise the actual durable layout as root and as the restricted TUI UID."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[2] / "rootfs/usr/local/bin/opencode-v2-tui-state.py"
spec = importlib.util.spec_from_file_location("tui_state", source)
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


def client(code, root):
    def drop():
        os.setgroups([])
        os.setgid(60001)
        os.setuid(60001)
    result = subprocess.run([sys.executable, "-c", code, str(root)], preexec_fn=drop,
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr


with tempfile.TemporaryDirectory(prefix="tui-state-") as temporary:
    base = Path(temporary)
    base.chmod(0o755)
    root, legacy = base / "persistent", base / "legacy"
    (legacy / "state/opencode").mkdir(parents=True)
    (legacy / "state/opencode/model.json").write_text('{"favorite":[{"providerID":"fixture","modelID":"test"}]}')
    state.prepare(root, legacy)
    client('''
import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
config = root / "config/opencode"
assert json.loads((root / "state/opencode/model.json").read_text())["favorite"]
for iteration in range(2):
    (config / "cli.json.tmp").write_text('{"theme":{"name":"nord"},"session":{"sidebar":"hide"}}')
    os.replace(config / "cli.json.tmp", config / "cli.json")
for path in [config / "opencode.json", config / "opencode.jsonc", config / "plugins"]:
    for operation in [lambda: path.rename(path.with_suffix(".stolen")),
                      lambda: path.write_text("unsafe") if path.is_file() else (path / "unsafe").mkdir()]:
        try:
            operation()
        except PermissionError:
            pass
        else:
            raise AssertionError("managed source became writable")
(root / "state/opencode/kv.json").write_text('{"session_picker":"all"}')
''', root)
    before = (root / "config/opencode/cli.json").read_bytes()
    state.prepare(root, legacy)
    assert (root / "config/opencode/cli.json").read_bytes() == before
    # Resume after an interruption between fchown and fchmod, and after mkdir
    # under a restrictive umask. Never require blanket recursive repair.
    os.chmod(root / "config/opencode", 0o1750)
    os.chmod(root / "config", 0o700)
    state.prepare(root, legacy)
    assert (root / "config/opencode").stat().st_mode & 0o7777 == 0o1770
    assert (root / "config").stat().st_mode & 0o7777 == 0o755
    assert json.loads((root / "state/opencode/kv.json").read_text())["session_picker"] == "all"
    # Reproduce #197's root-only state. Files retain their bytes; only these
    # explicitly recognized directory identities and preferences may converge.
    os.chown(root / "config/opencode", 0, 0)
    os.chmod(root / "config/opencode", 0o750)
    for leaf in ("data", "state"):
        for path in (root / leaf, root / leaf / "opencode"):
            os.chown(path, 0, 0)
            os.chmod(path, 0o700)
    os.chown(root / "state/opencode/kv.json", 0, 0)
    state.prepare(root, legacy)
    assert (root / "state/opencode/kv.json").stat().st_uid == 60001
    assert (root / "config/opencode").stat().st_mode & 0o7777 == 0o1770
    assert (root / "config/opencode/cli.json").read_bytes() == before
    # Reject replaced persistent directories without following them or altering
    # their target. Existing preferences must survive a failed preparation.
    (root / "data").rename(root / "retained-data")
    (root / "data").symlink_to(base)
    try:
        state.prepare(root, legacy)
    except ValueError:
        pass
    else:
        raise AssertionError("symlinked client data accepted")
    assert (root / "config/opencode/cli.json").read_bytes() == before
print("PASS TUI atomic settings, durable state, protected config/plugins and symlink rejection")
