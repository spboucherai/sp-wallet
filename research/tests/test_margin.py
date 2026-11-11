"""spq.margin must give the numbers of packages/derivatives/src/margin.ts on the same inputs.

Every expected value below is copied from packages/derivatives/test/margin.test.ts (the hand computations are in
that file's comments); `s` is the canonical decimal string of the TypeScript `D.str`."""
from __future__ import annotations

from decimal import Decimal, Inexact

import pytest

from spq.margin import (Position, apply_order_to_position, dec, div, dstr, effective_leverage, exact,
                        free_collateral_after_order, initial_margin, liquidation_price_at_leverage,
                        liquidation_price_cross, liquidation_price_isolated, maintenance_margin, notional,
                        quantize_down, signed_size, unrealized_pnl)

d, s = dec, dstr


def test_notional_and_margins():
    assert s(notional(d("0.5"), d("60000"))) == "30000"
    assert s(notional(d("-0.5"), d("60000"))) == "30000"
    assert s(initial_margin(d("30000"), d("20"))) == "1500"
    assert s(initial_margin(d("100"), d("3"))) == "33.333333333333333334"       # rounded UP at 18 decimals
    assert s(maintenance_margin(d("30000"), d("0.005"))) == "150"
    with pytest.raises(ValueError):
        initial_margin(d("100"), d("0"))
    with pytest.raises(ValueError):
        maintenance_margin(d("-1"), d("0.01"))


def test_unrealized_pnl():
    assert s(unrealized_pnl("long", d("0.5"), d("60000"), d("61000"))) == "500"
    assert s(unrealized_pnl("short", d("0.5"), d("60000"), d("61000"))) == "-500"
    assert s(unrealized_pnl("short", d("3"), d("2000"), d("1950.5"))) == "148.5"
    assert s(unrealized_pnl("long", d("3"), d("2000"), d("2000"))) == "0"


def test_effective_leverage():
    assert s(effective_leverage(d("13000"), d("65000"))) == "5"
    assert s(effective_leverage(d("30000"), d("65000"))) == "2.166666666666666667"
    assert effective_leverage(d("0"), d("65000")) is None and effective_leverage(d("-5"), d("65000")) is None
    assert s(effective_leverage(d("100"), d("0"))) == "0"


def test_isolated_liquidation_price_long():
    # long 10 @ 100 with 100 of margin, maintenance 6.25 %: p = 900 / 9.375 = 96
    assert s(liquidation_price_isolated("long", d("10"), d("100"), d("100"), d("0.0625"))) == "96"
    # maintenance 5 % + closing fee 1.25 % gives the same k
    assert s(liquidation_price_isolated("long", d("10"), d("100"), d("100"), d("0.05"), d("0.0125"))) == "96"
    # (60 000 - 6 000) / 0.995 rounded UP at 18 decimals
    assert s(liquidation_price_isolated("long", d("1"), d("60000"), d("6000"), d("0.005"))) == "54271.35678391959798995"
    assert liquidation_price_isolated("long", d("10"), d("100"), d("1000"), d("0.05")) is None
    with pytest.raises(ValueError):
        liquidation_price_isolated("long", d("1"), d("100"), d("10"), d("1"))


def test_isolated_liquidation_price_short():
    # short 10 @ 100 with 275 of margin, maintenance 6.25 %: p = 1 275 / 10.625 = 120
    assert s(liquidation_price_isolated("short", d("10"), d("100"), d("275"), d("0.0625"))) == "120"
    # (1 000 + 100) / 10.5 rounded DOWN at 18 decimals
    assert s(liquidation_price_isolated("short", d("10"), d("100"), d("100"), d("0.05"))) == "104.761904761904761904"


def test_liquidation_price_from_a_leverage():
    assert s(liquidation_price_at_leverage("long", d("100"), d("10"), d("0.0625"))) == "96"
    assert s(liquidation_price_at_leverage("short", d("100"), d("4"), d("0"))) == "125"
    assert liquidation_price_at_leverage("long", d("100"), d("1"), d("0.01")) is None


def test_cross_liquidation_price_single_position_approximation():
    assert s(liquidation_price_cross("long", d("10"), d("100"), d("500"), d("0.0625"))) == "53.333333333333333334"
    assert s(liquidation_price_cross("long", d("10"), d("100"), d("500"), d("0.0625"), d("-100"), d("300"))) == "96"
    assert s(liquidation_price_cross("short", d("10"), d("100"), d("275"), d("0.0625"))) == "120"
    # the estimate shown by the TypeScript paper account in paper.test.ts (long 9 @ 100, collateral 99.1, 5 %)
    assert s(liquidation_price_cross("long", d("9"), d("100"), d("99.1"), d("0.05"))) == "93.672514619883040936"


def test_effect_of_an_order_on_a_position():
    e = apply_order_to_position(None, "sell", d("2"), d("100"))
    assert (e.kind, e.position.side, s(e.position.size), s(e.position.entry_price), s(e.realized_pnl)) == \
        ("open", "short", "2", "100", "0")
    long2 = Position("long", d("2"), d("100"))
    inc = apply_order_to_position(long2, "buy", d("1"), d("130"))
    assert (inc.kind, s(inc.position.size), s(inc.position.entry_price), s(inc.realized_pnl), s(inc.opened_size)) == \
        ("increase", "3", "110", "0", "1")
    red = apply_order_to_position(inc.position, "sell", d("1"), d("120"))
    assert (red.kind, s(red.position.size), s(red.position.entry_price), s(red.realized_pnl), s(red.closed_size)) == \
        ("reduce", "2", "110", "10", "1")
    close = apply_order_to_position(red.position, "sell", d("2"), d("105"))
    assert (close.kind, close.position, s(close.realized_pnl)) == ("close", None, "-10")
    flip = apply_order_to_position(long2, "sell", d("5"), d("90"))
    assert (flip.kind, flip.position.side, s(flip.position.size), s(flip.position.entry_price), s(flip.realized_pnl),
            s(flip.closed_size), s(flip.opened_size)) == ("flip", "short", "3", "90", "-20", "2", "3")
    sred = apply_order_to_position(Position("short", d("4"), d("50")), "buy", d("1"), d("40"))
    assert (sred.kind, s(sred.realized_pnl), s(sred.position.size)) == ("reduce", "10", "3")
    avg = apply_order_to_position(Position("long", d("1"), d("100")), "buy", d("2"), d("101"))
    assert s(avg.position.entry_price) == "100.666666666666666667"             # half-even at 18 decimals
    with pytest.raises(ValueError):
        apply_order_to_position(None, "buy", d("0"), d("1"))


def test_free_collateral_after_a_hypothetical_order():
    base = dict(equity=d("1000"), margin_used=d("200"), price=d("100"), leverage=d("5"))
    assert s(free_collateral_after_order(side="buy", size=d("1"), **base)) == "780"
    assert s(free_collateral_after_order(side="buy", size=d("1"), fee_rate=d("0.001"), **base)) == "779.9"
    long2 = Position("long", d("2"), d("90"))
    assert s(free_collateral_after_order(side="sell", size=d("1"), position=long2, **base)) == "800"
    assert s(free_collateral_after_order(side="sell", size=d("3"), position=long2, **base)) == "800"
    assert s(free_collateral_after_order(side="sell", size=d("6"), position=long2, **base)) == "760"
    assert s(free_collateral_after_order(side="buy", size=d("3"), position=long2, **base)) == "740"
    assert s(signed_size(Position("long", d("2"), d("1")))) == "2"
    assert s(signed_size(Position("short", d("2"), d("1")))) == "-2" and s(signed_size(None)) == "0"


def test_at_the_liquidation_price_equity_equals_maintenance():
    """Property of the formula (margin.test.ts checks it on random inputs): equity - maintenance is zero at p,
    up to the rounding of p at 18 decimals."""
    for side, size, entry, margin, mmf in [("long", "3.7", "2011.5", "900", "0.02"), ("short", "0.42", "61234", "4100", "0.0125"),
                                           ("long", "150", "83.4", "2000", "0.05"), ("short", "9", "100", "99.1", "0.05")]:
        p = liquidation_price_isolated(side, d(size), d(entry), d(margin), d(mmf))
        with exact():
            equity = d(margin) + unrealized_pnl(side, d(size), d(entry), p)
            maint = d(size) * p * d(mmf)
        assert abs(equity - maint) < Decimal("1e-14")
        assert (p < d(entry)) if side == "long" else (p > d(entry))


def test_exact_context_and_helpers():
    assert dstr(dec(0.1)) == "0.1" and dstr(dec("1.2300")) == "1.23" and dstr(dec(5)) == "5" and dstr(dec("0.000")) == "0"
    assert dstr(div(d("1"), d("3"), 4, "down")) == "0.3333" and dstr(div(d("1"), d("3"), 4, "up")) == "0.3334"
    assert dstr(div(d("-1"), d("3"), 4, "up")) == "-0.3334" and dstr(div(d("1"), d("8"), 2, "half_even")) == "0.12"
    assert dstr(div(d("3"), d("8"), 2, "half_even")) == "0.38"
    assert dstr(quantize_down(d("1.23456789"), 4)) == "1.2345" and dstr(quantize_down(d("-1.23456789"), 4)) == "-1.2345"
    with exact():
        assert d("0.1") + d("0.2") == d("0.3")              # exact, unlike floats
        with pytest.raises(Inexact):
            d("1") / d("3")                                 # a division that would round is an error, not a value
    with pytest.raises(TypeError):
        dec(True)
    with pytest.raises(ValueError):
        dec(float("nan"))
