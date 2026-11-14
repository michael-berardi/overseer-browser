"""Browser launches must leave the caller's macOS process coalition.

The real-launchd tests start only a harmless stand-in (/bin/sh, /bin/sleep) through
the same code path the isolated Chrome uses; no browser is ever started here.
"""
from __future__ import annotations

import ast
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from native_host import coalition

ROOT = Path(__file__).resolve().parents[1]
DARWIN = sys.platform == 'darwin'


def test_process_coalition(pid: int) -> int:
    """proc_pidinfo(pid, PROC_PIDCOALITIONINFO): the resource coalition id, read independently of the module."""
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    buffer = (ctypes.c_uint64 * 8)()
    size = lib.proc_pidinfo(pid, 20, 1, buffer, ctypes.sizeof(buffer))
    assert size > 0, f'proc_pidinfo failed for {pid}'
    return int(buffer[0])


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_gone(pid: int, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(.05)
    return not alive(pid)


@unittest.skipUnless(DARWIN, 'launchd coalitions exist only on macOS')
class RealLaunchdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        environment = patch.dict(os.environ, {'OSB_COALITION_TEST': 'carried'})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop(coalition.MODE_ENV, None)
        self.processes = []
        self.addCleanup(self.stop_all)

    def stop_all(self):
        for process in self.processes:
            process.kill()

    def spawn(self, argv, **kwargs):
        process = coalition.spawn(argv, log=Path(self.tmp.name) / 'out.log', state_dir=Path(self.tmp.name) / 'launch', **kwargs)
        self.processes.append(process)
        return process

    def test_stand_in_runs_in_a_fresh_coalition_and_dies_on_close(self):
        process = self.spawn(['/bin/sleep', '300'])
        self.assertIsInstance(process, coalition.LaunchdProcess, 'launchd refused; see stderr')
        self.assertTrue(alive(process.pid))
        self.assertIsNone(process.poll())
        self.assertNotEqual(test_process_coalition(process.pid), test_process_coalition(os.getpid()))
        # The one-shot job is removed once the process is up, and the process survives that.
        listed = subprocess.run(['launchctl', 'list'], capture_output=True, text=True).stdout
        self.assertNotIn(process.label, listed)
        self.assertFalse(coalition.job_listed(process.label))
        self.assertTrue(alive(process.pid))
        process.terminate()
        self.assertTrue(wait_gone(process.pid))
        self.assertIsNotNone(process.poll())

    def test_argv_cwd_and_environment_are_passed_explicitly(self):
        directory = Path(self.tmp.name).resolve()
        process = self.spawn(['/bin/sh', '-c', 'pwd; echo "$OSB_COALITION_TEST"; echo "$1"; exec /bin/sleep 300', 'sh', 'an arg'],
                             cwd=directory, env={'PATH': '/usr/bin:/bin', 'OSB_COALITION_TEST': 'explicit'})
        self.assertIsInstance(process, coalition.LaunchdProcess)
        log = Path(self.tmp.name) / 'out.log'
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(log.read_text().splitlines()) < 3:
            time.sleep(.05)
        self.assertEqual(log.read_text().splitlines(), [str(directory), 'explicit', 'an arg'])
        self.assertEqual(log.stat().st_mode & 0o077, 0)
        process.kill()
        self.assertTrue(wait_gone(process.pid))

    def test_missing_executable_is_a_named_cause_and_falls_back_with_one_warning(self):
        with self.assertRaises(coalition.LaunchdRefused) as raised:
            coalition._submit(['/nonexistent/browser'], cwd=None, env={}, log=Path(self.tmp.name) / 'o.log',
                              state_dir=Path(self.tmp.name) / 'launch', timeout=10)
        self.assertIn('executable not found', str(raised.exception))
        self.assertFalse(any(Path(self.tmp.name, 'launch').glob('spec-*')), 'the spec (it carries the environment) must not linger')

    def test_repeated_starts_never_lose_the_child_to_launchd_cleanup(self):
        # The wrapper's parent used to exit before the child left its process group, and launchd
        # then cleaned the child up: about one start in twenty reported nothing and fell back.
        for _ in range(60):
            process = self.spawn(['/bin/sleep', '60'], timeout=5)
            self.assertIsInstance(process, coalition.LaunchdProcess, 'a start was lost; see stderr')
            process.kill()

    def test_start_directory_is_private(self):
        self.spawn(['/bin/sleep', '300'])
        self.assertEqual(Path(self.tmp.name, 'launch').stat().st_mode & 0o777, 0o700)

    def test_run_capture_returns_output_from_a_fresh_coalition(self):
        output = coalition.run_capture(['/bin/echo', 'stand-in 1.2.3'], state_dir=Path(self.tmp.name) / 'launch', env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(output.strip(), 'stand-in 1.2.3')


class FallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        coalition._warned = False
        self.addCleanup(setattr, coalition, '_warned', False)

    def test_refusal_names_the_cause_logs_once_and_starts_directly(self):
        log = Path(self.tmp.name) / 'o.log'
        refusal = coalition.LaunchdRefused('launchctl submit refused the job (exit 5): Input/output error')
        with patch.object(coalition, 'launchd_enabled', return_value=True), \
                patch.object(coalition, '_submit', side_effect=refusal), \
                patch('native_host.coalition.subprocess.Popen') as popen, \
                patch('sys.stderr') as stderr:
            first = coalition.spawn(['/bin/sleep', '1'], log=log, state_dir=Path(self.tmp.name) / 'l')
            coalition.spawn(['/bin/sleep', '1'], log=log, state_dir=Path(self.tmp.name) / 'l')
        self.assertEqual(popen.call_count, 2)
        self.assertIs(first, popen.return_value)
        written = ''.join(call.args[0] for call in stderr.write.call_args_list)
        self.assertEqual(written.count('warning'), 1)
        self.assertIn('launchctl submit refused the job (exit 5)', written)

    def test_other_platforms_start_directly_without_launchd(self):
        with patch.object(sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=False):
            os.environ.pop(coalition.MODE_ENV, None)
            self.assertFalse(coalition.launchd_enabled())
            with patch.object(coalition, '_submit') as submit, patch('native_host.coalition.subprocess.Popen') as popen:
                coalition.spawn(['/bin/true'], log=Path(self.tmp.name) / 'o.log', state_dir=Path(self.tmp.name) / 'l')
        submit.assert_not_called()
        popen.assert_called_once()
        self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_opt_out_env_starts_directly(self):
        with patch.dict(os.environ, {coalition.MODE_ENV: 'direct'}):
            self.assertFalse(coalition.launchd_enabled())

    def test_a_recycled_pid_is_never_signalled(self):
        stale = coalition.LaunchdProcess(os.getpid(), 'x', (1, 0))
        with patch('native_host.coalition.os.kill', wraps=os.kill) as kill:
            self.assertEqual(stale.poll(), coalition.EXITED)
            stale.terminate()
            stale.kill()
        self.assertTrue(all(call.args[1] == 0 for call in kill.call_args_list), 'only the liveness probe may run')


class HandleTests(unittest.TestCase):
    """The launchd process handle never reads a failed lookup as an exit and never forks to poll."""

    def test_an_unreadable_start_time_is_not_an_exit(self):
        handle = coalition.LaunchdProcess(os.getpid(), 'x', (5, 5))
        with patch.object(coalition, '_identity', return_value=None):
            self.assertIsNone(handle.poll())
        unknown = coalition.LaunchdProcess(os.getpid(), 'x', None)
        with patch.object(coalition, '_identity', return_value=None):
            self.assertIsNone(unknown.poll())
        with patch.object(coalition, '_identity', return_value=(7, 1)):
            self.assertIsNone(unknown.poll())
            self.assertEqual(unknown.identity, (7, 1))  # learned late, then checked from then on
            self.assertIsNone(unknown.poll())
        with patch.object(coalition, '_identity', return_value=(8, 1)):
            self.assertEqual(unknown.poll(), coalition.EXITED)

    def test_a_start_time_that_differs_or_a_gone_pid_is_an_exit(self):
        with patch.object(coalition, '_identity', return_value=(9, 9)):
            self.assertEqual(coalition.LaunchdProcess(os.getpid(), 'x', (1, 1)).poll(), coalition.EXITED)
        gone = subprocess.Popen([sys.executable, '-c', 'pass'])
        gone.wait()
        self.assertEqual(coalition.LaunchdProcess(gone.pid, 'x', (1, 1)).poll(), coalition.EXITED)

    def test_polling_never_forks(self):
        handle = coalition.LaunchdProcess(os.getpid(), 'x', coalition._identity(os.getpid()))
        with patch('native_host.coalition.subprocess.run', side_effect=AssertionError('forked')), \
                patch('native_host.coalition.subprocess.Popen', side_effect=AssertionError('forked')):
            for _ in range(20):
                self.assertIsNone(handle.poll())

    @unittest.skipUnless(DARWIN, 'proc_pidinfo exists only on macOS')
    def test_start_time_matches_ps_and_a_gone_pid_reads_none(self):
        first = coalition._identity(os.getpid())
        self.assertIsNotNone(first)
        self.assertEqual(first, coalition._identity(os.getpid()))
        ps = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(os.getpid())], capture_output=True, text=True).stdout.strip()
        stamp = time.strftime('%a %b %e %H:%M:%S %Y', time.localtime(first[0]))
        self.assertEqual(' '.join(ps.split()), ' '.join(stamp.split()))
        done = subprocess.Popen([sys.executable, '-c', 'pass'])
        done.wait()
        self.assertIsNone(coalition._identity(done.pid))


class StartCancelTests(unittest.TestCase):
    """The wrapper is run directly (no launchd): a start the parent gave up on must never run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_wrapper(self, argv, *, cancelled=False):
        pid_path = self.dir / 'pid.json'
        spec = self.dir / 'spec.json'
        spec.write_text(json.dumps({'argv': argv, 'cwd': None, 'env': {'PATH': '/usr/bin:/bin'}, 'log': str(self.dir / 'log'), 'pidfile': str(pid_path)}))
        if cancelled:
            pid_path.write_text('{"cancelled": true}')
        subprocess.run([sys.executable, '-I', '-B', '-c', coalition._WRAPPER, str(spec)], check=True, timeout=20)
        time.sleep(.5)  # the forked child outlives the wrapper
        return pid_path

    def test_a_late_wrapper_finds_the_cancel_and_does_not_run_the_command(self):
        marker = self.dir / 'ran'
        self.run_wrapper(['/bin/sh', '-c', f'touch {marker}'], cancelled=True)
        self.assertFalse(marker.exists(), 'a cancelled start must not run the command')
        self.assertEqual(json.loads((self.dir / 'pid.json').read_text()), {'cancelled': True})

    def test_an_uncancelled_wrapper_reports_its_pid_and_runs(self):
        marker = self.dir / 'ran'
        pid_path = self.run_wrapper(['/bin/sh', '-c', f'touch {marker}'])
        self.assertTrue(marker.exists())
        self.assertIsInstance(json.loads(pid_path.read_text())['pid'], int)

    def test_an_exec_failure_after_the_pid_report_is_named_in_the_log(self):
        script = self.dir / 'bad'
        script.write_text('#!/nonexistent/interpreter\n')
        script.chmod(0o755)
        pid_path = self.run_wrapper([str(script)])
        self.assertIn('pid', json.loads(pid_path.read_text()), 'the pid report the parent read is not overwritten')
        log = (self.dir / 'log').read_text()
        self.assertIn('the command did not start', log)
        self.assertIn('FileNotFoundError', log)

    def test_cancel_wins_only_when_no_report_exists(self):
        pid_path = self.dir / 'pid.json'
        self.assertIsNone(coalition._cancel_start(pid_path))
        self.assertEqual(json.loads(pid_path.read_text()), {'cancelled': True})
        late = self.dir / 'late.json'
        late.write_text('{"pid": 4242}')
        self.assertEqual(coalition._cancel_start(late), {'pid': 4242})


class SubmitFallbackTests(unittest.TestCase):
    """The real refusal paths reach the fallback: _submit runs, only launchctl and the wait are replaced."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        coalition._warned = False
        self.addCleanup(setattr, coalition, '_warned', False)
        ok = subprocess.CompletedProcess([], 0, '', '')
        patches = [patch.object(coalition, 'launchd_enabled', return_value=True),
                   patch.object(coalition, '_launchctl', return_value=ok),
                   patch.object(coalition, 'CANCEL_GRACE', .1)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def spawn(self, **kwargs):
        with patch('native_host.coalition.subprocess.Popen') as popen, patch('sys.stderr') as stderr:
            result = coalition.spawn(['/bin/sleep', '1'], log=self.dir / 'o.log', state_dir=self.dir / 'l', timeout=.2, **kwargs)
        return result, popen, ''.join(call.args[0] for call in stderr.write.call_args_list)

    def test_a_start_timeout_cancels_and_falls_back_once_with_the_cause(self):
        with patch.object(coalition, '_wait_for_report', return_value=None):
            result, popen, written = self.spawn()
        popen.assert_called_once()
        self.assertIs(result, popen.return_value)
        self.assertIn('nothing started within', written)
        self.assertEqual(written.count('warning'), 1)
        markers = list((self.dir / 'l').glob('pid-*.json'))
        self.assertEqual(len(markers), 1, 'the cancel marker stays so a late wrapper finds it')
        self.assertEqual(json.loads(markers[0].read_text()), {'cancelled': True})
        self.assertEqual(list((self.dir / 'l').glob('spec-*')), [])

    def test_a_report_that_arrives_as_the_wait_ends_is_used_not_replaced_by_a_second_start(self):
        def late(pid_path, timeout):
            Path(pid_path).write_text(json.dumps({'pid': os.getpid()}))
            return None
        with patch.object(coalition, '_wait_for_report', side_effect=[None, {'pid': os.getpid()}]) as wait, \
                patch.object(coalition, '_cancel_start', wraps=coalition._cancel_start) as cancel:
            # the report file appears between the timed-out wait and the cancel
            original = coalition.os.open
            def appear(path, flags, *args, **kwargs):
                if str(path).endswith('.json') and 'pid-' in str(path) and flags & os.O_EXCL and not Path(path).exists():
                    Path(path).write_text(json.dumps({'pid': os.getpid()}))
                return original(path, flags, *args, **kwargs)
            with patch.object(coalition.os, 'open', side_effect=appear):
                result, popen, _ = self.spawn()
        popen.assert_not_called()
        self.assertIsInstance(result, coalition.LaunchdProcess)
        self.assertEqual(result.pid, os.getpid())

    def test_a_wrapper_error_report_falls_back_naming_the_cause(self):
        with patch.object(coalition, '_wait_for_report', return_value={'error': 'FileNotFoundError: executable not found or not executable: x'}):
            result, popen, written = self.spawn()
        popen.assert_called_once()
        self.assertIn('the command did not start: FileNotFoundError', written)

    def test_launchctl_missing_from_path_still_uses_launchd_by_absolute_path(self):
        patch.stopall()
        with patch.object(sys, 'platform', 'darwin'), patch.dict(os.environ, {}, clear=False), \
                patch('native_host.coalition.shutil.which', return_value=None), \
                patch('native_host.coalition.Path.exists', return_value=True), \
                patch('native_host.coalition.subprocess.run') as run:
            os.environ.pop(coalition.MODE_ENV, None)
            self.assertTrue(coalition.launchd_enabled())
            coalition._launchctl('list')
        self.assertEqual(run.call_args.args[0], ['/bin/launchctl', 'list'])

    def test_launchctl_not_found_anywhere_is_a_named_refusal_and_falls_back(self):
        patch.stopall()
        coalition._warned = False
        with patch.object(coalition, 'launchd_enabled', return_value=True), \
                patch.object(coalition, '_launchctl_path', return_value=None):
            result, popen, written = self.spawn()
        popen.assert_called_once()
        self.assertIn('launchctl not found', written)


class StatusHintTests(unittest.TestCase):
    def test_a_shared_coalition_hint_wins_even_when_the_socket_is_connected(self):
        from cli.main import local_health
        from native_host.runtime import RuntimePaths
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = RuntimePaths(root, root / 's', root / 't')
            isolated = {'ok': False, 'coalition': {'ok': False, 'hint': 'shared coalition hint'}}
            with patch('native_host.isolation.isolation_health', return_value=isolated), \
                    patch('cli.main.find_active_runtime', return_value=None), \
                    patch('cli.main._private_socket', return_value=True), \
                    patch.object(Path, 'is_socket', return_value=True):
                checks = local_health(paths)
        self.assertTrue(checks['socket']['ok'])
        self.assertFalse(checks['ok'])
        self.assertEqual(checks['hint'], 'shared coalition hint')


class LauncherGuardTests(unittest.TestCase):
    """No browser executable may be spawned around native_host.coalition."""

    SPAWNERS = {('subprocess', name) for name in ('Popen', 'run', 'call', 'check_call', 'check_output')} | \
               {('os', name) for name in ('system', 'popen', 'posix_spawn', 'posix_spawnp', 'fork', 'forkpty',
                                          'execv', 'execve', 'execl', 'execle', 'execlp', 'execlpe', 'execvp', 'execvpe',
                                          'spawnv', 'spawnve', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnvp', 'spawnvpe')}
    # Reviewed non-browser spawns: the file, and the first word of the command's source.
    ALLOWED = {
        ('cli/main.py', 'str(script)'),            # the installer script behind install/update/uninstall
        ('cli/recording.py', 'ffmpeg'), ('cli/recording.py', "shutil.which('ffmpeg')"),
        ('cli/recording.py', "shutil.which('ffprobe')"), ('cli/recording.py', 'ffprobe'),
    }

    def sources(self):
        for folder in ('cli', 'native_host', 'scripts'):
            for path in sorted((ROOT / folder).rglob('*.py')):
                yield path.relative_to(ROOT).as_posix(), path.read_text()

    def spawns(self):
        for name, text in self.sources():
            if name == 'native_host/coalition.py':
                continue
            for node in ast.walk(ast.parse(text)):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
                        and (node.func.value.id, node.func.attr) in self.SPAWNERS:
                    first = ast.unparse(node.args[0]) if node.args else ''
                    command = first.strip('[]').split(',')[0].strip()
                    yield name, node.lineno, f'{node.func.value.id}.{node.func.attr}', command

    def test_every_process_spawn_is_reviewed_and_browser_spawns_use_the_launcher(self):
        stray = [(name, line, call, command) for name, line, call, command in self.spawns() if (name, command) not in self.ALLOWED]
        self.assertEqual(stray, [], 'a process spawn bypasses native_host.coalition; start browsers with coalition.spawn() '
                                    '(or add a reviewed non-browser command to ALLOWED)')

    def test_isolation_starts_the_supervisor_the_browser_and_its_version_probe_through_the_launcher(self):
        text = (ROOT / 'native_host/isolation.py').read_text()
        self.assertEqual(text.count('coalition.spawn('), 2)
        self.assertEqual(text.count('coalition.run_capture('), 1)
        self.assertNotIn('subprocess.Popen(', text)
        self.assertNotIn('subprocess.run(', text)

    @unittest.skipUnless(DARWIN, 'coalitions exist only on macOS')
    def test_on_macos_isolation_reaches_launchd_for_supervisor_and_browser(self):
        from native_host import isolation
        from native_host.runtime import RuntimePaths
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=False):
            os.environ.pop(coalition.MODE_ENV, None)
            root = Path(tmp)
            paths = isolation.isolated_paths(RuntimePaths(root, root / 's', root / 't'))
            paths.root.mkdir(parents=True)
            handle = patch('native_host.coalition._submit').start()
            self.addCleanup(patch.stopall)
            handle.return_value.pid = 4321
            handle.return_value.poll.return_value = None
            isolation.start_supervisor(paths, Path('/stand-in/chrome'), Path('/stand-in/ext'), 'load-extension')
            (paths.root / 'quit').touch()  # start_supervisor clears it; supervise returns at once
            isolation.supervise(paths.root, '/stand-in/chrome', '/stand-in/ext')
        launched = [call.args[0][0] for call in handle.call_args_list]
        self.assertIn('/stand-in/chrome', launched)          # the browser itself
        self.assertIn(sys.executable, launched)              # the supervisor
        self.assertEqual(launched.count('/stand-in/chrome'), 2)  # --version probe and the browser


if __name__ == '__main__':
    unittest.main()
