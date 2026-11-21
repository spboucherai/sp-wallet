/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/openapi.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-19
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

// OpenAPI 3.1 document of the SP Trading API, generated from spec.ts (zod 4 → JSON Schema 2020-12 with zod's own
// `z.toJSONSchema`: no extra dependency). Pure and deterministic: the same table always gives the same bytes, so the committed
// copy (docs/openapi/trading-v1.json) is compared with the generated one by a test.
import { z } from 'zod';
import { ERROR_CATALOG, MANDATE_DENY_DOCS, ORDER_STATE_DOCS, SCOPE_DOCS } from './error-catalog.ts';
import { EXAMPLES, type OperationExample } from './examples.ts';
import { ANY_SCOPE, API_VERSION, COMPONENT_SCHEMAS, ErrorSchema, errorsOf, EXECUTION_SCOPES, FINAL_ORDER_STATES, MANDATE_DENY_REASONS, NOT_FOUND, OPERATIONS, ORDER_STATES, requiresMandate, RISK_CHECK_IDS, SCOPES, TRADING_PREFIX, WEBHOOK_EVENTS, type OperationSpec } from './spec.ts';

type Json = Record<string, unknown>;
const raw = (s: z.ZodType, io: 'input' | 'output'): Json => {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
  delete j.$schema;
  return j;
};
// Shared shapes (an order, the canonical order, a risk check) are written once under components and referenced: a sub-schema
// that is exactly a component — its own `description` aside — becomes `{ $ref }` (with that description when it has one).
const bare = (j: Json): string => { const { description: _d, ...rest } = j; return JSON.stringify(rest); };
const COMPONENTS = Object.entries(COMPONENT_SCHEMAS).map(([name, s]) => { const json = raw(s, 'output'); return { name, json, key: bare(json), description: json.description }; });
function refs(node: unknown, root = false): unknown {
  if (Array.isArray(node)) return node.map((x) => refs(x));
  if (node === null || typeof node !== 'object') return node;
  const j = node as Json;
  if (!root && j.type === 'object') {
    const c = COMPONENTS.find((x) => x.key === bare(j));
    if (c) return { $ref: `#/components/schemas/${c.name}`, ...(typeof j.description === 'string' && j.description !== c.description ? { description: j.description } : {}) };
  }
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, refs(v)]));
}
const schema = (s: z.ZodType, io: 'input' | 'output'): Json => refs(raw(s, io)) as Json;
const oaPath = (p: string): string => TRADING_PREFIX + p.replace(/:([A-Za-z]+)/g, '{$1}');
const ERR = { $ref: '#/components/schemas/Error' };
const errorAnswer = (description: string): Json => ({ description, content: { 'application/json': { schema: ERR } } });

function parameters(op: OperationSpec, ex?: OperationExample): Json[] {
  const out: Json[] = [];
  for (const [where, s] of [['path', op.params], ['query', op.query]] as const) {
    if (!s) continue;
    const j = schema(s, 'input'), props = (j.properties ?? {}) as Record<string, Json>, required = new Set((j.required as string[] | undefined) ?? []);
    for (const [name, p] of Object.entries(props)) {
      const { description, ...rest } = p;
      const example = (where === 'path' ? ex?.params : ex?.query)?.[name];
      out.push({ name, in: where, required: where === 'path' || required.has(name), ...(description ? { description } : {}), schema: rest, ...(example !== undefined ? { example } : {}) });
    }
  }
  if (op.idempotent) {
    out.push({ name: 'Idempotency-Key', in: 'header', required: true, description: 'Replay protection: 8 to 100 characters (letters, digits, . _ : -). The same key with the same request returns the first answer; with a different request, 409 `idempotency_conflict`.', schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,100}$' } });
    out.push({ name: 'X-SPW-Timestamp', in: 'header', required: false, description: 'Optional freshness check: Unix seconds; refused (400 `stale_request`) when more than 300 s from the server clock.', schema: { type: 'string', pattern: '^\\d{9,11}$' } });
  }
  return out;
}

/** the base URL and the key of every sample: the two environment variables both SDKs read */
export const SAMPLE_BASE = '$SP_WALLET_BASE_URL', SAMPLE_KEY = '$SP_WALLET_API_KEY';
/** a path or query value as it is written in a URL: encoded, with the colon of `venue:symbol` left readable (it is legal there) */
const urlPart = (v: string | number): string => encodeURIComponent(String(v)).replace(/%3A/gi, ':');
/** the path and query of the example call, relative to the server root (`/api/v1/trading/…`) */
export function exampleUrl(op: OperationSpec, ex: OperationExample): string {
  const path = oaPath(op.path).replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => { const v = ex.params?.[name]; if (v === undefined) throw new Error(`openapi: the example of ${op.id} has no path parameter '${name}'`); return urlPart(v); });
  const q = Object.entries(ex.query ?? {}).map(([k, v]) => `${k}=${urlPart(v)}`).join('&');
  return q ? `${path}?${q}` : path;
}
/** the example call three ways: curl, the TypeScript SDK, the Python SDK (`x-codeSamples`, the extension documentation tools read) */
export function codeSamples(op: OperationSpec, ex: OperationExample): { lang: string; label: string; source: string }[] {
  const lines = [`curl -s${op.method === 'GET' ? '' : ` -X ${op.method}`} "${SAMPLE_BASE}${exampleUrl(op, ex)}"`, `  -H "Authorization: Bearer ${SAMPLE_KEY}"`];
  if (op.idempotent) lines.push('  -H "Idempotency-Key: $(uuidgen)"');
  if (ex.body !== undefined) lines.push('  -H "Content-Type: application/json"', `  -d '${JSON.stringify(ex.body).replace(/'/g, `'\\''`)}'`);
  return [{ lang: 'Shell', label: 'curl', source: lines.join(' \\\n') }, { lang: 'TypeScript', label: 'TypeScript', source: ex.ts }, { lang: 'Python', label: 'Python', source: ex.py }];
}
const exampleOf = (op: OperationSpec): OperationExample => { const ex = EXAMPLES[op.id]; if (!ex) throw new Error(`openapi: operation ${op.id} has no example in examples.ts`); return ex; };

/** what a status means, before the codes an operation can answer with it */
const STATUS_TEXT: Record<number, string> = {
  400: 'The request is not valid', 401: 'Missing, malformed, unknown, expired or revoked key', 403: 'Authenticated, and refused', 404: 'The object named by the request does not exist',
  409: 'The request conflicts with the state of the object, or needs a choice', 422: 'A valid request that cannot be carried out', 423: 'Blocked by the kill switch, by read-only mode or by a halt',
  429: 'Too many requests (see the `RateLimit-*` and `Retry-After` headers)', 500: 'Server error; a mutating call may or may not have run: send it again with the same Idempotency-Key',
  501: 'Declared but not connected yet. Never a success: nothing was done', 503: 'A backing service is unavailable; nothing was done',
};

function operationObject(op: OperationSpec): Json {
  const responses: Record<string, Json> = {}, ex = exampleOf(op);
  if (op.implemented) responses['200'] = { description: `OK${ex.recorded ? ' (the example is a recorded answer)' : ''}`, ...(op.response ? { content: { 'application/json': { schema: schema(op.response, 'output'), example: ex.response } } } : {}) };
  const errors = errorsOf(op), byStatus = new Map<number, string[]>();
  for (const e of errors) byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e.code]);
  for (const [status, codes] of byStatus) responses[String(status)] = errorAnswer(`${STATUS_TEXT[status] ?? 'Error'}: ${codes.map((c) => `\`${c}\``).join(', ')}`);
  const scopes = op.scope === ANY_SCOPE ? [] : [op.scope];
  return {
    operationId: op.id, tags: [op.tag], summary: op.summary, ...(op.description ? { description: op.description } : {}),
    security: [{ bearerKey: scopes }], 'x-spw-scope': op.scope === ANY_SCOPE ? 'any valid key' : op.scope, 'x-spw-implemented': op.implemented,
    ...(requiresMandate(op) ? { 'x-spw-requires-mandate': true } : {}), ...(op.idempotent ? { 'x-spw-idempotent': true } : {}),
    'x-spw-errors': errors, ...(op.implemented && op.errorsOpen ? { 'x-spw-errors-open': true } : {}),
    'x-spw-example-recorded': ex.recorded, ...(ex.note ? { 'x-spw-example-note': ex.note } : {}),
    'x-codeSamples': codeSamples(op, ex),
    parameters: parameters(op, ex),
    ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(op.body, 'input'), ...(ex.body !== undefined ? { example: ex.body } : {}) } } } } : {}),
    responses,
  };
}

/** the nine groups of operations, in the order of the reference */
const TAGS: [OperationSpec['tag'], string][] = [
  ['Meta', 'The contract itself.'],
  ['Markets', 'Public market data: instruments across venues, tickers, order books, candles, the venue comparator, and the synthetic contracts on private companies. Scope `markets:read`. Reading a venue does not mean it can be traded: live orders with a key exist on Hyperliquid only.'],
  ['Portfolio', 'What the wallet holds: on-chain balances, the valued portfolio with every derivatives account, and the activity feed. Scope `wallet:read`. Paper and live are separate figures, never summed.'],
  ['Nfts', 'Read-only NFT data: the wallet\'s inventory (`wallet:read`) and market data of any item (`markets:read`). No transfer and no market write exists in this API. An NFT never has a value here.'],
  ['Positions', 'Open positions, and the two ways out of one: close and reduce — strictly reduce-only market orders. Closing passes the kill switch.'],
  ['Orders', 'Preview, place, read and cancel orders, and the one-line command grammar. Every order passes the key, the mandate, the risk engine and the venue engine, in that order; a refusal names its gate.'],
  ['Strategies', 'The strategy library and the versions pinned to agents: register, backtest, start, stop. Research and paper sign nothing.'],
  ['Agents', 'Trading agents: templates, lifecycle (create, start, pause, stop), and their history read ONE mode per call (research, paper or live). An agent goes live only under its own owner-approved mandate.'],
  ['Risk', 'The state of the risk engine and of the server locks, and the one control a key has: engaging the global kill switch (never releasing it).'],
];
/** code → { statuses, meaning, action } for every code an operation can answer; a code without a sentence fails the build of the document */
function errorCatalog(): Record<string, { statuses: number[]; meaning: string; action: string }> {
  const by = new Map<string, Set<number>>();
  for (const op of OPERATIONS) for (const e of errorsOf(op)) by.set(e.code, (by.get(e.code) ?? new Set()).add(e.status));
  return Object.fromEntries([...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, st]) => {
    const d = ERROR_CATALOG[code];
    if (!d) throw new Error(`openapi: the error code '${code}' has no entry in error-catalog.ts`);
    return [code, { statuses: [...st].sort((a, b) => a - b), meaning: d[0], action: d[1] }];
  }));
}

export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) (paths[oaPath(op.path)] ??= {})[op.method.toLowerCase()] = operationObject(op);
  return {
    openapi: '3.1.0',
    info: {
      title: 'SP Trading API', version: API_VERSION,
      description: [
        'Machine interface of SP Wallet: market data, portfolio, positions, orders, strategies and agents.',
        `Human-readable reference, generated from this document and served by the same server: \`GET ${TRADING_PREFIX}/docs\` (HTML: getting started, concepts, one section per operation, the error catalogue) and \`GET ${TRADING_PREFIX}/docs.md\` (the same as Markdown). Those two paths and the websocket below are the only paths under the prefix that are not operations of this document.`,
        'Every operation carries a worked example: the request (`example` on parameters and on the request body), the 200 answer (`example` on the response; `x-spw-example-recorded: true` when it is a real recorded answer), and the same call as curl, TypeScript and Python (`x-codeSamples`; `client` is an `SPWallet` of the SDK, built from the environment variables `SP_WALLET_API_KEY` and `SP_WALLET_BASE_URL`).',
        'What each error code means and what to do about it: `x-spw-error-catalog` (every code of every `x-spw-errors`). The reasons of a `mandate_denied`: `x-spw-mandate-deny-reason-docs`. The twelve order states: `x-spw-order-states`, each explained in `x-spw-order-state-docs`; the scopes in `x-spw-scope-docs`.',
        'Live trading with a key exists on Hyperliquid only (the perpetuals of its own dex, ids `hyperliquid:BTC`); GMX orders are the owner\'s, approved in the app; dYdX and edgeX are market data only. Paper orders are simulated by the wallet against the real Hyperliquid order book.',
        'Authentication: `Authorization: Bearer spw_live_…` (an API key created by the owner with his passkey). A key opens nothing outside `/api/v1/trading/`.',
        'Every operation names the scope it needs (`x-spw-scope`). Scopes are access control inside the API; they are not what bounds execution: an order placed with a key is bounded by a trading mandate that the isolated signer enforces, and execution scopes are inert without one.',
        'Numbers that carry money are decimal strings. Paper and live data always carry a `mode` and are never merged.',
        'Errors are `{ "error": "<code>", "message": "<sentence>" }`, with `data` when a refusal has machine-readable detail (the order it is about, the mandate\'s reasons, the failed risk checks, the questions of an ambiguous command). Every operation lists the codes it can answer, with their status, in `x-spw-errors`. A 400 `bad_request` produced by input validation also carries `data.fields`: one `{ path, code, message }` per refused member (what is expected, never the value that was sent). Rate limits are per key: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds).',
        `A path that is not an operation of this document (or a known path with another method) answers ${NOT_FOUND.status} \`${NOT_FOUND.code}\` in the same error model.`,
        "Live market data (quotes, order books, trades, candles, venue statuses) is also served over a websocket, which this document cannot describe: `GET /api/v1/trading/stream` (scope `markets:read`; the key in the `Authorization` header of the handshake, or `?ticket=` with a single-use ticket from `POST /api/v1/trading/stream/ticket`). See `docs/V11-QUOTE-ENGINE.md`. A stream connection writes no row in the key\'s usage log — it is counted in the stream\'s own statistics; the ticket request is an ordinary call and is logged like any other.",
        'An order\'s `status` is one of the twelve states of `x-spw-order-states`; `final` is true for the states marked final. `UNKNOWN` is neither final nor a failure. Lists that can grow without bound (`GET /orders`, `GET /activity`) are paginated with `cursor` / `nextCursor`.',
      ].join('\n\n'),
    },
    servers: [{ url: '/', description: 'the wallet\'s own origin' }],
    externalDocs: { description: 'Reference: getting started, concepts, examples, error catalogue (HTML; add `.md` for Markdown)', url: `${TRADING_PREFIX}/docs` },
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', bearerFormat: 'spw_live_<key id>_<secret>', description: 'API key shown once at creation. Never sent together with a session cookie.' } },
      schemas: { Error: schema(ErrorSchema, 'output'), ...Object.fromEntries(COMPONENTS.map((c) => [c.name, refs(c.json, true)])) },
    },
    'x-spw-scopes': SCOPES.map((s) => ({ scope: s, execution: (EXECUTION_SCOPES as readonly string[]).includes(s) })),
    'x-spw-scope-docs': Object.fromEntries(SCOPES.map((s) => [s, SCOPE_DOCS[s]])),
    'x-spw-order-states': ORDER_STATES.map((state) => ({ state, final: FINAL_ORDER_STATES.includes(state) })),
    'x-spw-order-state-docs': Object.fromEntries(ORDER_STATES.map((state) => [state, ORDER_STATE_DOCS[state]])),
    'x-spw-mandate-deny-reasons': [...MANDATE_DENY_REASONS],
    'x-spw-mandate-deny-reason-docs': Object.fromEntries(MANDATE_DENY_REASONS.map((r) => [r, MANDATE_DENY_DOCS[r]])),
    'x-spw-error-catalog': errorCatalog(),
    'x-spw-risk-checks': [...RISK_CHECK_IDS],
    'x-spw-not-found': { status: NOT_FOUND.status, error: NOT_FOUND.code },
    'x-spw-webhook-events': WEBHOOK_EVENTS.map((e) => ({ ...e })),
  };
}
/** the exact bytes written to docs/openapi/trading-v1.json */
export const openApiJson = (): string => JSON.stringify(buildOpenApi(), null, 2) + '\n';

/** docs/TRADING-API-OPENAPI.md — a readable index of the same document (generated: edit spec.ts, then `node scripts/gen-openapi.mts`) */
export function openApiMarkdown(): string {
  const doc = buildOpenApi() as { info: { version: string } };
  const L: string[] = [];
  L.push('# SP Trading API v1 — reference', '', '> Generated by `node scripts/gen-openapi.mts` from `services/api/src/trading-api/spec.ts`. Do not edit by hand:', '> a test compares this file and `docs/openapi/trading-v1.json` with what the code generates.', '');
  L.push(`Version ${doc.info.version}. Machine-readable document: [\`docs/openapi/trading-v1.json\`](openapi/trading-v1.json), also served at \`GET ${TRADING_PREFIX}/openapi.json\`.`, '');
  L.push('This file is the compact index (operations, raw JSON Schemas, error codes). The reference with getting started, concepts, a worked example per operation', `and what each error means is [\`TRADING-API-REFERENCE.md\`](TRADING-API-REFERENCE.md), served at \`GET ${TRADING_PREFIX}/docs\`.`, '');
  L.push('## Authentication', '', '`Authorization: Bearer spw_live_<key id>_<secret>`. No cookie, no CSRF header. The key is refused on every path outside', `\`${TRADING_PREFIX}/\`.`, '');
  L.push('## Streaming', '', 'Live market data (quotes, order books, trades, candles, venue statuses) is also served over a websocket, which the OpenAPI document cannot describe:', '`GET /api/v1/trading/stream` — scope `markets:read`; the key in the `Authorization` header of the handshake, or `?ticket=` with a single-use ticket', 'from `POST /api/v1/trading/stream/ticket` (the way of a browser, which cannot set a header on a websocket). Protocol: [`V11-QUOTE-ENGINE.md`](V11-QUOTE-ENGINE.md); clients:', '`SPWalletStream` in both SDKs.', '', '**A stream connection writes no row in the key\'s usage log**: it is counted in the stream\'s own statistics. The ticket request is an ordinary call and is', 'logged like any other.', '');
  L.push('## Scopes', '', '| Scope | Execution scope (inert without an approved trading mandate bound to the key — except a cancel of the key\'s own order and the kill switch, which only remove risk) |', '|---|---|');
  for (const s of SCOPES) L.push(`| \`${s}\` | ${(EXECUTION_SCOPES as readonly string[]).includes(s) ? 'yes' : 'no'} |`);
  L.push('', '## Operations', '', '| Method | Path | Scope | State | Idempotency-Key | Summary |', '|---|---|---|---|---|---|');
  for (const op of OPERATIONS) L.push(`| ${op.method} | \`${oaPath(op.path)}\` | ${op.scope === ANY_SCOPE ? 'any valid key' : `\`${op.scope}\``} | ${op.implemented ? 'implemented' : '**501** `execution_not_wired`'} | ${op.idempotent ? 'required' : '—'} | ${op.summary} |`);
  L.push('', '## Parameters', '');
  for (const op of OPERATIONS) {
    const ps = parameters(op).filter((p) => p.in !== 'header');
    if (!ps.length && !op.body) continue;
    L.push(`### ${op.method} \`${oaPath(op.path)}\``, '');
    if (ps.length) { L.push('| Name | In | Required | Schema | Description |', '|---|---|---|---|---|'); for (const p of ps) L.push(`| \`${p.name}\` | ${p.in} | ${p.required ? 'yes' : 'no'} | \`${JSON.stringify(p.schema)}\` | ${String(p.description ?? '').replace(/\|/g, '\\|')} |`); L.push(''); }
    if (op.body) L.push('Request body (JSON):', '', '```json', JSON.stringify(schema(op.body, 'input'), null, 2), '```', '');
  }
  L.push('## Errors', '', 'A 400 `bad_request` produced by input validation carries `data.fields`: one `{ path, code, message }` per refused member (what is expected, never the value that was sent).', '', 'Every error is `{ "error": "<code>", "message": "<sentence>" }`; a refusal about an order also carries `data` (`data.order`, `data.reasons`, `data.failed`, `data.checks`, `data.questions`).',
    `A path that is not an operation (or a known path with another method) answers ${NOT_FOUND.status} \`${NOT_FOUND.code}\`.`, '',
    'The codes each operation can answer (the document\'s `x-spw-errors`). "open": the venue engine that executes the order can add a refusal code of its own rules.', '');
  for (const op of OPERATIONS) {
    const by = new Map<number, string[]>();
    for (const e of errorsOf(op)) by.set(e.status, [...(by.get(e.status) ?? []), e.code]);
    L.push(`### ${op.method} \`${oaPath(op.path)}\`${op.implemented && op.errorsOpen ? ' (open)' : ''}`, '', '| Status | Codes |', '|---|---|');
    for (const [status, codes] of by) L.push(`| ${status} | ${codes.map((c) => `\`${c}\``).join(', ')} |`);
    L.push('');
  }
  L.push('## Order states', '', '| `status` | `final` |', '|---|---|');
  for (const s of ORDER_STATES) L.push(`| \`${s}\` | ${FINAL_ORDER_STATES.includes(s) ? 'yes' : 'no'} |`);
  L.push('', '`UNKNOWN`: the outcome at the venue is not known yet. It is not final and it is not a failure; the server resolves it by asking the venue.', '',
    '## Refusal detail', '', `\`mandate_denied\` — \`data.reasons\`: ${MANDATE_DENY_REASONS.map((r) => `\`${r}\``).join(', ')}.`, '',
    `\`risk_denied\`, \`kill_switch_active\`, \`read_only_mode\` — \`data.failed\` (ids of \`data.checks\`): ${RISK_CHECK_IDS.map((r) => `\`${r}\``).join(', ')}.`, '');
  L.push('## Webhook events', '', '| Event | Emitted in this version | Payload (`data`) | Description |', '|---|---|---|---|');
  for (const e of WEBHOOK_EVENTS) L.push(`| \`${e.event}\` | ${e.emitted ? 'yes' : 'no — pending wiring'} | \`${e.payload}\` | ${e.description} |`);
  L.push('');
  return L.join('\n');
}
