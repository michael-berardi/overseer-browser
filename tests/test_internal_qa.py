"""Candidate-only, mock transport: never opens a browser, broker or native socket."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import runpy
import sys
import unittest
import warnings
from unittest.mock import patch

from cli import main as cli
from cli.internal_qa import (OWNED_APEXES, OWNED_HOSTS,
                             is_owned_url, mark_owned_url, prepare_cli_navigation)

URL = "https://lucerolegal.org/path?token=a%2fb+Z&overseer_internal=0#frag%2F"
MARKED = "https://lucerolegal.org/path?token=a%2fb+Z&overseer_internal=1#frag%2F"


class Transport:
    def __init__(self):
        self.calls = []
        self.sessions = [
            {"sessionKey": "mine", "agentWindowId": 10, "ownedTabIds": [11, 12],
             "borrowedTabIds": [21], "selectedTabId": 11},
            {"sessionKey": "peer", "agentWindowId": 30, "ownedTabIds": [31],
             "borrowedTabIds": [], "selectedTabId": 31},
        ]
        self.tabs = [{"id": 11, "windowId": 10, "active": True},
                     {"id": 12, "windowId": 10, "active": False},
                     {"id": 21, "windowId": 20, "active": True}]

    def __call__(self, command, params, **options):
        self.calls.append((command, copy.deepcopy(params), options))
        if command == "sessions.list":
            return {"ok": True, "result": copy.deepcopy(self.sessions)}
        if command == "tabs.list":
            return {"ok": True, "result": copy.deepcopy(self.tabs)}
        return {"ok": True, "result": {}}


class URLMarkerTests(unittest.TestCase):
    def test_exact_inventory_including_nine_new_cloudflare_domains(self):
        inventory = Path(__file__).resolve().parents[2] / "overseer-j0268/scripts/lib/site-inventory.mjs"
        domains = re.findall(r'\bdomain:\s*"([^"]+)"', inventory.read_text())
        self.assertEqual(len(domains), 47)
        self.assertEqual(OWNED_APEXES, frozenset(domains))
        self.assertEqual(len(OWNED_HOSTS), 94)
        for host in OWNED_HOSTS:
            for scheme in ("http", "https", "HTTPS"):
                with self.subTest(host=host, scheme=scheme):
                    url = f"{scheme}://{host.upper()}:8443/a?x=%2f+%20#F"
                    self.assertEqual(mark_owned_url(url), url.replace("#", "&overseer_internal=1#"))
        self.assertTrue({"aussiesinargentina.com", "australiatoargentina.com", "implosecybernetics.com",
                         "imploselabs.com", "mileinews.com", "mouseia.org", "ottercasa.com",
                         "plataplace.com", "platastar.com"} <= OWNED_APEXES)

    def test_unowned_and_ambiguous_urls_remain_byte_identical(self):
        for url in ("https://example.org/?overseer_internal=0", "http://localhost:3000/",
                    "https://api.lucerolegal.org/", "https://lucerolegal.org.evil.test/",
                    "https://lucerolegal.org@evil.test/", "https://lucerolegal.org./",
                    "https://www.www.lucerolegal.org/", "https://%6cucerolegal.org/",
                    "//lucerolegal.org/", "/lucerolegal.org", "data:text/html,lucerolegal.org",
                    "ftp://lucerolegal.org/", "https://lucerolegal.org:bad/",
                    "https://lucerolegal.org\\@evil.test/", " https://lucerolegal.org/",
                    "https://lucerolegal.org/\n", "https://[broken/"):
            with self.subTest(url=url):
                self.assertFalse(is_owned_url(url))
                self.assertEqual(mark_owned_url(url), url)

    def test_credentials_and_static_document_navigation(self):
        for url in ("https://user:p%40ss@www.lucerolegal.org/a.svg",
                    "https://evil.test@lucerolegal.org/assets/app.js",
                    "https://lucerolegal.org/photo.webp", "https://lucerolegal.org/download.pdf"):
            self.assertEqual(mark_owned_url(url), url + "?overseer_internal=1")

    def test_raw_query_fragment_duplicates_and_encoded_marker_reset(self):
        cases = {
            "https://lucerolegal.org": "https://lucerolegal.org?overseer_internal=1",
            "https://lucerolegal.org/?#": "https://lucerolegal.org/?overseer_internal=1#",
            "https://lucerolegal.org/?a=1&": "https://lucerolegal.org/?a=1&&overseer_internal=1",
            URL: MARKED,
            "https://lucerolegal.org/?overseer%5finternal=0&x=%2f+%20&overseer_internal=0#?n=0":
                "https://lucerolegal.org/?overseer_internal=1&x=%2f+%20#?n=0",
            "https://lucerolegal.org/?overseer_internal&overseer_internal=1&overseer_internal=0":
                "https://lucerolegal.org/?overseer_internal=1",
            "https://lucerolegal.org/?redirect=https%3A%2F%2Fother.test%3Foverseer_internal%3D0&sig=Ab%2Bc%2f==#hash":
                "https://lucerolegal.org/?redirect=https%3A%2F%2Fother.test%3Foverseer_internal%3D0&sig=Ab%2Bc%2f==&overseer_internal=1#hash",
            "https://lucerolegal.org/?OVERSEER_INTERNAL=0&overseer%255finternal=0":
                "https://lucerolegal.org/?OVERSEER_INTERNAL=0&overseer%255finternal=0&overseer_internal=1",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(mark_owned_url(url), expected)
                self.assertEqual(mark_owned_url(expected), expected)


class CandidateCLITests(unittest.TestCase):
    def invoke(self, argv, transport):
        with patch.dict(os.environ, {}, clear=True), patch.object(cli, "request_once", side_effect=transport), \
             patch.object(cli, "_request_once", side_effect=AssertionError("no native transport")), \
             patch.object(cli.socket, "socket", side_effect=AssertionError("no socket")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            status = cli.main(argv)
        return status, json.loads(output.getvalue())

    def test_navigate_open_and_tab_create_mark_before_first_rpc_load(self):
        for argv, command in ((["navigate", URL], "navigate"), (["open", URL], "navigate"),
                              (["tabs", "create", URL], "tabs.create")):
            transport = Transport()
            with self.subTest(argv=argv):
                status, payload = self.invoke(["--session", "mine", *argv], transport)
                self.assertEqual(status, 0)
                self.assertTrue(payload["ok"])
                self.assertEqual(transport.calls[-1][0], command)
                self.assertEqual(transport.calls[-1][1]["url"], MARKED)
                self.assertEqual(transport.calls[-1][2]["session_key"], "mine")
                if command == "navigate":
                    self.assertEqual([c[0] for c in transport.calls], ["sessions.list", "tabs.list", "navigate"])
                    self.assertEqual(transport.calls[-1][1]["tab_id"], 11)
                else:
                    self.assertEqual(len(transport.calls), 1)

    def test_borrowed_target_unchanged_and_peer_scope_blocked(self):
        for explicit in (False, True):
            transport = Transport()
            transport.sessions[0]["selectedTabId"] = 21
            args = ["--tab-id", "21"] if explicit else []
            status, _ = self.invoke(["--session", "mine", *args, "navigate", URL], transport)
            self.assertEqual(status, 0)
            self.assertEqual(transport.calls[-1][1], {"url": URL, "tab_id": 21})
        transport = Transport()
        status, payload = self.invoke(["--session", "mine", "--tab-id", "31", "navigate", URL], transport)
        self.assertEqual(status, 1)
        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
        self.assertEqual([c[0] for c in transport.calls], ["sessions.list", "tabs.list"])

    def test_active_owned_tab_beats_stale_selection_and_preserves_target_flags(self):
        transport = Transport()
        transport.sessions[0]["selectedTabId"] = 12
        status, _ = self.invoke(["--session", "mine", "--request-id", "nav-1", "navigate", URL,
                                "--wait-until", "interactive"], transport)
        self.assertEqual(status, 0)
        self.assertEqual(transport.calls[-1][1], {"url": MARKED, "tab_id": 11, "wait_until": "interactive"})
        self.assertEqual(transport.calls[-1][2]["request_id"], "nav-1")
        self.assertNotIn("request_id", transport.calls[0][2])

    def test_missing_or_invalid_scope_never_sends_owned_navigation(self):
        for mutation in (lambda t: t.sessions.clear(),
                         lambda t: t.sessions.append(copy.deepcopy(t.sessions[0])),
                         lambda t: t.sessions[0].pop("borrowedTabIds"),
                         lambda t: t.tabs.clear()):
            transport = Transport()
            mutation(transport)
            status, payload = self.invoke(["--session", "mine", "navigate", URL], transport)
            self.assertEqual(status, 1)
            self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
            self.assertNotIn("navigate", [c[0] for c in transport.calls])

    def test_no_sticky_proof_or_optout_between_invocations(self):
        transport = Transport()
        self.assertEqual(self.invoke(["--session", "mine", "navigate", URL], transport)[0], 0)
        transport.calls.clear()
        transport.sessions[0]["selectedTabId"] = 21
        self.assertEqual(self.invoke(["--session", "mine", "navigate", URL], transport)[0], 0)
        self.assertEqual(transport.calls[-1][1]["url"], URL)
        self.assertEqual([c[0] for c in transport.calls], ["sessions.list", "tabs.list", "navigate"])

    def test_unowned_urls_and_opaque_values_and_url_free_navigation_unchanged(self):
        cases = [(["navigate", "https://example.org/?overseer_internal=0"], "navigate", {"url": "https://example.org/?overseer_internal=0"}),
                 (["fill", "osr-1", URL], "fill", {"ref": "osr-1", "value": URL}),
                 (["type", "osr-1", URL], "type", {"ref": "osr-1", "text": URL}),
                 (["select", "osr-1", URL], "select", {"ref": "osr-1", "value": URL}),
                 (["evaluate", URL], "evaluate", {"source": URL}),
                 (["wait", "--url", URL], "wait.for", {"url_contains": URL}),
                 (["tabs", "create"], "tabs.create", {}),
                 (["reload"], "reload", {}), (["back"], "back", {}), (["forward"], "forward", {})]
        for argv, command, params in cases:
            transport = Transport()
            with self.subTest(argv=argv):
                self.assertEqual(self.invoke(argv, transport)[0], 0)
                self.assertEqual([(c[0], c[1]) for c in transport.calls], [(command, params)])

    def test_batch_marks_only_navigation_fields_and_does_not_mutate_input(self):
        transport = Transport()
        params = {"actions": [{"command": "fill", "params": {"ref": "osr-1", "value": URL}},
                              {"command": "tabs.create", "params": {"url": URL}},
                              {"command": "navigate", "params": {"url": URL, "tab_id": 12}},
                              {"command": "evaluate", "params": {"source": URL}}]}
        before = copy.deepcopy(params)
        updated = prepare_cli_navigation("batch", params, request=transport, session_key="mine", timeout=3,
                                         error_factory=cli.CLIError,
                                         serialized_batch_size=cli._serialized_batch_request_bytes,
                                         max_request_bytes=cli.MAX_EXTENSION_REQUEST_BYTES)
        self.assertEqual(params, before)
        self.assertEqual(updated["actions"][0], params["actions"][0])
        self.assertEqual(updated["actions"][1]["params"]["url"], MARKED)
        self.assertEqual(updated["actions"][2]["params"], {"url": MARKED, "tab_id": 12})
        self.assertEqual(updated["actions"][3], params["actions"][3])
        status, _ = self.invoke(["--session", "mine", "batch", json.dumps(params)], Transport())
        self.assertEqual(status, 0)

    def test_batch_implicit_navigation_after_scope_change_is_blocked(self):
        transport = Transport()
        actions = [{"command": "tabs.create", "params": {"url": URL}},
                   {"command": "navigate", "params": {"url": URL}}]
        status, payload = self.invoke(["--session", "mine", "batch", json.dumps(actions)], transport)
        self.assertEqual(status, 1)
        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
        self.assertEqual(transport.calls, [])

    def test_all_command_help_and_unknown_flags_remain_zero_io(self):
        paths = list(cli.CLI_USAGE)
        for path in paths:
            for flag in ("--help", "-h", "--typo"):
                if path == "help" and flag == "--typo":
                    continue
                transport = Transport()
                with self.subTest(path=path, flag=flag), \
                     patch.object(cli, "local_health", side_effect=AssertionError("no health")), \
                     patch.object(cli, "_run_script", side_effect=AssertionError("no installer")), \
                     patch.object(cli, "find_active_runtime", side_effect=AssertionError("no runtime")), \
                     patch.object(cli.temp_outputs, "reservation", side_effect=AssertionError("no output")):
                    status, _ = self.invoke([*path.split(), flag], transport)
                    self.assertEqual(status, 2 if flag == "--typo" else 0)
                    self.assertEqual(transport.calls, [])
        for argv, expected in ((["--version"], 0), (["version"], 0),
                               (["navigate", URL, "--wait-until", "bad"], 2),
                               (["navigate", URL, "--max-nodes", "3"], 1),
                               (["tabs", "create", URL, "--tab-id", "11"], 1),
                               (["navigate", URL, "--timeout", "bad"], 2),
                               (["navigate", URL, "--request-id", "bad/key"], 2),
                               (["navigate", URL, "--session", "bad/key"], 2),
                               (["tabs", "create", "--clear"], 2)):
            transport = Transport()
            with self.subTest(argv=argv):
                self.assertEqual(self.invoke(argv, transport)[0], expected)
                self.assertEqual(transport.calls, [])

    def test_marked_batch_size_limit_is_local_and_zero_native_io(self):
        params = {"actions": [{"command": "tabs.create", "params": {"url": "https://lucerolegal.org/"}}]}
        with patch.object(cli, "MAX_EXTENSION_REQUEST_BYTES", cli._serialized_batch_request_bytes(params)):
            transport = Transport()
            status, payload = self.invoke(["batch", json.dumps(params)], transport)
            self.assertEqual(status, 1)
            self.assertEqual(payload["error"]["code"], "usage")
            self.assertEqual(transport.calls, [])

    def test_scope_transport_error_never_replays_or_sends_navigation(self):
        transport = Transport()
        def failed(command, params, **options):
            response = transport(command, params, **options)
            return {"ok": False, "error": {"code": "session_required"}} if command == "tabs.list" else response
        status, payload = self.invoke(["--session", "mine", "navigate", URL], failed)
        self.assertEqual(status, 1)
        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
        self.assertEqual([c[0] for c in transport.calls], ["sessions.list", "tabs.list"])

    def test_explicit_owned_target_and_moved_tab_require_real_window(self):
        transport = Transport()
        status, _ = self.invoke(["--session", "mine", "navigate", URL, "--tab-id", "12"], transport)
        self.assertEqual(status, 0)
        self.assertEqual(transport.calls[-1][1], {"url": MARKED, "tab_id": 12})
        transport.calls.clear()
        transport.tabs[1]["windowId"] = 20
        status, payload = self.invoke(["--session", "mine", "navigate", URL, "--tab-id", "12"], transport)
        self.assertEqual(status, 1)
        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
        self.assertNotIn("navigate", [c[0] for c in transport.calls])

    def test_generic_rpc_and_original_cli_payload_remain_unchanged(self):
        original = cli.request_once
        params = {"url": URL, "tab_id": 11}
        with patch.object(cli, "_request_once", return_value={"ok": True}) as native:
            sentinel = object()
            self.assertTrue(cli.request_once("navigate", params, timeout=1, paths=sentinel, session_key="mine")["ok"])
            self.assertEqual(native.call_args.args, ("navigate", params))
            self.assertIs(native.call_args.args[1], params)
        transport = Transport()
        self.invoke(["--session", "mine", "navigate", URL], transport)
        self.assertIs(cli.request_once, original)
        self.assertEqual(cli._command_request("navigate", [URL]), ("navigate", {"url": URL}))


class ManagedEntryTests(unittest.TestCase):
    def invoke(self, argv, transport, *, script=False):
        """Execute real __main__ definitions, substituting only the RPC boundary.

        runpy redefines request_once, so a bounded trace installs the mock when
        the executing main is called (not an alias imported as cli.main).
        """
        main_path = str(Path(cli.__file__).resolve())
        previous_trace = sys.gettrace()

        def intercept(frame, event, arg):
            if (event == "call" and frame.f_code.co_name == "main"
                    and frame.f_code.co_filename == main_path):
                frame.f_globals["request_once"] = transport
            return intercept

        with patch.dict(os.environ, {}, clear=True), \
             patch.object(cli.socket, "socket", side_effect=AssertionError("no socket")), \
             patch("cli.runtime_discovery.find_active_runtime", side_effect=AssertionError("no runtime")), \
             patch("native_host.isolation.ensure_instance", side_effect=AssertionError("no host")), \
             patch.object(sys, "argv", [main_path, *argv]), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()) as errors, warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=".*cli.main.*found in sys.modules.*", category=RuntimeWarning)
            try:
                sys.settrace(intercept)
                with self.assertRaises(SystemExit) as exit_info:
                    if script:
                        runpy.run_path(main_path, run_name="__main__")
                    else:
                        runpy.run_module("cli.main", run_name="__main__")
            finally:
                sys.settrace(previous_trace)
        self.assertEqual(errors.getvalue(), "")
        return exit_info.exception.code, json.loads(output.getvalue())

    def test_actual_managed_entry_success_and_structured_scope_errors(self):
        for script in (False, True):
            for case in ("success", "missing", "peer"):
                with self.subTest(script=script, case=case):
                    transport = Transport()
                    args = ["--session", "mine", "navigate", URL]
                    if case == "missing":
                        transport.sessions.clear()
                    elif case == "peer":
                        args += ["--tab-id", "31"]
                    status, payload = self.invoke(args, transport, script=script)
                    self.assertEqual(status, 0 if case == "success" else 1)
                    if case == "success":
                        self.assertEqual(transport.calls[-1][1], {"url": MARKED, "tab_id": 11})
                    else:
                        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
                        self.assertEqual([c[0] for c in transport.calls], ["sessions.list", "tabs.list"])

    def test_actual_entries_refuse_whatwg_aliases_before_any_rpc(self):
        aliases = ("https://%6cucerolegal.org/", " https://lucerolegal.org/",
                   "\x00\x1fhttps://lucerolegal.org/\x00", "https://lucerolegal.org/\n",
                   "h\tttps://lucerolegal.org/", "https://lu\ncerolegal.org/",
                   "https://lucerolegal.org\\@evil.test/", "https:\\lucerolegal.org/",
                   "https:/lucerolegal.org/", "https:lucerolegal.org/",
                   "https:////lucerolegal.org/", "https://ｌｕｃｅｒｏｌｅｇａｌ.org/",
                   "https://user:pass@%77ww.lucerolegal.org/")
        for alias in aliases:
            for argv in (["navigate", alias], ["open", alias], ["tabs", "create", alias],
                         ["batch", json.dumps([{"command": "navigate", "params": {"url": alias}}])]):
                with self.subTest(alias=alias, command=argv[0]):
                    for invoke in (self.invoke, lambda args, t: CandidateCLITests.invoke(self, args, t)):
                        transport = Transport()
                        status, payload = invoke(["--session", "mine", *argv], transport)
                        self.assertEqual(status, 1)
                        self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
                        self.assertEqual(transport.calls, [])

    def test_managed_opaque_aliases_and_ordinary_controls_survive(self):
        alias = " https://%6cucerolegal.org/\n"
        cases = [(["fill", "osr-1", alias], {"ref": "osr-1", "value": alias}),
                 (["evaluate", alias], {"source": alias}),
                 (["navigate", "https://user:p%40ss@example.org/a?x=%2f#F"],
                  {"url": "https://user:p%40ss@example.org/a?x=%2f#F"}),
                 (["navigate", "https://api.lucerolegal.org/"], {"url": "https://api.lucerolegal.org/"}),
                 (["reload"], {}), (["back"], {}), (["forward"], {})]
        for argv, expected in cases:
            with self.subTest(argv=argv):
                transport = Transport()
                self.assertEqual(self.invoke(argv, transport)[0], 0)
                self.assertEqual(len(transport.calls), 1)
                self.assertEqual(transport.calls[-1][1], expected)
        for argv in (["navigate", alias, "--help"], ["navigate", alias, "--typo"]):
            transport = Transport()
            self.invoke(argv, transport)
            self.assertEqual(transport.calls, [])

    def test_borrowed_selection_race_pins_unchanged_url_in_entry_and_batch(self):
        for script in (False, True):
            for batch in (False, True):
                transport = Transport()
                transport.sessions[0]["selectedTabId"] = 21
                loaded = []

                def race(command, params, **options):
                    response = transport(command, params, **options)
                    if command == "tabs.list":
                        transport.sessions[0]["selectedTabId"] = 11
                    if command in {"navigate", "batch"}:
                        values = params["actions"][0]["params"] if command == "batch" else params
                        target = values.get("tab_id", transport.sessions[0]["selectedTabId"])
                        loaded.append((target, values["url"]))
                    return response

                argv = (["batch", json.dumps([{"command": "navigate", "params": {"url": URL}}])]
                        if batch else ["navigate", URL])
                with self.subTest(script=script, batch=batch):
                    self.assertEqual(self.invoke(["--session", "mine", *argv], race, script=script)[0], 0)
                    self.assertEqual(loaded, [(21, URL)])

    def test_managed_shared_timeout_budget_and_exhaustion(self):
        for times, expected in (([10, 10.25, 10.5, 11, 11.25], [2.75, 2.25, 1.75]),
                                ([10, 10.25, 10.5, 14], [2.75]),
                                ([10, 10.25, 10.5, 11, 14], [2.75, 2.25])):
            transport = Transport()
            with patch.object(cli.time, "monotonic", side_effect=times):
                status, payload = self.invoke(["--session", "mine", "--timeout", "3", "navigate", URL], transport)
            self.assertEqual([c[2]["timeout"] for c in transport.calls], expected)
            self.assertEqual(status, 0 if len(expected) == 3 else 1)
            if status:
                self.assertEqual(payload["error"]["code"], "qa_scope_unverified")
                self.assertNotIn("navigate", [c[0] for c in transport.calls])

    def test_actual_managed_marked_size_overflow_is_structured_and_zero_rpc(self):
        params = {"actions": [{"command": "tabs.create", "params": {"url": "https://lucerolegal.org/?pad="}}]}
        params["actions"][0]["params"]["url"] += "x" * (cli.MAX_EXTENSION_REQUEST_BYTES - cli._serialized_batch_request_bytes(params))
        source = json.dumps(params, separators=(",", ":"))
        self.assertEqual(cli._serialized_batch_request_bytes(params), cli.MAX_EXTENSION_REQUEST_BYTES)
        self.assertLessEqual(len(source.encode()), cli.MAX_BATCH_SOURCE_BYTES)
        for script in (False, True):
            transport = Transport()
            status, payload = self.invoke(["batch", source], transport, script=script)
            self.assertEqual(status, 1)
            self.assertEqual(payload["error"]["code"], "usage")
            self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()
