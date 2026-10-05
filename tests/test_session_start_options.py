from __future__ import annotations

import unittest

from cli.main import CLIError, _command_request


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


if __name__ == "__main__":
    unittest.main()
