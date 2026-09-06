"""Reconnect before sending, never replay a possibly executed browser mutation."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from cli.main import _request_once
from native_host.runtime import RuntimePaths, ensure_token


class ConnectionRecoveryTests(unittest.TestCase):
    def test_absent_socket_retries_before_sending_once(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            paths = RuntimePaths(root, root / 'overseer-browser.sock', root / 'token')
            ensure_token(paths)
            failed, live = MagicMock(), MagicMock()
            failed.connect.side_effect = FileNotFoundError()
            response = {'version': 1, 'kind': 'response', 'request_id': 'test', 'ok': True, 'result': {'title': 'Recovered'}}
            with patch('cli.main.socket.socket', side_effect=[failed, live]), patch('cli.main.time.sleep'), patch('cli.main.read_frame', return_value=response):
                self.assertEqual(_request_once('evaluate', {'source': 'document.title'}, timeout=2, paths=paths, request_id='test'), response)
            failed.close.assert_called_once()
            failed.sendall.assert_not_called()
            live.sendall.assert_called_once()
