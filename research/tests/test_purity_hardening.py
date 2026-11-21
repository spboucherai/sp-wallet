# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_purity_hardening.py
# Description      : v8: the static purity lint (spq.purity) against the
#                    evasion patterns of tests/evasions.py, and the policy
#                    itself.
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-11
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

"""v8: the static purity lint (spq.purity) against the evasion patterns of tests/evasions.py, and the policy itself.

The lint is not a security boundary (the OS sandbox is); these tests keep it honest as a lint: every pattern that
slipped through the pre-v8 deny-list is refused with a readable reason, the patterns marked `demo` are shown to be
real (they execute and obtain what they claim when run as plain Python), and ordinary numerical code still passes."""
from pathlib import Path

import pytest

from evasions import EVASIONS, HEADER
from spq.purity import ALLOWED_MODULES, MODULE_API, MODULE_NAMES, OPEN_MODULES, check
from spq.strategy import StrategyError, load_strategy, static_check

# rj_<job> directories are strategies installed by research jobs (on a deployed node, or — for a few seconds — by the API's
# research tests running at the same time in this checkout): not the library, exactly as in conftest.py.
LIBRARY = sorted(p for p in Path(__file__).resolve().parents[1].glob("strategies/*/*/strategy.py") if not p.parent.parent.name.startswith("rj_"))


@pytest.mark.parametrize("name", sorted(EVASIONS))
def test_every_known_evasion_is_refused(name):
    problems = static_check(HEADER + EVASIONS[name]["body"])
    assert problems, f"{name} ({EVASIONS[name]['reaches']}) passes the lint"
    assert all(p.startswith("line ") for p in problems)


@pytest.mark.parametrize("name", sorted(n for n, e in EVASIONS.items() if e["demo"]))
def test_demo_evasions_are_real(name):
    """Run as plain Python (no lint, no guard) the snippet really obtains something: the list is not imaginary."""
    g: dict = {}
    exec(compile(HEADER + EVASIONS[name]["body"], name, "exec"), g)  # noqa: S102 - the point of the test
    g["target_weights"]({}, {})
    if name != "warnings_sys_modules_posix":
        assert g["LEAK"]


def test_load_strategy_refuses_an_evasion_before_running_it(tmp_path):
    marker = tmp_path / "ran.txt"
    body = EVASIONS["from_typing_import_sys"]["body"].replace('LEAK = sys.modules["os"].getcwd()',
                                                              f'LEAK = sys.modules["os"].mkdir({str(marker)!r})')
    (tmp_path / "strategy.py").write_text(HEADER + body)
    with pytest.raises(StrategyError, match="purity check"):
        load_strategy(tmp_path)
    assert not marker.exists()  # nothing of the file was executed


def test_the_library_passes_unchanged():
    assert len(LIBRARY) >= 20
    for path in LIBRARY:
        assert static_check(path.read_text()) == [], path


ACCEPTED = '''
"""Docstring mentioning __init__ and eval() in prose is fine."""
from __future__ import annotations
import math
import numpy as np
import pandas as pd
from numpy.linalg import lstsq
from scipy import stats
from scipy.optimize import minimize
import statsmodels.api as sm
from arch import arch_model
from sklearn.linear_model import Ridge

META = {"name": "ok", "version": "1", "universe": ["ETH", "BTC"], "interval": "1h", "lookback": 50, "params": {"n": 20}}


def _z(x: np.ndarray, n: int) -> float:
    w = np.lib.stride_tricks.sliding_window_view(x, n)
    return float((x[-1] - w.mean(axis=1)[-1]) / (w.std(axis=1)[-1] + 1e-12))


def target_weights(data, params):
    n = int(params["n"])
    out = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        r = pd.Series(np.diff(np.log(close))).rolling(n).mean().iloc[-1]
        beta = lstsq(np.column_stack([np.ones(n), np.arange(n)]), close[-n:], rcond=None)[0][1]
        p = stats.norm.cdf(_z(close, n))
        fit = sm.OLS(close[-n:], sm.add_constant(np.arange(n))).fit()
        out[symbol] = 0.5 if (r > 0 and beta > 0 and p > 0.5 and math.isfinite(fit.params[1])) else 0.0
    label = f"{len(out)} symbols"
    return out if label else {}
'''


def test_ordinary_numerical_code_is_accepted():
    assert check(ACCEPTED) == []


@pytest.mark.parametrize("line, reason", [
    ("import os", "import of 'os'"),
    ("import numpy.random as r", "import of 'numpy.random'"),
    ("from numpy import ctypeslib", "numpy.ctypeslib is not in the reviewed API"),
    ("from scipy.stats import os", "is a module reached through scipy.stats"),
    ("from pandas import *", "import \\* is not allowed"),
    ("import numpy as np\nx = np", "may only be used as `np.name`"),
    ("import numpy as np\nla = np.linalg", "is a module: use one of its functions"),
    ("import numpy as np\nnp = 3", "cannot be reassigned"),
    ("import numpy as np\nx = np.random.default_rng(0)", "numpy.random is not in the reviewed API"),
    ("import pandas as pd\nx = pd.Timestamp.now()", "attribute .now is not allowed"),
    ("import pandas as pd\nx = pd.DataFrame().eval('a')", "attribute .eval is not allowed"),
    ("x = (1).__class__", "no dunder access"),
    ("x = [].append.__self__", "no dunder access"),
    ("x = {}._private", "private attributes"),
    ("x = type(3)", "use of 'type'"),
    ("x = getattr(3, 'real')", "use of 'getattr'"),
    ("x = __name__", "use of '__name__'"),
    ("class A:\n    pass", "class definitions"),
    ("import functools\n@functools.partial\ndef f():\n    pass", "decorators are not allowed"),
    ("def f(x: 'int'):\n    pass", "string annotations"),
    ("def f() -> 'int':\n    pass", "string annotations"),
    ("def __getattr__(name):\n    return 1", "a function named '__getattr__'"),
    ("x = 'a{}'.format(1)", "attribute .format"),
    ("x = {}['__builtins__']", "names a dunder"),
    ("def f():\n    global y", "global state"),
    ("async def f():\n    pass", "async code"),
])
def test_policy_refusals(line, reason):
    problems = check(line)
    assert problems and any(__import__("re").search(reason, p) for p in problems), problems


def test_policy_tables_are_consistent():
    assert not set(MODULE_API) & set(OPEN_MODULES)
    for module, names in MODULE_API.items():
        for n in names:  # a strict API never lists a private name
            assert not n.startswith("_"), (module, n)
    for module in ALLOWED_MODULES:  # every sub-module is reachable from its parent
        if "." in module:
            parent, leaf = module.rsplit(".", 1)
            assert leaf in (MODULE_API.get(parent) or OPEN_MODULES.get(parent) or set()), module
    assert {"os", "sys", "ctypes", "subprocess", "socket", "pickle", "importlib", "builtins"} <= MODULE_NAMES
