"""Portable ``overseer-browser`` CLI for the private local browser host."""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Iterable

try:
    from native_host.protocol import MAX_FRAME_BYTES, encode_frame, read_frame
    from native_host.runtime import RuntimePaths, is_private_file
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from native_host.protocol import MAX_FRAME_BYTES, encode_frame, read_frame
    from native_host.runtime import RuntimePaths, is_private_file
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_CHUNKS = 32
UPLOAD_CHUNK_BYTES = 256 * 1024
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def _checked_request_id(request_id: str) -> str:
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise CLIError("usage", "request IDs must be 1-128 ASCII letters, digits, `_`, `.`, `:`, or `-`")
    return request_id



class CLIError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def request_once(
    command: str,
    params: dict[str, Any],
    *,
    timeout: float,
    paths: RuntimePaths | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    paths = paths or RuntimePaths.discover()
    if not paths.token.exists() or not is_private_file(paths.token):
        raise CLIError("not_installed", "native host token is missing; run overseer-browser install")
    token = paths.token.read_text(encoding="utf-8").strip()
    if not token:
        raise CLIError("not_installed", "native host token is empty; run overseer-browser install")
    if not paths.socket.exists():
        raise CLIError("host_unavailable", "native host is not running; open the extension or run status")
    request_id = _checked_request_id(request_id) if request_id is not None else f"cli-{uuid.uuid4().hex}"
    request = {"version": 1, "kind": "request", "request_id": request_id, "command": command, "params": params, "token": token}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(max(0.2, min(timeout, 300.0)))
            connection.connect(str(paths.socket))
            connection.sendall(encode_frame(request, byteorder="big"))
            response = read_frame(connection, byteorder="big")
    except FileNotFoundError as exc:
        raise CLIError("host_unavailable", "native host socket disappeared; reopen the extension") from exc
    except ConnectionRefusedError as exc:
        raise CLIError("host_unavailable", "native host is not accepting connections") from exc
    except EOFError as exc:
        raise CLIError("native_disconnected", "native host disconnected before returning a response") from exc
    except socket.timeout as exc:
        raise CLIError("timeout", "timed out waiting for the browser extension") from exc
    if response.get("request_id") != request_id:
        raise CLIError("protocol_error", "native host returned a mismatched request")
    return response


def local_health(paths: RuntimePaths | None = None) -> dict[str, Any]:
    paths = paths or RuntimePaths.discover()
    checks: dict[str, Any] = {
        "runtime_directory": {"path": str(paths.root), "ok": paths.root.is_dir() and _private_dir(paths.root)},
        "token": {"ok": paths.token.is_file() and is_private_file(paths.token)},
        "socket": {"path": str(paths.socket), "ok": not paths.socket.is_symlink() and paths.socket.is_socket() and _private_socket(paths.socket)},
        "native_manifest": {"ok": _manifest_exists()},
        "extension_id": "iabfdeokmilpklblkgccpjlekchfjcno",
        "tcp_listener": False,
        "external_traffic": False,
    }
    checks["ok"] = all(item.get("ok", False) for item in checks.values() if isinstance(item, dict))
    checks["hint"] = "Open the extension popup to connect" if not checks["socket"]["ok"] else "Local host is available"
    return checks


def _private_dir(path: Path) -> bool:
    try:
        stat_result = path.stat()
        owner_ok = not hasattr(os, "getuid") or stat_result.st_uid == os.getuid()
        return owner_ok and (stat_result.st_mode & 0o077) == 0
    except (FileNotFoundError, OSError):
        return False


def _private_socket(path: Path) -> bool:
    try:
        stat_result = path.stat()
        owner_ok = not hasattr(os, "getuid") or stat_result.st_uid == os.getuid()
        return owner_ok and (stat_result.st_mode & 0o077) == 0
    except (FileNotFoundError, OSError):
        return False


def _manifest_paths() -> list[Path]:
    override = os.environ.get("OVERSEER_BROWSER_MANIFEST", "").strip()
    if override:
        return [Path(override).expanduser()]
    if sys.platform == "darwin":
        return [Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "NativeMessagingHosts" / "com.imploselabs.overseer_browser.json"]
    if os.name == "nt":
        return [Path(os.environ.get("LOCALAPPDATA", Path.home())) / "OverSeer" / "browser" / "native-host.json"]
    return [Path.home() / ".config" / "google-chrome" / "NativeMessagingHosts" / "com.imploselabs.overseer_browser.json"]


def _manifest_exists() -> bool:
    return any(path.is_file() for path in _manifest_paths())


def _safe_mime_type(path: Path) -> str:
    guessed = mimetypes.guess_type(path.name, strict=False)[0] or "application/octet-stream"
    return guessed if re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", guessed) else "application/octet-stream"


def _safe_upload_filename(path: Path) -> str:
    """Return a bounded basename safe to expose to the extension."""
    filename = path.name
    if not filename or filename in {".", ".."}:
        raise CLIError("invalid_upload", "upload filename must be a non-empty basename")
    if "/" in filename or "\\" in filename:
        raise CLIError("invalid_upload", "upload filename must not contain path separators")
    if any(unicodedata.category(character).startswith("C") for character in filename):
        raise CLIError("invalid_upload", "upload filename must not contain control characters")
    try:
        filename_bytes = filename.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise CLIError("invalid_upload", "upload filename must be valid UTF-8") from exc
    if len(filename_bytes) > 255:
        raise CLIError("invalid_upload", "upload filename exceeds the 255-byte limit")
    return filename


def iter_upload_chunks(path: Path, ref: str) -> Iterable[dict[str, Any]]:
    """Yield the extension's bounded upload chunk contract without exposing local paths."""
    if not ref or len(ref) > 128:
        raise CLIError("usage", "upload requires an element REF and PATH")
    filename = _safe_upload_filename(path)
    size = path.stat().st_size
    if size > MAX_UPLOAD_BYTES:
        raise CLIError("upload_too_large", "upload exceeds the 8 MiB limit")
    total = max(1, (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES)
    if total > MAX_UPLOAD_CHUNKS:
        raise CLIError("upload_too_large", "upload exceeds the 32-chunk limit")
    upload_id = f"upload-{uuid.uuid4().hex}"
    mime_type = _safe_mime_type(path)
    with path.open("rb") as handle:
        for index in range(total):
            chunk = handle.read(UPLOAD_CHUNK_BYTES)
            yield {
                "upload_id": upload_id,
                "index": index,
                "total": total,
                "chunk": base64.b64encode(chunk).decode("ascii"),
                "ref": ref,
                "filename": filename,
                "mime_type": mime_type,
            }


def _command_request(command: str, args: list[str]) -> tuple[str, dict[str, Any]]:
    """Map friendly CLI paths to the extension's stable dotted command names."""
    if command == "open":
        _require(args, 1, "open URL")
        return "navigate", {"url": args[0]}
    if command in {"snapshot", "observe"}:
        return command, {}
    if command in {"eval", "evaluate"}:
        _require(args, 1, f"{command} SOURCE")
        return "evaluate", {"source": args[0]}
    if command == "screenshot":
        return "screenshot.visible", {}
    if command == "close":
        return "sessions.stop", {}
    if command in {"navigate", "back", "forward", "reload"}:
        if command == "navigate":
            _require(args, 1, "navigate URL")
            return command, {"url": args[0]}
        return command, {}
    if command in {"sessions", "windows", "tabs", "capture"}:
        _require(args, 1, f"{command} ACTION")
        action = args[0]
        params: dict[str, Any] = {}
        rest = args[1:]
        if command == "windows" and action == "resize":
            _require(rest, 2, "windows resize WIDTH HEIGHT")
            params = {"width": _number(rest[0]), "height": _number(rest[1])}
            if len(rest) > 2:
                params["left"] = _integer(rest[2], minimum=-16_384, maximum=16_384)
            if len(rest) > 3:
                params["top"] = _integer(rest[3], minimum=-16_384, maximum=16_384)
        elif command == "tabs" and action == "create":
            if rest:
                params = {"url": rest[0]}
        elif command == "tabs" and action in {"select", "close", "borrow", "return"}:
            _require(rest, 1, f"tabs {action} TAB_ID")
            params = {"tab_id": _integer(rest[0])}
        elif command == "sessions" and action == "start" and rest:
            params = {"name": rest[0]}
        return f"{command}.{action}", params
    if command in {"click", "hover"}:
        _require(args, 1, f"{command} REF")
        return command, {"ref": args[0]}
    if command == "fill" or command == "select":
        _require(args, 2, f"{command} REF VALUE")
        return command, {"ref": args[0], "value": args[1]}
    if command == "type":
        _require(args, 2, "type REF TEXT")
        return command, {"ref": args[0], "text": args[1]}
    if command == "press":
        _require(args, 1, "press KEY [REF]")
        return command, ({"key": args[0]} if len(args) == 1 else {"ref": args[0], "key": args[1]})
    if command == "scroll":
        _require(args, 1, "scroll Y | scroll X Y | scroll REF X Y")
        if len(args) == 1:
            return command, {"y": _integer(args[0], minimum=-100_000, maximum=100_000)}
        if len(args) == 2:
            return command, {"x": _integer(args[0], minimum=-100_000, maximum=100_000), "y": _integer(args[1], minimum=-100_000, maximum=100_000)}
        return command, {"ref": args[0], "x": _integer(args[1], minimum=-100_000, maximum=100_000), "y": _integer(args[2], minimum=-100_000, maximum=100_000)}
    if command == "cancel":
        _require(args, 1, "cancel REQUEST_ID")
        return command, {"request_id": args[0]}
    if command == "takeover":
        if args and args != ["prompt"]:
            raise CLIError("usage", "takeover may only request human control; only the popup can resume automation")
        return "takeover.prompt", {}
    if command in {"screenshot-element", "element-screenshot"}:
        _require(args, 1, f"{command} REF")
        return "screenshot.element", {"ref": args[0]}
    raise CLIError("unknown_command", f"unknown command: {command}")


def _require(args: list[str], count: int, usage: str) -> None:
    if len(args) < count:
        raise CLIError("usage", f"usage: overseer-browser {usage}")



def _integer(value: str, *, minimum: int = 1, maximum: int = 2_147_483_647) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise CLIError("usage", f"expected integer, got {value!r}") from exc
    if not minimum <= result <= maximum:
        raise CLIError("usage", f"integer must be between {minimum} and {maximum}")
    return result
def _number(value: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise CLIError("usage", f"expected integer, got {value!r}") from exc
    if not 1 <= result <= 16_384:
        raise CLIError("usage", "dimension must be between 1 and 16384")
    return result


def _run_script(action: str) -> dict[str, Any]:
    script = Path(__file__).resolve().parents[1] / "scripts" / "manage-macos.sh"
    if not script.exists():
        raise CLIError("not_installed", "installer script is missing")
    try:
        completed = subprocess.run([str(script), action], capture_output=True, text=True, timeout=300, check=False)
    except OSError as exc:
        raise CLIError("installer_failed", str(exc)) from exc
    return {"ok": completed.returncode == 0, "action": action, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip(), "returncode": completed.returncode}

def _materialize_screenshot(payload: dict[str, Any], output: Path | None) -> dict[str, Any]:
    if not payload.get("ok") or not isinstance(payload.get("result"), dict):
        return payload
    result = payload["result"]
    encoded = result.get("data")
    if not isinstance(encoded, str):
        raise CLIError("protocol_error", "screenshot response did not contain image data")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CLIError("protocol_error", "screenshot response contained invalid image data") from exc
    if len(data) > 850 * 1024:
        raise CLIError("screenshot_too_large", "screenshot exceeds the native frame image limit")
    metadata = {key: value for key, value in result.items() if key != "data"}
    metadata["data_available"] = True
    if output is not None:
        path = output.expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        metadata["path"] = str(path)
    return {**payload, "result": metadata}


def _render(payload: dict[str, Any], json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return
    if payload.get("ok") is False:
        err = payload.get("error") or {}
        print(f"Error [{err.get('code', 'error')}]: {err.get('message', 'request failed')}", file=sys.stderr)
        return
    if "result" in payload:
        value = payload["result"]
        print(json.dumps(value, ensure_ascii=False, indent=2) if isinstance(value, (dict, list)) else value)
    elif "hint" in payload:
        print(payload["hint"])
    else:
        print("OK")


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    json_output = "--json" in raw
    raw = [arg for arg in raw if arg != "--json"]
    timeout = 30.0
    if "--timeout" in raw:
        index = raw.index("--timeout")
        try:
            timeout = float(raw[index + 1])
        except (IndexError, ValueError) as exc:
            _render({"ok": False, "error": {"code": "usage", "message": "--timeout requires seconds"}}, json_output)
            return 2
        del raw[index : index + 2]
    request_id: str | None = None
    if "--request-id" in raw:
        index = raw.index("--request-id")
        try:
            request_id = _checked_request_id(raw[index + 1])
        except IndexError:
            _render({"ok": False, "error": {"code": "usage", "message": "--request-id requires an ID"}}, json_output)
            return 2
        except CLIError as exc:
            _render({"ok": False, "error": {"code": exc.code, "message": exc.message}}, json_output)
            return 2
        del raw[index : index + 2]
    if not raw or raw[0] in {"-h", "--help"}:
        _render(
            {
                "ok": True,
                "result": {
                    "commands": [
                        "health",
                        "status",
                        "install",
                        "update",
                        "uninstall",
                        "sessions",
                        "windows",
                        "tabs",
                        "navigate",
                        "snapshot",
                        "observe",
                        "click",
                        "hover",
                        "fill",
                        "type",
                        "select",
                        "press",
                        "scroll",
                        "evaluate",
                        "screenshot",
                        "screenshot-element",
                        "upload",
                        "takeover",
                        "cancel",
                    ]
                },
            },
            json_output,
        )
        return 0
    command, args = raw[0], raw[1:]
    try:
        if command in {"install", "update", "uninstall"}:
            payload = _run_script(command)
        elif command == "health":
            payload = local_health()
        elif command == "status":
            payload = local_health()
            payload["mode"] = "local-native"
        elif command == "upload":
            _require(args, 2, "upload REF PATH")
            ref, path_arg = args[0], args[1]
            if len(args) > 2:
                raise CLIError("usage", "usage: overseer-browser upload REF PATH")
            payload = None
            for chunk in iter_upload_chunks(Path(path_arg).expanduser(), ref):
                payload = request_once("upload", chunk, timeout=timeout, request_id=request_id)
                if not payload.get("ok"):
                    break
            if payload is None:
                raise CLIError("invalid_upload", "upload did not produce any chunks")
        elif command in {"screenshot", "screenshot-element", "element-screenshot"}:
            if command == "screenshot" and len(args) > 1:
                raise CLIError("usage", "usage: overseer-browser screenshot [PATH]")
            if command != "screenshot" and len(args) > 2:
                raise CLIError("usage", "usage: overseer-browser screenshot-element REF [PATH]")
            extension_command, params = _command_request(command, args)
            output_arg = args[0] if command == "screenshot" and args else args[1] if len(args) > 1 else None
            payload = request_once(extension_command, params, timeout=timeout, request_id=request_id)
            payload = _materialize_screenshot(payload, Path(output_arg) if output_arg else None)
        elif command == "help":
            payload = {
                "ok": True,
                "result": {
                    "commands": [
                        "health",
                        "status",
                        "install",
                        "update",
                        "uninstall",
                        "sessions",
                        "windows",
                        "tabs",
                        "navigate",
                        "snapshot",
                        "observe",
                        "click",
                        "hover",
                        "fill",
                        "type",
                        "select",
                        "press",
                        "scroll",
                        "evaluate",
                        "screenshot",
                        "screenshot-element",
                        "upload",
                        "takeover",
                        "cancel",
                    ]
                },
            }
        else:
            extension_command, params = _command_request(command, args)
            payload = request_once(extension_command, params, timeout=timeout, request_id=request_id)
    except (CLIError, OSError, ValueError) as exc:
        if isinstance(exc, CLIError):
            payload = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        else:
            payload = {"ok": False, "error": {"code": "error", "message": str(exc)}}
    _render(payload, json_output)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
