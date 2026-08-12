from __future__ import annotations

import io
import json
import os
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from cli.main import CLIError, _command_request, _materialize_screenshot, iter_upload_chunks, local_health, main as cli_main, request_once
from native_host.host import Client, NativeHost, main as native_main, validate_caller_origin
from native_host.protocol import ProtocolError, encode_frame, read_frame, validate_request
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
        validate_caller_origin(None)
        with self.assertRaises(ValueError):
            validate_caller_origin("chrome-extension://other/")

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
                for pending in list(host._pending.values()):
                    pending.timer.cancel()

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
                    connection.sendall(encode_frame({"version": 1, "requestId": "d1", "ok": True}, byteorder="big"))

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
    def test_legacy_and_expanded_commands_match_extension_schema(self) -> None:
        self.assertEqual(_command_request("open", ["https://example.test"]), ("navigate", {"url": "https://example.test"}))
        self.assertEqual(_command_request("tabs", ["select", "42"]), ("tabs.select", {"tab_id": 42}))
        self.assertEqual(_command_request("evaluate", ["1 + 1"]), ("evaluate", {"source": "1 + 1"}))
        self.assertEqual(_command_request("fill", ["@e1", "hello"]), ("fill", {"ref": "@e1", "value": "hello"}))
        self.assertEqual(_command_request("type", ["@e1", "hello"]), ("type", {"ref": "@e1", "text": "hello"}))
        self.assertEqual(_command_request("press", ["Enter"]), ("press", {"key": "Enter"}))
        self.assertEqual(_command_request("cancel", ["known-request"]), ("cancel", {"request_id": "known-request"}))

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
                return_value={"request_id": "caller-request", "ok": True},
            ):
                response = request_once("snapshot", {}, timeout=1, paths=paths, request_id="caller-request")
            request = read_frame(io.BytesIO(connection.sent[0]), byteorder="big")
            self.assertEqual(response["request_id"], "caller-request")
            self.assertEqual(request["request_id"], "caller-request")
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
            payload = _materialize_screenshot(
                {"version": 1, "kind": "response", "ok": True, "result": {"format": "jpeg", "data": "aGVsbG8=", "bytes": 5}},
                output,
            )
            self.assertEqual(output.read_bytes(), b"hello")
            self.assertEqual(payload["result"]["path"], str(output))


class InstallerContractTests(unittest.TestCase):
    def test_installer_installs_cli_and_preserves_unrelated_launcher(self) -> None:
        script = (Path(__file__).resolve().parents[1] / "scripts" / "manage-macos.sh").read_text(encoding="utf-8")
        self.assertIn('install -m 600 "$ROOT/cli/main.py" "$CLI_MAIN"', script)
        self.assertIn("# OverSeer Browser managed launcher", script)
        self.assertIn('Preserved unrelated CLI launcher', script)
        self.assertIn('rm -rf "$HOST_DIR" "$CLI_DIR"', script)

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
