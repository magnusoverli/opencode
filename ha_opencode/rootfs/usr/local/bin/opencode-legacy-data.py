#!/usr/bin/env python3
"""Metadata-only inventory and live quarantine; seven-day expiry only at cold startup."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time

MAX_ENTRIES = 20000
RETENTION_SECONDS = 7 * 24 * 60 * 60
RECEIPTS = ".opencode-legacy-quarantines"
MAX_QUARANTINES = 128
PATHS = (
    (".cache/opencode", "disposable_v1_cache"),
    (".local/share/opencode", "retained_original_history_and_accounts"),
    (".local/state/opencode", "retained_original_client_state"),
    (".config/opencode", "active_skills_agents_and_mcp_assets"),
    (".npm-global", "retained_user_installed_packages"),
)


def directory(path):
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("unsafe_directory")


def snapshot(path):
    """Do not open file contents, follow links, cross mounts or print filenames."""
    directory(path)
    root_device = path.stat().st_dev
    mounts = set()
    if sys.platform == "linux":
        with open("/proc/self/mountinfo", encoding="utf-8") as source:
            for index, line in enumerate(source):
                if index >= MAX_ENTRIES:
                    raise ValueError("mount_inventory_limit")
                # Mountinfo escapes spaces/backslashes as octal. Same-device
                # bind mounts are not detectable using st_dev alone.
                mounts.add(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), line.split()[4]))
    entries, size, files = [], 0, 0
    deadline = time.monotonic() + 5
    pending = [path]
    while pending:
        parent = pending.pop()
        if str(parent) in mounts:
            raise ValueError("nested_mount")
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_dev != root_device:
            raise ValueError("unsafe_directory")
        entries.append((str(parent.relative_to(path)), info.st_dev, info.st_ino,
                        info.st_mode, info.st_mtime_ns, 0))
        with os.scandir(parent) as children:
            for child in children:
                if len(entries) + len(pending) >= MAX_ENTRIES or time.monotonic() > deadline:
                    raise ValueError("inventory_limit")
                info = child.stat(follow_symlinks=False)
                if info.st_dev != root_device or child.path in mounts:
                    raise ValueError("nested_mount")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(child.path))
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    files += 1
                    size += info.st_size
                    entries.append((str(Path(child.path).relative_to(path)), info.st_dev,
                                    info.st_ino, info.st_mode, info.st_mtime_ns, info.st_size,
                                    info.st_ctime_ns, info.st_uid, info.st_gid))
                else:
                    raise ValueError("links_or_special_files")
    revision = hashlib.sha256(json.dumps(sorted(entries)).encode()).hexdigest()
    return {"status": "present", "files": files, "bytes": size, "revision": revision}


def migration_module():
    source = Path(__file__).with_name("opencode-v2-migrate.py")
    spec = importlib.util.spec_from_file_location("legacy_inventory_migration", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def active_generation(root):
    migration = migration_module()
    state = root / "v2"
    directory(state / "generations")
    current = migration.load_current(state)
    if not current:
        raise ValueError("no_active_v2_generation")
    result = migration.generation_result(state, current)
    database = state / "generations" / current / "data/opencode/opencode.db"
    migration.ensure_plain_file(database)
    if database.stat().st_size == 0:
        raise ValueError("empty_active_database")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", str(result.get("target_version", ""))):
        raise ValueError("unverified_active_version")
    return current, result["target_version"]


def inspect(root):
    directory(root)
    result = {"format": 1, "items": []}
    try:
        current, version = active_generation(root)
        result["active_v2"] = {"generation": current, "version": version}
    except Exception:
        result["active_v2"] = {"status": "unverified"}
    for relative, purpose in PATHS:
        item = {"path": str(root / relative), "purpose": purpose,
                "cleanup_supported": False, "quarantine_supported": False}
        try:
            item.update(snapshot(root / relative))
            item["quarantine_supported"] = purpose == "disposable_v1_cache" and "generation" in result["active_v2"]
        except FileNotFoundError:
            item["status"] = "absent"
        except (OSError, ValueError):
            item["status"] = "unverified"
        result["items"].append(item)
    result["quarantine_retention_days"] = 7
    result["note"] = "Metadata only. Unknown sizes are not zero. Live commands only quarantine reviewed V1 cache. Recorded, unchanged quarantines expire after seven days at a verified cold startup before services launch. Original history/accounts, active assets, npm packages and V2 state are retained."
    return result


def cache_in_use(path):
    # Linux quarantine only: fail closed if procfs cannot establish process usage.
    prefix = str(path) + "/"
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            links = [process / "cwd", process / "exe", *list((process / "fd").iterdir())]
            for link in links:
                try:
                    target = os.readlink(link)
                except FileNotFoundError:
                    continue
                if target == str(path) or target.startswith(prefix):
                    return True
            with (process / "maps").open(encoding="utf-8") as maps:
                for index, line in enumerate(maps):
                    if index >= MAX_ENTRIES:
                        raise ValueError("process_inventory_limit")
                    parts = line.rstrip("\n").split(maxsplit=5)
                    if len(parts) == 6 and (parts[5] == str(path) or parts[5].startswith(prefix)):
                        return True
        except FileNotFoundError:
            continue
    return False


def quarantine_cache(root, review, in_use=cache_in_use):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("quarantine_requires_linux_app_root")
    if not isinstance(review, str) or len(review) != 64 or any(c not in "0123456789abcdef" for c in review):
        raise ValueError("inspect_first_and_supply_exact_revision")
    directory(root / "v2/work")
    migration = migration_module()
    # Coordinate with history upgrades, even though the disposable cache is
    # outside every active V2 generation and the client state roots.
    with migration.migration_lock(root / "v2/work/.migration.lock"):
        active_generation(root)
        cache = root / ".cache/opencode"
        before = snapshot(cache)
        if before["revision"] != review:
            raise ValueError("cache_changed_inspect_again")
        if in_use(cache):
            raise ValueError("legacy_cache_in_use")
        retired = cache.with_name(f".opencode-retired-{review}")
        if retired.exists() or retired.is_symlink():
            raise ValueError("existing_quarantine_requires_inspection")
        if snapshot(cache)["revision"] != review:
            raise ValueError("cache_changed_inspect_again")
        os.rename(cache, retired)
        # Process scans and metadata snapshots cannot exclude concurrent writers.
        # Preserve the directory during live calls: another revision check alone
        # would merely move the race window before recursive deletion.
        if snapshot(retired)["revision"] != review or in_use(retired):
            raise ValueError("quarantined_cache_requires_inspection")
        if snapshot(retired)["revision"] != review:
            raise ValueError("quarantined_cache_requires_inspection")
        record_quarantine(root, review)
        return {"status": "quarantined", "path": str(cache), "quarantine_path": str(retired),
                "reviewed_bytes": before["bytes"], "bytes_reclaimed": 0,
                "retention_days": 7,
                "note": "Preserved now; recorded unchanged data is eligible for expiry after seven days at verified cold startup. Live checks do not freeze writers."}


def clean_cache(root, review, in_use=cache_in_use):
    """Compatibility alias: live calls only quarantine; expiry is startup-only."""
    return quarantine_cache(root, review, in_use=in_use)


def owned_directory(path):
    directory(path)
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("untrusted_quarantine_directory")


def record_quarantine(root, review):
    owned_directory(root)
    store = root / RECEIPTS
    store.mkdir(mode=0o700, exist_ok=True)
    owned_directory(store)
    record = {"format": 1, "revision": review, "quarantined_at": int(time.time())}
    # Exclusive creation: an interrupted/invalid receipt is retained, never
    # silently adopted or overwritten. No receipt means no automatic expiry.
    fd = os.open(store / f"{review}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(record, target)
        target.flush()
        os.fsync(target.fileno())
    sync_directory(store)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def require_cold_start():
    # This is a scheduling boundary, not a claim that a live process scan locks
    # out writers. PID 1 is synchronously waiting for this helper before exec /init.
    # Host/admin processes must not concurrently alter the private app volume.
    if sys.platform != "linux" or os.geteuid() != 0 or os.getppid() != 1:
        raise ValueError("not_container_preinit")
    if os.readlink("/proc/1/exe") != "/usr/local/bin/opencode-container-init":
        raise ValueError("not_container_preinit")
    pids = {int(item.name) for item in Path("/proc").iterdir() if item.name.isdigit()}
    if pids != {1, os.getpid()}:
        raise ValueError("other_processes_present")


def read_receipt(path, review):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 1024):
            raise ValueError("untrusted_quarantine_receipt")
        value = json.loads(source.read(1025))
    if (not isinstance(value, dict) or set(value) != {"format", "revision", "quarantined_at"} or
            type(value["format"]) is not int or value["format"] != 1 or value["revision"] != review or
            type(value["quarantined_at"]) is not int or value["quarantined_at"] <= 0):
        raise ValueError("invalid_quarantine_receipt")
    return value


def expire_quarantines(root):
    require_cold_start()
    result = {"status": "checked", "removed": [], "preserved": [],
              "removed_bytes": 0, "retention_days": 7}
    store = root / RECEIPTS
    cache_root = root / ".cache"
    if not cache_root.exists() and not cache_root.is_symlink():
        return {**result, "status": "no_legacy_cache"}
    owned_directory(root)
    owned_directory(cache_root)
    entries = []
    if store.exists() or store.is_symlink():
        owned_directory(store)
        with os.scandir(store) as scan:
            for entry in scan:
                if len(entries) >= MAX_QUARANTINES:
                    raise ValueError("quarantine_inventory_limit")
                entries.append(entry.name)
    with os.scandir(cache_root) as scan:
        for index, entry in enumerate(scan):
            if index >= MAX_ENTRIES:
                raise ValueError("cache_inventory_limit")
            if entry.name.startswith(".opencode-retired-"):
                review = entry.name.removeprefix(".opencode-retired-")
                if not re.fullmatch(r"[a-f0-9]{64}", review) or f"{review}.json" not in entries:
                    result["preserved"].append({"reason": "unrecorded_quarantine"})
                    if len(result["preserved"]) >= MAX_QUARANTINES:
                        raise ValueError("quarantine_inventory_limit")
    if not entries:
        return {**result, "status": "no_recorded_quarantines"}
    active_generation(root)
    deadline = time.monotonic() + 20
    with migration_module().migration_lock(root / "v2/work/.migration.lock"):
        for name in sorted(entries):
            if not re.fullmatch(r"[a-f0-9]{64}\.json", name):
                result["preserved"].append({"reason": "unrecognized_receipt"})
                continue
            review = name[:-5]
            target = root / ".cache" / f".opencode-retired-{review}"
            receipt = store / name
            try:
                if time.monotonic() > deadline:
                    raise ValueError("startup_time_budget")
                recorded = read_receipt(receipt, review)
                age = int(time.time()) - recorded["quarantined_at"]
                if age < 0:
                    raise ValueError("clock_before_quarantine")
                if age < RETENTION_SECONDS:
                    raise ValueError("within_grace_period")
                current = snapshot(target)
                if current["revision"] != review:
                    raise ValueError("quarantine_changed")
                require_cold_start()
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise ValueError("safe_removal_unavailable")
                # Disarm the receipt durably before removal. Interruption leaves
                # an unrecorded partial quarantine for manual review, never an
                # automatically retried deletion of a changed directory.
                receipt.unlink()
                sync_directory(store)
                shutil.rmtree(target)
                result["removed"].append(target.name)
                result["removed_bytes"] += current["bytes"]
            except (OSError, ValueError) as error:
                # Only our fixed reason codes reach logs, not arbitrary paths
                # from OS errors or malformed JSON.
                reason = str(error) if type(error) is ValueError and re.fullmatch(r"[a-z_]+", str(error)) else "unsafe_or_unavailable"
                result["preserved"].append({"directory": target.name, "reason": reason})
    return result


def main():
    if sys.argv[1:] == ["--startup-expire"]:
        try:
            print("Legacy quarantine expiry: " + json.dumps(expire_quarantines(Path("/data"))))
            return 0
        except Exception:
            print("Legacy quarantine expiry skipped: cold-start, ownership or state evidence unavailable", file=sys.stderr)
            return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "quarantine-cache", "clean-cache"),
                        nargs="?", default="inspect",
                        help="clean-cache is a compatibility alias for quarantine-cache; neither deletes data")
    parser.add_argument("--review", help="Exact V1 cache revision from inspect")
    args = parser.parse_args()
    root = Path("/data")
    try:
        result = inspect(root) if args.command == "inspect" else quarantine_cache(root, args.review)
        print(json.dumps(result, indent=2))
        return 0
    except Exception:
        # Never echo arbitrary path names, metadata payloads or file contents.
        print("Legacy cache quarantine/inventory could not be verified. No automatic deletion was performed. Inspect the fixed cache, retired-cache and V2 work paths before retrying; retained history and active assets were not quarantine targets.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
