"""Backtest one strategy version and write the JSON report.

    uv run python -m spq.backtest --strategy strategies/ma_trend/1 --symbols ETH,LINK --interval 1h \
        --start 2024-11-10 --end 2026-11-10 --fee-bps 10 --slippage-bps 10 --out report.json

Data come from --data-dir (local files written by spq.data.fetch), else SPQ_DATA_DIR, else DATABASE_URL.
The report is validated against schema/backtest-report.schema.json before it is written. Exit code 0 means a
report was written; it says nothing about whether the strategy is any good.
"""
from __future__ import annotations

import argparse
import json
import sys

from .data import DataError, load_universe
from .engine import BacktestConfig
from .report import build_report, write_report
from .research import cartesian_grid
from .strategy import StrategyError, load_strategy


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m spq.backtest", description=__doc__.split("\n")[0])
    p.add_argument("--strategy", required=True, help="strategy version directory (contains strategy.py)")
    p.add_argument("--sha256", default=None, help="refuse to run if strategy.py has another hash")
    p.add_argument("--symbols", default=None, help="comma-separated; default: META['universe'] (required when it is ['*'])")
    p.add_argument("--interval", default=None, help="default: META['interval']")
    p.add_argument("--start", default=None, help="UTC, inclusive")
    p.add_argument("--end", default=None, help="UTC, exclusive")
    p.add_argument("--fee-bps", type=float, default=10.0)
    p.add_argument("--slippage-bps", type=float, default=10.0)
    p.add_argument("--initial-cash", type=float, default=1000.0)
    p.add_argument("--min-order", type=float, default=0.0, help="USD; smaller orders are skipped")
    p.add_argument("--rebalance-threshold", type=float, default=0.05,
                   help="weight distance under which a position is left alone (default 0.05; 0 = rebalance to "
                        "the exact target at every bar, which trades at every bar)")
    p.add_argument("--decision-every", type=int, default=1, help="ask the strategy every N bars")
    p.add_argument("--split", default="0.6,0.2,0.2", help="train,validation,test fractions (chronological)")
    p.add_argument("--grid", default=None,
                   help='JSON object parameter -> list of values for the sensitivity grid, e.g. \'{"fast":[12,24]}\'; '
                        "default: each numeric parameter halved and doubled, one at a time")
    p.add_argument("--folds", type=int, default=4, help="walk-forward folds")
    p.add_argument("--resamples", type=int, default=2000, help="bootstrap / Monte Carlo draws")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--ledger", default=None,
                   help="JSONL file recording every trial and test evaluation across runs; the deflated Sharpe "
                        "ratio then counts all the trials in it")
    p.add_argument("--job-ledger", default=None,
                   help="v7: the trial ledger of the research job that produced this strategy (the runner's copy); "
                        "its trials are added to the trial count of the deflated Sharpe ratio")
    p.add_argument("--data-dir", default=None, help="root of local candle files (<root>/<source>/<SYM>_<interval>)")
    p.add_argument("--source", default=None, help="candle source (default: coinbase for files)")
    p.add_argument("--out", required=True, help="report path (JSON)")
    return p


def main(argv=None) -> int:
    a = parser().parse_args(argv)
    try:
        strategy = load_strategy(a.strategy, a.sha256)
        if strategy.kind != "spot":
            raise StrategyError(f"{strategy.name} is a {strategy.kind} strategy: use python -m spq.perp_backtest")
        given = [s.strip().upper() for s in a.symbols.split(",") if s.strip()] if a.symbols else None
        symbols = strategy.symbols_for(given)  # v5: a generic strategy takes --symbols (validated); a fixed one is unchanged
        interval = a.interval or strategy.meta["interval"]
        config = BacktestConfig(interval=interval, fee_bps=a.fee_bps, slippage_bps=a.slippage_bps,
                                initial_cash=a.initial_cash, min_order=a.min_order,
                                rebalance_threshold=a.rebalance_threshold, decision_every=a.decision_every)
        fractions = tuple(float(x) for x in a.split.split(","))
        grid = cartesian_grid(strategy.params, json.loads(a.grid)) if a.grid else None
        kwargs = {"root": a.data_dir} if a.data_dir else {}
        data, quality = load_universe(symbols, interval, a.start, a.end, source=a.source, **kwargs)
        raw_bars = {s: q.n_bars for s, q in quality.items()}
        aligned = len(next(iter(data.values())))
        notes = []
        if any(n != aligned for n in raw_bars.values()):
            notes.append(f"bars per symbol before alignment {raw_bars}, common bars kept: {aligned}")
        source = next(iter(quality.values())).source
        report, _ = build_report(strategy, data, config, quality=quality, fractions=fractions, grid=grid,
                                 ledger=a.ledger, job_ledger=a.job_ledger, n_folds=a.folds, n_resamples=a.resamples, seed=a.seed,
                                 source=source, notes=notes)
        write_report(report, a.out)
    except (StrategyError, DataError, ValueError) as e:
        print(f"spq.backtest: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    t, b = report["metrics"]["test"], report["benchmarks"]["buy_and_hold"]
    print(json.dumps({
        "report": a.out, "strategy_sha256": report["strategy_sha256"],
        "test": {k: t[k] for k in ("total_return", "sharpe", "max_drawdown", "trades", "fees_paid", "exposure")},
        "buy_and_hold_test": {k: b[k] for k in ("total_return", "sharpe", "max_drawdown")},
        "trials_tested": report["robustness"]["trials_tested"],
        "deflated_sharpe": report["robustness"]["deflated_sharpe"],
        "checks": {k: report["checks"][k] for k in ("lookahead", "data_quality")},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
