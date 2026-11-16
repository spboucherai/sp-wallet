# risk_supervisor — a deterministic portfolio-level policy that only PROPOSES

Not a trading strategy. `spq.risk_supervisor.propose(positions, equity_curve, limits)` is a pure function: given
the positions of an account (or of several agents taken together), the equity history and limits, it returns a list
of proposed REDUCTIONS with the rule and the numbers behind each one. It never opens or increases a position and
never sends anything; whether a proposal is acted on belongs to the owner or to the engine. Tests:
`tests/test_v11_tools.py` (every rule, determinism, refusal of malformed inputs, and the lab's purity lint on the
module's own source: no import, no clock, no file, no randomness).

**Hypothesis.** The audit found no portfolio-level risk view (`docs/TRADING-AGENTS-AUDIT.md` section 2.3: "Risk
management as an agent: missing" — limits live inside each engine, per agent). A small, explainable policy over the
aggregate book catches what per-agent limits cannot: several agents long the same asset, a drawdown of the whole
book, a position close to its liquidation price, a position that bleeds funding.

**Signal.** Rules applied in this order; each can only LOWER the allowed notional of a position, the lowest wins,
every reason is kept:

| # | Rule | Condition | Proposal |
|---|---|---|---|
| 1 | drawdown de-leverage | `1 - equity / running peak >= drawdown_hard` | every position to 0 |
| | | `>= drawdown_soft` | every position x `drawdown_soft_scale` |
| 2 | gross leverage | `sum |notional| / equity > max_gross_leverage` | all positions scaled pro rata |
| 3 | concentration | `|notional| / equity > max_position_share` | that position to the cap |
| 4 | liquidation distance | `|mark - liquidation price| / mark < min_liquidation_distance` | that position x `(1 - liquidation_cut)` |
| 5 | funding bleed | the position PAYS more than `max_funding_bleed_apr` of its notional a year (a long pays a positive rate, a short a negative one) | that position x `(1 - funding_cut)` |

**Parameters.** Defaults (`DEFAULT_LIMITS`): `drawdown_soft` 0.05, `drawdown_hard` 0.10, `drawdown_soft_scale`
0.5, `max_gross_leverage` 1.5, `max_position_share` 1.0, `min_liquidation_distance` 0.10, `liquidation_cut` 0.5,
`max_funding_bleed_apr` 0.30, `funding_cut` 0.5, `min_reduction_usd` 1.0 (smaller reductions are not proposed).
The gross and position caps are the perp engine's own defaults (`research/src/spq/params/engine-parity.json`); the
drawdown levels sit at half of and at the engine's total loss limit.

**Costs assumed.** None: it proposes, it does not trade. A reduction it proposes would cost a taker fee and a spread.

**Result.** No backtest and no performance claim: the policy has no return of its own. What is verified is its
behaviour (4 tests): it is deterministic, it only reduces, it never reverses a sign, it refuses
NaN / duplicate / missing inputs instead of guessing, and it says nothing when nothing is to be done.

**Failure modes.** It sees only what it is given: stale positions or marks give stale proposals. It does not
recompute a venue's margin (rule 4 cuts by a fixed fraction). Rules are thresholds, not a model: no correlation, no
VaR, no forecast. De-leveraging in a drawdown locks the loss in (that is its purpose) and will also cut a book that
was about to recover. It is not wired to anything: an agent, a route and a mandate field that could act on a
proposal do not exist (`docs/v11/work/quant-lab.md`, TypeScript follow-ups).
