import builtins
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from cli import temp_outputs as outputs, recording
from native_host.host import NativeHost


class OutputsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patch = patch('tempfile.gettempdir', return_value=self.tmp.name)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_repeated_capture_evicts_completed_outputs_without_waiting_for_ttl(self):
        with patch.object(outputs, 'MAX_COUNT', 2), patch.object(outputs, 'MAX_BYTES', 20):
            for n in range(30):
                path = self.root / f'cycle-{n}.png'
                with outputs.reservation(path, count=1, byte_limit=10) as files:
                    files.write_bytes(path, b'image')
                self.assertLessEqual(len(list(self.root.glob('cycle-*.png'))), 2)
            self.assertTrue(path.exists())

    def test_atomic_registry_failure_preserves_previous_journal(self):
        self.create()
        registry = outputs._root() / 'registry.json'
        before = registry.read_bytes()
        with patch.object(outputs.os, 'replace', side_effect=OSError('fixture')):
            with self.assertRaises(OSError):
                with outputs._registry() as rows:
                    rows.clear()
        self.assertEqual(registry.read_bytes(), before)
        self.assertIsInstance(json.loads(before), list)

    def test_crash_after_publication_is_recovered_without_next_writer(self):
        destination = self.root / 'crash.png'
        code = '''
import os
from pathlib import Path
from cli import temp_outputs as o
original = os.replace
def publish_then_crash(source, target):
    original(source, target)
    if Path(target).name == 'crash.png': os._exit(37)
os.replace = publish_then_crash
with o.reservation(os.environ['OUTPUT'], count=1, byte_limit=64) as files:
    files.write_bytes(os.environ['OUTPUT'], b'crash-proof')
'''
        env = dict(os.environ, TMPDIR=str(self.root), OUTPUT=str(destination))
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1], env=env, timeout=15)
        self.assertEqual(result.returncode, 37)
        self.assertEqual(destination.read_bytes(), b'crash-proof')
        self.expire()
        self.assertFalse(destination.exists())
        with patch('time.time', return_value=10**12):
            recording.reap_staging()

    def test_created_parent_directories_expire_only_when_empty(self):
        path = self.root / 'new' / 'nested' / 'frame.png'
        with outputs.reservation(path, count=3, byte_limit=16) as files:
            files.write_bytes(path, b'frame')
        self.expire()
        self.assertFalse((self.root / 'new').exists())
        self.assertTrue(self.root.exists())

    def test_publication_race_does_not_adopt_an_operator_edit(self):
        path = self.root / 'publication.png'
        replace = os.replace
        def edited(source, destination):
            replace(source, destination)
            if Path(destination).resolve() == path.resolve():
                path.write_bytes(b'operator annotation')
        with outputs.reservation(path, count=1, byte_limit=32) as files:
            with patch.object(outputs.os, 'replace', side_effect=edited):
                files.write_bytes(path, b'capture')
        self.expire()
        self.assertEqual(path.read_bytes(), b'operator annotation')

    def test_edit_during_capture_is_not_adopted_at_finalization(self):
        path = self.root / 'edited.png'
        with outputs.reservation(path, count=1, byte_limit=32) as files:
            files.write_bytes(path, b'capture')
            path.write_bytes(b'operator annotation')
        self.expire()
        self.assertEqual(path.read_bytes(), b'operator annotation')

    def test_tracked_writes_replace_manifest_and_preserve_foreign_additions(self):
        directory = self.root / 'evidence'
        with outputs.reservation(directory, count=2, byte_limit=32) as files:
            directory.mkdir()
            files.directory_created(directory)
            files.write_bytes(directory / 'manifest.json', b'first')
            files.write_bytes(directory / 'manifest.json', b'final')
            (directory / 'operator.txt').write_text('keep')
        self.expire()
        self.assertFalse((directory / 'manifest.json').exists())
        self.assertEqual((directory / 'operator.txt').read_text(), 'keep')

    def create(self, name='shot.png', keep=False):
        path = self.root / name
        with outputs.reservation(path, keep=keep, count=1, byte_limit=10) as files:
            path.write_bytes(b'image')
            if files is not None:
                files.append(path)
        return path

    def expire(self):
        with patch('cli.temp_outputs.time.time', return_value=10**12):
            outputs.reap_outputs()

    def test_idle_and_repeated_cycles(self):
        for _ in range(15):
            path = self.create()
            self.expire()
            self.assertFalse(path.exists())
        with outputs._registry() as rows:
            self.assertEqual(rows, [])

    def test_foreign_replacement_addition_and_modification(self):
        path = self.create()
        replacement = self.root / 'replacement'
        replacement.write_bytes(b'image')
        os.replace(replacement, path)
        foreign = self.root / 'foreign'
        foreign.write_text('keep')
        changed = self.create('changed.png')
        changed.write_text('changed')
        self.expire()
        self.assertTrue(all(p.exists() for p in (path, foreign, changed)))

    def test_keep_and_outside_temp(self):
        path = self.create(keep=True)
        with patch.object(outputs, 'eligible', return_value=False):
            other = self.create('export.png')
        self.expire()
        self.assertTrue(path.exists() and other.exists())

    def test_reservations_bound_active_writers(self):
        with outputs.reservation(self.root / 'a', byte_limit=outputs.MAX_BYTES, count=1):
            with self.assertRaisesRegex(ValueError, 'quota'):
                with outputs.reservation(self.root / 'b', byte_limit=1, count=1):
                    pass

    def test_host_timer(self):
        host = NativeHost.__new__(NativeHost)
        host._stop = Mock()
        host._stop.wait.side_effect = [False, False, True]
        with patch.object(recording, 'reap_staging') as staging, patch.object(outputs, 'reap_outputs') as temp:
            host._cleanup_once()  # startup tick
            host._cleanup_loop()
            self.assertEqual(staging.call_count, 3)
            self.assertEqual(temp.call_count, 3)

    def test_windows_import(self):
        original = builtins.__import__
        def no_fcntl(name, *args, **kwargs):
            if name == 'fcntl':
                raise ImportError('simulated Windows')
            return original(name, *args, **kwargs)
        try:
            with patch('builtins.__import__', side_effect=no_fcntl):
                importlib.reload(recording)
                import cli.main
                self.assertIsNone(recording.fcntl)
                with self.assertRaisesRegex(ValueError, 'POSIX'):
                    with recording.managed_staging():
                        pass
        finally:
            importlib.reload(recording)


if __name__ == '__main__':
    unittest.main()
