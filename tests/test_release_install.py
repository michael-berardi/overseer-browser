"""One-step release installer checks on macOS, always in a throwaway HOME.

Skipped unless OVERSEER_BROWSER_TEST_DIST points at a built dist/release folder
(scripts/test-install.sh builds it and sets the variable). Never touches the
real HOME, the real Chrome profile, or any running OverSeer Browser runtime.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
DIST = os.environ.get("OVERSEER_BROWSER_TEST_DIST", "")
CLI_VERSION = re.search(r'^CLI_VERSION = "([^"]+)"',
                        (REPO / "cli" / "main.py").read_text(), re.MULTILINE).group(1)


@unittest.skipUnless(sys.platform == "darwin", "macOS one-step installer test")
@unittest.skipUnless(DIST, "set OVERSEER_BROWSER_TEST_DIST to a built dist/release (scripts/test-install.sh does)")
class ReleaseInstallTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="osr-release-test-")
        self.addCleanup(self._temporary.cleanup)
        self.base = Path(self._temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.tool_home = self.home / ".overseer-browser"
        self.bin_dir = self.home / "bin"
        self.env = dict(
            os.environ,
            HOME=str(self.home),
            OVERSEER_BROWSER_HOME=str(self.tool_home),
            OVERSEER_BROWSER_BIN_DIR=str(self.bin_dir),
            OVERSEER_BROWSER_RUNTIME=str(self.home / "runtime"),
            OVERSEER_BROWSER_RELEASE_BASE="file://" + DIST,
            XDG_DATA_HOME=str(self.home / "data"),
            XDG_CONFIG_HOME=str(self.home / "config"),
            TMPDIR=str(self.base),
        )
        self.env.pop("OVERSEER_BROWSER_CONNECTION", None)
        self.env.pop("OVERSEER_BROWSER_PREBUILT_EXTENSION", None)

    def install(self, env=None):
        return subprocess.run(["sh", str(REPO / "scripts" / "install.sh")],
                              env=env or self.env, cwd=self.base,
                              text=True, capture_output=True, timeout=300)

    def cli(self, *args):
        return subprocess.run([str(self.bin_dir / "overseer-browser"), *args],
                              env=self.env, cwd=self.base,
                              text=True, capture_output=True, timeout=120)

    def test_install_upgrade_and_version(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        launcher = self.bin_dir / "overseer-browser"
        self.assertTrue(launcher.is_file(), "CLI launcher was not installed")
        version = self.cli("--version")
        self.assertEqual(version.returncode, 0, version.stdout + version.stderr)
        self.assertEqual(json.loads(version.stdout)["result"]["cli_version"], CLI_VERSION)
        # The stable Load unpacked folder and the per-user native manifest exist under the throwaway HOME.
        self.assertTrue((self.tool_home / "extension" / "manifest.json").is_file())
        manifest = (self.home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
                    / "com.paretocybernetics.overseer_browser.json")
        self.assertTrue(manifest.is_file(), "native messaging manifest missing in throwaway HOME")
        self.assertIn(str(self.home), json.loads(manifest.read_text())["path"])
        # Re-running upgrades in place and keeps exactly one release folder.
        again = self.install()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        releases = list((self.tool_home / "releases").glob("release-*"))
        self.assertEqual(len(releases), 1)
        self.assertEqual(self.cli("--version").returncode, 0)

    def test_corrupt_archive_refused(self):
        corrupt = self.base / "corrupt-dist"
        shutil.copytree(DIST, corrupt)
        with open(corrupt / "overseer-browser.tar.gz", "ab") as stream:
            stream.write(b"corrupted bytes")
        env = dict(self.env, OVERSEER_BROWSER_RELEASE_BASE="file://" + str(corrupt))
        result = self.install(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse((self.bin_dir / "overseer-browser").exists())
        self.assertFalse((self.tool_home / "releases").exists())

    def test_missing_python_named(self):
        fakebin = self.base / "fakebin"
        fakebin.mkdir()
        fake_python = fakebin / "python3"
        fake_python.write_text("#!/bin/sh\nexit 1\n")
        fake_python.chmod(0o700)
        env = dict(self.env, PATH=str(fakebin) + os.pathsep + os.environ["PATH"])
        result = self.install(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.9", result.stderr)
        self.assertFalse((self.bin_dir / "overseer-browser").exists())


if __name__ == "__main__":
    unittest.main()