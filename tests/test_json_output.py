"""Browser output is always plain compact JSON, without encoder processes."""
import io
import json
import os
import unittest
from unittest.mock import patch
from cli.main import _render


class JsonOutputTests(unittest.TestCase):
    def test_same_minified_envelope_for_terminal_pipe_and_compatibility_flags(self):
        payload = {'ok': True, 'result': {'text': 'hello\nworld', 'items': [1, 2]}}
        expected = json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n'
        for terminal in (True, False):
            for flags in ((False, False), (True, False), (True, True)):
                out, err = io.StringIO(), io.StringIO()
                before = dict(os.environ)
                with patch('sys.stdout', out), patch('sys.stderr', err), patch.object(out, 'isatty', return_value=terminal), \
                     patch('cli.main.subprocess.run', side_effect=AssertionError('No output subprocess allowed')):
                    _render(payload, *flags)
                self.assertEqual(out.getvalue(), expected)
                self.assertEqual(err.getvalue(), '')
                self.assertEqual(dict(os.environ), before)

    def test_errors_are_json_too(self):
        out = io.StringIO()
        with patch('sys.stdout', out):
            _render({'ok': False, 'error': {'code': 'fixture', 'message': 'Denied'}}, False)
        self.assertEqual(json.loads(out.getvalue())['error']['code'], 'fixture')
        self.assertEqual(len(out.getvalue().splitlines()), 1)
