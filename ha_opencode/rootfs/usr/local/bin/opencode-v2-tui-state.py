#!/usr/bin/env python3
"""Prepare durable client preferences without writable managed/plugin sources."""

import argparse
import os
from pathlib import Path
import re
import stat
import sys

UID = GID = 60001


def identity_error(path, expected, info, uid=None, gid=None, mode=None):
    name = re.sub(r"[^A-Za-z0-9/._-]", "_", str(path)[-160:])
    kind = ("symlink" if stat.S_ISLNK(info.st_mode) else
            "directory" if stat.S_ISDIR(info.st_mode) else
            "file" if stat.S_ISREG(info.st_mode) else "other")
    message = (f"path={name} expected={expected} type={kind} "
               f"uid={info.st_uid} gid={info.st_gid} mode={stat.S_IMODE(info.st_mode):04o}")
    if mode is not None:
        message += f" expected_uid={uid} expected_gid={gid} expected_mode={mode:04o}"
    return ValueError(message)


def repairable_directory(info, uid, gid, mode):
    # The reporter's root-only 0700 state and root:root 0750 configuration
    # cannot be written by the client. Relinquish only these bounded identities;
    # do not infer that every ownership mismatch is a historical app layout.
    actual = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        return False
    if (info.st_uid, info.st_gid, actual) == (uid, gid, mode):
        return False
    # Include states our own mkdir/umask and fchown-before-fchmod sequence can
    # leave on interruption. Root ownership remains mandatory throughout.
    if uid == 0 and gid == GID and mode == 0o1770:
        return info.st_gid in (0, GID) and actual in (0o700, 0o750, 0o755, 0o1750, 0o1770)
    if info.st_gid != 0:
        return False
    return ((uid == UID and gid == GID and mode == 0o700 and actual == 0o700)
            or (uid == 0 and gid == 0 and mode == 0o755 and actual in (0o700, 0o750))
            or (uid == 0 and gid == 0 and mode == 0o555 and actual in (0o500, 0o550)))


def directory(path, uid, gid, mode):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != 0:
                raise identity_error(path, "new-root-owned-directory", info)
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)
    info = path.lstat()
    if repairable_directory(info, uid, gid, mode):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if ((opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
                    or not repairable_directory(opened, uid, gid, mode)):
                raise identity_error(path, "unchanged-safe-directory", opened)
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)
        info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid
            or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode):
        raise identity_error(path, "directory", info, uid, gid, mode)


def managed_file(path, content):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o444):
            raise identity_error(path, "single-link-managed-file", info, 0, 0, 0o444)
        if path.read_bytes() != content:
            raise identity_error(path, "unchanged-managed-file", info)
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
                raise identity_error(parent, "root-owned-safe-parent", info)
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
    # Only known preference files are migrated. Do not traverse or change
    # arbitrary data, plugin sources, or an unknown user's files recursively.
    for relative in ("config/opencode/cli.json", "state/opencode/kv.json",
                     "state/opencode/model.json", "data/opencode/kv.json",
                     "data/opencode/model.json"):
        path = root / relative
        if not path.exists() and not path.is_symlink():
            continue
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or (info.st_uid, info.st_gid) not in ((0, 0), (UID, GID))
                or stat.S_IMODE(info.st_mode) not in (0o600, 0o644) or info.st_size > 4 * 1024 * 1024):
            raise identity_error(path, "private-single-link-preference", info)
        if info.st_uid == 0 and info.st_gid == 0:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                opened = os.fstat(fd)
                if ((opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
                        or opened.st_nlink != 1 or not stat.S_ISREG(opened.st_mode)
                        or opened.st_uid != 0 or opened.st_gid != 0
                        or stat.S_IMODE(opened.st_mode) not in (0o600, 0o644)):
                    raise identity_error(path, "unchanged-private-preference", opened)
                os.fchmod(fd, 0o600)
                os.fchown(fd, UID, GID)
            finally:
                os.close(fd)
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
    except (OSError, ValueError) as error:
        print("OpenCode TUI preferences could not be secured; existing files were preserved. Inspect client-state ownership and path types.", file=sys.stderr)
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        else:
            name = re.sub(r"[^A-Za-z0-9/._-]", "_", str(error.filename or "unknown")[-160:])
            print(f"path={name} errno={error.errno}; preparation stopped", file=sys.stderr)
        sys.exit(1)
