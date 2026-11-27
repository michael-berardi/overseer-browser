"""Release checks, update notices and verified self-update (update contract v1).

The only network use is one anonymous GET of the project's public GitHub
"latest release" record, at most once a day, made by a detached child process
so a command never waits for it. All state is one small JSON file in the
platform cache directory. `update` downloads the release's installer and
bundle into a temporary folder, verifies both against the release's SHA256SUMS
before anything changes, runs that installer, and keeps one rollback copy.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import IO, Any, Callable, Iterator

TOOL = "overseer-browser"
# scripts/build-release.sh replaces this neutral placeholder with the release repository.
RELEASE_REPO = "example-user/overseer-browser"
USER_AGENT = "overseer-browser-update-check"
INTERVAL = 24 * 60 * 60
CLAIM_SECONDS = 60.0  # a killed check must not suppress later checks for a day
TIMEOUT = 4.0
KEEP_PREVIOUS = 7 * 24 * 60 * 60
INSTALL_STALE = 60 * 60
LOG_LIMIT = 256 * 1024
NOTES_LIMIT = 600
STATE_FILE = "update-check.json"
LOG_FILE = "auto-update.log"
EXIT_AVAILABLE = 10

NO_CHECK_ENV = "OVERSEER_BROWSER_NO_UPDATE_CHECK"
AGENT_ENV = "OVERSEER_BROWSER_AGENT"
API_ENV = "OVERSEER_BROWSER_UPDATE_API"      # local release record for tests
REPO_ENV = "OVERSEER_BROWSER_RELEASE_REPO"
BASE_ENV = "OVERSEER_BROWSER_RELEASE_BASE"   # shared with install.sh: where the release assets are
CACHE_ENV = "OVERSEER_BROWSER_CACHE_DIR"
HOME_ENV = "OVERSEER_BROWSER_HOME"
BIN_ENV = "OVERSEER_BROWSER_BIN_DIR"
SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
POPUP_ACTIONS = ("status", "check", "install", "skip", "auto_on", "auto_off", "checks_on", "checks_off")

DEFAULTS: dict[str, Any] = {
    "checked_at": 0.0, "checking_at": 0.0, "spawned_at": 0.0, "latest": "", "notes": "", "error": "", "skip": "",
    "auto": False, "asked": False, "checks": True, "shown": "", "shown_at": 0.0,
    "installing": "", "installing_at": 0.0, "auto_error": "",
}


class UpdateError(Exception):
    """A bounded, user-facing update failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_version(value: object) -> tuple[int, int, int] | None:
    """Stable x.y.z (optionally v-prefixed) only; anything else is never newer."""
    if not isinstance(value, str):
        return None
    parts = (value[1:] if value.startswith("v") else value).split(".")
    if len(parts) != 3 or not all(part.isascii() and part.isdigit() for part in parts):
        return None
    return int(parts[0]), int(parts[1]), int(parts[2])


def is_newer(candidate: object, current: object) -> bool:
    new, old = parse_version(candidate), parse_version(current)
    return bool(new and old and new > old)


def _env(env: dict[str, str] | None) -> dict[str, str]:
    return dict(os.environ if env is None else env)


def _on(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def cache_dir(env: dict[str, str] | None = None) -> Path:
    environ = _env(env)
    if environ.get(CACHE_ENV):
        return Path(environ[CACHE_ENV]).expanduser()
    if sys.platform == "win32":
        return Path(environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / TOOL / "Cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / TOOL
    return Path(environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / TOOL


def tool_home(env: dict[str, str] | None = None) -> Path:
    """The one-step installer's folder (install.sh / install.ps1 use the same default)."""
    environ = _env(env)
    if environ.get(HOME_ENV):
        return Path(environ[HOME_ENV]).expanduser()
    if sys.platform == "win32" and environ.get("LOCALAPPDATA"):
        return Path(environ["LOCALAPPDATA"]) / "OverSeerBrowser"
    return Path.home() / ".overseer-browser"


def load_state(env: dict[str, str] | None = None) -> dict[str, Any]:
    state = dict(DEFAULTS)
    try:
        stored = json.loads((cache_dir(env) / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return state
    if isinstance(stored, dict):
        for key, default in DEFAULTS.items():
            value = stored.get(key)
            if isinstance(default, float) and type(value) in (int, float):
                state[key] = float(value)
            elif type(value) is type(default):
                state[key] = value
    return state


def save_state(state: dict[str, Any], env: dict[str, str] | None = None) -> None:
    """Atomic 0600 write of the single state file."""
    directory = cache_dir(env)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    clean = {key: state.get(key, default) for key, default in DEFAULTS.items()}
    clean["notes"] = str(clean["notes"])[:NOTES_LIMIT]
    clean["error"], clean["auto_error"] = str(clean["error"])[:300], str(clean["auto_error"])[:300]
    descriptor, temporary = tempfile.mkstemp(prefix=".update-check.", dir=str(directory))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(clean, handle, separators=(",", ":"))
        os.chmod(temporary, 0o600)
        os.replace(temporary, directory / STATE_FILE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def update_state(env: dict[str, str] | None = None, **changes: Any) -> dict[str, Any]:
    state = load_state(env)
    state.update(changes)
    save_state(state, env)
    return state


def remove_state(env: dict[str, str] | None = None) -> None:
    """Uninstall: remove the state file, the auto-update log and the rollback copy."""
    folder = cache_dir(env)
    for name in (STATE_FILE, LOG_FILE):
        with contextlib.suppress(FileNotFoundError):
            (folder / name).unlink()
    with contextlib.suppress(OSError):
        folder.rmdir()
    shutil.rmtree(tool_home(env) / "previous", ignore_errors=True)


def _repo(env: dict[str, str]) -> str | None:
    repo = env.get(REPO_ENV) or RELEASE_REPO
    return repo if SLUG_RE.fullmatch(repo) and repo.split("/")[0] != "example-user" else None  # unstamped build


def _cause(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        text = f"HTTP {exc.code} from the release server"
    elif isinstance(exc, urllib.error.URLError):
        text = f"network error: {exc.reason}"
    elif isinstance(exc, TimeoutError):
        text = f"no answer within {TIMEOUT:g} s"
    else:
        text = str(exc) or exc.__class__.__name__
    return " ".join(text.split())[:300]


def _get(url: str, limit: int, accept: str = "application/octet-stream") -> bytes:
    """One anonymous GET: fixed User-Agent, no cookies, identifiers, version or query string."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("download_too_large", f"{url.rsplit('/', 1)[-1]} is larger than expected")
    return data


def fetch_latest(url: str) -> dict[str, Any]:
    record = json.loads(_get(url, 1024 * 1024, "application/vnd.github+json").decode("utf-8"))
    if not isinstance(record, dict):
        raise UpdateError("bad_release_record", "the release record is not a JSON object")
    return record


def _live_claim(state: dict[str, Any], moment: float) -> bool:
    """True only while a check that started just now still owns the single request."""
    started = float(state.get("checking_at") or 0.0)
    return bool(started and 0 <= moment - started < CLAIM_SECONDS)


def check_now(current: str, env: dict[str, str] | None = None,
              fetch: Callable[[str], dict[str, Any]] | None = None,
              now: float | None = None,
              force: bool = False) -> dict[str, Any]:
    """Fetch the latest release record once and record the outcome, or its cause, in the state file.

    A live claim is reused rather than sending a second GET (including from
    ``update --check``); the detached child passes ``force`` to finish the
    claim its parent created. An abandoned claim expires after 60 seconds.
    """
    environ = _env(env)
    moment = time.time() if now is None else now
    state = load_state(environ)
    if not force and (_live_claim(state, moment) or
                      (state.get("spawned_at") and 0 <= moment - state["spawned_at"] < CLAIM_SECONDS)):
        return state  # a detached child already owns this check
    update_state(environ, checked_at=moment, checking_at=moment, spawned_at=0.0)  # claim before the GET
    changes: dict[str, Any] = {"checked_at": moment, "checking_at": 0.0,
                               "latest": "", "notes": "", "error": ""}
    try:
        repo = _repo(environ)
        url = environ.get(API_ENV) or (repo and f"https://api.github.com/repos/{repo}/releases/latest")
        if not url:
            raise UpdateError("no_release_repo", f"this build names no release repository; set {REPO_ENV}=owner/repo")
        record = (fetch or fetch_latest)(url)
        tag = record.get("tag_name")
        if record.get("draft") is not True and record.get("prerelease") is not True and parse_version(tag):
            changes["latest"] = "%d.%d.%d" % parse_version(tag)  # type: ignore[str-format]
            changes["notes"] = str(record.get("body") or "")[:NOTES_LIMIT]
    except Exception as exc:  # recorded once with its cause; never printed, never retried in a loop
        changes["error"] = _cause(exc)
        if isinstance(exc, urllib.error.HTTPError):
            exc.close()
    return update_state(environ, **changes)  # clears the claim even on failure


def due(state: dict[str, Any], now: float | None = None) -> bool:
    """Never checked, a stale claim, checked 24 h ago, or the clock moved back."""
    moment = time.time() if now is None else now
    if _live_claim(state, moment):
        return False
    if state.get("checking_at"):
        return True  # abandoned in-flight check: retry rather than gate for a day
    # A spawned child that never reached its GET is still covered by the daily slot claim.
    elapsed = moment - state["checked_at"]
    return not state["checked_at"] or not 0 <= elapsed < INTERVAL


def automatic_checks(env: dict[str, str] | None = None) -> bool:
    return not _on(_env(env).get(NO_CHECK_ENV)) and load_state(env)["checks"]


def notices_allowed(json_output: bool, env: dict[str, str] | None = None,
                    streams: tuple[Any, ...] | None = None) -> bool:
    """Automatic checks and notices run only for a person at a terminal."""
    environ = _env(env)
    if json_output or environ.get("CI") or _on(environ.get(AGENT_ENV)):
        return False
    if not all(getattr(stream, "isatty", lambda: False)() for stream in streams or (sys.stdout, sys.stderr)):
        return False
    return automatic_checks(environ)


def _spawn(args: list[str], env: dict[str, str] | None = None) -> None:
    """Detached child running this file; the parent never waits for it."""
    options: dict[str, Any] = {"env": _env(env), "stdin": subprocess.DEVNULL,
                               "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if os.name == "nt":
        options["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # detached, new group, no window
    else:
        options["start_new_session"] = True
    subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).resolve()), *args], **options)


def start_background_check(current: str, env: dict[str, str] | None = None, now: float | None = None,
                           spawn: Callable[[list[str], dict[str, str]], None] | None = None,
                           force: bool = False) -> bool:
    """Start the daily check in a detached child when it is due; claims the slot first."""
    environ = _env(env)
    moment = time.time() if now is None else now
    if not force and not due(load_state(environ), moment):
        return False
    update_state(environ, checked_at=moment, checking_at=0.0, spawned_at=moment)  # parallel commands see the claim
    (spawn or _spawn)(["--background", current], environ)
    return True


def install_kind(current: str, env: dict[str, str] | None = None) -> str:
    """'release' for the one-step installer's layout, else 'source' (a checkout installed by its script)."""
    main_py = tool_home(env) / "releases" / f"release-{current}" / "cli" / "main.py"
    return "release" if main_py.is_file() else "source"


def update_command(current: str, env: dict[str, str] | None = None) -> str:
    if install_kind(current, env) == "source":
        return f"git pull --ff-only && {TOOL} update"
    return f"{TOOL} update"


def notice(current: str, env: dict[str, str] | None = None, now: float | None = None) -> list[str]:
    """The one- or two-line notice, at most once a day per version; records that it was shown."""
    environ = _env(env)
    state = load_state(environ)
    latest, moment = state["latest"], time.time() if now is None else now
    if not is_newer(latest, current) or state["skip"] == latest:
        return []
    if state["installing"] == latest and moment - state["installing_at"] < INSTALL_STALE:
        return []
    if state["shown"] == latest and 0 <= moment - state["shown_at"] < INTERVAL:
        return []
    update_state(environ, shown=latest, shown_at=moment)
    first = f"{TOOL} {latest} available (you have {current}) · run: {update_command(current, environ)}"
    if state["auto"] and state["auto_error"]:
        return [first, f"automatic update failed: {TOOL} update --auto status · skip: {TOOL} update --skip"]
    if state["auto"]:
        return [first, f"skip: {TOOL} update --skip"]
    return [first, f"turn on automatic updates: {TOOL} update --auto on · skip: {TOOL} update --skip"]


def emit_notice(lines: list[str], stream: Any = None, env: dict[str, str] | None = None) -> None:
    """stderr only; the second line is dim unless NO_COLOR is set."""
    target = stream or sys.stderr
    dim = not _env(env).get("NO_COLOR") and getattr(target, "isatty", lambda: False)()
    for index, line in enumerate(lines):
        target.write(f"\x1b[2m{line}\x1b[0m\n" if dim and index else f"{line}\n")
    target.flush()


def report(current: str, state: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    latest = state["latest"]
    available = is_newer(latest, current)
    result: dict[str, Any] = {
        "state": "failed" if state["error"] else "available" if available else "current",
        "current": current, "latest": latest or None, "error": state["error"],
        "skipped": available and state["skip"] == latest, "auto": state["auto"],
        "command": update_command(current, env) if available else "",
        "notes": release_notes(state["notes"]) if available else "",
    }
    if _live_claim(state, time.time()):
        result["in_progress"] = True
    return result


def release_notes(notes: str, lines: int = 6, limit: int = 500) -> str:
    kept = [line.strip() for line in str(notes).splitlines() if line.strip()][:lines]
    return "\n".join(kept)[:limit]


def parse_sums(text: str) -> dict[str, str]:
    sums = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            sums[parts[1].lstrip("*")] = parts[0].lower()
    return sums


def _installed_version(home: Path, version: str) -> str:
    try:
        text = (home / "releases" / f"release-{version}" / "cli" / "main.py").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r'^CLI_VERSION = "([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else ""


def _run(argv: list[str], env: dict[str, str], out: IO[str] | None) -> int:
    target = out if out is not None else sys.stderr
    target.flush()
    return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=target,
                          stderr=subprocess.STDOUT, check=False).returncode


def _installer_env(environ: dict[str, str], **extra: str) -> dict[str, str]:
    child = dict(environ, **extra)
    child.setdefault("PYTHON", sys.executable)  # the same interpreter the current install uses
    saved = Path.home() / "Library/Application Support/OverSeer/browser/cli-launcher-path"
    if sys.platform == "darwin" and BIN_ENV not in child and saved.is_file():
        launcher = saved.read_text(encoding="utf-8").strip()
        if launcher:
            child[BIN_ENV] = str(Path(launcher).parent)  # keep a custom launcher folder across updates
    return child


def keep_previous(current: str, env: dict[str, str] | None = None) -> Path | None:
    """Move the installed release aside as the single rollback copy (an older copy goes first)."""
    home = tool_home(env)
    release = home / "releases" / f"release-{current}"
    if not release.is_dir():
        return None
    previous = home / "previous"
    shutil.rmtree(previous, ignore_errors=True)
    previous.mkdir(mode=0o700, parents=True)
    os.replace(release, previous / release.name)
    return previous / release.name


def _platform_installer(release: Path) -> list[str]:
    if sys.platform == "darwin":
        return ["bash", str(release / "scripts" / "manage-macos.sh"), "install"]
    if sys.platform.startswith("linux"):
        return ["bash", str(release / "scripts" / "install-linux.sh")]
    raise UpdateError("rollback_unavailable", "rollback is not available on this platform; "
                      "run install.ps1 with OVERSEER_BROWSER_VERSION set to the version you want")


def restore_previous(env: dict[str, str] | None = None, out: IO[str] | None = None,
                     run: Callable[[list[str], dict[str, str], IO[str] | None], int] | None = None) -> str | None:
    """Reinstall the rollback copy with its own platform installer; returns its version."""
    environ = _env(env)
    home = tool_home(environ)
    kept = sorted((home / "previous").glob("release-*"))
    if not kept:
        return None
    release = home / "releases" / kept[-1].name
    release.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(release, ignore_errors=True)
    os.replace(kept[-1], release)
    shutil.rmtree(home / "previous", ignore_errors=True)
    version = release.name[len("release-"):]
    code = (run or _run)(_platform_installer(release), _installer_env(environ, OVERSEER_BROWSER_PREBUILT_EXTENSION="1"), out)
    if code != 0:
        raise UpdateError("rollback_failed", f"reinstalling {version} failed (exit {code}); run install.sh again")
    for other in (home / "releases").glob("release-*"):
        if other != release:
            shutil.rmtree(other, ignore_errors=True)
    built = release / "extension" / ".output" / "chrome-mv3"
    if built.is_dir():
        staged = home / "extension.tmp"
        shutil.rmtree(staged, ignore_errors=True)
        shutil.copytree(built, staged)
        shutil.rmtree(home / "extension", ignore_errors=True)
        os.replace(staged, home / "extension")
    return version


def prune_previous(current: str, env: dict[str, str] | None = None, used: bool = False,
                   now: float | None = None) -> bool:
    """Drop the rollback copy once a newer version has run a command successfully, or after 7 days."""
    previous = tool_home(env) / "previous"
    try:
        age = (time.time() if now is None else now) - previous.stat().st_mtime
    except OSError:
        return False
    kept = [path.name[len("release-"):] for path in previous.glob("release-*")]
    if age > KEEP_PREVIOUS or (used and all(is_newer(current, version) for version in kept)):
        shutil.rmtree(previous, ignore_errors=True)
        return True
    return False


def install(current: str, version: str, env: dict[str, str] | None = None, out: IO[str] | None = None,
            run: Callable[[list[str], dict[str, str], IO[str] | None], int] | None = None) -> dict[str, Any]:
    """Download, verify against SHA256SUMS, then run the release's own installer; roll back on failure."""
    environ = _env(env)
    if not is_newer(version, current):
        raise UpdateError("not_newer", f"{version} is not a newer stable release than {current}")
    repo = _repo(environ)
    base = environ.get(BASE_ENV) or (repo and f"https://github.com/{repo}/releases/download/v{version}")
    if not base:
        raise UpdateError("no_release_repo", f"this build names no release repository; set {REPO_ENV}=owner/repo")
    windows = sys.platform == "win32"
    installer, bundle = ("install.ps1", "overseer-browser.zip") if windows else ("install.sh", "overseer-browser.tar.gz")
    home = tool_home(environ)
    with tempfile.TemporaryDirectory(prefix="overseer-browser-update-") as temporary:  # removed on success and failure
        folder = Path(temporary)
        try:
            raw_sums = _get(f"{base.rstrip('/')}/SHA256SUMS", 64 * 1024)
            sums = parse_sums(raw_sums.decode("utf-8", "replace"))
            (folder / "SHA256SUMS").write_bytes(raw_sums)
            for name in (installer, bundle):
                data = _get(f"{base.rstrip('/')}/{name}", 64 * 1024 * 1024)
                if name not in sums:
                    raise UpdateError("checksum_missing", f"SHA256SUMS has no entry for {name}; nothing was installed")
                if hashlib.sha256(data).hexdigest() != sums[name]:
                    raise UpdateError("checksum_mismatch", f"checksum mismatch for {name}; nothing was installed")
                (folder / name).write_bytes(data)
        except (OSError, ValueError) as exc:
            raise UpdateError("download_failed", f"{_cause(exc)}; nothing was installed") from exc
        previous = keep_previous(current, environ)
        argv = (["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(folder / installer)]
                if windows else ["sh", str(folder / installer)])
        child = _installer_env(environ, **{BASE_ENV: folder.as_uri(), "OVERSEER_BROWSER_VERSION": version,
                                            HOME_ENV: str(home)})
        try:
            code = (run or _run)(argv, child, out)
        except OSError as exc:
            code = 127
            print(f"{TOOL} update: {exc}", file=out or sys.stderr)
        if code != 0 or _installed_version(home, version) != version:
            restored = restore_previous(environ, out, run) if previous else None
            kept = f"restored {restored}" if restored else "the current version is unchanged"
            raise UpdateError("install_failed", f"the {version} installer failed (exit {code}); {kept}")
    return {"installed": version, "previous": current, "rollback": previous is not None}


def _ask(prompt: str, default: bool, ask: Callable[[str], str] | None) -> bool:
    if ask is None:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        answer = sys.stdin.readline()
    else:
        answer = ask(prompt)
    answer = answer.strip().lower()
    return default if not answer else answer.startswith("y")


def run_update(current: str, env: dict[str, str] | None = None, interactive: bool | None = None,
               ask: Callable[[str], str] | None = None, out: IO[str] | None = None,
               fetch: Callable[[str], dict[str, Any]] | None = None,
               run: Callable[[list[str], dict[str, str], IO[str] | None], int] | None = None) -> dict[str, Any]:
    """`overseer-browser update` for the one-step installer layout; messages go to stderr."""
    environ = _env(env)
    say = out or sys.stderr
    if interactive is None:
        interactive = sys.stdin.isatty() and sys.stderr.isatty()
    state = check_now(current, environ, fetch)
    if state["error"]:
        raise UpdateError("check_failed", state["error"])
    latest = state["latest"]
    if not is_newer(latest, current):
        return {"state": "current", "current": current, "latest": latest or None}
    print(f"{TOOL} {current} → {latest}", file=say)
    notes = release_notes(state["notes"])
    if notes:
        print(notes, file=say)
    if interactive and not _ask(f"Install {latest} now? [Y/n] ", True, ask):
        return {"state": "declined", "current": current, "latest": latest}
    result = install(current, latest, environ, out=say, run=run)
    state = load_state(environ)
    if interactive and not state["auto"] and not state["asked"]:
        state = update_state(environ, auto=_ask("Install future updates automatically? [y/N] ", False, ask), asked=True)
    return {"state": "installed", "current": current, "latest": latest, **result, "auto": state["auto"]}


@contextlib.contextmanager
def bounded_log(env: dict[str, str] | None = None) -> Iterator[IO[str]]:
    """The one auto-update log, trimmed to its newest half whenever it passes LOG_LIMIT."""
    path = cache_dir(env) / LOG_FILE
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    trim_log(path)
    with open(path, "a", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        yield handle
    trim_log(path)


def trim_log(path: Path, limit: int = LOG_LIMIT) -> None:
    try:
        if path.stat().st_size <= limit:
            return
        with open(path, "rb") as handle:
            handle.seek(-(limit // 2), os.SEEK_END)
            tail = handle.read()
    except OSError:
        return
    tail = tail[tail.find(b"\n") + 1:] if b"\n" in tail else tail
    path.write_bytes(tail)


def background_install(current: str, version: str, env: dict[str, str] | None = None,
                       run: Callable[[list[str], dict[str, str], IO[str] | None], int] | None = None) -> bool:
    """Unattended install (auto-update or the popup); the running version keeps working on failure."""
    environ = _env(env)
    state = load_state(environ)
    if state["installing"] == version and time.time() - state["installing_at"] < INSTALL_STALE:
        return False
    update_state(environ, installing=version, installing_at=time.time())
    try:
        with bounded_log(environ) as log:
            print(time.strftime("%Y-%m-%dT%H:%M:%S"), f"installing {version} (current {current})", file=log, flush=True)
            install(current, version, environ, out=log, run=run)
            print(f"installed {version}; it applies from the next command", file=log, flush=True)
    except Exception as exc:  # recorded; the notice falls back to asking
        update_state(environ, installing="", auto_error=_cause(exc))
        return False
    update_state(environ, installing="", auto_error="")
    return True


def background(current: str, install_version: str = "", env: dict[str, str] | None = None) -> int:
    """Child process body: the daily check, then an opted-in or requested install."""
    with contextlib.suppress(AttributeError, OSError):
        os.nice(10)
    environ = _env(env)
    if not install_version:
        state = check_now(current, environ, force=True)  # finish the claim the parent created
        if not (state["auto"] and is_newer(state["latest"], current) and state["skip"] != state["latest"]):
            return 0
        install_version = state["latest"]
    if install_kind(current, environ) != "release":
        update_state(environ, auto_error="automatic install needs the one-step installer layout")
        return 1
    return 0 if background_install(current, install_version, environ) else 1


def popup(current: str, action: str = "status", env: dict[str, str] | None = None, now: float | None = None,
          spawn: Callable[[list[str], dict[str, str]], None] | None = None) -> dict[str, Any]:
    """Native-host answer for the extension popup: local state only; network work goes to a child."""
    environ = _env(env)
    state = load_state(environ)
    moment = time.time() if now is None else now
    latest = state["latest"]
    if action == "check" or (action == "status" and automatic_checks(environ) and due(state, moment)):
        start_background_check(current, environ, moment, spawn, force=True)
    elif action == "install" and is_newer(latest, current):
        (spawn or _spawn)(["--background", current, "--install", latest], environ)
    elif action == "skip" and latest:
        update_state(environ, skip=latest)
    elif action in {"auto_on", "auto_off"}:
        update_state(environ, auto=action == "auto_on", asked=True)
    elif action in {"checks_on", "checks_off"}:
        update_state(environ, checks=action == "checks_on")
    state = load_state(environ)
    latest = state["latest"]
    newer = is_newer(latest, current)
    return {
        "available": newer and state["skip"] != latest, "current": current, "latest": latest or None,
        "notes": release_notes(state["notes"], 4, 300) if newer else "",
        "installing": newer and (action == "install" or (
            state["installing"] == latest and moment - state["installing_at"] < INSTALL_STALE)),
        "installed": newer and _installed_version(tool_home(environ), latest) == latest,
        "auto": state["auto"], "checks": automatic_checks(environ),
        "error": (state["auto_error"] or state["error"])[:200], "command": update_command(current, environ),
    }


def main(argv: list[str] | None = None) -> int:
    """Entry point of the detached child; not a user command."""
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) not in (2, 4) or args[0] != "--background" or not parse_version(args[1]):
        print("usage: updates.py --background CURRENT [--install VERSION]", file=sys.stderr)
        return 2
    if len(args) == 4 and (args[2] != "--install" or not parse_version(args[3])):
        return 2
    return background(args[1], args[3] if len(args) == 4 else "")


if __name__ == "__main__":
    raise SystemExit(main())
