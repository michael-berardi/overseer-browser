"""Owned Chrome lifecycle. Never discovers or controls existing browser windows.

The supervisor retains the Popen handle: shutdown cannot signal a recycled PID.
A separate runtime and inherited launch marker exclude daily Chrome native ports.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

try:
    from .protocol import EXTENSION_ID, NATIVE_HOST_NAME
    from .runtime import RuntimePaths, ensure_private_directory, ensure_token, write_manifest
except ImportError:
    from protocol import EXTENSION_ID, NATIVE_HOST_NAME  # type: ignore[no-redef]
    from runtime import RuntimePaths, ensure_private_directory, ensure_token, write_manifest  # type: ignore[no-redef]

DEFAULT_CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
# Chrome starts this file for every connectNative() call, so the profile's manifest
# must name an absolute executable that belongs to the runtime being launched.
LAUNCHER_NAME = 'overseer-browser-native-host'
LAUNCHER_MODULE = 'native_host.host'
STATE_NAME = 'isolation-state.json'
# Chrome's two supported ways to load an unpacked extension. The first is the plain
# switch; the second additionally loads this extension and no other.
LOAD_MODES = ('load-extension', 'exclusive')
# A Unix socket path longer than this cannot be bound: the host dies before it can
# log anything, which used to surface only as "Isolated Chrome is not connected".
MAX_SOCKET_PATH_BYTES = 103


def isolated_paths(base: RuntimePaths) -> RuntimePaths:
    root = base.root / 'agent-v1'
    return RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')


@contextlib.contextmanager
def lifecycle_lock(paths: RuntimePaths):
    if os.name != 'posix':
        raise ValueError('Isolated browser lifecycle currently requires macOS or Linux')
    import fcntl
    ensure_private_directory(paths.root)
    lock = paths.root / 'lifecycle.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def connected(paths: RuntimePaths) -> bool:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(.1)
        try:
            probe.connect(str(paths.socket))
            return True
        except OSError:
            return False


def default_extension(install_root: Path) -> Path:
    """Prefer the bundle belonging to this immutable installed runtime."""
    roots = [install_root]
    source = install_root / 'source-root'
    if source.is_file():
        roots.append(Path(source.read_text().strip()))
    for root in roots:
        for candidate in (root / 'extension', root / 'extension/.output/chrome-mv3', root / 'chrome-extension'):
            if (candidate / 'manifest.json').is_file():
                return candidate
    raise ValueError('No built extension found; run the platform installer')


def ensure_instance(paths: RuntimePaths, timeout: float, *, repair: bool = True) -> None:
    """Start (or repair) the isolated instance and wait for its native port.

    A failed launch is diagnosed from what actually happened (launch record, native
    host log, Chrome's own registration of the extension) and repaired once without
    an operator: the unconnectable instance is stopped and relaunched on the
    exclusive load path. Chrome runs a stale service worker or an old profile for a
    while, so one retry covers it; an operator has nothing to click.
    """
    ensure_token(paths)
    if connected(paths):
        return
    too_long = socket_path_problem(paths)
    if too_long:
        raise ValueError(too_long)
    chrome, extension = launch_targets()
    running = paths.root / 'supervisor.running'
    if running.exists() and not supervisor_alive(running):
        # A supervisor killed with its terminal, or lost to a reboot, leaves its
        # record behind; the old code then waited out the whole timeout for a
        # browser that was never coming back.
        running.unlink(missing_ok=True)
    if not running.exists():
        start_supervisor(paths, chrome, extension, LOAD_MODES[0])
    if wait_for_connection(paths, timeout):
        return
    cause = diagnose(paths, extension)
    if not repair:
        raise ValueError(cause)
    try:
        stop_instance(paths, timeout=min(20.0, max(5.0, timeout)))
    except ValueError as exc:
        raise ValueError(f'{cause} Replacing that instance failed: {exc}') from exc
    mode = LOAD_MODES[1] if LOAD_MODES[0] != LOAD_MODES[1] else LOAD_MODES[0]
    start_supervisor(paths, chrome, extension, mode)
    if wait_for_connection(paths, min(timeout, 20.0)):
        return
    cause = diagnose(paths, extension)
    with contextlib.suppress(ValueError):
        # Leave no unconnectable Chrome behind: nobody can drive it, it holds the
        # profile and the next attempt starts from a clean one.
        stop_instance(paths, timeout=min(20.0, max(5.0, timeout)))
    raise ValueError(f'{cause} (retried once with the exclusive extension load path; that instance was closed)')


def launch_targets() -> tuple[Path, Path]:
    """Resolve the Chrome binary and the built extension, naming whichever is wrong."""
    chrome = Path(os.environ.get('OVERSEER_BROWSER_CHROME', DEFAULT_CHROME))
    install_root = Path(__file__).resolve().parents[1]
    override = os.environ.get('OVERSEER_BROWSER_EXTENSION')
    extension = (Path(override) if override else default_extension(install_root)).resolve()
    if not chrome.is_file():
        raise ValueError(f'Chrome for Testing is missing at {chrome}; set OVERSEER_BROWSER_CHROME to the Chrome for Testing binary')
    if not (extension / 'manifest.json').is_file():
        raise ValueError(f'the built extension is missing from {extension} (no manifest.json there); set OVERSEER_BROWSER_EXTENSION to a built chrome-mv3 directory')
    return chrome, extension


def socket_path_problem(paths: RuntimePaths) -> str | None:
    length = len(os.fsencode(paths.socket))
    if length <= MAX_SOCKET_PATH_BYTES:
        return None
    return (f'the isolated runtime path is too long for a Unix socket ({length} > {MAX_SOCKET_PATH_BYTES} bytes), so the native host '
            f'cannot bind {paths.socket}; use a shorter OVERSEER_BROWSER_RUNTIME than {paths.root}')


def start_supervisor(paths: RuntimePaths, chrome: Path, extension: Path, load_mode: str) -> None:
    (paths.root / 'quit').unlink(missing_ok=True)
    with (paths.root / 'chrome.log').open('ab') as log:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(paths.root), str(chrome), str(extension), load_mode],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)


def wait_for_connection(paths: RuntimePaths, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if connected(paths):
            return True
        time.sleep(.1)
    return connected(paths)


def supervisor_alive(running: Path) -> bool:
    try:
        pid = int(json.loads(running.read_text())['pid'])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_instance(paths: RuntimePaths, timeout: float = 15) -> None:
    (paths.root / 'quit').touch(mode=0o600)
    deadline = time.monotonic() + timeout
    while (paths.root / 'supervisor.running').exists():
        if time.monotonic() >= deadline:
            raise ValueError('Dedicated Chrome shutdown timed out; no other browser was signalled')
        time.sleep(.1)


def _extension_version(extension: Path) -> str | None:
    try:
        return str(json.loads((extension / 'manifest.json').read_text())['version'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _chrome_version(chrome: str) -> str | None:
    """The launched build's own version, for the failure report; never stops a launch."""
    try:
        completed = subprocess.run([chrome, '--version'], capture_output=True, text=True, timeout=10, check=False)
        output = completed.stdout if isinstance(completed.stdout, str) else ''
        error = completed.stderr if isinstance(completed.stderr, str) else ''
    except Exception:
        return None
    text = (output or error).strip()
    return text or None


def _shell_quote(value: str) -> str:
    escaped = value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    return f'"{escaped}"'


def write_host_launcher(root: Path) -> Path:
    """Write the launcher the isolated profile's native-messaging manifest names.

    The manifest has to name an absolute executable, and Chrome starts it for every
    connectNative() call. It used to be assumed two directories up
    (<runtime parent>/overseer-browser-native-host), which only the installed
    application-support runtime has: in any other runtime root - a caller's own, the
    operator relay's - the extension loaded, its port silently failed to open and
    every command ended as an unnamed isolation_unavailable. Generating the launcher
    inside the runtime the supervisor owns removes that assumption, and it runs the
    native host of this same runtime, never another version's.
    """
    runtime = Path(__file__).resolve().parents[1]
    launcher = root / LAUNCHER_NAME
    runner = ('import runpy,sys; sys.path.insert(0, sys.argv.pop(1)); '
              f'runpy.run_module("{LAUNCHER_MODULE}", run_name="__main__")')
    body = (
        '#!/bin/sh\n'
        '# OverSeer Browser isolated native host launcher, generated by the isolated supervisor.\n'
        f'exec {_shell_quote(sys.executable)} -I -B -c {_shell_quote(runner)} {_shell_quote(str(runtime))} "$@"\n'
    )
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{LAUNCHER_NAME}.', dir=root)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(body)
        os.chmod(temporary, 0o700)
        os.replace(temporary, launcher)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return launcher


def write_state(root: Path, payload: dict[str, object]) -> None:
    """Record what was launched, for the failure diagnosis; never raises."""
    temporary = root / f'.{STATE_NAME}.{os.getpid()}'
    try:
        with temporary.open('w') as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
        os.chmod(temporary, 0o600)
        os.replace(temporary, root / STATE_NAME)
    except OSError:
        temporary.unlink(missing_ok=True)


def read_state(root: Path) -> dict[str, object]:
    try:
        payload = json.loads((root / STATE_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _host_lines_since(host_log: Path, started: float) -> list[str]:
    try:
        lines = host_log.read_text(errors='replace').splitlines()[-50:]
    except OSError:
        return []
    from datetime import datetime

    recent: list[str] = []
    for line in lines:
        stamp = line.split(' ', 1)[0]
        try:
            when = datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%S%z').timestamp()
        except ValueError:
            continue
        if when >= started - 2:
            recent.append(line)
    return recent


def _profile_registration(profile: Path) -> str | None:
    """The folder Chrome actually registered this extension from, or None."""
    for name in ('Default/Secure Preferences', 'Default/Preferences', 'Secure Preferences'):
        try:
            settings = (json.loads((profile / name).read_text()).get('extensions') or {}).get('settings') or {}
        except (OSError, ValueError, AttributeError):
            continue
        entry = settings.get(EXTENSION_ID) if isinstance(settings, dict) else None
        if isinstance(entry, dict) and entry.get('path'):
            return str(entry['path'])
    return None


def _last_error(log: Path) -> str | None:
    try:
        lines = log.read_text(errors='replace').splitlines()[-200:]
    except OSError:
        return None
    for line in reversed(lines):
        if 'ERROR' in line:
            return line[:300]
    return None


def diagnose(paths: RuntimePaths, extension: Path) -> str:
    """Name why the isolated instance never connected, from what actually happened.

    Folder presence proves nothing - the extension folder, the profile manifest and
    the launcher all sit on disk in the failing case - so the verdict comes from the
    launch record, the native host's own lifecycle log and Chrome's registration of
    the extension in the profile.
    """
    root = paths.root
    chrome_log = root / 'chrome.log'
    host_log = root / 'host.log'
    state = read_state(root)
    if not state:
        return (f'the isolated supervisor wrote no launch record in {root}, so no isolated Chrome was started there; '
                f'run the command again. Chrome log: {chrome_log}')
    started = float(state.get('started_at') or 0)
    mode = str(state.get('load_mode') or LOAD_MODES[0])
    host_lines = _host_lines_since(host_log, started)
    if not (root / 'supervisor.running').exists():
        detail = _last_error(chrome_log)
        return (f'isolated Chrome exited before the extension connected (exit code {state.get("exit_code")})'
                f'{f". Last Chrome error: {detail}" if detail else ""}. Chrome log: {chrome_log}')
    if not host_lines:
        launcher = Path(str(state.get('native_host') or root / LAUNCHER_NAME))
        if not launcher.is_file() or not os.access(launcher, os.X_OK):
            return (f'the extension could not start its native host: the isolated profile manifest names {launcher}, '
                    f'which is missing or not executable, so the extension loads and its port never opens. Chrome log: {chrome_log}')
        registration = _profile_registration(Path(str(state.get('profile') or root / 'profile')))
        if registration is None:
            return (f'Chrome did not register the extension from {extension} (load mode {mode}), so it never opened its '
                    f'native-messaging port. Chrome log: {chrome_log}')
        return (f'Chrome registered the extension from {registration} but it never opened its native-messaging port, '
                f'so the connection is blocked in this profile rather than unloaded. Native host log: {host_log}')
    if 'AF_UNIX path too long' in '\n'.join(host_lines):
        return (f'the native host cannot bind {paths.socket} because the runtime path is too long for a Unix socket; '
                f'use a shorter OVERSEER_BROWSER_RUNTIME than {root}. Native host log: {host_log}')
    return (f'the native host started ({host_lines[-1].strip()}) but did not answer on {paths.socket}. '
            f'Native host log: {host_log}')


def isolation_health(paths: RuntimePaths) -> dict[str, object]:
    """Preflight for the isolated lane, drawn from the loaded instance, not a folder."""
    root = paths.root
    state = read_state(root)
    launcher = Path(str(state.get('native_host') or root / LAUNCHER_NAME))
    extension = Path(str(state.get('extension'))) if state.get('extension') else None
    registered = _profile_registration(root / 'profile')
    launched = bool(state)
    port = bool(_host_lines_since(root / 'host.log', float(state.get('started_at') or 0)))
    running = (root / 'supervisor.running').exists() and supervisor_alive(root / 'supervisor.running')
    report: dict[str, object] = {
        'load_mode': state.get('load_mode'),
        'native_host_launcher': {'path': str(launcher), 'ok': launcher.is_file() and os.access(launcher, os.X_OK)},
        'extension': {
            'path': str(extension) if extension else None,
            'version': state.get('extension_version'),
            'registered_path': registered,
            'ok': (not launched) or (
                registered is not None and extension is not None
                and Path(registered).resolve() == extension.resolve()),
        },
        'native_port': {'ok': port, 'running': running},
    }
    report['ok'] = (bool(report['native_host_launcher']['ok'])  # type: ignore[index]
                    and bool(report['extension']['ok'])  # type: ignore[index]
                    and (port or not running))
    return report


def reset_stale_extension_worker(profile: Path, extension: Path) -> bool:
    """Drop Chrome's cached service worker when the loaded extension version changes.

    Chrome for Testing keeps running a cached MV3 service worker from an
    --load-extension folder even after the folder's code changes. After the
    0.6.6 host rename that stale worker kept calling the old native host name
    (com.imploselabs...), so the isolated browser never connected and every
    command failed with isolation_unavailable. Only the dedicated agent profile
    is touched; the operator's browsers are never read or changed.
    """
    version = _extension_version(extension)
    marker = profile / 'overseer-extension-version'
    try:
        previous = marker.read_text().strip()
    except OSError:
        previous = None
    if version is None or previous == version:
        return False
    worker_cache = profile / 'Default' / 'Service Worker'
    reset = worker_cache.exists()
    if reset:
        import shutil
        shutil.rmtree(worker_cache)
        print(f'overseer-browser: extension {previous or "unknown"} -> {version}; cleared cached service worker in {worker_cache}', file=sys.stderr)
    marker.write_text(version)
    os.chmod(marker, 0o600)
    return reset


def supervise(root: Path, chrome: str, extension: str, load_mode: str = LOAD_MODES[0]) -> None:
    paths = RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')
    ensure_private_directory(root)
    profile = root / 'profile'
    ensure_private_directory(profile)
    # Chromium resolves per-user native manifests relative to --user-data-dir,
    # not the default Chrome for Testing application-support directory.
    host = write_host_launcher(root)
    write_manifest(profile / 'NativeMessagingHosts' / f'{NATIVE_HOST_NAME}.json', host)
    reset_stale_extension_worker(profile, Path(extension))
    # pareto-legacy: remove after 2027-08-23. One-time migration: a profile created before the rename still holds the old-name manifest.
    legacy_manifest = profile / 'NativeMessagingHosts' / 'com.imploselabs.overseer_browser.json'  # pareto-legacy
    if legacy_manifest.exists() or legacy_manifest.is_symlink():
        legacy_manifest.unlink()
        print(f'overseer-browser: migrated native messaging host to com.paretocybernetics.overseer_browser; removed legacy manifest {legacy_manifest}', file=sys.stderr)
    running = root / 'supervisor.running'
    # Exclusive creation also protects concurrent or abandoned startup attempts.
    fd = os.open(running, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    process = None
    load_flags = [f'--load-extension={extension}']
    if load_mode in {'exclusive', 'disable-extensions-except'}:
        load_flags.insert(0, f'--disable-extensions-except={extension}')
    record = {
        'version': 1,
        'started_at': time.time(),
        'chrome': chrome,
        'chrome_version': _chrome_version(chrome),
        'extension': extension,
        'extension_version': _extension_version(Path(extension)),
        'native_host': str(host),
        'load_mode': load_mode,
        'flags': load_flags,
        'profile': str(profile),
    }
    try:
        env = {**os.environ, 'OVERSEER_BROWSER_RUNTIME': str(root), 'OVERSEER_BROWSER_ISOLATED_PROFILE': str(profile)}
        process = subprocess.Popen([chrome, f'--user-data-dir={profile}', *load_flags, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', 'about:blank'], env=env)
        with os.fdopen(fd, 'w') as state:
            json.dump({'pid': process.pid, 'profile': str(profile)}, state)
        write_state(root, {**record, 'chrome_pid': process.pid})
        while process.poll() is None and not (root / 'quit').exists():
            time.sleep(.1)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    finally:
        write_state(root, {**record, 'chrome_pid': process.pid if process else None,
                           'ended_at': time.time(), 'exit_code': process.poll() if process else None,
                           'quit_requested': (root / 'quit').exists()})
        running.unlink(missing_ok=True)
        (root / 'quit').unlink(missing_ok=True)


if __name__ == '__main__':
    supervise(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
