"""Start the isolated browser outside the caller's macOS process coalition.

On macOS a process inherits its parent's launchd coalition, and force-quitting an
application stops every coalition holding a process registered as that application.
A Chrome started from a terminal pane therefore shared the terminal multiplexer's
coalition, and stopping Chrome from the Dock took the multiplexer and every session
in it down. `start_new_session` does not change the coalition; only launchd does.

`spawn()` submits a one-shot launchd job whose wrapper forks the real command into
its own session and exits. The job therefore ends by itself, `launchctl remove` is
plain cleanup (removing a job that is still running would stop its process), and the
command keeps running in the fresh coalition launchd gave the job. The returned handle
names the real command's pid, recorded with its start time so a recycled pid is never
signalled. When launchd refuses, the cause is named, one warning is logged and the
command starts directly, as it did before. Linux and Windows always start directly.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

# "direct" (or "off") skips launchd, for hosts where launchctl is unavailable.
MODE_ENV = 'OVERSEER_BROWSER_COALITION'
LABEL_PREFIX = 'com.overseer-browser.launch'
START_TIMEOUT = 15.0
PROC_PIDCOALITIONINFO = 20
EXITED = -1  # a launchd-started process is not our child: it exited, its status is unknown

_warned = False

# Runs inside the launchd job (launchd jobs inherit nothing from the caller): read
# the spec, fork the command into its own session, report its pid, exec it.
_WRAPPER = r'''
import json, os, shutil, sys
spec = json.load(open(sys.argv[1]))
os.unlink(sys.argv[1])
if os.fork():
    os._exit(0)
os.setsid()
def report(payload):
    tmp = spec['pidfile'] + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(payload, handle)
    os.replace(tmp, spec['pidfile'])
try:
    argv, env = spec['argv'], spec['env']
    exe = argv[0] if os.sep in argv[0] else shutil.which(argv[0], path=env.get('PATH'))
    if not exe or not os.path.isfile(exe) or not os.access(exe, os.X_OK):
        raise FileNotFoundError('executable not found or not executable: ' + argv[0])
    if spec.get('cwd'):
        os.chdir(spec['cwd'])
    null = os.open(os.devnull, os.O_RDONLY)
    out = os.open(spec['log'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(null, 0); os.dup2(out, 1); os.dup2(out, 2)
    report({'pid': os.getpid()})
    os.execve(exe, argv, env)
except BaseException as exc:
    report({'error': type(exc).__name__ + ': ' + str(exc)})
    os._exit(127)
'''


class LaunchdRefused(Exception):
    """launchd could not start the command; the message names the cause."""


def launchd_enabled() -> bool:
    if sys.platform != 'darwin':
        return False
    if os.environ.get(MODE_ENV, '').strip().lower() in {'direct', 'off', '0'}:
        return False
    return shutil.which('launchctl') is not None or Path('/bin/launchctl').exists()


def coalition_id(pid: int) -> int | None:
    """The resource coalition id of a process (proc_pidinfo flavor 20), or None."""
    if sys.platform != 'darwin':
        return None
    try:
        import ctypes
        lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        buffer = (ctypes.c_uint64 * 8)()
        size = lib.proc_pidinfo(int(pid), PROC_PIDCOALITIONINFO, 1, buffer, ctypes.sizeof(buffer))
    except (OSError, AttributeError, ValueError):
        return None
    return int(buffer[0]) if size >= 16 and buffer[0] else None


def _identity(pid: int) -> str | None:
    """The process start time: with the pid it names one process, never a recycled one."""
    try:
        done = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    text = (done.stdout or '').strip() if isinstance(done.stdout, str) else ''
    return text or None


class LaunchdProcess:
    """A process started through launchd; the Popen-shaped surface the lifecycle needs."""

    def __init__(self, pid: int, label: str, identity: str | None) -> None:
        self.pid = pid
        self.label = label
        self.identity = identity
        self.returncode: int | None = None

    def _alive(self) -> bool:
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return False  # a pid we cannot signal is not ours any more
        # Without a recorded start time the pid cannot be told from a recycled one.
        return self.identity is not None and _identity(self.pid) == self.identity

    def poll(self) -> int | None:
        if self.returncode is None and not self._alive():
            self.returncode = EXITED
        return self.returncode

    def _signal(self, number: int) -> None:
        if self.poll() is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(self.pid, number)

    def terminate(self) -> None:
        self._signal(15)

    def kill(self) -> None:
        self._signal(9)

    def wait(self, timeout: float | None = None) -> int:
        deadline = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(str(self.pid), timeout or 0)
            time.sleep(.05)
        return int(self.returncode if self.returncode is not None else EXITED)


def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['launchctl', *args], capture_output=True, text=True, timeout=20, check=False)


def _remove_job(label: str) -> None:
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        _launchctl('remove', label)


def job_listed(label: str) -> bool:
    done = _launchctl('list')
    return any(line.split('\t')[-1].strip() == label for line in (done.stdout or '').splitlines())


def _private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _submit(argv: list[str], *, cwd: str | None, env: dict[str, str], log: Path, state_dir: Path, timeout: float) -> LaunchdProcess:
    state = _private_dir(state_dir)
    token = secrets.token_hex(8)
    label = f'{LABEL_PREFIX}.{os.getpid()}.{token}'
    spec_path = state / f'spec-{token}.json'
    pid_path = state / f'pid-{token}.json'
    fd = os.open(spec_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'argv': argv, 'cwd': cwd, 'env': env, 'log': str(log), 'pidfile': str(pid_path)}, handle)
    submitted = False
    try:
        try:
            done = _launchctl('submit', '-l', label, '-o', os.devnull, '-e', os.devnull, '--',
                              sys.executable, '-I', '-B', '-c', _WRAPPER, str(spec_path))
        except (OSError, subprocess.SubprocessError) as exc:
            raise LaunchdRefused(f'launchctl submit could not run: {exc}') from exc
        if done.returncode != 0:
            raise LaunchdRefused(f'launchctl submit refused the job (exit {done.returncode}): {(done.stderr or done.stdout or "").strip()[:200]}')
        submitted = True
        report = _wait_for_report(pid_path, timeout)
        if report is None:
            raise LaunchdRefused(f'launchd accepted the job but nothing started within {timeout:g}s')
        if 'error' in report:
            raise LaunchdRefused(f'launchd started the wrapper but the command did not start: {report["error"]}')
        pid = int(report['pid'])
        # The pid is reported after the command's own session starts, so a command that
        # already finished is a fast command, not a refusal; the handle then reads exited.
        return LaunchdProcess(pid, label, _identity(pid))
    finally:
        if submitted:
            _remove_job(label)
        for leftover in (spec_path, pid_path):
            with contextlib.suppress(OSError):
                leftover.unlink()


def _wait_for_report(pid_path: Path, timeout: float) -> dict | None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            payload = json.loads(pid_path.read_text())
            if isinstance(payload, dict):
                return payload
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            return None
        time.sleep(.02)


def _warn_once(what: str, cause: object) -> None:
    global _warned
    if _warned:
        return
    _warned = True
    print(f'overseer-browser: warning: launchd refused ({cause}); starting {what} directly, so it shares the '
          f'caller\'s process coalition', file=sys.stderr)


def spawn(argv: list[str], *, log: Path, state_dir: Path, env: dict[str, str] | None = None,
          cwd: str | os.PathLike[str] | None = None, what: str = 'the command',
          timeout: float = START_TIMEOUT):
    """Start `argv` detached from the caller, in a fresh launchd coalition on macOS.

    Returns a Popen-like handle (pid, poll, terminate, kill, wait). stdout and stderr
    append to `log`; stdin is closed. Falls back to a direct start with one warning.
    """
    environment = dict(os.environ if env is None else env)
    directory = str(cwd) if cwd is not None else os.getcwd()
    if launchd_enabled():
        try:
            return _submit([str(item) for item in argv], cwd=directory, env=environment, log=Path(log),
                           state_dir=Path(state_dir), timeout=timeout)
        except LaunchdRefused as exc:
            _warn_once(what, exc)
    with Path(log).open('ab') as stream:
        return subprocess.Popen([str(item) for item in argv], env=environment, cwd=directory,
                                stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, start_new_session=True)


def run_capture(argv: list[str], *, state_dir: Path, timeout: float = 10.0, env: dict[str, str] | None = None) -> str:
    """Run a short command and return its output, outside the caller's coalition on macOS."""
    if not launchd_enabled():
        done = subprocess.run([str(item) for item in argv], capture_output=True, text=True, timeout=timeout, check=False, env=env)
        output = done.stdout if isinstance(done.stdout, str) else ''
        error = done.stderr if isinstance(done.stderr, str) else ''
        return output or error
    state = _private_dir(Path(state_dir))
    log = state / f'out-{secrets.token_hex(8)}.log'
    try:
        process = spawn(argv, log=log, state_dir=state, env=env, what=Path(str(argv[0])).name, timeout=timeout)
        try:
            process.wait(timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            raise
        try:
            return log.read_text(errors='replace')
        except OSError:
            return ''
    finally:
        with contextlib.suppress(OSError):
            log.unlink()
