# V11 work log — SP Trading API (machine authentication + read side)

Branch `v11-trading-api`, from local `v11` (`fe705be`). Date: 2026-11-15. Author: an agent working in an isolated worktree.
Nothing was pushed, production was not touched, no order or transaction was sent. The local stacks used a throwaway
signer keystore and database, with broadcast off.

Related documents: `docs/TRADING-API-ARCHITECTURE.md`, `docs/TRADING-API-SECURITY.md`, `docs/TRADING-API-OPENAPI.md`,
`docs/openapi/trading-v1.json`.

## Verification summary

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| New tests | `services/api/test/trading-api-unit.test.ts` 11, `services/api/test/trading-api.test.ts` 28, `apps/web/test/developer.test.ts` 10 — all pass |
| Full `pnpm test` (3 runs) | 126 files, 2 731 tests: 2 672 passed and 59 skipped on the clean run. In 2 of the 3 runs one existing test failed (see below). |
| Web build (`node scripts/build.mjs` + `vite build`) | exit 0; first chunk 257.7 kB (257 kB before); `Developer` chunk 32.3 kB |
| Playwright `tests/e2e/developer.spec.ts` on `scripts/dev-stack.sh` (port 8760, own database) | 1 passed (9.3 s) |
| `node scripts/gen-openapi.mts --check` | both files up to date |

Notes on the full suite, as observed in this worktree:

- **59 skipped tests** are the laboratory and sandbox suites (`lab-sandbox`, `lab-identity`, `research`, the two
  `research-runner` files, 2 in `agent-networks`). The worktree has no `research/.venv`. They are not touched by this work.
- Without `SPW_RESEARCH_PYTHON`, `perp-agent.test.ts` fails one test for the same reason (no laboratory Python in the
  worktree). The full runs above set `SPW_RESEARCH_PYTHON` to the main checkout's interpreter.
- **Flaky existing test**: `api.test.ts` › "swap: quotes are for the wallet's own addresses…" failed in 2 of 3 full
  runs with `expected 3 to be greater than or equal to 4` on `swap_quotes`, and passed 3 times out of 3 when run alone.
  The rows are written by a fire-and-forget insert (`swap.ts:83`) that the test reads without waiting. Not changed here
  (swaps belong to another workstream); it should be fixed there.

## Per item

### 1. API keys

- **Initial state**: no machine authentication except the research runner's shared secret; no key table.
- **Change**: tables `api_keys`, `api_key_usage`, `api_key_intents` (one block in `db.ts`). Token
  `spw_live_<id>_<secret>`, stored as HMAC-SHA-256 under a pepper kept in a 0600 file outside the database. Closed scope
  enum (12 scopes). Limits, restrictions, `mandate_id`, `rate_limit_per_min`, required expiry (≤ 365 days).
- **Tests**: token format and hash; the secret is absent from every table; expiry bounds; widening rule; CIDR match;
  creation, wrong passkey, replayed intent, forged challenge.
- **Result**: pass.
- **Limitation**: limits are recorded, not enforced. `mandate_id` is a stored UUID: nothing checks that the mandate
  exists or is active (the mandate table is in `packages/trading`, not available on this branch).

### 2. Principal, guard, limits, usage, replay protection

- **Initial state**: one `onRequest` hook, a boolean `isAuthed`, no identity, no authorization layer.
- **Change**: `apiKeyGate` branch in the hook; `req.principal`; `scopeGuard` as the single preHandler (default deny);
  per-key limiter with `RateLimit-*` headers; failed-auth throttle (10/min/address); usage row per call with
  retention; `withIdempotency` and optional `X-SPW-Timestamp`.
- **Tests**: every route of the Fastify instance outside `/api/v1/trading/` (enumerated from its route tree, more than
  190 routes) answers 403 to a valid key holding every scope; a route without a declared scope is closed; scope
  refusals are audited; rate limit, throttle, source address, key + cookie refusal; idempotent replay, conflict, stale
  timestamp; usage rows hold no query string and no secret.
- **Result**: pass.
- **Limitation**: limiters are in memory and per process. The timestamp header is optional and unsigned. The audit
  actor of the existing routes is still the literal `owner`; only the new code uses `actorOf(principal)`.

### 3. Key management (owner session only)

- **Initial state**: none.
- **Change**: `/api/v1/developer/keys` (list, prepare, create, revoke, rotate, update), `/usage`, `/status`. Create,
  rotate and widening need a passkey assertion whose challenge is the SHA-256 of the canonical intent; verified by the
  API's own WebAuthn code. Revocation and narrowing need the session only. Audit events `apikey.created`, `.revoked`,
  `.rotated`, `.updated`, `.denied`, `.approval_failed`.
- **Why not the signer's approval mechanism**: it is bound to the signer's intent kinds and the signer may not be
  changed in this work. Documented in the security document, with what this does and does not protect against.
- **Tests**: as in item 1, plus rotation (old key dead, same authority), intent bound to one key, narrowing versus
  widening.
- **Result**: pass.

### 4. Trading API

- **Initial state**: no `/api/v1/trading` route.
- **Change**: 14 read operations on the real services, 12 write operations answering `501 execution_not_wired`.
  Restrictions apply to reads.
- **Tests**: fixture-backed venue adapters (recorded venue answers), a real signer process, scripted chain balances,
  the paper engine. Stale flag and 503 when a venue is unreachable; ambiguous symbol 409; paper and live separated;
  signer down → 503; every write answers 501 for a key with a mandate and for the owner, never 2xx, creates no order
  and stores no idempotency record; `mandate_required` without a mandate. Real answers are parsed against the
  documented response schemas.
- **Result**: pass.
- **Limitations**: spot `mark` is the last 1 h close, not a live quote; no spot order book; `/orders` has no cursor
  pagination; GMX positions are read from the chain on each call.

### 5. OpenAPI 3.1

- **Change**: generated from the route table with zod 4.6.7's `z.toJSONSchema` (already in the lockfile; no new
  dependency). Script `scripts/gen-openapi.mts`; served at `GET /api/v1/trading/openapi.json`.
- **Tests**: the committed JSON and markdown equal the generated ones; every operation has `x-spw-scope`, the bearer
  scheme, the error model; mutations have the `Idempotency-Key` header; unwired operations document no 2xx.
- **Result**: pass.
- **Limitation**: response schemas are loose (main fields declared, additional properties allowed).

### 6. Webhooks

- **Change**: `alerts/webhook.ts` gained `postSigned` (the alert webhook uses it; behaviour unchanged).
  `/api/v1/developer/webhooks`, signing secret per endpoint in the secrets file, retries with backoff, delivery log.
- **Emitted now**: `key.revoked`, `risk.kill_switch`, `agent.updated` (owner actions only). **Pending**: `order.updated`.
- **Tests**: signature verified with the existing `verifyWebhook`; tampering and replay window; retry after 30 s; six
  attempts then failed; disabled endpoint; secret rotation; secret absent from the database.
- **Result**: pass.
- **Limitation**: creating an endpoint needs the session only; the URL host is not checked against private ranges.

### 7. Web

- **Change**: `apps/web/src/screens/Developer.tsx` (own chunk, route `/developer`, entry in Settings),
  `apps/web/src/developer.ts`, `dv` block in `i18n.ts` (FR and EN).
- **Tests**: component-level (`apps/web/test/developer.test.ts`) and the Playwright spec, which ran: key created with a
  virtual passkey, secret shown once and gone from the page, calls without a cookie, refusals outside the prefix,
  usage, documentation viewer, status, revocation, no horizontal overflow on a phone viewport.
- **Result**: pass.
- **Limitation**: the screen has no form to edit an existing key (the update routes exist and are tested on the API).
  A free-text revocation reason typed by the owner is shown as typed.

### 8. Documents

`docs/TRADING-API-ARCHITECTURE.md`, `docs/TRADING-API-SECURITY.md`, this file, and the generated reference.

## Transcript — the real server driven with curl

Stack: `SPW_DEV_PORT=8760 SPW_DEV_DB=spw_dev_v11api SPW_DEV_DIR=/tmp/spw-dev-v11api SPW_WORKERS=off scripts/dev-stack.sh`
(built bundles `dist/api.mjs` and `dist/signer.mjs`). Driver: `scripts/demo-trading-api.mts`, which runs each `curl`
command below and holds a software passkey to answer the WebAuthn challenges. Output as printed, on 2026-11-15
(server clock in UTC). Secrets, the session cookie and signature bytes are redacted by the driver; long request
bodies are cut. The market data in calls 3, 4 and 6 is live public data from the venues.

```text
# owner setup: registration options
$ curl -s -i -X POST http://localhost:8760/api/v1/auth/setup/options -H 'Origin: http://localhost:8760' -H 'x-spw-csrf: 1' -H 'content-type: application/json' -d '{}'
HTTP/1.1 200 OK
{"challengeId":"b405d015-4e92-4622-9436-baa117f1ec74","options":"…"}

# owner setup: the passkey is enrolled on the API and on the signer; a session cookie is set
$ curl -s -i -X POST http://localhost:8760/api/v1/auth/setup/verify -H 'Origin: http://localhost:8760' -H 'x-spw-csrf: 1' -H 'content-type: application/json' -d '{"challengeId":"b405d015-4e92-4622-9436-baa117f1ec74","response":{"id":"iVYN5Uy0yB20JxOLUR4g48pZkpY","rawId":"iVYN5Uy0yB20JxOLUR4g48pZkpY","type":"public-key","clientExtensionResults":{},"response":{"clientDataJSON":"eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGx… [736 bytes]'
HTTP/1.1 200 OK
{"ok":true}

# 1. prepare the key: the server builds the canonical intent and a WebAuthn request whose challenge is its SHA-256
$ curl -s -i -X POST http://localhost:8760/api/v1/developer/keys/prepare -H 'Cookie: spw=<SESSION>' -H 'Origin: http://localhost:8760' -H 'x-spw-csrf: 1' -H 'content-type: application/json' -d '{"name":"demo reader","scopes":["markets:read","agents:read","orders:prepare"],"expiresInDays":30,"limits":{"maxOrderNotionalUsd":500,"maxDailyNotionalUsd":2000}}'
HTTP/1.1 200 OK
{"intentId":"7568c73b-7e81-4e01-a119-c260cf370e11","intent":{"v":1,"action":"create","intentId":"7568c73b-7e81-4e01-a119-c260cf370e11","origin":"http://localhost:8760","preparedAt":"2026-11-16T00:27:03.951Z","key":{"id":"spk_dd12a76d8479","name":"demo reader","scopes":["agents:read","markets:read","orders:prepare"],"expiresAt":"2026-12-16T00:27:03.951Z","limits":{"maxOrderNotionalUsd":500,"maxDailyNotionalUsd":2000},"restrictions":{"networks":[],"venues":[],"instruments":[],"ipAllow":[]},"rateLimitPerMin":120,"mandateId":null}},"sha256":"4d540d1406082be3885da5fe4c5774e2846b4c370cce57eb66eb49c56ecf63ee","options":{"challenge":"TVQNFAYIK-OIXaX-TFd04oRrTDcMzlfrZutJxW7PY-4","rpId":"localhost","userVerification":"required"}}

# 2. create: the passkey assertion over that challenge; the secret is in this answer and nowhere else
$ curl -s -i -X POST http://localhost:8760/api/v1/developer/keys -H 'Cookie: spw=<SESSION>' -H 'Origin: http://localhost:8760' -H 'x-spw-csrf: 1' -H 'content-type: application/json' -d '{"intentId":"7568c73b-7e81-4e01-a119-c260cf370e11","assertion":{"id":"iVYN5Uy0yB20JxOLUR4g48pZkpY","rawId":"iVYN5Uy0yB20JxOLUR4g48pZkpY","type":"public-key","clientExtensionResults":{},"response":{"clientDataJSON":"eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlI… [581 bytes]'
HTTP/1.1 200 OK
{"key":{"id":"spk_dd12a76d8479","name":"demo reader","status":"active","scopes":["agents:read","markets:read","orders:prepare"],"limits":{"maxOrderNotionalUsd":500,"maxDailyNotionalUsd":2000},"restrictions":{"networks":[],"venues":[],"instruments":[],"ipAllow":[]},"rateLimitPerMin":120,"mandateId":null,"inertScopes":[],"rotatedFrom":null,"createdAt":1794788823964,"expiresAt":1797380823951,"revokedAt":null,"revokedReason":null,"lastUsedAt":null,"lastUsedIp":null},"secret":"spw_live_spk_dd12a76d8479_<REDACTED>"}

# 3. read: markets (Hyperliquid, live public data through the derivatives data service)
$ curl -s -i -X GET 'http://localhost:8760/api/v1/trading/markets?venue=hyperliquid&q=BTC&limit=2' -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 200 OK
x-request-id: abdff626-691a-4490-9643-e7c7e6404a0f
ratelimit-limit: 120
ratelimit-remaining: 119
ratelimit-reset: 60
{"markets":[{"id":"hyperliquid:BTC","kind":"perpetual","mark":"64950","ts":1794788824505,"stale":false,"source":"venue"}],"total":1,"errors":[]}

# 4. read: order book
$ curl -s -i -X GET 'http://localhost:8760/api/v1/trading/markets/hyperliquid:BTC/orderbook?depth=2' -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 200 OK
x-request-id: 464df700-0376-4440-8e5e-d3a36fea7560
ratelimit-limit: 120
ratelimit-remaining: 118
ratelimit-reset: 60
{"id":"hyperliquid:BTC","bids":[["64955","1.93466"],["64954","0.3704"]],"asks":[["64956","3.43743"],["64958","0.317"]],"ts":1794788824050,"stale":false,"source":"venue"}

# 5. read: agents
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/agents -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 200 OK
x-request-id: 98b310e2-9376-4a34-91a2-d7319f0b3cad
ratelimit-limit: 120
ratelimit-remaining: 117
ratelimit-reset: 60
{"agents":[]}

# 6. an ambiguous bare symbol: 409 with the candidates
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/markets/BTC -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 409 Conflict
x-request-id: 15ec9292-0348-476a-856b-400c43bb6e27
ratelimit-limit: 120
ratelimit-remaining: 116
ratelimit-reset: 60
{"error":"ambiguous_symbol","message":"'BTC' exists on several venues: name one of the candidates as venue:symbol","candidates":["dydx:BTC-USD","gmx:BTC/USD [BTC-BTC]","gmx:BTC/USD [BTC-USDC]","gmx:BTC/USD [TBTC-TBTC]","gmx:BTC/USD [USDG-USDG]","hyperliquid:BTC","spot:BTC"]}

# 7. REFUSED outside the prefix: the security overview
$ curl -s -i -X GET http://localhost:8760/api/v1/security/overview -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 403 Forbidden
{"error":"key_path_forbidden","message":"an API key is accepted under /api/v1/trading/ only"}

# 8. REFUSED outside the prefix: key management itself
$ curl -s -i -X GET http://localhost:8760/api/v1/developer/keys -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 403 Forbidden
{"error":"key_path_forbidden","message":"an API key is accepted under /api/v1/trading/ only"}

# 9. REFUSED outside the prefix: the emergency halt
$ curl -s -i -X POST http://localhost:8760/api/v1/security/emergency-halt -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>' -H 'content-type: application/json' -d '{}'
HTTP/1.1 403 Forbidden
{"error":"key_path_forbidden","message":"an API key is accepted under /api/v1/trading/ only"}

# 10. REFUSED scope: the key has no wallet:read
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/portfolio -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 403 Forbidden
x-request-id: c61c061c-2827-4a96-8a1b-0ddf08ccb80a
ratelimit-limit: 120
ratelimit-remaining: 115
ratelimit-reset: 59
{"error":"insufficient_scope","message":"this key lacks the scope wallet:read"}

# 11. REFUSED: key and session cookie together
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/agents -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>' -H 'Cookie: spw=<SESSION>'
HTTP/1.1 403 Forbidden
{"error":"mixed_credentials","message":"send an API key or the session cookie, never both"}

# 12. a write operation: scope held (orders:prepare), validated, replay-checked, then 501 — not a success
$ curl -s -i -X POST http://localhost:8760/api/v1/trading/orders/preview -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>' -H 'Idempotency-Key: demo-0001-preview' -H 'content-type: application/json' -d '{"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"market","size":"0.01"}'
HTTP/1.1 501 Not Implemented
x-request-id: 4ca4ea97-5b5c-4e6b-b147-787108204c78
ratelimit-limit: 120
ratelimit-remaining: 114
ratelimit-reset: 59
{"error":"execution_not_wired","message":"POST /api/v1/trading/orders/preview is declared but not connected to execution yet; nothing was done"}

# 13. the same without an Idempotency-Key
$ curl -s -i -X POST http://localhost:8760/api/v1/trading/orders/preview -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>' -H 'content-type: application/json' -d '{"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"market","size":"0.01"}'
HTTP/1.1 400 Bad Request
x-request-id: 3de8c3db-5acd-4601-a473-5152ac1f1032
ratelimit-limit: 120
ratelimit-remaining: 113
ratelimit-reset: 59
{"error":"idempotency","message":"an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required"}

# 14. no key at all
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/agents
HTTP/1.1 401 Unauthorized
{"error":"unauthenticated","message":"authentication required"}

# 15. the owner revokes the key (session only)
$ curl -s -i -X POST http://localhost:8760/api/v1/developer/keys/spk_dd12a76d8479/revoke -H 'Cookie: spw=<SESSION>' -H 'Origin: http://localhost:8760' -H 'x-spw-csrf: 1' -H 'content-type: application/json' -d '{"reason":"demo over"}'
HTTP/1.1 200 OK
{"key":{"id":"spk_dd12a76d8479","status":"revoked","revokedReason":"demo over"}}

# 16. REVOKED key
$ curl -s -i -X GET http://localhost:8760/api/v1/trading/agents -H 'Authorization: Bearer spw_live_<key id>_<REDACTED>'
HTTP/1.1 401 Unauthorized
x-request-id: 92bb16ba-c37e-467f-8407-60fa72808ade
{"error":"unauthenticated","message":"authentication required"}

# 17. the usage log of the key (owner): route patterns and statuses only
$ curl -s -i -X GET 'http://localhost:8760/api/v1/developer/usage?key=spk_dd12a76d8479' -H 'Cookie: spw=<SESSION>'
HTTP/1.1 200 OK
["GET /api/v1/trading/agents 401","POST /api/v1/trading/orders/preview 400","POST /api/v1/trading/orders/preview 501","GET /api/v1/trading/portfolio 403","GET /api/v1/trading/markets/:symbol 409","GET /api/v1/trading/agents 200","GET /api/v1/trading/markets/:symbol/orderbook 200","GET /api/v1/trading/markets 200"]
```
