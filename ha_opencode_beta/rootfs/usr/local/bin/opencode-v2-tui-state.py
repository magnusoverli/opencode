#!/usr/bin/env python3
"""Prepare durable client preferences without writable managed/plugin sources."""

import argparse
import os
from pathlib import Path
import stat
import sys

UID = GID = 60001


def directory(path, uid, gid, mode):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        os.chmod(path, mode)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid
            or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode):
        raise ValueError("unsafe client-state directory identity")


def managed_file(path, content):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o444):
            raise ValueError("unsafe managed client configuration identity")
        if path.read_bytes() != content:
            raise ValueError("unexpected managed client configuration")
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    with os.fdopen(fd, "wb") as output:
        output.write(content)
        os.fchmod(output.fileno(), 0o444)


def prepare(root, legacy):
    # Verify ancestors without following links, including the Supervisor /data mount.
    for parent in reversed(root.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            # /tmp is allowed for isolated root-run tests, never a writable ancestor
            # of the production /data/opencode-tui location.
            if parent != Path("/tmp") or not info.st_mode & stat.S_ISVTX:
                raise ValueError("unsafe client-state parent")
    directory(root, 0, 0, 0o755)
    directory(root / "config", 0, 0, 0o755)
    config = root / "config" / "opencode"
    # Sticky root ownership allows atomic cli.json replacement, but prevents
    # UID 60001 from replacing root-owned config files or plugin directories.
    directory(config, 0, GID, 0o1770)
    directory(config / "plugins", 0, 0, 0o555)
    managed_file(config / "opencode.json", b'{"autoupdate":false}\n')
    managed_file(config / "opencode.jsonc", b'{}\n')
    for leaf in ("data", "state"):
        directory(root / leaf, UID, GID, 0o700)
        directory(root / leaf / "opencode", UID, GID, 0o700)
    # Carry forward known client preference files if a same-container restart
    # still has them. Never overwrite an existing durable preference or copy
    # arbitrary configuration/plugins from the old ephemeral tree.
    for relative in ("config/opencode/cli.json", "state/opencode/kv.json",
                     "state/opencode/model.json", "data/opencode/kv.json",
                     "data/opencode/model.json"):
        target = root / relative
        source = legacy / relative
        if target.exists() or target.is_symlink() or not source.exists():
            continue
        for parent in source.parents:
            if parent == legacy.parent:
                break
            if not stat.S_ISDIR(parent.lstat().st_mode):
                raise ValueError("unsafe legacy client-state directory")
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as input_file:
            info = os.fstat(input_file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
                raise ValueError("unsafe legacy client-state file")
            content = input_file.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise ValueError("legacy client-state file exceeds limit")
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(content)
            os.fchown(output.fileno(), UID, GID)
            os.fchmod(output.fileno(), 0o600)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/data/opencode-tui"))
    parser.add_argument("--legacy", type=Path, default=Path("/run/opencode-v2/tui"))
    args = parser.parse_args()
    try:
        prepare(args.root, args.legacy)
    except (OSError, ValueError):
        print("OpenCode TUI preferences could not be secured; existing files were preserved. Inspect client-state ownership and path types.", file=sys.stderr)
        sys.exit(1)
