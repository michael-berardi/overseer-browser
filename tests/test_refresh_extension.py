"""refresh-extension: put the installed version into the folder Chrome loaded (synthetic HOME; no browser)."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from cli.main import CLI_VERSION, _extension_update_hint

REPO = Path(__file__).resolve().parents[1]
KEY = 'MIIB-test-key'


class RefreshExtensionTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        root = self.base / 'checkout'
        (root / 'scripts').mkdir(parents=True)
        shutil.copy2(REPO / 'scripts/manage-macos.sh', root / 'scripts/manage-macos.sh')
        for package in ('cli', 'native_host'):
            (root / package).mkdir()
            for source in (REPO / package).glob('*.py'):
                shutil.copy2(source, root / package / source.name)
        built = root / 'extension/.output/chrome-mv3'
        built.mkdir(parents=True)
        (built / 'manifest.json').write_text(json.dumps({'manifest_version': 3, 'name': 'OverSeer Browser', 'version': '9.9.9', 'key': KEY}))
        (built / 'background.js').write_text('// new build')
        (root / 'extension/package.json').write_text('{}')
        npm = self.base / 'npm'
        npm.write_text('#!/bin/sh\nexit 0\n')
        npm.chmod(0o700)
        self.home = self.base / 'home'
        self.home.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), PYTHON=sys.executable, NPM=str(npm),
                        OVERSEER_BROWSER_BIN_DIR=str(self.home / 'bin'), TMPDIR=str(self.base),
                        OVERSEER_BROWSER_SKIP_ACTIVITY_CHECK='1')
        self.script = root / 'scripts/manage-macos.sh'
        result = self.run_script('install')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.app = self.home / 'Library/Application Support/OverSeer/browser'

    def run_script(self, action, **extra):
        return subprocess.run(['bash', str(self.script), action], env=dict(self.env, **extra), cwd=self.base, text=True, capture_output=True)

    def loaded(self, version='0.0.1', key=KEY, name='OverSeer Browser'):
        folder = self.base / 'loaded' / 'chrome-extension'
        folder.mkdir(parents=True)
        (folder / 'manifest.json').write_text(json.dumps({'manifest_version': 3, 'name': name, 'version': version, 'key': key}))
        (folder / 'background.js').write_text('// old build')
        return folder

    def test_puts_the_installed_version_into_the_loaded_folder_and_keeps_one_previous(self):
        folder = self.loaded()
        result = self.run_script('refresh-extension', OVERSEER_BROWSER_LOADED_EXTENSION=str(folder))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((folder / 'manifest.json').read_text())['version'], '9.9.9')
        self.assertEqual((folder / 'background.js').read_text(), '// new build')
        previous = self.app / 'rollback-extension-previous'
        self.assertEqual(json.loads((previous / 'manifest.json').read_text())['version'], '0.0.1')
        self.assertIn('click Reload', result.stdout)
        self.assertFalse(list(folder.parent.glob('.overseer-extension-*')))
        again = self.run_script('refresh-extension', OVERSEER_BROWSER_LOADED_EXTENSION=str(folder))
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already holds 9.9.9', again.stdout)

    def test_never_touches_a_folder_that_is_not_this_extension(self):
        folder = self.loaded(key='someone-else')
        result = self.run_script('refresh-extension', OVERSEER_BROWSER_LOADED_EXTENSION=str(folder))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not this extension', result.stdout + result.stderr)
        self.assertEqual(json.loads((folder / 'manifest.json').read_text())['version'], '0.0.1')

    def test_an_immutable_runtime_folder_is_left_alone(self):
        runtime = next((self.app / 'runtimes').iterdir()) / 'extension'
        before = (runtime / 'manifest.json').read_text()
        result = self.run_script('refresh-extension', OVERSEER_BROWSER_LOADED_EXTENSION=str(runtime))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Load unpacked', result.stdout)
        self.assertEqual((runtime / 'manifest.json').read_text(), before)

    def test_status_names_an_older_loaded_extension(self):
        self.assertIsNone(_extension_update_hint(CLI_VERSION))
        self.assertIsNone(_extension_update_hint(None))
        hint = _extension_update_hint('0.0.1')
        self.assertEqual((hint['loaded'], hint['installed']), ('0.0.1', CLI_VERSION))
        self.assertIn('refresh-extension', hint['hint'])


if __name__ == '__main__':
    unittest.main()
