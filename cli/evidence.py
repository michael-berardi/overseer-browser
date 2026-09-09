"""Foreground evidence composition over the existing session-scoped transport."""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path


def _save(path, payload):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _attempt(action):
    try:
        return action()
    except (OSError, ValueError, RuntimeError) as exc:
        return {'ok': False, 'error': {'code': getattr(exc, 'code', 'evidence_error'),
                                     'message': str(exc)}}


def doctor(request, version):
    """Report observed runtime facts; never present source host version as loaded."""
    from native_host.host import HOST_VERSION
    status = _attempt(lambda: request('health.status', {}))
    observed = status.get('result', {}) if status.get('ok') else {}
    extension = observed.get('extension_version')
    host = observed.get('host_version')
    drift = {name: {'expected': version, 'observed': value,
                    'state': 'unknown' if value is None else 'match' if value == version else 'drift'}
             for name, value in [('extension', extension), ('host', host)]}
    return {'ok': status.get('ok') is True and not any(v['state'] == 'drift' for v in drift.values()),
            'result': {'cli_version': version, 'host_source_version': HOST_VERSION,
                       'version_checks': drift, 'runtime_status': status,
                       'capture': {'qa_pack': True, 'screenshot_timelapse': True,
                                   'video_recording': 'user-consented native tab capture; source capability, not live verification',
                                   'recording_preflight': __import__('cli.recording', fromlist=['doctor']).doctor(),
                                   'network': 'Resource Timing metadata, not response bodies',
                                   'console': 'Only entries captured after console start'}}}


def collect(directory, request, materialize, version, session_key, *, tab_id=None, frames=None, interval=2.0, tracked=None):
    """Refuse existing destinations, preserving previous evidence and symlink safety."""
    directory = Path(directory).expanduser().absolute()
    if '..' in directory.parts:
        raise ValueError('evidence path must not contain parent traversal')
    # macOS /tmp and /var are system aliases; resolve only those roots.
    for alias in ('/tmp', '/var'):
        if str(directory).startswith(alias + '/'):
            directory = Path(alias).resolve() / directory.relative_to(alias)
            break
    for parent in reversed(directory.parents):
        if parent.is_symlink():
            raise ValueError('evidence path must not contain symlink parents')
        if not parent.exists():
            parent.mkdir(mode=0o700)
    directory.mkdir(mode=0o700, exist_ok=False)
    if tracked is not None:
        tracked.directory_created(directory)
    def save(path, payload):
        if tracked is None:
            return _save(path, payload)
        tracked.write_bytes(path, (json.dumps(payload, indent=2, ensure_ascii=False) + '\n').encode())
    started = time.monotonic()
    manifest = {'schema_version': 1, 'cli_version': version, 'session_key': session_key,
                'started_unix': time.time(), 'kind': 'timelapse' if frames else 'qa_pack',
                'artifacts': [], 'errors': [], 'complete': False,
                'limitations': ['Sequential, not an atomic page capture',
                                'Visible viewport only; console requires prior console start',
                                'Network is Resource Timing metadata, not response bodies']}
    if frames:
        manifest.update(requested_frames=frames, minimum_interval_seconds=interval)
    save(directory / 'manifest.json', manifest)

    def capture(name, command, params, image=False):
        if tab_id is not None:
            params = {**params, 'tab_id': tab_id}
        offset = time.monotonic() - started
        def perform():
            response = request(command, params)
            return materialize(response, directory / name) if image else response
        response = _attempt(perform)
        metadata_name = name + '.json' if image else name
        save(directory / metadata_name, response)
        artifact = {'file': name if response.get('ok') else None, 'response': metadata_name,
                    'command': command, 'offset_seconds': offset, 'ok': response.get('ok') is True}
        manifest['artifacts'].append(artifact)
        if not artifact['ok']:
            manifest['errors'].append({'command': command, 'error': response.get('error', {'code': 'invalid_response'})})
        save(directory / 'manifest.json', manifest)

    try:
        if frames:
            for index in range(frames):
                frame_start = time.monotonic()
                capture(f'frame-{index:04d}.png', 'screenshot.visible', {'format': 'png'}, True)
                if index + 1 < frames:
                    time.sleep(max(0, interval - (time.monotonic() - frame_start)))
        else:
            capture('snapshot.json', 'snapshot', {})
            capture('screenshot.png', 'screenshot.visible', {'format': 'png'}, True)
            capture('console.json', 'console.read', {})
            capture('network.json', 'network.read', {'limit': 200})
    except KeyboardInterrupt:
        manifest['errors'].append({'error': {'code': 'interrupted', 'message': 'Foreground capture interrupted'}})
    manifest['elapsed_seconds'] = time.monotonic() - started
    manifest['complete'] = not manifest['errors']
    save(directory / 'manifest.json', manifest)
    return {'ok': manifest['complete'], 'result': {'directory': str(directory), 'manifest': str(directory / 'manifest.json'),
                                                 'errors': manifest['errors']}}
