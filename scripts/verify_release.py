#!/usr/bin/env python3
"""Verify the public OverSeer Browser release identity and privacy invariants."""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import sys
from pathlib import Path

EXPECTED_VERSION = "0.1.1"
EXPECTED_EXTENSION_ID = "iabfdeokmilpklblkgccpjlekchfjcno"
EXPECTED_TELEMETRY_ENDPOINT = "https://analytics.libertydesign.studio/api/app-telemetry/event"
EXPECTED_TELEMETRY_SCHEMA = "lds.app-telemetry.event.v2"
EXPECTED_PUBLIC_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtsB8TWcXWqPl4DKi7y9AEri4e0ZXYzLEv/WM3T+qY6IkAskSX/WNcWwJNETRm5f6Pq02XONBu0SxJGW5gjVWcQ6+zd6Ke5jl/xKHFAJHdFOwXxul7qDlqSt4kTDiD7xECAT5c83FzhXHtiNO8xSM4cfFN40zK+moBA/mStTysLs1xHyG79ia19yOE2kNY9QmnvLSBRlfwrTxI7AbPWbEKV9LAYsucvqH40MdAaHS9Gem52dbdr/RUjy47rcLL/Cvm5buTHS7BSdj8fVGyQNCV6DXxs7ix7OLuNnHjC0lgdd25EhivYJ2h1oTFy7HCJ8Pg/fuRaImOODSdRcFNDcJswIDAQAB"
)
EXPECTED_EXTENSION_CSP = (
    "script-src 'self'; object-src 'self'; "
    "connect-src https://analytics.libertydesign.studio"
)
EXPECTED_PERMISSIONS = ["nativeMessaging", "storage", "scripting", "tabs", "windows", "activeTab"]
EXPECTED_HOST_PERMISSIONS = [
    "https://meet.google.com/*",
    "https://zoom.us/*",
    "https://*.zoom.us/*",
]
FORBIDDEN_BUNDLE_MARKERS = (
    "chrome.debugger",
    "chrome.webRequest",
    "chrome.history",
    "chrome.bookmarks",
    "BEGIN PRIVATE KEY",
    "client_secret",
    "refresh_token",
)


def extension_id(public_key: str) -> str:
    try:
        digest = hashlib.sha256(base64.b64decode(public_key, validate=True)).digest()[:16]
    except (ValueError, binascii.Error) as error:
        raise ValueError("manifest key is not valid base64") from error
    return "".join(chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0x0F)) for byte in digest)


def verify_artifact(artifact: Path) -> dict[str, object]:
    manifest_path = artifact / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"missing {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("manifest.json is not valid UTF-8 JSON") from error
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must contain an object")
    if manifest.get("manifest_version") != 3:
        raise ValueError("manifest_version must be 3")
    if manifest.get("version") != EXPECTED_VERSION:
        raise ValueError(f"version must be {EXPECTED_VERSION}")
    if manifest.get("key") != EXPECTED_PUBLIC_KEY:
        raise ValueError("manifest key does not match the stable public key")
    derived_id = extension_id(EXPECTED_PUBLIC_KEY)
    if derived_id != EXPECTED_EXTENSION_ID:
        raise ValueError("the configured stable extension ID does not match the public key")
    if "update_url" in manifest:
        raise ValueError("Chrome Web Store packages must not declare an external update_url")
    csp = manifest.get("content_security_policy")
    if not isinstance(csp, dict) or csp.get("extension_pages") != EXPECTED_EXTENSION_CSP:
        raise ValueError("extension_pages CSP does not match the privacy-safe policy")
    if manifest.get("permissions") != EXPECTED_PERMISSIONS:
        raise ValueError("required permissions drifted")
    if manifest.get("host_permissions") != EXPECTED_HOST_PERMISSIONS:
        raise ValueError("required host permissions drifted")

    if manifest.get("optional_host_permissions") != ["<all_urls>"]:
        raise ValueError("optional host permissions must contain only <all_urls>")
    serialized_manifest = json.dumps(manifest, sort_keys=True)
    if any(marker in serialized_manifest for marker in FORBIDDEN_BUNDLE_MARKERS[:4]):
        raise ValueError("manifest contains a forbidden browser API")
    bundle_files = [path for path in artifact.rglob("*") if path.is_file() and path != manifest_path]
    for path in bundle_files:
        if path.is_symlink() or path.name.startswith(".env") or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".token"}:
            raise ValueError(f"release artifact contains a forbidden secret-like file: {path.name}")
    bundle_text = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in bundle_files)
    for marker in FORBIDDEN_BUNDLE_MARKERS:
        if marker in bundle_text:
            raise ValueError(f"release artifact contains forbidden marker: {marker}")
    if EXPECTED_TELEMETRY_ENDPOINT not in bundle_text or EXPECTED_TELEMETRY_SCHEMA not in bundle_text or "batchId" not in bundle_text:
        raise ValueError("release artifact is missing the opted-in telemetry contract")
    return {"artifact": str(artifact), "version": EXPECTED_VERSION, "extension_id": EXPECTED_EXTENSION_ID}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path, help="built chrome-mv3 directory")
    args = parser.parse_args(argv)
    try:
        result = verify_artifact(args.artifact)
    except ValueError as error:
        print(f"release verification failed: {error}", file=sys.stderr)
        return 1
    print(f"release verified: {result['artifact']} version {result['version']} extension {result['extension_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
