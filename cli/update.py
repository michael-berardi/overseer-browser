"""Anonymous release checks and opt-in update controls for the CLI.

The only automatic network request this tool makes is one anonymous GET to the
public GitHub "latest release" record. Everything else in this module is local
state: an at-most-daily cache, a persistent settings file, and the notice /
install helpers. The extension and native host never call this module.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

TOOL = "overseer-browser"
# A source checkout must check the project's own repository, not a build-time
# placeholder. Kept as the canonical URL so the shipped-source neutrality
# guard only has to allowlist that one documented form.
CANONICAL_REPOSITORY = "https://github.com/michael-berardi/overseer-browser"
RELEASE_SLUG = CANONICAL_REPOSITORY.removeprefix("https://github.com/")
USER_AGENT = "overseer-browser-update-check"
CHECK_INTERVAL_SECONDS = 24 * 60 * 60
# The exclusive marker is removed when the check finishes; this bound only
# recovers a missing marker. A completed check gates for 24 h; an unfinished
# one can be retried after this bound.
CHECK_CLAIM_SECONDS = 60.0
HTTP_TIMEOUT_SECONDS = 3.0
MAX_RESPONSE_BYTES = 1024 * 1024
# Detached update-install output is capped to its newest 256 KiB.
INSTALL_LOG_MAX_BYTES = 256 * 1024
STATE_DIR_ENV = "OVERSEER_BROWSER_UPDATE_STATE_DIR"
OPT_OUT_ENV = "OVERSEER_BROWSER_NO_UPDATE_CHECK"
AUTO_MARKER_ENV = "OVERSEER_BROWSER_AGENT"
AGENT_ENV_MARKERS = ("ULTRATERM_SLOT", "ULTRATERM_TMUX_SESSION", AUTO_MARKER_ENV)
CI_ENV_MARKERS = ("CI", "GITHUB_ACTIONS", "BUILD_NUMBER")
STABLE_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")

CACHE_DEFAULTS: dict[str, Any] = {
    "version": 1,
    "checked_at": 0.0,
    "checking_at": 0.0,
    "latest": None,
    "error": None,
    "shown": {},
    "skipped": None,
    "assets": {},
}
SETTINGS_DEFAULTS: dict[str, Any] = {
    "version": 1,
    "checks_enabled": True,
    "auto_install": False,
    "auto_asked": False,
}


def release_slug() -> str:
    override = os.environ.get("OVERSEER_BROWSER_RELEASE_REPO", "").strip()
    slug = override or RELEASE_SLUG
    return slug if SLUG_RE.fullmatch(slug) else RELEASE_SLUG


def release_url() -> str:
    return "https://api.github.com/repos/" + release_slug() + "/releases/latest"


def state_root() -> Path:
    """Private per-user state directory; the env override keeps tests isolated."""
    override = os.environ.get(STATE_DIR_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "OverSeer" / "browser" / "update"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "overseer-browser"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "overseer-browser"


def cache_path() -> Path:
    return state_root() / "update-check.json"


def claim_path() -> Path:
    return state_root() / "update-check.inflight"


def settings_path() -> Path:
    override = os.environ.get(STATE_DIR_ENV, "").strip()
    if override:
        return Path(override).expanduser() / "update-settings.json"
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "OverSeer" / "browser"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "OverSeer" / "browser"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "overseer-browser"
    return base / "update-settings.json"


def _private_dir(path: Path) -> None:
    if path.is_symlink():
        raise PermissionError("update state directory must not be a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(path, 0o700)


def _read(path: Path, defaults: dict[str, Any]) -> dict[str, Any]:
    result = dict(defaults)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return result
    if not isinstance(data, dict):
        return result
    for key, default in defaults.items():
        value = data.get(key)
        if isinstance(default, bool):
            result[key] = value if isinstance(value, bool) else default
        elif isinstance(default, float):
            result[key] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default
        elif isinstance(default, dict):
            result[key] = value if isinstance(value, dict) else default
        elif isinstance(default, str) or default is None:
            result[key] = value if isinstance(value, str) or value is None else default
    return result


def _write(path: Path, data: dict[str, Any]) -> None:
    _private_dir(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=".update-state-", dir=str(path.parent))
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_cache() -> dict[str, Any]:
    return _read(cache_path(), CACHE_DEFAULTS)


def write_cache(cache: dict[str, Any]) -> None:
    _write(cache_path(), cache)


def read_settings() -> dict[str, Any]:
    return _read(settings_path(), SETTINGS_DEFAULTS)


def write_settings(settings: dict[str, Any]) -> dict[str, Any]:
    merged = dict(SETTINGS_DEFAULTS)
    merged.update({key: value for key, value in settings.items() if key in SETTINGS_DEFAULTS})
    _write(settings_path(), merged)
    return merged


def stable_version(tag: Any) -> Optional[tuple[int, int, int]]:
    """Only stable strict x.y.z tags count; prereleases and garbage do not."""
    if not isinstance(tag, str):
        return None
    match = STABLE_TAG_RE.fullmatch(tag.strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def is_newer(candidate: Any, current: str) -> bool:
    new = stable_version(candidate)
    old = stable_version(current)
    return bool(new and old and new > old)


def clean_tag(tag: Any) -> Optional[str]:
    if not is_newer(tag, "0.0.0"):
        return None
    text = tag.strip()
    return text[1:] if text.startswith("v") else text


def _cause(exc: BaseException) -> str:
    text = " ".join(str(exc).split())
    return (type(exc).__name__ + ": " + text if text else type(exc).__name__)[:240]


def _clear_claim() -> None:
    try:
        claim_path().unlink()
    except (FileNotFoundError, OSError):
        pass


def _live_claim(instant: float) -> Optional[float]:
    """Return the start of a claim still inside its short in-flight window.

    A claim left by a dead worker is not a 24-hour gate: after the claim
    window it is stale and another invocation may start a fresh check.
    """
    try:
        started = float(claim_path().read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return started if 0 <= instant - started < CHECK_CLAIM_SECONDS else None


def _in_progress(cache: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "checked": False, "latest": cache["latest"],
            "error": cache["error"], "assets": cache["assets"],
            "in_progress": True}


def _claim_check(instant: float) -> bool:
    """Record the start time before any GET; only one invoker owns the check."""
    path = claim_path()
    _private_dir(path.parent)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        try:
            text = path.read_text(encoding="utf-8").strip()
            started = float(text) if text else path.stat().st_mtime
        except (OSError, ValueError):
            started = 0.0
        if 0 <= instant - started < CHECK_CLAIM_SECONDS:
            return False
        try:
            path.unlink()
        except (FileNotFoundError, OSError):
            return False
        try:
            fd = os.open(path, flags, 0o600)
        except FileExistsError:
            return False
    try:
        cache = read_cache()
        cache["checking_at"] = instant
        write_cache(cache)
    except OSError:
        _clear_claim()
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(str(instant) + "\n")
    return True


def _fresh_check(instant: float, cache: dict[str, Any], force: bool = False) -> bool:
    """A completed result gates for 24 h; a live claim gates only briefly.

    The detached worker owns the claim from just before its GET until it
    records success or failure. A persisted start whose claim is gone (for
    example, a worker killed before it could write) is abandoned and must
    not make a later invocation — including ``update --check`` — report a
    false "current" state for 24 hours.
    """
    if _live_claim(instant) is not None:
        return True
    if force:
        return False
    checked = float(cache.get("checked_at") or 0.0)
    return checked > 0 and 0 <= instant - checked < CHECK_INTERVAL_SECONDS


def _finish_check(instant: float, latest: Optional[str], error: Optional[str],
                  assets: dict[str, str], ok: bool) -> dict[str, Any]:
    cache = read_cache()
    cache.update({"checked_at": instant, "checking_at": 0.0, "latest": latest,
                  "error": error, "assets": assets})
    try:
        write_cache(cache)
    except OSError as exc:
        error = _cause(exc)
        ok = False
    finally:
        _clear_claim()
    return {"ok": ok, "checked": True, "latest": latest, "error": error, "assets": assets}


def fetch_latest(get: Optional[Callable[[str, float], bytes]] = None) -> dict[str, Any]:
    """One anonymous GET; returns the stable tag and install asset URLs."""
    slug = release_slug()
    if not SLUG_RE.fullmatch(slug):
        raise ValueError("invalid release repository metadata")
    url = "https://api.github.com/repos/" + slug + "/releases/latest"
    if get is None:
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})

        def default_get(target: str, timeout: float) -> bytes:
            with urlopen(request if target == url else Request(target, headers={"User-Agent": USER_AGENT}),
                         timeout=timeout) as response:
                return response.read(MAX_RESPONSE_BYTES + 1)

        get = default_get
    payload = json.loads(get(url, HTTP_TIMEOUT_SECONDS).decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("draft") or payload.get("prerelease"):
        return {"tag": None, "assets": {}}
    tag = clean_tag(payload.get("tag_name"))
    assets: dict[str, str] = {}
    entries = payload.get("assets")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("name"), str) and isinstance(entry.get("browser_download_url"), str):
                if entry["name"] in {"overseer-browser.tar.gz", "SHA256SUMS", "overseer-browser.zip"}:
                    assets[entry["name"]] = entry["browser_download_url"]
    return {"tag": tag, "assets": assets}


def check(current: str, force: bool = False, get: Optional[Callable[[str, float], bytes]] = None,
          now: Optional[float] = None) -> dict[str, Any]:
    """Perform or reuse the at-most-daily check; always record failures locally.

    The start is claimed before the GET so concurrent invocations do not send
    a second request. The claim is short-lived: the detached worker writes a
    completed result or failure, and an abandoned claim can be retried.
    """
    instant = time.time() if now is None else now
    cache = read_cache()
    if _fresh_check(instant, cache, force=force):
        result = {"ok": True, "checked": False, "latest": cache["latest"],
                  "error": cache["error"], "assets": cache["assets"]}
        if _live_claim(instant) is not None:
            result["in_progress"] = True
        return result
    if not _claim_check(instant):
        return _in_progress(cache)
    try:
        release = fetch_latest(get)
    except (OSError, ValueError, URLError) as exc:
        return _finish_check(instant, None, _cause(exc), {}, False)
    return _finish_check(instant, release["tag"], None, release["assets"], True)


def skip_version(version: Optional[str] = None) -> str:
    cache = read_cache()
    target = version or cache.get("latest")
    if not clean_tag(target):
        raise ValueError("no stable version to skip; pass an x.y.z version")
    cache["skipped"] = target.strip()
    write_cache(cache)
    return cache["skipped"]


def notice_lines(current: str, dim: bool = False, now: Optional[float] = None) -> list[str]:
    """One notice per version per 24 h; skipped and failed checks stay silent."""
    cache = read_cache()
    latest = cache.get("latest")
    if cache.get("error") or not is_newer(latest, current) or cache.get("skipped") == latest:
        return []
    instant = time.time() if now is None else now
    shown = cache.get("shown") or {}
    last = shown.get(latest)
    if isinstance(last, (int, float)) and 0 <= instant - float(last) < CHECK_INTERVAL_SECONDS:
        return []
    shown[latest] = instant
    for old in sorted(shown, key=lambda key: shown[key])[:-8]:
        shown.pop(old, None)
    cache["shown"] = shown
    write_cache(cache)
    first = f"{TOOL} {latest} available (you have {current}) · run: {TOOL} update"
    second = f"turn on automatic updates: {TOOL} update --auto on · skip: {TOOL} update --skip"
    return [first, ("\x1b[2m" + second + "\x1b[0m") if dim else second]


def automatic_check_allowed(argv: Optional[list[str]] = None, environ: Optional[dict[str, str]] = None,
                            stdout: Any = None, stderr: Any = None) -> bool:
    """Interactive terminals only: no CI, agents, JSON output, or opt-outs."""
    env = dict(os.environ if environ is None else environ)
    words = list(argv or [])
    if any(word in {"-h", "--help", "--json", "--raw-json"} for word in words):
        return False
    stripped = [word for word in words if word.startswith("-") is False]
    if not stripped or stripped[0] in {"help", "version", "update", "install", "uninstall", "refresh-extension"}:
        return False
    if env.get(OPT_OUT_ENV, "").strip().lower() not in ("", "0", "false", "no", "off"):
        return False
    if any(env.get(name, "").strip().lower() not in ("", "0", "false", "no", "off") for name in CI_ENV_MARKERS):
        return False
    if any(env.get(name, "").strip() for name in AGENT_ENV_MARKERS):
        return False
    if env.get("TERM", "").strip().lower() == "dumb":
        return False
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    if not getattr(out, "isatty", lambda: False)() or not getattr(err, "isatty", lambda: False)():
        return False
    return bool(read_settings()["checks_enabled"])


def bound_install_log(log: Path, max_bytes: int = INSTALL_LOG_MAX_BYTES) -> None:
    """Keep detached update-install output owner-only and capped at 256 KiB.

    The log is rewritten in place (same inode), so a detached installer that
    still has it open keeps appending to the bounded file.
    """
    try:
        info = log.lstat()
    except OSError:
        return
    if not stat.S_ISREG(info.st_mode):
        return
    with contextlib.suppress(OSError):
        os.chmod(log, 0o600)
    if info.st_size <= max_bytes:
        return
    try:
        with log.open("rb") as handle:
            handle.seek(-max_bytes, os.SEEK_END)
            tail = handle.read()
        newline = tail.find(b"\n")
        if 0 <= newline < len(tail) - 1:
            tail = tail[newline + 1:]
        flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(log, flags)
        with os.fdopen(fd, "wb") as handle:
            handle.truncate(0)
            handle.write(tail)
    except OSError:
        pass


class BackgroundChecker:
    """Starts one check in a detached child; the CLI may exit immediately.

    A Python thread died with a fast command and left only a pre-request claim,
    so no result was ever cached. The child is a separate, low-priority,
    one-shot process: it owns the brief claim and writes success or failure to
    the private cache itself, whether or not the invoking CLI is still alive.
    """

    def __init__(self, current: str):
        self.current = current
        self.result: dict[str, Any] | None = None
        self.process: subprocess.Popen[bytes] | None = None
        self.spawn_error: str | None = None

    def start(self) -> None:
        cache = read_cache()
        if _fresh_check(time.time(), cache):
            self.result = {"ok": True, "checked": False, "latest": cache["latest"],
                           "error": cache["error"], "assets": cache["assets"]}
            return
        script = Path(__file__).with_name("update.py")
        command = [sys.executable, str(script), "--check-once", self.current]
        if os.name == "posix" and shutil.which("nice"):
            command = ["nice", "-n", "10", *command]
        creationflags = 0
        if os.name == "nt":
            # DETACHED_PROCESS | CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
            creationflags = 0x00000008 | 0x00000200 | 0x00004000
        environment = dict(os.environ, **{OPT_OUT_ENV: "1"})
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            env=environment, close_fds=True,
                                            start_new_session=(os.name == "posix"),
                                            creationflags=creationflags)
        except OSError as exc:
            # A spawn failure is recorded locally; no claim is left behind.
            self.spawn_error = _cause(exc)
            self.result = _finish_check(time.time(), None,
                                        "background check could not start: " + self.spawn_error, {}, False)

    def _run(self) -> dict[str, Any]:
        """One-shot worker body; used only by the detached child (and tests)."""
        try:
            result = check(self.current)
        except BaseException as exc:  # record even an unexpected worker failure
            result = _finish_check(time.time(), None, _cause(exc), {}, False)
        self.result = result
        if result.get("ok") and is_newer(result.get("latest"), self.current):
            try:
                if self.settings()["auto_install"]:
                    self.auto_install()
            except Exception as exc:
                self._record_install_failure(exc)
        return result

    @staticmethod
    def _record_install_failure(exc: BaseException) -> None:
        log = state_root() / "update-install.log"
        try:
            _private_dir(log.parent)
            bound_install_log(log)
            with open(log, "ab") as output:
                with contextlib.suppress(OSError):
                    os.chmod(log, 0o600)
                output.write(("auto-install failed: " + _cause(exc) + "\n").encode("utf-8"))
            bound_install_log(log)
        except OSError:
            pass

    @staticmethod
    def settings() -> dict[str, Any]:
        return read_settings()

    @staticmethod
    def auto_install() -> dict[str, Any]:
        """Opt-in only: detached, low priority, logged; applies on next start."""
        script = Path(__file__).with_name("overseer-browser")
        if not script.is_file():
            return {"ok": False, "error": "installed CLI has no update entrypoint"}
        log = state_root() / "update-install.log"
        _private_dir(log.parent)
        bound_install_log(log)
        command = [sys.executable, str(script), "update"]
        if os.name == "posix" and shutil.which("nice"):
            command = ["nice", "-n", "10", *command]
        creationflags = 0
        if os.name == "nt":
            creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NO_WINDOW
        try:
            with open(log, "ab") as output:
                try:
                    os.chmod(log, 0o600)
                except OSError:
                    pass
                environment = dict(os.environ, OVERSEER_BROWSER_AUTO_UPDATE="1")
                subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                 env=environment, close_fds=True,
                                 start_new_session=(os.name == "posix"), creationflags=creationflags)
        except OSError as exc:
            cause = _cause(exc)
            with open(log, "ab") as output:
                output.write(("auto-install failed: " + cause + "\n").encode("utf-8"))
            bound_install_log(log)
            return {"ok": False, "error": cause, "log": str(log)}
        bound_install_log(log)
        return {"ok": True, "started": True, "log": str(log)}

    def notices(self, dim: bool = False) -> list[str]:
        # A fast command usually exits before the child finishes; the next
        # command reads the completed cache and emits the one daily notice.
        if self.process is not None and self.process.poll() is None:
            return []
        return notice_lines(self.current, dim=dim)


def _worker_signal(signum: int, _frame: Any) -> None:
    """A terminated worker records a failure if it still owns the check."""
    cache = read_cache()
    if float(cache.get("checking_at") or 0.0) > 0:
        _finish_check(time.time(), None, "check interrupted by signal " + str(signum), {}, False)
    raise SystemExit(1)


def _worker_main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "--check-once":
        print("usage: update.py --check-once VERSION", file=sys.stderr)
        return 2
    for name in ("SIGTERM", "SIGINT"):
        number = getattr(signal, name, None)
        if number is not None:
            with contextlib.suppress(ValueError, OSError):
                signal.signal(number, _worker_signal)
    BackgroundChecker(argv[2])._run()
    return 0


def verify_sha256(archive: Path, sums: str, name: str) -> bool:
    """Refuse to install when a release archive does not match SHA256SUMS."""
    wanted = None
    for line in sums.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1].lstrip("*") == name:
            wanted = fields[0].lower()
            break
    if not wanted or not re.fullmatch(r"[0-9a-f]{64}", wanted):
        return False
    digest = hashlib.sha256()
    with open(archive, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == wanted


if __name__ == "__main__":
    raise SystemExit(_worker_main(sys.argv))
