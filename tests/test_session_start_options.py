from __future__ import annotations

import unittest

from cli.main import CLIError, _command_request, _require_mobile_support


class SessionStartOptionsTests(unittest.TestCase):
    def test_plain_start_keeps_its_old_shape(self) -> None:
        self.assertEqual(_command_request("sessions", ["start"]), ("sessions.start", {}))
        self.assertEqual(_command_request("sessions", ["start", "qa"]), ("sessions.start", {"name": "qa"}))

    def test_mobile_defaults_leave_the_size_to_the_extension(self) -> None:
        self.assertEqual(_command_request("sessions", ["start", "--mobile"]), ("sessions.start", {"mobile": True}))

    def test_mobile_size_and_name_in_any_order(self) -> None:
        expected = ("sessions.start", {"name": "qa", "mobile": True, "width": 414, "height": 896})
        self.assertEqual(_command_request("sessions", ["start", "qa", "--mobile", "--width", "414", "--height", "896"]), expected)
        self.assertEqual(_command_request("sessions", ["start", "--height", "896", "--mobile", "--width", "414", "qa"]), expected)

    def test_size_without_mobile_is_a_usage_error(self) -> None:
        for args in (["start", "--width", "375"], ["start", "--height", "812"]):
            with self.assertRaises(CLIError) as caught:
                _command_request("sessions", args)
            self.assertEqual(caught.exception.code, "usage")
            self.assertIn("only with --mobile", caught.exception.message)

    def test_malformed_options_are_usage_errors(self) -> None:
        for args in (["start", "--mobile", "--width"], ["start", "--mobile", "--width", "wide"], ["start", "a", "b"], ["start", "--mobile", "a", "b"]):
            with self.assertRaises(CLIError) as caught:
                _command_request("sessions", args)
            self.assertEqual(caught.exception.code, "usage")

    def test_old_extension_ignoring_mobile_is_reported_not_trusted(self) -> None:
        old = {"ok": True, "result": {"name": "qa", "started": True}}
        out = _require_mobile_support("sessions.start", {"mobile": True}, old)
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["code"], "extension_outdated")

    def test_mobile_result_and_plain_start_pass_through(self) -> None:
        new = {"ok": True, "result": {"mobile": {"width": 375, "height": 812}, "viewport": {"width": 375, "height": 812, "devicePixelRatio": 2}}}
        self.assertIs(_require_mobile_support("sessions.start", {"mobile": True}, new), new)
        plain = {"ok": True, "result": {"started": True}}
        self.assertIs(_require_mobile_support("sessions.start", {}, plain), plain)
        failed = {"ok": False, "error": {"code": "window_size_clamped"}}
        self.assertIs(_require_mobile_support("sessions.start", {"mobile": True}, failed), failed)


if __name__ == "__main__":
    unittest.main()
