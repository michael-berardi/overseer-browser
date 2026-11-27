"""Update contract v1: checks, notices, opt-in, verified install, rollback and debris bounds.

Hermetic: a temporary cache and install home, file:// release fixtures, fake installers,
and one loopback HTTP server for the request-anonymity check. No real network, HOME or browser.
"""
from __future__ import annotations

import contextlib
import hashlib
import http.server
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from cli import updates
from cli import main as cli_main
from native_host.protocol import ProtocolError, validate_extension_message

REPO = Path(__file__).resolve().parents[1]
CURRENT = "0.11.3"
NEXT = "0.12.0"


class TTY(io.StringIO):
    def isatty(self) -> bool:
        return True


class Sandbox(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="osr-updates-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / "home"
        self.cache = self.base / "cache"
        self.env = {updates.CACHE_ENV: str(self.cache), updates.HOME_ENV: str(self.home),
                    updates.BIN_ENV: str(self.base / "bin"), updates.REPO_ENV: "owner/repo", "PATH": os.environ.get("PATH", "")}
        self.spawned: list[list[str]] = []

    def spawn(self, args: list[str], env: dict[str, str]) -> None:
        self.spawned.append(args)

    def release(self, version: str = CURRENT) -> Path:
        main_py = self.home / "releases" / f"release-{version}" / "cli" / "main.py"
        main_py.parent.mkdir(parents=True, exist_ok=True)
        main_py.write_text(f'CLI_VERSION = "{version}"\n', encoding="utf-8")
        return main_py.parents[1]

    def record(self, tag: str = f"v{NEXT}", **extra: object) -> dict:
        return {"tag_name": tag, "draft": False, "prerelease": False, "body": "First note.\n\nSecond note.", **extra}


class VersionTests(unittest.TestCase):
    def test_only_strictly_newer_stable_versions_count(self) -> None:
        self.assertTrue(updates.is_newer(NEXT, CURRENT))
        self.assertTrue(updates.is_newer("v0.11.4", CURRENT))
        self.assertTrue(updates.is_newer("0.11.10", "0.11.9"))
        self.assertFalse(updates.is_newer(CURRENT, CURRENT))
        self.assertFalse(updates.is_newer("0.10.17", CURRENT))
        for garbage in ("garbage", "", None, 12, "0.12", "0.12.0.1", "0.12.0-rc.1", "0.12.0+build", "١.٢.٣", "vv0.12.0"):
            self.assertFalse(updates.is_newer(garbage, CURRENT), garbage)
        self.assertFalse(updates.is_newer(NEXT, "not-a-version"))


class CheckTests(Sandbox):
    def test_check_records_latest_stable_only(self) -> None:
        state = updates.check_now(CURRENT, self.env, lambda url: self.record(), now=100.0)
        self.assertEqual((state["latest"], state["error"], state["checked_at"]), (NEXT, "", 100.0))
        self.assertEqual(updates.report(CURRENT, state, self.env)["state"], "available")
        for ignored in (self.record(draft=True), self.record(prerelease=True), self.record(tag="v0.12.0-rc.1"), self.record(tag="nightly")):
            state = updates.check_now(CURRENT, self.env, lambda url, r=ignored: r)
            self.assertEqual(state["latest"], "")
            self.assertEqual(updates.report(CURRENT, state, self.env)["state"], "current")

    def test_failure_is_recorded_with_its_cause(self) -> None:
        def denied(url: str) -> dict:
            raise urllib.error.HTTPError(url, 403, "rate limited", {}, None)  # type: ignore[arg-type]
        state = updates.check_now(CURRENT, self.env, denied)
        self.assertEqual(state["error"], "HTTP 403 from the release server")
        self.assertEqual(updates.report(CURRENT, state, self.env)["state"], "failed")
        state = updates.check_now(CURRENT, self.env, lambda url: (_ for _ in ()).throw(TimeoutError()))
        self.assertEqual(state["error"], "no answer within 4 s")
        unstamped = dict(self.env)
        unstamped.pop(updates.REPO_ENV)
        self.assertIn("names no release repository", updates.check_now(CURRENT, unstamped)["error"])

    def test_request_is_one_anonymous_get(self) -> None:
        seen: list[tuple[str, str, dict]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen.append((self.command, self.path, dict(self.headers)))
                body = json.dumps({"tag_name": f"v{NEXT}", "draft": False, "prerelease": False, "body": ""}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = dict(self.env, **{updates.API_ENV: f"http://127.0.0.1:{server.server_port}/repos/owner/repo/releases/latest"})
        self.assertEqual(updates.check_now(CURRENT, env)["latest"], NEXT)
        self.assertEqual(len(seen), 1)
        method, path, headers = seen[0]
        self.assertEqual((method, path), ("GET", "/repos/owner/repo/releases/latest"))
        self.assertEqual(headers["User-Agent"], "overseer-browser-update-check")
        self.assertEqual(sorted(name.lower() for name in headers),
                         ["accept", "accept-encoding", "connection", "host", "user-agent"])
        self.assertNotIn(CURRENT, json.dumps(headers))

    def test_state_is_one_private_file(self) -> None:
        updates.check_now(CURRENT, self.env, lambda url: self.record())
        self.assertEqual(sorted(path.name for path in self.cache.iterdir()), [updates.STATE_FILE])
        self.assertEqual(stat.S_IMODE((self.cache / updates.STATE_FILE).stat().st_mode), 0o600)
        self.assertLess((self.cache / updates.STATE_FILE).stat().st_size, 1024)
        (self.cache / updates.STATE_FILE).write_text("{not json", encoding="utf-8")
        self.assertEqual(updates.load_state(self.env), updates.DEFAULTS)

    def test_background_check_runs_at_most_once_a_day(self) -> None:
        self.assertTrue(updates.start_background_check(CURRENT, self.env, 1_000.0, self.spawn))
        self.assertFalse(updates.start_background_check(CURRENT, self.env, 1_000.0 + 3_600, self.spawn))
        self.assertEqual(self.spawned, [["--background", CURRENT]])
        self.assertTrue(updates.start_background_check(CURRENT, self.env, 1_000.0 + updates.INTERVAL, self.spawn))
        updates.update_state(self.env, checked_at=time.time() + 3_600)  # a clock set back still checks
        self.assertTrue(updates.start_background_check(CURRENT, self.env, spawn=self.spawn))
        self.assertEqual(len(self.spawned), 3)

    def test_detached_child_runs_isolated_and_writes_only_the_state_file(self) -> None:
        record = self.base / "latest.json"
        record.write_text(json.dumps(self.record()), encoding="utf-8")
        env = dict(self.env, **{updates.API_ENV: record.as_uri()})
        completed = subprocess.run([sys.executable, "-I", "-B", str(REPO / "cli" / "updates.py"), "--background", CURRENT],
                                   env=env, capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual((completed.returncode, completed.stdout, completed.stderr), (0, "", ""))
        self.assertEqual(updates.load_state(env)["latest"], NEXT)
        self.assertEqual([path.name for path in self.cache.iterdir()], [updates.STATE_FILE])


class NoticeTests(Sandbox):
    def available(self, **state: object) -> None:
        updates.update_state(self.env, checked_at=time.time(), latest=NEXT, **state)

    def test_notice_text_frequency_and_skip(self) -> None:
        self.release()
        self.available()
        self.assertEqual(updates.notice(CURRENT, self.env, now=10.0), [
            "overseer-browser 0.12.0 available (you have 0.11.3) · run: overseer-browser update",
            "turn on automatic updates: overseer-browser update --auto on · skip: overseer-browser update --skip",
        ])
        self.assertEqual(updates.notice(CURRENT, self.env, now=10.0 + 3_600), [])
        self.assertEqual(len(updates.notice(CURRENT, self.env, now=10.0 + updates.INTERVAL)), 2)
        updates.update_state(self.env, skip=NEXT, shown="")
        self.assertEqual(updates.notice(CURRENT, self.env), [])
        self.available(skip=NEXT)
        updates.update_state(self.env, latest="0.12.1")
        self.assertIn("overseer-browser 0.12.1 available", updates.notice(CURRENT, self.env)[0])

    def test_notice_follows_install_kind_and_auto_state(self) -> None:
        self.available()
        self.assertIn("run: git pull --ff-only && overseer-browser update", updates.notice(CURRENT, self.env, now=1.0)[0])
        self.release()
        self.available(auto=True, shown="")
        self.assertEqual(updates.notice(CURRENT, self.env, now=1.0)[1], "skip: overseer-browser update --skip")
        self.available(auto=True, auto_error="checksum mismatch", shown="")
        self.assertTrue(updates.notice(CURRENT, self.env, now=1.0)[1].startswith("automatic update failed"))

    def test_silent_outside_a_terminal_and_when_opted_out(self) -> None:
        streams = (TTY(), TTY())
        self.assertTrue(updates.notices_allowed(False, self.env, streams))
        self.assertFalse(updates.notices_allowed(False, self.env, (io.StringIO(), TTY())))
        self.assertFalse(updates.notices_allowed(False, self.env, (TTY(), io.StringIO())))
        self.assertFalse(updates.notices_allowed(True, self.env, streams))
        for extra in ({"CI": "true"}, {updates.AGENT_ENV: "1"}, {updates.NO_CHECK_ENV: "1"}):
            self.assertFalse(updates.notices_allowed(False, dict(self.env, **extra), streams), extra)
        updates.update_state(self.env, checks=False)
        self.assertFalse(updates.notices_allowed(False, self.env, streams))

    def test_notice_goes_to_stderr_after_the_result_and_never_into_json(self) -> None:
        self.release()
        self.available()
        out, err = TTY(), TTY()
        with patch.object(sys, "stdout", out), patch.object(sys, "stderr", err), \
                patch.object(updates, "_spawn", self.spawn):
            cli_main._after_command("tabs", True, True, self.env)
            self.assertEqual(err.getvalue(), "")
            cli_main._after_command("tabs", True, False, dict(self.env, NO_COLOR="1"))
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue().splitlines()[0],
                         "overseer-browser 0.12.0 available (you have 0.11.3) · run: overseer-browser update")
        self.assertEqual(len(err.getvalue().splitlines()), 2)

    def test_emit_dims_only_the_second_line_on_a_terminal(self) -> None:
        stream = TTY()
        updates.emit_notice(["one", "two"], stream, env={})
        self.assertEqual(stream.getvalue(), "one\n\x1b[2mtwo\x1b[0m\n")


class CommandTests(Sandbox):
    def run_cli(self, *args: str) -> tuple[int, dict]:
        out = io.StringIO()
        with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            code = cli_main.main(["update", *args, "--json"])
        return code, json.loads(out.getvalue())

    def api(self, record: dict | None) -> None:
        path = self.base / "latest.json"
        if record is None:
            self.env[updates.API_ENV] = (self.base / "missing.json").as_uri()
        else:
            path.write_text(json.dumps(record), encoding="utf-8")
            self.env[updates.API_ENV] = path.as_uri()

    def test_check_exit_codes(self) -> None:
        with patch.object(cli_main, "CLI_VERSION", CURRENT):
            self.api(self.record())
            code, payload = self.run_cli("--check")
            self.assertEqual((code, payload["result"]["state"], payload["result"]["latest"]), (10, "available", NEXT))
            self.api(self.record(tag=f"v{CURRENT}"))
            self.assertEqual(self.run_cli("--check")[0], 0)
            self.api(None)
            code, payload = self.run_cli("--check")
            self.assertEqual((code, payload["ok"]), (1, False))
            self.assertIn("network error", payload["result"]["error"])

    def test_skip_and_auto_persist(self) -> None:
        with patch.object(cli_main, "CLI_VERSION", CURRENT):
            self.api(self.record())
            self.assertEqual(self.run_cli("--skip")[1]["result"]["skipped"], NEXT)
            self.assertEqual(updates.load_state(self.env)["skip"], NEXT)
            self.assertEqual(self.run_cli("--auto", "status")[1]["result"]["auto"], False)
            self.assertEqual(self.run_cli("--auto", "on")[1]["result"]["auto"], True)
            self.assertTrue(updates.load_state(self.env)["auto"])
            self.assertEqual(self.run_cli("--auto", "off")[1]["result"]["auto"], False)
            self.assertEqual(self.run_cli("--auto-check", "off")[1]["result"]["checks"], False)
            self.assertFalse(updates.automatic_checks(self.env))
            self.assertEqual(self.run_cli("--auto", "maybe")[0], 2)
            self.assertEqual(self.run_cli("--check", "--skip")[0], 2)
            code, payload = self.run_cli("--rollback")
            self.assertEqual((code, payload["error"]["code"]), (1, "rollback_unavailable"))


class InstallTests(Sandbox):
    def setUp(self) -> None:
        super().setUp()
        self.tmp_root = self.base / "tmp"
        self.tmp_root.mkdir()
        patcher = patch.object(tempfile, "tempdir", str(self.tmp_root))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.assets = self.base / "assets"
        self.assets.mkdir()
        (self.assets / "install.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (self.assets / "overseer-browser.tar.gz").write_bytes(b"bundle bytes")
        self.sign()
        self.env[updates.BASE_ENV] = self.assets.as_uri()
        self.calls: list[tuple[list[str], dict[str, str]]] = []

    def sign(self) -> None:
        lines = [f"{hashlib.sha256((self.assets / n).read_bytes()).hexdigest()}  {n}" for n in ("overseer-browser.tar.gz", "install.sh")]
        (self.assets / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def installer(self, code: int = 0, writes: str | None = NEXT):
        def run(argv: list[str], env: dict[str, str], out: object) -> int:
            self.calls.append((argv, env))
            if argv[0] == "sh" and writes:
                self.release(writes)
                for old in (self.home / "releases").glob("release-*"):  # install.sh keeps only the new release
                    if old.name != f"release-{writes}":
                        old.rename(self.base / f"pruned-{old.name}")
            return code if argv[0] == "sh" else 0
        return run

    def test_checksum_mismatch_refuses_before_anything_changes(self) -> None:
        self.release()
        (self.assets / "overseer-browser.tar.gz").write_bytes(b"tampered")
        with self.assertRaises(updates.UpdateError) as caught:
            updates.install(CURRENT, NEXT, self.env, io.StringIO(), self.installer())
        self.assertEqual(caught.exception.code, "checksum_mismatch")
        self.assertEqual(self.calls, [])
        self.assertTrue((self.home / "releases" / f"release-{CURRENT}").is_dir())
        self.assertFalse((self.home / "previous").exists())
        self.assertEqual(list(self.tmp_root.iterdir()), [])

    def test_missing_checksum_entry_refuses(self) -> None:
        self.release()
        (self.assets / "SHA256SUMS").write_text("", encoding="utf-8")
        with self.assertRaises(updates.UpdateError) as caught:
            updates.install(CURRENT, NEXT, self.env, io.StringIO(), self.installer())
        self.assertEqual(caught.exception.code, "checksum_missing")
        self.assertEqual(self.calls, [])

    def test_verified_install_runs_the_release_installer_offline_and_keeps_one_rollback(self) -> None:
        self.release()
        result = updates.install(CURRENT, NEXT, self.env, io.StringIO(), self.installer())
        self.assertEqual(result, {"installed": NEXT, "previous": CURRENT, "rollback": True})
        argv, env = self.calls[0]
        self.assertEqual(argv[0], "sh")
        self.assertTrue(argv[1].endswith("/install.sh"))
        self.assertTrue(env[updates.BASE_ENV].startswith("file://"))
        self.assertEqual(env["OVERSEER_BROWSER_VERSION"], NEXT)
        self.assertEqual([p.name for p in (self.home / "previous").iterdir()], [f"release-{CURRENT}"])
        self.assertEqual(list(self.tmp_root.iterdir()), [])

    def test_failed_install_restores_the_previous_release(self) -> None:
        self.release()
        with self.assertRaises(updates.UpdateError) as caught:
            updates.install(CURRENT, NEXT, self.env, io.StringIO(), self.installer(code=1, writes=None))
        self.assertEqual(caught.exception.code, "install_failed")
        self.assertIn(f"restored {CURRENT}", str(caught.exception))
        self.assertEqual(len(self.calls), 2)  # the new installer, then the kept release's platform installer
        self.assertIn(f"release-{CURRENT}", self.calls[1][0][1])
        self.assertEqual(self.calls[1][1]["OVERSEER_BROWSER_PREBUILT_EXTENSION"], "1")
        self.assertTrue((self.home / "releases" / f"release-{CURRENT}" / "cli" / "main.py").is_file())
        self.assertFalse((self.home / "previous").exists())
        self.assertEqual(list(self.tmp_root.iterdir()), [])

    def test_rollback_restores_the_kept_release(self) -> None:
        self.release()
        updates.install(CURRENT, NEXT, self.env, io.StringIO(), self.installer())
        built = self.home / "previous" / f"release-{CURRENT}" / "extension" / ".output" / "chrome-mv3"
        built.mkdir(parents=True)
        (built / "manifest.json").write_text("{}", encoding="utf-8")
        self.assertEqual(updates.restore_previous(self.env, io.StringIO(), self.installer()), CURRENT)
        self.assertEqual(sorted(p.name for p in (self.home / "releases").iterdir()), [f"release-{CURRENT}"])
        self.assertTrue((self.home / "extension" / "manifest.json").is_file())
        self.assertFalse((self.home / "previous").exists())
        self.assertIsNone(updates.restore_previous(self.env, io.StringIO(), self.installer()))

    def test_rollback_copy_is_bounded(self) -> None:
        self.release(CURRENT)
        updates.keep_previous(CURRENT, self.env)
        self.release(NEXT)
        updates.keep_previous(NEXT, self.env)
        self.assertEqual([p.name for p in (self.home / "previous").iterdir()], [f"release-{NEXT}"])
        self.assertFalse(updates.prune_previous("0.12.1", self.env, used=False))
        self.assertFalse(updates.prune_previous(NEXT, self.env, used=True))  # not newer than the kept copy
        self.assertTrue(updates.prune_previous("0.12.1", self.env, used=True))
        self.release(NEXT)
        updates.keep_previous(NEXT, self.env)
        self.assertTrue(updates.prune_previous(NEXT, self.env, now=time.time() + updates.KEEP_PREVIOUS + 1))
        self.assertFalse((self.home / "previous").exists())

    def test_update_command_asks_then_offers_auto_once(self) -> None:
        self.release()
        answers = iter(["", "n"])
        result = updates.run_update(CURRENT, self.env, True, lambda prompt: next(answers), io.StringIO(),
                                    lambda url: self.record(), self.installer())
        self.assertEqual((result["state"], result["auto"]), ("installed", False))
        self.assertTrue(updates.load_state(self.env)["asked"])
        declined = updates.run_update("0.11.5", self.env, True, lambda prompt: "n", io.StringIO(), lambda url: self.record())
        self.assertEqual(declined["state"], "declined")
        current = updates.run_update(NEXT, self.env, True, None, io.StringIO(), lambda url: self.record())
        self.assertEqual(current["state"], "current")

    def test_non_interactive_update_installs_without_questions(self) -> None:
        self.release()
        result = updates.run_update(CURRENT, self.env, False, lambda prompt: self.fail(prompt), io.StringIO(),
                                    lambda url: self.record(), self.installer())
        self.assertEqual(result["state"], "installed")


class AutoTests(InstallTests):
    def test_auto_install_runs_only_when_opted_in_and_logs_bounded(self) -> None:
        self.release()
        record = self.base / "latest.json"
        record.write_text(json.dumps(self.record()), encoding="utf-8")
        self.env[updates.API_ENV] = record.as_uri()
        with patch.object(updates, "background_install") as installer:
            self.assertEqual(updates.background(CURRENT, env=self.env), 0)
            installer.assert_not_called()
            updates.update_state(self.env, auto=True)
            updates.background(CURRENT, env=self.env)
            installer.assert_called_once_with(CURRENT, NEXT, self.env)
        self.assertTrue(updates.background_install(CURRENT, NEXT, self.env, self.installer()))
        log = self.cache / updates.LOG_FILE
        self.assertIn(f"installed {NEXT}", log.read_text(encoding="utf-8"))
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)

    def test_failed_auto_install_records_the_cause_and_falls_back_to_the_notice(self) -> None:
        self.release()
        (self.assets / "install.sh").write_text("tampered", encoding="utf-8")
        updates.update_state(self.env, auto=True, latest=NEXT, checked_at=time.time())
        self.assertFalse(updates.background_install(CURRENT, NEXT, self.env, self.installer()))
        state = updates.load_state(self.env)
        self.assertIn("checksum mismatch for install.sh", state["auto_error"])
        self.assertEqual(state["installing"], "")
        self.assertTrue(updates.notice(CURRENT, self.env)[1].startswith("automatic update failed"))

    def test_log_and_state_are_bounded_and_removed_on_uninstall(self) -> None:
        log = self.cache / updates.LOG_FILE
        self.cache.mkdir(parents=True, exist_ok=True)
        log.write_bytes(b"old line\n" * 40_000)
        with updates.bounded_log(self.env) as handle:
            handle.write("x" * 1000 + "\n")
        self.assertLessEqual(log.stat().st_size, updates.LOG_LIMIT)
        log.write_bytes(b"y" * (updates.LOG_LIMIT + 50_000))
        updates.trim_log(log)
        self.assertLessEqual(log.stat().st_size, updates.LOG_LIMIT)
        updates.update_state(self.env, auto=True)
        self.release()
        updates.keep_previous(CURRENT, self.env)
        updates.remove_state(self.env)
        self.assertFalse(self.cache.exists())
        self.assertFalse((self.home / "previous").exists())


class PopupTests(Sandbox):
    def test_actions_change_only_local_state_and_network_goes_to_a_child(self) -> None:
        status = updates.popup(CURRENT, "status", self.env, now=1_000.0, spawn=self.spawn)
        self.assertEqual(self.spawned, [["--background", CURRENT]])
        self.assertEqual((status["available"], status["checks"], status["auto"]), (False, True, False))
        updates.popup(CURRENT, "status", self.env, now=1_001.0, spawn=self.spawn)
        self.assertEqual(len(self.spawned), 1)  # the daily bound holds for the popup too
        updates.update_state(self.env, latest=NEXT, notes="Fixes.")
        status = updates.popup(CURRENT, "status", self.env, now=1_002.0, spawn=self.spawn)
        self.assertEqual((status["available"], status["latest"], status["notes"]), (True, NEXT, "Fixes."))
        status = updates.popup(CURRENT, "install", self.env, now=1_003.0, spawn=self.spawn)
        self.assertEqual(self.spawned[-1], ["--background", CURRENT, "--install", NEXT])
        self.assertTrue(status["installing"])
        self.assertFalse(updates.popup(CURRENT, "skip", self.env, spawn=self.spawn)["available"])
        self.assertTrue(updates.popup(CURRENT, "auto_on", self.env, spawn=self.spawn)["auto"])
        self.assertFalse(updates.popup(CURRENT, "checks_off", self.env, spawn=self.spawn)["checks"])
        updates.update_state(self.env, checked_at=0.0)
        updates.popup(CURRENT, "status", self.env, spawn=self.spawn)
        self.assertEqual(len(self.spawned), 2)  # checks off: no automatic check from the popup
        updates.popup(CURRENT, "check", self.env, spawn=self.spawn)
        self.assertEqual(len(self.spawned), 3)  # Check Now still works

    def test_host_protocol_accepts_only_known_actions(self) -> None:
        message = validate_extension_message({"version": 1, "kind": "update_check", "request_id": "update-check-v1", "action": "skip"})
        self.assertEqual(message["action"], "skip")
        with self.assertRaises(ProtocolError):
            validate_extension_message({"version": 1, "kind": "update_check", "request_id": "update-check-v1", "action": "sh"})

    def test_release_build_stamps_the_repository_into_the_bundle(self) -> None:
        script = (REPO / "scripts" / "build-release.sh").read_text(encoding="utf-8")
        self.assertIn("for f in cli/updates.py scripts/install.sh scripts/install.ps1; do", script)
        self.assertLess(script.index('slug="${OVERSEER_BROWSER_RELEASE_REPO:-}"'), script.index("git archive"))
        self.assertEqual(updates.RELEASE_REPO, "example-user/overseer-browser")
        self.assertIsNone(updates._repo({}))
        with patch.object(updates, "RELEASE_REPO", "owner/overseer-browser"):
            self.assertEqual(updates._repo({}), "owner/overseer-browser")


if __name__ == "__main__":
    unittest.main()
