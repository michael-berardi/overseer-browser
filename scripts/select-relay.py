#!/usr/bin/env python3
"""Select an existing owned relay without changing hosts, manifests or sessions."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cli.main import _request_once
from cli.runtime_discovery import _private, _read_private
from native_host.runtime import RuntimePaths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime_root", type=Path)
    args = parser.parse_args()
    root = args.runtime_root.expanduser().resolve()
    try:
        if not stat.S_ISDIR(_private(root, "runtime directory").st_mode):
            raise ValueError("runtime root must be a private directory")
        paths = RuntimePaths(root, root / "overseer-browser.sock", root / "token")
        if not stat.S_ISSOCK(_private(paths.socket, "socket").st_mode):
            raise ValueError("runtime socket is not a Unix socket")
        token = _read_private(paths.token, 4096, "token").strip()
        response = _request_once("health.status", {}, timeout=10, paths=paths,
                                 auth_token=token.decode("utf-8"))
        health = response.get("result", {})
        if response.get("ok") is not True or health.get("connected") is not True or health.get("multi_session") is not True:
            raise ValueError("relay must be connected and advertise multi-session support")
        payload = {"version": 1, "mode": "operator-relay", "runtime_root": str(root), "token_sha256": hashlib.sha256(token).hexdigest()}
        directory = Path.home() / ".config" / "overseer-browser"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not stat.S_ISDIR(_private(directory, "descriptor directory").st_mode):
            raise ValueError("descriptor directory is not a directory")
        destination = directory / "active-connection.json"
        if destination.exists() or destination.is_symlink():
            previous = _read_private(destination, 8192, "descriptor")
            backup = directory / f"active-connection.backup-{time.time_ns()}.json"
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(previous)
        fd, staged = tempfile.mkstemp(prefix=".active-connection-", dir=directory)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(payload, stream)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(staged, destination)
        finally:
            if os.path.exists(staged):
                os.unlink(staged)
        print(json.dumps({"ok": True, "mode": "operator-relay", "runtime_root": str(root), "descriptor": str(destination)}))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        # Never include the token or descriptor body in diagnostics.
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
