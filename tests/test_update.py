"""Update-contract v1: anonymous daily check, notices, opt-ins and safe install.

All HTTP is injected; these tests never touch the network.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from cli import update
from cli.main import main

ROOT = Path(__file__).resolve().parents[1]
# Canonical URL form is the one allowlisted spelling of the owner in the
# shipped-source neutrality guard.
CANONICAL_REPOSITORY = "https://github.com/michael-berardi/overseer-browser"
EXPECTED_SLUG = CANONICAL_REPOSITORY.removeprefix("https://github.com/")
EXPECTED_API_URL = "https://api.github.com/repos/" + EXPECTED_SLUG + "/releases/latest"


def release_payload(tag="v0.10.20", draft=False, prerelease=False):
    return json.dumps({
        "tag_name": tag, "draft": draft, "prerelease": prerelease,
        "assets": [
            {"name": "overseer-browser.tar.gz", "browser_download_url": "https://example.invalid/overseer-browser.tar.gz"},
            {"name": "SHA256SUMS", "browser_download_url": "https://example.invalid/SHA256SUMS"},
        ],
    }).encode("utf-8")


class UpdateContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="osr-update-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.env = dict(os.environ, **{update.STATE_DIR_ENV: str(self.base / "state")})
        for name in (update.OPT_OUT_ENV, "CI", "GITHUB_ACTIONS", "BUILD_NUMBER", "TERM",
                     "ULTRATERM_SLOT", "ULTRATERM_TMUX_SESSION", update.AUTO_MARKER_ENV,
                     "OVERSEER_BROWSER_RELEASE_REPO"):
            self.env.pop(name, None)
        stack = patch.dict(os.environ, self.env, clear=True)
        stack.start()
        self.addCleanup(stack.stop)

    @staticmethod
    def getting(payload, calls):
        def get(url, timeout):
            calls.append((url, timeout))
            if isinstance(payload, BaseException):
                raise payload
            return payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        return get

    def test_stable_version_comparison(self):
        self.assertTrue(update.is_newer("0.10.20", "0.10.19"))
        self.assertTrue(update.is_newer("v1.0.0", "0.10.19"))
        self.assertFalse(update.is_newer("0.10.19", "0.10.19"))
        self.assertFalse(update.is_newer("0.10.18", "0.10.19"))
        for bad in ("v0.10.20-rc.1", "latest", "0.10", "0.10.20.1", "", None):
            self.assertFalse(update.is_newer(bad, "0.10.19"))
            self.assertIsNone(update.stable_version(bad))

    def test_fetch_is_one_anonymous_get_to_own_release_record(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                self.limit = limit
                return release_payload()

        def urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return Response()

        with patch.object(update, "urlopen", urlopen):
            result = update.fetch_latest()
        request = captured["request"]
        self.assertEqual(request.full_url, EXPECTED_API_URL)
        self.assertEqual(request.get_header("User-agent"), update.USER_AGENT)
        self.assertLessEqual(captured["timeout"], 4)
        self.assertEqual(result["tag"], "0.10.20")
        self.assertEqual(result["assets"]["SHA256SUMS"], "https://example.invalid/SHA256SUMS")
        for flags in ({"draft": True}, {"prerelease": True}, {"tag_name": "v0.10.20-rc.1"}):
            payload = json.loads(release_payload())
            payload.update(flags)
            self.assertIsNone(update.fetch_latest(self.getting(payload, []))["tag"])

    def test_check_interval_cache_permissions_and_failure_cause(self):
        calls = []
        get = self.getting(release_payload(), calls)
        first = update.check("0.10.19", get=get, now=1000.0)
        self.assertTrue(first["ok"] and first["checked"])
        self.assertEqual(calls[0][1], update.HTTP_TIMEOUT_SECONDS)
        update.check("0.10.19", get=get, now=1000.0 + 3600)
        self.assertEqual(len(calls), 1, "the automatic check must not repeat inside 24 h")
        self.assertEqual(update.cache_path().stat().st_mode & 0o777, 0o600)
        self.assertEqual(update.read_cache()["latest"], "0.10.20")
        failed = update.check("0.10.19", force=True, get=self.getting(OSError("network offline"), calls), now=100000.0)
        self.assertFalse(failed["ok"])
        self.assertIn("network offline", failed["error"])
        self.assertIn("network offline", update.read_cache()["error"])
        self.assertIsNone(update.read_cache()["latest"])

    def test_start_time_is_recorded_before_get_and_blocks_repeat_checks(self):
        """A fast CLI exiting before the daemon writes its result must not re-GET."""
        entered = threading.Event()
        proceed = threading.Event()
        calls = []

        def slow_get(url, timeout):
            calls.append((url, timeout))
            entered.set()
            if not proceed.wait(3):
                raise AssertionError("blocked check was never released")
            return release_payload()

        result: dict[str, object] = {}
        errors: list[BaseException] = []

        def run():
            try:
                result.update(update.check("0.10.19", get=slow_get, now=1000.0))
            except BaseException as exc:
                errors.append(exc)

        worker = threading.Thread(target=run, name="update-check-test")
        worker.start()
        try:
            self.assertTrue(entered.wait(3), "the first check did not start")
            cache = update.read_cache()
            self.assertEqual(cache["checking_at"], 1000.0)
            self.assertIsNone(cache["latest"])
            # While the GET is in flight, a second invocation must not send one.
            second = update.check("0.10.19", get=self.getting(release_payload(), calls), now=1000.05)
            self.assertFalse(second["checked"])
            # An explicit re-check also respects the in-flight claim.
            forced = update.check("0.10.19", force=True,
                                  get=self.getting(release_payload(), calls), now=1000.06)
            self.assertFalse(forced["checked"])
            self.assertTrue(forced["in_progress"])
            self.assertEqual(len(calls), 1)
        finally:
            proceed.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(result["ok"] and result["checked"])
        cache = update.read_cache()
        self.assertEqual(cache["checked_at"], 1000.0)
        self.assertEqual(cache["checking_at"], 0.0)
        self.assertFalse(update.claim_path().exists())
        # Immediately after the first check finished, the daily cache still wins.
        later = []
        third = update.check("0.10.19", get=self.getting(release_payload(), later), now=1000.1)
        self.assertFalse(third["checked"])
        self.assertEqual(later, [])

    def test_stale_in_flight_marker_does_not_suppress_checks_forever(self):
        claim = update.claim_path()
        update._private_dir(claim.parent)
        claim.write_text("1000.0\n", encoding="utf-8")
        calls = []
        result = update.check("0.10.19", get=self.getting(release_payload(), calls),
                              now=1000.0 + update.CHECK_CLAIM_SECONDS + 1)
        self.assertTrue(result["checked"])
        self.assertEqual(len(calls), 1)

    def test_notice_once_per_version_per_day_and_skip(self):
        payload = release_payload()
        update.check("0.10.19", get=self.getting(payload, []), now=1000.0)
        lines = update.notice_lines("0.10.19", now=1000.0)
        self.assertEqual(len(lines), 2)
        self.assertIn("overseer-browser 0.10.20 available (you have 0.10.19) · run: overseer-browser update", lines[0])
        self.assertIn("update --auto on", lines[1])
        self.assertIn("update --skip", lines[1])
        self.assertEqual(update.notice_lines("0.10.19", now=2000.0), [])
        self.assertEqual(len(update.notice_lines("0.10.19", now=1000.0 + 86401)), 2)
        self.assertEqual(update.skip_version(), "0.10.20")
        self.assertEqual(update.notice_lines("0.10.19", now=200000.0), [])
        self.assertEqual(update.skip_version("0.10.21"), "0.10.21")
        self.assertEqual(len(update.notice_lines("0.10.19", now=300000.0)), 2)

    def test_automatic_check_gates(self):
        out = io.StringIO()
        out.isatty = lambda: True
        err = io.StringIO()
        err.isatty = lambda: True
        self.assertTrue(update.automatic_check_allowed(["health"], self.env, out, err))
        self.assertFalse(update.automatic_check_allowed(["health"], dict(self.env, CI="1"), out, err))
        self.assertFalse(update.automatic_check_allowed(["health"], dict(self.env, ULTRATERM_SLOT="1"), out, err))
        self.assertFalse(update.automatic_check_allowed(["health"], dict(self.env, TERM="dumb"), out, err))
        self.assertFalse(update.automatic_check_allowed(["health", "--json"], self.env, out, err))
        self.assertFalse(update.automatic_check_allowed(["update"], self.env, out, err))
        self.assertFalse(update.automatic_check_allowed(["health"], dict(self.env, **{update.OPT_OUT_ENV: "1"}), out, err))
        self.assertFalse(update.automatic_check_allowed(["health"], self.env, io.StringIO(), err))
        settings = update.read_settings()
        settings["checks_enabled"] = False
        update.write_settings(settings)
        self.assertFalse(update.automatic_check_allowed(["health"], self.env, out, err))

    def test_auto_install_is_gated_on_opt_in(self):
        result = {"ok": True, "latest": "0.10.20", "error": None, "assets": {}}
        with patch.object(update, "check", return_value=result), patch.object(update.BackgroundChecker, "auto_install") as install:
            checker = update.BackgroundChecker("0.10.19")
            checker._run()
            install.assert_not_called()
        settings = update.read_settings()
        settings["auto_install"] = True
        update.write_settings(settings)
        with patch.object(update, "check", return_value=result), patch.object(update.BackgroundChecker, "auto_install") as install:
            checker = update.BackgroundChecker("0.10.19")
            checker._run()
            install.assert_called_once_with()

    def test_settings_persist_and_check_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["update", "--auto", "on"]), 0)
        self.assertTrue(update.read_settings()["auto_install"])
        self.assertEqual(update.settings_path().stat().st_mode & 0o777, 0o600)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["update", "--auto", "status"]), 0)
            self.assertEqual(main(["update", "--checks", "off"]), 0)
        self.assertFalse(update.read_settings()["checks_enabled"])
        payload = {"ok": True, "checked": True, "latest": "0.10.21", "error": None, "assets": {}}
        with patch.object(update, "check", return_value=payload), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            status = main(["update", "--check", "--json"])
        self.assertEqual(status, 10)
        result = json.loads(out.getvalue())
        self.assertTrue(result["result"]["update_available"])
        self.assertEqual(err.getvalue(), "")
        payload["latest"] = None
        with patch.object(update, "check", return_value=payload), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["update", "--check"]), 0)
        payload = {"ok": False, "checked": True, "latest": None, "error": "check failed: offline", "assets": {}}
        with patch.object(update, "check", return_value=payload), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(main(["update", "--check"]), 1)
        self.assertEqual(json.loads(out.getvalue())["error"]["message"], "check failed: offline")

    def test_notice_is_stderr_only_after_command(self):
        class Checker:
            def __init__(self, current):
                self.current = current

            def start(self):
                pass

            def notices(self, dim=False):
                return ["notice line", "dim line"]

        with patch.object(update, "automatic_check_allowed", return_value=True), \
             patch.object(update, "BackgroundChecker", Checker), \
             patch("cli.main.local_health", return_value={"ok": True}), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(main(["health"]), 0)
        self.assertEqual(json.loads(out.getvalue())["ok"], True)
        self.assertNotIn("notice line", out.getvalue())
        self.assertIn("notice line", err.getvalue())
        self.assertIn("dim line", err.getvalue())

    def test_checksum_mismatch_refuses(self):
        archive = self.base / "overseer-browser.tar.gz"
        archive.write_bytes(b"a verified release bundle")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertTrue(update.verify_sha256(archive, f"{digest}  overseer-browser.tar.gz\n", archive.name))
        self.assertFalse(update.verify_sha256(archive, "0" * 64 + "  overseer-browser.tar.gz\n", archive.name))
        self.assertFalse(update.verify_sha256(archive, "garbage\n", archive.name))
        installer = (ROOT / "scripts" / "install.sh").read_text()
        self.assertIn("checksum mismatch for $2", installer)
        self.assertIn("SHA256SUMS", installer)

    def test_rollback_restores_previous_release_from_fixture(self):
        home = self.base / "home"
        rollback = home / "rollback" / "previous"
        (rollback / "cli").mkdir(parents=True)
        (rollback / "extension" / ".output" / "chrome-mv3").mkdir(parents=True)
        (rollback / "scripts").mkdir(parents=True)
        (rollback / "cli" / "main.py").write_text('CLI_VERSION = "0.10.18"\n')
        (rollback / "extension" / ".output" / "chrome-mv3" / "manifest.json").write_text('{"name":"test"}')
        (rollback / "scripts" / "manage-macos.sh").write_text(
            '#!/bin/bash\nset -e\nmkdir -p "$OVERSEER_BROWSER_BIN_DIR"\n'
            'cp "$(dirname "$0")/fake-cli" "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n'
            'chmod 700 "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n')
        (rollback / "scripts" / "fake-cli").write_text(
            '#!/bin/sh\n# OverSeer Browser managed launcher\n'
            'printf \'%s\\n\' \'{"ok":true,"result":{"cli_version":"0.10.18"}}\'\n')
        current = home / "releases" / "release-0.10.19"
        current.mkdir(parents=True)
        (current / "marker").write_text("current")
        env = dict(os.environ, OVERSEER_BROWSER_HOME=str(home),
                   OVERSEER_BROWSER_BIN_DIR=str(self.base / "bin"), OSR_INSTALLER_LIB="1")
        command = '. "' + str(ROOT / "scripts" / "install.sh") + '"; rollback_install'
        result = subprocess.run(["sh", "-c", command], env=env, cwd=str(self.base),
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((home / "releases" / "release-0.10.18" / "cli" / "main.py").is_file())
        self.assertFalse(current.exists())
        self.assertFalse((home / "rollback" / "previous").exists())
        self.assertTrue((home / "extension" / "manifest.json").is_file())
        self.assertTrue((self.base / "bin" / "overseer-browser").is_file())

    def test_shipped_sources_use_the_project_release_repository(self):
        for relative in ("cli/update.py", "scripts/install.sh", "scripts/install.ps1"):
            self.assertNotIn("example-user", (ROOT / relative).read_text(), relative)
        # The build script only mentions the old slug in its negative guard.
        self.assertNotIn("example-user/overseer-browser", (ROOT / "scripts" / "build-release.sh").read_text())
        self.assertEqual(update.RELEASE_SLUG, EXPECTED_SLUG)
        self.assertEqual(update.release_url(), EXPECTED_API_URL)
        for relative in ("cli/update.py", "scripts/install.sh", "scripts/install.ps1"):
            self.assertIn(CANONICAL_REPOSITORY, (ROOT / relative).read_text(), relative)
        build = (ROOT / "scripts" / "build-release.sh").read_text()
        self.assertNotIn("PLACEHOLDER=", build)
        self.assertNotIn("sed \"s#$PLACEHOLDER#$slug#g\"", build)
        self.assertIn("<!-- update-contract: v1 -->", (ROOT / "docs" / "updates.md").read_text())
        privacy = (ROOT / "README.md").read_text()
        self.assertIn("anonymous HTTPS GET", privacy)


if __name__ == "__main__":
    unittest.main()
