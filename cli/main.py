"""Portable ``overseer-browser`` CLI for the private local browser host."""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import math
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
    from native_host.protocol import MAX_FRAME_BYTES, ProtocolError, encode_frame, read_frame
    from native_host.runtime import RuntimePaths, is_private_file
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from native_host.protocol import MAX_FRAME_BYTES, ProtocolError, encode_frame, read_frame
    from native_host.runtime import RuntimePaths, is_private_file
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_CHUNKS = 32
MAX_UPLOAD_FILES = 16
MAX_BATCH_ACTIONS = 20
MAX_PARALLEL_BATCH_ACTIONS = 8
CONNECT_RETRY_DELAYS = (0.0, 0.005, 0.015, 0.03, 0.06)
# The extension rejects a serialized forwarded request above 512 KiB. Keep the
# source bound below that parser limit even after adding the complete envelope.
MAX_EXTENSION_REQUEST_BYTES = 512 * 1024
_MAX_REQUEST_ID_FOR_BOUND = "r" * 128
_EMPTY_BATCH_REQUEST = {
    "version": 1,
    "kind": "request",
    "request_id": _MAX_REQUEST_ID_FOR_BOUND,
    "command": "batch",
    "params": {},
}
_BATCH_REQUEST_OVERHEAD = len(
    json.dumps(_EMPTY_BATCH_REQUEST, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
) - len(b"{}")
MAX_BATCH_SOURCE_BYTES = MAX_EXTENSION_REQUEST_BYTES - _BATCH_REQUEST_OVERHEAD
if MAX_BATCH_SOURCE_BYTES <= 0:
    raise RuntimeError("batch request envelope exceeds extension request limit")
UPLOAD_CHUNK_BYTES = 256 * 1024
_SCREENSHOT_SUFFIX_FORMATS = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg"}
_SCREENSHOT_MAGIC = {
    "png": b"\x89PNG\r\n\x1a\n",
    "jpeg": b"\xff\xd8\xff",
}

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
CLI_COMMANDS = (
    "health", "status", "install", "update", "uninstall", "help", "sessions", "windows", "tabs",
    "open", "close", "navigate", "back", "forward", "reload", "snapshot", "observe", "click", "hover", "fill", "type", "select", "press",
    "scroll", "evaluate", "eval", "console", "network", "batch", "capture", "screenshot",
    "screenshot-element", "element-screenshot", "upload", "takeover", "cancel", "wait",
)

_TAB_TARGETED_COMMANDS = {
    "navigate", "back", "forward", "reload", "snapshot", "observe", "wait.for",
    "click", "hover", "fill", "type", "select", "press", "scroll", "evaluate",
    "screenshot.visible", "screenshot.element", "upload",
    "console.start", "console.read", "console.stop", "network.read",
}


def _apply_targeting(command: str, params: dict[str, Any], tab_id: int | None, max_nodes: int | None) -> dict[str, Any]:
    if tab_id is not None:
        if command not in _TAB_TARGETED_COMMANDS:
            raise CLIError("usage", f"--tab-id does not apply to {command}")
        params.setdefault("tab_id", tab_id)
    if max_nodes is not None:
        if command not in {"snapshot", "observe"}:
            raise CLIError("usage", "--max-nodes applies only to snapshot and observe")
        params["max_nodes"] = max_nodes
    return params

_BATCH_COMMANDS = {
    "windows.resize",
    "tabs.list",
    "tabs.create",
    "tabs.select",
    "tabs.close",
    "tabs.return",
    "navigate",
    "back",
    "forward",
    "reload",
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
    "console.start",
    "console.read",
    "console.stop",
    "network.read",
    "screenshot.visible",
    "screenshot.element",
}


def _checked_request_id(request_id: str) -> str:
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise CLIError("usage", "request IDs must be 1-128 ASCII letters, digits, `_`, `.`, `:`, or `-`")
    return request_id



class CLIError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
def _checked_timeout(timeout: float) -> float:
    if isinstance(timeout, bool):
        raise CLIError("usage", "timeout must be a finite positive number")
    try:
        value = float(timeout)
    except (TypeError, ValueError) as exc:
        raise CLIError("usage", "timeout must be a finite positive number") from exc
    if not math.isfinite(value) or value <= 0:
        raise CLIError("usage", "timeout must be a finite positive number")
    return max(0.2, min(value, 300.0))


def _validate_response(response: object, request_id: str) -> dict[str, Any]:
    if (
        not isinstance(response, dict)
        or isinstance(response.get("version"), bool)
        or response.get("version") != 1
        or response.get("kind") != "response"
    ):
        raise CLIError("protocol_error", "native host returned an invalid response envelope")
    if response.get("request_id") != request_id:
        raise CLIError("protocol_error", "native host returned a mismatched request")
    if not isinstance(response.get("ok"), bool):
        raise CLIError("protocol_error", "native host returned an invalid response status")
    error_value = response.get("error")
    if response["ok"]:
        if "error" in response:
            raise CLIError("protocol_error", "native host returned an invalid successful response")
    else:
        if not isinstance(error_value, dict):
            raise CLIError("protocol_error", "native host returned an invalid response error")
        code = error_value.get("code")
        message = error_value.get("message")
        if not isinstance(code, str) or not 1 <= len(code) <= 96 or not isinstance(message, str) or not 1 <= len(message) <= 4_096:
            raise CLIError("protocol_error", "native host returned an invalid response error")
        for field in ("reason", "fallback"):
            value = error_value.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 4_096):
                raise CLIError("protocol_error", "native host returned an invalid response error")
    return response
def _serialized_batch_request_bytes(payload: dict[str, Any]) -> int:
    request = {
        "version": 1,
        "kind": "request",
        "request_id": _MAX_REQUEST_ID_FOR_BOUND,
        "command": "batch",
        "params": payload,
    }
    return len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _parse_batch_payload(source: str) -> dict[str, Any]:
    try:
        if len(source.encode("utf-8")) > MAX_BATCH_SOURCE_BYTES:
            raise ValueError("batch source exceeds the request bound")
        parsed = json.loads(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise CLIError("usage", "batch requires a finite JSON array or object contract") from exc
    if isinstance(parsed, list):
        payload: dict[str, Any] = {"actions": parsed}
    elif isinstance(parsed, dict):
        if set(parsed) - {"actions", "stop_on_error", "max_parallel"}:
            raise CLIError("usage", "batch object may contain only actions, stop_on_error, and max_parallel")
        payload = dict(parsed)
    else:
        raise CLIError("usage", "batch requires a JSON array or object contract")
    actions = payload.get("actions")
    if not isinstance(actions, list) or not 1 <= len(actions) <= MAX_BATCH_ACTIONS:
        raise CLIError("usage", f"batch actions must contain 1-{MAX_BATCH_ACTIONS} objects")
    for index, action in enumerate(actions):
        if not isinstance(action, dict) or set(action) - {"command", "params"}:
            raise CLIError("usage", f"batch action {index} must contain only command and params")
        command = action.get("command")
        if not isinstance(command, str) or command not in _BATCH_COMMANDS:
            raise CLIError("usage", f"batch action {index} uses an unsupported command")
        params = action.get("params")
        if "params" in action and (not isinstance(params, dict) or isinstance(params, list)):
            raise CLIError("usage", f"batch action {index} params must be an object")
    if "stop_on_error" in payload and not isinstance(payload["stop_on_error"], bool):
        raise CLIError("usage", "batch stop_on_error must be boolean")
    if "max_parallel" in payload and (
        isinstance(payload["max_parallel"], bool)
        or not isinstance(payload["max_parallel"], int)
        or not 1 <= payload["max_parallel"] <= MAX_PARALLEL_BATCH_ACTIONS
    ):
        raise CLIError("usage", f"batch max_parallel must be an integer between 1 and {MAX_PARALLEL_BATCH_ACTIONS}")
    try:
        if _serialized_batch_request_bytes(payload) > MAX_EXTENSION_REQUEST_BYTES:
            raise ValueError("batch request envelope exceeds the request bound")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise CLIError("usage", "batch requires a finite JSON array or object contract") from exc
    return payload



def request_once(
    command: str,
    params: dict[str, Any],
    *,
    timeout: float,
    paths: RuntimePaths | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    timeout_value = _checked_timeout(timeout)
    paths = paths or RuntimePaths.discover()
    if not paths.token.exists() or not is_private_file(paths.token):
        raise CLIError("not_installed", "native host token is missing; run overseer-browser install")
    try:
        token = paths.token.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise CLIError("native_io_error", "native host token could not be read") from exc
    if not token:
        raise CLIError("not_installed", "native host token is empty; run overseer-browser install")
    if not paths.socket.exists():
        raise CLIError("host_unavailable", "native host is not running; open the extension or run status")
    request_id = _checked_request_id(request_id) if request_id is not None else f"cli-{uuid.uuid4().hex}"
    request = {"version": 1, "kind": "request", "request_id": request_id, "command": command, "params": params, "token": token}
    deadline = time.monotonic() + timeout_value
    connection: socket.socket | None = None
    last_refused: ConnectionRefusedError | None = None
    try:
        for delay in CONNECT_RETRY_DELAYS:
            if delay > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(delay, remaining))
            candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            candidate.settimeout(max(0.001, deadline - time.monotonic()))
            try:
                candidate.connect(str(paths.socket))
            except ConnectionRefusedError as exc:
                candidate.close()
                last_refused = exc
                continue
            except BaseException:
                candidate.close()
                raise
            connection = candidate
            break
        if connection is None:
            raise last_refused or ConnectionRefusedError("native host is not accepting connections")
        with connection:
            connection.settimeout(max(0.001, deadline - time.monotonic()))
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
    except ProtocolError as exc:
        raise CLIError("protocol_error", "native host exchanged an invalid protocol frame") from exc
    except OSError as exc:
        raise CLIError("native_io_error", "native host communication failed") from exc
    return _validate_response(response, request_id)


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
    if checks["socket"]["ok"]:
        checks["hint"] = "Local host is available"
    elif not checks["native_manifest"]["ok"]:
        checks["hint"] = "Reinstall the native host manifest, then reload the extension"
    else:
        checks["hint"] = (
            "Reload or load the unpacked extension; it reconnects automatically unless "
            "Stop reconnecting was selected, in which case reconnect from the popup"
        )
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
        base = Path.home() / "Library" / "Application Support" / "Google"
        filename = "com.imploselabs.overseer_browser.json"
        return [
            base / "Chrome" / "NativeMessagingHosts" / filename,
            base / "Chrome for Testing" / "NativeMessagingHosts" / filename,
        ]
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


def iter_upload_file_chunks(paths: list[Path], ref: str) -> Iterable[dict[str, Any]]:
    """Yield one ordered upload transaction for one to sixteen local files."""
    if not 1 <= len(paths) <= MAX_UPLOAD_FILES:
        raise CLIError("invalid_upload", f"upload accepts 1-{MAX_UPLOAD_FILES} files")
    if not ref or len(ref) > 128:
        raise CLIError("usage", "upload requires an element REF and PATH")
    records: list[tuple[Path, str, str, int, int]] = []
    aggregate_bytes = 0
    aggregate_chunks = 0
    for path in paths:
        filename = _safe_upload_filename(path)
        try:
            size = path.stat().st_size
            with path.open("rb"):
                pass
        except OSError as exc:
            raise CLIError("invalid_upload", f"upload file is not readable: {path.name}") from exc
        total = max(1, (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES)
        aggregate_bytes += size
        aggregate_chunks += total
        if size > MAX_UPLOAD_BYTES:
            raise CLIError("upload_too_large", "upload exceeds the 8 MiB limit")
        records.append((path, filename, _safe_mime_type(path), total, size))
    if aggregate_bytes > MAX_UPLOAD_BYTES:
        raise CLIError("upload_too_large", "upload file set exceeds the 8 MiB limit")
    if aggregate_chunks > MAX_UPLOAD_CHUNKS:
        raise CLIError("upload_too_large", "upload file set exceeds the 32-chunk limit")
    upload_id = f"upload-{uuid.uuid4().hex}"
    file_total = len(records)
    for file_index, (path, filename, mime_type, total, _) in enumerate(records):
        with path.open("rb") as handle:
            for index in range(total):
                chunk = handle.read(UPLOAD_CHUNK_BYTES)
                payload: dict[str, Any] = {
                    "upload_id": upload_id,
                    "index": index,
                    "total": total,
                    "chunk": base64.b64encode(chunk).decode("ascii"),
                    "ref": ref,
                    "filename": filename,
                    "mime_type": mime_type,
                }
                if file_total > 1:
                    payload["file_index"] = file_index
                    payload["file_total"] = file_total
                yield payload


def iter_upload_chunks(path: Path, ref: str) -> Iterable[dict[str, Any]]:
    """Yield the backward-compatible single-file upload chunk contract."""
    yield from iter_upload_file_chunks([path], ref)

def _command_request(command: str, args: list[str]) -> tuple[str, dict[str, Any]]:
    """Map friendly CLI paths to the extension's stable dotted command names."""
    if command == "console":
        _require(args, 1, "console start|read [--clear]|stop")
        action = args[0]
        rest = args[1:]
        if action == "start":
            _exact(rest, 0, "console start")
            return "console.start", {}
        if action == "stop":
            _exact(rest, 0, "console stop")
            return "console.stop", {}
        if action == "read":
            if not rest:
                return "console.read", {}
            _exact(rest, 1, "console read [--clear]")
            if rest[0] != "--clear":
                raise CLIError("usage", "usage: overseer-browser console read [--clear]")
            return "console.read", {"clear": True}
        raise CLIError("unknown_command", f"unknown command: {command}.{action}")
    if command == "network":
        _require(args, 1, "network read [LIMIT]")
        action = args[0]
        if action != "read":
            raise CLIError("unknown_command", f"unknown command: {command}.{action}")
        if len(args) > 2:
            raise CLIError("usage", "usage: overseer-browser network read [LIMIT]")
        return "network.read", {} if len(args) == 1 else {"limit": _integer(args[1], maximum=200)}
    if command == "batch":
        _exact(args, 1, "batch JSON")
        return "batch", _parse_batch_payload(args[0])
    if command == "open":
        _exact(args, 1, "open URL")
        return "navigate", {"url": args[0]}
    if command in {"snapshot", "observe"}:
        if command == "observe" and args == ["--changes"]:
            return command, {"changes": True}
        _exact(args, 0, command)
        return command, {}
    if command in {"eval", "evaluate"}:
        _exact(args, 1, f"{command} SOURCE")
        return "evaluate", {"source": args[0]}
    if command == "screenshot":
        _exact(args, 0, "screenshot")
        return "screenshot.visible", {}
    if command == "close":
        _exact(args, 0, "close")
        return "sessions.stop", {}
    if command in {"navigate", "back", "forward", "reload"}:
        if command == "navigate":
            _exact(args, 1, "navigate URL")
            return command, {"url": args[0]}
        _exact(args, 0, command)
        return command, {}
    if command in {"sessions", "windows", "tabs", "capture"}:
        _require(args, 1, f"{command} ACTION")
        action = args[0]
        rest = args[1:]
        params: dict[str, Any] = {}
        if command == "windows":
            if action != "resize":
                raise CLIError("unknown_command", f"unknown command: {command}.{action}")
            if not 2 <= len(rest) <= 4:
                raise CLIError("usage", "usage: overseer-browser windows resize WIDTH HEIGHT [LEFT TOP]")
            params = {"width": _number(rest[0]), "height": _number(rest[1])}
            if len(rest) > 2:
                params["left"] = _integer(rest[2], minimum=-16_384, maximum=16_384)
            if len(rest) > 3:
                params["top"] = _integer(rest[3], minimum=-16_384, maximum=16_384)
        elif command == "tabs":
            if action == "create":
                if len(rest) > 1:
                    raise CLIError("usage", "usage: overseer-browser tabs create [URL]")
                if rest:
                    params = {"url": rest[0]}
            elif action == "list":
                _exact(rest, 0, "tabs list")
            elif action in {"select", "close", "borrow", "return"}:
                _exact(rest, 1, f"tabs {action} TAB_ID")
                params = {"tab_id": _integer(rest[0])}
            else:
                raise CLIError("unknown_command", f"unknown command: {command}.{action}")
        elif command == "sessions":
            if action == "start":
                if len(rest) > 1:
                    raise CLIError("usage", "usage: overseer-browser sessions start [NAME]")
                if rest:
                    params = {"name": rest[0]}
            elif action in {"stop", "list"}:
                _exact(rest, 0, f"sessions {action}")
            else:
                raise CLIError("unknown_command", f"unknown command: {command}.{action}")
        else:
            if action not in {"start", "stop"}:
                raise CLIError("unknown_command", f"unknown command: {command}.{action}")
            _exact(rest, 0, f"{command} {action}")
        return f"{command}.{action}", params
    if command in {"click", "hover"}:
        _exact(args, 1, f"{command} REF")
        return command, {"ref": args[0]}
    if command in {"fill", "select"}:
        _exact(args, 2, f"{command} REF VALUE")
        return command, {"ref": args[0], "value": args[1]}
    if command == "type":
        _exact(args, 2, "type REF TEXT")
        return command, {"ref": args[0], "text": args[1]}
    if command == "press":
        if not 1 <= len(args) <= 2:
            raise CLIError("usage", "usage: overseer-browser press KEY [REF]")
        return command, ({"key": args[0]} if len(args) == 1 else {"key": args[0], "ref": args[1]})
    if command == "scroll":
        if not 1 <= len(args) <= 3:
            raise CLIError("usage", "usage: overseer-browser scroll Y | scroll REF | scroll X Y | scroll REF X Y")
        if len(args) == 1:
            if args[0].startswith("osr-"):
                return command, {"ref": args[0]}
            return command, {"y": _integer(args[0], minimum=-100_000, maximum=100_000)}
        if len(args) == 2:
            return command, {"x": _integer(args[0], minimum=-100_000, maximum=100_000), "y": _integer(args[1], minimum=-100_000, maximum=100_000)}
        return command, {"ref": args[0], "x": _integer(args[1], minimum=-100_000, maximum=100_000), "y": _integer(args[2], minimum=-100_000, maximum=100_000)}
    if command == "wait":
        params: dict[str, Any] = {}
        conditions = 0
        rest = list(args)
        while rest:
            flag = rest.pop(0)
            if flag == "--ready":
                params["ready"] = True
                conditions += 1
            elif flag == "--absent":
                params["absent"] = True
            elif flag in {"--url", "--text", "--selector", "--state", "--stable", "--timeout-ms"}:
                if not rest:
                    raise CLIError("usage", f"{flag} requires a value")
                value = rest.pop(0)
                if flag == "--url":
                    params["url_contains"] = value
                    conditions += 1
                elif flag == "--text":
                    params["text"] = value
                    conditions += 1
                elif flag == "--selector":
                    params["selector"] = value
                    conditions += 1
                elif flag == "--state":
                    if value not in {"visible", "hidden", "enabled"}:
                        raise CLIError("usage", "--state must be visible, hidden, or enabled")
                    params["state"] = value
                elif flag == "--stable":
                    params["dom_stable_ms"] = _integer(value, minimum=100, maximum=30_000)
                    conditions += 1
                else:
                    params["timeout_ms"] = _integer(value, minimum=1, maximum=45_000)
            else:
                raise CLIError(
                    "usage",
                    "usage: overseer-browser wait (--ready | --url TEXT | --text TEXT [--absent] | "
                    "--selector CSS [--state visible|hidden|enabled] | --stable MS) [--timeout-ms N]",
                )
        if conditions != 1:
            raise CLIError("usage", "wait requires exactly one condition: --ready, --url, --text, --selector, or --stable")
        return "wait.for", params
    if command == "cancel":
        _exact(args, 1, "cancel REQUEST_ID")
        return command, {"request_id": _checked_request_id(args[0])}
    if command == "takeover":
        if args and args not in (["prompt"], ["resume"]):
            raise CLIError("usage", "usage: overseer-browser takeover [prompt|resume]")
        if args == ["resume"]:
            return "takeover.resume", {}
        return "takeover.prompt", {}
    if command in {"screenshot-element", "element-screenshot"}:
        _exact(args, 1, f"{command} REF")
        return "screenshot.element", {"ref": args[0]}
    raise CLIError("unknown_command", f"unknown command: {command}")


def _require(args: list[str], count: int, usage: str) -> None:
    if len(args) < count:
        raise CLIError("usage", f"usage: overseer-browser {usage}")
def _exact(args: list[str], count: int, usage: str) -> None:
    if len(args) != count:
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

def _screenshot_output_format(output: Path) -> str:
    suffix = output.suffix.lower()
    try:
        return _SCREENSHOT_SUFFIX_FORMATS[suffix]
    except KeyError as exc:
        supported = ", ".join(_SCREENSHOT_SUFFIX_FORMATS)
        raise CLIError("screenshot_format", f"unsupported screenshot output suffix {suffix or '<none>'}; use {supported}") from exc


def _screenshot_payload_format(result: dict[str, Any], data: bytes, expected: str) -> None:
    reported = result.get("format")
    if not isinstance(reported, str):
        raise CLIError("screenshot_format", "screenshot response did not report an image format")
    reported = "jpeg" if reported.lower() in {"jpg", "jpeg"} else reported.lower()
    if reported != expected:
        raise CLIError("screenshot_format", f"screenshot response format {reported!r} cannot be written to a .{expected} path")
    reported_bytes = result.get("bytes")
    if reported_bytes is not None and (isinstance(reported_bytes, bool) or not isinstance(reported_bytes, int) or reported_bytes != len(data)):
        raise CLIError("screenshot_format", "screenshot response byte count does not match its encoded data")
    if not data.startswith(_SCREENSHOT_MAGIC[expected]):
        raise CLIError("screenshot_format", f"screenshot response bytes are not valid {expected} data")


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
        expected_format = _screenshot_output_format(path)
        _screenshot_payload_format(result, data, expected_format)
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

def _uc_bin() -> str:
    """UC binary location; UC_BIN overrides the default dev checkout."""
    return os.environ.get("UC_BIN") or os.path.expanduser(
        "~/dev/ultracompact/target/release/uc"
    )


def _uc_encode(payload: dict[str, Any]) -> str:
    """Encode `payload` as an UltraCompact packet (token-minimizing), with a
    token report on stderr. UC failures fall back to canonical JSON — never
    lose data."""
    try:
        proc = subprocess.run(
            [_uc_bin(), "encode", "--stats"],
            input=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "UC_TELEMETRY_SOURCE": "overseer-browser"},
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip())
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        return proc.stdout
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print(f"Warning: UC encoding failed ({exc}); emitting JSON", file=sys.stderr)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _render(payload: dict[str, Any], json_output: bool, raw_json: bool = False) -> None:
    if json_output:
        print(_uc_encode(payload) if not raw_json else json.dumps(payload, ensure_ascii=False, separators=(",", ":")), end="")
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
    raw_json = "--raw-json" in raw
    json_output = "--json" in raw or raw_json
    raw = [arg for arg in raw if arg not in ("--json", "--raw-json")]
    timeout = 30.0
    if "--timeout" in raw:
        index = raw.index("--timeout")
        try:
            timeout = _checked_timeout(raw[index + 1])
        except IndexError:
            _render({"ok": False, "error": {"code": "usage", "message": "--timeout requires seconds"}}, json_output, raw_json)
            return 2
        except CLIError as exc:
            _render({"ok": False, "error": {"code": exc.code, "message": exc.message}}, json_output, raw_json)
            return 2
        del raw[index : index + 2]
    request_id: str | None = None
    if "--request-id" in raw:
        index = raw.index("--request-id")
        try:
            request_id = _checked_request_id(raw[index + 1])
        except IndexError:
            _render({"ok": False, "error": {"code": "usage", "message": "--request-id requires an ID"}}, json_output, raw_json)
            return 2
        except CLIError as exc:
            _render({"ok": False, "error": {"code": exc.code, "message": exc.message}}, json_output, raw_json)
            return 2
        del raw[index : index + 2]
    tab_id: int | None = None
    if "--tab-id" in raw:
        index = raw.index("--tab-id")
        try:
            tab_id = _integer(raw[index + 1])
        except IndexError:
            _render({"ok": False, "error": {"code": "usage", "message": "--tab-id requires a tab ID"}}, json_output, raw_json)
            return 2
        except CLIError as exc:
            _render({"ok": False, "error": {"code": exc.code, "message": exc.message}}, json_output, raw_json)
            return 2
        del raw[index : index + 2]
    max_nodes: int | None = None
    if "--max-nodes" in raw:
        index = raw.index("--max-nodes")
        try:
            max_nodes = _integer(raw[index + 1], maximum=500)
        except IndexError:
            _render({"ok": False, "error": {"code": "usage", "message": "--max-nodes requires a node count"}}, json_output, raw_json)
            return 2
        except CLIError as exc:
            _render({"ok": False, "error": {"code": exc.code, "message": exc.message}}, json_output, raw_json)
            return 2
        del raw[index : index + 2]
    if not raw or raw[0] in {"-h", "--help"}:
        _render({
            "ok": True,
            "result": {
                "commands": list(CLI_COMMANDS)
            },
        }, json_output, raw_json)
        return 0
    command, args = raw[0], raw[1:]
    try:
        if command in {"install", "update", "uninstall"}:
            _exact(args, 0, command)
            payload = _run_script(command)
        elif command == "health":
            _exact(args, 0, "health")
            payload = local_health()
        elif command == "status":
            _exact(args, 0, "status")
            payload = local_health()
            payload["mode"] = "local-native"
            if payload.get("ok"):
                try:
                    extension_response = request_once("health.status", {}, timeout=timeout, request_id=request_id)
                except CLIError as exc:
                    payload["ok"] = False
                    payload["extension"] = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
                else:
                    extension_result = extension_response.get("result")
                    if extension_response.get("ok") is True and isinstance(extension_result, dict):
                        payload["extension"] = {"ok": True, **extension_result}
                    else:
                        payload["ok"] = False
                        payload["extension"] = {"ok": False, "error": extension_response.get("error", {"code": "invalid_response", "message": "Extension status was unavailable."})}
        elif command == "upload":
            _require(args, 2, "upload REF PATH [PATH...]")
            if max_nodes is not None:
                raise CLIError("usage", "--max-nodes applies only to snapshot and observe")
            ref = args[0]
            path_args = args[1:]
            if len(path_args) > MAX_UPLOAD_FILES:
                raise CLIError("invalid_upload", f"upload accepts 1-{MAX_UPLOAD_FILES} files")
            payload = None
            paths = [Path(path_arg).expanduser() for path_arg in path_args]
            for chunk in iter_upload_file_chunks(paths, ref):
                if tab_id is not None:
                    chunk["tab_id"] = tab_id
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
            mapping_args = [] if command == "screenshot" else args[:1]
            extension_command, params = _command_request(command, mapping_args)
            output_arg = args[0] if command == "screenshot" and args else args[1] if len(args) > 1 else None
            output_path = Path(output_arg).expanduser() if output_arg else None
            if output_path is not None:
                params["format"] = _screenshot_output_format(output_path)
            params = _apply_targeting(extension_command, params, tab_id, max_nodes)
            payload = request_once(extension_command, params, timeout=timeout, request_id=request_id)
            payload = _materialize_screenshot(payload, output_path)
        elif command == "help":
            _exact(args, 0, "help")
            payload = {
                "ok": True,
                "result": {
                    "commands": list(CLI_COMMANDS)
                },
            }
        else:
            extension_command, params = _command_request(command, args)
            params = _apply_targeting(extension_command, params, tab_id, max_nodes)
            payload = request_once(extension_command, params, timeout=timeout, request_id=request_id)
    except CLIError as exc:
        payload = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
    except ProtocolError as exc:
        payload = {"ok": False, "error": {"code": "protocol_error", "message": "native host exchanged an invalid protocol frame"}}
    except OSError as exc:
        payload = {"ok": False, "error": {"code": "native_io_error", "message": "native host communication failed"}}
    except ValueError as exc:
        payload = {"ok": False, "error": {"code": "error", "message": str(exc)}}
    _render(payload, json_output, raw_json)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
