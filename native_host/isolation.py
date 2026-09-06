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


def ensure_instance(paths: RuntimePaths, timeout: float) -> None:
    ensure_token(paths)
    if connected(paths):
        return
    running = paths.root / 'supervisor.running'
    if not running.exists():
        chrome = Path(os.environ.get('OVERSEER_BROWSER_CHROME', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
        install_root = Path(__file__).resolve().parents[1]
        source_root = install_root / 'source-root'
        default_extension = (Path(source_root.read_text().strip()) if source_root.is_file() else install_root) / 'chrome-extension'
        extension = Path(os.environ.get('OVERSEER_BROWSER_EXTENSION', str(default_extension))).resolve()
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


def supervise(root: Path, chrome: str, extension: str) -> None:
    paths = RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')
    ensure_private_directory(root)
    profile = root / 'profile'
    ensure_private_directory(profile)
    # Chromium resolves per-user native manifests relative to --user-data-dir,
    # not the default Chrome for Testing application-support directory.
    host = root.parent / 'overseer-browser-native-host'
    write_manifest(profile / 'NativeMessagingHosts' / 'com.imploselabs.overseer_browser.json', host)
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
