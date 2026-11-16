# V11 — Real-time quotation engine

Live public market data — quotes, order books, trades, candles, venue status — pushed over a websocket to the wallet's web app
and to API clients. Written 2026-11-15, branch `v11-quotes`. Work note with the measured runs: `docs/v11/work/quotes.md`.

**Read-only.** The engine subscribes to PUBLIC market-data feeds and fans them out. It holds no account, no key and no signer;
`services/api/src/quotes/` imports neither the signer client nor a venue's trading object. Nothing in it can place, sign or
cancel anything.

**No production change was made.** Everything below was built and run locally.

Contents: 1 architecture · 2 upstream sources · 3 endpoints and authentication · 4 protocol · 5 limits · 6 backpressure ·
7 web client · 8 SDKs · 9 failure modes · 10 metrics and logs · 11 deployment notes · 12 for the agents' stream engine · 13 limits of this version

---

## 1. Architecture

```
 venues (public feeds)                      API process (services/api/src/quotes)                     clients
 ────────────────────                       ─────────────────────────────────────                    ───────
 Hyperliquid  wss ──┐   upstreams.ts        hub.ts                     engine.ts + outbox.ts
 edgeX        wss ──┤   one Upstream  ───▶  Feed (venue|kind|symbol) ─▶ Chan (type|id|param) ─▶ Conn ─▶ browser  GET /api/v1/stream
 dYdX         wss ──┤   per venue           reference-counted            reference-counted        │      (session cookie + Origin)
 GMX         REST ──┤   (reconnect,         merge, seq, checksum,        last value, snapshot     ├────▶ API key  GET /api/v1/trading/stream
 Coinbase     wss ──┤    heartbeat,         venue status                                          │      (Bearer header or ticket)
 CoinGecko   REST ──┘    resubscribe)                                                             └────▶ another module of the process: hub.subscribe()
```

| File | Role |
|---|---|
| `protocol.ts` | The wire protocol as zod schemas (version 1). The web client and the SDK tests import its TYPES. |
| `shared.ts` | Code shared by value with the browser (no import): book checksum (CRC-32), delta apply / diff, decimal compare, channel key, backoff, close codes. |
| `hub.ts` | `QuoteHub`: channels and upstream feeds, both reference-counted; merge of quote parts; book snapshot / delta; venue status; bounds. |
| `upstreams.ts` | One `Upstream` per venue: Hyperliquid, edgeX / dYdX / GMX through the derivatives registry, spot (Coinbase + the price module). |
| `ws-client.ts` | A reconnecting websocket CLIENT (backoff + jitter, liveness watchdog) — used for Coinbase. |
| `outbox.ts` | Per-connection backpressure: conflation, dropped-trade counter, high-water disconnect. |
| `engine.ts` | `QuoteEngine`: the websocket server (`@fastify/websocket` 11.3.7 on Fastify 5.12.8), authentication gate, tickets, limits, liveness, credential re-checks, stats. |
| `index.ts` | `installQuotes` (wiring used by `server.ts`), `quoteHub()`, `quoteSummary()`. |

**Reference counting, two levels.** A *channel* (`quote|hyperliquid:BTC|`, `book|hyperliquid:BTC|10`) is opened by its first
listener and shared by the next ones. A channel needs one or more upstream *feeds* (`hyperliquid|ticker|BTC`,
`hyperliquid|bbo|BTC`); a feed is opened by the first channel that needs it (a book at depth 5 and a book at depth 20 share
ONE upstream book feed) and closed with the last. A channel without listener is kept `idleGraceMs` (10 s) before its feeds are
released: changing page does not cost a venue subscription. Nothing is connected upstream until something is subscribed.

**Never a fabricated price.** A quote is the newest fields its source sent, merged. A field the source does not publish is
`null`. `mid` is the mid of the two sides when the source gives both, else the venue's own mid, else `null` — never one side of
now with the other side of earlier, never a figure from another venue. A malformed upstream frame is dropped and counted; it
never produces half a quote. When a venue has no data there is no message — there is a `status`.

**Isolation.** Every upstream call and every listener call is wrapped; each venue has its own connection, its own status, its
own counters and its own subscription budget. A venue that throws, hangs, floods or dies costs the others nothing
(`services/api/test/quotes-hub.test.ts`, and observed in a browser: §"browser check" of the work note).

**Bounded memory.** 3 000 channels in the hub, 800 upstream feeds per venue, 800 new upstream subscriptions per venue and per
minute, one quote + one book + 50 trades + one candle per channel; per connection: 300 subscriptions and a queue of at most one
entry per subscription (§6).

## 2. Upstream sources

Verified by a live connection on 2026-11-15 (probe frames recorded in `services/api/test/fixtures/quotes/` and
`packages/derivatives/test/fixtures/`).

| Venue | Transport | What is used | Official documentation |
|---|---|---|---|
| **Hyperliquid** (main dex **and** builder-deployed dexes: `xyz:ANT`, `io:ANTH`…) | **websocket** `wss://api.hyperliquid.xyz/ws`, ONE connection owned by the hub | `activeAssetCtx` (mark, oracle, funding, open interest, 24 h), `bbo` (best bid / offer, venue-stamped), `l2Book`, `trades`, `candle` | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket (+ `/subscriptions`, `/timeouts-and-heartbeats`); limits: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits |
| **edgeX** | **websocket** `wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws` through the adapter (one connection for the service) | `ticker.{contractId}`, `depth.{contractId}.15`, `trades.{contractId}`; candles: REST polling (10 s) | https://edgex-1.gitbook.io/edgeX-documentation/api-v2 (see `docs/v11/research/edgex-api.md` §1.8) |
| **dYdX v4** | **websocket** `wss://indexer.dydx.trade/v4/ws` through the adapter (the documented indexer websocket; verified live) | `v4_markets` (oracle price, funding estimate, open interest), `v4_orderbook`, `v4_trades`; candles: REST polling (10 s) | https://docs.dydx.xyz/indexer-client/websockets |
| **GMX v2** | **REST polling** (every 3 s, over the data service's 3 s cache: a fresh read about every 6 s) of the oracle tickers through the derivatives data service (per-venue budget, last-good cache) | quote only — GMX has no order book and no public trade feed; candles: REST polling | https://docs.gmx.io/docs/api/overview/ — no public websocket / SSE is documented |
| **spot** — symbols Coinbase lists against USD | **websocket** `wss://ws-feed.exchange.coinbase.com` (public market-data feed, no authentication) | channel `ticker` (last trade, best bid / offer with sizes, 24 h open, venue-stamped) + `heartbeat` | https://docs.cdp.coinbase.com/exchange/websocket-feed/overview (« available without authentication »; a subscribe is required within 5 s) |
| **spot** — any other wallet symbol | **polling** (60 s) of the wallet's existing price module (CoinGecko, `server.ts` `markets()`, cached 4 min) | last price with the source's own date (`venueTs`) | https://docs.coingecko.com/reference/coins-markets |

What each upstream client does (reconnect with exponential backoff + jitter, heartbeat per the venue's protocol, resubscription
after reconnect, gap events):

- **Hyperliquid** — `createHlStream` (`packages/derivatives/src/venues/hyperliquid/stream.ts`, extended in this work with `bbo`
  and `candle`): client `{"method":"ping"}` every 15 s (the venue drops a connection it has sent nothing to for 60 s), `stale`
  after 25 s of silence, re-opened 10 s later, backoff 1 s … 30 s, a `gap` event after every reconnection. The venue DROPS the
  whole connection on a subscription to an unknown coin: the hub validates the coin against the venue's own listing before it
  subscribes (main dex: `meta`; builder dexes: `perpDexs` asset table, delisted coins refused). Venue limits per address:
  10 websocket connections, 1 000 subscriptions, 30 new connections a minute, 2 000 messages sent a minute — hence the hub's
  budgets (800 feeds, 800 new feeds a minute).
- **edgeX** — `EdgeXStream`: answers the server's ping (every 10 s) with the same time; depth is a snapshot + increments whose
  `startVersion` must equal the previous `endVersion`, anything else is a gap and the channel is subscribed again.
- **dYdX** — `DydxStream`: client ping, per-connection `message_id` tracking (an id still missing 5 s after a later one = gap →
  reconnect), snapshots on resubscription. A crossed book published by the indexer is skipped, never repaired.
- **Coinbase** — `createReconnectingWs` (`ws-client.ts`): the `heartbeat` channel (one frame per second and per product) proves
  liveness; `stale` after 20 s of silence, re-opened 10 s later; resubscription of every product on reconnect.
- **Kraken** (`wss://ws.kraken.com/v2`, channel `ticker`) was verified live too and NOT added: one streamed source per symbol
  keeps « which exchange is this price from » unambiguous, and the wallet's bars already name Coinbase first.

**Ids** are those of the markets hub: `venue:symbol` (`hyperliquid:BTC`, `hyperliquid:xyz:ANT`, `edgex:BTCUSDC`,
`dydx:BTC-USD`, `gmx:BTC/USD [BTC-USDC]`) and `spot:<symbol>`.

**Venue timestamps.** `venueTs` is the venue's own stamp when it gives one: Hyperliquid `bbo.time` and `l2Book.time`, trade
times on every venue, Coinbase `ticker.time`, CoinGecko `last_updated`. Hyperliquid's asset context, edgeX's and dYdX's tickers
and books and GMX's tickers carry none: `venueTs` is `null` and `recvTs` (receipt by this server) is the only date.

## 3. Endpoints and authentication

| Route | Who | Credential |
|---|---|---|
| `GET /api/v1/stream` (websocket) | the wallet's web app | owner session cookie **and** `Origin` equal to `SPW_ORIGIN` |
| `GET /api/v1/trading/stream` (websocket) | API clients | `Authorization: Bearer spw_live_…` with scope `markets:read`, **or** `?ticket=…`; the owner's cookie is accepted too, under the same Origin rule |
| `POST /api/v1/trading/stream/ticket` | a key (`markets:read`) or the owner | answers `{ ticket, expiresAt, ttlMs, url, protocol }` |
| `GET /api/v1/stream/stats` | owner | counters (§10) |

Authentication happens **before the upgrade**, in the hooks every request of the service goes through: the single `onRequest`
hook of `server.ts` (session cookie → owner; `apiKeyGate` → key principal, IP allow-list, per-key rate limit) and the trading
API's `scopeGuard` (the route declares `markets:read`). A refused request gets a plain HTTP answer — `401 unauthenticated`,
`403 origin_refused | insufficient_scope | key_path_forbidden | mixed_credentials`, `429 too_many_connections` — and the socket is
never upgraded.

**The Origin rule.** A websocket handshake is a `GET` that carries the session cookie from ANY page: CORS does not apply to
websockets, and the custom-header CSRF defence of the REST routes cannot be used (a browser cannot set a header on a
websocket). The `Origin` header — set by the browser, not by the page — is therefore the CSRF defence: a cookie-authenticated
upgrade whose `Origin` is not exactly `SPW_ORIGIN` (absent, `null`, another scheme, a look-alike host) is refused with 403.
The cookie is also `SameSite=Strict`. A key or a ticket is not an ambient credential: no Origin is required with them.

**API keys.** Never in the query string: `?key=`, `?token=`… open nothing (401). A key's restrictions apply **per
subscription**: a channel on a venue or an instrument outside `restrictions.venues` / `restrictions.instruments` is answered
`error restricted` and opens nothing upstream; the rest of the key's subscriptions go through. `status` channels are open to
every key.

**Tickets** (for clients that cannot set a header — browsers): 24 random bytes (`spw_tkt_…`), stored as a SHA-256, valid 30 s,
**single use** (removed when presented, whatever the outcome), bound to the principal that asked for it (a key's scopes and
restrictions, or the owner's session), never combined with a cookie or a bearer header (403 `mixed_credentials`), accepted on
`/api/v1/trading/stream` only. The ticket is the only thing that ever appears in a URL, and it is worthless after one use.

**Sessions end, keys get revoked.** Each socket re-checks its credential every 30 s (`auth.ts` `sessionAlive` — read-only, it does
not keep an idle session alive — and the key's status) and right after any successful `POST` to `/api/v1/auth/*`,
`/api/v1/developer/keys*`, `/api/v1/security/*`: a logout, an expired session, a revoked / rotated / expired key closes its
sockets with code **4001**.

**CSP.** `connect-src 'self' wss://<origin host>`. CSP3 lets `'self'` match the `ws` / `wss` scheme of the page's own origin and
current Chrome, Firefox and Safari do; Safari up to 15.3 did not ([WebKit bug 201591](https://bugs.webkit.org/show_bug.cgi?id=201591),
closed as a duplicate of 235873), so the same-origin websocket origin is named explicitly — one origin, nothing wider. Checked
in Chromium (no CSP violation, `tests/e2e/v11-quotes-live.mts`); Safari / iOS were not run here.

## 4. Protocol (version 1)

JSON text frames. Every server frame carries `"v": 1` and a `type`. Prices, sizes and rates are canonical decimal **strings**
(`/^-?(0|[1-9]\d*)(\.\d+)?$/`), never floats. Times are milliseconds since the epoch.

### Client → server

```json
{ "v": 1, "op": "subscribe",   "reqId": 7, "channels": [ { "type": "quote", "id": "hyperliquid:BTC" },
                                                          { "type": "book",  "id": "hyperliquid:BTC", "depth": 10 },
                                                          { "type": "trades", "id": "dydx:BTC-USD" },
                                                          { "type": "candle", "id": "hyperliquid:BTC", "interval": "1m" },
                                                          { "type": "status", "id": "*" } ] }
{ "v": 1, "op": "unsubscribe", "channels": [ { "type": "quote", "id": "hyperliquid:BTC" } ] }
{ "v": 1, "op": "ping", "t": 42 }
```

`type`: `quote | book | trades | candle | status`. `depth`: 5, 10 or 20 (default 20). `interval`: `1m 5m 15m 1h 4h 1d` (default
`1m`). `status` id: `*` or a venue id. `v` may be omitted; any other value is refused. Unknown fields are refused. At most 200
channels per frame. Subscribing again to a channel one already has means « send me the snapshot again ».

### Server → client

`hello` — first frame:

```json
{ "v": 1, "type": "hello", "connId": "65e1db2a-87d6", "heartbeatMs": 15000, "serverTs": 1794798600000,
  "limits": { "maxSubscriptions": 300, "maxFrameBytes": 16384, "maxMessagesPerSec": 20, "idleTimeoutMs": 120000 } }
```

`subscribed` — one per channel, with the **last known value at once** and its age (`null` when nothing was received yet):

```json
{ "v": 1, "type": "subscribed", "reqId": 7, "channel": { "type": "quote", "id": "hyperliquid:BTC" }, "key": "quote|hyperliquid:BTC|",
  "staleAfterMs": 15000, "source": "hyperliquid-ws", "snapshotAgeMs": 84, "snapshot": { "v": 1, "type": "quote", "…": "…" } }
```

`quote`:

```json
{ "v": 1, "type": "quote", "id": "hyperliquid:BTC", "bid": "65085", "bidSize": "11.88311", "ask": "65086", "askSize": "0.85252",
  "mid": "65085.5", "mark": "65087", "index": "65115", "last": null, "funding": "0.0000125", "openInterest": "36159.52766",
  "change24h": "0.003067", "volume24h": "3319784424.8816184998", "venueTs": 1794797790906, "recvTs": 1794797791203,
  "seq": 412, "source": "hyperliquid-ws", "stale": false }
```

`seq` increases by one for every quote the hub produced on that channel (a jump on the wire = conflated updates, never lost
state: a quote is a full state). `funding` is per funding interval of the venue, as the venue publishes it.

`book` — a snapshot, then deltas:

```json
{ "v": 1, "type": "book", "id": "hyperliquid:BTC", "depth": 10, "kind": "snapshot", "bids": [["65085","1.5"],["65084","3"]], "asks": [["65086","2"]],
  "seq": 1, "prevSeq": null, "checksum": 2874311908, "venueTs": 1794797790906, "recvTs": 1794797791203, "source": "hyperliquid-ws", "stale": false }
{ "v": 1, "type": "book", "id": "hyperliquid:BTC", "depth": 10, "kind": "delta", "bids": [["65085","0"],["65083","4"]], "asks": [],
  "seq": 2, "prevSeq": 1, "checksum": 1146302475, "venueTs": null, "recvTs": 1794797791703, "source": "hyperliquid-ws", "stale": false }
```

A delta lists changed prices only; size `"0"` removes the price. **Contiguous sequence**: a delta applies only when `prevSeq` is
the `seq` of the last message applied. **Checksum**: CRC-32 (IEEE) of `p:s|p:s…;p:s|…` over the best 10 levels of each side, bids
first, decimal strings exactly as sent, computed on the server's book AFTER the message. On a hole or a mismatch the client
subscribes to the channel again and waits for the snapshot (`OrderBook` in both SDKs and `quotes.ts` do exactly this). After any
upstream gap or reconnection the server itself restarts the channel from a snapshot.

`trade` — a batch, oldest first; the first batch after a subscription (or a gap) is the venue's recent history, flagged:

```json
{ "v": 1, "type": "trade", "id": "hyperliquid:BTC", "trades": [ { "id": "437504529308123", "price": "65085", "size": "0.1", "side": "sell", "ts": 1794797517779 } ],
  "seq": 9, "recvTs": 1794797517902, "source": "hyperliquid-ws", "snapshot": true }
```

`candle` — the bar in progress (same `ts`, new figures) or a new bar:

```json
{ "v": 1, "type": "candle", "id": "hyperliquid:BTC", "interval": "1m", "ts": 1794798660000, "open": "65032", "high": "65066", "low": "65012", "close": "65066",
  "volume": "3.5836", "seq": 14, "recvTs": 1794798671010, "source": "hyperliquid-ws" }
```

`status` — per venue: `connected | reconnecting | stale | down | idle` (`idle`: nothing subscribed, no connection):

```json
{ "v": 1, "type": "status", "venue": "hyperliquid", "status": "reconnecting", "since": 1794798700000, "ageMs": 1200, "transport": "stream",
  "source": "hyperliquid-ws", "detail": null, "ts": 1794798701200 }
```

Sent on every change, every 5 s for a venue that is not connected (its `ageMs` grows) and every 15 s otherwise. A venue that
stays `reconnecting` or `stale` for 30 s is reported `down` and stays so until it is connected again.

Others:

```json
{ "v": 1, "type": "heartbeat", "ts": 1794798615000, "subscriptions": 5 }          // every 15 s
{ "v": 1, "type": "pong", "t": 42, "ts": 1794798615003 }
{ "v": 1, "type": "dropped", "channel": "trades", "id": "hyperliquid:BTC", "count": 37, "total": 37 }
{ "v": 1, "type": "unsubscribed", "channel": { "type": "quote", "id": "hyperliquid:BTC" }, "key": "quote|hyperliquid:BTC|" }
{ "v": 1, "type": "error", "code": "unknown_instrument", "message": "unknown instrument 'hyperliquid:NOPE'", "channel": { "type": "quote", "id": "hyperliquid:NOPE" }, "reqId": 7 }
```

Error codes: `bad_frame` (not JSON, or a binary frame), `bad_message`, `unsupported_version`, `unknown_instrument`,
`unsupported_channel` (e.g. a book on GMX, a book on spot), `restricted` (the key), `too_many_subscriptions`, `rate_limited`,
`upstream_unavailable` (the venue cannot be asked now, or a hub budget is spent), `internal`. An error never closes the
connection by itself.

Close codes: `1001` server shutting down (reconnect), `1009` frame too big, `4001` session ended / key no longer active (do
**not** reconnect with the same credential), `4002` flood, `4003` slow consumer, `4004` idle, `4005` dead peer, `4006` repeated
protocol violations.

### Staleness

Per source, from how often it really sends (`QUOTE_CADENCE_MS`, measured in the work note): Hyperliquid 15 s, edgeX 15 s,
dYdX 60 s, GMX 20 s, Coinbase 30 s, CoinGecko 15 min. Computed **twice**:

- **server**: `stale` in a message is true when the venue is not `connected` or the value is older than its bound when the frame
  is built (it matters for the snapshot of a `subscribed`);
- **client**: `subscribed.staleAfterMs` gives the bound; the client re-evaluates with ITS clock (`freshnessOf`): `live` →
  `delayed` (5 s, or half the bound) → `stale`, `reconnecting` as soon as the tab's connection or the value's venue is not live.
  A frozen connection therefore turns stale on screen without any message; the heartbeat watchdog then re-opens it.

The age shown counts from the figure's own date: local receive time, minus the snapshot's age, minus what the server measured
between the source's date and its receipt (a CoinGecko price dated 3 minutes before the server got it is 3 minutes old).

## 5. Limits

| Limit | Default | Where |
|---|---|---|
| connections per principal | owner 12 (`SPW_STREAM_MAX_CONN_OWNER`), API key 4 (`SPW_STREAM_MAX_CONN_KEY`) | before the upgrade: 429 `too_many_connections` |
| connections in total | 200 (`SPW_STREAM_MAX_CONN`) | idem |
| subscriptions per connection | 300 (`SPW_STREAM_MAX_SUBS`) | `error too_many_subscriptions` |
| client frame size | 16 kB | close 1009 |
| client frames | 20 / s, burst 40 | `error rate_limited`; 20 refusals in a row: close 4002 |
| idle (nothing subscribed, nothing received) | 120 s | close 4004 |
| liveness | protocol ping every 15 s; no pong by the next one | socket terminated (4005 counted) |
| upgrade requests | the service's global limit, 240 / minute per address | 429 |
| ticket | 30 s, single use, 2 000 pending at most | 401 / 429 |

## 6. Backpressure

Per connection (`outbox.ts`). A frame goes straight to the socket while the client keeps up (`bufferedAmount` ≤ 256 kB and
nothing queued). Otherwise the queue takes over — bounded by construction, at most one entry per subscription:

- **quote, candle, status — conflated**: only the newest per channel is kept; the replaced one is counted (`conflated`);
- **book — conflated into a snapshot**: one queued delta is sent as it is (its predecessor was sent); a second one for the same
  channel turns the entry into a SNAPSHOT of the channel's current book, built when it is finally written (`bookResyncs`). A
  client never receives a delta whose predecessor it did not get;
- **trades — dropped, never silently**: the count is sent as a `dropped` frame as soon as the client drains (`count` since the
  last notice, `total` since the connection opened). Delivered + declared dropped = everything.

A client over the high-water mark (4 MB) for 10 s, or beyond four times that mark, is closed with **4003**. The hub also
conflates quotes at the source: at most one quote per channel every 100 ms, always the newest state.

Tested with a really slow consumer (a client whose socket stops reading while 6 000 bursts are pushed): the healthy client on
the same hub receives every message in order; the slow one catches up with the latest quote of each market, a book whose
sequence and checksum hold, and `delivered + dropped = 6 000` trades (`services/api/test/quotes-stream.test.ts`).

## 7. Web client

`apps/web/src/quotes.ts` (hooks), `quotes-ui.tsx` (pieces), `quotes-spot.tsx` (first-chunk screens).

- **One connection per tab**, lazy: opened by the first subscriber, closed 2.5 s after the last one leaves (`lingerMs`).
- **Reconnect** with backoff + jitter (1 s … 30 s), **resubscribe** everything (the venue statuses always come along), books
  restart from their snapshot.
- **Heartbeat watchdog**: no frame for 2.5 heartbeat periods (37.5 s) → the connection is considered frozen and re-opened.
- **Visibility**: the tab hidden for 30 s → socket closed (`paused`); visible → reconnected at once, fresh snapshots.
- **Fallback**: three failed connections in a row → `fallback` (it keeps trying, slowly). Every screen keeps the REST polling it
  had; the Futures terminal re-opens its SSE stream. The state is shown (`LiveStatus`).
- **Rendering**: messages fill a pending buffer; ONE `requestAnimationFrame` commits and wakes only the components subscribed
  to the keys that changed (`useSyncExternalStore`). 3 000 messages on 150 markets = one commit, 150 cell renders.
- Hooks: `useQuote(id)`, `useQuotes(ids)`, `useBook(id, depth)`, `useTrades(id)`, `useVenueStatus()`, `useConn()`,
  `useFresh(value)`, `useQuoteSubscriptions(ids)`. Pieces: `LiveDot` / `QuoteDot` (live · delayed · stale · reconnecting, in
  words with the age), `LiveCell` (a ticking figure; the tick flash is off under `prefers-reduced-motion`), `LiveStatus`.
- **First chunk**: 260.61 kB → 262.30 kB (+1.69 kB; gzip 80.03 → 80.61 kB). The client is a chunk of its own (10.5 kB, 3.9 kB
  gzip) loaded by the screens that use it; Home and the asset page reach it through a dynamic import (`quotes-spot.tsx`).

| Screen | What ticks | Without the socket |
|---|---|---|
| Markets explorer | price, 24 h change, funding of every row; freshness dot; stream + venue status | listing polled every 10 s as before (30 s while live) |
| Futures terminal | ticker, order book (sequence + checksum), trades — the shared socket replaces the per-instrument SSE stream | SSE stream re-opened; REST snapshot every 5 s as before |
| Compare | mark, index, spread of the table; the live price next to the price each cost estimate was computed on | 15 s polling as before. The comparison is recomputed on that cadence or on demand (« Recompute now »), never per tick |
| Private Markets | price, bid, ask of live contracts (builder-dex coins and edgeX) | 20 s polling as before (60 s while live) |
| Asset page, Home | streamed USD price where Coinbase lists the symbol (in CAD: converted at the rate of the polled reading — said on screen) | polled CoinGecko price with its own date, as before |

## 8. SDKs

New files only: `packages/trading-sdk/src/stream.ts` (`SPWalletStream`, `OrderBook`; zero dependency) and
`sdk/python/src/sp_wallet/stream.py` (`SPWalletStream`, `OrderBook`; asyncio, `websockets==16.0` as the optional extra
`stream`). Not yet re-exported from the packages' index files (they belong to the contract workstream): import
`@sp-wallet/trading-sdk/src/stream.ts` / `sp_wallet.stream`.

```ts
const stream = new SPWalletStream({ apiKey: process.env.SP_WALLET_API_KEY, baseUrl: 'https://wallet.example' });
await stream.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 10 }]);
const book = new OrderBook();
stream.on('book', (m) => { if (!book.apply(m)) stream.resync({ type: 'book', id: 'hyperliquid:BTC', depth: 10 }); });
for await (const m of stream) if (m.type === 'quote') console.log(m.id, m.bid, m.ask, m.stale);
```

```python
async with SPWalletStream(api_key="spw_live_…", base_url="https://wallet.example") as stream:
    await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}])
    async for m in stream:
        print(m.id, m.bid, m.ask, m.stale)
```

Node (≥ 22, or the `ws` package passed as `WebSocket`) and Python send the key in the `Authorization` header of the handshake.
Browsers use a ticket: `ticket: () => fetchTicketFromYourBackend()`, or `auth: 'ticket'` when the page is served by the wallet's
origin. Both clients reconnect (backoff + jitter), resubscribe, watch the heartbeat, stop for good on `4001` or a refused
credential, and bound the `for await` buffer (oldest dropped, counted).

## 9. Failure modes

| What happens | What the client sees |
|---|---|
| A venue's connection drops | `status reconnecting` for that venue; its quotes say `reconnecting` then `stale`; the other venues are untouched; on return `status connected`, books restart from a snapshot |
| A venue does not come back in 30 s | `status down`, until it is connected again |
| A venue sends garbage | the frame is dropped and counted (`errors`, `lastError` in the stats); never a partial quote |
| A hole in a venue's book sequence | the upstream client resubscribes that channel; the hub sends a snapshot |
| A poll fails (GMX, CoinGecko) | no message; `status stale`, `down` after three failures |
| The client is slow | conflation, `dropped` notices; 4003 if it stays over the high-water mark |
| The client's connection freezes | no heartbeat → its watchdog reconnects; meanwhile every figure turns stale on its own clock |
| The websocket cannot be opened (proxy) | web: `fallback`, REST polling / SSE; SDK: an error after three attempts when it never opened |
| Session ends, key revoked | close 4001 |
| The API restarts | close 1001 « server shutting down »; clients reconnect and resubscribe; upstream connections are re-opened on demand |
| A hub budget is spent | `error upstream_unavailable` for the new channel; existing channels are untouched |

## 10. Metrics and logs

`GET /api/v1/stream/stats` (owner) — and a summary in `GET /api/v1/monitor/health` (`quotes`):

```
connections { open, byPrincipal, total, refused }      subscriptions      messagesPerSec (last 10 s)      messagesSent, bytesSent
backpressure { queuedNow, conflated, tradesDropped, bookResyncs, slowConsumersClosed }
clients { deadPeers, badFrames, rateLimited, restricted, unauthorizedClosed }      tickets { issued, used, refused, pending }
upstreamReconnects      lagMs { samples, p50, p95 }
hub { channels, channelsByType, feeds, listeners, counters { quote, book, bookSnapshots, trade, candle, status, upstreamMessages, gaps, … },
      venues [ { venue, status, since, ageMs, transport, source, feeds, messages, reconnects, gaps, errors, lastError, upstream } ] }
```

`lagMs` is measured from the venue's own timestamp of an update to that update being written to a client socket — only on
updates the venue stamped (Hyperliquid best bid / offer and books, trades, Coinbase tickers), sent without queueing.

Structured logs (the service's pino logger): `quotes.conn.open` / `quotes.conn.close` (info: who, via, counters, duration),
`quotes.conn.closed` (warn: abnormal close with its code), `quotes.conn.dead`, `quotes.venue` (status changes; `down` at warn),
`quotes.gap`, `quotes.socket.error`. The cookie, the bearer header and a ticket are never logged (the logger redacts the two
headers; the ticket travels in the URL, which the service does not log at its level).

## 11. Deployment notes (nothing was changed in production)

- **Caddy** proxies websockets with a plain `reverse_proxy`: it performs the upgrade and tunnels the connection. No directive is
  needed. Two behaviours to know ([reverse_proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)):
  `stream_timeout` — « Default: no timeout » — so Caddy does not cut a long-lived stream by itself; and on a **config reload**
  « WebSocket connections are forcibly closed » unless `stream_close_delay` is set. A reload is therefore a reconnection for
  every client (they do it by themselves, with jitter); setting `stream_close_delay 5m` in the site block would avoid it — a
  production change, not made.
- **Idle timers on the path** (a home router's NAT, a corporate proxy, a mobile carrier) are kept open by the 15 s heartbeat
  frame and the 15 s protocol ping. If an intermediary still cuts, the client's watchdog reconnects within 37.5 s.
- **`Origin`**: Caddy passes the browser's `Origin` header through; the API compares it with `SPW_ORIGIN`. `SPW_TRUST_PROXY`
  is unchanged (it concerns `req.ip`, used by the limits and the key IP allow-list).
- **Access logs**: a ticket appears in the request line of ONE upgrade request; it is single-use and expires in 30 s.
- **One process**: the hub is in-process. With `SPW_WORKERS=api` + a separate agents process, each process that builds the
  server has its own hub (and its own venue connections: Hyperliquid allows 10 per address).
- **Outbound**: the API host needs outbound `wss` to `api.hyperliquid.xyz`, `edgex-quote-prod-v2.edgex.exchange`,
  `indexer.dydx.trade` and `ws-feed.exchange.coinbase.com` (the first three were already used).
- **Restart**: `app.close()` closes every client with 1001 before the listener goes away (`main.ts` already calls it on
  SIGINT / SIGTERM).

## 12. For the agents' stream engine

`services/api/src/agent-runtime` has its own stream engine and stores `market_snapshots`; it was not edited. The hub exposes
what it can adopt instead of opening its own venue streams:

```ts
import { quoteHub } from '../quotes/index.ts';
const hub = quoteHub()!;                                   // the hub of this process
await hub.validate({ type: 'quote', id: 'hyperliquid:BTC' });   // throws QuoteError(code) — unknown instrument, unsupported channel…
const sub = hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, (frame) => { /* frame.msg: QuoteMsg, typed; frame.lagTs */ });
sub.snapshot();         // the last known value now, or null
sub.unsubscribe();      // reference-counted: the upstream feed closes with its last user (after the idle grace)
hub.statuses();         // one StatusMsg per venue
```

Same messages as on the wire (`protocol.ts`), same reference counting, same venue status; a listener that throws is isolated.
In a process without the HTTP server (`agent-worker-main.ts`) a hub can be built directly:
`new QuoteHub({ upstreams: defaultUpstreams(derivatives()) })`.

## 13. Limits of this version

- **Candles** are streamed by Hyperliquid only; edgeX, dYdX and GMX candles are the venues' REST bars re-read every 10 s
  (`source: <venue>-rest`). There is no candle channel for spot.
- **Bid / ask of edgeX and dYdX quotes** come from the order book and are present only while a book of that market is open in
  the hub (someone subscribed to it); otherwise they are `null` (edgeX's ticker increments and dYdX's market feed carry none).
- **dYdX quotes are sparse**: the feed speaks when the oracle price or the funding estimate moves (5 in a minute on BTC).
- **Hyperliquid `l2Book`** arrived every 5 to 12 s in the runs of 2026-11-15 (5 to 6 messages a minute on BTC); the best bid /
  offer (`bbo`, ≈ 10 / s) is what keeps the quote live. The terminal's book is as fresh as the venue's feed, no more.
- **Spot** streams from ONE exchange (Coinbase), in USD. The CAD figure on Home and the asset page is that price converted at
  the rate implied by the last polled reading; symbols Coinbase does not list stay on the polled price module.
- **GMX** has no stream: one quote per fresh read of the venue, about every 6 s (10 in a minute in the smoke).
- **One process**: no cross-process fan-out; connection limits are per process.
- **Safari / iOS** were not run (Chromium only); the CSP names the websocket origin explicitly for the old Safari behaviour.
- The SDK stream classes are not yet exported from the packages' index files, and the OpenAPI document does not (cannot)
  describe the websocket.
