"""Backtest one perpetual-futures strategy version and write the version-2 JSON report.

    uv run python -m spq.perp_backtest --strategy strategies/ts_momentum_perp/1 --data-dir data \
        --rebalance-threshold 0.05 --out report.json

Data come from --data-dir: Hyperliquid candles and funding written by `python -m spq.data.hyperliquid`, and (for
the spot benchmark and for spot legs) spot candles written by `python -m spq.data.fetch`. Venue parameters
(maximum leverage, lot) are read from <data-dir>/hyperliquid/meta.json when it exists. The report is validated
against schema/backtest-report-v2.schema.json before it is written. Exit code 0 means a report was written; it
says nothing about whether the strategy is any good.

V11: `--report-version 3` writes the version-3 report (schema/backtest-report-v3.schema.json) with the V11 execution
model (latency bound, size-dependent slippage, fees and accounts per venue) and ENGINE PARITY (the live engine's
default sizing and stop rules from research/src/spq/params/engine-parity.json); `--ledger` is then mandatory. The default
stays version 2, unchanged. Symbols may then be 'BTC@EDGEX' (another venue's store) next to 'BTC' and 'BTC.SPOT'.
"""
from __future__ import annotations

import argparse
import json
import sys

from .data import DataError
from .data.hyperliquid import SOURCE, load_meta, load_perp_universe, load_spot_reference
from .perp_engine import HL_MAKER_BPS, HL_MIN_ORDER, HL_TAKER_BPS, PerpConfig
from .perp_report import build_perp_report, write_perp_report
from .research import cartesian_grid
from .strategy import StrategyError, is_spot_leg, load_strategy


def add_cost_arguments(p: argparse.ArgumentParser) -> None:
    p.add_argument("--taker-fee-bps", type=float, default=HL_TAKER_BPS, help="Hyperliquid base tier: 4.5")
    p.add_argument("--maker-fee-bps", type=float, default=HL_MAKER_BPS, help="Hyperliquid base tier: 1.5")
    p.add_argument("--liquidity", choices=("taker", "maker"), default="taker",
                   help="fee paid by every fill (default taker: fills at the open are market orders)")
    p.add_argument("--slippage-bps", type=float, default=2.0)
    p.add_argument("--liquidation-penalty-bps", type=float, default=100.0,
                   help="charged on the liquidated notional, on top of the taker fee")
    p.add_argument("--maintenance-fraction", type=float, default=None,
                   help="flat maintenance margin fraction; default 1 / (2 x venue max leverage) per symbol")
    p.add_argument("--leverage", type=float, default=None, help="account leverage; default META['max_leverage']")
    p.add_argument("--spot-fee-bps", type=float, default=10.0)
    p.add_argument("--spot-slippage-bps", type=float, default=10.0)
    p.add_argument("--initial-cash", type=float, default=1000.0)
    p.add_argument("--min-order", type=float, default=HL_MIN_ORDER, help="USD; Hyperliquid minimum: 10")
    p.add_argument("--rebalance-threshold", type=float, default=0.05)


def make_config(a, interval: str, venue_meta: dict, symbols, decision_every: int = 1) -> PerpConfig:
    uni = venue_meta.get("universe", {})
    perps = [s for s in symbols if not is_spot_leg(s)]
    return PerpConfig(
        interval=interval, taker_fee_bps=a.taker_fee_bps, maker_fee_bps=a.maker_fee_bps, liquidity=a.liquidity,
        slippage_bps=a.slippage_bps, initial_cash=a.initial_cash, min_order=a.min_order,
        rebalance_threshold=a.rebalance_threshold, decision_every=decision_every, leverage=a.leverage,
        venue_max_leverage={s: uni[s]["max_leverage"] for s in perps if s in uni},
        maintenance_fraction=a.maintenance_fraction, liquidation_penalty_bps=a.liquidation_penalty_bps,
        size_decimals={s: uni[s]["size_decimals"] for s in perps if s in uni},
        spot_fee_bps=a.spot_fee_bps, spot_slippage_bps=a.spot_slippage_bps)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m spq.perp_backtest", description=__doc__.split("\n")[0])
    p.add_argument("--strategy", required=True, help="strategy version directory (contains strategy.py)")
    p.add_argument("--sha256", default=None, help="refuse to run if strategy.py has another hash")
    p.add_argument("--symbols", default=None, help="comma-separated; default: META['universe']")
    p.add_argument("--interval", default=None, help="default: META['interval']")
    p.add_argument("--start", default=None, help="UTC, inclusive")
    p.add_argument("--end", default=None, help="UTC, exclusive")
    add_cost_arguments(p)
    p.add_argument("--decision-every", type=int, default=1, help="ask the strategy every N bars")
    p.add_argument("--split", default="0.6,0.2,0.2", help="train,validation,test fractions (chronological)")
    p.add_argument("--grid", default=None, help="JSON object parameter -> list of values for the sensitivity grid")
    p.add_argument("--folds", type=int, default=4)
    p.add_argument("--resamples", type=int, default=2000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--ledger", default=None, help="JSONL file recording every trial and test evaluation")
    p.add_argument("--job-ledger", default=None,
                   help="v7: the trial ledger of the research job that produced this strategy (the runner's copy); "
                        "its trials are added to the trial count of the deflated Sharpe ratio")
    p.add_argument("--data-dir", required=True, help="root of the local store (hyperliquid/ and the spot source)")
    p.add_argument("--spot-source", default="coinbase", help="spot candles for the benchmark and for spot legs")
    p.add_argument("--out", required=True, help="report path (JSON)")
    p.add_argument("--report-version", type=int, choices=(2, 3), default=2,
                   help="3 = V11 report: execution realism + engine parity + data bias + journal (needs --ledger)")
    p.add_argument("--as-of", default=None,
                   help="v3: capture time of the data (ISO 8601), written as generated_at; default: the close of the "
                        "last bar (a version-3 report holds no wall-clock time)")
    p.add_argument("--no-engine-parity", action="store_true",
                   help="v3: do not apply the live engine's default limits (the report then says so)")
    return p


def _main_v3(a, strategy, symbols, interval) -> int:
    from dataclasses import replace

    import pandas as pd

    from .data.core import interval_seconds
    from .data.multivenue import data_bias, funding_intervals, load_multivenue, snapshot_hash
    from .execution import calibrated_execution, load_parity
    from .report_v3 import build_report_v3, write_report_v3

    if not a.ledger:
        raise ValueError("--report-version 3 needs --ledger: every run is recorded")
    data, quality, fq, raw, clock = load_multivenue(symbols, interval, a.start, a.end, root=a.data_dir,
                                                    as_of=a.as_of, spot_source=a.spot_source)
    index = next(iter(data.values())).index
    as_of = a.as_of or (index[-1] + pd.Timedelta(seconds=interval_seconds(interval))).isoformat()
    perp_par, _, parity_raw = load_parity()
    config = replace(make_config(a, interval, load_meta(a.data_dir), symbols, a.decision_every),
                     execution=calibrated_execution(symbols), parity=None if a.no_engine_parity else perp_par)
    perps = [s for s in symbols if not is_spot_leg(s)]
    spot, _ = (load_spot_reference(perps, interval, index, root=a.data_dir, source=a.spot_source)
               if all("@" not in s for s in perps) else ({}, {}))
    if spot and not all(index.isin(df.index).all() for df in spot.values()):
        spot = {}
    spot = {s: df.loc[index] for s, df in spot.items()}
    grid = cartesian_grid(strategy.params, json.loads(a.grid)) if a.grid else None
    report, _ = build_report_v3(
        strategy, data, config, ledger=a.ledger, job_ledger=a.job_ledger,
        data_bias=data_bias(symbols, data, quality, clock, interval, requested_start=a.start),
        data_snapshot={"sha256": snapshot_hash(data), "captured_at": as_of, "manifest": None,
                       "range": [index[0].isoformat(), index[-1].isoformat()], "bars": int(len(index))},
        generated_at=as_of, parity_raw=parity_raw, funding_intervals=funding_intervals(symbols), seed=a.seed,
        n_resamples=a.resamples, fractions=tuple(float(x) for x in a.split.split(",")), quality=quality,
        funding_quality=fq, funding_raw=raw, spot_data=spot, grid=grid, n_folds=a.folds, source=SOURCE)
    digest = write_report_v3(report, a.out)
    t = report["metrics"]["test"]
    print(json.dumps({
        "report": a.out, "report_sha256": digest, "schema_version": 3, "strategy_sha256": report["strategy_sha256"],
        "test": {k: t[k] for k in ("total_return", "sharpe", "max_drawdown", "trades", "liquidations")},
        "gross_to_net_test": t["gross_to_net"], "engine_stop_test": report["engine_parity"].get("observed", {}).get("test", {}).get("stop"),
        "deflated_sharpe": report["robustness"]["deflated_sharpe"],
        "checks": {k: report["checks"][k] for k in ("lookahead", "data_quality", "ledger", "funding_alignment")},
    }))
    return 0


def main(argv=None) -> int:
    a = parser().parse_args(argv)
    try:
        strategy = load_strategy(a.strategy, a.sha256)
        if strategy.kind != "perp":
            raise StrategyError(f"{strategy.name} is a {strategy.kind} strategy: use python -m spq.backtest")
        given = [s.strip() for s in a.symbols.split(",") if s.strip()] if a.symbols else None
        symbols = strategy.symbols_for(given)        # v11: a generic perp universe takes --symbols (validated)
        interval = a.interval or strategy.meta["interval"]
        if a.report_version == 3:
            return _main_v3(a, strategy, symbols, interval)
        config = make_config(a, interval, load_meta(a.data_dir), symbols, a.decision_every)
        fractions = tuple(float(x) for x in a.split.split(","))
        grid = cartesian_grid(strategy.params, json.loads(a.grid)) if a.grid else None
        data, quality, fq, raw = load_perp_universe(symbols, interval, a.start, a.end, root=a.data_dir,
                                                    spot_source=a.spot_source)
        index = next(iter(data.values())).index
        perps = [s for s in symbols if not is_spot_leg(s)]
        spot, spot_q = load_spot_reference(perps, interval, index, root=a.data_dir, source=a.spot_source)
        notes = [f"spot benchmark from {a.spot_source}: {s} {q.n_bars} bars, {q.missing_bars} missing"
                 for s, q in spot_q.items()]
        report, _ = build_perp_report(strategy, data, config, quality=quality, funding_quality=fq, funding_raw=raw,
                                      spot_data=spot, fractions=fractions, grid=grid, ledger=a.ledger, job_ledger=a.job_ledger,
                                      n_folds=a.folds, n_resamples=a.resamples, seed=a.seed, source=SOURCE,
                                      notes=notes)
        write_perp_report(report, a.out)
    except (StrategyError, DataError, ValueError) as e:
        print(f"spq.perp_backtest: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    t = report["metrics"]["test"]
    print(json.dumps({
        "report": a.out, "strategy_sha256": report["strategy_sha256"],
        "test": {k: t[k] for k in ("total_return", "sharpe", "max_drawdown", "worst_intrabar_drawdown", "trades",
                                   "fees_paid", "funding_pnl", "gross_leverage_mean", "liquidations", "wiped_out")},
        "benchmarks_test": {n: {k: b[k] for k in ("total_return", "sharpe", "max_drawdown")}
                            for n, b in report["benchmarks"].items() if n in ("buy_and_hold", "perp_long_1x")},
        "sharpe_ci": report["robustness"]["bootstrap_sharpe_ci"],
        "trials_tested": report["robustness"]["trials_tested"],
        "deflated_sharpe": report["robustness"]["deflated_sharpe"],
        "checks": {k: report["checks"][k] for k in ("lookahead", "data_quality", "ledger", "funding_alignment")},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
