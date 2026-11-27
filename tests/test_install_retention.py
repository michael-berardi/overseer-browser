"""Retention bounds for the installer's own local writes.

Every local write is inventoried in PRIVACY.md with a lifetime. These tests run the
real installer functions against a throwaway HOME and temp root: no network, no
platform install, no browser, and no writes outside the temporary tree.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]
INSTALLER = REPO / "scripts" / "install.sh"
MARKER = "# OverSeer Browser managed launcher"


class InstallerRetentionTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="osr-retention-test-")
        self.addCleanup(self._temporary.cleanup)
        self.base = Path(self._temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.tool_home = self.base / "install"
        self.bin_dir = self.base / "bin"
        self.tmp = self.base / "tmp"
        self.tmp.mkdir()
        self.app = (self.home / "Library/Application Support/OverSeer/browser"
                    if sys.platform == "darwin" else self.home / "data/overseer-browser")
        self.env = dict(
            os.environ,
            HOME=str(self.home),
            OVERSEER_BROWSER_HOME=str(self.tool_home),
            OVERSEER_BROWSER_BIN_DIR=str(self.bin_dir),
            TMPDIR=str(self.tmp),
            XDG_DATA_HOME=str(self.home / "data"),
            XDG_CONFIG_HOME=str(self.home / "config"),
            OSR_INSTALLER_LIB="1",
        )

    def run_functions(self, body: str):
        """Source the installer (functions only) and run the requested retention function."""
        return subprocess.run(["sh", "-c", '. "$0"; ' + body, str(INSTALLER)],
                              env=self.env, cwd=str(self.base), text=True,
                              capture_output=True, timeout=120)

    @staticmethod
    def age(path: Path, minutes: int) -> None:
        stamp = time.time() - minutes * 60
        os.utime(path, (stamp, stamp), follow_symlinks=False)

    def test_stale_installer_temp_is_swept_and_fresh_temp_is_kept(self):
        stale = self.tmp / "overseer-browser-install.ABCDEF"
        (stale / "src").mkdir(parents=True)
        (stale / "overseer-browser.tar.gz").write_text("archive")
        self.age(stale, 7 * 60)
        live = self.tmp / "overseer-browser-install.LIVE12"
        (live / "src").mkdir(parents=True)
        self.age(live, 1)
        unrelated = self.tmp / "other-download"
        unrelated.mkdir()
        self.age(unrelated, 7 * 60)

        result = self.run_functions("sweep_install_debris")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(stale.exists(), result.stdout)
        self.assertIn("Removed stale installer temp folder", result.stdout)
        self.assertTrue((live / "src").is_dir(), "a fresh installer temp folder must survive")
        self.assertTrue(unrelated.is_dir(), "unrelated temp folders are never swept")

    def test_stale_install_staging_and_platform_debris_is_swept(self):
        for directory in ("releases/release-0.10.18.tmp", "extension.tmp", "rollback/.restoring"):
            path = self.tool_home / directory
            path.mkdir(parents=True)
            (path / "partial").write_text("half staged")
            self.age(path, 3 * 60)
        stage = self.app / "runtimes" / ".stage-deadbeef"
        stage.mkdir(parents=True)
        (stage / "cli").write_text("stale")
        self.age(stage, 3 * 60)
        published = self.app / ".publish-stale"
        published.write_text("stale")
        self.age(published, 3 * 60)
        fresh = self.tool_home / "releases" / "release-0.11.9.tmp"
        fresh.mkdir()
        self.age(fresh, 1)
        fresh_stage = self.app / "runtimes" / ".stage-fresh1"
        fresh_stage.mkdir()

        result = self.run_functions("sweep_install_debris")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(stage.exists())
        self.assertFalse(published.exists())
        self.assertFalse((self.tool_home / "rollback" / ".restoring").exists())
        self.assertFalse((self.tool_home / "releases" / "release-0.10.18.tmp").exists())
        self.assertIn("Removed stale runtime staging folder", result.stdout)
        self.assertIn("Removed stale publish temp file", result.stdout)
        self.assertTrue(fresh.is_dir(), "a fresh staging folder must survive")
        self.assertTrue(fresh_stage.is_dir(), "a fresh runtime stage must survive")

    def release_tree(self, version: str, cli_version: str, name: str) -> Path:
        """A staged release bundle whose platform installer drops a matching fake CLI."""
        source = self.base / name
        (source / "cli").mkdir(parents=True)
        (source / "cli" / "main.py").write_text(f'CLI_VERSION = "{version}"\n')
        (source / "extension" / ".output" / "chrome-mv3").mkdir(parents=True)
        (source / "extension" / ".output" / "chrome-mv3" / "manifest.json").write_text('{"name": "test"}')
        (source / "scripts").mkdir()
        (source / "scripts" / "fake-cli").write_text(
            "#!/bin/sh\n" + MARKER + "\n"
            f"printf '%s\\n' '{{\"ok\":true,\"result\":{{\"cli_version\":\"{cli_version}\"}}}}'\n")
        for installer in ("manage-macos.sh", "install-linux.sh"):
            (source / "scripts" / installer).write_text(
                "#!/bin/sh\nset -e\n"
                'mkdir -p "$OVERSEER_BROWSER_BIN_DIR"\n'
                'cp "$(dirname "$0")/fake-cli" "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n'
                'chmod 700 "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n')
        return source

    def retained_previous(self) -> Path:
        """What an update leaves behind: the release it displaced, kept for --rollback."""
        tree = self.release_tree("0.11.1", "0.11.1", "displaced")
        (tree / "marker").write_text("displaced release")
        previous = self.tool_home / "rollback" / "previous"
        previous.parent.mkdir(parents=True)
        tree.rename(previous)
        (self.tool_home / "releases").mkdir(parents=True, exist_ok=True)
        return previous

    def test_successful_install_deletes_the_retained_previous_release(self):
        previous = self.retained_previous()
        source = self.release_tree("0.11.2", "0.11.2", "downloaded")
        result = self.run_functions(
            f'finalize_install "{self.tool_home}/releases/release-0.11.2" 0.11.2 "{source}"')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(previous.exists(), "a successful run must not keep the previous release")
        self.assertIn("Removed the retained previous release", result.stdout)
        self.assertFalse((self.tool_home / "rollback").exists())
        self.assertTrue((self.tool_home / "releases" / "release-0.11.2" / "cli" / "main.py").is_file())
        self.assertTrue((self.bin_dir / "overseer-browser").is_file())

    def test_failed_install_keeps_the_retained_previous_release_for_rollback(self):
        previous = self.retained_previous()
        # The staged CLI reports a version other than the release being installed:
        # that check failing is exactly what keeps the rollback copy alive.
        source = self.release_tree("0.11.2", "0.9.9", "downloaded")
        result = self.run_functions(
            f'finalize_install "{self.tool_home}/releases/release-0.11.2" 0.11.2 "{source}"')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("the installed CLI reports", result.stderr)
        self.assertTrue(previous.exists(), "a failed run must keep the rollback copy")
        self.assertEqual((previous / "marker").read_text(), "displaced release")
        restore = self.run_functions("rollback_install")
        self.assertEqual(restore.returncode, 0, restore.stdout + restore.stderr)
        self.assertIn("Rolled back to OverSeer Browser 0.11.1", restore.stdout)
        self.assertFalse(previous.exists())
        self.assertTrue((self.tool_home / "releases" / "release-0.11.1" / "cli" / "main.py").is_file())

    def test_a_symlinked_previous_release_is_never_deleted(self):
        elsewhere = self.base / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "keep").write_text("not ours")
        rollback = self.tool_home / "rollback"
        rollback.mkdir(parents=True)
        (rollback / "previous").symlink_to(elsewhere, target_is_directory=True)
        result = self.run_functions("drop_previous_release")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Left the unexpected symlink", result.stdout)
        self.assertTrue((elsewhere / "keep").is_file())


class OneStepInstallerRetentionTests(unittest.TestCase):
    """End-to-end: the real install.sh against a file:// release base and a throwaway HOME."""

    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="osr-retention-e2e-")
        self.addCleanup(self._temporary.cleanup)
        self.base = Path(self._temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.tool_home = self.base / "install"
        self.bin_dir = self.base / "bin"
        self.tmp = self.base / "tmp"
        self.tmp.mkdir()
        self.dist = self.base / "dist"
        self.dist.mkdir()
        self.env = dict(
            os.environ,
            HOME=str(self.home),
            OVERSEER_BROWSER_HOME=str(self.tool_home),
            OVERSEER_BROWSER_BIN_DIR=str(self.bin_dir),
            TMPDIR=str(self.tmp),
            XDG_DATA_HOME=str(self.home / "data"),
            XDG_CONFIG_HOME=str(self.home / "config"),
            OVERSEER_BROWSER_RELEASE_BASE="file://" + str(self.dist),
        )
        for key in ("OVERSEER_BROWSER_VERSION", "OVERSEER_BROWSER_CONNECTION", "OVERSEER_BROWSER_AGENT"):
            self.env.pop(key, None)
        self.app = (self.home / "Library/Application Support/OverSeer/browser"
                    if sys.platform == "darwin" else self.home / "data/overseer-browser")
        self.build_release("0.11.2")

    @staticmethod
    def age(path: Path, minutes: int) -> None:
        stamp = time.time() - minutes * 60
        os.utime(path, (stamp, stamp), follow_symlinks=False)

    def build_release(self, version: str) -> None:
        tree = self.base / "release-tree"
        (tree / "cli").mkdir(parents=True, exist_ok=True)
        (tree / "cli" / "main.py").write_text(f'CLI_VERSION = "{version}"\n')
        (tree / "native_host").mkdir(exist_ok=True)
        (tree / "native_host" / "host.py").write_text("# fake host\n")
        (tree / "extension" / ".output" / "chrome-mv3").mkdir(parents=True, exist_ok=True)
        (tree / "extension" / ".output" / "chrome-mv3" / "manifest.json").write_text('{"name": "test"}')
        (tree / "scripts").mkdir(exist_ok=True)
        (tree / "scripts" / "fake-cli").write_text(
            "#!/bin/sh\n" + MARKER + "\n"
            f"printf '%s\\n' '{{\"ok\":true,\"result\":{{\"cli_version\":\"{version}\"}}}}'\n")
        for installer in ("manage-macos.sh", "install-linux.sh"):
            (tree / "scripts" / installer).write_text(
                "#!/bin/sh\nset -e\n"
                'mkdir -p "$OVERSEER_BROWSER_BIN_DIR"\n'
                'cp "$(dirname "$0")/fake-cli" "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n'
                'chmod 700 "$OVERSEER_BROWSER_BIN_DIR/overseer-browser"\n')
        archive = self.dist / "overseer-browser.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for child in sorted(tree.iterdir()):
                tar.add(child, arcname=child.name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.dist / "SHA256SUMS").write_text(f"{digest}  overseer-browser.tar.gz\n")

    def test_install_sweeps_stale_debris_and_drops_the_previous_release(self):
        displaced = self.tool_home / "releases" / "release-0.10.18"
        (displaced / "cli").mkdir(parents=True)
        (displaced / "cli" / "main.py").write_text('CLI_VERSION = "0.10.18"\n')
        stale_temp = self.tmp / "overseer-browser-install.KILLED"
        (stale_temp / "src").mkdir(parents=True)
        self.age(stale_temp, 24 * 60)
        stale_stage = self.app / "runtimes" / ".stage-killed1"
        stale_stage.mkdir(parents=True)
        self.age(stale_stage, 24 * 60)

        result = subprocess.run(["sh", str(INSTALLER)], env=self.env, cwd=str(self.base),
                                text=True, capture_output=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Removed stale installer temp folder", result.stdout)
        self.assertIn("Removed stale runtime staging folder", result.stdout)
        self.assertIn("Previous release staged at", result.stdout)
        self.assertIn("Removed the retained previous release", result.stdout)
        self.assertFalse(stale_temp.exists())
        self.assertFalse(stale_stage.exists())
        self.assertFalse((self.tool_home / "rollback" / "previous").exists(),
                         "a successful install must not leave the previous release behind")
        self.assertFalse(displaced.exists())
        self.assertTrue((self.tool_home / "releases" / "release-0.11.2" / "cli" / "main.py").is_file())
        self.assertFalse(list(self.tmp.glob("overseer-browser-install.*")), result.stdout)
        self.assertTrue((self.bin_dir / "overseer-browser").is_file())


class RetentionDocumentationTests(unittest.TestCase):
    def test_privacy_inventory_lists_every_local_write_with_a_lifetime(self):
        privacy = (REPO / "PRIVACY.md").read_text(encoding="utf-8")
        self.assertIn("## Local writes, lifetimes, and automatic cleanup", privacy)
        for write in ("host.log", "agent-v1/chrome.log", "update-check.json",
                      "update-install.log", "rollback/previous",
                      "overseer-browser-install.*", "overseer-media-v1-",
                      "overseer-outputs-v1-", "extension.tmp"):
            self.assertIn(write, privacy, write)
        self.assertIn("### Deleting local data", privacy)
        updates = " ".join((REPO / "docs" / "updates.md").read_text(encoding="utf-8").split())
        self.assertIn("a successful update leaves no previous release", updates)
        self.assertNotIn("must be removed manually", updates)
        install = " ".join((REPO / "docs" / "install.md").read_text(encoding="utf-8").split())
        self.assertIn("a successful update deletes the copy", install)

    def test_readme_privacy_stays_short_and_links_the_detail(self):
        readme = (REPO / "README.md").read_text(encoding="utf-8")
        section = readme[readme.index("## Privacy\n"):readme.index("## Reference\n")].strip()
        lines = [line for line in section.splitlines() if line.strip()]
        self.assertEqual(lines[0], "## Privacy")
        self.assertGreaterEqual(len(lines) - 1, 3, section)
        self.assertLessEqual(len(lines) - 1, 6, section)
        self.assertIn("[PRIVACY.md](PRIVACY.md)", section)
        self.assertIn("anonymous HTTPS GET", section)
        # Detail belongs to PRIVACY.md, not to the README summary.
        self.assertNotIn("agent-v1/chrome.log", section)
        self.assertNotIn("User-Agent", section)


if __name__ == "__main__":
    unittest.main()
