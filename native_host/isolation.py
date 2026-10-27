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
import time

try:
    from .runtime import RuntimePaths, ensure_private_directory, ensure_token, write_manifest
except ImportError:
    from runtime import RuntimePaths, ensure_private_directory, ensure_token, write_manifest


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


def ensure_instance(paths: RuntimePaths, timeout: float) -> None:
    ensure_token(paths)
    if connected(paths):
        return
    running = paths.root / 'supervisor.running'
    if not running.exists():
        chrome = Path(os.environ.get('OVERSEER_BROWSER_CHROME', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
        install_root = Path(__file__).resolve().parents[1]
        override = os.environ.get('OVERSEER_BROWSER_EXTENSION')
        extension = (Path(override) if override else default_extension(install_root)).resolve()
        if not chrome.is_file() or not (extension / 'manifest.json').is_file():
            raise ValueError('Set OVERSEER_BROWSER_CHROME to Chrome for Testing and OVERSEER_BROWSER_EXTENSION to the built chrome-extension directory')
        (paths.root / 'quit').unlink(missing_ok=True)
        with (paths.root / 'chrome.log').open('ab') as log:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(paths.root), str(chrome), str(extension)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if connected(paths):
            return
        time.sleep(.1)
    raise ValueError('Isolated Chrome is not connected. Enable OverSeer Browser native connection in the dedicated Chrome for Testing profile; never connect daily Chrome. See agent-v1/chrome.log.')


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


def supervise(root: Path, chrome: str, extension: str) -> None:
    paths = RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')
    ensure_private_directory(root)
    profile = root / 'profile'
    ensure_private_directory(profile)
    # Chromium resolves per-user native manifests relative to --user-data-dir,
    # not the default Chrome for Testing application-support directory.
    host = root.parent / 'overseer-browser-native-host'
    write_manifest(profile / 'NativeMessagingHosts' / 'com.paretocybernetics.overseer_browser.json', host)
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
    try:
        env = {**os.environ, 'OVERSEER_BROWSER_RUNTIME': str(root), 'OVERSEER_BROWSER_ISOLATED_PROFILE': str(profile)}
        process = subprocess.Popen([chrome, f'--user-data-dir={profile}', f'--load-extension={extension}', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', 'about:blank'], env=env)
        with os.fdopen(fd, 'w') as state:
            json.dump({'pid': process.pid, 'profile': str(profile)}, state)
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
        running.unlink(missing_ok=True)
        (root / 'quit').unlink(missing_ok=True)


if __name__ == '__main__':
    supervise(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
