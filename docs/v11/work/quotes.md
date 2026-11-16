# V11 — Real-time quotation engine with WebSocket: work note

Branch `v11-quotes`, from the local branch `v11` at `dbd62f2`; the local `v11` of the end of the work (`8b489d7`) is merged in.
Written 2026-11-15 (the runs below are stamped 2026-11-16 UTC).
Scope: READ-ONLY public market data. The engine never places, signs or cancels anything; no production access, no production
change. Architecture and protocol reference: [`docs/V11-QUOTE-ENGINE.md`](../../V11-QUOTE-ENGINE.md).

Method: every figure below was produced by code of this branch — unit tests on scripted upstreams and on REAL frames recorded
from the venues, the real server with real websocket clients, a live read-only smoke, a local load test and a real browser.
The three live outputs are pasted in full at the end.

Per item: initial state / change / tests / observed result / limitation.

---

## 0. Before building: what was verified

| Question | Answer (2026-11-15) |
|---|---|
| `@fastify/websocket` in the lockfile? | No. Added `@fastify/websocket` 11.3.7 (peer of Fastify 5; the repository has 5.12.8), `ws` 8.22.2 (already in the lockfile as a transitive dependency; now direct, for the tests' client), `@types/ws` 8.18.2 — exact pins, `services/api/package.json`. |
| Does the Hyperliquid stream serve builder-dex coins? | Yes, live: `activeAssetCtx`, `bbo` and `trades` of `xyz:ANT` answer on `wss://api.hyperliquid.xyz/ws` with the coin written `dex:COIN`. Recorded: `services/api/test/fixtures/quotes/hyperliquid-ws.json`. |
| dYdX public websocket? | `wss://indexer.dydx.trade/v4/ws` is documented (https://docs.dydx.xyz/indexer-client/websockets) and answered live (`connected`, `v4_markets`, `v4_trades`). The adapter already had a client for it (`DydxStream`): used. |
| GMX public websocket / SSE? | None documented (https://docs.gmx.io/docs/api/overview/): REST polling. |
| Coinbase / Kraken public tickers? | Both answered live without authentication (`wss://ws-feed.exchange.coinbase.com` channel `ticker`; `wss://ws.kraken.com/v2` channel `ticker`). Coinbase added (one streamed source per symbol); Kraken not added. Recorded: `fixtures/quotes/coinbase-ws.json`. |
| Safari and `connect-src 'self'` for websockets? | CSP3 says `'self'` matches the page's own `ws`/`wss` origin; Safari ≤ 15.3 did not (WebKit bug 201591, closed as a duplicate of 235873). The CSP names the same-origin websocket origin explicitly. Chromium checked; Safari / iOS not run. |
| Caddy? | `reverse_proxy` tunnels websockets with no directive; `stream_timeout` has no default timeout; a config reload closes websockets unless `stream_close_delay` is set (documentation quoted in the engine document §11). Nothing changed in production. |

## 1. Quote hub

**Initial state.** No websocket to the browser; five SSE streams. `DerivData.subscribe` opened one upstream per instrument for
the Futures terminal's SSE stream (Hyperliquid, dYdX, edgeX through their adapters; GMX polled). Spot prices: CoinGecko, polled.
Private Markets: builder-dex coins polled every 20 s.

**Change.** `services/api/src/quotes/hub.ts` + `upstreams.ts` + `ws-client.ts`: ONE in-process hub. Channels
(`type|id|param`) and upstream feeds (`venue|kind|symbol`) are both reference-counted; a channel without listener is kept 10 s;
a quote is the merge of the parts its source sends (never a part invented); a book is a snapshot followed by deltas with a
contiguous sequence and a CRC-32 checksum, restarted from a snapshot after any gap or reconnection; one status per venue with
escalation to `down` after 30 s; bounds on channels, feeds and new upstream subscriptions per minute. Upstreams: Hyperliquid on
the hub's own connection (`createHlStream`, extended with `bbo` and `candle`), edgeX and dYdX through their adapters'
websockets, GMX polled through the data service, spot from Coinbase's websocket or the polled price module.

**Tests.** `services/api/test/quotes-hub.test.ts` (27 tests, no network): reference counting and idle grace; one upstream book
for two depths and the quote; merge without invention; hub conflation; snapshot → deltas → gap → snapshot with the checksum
verified by a client replay; trades de-duplicated and the history batch flagged; candle replacement; validation before any
upstream subscription; a venue that throws / a listener that throws / an upstream event that cannot be digested; channel, feed
and subscription-rate bounds; `close()`; venue status (reconnecting → down → connected, the others untouched) and staleness by
cadence. Then the REAL clients on a scripted socket replaying REAL recorded frames: Hyperliquid (BTC and `xyz:ANT`: quote,
book, trades, candle; drop → backoff → resubscribe → snapshot; silence → ping, stale, re-open), edgeX (ticker, 15-level depth
whose deltas rebuild the venue's book, trades), dYdX (markets, 154 recorded book deltas, trades; a crossed book is skipped),
GMX polling (one quote per fresh read, nothing on a last-good answer, `down` after three failures), Coinbase (ticker frames,
the venue's own time, a malformed frame dropped, backoff with jitter 500 ms then 2 s, resubscription, gap) and the polled
price module; the reconnecting client's watchdog.

**Observed (live smoke, §A).** Five venues connected in under a second; in 60 s on BTC: Hyperliquid 590 quotes, Coinbase 303,
edgeX 145, GMX 10, dYdX 5; the Hyperliquid book: 1 snapshot + 4 deltas, 0 sequence break, 0 checksum mismatch; the builder-dex
coin `xyz:ANT` subscribed; the unknown coin refused before any upstream subscription; 0 upstream reconnect, 0 gap, 0 error.

**Limitation.** Candles are streamed by Hyperliquid only (REST bars re-read every 10 s elsewhere). edgeX / dYdX quotes carry a
bid and an ask only while a book of that market is open in the hub. dYdX's market feed is sparse (5 quotes a minute on BTC).
Hyperliquid's `l2Book` came 5 times in the minute. GMX: a 3 s poll over the data service's 3 s cache gives a fresh read about
every 6 s. One process: no cross-process fan-out.

## 2. Normalised messages

**Initial state.** SSE events `ticker`, `book` (whole book each time), `trades`, `status`, in the adapters' shapes.

**Change.** `services/api/src/quotes/protocol.ts` (zod; the web client and the SDK tests import its types) and `shared.ts` (code
shared by value with the browser): `quote`, `book` (snapshot / delta, `seq` / `prevSeq`, `checksum`), `trade`, `candle`,
`status` (`connected | reconnecting | stale | down | idle`, `since`, `ageMs`), `heartbeat`, plus `hello`, `subscribed`,
`dropped`, `pong`, `error`. Decimal strings only. `venueTs` when the venue stamps, `recvTs` always. Staleness per source cadence,
computed by the server when the frame is built and re-evaluated by the client with its own clock and the venue's status.

**Tests.** Every message of the hub tests is parsed with its zod schema; `apps/web/test/quotes.test.ts` (freshness: live →
delayed → stale by age, the server's flag, a venue that is reconnecting, the age of a polled figure counted from the source's
own date); SDK drift tests (the SDK's message types are valid messages of the server's schema; the book vectors).

**Observed.** In the browser, cutting Hyperliquid turned its 35 rows « reconnecting » at once while the 15 rows of the other
venues on the same page stayed live (§C).

**Limitation.** `venueTs` is null where the venue gives none (Hyperliquid's asset context, edgeX's and dYdX's tickers and books,
GMX). A quote re-sent because an unstamped part moved keeps the stamp of its last stamped part in `venueTs`: it is the age of
that part.

## 3. WebSocket server

**Initial state.** None.

**Change.** `services/api/src/quotes/engine.ts`, `outbox.ts`; `server.ts`: the plugin before the routes, the single-use ticket
gate in the `onRequest` hook, the routes after the trading API, `connect-src`. `GET /api/v1/stream` (owner session + strict
`Origin`), `GET /api/v1/trading/stream` (Bearer key with `markets:read`, or ticket), `POST /api/v1/trading/stream/ticket`,
`GET /api/v1/stream/stats`. Authentication before the upgrade through the service's existing hooks (`apiKeyGate`,
`scopeGuard`); restrictions per subscription; limits (connections per principal, subscriptions, frame size, frame rate, idle);
protocol ping / pong with termination of dead peers; backpressure (conflation of quotes and books, dropped-trade notices,
high-water disconnect); credential re-check every 30 s and right after a logout or a key change (close 4001); graceful shutdown
(1001 + reason); counters in `/stream/stats` and in the monitor's health answer; structured logs.

**Tests.** `services/api/test/quotes-stream.test.ts` (14 tests; the real server on a local port, real `ws` clients, scripted
upstreams): no session → 401; wrong / look-alike / absent / `null` Origin → 403 before the upgrade; key on the browser route →
403; key without scope → 403; wrong key, key in the query string → 401; key + cookie → 403; ticket single use, expiry, mixed
credentials, wrong path, owner ticket; restricted venue / instrument per subscription with nothing opened upstream; snapshot on
subscribe with its age, second connection sharing ONE upstream, resubscribe = snapshot again, unsubscribe, ping; malformed JSON,
binary frame, wrong version, unknown op, unknown field, bad depth, unknown instrument, unsupported channel; too many
subscriptions, frame rate (refusals then close 4002), oversized frame (1009), connections per principal (429) and the slot
freed on close; a really slow consumer (socket paused while 6 000 bursts are pushed: quotes conflated, book restarted from a
snapshot with sequence and checksum intact, `delivered + dropped = 6 000` trades, the healthy client untouched); disconnect over
the high-water mark; heartbeat, dead peer, idle; logout closes that session's sockets within 150 ms, an expired session at the
next check, other sessions stay; key revocation by the owner route closes header and ticket sockets, an expired key at the next
check; shutdown 1001 with the upstream feeds released; stats and monitor figures, lag measured on venue-stamped updates only.
`quotes-outbox.test.ts` (5 tests): the outbox alone on a socket whose buffer the test controls.

**Observed (load, §B).** 50 connections × 100 subscriptions for 60 s: 5 000 subscriptions served by 156 hub channels and 226
upstream feeds; 574 866 frames sent (≈ 10 400 / s, 203 MB); API process 10.3 % of one core on average (7.2 – 19.7 % per 5 s),
RSS 188 → 212 MB (peak 215); 0 conflated, 0 trade dropped, 0 book resync, 0 sequence break seen by the clients, 0 abnormal
close; venue → client latency p50 357 ms / p95 560 ms on 34 370 venue-stamped frames (server-side lag p50 318 / p95 398 ms —
most of it is the age of the venue's stamp when the frame reaches this machine: Coinbase alone is p50 37 ms in the smoke).

**Limitation.** The existing test `trading-api.test.ts` asserted that the routes under `/api/v1/trading/` are exactly the
operations of the spec: the two streaming routes are now listed there as the documented exception (the OpenAPI document cannot
describe a websocket; `spec.ts` was not edited). A stream connection does not write a row in the key's usage log (the handshake
is hijacked before `onResponse`); it is counted in the stats and logged. Connection limits are per process.

## 4. Fallback

**Initial state.** SSE and polling were the only paths.

**Change.** Nothing was removed: every REST route and the five SSE streams still work. The web client reports `fallback` after
three failed connections and keeps trying slowly; screens keep their polling (slower while the stream is live, at their old
cadence otherwise); the Futures terminal re-opens its SSE stream in `fallback` and closes it when the socket is back.

**Tests.** `apps/web/test/quotes.test.ts` (three failures → `fallback`, first success → `live`, the source conventions: SSE
still in the store, `refetchInterval` conditional on the stream). Browser (§C): with the websocket refused, Markets shows
« Flux en direct indisponible — les prix sont relus périodiquement », 50 rows with their polled freshness, no live cell; the
terminal opened 1 SSE request and was `live`.

**Limitation.** The fallback is detected by failure (three attempts, ≈ 4 s), not announced by the server.

## 5. Web client

**Initial state.** Each screen polled; the terminal had its own EventSource per instrument.

**Change.** `apps/web/src/quotes.ts` (`QuoteClient` + hooks `useQuote`, `useQuotes`, `useBook`, `useTrades`, `useVenueStatus`,
`useConn`, `useFresh`, `useQuoteSubscriptions`), `quotes-ui.tsx` (`LiveDot`, `QuoteDot`, `LiveCell`, `LiveStatus`),
`quotes-spot.tsx` (`useLiveSpot`, `overlaySpot`, `LiveSpotTag`), i18n block `qt` (18 keys, two languages).

**Tests.** `apps/web/test/quotes.test.ts` (13 tests): lazy connection, one socket for every subscriber, linger; reconnect with
backoff + jitter (500 ms, then 2 s), resubscribe, a delta before the new snapshot is not applied, refused channels not asked
again; fallback; watchdog (37.5 s); visibility (paused after 30 s hidden, back at once); 3 000 messages on 150 markets = ONE
commit and one call per listener; book hole and checksum mismatch → resync; trades; freshness; helpers; the `qt` block
(contiguous, same placeholders, every key used, every used key present); the first chunk does not import the client.

**Observed.** First JS chunk 260.61 kB → 262.30 kB (gzip 80.03 → 80.61 kB), measured by building the web sources of `v11` and
of this branch with the same command. New chunks: `quotes` 10.5 kB (3.9 kB gzip), `quotes-ui` 6.4 kB (2.9 kB gzip).

**Limitation.** Component rendering is tested through the store and the listeners (the repository's web tests run without a
DOM), and in a real browser by the script of §C.

## 6. Screens

| Screen | Change | Clean swap? |
|---|---|---|
| Markets explorer | price, 24 h change and funding cells tick (`LiveCell`, flash off under reduced motion); freshness dot per row; stream + venue status line; listing polled every 30 s while live, 10 s otherwise | added over the listing, which stays the source of order, pages and volumes |
| Futures terminal | `MarketStore.open()` takes ticker, book and trades from the shared socket; the SSE stream is the fallback | **yes** — same slices, same commit loop, same freshness rule; the per-instrument EventSource is no longer opened while the socket is live (0 SSE request in §C) |
| Compare | mark, index and spread of the facts table tick; the cost table shows the live price under the price each estimate was computed on; « Recompute now » | the comparison itself is recomputed every 15 s as before or on demand — never per tick |
| Private Markets | list price, detail price, bid and ask tick for live contracts (Hyperliquid builder-dex coins and edgeX); polling 60 s while live, 20 s otherwise | added over the answer: valuation, references and candles stay server-computed at their cadence |
| Asset page, Home | streamed USD price over the polled one where Coinbase lists the symbol; « live » tag; in CAD the price is converted at the rate implied by the polled reading (tooltip says so) | added; without a streamed quote the polled CoinGecko price and its date are shown as before |

**Tests.** `apps/web/test/quotes.test.ts` (helpers `liveIdOf`, `livePriceOf`, `annualisedOf`, `liveSpreadBps`, `overlaySpot`;
conventions); the web suites (16 files, 287 tests, 13 of them new) pass; browser (§C).

**Observed (§C).** Markets: 50 rows, 150 live cells, the BTC price took 3 values in 8 s. Terminal: the mark price took 4
values in 8 s, book and trades drawn. Compare: 3 venues with a live price, recompute on demand. Private Markets: 8 live prices.

**Limitation.** Home and the asset page were not exercised in the browser run (the throw-away stack has no signer: the
portfolio answer needs one); their overlay is unit-tested. The streamed spot price is Coinbase's USD price; the CAD figure is
a conversion.

## 7. SDK streaming (new files only)

**Initial state.** The SDKs had no stream.

**Change.** `packages/trading-sdk/src/stream.ts` (`SPWalletStream`: header in Node, ticket in browsers, subscribe /
unsubscribe, callbacks + async iterator, reconnect / resubscribe, watchdog, typed messages, `OrderBook`; zero dependency) and
`sdk/python/src/sp_wallet/stream.py` (the same on asyncio). New test stack `packages/trading-sdk/scripts/stream-stack.mts`
(the real API with the real venue adapters on an own database; needs PostgreSQL only).

**Existing SDK files changed: two, both in `sdk/python`.** `pyproject.toml`: `[project.optional-dependencies] stream =
["websockets==16.0"]` and the same pin in the `dev` group (16.0 is the newest release that supports Python 3.10, the SDK's
floor; 17.x needs 3.11). `uv.lock`: regenerated by `uv lock` (uv 0.11.7) — `websockets` 16.0 added; one marker line of an
existing package changed (`typing-extensions`, `python_full_version < '3.13'` → `< '3.11'`). No generated file and no client
class was edited. The stream classes are NOT re-exported from `src/index.ts` / `__init__.py` (contract workstream): import
`…/src/stream.ts` and `sp_wallet.stream`.

**Tests.** TypeScript: `test/stream.test.ts` (8 tests, a local fake server in the process): header handshake, the key never in
the URL, ticket per connection (function, or asked from the API), refused credentials not retried, subscribe / acknowledge /
refuse, snapshot first, callbacks and `for await`, bounded buffer, backoff + jitter, resubscription, watchdog, 4001 final;
drift: the SDK's messages against the server's zod schema, `OrderBook` against the server's helpers on 200 random deltas.
`test/stream.integration.test.ts` (5 tests, the real local API stream): header and ticket connections, scope refusal, revoked
key, venue restriction, live Hyperliquid quotes and a book kept with its checksum. Python: `tests/test_stream.py` (9 tests, a
real local websocket server): the same list, plus the server's book vectors (`tests/fixtures/stream-vectors.json`, generated
from the server's code and pinned by a server-side test); `tests/test_stream_integration.py` (5 tests, the same real stack).

**Observed.** Python transcript of the integration run (2026-11-16 UTC):

```
[sdk-py-stream] narrow key connected: conn 66342fb7-34ed; venues hyperliquid=idle gmx=idle dydx=idle edgex=idle spot=idle
[sdk-py-stream] limited key: refused before the upgrade — HTTP 403 insufficient_scope
[sdk-py-stream] revoked key: refused before the upgrade — HTTP 401 unauthenticated
[sdk-py-stream] ticket connection: conn 74aa8d20-d3b0
[sdk-py-stream] hyperliquid:BTC mark 64850 bid None ask None (seq 1); book 1 message(s), best 64851 / 64852; 3 messages in 0.5 s; frames 8
```

**Limitation.** The shared stack of the existing SDK integration tests (`scripts/test-stack.mts`) fails at this base
(`POST /developer/keys/prepare → 422 mandate_not_found`, contract workstream), hence the dedicated stream stack. In a browser
or in Node the websocket API gives no HTTP status for a refused handshake: the TypeScript client reports `disconnected` after
three attempts when the stream never opened (through the ticket endpoint the refusal has its code); the Python client reads
the status and the code. In Node the header needs Node ≥ 22 (undici's `WebSocket`) or the `ws` package.

## 8. Tests — totals observed

| Suite | Result |
|---|---|
| `services/api/test/quotes-hub.test.ts` | 27 / 27 |
| `services/api/test/quotes-outbox.test.ts` | 5 / 5 |
| `services/api/test/quotes-stream.test.ts` | 14 / 14 |
| `apps/web/test/quotes.test.ts` | 13 / 13 (the web suites: 16 files, 287 tests, all passing) |
| `packages/trading-sdk/test/stream.test.ts` | 8 / 8 |
| `packages/trading-sdk/test/stream.integration.test.ts` | 5 / 5 (real local API, real venues) |
| `sdk/python/tests/test_stream.py` | 9 / 9 (7 functions, one parametrised ×3) |
| `sdk/python/tests/test_stream_integration.py` | 5 / 5 (real local API, real venues) |
| `pnpm typecheck` | exit 0 |
| **`pnpm test`, whole repository, once at the end** | **170 files: 168 passed, 2 failed — 4 001 tests: 3 999 passed, 2 failed** (134 s) |
| `ruff check` on `sdk/python` | all checks passed |
| `node scripts/build.mjs` + `vite build` | built; first chunk 262.30 kB |

The two failing files of the full run are those announced as belonging to the contract-resync workstream; what they assert is
in files this branch does not touch (not re-run on a checkout without this branch): `packages/trading-sdk/test/generated.test.ts` (2 tests: the generated types and the operation table
no longer match `docs/openapi/trading-v1.json`) and `packages/trading-sdk/test/integration.test.ts` (its stack cannot create its
keys: `POST /developer/keys/prepare → 422 mandate_not_found`). The Python SDK's existing `tests/test_models_drift.py` fails for
the same contract reason (6 tests, `KeyError: 'compareMarkets'` and model drift); the other 273 existing Python tests pass.
No flaky test failed in the final run (`api.test.ts › swap: quotes…` and `lab-identity.test.ts` passed).

One failure of the first full run was caused by this branch and fixed: `generated.test.ts › the built package` (the SDK's
declaration build has no `@types/node`, and `stream.ts` named `process`); it passes now.

### After merging the local `v11` as it stood at the end of the work (`8b489d7`, with `v11-exec2`, `v11-contract`, `v11-mm-core`)

`v11` moved three times during the work. It was merged into this branch (`91c0c12`); one conflict, in the test line named above:
the route / spec equality now lists both exceptions — the two streaming routes and the trading prefix's catch-all.

| Suite, on the merged tree | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| **`pnpm test`, whole repository** | **185 files: 183 passed, 2 failed — 4 344 tests: 4 342 passed, 2 failed** (144 s) |
| the two failures, re-run alone | both pass: `services/api/test/trading-contract.test.ts` 21 / 21 (21 s), `packages/trading-sdk/test/integration.test.ts` 22 / 22 (70 s) |
| Python SDK, `pytest -m "not integration"` | 359 passed (the contract drift tests pass on the merged tree) |
| Python stream tests | 14 / 14 |
| `vite build` | first chunk 262.35 kB (gzip 80.63 kB) |
| browser check (§C script) | all checks passed again |

The two failures of the merged full run were 30 s timeouts under the load of the whole suite (`trading-contract.test.ts ›
templates → create from a stream template…` and `integration.test.ts › getPortfolio / getBalances…`); neither is a file of this
branch, both pass alone. They are not in the list of known flaky tests given for this work.

## 9. Files touched outside the owned set

| File | Why |
|---|---|
| `packages/derivatives/src/venues/hyperliquid/stream.ts`, `schemas.ts` | `bbo` and `candle` subscriptions of the Hyperliquid websocket client (additive: two message types, two subscription types) |
| `services/api/src/auth.ts` | `sessionAlive(token)`: read-only session check for an open socket (the idle rule stays in one place) |
| `services/api/src/monitor/routes.ts` | `quotes` in the health answer |
| `services/api/test/trading-api.test.ts` | the two streaming routes named as the exception to « trading routes = operations of the spec » |
| `services/api/package.json`, `pnpm-lock.yaml` | `@fastify/websocket` 11.3.7, `ws` 8.22.2, `@types/ws` 8.18.2 |
| `sdk/python/pyproject.toml`, `sdk/python/uv.lock` | `websockets==16.0` (§7) |
| `apps/web/vite.config.ts` | `ws: true` on the dev proxy of `/api` |
| `apps/web/src/derivatives/store.ts`, `Compare.tsx`, `screens/Markets.tsx`, `PrivateMarkets.tsx`, `Home.tsx`, `Asset.tsx` | the screens of §6 |
| `docs/TRADING-API-ARCHITECTURE.md` | one paragraph pointing to the engine document |

Not touched: `services/api/src/{orders,risk,mandates}/**`, `screens/Risk.tsx`, `trading-api/{spec,read,openapi}.ts`, the
existing files of `packages/trading-sdk/**` and `sdk/python/**` other than the two above, `services/api/src/agents/**`,
`services/api/src/agent-runtime/**`, `main.ts`.

---

## A. Live smoke — `npx tsx scripts/smoke-quotes.mts --seconds 60` (real output)

```
quote engine smoke (read-only)  2026-11-16T03:55:49.897Z  api 127.0.0.1:55834  60 s
  markets: hyperliquid:BTC, edgex:BTCUSDC, dydx:BTC-USD, gmx:BTC/USD [BTC-BTC], spot:BTC

== subscriptions
  status|*| [—, snapshot 0 ms old]
  quote|hyperliquid:BTC| [hyperliquid-ws, no snapshot yet]
  quote|edgex:BTCUSDC| [edgex-ws, no snapshot yet]
  quote|dydx:BTC-USD| [dydx-ws, no snapshot yet]
  quote|gmx:BTC/USD [BTC-BTC]| [gmx-rest, no snapshot yet]
  quote|spot:BTC| [coinbase-ws, no snapshot yet]
  book|hyperliquid:BTC|20 [hyperliquid-ws, no snapshot yet]
  trades|hyperliquid:BTC| [hyperliquid-ws, no snapshot yet]
  trades|edgex:BTCUSDC| [edgex-ws, no snapshot yet]
  trades|dydx:BTC-USD| [dydx-ws, no snapshot yet]
  candle|hyperliquid:BTC|1m [hyperliquid-ws, no snapshot yet]
  quote|hyperliquid:xyz:ANT| [hyperliquid-ws, no snapshot yet]

== per venue (messages over the run; latency = client receive time − the venue's own timestamp)
  spot                               quotes 303  book 0  trades 0  candles 0  | latency p50 37 ms p95 129 ms (280 stamped) | stale flags 0 | first quote after 454 ms | coinbase-ws
  gmx                                quotes 10  book 0  trades 0  candles 0  | latency p50 — ms p95 — ms (0 stamped) | stale flags 0 | first quote after 471 ms | gmx-rest
  hyperliquid                        quotes 590  book 5  trades 439  candles 86  | latency p50 371 ms p95 552 ms (923 stamped) | stale flags 0 | first quote after 544 ms | hyperliquid-ws
  dydx                               quotes 5  book 0  trades 1000  candles 0  | latency p50 — ms p95 — ms (0 stamped) | stale flags 0 | first quote after 905 ms | dydx-ws
  edgex                              quotes 145  book 0  trades 98  candles 0  | latency p50 148 ms p95 207 ms (68 stamped) | stale flags 0 | first quote after 980 ms | edgex-ws

== order book integrity
  hyperliquid:BTC                    1 snapshot(s), 4 delta(s); sequence breaks 0; checksum mismatches 0; best bid 65093 / ask 65094

== venue status events
  +0.0s hyperliquid idle (stream, hyperliquid)
  +0.0s gmx idle (stream, gmx)
  +0.0s dydx idle (stream, dydx)
  +0.0s edgex idle (stream, edgex)
  +0.0s spot idle (stream, spot)
  +0.0s hyperliquid reconnecting (stream, hyperliquid-ws)
  +0.0s edgex reconnecting (stream, edgex-ws)
  +0.0s dydx reconnecting (stream, dydx-ws)
  +0.0s gmx reconnecting (poll, gmx-rest)
  +0.0s spot reconnecting (stream, coinbase-ws)
  +0.3s hyperliquid connected (stream, hyperliquid-ws)
  +0.4s spot connected (stream, coinbase-ws)
  +0.5s gmx connected (poll, gmx-rest)
  +0.7s dydx connected (stream, dydx-ws)
  +0.8s edgex connected (stream, edgex-ws)

== server (GET /api/v1/stream/stats)
  connections / subscriptions        1 / 12
  messages                           1410 sent, 21.8/s over the last 10 s, 602648 bytes
  backpressure                       conflated 0, trades dropped 0 (client saw 0), book resyncs 0
  lag venueTs → socket write         p50 333 ms, p95 475 ms (1028 stamped frames)
  upstream reconnects / gaps         0 / 0
    hyperliquid                      connected (stream), feeds 7, upstream messages 1003, reconnects 0, gaps 0, errors 0
    gmx                              connected (poll), feeds 1, upstream messages 10, reconnects 0, gaps 0, errors 0
    dydx                             connected (stream), feeds 2, upstream messages 6, reconnects 0, gaps 0, errors 0
    edgex                            connected (stream), feeds 2, upstream messages 219, reconnects 0, gaps 0, errors 0
    spot                             connected (stream), feeds 1, upstream messages 953, reconnects 0, gaps 0, errors 0
  heartbeats received                4
  errors                             unknown_instrument: unknown instrument 'hyperliquid:NOPE'
  socket                             open until the end

== outgoing HTTP requests (public market data only)
  GET arbitrum.gmxapi.io             22
  GET edgex-prod-v2.edgex.exchange   2
  GET indexer.dydx.trade             1
  POST api.hyperliquid.xyz           3
  trading / account endpoints        none
```

## B. Load test — `npx tsx scripts/smoke-quotes.mts --load 50x100 --seconds 60` (real output)

Machine: the development laptop (Apple Silicon), API and clients on the same host, clients in a child process.

```
quote engine smoke (read-only)  2026-11-16T03:56:52.465Z  api 127.0.0.1:56937  60 s
  markets: hyperliquid:BTC, edgex:BTCUSDC, dydx:BTC-USD, gmx:BTC/USD [BTC-BTC], spot:BTC
  load: 50 connections × 100 subscriptions for 60 s — quotes over a pool of 150 markets of hyperliquid / edgex / dydx; connection 0 also takes 3 books and trade feeds. Clients in a child process.

== load result
  API process                        CPU 10.3 % of one core on average; per 5 s: min 7.2 % max 19.7 %
  memory (RSS)                       before 188 MB, after 212 MB, peak sample 215 MB
  connections / subscriptions        50 / 5000; hub channels 156, upstream feeds 226
  frames received by the clients     596673 (min 8172 / max 21037 per connection); server: 574866 sent, 10409.9 msg/s over the last 10 s, 203.5 MB
  conflated / trades dropped         0 / 0 (clients saw 0 dropped); book resyncs 0; book sequence breaks seen by clients 0; slow consumers closed 0
  venue → client latency (stamped)   p50 357 ms, p95 560 ms over 34370 frames; server-side lag p50 318 ms p95 398 ms
  upstream                           hyperliquid connected feeds 142 msgs 13548 reconnects 0 gaps 0; gmx idle feeds 0 msgs 0 reconnects 0 gaps 0; dydx connected feeds 37 msgs 10931 reconnects 0 gaps 0; edgex connected feeds 47 msgs 4200 reconnects 0 gaps 0; spot idle feeds 0 msgs 0 reconnects 0 gaps 0
  errors / abnormal closes           none / none

== outgoing HTTP requests (public market data only)
  GET arbitrum.gmxapi.io             2
  GET edgex-prod-v2.edgex.exchange   2
  GET indexer.dydx.trade             1
  POST api.hyperliquid.xyz           1
  trading / account endpoints        none
```

## C. Browser check — `npx tsx tests/e2e/v11-quotes-live.mts` (real output, Chromium, the built app, real venues)

```
quote engine in the browser  2026-11-16T03:57:54.104Z  http://localhost:57321

== Markets explorer (websocket live)
  ok   one websocket to the same origin, no CSP violation — ws://localhost:57321/api/v1/stream
  ok   rows carry live cells — 50 rows, 150 live cells (price, change, funding)
  ok   the BTC price ticks (8 s of observation) — 3 distinct values: 65 113,4 | 65 113,0 | 65 115,0
  ok   freshness dots say « live » — {"live":45,"delayed":5}

== the Hyperliquid upstream is cut
  ok   the venue is named as reconnecting — Hyperliquid · reconnexion · 0 s
  ok   every Hyperliquid row says « reconnecting » (none « live »); the rows of the other venues on the same page stay live; so does the tab's connection — 35 Hyperliquid rows: ["reconnecting"]; 15 other rows: {"reconnecting":35,"live":13,"delayed":2}
  ok   another venue keeps ticking meanwhile (edgeX rows) — {"live":50}
  ok   back by itself after the cut: the tag is gone

== Futures terminal (hyperliquid:BTC)
  ok   the mark price ticks from the shared socket — 4 distinct values
  ok   order book and trades are drawn
  ok   no SSE stream was opened while the socket is live — 0 request(s) to /derivatives/stream; websockets opened by the tab: 2

== Compare and Private Markets
  ok   the comparison shows the live price next to the one it was computed on — 3 venues with a live price
  ok   « recompute now » re-reads the comparison on demand — total before: 1,06 $ 10,62 pb
  ok   private markets: contracts tick from the venue streams (builder-dex coins and edgeX) — 8 live prices; dots {"live":8}
  server: 1 connection(s), 9 subscriptions, 3123 frames sent, conflated 0, upstream reconnects 1, lag p50 333 ms p95 507 ms

== a browser whose websocket is refused (corporate proxy)
  ok   the state says so and the rows keep the polled figures with their own age — 50 rows, 50 polled freshness marks; « Flux en direct indisponible — les prix sont relus périodiquement »
  ok   the terminal falls back to its SSE stream and stays live — 1 SSE request(s); freshness live

all checks passed — screenshots in test-results/v11-quotes/
```

Screenshots: `test-results/v11-quotes/` (not committed).
