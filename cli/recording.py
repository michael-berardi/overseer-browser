"""Foreground export of bounded, user-approved native tab video."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


# Only this private namespace is eligible for automatic deletion. Active leases
# are flock-protected even across CLI processes; rejected allocations fail closed.
import contextlib
try:
    import fcntl
except ImportError:  # Non-staging commands remain available on Windows.
    fcntl = None
import stat
import threading
import time
import uuid

STAGING_TTL = 900
STAGING_COUNT = 4
STAGING_BYTES = 512 * 1024 * 1024
_sweeper_started = False
_sweeper_lock = threading.Lock()


def _staging_root():
    if fcntl is None or not hasattr(os, 'getuid'):
        raise ValueError('Managed media staging requires POSIX file locking; use a supported POSIX host')
    root = Path(tempfile.gettempdir()) / f'overseer-media-v1-{os.getuid()}'
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe managed media directory')
    return root


def reap_staging():
    """Reap expired, unlocked leases only; safe for a persistent host timer."""
    if fcntl is None:
        return
    root = _staging_root()
    with open(root / '.lock', 'a') as lock:
        os.chmod(root / '.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        for directory in root.glob('lease-*'):
            try:
                if directory.is_symlink() or not directory.is_dir():
                    continue
                marker = directory / '.lease'
                fd = os.open(marker, os.O_RDWR | os.O_NOFOLLOW)
                with os.fdopen(fd, 'r') as lease:
                    info = os.fstat(lease.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                        continue
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    if time.time() - info.st_mtime >= STAGING_TTL:
                        for child in directory.iterdir():
                            if child.name != '.lease':
                                if child.is_dir() and not child.is_symlink():
                                    shutil.rmtree(child)
                                else:
                                    child.unlink()
                        shutil.rmtree(directory)
            except OSError:
                # Permission/transient unlink failures remain charged to quotas
                # and are retried on the next sweep, never silently forgotten.
                continue


def _start_sweeper():
    global _sweeper_started
    with _sweeper_lock:
        if _sweeper_started:
            return
        _sweeper_started = True
        def sweep():
            while True:
                time.sleep(30)
                try:
                    reap_staging()
                except OSError:
                    pass
        threading.Thread(target=sweep, daemon=True, name='media-cleanup').start()


@contextlib.contextmanager
def managed_staging():
    """Disposable staging lease, NOT a user-kept output directory.

    Callers must bound writes to 128 MiB and finish/release within 15 minutes.
    Four reserved slots cap aggregate cooperating writers at 512 MiB.
    """
    _staging_root()
    reap_staging()
    root = _staging_root()
    with open(root / '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = list(root.glob('lease-*'))
        total = sum(p.stat().st_size for d in entries if not d.is_symlink()
                    for p in d.rglob('*') if p.is_file() and not p.is_symlink())
        if len(entries) >= STAGING_COUNT or total + 128 * 1024 * 1024 > STAGING_BYTES:
            raise ValueError('Managed media staging quota exhausted')
        directory = root / ('lease-' + uuid.uuid4().hex)
        directory.mkdir(mode=0o700)
        lease = open(directory / '.lease', 'x')
        os.chmod(directory / '.lease', 0o600)
        fcntl.flock(lease, fcntl.LOCK_EX)
    try:
        yield str(directory)
    finally:
        try:
            # Keep the marker until all data is removed, allowing retry/recovery.
            for child in directory.iterdir():
                if child.name != '.lease':
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
            lease.close()
            shutil.rmtree(directory)
        except OSError:
            os.utime(directory / '.lease', (0, 0))
        finally:
            lease.close()


def doctor():
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    try:
        codecs = subprocess.run([ffmpeg, '-hide_banner', '-encoders'], capture_output=True, text=True, timeout=10).stdout if ffmpeg else ''
    except (OSError, subprocess.SubprocessError):
        codecs = ''
    verified = False
    if ffmpeg and 'libx264' in codecs:
        try:
            with managed_staging() as tmp:
                probe = Path(tmp) / 'probe.mp4'
                result = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(probe)], capture_output=True, timeout=15)
                verified = result.returncode == 0 and probe.is_file() and probe.stat().st_size > 0
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return {'ffmpeg': bool(ffmpeg), 'ffprobe': bool(ffprobe), 'mp4_h264': verified,
            'browser_codec': 'checked with MediaRecorder.isTypeSupported on consent', 'live_capture_verified': False}


def export(request, destination, *, publisher=None):
    path = Path(destination).expanduser()
    if path.suffix.lower() not in {'.webm', '.mp4'} or not path.parent.is_dir() or path.exists() or path.is_symlink():
        raise ValueError('Output must be a new .webm or .mp4 file in an existing directory')
    if path.suffix.lower() == '.mp4' and not doctor()['mp4_h264']:
        raise ValueError('MP4 requires installed ffmpeg with libx264')
    def call(command, params):
        response = request(command, params)
        if not response.get('ok'): raise ValueError(str(response.get('error')))
        return response['result']
    state = call('record.stop', {})
    try:
        if state.get('phase') != 'stopped' or state.get('reason') in {'byte_limit', 'encoder_error'}:
            raise ValueError(f'Recording is not exportable: {state}')
        size, count = state.get('bytes'), state.get('chunks')
        if type(size) is not int or not 0 < size <= 64 * 1024 * 1024 or count != (size + 196607) // 196608:
            raise ValueError('Invalid recording bounds')
        with managed_staging() as tmp:
            source = Path(tmp) / 'capture.webm'
            received = 0
            with os.fdopen(os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
                for index in range(count):
                    chunk = call('record.chunk', {'index': index})
                    encoded = chunk.get('data')
                    if not isinstance(encoded, str) or len(encoded) > 262144:
                        raise ValueError('Oversized recording chunk')
                    data = base64.b64decode(encoded, validate=True)
                    if chunk.get('index') != index or len(data) != min(196608, size - received) or received + len(data) > size:
                        raise ValueError('Invalid recording chunk')
                    stream.write(data); received += len(data)
            if received != size: raise ValueError('Truncated recording')
            output = source
            if path.suffix.lower() == '.mp4':
                output = Path(tmp) / 'capture.mp4'
                subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(source), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fs', '67108864', str(output)], check=True, timeout=360)
            limit = 63 * 1024 * 1024 if path.suffix.lower() == '.mp4' else 64 * 1024 * 1024 + 1
            if not 0 < output.stat().st_size < limit:
                raise ValueError('Output exceeds disk limit or is empty')
            evidence = {'encoded_frame_count': None, 'note': 'No frame-rate parity claim without decoded frame evidence'}
            if shutil.which('ffprobe'):
                evidence = json.loads(subprocess.run([shutil.which('ffprobe'), '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames,duration', '-of', 'json', str(output)], check=True, capture_output=True, text=True, timeout=360).stdout)
            os.chmod(output, 0o600)
            if publisher is None:
                os.link(output, path)  # atomic no-clobber publication
            else:
                publisher(output, path, no_clobber=True)
    finally:
        try:
            call('record.clear', {})
        except Exception:
            pass  # Recorder's independent retention deadline remains the fallback.
    return {'ok': True, 'result': {'path': str(path), 'capture': state, 'encoded_evidence': evidence}}
