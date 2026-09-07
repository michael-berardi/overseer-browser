"""Hermetic relay-selection regressions: no Chrome or live session changes."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from cli.main import CLIError, local_health, request_once
from cli.runtime_discovery import ActiveRuntimeError, find_active_runtime
from native_host.runtime import RuntimePaths


class RuntimeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.root = self.home / "relay"
        self.root.mkdir(mode=0o700)
        self.paths = RuntimePaths(self.root, self.root / "overseer-browser.sock", self.root / "token")
        self.paths.token.write_text("test-token\n")
        self.paths.token.chmod(0o600)
        self.sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.sock.close)
        self.sock.bind(str(self.paths.socket))
        self.paths.socket.chmod(0o600)
        self.directory = self.home / ".config" / "overseer-browser"
        self.directory.mkdir(mode=0o700, parents=True)
        self.descriptor = self.directory / "active-connection.json"
        self.payload = {"version": 1, "mode": "operator-relay", "runtime_root": str(self.root), "token_sha256": hashlib.sha256(b"test-token").hexdigest()}
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.home_patch = patch("pathlib.Path.home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)

    def publish(self):
        self.descriptor.write_text(json.dumps(self.payload))
        self.descriptor.chmod(0o600)

    def test_no_descriptor_preserves_managed_default(self):
        self.assertIsNone(find_active_runtime())

    def test_connection_selected_before_any_session_exists(self):
        self.publish()
        self.assertEqual(find_active_runtime().paths, self.paths)
        self.assertEqual(find_active_runtime(session_key="new-independent-agent").paths, self.paths)

    def test_explicit_runtime_override_wins_even_if_descriptor_invalid(self):
        self.publish()
        self.descriptor.write_text("invalid")
        with patch.dict(os.environ, {"OVERSEER_BROWSER_RUNTIME": "/explicit"}):
            self.assertIsNone(find_active_runtime())

    def test_explicit_managed_mode_ignores_selected_relay(self):
        self.publish()
        with patch.dict(os.environ, {"OVERSEER_BROWSER_CONNECTION": "managed"}):
            self.assertIsNone(find_active_runtime())

    def test_explicit_missing_descriptor_fails_closed(self):
        with patch.dict(os.environ, {"OVERSEER_BROWSER_CONNECTION": str(self.descriptor)}):
            with self.assertRaises(ActiveRuntimeError):
                find_active_runtime()

    def test_invalid_schema_and_json_fail_closed(self):
        for content in ["{", "[]", '{"version":true}', json.dumps({**self.payload, "mode": "guess"})]:
            self.descriptor.write_text(content)
            self.descriptor.chmod(0o600)
            with self.subTest(content=content), self.assertRaises(ActiveRuntimeError):
                find_active_runtime()

    def test_descriptor_permissions_and_symlink_rejected(self):
        self.publish()
        self.descriptor.chmod(0o644)
        with self.assertRaises(ActiveRuntimeError):
            find_active_runtime()
        self.descriptor.unlink()
        self.descriptor.symlink_to(self.paths.token)
        with self.assertRaises(ActiveRuntimeError):
            find_active_runtime()

    def test_descriptor_directory_must_be_private(self):
        self.publish()
        self.directory.chmod(0o755)
        with self.assertRaises(ActiveRuntimeError):
            find_active_runtime()

    def test_socket_and_token_must_be_private(self):
        self.publish()
        for path in [self.paths.token, self.paths.socket]:
            path.chmod(0o644)
            with self.subTest(path=path), self.assertRaises(ActiveRuntimeError):
                find_active_runtime()
            path.chmod(0o600)

    def test_replaced_token_requires_reselection(self):
        self.publish()
        self.paths.token.write_text("different-token")
        with self.assertRaisesRegex(ActiveRuntimeError, "identity changed"):
            find_active_runtime()

    def test_regular_file_cannot_impersonate_socket(self):
        self.publish()
        self.paths.socket.unlink()
        self.paths.socket.write_text("")
        self.paths.socket.chmod(0o600)
        with self.assertRaises(ActiveRuntimeError):
            find_active_runtime()

    def test_oversized_descriptor_is_bounded(self):
        self.publish()
        self.descriptor.write_text(" " * 8193)
        with self.assertRaises(ActiveRuntimeError):
            find_active_runtime()

    def test_relay_start_and_last_stop_never_manage_host_lifecycle(self):
        self.publish()
        for command in ["sessions.start", "sessions.stop", "tabs.list"]:
            with self.subTest(command=command), patch("cli.main._request_once", return_value={"ok": True}) as request, patch("native_host.isolation.ensure_instance") as start, patch("native_host.isolation.stop_instance") as stop, patch("native_host.isolation.lifecycle_lock") as lock:
                self.assertTrue(request_once(command, {}, timeout=1, session_key="owned-session")["ok"])
                self.assertEqual(request.call_args.kwargs["paths"], self.paths)
                self.assertEqual(request.call_args.kwargs["session_key"], "owned-session")
                request.assert_called_once()
                start.assert_not_called()
                stop.assert_not_called()
                lock.assert_not_called()

    def test_status_and_commands_use_same_connection(self):
        self.publish()
        with patch("cli.main._manifest_exists", return_value=True):
            health = local_health()
        self.assertEqual(health["runtime_directory"]["path"], str(self.root))
        self.assertEqual(health["connection_mode"], "operator-relay")
        self.assertTrue(health["token"]["ok"])
        self.assertTrue(health["socket"]["ok"])

    def test_selection_helper_authenticates_before_atomic_publication(self):
        spec = importlib.util.spec_from_file_location("select_relay", Path(__file__).resolve().parents[1] / "scripts" / "select-relay.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        for connected in [False, True]:
            with patch("sys.argv", ["select-relay", str(self.root)]), patch.object(helper, "_request_once", return_value={"ok": True, "result": {"connected": connected, "multi_session": True}}) as health, patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(helper.main(), 0 if connected else 1)
                health.assert_called_once_with("health.status", {}, timeout=10, paths=self.paths, auth_token="test-token")
                self.assertEqual(self.descriptor.exists(), connected)
        self.assertEqual(find_active_runtime().paths, self.paths)
        self.assertNotIn("test-token", self.descriptor.read_text())

    def test_rotation_after_validation_does_not_change_transport_token(self):
        self.publish()
        def select_then_rotate(**kwargs):
            selected = find_active_runtime(**kwargs)
            self.paths.token.write_text("replacement-token")
            return selected
        response = {"version": 1, "kind": "response", "request_id": "rotation-test", "ok": True, "result": {}}
        with patch("cli.main.find_active_runtime", side_effect=select_then_rotate), patch("cli.main.socket.socket"), patch("cli.main.encode_frame", return_value=b"frame") as encode, patch("cli.main.read_frame", return_value=response):
            self.assertTrue(request_once("health.status", {}, timeout=1, request_id="rotation-test")["ok"])
            self.assertEqual(encode.call_args.args[0]["token"], "test-token")
            self.assertEqual(self.paths.token.read_text(), "replacement-token")

    def test_wrong_owner_is_rejected(self):
        self.publish()
        with patch("os.getuid", return_value=os.getuid() + 1):
            with self.assertRaises(ActiveRuntimeError):
                find_active_runtime()

    def test_invalid_selection_is_structured_error_not_fallback(self):
        self.publish()
        self.paths.socket.unlink()
        with patch("native_host.isolation.ensure_instance") as start:
            for operation in [lambda: local_health(), lambda: request_once("sessions.start", {}, timeout=1)]:
                with self.assertRaises(CLIError) as raised:
                    operation()
                self.assertEqual(raised.exception.code, "active_connection_unavailable")
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
