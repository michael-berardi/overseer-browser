"""Bounded JSON framing and protocol validation for the local browser bridge."""
from __future__ import annotations

import hmac
import json
import re
import struct
from typing import Any, BinaryIO

MAX_FRAME_BYTES = 1_048_576
MAX_REQUEST_ID = 128
MAX_COMMAND = 96
EXTENSION_ID = "iabfdeokmilpklblkgccpjlekchfjcno"
NATIVE_HOST_NAME = "com.imploselabs.overseer_browser"

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_COMMAND_RE = re.compile(r"^[A-Za-z0-9_.:/-]{1,96}$")
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


class ProtocolError(ValueError):
    """Raised when a frame is malformed or exceeds a protocol bound."""


def _read_exact(stream: BinaryIO, count: int, *, idle_timeout: bool = False) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        reader = getattr(stream, "recv", None)
        try:
            chunk = reader(remaining) if reader is not None else stream.read(remaining)
        except TimeoutError as exc:
            if chunks or not idle_timeout:
                raise ProtocolError("truncated frame") from exc
            raise
        if not chunk:
            if chunks:
                raise ProtocolError("truncated frame")
            raise EOFError
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def encode_frame(value: dict[str, Any], *, byteorder: str = "big") -> bytes:
    """Encode one bounded JSON object using a four-byte unsigned length prefix."""
    if not isinstance(value, dict):
        raise ProtocolError("frame must be a JSON object")
    try:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProtocolError("frame is not JSON serializable") from exc
    if not payload or len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError("frame exceeds maximum size")
    prefix = "<I" if byteorder == "little" else ">I"
    if byteorder not in {"little", "big"}:
        raise ProtocolError("byteorder must be little or big")
    return struct.pack(prefix, len(payload)) + payload


def read_frame(stream: BinaryIO, *, byteorder: str = "big") -> dict[str, Any]:
    """Read and decode one frame from a socket or binary stream."""
    if byteorder not in {"little", "big"}:
        raise ProtocolError("byteorder must be little or big")
    prefix = "<I" if byteorder == "little" else ">I"
    header = _read_exact(stream, 4, idle_timeout=True)
    size = struct.unpack(prefix, header)[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise ProtocolError("invalid frame length")
    payload = _read_exact(stream, size)
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("frame payload is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("frame must be a JSON object")
    return value


def validate_request(message: object, token: str | None = None) -> dict[str, Any]:
    """Validate a CLI request and return a copy without its authentication token."""
    if not isinstance(message, dict):
        raise ProtocolError("request must be an object")
    if message.get("version") != 1 or message.get("kind") != "request":
        raise ProtocolError("unsupported request version or kind")
    request_id = message.get("request_id")
    command = message.get("command")
    params = message.get("params", {})
    if not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id):
        raise ProtocolError("invalid request_id")
    if not isinstance(command, str) or not _COMMAND_RE.fullmatch(command):
        raise ProtocolError("invalid command")
    if not isinstance(params, dict):
        raise ProtocolError("params must be an object")
    supplied = message.get("token")
    if token is not None and (not isinstance(supplied, str) or not hmac.compare_digest(supplied, token)):
        raise ProtocolError("authentication failed")
    clean = {"version": 1, "kind": "request", "request_id": request_id, "command": command, "params": params}
    return clean


def validate_extension_message(message: object) -> dict[str, Any]:
    """Validate an extension-to-host message."""
    if not isinstance(message, dict) or message.get("version") != 1:
        raise ProtocolError("unsupported extension message")
    kind = message.get("kind")
    if kind in {"handshake", "hello"}:
        extension_id = message.get("extension_id")
        if extension_id is not None and extension_id != EXTENSION_ID:
            raise ProtocolError("extension identity mismatch")
        return message
    if kind == "response":
        request_id = message.get("request_id")
        if not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id):
            raise ProtocolError("invalid response request_id")
        if not isinstance(message.get("ok"), bool):
            raise ProtocolError("response ok must be boolean")
        return message
    if kind == "meeting_detected":
        validate_meeting_payload(message.get("payload"))
        return message
    raise ProtocolError("unsupported extension message kind")


def validate_meeting_payload(payload: object) -> dict[str, Any]:
    """Validate the opaque meeting event without accepting URL or content fields."""
    if not isinstance(payload, dict):
        raise ProtocolError("meeting payload must be an object")
    if payload.get("version") != 1:
        raise ProtocolError("unsupported meeting payload version")
    detection_id = payload.get("detection_id")
    provider = payload.get("provider")
    meeting_key = payload.get("meeting_key")
    detected_at_ms = payload.get("detected_at_ms")
    if not isinstance(detection_id, str) or not _REQUEST_ID_RE.fullmatch(detection_id):
        raise ProtocolError("invalid detection_id")
    if provider not in {"google_meet", "zoom"}:
        raise ProtocolError("unsupported meeting provider")
    if not isinstance(meeting_key, str) or not _HEX64_RE.fullmatch(meeting_key):
        raise ProtocolError("invalid opaque meeting key")
    if isinstance(detected_at_ms, bool) or not isinstance(detected_at_ms, int) or detected_at_ms < 0:
        raise ProtocolError("invalid detection timestamp")
    return {
        "version": 1,
        "detection_id": detection_id,
        "provider": provider,
        "meeting_key": meeting_key,
        "detected_at_ms": detected_at_ms,
    }


def meeting_forward_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Build the only shape permitted on the optional UltraVox Unix socket."""
    clean = validate_meeting_payload(payload)
    return {"version": 1, "requestId": clean["detection_id"], "command": "meeting_detected", "detection": clean}
