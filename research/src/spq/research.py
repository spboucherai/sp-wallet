# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/research.py
# Description      : Chronological splits and the Experiment object that
#                    enforces their use.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
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

"""Chronological splits and the Experiment object that enforces their use.

The rule "the test split is never used for parameter selection" is enforced by the API:

- Every routine that compares configurations (grid search, sensitivity, walk-forward) goes through
  `Experiment.trial()` / `Experiment.run()`, which only ever see `Experiment.dev_data()`: a copy of the data
  truncated before the first test bar. Asking them for the test split raises `TestSplitError`.
- The test split is reachable through `Experiment.final_test()` only. It can be evaluated once per strategy name;
  from that moment the experiment is sealed for that strategy: any further trial, or a second `final_test` with
  another version or other parameters, raises `TestSplitError`.
- Every trial and every test evaluation is counted (and appended to an optional JSONL ledger that survives the
  process), so the report can state how many configurations were tried and how often the test split was looked at.

What it cannot do: stop someone from creating a new Experiment and starting again. The persistent ledger exists
to make that visible (`test_evaluations` in the report), not impossible.
"""
from __future__ import annotations

import itertools
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .data.core import DataError
from .engine import BacktestConfig, BacktestResult, buy_and_hold, check_aligned, equal_weight, run_backtest
from .metrics import sharpe_ratio
from .strategy import Strategy

SELECTION_SPLITS = ("train", "validation", "development")
JOB_LEDGER_ENV = "SPQ_JOB_LEDGER"


class TestSplitError(PermissionError):
    """An attempt to use the test split for anything other than the single final evaluation."""

    __test__ = False  # not a pytest class


@dataclass(frozen=True)
class Splits:
    """Half-open [start, end) windows on bar-open time; `*_last` are the last bars inside each window."""

    train: tuple[pd.Timestamp, pd.Timestamp]
    validation: tuple[pd.Timestamp, pd.Timestamp]
    test: tuple[pd.Timestamp, pd.Timestamp]
    last: dict

    @classmethod
    def chronological(cls, index: pd.DatetimeIndex, fractions=(0.6, 0.2, 0.2)) -> "Splits":
        f = tuple(float(x) for x in fractions)
        if len(f) != 3 or any(x <= 0 for x in f) or abs(sum(f) - 1.0) > 1e-9:
            raise ValueError("fractions must be three positive numbers summing to 1 (train, validation, test)")
        n = len(index)
        i1, i2 = int(n * f[0]), int(n * (f[0] + f[1]))
        if min(i1, i2 - i1, n - i2) < 3:
            raise DataError("not enough bars for three splits")
        step = index[-1] - index[-2]
        end = index[-1] + step
        return cls(
            train=(index[0], index[i1]), validation=(index[i1], index[i2]), test=(index[i2], end),
            last={"train": index[i1 - 1], "validation": index[i2 - 1], "test": index[-1]},
        )

    def window(self, split: str) -> tuple[pd.Timestamp, pd.Timestamp]:
        if split == "development":
            return (self.train[0], self.validation[1])
        if split not in ("train", "validation", "test"):
            raise ValueError(f"unknown split {split!r}")
        return getattr(self, split)

    def to_report(self) -> dict:
        return {s: [self.window(s)[0].isoformat(), self.last[s].isoformat()] for s in ("train", "validation", "test")}


def params_key(params: dict) -> str:
    return json.dumps(params, sort_keys=True, default=str)


class Experiment:
    #: backtest function used for every run; spq.perp_research.PerpExperiment replaces it with the perp backtester
    _runner = staticmethod(run_backtest)

    def __init__(self, data: dict[str, pd.DataFrame], config: BacktestConfig, *, fractions=(0.6, 0.2, 0.2),
                 ledger: str | Path | None = None):
        index = check_aligned(data)
        self.config = config
        self.splits = Splits.chronological(index, fractions)
        self.symbols = list(data.keys())
        self.__full = data
        test_start = self.splits.test[0]
        self._dev = {s: df.loc[df.index < test_start] for s, df in data.items()}
        self.ledger_path = Path(ledger) if ledger else None
        self.trials: list[dict] = []
        self.test_evaluations: list[dict] = []
        self._cache: dict[tuple, BacktestResult] = {}
        self._sealed: dict[str, tuple[str, str]] = {}

    # ----------------------------------------------------------------------------------------------- selection side
    def dev_data(self) -> dict[str, pd.DataFrame]:
        """Train + validation bars only. This is all that selection code can obtain."""
        return dict(self._dev)

    def _check_open(self, strategy: Strategy):
        if strategy.name in self._sealed:
            raise TestSplitError(
                f"the test split was already evaluated for strategy {strategy.name!r}: selection is closed. "
                "Tuning after looking at the test split would turn it into a second validation split."
            )

    def trial(self, strategy: Strategy, params: dict | None = None) -> BacktestResult:
        """Run one configuration over the whole development range (train + validation) and record it as a trial."""
        self._check_open(strategy)
        p = strategy.params if params is None else dict(params)
        key = (strategy.sha256, params_key(p))
        if key not in self._cache:
            start, end = self.splits.window("development")
            res = self._runner(strategy, self._dev, self.config, start=start, end=end, params=p)
            self._cache[key] = res
            rec = {"kind": "trial", "strategy": strategy.name, "sha256": strategy.sha256, "params": p,
                   "symbols": self.symbols, "interval": self.config.interval}
            for split in ("train", "validation"):
                r = self.split_returns(res, split)
                rec[f"{split}_sharpe_per_bar"] = _finite(sharpe_ratio(r))
                rec[f"{split}_bars"] = int(len(r))
                rec[f"{split}_return"] = _finite(float(np.prod(1.0 + r) - 1.0))
            self.trials.append(rec)
            self._append_ledger(rec)
        return self._cache[key]

    def split_returns(self, result: BacktestResult, split: str) -> np.ndarray:
        """Bar returns of a development-range run restricted to `split` (train or validation)."""
        if split not in SELECTION_SPLITS:
            raise TestSplitError("only train, validation and development are available for selection")
        start, end = self.splits.window(split)
        r = result.returns
        return r[(r.index >= start) & (r.index < end)].to_numpy()

    def run(self, strategy: Strategy, split: str, params: dict | None = None) -> BacktestResult:
        """Stand-alone backtest of one split (starting from cash at the split start). Never the test split."""
        if split not in SELECTION_SPLITS:
            raise TestSplitError(
                f"split {split!r} is not available here: the test split can only be evaluated once, "
                "through Experiment.final_test()"
            )
        self._check_open(strategy)
        start, end = self.splits.window(split)
        return self._runner(strategy, self._dev, self.config, start=start, end=end, params=params)

    def run_window(self, strategy: Strategy, start, end, params: dict | None = None) -> BacktestResult:
        """Backtest an arbitrary window that lies entirely inside the development range (walk-forward folds)."""
        self._check_open(strategy)
        if pd.Timestamp(end) > self.splits.test[0]:
            raise TestSplitError("the requested window reaches into the test split")
        return self._runner(strategy, self._dev, self.config, start=start, end=end, params=params)

    def trial_sharpes(self, split: str = "validation", strategy_name: str | None = None) -> list[float]:
        return [t[f"{split}_sharpe_per_bar"] for t in self.trials
                if t.get(f"{split}_sharpe_per_bar") is not None
                and (strategy_name is None or t["strategy"] == strategy_name)]

    # ---------------------------------------------------------------------------------------------- reporting side
    def final_test(self, strategy: Strategy, params: dict | None = None) -> BacktestResult:
        """The single out-of-sample evaluation of a strategy. Seals the experiment for that strategy name."""
        p = strategy.params if params is None else dict(params)
        ident = (strategy.sha256, params_key(p))
        if strategy.name in self._sealed and self._sealed[strategy.name] != ident:
            raise TestSplitError(
                f"strategy {strategy.name!r} was already evaluated on the test split with another version or "
                "other parameters; a second look is parameter selection on the test split"
            )
        start, end = self.splits.window("test")
        res = self._runner(strategy, self.__full, self.config, start=start, end=end, params=p)
        if strategy.name not in self._sealed:
            self._sealed[strategy.name] = ident
            rec = {"kind": "test", "strategy": strategy.name, "sha256": strategy.sha256, "params": p,
                   "symbols": self.symbols, "interval": self.config.interval,
                   "window": [start.isoformat(), self.splits.last["test"].isoformat()]}
            self.test_evaluations.append(rec)
            self._append_ledger(rec)
        return res

    def benchmarks(self, split: str) -> dict[str, BacktestResult]:
        """Buy-and-hold (per symbol and equal-weight, never rebalanced) and rebalanced equal-weight on a split.

        Benchmarks have no parameters, so they may be computed on any split, including test.
        """
        start, end = self.splits.window(split)
        data = self.__full if split == "test" else self._dev
        out = {"buy_and_hold": buy_and_hold(data, self.config, start=start, end=end),
               "equal_weight": equal_weight(data, self.config, start=start, end=end)}
        if len(self.symbols) > 1:
            for s in self.symbols:
                out[f"buy_and_hold_{s}"] = buy_and_hold({s: data[s]}, self.config, start=start, end=end)
        return out

    def lookahead_data(self) -> dict[str, pd.DataFrame]:
        """Full data for the look-ahead check only (it compares a run with itself; nothing is selected)."""
        return dict(self.__full)

    # ------------------------------------------------------------------------------------------------------ ledger
    def _append_ledger(self, rec: dict):
        # v7 research jobs: when SPQ_JOB_LEDGER is set (by the job runner, outside the agent), EVERY trial and test
        # evaluation of every Experiment of the process is appended there, whatever `ledger=` the caller passed.
        # The runner copies the lines out of the agent's reach as they appear and counts them against the budget.
        job = os.environ.get(JOB_LEDGER_ENV)
        seen = set()
        for path in (self.ledger_path, Path(job) if job else None):
            if path is None or str(path.absolute()) in seen:
                continue
            seen.add(str(path.absolute()))
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as fh:
                fh.write(json.dumps(rec, default=str) + "\n")


def read_ledger(path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


# --- v7 research jobs ---------------------------------------------------------------------------------------------
MAX_SANE_SHARPE_PER_BAR = 1.0


def read_job_trials(path) -> dict:
    """Trials consumed by a research job, from the runner's copy of the job ledger. The file was written by an
    UNTRUSTED process: it is read defensively. Every non-empty line counts as one trial (a line is something the
    job did, so garbage can only raise the count); only finite validation Sharpe ratios of plausible size, on
    well-formed "trial" records, are kept as numbers."""
    out = {"count": 0, "sharpes": [], "unreadable": 0}
    path = Path(path)
    if not path.exists():
        return out
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        out["count"] += 1
        try:
            rec = json.loads(line)
        except (ValueError, TypeError):
            out["unreadable"] += 1
            continue
        if not isinstance(rec, dict) or rec.get("kind") not in ("trial", "test"):
            out["unreadable"] += 1
            continue
        v = rec.get("validation_sharpe_per_bar")
        if (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                and abs(v) <= MAX_SANE_SHARPE_PER_BAR):
            out["sharpes"].append(float(v))
    return out
# --- end v7 -------------------------------------------------------------------------------------------------------


def _finite(x):
    return float(x) if x is not None and math.isfinite(x) else None


# ------------------------------------------------------------------------------------------------------- grids

def one_at_a_time_grid(params: dict, factors=(0.5, 2.0)) -> list[dict]:
    """Default sensitivity grid: the base parameters, then each numeric parameter scaled by each factor in turn."""
    grid = [dict(params)]
    for k, v in params.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        for f in factors:
            nv = max(1, int(round(v * f))) if isinstance(v, int) else float(v * f)
            if nv != v:
                cand = {**params, k: nv}
                if cand not in grid:
                    grid.append(cand)
    return grid


def cartesian_grid(base: dict, axes: dict[str, list]) -> list[dict]:
    """Full grid over `axes` (parameter -> list of values), other parameters taken from `base`."""
    unknown = set(axes) - set(base)
    if unknown:
        raise ValueError(f"grid parameters not in META['params']: {sorted(unknown)}")
    keys = list(axes)
    grid = [dict(base)]
    for combo in itertools.product(*(axes[k] for k in keys)):
        cand = {**base, **dict(zip(keys, combo))}
        if cand not in grid:
            grid.append(cand)
    return grid
