"""Private same-user runtime paths and native-host manifest helpers."""
from __future__ import annotations

import json
import os
import secrets
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    from .protocol import EXTENSION_ID, NATIVE_HOST_NAME
except ImportError:
    from protocol import EXTENSION_ID, NATIVE_HOST_NAME  # type: ignore[no-redef]



@dataclass(frozen=True)
class RuntimePaths:
    root: Path
    socket: Path
    token: Path

    @classmethod
    def discover(cls) -> "RuntimePaths":
        override = os.environ.get("OVERSEER_BROWSER_RUNTIME", "").strip()
        if override:
            root = Path(override).expanduser()
        elif os.name == "nt":
            root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "OverSeer" / "browser"
        elif sys_platform() == "darwin":
            root = Path.home() / "Library" / "Application Support" / "OverSeer" / "browser"
        else:
            root = Path(os.environ.get("XDG_RUNTIME_DIR", Path.home() / ".config")) / "overseer-browser"
        return cls(root=root, socket=root / "overseer-browser.sock", token=root / "token")


def sys_platform() -> str:
    # Kept as a function so tests can monkeypatch platform discovery without importing platform state.
    import sys

    return sys.platform


def ensure_private_directory(path: Path) -> None:
    if path.is_symlink():
        raise PermissionError("runtime directory must not be a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    if hasattr(os, "getuid") and path.stat().st_uid != os.getuid():
        raise PermissionError("runtime directory is not owned by the current user")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise PermissionError("runtime directory is accessible by another user")


def ensure_token(paths: RuntimePaths) -> str:
    ensure_private_directory(paths.root)
    if paths.token.is_symlink():
        raise PermissionError("token path must not be a symlink")
    if paths.token.exists():
        if not is_private_file(paths.token):
            raise PermissionError("token file permissions are too broad")
        token = paths.token.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    fd, temporary = tempfile.mkstemp(prefix="token.", dir=paths.root)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(token + "\n")
        os.replace(temporary, paths.token)
        os.chmod(paths.token, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return token


def is_private_file(path: Path) -> bool:
    if path.is_symlink():
        return False
    try:
        stat_result = path.stat()
    except FileNotFoundError:
        return False
    owner_ok = not hasattr(os, "getuid") or stat_result.st_uid == os.getuid()
    return owner_ok and (stat.S_IMODE(stat_result.st_mode) & 0o077) == 0



def prepare_socket(paths: RuntimePaths) -> None:
    """Remove only a stale socket owned by this user; never unlink arbitrary files."""
    ensure_private_directory(paths.root)
    if not paths.socket.exists() and not paths.socket.is_symlink():
        return
    if paths.socket.is_symlink() or not stat.S_ISSOCK(paths.socket.stat().st_mode):
        raise FileExistsError("runtime socket path is not a socket")
    if hasattr(os, "getuid") and paths.socket.stat().st_uid != os.getuid():
        raise PermissionError("runtime socket is not owned by the current user")
    import socket

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.1)
    try:
        probe.connect(str(paths.socket))
    except (FileNotFoundError, ConnectionRefusedError, TimeoutError, OSError):
        paths.socket.unlink(missing_ok=True)
    else:
        raise FileExistsError("browser host is already running")
    finally:
        probe.close()


def native_manifest(host_path: Path) -> dict[str, object]:
    """Return the exact Chrome native-messaging manifest for the stable extension ID."""
    return {
        "name": NATIVE_HOST_NAME,
        "description": "Private local OverSeer Browser native host",
        "path": str(host_path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }


def write_manifest(path: Path, host_path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = json.dumps(native_manifest(host_path), indent=2, sort_keys=True) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
