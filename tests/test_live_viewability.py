"""Opt-in real-session regression for non-QA viewability evidence.

Run with OVERSEER_BROWSER_LIVE_VIEWABILITY=1 after installing the extension under
test. It starts its own bounded localhost fixture and one owned browser session,
then stops both in ``finally``. The normal test suite skips it because it needs
a real OverSeer Browser extension connection.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLI = os.environ.get("OVERSEER_BROWSER_CLI", "overseer-browser")
ENABLED = os.environ.get("OVERSEER_BROWSER_LIVE_VIEWABILITY") == "1"

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Viewability regression fixture</title>
<style>
 body { margin: 0; font: 16px system-ui, sans-serif; }
 #ad-card { width: 420px; height: 220px; margin: 80px auto; background: #d9ecff;
   border: 2px solid #175a9c; border-radius: 12px; }
 .spacer { height: 2400px; }
</style></head><body>
<div id="ad-card" data-zone="listing-feature">Visible ad card</div>
<div class="spacer"></div>
</body></html>"""

EVALUATE_SOURCE = """new Promise((resolve) => {
  const card = document.getElementById('ad-card');
  const callbacks = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    resolve({ visibility: document.visibilityState, callbacks });
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      callbacks.push({ visible: entry.isIntersecting, ratio: entry.intersectionRatio });
    }
    if (callbacks.some((entry) => entry.visible && entry.ratio >= 0.5)) {
      navigator.sendBeacon('/api/network/observability/client-event', JSON.stringify({
        kind: 'ad_impression', zone: 'listing-feature'
      }));
      finish();
    }
  }, { threshold: [0.5] });
  observer.observe(card);
  setTimeout(finish, 5000);
})"""


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(min(length, 8192))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


@unittest.skipUnless(ENABLED, "set OVERSEER_BROWSER_LIVE_VIEWABILITY=1 to run the real-session check")
class LiveViewabilityTests(unittest.TestCase):
    def test_visible_card_fires_observer_and_beacon_metadata_is_exposed(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        session_key = None
        try:
            def cli(*args: str):
                completed = subprocess.run(
                    [CLI, *args, "--raw-json"], capture_output=True, text=True, timeout=45,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
                payload = json.loads(completed.stdout.strip().splitlines()[-1])
                self.assertTrue(payload.get("ok"), payload)
                return payload.get("result", {})

            started = cli("sessions", "start", f"j4464-live-{os.getpid()}")
            session_key = started["sessionKey"]
            self.assertTrue(started["started"])
            cli("--session", session_key, "navigate", f"http://127.0.0.1:{server.server_port}/viewability.html")
            cli("--session", session_key, "network", "start")

            observed = cli("--session", session_key, "evaluate", EVALUATE_SOURCE)
            self.assertEqual(observed["visibility"], "visible")
            self.assertTrue(
                any(item["visible"] and item["ratio"] >= 0.5 for item in observed["callbacks"]),
                observed,
            )

            network = cli("--session", session_key, "network", "read", "200")
            self.assertTrue(network["capture"]["installed"])
            beacons = [
                entry for entry in network["beacons"]
                if entry["url"].endswith("/api/network/observability/client-event")
            ]
            self.assertTrue(beacons, network)
            beacon = beacons[-1]
            self.assertEqual(beacon["method"], "POST")
            self.assertEqual(beacon["source"], "navigator.sendBeacon")
            self.assertEqual(beacon["content_type"], "text/plain;charset=UTF-8")
            self.assertGreater(beacon["body_bytes"], 0)
            self.assertFalse(network["response_bodies"])
            self.assertNotIn("?", beacon["url"])
            self.assertNotIn("ad_impression", json.dumps(beacon))

            cli("--session", session_key, "network", "stop")
            after_stop = cli("--session", session_key, "network", "read", "200")
            self.assertFalse(after_stop["capture"]["installed"])
        finally:
            try:
                if session_key:
                    subprocess.run(
                        [CLI, "--session", session_key, "sessions", "stop", "--raw-json"],
                        capture_output=True, text=True, timeout=45, check=False,
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        listed = subprocess.run(
            [CLI, "sessions", "list", "--raw-json"],
            capture_output=True, text=True, timeout=45, check=False,
        )
        self.assertEqual(listed.returncode, 0, listed.stderr or listed.stdout)
        try:
            active = json.loads(listed.stdout.strip().splitlines()[-1]).get("result") or []
        except (ValueError, IndexError):
            self.fail("sessions list returned no valid JSON")
        self.assertTrue(
            all(entry.get("sessionKey") != session_key for entry in active),
            "the test session remained open",
        )


if __name__ == "__main__":
    unittest.main()
