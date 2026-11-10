"""Focused lifecycle tests; no real Chrome, personal profile or windows touched."""
import json
import os
import tempfile
import time
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

    def test_default_bundle_discovery_prefers_immutable_runtime(self):
        from native_host.isolation import default_extension
        root = self.base.root
        for relative in ('extension', 'extension/.output/chrome-mv3', 'chrome-extension'):
            folder = root / relative
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'manifest.json').write_text('{}')
        self.assertEqual(default_extension(root), root / 'extension')
        (root / 'extension/manifest.json').unlink()
        self.assertEqual(default_extension(root), root / 'extension/.output/chrome-mv3')
        (root / 'extension/.output/chrome-mv3/manifest.json').unlink()
        self.assertEqual(default_extension(root), root / 'chrome-extension')

    def test_separate_namespace(self):
        agent = isolated_paths(self.base)
        self.assertNotEqual(agent.socket, self.base.socket)
        self.assertEqual(agent.root, self.base.root / 'agent-v1')

    def test_personal_native_host_rejected_before_serve(self):
        with patch.dict('os.environ', {}, clear=True), patch('native_host.host.NativeHost.serve') as serve:
            self.assertEqual(host_main(['chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/']), 1)
            serve.assert_not_called()

    def test_explicit_operator_relay_still_validates_extension_identity(self):
        with patch.dict('os.environ', {}, clear=True), patch('native_host.host.NativeHost.serve') as serve:
            self.assertEqual(host_main(['--operator-relay', 'chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/']), 0)
            serve.assert_called_once()
        with patch.dict('os.environ', {}, clear=True), patch('native_host.host.NativeHost.serve') as serve:
            self.assertEqual(host_main(['--operator-relay', 'chrome-extension://wrong/']), 1)
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

    def test_supervise_removes_pre_rebrand_profile_manifest(self):
        # pareto-legacy: remove after 2027-08-23.
        root = isolated_paths(self.base).root
        hosts = root / 'profile' / 'NativeMessagingHosts'
        hosts.mkdir(parents=True)
        stale = hosts / 'com.imploselabs.overseer_browser.json'  # pareto-legacy
        stale.write_text('{}')
        (root / 'quit').touch()
        with patch('native_host.isolation.subprocess.Popen') as launch, patch('sys.stderr') as stderr:
            child = launch.return_value
            child.pid = 123
            child.poll.return_value = None
            supervise(root, '/owned/chrome', '/owned/extension')
        self.assertFalse(stale.exists())
        self.assertTrue((hosts / 'com.paretocybernetics.overseer_browser.json').is_file())
        self.assertIn('removed legacy manifest', ''.join(call.args[0] for call in stderr.write.call_args_list))

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


class StaleWorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.profile = root / 'profile'
        self.extension = root / 'extension'
        self.extension.mkdir()
        self.cache = self.profile / 'Default' / 'Service Worker' / 'ScriptCache'
        self.cache.mkdir(parents=True)
        (self.cache / 'stale_0').write_text('com.imploselabs.overseer_browser')

    def _version(self, version):
        (self.extension / 'manifest.json').write_text('{"version": "%s"}' % version)

    def test_version_change_clears_cached_worker_once(self):
        from native_host.isolation import reset_stale_extension_worker
        self._version('0.6.8')
        self.assertTrue(reset_stale_extension_worker(self.profile, self.extension))
        self.assertFalse((self.profile / 'Default' / 'Service Worker').exists())
        self.assertEqual((self.profile / 'overseer-extension-version').read_text(), '0.6.8')
        self.cache.mkdir(parents=True)
        self.assertFalse(reset_stale_extension_worker(self.profile, self.extension))
        self.assertTrue(self.cache.exists())

    def test_unreadable_manifest_leaves_profile_alone(self):
        from native_host.isolation import reset_stale_extension_worker
        self.assertFalse(reset_stale_extension_worker(self.profile, self.extension))
        self.assertTrue(self.cache.exists())


class IsolatedLoadDiagnosisTests(unittest.TestCase):
    """The isolated lane must report why it did not connect and repair itself once.

    No real Chrome is started: the supervisor launch is mocked and the failure
    evidence (launch record, native host log, Chrome's extension registration) is
    written exactly as the real supervisor writes it.
    """

    def setUp(self):
        discovery = patch('cli.main.find_active_runtime', return_value=None)
        discovery.start()
        self.addCleanup(discovery.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.paths = isolated_paths(RuntimePaths(root, root / 'overseer-browser.sock', root / 'token'))
        self.paths.root.mkdir(parents=True, exist_ok=True)
        self.chrome = self.paths.root / 'chrome'
        self.chrome.write_text('#!/bin/sh\nexit 0\n')
        self.chrome.chmod(0o700)
        self.extension = self.paths.root / 'extension'
        self.extension.mkdir()
        (self.extension / 'manifest.json').write_text('{"version": "9.9.9"}')
        environment = patch.dict('os.environ', {'OVERSEER_BROWSER_CHROME': str(self.chrome),
                                                'OVERSEER_BROWSER_EXTENSION': str(self.extension)})
        environment.start()
        self.addCleanup(environment.stop)

    def record_launch(self, native_host=None, extension=None):
        from native_host.isolation import write_state
        state = {'version': 1, 'started_at': time.time(), 'chrome': str(self.chrome),
                 'extension': str(extension or self.extension), 'extension_version': '9.9.9',
                 'native_host': str(native_host or (self.paths.root / 'overseer-browser-native-host')),
                 'load_mode': 'load-extension', 'profile': str(self.paths.root / 'profile')}
        write_state(self.paths.root, state)
        (self.paths.root / 'supervisor.running').write_text(json.dumps({'pid': os.getpid(), 'profile': state['profile']}))
        return state

    def register_extension(self, folder):
        profile = self.paths.root / 'profile' / 'Default'
        profile.mkdir(parents=True, exist_ok=True)
        (profile / 'Secure Preferences').write_text(json.dumps(
            {'extensions': {'settings': {'iabfdeokmilpklblkgccpjlekchfjcno': {'location': 8, 'path': str(folder)}}}}))

    def test_missing_native_host_launcher_is_named_instead_of_not_connected(self):
        # Today's behaviour: "Isolated Chrome is not connected" with no cause. The
        # launcher the profile manifest names is the folder's own requirement, so an
        # absent or unusable one has to be the named cause.
        state = self.record_launch()
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.wait_for_connection', return_value=False), \
                patch('native_host.isolation.subprocess.Popen') as launch:
            with self.assertRaises(ValueError) as raised:
                ensure_instance(self.paths, 0.2, repair=False)
        message = str(raised.exception)
        self.assertIn('could not start its native host', message)
        self.assertIn(state['native_host'], message)
        self.assertIn('missing or not executable', message)
        self.assertNotIn('Isolated Chrome is not connected', message)
        launch.assert_not_called()

    def test_unregistered_extension_names_the_load_path_named_by_the_launcher(self):
        launcher = self.paths.root / 'overseer-browser-native-host'
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o700)
        state = self.record_launch(native_host=launcher)
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.wait_for_connection', return_value=False), \
                patch('native_host.isolation.subprocess.Popen'):
            with self.assertRaises(ValueError) as raised:
                ensure_instance(self.paths, 0.2, repair=False)
        message = str(raised.exception)
        self.assertIn('did not register the extension', message)
        self.assertIn(state['extension'], message)
        self.assertIn('load mode load-extension', message)

    def test_registered_extension_that_never_opened_its_port_is_a_real_load_verdict(self):
        launcher = self.paths.root / 'overseer-browser-native-host'
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o700)
        self.record_launch(native_host=launcher)
        self.register_extension(self.extension)
        room = patch('native_host.isolation.connected', return_value=False)
        wait = patch('native_host.isolation.wait_for_connection', return_value=False)
        with room, wait, patch('native_host.isolation.subprocess.Popen'):
            with self.assertRaises(ValueError) as raised:
                ensure_instance(self.paths, 0.2, repair=False)
        message = str(raised.exception)
        self.assertIn('registered the extension from', message)
        self.assertIn(str(self.extension), message)
        self.assertIn('never opened its native-messaging port', message)

    def test_failed_instance_is_replaced_once_on_the_exclusive_load_path(self):
        # self-repair: the unconnectable instance is stopped and retried once with
        # --disable-extensions-except, then the lane works without an operator.
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.wait_for_connection', side_effect=[False, True]), \
                patch('native_host.isolation.stop_instance') as stop, \
                patch('native_host.isolation.subprocess.Popen') as launch:
            ensure_instance(self.paths, 0.2)
        self.assertEqual(launch.call_count, 2)
        # Each launch starts the supervisor, which passes the load mode to Chrome.
        first, second = (call.args[0][-1] for call in launch.call_args_list)
        self.assertEqual(first, 'load-extension')
        self.assertEqual(second, 'exclusive')
        stop.assert_called_once()

    def test_second_failure_names_the_retry_and_the_cause(self):
        launcher = self.paths.root / 'overseer-browser-native-host'
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o700)
        self.record_launch(native_host=launcher)
        self.register_extension(self.extension)
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.wait_for_connection', return_value=False), \
                patch('native_host.isolation.stop_instance'), \
                patch('native_host.isolation.subprocess.Popen'):
            with self.assertRaises(ValueError) as raised:
                ensure_instance(self.paths, 0.2)
        message = str(raised.exception)
        self.assertIn('retried once with the exclusive extension load path', message)
        self.assertIn('never opened its native-messaging port', message)

    def test_stale_supervisor_record_is_replaced_instead_of_waited_out(self):
        # A supervisor killed with its terminal leaves supervisor.running behind; the
        # old code then waited for a browser that was never coming back.
        (self.paths.root / 'supervisor.running').write_text(json.dumps({'pid': 999_999, 'profile': 'gone'}))
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.wait_for_connection', return_value=True), \
                patch('native_host.isolation.subprocess.Popen') as launch:
            ensure_instance(self.paths, 0.2)
        launch.assert_called_once()

    def test_runtime_path_too_long_for_a_socket_is_named_before_launching(self):
        long_root = self.paths.root / ('x' * 60)
        paths = RuntimePaths(long_root, long_root / 'overseer-browser.sock', long_root / 'token')
        with patch('native_host.isolation.connected', return_value=False), \
                patch('native_host.isolation.subprocess.Popen') as launch:
            with self.assertRaises(ValueError) as raised:
                ensure_instance(paths, 0.2)
        self.assertIn('too long for a Unix socket', str(raised.exception))
        launch.assert_not_called()

    def test_health_reports_the_registered_folder_not_a_folder_on_disk(self):
        from native_host.isolation import isolation_health
        launcher = self.paths.root / 'overseer-browser-native-host'
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o700)
        self.record_launch(native_host=launcher)
        self.assertFalse(isolation_health(self.paths)['extension']['ok'])
        self.register_extension(self.paths.root / 'other-extension')
        self.assertFalse(isolation_health(self.paths)['extension']['ok'])
        self.register_extension(self.extension)
        health = isolation_health(self.paths)
        self.assertTrue(health['extension']['ok'])
        # The native port is part of the verdict: a running instance that never
        # opened it is exactly the defect, so it cannot report ok yet.
        self.assertFalse(health['native_port']['ok'])
        self.assertFalse(health['ok'])   # type: ignore[index]
        with (self.paths.root / 'host.log').open('w') as log:
            log.write(time.strftime('%Y-%m-%dT%H:%M:%S%z') + ' pid=1 ppid=0 start\n')
        self.assertTrue(isolation_health(self.paths)['ok'])

    def test_supervise_writes_the_launcher_it_names_and_the_launch_record(self):
        from native_host.isolation import read_state
        root = self.paths.root
        (root / 'quit').touch()
        with patch('native_host.isolation.subprocess.Popen') as launch:
            child = launch.return_value
            child.pid = 321
            child.poll.return_value = None
            supervise(root, str(self.chrome), str(self.extension), 'exclusive')
        launcher = root / 'overseer-browser-native-host'
        self.assertTrue(launcher.is_file())
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn('native_host.host', launcher.read_text())
        manifest = root / 'profile' / 'NativeMessagingHosts' / 'com.paretocybernetics.overseer_browser.json'
        self.assertEqual(json.loads(manifest.read_text())['path'], str(launcher))
        argv = launch.call_args.args[0]
        self.assertIn(f'--disable-extensions-except={self.extension}', argv)
        state = read_state(root)
        self.assertEqual(state['load_mode'], 'exclusive')
        self.assertEqual(state['native_host'], str(launcher))
        self.assertEqual(state['extension_version'], '9.9.9')
