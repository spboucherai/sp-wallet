# V11 Phase A audit — derivatives, order execution, signer authorization, mandates, risk controls

Scope: `packages/derivatives`, `services/api/src/derivatives`, `services/isolated-signer`, `packages/core/src/{intent,policy,mandate,audit,state}.ts`,
`services/api/src/{server,auth,signer-client,config,capabilities,db}.ts`, and the docs that describe them. Branch `v11` (= production commit `a118e3e`).
Date of the audit: 2026-11-15.

Method: static reading of the source. No test, build, order, transaction or production access. The only network calls were read-only
public market-data requests listed in section 1.5. Every statement below carries a `file:line` reference; where a behaviour was deduced
from the code but not exercised, it says "read, not run". Where it could not be confirmed, it says "not verified".

Paths are relative to the repository root. Abbreviations: HL = Hyperliquid; `exec.ts` = `services/api/src/derivatives/exec.ts`;
`gmx-exec.ts` = `services/api/src/derivatives/gmx-exec.ts`; `signer/` = `services/isolated-signer/src/`; `live/` = `packages/derivatives/src/live/`.

---

## 1. What is really connected, per venue

### 1.1 Summary table

| Capability | Hyperliquid | GMX v2 (Arbitrum) | dYdX v4 |
|---|---|---|---|
| Market data (instruments, tickers, book, trades, candles, funding) | real, mainnet + testnet (`packages/derivatives/src/venues/hyperliquid/adapter.ts:69-73`) | real, mainnet only, no order book (`venues/gmx/adapter.ts:30-32`; `services/api/src/derivatives/venues.ts:141-151`) | real, mainnet; **market data only** (`venues/dydx/adapter.ts:22-24`; restriction `venues.ts:35`, `:169`) |
| Websocket stream | public book/trades/ticker used; account stream exists in the adapter but is refused by the registry (`venues.ts:54-60`) and unused by the live engine (it polls every 10 s, `exec.ts:32`) | none (`venues/gmx/adapter.ts:32` `stream: false`) | public only |
| Account read (state, positions, open orders) | real (`exec.ts:220-226`, `live-venue.ts:82-101`) | real, two sources: on-chain `Reader` (`gmx-chain.ts:133-145`) and GMX's API as a cross-check (`gmx-exec.ts:178-184`) | adapter implements it, registry refuses it with 403 `venue_restricted` (`venues.ts:42-53`) |
| Order build | real: `createHlTrading().buildOrder / buildCancel / buildUpdateLeverage / buildApproveAgent` (`venues/hyperliquid/trading.ts:271-299`) | real: `buildGmxTxs` (`live/gmx.ts:362-383`) — the signer builds the transaction itself | none (`orders: false`) |
| Signing | real: trading key signs EIP-712 "phantom agent" digest (`signer/venue.ts:213-214`, `signer/venue-mandate.ts:270-271`) | real: main wallet key signs an EIP-1559 transaction (`signer/signer.ts:448-457`) | none |
| Submission | real: `POST /exchange` (`trading.ts:313-346`) | real: `eth_sendRawTransaction` to every registry RPC (`gmx-chain.ts:160-164`), after simulation (`gmx-exec.ts:555-579`) | none |
| Cancel | real: `cancel` by oid and `cancelByCloid` (`trading.ts:275-283`); no passkey (`signer/venue.ts:152-157`) | real but restricted: `cancelOrder(key)` only 300 s after creation or when frozen (`gmx-exec.ts:494-509`); **needs a passkey** (it is a wallet transaction through `Signer.sign`) | none |
| Close position | real: reduce-only IOC limit at a slippage-bounded worst price (`exec.ts:839-856`); passkey in manual mode | real: `MarketDecrease` (`gmx-exec.ts:481-491`); passkey | none |
| Order types | limit, market (= IOC limit at worst price), stop_market, stop_limit, take_profit_market, take_profit_limit (`trading.ts:165-185`; canonical list `live/canonical.ts:121`) | **MarketIncrease and MarketDecrease only** (`live/gmx.ts:239`, `:322`, `:326`; `core/src/intent.ts:82`). No limit, no stop-loss, no take-profit: `triggerPrice` must be 0 (`live/gmx.ts:297`) | none |
| TP / SL | built and signable as trigger orders, **but** the signer requires the trigger price within `maxPriceDeviationBps` of its own spot mid (`signer/venue.ts:184-186`, `signer/venue-mandate.ts:218-220`) — see finding B-07. No grouped TP/SL (`grouping: 'na'` only, `trading.ts:78`) | none | none |
| Reduce-only | real flag `r` (`trading.ts:184`); API risk engine verifies it really reduces (`packages/derivatives/src/risk.ts:201-204`) | implicit: a decrease sends no collateral (`live/gmx.ts:326-328`) | none |
| Time in force | gtc, ioc, alo (`trading.ts:177`) | n/a | none |
| Modify order | no (`modify: false`, `adapter.ts:72`) | no | no |
| Leverage / margin mode | real `updateLeverage`, cross or isolated (`trading.ts:285-291`); passkey in manual mode, none under a mandate | no setting: leverage = size / collateral, checked per increase (`live/gmx.ts:504-510`); isolated only | none |
| Collateral deposit | real on mainnet: plain USDC transfer on Arbitrum to the pinned Bridge2 (`live/collateral.ts:50-57`, `:97-119`); no testnet route (`:46-49`) | n/a (collateral travels with the order) | none |
| Collateral withdrawal | real: `withdraw3` to the wallet's own address, signed by the main key (`signer/venue-collateral.ts:49-79`) | n/a | none |
| Paper trading | yes — the only venue with `paperFees` (`venues.ts:119-128`; gate `services/api/src/derivatives/routes.ts:55`) | no (`paperFees: null`, no order book) | no |
| Autonomous (passkey-less) trading | yes: derivative mandate (`signer/venue-mandate.ts`) | **no**: `mode: z.literal('MANUAL_LIVE')` (`live/gmx.ts:450`) | no |

### 1.2 Environment locks

All three are read at every use and need the exact string `on`.

| Variable | Read at | Gates |
|---|---|---|
| `SPW_DERIV_LIVE_MAINNET` | `services/api/src/derivatives/live.ts:12` | HL mainnet: account creation (`exec.ts:296`), authorization (`:309`, `:337`), every trade **and every cancel** (`exec.ts:180`), the adapter's own second lock on `/exchange` (`live-venue.ts:63-65`, `trading.ts:316`), collateral moves (`collateral.ts:188`). Also a precondition of everything GMX (`gmx-exec.ts:144`). |
| `SPW_DERIV_MANDATE_MAINNET` | `live.ts:15` | mandate prepare / approve / place / leverage on HL mainnet (`exec.ts:980-985`). Needs the first one too. |
| `SPW_DERIV_GMX_LIVE` | `services/api/src/derivatives/gmx-live.ts:14` | every GMX prepare and approve (`gmx-exec.ts:143`), and the relay of an already signed transaction (`gmx-exec.ts:559`). |

HL **testnet** needs none of them. `capabilities.ts:16-36` reports the three at start-up. `docs/runbooks/deploy.md:49` shows the
expected production start-up line as `deriv_live_mainnet=on deriv_mandate_mainnet=on deriv_gmx_live=OFF(...)`. Whether production
actually runs with those values was **not verified** (production was not touched).

The signer has no environment lock for derivatives: its gates are the stored authorization, the passkey, and its own `halted` flag.

### 1.3 What is paper / simulated

- `packages/derivatives/src/paper.ts` (engine) + `services/api/src/derivatives/paper.ts` + `worker.ts`: a simulated HL account fed
  with real tickers and books every 3 s (`worker.ts:14`), funding applied from the venue's published rates. No signer call, no venue
  trading endpoint (`services/api/src/derivatives/index.ts:1-3`).
- `packages/derivatives/src/router.ts` + `services/api/src/derivatives/route.ts`: venue comparison for one order intent. Output is
  `source: 'estimate'`; it selects nothing and sends nothing (`routes.ts:115-125`).
- Perp agents on paper accounts (`services/api/src/agents/perp-engine.ts`); live agents use the mandate interface (`derivatives/mandate.ts`).

### 1.4 What has only ever been proven by tests, recordings or forks

The repository's own docs state this, and the code gives no reason to doubt them:

- **Hyperliquid, any accepted action on a funded account: never run.** `docs/v4/venues/hyperliquid.md:241`, `:318`, `:418-424`;
  `docs/v6/DERIVATIVE-MANDATE.md` section 7; `docs/v7/PERP-AGENT-LIVE.md:95-105`. What was proven on testnet with an unfunded
  throwaway key: the venue recovers the right signer address from our signatures (so hashing, field order and expiry match). The
  order → resting → fill → reconciliation path, `userRole` confirming the agent, `updateLeverage` confirmed, the exposure bound against
  real fills: all exercised only against the scripted fake exchange of the tests.
- **Hyperliquid collateral:** deposit proven on an anvil fork of Arbitrum (bridge side only); the venue crediting it is taken from the
  venue's documentation (`docs/v4/venues/hyperliquid.md:668-700`). Withdrawal: signature recovery proven on testnet, unfunded.
- **GMX:** creation, simulated execution and keeper cancellation proven on an anvil fork with real contract bytecode
  (`docs/v8/fork-gmx-2026-11-11.txt`, `docs/v4/venues/gmx.md:965-992`). Not run: shorts, the BTC market, frozen orders, liquidation,
  ADL, positions with a WETH/WBTC profit. **Nothing was sent to Arbitrum mainnet** according to the docs.
- **dYdX:** read side recorded as fixtures; no trading code exists.
- "Mainnet: nothing was ever sent to it" (`docs/v6/DERIVATIVE-MANDATE.md` section 7, `docs/v7/PERP-AGENT-LIVE.md:105`). Whether this
  is still true of the production deployment is **not verified**.

Test inventory relevant to this scope (count of `it(`/`test(`; not run for this audit): `signer/test/venue.test.ts` 18,
`venue-mandate.test.ts` 37, `venue-gmx.test.ts` 9, `venue-collateral.test.ts` 23, `mandate.test.ts` 10;
`services/api/test/derivatives-live.test.ts` 22, `derivatives-mandate.test.ts` 22, `derivatives-gmx.test.ts` 20,
`derivatives-collateral.test.ts` 16, `perp-agent-live.test.ts` 17; `packages/derivatives/test/risk.test.ts` 28,
`gmx-live.test.ts` 23, `hyperliquid/trading.test.ts` 38.

### 1.5 Public endpoints called on 2026-11-15 (~23:45 UTC), read-only

| Call | Result |
|---|---|
| `POST https://api.hyperliquid.xyz/info {"type":"meta"}` | 200, 235 assets. BTC index 0 / szDecimals 5 / maxLeverage 40; ETH 1 / 4 / 25; SOL 5 / 2 / 20 — **identical to the pinned table** `live/hl-assets.ts:19-23` |
| `POST https://api.hyperliquid-testnet.xyz/info {"type":"meta"}` | 200, 213 assets. SOL 0 / 2 / 10; BTC 3 / 5 / 40; ETH 4 / 4 / 25 — **identical to the pinned table** `hl-assets.ts:24-28` |
| HL mainnet `l2Book` (BTC), `metaAndAssetCtxs` | 200 |
| HL mainnet `clearinghouseState`, `frontendOpenOrders`, `activeAssetData`, `orderStatus` (address `0x…0001`, a cloid that does not exist) | 200; shapes match what `signer/venue-read.ts:53-81` and `live-venue.ts:17-22` parse (`marginSummary.accountValue`, `totalNtlPos`, `leverage:{type,value}`, `{"status":"unknownOid"}`) |
| First burst of HL calls | one **HTTP 429 with body `null`** on `meta` and on `clearinghouseState`; an immediate retry answered 200. The signer's reader treats any non-200 as "unreachable" (`venue-read.ts:27`), so a mandate order that adds exposure is refused on such a 429 (fail closed). |
| `GET https://indexer.dydx.trade/v4/height`, `/perpetualMarkets?ticker=BTC-USD`, `/orderbooks/perpetualMarket/BTC-USD` | 200 |
| `GET https://indexer.v4testnet.dydx.exchange/v4/height` | 200 |
| `GET https://arbitrum.gmxapi.io/v1/markets`, `/v1/markets/tickers`, peer `https://arbitrum.gmxapi.ai/v1/markets` | 200 |
| `GET https://arbitrum-api.gmxinfra.io/prices/tickers`, `/markets/info` | 200 |

Not called: any `/exchange` endpoint, any RPC `eth_sendRawTransaction`, the GMX pinned-bytecode check (it needs the registry RPC
endpoints; `gmx-chain.ts:74-106`), websockets, Coinbase/Kraken (the signer's price sources).

---

## 2. The venue abstraction

### 2.1 Exact shape

`packages/derivatives/src/venue.ts`:

- `Capabilities` (`:8-10`): `marketData, account, orders: boolean; orderTypes; tif; modify; leverage; marginModes; subaccounts; testnet; stream; notes[]`.
- `VenueAdapter` (`:12-32`): `id: VenueId`, `network: 'mainnet' | 'testnet'`, `capabilities`, read methods `instruments, tickers, book,
  trades, candles, fundingHistory, account, positions, openOrders, orderHistory, fills, funding`, optional `stream`, optional `trading?: VenueTrading`.
- `SignRequest` (`:34`): `{ venue: VenueId; network; kind: string; payload: unknown }`.
- `VenueTrading` (`:36-43`): `buildOrder(req, {instrument, nonce})`, `buildCancel`, `describe(sign)` (the signer's independent reading),
  `submit(action, signature, nonce)`.

`packages/derivatives/src/models.ts`: `VENUE_IDS = ['hyperliquid','dydx','gmx']` (`:14`), zod schemas `Instrument` (`:27-45`), `Ticker`,
`Book`, `AccountState` (`:80-91`), `Position` (`:94-108`), `OrderRequest` (`:117-127`), `ORDER_TYPES` (`:111`), `ORDER_STATUSES`
(`:130`), `Order`, `Fill`, `FundingPayment`, `VenueError` with codes `rate_limited | unavailable | bad_answer | rejected | unsupported | stale` (`:166-180`).

### 2.2 What the abstraction really covers

- **Read side: genuine.** Three adapters implement `VenueAdapter`; `VenueRegistry` (`venues.ts:65-116`) hands out a narrowed
  `ReadAdapter` (`:12-13`) without `trading`, tracks health, and applies a per-venue `restriction` text.
- **Trade side: not an abstraction.** `VenueTrading` has exactly one implementation (`HlTrading`, `trading.ts:116-126`), which extends it
  with `buildUpdateLeverage`, `buildApproveAgent`, `normalizeRequest`. The live engine does not go through `VenueAdapter.trading`: it
  builds `createHlTrading` directly (`live-venue.ts:63-65`). `LiveService` is Hyperliquid-specific by type (`exec.ts:73`
  `venue: 'hyperliquid'`), by schema (`exec.ts:85`), and by guard (`exec.ts:288`).
- **GMX is a second, parallel engine**, not a `VenueTrading`: its own service (`gmx-exec.ts`), table (`deriv_gmx_ops`), routes
  (`gmx-routes.ts`), state list, signer path (`Signer.sign` + `venue-gmx.ts`) and intent section (`core/src/intent.ts:78-89`).
- **`Capabilities` is not the source of truth for trading.** `GMX_CAPABILITIES.orders` is `false` with `orderTypes: []`
  (`venues/gmx/adapter.ts:30-32`) although GMX orders can be created; the HL registry adapter declares `orders: true` while its
  `trading` is deliberately undefined (`venues.ts:156`). The router keeps a third table, `WALLET` (`route.ts:42-46`), that says GMX
  trading is `'none'`.

### 2.3 Every place that enumerates venues (what a new venue must touch)

Shared package (`packages/derivatives/src`):

1. `models.ts:14` — `VENUE_IDS` (drives `VenueId`, `InstrumentSchema.venue`, `AccountState.venue`).
2. `venues/<venue>/` — adapter, wire schemas, mappers, stream; export from `index.ts:9-12`.
3. `router.ts:74` — `ROUTER_FACTS: Record<VenueId, …>` (compile error until filled); `ROUTER_WARNINGS`.
4. `live/index.ts` — the signer's lean entry point must re-export the new venue's pure builder / `describe`.
5. `live/canonical.ts:46`, `:67`, `:125`, `:135`, `:164` — `venue: z.literal('hyperliquid')` and instrument regex `^hyperliquid:` in
   `VenuePolicySchema`, `VenueAuthorizationSchema`, `VenueOrderSchema`, `VenueLeverageSchema`.
6. `live/mandate.ts:31`, `:43` — same literal and regex in `VenueMandateSchema`.
7. `live/collateral.ts:50-60`, `:105`, `:133` — bridge pins, `venue !== 'hyperliquid'`, `VenueWithdrawalSchema`.
8. `live/jurisdiction.ts:15-16` — `AckVenue` and the acknowledgement texts (fr + en) the signer accepts by hash.
9. `live/hl-assets.ts` (HL pinned assets) / `live/gmx.ts:48-67`, `:124-129` (GMX pinned contracts and markets): a new venue needs its own pinned trust table.

Core: `packages/core/src/intent.ts:56` (`venueDeposit.venue: z.enum(['hyperliquid'])`), `:78-89` (`gmx` section) and the hashing in
`fields()` (`:132-137`) — any new intent section must be added to the canonical byte order.

Signer (`services/isolated-signer/src`):

10. `keys.ts:89-93` — `venueKey(venue: 'hyperliquid', …)` and the derivation path.
11. `venue.ts:41` (`venueKeyAddress`), `:82`, `:134` (`createHlTrading` hard-wired in authorize and sign), `:116`, `:180` (instrument → price symbol).
12. `venue-mandate.ts:116`, `:170` — same; `venue-read.ts:23` — pinned info hosts, HL-specific parsing.
13. `venue-gmx.ts`, `venue-collateral.ts` — venue-specific files; `signer.ts:435-439` — the two "plain transfer to a venue contract" refusals.
14. `server.ts:65-77` — route table (`/venue/key`, `/venue/authorize`, `/venue/sign`, `/venue/revoke`, `/venue/withdraw`,
    `/venue/mandate/*`, `/venue/gmx/*`); `store.ts:20-27` — state maps `venues`, `venueWithdrawals`, `venueMandates`, `gmx`; `store.ts:90-98` pruning.
15. `prices.ts` + `packages/core/src/market-listings.ts` — the signer prices only symbols listed on both Coinbase and Kraken (`prices.ts:48`, `:57-58`).

API (`services/api/src`):

16. `derivatives/venues.ts:119-170` — `*_FACTS`, `createDefaultRegistry`, `createRegistry` (three explicit `if (adapters.x)` branches).
17. `derivatives/exec.ts:73`, `:85`, `:235`, `:288`, `:319`, `:532`, `:754`, `:1020`, `:1172` — literal `'hyperliquid'`; `live-venue.ts` (HL only).
18. `derivatives/route.ts:42-46` (`WALLET`), `market-texts.ts:64` (`TERMS_FR: Record<VenueId, …>`), `live-texts.ts`, `live-routes.ts:37`.
19. `derivatives/gmx-*.ts`, `collateral*.ts`; `server.ts:144-149` (route registration); `main.ts:28-31` (workers); `worker.ts:34`, `:40` (`p.kind === 'gmx'`).
20. `capabilities.ts:17-25` — one entry per env lock; `signer-client.ts:57-70` — one client method per signer route.
21. `agents/perp-engine.ts`, `perp-data.ts`, `perp-routes.ts` — the perp agent assumes HL.

Database: **no enum and no check constraint on any venue column** (`db.ts:93-125`, `:196-202`): `venue text`, `network text`,
`state text`. A new venue needs no migration for the type, but nothing in the database rejects an unknown venue or state either.

Web (`apps/web/src`): `derivatives/bits.tsx:22-23` (`VENUE_NAME`, `VENUE_DOT`), `Compare.tsx:15`, `mockRouter.ts:21`, `:68`,
`mock*.ts`, `dec.ts:144`, `types.ts:57`, `LiveAccounts.tsx`, `LiveCollateral.tsx`, `GmxOrderPanel.tsx`, `screens/Futures.tsx`,
`screens/PerpAgent*.tsx`, `i18n.ts`, `icons*.ts`.

### 2.4 How a new venue would plug in today

- **Read-only venue:** contained. Add the id, an adapter, facts, router facts, FR texts, web names. Roughly items 1-3, 16, 18 and the web list.
- **Tradable venue:** there is no seam to plug into. The honest description is "write a third engine", as GMX did: a new signer file
  with its own authorization object, pinned table, `describe`/builder, state map and routes; a new API service with its own table and
  state list; a new env lock. Two shapes exist as precedents:
  - *off-chain signed venue with an API wallet* (HL): canonical authorization → trading key → `describe()` → per-action signature;
  - *on-chain venue* (GMX): a new optional section of `Intent`, built into a transaction by the signer, policy via `checkPolicy`.
- A V11 venue layer would have to generalise at least: the canonical objects (`venue` literal + instrument regex), the signer's
  `describe` dispatch (`createHlTrading` is called by name in four places), the trading-key derivation, the venue account reader used
  by mandates, and the order table/state machine (two incompatible ones today, section 3).

---

## 3. Order life cycle

### 3.1 Hyperliquid (`exec.ts`)

**States** (`exec.ts:41`, comment `db.ts:133`):
`proposed → risk_checked → authorized → signed → submitted → open | partially_filled | filled | cancelled | rejected`, plus `unknown`.
Groups: `PRE_SUBMIT = [proposed, risk_checked]`, `IN_FLIGHT = [authorized, signed]`, `AT_VENUE = [submitted, unknown, open, partially_filled, filled]` (`exec.ts:40`).

| State | Meaning in the code | Set at |
|---|---|---|
| `proposed` | row inserted, proposal being built | `exec.ts:518-520` (manual), `:1157-1159` (mandate) |
| `risk_checked` | passed the API risk engine; canonical order, hash, nonce, action and sign request stored; waiting for the passkey | `exec.ts:539-540` |
| `authorized` | taken by exactly one approve call and handed to the signer (compare-and-set on `risk_checked`) | `exec.ts:590` (manual); `:1177-1178` (mandate: straight from `proposed`, no approval step) |
| `signed` | signature received and stored | `exec.ts:601`, `:1192` |
| `submitted` | venue answered OK | `exec.ts:614` |
| `unknown` | timeout / unreadable answer, or the venue stopped knowing an acknowledged order | `exec.ts:624`, `:654`, `:658` |
| `open`, `partially_filled`, `filled`, `cancelled`, `rejected` | from the venue's own records only | `exec.ts:660-675` |

**Tables and columns** (`db.ts:97-102`, `:134-147`, `:183-185`): `deriv_orders` — primary key `(account_id, client_id)`; `state`,
`final`, `status` (legacy/paper column kept in sync, `exec.ts:556`), `cloid`, `request` (canonical `VenueOrder`), `order_hash`, `nonce`,
`expires_at`, `action` and `sign_request` (type `json`, not `jsonb`, to keep key order — `db.ts:141`), `signature`, `venue_answer`,
`submitted_at`, `venue_order_id`, `filled`, `avg_fill_price`, `reject_reason`, `origin` (`owner | close | mandate`), `mandate_id`,
`agent`, `estimate`. The same table holds paper orders (`state is null`). Cancels and leverage changes: `deriv_actions`
(`db.ts:149-152`, states `authorized | risk_checked | signed | submitted | rejected | unknown | confirmed | cancelled`). Fills
`deriv_fills` (pk `(account_id, fill_id)`), funding `deriv_funding`, risk events `deriv_risk_events` (unique `(account_id, dedupe)`),
equity `deriv_equity`, mandates `deriv_mandates`, account `deriv_accounts` (`last_nonce`, `halt`, `divergence`, `meta`).

**Idempotency, four layers:**

1. HTTP `Idempotency-Key` header, required, 8-100 chars (`live-routes.ts:17`, `:24-29`, `:62`) = `client_id` = primary key. An
   in-process map makes a concurrent duplicate wait (`exec.ts:133`, `:485-497`); `insert … on conflict do nothing` covers another process (`:518-521`).
2. Venue client order id: `cloid = first 16 bytes of keccak256("spw/hyperliquid/cloid/v1:" ‖ clientId)` (`trading.ts:46-51`), so a retry can never create a second venue order.
3. Venue nonce: `last_nonce = greatest(last_nonce + 1, now)` in one SQL statement (`exec.ts:166-169`); every action carries
   `expiresAfter = nonce + 90 s` manual / `+ 30 s` mandate (`live-venue.ts:13`, `exec.ts:100`).
4. Signer: client id signed once per three days (`signer/venue.ts:178`, `:190`; `store.ts:92`), nonce never reused and never below the
   lowest of the last 100 (`venue.ts:146-147`, `:211`), all persisted before the signature is returned (`venue.ts:210-216`).

**Ambiguous submission** (`exec.ts:609-628`): a `VenueError` `rejected` → `rejected` final; `unsupported` or a *local* rate-limit
refusal → `rejected`, "not sent"; **anything else** (timeout, network error, unreadable body — `trading.ts:333`) → `unknown`, non-final,
plus a risk event. `unknown` is left only by `reconcileOrder`.

**Reconciliation** (`exec.ts:634-676`), per order, by `orderStatus(cloid)` + fills carrying the cloid:

- venue does not know the cloid and the order is `signed`/`unknown`: after `expires_at + 5 s` → `rejected` final "never placed"
  (`:649-653`); before that, `signed` becomes `unknown` (`:654`). If the order had been acknowledged: a `divergence` risk event and `unknown` (`:657-658`).
- venue knows it: filled size = `max(Σ stored fills, origSz − sz)`; `open`/`partially_filled` while resting; when the venue says
  `filled` or `cancelled`: `filled` if size reached, else `partially_filled` (with a reason) or `cancelled`; `final` only once the fills
  add up or 60 s have passed (`:660-670`). Any other venue status → `rejected` final.

**What marks an order filled:** only the venue's order status and fills (`exec.ts:630-633`). The HTTP answer of `/exchange` never does.

**After a restart:** the worker (`live.ts:34-43`, every 10 s) runs `reconcile()` (`exec.ts:881-955`) for every account that was ever
authorized or still has a non-final order (`:872-875`), entirely from the database and the venue: (1) proposals past their window →
`cancelled`; `authorized` older than 60 s → `rejected` "no signature was received" (`:884-888`); (2) fills from `fillsCursor − 60 s`,
funding every 5 min; (3) every non-final order past `authorized` is reconciled (`:909-910`); (4) divergence: positions explained by
the wallet's own fills since the baseline vs the venue's positions, and resting orders not placed by the wallet; a difference seen on
two consecutive passes sets `divergence`, which halts new orders (`:913-942`, `:186-188`); (5) one equity row per minute.

### 3.2 GMX (`gmx-exec.ts`)

Two rows per order action: a wallet `proposals` row (`kind = 'gmx'`, state machine `packages/core/src/state.ts:5-14`:
`pending_approval → approved → signed → broadcast → confirming → finalized`, or `rejected | expired | failed | replaced | reorged`) and a
`deriv_gmx_ops` row (`db.ts:196-202`) that follows the *order*.

Op states (`gmx-exec.ts:94`): `pending_approval → signed → sent → created → executed | cancelled | frozen`, `done` (a mined cancel),
`failed`, `expired`, `withdrawn`, `unknown`.

- **Idempotency:** `deriv_gmx_ops.idempotency_key` unique (`db.ts:197`; replay `gmx-exec.ts:454-461`); proposal id single-use in the
  signer (`signer.ts:433`, `:543`); EVM nonce read with quorum (`gmx-chain.ts:117`); one unapproved op at a time (`gmx-exec.ts:438`); one
  in-flight wallet transaction per network (`:450-453`).
- **Ambiguous submission:** the transaction hash is known before sending. `broadcast` goes to every RPC; "already known" is not an
  error (`gmx-chain.ts:160-164`). A failed attempt leaves the proposal `signed` and is retried by the worker for 8 minutes
  (`gmx-exec.ts:560`, `:577`; `services/api/src/worker.ts:34`). No receipt after 15 min → `unknown`, still polled (`:630-636`).
- **What marks execution:** the `OrderCreated` event in the receipt gives the order key and is compared field by field with the
  approved plan (`:648-655`); then, once `Reader.getOrder` no longer returns the order, an `OrderExecuted` or `OrderCancelled` event of
  the pinned EventEmitter for that key (`:657-675`). "created" is never shown as "executed". Order gone and no event after 6 passes → `unknown` (`:667-671`).
- **Restart:** `GmxService.step()` every 5 s over all non-final ops (`:680-686`); a proposal stuck in `approved` is failed after one
  minute by the wallet worker (`worker.ts:22-23`), which the op then mirrors (`gmx-exec.ts:626`).
- **Naming trap:** the op is set to `signed` *before* the signer is called (`gmx-exec.ts:530`); it means "handed to the signer".

### 3.3 Gaps against the target state machine

| Target | HL today | GMX today | Gap |
|---|---|---|---|
| CREATED | `proposed` | (no row before validation) | GMX stores nothing until every check passed (`gmx-exec.ts:444`); a refused GMX request leaves no order row, only an HTTP error. |
| VALIDATED | `risk_checked` | — | For HL, VALIDATED and AWAITING_APPROVAL are the same state. |
| AWAITING_APPROVAL | `risk_checked` | `pending_approval` | No separate state on HL. Mandate orders skip it by design (`exec.ts:1176`). |
| APPROVED | `authorized` | `signed` (op) / `approved` (proposal) | Neither means "approval verified": the API cannot verify a passkey. Both mean "handed to the signer". The verified approval and the signature arrive together. |
| SUBMITTING | `signed` | `signed` (proposal) | Present under another name. |
| SUBMITTED | `submitted` | `sent` then `created` | HL has an extra accepted-and-resting state `open` with no target equivalent. GMX needs two (`sent` = transaction relayed, `created` = order exists on-chain). |
| PARTIALLY_FILLED | `partially_filled` | n/a (market orders execute whole or are cancelled) | On HL the same value is both transient (resting) and terminal (remainder cancelled, `final = true`, `exec.ts:667-669`). Only `final` tells them apart. |
| FILLED | `filled` | `executed` | Different names. |
| CANCELLED | `cancelled` | `cancelled`, `withdrawn`, `expired`, `done` | HL overloads `cancelled` with four causes: withdrawn before approval (`:722`), window expired (`:581`, `:884`), halted (`:577`, `:794`), revoked (`:390`), and cancelled at the venue. The cause is free text in `reject_reason`. |
| REJECTED | `rejected` | `failed` | HL overloads `rejected`: risk refusal (`:523`), build error (`:535`), signer refusal or signer unreachable (`:597`), venue refusal (`:621`), "never placed" (`:650`), "interrupted while asking the signer" (`:886`). |
| FAILED | **absent** | `failed` | HL has no technical-failure state: infrastructure failures are filed under `rejected`. |
| UNKNOWN | `unknown` | `unknown` | Present on both. On HL an order the venue acknowledged and then forgot stays `unknown` and non-final forever (`:657-658`); there is no time-out and no operator action to close it. |

Structural gaps:

- **No transition table for derivative orders.** `core/state.ts` guards wallet proposals (`assertTransition`), but `setOrder`
  (`exec.ts:555-564`) writes any state unconditionally; only three updates are compare-and-set (`:590`, `:722-723`, `:1177-1178`).
- **No state history.** One row per order, overwritten; the trail is the audit chain plus `updated_at`. Audit failures are swallowed (`exec.ts:163-165`).
- **No database constraint** on `state` / `status`; two columns carry overlapping meaning (`exec.ts:556`).
- **Two vocabularies** (HL and GMX) and a third for collateral (`collateral.ts:51-52`) and a fourth for `deriv_actions`.
- **Reconciliation is polling only** (10 s HL, 5 s GMX). The HL user websocket stream is implemented in the adapter but unused.
- The "never placed" rule relies on two unverified venue properties: that HL refuses an action after `expiresAfter`, and that its
  info endpoint lags less than 5 s (`exec.ts:36`; listed as not verified in `docs/v6/DERIVATIVE-MANDATE.md` section 7). A wrong
  "never placed" is final, though the position-divergence check would still flag the resulting position.

---

## 4. The signer's authorization model

### 4.1 Transport

Plain HTTP on `SPW_SIGNER_HOST:SPW_SIGNER_PORT` (default `127.0.0.1:8651`, `signer/main.ts:81`), reached through a TCP relay
(`scripts/signer-relay.mjs`). Every request except `GET /healthz` carries `x-spw-auth: t=<unix s>,n=<uuid>,s=<hmac>`, HMAC-SHA256 over
`method \n path \n ts \n nonce \n sha256(body)` with one shared secret ≥ 32 chars (`signer/server.ts:7-10`, `:23-35`); ±60 s window; nonce
cache in memory for 120 s; optional source-IP allowlist `SPW_SIGNER_ALLOW_IPS` (`main.ts:82`, `server.ts:41-42`); body ≤ 1 MB; all
requests strictly serialized (`server.ts:36`, `:80`). The HMAC authenticates the API process as a whole: **the signer cannot tell an owner
session from an agent or from any future API-key caller.** Everything it decides, it decides from the request content.

### 4.2 Every endpoint and what it verifies itself

`P` = WebAuthn assertion with user verification, checked against the passkey public keys the signer pinned itself
(`signer.ts:74-88`; origin and rpId from the signer's own environment, `main.ts:79`).

| Endpoint (`server.ts`) | Passkey | What the signer checks by itself |
|---|---|---|
| `GET /status` (`:47`) | no | — returns key id, addresses, halted, policy, today's spend, mandates, venue authorizations, journal head (`signer.ts:35-52`) |
| `POST /enroll` (`:48`) | first: one-time setup token; later: `P` over `SPW-ENROLL-v1 ‖ id ‖ pubkey` | `signer.ts:91-106` |
| `POST /sign` (`:49`) | `P` over `intentHash` | key id, network/chain ref, `from` = own address, self-send rules, replay (`used[proposalId]`), venue-deposit and GMX-contract refusals, `checkPolicy` (halt, policy version, window ≤ `maxApprovalTtlSec`, per-tx and daily amount, fee ceiling, allowlist), then **rebuilds the transaction from the intent**; swap calldata must hash to `swap.dataHash` and pass decoding; spend and replay marker stored before signing (`signer.ts:414-554`) |
| `POST /bridge/mint` (`:51`) | first signature none; any further one `P` | only the `receiveMessage` matching a stored approved bridge, to the wallet's own address (`signer.ts:253-290`) |
| `POST /bridge/reclaim`, `/sol/token-account` (`:53-54`) | `P` | `signer.ts:330-385` |
| `POST /halt` (`:55`) | **no** | sets `halted = true` (`signer.ts:408-412`). There is no un-halt endpoint; only the CLI (`main.ts:49-54`). |
| `POST /vault/address` (`:57`) | no | derivation only |
| `POST /mandate/approve` (`:58`) | `P` over `mandateHash` | spot vault mandate; see 4.5 |
| `POST /mandate/sign` (`:60`) | **no** | spot vault order inside the mandate + the signer's own price check (`signer.ts:144-185`) |
| `POST /mandate/revoke` (`:59`) | no | irreversible |
| `POST /mandate/return`, `/vault/return` (`:61-62`) | **no** | plain transfer from a vault, destination must be the owner's own address; no halt check, no amount limit, fee ≤ policy (`signer.ts:188-244`) |
| `POST /venue/key` (`:65`) | no | returns the trading key address and path |
| `POST /venue/authorize` (`:66`) | `P` over `venueAuthorizationHash` | key id, account = own address, agent = its own derived trading key, instruments in the pinned table, leverage ≤ venue max, known acknowledgement hash, no other active authorization for the venue+network, halt off; then the **main key signs `approveAgent`** built here and read back (`signer/venue.ts:58-100`) |
| `POST /venue/sign` (`:67`) | order, leverage: `P` over the canonical object; **cancel: none** | see 4.4 |
| `POST /venue/revoke` (`:68`) | no | irreversible; a revoked authorization signs nothing, not even a cancel (`venue.ts:103-112`, `:126`) |
| `POST /venue/withdraw` (`:70`) | `P` over `venueWithdrawalHash` | account = destination = own address, fee = documented fee, window ≤ 5 min, `time` strictly increasing, ≤ 10 per UTC day, halt off; action built here and read back (`signer/venue-collateral.ts:49-79`) |
| `POST /venue/mandate/approve` (`:72`) | `P` over `venueMandateHash` | see 4.6 |
| `POST /venue/mandate/sign` (`:73`) | **no** | see 4.6 |
| `POST /venue/mandate/revoke` (`:74`) | no | starts the 24 h wind-down |
| `POST /venue/gmx/authorize` (`:76`) | `P` over `gmxAuthorizationHash` | key id, account = own address on Arbitrum, contract-set id = the pinned one, markets in the pinned table, execution-fee ceiling, known GMX acknowledgement hash, no other active authorization, halt off (`signer/venue-gmx.ts:35-55`) |
| `POST /venue/gmx/revoke` (`:77`) | no | irreversible |

Signatures released **without a passkey** today: `/mandate/sign`, `/mandate/return`, `/vault/return`, `/venue/sign` (cancel),
`/venue/mandate/sign` (order, cancel, leverage), `/bridge/mint` (first signature of an approved bridge).

### 4.3 `policy.json`

Schema `packages/core/src/policy.ts:8-17` (strict):

```
{ version: int,
  perTx:  { "<network>:<symbol>": "<base units>" },   // missing key = 0 = deny
  daily:  { "<network>:<symbol>": "<base units>" },
  maxFee: { "<network>": "<native base units>" },
  maxApprovalTtlSec: 30..900,
  allowlist: [ "<network>:<address>" ] }               // non-empty = only these destinations
```

Loaded once at start from `<signer dir>/policy.json`; written with defaults when absent (`store.ts:62-66`). Defaults: about 50 USD per
transfer and twice that per UTC day per asset (`policy.ts:23-47`, `:64-74`), `maxApprovalTtlSec` 300, empty allowlist, version 4. The
policy can only be changed by editing the file on the signer machine and restarting; `policyVersion` in every intent must equal it
(`policy.ts:83`). Enforcement: `checkPolicy` (`:80-96`) with the day's spend kept in `state.spent["<day>|<network>:<symbol>"]`
(`signer.ts:441-443`, `:544`); `checkPolicyNoSpend` for a GMX decrease or cancel (`:104-115`).

`policy.json` contains **nothing about derivatives**. Derivative limits live in the per-authorization objects stored in `state.json`
(`store.ts:20-27`): they are chosen by the owner in the app and committed by the passkey, bounded by constants compiled into the signer
(`VENUE_POLICY_BOUNDS` `live/canonical.ts:19`; `VENUE_MANDATE_BOUNDS` `live/mandate.ts:20`; `GMX_POLICY_BOUNDS` `live/gmx.ts:421-423`).
The wallet policy still applies to the wallet-transaction parts: a HL deposit and a GMX increase count against `perTx` / `daily` of
`arbitrum:USDC` and `maxFee.arbitrum`.

### 4.4 Manual live trading (Hyperliquid `MANUAL_LIVE`)

Authorization object `VenueAuthorization` (`live/canonical.ts:62-84`): venue, network, account, agent address and name, mode, policy
`{ allowedInstruments (≤ 8), maxLeverage (≤ 20), maxOrderNotional, maxPositionNotional, maxGrossExposure, maxOrdersPerDay (≤ 500),
maxPriceDeviationBps (10..2000) }`, `createdAt`, `expiresAt` (≤ 90 days), `approveNonce`, `ackSha256`.

On `/venue/sign` (`signer/venue.ts:119-218`): authorization unrevoked, unexpired, `MANUAL_LIVE`; the payload is **read by the signer**
(`describe`, pinned asset table) and its typed data must be exactly the hash of the action (`trading.ts:214-222`); only `order`,
`cancel`/`cancelByCloid`, `updateLeverage`; no vault/sub-account; a venue expiry is mandatory and ≤ 120 s after the nonce
(`canonical.ts:17`, `:180-187`); nonce rules. For an **order**: halt off; exactly one order; the canonical object shown for approval
must equal the payload field by field (`venue.ts:165-172`); instrument allowed; notional ≤ `maxOrderNotional`; daily count; client id
never signed; every price within the band of the signer's **own** Coinbase+Kraken mid (`:180-186`); passkey over `venueOrderHash`.
For a **leverage change**: halt off, fields equal, leverage ≤ `maxLeverage`, passkey. For a **cancel**: instrument allowed only.

Enforced by the API only in manual mode (the signer says so, `canonical.ts:51-55`, `venue.ts:175`): resulting position and gross
exposure, account leverage, free collateral, liquidation distance, loss limits, order rate per minute.

### 4.5 Spot vault mandates

`Mandate` (`packages/core/src/mandate.ts:14-36`): `mandateId, keyId, vaultIndex (≥ 1), vault, network, provider: 'kyberswap', assets
(2..12), maxOrder / maxDaily per asset, maxOrdersPerDay (≤ 500), maxSlippageBps (10..500), createdAt, expiresAt (≤ 90 days),
strategySha256, label`. Approved by the owner's passkey over `mandateHash` (`signer.ts:115-134`). A vault is a separate HD account
(`m/44'/60'/<index>'/0/0`, `keys.ts:83-88`); the owner's key is account 0 and cannot be mandated.

Enforcement without the API (`signer.ts:144-185`, `mandate.ts:74-93`): halt, revoked, expiry, vault key id, network, swap through the
mandated provider only, spend from and deliver to the vault itself, assets inside the mandate, window ≤ 300 s, per-order and daily
volume, daily count, fee ceiling; calldata rebuilt and checked; and the signer's own price check — the guaranteed minimum output must
be worth at least `1 − maxSlippageBps` of the input at Coinbase+Kraken prices (`mandate.ts:99-108`, floats for the comparison only).

An agent **can**: swap inside the vault, within limits. It **cannot**: move funds out of the vault except to the owner's own address,
touch the owner's wallet, widen or re-activate a mandate, trade another asset or provider.

### 4.6 Derivative mandates (`MANDATE_LIVE`, Hyperliquid only)

`VenueMandate` (`live/mandate.ts:37-67`): `mandateId, authorizationId` (it **extends** a `MANUAL_LIVE` authorization and dies with it),
`keyId, venue, network, account, agentAddress, strategySha256, agentId` (audit only — the signer cannot verify what code runs,
`:47`), `instruments[{ instrument, maxLeverage, maxPositionNotional }]`, `maxOrderNotional, maxGrossExposure, maxOrdersPerDay,
maxOrdersPerHour (≤ 60), maxDailyTurnover, floorEquity, maxPriceDeviationBps, createdAt, expiresAt (≤ 30 days), ackSha256`.

Who approves: the owner, one passkey assertion over `venueMandateHash` (`signer/venue-mandate.ts:55-87`). Every limit must be ≤ the
authorization's (`live/mandate.ts:88-112`); one active mandate per authorization (`venue-mandate.ts:76-78`); halt off.

How the signer enforces it independently (`venue-mandate.ts:150-275`) — nothing the API says about the order, positions or prices is used:

- the order is taken from the payload via `describe`; the API's description is optional and must merely agree (`:194-208`);
- **cancel:** authorization alive, mandate not ended, instrument allowed. Also under halt and during the wind-down;
- **reduce-only order:** instrument in the mandate, notional ≤ `maxOrderNotional`, price band, client id never signed. No venue
  read, no counter, signed also under halt and wind-down (`:222`);
- **order that can add exposure:** mandate `active`, halt off, daily count (mandate and authorization), hourly count, daily turnover;
  then the **signer's own read of the venue account** (`venue-read.ts`, pinned hosts, `/info` only): fresh within 30 s, internally
  consistent, valued within the band of the signer's own price, no position on an asset it cannot price (`venue-mandate.ts:105-144`);
  account value ≥ `floorEquity`; the venue's leverage setting ≤ the mandate's; worst-case position and worst-case gross exposure
  (positions + resting orders + recently signed orders + the candidate, `live/mandate.ts:144-172`) within limits (`:231-243`);
- **leverage change:** mandate active, halt off, ≤ the mandate's leverage, ≤ 20 per day, never a margin-mode change on an open position (`:247-261`).

Phases (`live/mandate.ts:120-125`): `active`; `wind_down` for 24 h after revocation or expiry (cancels and reduce-only only); `ended`.

What an agent **can** do: place orders, cancels and leverage changes on the allowed instruments of one HL account, inside those
limits, through in-process code only — there is no HTTP route that places a mandate order (`live-routes.ts:53-54`,
`derivatives/mandate.ts:1-2`). What it **cannot** do: withdraw or transfer collateral (the trading key signs only L1 order / cancel /
leverage actions, `venue.ts:137-138`; a withdrawal is a main-key action with a passkey), trade sub-accounts or vaults, approve another
agent, exceed the exposure bound at signing time, act after the authorization is revoked.

`strategySha256` and `agentId` are checked by the **API** only (`exec.ts:1141`, `:1211`). A compromised API can therefore place any
order the mandate's numeric limits allow, whatever strategy was approved. The docs say so (`live/mandate.ts:47`).

### 4.7 GMX

No trading key and no mandate. One passkey per order through `/sign`. On top of the wallet policy, `gmxPrepare`
(`signer/venue-gmx.ts:80-111`) requires an active authorization for the pinned contract set, rebuilds the transaction
(`buildGmxTxs`: pinned ExchangeRouter / Router / OrderVault, receiver = cancellation receiver = the wallet, no callback, no UI fee, no
swap path, no referral code — `live/gmx.ts:273-280`, `:362-383`) and applies `gmxPolicyVerdict` with the signer's own prices
(`live/gmx.ts:494-512`): market allowed, execution fee ≤ ceiling, acceptable price within the band, and for an increase: size ≤
`maxOrderSizeUsd` and size ≤ `maxLeverage ×` the collateral sent. Daily counts: increases ≤ `maxOrdersPerDay`, decreases + cancels ≤ 100.
A plain transfer to a pinned GMX contract is refused (`venue-gmx.ts:69-72`).

The signer does **not** verify contract bytecode (it has no RPC access): the code-hash pin check is done by the API
(`gmx-chain.ts:74-106`, before every prepare `gmx-exec.ts:150-151` and before relaying `:570-572`). The signer only pins *addresses*.
A compromised API can skip the bytecode check, but cannot change the addresses or the calldata.

---

## 5. Risk controls: what exists, where, and gaps

### 5.1 Where each control is enforced

| Control | Web | API | Signer |
|---|---|---|---|
| Order notional limit | display | `risk.ts:219`; `exec.ts:457-460` | HL manual `venue.ts:176`; mandate `venue-mandate.ts:212`; GMX increase `gmx.ts:505` |
| Position limit per instrument | display | `risk.ts:223` (positions only; resting orders not counted, `risk.ts:29`) | **mandate only** (`venue-mandate.ts:238-239`). Manual HL: none. GMX: none. |
| Gross exposure limit | display | `risk.ts:221` | **mandate only** (`venue-mandate.ts:240`) |
| Leverage limit | display | account leverage after the order `risk.ts:217`; leverage setting `exec.ts:749` | HL setting ≤ authorized (`venue.ts:202`); mandate also refuses orders while the venue's setting is higher (`venue-mandate.ts:237`); GMX per increase (`gmx.ts:509`) |
| Loss limits | — | daily and total, realised (stored fills − fees + funding) + unrealised (`risk.ts:262-266`, `exec.ts:422-430`). Defaults 5 % and 20 % of `maxGrossExposure` (`exec.ts:119`). **GMX: disabled** — both set to 1e9 and usage passed as `'0'` (`gmx-exec.ts:359`, `:364`) | mandate: `floorEquity` on the venue's account value (`venue-mandate.ts:232`). Manual HL and GMX: none. |
| Liquidation estimate | shown | pre-trade distance check, single-position approximation for cross (`risk.ts:234-259`, `margin.ts`); min distance 1000 bps HL (`exec.ts:119`), 200 bps GMX (`gmx-exec.ts:359`). HL preview returns `liquidationPrice: null` (`exec.ts:469`); GMX shows an estimate (`gmx-exec.ts:333`) | none |
| Slippage control | input | market order needs a worst price (`risk.ts:158`); default 50 bps, max 500 (`paper.ts:28-29`); deviation vs mark (`risk.ts:171`), capped at 300 bps for live HL (`exec.ts:115`); GMX `slippageBps` 1..500 → `acceptablePrice` (`gmx-exec.ts:85`, `:294`) | price band vs the signer's own mid on every HL order and GMX acceptable price |
| Price freshness | "stale" badges | ticker and book ≤ `maxDataAgeMs` (5 s live HL, `exec.ts:114`; `risk.ts:152-153`); live orders read market data now, never from cache (`live-venue.ts:72-77`); data cache bounds `data.ts:15-24`; GMX market data ≤ 30 s (`gmx-exec.ts:290`) | own prices: Coinbase quote ≤ 180 s old, both sources within 1 %, 15 s cache (`prices.ts:14`, `:28`, `:61`); venue read ≤ 30 s (`venue-mandate.ts:109`) |
| Inconsistent-data detection | — | mark vs index (`risk.ts:172-176`); pinned asset table vs live `meta` before every proposal and approval (`live-venue.ts:78-81`, `hl-assets.ts:40-51`); venue vs wallet records → `divergence` halt (`exec.ts:913-942`); GMX on-chain vs API positions (`gmx-exec.ts:178-184`), `OrderCreated` vs plan (`:652`), pins (`gmx-chain.ts:74-106`) | mandate: duplicate positions, Σ position values vs the venue total, venue valuation vs own price (`venue-mandate.ts:110-139`); two price sources must agree |
| Order rate | — | per minute and per day (`risk.ts:271-272`) | per day (all), per hour and daily turnover (mandate) |
| Kill switch | buttons | per account: `halt` (new exposure stopped, reduce-only passes), `cancel-all`, `close`, `resume` (`exec.ts:789-856`); automatic divergence halt; perp agent pause/stop (`agents/perp-live-cycle.ts`) | global `halted` flag (`signer.ts:408-412`); revocations |
| Read-only mode | — | `mode: 'READ_ONLY'` per HL account, the default (`exec.ts:122-123`, `:181-182`; `risk.ts:141`); env locks | absence of an authorization |
| Exposure per asset / per protocol | — | per instrument and per venue account only | per instrument (mandate) |
| Collateral concentration | — | **none** | **none** |

Nothing is enforced by the web app alone: it only displays what the API computed.

### 5.2 Gaps against the target list

1. **Position limits:** in HL manual mode and on GMX they are API-only; the signer bounds one order at a time. Resting orders are
   ignored by the API risk engine (`risk.ts:29`), so several resting limit orders can together exceed `maxPositionNotional`. Only the
   mandate path counts them.
2. **Leverage limits:** present. GMX leverage is checked at entry per increase; nothing re-checks it as collateral erodes.
3. **Loss limits:** API-only except the mandate's `floorEquity`. They are pre-trade gates: a breach refuses new orders, it does not
   cancel or close anything (the perp-agent engine does, for its own account). Realised PnL counts only fills stored since the
   authorization (`fillsCursor = now` at approval, `exec.ts:367`). **GMX has no loss limit at all.**
4. **Exposure per asset / protocol:** no cross-account, cross-venue or wallet-wide view. BTC long on HL and BTC long on GMX are two
   unrelated limits. Paper, HL-testnet and HL-mainnet accounts are independent. No aggregation with spot holdings.
5. **Collateral concentration:** absent. Nothing limits the share of wallet value sitting on one venue or in one position. The only
   brake is the wallet policy's per-transfer / daily USDC cap on the deposit itself.
6. **Liquidation estimate:** pre-trade only, approximate, HL preview does not display it; no monitoring of the live distance to
   liquidation, no alert rule in this scope (alerts were not audited here).
7. **Slippage control:** present on both venues, at both layers.
8. **Price freshness:** present. Weak point: Kraken quotes carry no timestamp (`prices.ts:33-41`), so their staleness is only caught
   through the 1 % disagreement test; USDC is priced from Kraken alone (`prices.ts:45`).
9. **Inconsistent-data detection:** good on the mandate path and for HL divergence. In HL manual mode the signer trusts nothing but
   also checks nothing about the account. No cross-venue price sanity check on the API side beyond mark vs index.
10. **Global kill switch:** two partial ones, neither is "stop everything safely":
    - signer `halt` is global and one-way (un-halt = CLI + daemon restart, `main.ts:49-54`), and it also blocks **manual** risk
      reduction: HL manual reduce-only orders (`venue.ts:159`), GMX decreases and cancels (`policy.ts:107`), HL withdrawals
      (`venue-collateral.ts:55`). Under halt only HL cancels and mandate reduce-only orders are still signed.
    - API `halt` is per HL account only; no API-wide switch; GMX has none (`policy.halt: null`, `gmx-exec.ts:357`).
    - No single action cancels all orders and flattens all venues.
11. **Read-only mode:** per HL account only. No global or per-session read-only mode; no "API key can read but not trade" notion (section 7).
12. Not on the target list but missing: no automatic cancel of resting orders before an authorization expires (after expiry nothing
    can cancel them without a new passkey-approved authorization; `venue.ts:127`), no dead-man switch (`scheduleCancel` is not built),
    no maximum position age, no funding-cost limit.

---

## 6. Findings

Severity is for a wallet meant to trade real funds. Each item was confirmed by reading the cited code unless marked otherwise. None
was reproduced by running code (tests and builds were out of bounds).

### High

**B-01 — The emergency halt blocks manual risk reduction, and cannot be lifted from the app.**
`signer/venue.ts:159` refuses every manual HL order under halt, reduce-only included; `packages/core/src/policy.ts:107` refuses GMX
decreases and cancels; `signer/venue-collateral.ts:55` refuses withdrawals to the owner's own address. The test
`services/isolated-signer/test/venue.test.ts:316` pins this as intended ("emergency halt stops orders and leverage changes; cancels
are still signed"). The mandate path does the opposite and keeps reduce-only alive (`venue-mandate.ts:222-225`). Result: after
pressing "Emergency halt" with a manual position open, the owner cannot close it or withdraw until someone runs the CLI on the signer
machine and restarts the daemon (`main.ts:49-54`, `docs/runbooks/operations.md:10-11`). In a fast market that is a liquidation risk
created by the safety control.

**B-02 — Switching a mainnet env lock off disables the ways out.**
`exec.ts:180` returns `mainnet_disabled` for `what === 'stop'` too, so `cancelOrder` (`:727-728`) and `cancelAll` (`:815-816`) are
refused, and `trading.ts:316` would refuse the submission anyway. Mandate reduce-only orders and leverage changes are refused by
`mandateLock` (`exec.ts:980-985`, `:1136`). GMX: `gate()` (`gmx-exec.ts:143-144`) blocks `prepareClose`, `prepareCancel` and `approve`,
and `advanceSend` (`:559`) fails an already signed transaction — including a close. The locks are documented as "easy to forget" on
restart (`docs/runbooks/deploy.md:30-40`): a routine `pm2` restart without the variables leaves open mainnet positions and resting
orders that the wallet can no longer cancel or close.

**B-03 — Production may be configured for mainnet trading on code paths never exercised on a funded account.**
`docs/runbooks/deploy.md:49` gives `deriv_live_mainnet=on deriv_mandate_mainnet=on` as the expected start-up line, while
`docs/v4/venues/hyperliquid.md:318`, `:422-424`, `docs/v6/DERIVATIVE-MANDATE.md` §7 and `docs/v7/PERP-AGENT-LIVE.md:95-105` state that
no order was ever accepted by the venue on a funded account, on testnet or mainnet. The fill, partial-fill, `userRole`, leverage
confirmation, divergence and "never placed" logic rest on a fake exchange. The actual production environment was **not verified**.

### Medium

**B-04 — An authorization can be orphaned on the signer, locking the venue account for up to 90 days.**
`exec.ts:342` clears `pending` before calling the signer; `:343` calls `venueAuthorize`. If the signer stores the authorization but
the answer is lost (15 s client timeout `signer-client.ts:24`, crash, relay drop), the API keeps the account `READ_ONLY` with no
`authorization_id`. A new attempt is refused by the signer: "another authorization is active for this venue account: revoke it first"
(`signer/venue.ts:71-73`). The API can only revoke an id it stored (`exec.ts:383`); `LiveSignerPort.status` does not read the signer's
`venues` list (`exec.ts:44`), and the signer CLI has no revoke command (`main.ts:86`). The same shape exists for derivative mandates
(`exec.ts:1049-1056` marks `failed` on any error, `venue-mandate.ts:76-78`) and GMX is immune only because `revoke()` walks the
signer's own list (`gmx-exec.ts:276-280`). Read, not run.

**B-05 — The signer journal grows without bound and is rewritten in full on every request that logs.**
`store.ts:15` keeps `journal: AuditRecord[]` inside `state.json`; `prune()` (`:80-99`) never trims it; `save()` (`:75`) serializes the
whole state and fsyncs; every denial logs and saves (e.g. `venue.ts:125`, `venue-mandate.ts:156`, `signer.ts:420-424`). A mandate agent
(up to 500 orders a day plus cancels and reduce-only orders with no count limit) and, worse, a compromised API sending requests that
are denied, make each signature progressively slower; all requests are serialized (`server.ts:36`), and `verifyAuditChain` runs over
the whole journal at start (`main.ts:72`). Availability of the only signing component degrades with use.

**B-06 — CLI commands mutate `state.json` under a running daemon with no lock.**
`main.ts:49-60` (`halt`, `unhalt`, `reset-passkeys`, `setup-token`) open the store, change it and save. The daemon holds its own copy
in memory and overwrites the file at its next `save()`, silently undoing the CLI change and dropping the CLI's journal record, unless
the daemon is restarted first. The runbook chains `halt && pm2 restart` (`operations.md:10`), which leaves a window; a CLI `halt`
without the restart is lost at the next signed request. Read, not run.

**B-07 — Stop-loss and take-profit orders can only be placed close to the market.**
The signer requires both the limit price **and the trigger price** to be within `maxPriceDeviationBps` of its own mid
(`signer/venue.ts:184-186`; mandate `venue-mandate.ts:218-220`). The band is capped at 2000 bps (`live/canonical.ts:19`) and is the
same number that bounds slippage, so an owner who picks a prudent 100-300 bps band cannot place a stop 5 % away. The API risk engine
does not warn: it compares a trigger order's price with its trigger, not with the mark (`risk.ts:169-171`), so the refusal appears
only at the signer after the passkey prompt (`exec.ts:594-600`). Protective orders are therefore the hardest orders to place.

**B-08 — API-only risk limits can be loosened by a session, without a passkey, and they also govern mandate orders.**
`setPolicy` (`exec.ts:403-418`) bounds six fields by the authorization; `maxDailyLoss`, `maxTotalLoss`, `minLiquidationDistanceBps`,
`minFreeCollateral`, `maxDataAgeMs`, `maxMarkIndexBps`, `maxDeviationBps` and `maxOrdersPerMinute` are free (`RiskPolicySchema` only
requires non-negative values, `risk.ts:44-67`). `mandatePolicy` (`exec.ts:1101-1106`) starts from this account policy, so a stolen
session cookie can remove the loss limits under which the autonomous agent trades; only the signer's `floorEquity` remains. `resume`
(`exec.ts:804-811`) lifts an owner halt the same way. By design for a single owner, but it means every loss limit except one is
advisory against the threat the signer is built for.

**B-09 — In manual mode and on GMX, position, exposure and loss limits do not exist at the signer.**
Stated in the code (`live/canonical.ts:51-55`, `signer/venue.ts:175`). A compromised API plus approved passkey prompts (the review
screen is rendered by the same API, `docs/adr/0001-custody.md` "Residual risk") is bounded per order, per day and by the price band
only: `maxOrdersPerDay × maxOrderNotional` of exposure per day on HL; `maxOrdersPerDay × maxOrderSizeUsd` on GMX, further limited by
the wallet's USDC caps. `maxPositionNotional` and `maxGrossExposure` are part of the passkey-approved authorization and look
signer-enforced to the owner, but are not.

**B-10 — GMX orders run with the loss limits switched off and a risk policy invented in the API.**
`gmx-exec.ts:357-359`: `maxDailyLoss` and `maxTotalLoss` = `'1000000000'`; `usage.realizedToday/realizedTotal = '0'` (`:364`);
`maxGrossExposure = 3 ×` and `maxPositionNotional = 2 × maxOrderSizeUsd` are constants the owner never saw or approved; `halt: null`.
There is no GMX kill switch, no divergence detection against positions opened elsewhere, and no stored PnL.

**B-11 — No state-transition guard and no history for derivative orders.**
`setOrder` (`exec.ts:555-564`) and `GmxService.set` without `from` (`gmx-exec.ts:113-118`) write any state. There is no check
constraint (`db.ts:134`, `:197`). `rejected` and `cancelled` each carry four to six different causes (section 3.3), HL has no `FAILED`,
and an order the venue forgot stays `unknown` and non-final forever (`exec.ts:657-658`) while still counting against the order rate
(`exec.ts:427-428`). Audit writes are best-effort (`exec.ts:163-165`): an order can be signed and sent with no audit record.

### Low

**B-12 — Documentation contradicts the code on the central security claim.**
`docs/adr/0001-custody.md` ("every signature requires a fresh WebAuthn assertion"; "the signer can only express two transaction shapes
per chain … there is no message-signing … endpoint") and `docs/threat-model/threat-model.md` row 19 ("no code path signs without a
passkey assertion") are no longer true: see the list at the end of 4.2, plus swaps, bridges, typed-data signing and plugin chains.
`docs/security/acceptance.md` still describes "mainnet only". `signer/server.ts:21` still says "Narrow HTTP surface: status, enroll,
sign, halt" above 24 routes.

**B-13 — Stale and inconsistent mode vocabulary.**
`validateVenueAuthorization` rejects `MANDATE_LIVE` with "is not part of this delivery" (`live/canonical.ts:105`) although mandates
ship; the schema keeps the value "so that it can be refused by name" (`:75-76`). `ACCOUNT_MODES` has four values (`risk.ts:37`), the
account row two (`exec.ts:73`), the API answers a `modes` array (`exec.ts:1000`), and GMX has its own literal (`live/gmx.ts:450`).

**B-14 — `Capabilities` misreports trading** (section 2.2): GMX `orders: false` (`venues/gmx/adapter.ts:31`) and router `WALLET.gmx.trading = 'none'`
(`route.ts:44`) while GMX orders exist; a consumer that trusts `capabilities` gets the wrong answer.

**B-15 — After revocation or expiry of an HL authorization, resting orders stay on the venue with nothing able to cancel them.**
`signer/venue.ts:126-127` signs nothing, cancels included; the API only warns (`exec.ts:398`). Expiry is silent: no pre-expiry
cancel-all, no alert in this scope. The venue-side API wallet also remains approved until its `valid_until` (the wallet never sends a
de-registration). By design, but it is an operational trap.

**B-16 — Replay cache of the signer's HMAC nonces is in memory** (`server.ts:24`): after a signer restart, a request captured in the
last 60 s can be replayed once. Content-level protections (proposal id, venue nonce, client id) make it harmless for signatures;
`/halt` and revocations are idempotent. The allowlist is optional and empty by default (`main.ts:82`).

**B-17 — Vault return endpoints sign without a passkey, without a halt check and without an amount limit** (`signer.ts:188-244`).
Destination is fixed to the owner's own address, so the worst case is gas burnt from the vault (≤ `maxFee` per call, unlimited calls). Stated in the code comment (`:214-218`).

**B-18 — Price sources.** Kraken has no freshness check; USDC relies on Kraken alone (`prices.ts:33-45`). `gmxPolicyVerdict` and
`checkOrderPrice` convert floats (`live/gmx.ts:501`, `:507`; `core/mandate.ts:99-108`) — comparison only, never amounts.

**B-19 — `partially_filled` is both a live and a terminal state** (`exec.ts:664-669`), distinguishable only by `final`; `orderView.source`
(`:200`) labels a terminal partially-filled order as venue-sourced but any consumer switching on `state` alone will treat it as still working.

### Dead or unused code

- `HyperliquidAdapter.loadTrading()` (`venues/hyperliquid/adapter.ts:98`) — no caller.
- `createHlNonceSource` (`trading.ts:62-65`) — no caller; nonces come from SQL (`exec.ts:166-169`).
- `gmxAuthorizationHashHex` (`live/gmx.ts:475`) — no caller.
- `GMX_PINS.simulationRouter` (`live/gmx.ts:66`) — referenced nowhere else in `packages/`, `services/`, `apps/`.
- `DelegatedSigner` interface (`signer.ts:563-569`) — no implementer or consumer besides the class itself.
- `VenueAdapter.trading?` and `VenueTrading` as an interface (`packages/derivatives/src/venue.ts:31`, `:36-43`) — the live engine bypasses both.
- `orderHistory()` on the three adapters — not called by the API service.
- HL and dYdX account streams — implemented, refused by the registry (`venues.ts:57`), unused by the live engine.
- `deriv_orders.status` for live rows — duplicated by `state` (`exec.ts:556`).

### Claims checked and found correct

- The signer signs only what it has read itself: typed data must equal the hash of the action (`trading.ts:218-222`), field order is
  enforced (`:96`, `:191-192`, `:229`), unknown action types are `other` and refused (`:251-253`; `venue.ts:138`).
- Counters, replay markers and nonces are saved before a signature is returned (`venue.ts:210-216`, `venue-mandate.ts:263-273`, `signer.ts:542-552`).
- No HTTP route places a mandate order (`live-routes.ts`, all routes read; `perp-routes.ts:177-222` expose prepare/approve/pause/resume/stop only).
- GMX: no field of the intent can carry another receiver, callback, UI fee, swap path or referral code (`core/src/intent.ts:78-89`, strict object; `live/gmx.ts:273-280`).
- Withdrawals and vault returns can only pay the owner's own address (`venue-collateral.ts:57-58`, `live/collateral.ts:193`; `signer.ts:201`, `:233`).
- The pinned HL asset tables match the venue today (section 1.5).

### Not verified

- Anything requiring execution: test results, the fork scripts, the testnet proofs' replay.
- The production environment values, the signer's `policy.json` in production, `SPW_SIGNER_ALLOW_IPS`, whether any authorization or mandate exists there.
- GMX pinned bytecode hashes against Arbitrum today (no RPC call was made).
- Venue behaviours the code relies on: HL rejecting an action after `expiresAfter`, info-endpoint lag, `orderStatus` retention of old orders.
- The web app's rendering of approval screens (out of scope; another part of the audit).
- `packages/derivatives/src/{margin,router,paper,decimal}.ts` were skimmed for interfaces, not reviewed line by line.

---

## 7. Authentication today, and where an API-key layer would hook in

### 7.1 How requests are authenticated

- **One principal: the owner.** WebAuthn passkey login (`services/api/src/auth.ts:92-110`), user verification required, discoverable
  credentials (`allowCredentials: []`). First passkey needs the signer's one-time setup token (`:78-89`).
- **Session:** 32 random bytes in an HttpOnly, Secure, SameSite=Strict cookie (`__Host-spw` over HTTPS), stored hashed in `sessions`;
  30 min idle, 12 h absolute (`auth.ts:13-14`, `:33-45`). `isAuthed` is the only check, and it yields a boolean, not an identity.
- **One global hook:** `app.addHook('onRequest', …)` at `server.ts:104-122`: security headers; for `/api/*`: the runner bypass, then
  CSRF (`Origin` must equal `config.origin` **and** header `x-spw-csrf: 1` on every non-GET, `:117-120`), then
  `PUBLIC.has(path) || isAuthed(req)` (`:121`; `PUBLIC` at `:38`).
- **No authorization layer:** no roles, no scopes, no per-route `preHandler`, no `app.decorate` / `decorateRequest` anywhere in
  `server.ts`. A valid session can call every route. What stops a session from moving funds is the signer's passkey requirement, not the API.

### 7.2 Machine-to-machine auth

Exactly one exists: the **research runner**. Paths under `/api/v1/research/runner/` skip the session and CSRF checks and go through
`runnerGate` (`server.ts:115`; `research/routes.ts:32-42`): `POST` only, `Authorization: Bearer <SPW_RESEARCH_RUNNER_SECRET>` (≥ 32
chars, constant-time compare), plus a per-job token in `x-spw-job-token` (`:176-182`). One static shared secret, no rotation, no
scope beyond the path prefix, no per-key identity. There is **no API-key table, no key issuance, no HMAC-signed client requests** on
the API. (The API → signer HMAC of section 4.1 is service-to-service, not client auth.)

Perp agents are not API clients: they run inside the API process and call `derivatives/mandate.ts` directly.

### 7.3 Rate limiting

`@fastify/rate-limit` registered globally, 240 requests per minute (`server.ts:102`), default key = client IP (with
`trustProxy` from `SPW_TRUST_PROXY`, `:100`, `config.ts:10`); 10 per minute on the auth routes through route config
(`auth.ts:65`). In-memory store, per process. SSE streams are capped by counters (`live-routes.ts:16`, `routes.ts:15`). Outbound:
the HL adapter has its own weight budget (`venues/hyperliquid/http.ts`). The signer has no rate limit, only serialization.

### 7.4 Where a scoped API-key layer would attach

1. **Authentication:** in the existing `onRequest` hook, `server.ts:113-121`, as a third branch beside `runnerGate` and `isAuthed`.
   An API-key request has no `Origin`, so the CSRF test at `:117-120` must be skipped for it and only for it — and a request carrying
   a key must never also be accepted on cookie strength (keep the two principals exclusive, as the runner gate does).
2. **Identity:** introduce `app.decorateRequest('principal', null)` and set `{ kind: 'owner' | 'apiKey', keyId, scopes }` in that hook.
   Today nothing downstream knows who is calling; `audit(type, actor, …)` receives the literal `'owner'` in ~all call sites
   (`exec.ts:163`, `gmx-exec.ts:124`, `server.ts:244`, `:277`), so the actor must be threaded through.
3. **Authorization:** no seam exists. Either a `preHandler` per route registration function (`liveRoutes`, `gmxRoutes`,
   `collateralRoutes`, `derivativesRoutes`, `perpAgentRoutes` — each wraps handlers in a local `run()` helper, e.g.
   `live-routes.ts:31`, which is a natural place for a scope argument), or route `config: { scope: '…' }` read by one global
   `preHandler` hook (the pattern already used for `config.rateLimit`).
4. **Rate limiting:** `keyGenerator` on the existing plugin to key by API key instead of IP, and per-scope `config.rateLimit`.
5. **Storage:** a new table (hashed key, scopes, expiry, last use, revoked) next to `sessions`; nothing comparable exists in `db.ts`.

Constraints the design must respect, from sections 4 and 5:

- **The signer cannot see scopes.** It authenticates the API process only (4.1). Any scope is enforced by the API alone, i.e. it
  does not survive an API compromise. Scopes are an access-control convenience, not a custody boundary.
- **A key cannot produce a passkey assertion.** So a key can never complete a manual HL order, a leverage change, a GMX order, a
  deposit, a withdrawal, an authorization or a mandate approval. With today's signer, the only trading a key could do is (a) what
  needs no passkey: cancels, API halt/resume, revocations; and (b) orders under a **derivative mandate** — which would require adding
  the HTTP route that deliberately does not exist (`live-routes.ts:53-54`). That route would turn "only code inside the API process
  can trade without a passkey" into "any holder of a key with the trade scope can", inside the mandate's signer-enforced limits.
- Because the mandate's `strategySha256` / `agentId` are API-checked only (4.6), a per-key mandate would need the signer to bind
  something it can verify (for example a per-key signing secret, or one mandate per key with its own limits) if key scopes are meant
  to be more than advisory.
- Findings B-01, B-02 and B-08 interact with keys: a key with a "risk" scope could loosen API-only loss limits (`setPolicy`), lift an
  owner halt (`resume`), or trigger the one-way signer halt (`POST /api/v1/security/emergency-halt`, `server.ts:275-279`). These
  routes need explicit scope decisions, and "halt" should probably stay grantable while "resume" and "policy" should not.
