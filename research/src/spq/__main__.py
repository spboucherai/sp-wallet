# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/__main__.py
# Description      : `python -m spq <group> <command> ...` (also installed as
#                    the `spq` script).
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-15
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

"""`python -m spq <group> <command> ...` (also installed as the `spq` script).

    spq data pull          public candles + funding of one underlying set on several venues, into a local store
    spq data quality       data-quality report of the store (JSON + Markdown)
    spq data manifest      hashes, ranges and row counts of the store (the file that IS committed)
    spq data record-books  order-book snapshots at a fixed cadence (Hyperliquid, edgeX, dYdX)
    spq v11 run|verify     the V11 research run (version-3 reports) and its reproducibility check
    spq study <name>       market_making_as | cross_exchange_spread | vol_forecast | book_depth

Read-only public market data. Nothing here holds a key, signs or places an order.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _csv(x: str) -> list[str]:
    return [s.strip() for s in x.split(",") if s.strip()]


def data_main(argv) -> int:
    from .data import books, multivenue
    from .data.core import DataError

    p = argparse.ArgumentParser(prog="python -m spq data")
    sub = p.add_subparsers(dest="command", required=True)
    q = sub.add_parser("pull")
    q.add_argument("--venues", default="hyperliquid,edgex,dydx,gmx,coinbase")
    q.add_argument("--symbols", default="BTC,ETH,SOL")
    q.add_argument("--interval", default="1h")
    q.add_argument("--days", type=int, default=180)
    q.add_argument("--start", default=None, help="UTC, inclusive (default: --days before --end)")
    q.add_argument("--end", default=None, help="UTC, exclusive (default: today 00:00 UTC)")
    q.add_argument("--out", default="data")
    q = sub.add_parser("quality")
    q.add_argument("--root", default="data")
    q.add_argument("--interval", default="1h")
    q.add_argument("--symbols", default="BTC,ETH,SOL")
    q.add_argument("--out", required=True, help="path prefix: <out>.json and <out>.md are written")
    q = sub.add_parser("manifest")
    q.add_argument("--root", default="data")
    q.add_argument("--start", required=True)
    q.add_argument("--end", required=True)
    q.add_argument("--out", required=True)
    q = sub.add_parser("record-books")
    q.add_argument("--venues", default="hyperliquid,edgex")
    q.add_argument("--symbols", default="BTC,ETH,SOL")
    q.add_argument("--cadence", type=float, default=5.0)
    q.add_argument("--minutes", type=float, default=60.0)
    q.add_argument("--levels", type=int, default=20)
    q.add_argument("--out", default="data")
    a = p.parse_args(argv)
    if a.command == "pull":
        end = a.end or datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
        start = a.start or (datetime.fromisoformat(end.replace("Z", "+00:00")) - timedelta(days=a.days)).isoformat()
        status = 0
        for v in _csv(a.venues):
            for s in _csv(a.symbols):
                try:
                    print(json.dumps(multivenue.pull(v, s, a.interval, start, end, out=a.out)), flush=True)
                except (DataError, ValueError) as e:
                    print(f"{v} {s}: {e}", file=sys.stderr)
                    status = 1
        return status
    if a.command == "quality":
        rep = multivenue.quality_report(a.root, a.interval, _csv(a.symbols))
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out + ".json").write_text(json.dumps(rep, indent=1) + "\n")
        Path(a.out + ".md").write_text(multivenue.quality_markdown(rep))
        print(multivenue.quality_markdown(rep))
        return 0
    if a.command == "manifest":
        m = multivenue.build_manifest(a.root)
        m["range"] = [a.start, a.end]
        m["captured_at"] = max((f["captured_at"] for f in m["files"].values()), default=None)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(m, indent=1, sort_keys=True) + "\n")
        print(json.dumps({k: m[k] for k in ("n_files", "snapshot_sha256", "captured_at", "range")}))
        return 0
    print(json.dumps(books.record(_csv(a.venues), _csv(a.symbols), out=a.out, cadence=a.cadence, minutes=a.minutes,
                                  levels=a.levels)))
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    group, rest = argv[0], argv[1:]
    if group == "data":
        return data_main(rest)
    if group == "v11":
        from .v11_pipeline import main as v11

        return v11(rest)
    if group == "study":
        from .studies import main as study

        return study(rest)
    print(f"unknown group {group!r}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
