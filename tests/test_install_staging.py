"""Installer checks: synthetic checkout/build, fake HOME; never start a browser/host."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]


class InstallStagingTests(unittest.TestCase):
    def exercise(self, script):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'checkout'
            (root / 'scripts').mkdir(parents=True)
            shutil.copy2(REPO / 'scripts' / script, root / 'scripts' / script)
            for package in ('cli', 'native_host'):
                (root / package).mkdir()
                for source in (REPO / package).glob('*.py'):
                    shutil.copy2(source, root / package / source.name)
            (root / '.env').write_text('SECRET=not-for-install')
            loaded = root / 'chrome-extension'
            loaded.mkdir()
            (loaded / 'manifest.json').write_text('existing loaded tree; do not touch')
            built = root / 'extension/.output/chrome-mv3'
            built.mkdir(parents=True)
            (built / 'manifest.json').write_text(json.dumps({'manifest_version': 3}))
            (built / 'background.js').write_text('// synthetic build')
            (root / 'extension/package.json').write_text('{}')
            (root / 'extension/node_modules').mkdir()
            npm = base / 'npm'
            npm.write_text('#!/bin/sh\nexit 0\n')
            npm.chmod(0o700)
            home = base / 'home'
            home.mkdir()
            env = dict(os.environ, HOME=str(home), PYTHON=sys.executable, NPM=str(npm),
                       XDG_DATA_HOME=str(home / 'data'), XDG_CONFIG_HOME=str(home / 'config'),
                       OVERSEER_BROWSER_BIN_DIR=str(home / 'bin'), TMPDIR=str(base))
            app = home / ('Library/Application Support/OverSeer/browser' if 'macos' in script
                          else 'data/overseer-browser')
            command = ['bash', str(root / 'scripts' / script), 'install']

            def install(ok=True):
                result = subprocess.run(command, env=env, cwd=base, text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                self.assertFalse(list(app.rglob('.stage-*')))
                self.assertFalse(list(home.rglob('.publish-*')))
                return result

            result = install()
            self.assertIn('permissions', result.stdout)
            first = next((app / 'runtimes').iterdir())
            snapshot = {str(p.relative_to(first)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in first.rglob('*') if p.is_file()}
            for module in ('runtime_discovery', 'evidence', 'recording', 'dom_query'):
                self.assertTrue((first / 'cli' / (module + '.py')).is_file())
            self.assertFalse((first / '.env').exists())
            self.assertFalse(list(first.rglob('__pycache__')))
            launcher = home / 'bin/overseer-browser'
            check = subprocess.run([str(launcher), '--help'], env=env, cwd=base, capture_output=True)
            self.assertEqual(check.returncode, 0, check.stderr)
            manifests = {p: p.read_bytes() for p in home.rglob('com.imploselabs.overseer_browser.json')}
            self.assertTrue(manifests)
            previous = launcher.read_bytes()
            host_previous = (app / 'overseer-browser-native-host').read_bytes()
            module = root / 'cli/dom_query.py'
            original = module.read_text()
            module.write_text('this is not valid python!')
            for _ in range(2):
                install(False)
            self.assertEqual({p: p.read_bytes() for p in manifests}, manifests)
            self.assertEqual(launcher.read_bytes(), previous)
            self.assertEqual((app / 'overseer-browser-native-host').read_bytes(), host_previous)
            self.assertEqual(len(list((app / 'runtimes').iterdir())), 1)
            module.write_text(original)
            (built / 'background.js').write_text('// updated synthetic build')
            install()
            self.assertEqual((loaded / 'manifest.json').read_text(), 'existing loaded tree; do not touch')
            self.assertEqual(len(list((app / 'runtimes').iterdir())), 2)
            self.assertNotEqual(launcher.read_bytes(), previous)
            # CLI execution must not mutate the immutable runtime either.
            after = {str(p.relative_to(first)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in first.rglob('*') if p.is_file()}
            self.assertEqual(snapshot, after)

    def test_macos_staging(self):
        self.exercise('manage-macos.sh')

    def test_linux_staging(self):
        self.exercise('install-linux.sh')


if __name__ == '__main__':
    unittest.main()
