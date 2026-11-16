# SP Trading API — architecture (V11)

Status on branch `v11-trading-api`: machine authentication and the **read side** are implemented and connected to the
real services. The **write side** is registered (scope, validation, replay protection) and answers
`501 execution_not_wired`. Security model: `docs/TRADING-API-SECURITY.md`. Reference: `docs/TRADING-API-OPENAPI.md`.

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
| `routes.ts` | registers `/api/v1/trading/*` from `spec.ts`; `requireMandate`; the 501 handler |
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
- Limits are **recorded, not enforced**: nothing can be executed yet. `GET /risk` says `limitsEnforced: false`.
- `mandate_id` is stored as given (a UUID). Its existence and state are **not checked** in this wave: the trading
  mandate table belongs to `packages/trading`, which is not merged here. Without a `mandate_id`, execution scopes
  answer 403 `mandate_required`. With one, they reach the 501 handler.

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

## 7. Write side (not wired)

Twelve operations answer 501: `POST /orders/preview`, `POST /orders`, `DELETE /orders/{id}`,
`POST /positions/{id}/close|reduce`, `POST /strategies`, `POST /strategies/{id}/backtest|start|stop`, `POST /agents`,
`POST /agents/{id}/start|stop`. Order of checks: authentication → scope → `mandate_required` → body validation →
`Idempotency-Key` → 501. To wire one, replace its `notWired` entry in `routes.ts` with a handler and set
`implemented: true` in `spec.ts` (a start-up check refuses a mismatch), then regenerate the OpenAPI files.

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

Deployment note: the pepper file must be in the secrets backup. Losing it invalidates every key.
