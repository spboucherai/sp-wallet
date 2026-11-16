// V11 Developer / API screen — component-level checks, as the repository does for its other screens (pure helpers + source
// conventions; the screen itself is exercised against a real server by the Playwright spec tests/e2e/developer.spec.ts):
// the key form → request body, the OpenAPI viewer model on the COMMITTED document, the code examples against the real routes,
// and the `dv` block of i18n.ts (contiguous, two languages, every key used, every used key present).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeExamples, daysLeft, docOps, docTags, draftBody, DV_ERRORS, emptyDraft, errKey, examplePaths, keyIdOf, SCOPE_GROUPS, scopeKey, schemaType, SCOPES, splitList } from '../src/developer';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');
const doc = JSON.parse(read('../../../docs/openapi/trading-v1.json'));
const BOUNDS = { maxDays: 365, maxRatePerMin: 600 };

describe('key form', () => {
  it('builds the creation request; empty limits mean "no limit on the key"; lists are split and de-duplicated', () => {
    const d = { ...emptyDraft(), name: '  reader  ', days: 90, scopes: ['markets:read', 'orders:read'], venues: 'hyperliquid, gmx hyperliquid', instruments: 'hyperliquid:BTC', ips: '10.0.0.0/8; 203.0.113.7', maxOrderUsd: '250,5' };
    expect(draftBody(d, BOUNDS)).toEqual({ ok: true, body: { name: 'reader', scopes: ['markets:read', 'orders:read'], expiresInDays: 90, rateLimitPerMin: 120, limits: { maxOrderNotionalUsd: 250.5, maxDailyNotionalUsd: null },
      restrictions: { networks: [], venues: ['hyperliquid', 'gmx'], instruments: ['hyperliquid:BTC'], ipAllow: ['10.0.0.0/8', '203.0.113.7'] }, mandateId: null } });
    expect(splitList(' a,b ;c\na ')).toEqual(['a', 'b', 'c']);
  });
  it('names every field to fix, and never sends a request with one', () => {
    const bad = draftBody({ ...emptyDraft(), name: '', scopes: [], ratePerMin: '0', maxOrderUsd: '-5', maxDailyUsd: 'abc', ips: 'not an ip', mandateId: 'nope' }, BOUNDS);
    expect(bad).toEqual({ ok: false, errors: ['name', 'scopes', 'rate', 'maxOrder', 'maxDaily', 'ips', 'mandate'] });
    expect(draftBody({ ...emptyDraft(), name: 'x', ratePerMin: '601' }, BOUNDS)).toEqual({ ok: false, errors: ['rate'] });
    expect(draftBody({ ...emptyDraft(), name: 'x', days: 9999 }, BOUNDS)).toMatchObject({ ok: true, body: { expiresInDays: 365 } });                 // an expiry is always sent, at most one year
    expect(draftBody({ ...emptyDraft(), name: 'x', mandateId: 'AAAAAAAA-0000-4000-8000-000000000001' }, BOUNDS)).toMatchObject({ ok: true, body: { mandateId: 'aaaaaaaa-0000-4000-8000-000000000001' } });
  });
  it('the scope checklist covers exactly the server\'s closed list', () => {
    expect(SCOPE_GROUPS.flatMap((g) => g.scopes).sort()).toEqual([...SCOPES].sort());
    expect(doc['x-spw-scopes'].map((s: { scope: string }) => s.scope).sort()).toEqual([...SCOPES].sort());
    expect(SCOPE_GROUPS.find((g) => g.id === 'execute')!.scopes.sort()).toEqual(doc['x-spw-scopes'].filter((s: { execution: boolean }) => s.execution).map((s: { scope: string }) => s.scope).sort());
    expect(scopeKey('orders:read')).toBe('dvScope_orders_read');
  });
  it('small helpers', () => {
    expect(daysLeft(Date.UTC(2026, 0, 11), Date.UTC(2026, 0, 1))).toBe(10);
    expect(daysLeft(0, 1)).toBe(0);
    expect(keyIdOf('spw_live_spk_0123456789ab_xxxxxxxx')).toBe('spk_0123456789ab');
    expect(keyIdOf('whsec_abc')).toBeNull();
    expect(errKey('approval_failed')).toBe('dvErr_approval_failed');
    expect(errKey('something_new')).toBe('dvErrOther');
    expect(errKey(undefined)).toBe('dvErrOther');
  });
});

describe('OpenAPI viewer', () => {
  const ops = docOps(doc);
  it('lists every operation of the committed document with its scope, state and parameters', () => {
    expect(ops).toHaveLength(27);   // 26 + compareMarkets (v11 markets hub)
    expect(ops.every((o) => o.scope && o.summary && o.path.startsWith('/api/v1/trading/') && o.responses.length > 0)).toBe(true);
    expect(ops.filter((o) => !o.implemented).map((o) => o.id).sort()).toEqual(['backtestStrategy', 'cancelOrder', 'closePosition', 'createAgent', 'createStrategy', 'placeOrder', 'previewOrder', 'reducePosition', 'startAgent', 'startStrategy', 'stopAgent', 'stopStrategy']);
    for (const o of ops.filter((x) => !x.implemented)) { expect(o.idempotent, o.id).toBe(true); expect(o.responses.some((r) => r.code.startsWith('2')), o.id).toBe(false); expect(o.responses.some((r) => r.code === '501'), o.id).toBe(true); }
    const markets = ops.find((o) => o.id === 'listMarkets')!;
    expect(markets).toMatchObject({ method: 'GET', scope: 'markets:read', implemented: true, idempotent: false, needsMandate: false, body: null });
    expect(markets.params.map((p) => p.name)).toEqual(['venue', 'kind', 'q', 'limit']);
    expect(markets.params.find((p) => p.name === 'kind')!.type).toBe('"perpetual" | "spot"');
    expect(markets.params.find((p) => p.name === 'limit')!.type).toBe('integer 1…5000 (default 2000)');
    const place = ops.find((o) => o.id === 'placeOrder')!;
    expect(place).toMatchObject({ method: 'POST', scope: 'orders:execute', needsMandate: true });
    expect(JSON.parse(place.body!).required).toEqual(expect.arrayContaining(['mode', 'instrument', 'side', 'type', 'size']));
    expect(docTags(ops).map((g) => g.tag)).toEqual(['Meta', 'Markets', 'Portfolio', 'Positions', 'Orders', 'Strategies', 'Agents', 'Risk']);
    expect(docTags(ops).reduce((n, g) => n + g.ops.length, 0)).toBe(27);
  });
  it('never throws on a missing or odd document', () => {
    expect(docOps(null)).toEqual([]);
    expect(docOps({})).toEqual([]);
    expect(docOps({ paths: { '/x': { get: {} } } })).toEqual([expect.objectContaining({ id: 'get /x', method: 'GET', scope: '', implemented: true, params: [], body: null, responses: [] })]);
    expect(schemaType(undefined)).toBe('any');
    expect(schemaType({ type: 'array', items: { type: 'string' } })).toBe('array of string');
    expect(schemaType({ anyOf: [{ type: 'number' }, { type: 'null' }] })).toBe('number | null');
  });
});

describe('code examples', () => {
  const templates = Object.keys(doc.paths).map((p) => new RegExp(`^${p.replace('/api/v1/trading', '').replace(/\{[a-z]+\}/gi, '[^/]+')}$`));
  it('every path an example calls is a real route of the API', () => {
    const ex = codeExamples('https://wallet.example');
    expect(ex.map((e) => e.id)).toEqual(['curl', 'python', 'typescript']);
    for (const e of ex) {
      const paths = examplePaths(e.code.split('https://wallet.example/api/v1/trading').join('${BASE}'));
      expect(paths.length, e.id).toBeGreaterThanOrEqual(3);
      for (const p of paths) expect(templates.some((t) => t.test(p)), `${e.id}: ${p}`).toBe(true);
      expect(e.code).toContain('Bearer');
      expect(e.code).not.toMatch(/spw_live_[A-Za-z0-9_-]{20,}/);   // no key-looking string in an example
    }
    expect(ex.find((e) => e.id === 'python')!.code).toContain('Idempotency-Key');
    expect(ex.find((e) => e.id === 'typescript')!.code).toContain('idempotency-key');
  });
});

describe('i18n: the dv block', () => {
  const i18n = read('../src/i18n.ts'), screen = read('../src/screens/Developer.tsx'), pure = read('../src/developer.ts'), settings = read('../src/screens/Settings.tsx');
  const a = i18n.indexOf('// >>> v11 Developer / API'), b = i18n.indexOf('// <<< end of the `dv` block');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b(dv[A-Za-z0-9_]+): \[\s*'((?:[^'\\]|\\.)+)',\s*'((?:[^'\\]|\\.)+)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const keys = new Set(pairs.map((p) => p.key));
  it('one contiguous block; every key has a French and an English sentence; no dv key outside it', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(pairs.length).toBeGreaterThan(150);
    expect(keys.size).toBe(pairs.length);                                               // no duplicate
    expect([...block.matchAll(/\b(dv[A-Za-z0-9_]+): \[/g)].length).toBe(pairs.length);  // every entry parsed: two non-empty strings each
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bdv[A-Z][A-Za-z0-9_]*: \[/g)).toBeNull();
    for (const p of pairs) expect(p.fr.trim().length > 0 && p.en.trim().length > 0, p.key).toBe(true);
  });
  it('every key the screen uses exists, and every key of the block is used', () => {
    const used = new Set<string>([...(screen + settings).matchAll(/'(dv[A-Za-z0-9_]+)'/g)].map((m) => m[1]!));
    const families: Record<string, string[]> = { dvTab_: ['keys', 'usage', 'webhooks', 'docs', 'status'], dvStatus_: ['active', 'expired', 'revoked'], dvAxis_: ['venues', 'instruments', 'networks', 'ipAllow'],
      dvFieldErr_: ['name', 'scopes', 'rate', 'maxOrder', 'maxDaily', 'ips', 'mandate'], dvGroup_: ['read', 'prepare', 'execute'], dvDel_: ['delivered', 'pending', 'failed'],
      dvSvc_: ['database', 'signer', 'market_data', 'execution', 'webhooks'], dvScope_: SCOPES.map((s) => s.replace(':', '_')), dvErr_: [...DV_ERRORS] };
    for (const [prefix, members] of Object.entries(families)) {
      expect(screen.includes(`\`${prefix}\${`) || pure.includes(`\`${prefix}\${`), prefix).toBe(true);   // the family is really built in the code
      for (const m of members) used.add(prefix + m);
    }
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    for (const k of keys) expect(used.has(k), `unused key: ${k}`).toBe(true);
  });
  it('the screen is a chunk of its own, reachable from Settings', () => {
    const app = read('../src/App.tsx');
    expect(app).toMatch(/developer: \(\) => import\('\.\/screens\/Developer'\)/);
    expect(app).not.toMatch(/^import .*screens\/Developer/m);
    expect(settings).toContain("['developer', 'key', t('dvTitle'), '']");
    expect(screen).not.toMatch(/https?:\/\/(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i);   // nothing is loaded from another origin (the CSP forbids it)
  });
});
