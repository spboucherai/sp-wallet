"""Static purity check of a strategy file WITHOUT importing or executing it (v7 research jobs).

    python -m spq.lint --strategy <dir>

Prints {"sha256", "bytes", "problems": [...]} and exits 0 when the source passes the static check of spq.strategy
(allow-listed imports, no open/eval/exec/getattr/..., no clock, no file or network helper), 3 when it does not,
2 when the file cannot be read. Nothing of the file is executed: it is parsed (ast) and hashed. This is what the
API runs on a submitted strategy before any other laboratory command touches it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from .strategy import static_check

MAX_BYTES = 64 * 1024


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.lint")
    p.add_argument("--strategy", required=True, help="strategy version directory (contains strategy.py)")
    a = p.parse_args(argv)
    path = Path(a.strategy) / "strategy.py"
    try:
        if path.is_symlink() or not path.is_file():
            raise OSError("strategy.py is missing or is not a regular file")
        blob = path.read_bytes()
        if len(blob) > MAX_BYTES:
            raise OSError(f"strategy.py is {len(blob)} bytes (limit {MAX_BYTES})")
        source = blob.decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print(f"spq.lint: {e}", file=sys.stderr)
        return 2
    problems = static_check(source)
    print(json.dumps({"sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob), "problems": problems}))
    return 3 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
