"""The mismatched-extension gate must explain itself and never leave a browser behind.

Every case here is hermetic: the socket is a fake, the isolated lifecycle helpers
are patched, and no browser, port, relay or operator runtime is touched.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cli.main import CLI_VERSION, CLIError, _error_envelope, request_once
from cli.runtime_discovery import SelectedRelay
from native_host.isolation import isolated_paths
from native_host.protocol import read_frame
from native_host.runtime import RuntimePaths


class FakeSocket:
    """One same-connection fake: the capability probe and the command share it."""

    def __init__(self):
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def settimeout(self, value):
        pass

    def connect(self, value):
        pass

    def close(self):
        pass

    def sendall(self, value):
        self.sent.append(read_frame(io.BytesIO(value)))


def _reply(connection, result=None, *, ok=True, error=None):
    sent = connection.sent[-1]
    envelope = {"version": 1, "kind": "response", "request_id": sent["request_id"], "ok": ok}
    if ok:
        envelope["result"] = result
    else:
        envelope["error"] = error
    return envelope


class StartupGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.base = RuntimePaths(root, root / "overseer-browser.sock", root / "token")
        self.managed = isolated_paths(self.base)
        for paths in (self.base, self.managed):
            self._write_token(paths)

    @staticmethod
    def _write_token(paths: RuntimePaths) -> None:
        paths.root.mkdir(parents=True, exist_ok=True)
        paths.token.write_text("test-only-token")
        paths.token.chmod(0o600)

    def _relay(self):
        return SelectedRelay(self.base, "test-only-token")

    def test_unadvertised_capability_names_the_observed_extension_and_the_fix(self):
        connection = FakeSocket()

        def response(*args, **kwargs):
            self.assertEqual(connection.sent[-1]["params"], {"capabilities_only": True})
            return _reply(connection, {"multi_session": False, "extension_version": "0.9.3"})

        with patch("cli.main.find_active_runtime", return_value=self._relay()), \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("navigate", {"url": "https://synthetic.test/"}, timeout=1, session_key="agent-a")
        error = raised.exception
        self.assertEqual(error.code, "extension_upgrade_required")
        self.assertEqual(error.details["reason"], "capability_not_advertised")
        self.assertEqual(error.details["observed_extension_version"], "0.9.3")
        self.assertEqual(error.details["required_version"], CLI_VERSION)
        self.assertEqual(error.details["connection_mode"], "operator-relay")
        for expected in ("0.9.3", CLI_VERSION, "operator-relay", "refresh-extension",
                         "OVERSEER_BROWSER_CONNECTION=managed"):
            self.assertIn(expected, error.message)
        # The refusal is unchanged: the scoped command was never forwarded.
        self.assertEqual([item["command"] for item in connection.sent], ["health.status"])

    def test_probe_echoing_another_sessions_key_is_named(self):
        connection = FakeSocket()

        def response(*args, **kwargs):
            return _reply(connection, {"multi_session": True, "session_key": "agent-b",
                                       "extension_version": "0.9.4"})

        with patch("cli.main.find_active_runtime", return_value=self._relay()), \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("snapshot", {}, timeout=1, session_key="agent-a")
        self.assertEqual(raised.exception.details["reason"], "session_key_not_echoed")
        self.assertEqual(raised.exception.details["observed_extension_version"], "0.9.4")
        self.assertEqual([item["command"] for item in connection.sent], ["health.status"])

    def test_probe_error_reports_its_own_code_and_unknown_version(self):
        connection = FakeSocket()

        def response(*args, **kwargs):
            return _reply(connection, ok=False, error={"code": "unsupported_command",
                                                      "message": "health.status is not supported"})

        with patch("cli.main.find_active_runtime", return_value=self._relay()), \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("snapshot", {}, timeout=1, session_key="agent-a")
        details = raised.exception.details
        self.assertEqual(details["reason"], "probe_error")
        self.assertEqual(details["probe_error_code"], "unsupported_command")
        self.assertIsNone(details["observed_extension_version"])
        self.assertIn("unknown", raised.exception.message)

    def test_probe_with_no_usable_result_is_named(self):
        connection = FakeSocket()

        def response(*args, **kwargs):
            return _reply(connection, None)

        with patch("cli.main.find_active_runtime", return_value=self._relay()), \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("snapshot", {}, timeout=1, session_key="agent-a")
        self.assertEqual(raised.exception.details["reason"], "probe_unusable")

    def test_managed_start_that_fails_the_probe_stops_the_instance_it_started(self):
        connection = FakeSocket()

        def response(*args, **kwargs):
            return _reply(connection, {"multi_session": False, "extension_version": "0.9.3"})

        with patch("cli.main.RuntimePaths.discover", return_value=self.base), \
                patch("cli.main.find_active_runtime", return_value=None), \
                patch("native_host.isolation.read_state", return_value={}), \
                patch("native_host.isolation.supervisor_alive", return_value=False), \
                patch("native_host.isolation.connected", return_value=False), \
                patch("native_host.isolation.ensure_instance") as ensure, \
                patch("native_host.isolation.stop_instance") as stop, \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("sessions.start", {}, timeout=1, session_key="agent-a")
        ensure.assert_called_once()
        stop.assert_called_once_with(self.managed)
        error = raised.exception
        self.assertEqual(error.code, "extension_upgrade_required")
        self.assertIs(error.details["instance_was_running"], False)
        self.assertIs(error.details["instance_stopped"], True)
        self.assertEqual(error.details["reason"], "capability_not_advertised")
        self.assertEqual(error.details["observed_extension_version"], "0.9.3")
        self.assertEqual(error.details["connection_mode"], "managed-isolated")
        self.assertIn("was stopped", error.message)

    def test_failure_never_stops_an_instance_that_was_already_running(self):
        connection = FakeSocket()
        (self.managed.root / "supervisor.running").write_text(json.dumps({"pid": 4321}))

        def response(*args, **kwargs):
            return _reply(connection, {"multi_session": False, "extension_version": "0.9.3"})

        with patch("cli.main.RuntimePaths.discover", return_value=self.base), \
                patch("cli.main.find_active_runtime", return_value=None), \
                patch("native_host.isolation.read_state", return_value={"version": 1, "started_at": 1.0}), \
                patch("native_host.isolation.supervisor_alive", return_value=True), \
                patch("native_host.isolation.connected", return_value=True), \
                patch("native_host.isolation.ensure_instance") as ensure, \
                patch("native_host.isolation.stop_instance") as stop, \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("sessions.start", {}, timeout=1, session_key="agent-a")
        ensure.assert_called_once()
        stop.assert_not_called()
        error = raised.exception
        self.assertEqual(error.code, "extension_upgrade_required")
        self.assertIs(error.details["instance_was_running"], True)
        self.assertNotIn("instance_stopped", error.details)
        self.assertNotIn("was stopped", error.message)

    def test_stale_launch_record_without_a_live_supervisor_is_cleaned_up(self):
        """A supervisor killed with its terminal leaves an unterminated record, not a browser."""
        connection = FakeSocket()

        def response(*args, **kwargs):
            return _reply(connection, {"multi_session": False, "extension_version": "0.9.3"})

        with patch("cli.main.RuntimePaths.discover", return_value=self.base), \
                patch("cli.main.find_active_runtime", return_value=None), \
                patch("native_host.isolation.read_state", return_value={"version": 1, "started_at": 1.0}), \
                patch("native_host.isolation.supervisor_alive", return_value=False), \
                patch("native_host.isolation.connected", return_value=False), \
                patch("native_host.isolation.ensure_instance") as ensure, \
                patch("native_host.isolation.stop_instance") as stop, \
                patch("cli.main.socket.socket", return_value=connection), \
                patch("cli.main.read_frame", side_effect=response):
            with self.assertRaises(CLIError) as raised:
                request_once("sessions.start", {}, timeout=1, session_key="agent-a")
        ensure.assert_called_once()
        stop.assert_called_once_with(self.managed)
        self.assertIs(raised.exception.details["instance_was_running"], False)
        self.assertIs(raised.exception.details["instance_stopped"], True)

    def test_ordinary_errors_keep_the_unchanged_envelope(self):
        self.assertEqual(_error_envelope(CLIError("usage", "denied")),
                         {"ok": False, "error": {"code": "usage", "message": "denied"}})
        self.assertEqual(
            _error_envelope(CLIError("extension_upgrade_required", "refused", {"reason": "probe_unusable"})),
            {"ok": False, "error": {"code": "extension_upgrade_required", "message": "refused",
                                    "details": {"reason": "probe_unusable"}}},
        )


if __name__ == "__main__":
    unittest.main()
