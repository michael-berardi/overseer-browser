"""Focused lifecycle tests; no real Chrome, personal profile or windows touched."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from native_host.runtime import RuntimePaths
from native_host.isolation import isolated_paths, ensure_instance, supervise
from native_host.host import main as host_main
from cli.main import request_once


class IsolationTests(unittest.TestCase):
    def setUp(self):
        # Managed-instance tests must not inherit the operator's installed relay.
        discovery = patch('cli.main.find_active_runtime', return_value=None)
        discovery.start()
        self.addCleanup(discovery.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.base = RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')

    def test_separate_namespace(self):
        agent = isolated_paths(self.base)
        self.assertNotEqual(agent.socket, self.base.socket)
        self.assertEqual(agent.root, self.base.root / 'agent-v1')

    def test_personal_native_host_rejected_before_serve(self):
        with patch.dict('os.environ', {}, clear=True), patch('native_host.host.NativeHost.serve') as serve:
            self.assertEqual(host_main(['chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/']), 1)
            serve.assert_not_called()

    def test_attach_does_not_launch_another_chrome(self):
        with patch('native_host.isolation.connected', return_value=True), patch('native_host.isolation.subprocess.Popen') as launch:
            ensure_instance(isolated_paths(self.base), 1)
            launch.assert_not_called()

    def test_stop_preserves_other_sessions(self):
        with patch('cli.main.RuntimePaths.discover', return_value=self.base), patch('cli.main._request_once', side_effect=[{'ok': True, 'result': {'stopped': True}}, {'ok': True, 'result': [{'sessionKey': 'other'}]}]), patch('native_host.isolation.stop_instance') as stop:
            result = request_once('sessions.stop', {}, timeout=1, session_key='one')
            self.assertTrue(result['ok'])
            stop.assert_not_called()

    def test_last_stop_quits_only_owned_instance(self):
        with patch('cli.main.RuntimePaths.discover', return_value=self.base), patch('cli.main._request_once', side_effect=[{'ok': True, 'result': {'stopped': True}}, {'ok': True, 'result': []}]), patch('native_host.isolation.stop_instance') as stop:
            request_once('sessions.stop', {}, timeout=1)
            stop.assert_called_once_with(isolated_paths(self.base))

    def test_launch_has_own_profile_and_shutdown_uses_child_handle(self):
        root = isolated_paths(self.base).root
        root.mkdir()
        (root / 'quit').touch()
        with patch('native_host.isolation.subprocess.Popen') as launch:
            child = launch.return_value
            child.pid = 123
            child.poll.return_value = None
            supervise(root, '/owned/chrome', '/owned/extension')
            argv = launch.call_args.args[0]
            self.assertIn(f'--user-data-dir={root / "profile"}', argv)
            self.assertEqual(launch.call_args.kwargs['env']['OVERSEER_BROWSER_RUNTIME'], str(root))
            child.terminate.assert_called_once()
            self.assertFalse((root / 'supervisor.running').exists())
