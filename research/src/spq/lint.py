# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/lint.py
# Description      : Static purity check of a strategy file WITHOUT importing
#                    or executing it (v7 research jobs).
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-11
# Last Modified    : 2026-11-11
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

"""Static purity check of a strategy file WITHOUT importing or executing it (v7 research jobs).

    python -m spq.lint --strategy <dir>

Prints {"sha256", "bytes", "problems": [...]} and exits 0 when the source passes the static check of spq.purity
(reviewed module API, no dunder, no module object as a value, no class / decorator, no string evaluation, no clock,
file or network helper), 3 when it does not, 2 when the file cannot be read. Nothing of the file is executed: it is
parsed (ast) and hashed. This is what the API runs on a submitted strategy before any other laboratory command
touches it. It is a lint: the process that later runs the strategy is confined by the OS whatever this says.
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
