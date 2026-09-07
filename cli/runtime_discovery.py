"""Explicit operator-relay selection; never discovers or borrows browser sessions.

Absent a descriptor, the CLI retains its managed agent-v1 isolation lifecycle.
A selected relay is transport-only: the CLI must not launch or stop its host.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path

from native_host.runtime import RuntimePaths

MAX_DESCRIPTOR_BYTES = 8192


@dataclass(frozen=True)
class SelectedRelay:
    paths: RuntimePaths
    auth_token: str = field(repr=False)


class ActiveRuntimeError(ValueError):
    """The explicitly selected connection cannot safely be used."""


def descriptor_path() -> Path:
    override = os.environ.get("OVERSEER_BROWSER_CONNECTION", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".config" / "overseer-browser" / "active-connection.json"


def _private(path: Path, kind: str) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ActiveRuntimeError(f"selected relay {kind} is unavailable: {path}") from exc
    if path.is_symlink() or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise ActiveRuntimeError(f"selected relay {kind} must be owned by this user and not a symlink")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        raise ActiveRuntimeError(f"selected relay {kind} must be private (0700 directory / 0600 file)")
    return info


def _read_private(path: Path, limit: int, kind: str) -> bytes:
    info = _private(path, kind)
    if not stat.S_ISREG(info.st_mode):
        raise ActiveRuntimeError(f"selected relay {kind} must be a regular file")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise ActiveRuntimeError(f"selected relay {kind} changed during validation")
            data = stream.read(limit + 1)
    except OSError as exc:
        raise ActiveRuntimeError(f"selected relay {kind} could not be read") from exc
    if len(data) > limit:
        raise ActiveRuntimeError(f"selected relay {kind} exceeds its size limit")
    return data


def find_active_runtime(*, session_key: str | None = None) -> SelectedRelay | None:
    # A descriptor selects a CONNECTION, never an agent/session. Native session
    # ownership checks continue to apply to every command on that connection.
    del session_key
    if os.environ.get("OVERSEER_BROWSER_RUNTIME", "").strip():
        return None  # Preserve the explicit runtime override and managed lifecycle.
    selection = os.environ.get("OVERSEER_BROWSER_CONNECTION", "").strip()
    if selection == "managed":
        return None
    path = descriptor_path()
    if not selection and not path.exists() and not path.is_symlink():
        return None
    if not stat.S_ISDIR(_private(path.parent, "descriptor directory").st_mode):
        raise ActiveRuntimeError("selected relay descriptor parent must be a directory")
    try:
        payload = json.loads(_read_private(path, MAX_DESCRIPTOR_BYTES, "descriptor"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ActiveRuntimeError("selected relay descriptor is not valid JSON") from exc
    if not isinstance(payload, dict) or type(payload.get("version")) is not int or payload.get("version") != 1 or payload.get("mode") != "operator-relay":
        raise ActiveRuntimeError("selected relay descriptor requires version 1 and mode operator-relay")
    value = payload.get("runtime_root")
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ActiveRuntimeError("selected relay runtime_root must be an absolute path")
    root = Path(value)
    if root.resolve() != root or not stat.S_ISDIR(_private(root, "runtime directory").st_mode):
        raise ActiveRuntimeError("selected relay runtime directory must be canonical and not a symlink")
    paths = RuntimePaths(root, root / "overseer-browser.sock", root / "token")
    if not stat.S_ISSOCK(_private(paths.socket, "socket").st_mode):
        raise ActiveRuntimeError("selected relay socket must be a Unix socket")
    token = _read_private(paths.token, 4096, "token").strip()
    if not token or hashlib.sha256(token).hexdigest() != payload.get("token_sha256"):
        raise ActiveRuntimeError("selected relay token identity changed; select the connection again")
    try:
        return SelectedRelay(paths, token.decode("utf-8"))
    except UnicodeError as exc:
        raise ActiveRuntimeError("selected relay token has invalid encoding") from exc
