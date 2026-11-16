// OpenAPI 3.1 document of the SP Trading API, generated from spec.ts (zod 4 → JSON Schema 2020-12 with zod's own
// `z.toJSONSchema`: no extra dependency). Pure and deterministic: the same table always gives the same bytes, so the committed
// copy (docs/openapi/trading-v1.json) is compared with the generated one by a test.
import { z } from 'zod';
import { ANY_SCOPE, API_VERSION, ErrorSchema, EXECUTION_SCOPES, OPERATIONS, SCOPES, TRADING_PREFIX, WEBHOOK_EVENTS, type OperationSpec } from './spec.ts';

type Json = Record<string, unknown>;
const schema = (s: z.ZodType, io: 'input' | 'output'): Json => {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
  delete j.$schema;
  return j;
};
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

function operationObject(op: OperationSpec): Json {
  const responses: Record<string, Json> = {};
  if (op.implemented) responses['200'] = { description: 'OK', ...(op.response ? { content: { 'application/json': { schema: schema(op.response, 'output') } } } : {}) };
  else responses['501'] = errorAnswer('`execution_not_wired`: this operation is declared but not connected yet. Never a success.');
  responses['400'] = errorAnswer('`bad_request`, `idempotency`, `stale_request`');
  responses['401'] = errorAnswer('`unauthenticated`: missing, malformed, unknown, expired or revoked key');
  const write = op.implemented && op.method !== 'GET';
  responses['403'] = errorAnswer(write ? '`insufficient_scope`, `restricted`, `ip_not_allowed`, `mandate_required`, `mandate_denied` (with `data.reasons`), `execution_disabled`, `key_limit_exceeded`, `not_your_order`, a closed server lock (`mainnet_disabled`, `mandate_mainnet_disabled`), `venue_restricted`, `spot_execution_requires_agent_vault`'
    : '`insufficient_scope`, `restricted`, `ip_not_allowed`, `mandate_required`');
  if (write) {
    responses['422'] = errorAnswer('`risk_denied` (with `data.failed` and `data.checks`), `not_reducing`, `no_position`, `no_account`, `below_min_size`, `leverage_mismatch`, a refusal of the venue engine. When an order exists it is in `data.order` (state `REJECTED` or `FAILED`).');
    responses['423'] = errorAnswer('`kill_switch_active` or `read_only_mode`: the global kill switch blocks new risk; read-only mode lets only cancels pass');
  }
  if (op.params) responses['404'] = errorAnswer('unknown market, order or object');
  if (op.idempotent || op.id === 'getMarket') responses['409'] = errorAnswer(op.idempotent ? '`idempotency_conflict`, `idempotency_in_progress`' : '`ambiguous_symbol` (with `candidates`)');
  responses['429'] = errorAnswer('`rate_limited` (see the `RateLimit-*` headers) or `auth_throttled`');
  if (op.implemented && op.method === 'GET' && op.id !== 'getOpenApi') responses['503'] = errorAnswer('a backing service is unavailable: `signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`…');
  const scopes = op.scope === ANY_SCOPE ? [] : [op.scope];
  return {
    operationId: op.id, tags: [op.tag], summary: op.summary, ...(op.description ? { description: op.description } : {}),
    security: [{ bearerKey: scopes }], 'x-spw-scope': op.scope === ANY_SCOPE ? 'any valid key' : op.scope, 'x-spw-implemented': op.implemented,
    ...(op.scope !== ANY_SCOPE && (EXECUTION_SCOPES as readonly string[]).includes(op.scope) && !op.noMandate ? { 'x-spw-requires-mandate': true } : {}),
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
        'Errors are `{ "error": "<code>", "message": "<sentence>" }`. Rate limits are per key: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds).',
      ].join('\n\n'),
    },
    servers: [{ url: '/', description: 'the wallet\'s own origin' }],
    tags: ['Meta', 'Markets', 'Portfolio', 'Positions', 'Orders', 'Strategies', 'Agents', 'Risk'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', bearerFormat: 'spw_live_<key id>_<secret>', description: 'API key shown once at creation. Never sent together with a session cookie.' } },
      schemas: { Error: schema(ErrorSchema, 'output') },
    },
    'x-spw-scopes': SCOPES.map((s) => ({ scope: s, execution: (EXECUTION_SCOPES as readonly string[]).includes(s) })),
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
  L.push('## Errors', '', 'Every error is `{ "error": "<code>", "message": "<sentence>" }`; a refusal about an order also carries `data` (`data.order`, `data.reasons`, `data.failed`, `data.checks`, `data.questions`).', '', '| Status | Codes |', '|---|---|',
    '| 400 | `bad_request`, `invalid_order`, `parse_error`, `idempotency`, `stale_request` |', '| 401 | `unauthenticated` |',
    '| 403 | `key_path_forbidden`, `mixed_credentials`, `insufficient_scope`, `scope_undeclared`, `restricted`, `ip_not_allowed`, `mandate_required`, `mandate_not_approved`, `mandate_denied`, `execution_disabled`, `key_limit_exceeded`, `not_your_order`, `mainnet_disabled`, `mandate_mainnet_disabled`, `venue_restricted`, `spot_execution_requires_agent_vault` |',
    '| 404 | `unknown_market`, `unknown_order`, `unknown_account`, `unknown_position`, `not_found` |', '| 409 | `ambiguous_symbol`, `ambiguous_command`, `account_required`, `idempotency_conflict`, `idempotency_in_progress`, `bad_state` |',
    '| 422 | `no_orderbook`, `venue_rejected`, `risk_denied`, `not_reducing`, `no_position`, `no_account`, `below_min_size`, `leverage_mismatch`, `venue_not_wired`, `spot_via_swap_screen`, `cancel_in_app`, `close_in_app`, the risk codes of the venue engine |',
    '| 423 | `kill_switch_active`, `read_only_mode` |',
    '| 429 | `rate_limited`, `auth_throttled` |', '| 501 | `execution_not_wired` |', '| 503 | `signer_unreachable`, `venue_unavailable`, `venue_rate_limited`, `markets_unavailable`, `stale_data`, `service_unavailable` |', '');
  L.push('## Webhook events', '', '| Event | Emitted in this version | Payload (`data`) | Description |', '|---|---|---|---|');
  for (const e of WEBHOOK_EVENTS) L.push(`| \`${e.event}\` | ${e.emitted ? 'yes' : 'no — pending wiring'} | \`${e.payload}\` | ${e.description} |`);
  L.push('');
  return L.join('\n');
}
