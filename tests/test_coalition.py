"""Browser launches must leave the caller's macOS process coalition.

The real-launchd tests start only a harmless stand-in (/bin/sh, /bin/sleep) through
the same code path the isolated Chrome uses; no browser is ever started here.
"""
from __future__ import annotations

import ast
import ctypes
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
        stale = coalition.LaunchdProcess(os.getpid(), 'x', 'Thu Jan  1 00:00:00 1970')
        with patch('native_host.coalition.os.kill', wraps=os.kill) as kill:
            self.assertEqual(stale.poll(), coalition.EXITED)
            stale.terminate()
            stale.kill()
        self.assertTrue(all(call.args[1] == 0 for call in kill.call_args_list), 'only the liveness probe may run')


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
