"""Run with `uv run ha_opencode_beta/test/backup-restore.py`.

Exercise Supervisor 2026.11.0's app-data filter and securetar walker against the
shipping manifest. No Supervisor instance, existing app data or network needed
once the two test dependencies are installed.
"""
# /// script
# requires-python = ">=3.12"
# dependencies = ["securetar==2026.10.0", "PyYAML==6.0.3"]
# ///
from io import BytesIO
from pathlib import Path, PurePosixPath
import sqlite3
import tarfile
from tempfile import TemporaryDirectory

from securetar import atomic_contents_add
import yaml


def snapshot(source, config, slug):
    # Supervisor apps/app.py:_is_excluded_by_filter matches the full private
    # path. In particular, an excluded directory is never descended into.
    root = PurePosixPath("/data/apps/data", slug)

    def excluded(member):
        path = root / PurePosixPath(member.as_posix()).relative_to("data")
        return any(path.match(rule) for rule in config["backup_exclude"])

    output = BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        atomic_contents_add(tar, source, excluded, arcname="data")
    output.seek(0)
    return output


def main():
    config = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert config["backup"] == "cold"
    speech = ".config/openchamber/speech-models"
    keep = [
        f"{speech}/voice/model.onnx", f"{speech}/voice/tokens.txt",
        f"{speech}/.downloads/voice.tar.bz2", ".config/openchamber/settings.json",
        ".config/opencode/skills/my-skill/context/guide.md",
        ".npm-global/lib/node_modules/user-package/hooks/setup.js",
        "opencode-tui/config/opencode/cli.json", "opencode-tui/state/opencode/model.json",
        "v2/current", "options.json",
    ]
    skip = [
        f"{speech}/.downloads/voice.tar.bz2.tmp-1234",
        f"{speech}/.staging-voice-1234/model.onnx",
        "opencode-tui/data/opencode/log/opencode.log",
        "hooks/last-run.log", ".env_vars", ".env_vars_discovered",
        "context/generated.md", "v2/work/candidate/partial.db", "v2/cache/file",
    ]
    with TemporaryDirectory() as tmp:
        source = Path(tmp, "source")
        for name in keep + skip:
            file = source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(("fixture:" + name).encode())
        db_path = Path("v2/generations/fixture/data/opencode/opencode.db")
        (source / db_path).parent.mkdir(parents=True)
        db = sqlite3.connect(source / db_path)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE session(title)")
        db.execute("INSERT INTO session VALUES ('preserved')")
        db.commit()
        db.close()  # Cold snapshot: no process can change the DB/WAL pair.

        for prefix in ("local", "1234abcd"):
            slug = prefix + "_" + config["slug"]
            restored = Path(tmp, slug)
            with tarfile.open(fileobj=snapshot(source, config, slug)) as backup:
                backup.extractall(restored, filter="data")
            data = restored / "data"
            for name in keep:
                assert (source / name).read_bytes() == (data / name).read_bytes(), name
            for name in skip:
                assert not (data / name).exists(), name
            assert not (data / "opencode-tui/data/opencode/log").exists()
            db = sqlite3.connect((data / db_path).as_uri() + "?mode=ro", uri=True)
            try:
                assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                assert db.execute("SELECT title FROM session").fetchall() == [("preserved",)]
            finally:
                db.close()
    print("Cold archive round-trip passed for repository and local installs.")


if __name__ == "__main__":
    main()
