from __future__ import annotations

import base64
import io
import json
import os
import socket
import stat
import tempfile
import threading
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from cli.main import (
    CLIError,
    MAX_BATCH_SOURCE_BYTES,
    MAX_EXTENSION_REQUEST_BYTES,
    _command_request,
    _materialize_screenshot,
    _serialized_batch_request_bytes,
    _manifest_paths,
    iter_upload_chunks,
    iter_upload_file_chunks,
    local_health,
    main as cli_main,
    request_once,
)
from native_host.host import Client, NativeHost, _normalise_error, main as native_main, validate_caller_origin
from native_host.protocol import ProtocolError, encode_frame, read_frame, validate_meeting_response, validate_request
from native_host.runtime import RuntimePaths, ensure_token, native_manifest


class FramingTests(unittest.TestCase):
    def test_native_little_and_cli_big_endian_frames_round_trip(self) -> None:
        message = {"version": 1, "kind": "request", "request_id": "x", "params": {"ok": True}}
        self.assertEqual(read_frame(io.BytesIO(encode_frame(message, byteorder="little")), byteorder="little"), message)
        self.assertEqual(read_frame(io.BytesIO(encode_frame(message, byteorder="big")), byteorder="big"), message)

    def test_timeout_after_complete_header_is_fatal(self) -> None:
        class HeaderThenTimeout:
            def __init__(self) -> None:
                self.calls = 0

            def read(self, count: int) -> bytes:
                self.calls += 1
                if self.calls == 1:
                    return (3).to_bytes(4, "big")
                raise TimeoutError

        with self.assertRaises(ProtocolError):
            read_frame(HeaderThenTimeout())

    def test_timeout_before_any_header_byte_remains_idle_timeout(self) -> None:
        class Idle:
            def read(self, count: int) -> bytes:
                raise TimeoutError

        with self.assertRaises(TimeoutError):
            read_frame(Idle())


    def test_authentication_is_required_and_constant_shape_is_returned(self) -> None:
        request = {"version": 1, "kind": "request", "request_id": "x", "command": "snapshot", "params": {}, "token": "secret"}
        self.assertEqual(validate_request(request, "secret")["kind"], "request")
        with self.assertRaises(ProtocolError):
            validate_request({**request, "token": "wrong"}, "secret")
    def test_outbound_frame_bound_is_rejected(self) -> None:
        with self.assertRaises(ProtocolError):
            encode_frame({"payload": "x" * (1_048_576 + 1)})

    def test_meeting_adapter_response_requires_bounded_complete_envelope(self) -> None:
        valid = {"version": 1, "requestId": "d1", "ok": True, "state": "prompted"}
        self.assertEqual(validate_meeting_response(valid, "d1"), valid)
        for response in (
            {"version": 2, "requestId": "d1", "ok": True, "state": "prompted"},
            {"version": 1, "requestId": "other", "ok": True, "state": "prompted"},
            {"version": 1, "requestId": "d1", "ok": "yes", "state": "prompted"},
            {"version": 1, "requestId": "d1", "ok": True, "state": "x" * 129},
        ):
            with self.subTest(response=response):
                with self.assertRaises(ProtocolError):
                    validate_meeting_response(response, "d1")



class RuntimeTests(unittest.TestCase):
    def test_token_and_runtime_are_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = RuntimePaths(root, root / "host.sock", root / "token")
            ensure_token(paths)
            self.assertEqual(stat.S_IMODE(paths.root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(paths.token.stat().st_mode), 0o600)

    def test_manifest_has_exact_origin_and_no_debugger_permission(self) -> None:
        manifest = native_manifest(Path("/private/host"))
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/"])
        self.assertNotIn("debugger", json.dumps(manifest))
        self.assertNotIn("key", manifest)

    def test_chrome_origin_is_exact_and_wrong_origin_is_rejected(self) -> None:
        validate_caller_origin("chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/")
        with self.assertRaises(ValueError):
            validate_caller_origin(None)
        with self.assertRaises(ValueError):
            validate_caller_origin("chrome-extension://other/")

    def test_native_timeout_must_be_finite_and_positive(self) -> None:
        for timeout in (0, -1, float("nan"), float("inf")):
            with self.subTest(timeout=timeout):
                with self.assertRaises(ValueError):
                    NativeHost(request_timeout=timeout)

    def test_native_main_tolerates_chrome_parent_window_argument(self) -> None:
        with patch("native_host.host.NativeHost.serve"):
            self.assertEqual(
                native_main(
                    [
                        "chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/",
                        "--parent-window",
                        "0",
                    ]
                ),
                0,
            )

    def test_native_host_runs_as_installed_script(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).parents[1] / "native_host" / "host.py"),
                    "chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/",
                ],
                env={**os.environ, "OVERSEER_BROWSER_RUNTIME": directory},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as process:
                assert process.stdin is not None
                assert process.stdout is not None
                handshake = {
                    "version": 1,
                    "kind": "handshake",
                    "extension_id": "iabfdeokmilpklblkgccpjlekchfjcno",
                    "capabilities": ["health.status"],
                }
                process.stdin.write(encode_frame(handshake, byteorder="little"))
                process.stdin.flush()
                response = read_frame(process.stdout, byteorder="little")
                self.assertEqual(response["kind"], "handshake_ack")
                self.assertTrue(response["ok"])
                process.terminate()
                process.wait(timeout=2)

    def test_local_status_reports_unconnected_host_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(
                os.environ,
                {
                    "OVERSEER_BROWSER_RUNTIME": directory,
                    "OVERSEER_BROWSER_MANIFEST": str(Path(directory) / "manifest.json"),
                },
            ):
                status = local_health()
        self.assertFalse(status["ok"])
        self.assertFalse(status["socket"]["ok"])
        self.assertEqual(status["token"], {"ok": False})

class HostRoutingTests(unittest.TestCase):
    def test_request_is_authenticated_then_forwarded_without_token(self) -> None:
        native_out = io.BytesIO()
        host = NativeHost(native_in=io.BytesIO(), native_out=native_out, request_timeout=5)
        with tempfile.TemporaryDirectory() as directory:
            paths = RuntimePaths(Path(directory), Path(directory) / "host.sock", Path(directory) / "token")
            host.paths = paths
            host.token = "secret"
            left, right = socket.socketpair()
            client = Client(left)
            try:
                host._route_request(client, {"version": 1, "kind": "request", "request_id": "r1", "command": "snapshot", "params": {}, "token": "secret"})
                forwarded = read_frame(io.BytesIO(native_out.getvalue()), byteorder="little")
                self.assertNotIn("token", forwarded)
                self.assertEqual(forwarded["request_id"], "r1")
            finally:
                right.close()
                left.close()
                host._drop_client_pending(client)

    def test_timeout_returns_structured_error(self) -> None:
        host = NativeHost(native_in=io.BytesIO(), native_out=io.BytesIO(), request_timeout=0.2)
        host.token = "secret"
        left, right = socket.socketpair()
        client = Client(left)
        try:
            host._route_request(client, {"version": 1, "kind": "request", "request_id": "r2", "command": "snapshot", "params": {}, "token": "secret"})
            response = read_frame(right, byteorder="big")
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "timeout")
        finally:
            right.close()
            left.close()
    def test_pending_requests_share_one_deadline_worker(self) -> None:
        host = NativeHost(native_in=io.BytesIO(), native_out=io.BytesIO(), request_timeout=5)
        host.token = "secret"
        left, right = socket.socketpair()
        client = Client(left)
        try:
            for index in range(64):
                host._route_request(
                    client,
                    {
                        "version": 1,
                        "kind": "request",
                        "request_id": f"shared-deadline-{index}",
                        "command": "snapshot",
                        "params": {},
                        "token": "secret",
                    },
                )
            worker = host._expiry_thread
            self.assertIsNotNone(worker)
            self.assertTrue(worker.is_alive())
            self.assertEqual(len(host._pending), 64)
            self.assertTrue(all(not hasattr(item, "timer") for item in host._pending.values()))
            host._drop_client_pending(client)
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())
        finally:
            right.close()
            left.close()
    def test_invalid_request_id_is_not_echoed_in_error(self) -> None:
        host = NativeHost(native_in=io.BytesIO(), native_out=io.BytesIO())
        host.token = "secret"
        left, right = socket.socketpair()
        try:
            host._route_request(
                Client(left),
                {
                    "version": 1,
                    "kind": "request",
                    "request_id": "x" * 129,
                    "command": "snapshot",
                    "params": {},
                    "token": "secret",
                },
            )
            response = read_frame(right, byteorder="big")
            self.assertEqual(response["request_id"], "")
            self.assertFalse(response["ok"])
        finally:
            right.close()
            left.close()

    def test_oversized_response_is_replaced_by_bounded_structured_error(self) -> None:
        host = NativeHost(native_in=io.BytesIO(), native_out=io.BytesIO())
        left, right = socket.socketpair()
        try:
            host._send_response(Client(left), "large", True, result={"data": "x" * 1_048_576})
            response = read_frame(right, byteorder="big")
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "response_too_large")
        finally:
            right.close()
            left.close()

    def test_extension_error_preserves_bounded_reason_and_fallback(self) -> None:
        value = _normalise_error({"code": "failed", "message": "message", "reason": "why", "fallback": "try again"})
        self.assertEqual(value, {"code": "failed", "message": "message", "reason": "why", "fallback": "try again"})
        bounded = _normalise_error({"code": "failed", "message": "m", "reason": "r" * 10_000, "fallback": "f" * 10_000})
        self.assertLessEqual(len(bounded["reason"]), 4_096)
        self.assertLessEqual(len(bounded["fallback"]), 4_096)

    def test_same_connection_cannot_reuse_request_id_after_response(self) -> None:
        native_out = io.BytesIO()
        host = NativeHost(native_in=io.BytesIO(), native_out=native_out, request_timeout=5)
        host.token = "secret"
        left, right = socket.socketpair()
        client = Client(left)
        try:
            request = {"version": 1, "kind": "request", "request_id": "reuse", "command": "snapshot", "params": {}, "token": "secret"}
            host._route_request(client, request)
            host._route_extension_response({"version": 1, "kind": "response", "request_id": "reuse", "ok": True, "result": {}})
            self.assertTrue(read_frame(right, byteorder="big")["ok"])
            host._route_request(client, request)
            response = read_frame(right, byteorder="big")
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "duplicate_request")
        finally:
            right.close()
            left.close()
    def test_abandoned_requests_cancel_beyond_retention_cap(self) -> None:
        native_out = io.BytesIO()
        host = NativeHost(native_in=io.BytesIO(), native_out=native_out, request_timeout=5)
        host.token = "secret"
        left, right = socket.socketpair()
        client = Client(left)
        request_ids = [f"abandoned-{index}" for index in range(3)]
        try:
            with patch("native_host.host.MAX_ABANDONED_REQUEST_IDS", 2):
                for request_id in request_ids:
                    host._route_request(
                        client,
                        {
                            "version": 1,
                            "kind": "request",
                            "request_id": request_id,
                            "command": "snapshot",
                            "params": {},
                            "token": "secret",
                        },
                    )
                host._drop_client_pending(client)
                self.assertEqual(list(host._abandoned_request_ids), request_ids[-2:])
                self.assertLessEqual(len(host._abandoned_request_ids), 2)

            frames: list[dict] = []
            output = io.BytesIO(native_out.getvalue())
            while True:
                try:
                    frames.append(read_frame(output, byteorder="little"))
                except EOFError:
                    break
            cancellations = [frame for frame in frames if frame.get("command") == "cancel"]
            self.assertEqual(len(cancellations), len(request_ids))
            self.assertEqual(
                {frame["params"]["request_id"] for frame in cancellations},
                set(request_ids),
            )
        finally:
            right.close()
            left.close()

    def test_timeout_cancels_extension_request(self) -> None:
        native_out = io.BytesIO()
        host = NativeHost(native_in=io.BytesIO(), native_out=native_out, request_timeout=5)
        host.token = "secret"
        left, right = socket.socketpair()
        client = Client(left)
        try:
            host._route_request(
                client,
                {
                    "version": 1,
                    "kind": "request",
                    "request_id": "timed-out",
                    "command": "snapshot",
                    "params": {},
                    "token": "secret",
                },
            )
            host._expire("timed-out")
            self.assertEqual(read_frame(right, byteorder="big")["error"]["code"], "timeout")
            output = io.BytesIO(native_out.getvalue())
            forwarded = read_frame(output, byteorder="little")
            cancellation = read_frame(output, byteorder="little")
            self.assertEqual(forwarded["request_id"], "timed-out")
            self.assertEqual(cancellation["command"], "cancel")
            self.assertEqual(cancellation["params"]["request_id"], "timed-out")
        finally:
            right.close()
            left.close()


class MeetingForwardingTests(unittest.TestCase):
    def test_only_opaque_detection_is_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice-v1.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            path.chmod(0o600)
            listener.listen(1)
            received: list[dict] = []

            def receive() -> None:
                connection, _ = listener.accept()
                with connection:
                    frame = read_frame(connection, byteorder="big")
                    received.append(frame)
                    connection.sendall(encode_frame({"version": 1, "requestId": "d1", "ok": True, "state": "prompted"}, byteorder="big"))

            thread = threading.Thread(target=receive)
            thread.start()
            host = NativeHost(ultravox_socket=path)
            delivered = host._forward_meeting({"version": 1, "detection_id": "d1", "provider": "zoom", "meeting_key": "a" * 64, "detected_at_ms": 1})
            thread.join(timeout=1)
            listener.close()
            self.assertEqual(received[0]["command"], "meeting_detected")
            self.assertNotIn("url", json.dumps(received[0]))
            self.assertTrue(delivered)


class CLIMappingTests(unittest.TestCase):
    def test_sessions_stop_targets_only_active_session(self) -> None:
        self.assertEqual(_command_request("sessions", ["stop"]), ("sessions.stop", {}))
        with self.assertRaises(CLIError):
            _command_request("sessions", ["stop", "session-id"])
    def test_batch_source_bound_accounts_for_complete_extension_envelope(self) -> None:
        prefix = '{"actions":[{"command":"tabs.list","params":{"padding":"'
        suffix = '"}}]}'
        padding = "x" * (MAX_BATCH_SOURCE_BYTES - len((prefix + suffix).encode("utf-8")))
        source = prefix + padding + suffix
        self.assertEqual(len(source.encode("utf-8")), MAX_BATCH_SOURCE_BYTES)
        command, payload = _command_request("batch", [source])
        self.assertEqual(command, "batch")
        self.assertEqual(_serialized_batch_request_bytes(payload), MAX_EXTENSION_REQUEST_BYTES)

        with self.assertRaisesRegex(CLIError, "batch requires a finite JSON array or object contract"):
            _command_request("batch", [source + " "])
    def test_legacy_and_expanded_commands_match_extension_schema(self) -> None:
        self.assertEqual(_command_request("open", ["https://example.test"]), ("navigate", {"url": "https://example.test"}))
        self.assertEqual(_command_request("tabs", ["select", "42"]), ("tabs.select", {"tab_id": 42}))
        self.assertEqual(_command_request("evaluate", ["1 + 1"]), ("evaluate", {"source": "1 + 1"}))
        self.assertEqual(_command_request("fill", ["@e1", "hello"]), ("fill", {"ref": "@e1", "value": "hello"}))
        self.assertEqual(_command_request("type", ["@e1", "hello"]), ("type", {"ref": "@e1", "text": "hello"}))
        self.assertEqual(_command_request("press", ["Enter"]), ("press", {"key": "Enter"}))
        self.assertEqual(_command_request("cancel", ["known-request"]), ("cancel", {"request_id": "known-request"}))
        self.assertEqual(_command_request("takeover", []), ("takeover.prompt", {}))
        self.assertEqual(_command_request("takeover", ["resume"]), ("takeover.resume", {}))
        with self.assertRaises(CLIError):
            _command_request("takeover", ["invalid"])
        self.assertEqual(_command_request("press", ["Enter", "osr-submit"]), ("press", {"key": "Enter", "ref": "osr-submit"}))
        self.assertEqual(_command_request("scroll", ["osr-target"]), ("scroll", {"ref": "osr-target"}))
        self.assertEqual(_command_request("scroll", ["500"]), ("scroll", {"y": 500}))
    def test_help_lists_all_public_command_aliases(self) -> None:
        with patch("cli.main._render") as render:
            self.assertEqual(cli_main(["help"]), 0)
        payload = render.call_args.args[0]
        commands = payload["result"]["commands"]
        self.assertTrue(
            {
                "open", "close", "back", "forward", "reload", "eval",
                "element-screenshot", "help",
            }.issubset(commands)
        )

    def test_macos_manifest_discovery_includes_chrome_for_testing(self) -> None:
        with (
            patch("cli.main.sys.platform", "darwin"),
            patch("cli.main.Path.home", return_value=Path("/Users/test")),
        ):
            self.assertEqual(
                _manifest_paths(),
                [
                    Path("/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.imploselabs.overseer_browser.json"),
                    Path("/Users/test/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.imploselabs.overseer_browser.json"),
                ],
            )

    def test_status_combines_local_and_extension_readiness(self) -> None:
        extension = {
            "version": 1,
            "kind": "response",
            "request_id": "status",
            "ok": True,
            "result": {
                "connected": True,
                "extension_id": "iabfdeokmilpklblkgccpjlekchfjcno",
                "evaluate_enabled": False,
                "permissions": {
                    "meetingHosts": True,
                    "optionalSiteAccess": True,
                    "currentOrigin": "https://example.test/*",
                    "currentOriginAccess": True,
                    "allSiteAccess": True,
                },
                "sessions": [],
            },
        }
        with (
            patch("cli.main.local_health", return_value={"ok": True, "socket": {"ok": True}}),
            patch("cli.main.request_once", return_value=extension) as request,
            patch("cli.main._render") as render,
        ):
            self.assertEqual(cli_main(["--json", "status"]), 0)
        request.assert_called_once_with("health.status", {}, timeout=30.0, request_id=None)
        payload = render.call_args.args[0]
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["extension"], {"ok": True, **extension["result"]})

    def test_status_preserves_local_readiness_when_extension_is_unavailable(self) -> None:
        local = {"ok": True, "socket": {"ok": True}}
        with (
            patch("cli.main.local_health", return_value=local),
            patch("cli.main.request_once", side_effect=CLIError("native_disconnected", "native host disconnected before returning a response")),
            patch("cli.main._render") as render,
        ):
            self.assertEqual(cli_main(["--json", "status"]), 1)
        payload = render.call_args.args[0]
        self.assertEqual(payload["socket"], {"ok": True})
        self.assertEqual(payload["mode"], "local-native")
        self.assertEqual(payload["extension"]["error"], {"code": "native_disconnected", "message": "native host disconnected before returning a response"})

    def test_console_network_batch_and_capture_commands_match_extension_schema(self) -> None:
        self.assertEqual(_command_request("console", ["start"]), ("console.start", {}))
        self.assertEqual(_command_request("console", ["read", "--clear"]), ("console.read", {"clear": True}))
        self.assertEqual(_command_request("console", ["stop"]), ("console.stop", {}))
        self.assertEqual(_command_request("network", ["read", "25"]), ("network.read", {"limit": 25}))
        self.assertEqual(
            _command_request("batch", ['{"actions":[{"command":"snapshot"}],"stop_on_error":false}']),
            ("batch", {"actions": [{"command": "snapshot"}], "stop_on_error": False}),
        )
        self.assertEqual(
            _command_request("batch", ['{"actions":[{"command":"tabs.list"}],"stop_on_error":false,"max_parallel":4}']),
            ("batch", {"actions": [{"command": "tabs.list"}], "stop_on_error": False, "max_parallel": 4}),
        )
        self.assertEqual(_command_request("capture", ["start"]), ("capture.start", {}))
        for args in (["read", "--bad"], ["read", "--clear", "extra"], ["read", "0"]):
            with self.subTest(args=args):
                with self.assertRaises(CLIError):
                    _command_request("console" if args[0] == "read" else "network", args)

    def test_batch_rejects_unsafe_json_contract(self) -> None:
        for source in (
            "{}",
            '{"actions":[]}',
            '{"actions":[{"command":"upload"}]}',
            '{"actions":[{"command":"tabs.list"}],"max_parallel":0}',
            '{"actions":[{"command":"tabs.list"}],"max_parallel":true}',
            '{"actions":[{"command":"tabs.list"}],"max_parallel":9}',
            "[1]",
            "not-json",
        ):
            with self.subTest(source=source):
                with self.assertRaises(CLIError):
                    _command_request("batch", [source])

    def test_main_passes_caller_request_id_to_cancel_request(self) -> None:
        with patch("cli.main.request_once", return_value={"ok": True, "result": {"cancelled": True}}) as request:
            self.assertEqual(cli_main(["--json", "--request-id", "cancel-request", "cancel", "known-request"]), 0)
        request.assert_called_once_with(
            "cancel",
            {"request_id": "known-request"},
            timeout=30.0,
            request_id="cancel-request",
        )
    def test_request_once_emits_caller_request_id(self) -> None:
        class FakeSocket:
            def __init__(self) -> None:
                self.sent: list[bytes] = []

            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                del args

            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path

            def sendall(self, payload: bytes) -> None:
                self.sent.append(payload)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            socket_path = root / "browser.sock"
            token.write_text("secret\n", encoding="utf-8")
            os.chmod(token, 0o600)
            socket_path.touch()
            paths = RuntimePaths(root=root, socket=socket_path, token=token)
            connection = FakeSocket()
            with patch("cli.main.socket.socket", return_value=connection), patch(
                "cli.main.read_frame",
                return_value={"version": 1, "kind": "response", "request_id": "caller-request", "ok": True},
            ):
                response = request_once("snapshot", {}, timeout=1, paths=paths, request_id="caller-request")
            request = read_frame(io.BytesIO(connection.sent[0]), byteorder="big")
            self.assertEqual(response["request_id"], "caller-request")
            self.assertEqual(request["request_id"], "caller-request")
    def test_request_once_retries_a_transient_full_socket_backlog(self) -> None:
        class RefusingSocket:
            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path
                raise ConnectionRefusedError

            def close(self) -> None:
                pass

        class WorkingSocket:
            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                del args

            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path

            def sendall(self, payload: bytes) -> None:
                del payload

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            socket_path = root / "browser.sock"
            token.write_text("secret\n", encoding="utf-8")
            os.chmod(token, 0o600)
            socket_path.touch()
            paths = RuntimePaths(root=root, socket=socket_path, token=token)
            response = {"version": 1, "kind": "response", "request_id": "retry", "ok": True}
            with (
                patch("cli.main.socket.socket", side_effect=[RefusingSocket(), WorkingSocket()]) as socket_factory,
                patch("cli.main.time.sleep") as sleep,
                patch("cli.main.read_frame", return_value=response),
            ):
                self.assertEqual(
                    request_once("snapshot", {}, timeout=1, paths=paths, request_id="retry"),
                    response,
                )
        self.assertEqual(socket_factory.call_count, 2)
        sleep.assert_called_once()
    def test_request_once_converts_native_eof_to_structured_cli_error(self) -> None:
        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                del args

            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path

            def sendall(self, payload: bytes) -> None:
                del payload

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            socket_path = root / "browser.sock"
            token.write_text("secret\n", encoding="utf-8")
            os.chmod(token, 0o600)
            socket_path.touch()
            paths = RuntimePaths(root=root, socket=socket_path, token=token)
            with patch("cli.main.socket.socket", return_value=FakeSocket()), patch("cli.main.read_frame", side_effect=EOFError):
                with self.assertRaises(CLIError) as raised:
                    request_once("snapshot", {}, timeout=1, paths=paths)
        self.assertEqual(raised.exception.code, "native_disconnected")
    def test_request_once_rejects_malformed_response_envelope(self) -> None:
        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                del args

            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path

            def sendall(self, payload: bytes) -> None:
                del payload

        responses = (
            {"version": 2, "kind": "response", "request_id": "r", "ok": True},
            {"version": 1, "kind": "event", "request_id": "r", "ok": True},
            {"version": 1, "kind": "response", "request_id": "r", "ok": "yes"},
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            socket_path = root / "browser.sock"
            token.write_text("secret\n", encoding="utf-8")
            os.chmod(token, 0o600)
            socket_path.touch()
            paths = RuntimePaths(root=root, socket=socket_path, token=token)
            for response in responses:
                with self.subTest(response=response):
                    with patch("cli.main.socket.socket", return_value=FakeSocket()), patch("cli.main.read_frame", return_value=response):
                        with self.assertRaises(CLIError) as raised:
                            request_once("snapshot", {}, timeout=1, paths=paths, request_id="r")
                    self.assertEqual(raised.exception.code, "protocol_error")

    def test_request_once_translates_protocol_and_os_errors(self) -> None:
        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                del args

            def settimeout(self, value: float) -> None:
                del value

            def connect(self, path: str) -> None:
                del path

            def sendall(self, payload: bytes) -> None:
                del payload

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "token"
            socket_path = root / "browser.sock"
            token.write_text("secret\n", encoding="utf-8")
            os.chmod(token, 0o600)
            socket_path.touch()
            paths = RuntimePaths(root=root, socket=socket_path, token=token)
            with patch("cli.main.socket.socket", return_value=FakeSocket()), patch("cli.main.read_frame", side_effect=ProtocolError("bad")):
                with self.assertRaises(CLIError) as raised:
                    request_once("snapshot", {}, timeout=1, paths=paths)
            self.assertEqual(raised.exception.code, "protocol_error")
            with patch("cli.main.socket.socket", return_value=FakeSocket()), patch("cli.main.read_frame", side_effect=OSError("bad")):
                with self.assertRaises(CLIError) as raised:
                    request_once("snapshot", {}, timeout=1, paths=paths)
            self.assertEqual(raised.exception.code, "native_io_error")

    def test_multi_file_upload_is_atomic_and_uses_ordered_file_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.txt"
            second = Path(directory) / "second.bin"
            first.write_bytes(b"a" * 3)
            second.write_bytes(b"b" * 2)
            chunks = list(iter_upload_file_chunks([first, second], "@files"))
        self.assertEqual({chunk["file_total"] for chunk in chunks}, {2})
        self.assertEqual([chunk["file_index"] for chunk in chunks], [0, 1])
        self.assertEqual([chunk["filename"] for chunk in chunks], ["first.txt", "second.bin"])
        self.assertEqual(len({chunk["upload_id"] for chunk in chunks}), 1)

    def test_multi_file_upload_rejects_more_than_sixteen_files_before_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / f"{index}.txt" for index in range(17)]
            for path in paths:
                path.write_bytes(b"x")
            with self.assertRaises(CLIError) as raised:
                list(iter_upload_file_chunks(paths, "@files"))
        self.assertEqual(raised.exception.code, "invalid_upload")
    def test_cli_rejects_invalid_timeout_and_extra_arguments(self) -> None:
        for value in ("nan", "inf", "0", "-1"):
            with self.subTest(timeout=value), patch("cli.main.request_once") as request:
                self.assertEqual(cli_main(["--timeout", value, "snapshot"]), 2)
                request.assert_not_called()
        for command, args in (("open", ["https://example.test", "extra"]), ("snapshot", ["extra"]), ("click", ["@e1", "extra"])):
            with self.subTest(command=command):
                with self.assertRaises(CLIError):
                    _command_request(command, args)

    def test_upload_chunks_match_extension_schema_without_local_path(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".txt") as handle:
            source_path = handle.name
            handle.write(b"x" * 700_000)
            handle.flush()
            chunks = list(iter_upload_chunks(Path(handle.name), "@e2"))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(set(chunk) == {"upload_id", "index", "total", "chunk", "ref", "filename", "mime_type"} for chunk in chunks))
        self.assertTrue(all(chunk["ref"] == "@e2" and "path" not in chunk and source_path not in json.dumps(chunk) for chunk in chunks))
        self.assertEqual(chunks[-1]["total"], len(chunks))

    def test_upload_accepts_spaces_unicode_and_parentheses_in_basename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "Résumé (final) notes.txt"
            source.write_bytes(b"hello")
            chunks = list(iter_upload_chunks(source, "@common"))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["filename"], "Résumé (final) notes.txt")

    def test_upload_rejects_control_or_separator_filename_before_sending(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for filename in ("unsafe\\name.txt", "unsafe\nname.txt"):
                source = Path(directory) / filename
                source.write_bytes(b"hello")
                with self.subTest(filename=filename):
                    with self.assertRaises(CLIError) as raised:
                        list(iter_upload_chunks(source, "@unsafe"))
                    self.assertEqual(raised.exception.code, "invalid_upload")

    def test_zero_byte_upload_sends_one_empty_final_chunk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "empty.txt"
            source.write_bytes(b"")
            with patch("cli.main.request_once", return_value={"ok": True}) as request, patch("cli.main._render"):
                self.assertEqual(cli_main(["upload", "@empty", str(source)]), 0)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[1]["index"], 0)
        self.assertEqual(request.call_args.args[1]["total"], 1)
        self.assertEqual(request.call_args.args[1]["chunk"], "")

    def test_screenshot_result_is_decoded_to_a_private_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "capture.jpg"
            jpeg = b"\xff\xd8\xff\x00"
            payload = _materialize_screenshot(
                {"version": 1, "kind": "response", "ok": True, "result": {"format": "jpeg", "data": base64.b64encode(jpeg).decode(), "bytes": len(jpeg)}},
                output,
            )
            self.assertEqual(output.read_bytes(), jpeg)
            self.assertEqual(payload["result"]["path"], str(output))

    def test_screenshot_default_output_keeps_image_in_response(self) -> None:
        payload = _materialize_screenshot(
            {"version": 1, "kind": "response", "ok": True, "result": {"format": "jpeg", "data": base64.b64encode(b"hello").decode(), "bytes": 5}},
            None,
        )
        self.assertEqual(payload["result"]["data_available"], True)
        self.assertNotIn("path", payload["result"])

    def test_screenshot_accepts_png_and_jpeg_suffixes_only_when_bytes_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            png = b"\x89PNG\r\n\x1a\npayload"
            jpeg = b"\xff\xd8\xff\x00"
            for suffix, format_name, data in ((".png", "png", png), (".jpeg", "jpeg", jpeg)):
                with self.subTest(suffix=suffix):
                    output = Path(directory) / f"capture{suffix}"
                    _materialize_screenshot(
                        {"ok": True, "result": {"format": format_name, "data": base64.b64encode(data).decode()}},

                        output,
                    )
                    self.assertEqual(output.read_bytes(), data)

    def test_screenshot_passes_requested_format_to_extension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "capture.png"
            png = b"\x89PNG\r\n\x1a\npayload"
            response = {"ok": True, "result": {"format": "png", "data": base64.b64encode(png).decode(), "bytes": len(png)}}
            with patch("cli.main.request_once", return_value=response) as request, patch("cli.main._render"):
                self.assertEqual(cli_main(["screenshot", str(output)]), 0)
        self.assertEqual(request.call_args.args[1], {"format": "png"})
    def test_screenshot_rejects_unsupported_or_impossible_output_formats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jpeg = b"\xff\xd8\xff\x00"
            payload = {"ok": True, "result": {"format": "jpeg", "data": base64.b64encode(jpeg).decode()}}
            for suffix in (".gif", ""):
                with self.subTest(suffix=suffix):
                    with self.assertRaisesRegex(CLIError, "unsupported screenshot output suffix"):
                        _materialize_screenshot(payload, Path(directory) / f"capture{suffix}")
            with self.assertRaisesRegex(CLIError, "cannot be written"):
                _materialize_screenshot(payload, Path(directory) / "capture.png")


class InstallerContractTests(unittest.TestCase):
    def test_installer_installs_cli_and_preserves_unrelated_launcher(self) -> None:
        script = (Path(__file__).resolve().parents[1] / "scripts" / "manage-macos.sh").read_text(encoding="utf-8")
        self.assertIn('install -m 600 "$ROOT/cli/main.py" "$CLI_MAIN"', script)
        self.assertIn("# OverSeer Browser managed launcher", script)
        self.assertIn('Preserved unrelated CLI launcher', script)
        self.assertIn('rm -rf "$HOST_DIR" "$CLI_DIR"', script)
        self.assertIn('"$ROOT/scripts/generate_manifest.py" "$TESTING_MANIFEST" "$HOST_PATH"', script)

    def test_installed_cli_has_private_native_host_import_fallback(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "cli" / "main.py").read_text(encoding="utf-8")
        self.assertIn("parents[1]", source)
        self.assertIn("from native_host.protocol", source)

    def test_installed_manager_keeps_status_and_uninstall_source_independent(self) -> None:
        script = (Path(__file__).resolve().parents[1] / "scripts" / "manage-macos.sh").read_text(encoding="utf-8")
        self.assertIn('source_root_file="$app_support/source-root"', script)
        self.assertIn('status) status ;;', script)
        self.assertIn('uninstall) uninstall ;;', script)
        self.assertIn('install|update)', script)
        self.assertIn('source checkout is unavailable; reinstall from the public repository', script)


if __name__ == "__main__":
    unittest.main()
