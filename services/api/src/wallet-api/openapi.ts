/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/openapi.ts
 * Module           : wallet-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
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

// OpenAPI 3.1 document of the SP Wallet core API, generated from spec.ts with zod's own `z.toJSONSchema` (no dependency).
// Pure and deterministic: the same table always gives the same bytes; the committed copy (docs/openapi/wallet-v1.json) is
// compared with the generated one by a test, and so are the generated sections of docs/next/SP-WALLET-API.md.
import { z } from 'zod';
import { ENUMS, ErrorSchema, errorsOf, EVENT_TYPES, OPERATIONS, OTHER_FAMILIES, TAGS, TRANSFER_WARNINGS, WALLET_API_VERSION, WALLET_ERRORS, type EnumDoc, type WalletOp } from './spec.ts';

type Json = Record<string, unknown>;
const raw = (s: z.ZodType, io: 'input' | 'output'): Json => {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
  delete j.$schema;
  return j;
};
/** An enumeration as a component: a closed list is a JSON-Schema `enum`; an open one is a string that lists its known values
 *  in `x-spw-values` (a validator accepts any string, a client decodes with a fallback). */
const enumSchema = (e: EnumDoc): Json => ({ type: 'string', ...(e.open ? {} : { enum: [...e.values] }), description: e.description, 'x-spw-open': e.open, 'x-spw-values': [...e.values], ...(e.prefixes ? { 'x-spw-value-prefixes': [...e.prefixes] } : {}), ...(e.docs ? { 'x-spw-value-docs': e.docs } : {}) });

/** One build of the document: named shapes (`x-spw-component`) and enumerations (`x-spw-enum`) are hoisted under components. */
function builder() {
  const schemas: Record<string, Json> = {};
  for (const [name, e] of Object.entries(ENUMS)) schemas[name] = enumSchema(e);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const j = node as Json;
    if (typeof j['x-spw-enum'] === 'string') return { $ref: `#/components/schemas/${j['x-spw-enum']}` };
    if (typeof j['x-spw-component'] === 'string') {
      const name = j['x-spw-component'], { 'x-spw-component': _n, ...rest } = j;
      const built = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, walk(v)]));
      const have = schemas[name];
      if (have && JSON.stringify(have) !== JSON.stringify(built)) throw new Error(`wallet openapi: two different shapes are named '${name}'`);
      schemas[name] = built;
      return { $ref: `#/components/schemas/${name}` };
    }
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, walk(v)]));
  };
  return { schemas, schema: (s: z.ZodType, io: 'input' | 'output'): Json => walk(raw(s, io)) as Json };
}
export const oaPath = (p: string): string => p.replace(/:([A-Za-z]+)/g, '{$1}');

const STATUS_TEXT: Record<number, string> = {
  400: 'The request is not valid', 401: 'No valid session', 403: 'Refused', 404: 'The object does not exist', 409: 'Conflicts with the state of the object', 410: 'Expired', 422: 'A valid request that cannot be carried out',
  423: 'Blocked by the emergency halt', 429: 'Too many requests', 500: 'Server error', 503: 'A backing service is unavailable; nothing was done', 504: 'A source did not answer in time',
};

function parameters(o: WalletOp, schema: (s: z.ZodType, io: 'input' | 'output') => Json): Json[] {
  const out: Json[] = [];
  for (const [where, s] of [['path', o.params], ['query', o.query]] as const) {
    if (!s) continue;
    const j = schema(s, 'input'), props = (j.properties ?? {}) as Record<string, Json>, required = new Set((j.required as string[] | undefined) ?? []);
    for (const [name, p] of Object.entries(props)) { const { description, ...rest } = p; out.push({ name, in: where, required: where === 'path' || required.has(name), ...(description ? { description } : {}), schema: rest }); }
  }
  if (o.idempotencyKey) out.push({ name: 'Idempotency-Key', in: 'header', required: true, description: 'One key per intended operation: 16 to 64 letters, digits or dashes. The same key with the same body answers the first result; with another body, 409 `idempotency_mismatch`.', schema: { type: 'string', pattern: '^[A-Za-z0-9-]{16,64}$' } });
  if (o.id === 'streamEvents') out.push({ name: 'Last-Event-ID', in: 'header', required: false, description: 'The id of the last event processed (sent by EventSource on reconnect).', schema: { type: 'string', pattern: '^\\d+$' } });
  return out;
}

function operationObject(o: WalletOp, schema: (s: z.ZodType, io: 'input' | 'output') => Json): Json {
  const responses: Record<string, Json> = {};
  responses['200'] = { description: 'OK', content: o.produces ? { [o.produces]: { schema: { type: 'string' } } } : { 'application/json': { schema: o.response ? schema(o.response, 'output') : {} } } };
  const errors = errorsOf(o), byStatus = new Map<number, string[]>();
  for (const e of errors) byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e.code]);
  for (const [status, codes] of byStatus) responses[String(status)] = { description: `${STATUS_TEXT[status] ?? 'Error'}: ${codes.map((c) => `\`${c}\``).join(', ')}`, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  return {
    operationId: o.id, tags: [o.tag], summary: o.summary, ...(o.description ? { description: o.description } : {}),
    security: o.auth === 'public' ? [] : [{ session: [] }], 'x-spw-auth': o.auth, 'x-spw-csrf': o.method !== 'GET',
    ...(o.next ? { 'x-spw-since': 'next' } : {}), ...(o.idempotencyKey ? { 'x-spw-idempotency-key': true } : {}),
    'x-spw-errors': errors, ...(o.errorsOpen ? { 'x-spw-errors-open': true } : {}),
    parameters: parameters(o, schema),
    ...(o.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(o.body, 'input') } } } } : {}),
    responses,
  };
}

const TAG_TEXT: Record<(typeof TAGS)[number], string> = {
  Meta: 'Liveness and readiness.', Auth: 'Passkey sign-in and the one-time setup. The session is a `__Host-` HttpOnly cookie; nothing here returns a token.',
  Wallet: 'Networks, the verified asset registry, the wallet\'s addresses, asset preferences, market prices.', Portfolio: 'Balances with the provenance of their read, the server-computed summary, value history.',
  Transfers: 'A transfer is prepared (draft), frozen and shown (request-approval), approved with a passkey assertion over the intent hash, then followed on-chain. Read `lifecycle`.',
  Activity: 'What the wallet did and received.', AddressBook: 'Contacts: labels for the owner\'s eyes. The destination approved is always the full address shown on the review.',
  Settings: 'Language, currency, appearance: shared by every device.', Security: 'Signer state, passkeys, sessions, the audit chain, the emergency halt.',
  Alerts: 'In-app alerts, their settings, Web Push subscriptions, the optional webhook.', Events: 'The wallet event log: how clients stay in step without re-reading everything on a timer.',
  Dashboard: 'Read-only aggregates that compose the wallet and the trading services.', Analytics: 'Flows, fees paid, outcomes and counterparties, from recorded facts only.', Search: 'One search over assets, contacts and transactions.',
};

function errorCatalog(): Record<string, { statuses: number[]; meaning: string; action: string }> {
  const by = new Map<string, Set<number>>();
  for (const o of OPERATIONS) for (const e of errorsOf(o)) by.set(e.code, (by.get(e.code) ?? new Set()).add(e.status));
  return Object.fromEntries([...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, st]) => {
    const d = WALLET_ERRORS[code];
    if (!d) throw new Error(`wallet openapi: the error code '${code}' has no entry in WALLET_ERRORS`);
    return [code, { statuses: [...st].sort((a, b) => a - b), meaning: d[0], action: d[1] }];
  }));
}

export function buildWalletOpenApi(): Json {
  const b = builder(), paths: Record<string, Json> = {};
  const error = b.schema(ErrorSchema, 'output');                       // hoists `Error`
  if (!('$ref' in error)) throw new Error('wallet openapi: the error model must be a component');
  for (const o of OPERATIONS) (paths[oaPath(o.path)] ??= {})[o.method.toLowerCase()] = operationObject(o, b.schema);
  return {
    openapi: '3.1.0',
    info: { title: 'SP Wallet core API', version: WALLET_API_VERSION, description: [
      'Everything a wallet client (web, macOS, iOS) uses outside `/api/v1/trading`: authentication, accounts, portfolio, transfers, activity, address book, settings, security, alerts, events, analytics, search.',
      'Authentication: the owner session — a `__Host-spw` cookie set by the passkey sign-in. Every mutating request also carries `Origin` (the wallet\'s own origin) and `X-SPW-CSRF: 1`. An API key (`Authorization: Bearer spw_live_…`) opens nothing here.',
      'ADDITIVE: no member is ever removed, renamed or retyped; every object is open — ignore members you do not know. New routes and members only.',
      'AMOUNTS are strings of integer base units, next to a display string computed with exact arithmetic. Fiat figures are decimal strings. Market prices are display numbers and are never used as amounts.',
      'ESTIMATES are flagged: a figure that is an estimate, partial or stale carries the member that says so (`complete`, `estimate`, `stale`, `unvalued`, `unknown`…). An estimate is never called a realised return.',
      'ENUMERATIONS are components. `x-spw-open: true` means new values may appear in a later release: decode with an "unknown" fallback (the known values are in `x-spw-values`). `x-spw-open: false` is frozen for good.',
      'ERRORS are `{ "error": "<code>", "message": "<English sentence>", "data"?: … }`. Every operation lists its codes with their status in `x-spw-errors`; `x-spw-errors-open` means a chain adapter or the signer can add one of its own (`signer_<code>`). What each code means and what to do: `x-spw-error-catalog`. A 400 `bad_request` from input validation carries `data.fields` (path, code, message — never the submitted value).',
      'A transfer\'s state is read in `lifecycle` (`x-spw-lifecycle`). `state` keeps the vocabulary shipped clients know and never grows. Once an approval left the device its outcome is unknown until the server answers: re-read the proposal, never assume failure.',
      'IDLE RULE. A session ends after 30 minutes without activity (12 hours at most). A client marks the requests made on a real interaction of the user with the header `X-SPW-Interaction: 1` (`x-spw-interaction-header`); from the first such request on, only those keep the session alive — background polling no longer does. A session that never sent the header keeps the earlier behaviour (any authenticated request refreshes it).',
      'CONTROL CHARACTERS. A NUL anywhere in a request (query, path, JSON body), or any control character in the query string or a path parameter, is refused with 400 `bad_request` before the route runs.',
      'Other route families of the same server are documented elsewhere: `x-spw-other-families`.',
    ].join('\n\n') },
    servers: [{ url: '/', description: 'the wallet\'s own origin' }],
    tags: TAGS.map((name) => ({ name, description: TAG_TEXT[name] })),
    paths,
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: '__Host-spw', description: 'Session cookie set by POST /api/v1/auth/login/verify. HttpOnly, Secure, SameSite=Strict.' } },
      schemas: Object.fromEntries(Object.entries(b.schemas).sort(([x], [y]) => (x < y ? -1 : 1))),
    },
    'x-spw-error-catalog': errorCatalog(),
    'x-spw-lifecycle': ENUMS.Lifecycle.values.map((v) => ({ lifecycle: v, description: (ENUMS.Lifecycle.docs as Record<string, string>)[v] })),
    'x-spw-transfer-warnings': Object.entries(TRANSFER_WARNINGS).map(([code, w]) => ({ code, ...w })),
    'x-spw-event-types': Object.entries(EVENT_TYPES).map(([type, description]) => ({ type, description })),
    'x-spw-other-families': OTHER_FAMILIES,
    'x-spw-interaction-header': { name: 'X-SPW-Interaction', value: '1', in: 'header', required: false, idleMinutes: 30, absoluteHours: 12,
      description: 'Send it on requests caused by the user (a tap, a navigation), never on timers. Once a session has sent it, requests without it no longer refresh the idle timer.' },
  };
}
/** the exact bytes written to docs/openapi/wallet-v1.json */
export const walletOpenApiJson = (): string => JSON.stringify(buildWalletOpenApi(), null, 2) + '\n';

// ---------------------------------------------------------------------------------------------------------------- generated sections of docs/next/SP-WALLET-API.md
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** name → Markdown of each generated section (scripts/gen-openapi.mts writes them between `<!-- BEGIN GENERATED: name -->` markers) */
export function walletDocSections(): Record<string, string> {
  const cat = errorCatalog(), L = (rows: string[]) => rows.join('\n');
  const routes = ['| Method | Path | Tag | Session | Since | Summary |', '|---|---|---|---|---|---|',
    ...OPERATIONS.map((o) => `| ${o.method} | \`${oaPath(o.path)}\` | ${o.tag} | ${o.auth === 'public' ? 'public' : 'owner'} | ${o.next ? 'NEXT' : 'v1'} | ${cell(o.summary)}${o.produces ? ` (${o.produces})` : ''} |`),
    '', `${OPERATIONS.length} operations.`];
  const errors = ['| Code | Status | Meaning | What the client does |', '|---|---|---|---|', ...Object.entries(cat).map(([code, d]) => `| \`${code}\` | ${d.statuses.join(', ')} | ${cell(d.meaning)} | ${cell(d.action)} |`)];
  const perRoute = ['| Operation | Codes beyond the common ones |', '|---|---|',
    ...OPERATIONS.filter((o) => (o.errors ?? []).length || o.errorsOpen).map((o) => `| ${o.method} \`${oaPath(o.path)}\` | ${(o.errors ?? []).map((e) => `\`${e.code}\` (${e.status})`).filter((x, i, a) => a.indexOf(x) === i).join(', ')}${o.errorsOpen ? `${(o.errors ?? []).length ? ', ' : ''}*open*` : ''} |`)];
  const lifecycle = ['| `lifecycle` | Meaning |', '|---|---|', ...ENUMS.Lifecycle.values.map((v) => `| \`${v}\` | ${cell((ENUMS.Lifecycle.docs as Record<string, string>)[v]!)} |`)];
  const outcomes = ['| `errorCode` | English sentence (`error`) |', '|---|---|', ...ENUMS.ProposalErrorCode.values.map((v) => `| \`${v}\` | ${cell((ENUMS.ProposalErrorCode.docs as Record<string, string>)[v]!)} |`)];
  const warnings = ['| Warning | Meaning | Acknowledge before approving | Emitted |', '|---|---|---|---|', ...Object.entries(TRANSFER_WARNINGS).map(([code, w]) => `| \`${code}\` | ${cell(w.meaning)} | ${w.ack ? 'yes' : 'no'} | ${w.emitted ? 'yes' : 'reserved'} |`)];
  const enums = ['| Enumeration | New values may appear | Known values |', '|---|---|---|', ...Object.entries(ENUMS as Record<string, EnumDoc>).map(([name, e]) => `| \`${name}\` | ${e.open ? '**yes** — decode with a fallback' : 'no (frozen)'} | ${e.values.map((v) => `\`${v}\``).join(', ')} |`)];
  const events = ['| `type` | What happened |', '|---|---|', ...Object.entries(EVENT_TYPES).map(([t, d]) => `| \`${t}\` | ${cell(d)} |`)];
  const families = ['| Prefix | Documented in |', '|---|---|', ...Object.entries(OTHER_FAMILIES).map(([p, d]) => `| \`${p}\` | ${cell(d)} |`)];
  return { routes: L(routes), errors: L(errors), 'errors-per-route': L(perRoute), lifecycle: L(lifecycle), outcomes: L(outcomes), warnings: L(warnings), enums: L(enums), events: L(events), families: L(families) };
}
/** `doc` with every generated section replaced by what the table gives now; throws when a marker is missing */
export function applyDocSections(doc: string): string {
  let out = doc;
  for (const [name, body] of Object.entries(walletDocSections())) {
    const a = `<!-- BEGIN GENERATED: ${name} -->`, z2 = `<!-- END GENERATED: ${name} -->`, i = out.indexOf(a), j = out.indexOf(z2);
    if (i < 0 || j < i) throw new Error(`SP-WALLET-API.md: markers of the generated section '${name}' are missing`);
    out = `${out.slice(0, i + a.length)}\n${body}\n${out.slice(j)}`;
  }
  return out;
}
