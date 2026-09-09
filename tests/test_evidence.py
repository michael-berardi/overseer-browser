from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cli import evidence
from cli.main import CLIError, CLI_VERSION, _materialize_screenshot, main


def response(command, params):
    if command == 'screenshot.visible':
        return {'ok': True, 'result': {'data': base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode(), 'format': 'png'}}
    return {'ok': True, 'result': {'command': command}}


class EvidenceTests(unittest.TestCase):
    def test_refuses_symlink_parent_and_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            link = root / 'link'
            link.symlink_to(root, target_is_directory=True)
            for path in (link / 'pack', root / '..' / 'escape-pack'):
                with self.assertRaises(ValueError):
                    evidence.collect(path, response, _materialize_screenshot, CLI_VERSION, 's')
            self.assertFalse((root / 'pack').exists())

    def test_pack_separate_private_artifacts_and_targeting(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'pack'
            with patch('cli.main.request_once', side_effect=response) as request:
                with contextlib.redirect_stdout(io.StringIO()):
                    # Adapt mock to keyword-only transport options.
                    request.side_effect = lambda cmd, params, **kw: response(cmd, params)
                    code = main(['--session', 'my-test', '--tab-id', '42', 'qa', 'pack', str(directory), '--raw-json'])
            self.assertEqual(code, 0)
            self.assertEqual([c.args[0] for c in request.call_args_list], ['snapshot', 'screenshot.visible', 'console.read', 'network.read'])
            for call in request.call_args_list:
                self.assertEqual(call.kwargs['session_key'], 'my-test')
                self.assertEqual(call.args[1]['tab_id'], 42)
            manifest = json.loads((directory / 'manifest.json').read_text())
            self.assertTrue(manifest['complete'])
            self.assertEqual(len(manifest['artifacts']), 4)
            self.assertNotIn('data', json.loads((directory / 'screenshot.png.json').read_text())['result'])
            if os.name != 'nt':
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                for file in directory.iterdir():
                    self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_partial_errors_do_not_stop_other_artifacts(self):
        def partial(command, params):
            if command == 'snapshot':
                raise CLIError('disconnected', 'No extension')
            if command == 'console.read':
                return {'ok': False, 'error': {'code': 'not_started'}}
            return response(command, params)
        with tempfile.TemporaryDirectory() as root:
            result = evidence.collect(Path(root) / 'pack', partial, _materialize_screenshot, CLI_VERSION, 's')
            self.assertFalse(result['ok'])
            self.assertEqual(len(result['result']['errors']), 2)
            self.assertTrue((Path(root) / 'pack/network.json').exists())

    def test_refuses_existing_destination_and_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            for directory in [Path(root), Path(root) / 'link']:
                if directory.name == 'link':
                    directory.symlink_to(root, target_is_directory=True)
                with self.assertRaises(FileExistsError):
                    evidence.collect(directory, response, _materialize_screenshot, CLI_VERSION, 's')

    def test_doctor_drift_and_unknown_loaded_host(self):
        result = evidence.doctor(lambda *a: {'ok': True, 'result': {'extension_version': '0.4.1', 'multi_session': True}}, CLI_VERSION)
        self.assertFalse(result['ok'])
        self.assertEqual(result['result']['version_checks']['extension']['state'], 'drift')
        self.assertEqual(result['result']['version_checks']['host']['state'], 'unknown')
        self.assertTrue(result['result']['runtime_status']['result']['multi_session'])

    def test_doctor_transport_error(self):
        def failed(*a):
            raise CLIError('unavailable', 'not connected')
        self.assertFalse(evidence.doctor(failed, CLI_VERSION)['ok'])

    def test_timelapse_pacing_and_interrupt_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            with patch('cli.evidence.time.sleep') as sleep:
                result = evidence.collect(Path(root) / 'frames', response, _materialize_screenshot, CLI_VERSION, 's', frames=3, interval=2)
            self.assertTrue(result['ok'])
            self.assertEqual(sleep.call_count, 2)
            self.assertTrue(all(0 <= c.args[0] <= 2 for c in sleep.call_args_list))
            with patch('cli.evidence.time.sleep', side_effect=KeyboardInterrupt):
                result = evidence.collect(Path(root) / 'interrupted', response, _materialize_screenshot, CLI_VERSION, 's', frames=3)
            self.assertFalse(result['ok'])
            manifest = json.loads(Path(result['result']['manifest']).read_text())
            self.assertEqual(len(manifest['artifacts']), 1)
            self.assertEqual(manifest['errors'][0]['error']['code'], 'interrupted')

    def test_slow_frames_do_not_catch_up(self):
        clock = [0.0]
        sleeps = []
        def slow(command, params):
            clock[0] += 3.0
            return response(command, params)
        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
        with tempfile.TemporaryDirectory() as root:
            with patch('cli.evidence.time.monotonic', side_effect=lambda: clock[0]), patch('cli.evidence.time.sleep', side_effect=sleep):
                result = evidence.collect(Path(root) / 'frames', slow, _materialize_screenshot, CLI_VERSION, 's', frames=3)
            manifest = json.loads(Path(result['result']['manifest']).read_text())
            self.assertEqual([a['offset_seconds'] for a in manifest['artifacts']], [0, 3, 6])
            self.assertEqual(sleeps, [0, 0])

    def test_invalid_image_is_explicit_partial_failure(self):
        def corrupt(command, params):
            if command == 'screenshot.visible':
                return {'ok': True, 'result': {'data': 'invalid base64'}}
            return response(command, params)
        with tempfile.TemporaryDirectory() as root:
            result = evidence.collect(Path(root) / 'pack', corrupt, _materialize_screenshot, CLI_VERSION, 's')
            self.assertFalse(result['ok'])
            self.assertEqual(result['result']['errors'][0]['error']['code'], 'protocol_error')
            self.assertFalse((Path(root) / 'pack/screenshot.png').exists())

    def test_capture_requires_session(self):
        with patch.dict(os.environ, {}, clear=True), patch('cli.main.request_once') as request, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(['qa', 'pack', '/not-created', '--raw-json']), 1)
            request.assert_not_called()

    def test_source_versions_coherent(self):
        from native_host.host import HOST_VERSION
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(HOST_VERSION, CLI_VERSION)
        self.assertEqual(json.loads((root / 'extension/package.json').read_text())['version'], CLI_VERSION)
        lock = json.loads((root / 'extension/package-lock.json').read_text())
        self.assertEqual(lock['version'], CLI_VERSION)
        self.assertEqual(lock['packages']['']['version'], CLI_VERSION)
        self.assertIn("version: '" + CLI_VERSION + "'", (root / 'extension/wxt.config.ts').read_text())

    def test_invalid_options_do_not_contact_browser(self):
        cases = [['timelapse', '/not-created', '121', '2'],
                 ['timelapse', '/not-created', '2', 'nan'],
                 ['timelapse', '/not-created', '2', '0.1'],
                 ['qa', 'pack', '/not-created', '--request-id', 'duplicate'],
                 ['doctor', '--tab-id', '1']]
        with patch('cli.main.request_once') as request, contextlib.redirect_stdout(io.StringIO()):
            for args in cases:
                self.assertEqual(main(['--session', 'test', '--raw-json', *args]), 1)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
