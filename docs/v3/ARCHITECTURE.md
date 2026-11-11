# SP Wallet V3 — trading agents: architecture and contracts

Real money, small amounts, one owner. The rule that shapes everything: **an agent can never sign with the owner's key and
can never exceed a mandate that the isolated signer enforces by itself.** Research (LLM, Python) proposes; an independent,
deterministic engine executes; the signer has the last word.

> **V5** widens agents to any registry asset with market data, on every execution-enabled EVM network, and adds
> universe-generic strategies: see `docs/v5/AGENTS-ANY-ASSET.md`. The notes marked V5 below are the points that changed.

## Trust zones
| Zone | Runs | Can do | Cannot do |
|---|---|---|---|
| Research | Claude Code + Python lab, on a research node | read market data, write strategy code, backtest, write reports | reach the signer, hold keys, place orders, change a mandate |
| Engine | deterministic worker inside the API service | load an **approved** strategy version, compute targets, build swap orders through the V2 router, ask the signer for a *delegated* signature | sign anything itself, change limits, use the owner's key |
| Signer | isolated Mac | hold one key **per agent vault** (separate HD account), store mandates the owner approved with a passkey, sign an order only if it fits the mandate | — |
| Owner | phone, passkey | create/fund agents, approve strategy versions and mandates, pause, revoke, withdraw | — |

## Agent vault and mandate (signer side)
- Vault = its own EVM address, derived at `m/44'/60'/<index>'/0/0`, index ≥ 1 (the owner's wallet is index 0). Funds move
  owner → vault by an ordinary passkey-approved transfer.
- Mandate (approved once with a passkey over its canonical hash, stored by the signer): vault index, network, allowed assets
  (registry ids), allowed swap provider/router, max input per order and per day for each asset, max orders per day, expiry,
  strategy code hash (audit), creation time.
- Delegated signature: only a V2 swap intent whose source **and recipient are the vault itself**, between allowed assets,
  on the pinned router, within the order/day caps, before expiry, while not halted or revoked. The signer applies the same
  calldata verification as for the owner (recipient, minimum output, exact amount/allowance).
- Returning funds: a transfer from a vault is only ever signed towards the owner's own address.
- Revocation and emergency halt need no passkey (stopping is always safe). Raising any limit needs a new passkey approval.
- V5: a mandate is for ONE network among those where swap execution is enabled; the checks are per network (chain id,
  fee ceiling of the policy for that network, router variant). A wrapped asset is priced as what it tracks: a depeg makes
  the signer refuse the order.
- **What this does not guarantee:** the signer cannot see prices. Inside its mandate an agent (or a compromised engine) can
  still trade badly; the worst case is the loss of the capital placed in that vault. A loss limit based on market value is
  enforced by the engine and can be overshot by a gap, an outage or missing liquidity.

## Strategy contract (Python, research side)
A strategy version is a directory `research/strategies/<name>/<version>/` with `strategy.py`; its identity is the SHA-256 of
that file.
```python
META = {"name": "eth_trend", "version": "1", "universe": ["ETH", "LINK"], "interval": "1h", "lookback": 720,
        "params": {"fast": 24, "slow": 168}}
def target_weights(data: dict[str, "pandas.DataFrame"], params: dict) -> dict[str, float]:
    """data[symbol]: OHLCV indexed by UTC bar-open time, containing only CLOSED bars, oldest first.
    Return the desired portfolio weight of each symbol, each in [0, 1], summing to at most 1. The rest is USDC.
    Long-only spot: there is no shorting and no leverage. Must be a pure function of its inputs (no network, no clock, no files)."""
```
- V5: `"universe": ["*"]` declares a universe-generic strategy: the symbols (1 to 12, optionally bounded by
  `META["min_symbols"]` / `META["max_symbols"]`) are the agent's, given by the engine with the candles and by `--symbols`
  to the backtest; weights are validated against that list.
- Decisions are taken on closed bars and executed at the next bar: the backtester fills at the next bar's open with costs.
- Signal runner (used by the engine): `uv run python -m spq.signal --strategy <dir> --sha256 <hash> --input <json>` prints one
  JSON object `{"strategy_sha256", "as_of", "weights": {symbol: number}}` and exits 0, or exits non-zero. The engine treats
  anything else (timeout, bad JSON, weights out of range, wrong hash) as "no signal: hold".

## Market data (engine side, TypeScript + PostgreSQL)
- Table `candles(source, symbol, interval, ts, open, high, low, close, volume)`, primary key `(source, symbol, interval, ts)`,
  `ts` = bar-open time UTC, only closed bars. Sources: public, keyless exchange REST APIs (at least two independent ones).
- Pipeline ingest → validate → normalise → store, with a quality record per (symbol, interval): last bar time, gaps,
  cross-source deviation. A consumer must be able to ask "is this series fresh and consistent right now?" and get a hard no.
- Symbols are spot pairs against USD (`BTC`, `ETH`, `SOL`, `LINK`, `AAVE`, …); the mapping to on-chain assets is the engine's job.
  V5: the mapping is `packages/core/src/market-symbols.ts`, and the symbol set is derived from the token registry.

## Backtest report (JSON, produced by the lab, stored by the API)
`{"strategy_sha256", "config": {"symbols", "interval", "start", "end", "fee_bps", "slippage_bps", "initial_cash"},
  "splits": {"train": [start, end], "validation": [...], "test": [...]},
  "metrics": {"<split>": {"total_return", "cagr", "volatility", "sharpe", "sortino", "max_drawdown", "calmar", "turnover",
              "trades", "win_rate", "profit_factor", "fees_paid", "exposure"}},
  "benchmarks": {"buy_and_hold": {...same metrics on the test split...}},
  "robustness": {"walk_forward": [...], "bootstrap_sharpe_ci": [lo, hi], "parameter_sensitivity": [...], "trials_tested": n,
                 "deflated_sharpe": x},
  "checks": {"lookahead": "pass|fail", "data_quality": "pass|fail", "notes": [...]},
  "equity_curve": [[ts, equity], ...]}`
A report never says a strategy is profitable; it reports what was measured, on which data, with which costs.

## Modes
RESEARCH → BACKTESTING → PAPER_TRADING → AWAITING_APPROVAL → LIVE (also PAUSED, STOPPED, FAILED). Paper trading uses live
market data and live V2 quotes but signs nothing. LIVE requires an approved strategy version **and** an active mandate.
