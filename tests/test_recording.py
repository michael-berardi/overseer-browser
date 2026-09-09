import base64
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from cli.recording import export

class RecordingTests(TestCase):
    def test_invalid_path_format_never_stops(self):
        for path in ['/missing-parent/a.webm', 'capture.gif']:
            with self.assertRaises(ValueError): export(lambda *a: self.fail('request made'), path)

    def test_denied_and_wrong_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            for response in [{'ok': True, 'result': {'phase': 'denied'}}, {'ok': False, 'error': 'recording_wrong_session'}]:
                with self.assertRaises(ValueError): export(lambda *a: response, Path(tmp) / 'x.webm')

    def test_chunk_overflow_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            def request(cmd, params):
                return {'ok': True, 'result': {'phase': 'stopped', 'bytes': 1, 'chunks': 1} if cmd == 'record.stop' else {'index': 0, 'data': base64.b64encode(b'xx').decode()}}
            with self.assertRaises(ValueError): export(request, Path(tmp) / 'x.webm')
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_export_private_no_overwrite_and_clear(self):
        import os
        with tempfile.TemporaryDirectory() as tmp, patch('cli.recording.shutil.which', return_value=None):
            calls = []
            def request(cmd, params):
                calls.append(cmd)
                result = {'phase': 'stopped', 'bytes': 3, 'chunks': 1} if cmd == 'record.stop' else {'index': 0, 'data': 'YWJj'}
                return {'ok': True, 'result': result}
            path = Path(tmp) / 'x.webm'
            export(request, path)
            self.assertEqual(path.read_bytes(), b'abc')
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(calls[-1], 'record.clear')
            with self.assertRaises(ValueError): export(request, path)

    def test_mp4_encoder_failure_leaves_no_output(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp, patch('cli.recording.doctor', return_value={'mp4_h264': True}), patch('cli.recording.shutil.which', return_value='ffmpeg'), patch('cli.recording.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'ffmpeg')):
            def request(cmd, params):
                return {'ok': True, 'result': {'phase': 'stopped', 'bytes': 3, 'chunks': 1} if cmd == 'record.stop' else {'index': 0, 'data': 'YWJj'}}
            with self.assertRaises(subprocess.CalledProcessError): export(request, Path(tmp) / 'x.mp4')
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_oversized_encoded_chunk_and_expiration(self):
        with tempfile.TemporaryDirectory() as tmp:
            for state in [{'phase': 'expired'}, {'phase': 'stopped', 'bytes': 1, 'chunks': 1}]:
                def request(cmd, params):
                    return {'ok': True, 'result': state if cmd == 'record.stop' else {'index': 0, 'data': 'A' * 262145}}
                with self.assertRaises(ValueError): export(request, Path(tmp) / 'x.webm')
                self.assertEqual(list(Path(tmp).iterdir()), [])

class StagingTests(TestCase):
    def test_repeated_cycles_and_active_lease_protection(self):
        from cli import recording
        with tempfile.TemporaryDirectory() as tmp, patch('cli.recording._staging_root', return_value=Path(tmp)), patch('cli.recording._start_sweeper'):
            for _ in range(12):
                with recording.managed_staging() as directory:
                    marker = Path(directory) / '.lease'
                    import os
                    os.utime(marker, (0, 0))
                    recording.reap_staging()
                    self.assertTrue(marker.exists())
                self.assertEqual(list(Path(tmp).glob('lease-*')), [])

    def test_failed_unlink_is_retried_without_next_capture(self):
        from cli import recording
        with tempfile.TemporaryDirectory() as tmp, patch('cli.recording._staging_root', return_value=Path(tmp)), patch('cli.recording._start_sweeper'):
            original = Path.unlink
            def fail_media(path, *args, **kwargs):
                if path.name == 'capture.webm':
                    raise PermissionError('busy')
                return original(path, *args, **kwargs)
            with patch.object(Path, 'unlink', fail_media):
                with recording.managed_staging() as directory:
                    (Path(directory) / 'capture.webm').write_bytes(b'abc')
                recording.reap_staging()
                self.assertTrue(Path(directory).exists())
            # Timer/host entrypoint, not another allocation or operator command.
            recording.reap_staging()
            self.assertFalse(Path(directory).exists())

    def test_foreign_temp_and_kept_exports_untouched(self):
        from cli import recording
        with tempfile.TemporaryDirectory() as tmp, patch('cli.recording._staging_root', return_value=Path(tmp)):
            kept = Path(tmp) / 'lease-unmarked'
            kept.mkdir(); (kept / 'user.webm').write_bytes(b'keep')
            recording.reap_staging()
            self.assertEqual((kept / 'user.webm').read_bytes(), b'keep')
