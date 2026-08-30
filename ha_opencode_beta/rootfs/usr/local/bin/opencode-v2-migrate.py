#!/usr/bin/env python3
"""Build and atomically activate an isolated OpenCode V2 state generation."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


FORMAT = "ha-opencode-v2-migration/v1"
GENERATION_RE = re.compile(r"^[a-f0-9]{32}$")
MAX_AUTH_BYTES = 16 * 1024 * 1024
MAX_DATABASE_BYTES = 16 * 1024 * 1024 * 1024
SOURCE_SESSION_COLUMNS = (
    "id",
    "project_id",
    "workspace_id",
    "parent_id",
    "slug",
    "directory",
    "path",
    "title",
    "version",
    "share_url",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "metadata",
    "cost",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
    "revert",
    "permission",
    "agent",
    "model",
    "time_created",
    "time_updated",
    "time_compacting",
    "time_archived",
)
COPIED_SESSION_COLUMNS = (
    "workspace_id",
    "parent_id",
    "slug",
    "directory",
    "path",
    "title",
    "version",
    "share_url",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "metadata",
    "permission",
    "time_created",
    "time_updated",
    "time_archived",
)
SESSION_JSON_COLUMNS = {"summary_diffs", "metadata", "permission", "model"}
TARGET_ONLY_SESSION_DEFAULTS = {
    "fork_session_id": None,
    "fork_boundary": None,
    "time_idle": None,
    "time_viewed": None,
    "idle_outcome": None,
    "time_suspended": None,
    "resume_attempts": 0,
}


class MigrationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("inventory", "prepare"), nargs="?", default="prepare")
    parser.add_argument("--root", type=Path, default=Path("/data/v2"))
    parser.add_argument("--source-data", type=Path, default=Path("/data/.local/share/opencode"))
    parser.add_argument("--retained-root", action="append", type=Path, default=[])
    parser.add_argument("--v2-bin", type=Path, default=Path("/usr/local/bin/opencode2"))
    parser.add_argument("--runtime-user")
    parser.add_argument("--target-version", default="unknown")
    parser.add_argument("--timeout", type=int, default=300)
    return parser.parse_args()


def ensure_plain_directory(path: Path, *, create: bool = False) -> None:
    path = Path(os.path.abspath(path))
    parent = path.parent
    if parent != path:
        ensure_plain_directory(parent, create=create)
    if path.is_symlink():
        raise MigrationError("unsafe_symlink")
    if path.exists():
        if not path.is_dir():
            raise MigrationError("unsafe_path_type")
        return
    if not create:
        raise MigrationError("missing_directory")
    path.mkdir(mode=0o700)


def ensure_plain_file(path: Path, *, hardlinks: bool = True) -> None:
    ensure_plain_directory(path.parent)
    stat = path.lstat()
    if path.is_symlink() or not path.is_file():
        raise MigrationError("unsafe_path_type")
    if hardlinks and stat.st_nlink != 1:
        raise MigrationError("unsafe_hardlink")


def fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path: Path, value: dict) -> None:
    ensure_plain_directory(path.parent, create=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def atomic_text(path: Path, value: str) -> None:
    ensure_plain_directory(path.parent, create=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="ascii") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def selected_source_files(source: Path) -> list[tuple[str, Path]]:
    selected = []
    for logical_name, name in (
        ("database", "opencode.db"),
        ("database_wal", "opencode.db-wal"),
        ("database_shm", "opencode.db-shm"),
        ("provider_auth", "auth.json"),
    ):
        path = source / name
        if path.exists() or path.is_symlink():
            ensure_plain_file(path)
            selected.append((logical_name, path))
    return selected


def table_count(database: Path, table: str, *, required: bool = False) -> int:
    if not database.exists():
        return 0
    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            if required:
                raise MigrationError("database_schema_mismatch")
            return 0
        return int(connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0])
    finally:
        connection.close()


def decode_object(raw: object, code: str) -> dict:
    if not isinstance(raw, str):
        raise MigrationError(code)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MigrationError(code) from error
    if not isinstance(value, dict):
        raise MigrationError(code)
    return value


def decode_json(raw: object, code: str) -> object:
    if not isinstance(raw, str):
        raise MigrationError(code)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise MigrationError(code) from error


def require_string(value: object, code: str) -> str:
    if not isinstance(value, str):
        raise MigrationError(code)
    return value


def require_dict(value: object, code: str) -> dict:
    if not isinstance(value, dict):
        raise MigrationError(code)
    return value


def require_list(value: object, code: str) -> list:
    if not isinstance(value, list):
        raise MigrationError(code)
    return value


def require_number(value: object, code: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MigrationError(code)
    return value


def require_nonnegative_int(value: object, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MigrationError(code)
    return value


def validate_optional(value: dict, key: str, expected: type, code: str) -> None:
    if key in value and not isinstance(value[key], expected):
        raise MigrationError(code)


def validate_tokens(value: object, code: str) -> None:
    tokens = require_dict(value, code)
    for key in ("input", "output", "reasoning"):
        require_number(tokens.get(key), code)
    if "total" in tokens:
        require_number(tokens["total"], code)
    cache = require_dict(tokens.get("cache"), code)
    require_number(cache.get("read"), code)
    require_number(cache.get("write"), code)


def validate_source_error(value: object) -> None:
    error = require_dict(value, "invalid_source_message")
    name = require_string(error.get("name"), "invalid_source_message")
    data = require_dict(error.get("data"), "invalid_source_message")
    supported = {
        "ProviderAuthError",
        "ContentFilterError",
        "ContextOverflowError",
        "StructuredOutputError",
        "MessageOutputLengthError",
        "MessageAbortedError",
        "APIError",
        "UnknownError",
    }
    if name not in supported:
        raise MigrationError("invalid_source_message")
    if name != "MessageOutputLengthError":
        require_string(data.get("message"), "invalid_source_message")
    if name == "ProviderAuthError":
        require_string(data.get("providerID"), "invalid_source_message")
    elif name == "StructuredOutputError":
        require_nonnegative_int(data.get("retries"), "invalid_source_message")
    elif name == "APIError" and not isinstance(data.get("isRetryable"), bool):
        raise MigrationError("invalid_source_message")


def validate_source_message(value: dict) -> None:
    role = value.get("role")
    time_value = require_dict(value.get("time"), "invalid_source_message")
    require_nonnegative_int(time_value.get("created"), "invalid_source_message")
    if "completed" in time_value:
        require_nonnegative_int(time_value["completed"], "invalid_source_message")
    if role == "user":
        require_string(value.get("agent"), "invalid_source_message")
        model = require_dict(value.get("model"), "invalid_source_message")
        require_string(model.get("providerID"), "invalid_source_message")
        require_string(model.get("modelID"), "invalid_source_message")
        validate_optional(model, "variant", str, "invalid_source_message")
        return
    if role != "assistant":
        raise MigrationError("invalid_source_message")
    for key in ("parentID", "modelID", "providerID", "mode", "agent"):
        require_string(value.get(key), "invalid_source_message")
    path = require_dict(value.get("path"), "invalid_source_message")
    require_string(path.get("cwd"), "invalid_source_message")
    require_string(path.get("root"), "invalid_source_message")
    require_number(value.get("cost"), "invalid_source_message")
    validate_tokens(value.get("tokens"), "invalid_source_message")
    validate_optional(value, "summary", bool, "invalid_source_message")
    validate_optional(value, "variant", str, "invalid_source_message")
    validate_optional(value, "finish", str, "invalid_source_message")
    if "error" in value:
        validate_source_error(value["error"])


def validate_file_part(value: dict) -> None:
    require_string(value.get("mime"), "invalid_source_part")
    require_string(value.get("url"), "invalid_source_part")
    validate_optional(value, "filename", str, "invalid_source_part")
    if "source" not in value:
        return
    source = require_dict(value["source"], "invalid_source_part")
    kind = source.get("type")
    if kind not in {"file", "symbol", "resource"}:
        raise MigrationError("invalid_source_part")
    text = require_dict(source.get("text"), "invalid_source_part")
    require_string(text.get("value"), "invalid_source_part")
    require_number(text.get("start"), "invalid_source_part")
    require_number(text.get("end"), "invalid_source_part")
    if kind == "resource":
        require_string(source.get("clientName"), "invalid_source_part")
        require_string(source.get("uri"), "invalid_source_part")
    else:
        require_string(source.get("path"), "invalid_source_part")


def validate_source_part(value: dict) -> None:
    kind = value.get("type")
    if kind == "text":
        require_string(value.get("text"), "invalid_source_part")
        validate_optional(value, "synthetic", bool, "invalid_source_part")
        validate_optional(value, "ignored", bool, "invalid_source_part")
        validate_optional(value, "metadata", dict, "invalid_source_part")
        if "time" in value:
            timing = require_dict(value["time"], "invalid_source_part")
            require_nonnegative_int(timing.get("start"), "invalid_source_part")
            if "end" in timing:
                require_nonnegative_int(timing["end"], "invalid_source_part")
        return
    if kind == "reasoning":
        require_string(value.get("text"), "invalid_source_part")
        validate_optional(value, "metadata", dict, "invalid_source_part")
        timing = require_dict(value.get("time"), "invalid_source_part")
        require_nonnegative_int(timing.get("start"), "invalid_source_part")
        if "end" in timing:
            require_nonnegative_int(timing["end"], "invalid_source_part")
        return
    if kind == "file":
        validate_file_part(value)
        return
    if kind == "agent":
        require_string(value.get("name"), "invalid_source_part")
        if "source" in value:
            source = require_dict(value["source"], "invalid_source_part")
            require_string(source.get("value"), "invalid_source_part")
            require_nonnegative_int(source.get("start"), "invalid_source_part")
            require_nonnegative_int(source.get("end"), "invalid_source_part")
        return
    if kind == "subtask":
        for key in ("prompt", "description", "agent"):
            require_string(value.get(key), "invalid_source_part")
        return
    if kind == "compaction":
        if not isinstance(value.get("auto"), bool):
            raise MigrationError("invalid_source_part")
        validate_optional(value, "tail_start_id", str, "invalid_source_part")
        return
    if kind == "tool":
        require_string(value.get("callID"), "invalid_source_part")
        require_string(value.get("tool"), "invalid_source_part")
        validate_optional(value, "metadata", dict, "invalid_source_part")
        state = require_dict(value.get("state"), "invalid_source_part")
        status = state.get("status")
        require_dict(state.get("input"), "invalid_source_part")
        if status == "pending":
            require_string(state.get("raw"), "invalid_source_part")
        elif status == "running":
            timing = require_dict(state.get("time"), "invalid_source_part")
            require_nonnegative_int(timing.get("start"), "invalid_source_part")
            validate_optional(state, "metadata", dict, "invalid_source_part")
        elif status == "completed":
            require_string(state.get("output"), "invalid_source_part")
            require_string(state.get("title"), "invalid_source_part")
            require_dict(state.get("metadata"), "invalid_source_part")
            timing = require_dict(state.get("time"), "invalid_source_part")
            require_nonnegative_int(timing.get("start"), "invalid_source_part")
            require_nonnegative_int(timing.get("end"), "invalid_source_part")
            if "compacted" in timing:
                require_nonnegative_int(timing["compacted"], "invalid_source_part")
            if "attachments" in state:
                for attachment in require_list(state["attachments"], "invalid_source_part"):
                    file = require_dict(attachment, "invalid_source_part")
                    if file.get("type") != "file":
                        raise MigrationError("invalid_source_part")
                    validate_file_part(file)
        elif status == "error":
            require_string(state.get("error"), "invalid_source_part")
            timing = require_dict(state.get("time"), "invalid_source_part")
            require_nonnegative_int(timing.get("start"), "invalid_source_part")
            require_nonnegative_int(timing.get("end"), "invalid_source_part")
            validate_optional(state, "metadata", dict, "invalid_source_part")
        else:
            raise MigrationError("invalid_source_part")
        return
    if kind == "snapshot":
        require_string(value.get("snapshot"), "invalid_source_part")
        return
    if kind == "patch":
        require_string(value.get("hash"), "invalid_source_part")
        if any(not isinstance(item, str) for item in require_list(value.get("files"), "invalid_source_part")):
            raise MigrationError("invalid_source_part")
        return
    if kind == "step-start":
        validate_optional(value, "snapshot", str, "invalid_source_part")
        return
    if kind == "step-finish":
        require_string(value.get("reason"), "invalid_source_part")
        validate_optional(value, "snapshot", str, "invalid_source_part")
        require_number(value.get("cost"), "invalid_source_part")
        validate_tokens(value.get("tokens"), "invalid_source_part")
        return
    if kind == "retry":
        require_nonnegative_int(value.get("attempt"), "invalid_source_part")
        require_dict(value.get("error"), "invalid_source_part")
        timing = require_dict(value.get("time"), "invalid_source_part")
        require_number(timing.get("created"), "invalid_source_part")
        return
    raise MigrationError("invalid_source_part")


def counted_source_part(value: dict) -> bool:
    kind = value.get("type")
    if kind in {"file", "agent", "subtask", "tool"}:
        return True
    if kind in {"text", "reasoning"}:
        text = value.get("text")
        return isinstance(text, str) and bool(text) and not (
            kind == "text" and value.get("ignored") is True
        )
    return False


def source_content_part_count(database: Path) -> int:
    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    count = 0
    try:
        for (raw_data,) in connection.execute("SELECT data FROM part"):
            part = decode_object(raw_data, "invalid_source_part")
            validate_source_part(part)
            count += int(counted_source_part(part))
        return count
    finally:
        connection.close()


def json_equal(left: object, right: object) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math.isfinite(left) and math.isfinite(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(json_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def decode_node_base64(value: str) -> bytes:
    compact = "".join(character for character in value if not character.isspace()).replace("-", "+").replace("_", "/")
    if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", compact) or "=" in compact[:-2]:
        raise MigrationError("invalid_source_part")
    payload = compact.rstrip("=")
    if len(payload) % 4 == 1:
        raise MigrationError("invalid_source_part")
    try:
        return base64.b64decode(payload + "=" * ((-len(payload)) % 4), validate=True)
    except ValueError as error:
        raise MigrationError("invalid_source_part") from error


def migrate_file(part: dict) -> list[dict]:
    url = part["url"]
    if not url.startswith("data:"):
        return []
    comma = url.find(",")
    if comma < 0:
        return []
    header = url[:comma]
    payload = url[comma + 1 :]
    if header.endswith(";base64"):
        raw = decode_node_base64(payload)
    else:
        if re.search(r"%(?![0-9A-Fa-f]{2})", payload):
            raise MigrationError("invalid_source_part")
        raw = urllib.parse.unquote_to_bytes(payload)
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise MigrationError("invalid_source_part") from error
    source = part.get("source")
    result = {
        "data": base64.b64encode(raw).decode("ascii"),
        "mime": part["mime"],
        "source": {"type": "uri", "uri": source["uri"]}
        if isinstance(source, dict) and source.get("type") == "resource"
        else {"type": "inline"},
    }
    if part.get("filename"):
        result["name"] = part["filename"]
    if isinstance(source, dict):
        result["mention"] = {
            "text": source["text"]["value"],
            "start": source["text"]["start"],
            "end": source["text"]["end"],
        }
    return [result]


def unavailable_file(part: dict) -> str:
    source = part.get("source")
    label = part["filename"] if "filename" in part else (
        source["uri"] if isinstance(source, dict) and source.get("type") == "resource" else part["url"]
    )
    return f"[Attachment unavailable after migration: {label} ({part['mime']})]"


def migrate_tool(part: dict, fallback: int) -> dict:
    state = part["state"]
    result = {"type": "tool", "id": part["callID"], "name": part["tool"]}
    if "metadata" in part:
        result["providerState"] = part["metadata"]
    if state["status"] == "completed":
        content = [{"type": "text", "text": state["output"]}]
        if "compacted" in state["time"]:
            content = [{"type": "text", "text": "[Old tool result content cleared]"}]
        else:
            content.extend(
                {
                    "type": "file",
                    "uri": attachment["url"],
                    "mime": attachment["mime"],
                    **({"name": attachment["filename"]} if attachment.get("filename") else {}),
                }
                for attachment in state.get("attachments", [])
            )
        result["state"] = {
            "status": "completed",
            "input": state["input"],
            "content": content,
            "metadata": state["metadata"],
        }
        result["time"] = {"created": state["time"]["start"], "completed": state["time"]["end"]}
        return result
    if state["status"] == "error":
        target_state = {
            "status": "error",
            "input": state["input"],
            "error": {"type": "tool.execution", "message": state["error"]},
        }
        metadata = state.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("output"), str):
            target_state["content"] = [{"type": "text", "text": metadata["output"]}]
        if "metadata" in state:
            target_state["metadata"] = state["metadata"]
        result["state"] = target_state
        result["time"] = {"created": state["time"]["start"], "completed": state["time"]["end"]}
        return result
    target_state = {
        "status": "error",
        "input": state["input"],
        "error": {
            "type": "tool.interrupted",
            "message": "Tool execution was interrupted before V2 migration",
        },
    }
    if state["status"] == "running" and "metadata" in state:
        target_state["metadata"] = state["metadata"]
    result["state"] = target_state
    result["time"] = {"created": state["time"]["start"] if state["status"] == "running" else fallback}
    return result


def migrate_error(value: dict) -> dict:
    name = value["name"]
    data = value["data"]
    message = data.get("message")
    if not isinstance(message, str):
        message = "The model exceeded its output limit" if name == "MessageOutputLengthError" else name
    target_type = {
        "ProviderAuthError": "provider.auth",
        "ContentFilterError": "provider.content-filter",
        "ContextOverflowError": "provider.invalid-request",
        "StructuredOutputError": "provider.invalid-output",
        "MessageOutputLengthError": "provider.invalid-output",
        "MessageAbortedError": "aborted",
        "APIError": "provider.error",
    }.get(name, "unknown")
    return {"type": target_type, "message": message}


def synthetic_id(source: str, used: set[str]) -> str:
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    prefix = source[:16]
    salt = 0
    while True:
        seed = f"v1-synthetic:{source}{f':{salt}' if salt else ''}"
        value = int(hashlib.sha256(seed.encode()).hexdigest(), 16)
        suffix = ""
        while len(suffix) < 14:
            suffix = alphabet[value % 62] + suffix
            value //= 62
        candidate = prefix + suffix
        if candidate not in used:
            used.add(candidate)
            return candidate
        salt += 1


def serialize_recent(messages: list[dict], parts_by_message: dict[str, list[dict]]) -> str:
    result = []
    for message in messages:
        owned = parts_by_message.get(message["id"], [])
        if message["value"]["role"] == "user":
            text = "\n\n".join(
                part["text"]
                for part in owned
                if part["type"] == "text" and part.get("ignored") is not True
            )
            result.append(f"[User]: {text}")
            continue
        for part in owned:
            if part["type"] == "text":
                result.append(f"[Assistant]: {part['text']}")
            elif part["type"] == "reasoning" and part["text"]:
                result.append(f"[Assistant reasoning]: {part['text']}")
    return "\n\n".join(result)


def project_session(
    source_session: dict,
    message_rows: list[tuple],
    part_rows: list[tuple],
) -> tuple[list[dict], int, dict]:
    messages = []
    for message_id, session_id, time_created, time_updated, raw in message_rows:
        if not isinstance(message_id, str) or not isinstance(session_id, str):
            raise MigrationError("invalid_source_message")
        require_nonnegative_int(time_created, "invalid_source_message")
        require_nonnegative_int(time_updated, "invalid_source_message")
        value = decode_object(raw, "invalid_source_message")
        validate_source_message(value)
        messages.append(
            {
                "id": message_id,
                "session_id": session_id,
                "time_created": time_created,
                "time_updated": time_updated,
                "value": value,
            }
        )
    messages.sort(key=lambda item: (item["time_created"], item["id"]))
    message_ids = {message["id"] for message in messages}
    parts_by_message: dict[str, list[dict]] = {}
    validated_parts = 0
    for part_id, message_id, session_id, _created, _updated, raw in part_rows:
        if not all(isinstance(value, str) for value in (part_id, message_id, session_id)):
            raise MigrationError("invalid_source_part")
        if message_id not in message_ids:
            raise MigrationError("invalid_source_part")
        part = decode_object(raw, "invalid_source_part")
        validate_source_part(part)
        part["_id"] = part_id
        parts_by_message.setdefault(message_id, []).append(part)
        validated_parts += int(counted_source_part(part))
    for parts in parts_by_message.values():
        parts.sort(key=lambda item: item["_id"])

    paired: set[str] = set()
    used = set(message_ids)
    projected = []
    for message_index, message in enumerate(messages):
        if message["id"] in paired:
            continue
        value = message["value"]
        owned = parts_by_message.get(message["id"], [])
        if value["role"] == "user":
            compaction = next((part for part in owned if part["type"] == "compaction"), None)
            if compaction:
                summary = next(
                    (
                        candidate
                        for candidate in messages
                        if candidate["value"]["role"] == "assistant"
                        and candidate["value"]["parentID"] == message["id"]
                        and candidate["value"].get("summary") is True
                    ),
                    None,
                )
                if not summary:
                    continue
                paired.add(summary["id"])
                if "error" in summary["value"] or "completed" not in summary["value"]["time"]:
                    continue
                summary_text = "\n\n".join(
                    part["text"]
                    for part in parts_by_message.get(summary["id"], [])
                    if part["type"] == "text" and part["text"]
                )
                tail_start = compaction.get("tail_start_id")
                tail_index = next(
                    (index for index, candidate in enumerate(messages) if candidate["id"] == tail_start),
                    -1,
                ) if tail_start else -1
                tail = messages[tail_index:message_index] if 0 <= tail_index < message_index else []
                projected.append(
                    {
                        "id": message["id"],
                        "session_id": message["session_id"],
                        "type": "compaction",
                        "time_created": message["time_created"],
                        "time_updated": max(message["time_updated"], summary["time_updated"]),
                        "data": {
                            "status": "completed",
                            "reason": "auto" if compaction["auto"] else "manual",
                            "summary": summary_text,
                            "recent": serialize_recent(tail, parts_by_message),
                            "time": {"created": message["time_created"]},
                        },
                    }
                )
                continue
            subtasks = [part for part in owned if part["type"] == "subtask"]
            visible = [part for part in owned if part["type"] == "text" and part.get("ignored") is not True]
            files = [part for part in owned if part["type"] == "file"]
            agents = [part for part in owned if part["type"] == "agent"]
            if subtasks and not visible and not files and not agents:
                continue
            ordinary = [part for part in visible if part.get("synthetic") is not True]
            synthetic = [part for part in visible if part.get("synthetic") is True]
            attachments = [attachment for part in files for attachment in migrate_file(part)]
            unavailable = [unavailable_file(part) for part in files if not part["url"].startswith("data:")]
            text = "\n\n".join(
                part["text"] if part["type"] == "text" else unavailable_file(part)
                for part in owned
                if (part["type"] == "text" and part.get("ignored") is not True and part.get("synthetic") is not True)
                or (part["type"] == "file" and not part["url"].startswith("data:"))
            )
            agent_attachments = []
            for part in agents:
                agent = {"name": part["name"]}
                if "source" in part:
                    agent["mention"] = {
                        "text": part["source"]["value"],
                        "start": part["source"]["start"],
                        "end": part["source"]["end"],
                    }
                agent_attachments.append(agent)
            if not ordinary and not unavailable and synthetic and not attachments and not agent_attachments:
                projected.append(
                    {
                        "id": message["id"],
                        "session_id": message["session_id"],
                        "type": "synthetic",
                        "time_created": message["time_created"],
                        "time_updated": message["time_updated"],
                        "data": {
                            "text": "\n\n".join(part["text"] for part in synthetic),
                            "time": {"created": message["time_created"]},
                        },
                    }
                )
                continue
            user_data = {"text": text}
            if attachments:
                user_data["files"] = attachments
            if agent_attachments:
                user_data["agents"] = agent_attachments
            user_data["time"] = {"created": message["time_created"]}
            projected.append(
                {
                    "id": message["id"],
                    "session_id": message["session_id"],
                    "type": "user",
                    "time_created": message["time_created"],
                    "time_updated": message["time_updated"],
                    "data": user_data,
                }
            )
            if synthetic:
                projected.append(
                    {
                        "id": synthetic_id(message["id"], used),
                        "session_id": message["session_id"],
                        "type": "synthetic",
                        "time_created": message["time_created"],
                        "time_updated": message["time_updated"],
                        "data": {
                            "text": "\n\n".join(part["text"] for part in synthetic),
                            "time": {"created": message["time_created"]},
                        },
                    }
                )
            continue

        parent = next((candidate for candidate in messages if candidate["id"] == value["parentID"]), None)
        parent_parts = parts_by_message.get(parent["id"], []) if parent else []
        if any(part["type"] == "subtask" for part in parent_parts) and any(
            part["type"] == "tool" and part["tool"] == "task" for part in owned
        ):
            continue
        content = []
        for part in owned:
            if part["type"] == "text":
                item = {"type": "text", "text": part["text"]}
                if "metadata" in part:
                    item["state"] = part["metadata"]
                content.append(item)
            elif part["type"] == "reasoning":
                item = {"type": "reasoning", "text": part["text"]}
                if "metadata" in part:
                    item["state"] = part["metadata"]
                item["time"] = {"created": part["time"]["start"]}
                if "end" in part["time"]:
                    item["time"]["completed"] = part["time"]["end"]
                content.append(item)
            elif part["type"] == "tool":
                content.append(migrate_tool(part, message["time_created"]))
        starts = [part["snapshot"] for part in owned if part["type"] == "step-start" and part.get("snapshot")]
        snapshots = [part["snapshot"] for part in owned if part["type"] == "snapshot"]
        patches = [part["hash"] for part in owned if part["type"] == "patch"]
        start = starts[0] if starts else snapshots[0] if snapshots else patches[0] if patches else None
        ends = [part["snapshot"] for part in owned if part["type"] == "step-finish" and part.get("snapshot")]
        end = ends[-1] if ends else None
        snapshot_files = []
        for part in owned:
            if part["type"] == "patch":
                for file in part["files"]:
                    if file not in snapshot_files:
                        snapshot_files.append(file)
        assistant_data = {
            "agent": value["agent"],
            "model": {
                "providerID": value["providerID"],
                "id": value["modelID"],
                "variant": value.get("variant", "default"),
            },
            "content": content,
        }
        if start or end or snapshot_files:
            assistant_data["snapshot"] = {}
            if start:
                assistant_data["snapshot"]["start"] = start
            if end:
                assistant_data["snapshot"]["end"] = end
            if snapshot_files:
                assistant_data["snapshot"]["files"] = snapshot_files
        finish = value.get("finish")
        if finish:
            assistant_data["finish"] = finish if finish in {
                "stop", "length", "tool-calls", "content-filter", "error", "unknown"
            } else "unknown"
        assistant_data["cost"] = value["cost"]
        assistant_data["tokens"] = {
            "input": value["tokens"]["input"],
            "output": value["tokens"]["output"],
            "reasoning": value["tokens"]["reasoning"],
            "cache": value["tokens"]["cache"],
        }
        if "error" in value:
            assistant_data["error"] = migrate_error(value["error"])
        assistant_data["time"] = {"created": message["time_created"]}
        if "completed" in value["time"]:
            assistant_data["time"]["completed"] = message["time_updated"]
        projected.append(
            {
                "id": message["id"],
                "session_id": message["session_id"],
                "type": "assistant",
                "time_created": message["time_created"],
                "time_updated": message["time_updated"],
                "data": assistant_data,
            }
        )
    for sequence, message in enumerate(projected):
        message["seq"] = sequence
    assistants = [
        message["value"] for message in messages if message["value"]["role"] == "assistant"
    ]
    latest_user = None
    for message in messages:
        if message["value"]["role"] != "user":
            continue
        owned = parts_by_message.get(message["id"], [])
        if any(part["type"] == "compaction" for part in owned):
            continue
        if any(part["type"] == "subtask" for part in owned) and all(
            part["type"] == "subtask" for part in owned
        ):
            continue
        latest_user = message["value"]

    source_agent = source_session["agent"]
    if source_agent is not None and not isinstance(source_agent, str):
        raise MigrationError("invalid_source_session")
    source_model = source_session["model"]
    if source_model is not None:
        source_model = decode_object(source_model, "invalid_source_session")
        require_string(source_model.get("id"), "invalid_source_session")
        require_string(source_model.get("providerID"), "invalid_source_session")
        validate_optional(source_model, "variant", str, "invalid_source_session")
    elif latest_user is not None:
        source_model = {
            "id": latest_user["model"]["modelID"],
            "providerID": latest_user["model"]["providerID"],
            "variant": latest_user["model"].get("variant", "default"),
        }
    projected_session = {
        "agent": source_agent if source_agent is not None else (
            latest_user["agent"] if latest_user is not None else None
        ),
        "model": source_model,
        "cost": sum(message["cost"] for message in assistants),
        "tokens_input": sum(message["tokens"]["input"] for message in assistants),
        "tokens_output": sum(message["tokens"]["output"] for message in assistants),
        "tokens_reasoning": sum(message["tokens"]["reasoning"] for message in assistants),
        "tokens_cache_read": sum(message["tokens"]["cache"]["read"] for message in assistants),
        "tokens_cache_write": sum(message["tokens"]["cache"]["write"] for message in assistants),
        "revert": None,
        "time_compacting": None,
    }
    return projected, validated_parts, projected_session


def validate_session_projection(
    source_database: Path,
    target_database: Path,
) -> tuple[int, int, int]:
    source_uri = source_database.resolve().as_uri() + "?mode=ro"
    target_uri = target_database.resolve().as_uri() + "?mode=ro"
    source = sqlite3.connect(source_uri, uri=True, timeout=30)
    target = sqlite3.connect(target_uri, uri=True, timeout=30)
    validated_parts = 0
    expected_count = 0
    processed_messages = 0
    processed_parts = 0
    try:
        source_session_count = int(source.execute("SELECT count(*) FROM session").fetchone()[0])
        source_sessions = source.execute(
            f"SELECT {', '.join(SOURCE_SESSION_COLUMNS)} FROM session ORDER BY id"
        )
        target_session_count = int(target.execute("SELECT count(*) FROM session_v2").fetchone()[0])
        if target_session_count != source_session_count:
            raise MigrationError("session_count_mismatch")
        target_count = int(target.execute("SELECT count(*) FROM session_message").fetchone()[0])
        for source_row in source_sessions:
            source_session = dict(zip(SOURCE_SESSION_COLUMNS, source_row))
            session_id = source_session["id"]
            if not isinstance(session_id, str):
                raise MigrationError("invalid_source_session")
            source_project = source_session["project_id"]
            if not isinstance(source_project, str):
                raise MigrationError("invalid_source_session")
            message_rows = source.execute(
                "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id=?",
                (session_id,),
            ).fetchall()
            part_rows = source.execute(
                "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id=?",
                (session_id,),
            ).fetchall()
            processed_messages += len(message_rows)
            processed_parts += len(part_rows)
            expected, session_parts, projected_session = project_session(
                source_session, message_rows, part_rows
            )
            validated_parts += session_parts
            expected_count += len(expected)
            project_exists = source.execute(
                "SELECT 1 FROM project WHERE id=?", (source_project,)
            ).fetchone()
            expected_session = {
                "id": session_id,
                "project_id": source_project if project_exists else "global",
                **{
                    column: source_session[column]
                    for column in COPIED_SESSION_COLUMNS
                },
                **projected_session,
                **TARGET_ONLY_SESSION_DEFAULTS,
            }
            target_session_row = target.execute(
                f"SELECT {', '.join(expected_session)} FROM session_v2 WHERE id=?",
                (session_id,),
            ).fetchone()
            if target_session_row is None:
                raise MigrationError("session_identity_mismatch")
            actual_session = dict(zip(expected_session, target_session_row))
            for column in SESSION_JSON_COLUMNS:
                if expected_session[column] is not None and isinstance(expected_session[column], str):
                    expected_session[column] = decode_json(
                        expected_session[column], "invalid_source_session"
                    )
                if actual_session[column] is not None:
                    actual_session[column] = decode_json(
                        actual_session[column], "invalid_target_session"
                    )
            if not json_equal(expected_session, actual_session):
                raise MigrationError("session_projection_mismatch")

            sequence_rows = target.execute(
                "SELECT seq, owner_id FROM event_sequence WHERE aggregate_id=?",
                (session_id,),
            ).fetchall()
            if sequence_rows != [(len(expected) - 1, None)]:
                raise MigrationError("event_sequence_mismatch")
            target_rows = target.execute(
                "SELECT id, session_id, type, seq, time_created, time_updated, data "
                "FROM session_message WHERE session_id=? ORDER BY seq, id",
                (session_id,),
            ).fetchall()
            if len(target_rows) != len(expected):
                raise MigrationError("message_count_mismatch")
            for wanted, actual in zip(expected, target_rows):
                message_id, target_session, target_type, sequence, created, updated, raw_target = actual
                if message_id != wanted["id"]:
                    raise MigrationError("message_identity_mismatch")
                if (
                    target_session != wanted["session_id"]
                    or target_type != wanted["type"]
                    or sequence != wanted["seq"]
                    or created != wanted["time_created"]
                    or updated != wanted["time_updated"]
                ):
                    raise MigrationError("message_projection_mismatch")
                target_data = decode_object(raw_target, "invalid_target_message")
                if "id" in target_data or "type" in target_data:
                    raise MigrationError("message_projection_mismatch")
                hydrated = {"id": message_id, "type": target_type, **target_data}
                wanted_hydrated = {"id": wanted["id"], "type": wanted["type"], **wanted["data"]}
                if not json_equal(wanted_hydrated, hydrated):
                    raise MigrationError("message_projection_mismatch")
        if processed_messages != int(source.execute("SELECT count(*) FROM message").fetchone()[0]):
            raise MigrationError("invalid_source_message")
        if processed_parts != int(source.execute("SELECT count(*) FROM part").fetchone()[0]):
            raise MigrationError("invalid_source_part")
        if expected_count != target_count:
            raise MigrationError("message_count_mismatch")
    finally:
        source.close()
        target.close()
    return target_session_count, target_count, validated_parts


def read_string_list_kv(
    database: Path | None,
    key: str,
    code: str,
    *,
    strict: bool = True,
) -> list[str]:
    if database is None:
        return []
    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'"
        ).fetchone()
        if not table:
            return []
        row = connection.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    finally:
        connection.close()
    if not row:
        return []
    if not isinstance(row[0], str):
        if strict:
            raise MigrationError(code)
        return []
    try:
        value = json.loads(row[0])
    except json.JSONDecodeError as error:
        if strict:
            raise MigrationError(code) from error
        return []
    if not isinstance(value, list):
        if strict:
            raise MigrationError(code)
        return []
    if strict and any(not isinstance(item, str) for item in value):
        raise MigrationError(code)
    return [item for item in value if isinstance(item, str)]


def credential_method(integration_id: str) -> str:
    if integration_id == "openai":
        return "chatgpt-browser"
    if integration_id in {"github-copilot", "opencode", "xai"}:
        return "device"
    return "oauth"


def expected_credential(integration_id: str, source: dict) -> dict:
    kind = source.get("type")
    if kind == "api":
        result = {"type": "key", "key": source["key"]}
        if "metadata" in source:
            result["metadata"] = source["metadata"]
        return result
    if kind == "wellknown":
        return {"type": "key", "key": source["token"]}
    result = {
        "type": "oauth",
        "methodID": credential_method(integration_id),
        "refresh": source["refresh"],
        "access": source["access"],
        "expires": source["expires"],
    }
    metadata = {}
    if source.get("accountId"):
        metadata["accountID"] = source["accountId"]
    if source.get("enterpriseUrl"):
        metadata["enterpriseUrl"] = source["enterpriseUrl"]
    if metadata:
        result["metadata"] = metadata
    return result


def validate_provider_credential(credential: object) -> dict:
    if not isinstance(credential, dict):
        raise MigrationError("invalid_provider_auth")
    kind = credential.get("type")
    if kind == "api":
        if not isinstance(credential.get("key"), str):
            raise MigrationError("invalid_provider_auth")
        if "metadata" in credential:
            metadata = credential["metadata"]
            if not isinstance(metadata, dict) or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in metadata.items()
            ):
                raise MigrationError("invalid_provider_auth")
    elif kind == "oauth":
        expires = credential.get("expires")
        if (
            not isinstance(credential.get("refresh"), str)
            or not isinstance(credential.get("access"), str)
            or isinstance(expires, bool)
            or not isinstance(expires, int)
            or expires < 0
        ):
            raise MigrationError("invalid_provider_auth")
        validate_optional(credential, "accountId", str, "invalid_provider_auth")
        validate_optional(credential, "enterpriseUrl", str, "invalid_provider_auth")
    elif kind == "wellknown":
        if not isinstance(credential.get("key"), str) or not isinstance(credential.get("token"), str):
            raise MigrationError("invalid_provider_auth")
    else:
        raise MigrationError("invalid_provider_auth")
    return credential


def normalize_provider_credentials(source_credentials: dict) -> dict[str, dict]:
    normalized = {}
    for provider, credential in source_credentials.items():
        credential = validate_provider_credential(credential)
        integration_id = provider.rstrip("/")
        if not integration_id:
            raise MigrationError("invalid_provider_auth_id")
        if integration_id in normalized:
            raise MigrationError("provider_auth_id_collision")
        normalized[integration_id] = credential
    return normalized


def validate_credentials(
    database: Path,
    source_credentials: dict,
    source_database: Path | None = None,
) -> int:
    expected: dict[str, dict] = {}
    origins = []
    for integration_id, credential in normalize_provider_credentials(source_credentials).items():
        if credential.get("type") == "wellknown" and integration_id not in origins:
            origins.append(integration_id)
        expected[integration_id] = expected_credential(integration_id, credential)

    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        rows = connection.execute(
            "SELECT id, integration_id, label, value, connector_id, method_id FROM credential"
        ).fetchall()
    finally:
        connection.close()
    if len(rows) != len(expected):
        raise MigrationError("provider_auth_count_mismatch")
    found = set()
    for row in rows:
        integration_id = row[1]
        if not isinstance(integration_id, str) or integration_id in found or integration_id not in expected:
            raise MigrationError("provider_auth_mismatch")
        target_value = decode_object(row[3], "invalid_target_credential")
        expected_value = expected[integration_id]
        expected_label = "OAuth" if expected_value["type"] == "oauth" else "API key"
        if (
            row[2] != expected_label
            or row[4] is not None
            or row[5] is not None
            or not json_equal(expected_value, target_value)
        ):
            raise MigrationError("provider_auth_mismatch")
        found.add(integration_id)
    if found != set(expected):
        raise MigrationError("provider_auth_mismatch")

    baseline = read_string_list_kv(
        source_database,
        "wellknown:sources",
        "invalid_source_wellknown_sources",
        strict=False,
    )
    expected_origins = []
    for value in baseline + origins:
        if value not in expected_origins:
            expected_origins.append(value)
    target_origins = read_string_list_kv(database, "wellknown:sources", "invalid_target_wellknown_sources")
    if target_origins != expected_origins:
        raise MigrationError("provider_auth_mismatch")
    return len(rows)


def inventory(source: Path) -> dict:
    if not source.exists() and not source.is_symlink():
        return {
            "database": False,
            "database_bytes": 0,
            "database_sidecars": False,
            "provider_auth": False,
            "provider_auth_count": 0,
            "session_count": 0,
            "message_count": 0,
            "part_count": 0,
            "content_part_count": 0,
            "legacy_json_store": False,
        }

    ensure_plain_directory(source)
    files = dict(selected_source_files(source))
    storage = source / "storage"
    if storage.exists() or storage.is_symlink():
        ensure_plain_directory(storage)
    database = files.get("database")
    provider_auth = files.get("provider_auth")
    database_bytes = sum(
        path.stat().st_size
        for name, path in files.items()
        if name in {"database", "database_wal"}
    )
    if database_bytes > MAX_DATABASE_BYTES:
        raise MigrationError("database_too_large")
    return {
        "database": database is not None,
        "database_bytes": database_bytes,
        "database_sidecars": "database_wal" in files or "database_shm" in files,
        "provider_auth": provider_auth is not None,
        "provider_auth_count": len(read_provider_auth(provider_auth)) if provider_auth else 0,
        # Counting opens SQLite and may create a shared-memory file for a WAL.
        # The count is filled from the private cold copy instead.
        "session_count": None if database else 0,
        "message_count": None if database else 0,
        "part_count": None if database else 0,
        "content_part_count": None if database else 0,
        "legacy_json_store": storage.exists(),
    }


def snapshot_database(source: Path, target: Path) -> None:
    ensure_plain_file(source)
    ensure_plain_directory(target.parent, create=True)
    source_uri = source.resolve().as_uri() + "?mode=ro"
    source_connection = sqlite3.connect(source_uri, uri=True, timeout=30)
    target_connection = sqlite3.connect(target)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
    os.chmod(target, 0o600)


def source_database_is_open(source: Path) -> bool:
    if os.name == "nt" or not Path("/proc").is_dir():
        return False
    targets = {
        str(source.resolve()),
        str(source.with_name(source.name + "-wal").resolve()),
        str(source.with_name(source.name + "-shm").resolve()),
    }
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        descriptors = process / "fd"
        try:
            entries = list(descriptors.iterdir())
        except (FileNotFoundError, PermissionError):
            continue
        for descriptor in entries:
            try:
                opened = os.readlink(descriptor)
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if opened.removesuffix(" (deleted)") in targets:
                return True
    return False


def cold_snapshot(
    source_files: dict[str, Path],
    candidate: Path,
    target: Path,
    validation: Path,
) -> None:
    source = source_files["database"]
    if source_database_is_open(source):
        raise MigrationError("source_database_in_use")

    raw = candidate / "cache" / "v1-snapshot"
    ensure_plain_directory(raw, create=True)
    raw_database = raw / "opencode.db"
    shutil.copyfile(source, raw_database)
    os.chmod(raw_database, 0o600)
    if "database_wal" in source_files:
        raw_wal = raw / "opencode.db-wal"
        shutil.copyfile(source_files["database_wal"], raw_wal)
        os.chmod(raw_wal, 0o600)
    snapshot_database(raw_database, target)
    snapshot_database(target, validation)
    shutil.rmtree(raw)


@contextlib.contextmanager
def migration_lock(path: Path):
    ensure_plain_directory(path.parent, create=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    handle = os.fdopen(descriptor, "r+b", buffering=0)
    try:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise MigrationError("unsafe_lock_file")
        if os.name == "nt":
            import msvcrt

            if info.st_size == 0:
                handle.write(b"\0")
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise MigrationError("migration_locked") from error
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise MigrationError("migration_locked") from error
        yield
    finally:
        if os.name == "nt" and not handle.closed:
            import msvcrt

            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        handle.close()


def read_provider_auth(source: Path) -> dict:
    ensure_plain_file(source)
    if source.stat().st_size > MAX_AUTH_BYTES:
        raise MigrationError("provider_auth_too_large")
    try:
        with source.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MigrationError("invalid_provider_auth") from error
    if not isinstance(value, dict):
        raise MigrationError("invalid_provider_auth")
    normalize_provider_credentials(value)
    return value


def copy_provider_auth(source: Path, target: Path) -> dict:
    value = read_provider_auth(source)
    ensure_plain_directory(target.parent, create=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    return value


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_process(process: subprocess.Popen) -> None:
    if os.name == "nt":
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/pid", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        return
    process_group = process.pid
    if process_group_exists(process_group):
        try:
            os.killpg(process_group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        process.poll()
        if not process_group_exists(process_group):
            return
        time.sleep(0.05)
    try:
        os.killpg(process_group, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        process.poll()
        if not process_group_exists(process_group):
            return
        time.sleep(0.05)
    raise MigrationError("v2_process_cleanup_failed")


def runtime_identity(name: str | None) -> tuple[int, int] | None:
    if os.name == "nt":
        return None
    if not name:
        return os.geteuid(), os.getegid()
    import pwd

    try:
        user = pwd.getpwnam(name)
    except KeyError as error:
        raise MigrationError("missing_runtime_user") from error
    return user.pw_uid, user.pw_gid


def require_source_isolation(source: Path, identity: tuple[int, int] | None) -> None:
    if os.name == "nt" or not identity or not source.exists():
        return
    uid, gid = identity
    info = source.stat()
    if info.st_uid == uid:
        raise MigrationError("source_visible_to_v2")
    if info.st_mode & 0o007:
        raise MigrationError("source_visible_to_v2")
    if info.st_gid == gid and info.st_mode & 0o070:
        raise MigrationError("source_visible_to_v2")


def chown_subtree(root: Path, uid: int, gid: int) -> None:
    os.chown(root, uid, gid, follow_symlinks=False)
    for directory, directories, files in os.walk(root, topdown=True, followlinks=False):
        path = Path(directory)
        for name in directories + files:
            child = path / name
            if child.is_symlink():
                raise MigrationError("unsafe_symlink")
            os.chown(child, uid, gid, follow_symlinks=False)


def minimal_environment(candidate: Path, runtime_user: str | None) -> dict[str, str]:
    environment = {
        "HOME": str(candidate / "home"),
        "XDG_CONFIG_HOME": str(candidate / "config"),
        "XDG_DATA_HOME": str(candidate / "data"),
        "XDG_STATE_HOME": str(candidate / "state"),
        "XDG_CACHE_HOME": str(candidate / "cache"),
        "TMPDIR": str(candidate / "cache" / "tmp"),
        "PATH": os.environ.get("PATH", "") if os.name == "nt" else "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        "OPENCODE_SERVER_USERNAME": "opencode",
    }
    if runtime_user:
        environment["USER"] = runtime_user
        environment["LOGNAME"] = runtime_user
    if os.name == "nt":
        for name in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"):
            if value := os.environ.get(name):
                environment[name] = value
    return environment


def convert_candidate(
    candidate: Path,
    v2_bin: Path,
    timeout: int,
    runtime_user: str | None,
) -> None:
    if not v2_bin.is_file():
        raise MigrationError("missing_v2_runtime")

    config = candidate / "config" / "opencode" / "managed.json"
    atomic_json(
        config,
        {
            "$schema": "https://opencode.ai/config.json",
            "autoupdate": False,
            "plugins": [],
            "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
        },
    )

    ensure_plain_directory(candidate / "cache" / "tmp", create=True)
    identity = runtime_identity(runtime_user)
    if identity and identity != (os.geteuid(), os.getegid()):
        os.chmod(candidate, 0o711)
        for leaf in ("home", "config", "data", "state", "cache"):
            chown_subtree(candidate / leaf, *identity)
    environment = minimal_environment(candidate, runtime_user)
    environment["OPENCODE_CONFIG"] = str(config)
    password = uuid.uuid4().hex + uuid.uuid4().hex
    environment["OPENCODE_SERVER_PASSWORD"] = password
    port = available_port()
    command = [
        str(v2_bin),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    diagnostic_path = candidate.parent / f".{candidate.name}.conversion.log"
    diagnostic_descriptor = os.open(
        diagnostic_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    diagnostics = os.fdopen(diagnostic_descriptor, "wb", buffering=0)
    popen_options = {
        "cwd": str(candidate / "home"),
        "env": environment,
        "stdin": subprocess.DEVNULL,
        "stdout": diagnostics,
        "stderr": diagnostics,
    }
    if os.name == "nt":
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_options["start_new_session"] = True
        if identity and identity != (os.geteuid(), os.getegid()):
            uid, gid = identity

            def demote() -> None:
                os.setgroups([])
                os.setgid(gid)
                os.setuid(uid)

            popen_options["preexec_fn"] = demote
    try:
        process = subprocess.Popen(command, **popen_options)
    except Exception:
        diagnostics.close()
        diagnostic_path.unlink(missing_ok=True)
        raise

    authorization = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/experimental/migration/v1",
        headers={"Authorization": f"Basic {authorization}"},
    )
    deadline = time.monotonic() + timeout
    cleanup_error = None
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise MigrationError("v2_runtime_exited")
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    status = json.load(response)
                current = status.get("status") if isinstance(status, dict) else None
                if current == "completed":
                    return
                if current == "error":
                    raise MigrationError("v2_conversion_failed")
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                pass
            time.sleep(0.1)
        raise MigrationError("v2_conversion_timeout")
    finally:
        try:
            stop_process(process)
        except MigrationError as error:
            cleanup_error = error
        diagnostics.close()
        try:
            if diagnostic_path.stat().st_size > 1024 * 1024:
                raise MigrationError("conversion_diagnostics_too_large")
            diagnostic_text = diagnostic_path.read_text(encoding="utf-8", errors="replace")
            if re.search(
                r"\b(skipped|orphan(?:ed)?|failed to migrate|migration (?:error|failed))\b",
                diagnostic_text,
                re.IGNORECASE,
            ):
                raise MigrationError("lossy_v2_conversion")
        finally:
            diagnostic_path.unlink(missing_ok=True)
        if cleanup_error:
            raise cleanup_error


def validate_database(database: Path) -> None:
    connection = sqlite3.connect(database, timeout=30)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise MigrationError("target_integrity_failed")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise MigrationError("target_foreign_keys_failed")
    finally:
        connection.close()


def validate_tree(root: Path) -> None:
    ensure_plain_directory(root)
    for directory, directories, files in os.walk(root, topdown=True, followlinks=False):
        path = Path(directory)
        if path.is_symlink():
            raise MigrationError("unsafe_symlink")
        for name in directories:
            child = path / name
            if child.is_symlink() or not child.is_dir():
                raise MigrationError("unsafe_path_type")
        for name in files:
            file = path / name
            ensure_plain_file(file)


def fsync_tree(root: Path) -> None:
    validate_tree(root)
    for directory, _, files in os.walk(root, topdown=False, followlinks=False):
        path = Path(directory)
        for name in files:
            file = path / name
            if os.name != "nt":
                with file.open("rb") as handle:
                    os.fsync(handle.fileno())
        fsync_directory(path)


def remove_private_tree(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or not path.is_dir():
        path.unlink()
        return
    for entry in os.scandir(path):
        child = Path(entry.path)
        if entry.is_dir(follow_symlinks=False):
            remove_private_tree(child)
        else:
            child.unlink()
    path.rmdir()


def reconcile_private_state(root: Path, current: str | None) -> None:
    work = root / "work"
    generations = root / "generations"
    for entry in work.iterdir():
        if entry.name == ".migration.lock":
            continue
        if re.fullmatch(r"\.runtime-probe\.[A-Za-z0-9]{8}", entry.name):
            remove_private_tree(entry)
            continue
        if re.fullmatch(r"\.[a-f0-9]{32}\.conversion\.log", entry.name):
            remove_private_tree(entry)
            continue
        if not GENERATION_RE.fullmatch(entry.name):
            raise MigrationError("unexpected_migration_work")
        remove_private_tree(entry)
    for entry in generations.iterdir():
        if current and entry.name == current:
            continue
        if not GENERATION_RE.fullmatch(entry.name):
            raise MigrationError("unexpected_generation")
        remove_private_tree(entry)


def generation_result(root: Path, generation: str, target_version: str) -> dict:
    marker = root / "generations" / generation / "generation.json"
    ensure_plain_file(marker)
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MigrationError("invalid_generation_marker") from error
    if (
        not isinstance(value, dict)
        or value.get("format") != FORMAT
        or value.get("generation") != generation
        or value.get("status") != "validated"
    ):
        raise MigrationError("invalid_generation_marker")
    if value.get("target_version") != target_version:
        raise MigrationError("target_version_mismatch")
    return {**value, "status": "activated"}


def prepare_generation_ownership(generation: Path, runtime_user: str | None) -> None:
    validate_tree(generation)
    identity = runtime_identity(runtime_user)
    if not identity or identity == (os.geteuid(), os.getegid()):
        return
    os.chown(generation, os.geteuid(), os.getegid(), follow_symlinks=False)
    os.chmod(generation, 0o711)
    for leaf in ("home", "config", "data", "state"):
        chown_subtree(generation / leaf, *identity)


def load_current(root: Path) -> str | None:
    current = root / "current"
    if not current.exists() and not current.is_symlink():
        return None
    ensure_plain_file(current)
    value = current.read_text(encoding="ascii").strip()
    if not GENERATION_RE.fullmatch(value):
        raise MigrationError("invalid_current_generation")
    generation = root / "generations" / value
    ensure_plain_directory(generation)
    return value


def prepare(args: argparse.Namespace) -> dict:
    root = Path(os.path.abspath(args.root))
    ensure_plain_directory(root, create=True)
    generations = root / "generations"
    work = root / "work"
    ensure_plain_directory(generations, create=True)
    ensure_plain_directory(work, create=True)
    if os.name != "nt":
        # The converter cannot list these roots, but it can traverse to the one
        # random candidate path that the root coordinator passes to it.
        os.chmod(root, 0o711)
        os.chmod(generations, 0o711)
        os.chmod(work, 0o711)

    journal = root / "migration.json"
    with migration_lock(work / ".migration.lock"):
        current = load_current(root)
        reconcile_private_state(root, current)
        if current:
            result = generation_result(root, current, args.target_version)
            prepare_generation_ownership(generations / current, args.runtime_user)
            atomic_json(journal, result)
            return {"status": "already_activated", "generation": current}

        generation = uuid.uuid4().hex
        candidate = work / generation
        source_before = {}
        source_credentials = {}
        validation_database = candidate / ".v1-validation.db"
        try:
            source_info = inventory(args.source_data)
            if args.runtime_user:
                identity = runtime_identity(args.runtime_user)
                for retained in (args.source_data, *args.retained_root):
                    require_source_isolation(retained, identity)
            if source_info["database_sidecars"] and not source_info["database"]:
                raise MigrationError("orphan_database_sidecar")
            if source_info["legacy_json_store"] and not source_info["database"]:
                raise MigrationError("legacy_json_requires_v1")
            if source_info["provider_auth"] and not source_info["database"]:
                raise MigrationError("provider_auth_requires_v1_database")

            required = source_info["database_bytes"] * 3 + 256 * 1024 * 1024
            if shutil.disk_usage(root).free < required:
                raise MigrationError("insufficient_space")

            atomic_json(
                journal,
                {
                    "format": FORMAT,
                    "status": "inventoried",
                    "generation": generation,
                    "source": source_info,
                    "target_version": args.target_version,
                },
            )
            for leaf in ("home", "config", "data", "state", "cache"):
                ensure_plain_directory(candidate / leaf, create=True)
            target_data = candidate / "data" / "opencode"
            ensure_plain_directory(target_data, create=True)

            source_files = dict(selected_source_files(args.source_data)) if args.source_data.exists() else {}
            for logical_name, path in source_files.items():
                source_before[logical_name] = sha256(path)
            if "database" in source_files:
                cold_snapshot(
                    source_files,
                    candidate,
                    target_data / "opencode.db",
                    validation_database,
                )
                source_info["session_count"] = table_count(
                    validation_database, "session", required=True
                )
                source_info["message_count"] = table_count(
                    validation_database, "message", required=True
                )
                source_info["part_count"] = table_count(
                    validation_database, "part", required=True
                )
                source_info["content_part_count"] = source_content_part_count(
                    validation_database
                )
            if "provider_auth" in source_files:
                source_credentials = copy_provider_auth(
                    source_files["provider_auth"], target_data / "auth.json"
                )

            atomic_json(
                journal,
                {
                    "format": FORMAT,
                    "status": "snapshot_created",
                    "generation": generation,
                    "source": source_info,
                    "target_version": args.target_version,
                },
            )
            convert_candidate(
                candidate,
                args.v2_bin.resolve(),
                args.timeout,
                args.runtime_user,
            )
            target_database = target_data / "opencode.db"
            validate_tree(candidate)
            validate_database(target_database)
            if source_info["database"]:
                target_sessions, target_messages, validated_content_parts = validate_session_projection(
                    validation_database, target_database
                )
                if target_sessions != source_info["session_count"]:
                    raise MigrationError("session_count_mismatch")
            else:
                target_sessions = table_count(target_database, "session_v2", required=True)
                target_messages = table_count(
                    target_database, "session_message", required=True
                )
                validated_content_parts = 0
                if target_sessions or target_messages:
                    raise MigrationError("fresh_state_not_empty")
            if validated_content_parts != source_info["content_part_count"]:
                raise MigrationError("part_count_mismatch")
            target_credentials = validate_credentials(
                target_database,
                source_credentials,
                validation_database if source_info["database"] else None,
            )

            source_after = (
                dict(selected_source_files(args.source_data)) if args.source_data.exists() else {}
            )
            if source_after.keys() != source_files.keys():
                raise MigrationError("source_changed")
            if "database" in source_after and source_database_is_open(source_after["database"]):
                raise MigrationError("source_database_in_use")
            for logical_name, before in source_before.items():
                if sha256(source_after[logical_name]) != before:
                    raise MigrationError("source_changed")

            if validation_database.exists():
                ensure_plain_file(validation_database)
                validation_database.unlink()
            remove_private_tree(candidate / "cache")
            validated = {
                "format": FORMAT,
                "status": "validated",
                "generation": generation,
                "source": source_info,
                "target": {
                    "session_count": target_sessions,
                    "message_count": target_messages,
                    "validated_content_part_count": validated_content_parts,
                    "provider_auth_count": target_credentials,
                },
                "target_version": args.target_version,
            }
            atomic_json(candidate / "generation.json", validated)
            fsync_tree(candidate)
            activated = generations / generation
            os.replace(candidate, activated)
            fsync_directory(generations)
            atomic_text(root / "current", generation + "\n")
            result = {**validated, "status": "activated"}
            atomic_json(journal, result)
            return result
        except Exception as error:
            failure = error if isinstance(error, MigrationError) else MigrationError("migration_internal_error")
            remove_private_tree(candidate)
            activated = generations / generation
            try:
                selected = load_current(root)
            except MigrationError:
                selected = None
            if selected != generation:
                remove_private_tree(activated)
            atomic_json(
                journal,
                {
                    "format": FORMAT,
                    "status": "failed",
                    "generation": generation,
                    "error": failure.code,
                    "target_version": args.target_version,
                },
            )
            raise failure from None


def main() -> int:
    args = parse_args()
    try:
        if args.command == "inventory":
            print(json.dumps(inventory(args.source_data), sort_keys=True))
            return 0
        result = prepare(args)
        print(json.dumps({"status": result["status"], "generation": result["generation"]}))
        return 0
    except MigrationError as error:
        print(f"OpenCode V2 migration deferred: {error.code}", file=sys.stderr)
        return 1
    except Exception:
        print("OpenCode V2 migration deferred: migration_internal_error", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
