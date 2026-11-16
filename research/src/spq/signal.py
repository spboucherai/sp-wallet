"""Signal runner used by the engine (docs/v3/ARCHITECTURE.md, "Strategy contract").

    uv run python -m spq.signal --strategy <dir> --sha256 <hash> --input <json file, or - for stdin>

On success: exactly one JSON object on stdout, exit code 0:

    {"strategy_sha256": "<hex>", "as_of": "<bar-open time of the last closed bar, UTC>", "weights": {"ETH": 0.5, ...}}

On ANY problem: nothing on stdout, a one-line reason on stderr, non-zero exit code. The engine must treat every
non-zero exit (and a timeout, and unparsable output) as "no signal: hold".

    exit 2  bad command line or bad input (JSON, schema, symbols, timestamps, gaps, not enough bars)
    exit 3  strategy.py does not have the requested SHA-256 (no strategy code is executed)
    exit 4  strategy cannot be loaded (missing file, bad META, fails the static purity check, error at import)
    exit 5  target_weights raised (including an attempt to use the network, a file, the clock or randomness)
    exit 6  target_weights returned invalid weights (not a dict, NaN, outside [0, 1], sum > 1, unknown symbol)
    exit 1  anything else

Input (see schema/signal-input.schema.json):

    {"candles": {"ETH": [[ts, open, high, low, close, volume], ...], "LINK": [...]},
     "as_of": "2026-11-10T12:00:00Z",   # optional: must be the bar-open time of the last bar supplied
     "interval": "1h"}                   # optional: must equal META['interval']

`ts` is the bar-open time (ISO 8601 UTC string, or epoch seconds). Rows must be CLOSED bars, oldest first, strictly
increasing, for exactly the symbols of META['universe'] (for a universe-generic strategy, META['universe'] ==
["*"]: for the symbols the engine chose, 1 to 12 of them, within META['min_symbols'] / META['max_symbols'], and
the weights are validated against that list), with identical timestamps across symbols and at least
META['lookback'] bars; the last `lookback` bars are passed to the strategy. The runner has no clock: it cannot
tell whether the last bar is really closed, that is the engine's duty. Parameters always come from META (they are
part of the hashed file): the input cannot override them, otherwise an approved hash would not pin the behaviour.

Contract 2 — perpetual futures (META["kind"] = "perp"; docs/v4/quant-perps.md). Nothing above changes for spot
strategies. A perp strategy is only run when the caller passes `--contract 2` (without it: exit 2, so a caller
that only knows the spot contract can never receive signed, leveraged weights by accident); `--contract 2` on a
spot strategy is refused the same way. Input (schema/signal-input-v2.schema.json):

    {"candles": {"BTC": [[ts, o, h, l, c, v], ...], "BTC.SPOT": [...]},      # every symbol of the universe
     "funding": {"BTC": [[ts, rate], ...] or [[ts, rate, premium], ...]},   # every PERPETUAL of the universe
     "mark": {"BTC": [[ts, price], ...]}, "index": {...},                   # optional, perpetuals only
     "as_of": ..., "interval": ...}

Funding rows are hourly settlements: `ts` = the settlement hour (an instant within 60 s of the hour is attached to
it), `rate` = the fraction of notional longs paid at that instant, oldest first, strictly increasing. Each row is
attached to the bar that OPENS at its hour, exactly as in the backtester. A settlement — or a mark / index value —
dated AFTER the last bar's open time is refused (exit 2): it does not exist yet at the decision. Bars of the
lookback window without a settlement are refused beyond the same limits as missing bars. Output
(schema/signal-output-v2.schema.json), one line:

    {"schema_version": 2, "kind": "perp", "strategy_sha256": "<hex>", "as_of": "...",
     "weights": {"BTC": -0.5, "ETH": 0.25}, "max_leverage": 2.0, "max_gross_exposure": 2.0}

Weights are signed fractions of account equity (negative = short), each within +/- max_leverage (a spot leg within
[0, 1]) and their absolute values sum to at most max_gross_exposure; anything else is exit 6. These are TARGETS,
not orders: sizing, margin, liquidation distance and every risk limit are the engine's and the signer's duty.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys

import pandas as pd

import numpy as np

from .data.core import COLUMNS, DataError, align, normalise, to_utc
from .strategy import (HashMismatch, StrategyError, WeightsError, is_generic, is_spot_leg, load_strategy, resolve_symbols,
                       validate_perp_weights, validate_weights)

EXIT_INPUT, EXIT_HASH, EXIT_STRATEGY, EXIT_RUNTIME, EXIT_WEIGHTS = 2, 3, 4, 5, 6
FAR_FUTURE = "2262-01-01T00:00:00Z"


class InputError(ValueError):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise InputError(f"command line: {message}")


def iso_z(ts: pd.Timestamp) -> str:
    return ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_input(payload, meta: dict, *, max_gap_bars: int = 6, max_missing_fraction: float = 0.02):
    """Validate the engine's payload against META; return ({symbol: DataFrame of the last `lookback` bars}, as_of)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("candles"), dict):
        raise InputError('input must be an object with a "candles" object')
    unknown_keys = set(payload) - {"candles", "as_of", "interval"}
    if unknown_keys:
        raise InputError(f"unexpected input keys {sorted(unknown_keys)} (parameters cannot be overridden)")
    if "interval" in payload and payload["interval"] != meta["interval"]:
        raise InputError(f"input interval {payload['interval']!r} differs from META interval {meta['interval']!r}")
    candles = payload["candles"]
    if is_generic(meta):  # v5: a generic strategy takes its symbols from the input, in the order given
        try:
            universe = resolve_symbols(meta, list(candles))
        except StrategyError as e:
            raise InputError(str(e)) from e
    else:
        universe = meta["universe"]
        if sorted(candles) != sorted(universe):
            raise InputError(f"input symbols {sorted(candles)} differ from META universe {sorted(universe)}")
    data = {}
    for sym in universe:
        rows = candles[sym]
        if not isinstance(rows, list) or not rows:
            raise InputError(f"{sym}: candles must be a non-empty array")
        if not all(isinstance(r, list) and len(r) == 6 for r in rows):
            raise InputError(f"{sym}: every candle must be [ts, open, high, low, close, volume]")
        for r in rows:
            if any(isinstance(x, bool) or not isinstance(x, (int, float)) for x in r[1:]):
                raise InputError(f"{sym}: OHLCV values must be numbers")
        try:
            ts = [to_utc(pd.Timestamp(r[0], unit="s") if isinstance(r[0], (int, float)) else r[0]) for r in rows]
        except Exception as e:  # noqa: BLE001
            raise InputError(f"{sym}: unreadable timestamp ({e})") from e
        if any(b <= a for a, b in zip(ts, ts[1:])):
            raise InputError(f"{sym}: timestamps must be strictly increasing (oldest first, no duplicates)")
        raw = pd.DataFrame([r[1:] for r in rows], columns=COLUMNS, index=pd.DatetimeIndex(ts, name="ts"))
        try:
            df, q = normalise(raw, symbol=sym, interval=meta["interval"], source="engine", as_of=FAR_FUTURE)
        except DataError as e:
            raise InputError(str(e)) from e
        if q.off_grid or q.ohlc_violations:
            raise InputError(f"{sym}: {q.off_grid} timestamps off the {meta['interval']} grid, "
                             f"{q.ohlc_violations} rows with impossible OHLCV values")
        df = df.iloc[-meta["lookback"]:]
        if len(df) < meta["lookback"]:
            raise InputError(f"{sym}: {len(df)} bars supplied, the strategy needs {meta['lookback']}")
        _, q = normalise(df, symbol=sym, interval=meta["interval"], source="engine", as_of=FAR_FUTURE)
        if q.max_gap_bars > max_gap_bars or q.missing_fraction > max_missing_fraction:
            raise InputError(f"{sym}: {q.missing_bars} missing bars in the lookback window "
                             f"(longest gap {q.max_gap_bars}); refusing to compute a signal on a broken series")
        data[sym] = df
    first = data[universe[0]].index
    for sym, df in data.items():
        if not df.index.equals(first):
            raise InputError(f"{sym}: timestamps differ from {universe[0]} (series must be aligned)")
    as_of = first[-1]
    if payload.get("as_of") is not None:
        try:
            wanted = to_utc(payload["as_of"])
        except Exception as e:  # noqa: BLE001
            raise InputError(f"unreadable as_of ({e})") from e
        if wanted != as_of:
            raise InputError(f"as_of {payload['as_of']} is not the last bar supplied ({iso_z(as_of)})")
    return align(data), as_of


def _rows(obj, sym: str, what: str, widths: tuple[int, ...]) -> list:
    rows = obj.get(sym)
    if not isinstance(rows, list) or not rows:
        raise InputError(f"{sym}: {what} must be a non-empty array")
    if not all(isinstance(r, list) and len(r) in widths for r in rows):
        raise InputError(f"{sym}: every {what} row must have {' or '.join(map(str, widths))} values")
    for r in rows:
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or x != x or x in (float("inf"), float("-inf"))
               for x in r[1:]):
            raise InputError(f"{sym}: {what} values must be finite numbers")
    try:
        ts = [to_utc(pd.Timestamp(r[0], unit="s") if isinstance(r[0], (int, float)) else r[0]) for r in rows]
    except Exception as e:  # noqa: BLE001
        raise InputError(f"{sym}: unreadable {what} timestamp ({e})") from e
    if any(b <= a for a, b in zip(ts, ts[1:])):
        raise InputError(f"{sym}: {what} timestamps must be strictly increasing (oldest first, no duplicates)")
    return [(t, *r[1:]) for t, r in zip(ts, rows)]


def _nan_runs(values) -> tuple[int, int]:
    """(number of NaN, longest run of NaN)."""
    bad = np.isnan(np.asarray(values, dtype="float64"))
    longest = run = 0
    for b in bad:
        run = run + 1 if b else 0
        longest = max(longest, run)
    return int(bad.sum()), longest


def parse_perp_input(payload, meta: dict, *, max_gap_bars: int = 6, max_missing_fraction: float = 0.02):
    """Contract 2: candles as in parse_input, plus funding (mandatory) and mark / index (optional) for perpetuals.

    Nothing dated after the decision bar's open time may be in the input."""
    from .data.hyperliquid import FUNDING_TOLERANCE_MS, attach_funding

    if not isinstance(payload, dict):
        raise InputError('input must be an object with "candles" and "funding" objects')
    unknown_keys = set(payload) - {"candles", "funding", "mark", "index", "as_of", "interval"}
    if unknown_keys:
        raise InputError(f"unexpected input keys {sorted(unknown_keys)} (parameters cannot be overridden)")
    data, as_of = parse_input({k: payload[k] for k in ("candles", "as_of", "interval") if k in payload}, meta,
                              max_gap_bars=max_gap_bars, max_missing_fraction=max_missing_fraction)
    perps = [s for s in data if not is_spot_leg(s)]   # v11: the input's symbols (== META['universe'] when it is fixed)
    funding = payload.get("funding")
    if not isinstance(funding, dict) or sorted(funding) != sorted(perps):
        raise InputError(f'"funding" must be an object with exactly the perpetuals {sorted(perps)}')
    limit = int(len(next(iter(data.values()))) * max_missing_fraction)
    for sym in perps:
        rows = _rows(funding, sym, "funding", (2, 3))
        hour = [t.round("h") for t, *_ in rows]
        if any(abs((t - h).total_seconds()) * 1000 > FUNDING_TOLERANCE_MS for (t, *_), h in zip(rows, hour)):
            raise InputError(f"{sym}: funding timestamps must be hourly settlement times")
        if len(set(hour)) != len(hour):
            raise InputError(f"{sym}: two funding rows for the same settlement hour")
        if hour[-1] > as_of:
            raise InputError(f"{sym}: funding settlement {iso_z(hour[-1])} is dated after the decision bar "
                             f"({iso_z(as_of)}): a rate that is not settled yet cannot be an input")
        f = pd.DataFrame({"rate": [r[1] for r in rows], "premium": [r[2] if len(r) > 2 else float("nan") for r in rows]},
                         index=pd.DatetimeIndex(hour, name="ts").as_unit("ns"))
        data[sym] = attach_funding(data[sym], f)
        missing, gap = _nan_runs(data[sym]["funding"])
        if missing > limit or gap > max_gap_bars:
            raise InputError(f"{sym}: {missing} bars of the lookback window have no funding settlement "
                             f"(longest run {gap}); refusing to compute a signal on a broken funding series")
    for name in ("mark", "index"):
        if name not in payload:
            continue
        series = payload[name]
        if not isinstance(series, dict) or not set(series) <= set(perps) or not series:
            raise InputError(f'"{name}" must be an object keyed by perpetuals of the universe')
        for sym in series:
            rows = _rows(series, sym, name, (2,))
            if rows[-1][0] > as_of:
                raise InputError(f"{sym}: {name} value dated {iso_z(rows[-1][0])} is after the decision bar "
                                 f"({iso_z(as_of)})")
            if any(v <= 0 for _, v in rows):
                raise InputError(f"{sym}: {name} prices must be positive")
            s = pd.Series([v for _, v in rows], index=pd.DatetimeIndex([t for t, _ in rows]).as_unit("ns"))
            if not s.index[s.index >= data[sym].index[0]].isin(data[sym].index).all():
                raise InputError(f"{sym}: {name} timestamps must be bar-open times of the candles")
            data[sym] = data[sym].assign(**{name: s.reindex(data[sym].index).to_numpy()})
            missing, gap = _nan_runs(data[sym][name])
            if missing > limit or gap > max_gap_bars:
                raise InputError(f"{sym}: {missing} bars of the lookback window have no {name} value")
    return data, as_of


def compute_signal(strategy_dir, sha256: str, payload, contract: int = 1, **limits) -> dict:
    strategy = load_strategy(strategy_dir, sha256)
    if strategy.kind == "perp":
        if contract != 2:
            raise InputError("this is a perpetual-futures strategy (contract 2: signed, leveraged weights); "
                             "it is only run for a caller that passes --contract 2")
        data, as_of = parse_perp_input(payload, strategy.meta, **limits)
        with contextlib.redirect_stdout(sys.stderr):
            raw = strategy.raw(data)
        weights = validate_perp_weights(raw, list(data), strategy.meta["max_leverage"],
                                        strategy.meta["max_gross_exposure"])
        return {"schema_version": 2, "kind": "perp", "strategy_sha256": strategy.sha256, "as_of": iso_z(as_of),
                "weights": weights, "max_leverage": float(strategy.meta["max_leverage"]),
                "max_gross_exposure": float(strategy.meta["max_gross_exposure"])}
    if contract != 1:
        raise InputError("--contract 2 was requested but this is a spot strategy (contract 1)")
    data, as_of = parse_input(payload, strategy.meta, **limits)
    with contextlib.redirect_stdout(sys.stderr):
        raw = strategy.raw(data)
    weights = validate_weights(raw, list(data))  # v5: the symbols of the input (== META['universe'] when it is fixed)
    return {"strategy_sha256": strategy.sha256, "as_of": iso_z(as_of), "weights": weights}


def main(argv=None) -> int:
    try:
        p = _Parser(prog="python -m spq.signal", description=__doc__.split("\n")[0])
        p.add_argument("--strategy", required=True)
        p.add_argument("--sha256", required=True)
        p.add_argument("--input", required=True, help="JSON file, or - for stdin")
        p.add_argument("--max-gap-bars", type=int, default=6)
        p.add_argument("--max-missing-fraction", type=float, default=0.02)
        p.add_argument("--contract", type=int, choices=(1, 2), default=1,
                       help="1 = spot contract (default); 2 = perpetual futures (required to run a perp strategy)")
        try:
            a = p.parse_args(argv)
        except SystemExit as e:  # --help
            return int(e.code or 0)
        if len(a.sha256.strip()) != 64 or any(c not in "0123456789abcdefABCDEF" for c in a.sha256.strip()):
            raise InputError("--sha256 must be 64 hexadecimal characters")
        try:
            text = sys.stdin.read() if a.input == "-" else open(a.input, encoding="utf-8").read()
        except OSError as e:
            raise InputError(f"cannot read input: {e}") from e
        try:
            payload = json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(f"{c} not allowed")))
        except ValueError as e:
            raise InputError(f"input is not valid JSON: {e}") from e
        try:
            out = compute_signal(a.strategy, a.sha256, payload, contract=a.contract, max_gap_bars=a.max_gap_bars,
                                 max_missing_fraction=a.max_missing_fraction)
        except (HashMismatch, StrategyError, InputError, WeightsError):
            raise
        except BaseException as e:  # noqa: BLE001 - whatever the strategy raised, SystemExit(0) included
            print(f"spq.signal: strategy failed: {type(e).__name__}: {e}", file=sys.stderr)
            return EXIT_RUNTIME
        line = json.dumps(out, allow_nan=False)
    except InputError as e:
        print(f"spq.signal: input refused: {e}", file=sys.stderr)
        return EXIT_INPUT
    except HashMismatch as e:
        print(f"spq.signal: hash refused: {e}", file=sys.stderr)
        return EXIT_HASH
    except StrategyError as e:
        print(f"spq.signal: strategy refused: {e}", file=sys.stderr)
        return EXIT_STRATEGY
    except WeightsError as e:
        print(f"spq.signal: weights refused: {e}", file=sys.stderr)
        return EXIT_WEIGHTS
    except BaseException as e:  # noqa: BLE001
        print(f"spq.signal: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    sys.stdout.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
