"""The native host records every start/stop in <runtime>/host.log (Chrome drops stderr)."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from native_host import host


class HostLifecycleLogTest(unittest.TestCase):
    def test_refused_start_is_logged_with_cause(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, 0o700)
            with mock.patch.dict(os.environ, {"OVERSEER_BROWSER_RUNTIME": d}):
                with mock.patch.object(host.NativeHost, "__init__", side_effect=FileExistsError("browser host is already running")):
                    rc = host.main(["chrome-extension://iabfdeokmilpklblkgccpjlekchfjcno/", "--operator-relay"])
            self.assertEqual(rc, 1)
            text = (Path(d) / "host.log").read_text()
            self.assertIn(" start", text)
            self.assertIn("refused: browser host is already running", text)
            self.assertEqual(os.stat(Path(d) / "host.log").st_mode & 0o777, 0o600)

    def test_log_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, {"OVERSEER_BROWSER_RUNTIME": d}):
                for i in range(260):
                    host._lifecycle_log(f"e{i}")
            lines = (Path(d) / "host.log").read_text().splitlines()
            self.assertEqual(len(lines), 200)
            self.assertTrue(lines[-1].endswith("e259"))


if __name__ == "__main__":
    unittest.main()
