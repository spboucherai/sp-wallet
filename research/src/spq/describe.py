"""Describe a strategy version without running it: `python -m spq.describe --strategy <dir>` prints
{"sha256": "<hex of strategy.py>", "meta": {...}} after the same loading checks as the signal runner
(META validation, static purity check). Non-zero exit and a reason on stderr on any problem.

Contract versions. Without `--contract` (= 1) the output is exactly the one above and a perpetual-futures strategy
(META["kind"] = "perp", contract 2: signed, leveraged weights) is REFUSED with exit 4: a caller that only knows the
spot contract must not be offered a strategy whose weights it would misread. With `--contract 2` every strategy is
described and the output gains "contract" (1 or 2) and "kind" ("spot" or "perp")."""
from __future__ import annotations

import argparse
import json
import sys

from .strategy import StrategyError, load_strategy, sha256_file


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.describe")
    p.add_argument("--strategy", required=True)
    p.add_argument("--contract", type=int, choices=(1, 2), default=1,
                   help="highest strategy contract the caller understands (2 = perpetual futures)")
    a = p.parse_args(argv)
    try:
        s = load_strategy(a.strategy)
        if s.kind == "perp" and a.contract < 2:
            raise StrategyError("perpetual-futures strategy (contract 2): not available to a contract-1 caller; "
                                "pass --contract 2 if signed, leveraged weights are understood")
        out = {"sha256": sha256_file(f"{a.strategy}/strategy.py"), "meta": s.meta}
        if a.contract >= 2:
            out.update({"contract": 2 if s.kind == "perp" else 1, "kind": s.kind})
    except BaseException as e:  # noqa: BLE001
        print(f"spq.describe: {type(e).__name__}: {e}", file=sys.stderr)
        return 4
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
