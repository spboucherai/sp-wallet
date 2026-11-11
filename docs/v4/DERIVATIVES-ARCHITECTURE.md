# SP Wallet Derivatives (V4) — architecture and contracts

Owner brief received 2026-11-10 ("SP Wallet Futures": Hyperliquid first, then dYdX, GMX; universal derivatives router; quant
agents; controlled live trading). This document is the contract that every module follows. It adapts the brief to the repository
as it is; it does not restate the brief.

## State of the repository this builds on (audit, 2026-11-10)

- pnpm monorepo, Node 26, TypeScript 7 (type stripping: no enums, no parameter properties), vitest, zod, viem, Fastify, postgres.js,
  Vite/React/Tailwind PWA. Packages: `packages/core` (networks, assets, intents, policy, swap verification, mandates),
  `packages/swap` (V2 router, quote providers), `services/api` (API + workers), `services/isolated-signer` (keys, passkey
  verification, policy; runs alone on node m6ma), `apps/web`, `research/` (Python lab `spq`: strategies, backtests, signals).
- Custody: one BIP-39 seed on the signer. The API never sees a key. Every owner signature is a passkey assertion over the SHA-256
  of a canonical intent, verified by the signer itself. Agent vaults (`m/44'/60'/<i>'/0/0`) sign only under a mandate that the
  signer stores and enforces (limits, expiry, revocation, own price check).
- V3 trading agents: spot, long-only, Base, KyberSwap. Engine in `services/api/src/agents/` (deterministic, no LLM in the loop).
- Market data: `services/api/src/market/` (candles from Coinbase/Bitstamp/Kraken, quality gate `assertFresh`).
- Audit log: hash-chained `audit_events`. One order/transfer in flight per network.

## Principles (all binding)

1. **Four modes per venue account**: `READ_ONLY` → `PAPER` → `MANUAL_LIVE` (passkey per order) → `MANDATE_LIVE` (signer-enforced
   mandate). A new account starts `READ_ONLY`. Live modes are off until the owner turns them on per venue, with a passkey.
2. **No LLM, and no code written by an agent, can reach the signer.** Chain: strategy → order proposal → risk policy engine
   (deterministic) → execution authorization → signer → venue adapter.
3. **The main wallet key never trades on a venue.** Each venue gets a dedicated *trading key* derived by the signer on its own
   path. On Hyperliquid this is an *API wallet* ("agent"): it can place and cancel orders but cannot withdraw. The owner
   authorizes it once (passkey) with the venue's own approval action signed by the main key, and can revoke it.
4. **Exact arithmetic.** Prices, sizes, margin, PnL, fees, funding: decimal strings end to end, computed with the `Dec` type
   (`packages/derivatives/src/decimal.ts`, bigint mantissa + scale). No `number` in any value that feeds a decision or an order.
   `number` is allowed for display and charts only.
5. **Venue state is the truth.** An HTTP answer is not proof of execution: every order ends by reconciliation against the
   venue's own order/fill/position state. Local values that are estimates carry `source: 'estimate'`; values read from the venue
   carry `source: 'venue'`. The UI shows which is which.
6. **Contracts are not interchangeable.** Two perpetuals on the same asset are compared field by field (collateral, settlement,
   mark-price method, funding interval, tick, lot); the router never assumes equivalence.
7. **Nothing is shown as working unless it works.** A venue adapter declares its capabilities; the UI only offers what is declared.
8. **No real order, deposit or withdrawal is sent to test the system.** Tests use recorded fixtures, simulators and the venues'
   testnets. Live features are enabled by the owner, not by the build.

## Modules

| Module (brief name) | Location | Role |
|---|---|---|
| sp-derivatives-core | `packages/derivatives/src/{decimal,models,venue}.ts` | exact decimals, normalized models, venue adapter contract |
| sp-margin-engine | `packages/derivatives/src/margin.ts` | margin, leverage, liquidation estimates (always labelled estimates) |
| risk policy engine | `packages/derivatives/src/risk.ts` | deterministic pre-trade checks; pure functions |
| venue adapters | `packages/derivatives/src/venues/<venue>/` | Hyperliquid, dYdX v4, GMX v2 |
| paper engine | `packages/derivatives/src/paper.ts` | simulated account filled against live order books |
| sp-market-data (perps) | `services/api/src/derivatives/data.ts` | books, trades, funding, OI, mark/index — on top of the adapters |
| sp-execution-engine | `services/api/src/derivatives/exec.ts` | proposals, idempotency, signer calls, reconciliation |
| router | `packages/derivatives/src/router.ts` | venue comparison (simulation first) |
| sp-quant-engine | `research/` (`spq`) | extended for perps: funding, leverage, liquidation in the backtester |
| sp-agent-runtime | `services/api/src/agents/` | existing engine, extended to derivative mandates |
| UI | `apps/web/src/screens/Futures.tsx` (+ components) | Trade → Futures terminal, mobile first |

`packages/derivatives` depends on `zod` and (for signing helpers) `viem`, `@noble/hashes`; it must not import from `services/*`.

## Core contract (TypeScript, authoritative)

```ts
// decimal.ts
export type DecStr = string;                       // canonical decimal: /^-?(0|[1-9]\d*)(\.\d+)?$/ , no exponent
export interface Dec { readonly m: bigint; readonly s: number }   // value = m / 10^s
export const D: {
  from(x: DecStr | bigint | Dec): Dec; str(x: Dec): DecStr;
  add(a: Dec, b: Dec): Dec; sub(a: Dec, b: Dec): Dec; mul(a: Dec, b: Dec): Dec;
  /** division rounds to `scale` decimals with the given mode; never silently */
  div(a: Dec, b: Dec, scale: number, mode: 'down' | 'up' | 'half_even'): Dec;
  cmp(a: Dec, b: Dec): -1 | 0 | 1; neg(a: Dec): Dec; abs(a: Dec): Dec; isZero(a: Dec): boolean;
  /** quantize to a tick/lot (a positive Dec), rounding down or up */
  quantize(a: Dec, step: Dec, mode: 'down' | 'up'): Dec;
  toNumber(a: Dec): number;                        // display only
};

// models.ts (all zod schemas, exported with their inferred types)
export type VenueId = 'hyperliquid' | 'dydx' | 'gmx';
export type Side = 'long' | 'short';               // position side;  order side is 'buy' | 'sell'
export interface Instrument {
  venue: VenueId; symbol: string;                  // venue's own symbol, e.g. 'BTC' on Hyperliquid, 'BTC-USD' on dYdX
  id: string;                                      // `${venue}:${symbol}`
  base: string; quote: string;                     // 'BTC', 'USD'
  kind: 'perpetual';
  collateral: string;                              // 'USDC'
  settlement: string;                              // how PnL settles, free text from the venue's docs
  tickSize: DecStr; lotSize: DecStr; minOrderSize: DecStr | null; minNotional: DecStr | null;
  maxLeverage: DecStr; marginModes: ('cross' | 'isolated')[];
  fundingIntervalSec: number; markPriceMethod: string;
  status: 'active' | 'reduce_only' | 'halted';
}
export interface Ticker { instrument: string; mark: DecStr; index: DecStr | null; mid: DecStr | null; funding: DecStr | null;  // per funding interval
  openInterest: DecStr | null; volume24h: DecStr | null; change24h: DecStr | null; ts: number }
export interface Book { instrument: string; bids: [DecStr, DecStr][]; asks: [DecStr, DecStr][]; ts: number }   // [price, size], best first
export interface PublicTrade { instrument: string; price: DecStr; size: DecStr; side: 'buy' | 'sell'; ts: number; id: string }
export interface Candle { ts: number; open: DecStr; high: DecStr; low: DecStr; close: DecStr; volume: DecStr }
export interface AccountState { venue: VenueId; account: string; equity: DecStr; collateral: DecStr; freeCollateral: DecStr;
  marginUsed: DecStr; maintenanceMargin: DecStr | null; withdrawable: DecStr | null; ts: number; source: 'venue' | 'paper' }
export interface Position { instrument: string; side: Side; size: DecStr; entryPrice: DecStr; markPrice: DecStr;
  liquidationPrice: DecStr | null; leverage: DecStr; marginMode: 'cross' | 'isolated'; margin: DecStr;
  unrealizedPnl: DecStr; realizedPnl: DecStr | null; fundingPaid: DecStr | null; source: 'venue' | 'paper' }
export interface OrderRequest {
  instrument: string; side: 'buy' | 'sell'; type: 'limit' | 'market' | 'stop_market' | 'stop_limit' | 'take_profit_market' | 'take_profit_limit';
  size: DecStr; price: DecStr | null;              // limit price; for market orders the worst acceptable price (slippage bound), required
  triggerPrice: DecStr | null; reduceOnly: boolean; tif: 'gtc' | 'ioc' | 'alo';   // alo = post only
  clientId: string;                                // idempotency key, unique per account; adapters map it to the venue's client order id
}
export interface Order extends OrderRequest { venueOrderId: string | null; status: 'pending' | 'open' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected' | 'triggered';
  filled: DecStr; avgFillPrice: DecStr | null; createdAt: number; updatedAt: number; rejectReason: string | null }
export interface Fill { instrument: string; orderId: string | null; clientId: string | null; side: 'buy' | 'sell'; price: DecStr; size: DecStr;
  fee: DecStr; feeAsset: string; closedPnl: DecStr | null; ts: number; id: string; liquidation: boolean }
export interface FundingPayment { instrument: string; amount: DecStr; rate: DecStr; size: DecStr; ts: number }

// venue.ts
export interface Capabilities { marketData: boolean; account: boolean; orders: boolean; orderTypes: OrderRequest['type'][];
  tif: OrderRequest['tif'][]; modify: boolean; leverage: boolean; marginModes: ('cross' | 'isolated')[]; subaccounts: boolean;
  testnet: boolean; stream: boolean; notes: string[] }
export interface VenueAdapter {
  readonly id: VenueId; readonly network: 'mainnet' | 'testnet'; readonly capabilities: Capabilities;
  instruments(): Promise<Instrument[]>;
  tickers(): Promise<Ticker[]>;
  book(symbol: string, depth?: number): Promise<Book>;
  trades(symbol: string, limit?: number): Promise<PublicTrade[]>;
  candles(symbol: string, interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d', o: { start?: number; end?: number; limit?: number }): Promise<Candle[]>;
  fundingHistory(symbol: string, o: { start: number; end?: number }): Promise<{ ts: number; rate: DecStr; premium: DecStr | null }[]>;
  // account (read): `account` is the venue's account identifier (an EVM address on Hyperliquid/GMX, a dydx1… address + subaccount on dYdX)
  account(account: string): Promise<AccountState>;
  positions(account: string): Promise<Position[]>;
  openOrders(account: string): Promise<Order[]>;
  orderHistory(account: string, o?: { limit?: number }): Promise<Order[]>;
  fills(account: string, o?: { start?: number; limit?: number }): Promise<Fill[]>;
  funding(account: string, o?: { start?: number }): Promise<FundingPayment[]>;
  /** subscribe to live data; returns an unsubscribe function. Reconnects by itself and reports gaps through onStatus. */
  stream?(sub: { type: 'book' | 'trades' | 'ticker'; symbol: string } | { type: 'account'; account: string },
    on: (ev: unknown) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void): () => void;
  // trading: adapters BUILD and VERIFY actions; they never hold a key. Signing is injected.
  trading?: VenueTrading;
}
export interface SignRequest { venue: VenueId; network: 'mainnet' | 'testnet'; kind: string; payload: unknown }  // typed per venue
export interface VenueTrading {
  /** canonical, venue-ready action for an order + the exact bytes/typed data to sign; pure, no network */
  buildOrder(req: OrderRequest, ctx: { instrument: Instrument; nonce: number }): { action: unknown; sign: SignRequest };
  buildCancel(o: { instrument: Instrument; venueOrderId?: string; clientId?: string; nonce: number }): { action: unknown; sign: SignRequest };
  /** independent re-derivation used by the signer: what does this signed payload do? throws if it is not exactly an order/cancel */
  describe(sign: SignRequest): { kind: 'order' | 'cancel' | 'leverage' | 'approve_agent' | 'other'; orders?: OrderRequest[]; detail: Record<string, unknown> };
  submit(action: unknown, signature: unknown, nonce: number): Promise<{ accepted: boolean; venueOrderIds: string[]; error: string | null; raw: unknown }>;
}
```

Errors: adapters throw `VenueError` (`code: 'rate_limited' | 'unavailable' | 'bad_answer' | 'rejected' | 'unsupported' | 'stale'`).
Every HTTP answer is validated with zod before use; unknown fields are tolerated, missing or mistyped ones are `bad_answer`.
HTTP goes through an injectable `fetch` so tests replay recorded fixtures (`packages/derivatives/test/fixtures/<venue>/`).

## Risk policy engine (pure)

`checkOrder(policy, req, ctx) → { ok: true } | { ok: false; code; reason }` with `ctx = { instrument, account, positions,
openOrders, book, ticker, now, usage }`. Checks, in order: mode allows trading; instrument allowed and active; data age
(`ticker.ts`, `book.ts` ≤ `maxDataAgeMs`); price sanity (limit/worst price within `maxDeviationBps` of mark; mark vs index within
`maxMarkIndexBps`); tick/lot/min size; leverage after the order ≤ `maxLeverage`; notional per order ≤ `maxOrderNotional`;
resulting gross exposure ≤ `maxGrossExposure`; resulting position per instrument ≤ `maxPositionNotional`; free collateral after
initial margin ≥ `minFreeCollateral`; estimated liquidation distance ≥ `minLiquidationDistanceBps`; daily loss
(`usage.realizedToday + unrealized`) above `-maxDailyLoss`; total loss above `-maxTotalLoss`; order rate
(`usage.ordersLastMinute`, `usage.ordersToday`); duplicate `clientId`; `reduceOnly` orders that reduce are exempt from exposure
and loss limits (closing must always be possible). Circuit breakers (`halt` reasons) are inputs, not side effects.

## Signing (isolated signer)

New signer endpoints, same HMAC channel: `POST /venue/key` (derive and return the trading address for a venue; path
`m/44'/60'/9000'/<venueIndex>/<i>`; hyperliquid = 0), `POST /venue/authorize` (owner passkey over a canonical authorization
intent: venue, network, trading address, limits, expiry — on Hyperliquid this also returns the main-key signature of the
`approveAgent` action), `POST /venue/sign` (sign one venue action with the trading key: the signer runs `describe` itself and
applies the stored venue policy: `MANUAL_LIVE` needs a passkey assertion over the order hash; `MANDATE_LIVE` needs an active
derivative mandate), `POST /venue/revoke`. The signer refuses any payload whose `describe` is `other`.

Testnet and mainnet use different trading keys (`<i>` = 0 mainnet, 1 testnet) and different stored authorizations.

## Data model (PostgreSQL, created in `services/api/src/db.ts`)

`deriv_instruments`, `deriv_accounts` (venue, network, account, trading_address, mode, policy jsonb, authorized_at, revoked_at),
`deriv_orders` (client_id unique per account, request jsonb, state, venue_order_id, proposal hash, signatures, timestamps),
`deriv_fills`, `deriv_positions_snap`, `deriv_funding`, `deriv_risk_events`, `deriv_paper_accounts`, `deriv_paper_positions`,
`deriv_mandates`. All amounts `numeric`/text decimals. Order state machine:
`proposed → risk_checked → authorized → signed → submitted → open|filled|partially_filled|cancelled|rejected`, plus
`unknown` (submitted without a confirmed venue state — resolved only by reconciliation, never by assumption).

## Delivery

1. Foundation: decimal, models, venue contract, margin engine, risk engine, paper engine (property tests).
2. Hyperliquid: market data, account read, stream, action signing (verified against the official SDK's vectors), testnet orders.
3. dYdX v4 and GMX v2: read side first; trading only when its signing model is implemented and verified.
4. API + database + execution engine + signer endpoints; UI terminal (read-only and paper first).
5. Router (comparison in simulation). 6. `spq` perps backtesting. 7. Agents on derivatives. 8. Controlled live. 9. Hardening.

Live trading stays off until the owner enables it per venue.

## API contract (wave 2: read-only and paper) — `services/api/src/derivatives/`

All routes are behind the existing owner session (like every `/api/v1/*` route). Decimals are strings. Every object that carries
venue data has `source: 'venue' | 'paper' | 'estimate'` and a `ts`.

Venues served: `hyperliquid` (mainnet, read + paper), `gmx` (Arbitrum, read; no order book), `dydx` (mainnet **market data only**:
its terms exclude Canada and its indexer geoblocks account reads from the owner's network — no account, no paper account that
could be mistaken for a tradable venue, and the UI says why).

| Route | Answer |
|---|---|
| `GET /api/v1/derivatives/venues` | `{ venues: [{ id, name, network, capabilities, status: 'ok'|'degraded'|'down', lastOkAt, restriction: string|null }] }` |
| `GET /api/v1/derivatives/instruments?venue=` | `{ instruments: Instrument[] }` (active first; cached 10 min) |
| `GET /api/v1/derivatives/tickers?venue=` | `{ tickers: Ticker[], ts }` (cached ≤ 3 s) |
| `GET /api/v1/derivatives/market?instrument=<venue:symbol>` | `{ instrument, ticker, book: Book|null, liquidity: object|null (GMX), trades: PublicTrade[] }` |
| `GET /api/v1/derivatives/candles?instrument=&interval=&limit=` | `{ candles: Candle[] }` |
| `GET /api/v1/derivatives/funding?instrument=&hours=` | `{ history: [{ ts, rate }], intervalSec }` |
| `GET /api/v1/derivatives/stream?instrument=` | Server-Sent Events: `ticker`, `book`, `trades`, `status` (`connected|reconnecting|stale`); one upstream subscription shared by all listeners, closed when the last one leaves |
| `GET /api/v1/derivatives/compare?base=BTC` | `{ rows: [{ venue, instrument, mark, index, funding (per hour, normalised, with the venue's own interval stated), spreadBps|null, depthUsd1pct|null, takerFeeBps, maxLeverage, collateral, settlement, notes[] }] }` — a table, never a recommendation |
| `GET /api/v1/derivatives/accounts` | `{ accounts: [{ id, venue, network, kind: 'paper'|'venue', mode, label, policy, state: AccountState, positions: Position[], openOrders: Order[] }] }` |
| `POST /api/v1/derivatives/accounts` | body `{ venue, label, collateral: DecStr, policy?: Partial<RiskPolicy> }` → creates a **paper** account (`mode: 'PAPER'`) |
| `GET /api/v1/derivatives/accounts/:id` | account + positions + open orders + last 100 orders, fills, funding, risk events, equity history |
| `POST /api/v1/derivatives/accounts/:id/policy` | replaces the risk policy (paper accounts only in this wave) |
| `POST /api/v1/derivatives/accounts/:id/orders/preview` | body `OrderRequest` without `clientId` + optional `leverage` → `{ risk: RiskResult, estimate: { notional, initialMargin, fee, avgFillPrice, slippageBps, liquidationPrice: Estimate|null, freeCollateralAfter } }` — nothing is placed |
| `POST /api/v1/derivatives/accounts/:id/orders` | header `Idempotency-Key`; body as preview → runs the risk engine, then the paper engine against the live book → `{ order, fills }`; refusals are `422` with the risk `code` |
| `POST /api/v1/derivatives/accounts/:id/orders/:clientId/cancel` | `{ order }` |
| `POST /api/v1/derivatives/accounts/:id/close` | body `{ instrument, fraction: DecStr (0–1] }` → a reduce-only market order |
| `POST /api/v1/derivatives/accounts/:id/reset` | paper only: wipes positions and orders, restores collateral |
| `GET /api/v1/derivatives/watch?account=<address>&venue=` | read-only view of any public address on a venue (`AccountState`, positions, open orders) — for looking at one's own venue account before any trading key exists |

Paper accounts are driven by a worker: every few seconds, for each instrument with a paper position or resting order, feed the
latest book and ticker to the paper engine (`onBook`, `onTicker`), apply funding at the venue's funding times with the venue's
published rate, snapshot equity every minute, write `deriv_risk_events` (liquidation, margin warning at 80 % of maintenance,
loss-limit breach → `policy.halt`). State is persisted after every change (`deriv_paper_accounts.state jsonb`) so a restart
continues exactly. Live trading routes do not exist in this wave.

## Controlled live (delivery 8, Hyperliquid) — as built

Live trading exists for Hyperliquid perpetuals in `MANUAL_LIVE` only, and ships disabled. Details: `docs/v4/venues/hyperliquid.md`
(sections 13 and 14) and, for the routes, `docs/v4/API-LIVE-NOTES.md`. Differences from the text above, all deliberate:

- Signer endpoints `POST /venue/key | /venue/authorize | /venue/sign | /venue/revoke` (`services/isolated-signer/src/venue.ts`). The
  authorization commits to more than "venue, network, trading address, limits, expiry": also the account, the agent name, the mode,
  the nonce of the one `approveAgent` it lets the wallet key sign, and the SHA-256 of the jurisdiction acknowledgement shown to the owner.
- `MANDATE_LIVE` is not implemented: the signer refuses it by name. `deriv_mandates` does not exist.
- Venue accounts are in `deriv_accounts`. Their orders, fills, funding, risk events and equity share the paper tables
  (`deriv_orders`, `deriv_fills`, `deriv_funding`, `deriv_risk_events`, `deriv_equity`), keyed by the account id; for that the
  foreign keys of those tables to `deriv_paper_accounts` were dropped. `deriv_orders` gained the live columns (`state`, `final`,
  `cloid`, `request`, `order_hash`, `nonce`, `expires_at`, `action`, `sign_request`, `signature`, `venue_answer`, `submitted_at`);
  paper rows leave them null. Signed actions that are not orders (cancels, leverage) are in `deriv_actions`.
  `deriv_instruments` and `deriv_positions_snap` still do not exist (instruments and positions are read from the venue).
- Order states as specified, with two precisions: a proposal that expires or is withdrawn before approval ends `cancelled`
  (nothing was signed); an order the venue never received ends `rejected` with the reason `never placed`.
- The live engine has its own venue objects (`live-venue.ts`), bound to the asset table pinned in `@spw/derivatives/live`; the
  read-only registry used by market data and paper trading still exposes no trading object.
- Mainnet: three locks — the adapter's `allowMainnetExchange`, set only from the server setting `SPW_DERIV_LIVE_MAINNET=on`
  (default off), and an authorized account.

## Derivative mandate (`MANDATE_LIVE`, V6, Hyperliquid) — as built

Full description: `docs/v6/DERIVATIVE-MANDATE.md`. Differences from the text above ("Signing", "Controlled live"), all deliberate:

- A mandate is **not** a mode of the authorization: the authorization stays `MANUAL_LIVE` (the signer still refuses an
  authorization whose mode is `MANDATE_LIVE`), and a separate canonical object (`SPW-VENUE-MANDATE-v1`), approved with one
  passkey assertion, extends it. An account holds both: `mode: "MANUAL_LIVE"`, `modes: ["MANUAL_LIVE", "MANDATE_LIVE"]`.
- Signer endpoints `POST /venue/mandate/approve | /venue/mandate/sign | /venue/mandate/revoke`
  (`services/isolated-signer/src/venue-mandate.ts`); `/status` lists `venueMandates`. `/venue/sign` is unchanged.
- The signer now enforces position and gross-exposure limits itself, from its own read of the venue's public info endpoint
  (`venue-read.ts` — the signer's second kind of outbound request, after exchange prices) and its own prices; it fails
  closed when it cannot read. `deriv_mandates` exists.
- Revoking or letting a mandate expire stops new exposure at once and leaves 24 h in which cancels and reduce-only orders
  are still signed; revoking the authorization stops everything.
- Mainnet: a fourth lock for autonomous trading, the server setting `SPW_DERIV_MANDATE_MAINNET=on` (default off), on top of
  `SPW_DERIV_LIVE_MAINNET=on`.
- The agent runtime reaches live trading through `services/api/src/derivatives/mandate.ts` only; no HTTP route places a
  mandate order.
