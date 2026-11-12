"""Neutrality test for shipped files.

Fails if model IDs, provider preferences, or personal/project names appear in
shipped source, documentation, or examples. Allowlisted exceptions must be
documented with a comment.
"""

import os
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SHIPPED_DIRS = [
    "cli",
    "extension",
    "chrome-extension",
    "native_host",
    "scripts",
]
SHIPPED_FILES = [
    "README.md",
    "PROTOCOL.md",
    "DOM_QUERIES.md",
]

# Files excluded from the neutrality scan:
# - LICENSE and package metadata keep legal attribution.
# - The neutrality test itself contains pattern examples.
EXCLUDED_FILES = {
    "LICENSE",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "THIRD_PARTY_NOTICES.txt",
}
EXCLUDED_DIRS = {"__pycache__", ".git", "node_modules"}

MODEL_RE = re.compile(
    r"gpt-[56][a-z0-9.-]*|deepseek[a-z0-9.-]*|opencode-go/|openrouter/|:exacto|"
    r"mimo-v[0-9][a-z0-9.-]*|glm-[0-9][a-z0-9.-]*|claude-[a-z0-9.-]*-5-5|"
    r"(haiku|sonnet|opus)[ -]?5[.-]5",
    re.IGNORECASE,
)
PERSONAL_RE = re.compile(
    r"Mike|Berardi|Felix|Mouseia|Liberty Design|"
    r"libertydesign|/Users/",
    re.IGNORECASE,
)

# The repository's own canonical GitHub URL is the only allowed form of the owner name.
CANONICAL_URL_RE = re.compile(
    r"https://github\.com/michael-berardi/overseer-browser(?![A-Za-z0-9_-])"
    r"|https://img\.shields\.io/github/[a-z/-]+/michael-berardi/overseer-browser(?![A-Za-z0-9_-])"
)

# Documented allowlist. Entries must explain why the match is acceptable.
ALLOWLIST = {
    # Example: "path/to/file": {"line": 1, "text": "allowed text"},
}


def _iter_shipped_files(include_tests=False):
    for name in SHIPPED_FILES:
        path = ROOT / name
        if path.is_file():
            yield path
    for dirname in SHIPPED_DIRS + (["tests", "docs"] if include_tests else []):
        base = ROOT / dirname
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path == Path(__file__):
                continue
            if path.name in EXCLUDED_FILES:
                continue
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            yield path



def load_private_terms(path=None):
    path = Path(path or os.environ.get("OSS_PRIVATE_TERMS", "~/.config/oss-audit/names.txt")).expanduser()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None
    terms = [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]
    if not terms:
        return None
    patterns = [(r"\b" if term[0].isalnum() or term[0] == "_" else "")
                + re.escape(term)
                + (r"\b" if term[-1].isalnum() or term[-1] == "_" else "")
                for term in terms]
    return re.compile("|".join(patterns), re.IGNORECASE)


class NeutralityTests(unittest.TestCase):
    def test_private_terms_loader(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "terms.txt"
            path.write_text("# comment\n\nzzqx-private-term\n", encoding="utf-8")
            pattern = load_private_terms(path)
            self.assertIsNotNone(pattern)
            text = Path(directory) / "sample.txt"
            text.write_text("a ZZQX-private-term here", encoding="utf-8")
            self.assertRegex(text.read_text(encoding="utf-8"), pattern)
            text.write_text("a neutral text", encoding="utf-8")
            self.assertNotRegex(text.read_text(encoding="utf-8"), pattern)
            self.assertNotRegex("azzqx-private-termz", pattern)
            self.assertIsNone(load_private_terms(Path(directory) / "missing"))

    def test_shipped_files_contain_no_model_ids(self):
        hits = []
        for path in _iter_shipped_files():
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                for match in MODEL_RE.finditer(line):
                    rel = str(path.relative_to(ROOT))
                    allowed = ALLOWLIST.get(rel)
                    if allowed and allowed.get("line") == lineno and match.group(0) in allowed.get("text", ""):
                        continue
                    hits.append(f"{rel}:{lineno}: model id {match.group(0)!r}")
        if hits:
            self.fail("Model IDs found in shipped files:\n" + "\n".join(hits))

    def test_shipped_files_contain_no_personal_names(self):
        hits = []
        patterns = [PERSONAL_RE]
        private = load_private_terms()
        if private:
            patterns.append(private)
        for path in _iter_shipped_files(include_tests=True):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                line = CANONICAL_URL_RE.sub("", line)
                for match in (m for pattern in patterns for m in pattern.finditer(line)):
                    rel = str(path.relative_to(ROOT))
                    allowed = ALLOWLIST.get(rel)
                    if allowed and allowed.get("line") == lineno and match.group(0) in allowed.get("text", ""):
                        continue
                    hits.append(f"{rel}:{lineno}: personal name {match.group(0)!r}")
        if hits:
            self.fail("Personal names found in shipped files:\n" + "\n".join(hits))

    def test_canonical_url_is_the_only_allowed_owner_form(self):
        ok = "https://github.com/michael-berardi/overseer-browser/releases/latest"
        self.assertEqual(CANONICAL_URL_RE.sub("", ok), "/releases/latest")
        for bad in ("https://github.com/michael-berardi/other-repo",
                    "https://github.com/michael-berardi/overseer-browser-x",
                    "by michael-berardi"):
            self.assertRegex(CANONICAL_URL_RE.sub("", bad), PERSONAL_RE)

    def test_readme_has_no_placeholder_owner_in_urls(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        urls = re.findall(r"https?://[^\s)\"'>]+", text)
        placeholders = ["example-user", "your-org", "your-github-username", "Alex/", "OWNER", "<owner>"]
        bad = [u for u in urls for p in placeholders if p in u]
        self.assertEqual(bad, [], "placeholder owner in README URLs")
        self.assertNotRegex(text, r"(github\.com|shields\.io/github)[^\s)\"']*(example-user|your-org|your-github-username|Alex/|OWNER|<owner>)")
