# SP Trading API — architecture (V11)

Status: machine authentication and the **read side** are implemented and connected to the real services. Since
Phase F (branch `v11-exec`) the **order operations of the write side** are wired to the order service (section 7), and
the strategy and agent operations to the agents runtime (`agents/trading-handlers.ts`). All 41 operations of the contract
are implemented; `501 execution_not_wired` remains only as the answer of an owner's spot order on a server whose swap flow
is not configured. Every operation declares the error answers it can give (`x-spw-errors`). Security model: `docs/TRADING-API-SECURITY.md`. Reference for people (getting started, concepts, a worked example per
operation, error catalogue): `docs/TRADING-API-REFERENCE.md`, served at `GET /api/v1/trading/docs` (last section). Compact index: `docs/TRADING-API-OPENAPI.md`.

## 1. Where it sits

```
program ──Bearer spw_live_…──▶ /api/v1/trading/*   ┐
                                                    ├─ Fastify (services/api) ─▶ derivatives data service, venue registry,
browser ──session cookie────▶ /api/v1/developer/*  ┘                            market-data engine, paper / live / GMX
          (+ every existing route)                                              services, signer status, chain adapters, DB
```

All code is in `services/api/src/trading-api/`. Outside it, three files changed:

| File | Change |
|---|---|
| `server.ts` | one `onRequest` branch (`apiKeyGate`), `req.principal = OWNER` after the session check, one registration (`tradingApi`) |
| `db.ts` | one block of tables (`>>> v11 trading API`) |
| `alerts/webhook.ts` | the signed POST became `postSigned` (shared transport); `sendWebhook` is unchanged for its callers |

| Module | Role |
|---|---|
| `spec.ts` | the contract: scopes, zod schemas, the table of operations. Pure (no config, no DB). |
| `openapi.ts` | OpenAPI 3.1 and the markdown reference, generated from `spec.ts` with zod 4's `z.toJSONSchema` (no new dependency) |
| `key-model.ts` | token format, hash, canonical intent, widening rule, CIDR match. Pure. |
| `keys.ts` | key storage, verification, passkey-approved intents (create, rotate, update), revoke |
| `secrets.ts` | pepper and webhook signing secrets, in a 0600 file outside the database |
| `principal.ts` | `Principal`, `apiKeyGate` (onRequest), `scopeGuard` (the single preHandler), limiters, usage log, retention |
| `idempotency.ts` | `withIdempotency`, `replayHeaders` |
| `read.ts` | the read services and key restrictions |
| `routes.ts` | registers `/api/v1/trading/*` from `spec.ts`; `requireMandate`; the order handlers (calls to the order service), the agents' handlers (`agentTradingHandlers`), the shaping of previews and refusals, the catch-all `404 not_found` |
| `commands.ts` | `POST /commands`: the command grammar, the owner's resolution defaults |
| `developer-routes.ts` | `/api/v1/developer/*` (owner session only) |
| `webhooks.ts` | endpoints, `emitWebhook`, delivery with retries |
| `index.ts` | `tradingApi(app, deps)` and the exports for integrators |

## 2. Request path

1. `onRequest` (server.ts). A request with `Authorization: Bearer spw_live_…` is a key request and goes to
   `apiKeyGate`: path must start with `/api/v1/trading/` (else 403, before any lookup); no session cookie (else 403);
   failed-auth throttle; key verified; source address; per-key rate limit; `req.principal` set. Any other request
   follows the existing path (runner gate, CSRF, session) and gets `req.principal = { kind: 'owner' }`.
2. `preHandler` `scopeGuard` (one hook for the whole server). Key principal: the route must be a trading route with a
   declared scope the key holds. Any principal: a trading route without a declared scope is closed.
3. Handler (`routes.ts`): `requireMandate` → zod validation of params, query and body → the operation's handler.
4. `onResponse`: one usage row for a key call; webhook event sources.

### Principal

```ts
type Principal =
  | { kind: 'owner' }
  | { kind: 'api_key'; id: string; name: string; scopes: Scope[]; limits: Limits;
      restrictions: Restrictions; mandateId: string | null; rateLimitPerMin: number };
// req.principal is null on public routes and on the research runner's routes
```

`actorOf(principal)` gives the audit actor (`owner` or `key:<id>`).

## 3. API keys

- Token `spw_live_<key id>_<secret>`; key id `spk_<12 hex>` (public); secret 32 random bytes, shown once.
- Stored: `HMAC-SHA-256(pepper, "spw-api-key-v1\n<id>\n<secret>")`. Lookup by the id in the token, constant-time compare.
- Fields: name, scopes, `expires_at` (required, at most 365 days after creation), limits (max order notional, max
  daily notional), restrictions (networks, venues, instruments, source CIDRs), `rate_limit_per_min`, `mandate_id`,
  `last_used_at`, `revoked_at`.
- Limits (`maxOrderNotionalUsd`, `maxDailyNotionalUsd`) and restrictions (venues, instruments, networks) are
  **enforced on every order** the key places, before the mandate and the risk engine. A reduce-only exit is not
  stopped by the notional limits. `GET /risk` says `limitsEnforced: true`.
- `mandate_id` is **verified** when it is set: the mandate exists, is approved and active, and was approved for this
  key (`mandates/service.ts` `verifyKeyBinding`). A key is created without one — its id does not exist before — and
  bound with an update, which needs the passkey. Without a `mandate_id`, execution scopes answer 403
  `mandate_required`, except a cancel of the key's own order and the kill switch.

### Owner approval

`POST /keys/prepare` builds a canonical intent (sorted-key JSON) and stores it; the WebAuthn challenge is
`SHA-256("SPW-APIKEY-INTENT-v1\n" ‖ canonical)`. `POST /keys` sends `{ intentId, assertion }`; the intent is deleted
before the assertion is judged (single use, 3 minutes). Rotation and widening use the same mechanism. The assertion is
verified by the API with `@simplewebauthn/server` and the API's copy of the enrolled passkeys, as `auth.ts` does for
login. The signer's approvals could not be reused: they are bound to its own intent kinds (`packages/core/src/intent.ts`,
mandates, venue authorizations), and the signer may not be changed in this work.

| Action | Needs |
|---|---|
| create, rotate | session + passkey |
| update that widens (more scopes, later expiry, higher or removed limit, wider restriction, higher rate, mandate bound) | session + passkey |
| update that only narrows, revoke | session |

## 4. Rate limits and usage

- Per key: fixed one-minute window, `rate_limit_per_min` (default 120, at most 600), headers `RateLimit-Limit`,
  `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429. Counted in the gate, so 404s count too.
- Trading routes are exempt from the per-address limiter of `server.ts` **for key principals only**; the owner
  session stays under it.
- Failed authentications: 10 per minute per address, then 429 `auth_throttled`.
- Key-management routes: 10 calls per minute per address.
- Limiters are in memory and per process, like the existing one. A restart resets them.
- `api_key_usage`: key id, method, route pattern, status, latency, request id, address. Pruned after
  `SPW_API_USAGE_RETENTION_DAYS` (default 90).

## 5. Replay protection

`withIdempotency(req, reply, fn)`: `Idempotency-Key` required; stored per principal with the SHA-256 of method, path
and canonical body. Same key and request → stored answer, `Idempotent-Replay: true`, handler not run. Different
request → 409. Answers ≥ 500 are not stored. Optional `X-SPW-Timestamp` must be within 300 s. Records are kept 24 h.

An answer that carries a secret must not go through this store (webhook creation does not).

## 6. Read side

| Operation | Source |
|---|---|
| `GET /markets`, `/markets/{symbol}`, `/orderbook`, `/candles` | `DerivData` + `VenueRegistry` (Hyperliquid, GMX, dYdX); spot rows from the market-data engine (`activeMarketConfig`, `market_quality`, `getSeries`) |
| `GET /balances`, `/portfolio` | signer status (addresses, halt), chain adapters, the price feed of `server.ts`; accounts from the paper and live services |
| `GET /positions` | `PaperService.list`, `LiveService.get` (venue state), `GmxService.status` (chain) |
| `GET /orders`, `/orders/{id}` | `deriv_orders` (paper and venue accounts), `deriv_gmx_ops`, `agent_orders` |
| `GET /strategies`, `/agents` | strategy libraries, `strategy_versions`, `agents` |
| `GET /risk` | signer status and policy, `capabilities()`, account policies and halts |
| `GET /activity` | `proposals`, `deposits`, `deriv_fills` |

Rules: every market row has `ts` (source time) and `stale`. A source that fails is listed in `errors`; if every
source fails the call is a 503 with a code. Rows carry `mode: paper | live`; `/portfolio` returns three separate
figures and no sum across modes; testnet venue accounts are listed but not summed.

Order ids: `deriv:<account>:<clientId>`, `gmx:<op id>`, `agent:<order id>`. Position ids:
`<mode>:<venue>:<account>:<instrument>`.

Known limits of the read side:

- Spot `mark` is the close of the last consolidated 1 h bar, not a live quote. There is no spot order book.
- `/portfolio` values the wallet with the CoinGecko feed already used by the app; `pricesAsOf` is the answer time.
- `/positions` for GMX calls the signer and Arbitrum RPCs on each request (no cache of its own).
- `/orders` merges four tables in memory after a per-table `limit`; there is no cursor pagination.

## 7. Write side

Since Phase F the order operations are wired to the order service (`services/api/src/orders/`; see
`V11-EXECUTION-ENGINE.md` section 8). Nothing in `trading-api/` talks to a venue or to the signer.

| Operation | Scope | Mandate on a key | What it does |
|---|---|---|---|
| `POST /orders/preview` | `orders:prepare` | checked, not required | every check the order would meet, an estimate; creates nothing; no `Idempotency-Key` |
| `POST /orders` | `orders:execute` | required, must cover the order | owner: `AWAITING_APPROVAL` then the passkey in the app (paper: executed). Key: mandate, risk engine, the engine's mandate path |
| `DELETE /orders/{id}` | `orders:cancel` | not required | the key's own orders only |
| `POST /positions/{id}/close`, `/reduce` | `positions:manage` | required | strictly reduce-only |
| `POST /commands` | the resolved operation's | as that operation | one line of the command grammar; the owner's defaults (`GET/PUT /api/v1/developer/command-defaults`); 409 `ambiguous_command` executes nothing |
| `POST /risk/kill-switch` | `positions:manage` | not required | engages the global kill switch; a key cannot release it |

`requireMandate` skips the operations declared `noMandate` in `spec.ts`: they can only remove risk, or (the
command router) check per resolved operation.

Order of checks for `POST /orders`: authentication → scope → `mandate_required` → body validation →
`Idempotency-Key` → instrument resolution and the key's restrictions → idempotent replay → `execution_disabled`
→ key limits → the order exists → risk engine → mandate → engine. The key of the order is the body's
`clientOrderId` when given, else the `Idempotency-Key` header.

The strategy and agent operations are implemented by the agents runtime: `POST /strategies`,
`POST /strategies/{id}/backtest|start|stop`, `POST /agents`, `POST /agents/{id}/start|pause|stop|backtest`, and the
reads `GET /agents/templates`, `/agents/{id}`, `/agents/{id}/signals|journal|orders|performance` (ONE mode per call),
`GET /jobs/{id}`. `agents:manage` and `strategies:manage` are management scopes — no mandate on the key: research and
paper sign nothing, and going live is bounded by the agent's own owner-approved mandate (409 `mandate_required`).

Spot: 403 for a key (`spot_execution_requires_agent_vault`); the owner's spot order is a swap proposal of the existing
flow, approved with the passkey — a SELL names `size`, a BUY names `notional` (the quote amount: a swap is exact-input).
Live orders on GMX are the owner's, with the passkey (403 `gmx_requires_owner_passkey` for a key).

At the boundary (`routes.ts`, `read.ts`, `shaping.ts`), before or after the order service:
- `notional` on a perpetual becomes a size (notional ÷ the order's own price, else the mark read now, rounded down to the
  lot); such an order named by its `clientOrderId` is replayed from its stored answer, so a replay never re-reads a price;
- a preview, and the `data.checks` of an order refusal, withhold the account's figures from a key that holds neither
  `wallet:read` nor `positions:read`;
- `GET /orders` and `GET /activity` are keyset-paginated (`cursor` / `nextCursor`) on (time, id);
- a GMX position id is `live:gmx:<account>:<instrument>` when the wallet holds one position on that market (the
  66-character position key would not fit a path parameter);
- any other path under the prefix answers `404 not_found`.

## 8. Webhooks

Owner-managed HTTPS endpoints (`/api/v1/developer/webhooks`, at most 10). Body
`{ app, id, event, ts, data }`; headers `X-SPW-Timestamp`, `X-SPW-Signature: v1=<HMAC-SHA256(secret, "<ts>.<body>")>`,
`X-SPW-Event`, `X-SPW-Delivery`. Retries after 30 s, 2 min, 10 min, 1 h, 6 h; six attempts, then `failed`.
At-least-once; a receiver deduplicates on `id`. The retry worker starts with the server when `SPW_WORKERS` is on.

| Event | Source today |
|---|---|
| `key.revoked` | revoke and rotate routes |
| `risk.kill_switch` | `POST /security/emergency-halt` answered 200 |
| `agent.updated` | owner routes that change an agent's mode or mandate answered 200 |
| `order.updated` | none — pending the unified order state machine |

`agent.updated` does not cover transitions made by the engines (a stop on a loss limit, for example).

## 9. OpenAPI

`node scripts/gen-openapi.mts` writes `docs/openapi/trading-v1.json` and `docs/TRADING-API-OPENAPI.md`; `--check`
fails when they are stale, and so does a unit test. Served at `GET /api/v1/trading/openapi.json`. Response schemas are
loose objects (main fields declared, others allowed); the tests parse real answers against them.

### Streaming (not in the OpenAPI document)

Live market data is served over a websocket, which OpenAPI cannot describe: `GET /api/v1/trading/stream` (an API key with
the scope `markets:read` in the `Authorization` header of the handshake — never in the URL — or a single-use ticket from
`POST /api/v1/trading/stream/ticket` for clients that cannot set a header), with the key's venue and instrument restrictions
applied per subscription. The two routes are registered by the quote engine (`services/api/src/quotes`), declare their scope
like every trading route, and are the only routes under `/api/v1/trading/` that are not operations of the spec. Protocol
(version 1: `quote`, `book`, `trade`, `candle`, `status`), authentication, limits, backpressure and the SDK stream classes:
[`docs/V11-QUOTE-ENGINE.md`](V11-QUOTE-ENGINE.md).

## 10. Web

`apps/web/src/screens/Developer.tsx` (own chunk, 32 kB; route `/developer`, opened from Settings) with
`apps/web/src/developer.ts` (pure). Tabs: keys, usage, webhooks, documentation (in-app OpenAPI viewer, examples),
status. Texts: the `dv` block of `i18n.ts`.

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SPW_API_KEY_PEPPER` | unset | ≥ 32 characters: replaces the pepper of the secrets file |
| `SPW_DATA_DIR` | `~/.config/sp-wallet` | directory of `trading-api-secrets.json` (shared with the alerts secrets) |
| `SPW_API_USAGE_RETENTION_DAYS` | 90 | usage log retention |
| `SPW_TRADING_API_EXECUTION` | off | `on`: live orders can be placed through the trading API. Off: 403 `execution_disabled` for new live risk; paper works; cancels and strictly reducing orders pass |

Deployment note: the pepper file must be in the secrets backup. Losing it invalidates every key.

## The served reference (documentation)

`GET /api/v1/trading/docs` (HTML), `/docs.md` (Markdown) and `/docs.js` (the page's script) are rendered by
`trading-api/reference.ts` from the same sources as the contract, so they cannot describe another API than the one running:

| Source | Holds |
|---|---|
| `spec.ts` → `openapi.ts` | operations, schemas, the error codes each operation declares |
| `examples.ts` + `examples-data.ts` | one worked example per operation: the request, the answer (recorded from the real server on the SDK test stack, trimmed), the same call with both SDKs |
| `error-catalog.ts` | what every error code, mandate reason, scope and order state means, and what to do |
| `guide.ts` | getting started (English and French) and the concepts, as Markdown; the figures it quotes are read from the code |

The three paths are not operations (not in the OpenAPI document, not in the SDKs): they need a principal like every path
under the prefix — any valid key, or the owner session of the browser, which is how the Developer screen opens the page.
The page is one self-contained document: inline CSS (the policy allows it), no CDN, font or image, and its script is a
same-origin file because the server's Content-Security-Policy is `script-src 'self'`. The policy was not changed.

Tests (`services/api/test/trading-api-docs.test.ts`): every example passes the zod schemas of its operation; the catalogue
covers exactly the codes the operations declare; every SDK call of a sample exists in both SDKs; the committed Markdown is
what the code generates; the page names every operation with an example. To change the documentation, edit those four
files and run `npx tsx scripts/gen-openapi.mts`, then the two SDK generators (`packages/trading-sdk/scripts/gen-types.mts`,
`sdk/python/scripts/gen_models.py`) since descriptions flow into the generated types.

To record the examples again: start `packages/trading-sdk/scripts/test-stack.mts`, call the operations with the `trader`
key, and replace the bodies in `examples-data.ts`; the tests say at once when a recorded answer no longer matches the contract.
