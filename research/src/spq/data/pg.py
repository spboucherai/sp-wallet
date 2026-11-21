# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/data/pg.py
# Description      : Read-only access to the engine's PostgreSQL table
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

"""Read-only access to the engine's PostgreSQL table

    candles(source, symbol, interval, ts, open, high, low, close, volume)   PK (source, symbol, interval, ts)

as specified in docs/v3/ARCHITECTURE.md ("Market data"). `ts` is the bar-open time in UTC. The session is opened
read-only: the research zone never writes market data.
"""
from __future__ import annotations

import os

import pandas as pd

from .core import COLUMNS, DataError, to_utc

TABLE = "candles"


def read_pg(database_url: str, symbol: str, interval: str, start=None, end=None, source: str | None = None):
    """Return (raw frame with ts + OHLCV, source used).

    `source` defaults to SPQ_CANDLE_SOURCE; if neither is set and the table holds exactly one source for this
    (symbol, interval), that one is used; with several sources the call fails and lists them (mixing sources
    silently would hide cross-source deviations).
    """
    import psycopg

    source = source or os.environ.get("SPQ_CANDLE_SOURCE")
    with psycopg.connect(database_url, options="-c default_transaction_read_only=on") as conn:
        with conn.cursor() as cur:
            if source is None:
                cur.execute(
                    f"SELECT DISTINCT source FROM {TABLE} WHERE symbol = %s AND interval = %s ORDER BY 1",
                    (symbol.upper(), interval),
                )
                sources = [r[0] for r in cur.fetchall()]
                if len(sources) != 1:
                    raise DataError(
                        f"{symbol} {interval}: {len(sources)} sources in {TABLE} ({sources}); pass source= "
                        "or set SPQ_CANDLE_SOURCE"
                    )
                source = sources[0]
            sql = f"SELECT ts, open, high, low, close, volume FROM {TABLE} WHERE source = %s AND symbol = %s AND interval = %s"
            args: list = [source, symbol.upper(), interval]
            if start is not None:
                sql += " AND ts >= %s"
                args.append(to_utc(start).to_pydatetime())
            if end is not None:
                sql += " AND ts < %s"
                args.append(to_utc(end).to_pydatetime())
            cur.execute(sql + " ORDER BY ts", args)
            rows = cur.fetchall()
    if not rows:
        raise DataError(f"{symbol} {interval}: no rows in {TABLE} for source {source!r} in the requested range")
    df = pd.DataFrame(rows, columns=["ts", *COLUMNS])
    for c in COLUMNS:  # NUMERIC columns arrive as Decimal
        df[c] = df[c].astype("float64")
    return df, source
