# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/margin.py
# Description      : Margin arithmetic of the perp backtester: a Python port of
#                    `packages/derivatives/src/margin.ts`.
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

"""Margin arithmetic of the perp backtester: a Python port of `packages/derivatives/src/margin.ts`.

Same formulas, same rounding, same results on the same inputs (tests/test_margin.py ports the TypeScript examples):

- every value is a `decimal.Decimal`; sums, differences and products are EXACT (they run in a context that raises
  on any inexact result, see `EXACT`);
- every division states its scale (CALC_SCALE = 18 decimals) and its rounding mode, chosen on the cautious side:
  required margin and leverage round up, a long's liquidation price rounds up and a short's rounds down;
- `size` is a positive quantity of the base asset, the direction is `side` ('long' | 'short').

Like the TypeScript engine, these functions ignore funding accrual, tiered (size-dependent) maintenance margin,
venue-specific mark-price rules and auto-deleveraging. Their results are estimates of what a venue would compute.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Context, Decimal, DivisionByZero, Inexact, InvalidOperation, Overflow, localcontext
from fractions import Fraction

CALC_SCALE = 18
#: context in which the ledger runs: 200 significant digits, and any result that would need rounding raises
EXACT = Context(prec=200, traps=[Inexact, InvalidOperation, DivisionByZero, Overflow])
ZERO = Decimal(0)
ONE = Decimal(1)


def exact():
    """`with exact(): ...` — Decimal arithmetic that raises instead of rounding."""
    return localcontext(EXACT)


def dec(x) -> Decimal:
    """Decimal from a decimal string, an int or a Decimal. A float goes through its shortest repr (0.1 -> '0.1')."""
    if isinstance(x, Decimal):
        return x
    if isinstance(x, bool):
        raise TypeError("cannot build a Decimal from a bool")
    if isinstance(x, int):
        return Decimal(x)
    if isinstance(x, float):
        d = Decimal(repr(x))
    else:
        d = Decimal(str(x))
    if not d.is_finite():
        raise ValueError(f"not a finite decimal: {x!r}")
    return d


def dstr(x: Decimal) -> str:
    """Canonical decimal string of the TypeScript `D.str`: no exponent, no trailing zeros, '0' for zero."""
    if x == 0:
        return "0"
    s = format(x, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def div(a: Decimal, b: Decimal, scale: int = CALC_SCALE, mode: str = "half_even") -> Decimal:
    """a / b at `scale` decimals. mode: 'down' (towards zero), 'up' (away from zero), 'half_even'."""
    if b == 0:
        raise ZeroDivisionError("division by zero")
    if mode not in ("down", "up", "half_even"):
        raise ValueError(f"unknown rounding mode: {mode}")
    q = Fraction(a) / Fraction(b) * 10 ** scale
    num, den = q.numerator, q.denominator          # den > 0
    n = abs(num) // den
    r = abs(num) % den
    if r:
        if mode == "up" or (mode == "half_even" and (2 * r > den or (2 * r == den and n % 2 == 1))):
            n += 1
    return Decimal(-n if num < 0 else n).scaleb(-scale, EXACT)


def quantize_down(x: Decimal, decimals: int) -> Decimal:
    """Truncate towards zero at `decimals` decimals (lot size 10^-decimals)."""
    unit = 10 ** decimals
    f = Fraction(x) * unit
    n = abs(f.numerator) // f.denominator
    return Decimal(-n if f < 0 else n).scaleb(-decimals, EXACT)


def _positive(x: Decimal, name: str):
    if not x > 0:
        raise ValueError(f"{name} must be positive")


def _non_negative(x: Decimal, name: str):
    if x < 0:
        raise ValueError(f"{name} must not be negative")


def notional(size: Decimal, price: Decimal) -> Decimal:
    """|size| x price. Exact."""
    with exact():
        return abs(size) * price


def initial_margin(notional_value: Decimal, leverage: Decimal) -> Decimal:
    """IM = notional / leverage, rounded up at 18 decimals (flat fraction 1/leverage, no size tiers)."""
    _non_negative(notional_value, "notional")
    _positive(leverage, "leverage")
    return div(notional_value, leverage, CALC_SCALE, "up")


def maintenance_margin(notional_value: Decimal, maintenance_fraction: Decimal) -> Decimal:
    """notional x maintenance fraction. Exact (one flat fraction for the whole position)."""
    _non_negative(notional_value, "notional")
    _non_negative(maintenance_fraction, "maintenance fraction")
    with exact():
        return notional_value * maintenance_fraction


def unrealized_pnl(side: str, size: Decimal, entry_price: Decimal, mark_price: Decimal) -> Decimal:
    """long: size x (mark - entry); short: size x (entry - mark). Exact; linear USD-margined contract."""
    with exact():
        diff = mark_price - entry_price if side == "long" else entry_price - mark_price
        return abs(size) * diff


def effective_leverage(equity: Decimal, gross_exposure: Decimal) -> Decimal | None:
    """gross exposure / equity, rounded up; None when equity <= 0 (callers treat None as 'over any limit')."""
    if not equity > 0:
        return None
    return div(gross_exposure, equity, CALC_SCALE, "up")


def liquidation_price_isolated(side: str, size: Decimal, entry_price: Decimal, margin: Decimal,
                               maintenance_fraction: Decimal, fee_rate: Decimal = ZERO) -> Decimal | None:
    """Price at which position equity equals the maintenance requirement, k = maintenance fraction + fee rate:

        long :  margin + size (p - entry) = k size p   =>   p = (entry size - margin) / (size (1 - k))   rounded up
        short:  margin + size (entry - p) = k size p   =>   p = (entry size + margin) / (size (1 + k))   rounded down

    None when no positive price liquidates a long (its margin covers the whole notional). A long value >= entry
    (short <= entry) means the position is already at or past its threshold.
    """
    _positive(size, "size")
    _positive(entry_price, "entry price")
    _non_negative(maintenance_fraction, "maintenance fraction")
    _non_negative(fee_rate, "fee rate")
    with exact():
        k = maintenance_fraction + fee_rate
        entry_notional = entry_price * size
        if side == "long":
            den = size * (ONE - k)
            if not den > 0:
                raise ValueError("maintenance fraction + fee rate must be below 1")
            num = entry_notional - margin
            if not num > 0:
                return None
        else:
            num = entry_notional + margin
            if not num > 0:
                return ZERO
            den = size * (ONE + k)
    return div(num, den, CALC_SCALE, "up" if side == "long" else "down")


def liquidation_price_at_leverage(side: str, entry_price: Decimal, leverage: Decimal,
                                  maintenance_fraction: Decimal, fee_rate: Decimal = ZERO) -> Decimal | None:
    """Isolated position opened at `leverage` with exactly its initial margin (per unit of size)."""
    return liquidation_price_isolated(side, ONE, entry_price, initial_margin(entry_price, leverage),
                                      maintenance_fraction, fee_rate)


def liquidation_price_cross(side: str, size: Decimal, entry_price: Decimal, account_collateral: Decimal,
                            maintenance_fraction: Decimal, other_unrealized_pnl: Decimal = ZERO,
                            other_maintenance_margin: Decimal = ZERO, fee_rate: Decimal = ZERO) -> Decimal | None:
    """Cross margin, single-position approximation: the isolated formula with
    margin = account collateral + PnL of the other positions - their maintenance margin (both frozen).
    Exact only when this is the account's only position."""
    with exact():
        margin = account_collateral + other_unrealized_pnl - other_maintenance_margin
    return liquidation_price_isolated(side, size, entry_price, margin, maintenance_fraction, fee_rate)


@dataclass(frozen=True)
class Position:
    side: str            # 'long' | 'short'
    size: Decimal        # > 0
    entry_price: Decimal

    @property
    def signed(self) -> Decimal:
        return self.size if self.side == "long" else -self.size


@dataclass(frozen=True)
class PositionEffect:
    kind: str                    # open | increase | reduce | close | flip
    position: Position | None    # None when flat
    realized_pnl: Decimal        # of the closed part, fees not included
    closed_size: Decimal
    opened_size: Decimal


def signed_size(p: Position | None) -> Decimal:
    return ZERO if p is None else p.signed


def apply_order_to_position(position: Position | None, side: str, size: Decimal, price: Decimal) -> PositionEffect:
    """Effect of an execution (side 'buy' | 'sell', size, price) on a position.

    open / increase: entry = (old size x old entry + size x price) / (old size + size), half-even at 18 decimals
    (the only rounding). reduce / close: entry unchanged, realised PnL = closed x (price - entry) for a long,
    closed x (entry - price) for a short, exact. flip: the whole previous position is closed at `price` and the
    remainder opens the opposite side with entry = price.
    """
    _positive(size, "execution size")
    _positive(price, "execution price")
    direction = "long" if side == "buy" else "short"
    if position is None or position.size == 0:
        return PositionEffect("open", Position(direction, size, price), ZERO, ZERO, size)
    _positive(position.size, "position size")
    with exact():
        if position.side == direction:
            total = position.size + size
            cost = position.size * position.entry_price + size * price
            return PositionEffect("increase", Position(direction, total, div(cost, total, CALC_SCALE, "half_even")),
                                  ZERO, ZERO, size)
        closed = min(position.size, size)
        realized = unrealized_pnl(position.side, closed, position.entry_price, price)
        if size < position.size:
            return PositionEffect("reduce", Position(position.side, position.size - size, position.entry_price),
                                  realized, closed, ZERO)
        if size == position.size:
            return PositionEffect("close", None, realized, closed, ZERO)
        opened = size - position.size
        return PositionEffect("flip", Position(direction, opened, price), realized, closed, opened)


def free_collateral_after_order(equity: Decimal, margin_used: Decimal, side: str, size: Decimal, price: Decimal,
                                leverage: Decimal, position: Position | None = None,
                                fee_rate: Decimal = ZERO) -> Decimal:
    """equity - margin used - IM(added size x price, leverage) - size x price x fee rate, with
    added size = max(0, |position after| - |position before|). Margin released by a reduced part is not credited."""
    _positive(size, "order size")
    _positive(price, "order price")
    _positive(leverage, "leverage")
    with exact():
        before = signed_size(position)
        after = before + size if side == "buy" else before - size
        added = abs(after) - abs(before)
        margin = initial_margin(added * price, leverage) if added > 0 else ZERO
        return equity - margin_used - margin - size * price * fee_rate
