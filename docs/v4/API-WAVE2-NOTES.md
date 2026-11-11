# Derivatives API, wave 2 — what the backend really answers (for the UI)

The backend (`services/api/src/derivatives/`) follows the table in `DERIVATIVES-ARCHITECTURE.md`; differences are additive unless
stated. Source of truth for exact shapes: `services/api/src/derivatives/routes.ts` and `services/api/test/derivatives-*.test.ts`.

- Most answers add `ts`, `source`, and `errors` where several venues are read.
- `/venues` rows add `lastError`, `paper` (can a paper account exist there), `orderBook`; the answer adds `bounds` (cache ages), `ts`.
- `/instruments`, `/tickers`: `venue` optional; without it all venues are read, a failing venue goes to `errors: [{ venue, message }]`; 503 only if all fail.
- `/market` adds `errors: { book?, trades?, liquidity? }`; the ticker is mandatory (503 without it); book capped at 20 levels per side.
- `/candles`, `/funding` add `instrument` (and `interval`); `hours` ≤ 480, `limit` ≤ 1000.
- `/compare` → `{ base, rows, errors, ts }`; row: `funding` is a decimal string per hour (what longs pay; negative = longs receive),
  `fundingVenue: { rate, intervalSec }`, `depthBidUsd1pct`, `depthAskUsd1pct` (`depthUsd1pct` = sum, may be a lower bound, see `notes`),
  `restriction`, `ts`, `source`.
- Order / preview body: `price`, `triggerPrice`, `reduceOnly`, `tif` default to `null`, `null`, `false`, `'gtc'`; optional `slippageBps`
  (1–500) lets a `market` order with `price: null` derive its worst price from the book; a `clientId` in the body is a 400 (strict).
- Preview → `{ risk, estimate, request, ts }`; `estimate` also has `filledSize`, `restingSize`, `status`, `rejectReason`, `leverage`,
  `price`, `source: 'estimate'`; `liquidationPrice` is `{ value: DecStr|null, source: 'estimate', method }` or `null`.
- Order → `{ order, fills, idempotent }`. **A paper-engine rejection is a 200 with `order.status: 'rejected'` and `rejectReason`**
  (post-only would cross, insufficient collateral at fill…). Only risk-engine refusals are 422 `{ error: <risk code>, message }`.
- `/close` body: optional `slippageBps` (default 50); answer `{ order, fills, idempotent, worstPrice, slippageBoundBps }`.
- Account objects add `initialCollateral`, `settings` (leverage, fees, maintenance fraction), `totals`, `createdAt`, `updatedAt`.
- `/accounts/:id` adds `riskEvents: [{ id, ts, kind, code, message, data }]`, `equity: [{ ts, equity, collateral, marginUsed, unrealizedPnl, source }]`.
- `/policy` takes a complete `RiskPolicy` (strict) and answers the account detail. Lifting a halt = policy with `halt: null`.
- `/watch` → `{ venue, account, state, positions, openOrders, ts, source: 'venue' }`.
- Stream: events `status` `{ status, ts }` (first event, initially `reconnecting`), `ticker`, `book`, `trades` `{ instrument, trades, source }`,
  `error` `{ message, ts }`; GMX is polled every 3 s (ticker only); keep-alive comment every 15 s.
- **Paper accounts exist only on Hyperliquid** (`paper_unsupported` 422 on GMX; dYdX 403 `venue_restricted` with the restriction text).
- Hyperliquid's 5-significant-figure price rule is enforced: `price_not_on_tick` even when the price is a multiple of `tickSize`.
- `Idempotency-Key`: 8–100 chars of `[A-Za-z0-9._:-]`.
- Error codes: 400 `bad_request|idempotency|bad_instrument|bad_account|bad_policy`; 403 `venue_restricted`; 404 `unknown_venue|unknown_instrument|unknown_account|unknown_order`;
  422 any risk code + `leverage_exceeded|price_not_on_tick|no_position|below_min_size|instrument_mismatch|paper_unsupported|live_not_available|too_many_accounts|venue_no_account|venue_rejected`;
  429 `too_many_streams` (24 SSE connections); 503 `venue_unavailable|venue_rate_limited|stale_data|no_liquidity`.
- Default paper policy for collateral C: BTC and ETH only (`allowedInstruments` must be edited for others), max leverage 3,
  order notional ≤ C, gross exposure ≤ 3C, position ≤ 2C, free collateral ≥ 0.1C, daily loss 0.05C, total loss 0.2C.
- Risk event kinds: `order_refused`, `margin_warning`, `liquidation`, `loss_limit`, `funding_skipped`, `reset`.
- Paper simplifications to state in the UI: flat 2 % maintenance fraction, cross margin only, liquidation price is a single-position estimate.
