"""Private, identity-checked registry for tool-created OS-temp outputs.

No directory traversal/deletion: only registered, unchanged regular files.
Reservations bound cooperating writers; active reservations expire after two hours.
"""
import contextlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import uuid
from cli import recording

TTL = 900
ACTIVE_TTL = 7200
MAX_COUNT = 512
MAX_BYTES = 512 * 1024 * 1024


def eligible(path):
    path = Path(path).expanduser().absolute()
    roots = [Path(tempfile.gettempdir()).resolve()]
    if os.name == 'posix':
        roots.extend(Path(p).resolve() for p in ('/tmp', '/var/tmp'))
    # Publication replaces the final pathname; a file symlink must not make
    # a temp destination masquerade as an outside-temp durable export.
    resolved = path.resolve() if path.is_dir() and not path.is_symlink() else path.parent.resolve() / path.name
    return any(resolved.is_relative_to(root) for root in roots)


def _root():
    if recording.fcntl is None or not hasattr(os, 'getuid'):
        raise ValueError('Automatic temp cleanup requires POSIX file locking; use --keep for outputs')
    root = Path(tempfile.gettempdir()) / ('overseer-outputs-v1-' + str(os.getuid()))
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe output registry')
    return root


@contextlib.contextmanager
def _registry():
    root = _root()
    fd = os.open(root / 'registry.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('Unsafe output metadata')
        recording.fcntl.flock(lock, recording.fcntl.LOCK_EX)
        try:
            descriptor = os.open(root / 'registry.json', os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            rows = []
        else:
            with os.fdopen(descriptor, 'r') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise ValueError('Unsafe output metadata')
                raw = stream.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError('Output metadata exceeds size limit')
                rows = json.loads(raw) if raw else []
                if not isinstance(rows, list):
                    raise ValueError('Invalid output metadata')
        # Only atomic-journal debris in this private registry namespace.
        for part in root.glob('registry-*.part'):
            token = part.name[9:-5]
            if len(token) == 32 and all(c in '0123456789abcdef' for c in token) and not part.is_symlink():
                part.unlink()
        yield rows
        encoded = json.dumps(rows).encode()
        if len(encoded) > 1024 * 1024:
            raise ValueError('Output metadata exceeds size limit')
        temporary = root / ('registry-' + uuid.uuid4().hex + '.part')
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, root / 'registry.json')
            directory_fd = os.open(root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)


def _identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('Output is not an owned regular file')
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _reap(rows, now):
    remaining = []
    for row in rows:
        if row['expires'] > now:
            remaining.append(row)
            continue
        failed = False
        for item in row.get('files', []):
            path = Path(item['path'])
            try:
                # Parent resolution must still be identical; never follow a replaced directory.
                if str(path.resolve()) == str(path) and eligible(path):
                    actual = _identity(path)
                    matches = actual[:4] == item['identity'][:4] if item.get('pending') else actual == item['identity']
                    if matches and path.lstat().st_nlink == 1:
                        path.unlink()
                    elif matches and item.get('pending'):
                        failed = True  # Wait for the independently owned staging lease to release its link.
            except FileNotFoundError:
                pass
            except ValueError:
                pass
            except OSError:
                failed = True
        for item in reversed(row.get('directories', [])):
            path = Path(item['path'])
            try:
                info = path.lstat()
                if not path.is_symlink() and [info.st_dev, info.st_ino] == item['identity']:
                    path.rmdir()  # Never recursive: preserve unrelated additions.
            except OSError:
                pass
        if failed:
            remaining.append(row)
    rows[:] = remaining


def reap_outputs():
    if recording.fcntl is None or not hasattr(os, 'getuid'):
        return
    with _registry() as rows:
        _reap(rows, time.time())


class TrackedPaths(list):
    """Write-ahead publication from crash-reapable private staging."""
    def __init__(self, token, byte_limit, count):
        super().__init__()
        self.token, self.byte_limit, self.count = token, byte_limit, count
        self.directories = []

    def directory_created(self, path):
        path = Path(path).resolve()
        info = path.lstat()
        if str(path) in self.directories:
            return
        if len(self.directories) + len(set(self)) + 1 > self.count:
            raise ValueError('Temp output exceeded reserved count')
        with _registry() as rows:
            row = next(r for r in rows if r['token'] == self.token)
            row.setdefault('directories', []).append({'path':str(path), 'identity':[info.st_dev, info.st_ino]})
        self.directories.append(str(path))

    def publish(self, source, destination, *, no_clobber=False):
        source, destination = Path(source), Path(destination).absolute()
        destination = destination.parent.resolve() / destination.name
        if destination.is_symlink() or not eligible(destination):
            raise ValueError('Unsafe temporary publication destination')
        identity = _identity(source)
        others = {str(Path(p).resolve()) for p in self} - {str(destination)}
        used = sum(Path(p).stat().st_size for p in others if Path(p).is_file())
        if used + identity[2] > self.byte_limit or len(others) + len(self.directories) + 1 > self.count:
            raise ValueError('Temp output exceeded reserved bounds')
        intent = {'path':str(destination), 'identity':identity, 'pending':True}
        with _registry() as rows:
            row = next(r for r in rows if r['token'] == self.token)
            row.setdefault('files', []).append(intent)
        # The final pathname is registered before it can acquire any bytes.
        if no_clobber:
            os.link(source, destination)
            source.unlink()
        else:
            os.replace(source, destination)
        with _registry() as rows:
            row = next(r for r in rows if r['token'] == self.token)
            row['files'] = [f for f in row['files'] if f['path'] != str(destination)]
            actual = _identity(destination)
            # Rename/link may change ctime; do not adopt a concurrent replacement
            # or content edit while finalizing the publication journal.
            if actual is None or actual[:4] != identity[:4]:
                actual = identity
            row['files'].append({'path':str(destination), 'identity':actual})
        if str(destination) not in self:
            self.append(str(destination))

    def write_bytes(self, destination, data):
        if len(data) > self.byte_limit:
            raise ValueError('Temp output exceeded reserved bounds')
        missing = []
        parent = Path(destination).absolute().parent
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        destination_path = Path(destination).absolute()
        key = str(destination_path.parent.resolve() / destination_path.name)
        if len(set(self)) + len(self.directories) + len(missing) + int(key not in self) > self.count:
            raise ValueError('Temp output exceeded reserved count')
        for parent in reversed(missing):
            try:
                parent.mkdir(mode=0o700)
            except FileExistsError:
                continue
            self.directory_created(parent)
        with recording.managed_staging() as directory:
            source = Path(directory) / 'output'
            with source.open('xb') as stream:
                os.chmod(source, 0o600)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.publish(source, destination)


@contextlib.contextmanager
def reservation(path, *, keep=False, byte_limit=128 * 1024 * 1024, count=256):
    """Reserve before writing. Caller must bound writes and supply exact created paths."""
    if keep or not eligible(path):
        yield None
        return
    token = uuid.uuid4().hex
    now = time.time()
    row = dict(token=token, active=True, expires=now + ACTIVE_TTL, bytes=byte_limit, count=count, files=[])
    with _registry() as rows:
        _reap(rows, now)
        attempted = set()
        while sum(r['bytes'] for r in rows) + byte_limit > MAX_BYTES or sum(r['count'] for r in rows) + count > MAX_COUNT:
            completed = [r for r in rows if not r.get('active', not bool(r.get('files'))) and r['token'] not in attempted]
            if not completed:
                raise ValueError('Managed temp output quota occupied by active work or failed cleanup; retry later')
            oldest = min(completed, key=lambda r: r['expires'])
            attempted.add(oldest['token'])
            oldest['expires'] = now
            _reap(rows, now)
        rows.append(row)
    paths = TrackedPaths(token, byte_limit, count)
    try:
        yield paths
    finally:
        files = []
        seen = set()
        for candidate in dict.fromkeys(map(str, paths)):
            candidate = Path(candidate).absolute()
            if eligible(candidate) and not candidate.is_symlink():
                candidate = candidate.resolve()
                if str(candidate) in seen:
                    continue
                seen.add(str(candidate))
                try:
                    files.append(dict(path=str(candidate), identity=_identity(candidate)))
                except FileNotFoundError:
                    pass
        with _registry() as rows:
            found = next((r for r in rows if r['token'] == token), None)
            if found is not None:
                # Keep publication-time identity: never adopt a replacement or
                # an operator edit made while a long evidence capture is running.
                recorded = {f['path']:f for f in found.get('files', []) if not f.get('pending')}
                files = [recorded.get(f['path'], f) for f in files]
                # Preserve write-ahead intents when publication was interrupted.
                known = {f['path'] for f in files}
                files.extend(f for f in found.get('files', []) if f['path'] not in known)
                found.update(active=False, files=files, bytes=sum(f['identity'][2] for f in files), count=len(files) + len(found.get('directories', [])), expires=time.time() + TTL)
                if not files and not found.get('directories'):
                    rows.remove(found)
        if len(files) > count or sum(f['identity'][2] for f in files) > byte_limit:
            raise ValueError('Temp output exceeded reserved bounds')


def default_screenshot():
    base = Path('/tmp/screenshots') if os.name == 'posix' else Path(tempfile.gettempdir()) / 'screenshots'
    return base / ('overseer-screenshot-' + uuid.uuid4().hex + '.png')


def metadata(path, keep=False):
    return {'path': str(Path(path).absolute()), 'expires_unix': time.time() + TTL if not keep and eligible(path) else None}
