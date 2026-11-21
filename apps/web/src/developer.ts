/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/developer.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// Developer / API screen — the pure part (no React, no network): the shapes of /api/v1/developer, the key form → request
// body, the OpenAPI document → what the in-app viewer shows, and the code examples. Unit-tested in apps/web/test/developer.test.ts.

export const SCOPES = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'] as const;
export type Scope = (typeof SCOPES)[number];
/** scopes shown together in the checklist (the server's list is the truth: a scope it does not announce is not shown) */
export const SCOPE_GROUPS: { id: 'read' | 'prepare' | 'manage' | 'execute'; scopes: Scope[] }[] = [
  { id: 'read', scopes: ['wallet:read', 'markets:read', 'orders:read', 'positions:read', 'strategies:read', 'agents:read'] },
  { id: 'prepare', scopes: ['orders:prepare'] },
  // v11 agents: management scopes — research, paper trading, pause and stop sign nothing; an agent goes LIVE only under ITS OWN owner-approved mandate
  { id: 'manage', scopes: ['strategies:manage', 'agents:manage'] },
  { id: 'execute', scopes: ['orders:execute', 'orders:cancel', 'positions:manage'] },
];
/** `orders:read` → `dvScope_orders_read` */
export const scopeKey = (s: string): string => `dvScope_${s.replace(':', '_')}`;

export interface ApiKey {
  id: string; name: string; status: 'active' | 'expired' | 'revoked'; scopes: string[]; limits: { maxOrderNotionalUsd: number | null; maxDailyNotionalUsd: number | null };
  restrictions: { networks: string[]; venues: string[]; instruments: string[]; ipAllow: string[] }; rateLimitPerMin: number; mandateId: string | null; inertScopes: string[];
  rotatedFrom: string | null; createdAt: number; expiresAt: number; revokedAt: number | null; revokedReason: string | null; lastUsedAt: number | null; lastUsedIp: string | null;
}
export interface KeysAnswer { keys: ApiKey[]; scopes: { scope: string; execution: boolean }[]; bounds: { maxDays: number; defaultRatePerMin: number; maxRatePerMin: number; maxKeys: number }; execution: { wired: boolean; code: string } }
export interface UsageAnswer { items: { id: number; keyId: string; ts: number; method: string; route: string; status: number; latencyMs: number; requestId: string }[];
  perKey: { keyId: string; calls24h: number; errors24h: number; rateLimited24h: number; callsLastMinute: number; calls: number; lastAt: number | null; p95Ms: number | null }[]; retentionDays: number }
export interface StatusAnswer { api: { version: string; prefix: string; operations: number; implemented: number; notImplemented: string[] }; services: { id: string; ok: boolean; detail: string }[];
  keys: { total: number; active: number } | null; rateLimits: { defaultPerMin: number; maxPerMin: number; failedAuthPerMinPerAddress: number; headers: string[] }; ts: number }
export interface Webhook { id: string; url: string; events: string[]; enabled: boolean; label: string; createdAt: number; lastOkAt: number | null; lastError: string | null; failures: number; hasSecret: boolean }
export interface Delivery { id: number; webhookId: string; eventId: string; event: string; state: 'pending' | 'delivered' | 'failed'; attempts: number; nextAttemptAt: number | null; lastStatus: number | null; lastError: string | null; createdAt: number; deliveredAt: number | null }
export interface WebhooksAnswer { webhooks: Webhook[]; events: { event: string; emitted: boolean; description: string; payload: string }[]; deliveries: Delivery[]; retry: { attempts: number; backoffSec: number[] }; signature: string }

// ---------------------------------------------------------------------------------------------------------------- key form
export interface KeyDraft { name: string; days: number; scopes: string[]; ratePerMin: string; maxOrderUsd: string; maxDailyUsd: string; venues: string; instruments: string; networks: string; ips: string; mandateId: string }
export const emptyDraft = (ratePerMin = 120): KeyDraft => ({ name: '', days: 30, scopes: ['markets:read'], ratePerMin: String(ratePerMin), maxOrderUsd: '', maxDailyUsd: '', venues: '', instruments: '', networks: '', ips: '', mandateId: '' });
export const splitList = (s: string): string[] => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, IP = /^[0-9A-Fa-f:.]{2,45}(\/\d{1,3})?$/;
export type DraftError = 'name' | 'scopes' | 'rate' | 'maxOrder' | 'maxDaily' | 'ips' | 'mandate';
/** The body of POST /developer/keys/prepare, or the fields to fix. An empty limit means "no limit recorded on the key". */
export function draftBody(d: KeyDraft, bounds: { maxDays: number; maxRatePerMin: number }): { ok: true; body: Record<string, unknown> } | { ok: false; errors: DraftError[] } {
  const errors: DraftError[] = [];
  const usd = (s: string, e: DraftError): number | null => { if (s.trim() === '') return null; const n = Number(s.replace(',', '.')); if (!Number.isFinite(n) || n <= 0) { errors.push(e); return null; } return n; };
  if (d.name.trim().length < 1 || d.name.trim().length > 60) errors.push('name');
  if (d.scopes.length === 0) errors.push('scopes');
  const rate = Number(d.ratePerMin);
  if (!Number.isInteger(rate) || rate < 1 || rate > bounds.maxRatePerMin) errors.push('rate');
  const maxOrderNotionalUsd = usd(d.maxOrderUsd, 'maxOrder'), maxDailyNotionalUsd = usd(d.maxDailyUsd, 'maxDaily');
  const ipAllow = splitList(d.ips);
  if (ipAllow.some((x) => !IP.test(x))) errors.push('ips');
  const mandateId = d.mandateId.trim() || null;
  if (mandateId && !UUID.test(mandateId)) errors.push('mandate');
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { name: d.name.trim(), scopes: d.scopes, expiresInDays: Math.max(1, Math.min(bounds.maxDays, Math.round(d.days))), rateLimitPerMin: rate, limits: { maxOrderNotionalUsd, maxDailyNotionalUsd },
    restrictions: { networks: splitList(d.networks), venues: splitList(d.venues), instruments: splitList(d.instruments), ipAllow }, mandateId: mandateId?.toLowerCase() ?? null } };
}
export const daysLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 86_400_000));
/** `spw_live_spk_…_<secret>` → the public id, to show which key a pasted secret belongs to (never the secret) */
export const keyIdOf = (token: string): string | null => /^spw_live_(spk_[0-9a-f]{12})_/.exec(token)?.[1] ?? null;

// ---------------------------------------------------------------------------------------------------------------- OpenAPI viewer
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document
export interface DocParam { name: string; in: string; required: boolean; type: string; description: string }
export interface DocOp { id: string; method: string; path: string; tag: string; summary: string; description: string; scope: string; implemented: boolean; needsMandate: boolean; idempotent: boolean;
  params: DocParam[]; body: string | null; responses: { code: string; description: string }[] }
/** One line for a JSON Schema: `string`, `integer 1…500 (default 100)`, `"paper" | "live"`, `array of string`, `object` */
export function schemaType(s: Json | undefined): string {
  if (!s) return 'any';
  if (Array.isArray(s.enum)) return s.enum.map((x: unknown) => JSON.stringify(x)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.anyOf)) return s.anyOf.map((x: Json) => schemaType(x)).join(' | ');
  let t = Array.isArray(s.type) ? s.type.join(' | ') : String(s.type ?? 'any');
  if (t === 'array') t = `array of ${schemaType(s.items)}`;
  const lo = s.minimum ?? s.exclusiveMinimum, hi = s.maximum ?? s.exclusiveMaximum;
  if (lo !== undefined || hi !== undefined) t += ` ${lo ?? ''}…${hi ?? ''}`;
  if (s.default !== undefined) t += ` (default ${JSON.stringify(s.default)})`;
  return t;
}
/** The operations of an OpenAPI 3.1 document, in document order, grouped by tag by the caller. Tolerant: a field that is missing is empty. */
export function docOps(doc: Json | null | undefined): DocOp[] {
  const out: DocOp[] = [];
  for (const [path, item] of Object.entries((doc?.paths ?? {}) as Record<string, Json>)) for (const [method, op] of Object.entries(item as Record<string, Json>)) {
    const params: DocParam[] = ((op.parameters ?? []) as Json[]).map((p) => ({ name: String(p.name), in: String(p.in), required: !!p.required, type: schemaType(p.schema), description: String(p.description ?? '') }));
    const body = op.requestBody?.content?.['application/json']?.schema;
    out.push({ id: String(op.operationId ?? `${method} ${path}`), method: method.toUpperCase(), path, tag: String(op.tags?.[0] ?? ''), summary: String(op.summary ?? ''), description: String(op.description ?? ''),
      scope: String(op['x-spw-scope'] ?? ''), implemented: op['x-spw-implemented'] !== false, needsMandate: op['x-spw-requires-mandate'] === true, idempotent: params.some((p) => p.name === 'Idempotency-Key'),
      params, body: body ? JSON.stringify(body, null, 2) : null,
      responses: Object.entries((op.responses ?? {}) as Record<string, Json>).map(([code, r]) => ({ code, description: String(r.description ?? '') })) });
  }
  return out;
}
export function docTags(ops: DocOp[]): { tag: string; ops: DocOp[] }[] {
  const out: { tag: string; ops: DocOp[] }[] = [];
  for (const o of ops) { let g = out.find((x) => x.tag === o.tag); if (!g) out.push(g = { tag: o.tag, ops: [] }); g.ops.push(o); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- examples
/** Static examples against the real routes (checked against the OpenAPI document by a test). `origin` is the wallet's own origin. */
export function codeExamples(origin: string): { id: 'curl' | 'python' | 'typescript'; title: string; code: string }[] {
  const base = `${origin}/api/v1/trading`;
  return [
    { id: 'curl', title: 'curl', code: [
      'export SPW_KEY=spw_live_…   # shown once, when the key is created',
      `curl -s -H "Authorization: Bearer $SPW_KEY" "${base}/markets?venue=hyperliquid&q=BTC"`,
      `curl -s -H "Authorization: Bearer $SPW_KEY" "${base}/markets/hyperliquid:BTC/orderbook?depth=5"`,
      `curl -s -H "Authorization: Bearer $SPW_KEY" "${base}/positions?mode=paper"`,
    ].join('\n') },
    { id: 'python', title: 'Python', code: [
      'import os, uuid, requests',
      '',
      `BASE = "${base}"`,
      'S = requests.Session()',
      'S.headers["Authorization"] = f"Bearer {os.environ[\'SPW_KEY\']}"',
      '',
      'def get(path, **params):',
      '    r = S.get(BASE + path, params=params, timeout=15)',
      '    if r.status_code == 429:  # RateLimit-Reset: seconds until the window resets',
      '        raise RuntimeError(f"rate limited, retry in {r.headers.get(\'RateLimit-Reset\')} s")',
      '    if not r.ok:',
      '        raise RuntimeError(f"{r.status_code} {r.json().get(\'error\')}: {r.json().get(\'message\')}")',
      '    return r.json()',
      '',
      'markets = get("/markets", venue="hyperliquid", q="BTC")["markets"]',
      'book = get("/markets/hyperliquid:BTC/orderbook", depth=5)',
      'candles = get("/markets/hyperliquid:BTC/candles", interval="1h", limit=200)["candles"]',
      'positions = get("/positions")["positions"]          # each row carries mode: "paper" | "live"',
      'risk = get("/risk")',
      '',
      'ORDER = {"mode": "paper", "instrument": "hyperliquid:BTC", "side": "buy", "type": "market", "notional": "100"}',
      '# preview: every check the order would meet (wouldExecute, refusals); creates nothing, takes no Idempotency-Key',
      'r = S.post(BASE + "/orders/preview", timeout=15, json=ORDER)',
      'print(r.status_code, r.json())',
      '# place it on paper: a mutating call always carries an Idempotency-Key, and the key needs a trading mandate bound to it',
      'r = S.post(BASE + "/orders", headers={"Idempotency-Key": str(uuid.uuid4())}, timeout=15, json=ORDER)',
      'print(r.status_code, r.json())',
    ].join('\n') },
    { id: 'typescript', title: 'TypeScript', code: [
      `const BASE = '${base}';`,
      'const KEY = process.env.SPW_KEY!;',
      '',
      'async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {',
      '  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));',
      '  const r = await fetch(`${BASE}${path}${q.size ? `?${q}` : \'\'}`, { headers: { authorization: `Bearer ${KEY}` } });',
      '  const j = await r.json();',
      '  if (!r.ok) throw new Error(`${r.status} ${j.error}: ${j.message}`);   // { error, message }',
      '  return j as T;',
      '}',
      '',
      'const { markets } = await get<{ markets: { id: string; mark: string | null; stale: boolean }[] }>(\'/markets\', { venue: \'hyperliquid\', q: \'BTC\' });',
      'const portfolio = await get(\'/portfolio\');           // wallet, live venue accounts and paper accounts: three separate figures',
      'const orders = await get(\'/orders\', { open: \'true\' });',
      'const agents = await get(\'/agents\');',
      '',
      '// place a paper order: a mutating call always carries an Idempotency-Key, and the key needs a trading mandate bound to it',
      '// (POST /orders/preview takes the same body, creates nothing and says what would refuse the order)',
      'const r = await fetch(`${BASE}/orders`, { method: \'POST\',',
      '  headers: { authorization: `Bearer ${KEY}`, \'content-type\': \'application/json\', \'idempotency-key\': crypto.randomUUID() },',
      '  body: JSON.stringify({ mode: \'paper\', instrument: \'hyperliquid:BTC\', side: \'buy\', type: \'market\', notional: \'100\' }) });',
      'console.log(r.status, await r.json());',
    ].join('\n') },
  ];
}
/** every `/api/v1/trading/...` path an example calls, as an OpenAPI path template candidate (concrete ids replaced by the test) */
export const examplePaths = (code: string): string[] => [...new Set([...code.matchAll(/["'`](?:\$\{BASE\}|BASE \+ ")?(\/(?:markets|orders|positions|portfolio|balances|risk|agents|strategies|activity)[A-Za-z0-9:/._-]*)/g)].map((m) => m[1]!))];

/** known error codes of the developer routes that have their own sentence (`dvErr_<code>`) */
export const DV_ERRORS = ['approval_failed', 'intent_expired', 'intent_mismatch', 'too_many_keys', 'key_not_active', 'key_revoked', 'passkey_required', 'bad_webhook_url', 'too_many_webhooks', 'no_passkey', 'rate_limited', 'expiry_too_far', 'bad_request'] as const;
/** the full reference served by the wallet itself (services/api/src/trading-api/reference.ts): getting started, concepts, one worked example per operation, error catalogue */
export const REFERENCE_URL = '/api/v1/trading/docs';
export const errKey = (code: string | undefined): string => ((DV_ERRORS as readonly string[]).includes(code ?? '') ? `dvErr_${code}` : 'dvErrOther');
