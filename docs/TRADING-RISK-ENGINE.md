# Trading risk engine — operator view

How the owner runs the risk engine of the wallet. The model and the full check list are in
`V11-RISK-MODEL.md`; this page is about what to set, what to press and what to expect.

## What it is

Every order — the owner's, an agent's, an API key's; paper or live; on any venue — is judged by one engine
before any approval prompt or signature. It runs in the API service. It sees all the accounts of one book at
once: paper, live mainnet (Hyperliquid and GMX) or live testnet. The books are never mixed.

The screen is **Settings → Risk** (also reachable from Monitoring). The routes are under `/api/v1/risk` and
need the owner's session. An API key cannot reach them.

## Before the first live order

On a live book the engine has defaults for data quality and order rates only. Every limit on capital is
absent, and an absent limit denies. **Until the limits below are set, every new live order is refused**, with
the list of missing limits. This also applies to live orders placed from the Futures screen and by perp
agents that were live before this version. Cancels and strictly reducing orders are not concerned.

Limits to set (Risk → Limits → Live):

| Limit | Meaning |
|---|---|
| `allowedVenues`, `allowedInstruments` | where orders may go |
| `maxOrderNotional`, `maxDailyNotional` | one order; all orders of the day |
| `maxPositionNotional` | resulting position, per instrument (`per`) or `default` |
| `maxOrderLeverage`, `maxAccountLeverage` | the venue's leverage setting; gross exposure over total equity |
| `maxGrossExposure`, `maxNetExposure` | all venues of the book |
| `maxAssetExposure` | net exposure to one asset across venues (`per` asset, `default`) |
| `maxVenueExposure`, `maxVenueCollateralShareBps` | exposure and share of the equity on one venue |
| `maxDailyLoss`, `maxTotalLoss`, `maxDrawdownBps` | loss limits; reaching one denies new risk |

Example (stored set):

```json
{
  "allowedVenues": ["hyperliquid"], "allowedInstruments": ["hyperliquid:BTC", "hyperliquid:ETH"],
  "maxOrderNotional": "1000", "maxDailyNotional": "10000",
  "maxPositionNotional": { "per": {}, "default": "2000" },
  "maxOrderLeverage": "3", "maxAccountLeverage": "2",
  "maxGrossExposure": "4000", "maxNetExposure": "4000",
  "maxAssetExposure": { "per": {}, "default": "3000" }, "maxVenueExposure": { "per": {}, "default": "4000" },
  "maxVenueCollateralShareBps": "10000",
  "maxDailyLoss": "100", "maxTotalLoss": "400", "maxDrawdownBps": "2000"
}
```

Tightening a limit is immediate. Loosening one — setting a limit that was absent counts — asks for the
passkey: the screen shows which limits become looser, and the passkey signs the whole new set.

Paper has a complete default set. Its limits can be changed the same way.

## The kill switch

- **What it does.** No new risk, for anybody, on any venue, in any mode. Cancels pass. Orders that strictly
  reduce a position pass. It cancels nothing and closes nothing by itself.
- **Engage.** Risk → Global kill switch → Engage. No passkey. An API key with `positions:manage` can engage it
  (`POST /api/v1/trading/risk/kill-switch`, or the command `KILL`).
- **Automatic.** When the live mainnet book reaches `maxTotalLoss` or `maxDrawdownBps`, the supervisor
  engages it. This can be changed under `risk.auto`; switching an automatic stop off needs the passkey.
- **Release.** Risk → Release with the passkey. Nothing else releases it: not a key, not a restart.
- **What you are told.** An alert ("Global kill switch engaged"), the webhook `risk.kill_switch` and an audit
  event.

It is not the signer's emergency halt (Security screen). The halt stops the signer from signing and is lifted
on the signer machine. Use the halt when the API itself may be compromised: the kill switch is enforced by the
API.

## Read-only mode

Only cancels pass: no order at all, not even a reduction. Engage it from the Risk screen; release it with the
passkey. Use it when nothing should change on the accounts.

## Reading a refusal

A refused order says which check failed, what was observed and what the limit was:

- in the answer of the API: `risk_denied` with `data.failed` and `data.checks`; `kill_switch_active`;
  `read_only_mode`;
- in Risk → Last decisions, for every principal;
- in the table `risk_decisions`, with the limit set and a summary of the context.

Frequent ones:

| Check | Usual cause |
|---|---|
| any check with "no limit is configured" | the live limit was never set |
| `context_complete` | a venue account of the book could not be read: exposure is not known, so no new risk |
| `price_freshness`, `price_consistency` | the venue's data is old, or its mark and the other sources disagree |
| `signer_status` | the signer is unreachable or halted |
| `liquidation_distance`, `account_leverage` | the order is too large for the collateral |

With stale prices the way out is a reduce-only **limit** order: it carries its own price bound and is exempt
from the price checks.

## Server settings

| Variable | Default | Effect |
|---|---|---|
| `SPW_TRADING_API_EXECUTION` | off | `on`: live orders can be placed through the trading API. Off: 403 `execution_disabled` for new live risk; paper works; cancels and reductions pass |
| `SPW_DERIV_LIVE_MAINNET` | off | unchanged |
| `SPW_DERIV_MANDATE_MAINNET` | off | unchanged |
| `SPW_DERIV_GMX_LIVE` | off | unchanged |
| `SPW_WORKERS` | on | the `orders` loop (reconciler, mandate supervisor, automatic stops) runs only with workers on |

The Risk screen shows the state of the four locks.

## Limits of the engine

- It is enforced by the API. If the API process is compromised, what still holds is what the signer enforces:
  the passkey per manual order, the derivative mandate, the GMX policy.
- It does not count resting orders in exposure.
- A second account on the same venue is judged per account for the per-venue limits.
- GMX has no order book: the two book checks are marked not applicable there.
