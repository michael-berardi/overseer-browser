"""Help and invalid flags must never reach the browser or local mutators."""
from __future__ import annotations

import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch

from cli.main import CLI_COMMANDS, CLI_USAGE, CLIError, _command_request, main


# Enumerate independently of the implementation's help table so omissions fail.
SUBCOMMANDS = {
    "sessions": ("start", "stop", "list"),
    "windows": ("resize",),
    "tabs": ("list", "create", "select", "close", "borrow", "return"),
    "console": ("start", "read", "stop"),
    "network": ("read",),
    "capture": ("start", "stop"),
    "record": ("start", "restart", "status", "stop", "clear"),
    "qa": ("pack",),
    "dom": ("find", "get", "is"),
    "dom get": ("text", "html", "value", "attribute", "count", "box", "computedstyles"),
    "dom is": ("visible", "enabled", "checked", "editable", "attached"),
    "takeover": ("prompt", "resume"),
}
COMMAND_PATHS = [command for command in CLI_COMMANDS] + [
    f"{command} {action}" for command, actions in SUBCOMMANDS.items() for action in actions
]


class CLIHelpTests(unittest.TestCase):
    def invoke_read_only(self, argv, expected_status=0):
        stdout = io.StringIO()
        with contextlib.ExitStack() as stack:
            # Even invalid automatic identity must not stop local help.
            stack.enter_context(patch.dict(os.environ, {"OVERSEER_BROWSER_SESSION": "bad/key"}, clear=True))
            stack.enter_context(contextlib.redirect_stdout(stdout))
            mocks = [stack.enter_context(patch(target, side_effect=AssertionError("help must be read-only")))
                     for target in ("cli.main.request_once", "cli.main._request_once",
                                    "cli.main.socket.socket", "cli.main.find_active_runtime",
                                    "cli.main.local_health", "cli.main._run_script",
                                    "cli.main.temp_outputs.reservation",
                                    "cli.main.temp_outputs.default_screenshot")]
            self.assertEqual(main(argv), expected_status)
            for mock in mocks:
                mock.assert_not_called()
        return json.loads(stdout.getvalue())

    def test_usage_index_covers_public_commands_and_subcommands(self):
        self.assertEqual(set(COMMAND_PATHS), set(CLI_USAGE))

    def test_every_command_and_subcommand_help_has_zero_native_requests(self):
        for path in COMMAND_PATHS:
            for flag in ("--help", "-h"):
                with self.subTest(path=path, flag=flag):
                    result = self.invoke_read_only([*path.split(), flag])
                    self.assertTrue(result["ok"])
                    self.assertIn("usage", result["result"])
                    self.assertTrue(result["result"]["usage"].startswith("overseer-browser " + path))

    def test_help_command_and_namespace_help_are_read_only(self):
        for argv in ([], ["help"], ["--help"], ["-h"], ["--version", "--help"],
                     ["help", "sessions", "start"], ["sessions", "help"], ["dom", "help"]):
            with self.subTest(argv=argv):
                self.assertTrue(self.invoke_read_only(argv)["ok"])

    def test_help_wins_over_malformed_options_and_missing_operands(self):
        for argv in (["sessions", "start", "--width", "--help"],
                     ["sessions", "start", "--session", "bad/key", "--help"],
                     ["tabs", "create", "--unknown", "--help"],
                     ["--help", "--timeout", "bad", "navigate"],
                     ["record", "stop", "--help", "--request-id"],
                     ["qa", "pack", "--session", "--help"],
                     ["navigate", "--help", "--raw-json"],
                     ["dom", "get", "text", "--help", "--json"]):
            with self.subTest(argv=argv):
                self.assertTrue(self.invoke_read_only(argv)["ok"])

    def test_sessions_start_help_creates_no_session(self):
        sessions = []
        def transport(command, params, **kwargs):
            if command == "sessions.start":
                sessions.append(params)
            return {"ok": True}
        with patch("cli.main.request_once", side_effect=transport) as request, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["sessions", "start", "--help"]), 0)
        request.assert_not_called()
        self.assertEqual(sessions, [])

    def test_unknown_flags_have_named_errors_before_any_io(self):
        for path in COMMAND_PATHS:
            if path == "help":
                continue
            for flag in ("--not-an-option", "-z"):
                with self.subTest(path=path, flag=flag):
                    payload = self.invoke_read_only([*path.split(), flag], expected_status=2)
                    self.assertEqual(payload["error"]["code"], "unknown_option")
                    self.assertIn(flag, payload["error"]["message"])

    def test_known_but_inapplicable_flags_cannot_become_names_or_urls(self):
        for argv in (["sessions", "start", "--clear"], ["open", "--mobile"],
                     ["navigate", "--changes"], ["tabs", "create", "--clear"],
                     ["sessions", "start", "--session", "--misspelled"]):
            with self.subTest(argv=argv):
                payload = self.invoke_read_only(argv, expected_status=2)
                self.assertEqual(payload["error"]["code"], "unknown_option")

    def test_request_mapping_rejects_flags_as_names_and_urls(self):
        for command, args in (("sessions", ["start", "--typo"]),
                              ("tabs", ["create", "--typo"]),
                              ("open", ["--typo"]), ("navigate", ["-z"])):
            with self.subTest(command=command, args=args), self.assertRaises(CLIError) as caught:
                _command_request(command, args)
            self.assertEqual(caught.exception.code, "unknown_option")

    def test_opaque_values_survive_offline_transport(self):
        cases = [
            (["fill", "osr-1", "-draft"], "fill", {"ref": "osr-1", "value": "-draft"}),
            (["type", "osr-1", "-hello"], "type", {"ref": "osr-1", "text": "-hello"}),
            (["select", "osr-1", "--choice"], "select", {"ref": "osr-1", "value": "--choice"}),
            (["fill", "osr-1", "--session"], "fill", {"ref": "osr-1", "value": "--session"}),
            (["type", "osr-1", "--json"], "type", {"ref": "osr-1", "text": "--json"}),
            (["evaluate", "--", "-someExpression"], "evaluate", {"source": "-someExpression"}),
            (["eval", "--", "--session"], "evaluate", {"source": "--session"}),
            (["fill", "osr-1", "--", "--"], "fill", {"ref": "osr-1", "value": "--"}),
        ]
        for argv, command, params in cases:
            with self.subTest(argv=argv), patch.dict(os.environ, {}, clear=True), \
                 patch("cli.main.request_once", return_value={"ok": True}) as request, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(argv), 0)
                request.assert_called_once()
                self.assertEqual(request.call_args.args, (command, params))
                self.assertEqual(_command_request(argv[0], argv[1:]), (command, params))

    def test_opaque_values_do_not_disable_trailing_option_checks(self):
        for argv in (["fill", "osr-1", "-draft", "--typo"],
                     ["type", "--typo", "-text"],
                     ["evaluate", "-z"], ["evaluate", "-someExpression"],
                     ["sessions", "start", "fixture", "--typo"],
                     ["sessions", "start", "--", "--typo"],
                     ["tabs", "create", "--", "--typo"],
                     ["navigate", "--", "--typo"]):
            with self.subTest(argv=argv):
                result = self.invoke_read_only(argv, expected_status=2)
                self.assertEqual(result["error"]["code"], "unknown_option")
        for argv in (["evaluate", "--"], ["evaluate", "--", "1", "--typo"],
                     ["fill", "osr-1", "--", "text", "extra"]):
            with self.subTest(argv=argv):
                self.assertEqual(self.invoke_read_only(argv, expected_status=2)["error"]["code"], "usage")

    def test_global_options_and_help_with_opaque_values(self):
        with patch.dict(os.environ, {}, clear=True), \
             patch("cli.main.request_once", return_value={"ok": True}) as request, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--session", "fixture", "fill", "osr-1", "-draft", "--timeout", "2"]), 0)
            self.assertEqual(request.call_args.args, ("fill", {"ref": "osr-1", "value": "-draft"}))
            self.assertEqual(request.call_args.kwargs["session_key"], "fixture")
            self.assertEqual(request.call_args.kwargs["timeout"], 2)
        for argv in (["fill", "osr-1", "-draft", "--help"],
                     ["evaluate", "--", "--help"], ["sessions", "start", "--", "--help"]):
            with self.subTest(argv=argv):
                self.assertTrue(self.invoke_read_only(argv)["ok"])

    def test_negative_coordinates_and_literal_help_text_are_preserved(self):
        self.assertEqual(_command_request("scroll", ["-10", "-20"]),
                         ("scroll", {"x": -10, "y": -20}))
        self.assertEqual(_command_request("windows", ["resize", "800", "600", "-10", "-20"]),
                         ("windows.resize", {"width": 800, "height": 600, "left": -10, "top": -20}))
        with patch.dict(os.environ, {}, clear=True), \
             patch("cli.main.request_once", return_value={"ok": True}) as request, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["fill", "osr-1", "help"]), 0)
        request.assert_called_once()
        self.assertEqual(request.call_args.args, ("fill", {"ref": "osr-1", "value": "help"}))


if __name__ == "__main__":
    unittest.main()
