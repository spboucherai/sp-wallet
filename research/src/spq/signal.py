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
increasing, for exactly the symbols of META['universe'], with identical timestamps across symbols and at least
META['lookback'] bars; the last `lookback` bars are passed to the strategy. The runner has no clock: it cannot
tell whether the last bar is really closed, that is the engine's duty. Parameters always come from META (they are
part of the hashed file): the input cannot override them, otherwise an approved hash would not pin the behaviour.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys

import pandas as pd

from .data.core import COLUMNS, DataError, align, normalise, to_utc
from .strategy import HashMismatch, StrategyError, WeightsError, load_strategy, validate_weights

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
    if sorted(candles) != sorted(meta["universe"]):
        raise InputError(f"input symbols {sorted(candles)} differ from META universe {sorted(meta['universe'])}")
    data = {}
    for sym in meta["universe"]:
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
    first = data[meta["universe"][0]].index
    for sym, df in data.items():
        if not df.index.equals(first):
            raise InputError(f"{sym}: timestamps differ from {meta['universe'][0]} (series must be aligned)")
    as_of = first[-1]
    if payload.get("as_of") is not None:
        try:
            wanted = to_utc(payload["as_of"])
        except Exception as e:  # noqa: BLE001
            raise InputError(f"unreadable as_of ({e})") from e
        if wanted != as_of:
            raise InputError(f"as_of {payload['as_of']} is not the last bar supplied ({iso_z(as_of)})")
    return align(data), as_of


def compute_signal(strategy_dir, sha256: str, payload, **limits) -> dict:
    strategy = load_strategy(strategy_dir, sha256)
    data, as_of = parse_input(payload, strategy.meta, **limits)
    with contextlib.redirect_stdout(sys.stderr):
        raw = strategy.raw(data)
    weights = validate_weights(raw, strategy.universe)
    return {"strategy_sha256": strategy.sha256, "as_of": iso_z(as_of), "weights": weights}


def main(argv=None) -> int:
    try:
        p = _Parser(prog="python -m spq.signal", description=__doc__.split("\n")[0])
        p.add_argument("--strategy", required=True)
        p.add_argument("--sha256", required=True)
        p.add_argument("--input", required=True, help="JSON file, or - for stdin")
        p.add_argument("--max-gap-bars", type=int, default=6)
        p.add_argument("--max-missing-fraction", type=float, default=0.02)
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
            out = compute_signal(a.strategy, a.sha256, payload, max_gap_bars=a.max_gap_bars,
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
