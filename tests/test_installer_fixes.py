"""Regression tests for the 0.10.1 installer fixes.

Static checks guard the Windows-only code (PowerShell 5.1 is not available to CI); the shell
tests run the real platform installers against a copy of the working tree under a throwaway HOME.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BOOTSTRAP = (REPO / "scripts" / "install.ps1").read_text(encoding="utf-8")
WINDOWS = (REPO / "scripts" / "install-windows.ps1").read_text(encoding="utf-8")
BUILT_EXTENSION = REPO / "extension" / ".output" / "chrome-mv3" / "manifest.json"
MARKER = "# OverSeer Browser managed launcher"


def code_lines(text):
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


class WindowsStaticTests(unittest.TestCase):
    def test_platform_installer_runs_as_child_with_policy_bypass(self):
        self.assertIn("-ExecutionPolicy Bypass -File", BOOTSTRAP)
        self.assertNotRegex(BOOTSTRAP, r"&\s*\(Join-Path \$rel 'scripts/install-windows\.ps1'\)")
        self.assertRegex(BOOTSTRAP, r"install-windows\.ps1[^\n]*\n[^\n]*\n[^\n]*-ExecutionPolicy Bypass[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\)")

    def test_no_ascii_cmd_with_absolute_path_and_shim_is_marked(self):
        for name, text in (("install.ps1", BOOTSTRAP), ("install-windows.ps1", WINDOWS)):
            for line in code_lines(text):
                self.assertNotRegex(line, r"-Encoding\s+Ascii", f"{name}: {line}")
        self.assertIn("%LOCALAPPDATA%", BOOTSTRAP)
        self.assertIn("REM overseer-browser-shim", BOOTSTRAP)
        self.assertIn("Select-String -LiteralPath $shim", BOOTSTRAP)
        # The shim never embeds an absolute runtime path variable.
        self.assertNotIn("$runtimeRoot", BOOTSTRAP)

    def test_launchers_are_relative_and_oem_encoded(self):
        self.assertIn("%~dp0$RuntimeRel", WINDOWS)
        self.assertIn("OEMCodePage", WINDOWS)
        self.assertIn("$CmdEncoding", WINDOWS)
        for line in WINDOWS.splitlines():
            self.assertFalse(line.startswith('"$Python" -B "$') or line.startswith('set "PYTHONPATH=$Runtime"'), line)

    def test_no_setx_advice(self):
        self.assertNotRegex(WINDOWS, r"(?i)setx")
        self.assertNotRegex(BOOTSTRAP, r"(?i)setx")

    def test_paths_are_literal(self):
        for name, text in (("install.ps1", BOOTSTRAP), ("install-windows.ps1", WINDOWS)):
            for line in code_lines(text):
                for cmdlet in ("Test-Path", "Remove-Item", "Get-ChildItem", "Copy-Item", "Get-Content", "Get-FileHash"):
                    for match in re.finditer(r"(?<!\| )" + cmdlet + r"\b([^|;{}]*)", line):
                        rest = match.group(1)  # a cmdlet fed by a pipeline has no path argument
                        self.assertIn("-LiteralPath", rest, f"{name}: {line.strip()}")

    def test_session_state_stays_in_function_and_home_is_normalised(self):
        first_function = BOOTSTRAP.index("function Install-OverSeerBrowser")
        self.assertGreater(BOOTSTRAP.index("$ErrorActionPreference = 'Stop'"), first_function)
        self.assertNotRegex(BOOTSTRAP, r"(?m)^\s*exit\b")
        self.assertIn("GetUnresolvedProviderPathFromPSPath($HomeDir)", BOOTSTRAP)
        self.assertIn("GetUnresolvedProviderPathFromPSPath($BinDir)", BOOTSTRAP)
        self.assertIn("Tls12", BOOTSTRAP)
        self.assertIn("$ProgressPreference = 'SilentlyContinue'", BOOTSTRAP)


class ShimOwnershipTests(unittest.TestCase):
    def _pattern(self):
        match = re.search(r"\$legacyShimPattern = '([^\n]*)'\n", BOOTSTRAP)
        self.assertIsNotNone(match, "legacy shim pattern missing from install.ps1")
        return re.compile(match.group(1))

    def test_legacy_010_shim_is_recognised_as_ours(self):
        pattern = self._pattern()
        for body in (
            '@echo off\r\n"C:\\Users\\Ann\\AppData\\Local\\OverSeer\\browser\\overseer-browser.cmd" %*\r\n',
            '@echo off\r\n"C:\\Users\\Jos?\\AppData\\Local\\OverSeer\\browser\\overseer-browser.cmd" %*',
            '@echo off\n"D:\\x\\OverSeer\\browser\\overseer-browser.cmd" %*\n',
        ):
            self.assertRegex(body, pattern)

    def test_user_files_are_not_mistaken_for_the_legacy_shim(self):
        pattern = self._pattern()
        for body in (
            '@echo off\r\n"C:\\tools\\overseer-browser.cmd" %*\r\n',
            '@echo off\r\n"C:\\a\\OverSeer\\browser\\overseer-browser.cmd" %*\r\necho extra\r\n',
            '@echo off\r\nrem mine\r\n"C:\\a\\OverSeer\\browser\\overseer-browser.cmd" %*\r\n',
        ):
            self.assertNotRegex(body, pattern)

    def test_ownership_check_wired_in_and_bin_dir_env_restored(self):
        self.assertIn("Get-Content -LiteralPath $shim -Raw", BOOTSTRAP)
        self.assertIn("$shimBody -match $legacyShimPattern", BOOTSTRAP)
        self.assertIn("$savedBinDirEnv = $env:OVERSEER_BROWSER_BIN_DIR", BOOTSTRAP)
        finally_part = BOOTSTRAP[BOOTSTRAP.rindex("} finally {"):]
        self.assertIn("$env:OVERSEER_BROWSER_BIN_DIR = $savedBinDirEnv", finally_part)


@unittest.skipUnless(BUILT_EXTENSION.is_file(), "needs a built extension (npm run build --prefix extension)")
class ShellInstallerTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="osr-fix-")
        self.addCleanup(self._temporary.cleanup)
        self.base = Path(self._temporary.name)
        self.src = self.base / "src"
        for name in ("cli", "native_host", "scripts", "extension"):
            ignore = shutil.ignore_patterns("node_modules", "__pycache__", ".wxt", "src", "tests")
            if name == "extension":
                (self.src / "extension" / ".output").mkdir(parents=True)
                shutil.copytree(REPO / "extension" / ".output" / "chrome-mv3",
                                self.src / "extension" / ".output" / "chrome-mv3")
                (self.src / "extension" / "package.json").write_text((REPO / "extension" / "package.json").read_text())
            else:
                shutil.copytree(REPO / name, self.src / name, ignore=ignore)
        self.home = self.base / "home"
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), XDG_DATA_HOME=str(self.home / "data"),
                        XDG_CONFIG_HOME=str(self.home / "config"), TMPDIR=str(self.base),
                        OVERSEER_BROWSER_RUNTIME=str(self.home / "runtime"))
        for key in ("OVERSEER_BROWSER_BIN_DIR", "OVERSEER_BROWSER_CONNECTION", "OVERSEER_BROWSER_PREBUILT_EXTENSION"):
            self.env.pop(key, None)

    def run_script(self, args, **extra):
        env = dict(self.env, **extra)
        return subprocess.run(args, env=env, cwd=self.base, text=True, capture_output=True, timeout=300)

    def test_linux_installer_never_overwrites_unrelated_command(self):
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        foreign = bin_dir / "overseer-browser"
        foreign.write_text("#!/bin/sh\necho someone else's tool\n")
        foreign.chmod(0o755)
        result = self.run_script(["bash", str(self.src / "scripts" / "install-linux.sh")],
                                 OVERSEER_BROWSER_BIN_DIR=str(bin_dir))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(foreign.read_text(), "#!/bin/sh\necho someone else's tool\n")
        self.assertIn("not managed; preserving it", result.stdout)
        fallback = self.home / "data" / "overseer-browser" / "overseer-browser"
        self.assertTrue(fallback.is_file())
        self.assertEqual(fallback.read_text().splitlines()[1], MARKER)

    def test_linux_installer_updates_its_own_launcher(self):
        bin_dir = self.base / "bin"
        for _ in range(2):
            result = self.run_script(["bash", str(self.src / "scripts" / "install-linux.sh")],
                                     OVERSEER_BROWSER_BIN_DIR=str(bin_dir))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((bin_dir / "overseer-browser").read_text().splitlines()[1], MARKER)

    @unittest.skipUnless(sys.platform == "darwin", "macOS platform installer")
    def test_macos_bin_dir_override_beats_saved_launcher_path(self):
        first = self.base / "bin1"
        second = self.base / "bin2"
        for target in (first, second):
            result = self.run_script(["bash", str(self.src / "scripts" / "manage-macos.sh"), "install"],
                                     OVERSEER_BROWSER_BIN_DIR=str(target),
                                     OVERSEER_BROWSER_PREBUILT_EXTENSION="1")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((target / "overseer-browser").is_file(), f"no launcher in {target}")


if __name__ == "__main__":
    unittest.main()
