from __future__ import annotations

import io
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cli.main import CLIError, main, request_once, resolve_session_key
from native_host.host import Client, NativeHost
from native_host.protocol import ProtocolError, read_frame, validate_request
from native_host.runtime import RuntimePaths


class SessionRoutingTests(unittest.TestCase):
    def test_identity_is_stable_opaque_and_explicit_selection_wins(self):
        env = {"PI_SESSION_ID": "private-session-identity"}
        first = resolve_session_key(environ=env)
        self.assertEqual(first, resolve_session_key(environ=env))
        self.assertNotIn("private", first)
        self.assertNotEqual(first, resolve_session_key(environ={"PI_SESSION_ID": "another"}))
        self.assertEqual(resolve_session_key("explicit", {**env, "OVERSEER_BROWSER_SESSION": "env"}), "explicit")
        self.assertEqual(resolve_session_key(environ={**env, "OVERSEER_BROWSER_SESSION": "env"}), "env")
        self.assertIsNone(resolve_session_key(environ={}))
        self.assertIsNone(resolve_session_key(environ={"ULTRATERM_SLOT": "1"}))
        self.assertNotEqual(resolve_session_key(environ={"ULTRATERM_SLOT": "1", "ULTRATERM_TMUX_SESSION": "one"}), resolve_session_key(environ={"ULTRATERM_SLOT": "2", "ULTRATERM_TMUX_SESSION": "one"}))
        self.assertEqual(env, {"PI_SESSION_ID": "private-session-identity"})

    def test_invalid_keys_fail_before_any_io(self):
        for key in ("", "../escape", "a b", "a\n", "x" * 129):
            with self.subTest(key=key), self.assertRaises(CLIError):
                request_once("snapshot", {}, timeout=1, session_key=key)

    def test_native_validation_retains_scope_and_strips_token(self):
        base = {"version": 1, "kind": "request", "request_id": "test", "command": "snapshot", "params": {}, "token": "test-only-token"}
        clean = validate_request({**base, "session_key": "agent-a"}, "test-only-token")
        self.assertEqual(clean["session_key"], "agent-a")
        self.assertNotIn("token", clean)
        self.assertNotIn("session_key", validate_request(base))
        for value in (None, 4, "", "bad/key", "x" * 129):
            with self.subTest(value=value), self.assertRaises(ProtocolError):
                validate_request({**base, "session_key": value})

    def test_cli_scopes_every_command_without_mutating_environment(self):
        commands = [
            ["sessions", "start"], ["tabs", "list"], ["snapshot"],
            ["evaluate", "document.title"], ["cancel", "request-a"],
            ["batch", '[{"command":"tabs.list"}]'], ["screenshot"],
        ]
        with patch.dict(os.environ, {"PI_SESSION_ID": "test-agent"}, clear=True):
            before = dict(os.environ)
            for command in commands:
                with self.subTest(command=command), patch("cli.main.request_once", return_value={"ok": True}) as send, patch("cli.main._render"):
                    main([*command, "--session", "explicit-scope"])
                    self.assertEqual(send.call_args.kwargs["session_key"], "explicit-scope")
            with patch("cli.main.local_health", return_value={"ok": True}), patch("cli.main.request_once", return_value={"ok": True, "result": {}}) as send, patch("cli.main._render"):
                main(["status"])
                self.assertEqual(send.call_args.kwargs["session_key"], resolve_session_key(environ=before))
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / "synthetic.txt"
                file.write_bytes(b"a" * 300_000)
                with patch("cli.main.request_once", return_value={"ok": True}) as send, patch("cli.main._render"):
                    self.assertEqual(main(["upload", "osr-1", str(file), "--session", "upload-scope"]), 0)
                    self.assertGreater(send.call_count, 1)
                    self.assertTrue(all(call.kwargs["session_key"] == "upload-scope" for call in send.call_args_list))
            self.assertEqual(dict(os.environ), before)

    def test_old_transport_cannot_silently_downgrade_a_scoped_mutation(self):
        class FakeSocket:
            def __init__(self): self.sent = []
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def connect(self, value): pass
            def sendall(self, value): self.sent.append(read_frame(io.BytesIO(value)))

        for advertised_key in (None, "wrong", "agent-a"):
            with self.subTest(advertised_key=advertised_key), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                paths = RuntimePaths(root=root, socket=root / "browser.sock", token=root / "token")
                paths.token.write_text("test-only-token")
                paths.token.chmod(0o600)
                paths.socket.touch()
                connection = FakeSocket()
                def response(*args, **kwargs):
                    sent = connection.sent[-1]
                    result = {"multi_session": True, "session_key": advertised_key} if sent["command"] == "health.status" else {"scoped": True}
                    return {"version": 1, "kind": "response", "request_id": sent["request_id"], "ok": True, "result": result}
                with patch("cli.main.socket.socket", return_value=connection), patch("cli.main.read_frame", side_effect=response):
                    if advertised_key == "agent-a":
                        self.assertTrue(request_once("navigate", {"url": "https://synthetic.test/"}, timeout=1, paths=paths, session_key="agent-a")["ok"])
                        self.assertEqual([item["command"] for item in connection.sent], ["health.status", "navigate"])
                    else:
                        with self.assertRaises(CLIError) as raised:
                            request_once("navigate", {"url": "https://synthetic.test/"}, timeout=1, paths=paths, session_key="agent-a")
                        self.assertEqual(raised.exception.code, "extension_upgrade_required")
                        self.assertEqual([item["command"] for item in connection.sent], ["health.status"])

    def test_host_guards_old_extension_and_preserves_scope_on_disconnect_cancellation(self):
        output = io.BytesIO()
        host = NativeHost(native_in=io.BytesIO(), native_out=output, request_timeout=5)
        host.token = "test-only-token"
        left, right = socket.socketpair()
        right.settimeout(1)
        client = Client(left)
        request = {"version": 1, "kind": "request", "request_id": "old", "command": "snapshot", "params": {}, "token": host.token, "session_key": "agent-a"}
        try:
            host._route_request(client, request)
            self.assertEqual(read_frame(right)["error"]["code"], "extension_upgrade_required")
            self.assertEqual(output.getvalue(), b"")
            host._multi_session = True
            host._route_request(client, {**request, "request_id": "new"})
            host._drop_client_pending(client)
            frames = io.BytesIO(output.getvalue())
            forwarded = read_frame(frames, byteorder="little")
            cancelled = read_frame(frames, byteorder="little")
            self.assertEqual(forwarded["session_key"], "agent-a")
            self.assertEqual(cancelled["command"], "cancel")
            self.assertEqual(cancelled["session_key"], "agent-a")
            self.assertEqual(cancelled["params"]["request_id"], "new")
        finally:
            host._drop_client_pending(client)
            left.close()
            right.close()


if __name__ == "__main__":
    unittest.main()
