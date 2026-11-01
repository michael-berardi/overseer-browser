"""Neutrality test for shipped files.

Fails if model IDs, provider preferences, or personal/project names appear in
shipped source, documentation, or examples. Allowlisted exceptions must be
documented with a comment.
"""

import re
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
# - Test fixtures are excluded by design (this test lives under tests/).
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
    r"Mike|Berardi|Dana|Felix|acme|acme|Mouseia|Liberty Design|"
    r"libertydesign|acme|/Users/",
    re.IGNORECASE,
)

# Documented allowlist. Entries must explain why the match is acceptable.
ALLOWLIST = {
    # Example: "path/to/file": {"line": 1, "text": "allowed text"},
}


def _iter_shipped_files():
    for name in SHIPPED_FILES:
        path = ROOT / name
        if path.is_file():
            yield path
    for dirname in SHIPPED_DIRS:
        base = ROOT / dirname
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if path.name in EXCLUDED_FILES:
                continue
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            yield path


class NeutralityTests(unittest.TestCase):
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
        for path in _iter_shipped_files():
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                for match in PERSONAL_RE.finditer(line):
                    rel = str(path.relative_to(ROOT))
                    allowed = ALLOWLIST.get(rel)
                    if allowed and allowed.get("line") == lineno and match.group(0) in allowed.get("text", ""):
                        continue
                    hits.append(f"{rel}:{lineno}: personal name {match.group(0)!r}")
        if hits:
            self.fail("Personal names found in shipped files:\n" + "\n".join(hits))
