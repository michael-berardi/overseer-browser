"""Regression guards for the privacy promise: no telemetry clients and no default egress."""
from __future__ import annotations

import ast
import contextlib
import io
import os
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from cli.main import main

ROOT = Path(__file__).resolve().parents[1]
PY_DIRS = ('cli', 'native_host', 'scripts')
TS_DIRS = ('extension/src', 'extension/entrypoints')
FORBIDDEN_IMPORT_ROOTS = {
    'requests', 'httpx', 'aiohttp', 'httpcore', 'urllib3', 'sentry_sdk',
    'posthog', 'mixpanel', 'amplitude', 'segment', 'datadog', 'bugsnag',
    'opentelemetry', 'openai', 'anthropic',
}
FORBIDDEN_IMPORT_PATHS = {'urllib.request', 'http.client', 'http.server', 'socketserver'}
FORBIDDEN_SOCKET_ATTRS = {'AF_INET', 'AF_INET6', 'create_connection', 'gethostbyname'}
FORBIDDEN_PACKAGES = re.compile(
    r'(?:sentry|posthog|mixpanel|amplitude|segment|bugsnag|datadog|analytics|telemetry)', re.I)
FORBIDDEN_ENDPOINTS = re.compile(
    r'(?:sentry\.(?:io|net)|ingest\.sentry|api\.posthog\.com|api\.mixpanel\.com|'
    r'api\.amplitude\.com|api\.segment\.com|google-analytics\.com|googletagmanager\.com|'
    r'browser-intake-datadoghq\.com|analytics\.(?:pareto|implose)cybernetics\.com|'
    r'app[-_]?telemetry)', re.I)
FORBIDDEN_TS_CALLS = re.compile(r'\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon\s*\(')


def files_in(directory: Path, suffix: str):
    for path in sorted(directory.rglob('*' + suffix)):
        if 'node_modules' not in path.parts and '.output' not in path.parts:
            yield path


class PrivacyNoEgressTest(unittest.TestCase):
    def test_shipped_dependencies_have_no_telemetry_clients(self):
        package = json.loads((ROOT / 'extension/package.json').read_text(encoding='utf-8'))
        runtime_deps = package.get('dependencies', {})
        self.assertEqual(runtime_deps, {name: version for name, version in runtime_deps.items()
                                        if not FORBIDDEN_PACKAGES.search(name)})
        lock = json.loads((ROOT / 'extension/package-lock.json').read_text(encoding='utf-8'))
        installed = [key[len('node_modules/'):] for key in lock.get('packages', {})
                     if key.startswith('node_modules/')]
        self.assertEqual(installed, [name for name in installed if not FORBIDDEN_PACKAGES.search(name)])

    def test_python_runtime_has_no_outbound_http_clients_or_inet_sockets(self):
        for folder in PY_DIRS:
            for path in files_in(ROOT / folder, '.py'):
                tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
                with self.subTest(path=str(path.relative_to(ROOT))):
                    for node in ast.walk(tree):
                        if isinstance(node, ast.Import):
                            names = [alias.name for alias in node.names]
                        elif isinstance(node, ast.ImportFrom):
                            module = node.module or ''
                            names = [f'{module}.{alias.name}' for alias in node.names] if module else [alias.name for alias in node.names]
                        else:
                            names = []
                        for name in names:
                            self.assertNotIn(name, FORBIDDEN_IMPORT_PATHS)
                            self.assertNotIn(name.split('.')[0], FORBIDDEN_IMPORT_ROOTS)
                        if isinstance(node, ast.Attribute):
                            self.assertNotIn(node.attr, FORBIDDEN_SOCKET_ATTRS)

    def test_extension_sources_have_no_direct_network_calls_or_collection_endpoints(self):
        paths = [ROOT / 'extension/wxt.config.ts']
        for folder in TS_DIRS:
            paths.extend(files_in(ROOT / folder, '.ts'))
            paths.extend(files_in(ROOT / folder, '.tsx'))
        for path in paths:
            text = path.read_text(encoding='utf-8')
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertIsNone(FORBIDDEN_TS_CALLS.search(text))
                self.assertIsNone(FORBIDDEN_ENDPOINTS.search(text))
        config = (ROOT / 'extension/wxt.config.ts').read_text(encoding='utf-8')
        self.assertNotIn('update_url', config)
        self.assertNotIn('connect-src *', config)

    def test_build_settings_disable_registry_telemetry(self):
        for script in ('scripts/build-release.sh', 'scripts/manage-macos.sh'):
            build = (ROOT / script).read_text(encoding='utf-8')
            for setting in ('DO_NOT_TRACK=1', 'npm_config_audit=false', 'npm_config_fund=false'):
                with self.subTest(script=script, setting=setting):
                    self.assertIn(setting, build)

    def test_default_read_only_commands_open_no_socket(self):
        with patch('cli.main.socket.socket', side_effect=AssertionError('unexpected socket')) as socket_factory, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--version']), 0)
            self.assertEqual(main(['help']), 0)
        socket_factory.assert_not_called()


    def test_launch_logs_are_bounded_and_private(self):
        import tempfile
        from native_host import coalition
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'chrome.log'
            log.write_bytes(b'old line\n' * 400_000)  # ~3.6 MB, past the bound
            os.chmod(log, 0o644)
            coalition.bound_log(log)
            self.assertLessEqual(log.stat().st_size, coalition.LOG_KEEP_BYTES)
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertTrue(log.read_bytes().startswith(b'old line\n'))
            small = Path(tmp) / 'small.log'
            small.write_bytes(b'kept\n')
            coalition.bound_log(small)
            self.assertEqual(small.read_bytes(), b'kept\n')


if __name__ == '__main__':
    unittest.main()
