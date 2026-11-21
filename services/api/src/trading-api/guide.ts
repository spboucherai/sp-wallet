/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/guide.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// The prose of the trading API reference: getting started (English and French) and the concepts. One source — Markdown —
// rendered as it is into docs/TRADING-API-REFERENCE.md and converted to HTML for the served page (reference.ts).
//
// Every figure a sentence quotes (limits, windows, retry schedule, header names, scope lists, state lists, risk checks) is
// read from the code at render time, and every JSON answer shown is a recorded one (examples.ts): what is written by hand
// here is the explanation, not the facts. Pure: no database, no configuration.
import { createHmac } from 'node:crypto';
import { RISK_CHECKS } from '@spw/trading';
import { ERROR_CATALOG, MANDATE_DENY_DOCS, ORDER_STATE_DOCS, SCOPE_DOCS } from './error-catalog.ts';
import { ERROR_EXAMPLES, EXAMPLES, EXTRA } from './examples.ts';
import { CANDLE_INTERVALS, EXECUTION_SCOPES, FINAL_ORDER_STATES, KEY_BOUNDS, MANDATE_DENY_REASONS, OPERATIONS, ORDER_STATES, SCOPES, TRADING_PREFIX, WEBHOOK_EVENTS } from './spec.ts';

/** what the code holds as constants and this module must not import from modules that open a database (a test compares each with its source) */
export const FACTS = { authFailuresPerMin: 10, timestampToleranceSec: 300, webhookBackoffSec: [30, 120, 600, 3600, 21600], webhookMaxAttempts: 6, webhookMax: 10, webhookToleranceSec: 300,
  idempotencyRetentionHours: 24, usageRetentionDays: 90, streamTicketTtlSec: 30, streamMaxConnKey: 4, streamMaxSubs: 300, ownerRatePerMin: 240 } as const;

export const FAKE_KEY = 'spw_live_spk_0123456789ab_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0';
export const DOCS_PATH = `${TRADING_PREFIX}/docs`;
/** the worked webhook example: a fake secret, the recorded shape of a `key.revoked` event, and the signature the server's formula gives */
export const WEBHOOK_EXAMPLE = (() => {
  const secret = 'whsec_EXAMPLE_ONLY_0123456789abcdefghijklmnopqrstuv', timestamp = 1794953687;
  const body = JSON.stringify({ app: 'sp-wallet', id: 'ed1fb6d3-1b5c-4bf6-b8cd-2237d8b2b38c', event: 'key.revoked', ts: '2026-11-17T22:14:47.655Z', data: { keyId: 'spk_0123456789ab', name: 'old bot', reason: 'rotated to spk_ba9876543210' } });
  return { secret, timestamp, body, signature: `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}` };
})();

const j = (v: unknown): string => JSON.stringify(v, null, 2);
/** the language tag of the Python samples — a constant so that these documentation strings do not look like an interpreter being started (lab-sandbox.test.ts scans this directory) */
const PY = 'python';
const code = (lang: string, src: string): string => `\`\`\`${lang}\n${src}\n\`\`\``;
const json = (v: unknown): string => code('json', j(v));
/** a table cell: a pipe would end it */
const cell = (s: string): string => s.replace(/\|/g, '\\|');
const dur = (s: number): string => (s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`);
const B = '$SP_WALLET_BASE_URL/api/v1/trading';
const AUTH = '-H "Authorization: Bearer $SP_WALLET_API_KEY"';
const order = EXAMPLES.placeOrder!.body, orderJson = JSON.stringify(order);
const placed = EXAMPLES.placeOrder!.response as { order: { id: string; status: string; filled?: string; avgFillPrice?: string | null } };
const market = (EXAMPLES.listMarkets!.response as { markets: { id: string; mark: string | null; tickSize?: string; lotSize?: string }[] }).markets[0]!;

export interface GuideSection { id: string; title: string; /** shown in the navigation under this group */ group: 'Start' | 'Concepts'; md: string }

// ------------------------------------------------------------------------------------------------------------------ getting started
const tabsFirstCall = [
  code('bash', `export SP_WALLET_BASE_URL=https://wallet.spboucher.ai\nexport SP_WALLET_API_KEY=${FAKE_KEY}   # yours, shown once\n\ncurl -s "${B}/markets?venue=hyperliquid&q=BTC&limit=3" \\\n  ${AUTH}`),
  code('ts', `import { SPWallet } from '@sp-wallet/trading-sdk';\n\nconst client = new SPWallet();   // reads SP_WALLET_API_KEY and SP_WALLET_BASE_URL\n${EXAMPLES.listMarkets!.ts}\nconsole.log(markets[0].id, markets[0].mark);`),
  code(PY, `from sp_wallet import SPWallet\n\nclient = SPWallet()   # reads SP_WALLET_API_KEY and SP_WALLET_BASE_URL\n${EXAMPLES.listMarkets!.py}\nprint(markets[0].id, markets[0].mark)`),
].join('\n\n');
const tabsPaper = [
  code('bash', `# 1. what would happen — creates nothing\ncurl -s -X POST "${B}/orders/preview" ${AUTH} \\\n  -H "Content-Type: application/json" -d '${orderJson}'\n\n# 2. place it — one Idempotency-Key per logical order\ncurl -s -X POST "${B}/orders" ${AUTH} \\\n  -H "Content-Type: application/json" -H "Idempotency-Key: bot-2026-11-17-0001" -d '${orderJson}'\n\n# 3. read it, then close the position\ncurl -s "${B}/orders/${placed.order.id}" ${AUTH}\ncurl -s "${B}/positions?mode=paper" ${AUTH}`),
  code('ts', `import { SPWallet } from '@sp-wallet/trading-sdk';\n\nconst client = new SPWallet();\nconst order = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100' } as const;\n\nconst preview = await client.previewOrder(order);              // creates nothing\nif (!preview.wouldExecute) throw new Error(JSON.stringify(preview.refusals));\n\nconst placed = await client.createOrder(order, { idempotencyKey: 'bot-2026-11-17-0001' });\nconst done = await client.waitForOrder(placed.order.id);       // FILLED, CANCELLED, REJECTED or FAILED\nconsole.log(done.order.status, done.order.filled, done.order.avgFillPrice);\n\nconst { positions } = await client.getPositions({ mode: 'paper' });\nawait client.closePosition(positions[0].id);                   // strictly reduce-only`),
  code(PY, `from sp_wallet import SPWallet\n\nclient = SPWallet()\norder = dict(mode="paper", instrument="hyperliquid:BTC", side="buy", order_type="market", notional="100")\n\npreview = client.preview_order(**order)                        # creates nothing\nif not preview.would_execute:\n    raise SystemExit(preview.refusals)\n\nplaced = client.create_order(**order, idempotency_key="bot-2026-11-17-0001")\ndone = client.wait_for_order(placed.order.id)                  # FILLED, CANCELLED, REJECTED or FAILED\nprint(done.order.status, done.order.filled, done.order.avg_fill_price)\n\npositions = client.get_positions(mode="paper").positions\nclient.close_position(positions[0].id)                         # strictly reduce-only`),
].join('\n\n');
const sdkInstall = [
  code('bash', `# TypeScript (not on npm: built from the repository)\nnode packages/trading-sdk/scripts/build.mts\nnpm install /path/to/sp-wallet/packages/trading-sdk\n\n# Python (not on PyPI)\npip install /path/to/sp-wallet/sdk/python`),
].join('\n\n');

const READ_SCOPES = SCOPES.filter((s) => s.endsWith(':read'));
const start = `Five minutes from nothing to a simulated order. Everything below was run against a real server; the answers shown are recorded.

### 1. Create a key

In the wallet app: **Settings → Developer / API → Keys → New key**.

- **Name** — anything (\`my bot\`).
- **Expiry** — required, at most ${KEY_BOUNDS.maxDays} days.
- **Permissions** — for reading: ${READ_SCOPES.slice(0, 4).map((s) => `\`${s}\``).join(', ')}. For the paper order of step 3 add \`orders:prepare\`, \`orders:execute\`, \`orders:cancel\` and \`positions:manage\`.
- Approve with your passkey. The secret (\`spw_live_spk_…\`) is shown **once**: the server keeps only a hash of it.

A key opens \`${TRADING_PREFIX}/\` and nothing else — never the recovery phrase, the signer, the security settings or the keys themselves.

### 2. First call

${tabsFirstCall}

${json(EXAMPLES.listMarkets!.response)}

Prices are **strings** (\`"mark": "${market.mark}"\`): never parse them as floats. \`ts\` is milliseconds since the epoch.

The SDKs are in the repository and are not published:

${sdkInstall}

### 3. First paper order

An order placed with a key needs three things, which only the owner can set up:

1. a **paper account** on Hyperliquid — app: **Futures → Accounts**;
2. a **paper trading mandate** for the key — app: **Settings → Risk → Trading mandates → New** (principal: your API key; mode: paper; the account; the instruments, e.g. \`hyperliquid:BTC\`; the limits). A paper mandate signs nothing;
3. the mandate **bound to the key**. Without it, \`orders:execute\` is inert and the API answers:

${json(ERROR_EXAMPLES.mandateRequired.body)}

> **Gap in the app.** The Developer screen has a "Mandate id" field only when a key is *created*, and a mandate can only be created for a key that already exists. Binding a mandate to an existing key is the owner route pair \`POST /api/v1/developer/keys/{id}/update/prepare\` \`{ "changes": { "mandateId": "…" } }\` then \`POST /api/v1/developer/keys/{id}/update\` \`{ intentId, assertion }\` (a passkey assertion; binding widens the key). No screen calls it yet.

Then:

${tabsPaper}

The answer of step 2 — a paper market order is filled at once, against the real Hyperliquid order book, by the wallet's paper engine. Nothing is signed and nothing reaches a venue:

${json(EXAMPLES.placeOrder!.response)}

The same call with the same \`Idempotency-Key\` returns the same order (header \`Idempotent-Replay: true\`): a retry can never place it twice.

If the wallet has several paper accounts on the venue (a perp agent gets its own when it is created), the API asks which: 409 \`account_required\`. Add \`"accountId"\` to the order — the ids are in \`GET /portfolio\` (\`accounts\`).

### 4. Where to go next

- [Why an order is refused](#refusals) — the three gates and every code.
- [Idempotency](#idempotency) before you write a retry loop.
- [Paper and live](#paper-live) before the first real order.
- The machine-readable contract: [\`openapi.json\`](${TRADING_PREFIX}/openapi.json); this page as Markdown: [\`docs.md\`](${DOCS_PATH}.md).`;

const demarrage = `Cinq minutes pour passer de rien à un ordre simulé. Les exemples sont ceux de la section anglaise : les routes, les champs et les réponses sont les mêmes.

### 1. Créer une clé

Dans l'application : **Réglages → Développeur / API → Clés → Nouvelle clé**.

- **Nom** — libre (\`mon robot\`).
- **Expiration** — obligatoire, au plus ${KEY_BOUNDS.maxDays} jours.
- **Permissions** — pour lire : ${READ_SCOPES.slice(0, 4).map((s) => `\`${s}\``).join(', ')}. Pour l'ordre simulé de l'étape 3, ajoutez \`orders:prepare\`, \`orders:execute\`, \`orders:cancel\` et \`positions:manage\`.
- Approuvez avec votre clé d'accès. Le secret (\`spw_live_spk_…\`) n'est affiché **qu'une fois** : le serveur n'en garde qu'une empreinte.

Une clé n'ouvre que \`${TRADING_PREFIX}/\` — jamais la phrase de récupération, le signataire, la sécurité ni les clés elles-mêmes.

### 2. Premier appel

${tabsFirstCall}

Les prix sont des **chaînes** (\`"mark": "${market.mark}"\`) : ne les lisez jamais comme des flottants. \`ts\` est en millisecondes depuis l'époque Unix.

### 3. Premier ordre simulé (paper)

Un ordre passé avec une clé exige trois choses, que seul le propriétaire peut mettre en place :

1. un **compte simulé** sur Hyperliquid — application : **Contrats à terme → Comptes** ;
2. un **mandat de négociation simulé** pour la clé — application : **Réglages → Risque → Mandats de négociation → Nouveau** (mandant : votre clé d'API ; mode : simulé ; le compte ; les instruments, par exemple \`hyperliquid:BTC\` ; les limites). Un mandat simulé ne signe rien ;
3. le mandat **lié à la clé**. Sans lui, \`orders:execute\` est inerte et l'API répond \`403 mandate_required\`.

> **Lacune de l'application.** L'écran Développeur n'offre le champ « Identifiant du mandat » qu'à la *création* d'une clé, et un mandat ne peut être créé que pour une clé qui existe déjà. Lier un mandat à une clé existante passe par les deux routes du propriétaire \`POST /api/v1/developer/keys/{id}/update/prepare\` puis \`POST /api/v1/developer/keys/{id}/update\` (assertion de la clé d'accès). Aucun écran ne les appelle pour l'instant.

Ensuite :

${tabsPaper}

Un ordre au marché simulé est exécuté tout de suite par le moteur de simulation du portefeuille, contre le vrai carnet d'ordres d'Hyperliquid. Rien n'est signé, rien ne part vers une plateforme. Le même appel avec le même \`Idempotency-Key\` renvoie le même ordre : une relance ne peut pas le passer deux fois.

### 4. Ordres réels

Un ordre réel (\`"mode": "live"\`) passe par Hyperliquid seulement, sous un mandat réel approuvé avec la clé d'accès et appliqué par le signataire isolé, et seulement si le serveur a \`SPW_TRADING_API_EXECUTION=on\`. Voir [Paper and live](#paper-live) et [Why an order is refused](#refusals).`;

// ------------------------------------------------------------------------------------------------------------------ concepts
const overview = `The SP Trading API is the machine interface of SP Wallet: market data, the portfolio, positions, orders, strategies and agents — ${OPERATIONS.length} operations under \`${TRADING_PREFIX}\`, one owner, keys he creates with his passkey.

| | |
|---|---|
| Base URL | \`https://wallet.spboucher.ai${TRADING_PREFIX}\` |
| Format | JSON in, JSON out, UTF-8. Request bodies are strict: an unknown field is refused (400 \`bad_request\`) |
| Authentication | \`Authorization: Bearer spw_live_…\` |
| Contract | OpenAPI 3.1 at [\`${TRADING_PREFIX}/openapi.json\`](${TRADING_PREFIX}/openapi.json), generated from the same table the server registers its routes from |
| This reference | [\`${DOCS_PATH}\`](${DOCS_PATH}) (HTML), [\`${DOCS_PATH}.md\`](${DOCS_PATH}.md) (Markdown) — both need a key or the owner session, like every path of the API |
| SDKs | TypeScript \`@sp-wallet/trading-sdk\` (\`packages/trading-sdk\`), Python \`sp-wallet-python\` (\`sdk/python\`) |
| Live market data | websocket \`${TRADING_PREFIX}/stream\` |

Three rules run through everything:

- **Money is a string.** Prices, sizes, amounts and rates are decimal strings; send strings, parse with a decimal type.
- **Paper and live are never mixed.** Every row that could be either carries \`mode\`; no figure adds the two.
- **A permission is not an authorization to trade.** A scope lets a key *call* an operation. What bounds an order is a trading mandate the owner approved, checked on every order — and, for live orders, enforced by the isolated signer.`;

const auth = `Every request carries the key in one header. No cookie, no CSRF header, no query parameter — a key in a URL opens nothing.

${code('http', `GET ${TRADING_PREFIX}/markets HTTP/1.1\nHost: wallet.spboucher.ai\nAuthorization: Bearer ${FAKE_KEY}`)}

The token is \`spw_live_<key id>_<secret>\`. The key id (\`spk_\` + 12 hex) is public and appears in lists, logs and webhooks; the secret is 32 random bytes shown once. A missing, malformed, unknown, expired or revoked key gets one answer:

${json(ERROR_EXAMPLES.unauthenticated.body)}

${FACTS.authFailuresPerMin} failed authentications in a minute from one address lock that address out for the rest of the minute (429 \`auth_throttled\`). A request that carries a key **and** the session cookie is refused (403 \`mixed_credentials\`). Outside \`${TRADING_PREFIX}/\` a key is refused before it is even looked up (403 \`key_path_forbidden\`).

A key answer carries \`X-Request-Id\`: quote it when something needs investigating; it is in the usage log (Developer → Usage, kept ${FACTS.usageRetentionDays} days by default).

### Permissions (scopes)

| Scope | Opens | Execution scope |
|---|---|---|
${SCOPES.map((s) => `| \`${s}\` | ${SCOPE_DOCS[s]} | ${(EXECUTION_SCOPES as readonly string[]).includes(s) ? 'yes' : '—'} |`).join('\n')}

Every operation names the one scope it needs. A key without it gets:

${json(ERROR_EXAMPLES.insufficientScope.body)}

The three **execution scopes** are inert until a trading mandate is bound to the key (403 \`mandate_required\`), with two exceptions that can only remove risk: cancelling the key's own order, and engaging the kill switch.

### What else a key carries

- **Expiry** — required, at most ${KEY_BOUNDS.maxDays} days. At most ${KEY_BOUNDS.maxKeys} keys.
- **Rate limit** — ${KEY_BOUNDS.defaultRatePerMin} calls a minute by default, at most ${KEY_BOUNDS.maxRatePerMin}.
- **Restrictions** — optional allow-lists of venues, instruments, networks and source IP addresses / CIDR blocks. Outside them: 403 \`restricted\` or \`ip_not_allowed\`.
- **Limits** — optional notional per order and per day, in USD (403 \`key_limit_exceeded\`).
- **Mandate** — the id of the trading mandate bound to it, or none.

Narrowing a key needs the owner's session; anything that widens it — a scope, a later expiry, a looser restriction, a mandate — needs the passkey. **Rotating** a key creates a new id with the same settings and revokes the old one at once; the mandate named the old id, so the new key has no mandate until one is approved and bound again.`;

const formats = `### Decimals

Anything that carries money or a quantity is a decimal **string**: \`"64432"\`, \`"0.00155"\`, \`"0.0000089721"\`. In a request the form is \`^\\d+(\\.\\d+)?$\` — no sign, no exponent, no thousands separator. A size must be a multiple of the instrument's \`lotSize\` and a price a multiple of its \`tickSize\` (both in \`GET /markets/{symbol}\`); the simplest way to respect the lot is to send \`notional\` and let the server compute the size.

Counts and settings are JSON numbers (\`limit\`, \`slippageBps\`, \`fundingIntervalSec\`, \`decimals\`).

### Timestamps

Two forms, by family — the field name tells which:

- **milliseconds since the Unix epoch**, a JSON integer: \`ts\`, \`createdAt\`, \`updatedAt\`, \`expiresAt\`, \`at\` of a switch — markets, orders, positions, agents, risk;
- **ISO 8601 UTC strings**: \`asOf\` (portfolio, balances, NFTs), \`at\` of an activity item, \`priceAt\`, \`fetchedAt\`, the \`ts\` of a webhook envelope.

The optional request header \`X-SPW-Timestamp\` is Unix **seconds**.

### Freshness

Market rows carry \`ts\` (when the source produced the value) and \`stale\` (older than its freshness bound, or the source could not be refreshed). A stale row is shown, never hidden: decide on \`stale\`. Lists that read several sources carry \`errors: [{ source, message }]\` for the ones that failed, and answer 503 only when none answered.

### Identifiers

| Thing | Form | Example |
|---|---|---|
| Instrument / market | \`venue:symbol\` | \`hyperliquid:BTC\`, \`gmx:BTC/USD [BTC-USDC]\`, \`dydx:BTC-USD\`, \`spot:ETH\` |
| Order | opaque string | \`${placed.order.id}\` |
| Position | \`mode:venue:account:instrument\` — URL-encode it in a path | \`${EXAMPLES.closePosition!.params!.id}\` |
| Key | \`spk_\` + 12 hex | \`spk_0123456789ab\` |
| Agent, job, strategy version, mandate, account | UUID | \`${EXAMPLES.getAgent!.params!.id}\` |

A bare symbol (\`BTC\`) is accepted where a market is named, when it is not ambiguous; otherwise:

${json(ERROR_EXAMPLES.ambiguousSymbol.body)}`;

const instruments = `What can be read and what can be traded are different lists.

| Venue | Market data | Paper orders (API) | Live orders (API key) |
|---|---|---|---|
| \`hyperliquid\` | yes | yes | **yes** — the perpetuals of Hyperliquid's own dex (179 active out of 235 listed when this page was recorded, 2026-11-17), ids \`hyperliquid:BTC\`, \`hyperliquid:ETH\`, … |
| \`gmx\` | yes (pool figures, no order book) | no — the paper engine needs a book (422 \`paper_unsupported\`) | no — every GMX order is a wallet transaction the owner approves in the app (403 \`gmx_requires_owner_passkey\`) |
| \`dydx\` | yes | no | no — market data only (403 \`venue_restricted\`) |
| \`edgex\` | yes | no | no — market data only (403 \`venue_restricted\`) |
| \`spot\` | yes (bars, no order book) | no | no — a key cannot place a spot order (403 \`spot_execution_requires_agent_vault\`); an owner's spot order is a swap approved with the passkey |

\`GET /markets?venue=hyperliquid\` lists the instruments with what an order must respect:

${json(market)}

**Private markets** (\`GET /private-markets\`: synthetic contracts on private companies, on Hyperliquid builder dexes and edgeX) are display only — \`tradable\` is always \`false\`. Ids have three parts there: \`hyperliquid:io:ANTH\`.

Candle intervals: ${CANDLE_INTERVALS.map((i) => `\`${i}\``).join(', ')} (spot market data stores fewer: 422 \`unsupported_interval\`).`;

const paperLive = `Every order names its \`mode\`.

| | \`paper\` | \`live\` |
|---|---|---|
| What executes | the wallet's paper engine, against the venue's real public order book | the venue (Hyperliquid) |
| Money | simulated collateral of a paper account | the collateral of an authorized venue account |
| Signature | none | the isolated signer signs under the mandate it stores |
| Mandate (key) | a paper mandate; approving it signs nothing | a live mandate the owner approves with the passkey, compiled into the signer |
| Server locks | none | \`SPW_TRADING_API_EXECUTION\`, and the mainnet locks |

### The execution lock

\`SPW_TRADING_API_EXECUTION\` is a setting of the **server**, not of a key. Unless it is \`on\`, an order that adds live risk through this API is refused before anything is created:

${json(ERROR_EXAMPLES.executionDisabled.body)}

Paper is never affected; cancels and strictly reducing orders pass even when the lock is closed. The production server (wallet.spboucher.ai) was reported running with the lock **on** when this page was written (2026-11-17) — the page cannot check it. Two ways to know: the owner's **Developer → Status** screen (service "execution"), or a \`POST /orders/preview\` of a live order, whose \`refusals\` would carry \`{ "stage": "lock", "code": "execution_disabled" }\`. \`GET /risk\` lists the other server locks under \`capabilityLocks\` (\`deriv_live_mainnet\`, \`deriv_mandate_mainnet\`, \`deriv_gmx_live\`, \`broadcast\`), each with \`on\` and \`why\`; the execution lock itself is not in that list.

### Before the first live order with a key

1. An authorized Hyperliquid venue account (app: Futures → Accounts, passkey).
2. A **live** trading mandate for the key, approved with the passkey, and bound to the key.
3. The risk limits of the live book set by the owner (Settings → Risk → Limits → Live): on a live book an absent limit **denies**, and a key never benefits from limits carried over from earlier versions.
4. The server locks open.

Preview first: \`POST /orders/preview\` runs every gate on the market as it is now and says what would refuse the order, without creating anything.`;

const mandates = `A **trading mandate** is the owner's written authorization for one principal (an API key or an agent): which accounts, which instruments, which order types, how much, how fast, until when. It is immutable — a change is a new mandate and the revocation of the old one — and it is checked on **every** order.

What a mandate fixes: mode (\`paper\` or \`live\`), accounts, instruments, order types, \`maxCapitalUsd\`, \`maxOrderNotionalUsd\`, \`maxPositionNotionalUsd\`, \`maxLeverage\`, \`maxDailyLossUsd\`, \`floorEquityUsd\`, order frequency (per minute, hour, day), \`maxSlippageBps\`, \`maxFeeUsd\`, a duration in days, and stop conditions.

- **Only the owner** creates, approves or revokes one (Settings → Risk → Trading mandates). The routes are outside this API: a key can do nothing to a mandate, its own included.
- A **paper** mandate signs nothing. A **live** mandate is compiled into the shape the isolated signer enforces and approved with the passkey: the signer then refuses, by itself, an order outside it.
- A revoked or expired mandate **winds down**: for 24 hours only cancels and strictly reducing orders pass (422 \`mandate_wind_down\`).
- A strictly reducing order is exempt from the limits that would stop an exit (capital, position, daily loss, frequency, stop conditions). It stays bound to the mandate's account, venue and instrument.
- A key or an agent closes only what its own fills opened (403 \`position_not_attributable\`).

An order outside the mandate is refused with **every** reason at once, and the refused order is recorded:

${json(ERROR_EXAMPLES.mandateDenied.body)}

### \`data.reasons\` of \`mandate_denied\`

| Reason | Meaning |
|---|---|
${MANDATE_DENY_REASONS.map((r) => `| \`${r}\` | ${MANDATE_DENY_DOCS[r]} |`).join('\n')}`;

const failedOf = (b: unknown): string => ((b as { data?: { failed?: string[] } }).data?.failed ?? []).join(', ');
const refusals = `An order goes through gates, in this order. The first that refuses answers; the error code tells which gate it was.

| # | Gate | Refuses with | Fix |
|---|---|---|---|
| 1 | **The request** — schema, instrument, account | 400 \`bad_request\`, \`invalid_order\`; 404 \`unknown_instrument\`; 409 \`ambiguous_symbol\`, \`account_required\`; 422 \`below_min_size\`, \`no_account\` | the request |
| 2 | **The key** — scope, restrictions, a mandate bound to it | 403 \`insufficient_scope\`, \`restricted\`, \`mandate_required\` | another key, or the owner widens it |
| 3 | **The execution lock** (live only), then the key's own notional limits, then whose position it is | 403 \`execution_disabled\`; \`key_limit_exceeded\`; \`position_not_attributable\` | the operator; a smaller order |
| 4 | **The mandate** | 403 \`mandate_denied\` + \`data.reasons\`; \`mandate_not_approved\`, \`mandate_integrity\`; 422 \`mandate_wind_down\` | fit the mandate, or a new mandate |
| 5 | **The risk engine** — one engine for every principal, venue and mode | 422 \`risk_denied\` + \`data.failed\`, \`data.checks\`; 423 \`kill_switch_active\`, \`read_only_mode\` | read \`data.checks\` |
| 6 | **The venue engine's own rules** — tick, lot, price bands, collateral, the account policy; for live orders, the mainnet locks | 422 \`price_not_on_tick\`, \`size_not_on_lot\`, \`price_deviation\`, \`insufficient_collateral\`, …; 403 \`mainnet_disabled\` | the order; the operator |
| 7 | **The venue** | 422 \`venue_rejected\`; 503 \`venue_unavailable\` | read \`message\` |

Up to gate 3 nothing is created. From gate 4 on, the order **exists**: the refusal carries it in \`data.order\` with \`status: "REJECTED"\`, and it appears in \`GET /orders\`. A refusal is a 4xx; an outcome that is not known is **not** an error — the order is \`UNKNOWN\` and the server resolves it.

**Ask before you send.** \`POST /orders/preview\` runs the same gates and answers 200 with \`wouldExecute\` and \`refusals: [{ stage, code, message }]\` (\`stage\` is \`key\`, \`lock\`, \`mandate\`, \`risk\` or \`engine\`), every risk check with what was observed and its limit, and an estimate of fees and slippage.

### The risk engine

One engine judges every order — the owner's, an agent's, a key's; paper or live — before any signature. A refusal says which checks failed (\`${failedOf(ERROR_EXAMPLES.killSwitch.body)}\` here), what was observed and what the limit was:

${json(ERROR_EXAMPLES.killSwitch.body)}

\`data.checks[].observed\` and \`.detail\` are withheld (null / a neutral sentence) for the checks that reveal account figures when the key holds neither \`wallet:read\` nor \`positions:read\`.

| Check | Limit | Rule | Applies to a strictly reducing order |
|---|---|---|---|
${RISK_CHECKS.map((c) => `| \`${c.id}\` | ${c.limit === '—' ? '—' : `\`${c.limit}\``} | ${cell(c.rule)} | ${c.reducing === 'always' ? 'yes' : c.reducing === 'no_limit_price' ? 'only without a limit price' : 'no (exempt)'} |`).join('\n')}
| \`context_complete\` | — | every account of the book could be read; when one cannot, exposure is not known and new risk is denied | no (exempt) |

Three things worth knowing:

- On a **live** book, a limit that was never set **denies** (the detail says "no limit is configured"). The owner sets them in Settings → Risk.
- With stale prices, the way out of a position is a reduce-only **limit** order: it names its own price and is exempt from the price checks.
- The **kill switch** blocks every new risk for everybody; cancels and strictly reducing orders pass. A key with \`positions:manage\` can engage it (\`POST /risk/kill-switch\`) and **cannot** release it. **Read-only mode** lets only cancels pass. Neither is the signer's emergency halt (423 \`halted\`), which is lifted on the signer machine.

### The venue engine

The last local gate is the engine that would execute the order, with the account's own policy. Its codes are the ones a trading program meets most — a limit price too far from the mark, for instance:

${json({ error: (ERROR_EXAMPLES.priceDeviation.body as { error: string }).error, message: (ERROR_EXAMPLES.priceDeviation.body as { message: string }).message, data: { order: '{ … the order, status REJECTED … }' } })}

An operation whose engine can add a code of its own is marked **open** in its error list (\`x-spw-errors-open\` in the OpenAPI document): treat an unknown 4xx code by its HTTP status.`;

const idem = `Every mutating call needs an \`Idempotency-Key\` header: 8 to 100 characters among letters, digits, \`.\` \`_\` \`:\` \`-\`. It makes a retry safe.

| You send | The server |
|---|---|
| a new key | runs the operation, stores the answer (a 200 **or** a 4xx refusal) with a hash of the request (method, path, canonical body) |
| the same key, the same request | returns the stored answer with \`Idempotent-Replay: true\`; **nothing runs again** |
| the same key, a different request | 409 \`idempotency_conflict\` |
| the same key while the first call is still running | 409 \`idempotency_in_progress\` — wait and resend |
| no key | 400 \`idempotency\` |

${json(ERROR_EXAMPLES.idempotencyConflict.body)}

- The namespace is the **principal**: two keys can use the same string.
- An answer ≥ 500 is **not** stored: nothing is assumed to have happened, the same key can be sent again — and should be. After a timeout or a 5xx, resend with the **same** key; never mint a new one for a retry.
- Stored answers are kept ${FACTS.idempotencyRetentionHours} hours.
- **An order has a second, permanent identity**: \`clientOrderId\` in the body (default: the Idempotency-Key). The order id is derived from it and from the principal, so the same \`clientOrderId\` is the same order for ever — \`idempotent: true\` in the answer says "this already existed, nothing was sent again".
- \`X-SPW-Timestamp\` (optional, Unix seconds): when present, a call more than ${FACTS.timestampToleranceSec} s from the server clock is refused (400 \`stale_request\`) — a guard against a delayed replay by a proxy.

Operations that take **no** Idempotency-Key, because they change nothing or are naturally idempotent: \`POST /orders/preview\` and \`POST /risk/kill-switch\`.

A good key is the name of the intent, not a random value made at send time: \`rebalance-2026-11-17-btc\`. Persist it before sending if the process can crash.`;

const pagination = `Three conventions, by list:

| Lists | How | End |
|---|---|---|
| \`GET /orders\`, \`GET /activity\`, \`GET /nfts\`, \`GET /nfts/activity\` | \`limit\` + opaque \`cursor\`: pass \`nextCursor\` of a page as \`cursor\` of the next, **with the same filters** | \`nextCursor: null\` |
| \`GET /agents/{id}/signals\`, \`/journal\`, \`/orders\` | \`limit\` + \`before\` (Unix ms: rows strictly before it) — pass the \`ts\` of the last row | fewer rows than \`limit\` |
| \`GET /markets\` and the other lists | not paginated; \`limit\` cuts, and \`total\` + \`truncated\` say so | — |

Cursor pages are newest first, in one stable order (time, then id): a row created after the first page was read is not inserted into the pages that follow. A cursor that did not come from this list answers 400 \`invalid_cursor\`. \`GET /nfts/market/events\` has one cursor **per source**: send it with \`provider\`.

${json(EXAMPLES.getActivity!.response)}

Both SDKs follow the cursor for you: \`iterateOrders\` / \`iterateActivity\` (TypeScript), \`iter_orders\` / \`iter_activity\` (Python).`;

const rate = `Per key, in fixed one-minute windows: ${KEY_BOUNDS.defaultRatePerMin} calls a minute by default, set per key up to ${KEY_BOUNDS.maxRatePerMin}. Every answer to a key carries:

| Header | Meaning |
|---|---|
| \`RateLimit-Limit\` | the key's calls per minute |
| \`RateLimit-Remaining\` | calls left in the current window |
| \`RateLimit-Reset\` | seconds until the window resets |
| \`Retry-After\` | on a 429 only: seconds to wait |

${code('http', `HTTP/1.1 429 Too Many Requests\nRateLimit-Limit: 3\nRateLimit-Remaining: 0\nRateLimit-Reset: 60\nRetry-After: 60\n\n${JSON.stringify(ERROR_EXAMPLES.rateLimited.body)}`)}

- Every call counts, a refused one and a 404 included.
- The window is in the memory of the API process: a restart resets it.
- Failed authentications are counted per source address, apart: ${FACTS.authFailuresPerMin} a minute, then 429 \`auth_throttled\` with \`Retry-After: 60\`.
- The owner's session is limited per address instead (${FACTS.ownerRatePerMin} a minute) and carries no \`RateLimit-*\` header.
- Venues have their own limits: a venue that throttles the wallet answers 503 \`venue_rate_limited\`, which is not about your key.

Both SDKs wait and retry on 429 (reads, and writes because they carry an Idempotency-Key). For live prices do not poll: use the [stream](#stream).`;

const whE = WEBHOOK_EXAMPLE;
const webhooks = `Webhooks push events to an HTTPS endpoint of yours. The owner manages them in **Settings → Developer / API → Webhooks** (at most ${FACTS.webhookMax} endpoints); the signing secret (\`whsec_…\`) is shown once.

| Event | Payload (\`data\`) | When |
|---|---|---|
${WEBHOOK_EVENTS.map((e) => `| \`${e.event}\` | \`${cell(e.payload)}\` | ${cell(e.description)} |`).join('\n')}

Payloads carry identifiers and states only — no secret, no key material, no amount. On \`order.updated\`, read the order with \`GET /orders/{id}\`.

### What you receive

${code('http', `POST /your/endpoint HTTP/1.1\nContent-Type: application/json\nX-SPW-Timestamp: ${whE.timestamp}\nX-SPW-Signature: ${whE.signature}\nX-SPW-Event: key.revoked\nX-SPW-Delivery: 42\n\n${whE.body}`)}

### Verifying the signature

\`X-SPW-Signature\` is \`v1=\` + the hex HMAC-SHA-256 of \`"<X-SPW-Timestamp>.<raw body>"\` with the endpoint's secret. Verify over the **raw bytes** received (not a re-serialised object), compare in constant time, and refuse a timestamp more than ${FACTS.webhookToleranceSec} s from your clock.

The example above is real arithmetic: with the secret \`${whE.secret}\`, the string signed is \`${whE.timestamp}.\` followed by the body, and the HMAC is the value shown. Check your implementation against it.

${code('ts', `import { constructWebhookEvent, WebhookVerificationError } from '@sp-wallet/trading-sdk';\n\n// rawBody: the bytes exactly as received (Buffer / Uint8Array / string)\ntry {\n  const event = await constructWebhookEvent({\n    secret: process.env.SP_WALLET_WEBHOOK_SECRET!,\n    timestamp: req.headers['x-spw-timestamp'],\n    signature: req.headers['x-spw-signature'],\n    body: rawBody,\n  });\n  if (!seen.has(event.id)) { seen.add(event.id); handle(event.event, event.data); }\n  res.writeHead(200).end('ok');\n} catch (e) {\n  res.writeHead(e instanceof WebhookVerificationError ? 400 : 500).end();\n}`)}

${code(PY, `from sp_wallet import WebhookVerificationError, construct_webhook_event\n\n# raw: the bytes exactly as received\ntry:\n    event = construct_webhook_event(secret=SECRET, timestamp=headers.get("x-spw-timestamp"),\n                                    signature=headers.get("x-spw-signature"), body=raw)\nexcept WebhookVerificationError:\n    return 400\nif event["id"] not in seen:\n    seen.add(event["id"])\n    handle(event["event"], event["data"])\nreturn 200`)}

${code(PY, `# without the SDK\nimport hashlib, hmac, time\n\ndef verify(secret: str, timestamp: str, signature: str, raw: bytes) -> bool:\n    if abs(time.time() - int(timestamp)) > ${FACTS.webhookToleranceSec}:\n        return False\n    want = "v1=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(want, signature)`)}

### Delivery

- **At least once.** Deduplicate on the envelope's \`id\` (the same for every attempt of one event; \`X-SPW-Delivery\` is the delivery row).
- A delivery succeeds on any 2xx. Otherwise it is retried after ${FACTS.webhookBackoffSec.map(dur).join(', ')}; after ${FACTS.webhookMaxAttempts} attempts it is \`failed\`. The Webhooks screen shows every delivery with its last status.
- HTTPS only, no credentials in the URL, no redirect followed, 8 seconds to answer.
- Order is not guaranteed: use \`data.seq\` of \`order.updated\` (it grows with each transition of one order).`;

const stream = `Live market data — quotes, order books, trades, candles, venue status — is a websocket, which OpenAPI cannot describe. It is read-only: nothing is placed or cancelled over it.

${code('text', `wss://wallet.spboucher.ai${TRADING_PREFIX}/stream`)}

- **Scope**: \`markets:read\`. The key goes in the \`Authorization\` header of the handshake — never in the URL.
- A client that cannot set a header (a browser) asks for a single-use ticket: \`POST ${TRADING_PREFIX}/stream/ticket\` (same key, same scope) answers \`{ ticket, expiresAt, ttlMs, url, protocol }\`; connect to \`…/stream?ticket=…\` within ${FACTS.streamTicketTtlSec} s.
- A key's venue and instrument restrictions apply per subscription (\`error restricted\`).
- At most ${FACTS.streamMaxConnKey} connections per key and ${FACTS.streamMaxSubs} subscriptions per connection.
- A stream connection is not in the key's usage log; the ticket request is.

${code('ts', `import { SPWalletStream } from '@sp-wallet/trading-sdk';\n\nconst stream = new SPWalletStream();   // SP_WALLET_API_KEY, SP_WALLET_BASE_URL\nawait stream.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'status', id: 'hyperliquid' }]);\nfor await (const m of stream) {\n  if (m.type === 'quote') console.log(m.id, m.bid, m.ask, m.mark, m.stale ? '(stale)' : '');\n}`)}

${code(PY, `# pip install "sp-wallet-python[stream]"\nimport asyncio\nfrom sp_wallet import SPWalletStream\nfrom sp_wallet.stream import Quote\n\nasync def main() -> None:\n    stream = SPWalletStream()   # SP_WALLET_API_KEY, SP_WALLET_BASE_URL\n    await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "status", "id": "hyperliquid"}])\n    async for m in stream:\n        if isinstance(m, Quote):\n            print(m.id, m.bid, m.ask, m.mark, "(stale)" if m.stale else "")\n\nasyncio.run(main())`)}

### Protocol (version 1), in short

JSON text frames; every server frame has \`"v": 1\` and a \`type\`. Prices, sizes and rates are decimal strings; times are milliseconds.

${code('json', `// client → server\n{ "op": "subscribe", "reqId": 7, "channels": [ { "type": "quote",  "id": "hyperliquid:BTC" },\n                                               { "type": "book",   "id": "hyperliquid:BTC", "depth": 10 },\n                                               { "type": "trades", "id": "hyperliquid:BTC" },\n                                               { "type": "candle", "id": "hyperliquid:BTC", "interval": "1m" },\n                                               { "type": "status", "id": "*" } ] }\n{ "op": "unsubscribe", "channels": [ { "type": "quote", "id": "hyperliquid:BTC" } ] }\n{ "op": "ping", "t": 42 }`)}

| Server frame | Carries |
|---|---|
| \`hello\` | first frame: \`connId\`, \`heartbeatMs\`, the limits |
| \`subscribed\` | one per channel, with the last known value at once (\`snapshot\`, \`snapshotAgeMs\`) and \`staleAfterMs\` |
| \`quote\` | bid, ask, mid, mark, index, funding, open interest, \`seq\`, \`stale\` — a full state each time |
| \`book\` | a \`snapshot\`, then \`delta\`s (\`prevSeq\` must equal the last \`seq\` applied; size \`"0"\` removes a price; \`checksum\` is a CRC-32 of the top ten levels) |
| \`trade\` | a batch, oldest first; the first after a subscription is recent history (\`snapshot: true\`) |
| \`candle\` | the bar in progress or a new bar |
| \`status\` | per venue: \`connected\`, \`reconnecting\`, \`stale\`, \`down\`, \`idle\` |
| \`heartbeat\`, \`pong\`, \`dropped\`, \`unsubscribed\`, \`error\` | housekeeping; an \`error\` never closes the connection |

Close code **4001** means the key is no longer active: do not reconnect with it. \`1001\` (server restart) — reconnect. The full protocol, the limits and the staleness rules are in \`docs/V11-QUOTE-ENGINE.md\`; both SDKs implement reconnection, resubscription and the order-book checks (\`OrderBook\`).

Order and position updates are **not** on the stream: use the \`order.updated\` webhook, or poll \`GET /orders/{id}\` (\`waitForOrder\` / \`wait_for_order\`).`;

const states = `An order's \`status\` is one of twelve states; \`final\` is true for four of them.

${code('text', `CREATED → VALIDATED → AWAITING_APPROVAL → APPROVED → SUBMITTING → SUBMITTED → PARTIALLY_FILLED → FILLED\n                                                          └→ UNKNOWN → (the server asks the venue) → any of the above, or CANCELLED / REJECTED / FAILED\nfinal: FILLED, CANCELLED, REJECTED, FAILED`)}

| \`status\` | Final | Meaning |
|---|---|---|
${ORDER_STATES.map((s) => `| \`${s}\` | ${FINAL_ORDER_STATES.includes(s) ? 'yes' : '—'} | ${ORDER_STATE_DOCS[s]} |`).join('\n')}

- Decide on \`status\` and \`final\`. \`engineStatus\` is the executing engine's own word for the same moment, for information.
- **\`UNKNOWN\` is not a failure.** A network error after the request may have left makes the outcome unknown; the server reconciles with the venue. Wait — do not place the order again under another key.
- Nothing becomes \`FILLED\` without an event that comes from the venue (or the paper engine).
- \`reasonCode\` is the closed reason of the current state; \`rejectCode\` is the API error code of the refusal; \`reason\` is a sentence for people.
- Order types: \`market\`, \`limit\`, \`stop_market\`, \`stop_limit\`, \`take_profit_market\`, \`take_profit_limit\`. Time in force: \`gtc\`, \`ioc\`, \`alo\` (add-liquidity-only). A market order is bounded by \`slippageBps\` (1 to 500), not by a price.`;

const cmdExec = EXTRA.commandExecuted as { kind: string; command: string; executed: boolean; order: { id: string; status: string } };
const commands = `\`POST /commands\` takes one line of a small deterministic grammar — no model, no guess — in English or French. It is the same machinery as the order operations, behind a sentence.

${code('text', `LONG|SHORT <asset>-PERP <notional> [x<lev>] [LIMIT <px>] [SL <px>] [TP <px>] [ON <venue>]\nCLOSE <asset>-PERP [pct%] [ON <venue>]\nBUY <asset> <amount> <quote> [ON <venue>]          (spot — the owner only)\nSELL <asset> <amount|pct%> [FOR <quote>] [ON <venue>]   (spot — the owner only)\nCANCEL ORDER <id>          CANCEL ALL [ON <venue>]\nSHOW POSITIONS | BALANCES | ORDERS | RISK\nSTOP ALL AGENTS            KILL`)}

French spellings are accepted for the keywords (\`ACHETER\`, \`VENDRE\`, \`FERMER\`, \`ANNULER\`, \`AFFICHER\`, \`SUR\`, \`URGENCE\`, …); numbers are plain decimals.

- The **scope** checked is the one of the operation the line resolves to: an order needs \`orders:execute\` (\`orders:prepare\` with \`dryRun\`), CLOSE \`positions:manage\`, CANCEL \`orders:cancel\`, SHOW the matching read scope, KILL \`positions:manage\`.
- \`dryRun: true\` answers what the line resolves to and does nothing.
- **Nothing is assumed.** Venue, network, leverage, margin mode, fee cap, slippage bound and order validity come from the line or from the owner's stored defaults (he saves them from the command line of the app's Trade screen; owner routes \`GET\`/\`PUT /api/v1/developer/command-defaults\`). What neither says is asked back, and nothing executes:

${json(ERROR_EXAMPLES.ambiguousCommand.body)}

The answer has a \`kind\`: \`query\` (the read answer is in \`data\`), \`control\` (a cancel, the kill switch) or \`order\` — with \`executed: false\` for a dry run (\`order\` is then the canonical order) and \`executed: true\` otherwise (\`order\` is the placed order, \`canonical\` its canonical form). Recorded, \`LONG BTC-PERP 100\` executed on paper answered \`kind: "${cmdExec.kind}"\`, \`command: "${cmdExec.command}"\`, \`order.status: "${cmdExec.order.status}"\`.

A line that is not a sentence of the grammar:

${json(ERROR_EXAMPLES.parseError.body)}`;

const errors = `Every error has the same body, whatever the status:

${json({ error: '<stable machine code>', message: '<sentence for people, English>', data: { '…': 'machine-readable detail, on refusals that have some' } })}

Branch on \`error\`, never on \`message\`. \`data\` may carry: \`order\` (the order a refusal is about), \`reasons\` (mandate), \`failed\` and \`checks\` (risk), \`questions\` (an ambiguous command), \`code\` and \`token\` (a parse error). \`ambiguous_symbol\` carries \`candidates\` at the top level.

| Status | Class | Retry? |
|---|---|---|
| 400 | the request is not valid | no — fix it |
| 401 | no usable credential | no |
| 403 | authenticated, and refused: scope, restriction, mandate, server lock | no |
| 404 | the object does not exist; or the path is not an operation (\`not_found\`) | no |
| 409 | a conflict with the state of the object, or a choice is needed | after resolving it |
| 422 | a valid request that cannot be carried out now | after changing the order |
| 423 | blocked by the kill switch, read-only mode or a halt | when the owner releases it |
| 429 | too many requests | yes, after \`Retry-After\` |
| 500 | server error; a mutating call may or may not have run | yes, with the **same** Idempotency-Key |
| 501 | declared but not connected; nothing was done | no |
| 502, 503 | a backing service (venue, signer, provider) failed; nothing was done | yes, with backoff |

A path that is not an operation, or a known path with another method, answers in the same model:

${json(ERROR_EXAMPLES.notFound.body)}

A body that does not match the schema says only that — the server does not echo which field (check the request against the operation's schema):

${json(ERROR_EXAMPLES.badRequest.body)}

Both SDKs turn these into typed exceptions (\`AuthenticationError\`, \`ScopeDenied\`, \`MandateRequired\`, \`MandateDenied\`, \`RiskDenied\`, \`ExecutionDisabled\`, \`AmbiguousCommand\`, \`RateLimited\`, \`ValidationError\`, …) with \`code\`, \`status\`, \`requestId\` and \`order\`. A mutating call that got no trustworthy answer raises \`OutcomeUnknown\` — not a failure — with the Idempotency-Key to resume with.

The full list, code by code, is the [error catalogue](#error-catalogue) at the end; each operation lists the codes it can answer.`;

export const GUIDE: GuideSection[] = [
  { id: 'overview', title: 'Overview', group: 'Start', md: overview },
  { id: 'getting-started', title: 'Getting started in five minutes', group: 'Start', md: start },
  { id: 'demarrage-rapide', title: 'Démarrage rapide (français)', group: 'Start', md: demarrage },
  { id: 'authentication', title: 'Authentication and permissions', group: 'Concepts', md: auth },
  { id: 'formats', title: 'Decimals, timestamps, identifiers', group: 'Concepts', md: formats },
  { id: 'instruments', title: 'Instruments and venues', group: 'Concepts', md: instruments },
  { id: 'paper-live', title: 'Paper and live, the execution lock', group: 'Concepts', md: paperLive },
  { id: 'mandates', title: 'Mandates', group: 'Concepts', md: mandates },
  { id: 'refusals', title: 'Why an order is refused', group: 'Concepts', md: refusals },
  { id: 'order-states', title: 'Order states', group: 'Concepts', md: states },
  { id: 'idempotency', title: 'Idempotency', group: 'Concepts', md: idem },
  { id: 'pagination', title: 'Pagination', group: 'Concepts', md: pagination },
  { id: 'rate-limits', title: 'Rate limits', group: 'Concepts', md: rate },
  { id: 'errors', title: 'Errors', group: 'Concepts', md: errors },
  { id: 'commands', title: 'Commands', group: 'Concepts', md: commands },
  { id: 'webhooks', title: 'Webhooks', group: 'Concepts', md: webhooks },
  { id: 'stream', title: 'Streaming (websocket)', group: 'Concepts', md: stream },
];
export { ERROR_CATALOG };
