# V6 — Alerts and monitoring

The owner is told, on his phone and in the app, when something important happens — without opening the app and polling.
Nothing in signing, policy, limits or money logic changed: the alerts layer only **reads** what the system already records.

Code: `services/api/src/alerts/` (dispatcher, rules, conditions, Web Push, webhook, routes), `services/api/src/monitor/`
(dashboard), `packages/core/src/alert-catalog.ts` (kinds + FR/EN wording, shared by the API, the web app and the service
worker), `apps/web/src/{alerts.ts,sw.ts,sw-core.ts}`, `apps/web/src/screens/{Alerts,Monitor}.tsx`.

## 1. How an event becomes an alert (and why exactly once)

Every important event already passes through three append-only tables: `audit_events` (the hash chain), `deriv_risk_events`
and `research_log`. **One dispatcher tails those tables by id** (`alerts/dispatcher.ts`, started with the other workers,
one pass every 5 s). The alternative — a hook inside `audit()` — was rejected: it would run inside or next to money
transactions (an alert for a transaction that later rolls back, or lost if the process dies between the write and the hook),
and it would put alert code on the money path. Tailing needs no change in that code at all.

One pass is **one database transaction**: advisory lock → read the rows after the stored cursor (`alert_cursors`) → insert
the alerts → advance the cursor → commit. Either all of it happened or none of it:

- crash before the commit: no alert, cursor unchanged, the next pass redoes the same rows;
- crash after: alerts and cursor are both there;
- process down for an hour: the rows wait in their tables, nothing is lost;
- two API processes: the advisory lock serializes them, the cursor makes the second one a no-op.

`audit_events` numbers its rows under a lock held until commit, so a plain cursor is exact. The two `bigserial` tables can
commit out of order; for them the pass re-reads an overlap window of 200 ids behind the cursor and records the ids it
handled in `alert_seen` (same transaction). A unique index on `(source, source_id, kind)` is the last line of defence.
On its first run the dispatcher starts **from the present** (`floor`): history is never replayed.
Tests: `services/api/test/alerts-engine.test.ts` › "exactly once" (restart, crash before commit, two dispatchers, late commit).

Things that are *states* rather than events (a transfer still pending, a mandate close to expiry, a signer that stopped
answering…) are **condition rules**, polled every 30 s. Each alert carries a dedupe key naming the episode
(`stuck:<proposal>`, `mandate:<id>:24`, `conn.down:<id>:<since>`…) under a unique index, and debounce clocks live in the
database (`alert_state`), so a condition that stays true — or a restart while it is true — says it once.

A few refusals are thrown by the money code and stored nowhere (`router_changed`, `contract_changed`,
`asset_table_mismatch`, `signer_*`). One Fastify `onError` hook (in `alerts/routes.ts`) sees them leave as error answers and
raises the alert, deduped per hour. Agents hitting the same refusal are caught through `research_log`.

**Delivery** (push, webhook) is a second step on rows marked `pending`. A row is claimed (`pending → sent`) *before* the
network call: a crash in between loses that one notification rather than repeating it. The alert itself is in the app
either way. Delivery is therefore at-most-once; alert creation is exactly-once.

## 2. Alert kinds and defaults

Every rule has its own switch (Alerts → Réglages → Règles d’alerte). A rule that is off produces nothing at all.
Criticals are on by default and ignore quiet hours and the hourly cap. Alerts store a **kind and parameters**, never a
sentence; FR/EN wording is in `packages/core/src/alert-catalog.ts`.

| Kind | Severity | Default | Source |
|---|---|---|---|
| `transfer.confirmed`, `swap.confirmed` | info | on | audit `transfer.finalized` |
| `transfer.failed`, `swap.failed` | warning | on | audit `transfer.failed` |
| `bridge.confirmed` | info | on | audit `bridge.done` |
| `bridge.failed` | warning | on | audit `transfer.failed` (bridge), `bridge.mint_reverted` |
| `transfer.stuck` | warning | on | condition: not final after 30 min (bridge: 90 min) |
| `deposit.received` | info | on | audit `deposit.seen` |
| `agent.order_filled` | info | on | audit; digest: one alert per agent per 30 min (0 = each order) |
| `agent.stopped_loss` | **critical** | on | audit `agent.stopped` (loss limit) |
| `agent.stopped_mandate`, `agent.stopped` | warning | on | audit `agent.stopped` |
| `agent.mandate_revoked` | info | on | audit `mandate.revoked` |
| `agent.data_stale` | warning | on | condition: no completed bar for more than 3 bars |
| `agent.signal_failures` | warning | on | research log: 3 invalid signals in a row |
| `mandate.expiring` | info (72 h) / warning (24 h) | on | condition |
| `deriv.paper.filled` | info | on | audit `deriv.paper.fill` — worded "papier, simulé" |
| `deriv.live.filled` | info | on | audit `deriv.live.order_filled` |
| `deriv.order_rejected` | warning | on | risk `order_refused`, audit `deriv.live.order_rejected`; digest 10 min per account |
| `deriv.order_unknown` | **critical** | on | condition: live order `unknown` for more than 60 s |
| `deriv.position_opened` | info | **off** | derived from fills (net size kept per account and instrument) |
| `deriv.position_closed` | info | on | same |
| `deriv.margin_warning` | warning | on | risk `margin_warning` (at most one per account per hour) |
| `deriv.paper.liquidation` | warning | on | audit — worded "SIMULÉE / SIMULATED" |
| `deriv.live.liquidation` | **critical** | on | condition: a venue fill flagged `liquidation` |
| `deriv.funding` | info | on | condition: abs(payment) ≥ 5 USD |
| `deriv.loss_limit` | **critical** (paper account: warning) | on | audit `deriv.paper.halt` (daily / total) |
| `deriv.halt` | **critical** | on | audit `deriv.live.halt` |
| `deriv.divergence` | **critical** | on | risk `divergence` |
| `deriv.divergence_cleared` | info | on | risk `divergence_cleared` |
| `deriv.asset_table_mismatch` | **critical** | on | HTTP refusal `asset_table_mismatch` |
| `security.passkey_added` | **critical** | on | audit `device.added` |
| `security.new_device` | warning | on | audit `login.ok` from a browser never seen |
| `security.login_failed` | warning | on | audit `login.failed`; digest 15 min |
| `security.signer_unreachable` | **critical** | on | condition, debounced 2 min |
| `security.signer_back` | info | on | condition |
| `security.signer_halted` | **critical** | on | condition (signer status) |
| `security.signer_unhalted` | warning | on | condition |
| `security.signer_refused` | warning | on | audit `agent.order_refused` / `*.denied`, risk code `signer`, HTTP `signer_*`; digest 15 min |
| `security.pin_mismatch` | **critical** | on | `router_changed` (router, Jupiter program), `contract_changed` (CCTP); once per hour per pin |
| `security.audit_broken` | **critical** | on | condition: full chain verification every 10 min |
| `security.policy_changed` | warning | on | signer policy hash changed; audit `deriv.*.policy_replaced` |
| `system.api_restarted` | info | on | dispatcher start |
| `system.worker_failing` | warning | on | a `loop()` failed 5 passes in a row |
| `system.backup_missing` | warning | on | newest `sp-wallet-*.sql.gz` older than 36 h |
| `system.disk_low` | warning | on | free space under 10 % |
| `conn.down` / `conn.up` | warning / info | on | any connector of the dashboard, debounced 3 min |
| `system.alerts_capped` | info | fixed | the single "N more alerts" summary |
| `system.test` | info | fixed | the test button |

Thresholds are editable in the same screen (`thresholds` in the settings).

**Storm protection.** Digests and per-episode dedupe keys first; then a global cap (default 20 push/webhook deliveries per
hour, criticals excepted). What the cap holds back stays in the app, and when the hour ends **one** `system.alerts_capped`
alert says how many. A feed must be down for the whole debounce before it alerts: a feed flapping every 20 s says nothing.

**Quiet hours** (off by default; 22:00–07:00 `America/Toronto` when turned on, zone editable): non-critical alerts are
recorded in the app but not pushed, and are not pushed later either.

## 3. Channels — and what leaves the server

| Channel | Default | What leaves the server | To whom |
|---|---|---|---|
| In-app (bell, Alerts screen, SSE) | always | nothing | — |
| Web Push | off until a device subscribes | an encrypted payload: kind, severity, id, timestamp, subject id, and **safe parameters only** (names, networks, counts, durations) | the browser vendor's push service (Apple, Google, Mozilla) relays ciphertext it cannot read; it learns that a notification was sent, when, and its size |
| Webhook | **off** | a signed JSON body: kind, severity, English title and private body, safe parameters | the URL the owner typed |

"Show details" (off by default) adds amounts, symbols, prices and reason texts to push payloads; the webhook has its own
"include details" switch, and the settings screen shows the exact JSON that will be sent before it is enabled.
Addresses and transaction ids are never put in an alert's parameters. No e-mail, no SMS, no third-party notification service.

### Web Push
- Node `crypto` only (`alerts/webpush.ts`): RFC 8291 + RFC 8188 (`aes128gcm`), RFC 8292 (VAPID, ES256), RFC 8030
  (TTL, Urgency: `high` for criticals). Checked against the RFC 8291 appendix A vector.
- The VAPID key pair is generated on the server at first start and stored in
  `${SPW_DATA_DIR:-~/.config/sp-wallet}/alerts-secrets.json` (directory 0700, file 0600) — never in the database, never
  logged. The webhook secret lives in the same file.
- A subscription endpoint must be one of the browsers' push services (`*.push.apple.com`, `fcm.googleapis.com`,
  `*.push.services.mozilla.com`, `*.notify.windows.com`): the server never POSTs to an arbitrary URL.
- One subscription per device, with a label; "Tester" sends a harmless notification through the real path; a subscription
  the push service answers 404/410 for is removed automatically, other failures are counted and kept.
- The service worker (`/sw.js`) only shows notifications and handles the tap. It has no `fetch` handler and no cache.
  The notification is rendered on the device, in the language chosen in the app on that device.

### iPhone: installation steps (required for push)
iOS delivers Web Push only to a web app **installed on the Home Screen**, iOS 16.4 or later. In an ordinary Safari tab
`PushManager` does not exist and the settings screen shows these steps instead of the button.
1. Open `https://wallet.spboucher.ai` in **Safari**.
2. Share → **Sur l’écran d’accueil** (Add to Home Screen).
3. Open SP Wallet from its new icon and unlock with the passkey.
4. Bell → **Réglages** → **Activer les notifications** → allow → **Tester**.
If the permission was refused: Réglages iOS → Notifications → SP Wallet. Removing the icon removes the subscription
(the server drops it at the next 410).

### Webhook
`POST <url>` with `X-SPW-Timestamp: <unix s>` and `X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
The receiver recomputes the HMAC over the raw body and refuses a timestamp older than 5 minutes (`verifyWebhook` in
`alerts/webhook.ts` is the reference). HTTPS only, no redirect followed. The secret is generated by the server and shown once.

## 4. Monitoring dashboard ("État du système")

Read-only, cached 10–30 s, behind the owner session: `GET /api/v1/monitor/{capital,pnl,exposure,health}`.
- **Capital**: wallet (from the existing `/portfolio` answer), LIVE agent vaults, venue accounts — three separate lines,
  never summed; paper agents, paper accounts and testnet accounts shown apart and tagged *simulé*.
- **PnL** today / 7 d / 30 d per agent and per derivatives account, from `agent_equity` and `deriv_equity`. A deposit or
  withdrawal inside the window counts as PnL (said on screen); a series younger than the window is marked `*`.
- **Exposure** per asset, real and simulated apart, with the caveat that spot and perpetual contracts differ. Positions of
  venue accounts are derived from the recorded fills since the accepted baseline (the venue is not called).
- **Connectors** with last-success age — all read passively: signer, PostgreSQL, each RPC network (worker health cache),
  market data per source (newest BTC bar), derivatives venues (last equity snapshot of an active account), swap providers
  (last quote actually asked), Circle attestation (only a bridge in flight tells). Unmeasured is shown as *non mesuré*,
  never as healthy.
- Worker loop heartbeats (`loop()` in `worker.ts`), last backup, disk, audit chain, versions (API commit, signer key id).

## 5. Deployment

| Item | Value |
|---|---|
| `SPW_DATA_DIR` | directory of `alerts-secrets.json` (default `~/.config/sp-wallet`). **Keep it across deploys**: a new VAPID key invalidates every device subscription. |
| `SPW_VAPID_SUBJECT` | optional contact for push services (`mailto:` or `https:`); default = `SPW_ORIGIN` |
| `SPW_BACKUP_DIR` | where `scripts/backup.sh` writes (default `~/backups/sp-wallet`). If the API cannot see the directory the backup rule is skipped and the dashboard says so. |
| `SPW_DISK_PATH` | path whose volume is checked (default: home directory) |
| `SPW_COMMIT` | commit shown on the dashboard; `scripts/build.mjs` embeds `git rev-parse --short HEAD` |
| `SPW_PUSH_ALLOW_HOSTS` | tests only (a local fake push service). Leave unset in production. |

- Outgoing HTTPS from the API node to `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`.
- Reverse proxy: `/api/v1/alerts/stream` is Server-Sent Events (`x-accel-buffering: no` is sent; Caddy streams as is).
  `/sw.js` must be served from the site root — it is, by the API's static handler, with `cache-control: no-cache`.
- CSP: **unchanged** (`default-src 'self'` covers the worker and the manifest; nothing is loaded from a third party).
- Tables are created by `migrateAlerts()` at start: `alerts`, `alert_cursors`, `alert_seen`, `alert_state`,
  `push_subscriptions`. They hold no secret.

## 6. How to test

```
npx vitest run services/api/test/alerts-webpush.test.ts   # RFC 8291 vector, VAPID, endpoint allow-list
npx vitest run services/api/test/alerts-engine.test.ts    # rules, exactly-once, conditions, quiet hours, cap, webhook
npx vitest run services/api/test/alerts-api.test.ts       # routes, subscription lifecycle (fake push service), dashboard
npx vitest run packages/core/test/alert-catalog.test.ts   # every kind in FR and EN
npx vitest run apps/web/test/alerts-sw.test.ts            # service worker handler
(cd apps/web && node_modules/.bin/vite build) && npx playwright test -c tests/e2e/playwright.config.ts alerts.spec.ts
```
The test databases (`spw_v6_alerts_*`) are created on the local PostgreSQL. `ALERTS_SHOTS=1` rewrites `docs/v6/screens/alerts-*.png`.

On the real phone: install to the Home Screen, enable, press **Tester**; lock the phone and check the notification shows a
title and no amount; turn "Afficher les détails" on and test again.

## 7. Known limits

- Reason texts inside an alert (`reason`, connector details on the dashboard) are the server's English messages; titles and
  sentences around them are translated.
- The agent engine runs on its own timer, not through `loop()`: it has no heartbeat on the dashboard (each agent's last bar is shown instead).
- Live position opened/closed is computed from the wallet's own fills plus the accepted baseline; a position changed from another interface shows up as a divergence alert instead.
- `system.backup_missing` needs at least one backup file to measure from; an existing but empty directory is shown as "aucune" and does not alert.
- An alert held back by quiet hours or the cap is never pushed afterwards.
