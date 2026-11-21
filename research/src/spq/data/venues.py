# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/data/venues.py
# Description      : Venue table of the research lab: fees, funding interval,
#                    order limits and the REVIEWED symbol map.
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

"""Venue table of the research lab: fees, funding interval, order limits and the REVIEWED symbol map.

Everything here is a research input, read from public documentation or public endpoints on the date given in
`checked`. Nothing here is used to place an order. A venue's own fee schedule can change at any time: a report
prints the row it used (`execution_model.fee_table`), so a stale number is visible.

Symbol convention of the lab (contract 2): a bare ticker (`BTC`) is the perpetual on the PRIMARY venue
(Hyperliquid, the only venue the live engine trades); `BTC@EDGEX` is the perpetual of the same underlying on
another venue; `BTC.SPOT` is a spot leg. `split_symbol` is the only parser.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

PRIMARY_VENUE = "hyperliquid"
SPOT_VENUE = "spot"
SPOT_SUFFIX = ".SPOT"
VENUE_SEP = "@"


@dataclass(frozen=True)
class Venue:
    name: str
    taker_bps: float
    maker_bps: float
    funding_interval_s: int          # seconds between two funding settlements
    funding_model: str               # "settlement" (discrete payments) or "continuous-approximation"
    min_order_usd: float
    default_half_spread_bps: float   # used by the square-root slippage model when no book snapshot is supplied
    source: str
    checked: str
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


#: Base (lowest-volume) tier everywhere: the lab never assumes a volume discount or a rebate.
VENUES: dict[str, Venue] = {
    "hyperliquid": Venue(
        "hyperliquid", taker_bps=4.5, maker_bps=1.5, funding_interval_s=3600, funding_model="settlement",
        min_order_usd=10.0, default_half_spread_bps=0.5,
        source="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees (tier 0, perps); funding: "
               "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding (hourly); "
               "docs/v4/venues/contract-differences.md",
        checked="2026-11-10",
        notes="minimum order 10 USD notional; funding paid every hour on the oracle price"),
    "edgex": Venue(
        "edgex", taker_bps=4.5, maker_bps=4.0, funding_interval_s=14400, funding_model="settlement",
        min_order_usd=10.0, default_half_spread_bps=0.5,
        source="live getMetaData 2026-11-15: defaultTakerFeeRate 0.00045, defaultMakerFeeRate 0.0004, "
               "fundingRateIntervalMin 240; GET /api/v2/public/vip/config/list level 0 "
               "(docs/v11/research/edgex-api.md sections 1.2, 1.6, 1.10)",
        checked="2026-11-15",
        notes="settlements are 4 h apart (verified on the funding history); the per-contract minimum is a SIZE "
              "(minOrderSize), 10 USD is the lab's floor; trading is NOT available to the wallet (terms exclude "
              "Canada): this row exists for research on public data only"),
    "dydx": Venue(
        "dydx", taker_bps=5.0, maker_bps=1.0, funding_interval_s=3600, funding_model="settlement",
        min_order_usd=1.0, default_half_spread_bps=1.5,
        source="https://docs.dydx.exchange/introduction-trading_fees (tier 1: taker 5.0 bps, maker 1.0 bps); "
               "funding: indexer /v4/historicalFunding rows are one hour apart (verified live 2026-11-15)",
        checked="2026-11-15",
        notes="dYdX chain (v4); the fee tier table is governance-controlled and was read from the documentation, "
              "not from an endpoint"),
    "gmx": Venue(
        "gmx", taker_bps=6.0, maker_bps=6.0, funding_interval_s=3600, funding_model="continuous-approximation",
        min_order_usd=2.0, default_half_spread_bps=3.0,
        source="https://docs.gmx.io/docs/trading/v2 (open/close fee 0.04 % when the trade improves the long/short "
               "balance, 0.06 % otherwise; plus price impact, borrow fee and funding fee accrued per second)",
        checked="2026-11-15",
        notes="APPROXIMATION: GMX has no order book and no discrete funding settlement. Borrow and funding fees "
              "accrue continuously from pool utilisation and open-interest imbalance; no public REST endpoint "
              "serves their history, so the lab has GMX candles (oracle prices, no volume) and no GMX funding "
              "series. The 6 bps is the worse of the two position-fee rates; price impact is not modelled"),
    "spot": Venue(
        "spot", taker_bps=10.0, maker_bps=10.0, funding_interval_s=0, funding_model="none",
        min_order_usd=2.0, default_half_spread_bps=10.0,
        source="lab assumption for an on-chain swap (router fee + pool fee + price impact), research/README.md "
               "'Known limits'; the engine's own floor is MIN_TRADE_USD = 2 (services/api/src/agents/engine.ts:31)",
        checked="2026-11-15",
        notes="spot legs are Coinbase candles; execution in the wallet is an on-chain swap. Gas is not modelled"),
}

#: Reviewed 2026-11-15. Same underlying across venues; every id was read from the venue's own public metadata on
#: that date (edgeX: getMetaData contractList; dYdX: /v4/perpetualMarkets tickers; GMX: /prices/candles tokenSymbol;
#: Hyperliquid: meta.universe names). Quote currencies differ and are NOT converted: Hyperliquid and dYdX quote in
#: USD(C) with a USDT-heavy index, edgeX in USDC, GMX in USD oracle prices, Coinbase spot in USD.
SYMBOL_MAP: dict[str, dict[str, str]] = {
    "BTC": {"hyperliquid": "BTC", "edgex": "30000001", "dydx": "BTC-USD", "gmx": "BTC", "coinbase": "BTC-USD"},
    "ETH": {"hyperliquid": "ETH", "edgex": "30000002", "dydx": "ETH-USD", "gmx": "ETH", "coinbase": "ETH-USD"},
    "SOL": {"hyperliquid": "SOL", "edgex": "30000003", "dydx": "SOL-USD", "gmx": "SOL", "coinbase": "SOL-USD"},
}
#: edgeX contract names expected behind the ids above; the loader refuses to use an id whose live name differs.
EDGEX_NAMES = {"30000001": "BTCUSDC", "30000002": "ETHUSDC", "30000003": "SOLUSDC"}


def venue(name: str) -> Venue:
    try:
        return VENUES[name.lower()]
    except KeyError:
        raise ValueError(f"unknown venue {name!r} (known: {sorted(VENUES)})") from None


def split_symbol(symbol: str) -> tuple[str, str]:
    """'BTC' -> ('BTC', 'hyperliquid'); 'BTC@EDGEX' -> ('BTC', 'edgex'); 'BTC.SPOT' -> ('BTC', 'spot')."""
    if symbol.endswith(SPOT_SUFFIX):
        return symbol[: -len(SPOT_SUFFIX)], SPOT_VENUE
    if VENUE_SEP in symbol:
        base, _, v = symbol.partition(VENUE_SEP)
        return base, venue(v).name
    return symbol, PRIMARY_VENUE


def lab_symbol(underlying: str, venue_name: str) -> str:
    v = venue_name.lower()
    if v == PRIMARY_VENUE:
        return underlying
    if v == SPOT_VENUE:
        return underlying + SPOT_SUFFIX
    return f"{underlying}{VENUE_SEP}{v.upper()}"


def venue_id(underlying: str, venue_name: str) -> str:
    if venue_name.lower() == PRIMARY_VENUE and underlying not in SYMBOL_MAP:
        return underlying                     # Hyperliquid's id IS the ticker; only cross-venue ids need the map
    try:
        return SYMBOL_MAP[underlying][venue_name.lower()]
    except KeyError:
        raise ValueError(f"{underlying} has no reviewed id on {venue_name}: add it to SYMBOL_MAP after checking "
                         "the venue's own metadata") from None


def fee_table(venues) -> dict:
    return {v: venue(v).to_dict() for v in sorted(set(venues))}
