# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/risk_supervisor.py
# Description      : Portfolio-level risk supervisor: a deterministic POLICY,
#                    not a trading strategy.
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

"""Portfolio-level risk supervisor: a deterministic POLICY, not a trading strategy.

    propose(positions, equity_curve, limits) -> {"proposals": [...], "state": {...}}

Given the positions of an account (or of several agents taken together), its equity history and a set of limits,
it PROPOSES reductions. It never increases a position, never opens one, never sends anything: its output is a list
of "reduce this position to that notional, for this reason". Whether a proposal is acted on belongs to the owner or
to the engine. It is a pure function of its arguments (no clock, no file, no randomness; it passes the lab's purity
lint, tests/test_risk_supervisor.py) and the same inputs always give the same proposals, in the same order.

Inputs
- positions: list of {"symbol", "notional" (signed USD: + long, - short), and optionally "mark", "liquidation_price",
  "funding_rate_per_hour" (what a LONG pays per hour: a positive rate costs a long and pays a short), "venue"}.
- equity_curve: list of equity values, oldest first, the last one being the current equity (at least one value).
- limits: any subset of DEFAULT_LIMITS (missing keys take the default).

Rules, applied in this order; each can only LOWER the allowed notional of a position, and the final proposal of a
position is the lowest of all (reasons are all kept):
1. drawdown de-leverage   drawdown = 1 - equity / running peak. At or above `drawdown_hard`: every position to 0.
                          Between `drawdown_soft` and `drawdown_hard`: every position scaled by
                          `drawdown_soft_scale`.
2. gross leverage         sum of |notional| / equity above `max_gross_leverage`: all positions scaled pro rata.
3. concentration          |notional| / equity above `max_position_share`: that position cut to the cap.
4. liquidation distance   |mark - liquidation_price| / mark below `min_liquidation_distance`: that position cut by
                          `liquidation_cut` (a smaller position is further from its liquidation price in a cross
                          account; the supervisor does not recompute the venue's margin).
5. funding bleed          a position that PAYS funding at more than `max_funding_bleed_apr` of its notional per
                          year: cut by `funding_cut`.
A proposal is emitted only when the reduction is at least `min_reduction_usd` (no noise).
"""

DEFAULT_LIMITS = {
    "drawdown_soft": 0.05,
    "drawdown_hard": 0.10,
    "drawdown_soft_scale": 0.5,
    "max_gross_leverage": 1.5,
    "max_position_share": 1.0,
    "min_liquidation_distance": 0.10,
    "liquidation_cut": 0.5,
    "max_funding_bleed_apr": 0.30,
    "funding_cut": 0.5,
    "min_reduction_usd": 1.0,
}
HOURS_PER_YEAR = 8760.0


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
        raise ValueError(name + " must be a finite number")
    return float(value)


def drawdown(equity_curve):
    """1 - last equity / highest equity so far (0 when the curve is at its peak)."""
    peak = 0.0
    for value in equity_curve:
        peak = max(peak, _number(value, "equity"))
    last = _number(equity_curve[-1], "equity")
    return 0.0 if peak <= 0 else max(0.0, 1.0 - last / peak)


def propose(positions, equity_curve, limits=None):
    """See the module docstring. Raises ValueError on malformed inputs (a supervisor must not guess)."""
    lim = dict(DEFAULT_LIMITS)
    for key, value in (limits or {}).items():
        if key not in DEFAULT_LIMITS:
            raise ValueError("unknown limit " + str(key))
        lim[key] = _number(value, key)
    if not 0 < lim["drawdown_soft"] <= lim["drawdown_hard"] or not 0 <= lim["drawdown_soft_scale"] <= 1:
        raise ValueError("drawdown limits must satisfy 0 < soft <= hard and 0 <= soft scale <= 1")
    if not 0 <= lim["liquidation_cut"] <= 1 or not 0 <= lim["funding_cut"] <= 1:
        raise ValueError("cuts are fractions in [0, 1]")
    if not equity_curve:
        raise ValueError("the equity curve is empty")
    equity = _number(equity_curve[-1], "equity")
    rows, seen = [], set()
    for p in positions:
        symbol = p.get("symbol")
        key = (symbol, p.get("venue"))
        if not isinstance(symbol, str) or not symbol or key in seen:
            raise ValueError("every position needs a distinct symbol (per venue)")
        seen.add(key)
        rows.append({"symbol": symbol, "venue": p.get("venue"), "notional": _number(p.get("notional"), "notional"),
                     "p": p})
    dd = drawdown(equity_curve)
    gross = sum(abs(r["notional"]) for r in rows)
    state = {"equity": equity, "drawdown": dd, "gross_notional": gross,
             "gross_leverage": gross / equity if equity > 0 else None, "regime": "normal"}
    allowed = [abs(r["notional"]) for r in rows]
    reasons = [[] for _ in rows]

    def lower(i, cap, rule, detail):
        if cap < allowed[i] - 1e-12:
            allowed[i] = max(cap, 0.0)
            reasons[i].append({"rule": rule, "detail": detail})

    # 1. drawdown
    if equity <= 0 or dd >= lim["drawdown_hard"]:
        state["regime"] = "hard_drawdown"
        for i in range(len(rows)):
            lower(i, 0.0, "drawdown_hard", "drawdown %.4f >= %.4f: close" % (dd, lim["drawdown_hard"]))
    elif dd >= lim["drawdown_soft"]:
        state["regime"] = "soft_drawdown"
        for i, r in enumerate(rows):
            lower(i, abs(r["notional"]) * lim["drawdown_soft_scale"], "drawdown_soft",
                  "drawdown %.4f >= %.4f: scale by %.2f" % (dd, lim["drawdown_soft"], lim["drawdown_soft_scale"]))
    if equity > 0:
        # 2. gross leverage (on what rule 1 left)
        left = sum(allowed)
        cap = lim["max_gross_leverage"] * equity
        if left > cap + 1e-12:
            factor = cap / left
            for i in range(len(rows)):
                lower(i, allowed[i] * factor, "gross_leverage",
                      "gross %.2f > %.2f x equity: scale by %.4f" % (left, lim["max_gross_leverage"], factor))
        # 3. concentration
        cap = lim["max_position_share"] * equity
        for i, r in enumerate(rows):
            lower(i, cap, "concentration", "position above %.2f x equity" % lim["max_position_share"])
    for i, r in enumerate(rows):
        p = r["p"]
        # 4. liquidation distance
        if p.get("mark") is not None and p.get("liquidation_price") is not None:
            mark, liq = _number(p["mark"], "mark"), _number(p["liquidation_price"], "liquidation_price")
            if mark > 0:
                distance = abs(mark - liq) / mark
                if distance < lim["min_liquidation_distance"]:
                    lower(i, abs(r["notional"]) * (1.0 - lim["liquidation_cut"]), "liquidation_distance",
                          "liquidation %.4f away < %.4f: cut by %.2f" % (distance, lim["min_liquidation_distance"],
                                                                         lim["liquidation_cut"]))
        # 5. funding bleed: a long pays a positive rate, a short pays a negative one
        if p.get("funding_rate_per_hour") is not None and r["notional"] != 0:
            rate = _number(p["funding_rate_per_hour"], "funding_rate_per_hour")
            paid_apr = rate * HOURS_PER_YEAR * (1.0 if r["notional"] > 0 else -1.0)
            if paid_apr > lim["max_funding_bleed_apr"]:
                lower(i, abs(r["notional"]) * (1.0 - lim["funding_cut"]), "funding_bleed",
                      "pays %.4f of notional per year > %.4f: cut by %.2f" % (paid_apr, lim["max_funding_bleed_apr"],
                                                                              lim["funding_cut"]))
    proposals = []
    for i, r in enumerate(rows):
        cut = abs(r["notional"]) - allowed[i]
        if reasons[i] and cut >= lim["min_reduction_usd"]:
            sign = 1.0 if r["notional"] > 0 else -1.0
            proposals.append({"symbol": r["symbol"], "venue": r["venue"], "action": "reduce",
                              "from_notional": r["notional"], "to_notional": sign * allowed[i],
                              "reduce_by_usd": cut, "reasons": reasons[i]})
    proposals.sort(key=lambda x: (-x["reduce_by_usd"], x["symbol"], str(x["venue"])))
    state["proposed_gross_notional"] = sum(allowed)
    return {"proposals": proposals, "state": state, "limits": lim}
