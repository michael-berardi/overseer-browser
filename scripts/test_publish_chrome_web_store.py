#!/usr/bin/env python3
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import publish_chrome_web_store as publisher


class ChromeWebStorePublisherTest(unittest.TestCase):
    def test_uses_v2_publisher_scoped_endpoints(self) -> None:
        with patch.dict(os.environ, {publisher.PUBLISHER_ID_NAME: "publisher-123"}, clear=False):
            upload, status, publish = publisher.publisher_item_urls()
        resource = f"publishers/publisher-123/items/{publisher.EXPECTED_EXTENSION_ID}"
        self.assertEqual(upload, f"{publisher.UPLOAD_BASE_URL}/{resource}:upload")
        self.assertEqual(status, f"{publisher.API_BASE_URL}/{resource}:fetchStatus")
        self.assertEqual(publish, f"{publisher.API_BASE_URL}/{resource}:publish")

    def test_polls_in_progress_upload_before_publishing(self) -> None:
        responses = [
            {"uploadState": "IN_PROGRESS"},
            {"lastAsyncUploadState": "IN_PROGRESS"},
            {"lastAsyncUploadState": "SUCCEEDED"},
            {"state": "PENDING_REVIEW"},
        ]
        calls: list[tuple[str, str]] = []

        def fake_request(url: str, *, method: str, data: bytes | None, headers: dict[str, str]) -> dict[str, object]:
            del data, headers
            calls.append((method, url))
            return responses.pop(0)

        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "extension.zip"
            package.write_bytes(b"zip")
            with (
                patch.dict(os.environ, {publisher.PUBLISHER_ID_NAME: "publisher-123"}, clear=False),
                patch.object(publisher, "request_json", side_effect=fake_request),
                patch.object(publisher.time, "sleep"),
            ):
                publisher.publish(package, "access-token")

        self.assertEqual([method for method, _ in calls], ["POST", "GET", "GET", "POST"])
        self.assertTrue(calls[0][1].endswith(":upload"))
        self.assertTrue(calls[-1][1].endswith(":publish"))

    def test_rejects_failed_upload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "extension.zip"
            package.write_bytes(b"zip")
            with (
                patch.dict(os.environ, {publisher.PUBLISHER_ID_NAME: "publisher-123"}, clear=False),
                patch.object(publisher, "request_json", return_value={"uploadState": "FAILED"}),
            ):
                with self.assertRaisesRegex(RuntimeError, "rejected the upload"):
                    publisher.publish(package, "access-token")


if __name__ == "__main__":
    unittest.main()
