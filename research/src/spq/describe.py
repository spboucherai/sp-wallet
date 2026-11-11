"""Describe a strategy version without running it: `python -m spq.describe --strategy <dir>` prints
{"sha256": "<hex of strategy.py>", "meta": {...}, "generic": bool} after the same loading checks as the signal runner
(META validation, static purity check). Non-zero exit and a reason on stderr on any problem.
A universe-generic strategy reports "universe": ["*"] in meta (with "min_symbols" / "max_symbols" when it sets them),
"generic": true, and the bounds in force as "min_symbols" / "max_symbols" at the top level."""
from __future__ import annotations

import argparse
import json
import sys

from .strategy import load_strategy, sha256_file, symbol_bounds


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.describe")
    p.add_argument("--strategy", required=True)
    a = p.parse_args(argv)
    try:
        s = load_strategy(a.strategy)
        out = {"sha256": sha256_file(f"{a.strategy}/strategy.py"), "meta": s.meta, "generic": s.generic}
        if s.generic:
            out["min_symbols"], out["max_symbols"] = symbol_bounds(s.meta)
    except BaseException as e:  # noqa: BLE001
        print(f"spq.describe: {type(e).__name__}: {e}", file=sys.stderr)
        return 4
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
