#!/usr/bin/env python3
"""Package, and optionally publish, a verified Chrome Web Store artifact.

Credentials are read only from CHROME_WEB_STORE_CLIENT_ID,
CHROME_WEB_STORE_CLIENT_SECRET, and CHROME_WEB_STORE_REFRESH_TOKEN. The
publisher ID is read from CHROME_WEB_STORE_PUBLISHER_ID. None are written to
disk or included in command output.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from verify_release import EXPECTED_EXTENSION_ID, verify_artifact  # noqa: E402

TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE_URL = "https://chromewebstore.googleapis.com/v2"
UPLOAD_BASE_URL = "https://chromewebstore.googleapis.com/upload/v2"
PUBLISHER_ID_NAME = "CHROME_WEB_STORE_PUBLISHER_ID"
CREDENTIAL_NAMES = (
    "CHROME_WEB_STORE_CLIENT_ID",
    "CHROME_WEB_STORE_CLIENT_SECRET",
    "CHROME_WEB_STORE_REFRESH_TOKEN",
)
UPLOAD_SUCCEEDED = frozenset({"SUCCEEDED", "SUCCESS"})
UPLOAD_IN_PROGRESS = frozenset({"IN_PROGRESS", "UPLOAD_IN_PROGRESS"})
PUBLISH_ACCEPTED = frozenset({"PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"})
UPLOAD_POLL_SECONDS = 2.0
UPLOAD_TIMEOUT_SECONDS = 120.0


def package_artifact(artifact: Path, output: Path) -> None:
    artifact = artifact.resolve()
    output = output.resolve()
    if output == artifact or artifact in output.parents:
        raise RuntimeError("zip destination must be outside the build artifact")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(artifact.rglob("*")):
                if path.is_file() and not path.is_symlink():
                    archive.write(path, path.relative_to(artifact).as_posix())
        os.chmod(temporary, 0o600)
        os.replace(temporary, output)
        os.chmod(output, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def request_json(
    url: str, *, method: str, data: bytes | None, headers: dict[str, str]
) -> dict[str, object]:
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        status = getattr(error, "code", "request-error")
        raise RuntimeError(f"Chrome Web Store request failed ({status})") from None
    if not isinstance(parsed, dict):
        raise RuntimeError("Chrome Web Store returned an invalid response")
    return parsed


def access_token() -> str:
    missing = [name for name in CREDENTIAL_NAMES if not os.environ.get(name)]
    if missing:
        raise RuntimeError("publishing requires environment variables: " + ", ".join(missing))
    values = {name: os.environ[name] for name in CREDENTIAL_NAMES}
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": values["CHROME_WEB_STORE_CLIENT_ID"],
            "client_secret": values["CHROME_WEB_STORE_CLIENT_SECRET"],
            "refresh_token": values["CHROME_WEB_STORE_REFRESH_TOKEN"],
        }
    ).encode("ascii")
    response = request_json(
        TOKEN_URL,
        method="POST",
        data=body,
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    token = response.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("OAuth token response did not contain an access token")
    return token


def publisher_item_urls() -> tuple[str, str, str]:
    publisher_id = os.environ.get(PUBLISHER_ID_NAME, "").strip()
    if not publisher_id:
        raise RuntimeError(f"publishing requires environment variable: {PUBLISHER_ID_NAME}")
    quoted_publisher = urllib.parse.quote(publisher_id, safe="")
    quoted_item = urllib.parse.quote(EXPECTED_EXTENSION_ID, safe="")
    resource = f"publishers/{quoted_publisher}/items/{quoted_item}"
    return (
        f"{UPLOAD_BASE_URL}/{resource}:upload",
        f"{API_BASE_URL}/{resource}:fetchStatus",
        f"{API_BASE_URL}/{resource}:publish",
    )


def wait_for_upload(status_url: str, auth: dict[str, str]) -> None:
    deadline = time.monotonic() + UPLOAD_TIMEOUT_SECONDS
    while True:
        status = request_json(status_url, method="GET", data=None, headers=auth)
        state = status.get("lastAsyncUploadState")
        if state in UPLOAD_SUCCEEDED:
            return
        if state not in UPLOAD_IN_PROGRESS:
            raise RuntimeError(f"Chrome Web Store upload failed with state {state!r}")
        if time.monotonic() >= deadline:
            raise RuntimeError("Chrome Web Store upload did not finish within 120 seconds")
        time.sleep(UPLOAD_POLL_SECONDS)


def publish(zip_path: Path, token: str) -> None:
    auth = {"authorization": f"Bearer {token}"}
    upload_url, status_url, publish_url = publisher_item_urls()
    uploaded = request_json(
        upload_url,
        method="POST",
        data=zip_path.read_bytes(),
        headers={**auth, "content-type": "application/zip"},
    )
    upload_state = uploaded.get("uploadState")
    if upload_state in UPLOAD_IN_PROGRESS:
        wait_for_upload(status_url, auth)
    elif upload_state not in UPLOAD_SUCCEEDED:
        raise RuntimeError(f"Chrome Web Store rejected the upload with state {upload_state!r}")
    published = request_json(
        publish_url,
        method="POST",
        data=b"{}",
        headers={**auth, "content-type": "application/json"},
    )
    state = published.get("state")
    if state not in PUBLISH_ACCEPTED:
        raise RuntimeError(f"Chrome Web Store did not accept the publish request (state {state!r})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=Path("extension/.output/chrome-mv3"))
    parser.add_argument("--zip", type=Path, help="zip destination; defaults to a private temporary path")
    parser.add_argument("--publish", action="store_true", help="upload and publish after verification")
    args = parser.parse_args(argv)
    try:
        result = verify_artifact(args.artifact)
        if args.zip is None:
            output = Path(tempfile.gettempdir()) / f"overseer-browser-{result['version']}.zip"
        else:
            output = args.zip.expanduser().resolve()
        package_artifact(args.artifact, output)
        if args.publish:
            publish(output, access_token())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Chrome Web Store release failed: {error}", file=sys.stderr)
        return 1
    if args.publish:
        print(f"Chrome Web Store publish request submitted for {EXPECTED_EXTENSION_ID}; review status in the Web Store dashboard.")
    else:
        print(f"Chrome Web Store package created: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
