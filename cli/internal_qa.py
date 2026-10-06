"""CLI-before-RPC QA policy. The generic raw RPC remains unchanged.

Explicit navigation URLs only. Ownership comes from scoped extension responses,
never session names, environment labels, URL ownership, or an operator relay.
"""
from __future__ import annotations

import re
import time
from typing import Any, Callable
from urllib.parse import unquote_plus, urlsplit

# Snapshot of overseer-j0268/scripts/lib/site-inventory.mjs: 47 apexes.
OWNED_APEXES = frozenset("""
libertydesign.studio property-perfected.com plataworks.com dubledger.com
 dubhaven.com juiceboxx.net lucerolegal.org argentinavisalaw.com
 buenosairesexpats.com expatsargentina.com uaeargentina.com dubaitoargentina.com
 turkeyargentina.com turkeytoargentina.com russiatoargentina.com russiaargentina.com
 esteticaeunoia.com chinatoargentina.com chineseargentina.com italiaargentina.com
 italianiargentina.com ukargentina.com britsinargentina.com espanaargentina.com
 espanaenargentina.com germanexpatargentina.com deutschlandargentinien.com
 francaisargentine.com argentinaparafrances.com dubmenu.com americansinargentina.com
 chilenosargentina.com uruguayosenargentina.com usatoargentina.com canadatoargentina.com
 canadiansinargentina.com realtybuilt.com simplygreenny.com aussiesinargentina.com
 australiatoargentina.com implosecybernetics.com imploselabs.com mileinews.com
 mouseia.org ottercasa.com plataplace.com platastar.com
""".split())
OWNED_HOSTS = OWNED_APEXES | frozenset("www." + host for host in OWNED_APEXES)
MARKER_KEY = "overseer_internal"
MARKER_PAIR = MARKER_KEY + "=1"


def is_owned_url(url: Any) -> bool:
    """Exact HTTP(S) apex/www; reject browser/parser-ambiguous authorities."""
    if not isinstance(url, str) or not re.match(r"(?i)^https?://", url):
        return False
    if any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url:
        return False
    try:
        parsed = urlsplit(url)
        # Accessing port also rejects malformed authorities/ports.
        parsed.port
        return parsed.hostname in OWNED_HOSTS
    except ValueError:
        return False


def mark_owned_url(url: str) -> str:
    """Replace every decoded marker key; preserve all other raw URL bytes.

    Decode keys only, never values. Duplicate/encoded marker aliases collapse
    to one canonical =1, matching the collector's strict duplicate handling.
    """
    if not is_owned_url(url):
        return url
    document, hash_sep, fragment = url.partition("#")
    base, query_sep, query = document.partition("?")
    if not query_sep:
        marked = base + "?" + MARKER_PAIR
    else:
        pairs = []
        found = False
        for pair in query.split("&"):
            key = pair.partition("=")[0]
            if unquote_plus(key, errors="replace") == MARKER_KEY:
                if not found:
                    pairs.append(MARKER_PAIR)
                found = True
            else:
                pairs.append(pair)
        if not found:
            # Keep even empty raw query pairs (including a trailing ampersand).
            query = query + "&" + MARKER_PAIR if query else MARKER_PAIR
        else:
            query = "&".join(pairs)
        marked = base + "?" + query
    return marked + hash_sep + fragment


def _ambiguous_navigation_url(url: Any) -> bool:
    """Refuse HTTP(S) syntax WHATWG can reinterpret; never rewrite URL bytes.

    This conservative syntax gate does not replace native permission guards.
    Only navigation fields are inspected, never opaque command values.
    """
    if not isinstance(url, str):
        return False
    # WHATWG strips surrounding C0/space and removes TAB/LF/CR anywhere.
    candidate = url.strip("".join(chr(c) for c in range(33)))
    candidate = candidate.replace("\t", "").replace("\n", "").replace("\r", "")
    if not re.match(r"(?i)^https?:", candidate):
        return False  # Native guards reject non-HTTP(S), without new permissions.
    if (not re.match(r"(?i)^https?://[^/]", url)
            or any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url):
        return True
    try:
        parsed = urlsplit(url)
        parsed.port
        host = parsed.hostname
        # Percent-decoding and UTS46/IDNA can produce owned ASCII hostnames.
        return not host or "%" in host or not host.isascii()
    except ValueError:
        return True


def _positive_id(value: Any) -> bool:
    return type(value) is int and value > 0


class _Scope:
    """One invocation's uncached, read-only proof; never selects/borrows tabs."""

    def __init__(self, request: Callable, session_key: str | None, timeout: float,
                 error_factory: Callable):
        self.error_factory = error_factory
        self.request = request
        self.session_key = session_key
        self.deadline = time.monotonic() + timeout
        self.session = None
        self.tabs = None

    def error(self, message: str):
        return self.error_factory("qa_scope_unverified", message)

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise self.error("QA scope verification exceeded the command timeout.")
        return remaining

    def load(self):
        if self.session is not None:
            return
        options = {"session_key": self.session_key} if self.session_key is not None else {}
        summaries = self.request("sessions.list", {}, timeout=self.remaining(), **options)
        tabs = self.request("tabs.list", {}, timeout=self.remaining(), **options)
        if (summaries.get("ok") is not True or tabs.get("ok") is not True
                or not isinstance(summaries.get("result"), list)
                or not isinstance(tabs.get("result"), list)):
            raise self.error("Owned navigation requires verified session/window and tab scope.")
        key = self.session_key if self.session_key is not None else "default"
        matches = [s for s in summaries["result"] if isinstance(s, dict) and s.get("sessionKey") == key]
        if len(matches) != 1:
            raise self.error("No unique extension-confirmed session scope for navigation.")
        session = matches[0]
        if (not _positive_id(session.get("agentWindowId"))
                or not isinstance(session.get("ownedTabIds"), list)
                or not isinstance(session.get("borrowedTabIds"), list)
                or not all(_positive_id(t) for t in session["ownedTabIds"] + session["borrowedTabIds"])):
            raise self.error("Extension did not report a complete agent-window scope.")
        self.session, self.tabs = session, tabs["result"]

    def target(self, params: dict) -> tuple[int, bool]:
        self.load()
        session, tabs = self.session, self.tabs
        tab_id = params.get("tab_id")
        if tab_id is None:
            # Mirrors SessionManager.getSelectedTabId: borrowed selection first,
            # then active owned-window tab, then selected/first available tab.
            selected = session.get("selectedTabId")
            if selected in session["borrowedTabIds"]:
                tab_id = selected
            else:
                active = [t for t in tabs if isinstance(t, dict)
                          and t.get("windowId") == session["agentWindowId"] and t.get("active") is True]
                if len(active) == 1:
                    tab_id = active[0].get("id")
                elif _positive_id(selected):
                    tab_id = selected
        if not _positive_id(tab_id):
            raise self.error("Navigation target is ambiguous; use an owned --tab-id.")
        matches = [t for t in tabs if isinstance(t, dict) and t.get("id") == tab_id]
        if len(matches) != 1:
            raise self.error("Navigation target is not present in this session's tab list.")
        if tab_id in session["borrowedTabIds"]:
            return tab_id, False
        if matches[0].get("windowId") != session["agentWindowId"]:
            raise self.error("Navigation target is not in the verified Agent Window.")
        return tab_id, True


def prepare_cli_navigation(command: str, params: dict[str, Any], *, request: Callable,
                           session_key: str | None, timeout: float,
                           error_factory: Callable, serialized_batch_size: Callable,
                           max_request_bytes: int) -> dict[str, Any]:
    """Call only after CLI option/operand/target validation, before its RPC.

    Never call from generic request_once/_request_once. Unknown scope blocks an
    owned-host navigate (no unmarked first load). Borrowed URLs remain untouched.
    """
    scope = _Scope(request, session_key, timeout, error_factory)

    def prepare(cmd: str, values: dict, selection_changed: bool = False):
        if cmd not in {"navigate", "tabs.create"}:
            return values
        if _ambiguous_navigation_url(values.get("url")):
            raise scope.error("Ambiguous HTTP(S) URL syntax; use a canonical ASCII hostname URL.")
        if not is_owned_url(values.get("url")):
            return values
        if cmd == "navigate":
            if selection_changed and "tab_id" not in values:
                raise scope.error("Scope-changing batches require explicit owned tab_id for navigation.")
            tab_id, owned = scope.target(values)
            if not owned:
                # Selection can change after proof: pin borrowed targets too.
                return {**values, "tab_id": tab_id}
            return {**values, "tab_id": tab_id, "url": mark_owned_url(values["url"])}
        # Existing extension contract: createTab always creates in Agent Window;
        # a mobile window refuses creation rather than spilling into user tabs.
        return {**values, "url": mark_owned_url(values["url"])}

    if command != "batch":
        return prepare(command, params)
    actions = params.get("actions")
    if not isinstance(actions, list):
        return params  # Validation belongs to CLI, not this policy.
    result = []
    selection_changed = False
    for action in actions:
        cmd = action["command"]
        values = action.get("params", {})
        updated = prepare(cmd, values, selection_changed)
        result.append(action if updated is values else {**action, "params": updated})
        # Arbitrary page actions can open/select a new tab. Do not guess.
        if cmd in {"tabs.create", "tabs.select", "tabs.close", "tabs.return", "click", "press", "evaluate"}:
            selection_changed = True
    updated = {**params, "actions": result}
    # Markers increase payload size: validate again locally before broker/native.
    if serialized_batch_size(updated) > max_request_bytes:
        raise error_factory("usage", "marked batch request exceeds the request bound")
    return updated
