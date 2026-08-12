"""Chrome native-messaging host and private Unix control socket.

The host is intentionally dependency-free. Chrome speaks little-endian native
frames; the local CLI socket speaks big-endian frames. No TCP listener is used.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
import ctypes
import math
import os
import socket
import stat
import struct
import sys
import threading
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

try:
    from .protocol import (
        EXTENSION_ID,
        MAX_ERROR_CODE,
        MAX_ERROR_TEXT,
        ProtocolError,
        encode_frame,
        meeting_forward_request,
        normalize_request_id,
        read_frame,
        validate_extension_message,
        validate_meeting_payload,
        validate_meeting_response,
        validate_request,
    )
    from .runtime import RuntimePaths, ensure_token, prepare_socket
except ImportError:
    from protocol import (  # type: ignore[no-redef]
        EXTENSION_ID,
        MAX_ERROR_CODE,
        MAX_ERROR_TEXT,
        ProtocolError,
        encode_frame,
        meeting_forward_request,
        normalize_request_id,
        read_frame,
        validate_extension_message,
        validate_meeting_payload,
        validate_meeting_response,
        validate_request,
    )
    from runtime import RuntimePaths, ensure_token, prepare_socket  # type: ignore[no-redef]
DEFAULT_REQUEST_TIMEOUT = 30.0
MAX_PENDING = 128
MAX_CLIENT_REQUEST_IDS = 4_096
MAX_ABANDONED_REQUEST_IDS = 16_384


@dataclass(eq=False)
class Client:
    connection: socket.socket
    write_lock: threading.Lock = field(default_factory=threading.Lock)
    request_ids_lock: threading.Lock = field(default_factory=threading.Lock)
    request_ids: set[str] = field(default_factory=set)


@dataclass
class Pending:
    request_id: str
    client: Client
    timer: threading.Timer
    created_at: float


class NativeHost:
    """Bridge one Chrome native port to authenticated local CLI clients."""

    def __init__(
        self,
        paths: RuntimePaths | None = None,
        *,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        native_in: BinaryIO | None = None,
        native_out: BinaryIO | None = None,
        ultravox_socket: Path | None = None,
    ) -> None:
        self.paths = paths or RuntimePaths.discover()
        if isinstance(request_timeout, bool):
            raise ValueError("timeout must be finite and positive")
        try:
            timeout = float(request_timeout)
        except (TypeError, ValueError) as exc:
            raise ValueError("timeout must be finite and positive") from exc
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self.request_timeout = max(0.2, min(timeout, 300.0))
        self.native_in = native_in or sys.stdin.buffer
        self.native_out = native_out or sys.stdout.buffer
        self.ultravox_socket = ultravox_socket
        self.token = ""
        self._server: socket.socket | None = None
        self._stop = threading.Event()
        self._native_write_lock = threading.Lock()
        self._pending: dict[str, Pending] = {}
        self._abandoned_request_ids: OrderedDict[str, None] = OrderedDict()
        self._pending_lock = threading.Lock()
        self._clients: set[Client] = set()
        self._clients_lock = threading.Lock()

    def serve(self) -> None:
        self.token = ensure_token(self.paths)
        prepare_socket(self.paths)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server = server
        try:
            server.bind(str(self.paths.socket))
            os.chmod(self.paths.socket, 0o600)
            server.listen(16)
            server.settimeout(0.4)
            accept_thread = threading.Thread(target=self._accept_loop, name="browser-host-cli", daemon=True)
            accept_thread.start()
            self._native_loop()
        finally:
            self._stop.set()
            server.close()
            self.paths.socket.unlink(missing_ok=True)
            with self._pending_lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for item in pending:
                item.timer.cancel()
                self._send_response(item.client, item.request_id, False, error=error("host_stopped", "native host stopped"))
            with self._clients_lock:
                clients = list(self._clients)
                self._clients.clear()
            for client in clients:
                client.connection.close()

    def _accept_loop(self) -> None:
        server = self._server
        if server is None:
            return
        while not self._stop.is_set():
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self._peer_is_current_user(connection):
                connection.close()
                continue
            client = Client(connection)
            with self._clients_lock:
                self._clients.add(client)
            threading.Thread(target=self._client_loop, args=(client,), daemon=True).start()

    def _peer_is_current_user(self, connection: socket.socket) -> bool:
        if not hasattr(os, "getuid"):
            return True
        try:
            getpeereid = getattr(connection, "getpeereid", None)
            if getpeereid is not None:
                uid, _ = getpeereid()
                return uid == os.getuid()
            if hasattr(socket, "SO_PEERCRED"):
                raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                uid = struct.unpack("3i", raw[:12])[1]
                return uid == os.getuid()
        except OSError:
            return False
        return True

    def _client_loop(self, client: Client) -> None:
        connection = client.connection
        connection.settimeout(0.5)
        try:
            while not self._stop.is_set():
                try:
                    message = read_frame(connection, byteorder="big")
                except socket.timeout:
                    continue
                except EOFError:
                    break
                except ProtocolError as exc:
                    self._send_response(client, "", False, error=error("protocol_error", str(exc)))
                    break
                except OSError:
                    break
                self._route_request(client, message)
        finally:
            with self._clients_lock:
                self._clients.discard(client)
            connection.close()
            self._drop_client_pending(client)

    def _route_request(self, client: Client, message: object) -> None:
        request_id = normalize_request_id(message.get("request_id") if isinstance(message, dict) else None)
        try:
            request = validate_request(message, self.token)
        except ProtocolError as exc:
            self._send_response(client, request_id, False, error=error(_error_code(str(exc)), str(exc)))
            return
        request_id = request["request_id"]
        with self._pending_lock:
            if request_id in self._abandoned_request_ids:
                self._send_response(client, request_id, False, error=error("duplicate_request", "request_id was abandoned on a previous connection"))
                return
            with client.request_ids_lock:
                if request_id in client.request_ids:
                    self._send_response(client, request_id, False, error=error("duplicate_request", "request_id was already used on this connection"))
                    return
                if len(client.request_ids) >= MAX_CLIENT_REQUEST_IDS:
                    self._send_response(client, request_id, False, error=error("request_id_exhausted", "connection request ID limit reached"))
                    return
                client.request_ids.add(request_id)
            if len(self._pending) >= MAX_PENDING:
                self._send_response(client, request_id, False, error=error("busy", "too many pending requests"))
                return
            if request_id in self._pending:
                self._send_response(client, request_id, False, error=error("duplicate_request", "request_id is already pending"))
                return
            timer = threading.Timer(self.request_timeout, self._expire, args=(request_id,))
            timer.daemon = True
            self._pending[request_id] = Pending(request_id, client, timer, time.monotonic())
            timer.start()
        try:
            self._write_native(request)
        except ProtocolError as exc:
            with self._pending_lock:
                pending = self._pending.pop(request_id, None)
            if pending is not None:
                pending.timer.cancel()
            self._send_response(client, request_id, False, error=error("request_too_large", str(exc)))
        except (BrokenPipeError, OSError) as exc:
            with self._pending_lock:
                pending = self._pending.pop(request_id, None)
            if pending is not None:
                pending.timer.cancel()
            self._send_response(client, request_id, False, error=error("native_disconnected", str(exc)))

    def _write_native(self, request: dict[str, Any]) -> None:
        payload = encode_frame(request, byteorder="little")
        with self._native_write_lock:
            self.native_out.write(payload)
            flush = getattr(self.native_out, "flush", None)
            if flush is not None:
                flush()

    def _native_loop(self) -> None:
        while not self._stop.is_set():
            try:
                message = read_frame(self.native_in, byteorder="little")
            except EOFError:
                return
            except ProtocolError as exc:
                self._write_native_safely({"version": 1, "kind": "error", "error": error("protocol_error", str(exc))})
                return
            except OSError:
                self._write_native_safely(
                    {"version": 1, "kind": "error", "error": error("native_disconnected", "native input disconnected")}
                )
                return
            try:
                message = validate_extension_message(message)
            except ProtocolError as exc:
                self._write_native_safely({"version": 1, "kind": "error", "error": error(_error_code(str(exc)), str(exc))})
                continue
            kind = message["kind"]
            if kind in {"handshake", "hello"}:
                self._write_native_safely(
                    {
                        "version": 1,
                        "kind": "handshake_ack",
                        "ok": True,
                        "extension_id": EXTENSION_ID,
                        "capabilities": ["local_control", "meeting_detection"],
                    }
                )
            elif kind == "response":
                self._route_extension_response(message)
            elif kind == "meeting_detected":
                payload = message["payload"]
                delivered = self._forward_meeting(payload)
                self._write_native_safely(
                    {
                        "version": 1,
                        "kind": "meeting_ack",
                        "detection_id": payload["detection_id"],
                        "delivered": delivered,
                    }
                )

    def _write_native_safely(self, message: dict[str, Any]) -> None:
        try:
            self._write_native(message)
        except ProtocolError:
            fallback = {
                "version": 1,
                "kind": "error",
                "error": {"code": "protocol_error", "message": "native outbound frame exceeds the size limit"},
            }
            try:
                self._write_native(fallback)
            except (BrokenPipeError, OSError, ProtocolError):
                self._stop.set()
        except (BrokenPipeError, OSError):
            self._stop.set()

    def _route_extension_response(self, message: dict[str, Any]) -> None:
        request_id = message["request_id"]
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
            if pending is None:
                self._abandoned_request_ids.pop(request_id, None)
                return
        pending.timer.cancel()
        if message.get("ok"):
            self._send_response(pending.client, request_id, True, result=message.get("result"))
        else:
            self._send_response(pending.client, request_id, False, error=_normalise_error(message.get("error")))

    def _expire(self, request_id: str) -> None:
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
            if pending is not None:
                self._remember_abandoned_request_id(request_id)
        if pending is not None:
            self._send_response(pending.client, request_id, False, error=error("timeout", "request timed out"))
            if not self._stop.is_set():
                self._cancel_extension_request(request_id)

    def _remember_abandoned_request_id(self, request_id: str) -> None:
        """Retain recent abandoned IDs while deterministically evicting old ones."""
        self._abandoned_request_ids.pop(request_id, None)
        self._abandoned_request_ids[request_id] = None
        while len(self._abandoned_request_ids) > MAX_ABANDONED_REQUEST_IDS:
            self._abandoned_request_ids.popitem(last=False)

    def _drop_client_pending(self, client: Client) -> None:
        abandoned: list[str] = []
        with self._pending_lock:
            stale = [item for item in self._pending.values() if item.client is client]
            for item in stale:
                self._pending.pop(item.request_id, None)
                item.timer.cancel()
                self._remember_abandoned_request_id(item.request_id)
                abandoned.append(item.request_id)
        if not self._stop.is_set():
            for request_id in abandoned:
                self._cancel_extension_request(request_id)

    def _cancel_extension_request(self, request_id: str) -> None:
        """Best-effort cancellation using a unique internal request ID."""
        cancel_id = f"cancel-{uuid.uuid4().hex}"
        try:
            self._write_native(
                {
                    "version": 1,
                    "kind": "request",
                    "request_id": cancel_id,
                    "command": "cancel",
                    "params": {"request_id": request_id},
                }
            )
        except (BrokenPipeError, OSError, ProtocolError):
            return

    def _send_response(
        self,
        client: Client,
        request_id: str,
        ok: bool,
        *,
        result: Any = None,
        error: dict[str, str] | None = None,
    ) -> None:
        response: dict[str, Any] = {
            "version": 1,
            "kind": "response",
            "request_id": normalize_request_id(request_id),
            "ok": ok,
        }
        if ok:
            if result is not None:
                response["result"] = result
        else:
            response["error"] = _normalise_error(error)
        try:
            encoded = encode_frame(response, byteorder="big")
        except ProtocolError:
            response = {
                "version": 1,
                "kind": "response",
                "request_id": response["request_id"],
                "ok": False,
                "error": {"code": "response_too_large", "message": "response exceeds the native frame size limit"},
            }
            try:
                encoded = encode_frame(response, byteorder="big")
            except ProtocolError:
                return
        try:
            with client.write_lock:
                client.connection.sendall(encoded)
        except (BrokenPipeError, OSError):
            client.connection.close()

    def _forward_meeting(self, payload: dict[str, Any]) -> bool:
        try:
            clean = validate_meeting_payload(payload)
        except ProtocolError:
            return False
        path = self.ultravox_socket or _ultravox_socket_from_env()
        if path is None or not _is_private_unix_socket(path):
            return False
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(0.25)
                connection.connect(str(path))
                if not _peer_is_current_user(connection):
                    return False
                connection.sendall(encode_frame(meeting_forward_request(clean), byteorder="big"))
                response = read_frame(connection, byteorder="big")
                validated = validate_meeting_response(response, clean["detection_id"])
                return validated["ok"] is True
        except (EOFError, ProtocolError, FileNotFoundError, ConnectionRefusedError, TimeoutError, OSError):
            return False


def _is_private_unix_socket(path: Path) -> bool:
    if not hasattr(os, "getuid"):
        return False
    try:
        parent_metadata = path.parent.lstat()
        socket_metadata = path.lstat()
    except OSError:
        return False
    return (
        stat.S_ISDIR(parent_metadata.st_mode)
        and stat.S_ISSOCK(socket_metadata.st_mode)
        and parent_metadata.st_uid == os.getuid()
        and socket_metadata.st_uid == os.getuid()
        and (stat.S_IMODE(parent_metadata.st_mode) & 0o077) == 0
        and (stat.S_IMODE(socket_metadata.st_mode) & 0o077) == 0
    )


def _peer_is_current_user(connection: socket.socket) -> bool:
    if not hasattr(os, "getuid"):
        return False
    getpeereid = getattr(connection, "getpeereid", None)
    if callable(getpeereid):
        try:
            peer_uid, _ = getpeereid()
        except OSError:
            return False
        return peer_uid == os.getuid()
    if sys.platform == "darwin":
        effective_uid = ctypes.c_uint()
        effective_gid = ctypes.c_uint()
        libc = ctypes.CDLL(None, use_errno=True)
        result = libc.getpeereid(
            connection.fileno(),
            ctypes.byref(effective_uid),
            ctypes.byref(effective_gid),
        )
        return result == 0 and effective_uid.value == os.getuid()
    peer_credential = getattr(socket, "SO_PEERCRED", None)
    if peer_credential is None:
        return False
    try:
        raw = connection.getsockopt(socket.SOL_SOCKET, peer_credential, struct.calcsize("3i"))
        _, peer_uid, _ = struct.unpack("3i", raw)
    except (OSError, struct.error):
        return False
    return peer_uid == os.getuid()


def _ultravox_socket_from_env() -> Path | None:
    configured = os.environ.get("ULTRAVOX_VOICE_SOCKET", "").strip()
    if configured:
        return Path(configured).expanduser()
    runtime = os.environ.get("ULTRAVOX_RUNTIME_DIR", "").strip()
    if runtime:
        return Path(runtime).expanduser() / "voice-v1.sock"
    if sys.platform == "darwin":
        return Path(tempfile.gettempdir()) / "com.imploselabs.ultravox" / "voice-v1.sock"
    return None


def error(code: str, message: str) -> dict[str, str]:
    return {"code": code[:MAX_ERROR_CODE], "message": message[:MAX_ERROR_TEXT]}


def _normalise_error(value: object) -> dict[str, str]:
    if isinstance(value, dict) and isinstance(value.get("code"), str) and isinstance(value.get("message"), str):
        code = value["code"][:MAX_ERROR_CODE]
        message = value["message"][:MAX_ERROR_TEXT]
        if code and message:
            clean = {"code": code, "message": message}
            for field in ("reason", "fallback"):
                candidate = value.get(field)
                if isinstance(candidate, str):
                    clean[field] = candidate[:MAX_ERROR_TEXT]
            return clean
    return error("extension_error", "extension returned an invalid error")


def _error_code(message: str) -> str:
    lowered = message.lower()
    if "auth" in lowered:
        return "unauthorized"
    if "request_id" in lowered:
        return "invalid_request"
    return "protocol_error"


def validate_caller_origin(origin: str | None) -> None:
    """Validate Chrome's caller origin against the installed extension exactly."""
    if origin != f"chrome-extension://{EXTENSION_ID}/":
        raise ValueError("caller origin is not the installed OverSeer Browser extension")

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OverSeer Browser Chrome native host")
    parser.add_argument("origin", nargs="?", help="Chrome caller origin")
    parser.add_argument("--parent-window", nargs="?", default=None, help="Chrome parent window handle")
    parser.add_argument("--timeout", type=float, default=DEFAULT_REQUEST_TIMEOUT)
    args = parser.parse_args(argv)
    try:
        validate_caller_origin(args.origin)
        NativeHost(request_timeout=args.timeout).serve()
    except (FileExistsError, PermissionError, ValueError) as exc:
        print(f"overseer-browser native host: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
