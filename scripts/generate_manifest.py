#!/usr/bin/env python3
"""Write the exact stable Chrome native-messaging manifest."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native_host.runtime import native_manifest  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("host", type=Path)
    args = parser.parse_args(argv)
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = args.output.with_name(f".{args.output.name}.tmp")
    temporary.write_text(json.dumps(native_manifest(args.host), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, args.output)
    os.chmod(args.output, 0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
