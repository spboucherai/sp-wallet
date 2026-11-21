# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/describe.py
# Description      : Describe a strategy version without running it: `python -m
#                    spq.describe --strategy <dir>` prints {"sha256": "<hex of
#                    strategy.py>", "meta": {...}} after the same loading
#                    checks as the signal runner (META validation, static
#                    purity check).
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
# Last Modified    : 2026-11-10
#
# =============================================================================
# AUTHOR & PROFESSIONAL AFFILIATION
# =============================================================================
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Department       : Département des sciences administratives
# Organization     : SP Boucher
#
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# =============================================================================
# OFFICIAL CONTACT DIRECTORY
# =============================================================================
#
# General          : info@spboucher.ai
# Professional     : contact@spboucher.ai
# Direct           : simon@spboucher.ai
# Research         : research@spboucher.ai
# Development      : dev@spboucher.ai
# Support          : support@spboucher.ai
# Security/Admin   : admin@spboucher.ai
# Notifications    : notifications@spboucher.ai
#
# Preferred Contact: support@spboucher.ai
#
# =============================================================================
# COPYRIGHT & INTELLECTUAL PROPERTY
# =============================================================================
#
# Copyright (c) 2026
# Simon-Pierre Boucher
#
# All rights reserved where applicable.
#
# This file is governed by the applicable project license,
# copyright notices, institutional agreements and relevant law.
#
# Unless expressly authorized by the applicable license or
# rights holder, copying, redistribution, sublicensing,
# publication and commercial exploitation are not permitted.
#
# Existing third-party rights and notices remain unaffected.
#
# =============================================================================
# CONFIDENTIALITY & SECURITY
# =============================================================================
#
# Classification   : Public
# Distribution     : Public repository; use is governed by the project license
# Security Contact : admin@spboucher.ai
#
# Access to this source does not independently grant permission
# to redistribute or disclose confidential materials.
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# LICENSE & MAINTENANCE
# =============================================================================
#
# License          : None specified (no license file in this repository)
# Maintainer       : Simon-Pierre Boucher
# Technical Contact: dev@spboucher.ai
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

"""Describe a strategy version without running it: `python -m spq.describe --strategy <dir>` prints
{"sha256": "<hex of strategy.py>", "meta": {...}} after the same loading checks as the signal runner
(META validation, static purity check). Non-zero exit and a reason on stderr on any problem.

Contract versions. Without `--contract` (= 1) the output is exactly the one above and a perpetual-futures strategy
(META["kind"] = "perp", contract 2: signed, leveraged weights) is REFUSED with exit 4: a caller that only knows the
spot contract must not be offered a strategy whose weights it would misread. With `--contract 2` every strategy is
described and the output gains "contract" (1 or 2) and "kind" ("spot" or "perp").

A universe-generic strategy reports "universe": ["*"] in meta (with "min_symbols" / "max_symbols" when it sets them),
"generic": true, and the bounds in force as "min_symbols" / "max_symbols" at the top level; the output always has "generic"."""
from __future__ import annotations

import argparse
import json
import sys

from .strategy import StrategyError, load_strategy, sha256_file, symbol_bounds


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
        out = {"sha256": sha256_file(f"{a.strategy}/strategy.py"), "meta": s.meta, "generic": s.generic}
        if s.generic:
            out["min_symbols"], out["max_symbols"] = symbol_bounds(s.meta)
        if a.contract >= 2:
            out.update({"contract": 2 if s.kind == "perp" else 1, "kind": s.kind})
    except BaseException as e:  # noqa: BLE001
        print(f"spq.describe: {type(e).__name__}: {e}", file=sys.stderr)
        return 4
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
