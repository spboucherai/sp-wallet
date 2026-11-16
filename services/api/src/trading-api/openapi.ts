// OpenAPI 3.1 document of the SP Trading API, generated from spec.ts (zod 4 → JSON Schema 2020-12 with zod's own
// `z.toJSONSchema`: no extra dependency). Pure and deterministic: the same table always gives the same bytes, so the committed
// copy (docs/openapi/trading-v1.json) is compared with the generated one by a test.
import { z } from 'zod';
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

function parameters(op: OperationSpec): Json[] {
  const out: Json[] = [];
  for (const [where, s] of [['path', op.params], ['query', op.query]] as const) {
    if (!s) continue;
    const j = schema(s, 'input'), props = (j.properties ?? {}) as Record<string, Json>, required = new Set((j.required as string[] | undefined) ?? []);
    for (const [name, p] of Object.entries(props)) {
      const { description, ...rest } = p;
      out.push({ name, in: where, required: where === 'path' || required.has(name), ...(description ? { description } : {}), schema: rest });
    }
  }
  if (op.idempotent) {
    out.push({ name: 'Idempotency-Key', in: 'header', required: true, description: 'Replay protection: 8 to 100 characters (letters, digits, . _ : -). The same key with the same request returns the first answer; with a different request, 409 `idempotency_conflict`.', schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,100}$' } });
    out.push({ name: 'X-SPW-Timestamp', in: 'header', required: false, description: 'Optional freshness check: Unix seconds; refused (400 `stale_request`) when more than 300 s from the server clock.', schema: { type: 'string', pattern: '^\\d{9,11}$' } });
  }
  return out;
}

/** what a status means, before the codes an operation can answer with it */
const STATUS_TEXT: Record<number, string> = {
  400: 'The request is not valid', 401: 'Missing, malformed, unknown, expired or revoked key', 403: 'Authenticated, and refused', 404: 'The object named by the request does not exist',
  409: 'The request conflicts with the state of the object, or needs a choice', 422: 'A valid request that cannot be carried out', 423: 'Blocked by the kill switch, by read-only mode or by a halt',
  429: 'Too many requests (see the `RateLimit-*` and `Retry-After` headers)', 500: 'Server error; a mutating call may or may not have run: send it again with the same Idempotency-Key',
  501: 'Declared but not connected yet. Never a success: nothing was done', 503: 'A backing service is unavailable; nothing was done',
};

function operationObject(op: OperationSpec): Json {
  const responses: Record<string, Json> = {};
  if (op.implemented) responses['200'] = { description: 'OK', ...(op.response ? { content: { 'application/json': { schema: schema(op.response, 'output') } } } : {}) };
  const errors = errorsOf(op), byStatus = new Map<number, string[]>();
  for (const e of errors) byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e.code]);
  for (const [status, codes] of byStatus) responses[String(status)] = errorAnswer(`${STATUS_TEXT[status] ?? 'Error'}: ${codes.map((c) => `\`${c}\``).join(', ')}`);
  const scopes = op.scope === ANY_SCOPE ? [] : [op.scope];
  return {
    operationId: op.id, tags: [op.tag], summary: op.summary, ...(op.description ? { description: op.description } : {}),
    security: [{ bearerKey: scopes }], 'x-spw-scope': op.scope === ANY_SCOPE ? 'any valid key' : op.scope, 'x-spw-implemented': op.implemented,
    ...(requiresMandate(op) ? { 'x-spw-requires-mandate': true } : {}),
    'x-spw-errors': errors, ...(op.implemented && op.errorsOpen ? { 'x-spw-errors-open': true } : {}),
    parameters: parameters(op),
    ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(op.body, 'input') } } } } : {}),
    responses,
  };
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
        'Authentication: `Authorization: Bearer spw_live_…` (an API key created by the owner with his passkey). A key opens nothing outside `/api/v1/trading/`.',
        'Every operation names the scope it needs (`x-spw-scope`). Scopes are access control inside the API; they are not what bounds execution: an order placed with a key is bounded by a trading mandate that the isolated signer enforces, and execution scopes are inert without one.',
        'Numbers that carry money are decimal strings. Paper and live data always carry a `mode` and are never merged.',
        'Errors are `{ "error": "<code>", "message": "<sentence>" }`, with `data` when a refusal has machine-readable detail (the order it is about, the mandate\'s reasons, the failed risk checks, the questions of an ambiguous command). Every operation lists the codes it can answer, with their status, in `x-spw-errors`. Rate limits are per key: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds).',
        `A path that is not an operation of this document (or a known path with another method) answers ${NOT_FOUND.status} \`${NOT_FOUND.code}\` in the same error model.`,
        "Live market data (quotes, order books, trades, candles, venue statuses) is also served over a websocket, which this document cannot describe: `GET /api/v1/trading/stream` (scope `markets:read`; the key in the `Authorization` header of the handshake, or `?ticket=` with a single-use ticket from `POST /api/v1/trading/stream/ticket`). See `docs/V11-QUOTE-ENGINE.md`. A stream connection writes no row in the key\'s usage log — it is counted in the stream\'s own statistics; the ticket request is an ordinary call and is logged like any other.",
        'An order\'s `status` is one of the twelve states of `x-spw-order-states`; `final` is true for the states marked final. `UNKNOWN` is neither final nor a failure. Lists that can grow without bound (`GET /orders`, `GET /activity`) are paginated with `cursor` / `nextCursor`.',
      ].join('\n\n'),
    },
    servers: [{ url: '/', description: 'the wallet\'s own origin' }],
    tags: ['Meta', 'Markets', 'Portfolio', 'Positions', 'Orders', 'Strategies', 'Agents', 'Risk'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', bearerFormat: 'spw_live_<key id>_<secret>', description: 'API key shown once at creation. Never sent together with a session cookie.' } },
      schemas: { Error: schema(ErrorSchema, 'output'), ...Object.fromEntries(COMPONENTS.map((c) => [c.name, refs(c.json, true)])) },
    },
    'x-spw-scopes': SCOPES.map((s) => ({ scope: s, execution: (EXECUTION_SCOPES as readonly string[]).includes(s) })),
    'x-spw-order-states': ORDER_STATES.map((state) => ({ state, final: FINAL_ORDER_STATES.includes(state) })),
    'x-spw-mandate-deny-reasons': [...MANDATE_DENY_REASONS],
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
  L.push('## Errors', '', 'Every error is `{ "error": "<code>", "message": "<sentence>" }`; a refusal about an order also carries `data` (`data.order`, `data.reasons`, `data.failed`, `data.checks`, `data.questions`).',
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
