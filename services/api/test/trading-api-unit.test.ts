// Trading API — pure parts (no database, no server): key tokens and hashes, canonical intents, the "does this change widen
// the key" rule, source-address matching, the contract table, and the OpenAPI document against its committed copy.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyChanges, canonicalJson, formatToken, hashSecret, inertScopes, intentChallenge, ipAllowed, newKeyId, newKeySecret, parseToken, sameHash, type KeyFacts } from '../src/trading-api/key-model.ts';
import { buildOpenApi, openApiJson, openApiMarkdown } from '../src/trading-api/openapi.ts';
import { ANY_SCOPE, EXECUTION_SCOPES, KeyCreateSchema, OPERATIONS, SCOPES, TRADING_PREFIX, WEBHOOK_EVENTS } from '../src/trading-api/spec.ts';
import { REPO_ROOT } from './test-db.ts';

describe('key tokens', () => {
  it('a token is spw_live_<public id>_<32 random bytes>; nothing else parses', () => {
    const id = newKeyId(), secret = newKeySecret(), token = formatToken(id, secret);
    expect(id).toMatch(/^spk_[0-9a-f]{12}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(parseToken(token)).toEqual({ id, secret });
    for (const bad of ['', 'spw_live_', token.slice(0, -1), `${token}x`, token.replace('spw_live_', 'spw_demo_'), `spw_live_spk_XYZ_${secret}`, ` ${token}`, `spw_live_${id}_${'a'.repeat(200)}`]) expect(parseToken(bad), bad).toBeNull();
  });
  it('the stored value is an HMAC under the pepper: it depends on the id, the secret and the pepper, and never contains the secret', () => {
    const id = newKeyId(), secret = newKeySecret(), h = hashSecret('p'.repeat(40), id, secret);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(secret);
    expect(hashSecret('p'.repeat(40), id, secret)).toBe(h);
    expect(hashSecret('q'.repeat(40), id, secret)).not.toBe(h);
    expect(hashSecret('p'.repeat(40), newKeyId(), secret)).not.toBe(h);
    expect(hashSecret('p'.repeat(40), id, newKeySecret())).not.toBe(h);
    expect(sameHash(h, h)).toBe(true);
    expect(sameHash(h, h.slice(1))).toBe(false);
    expect(sameHash(h, '0'.repeat(64))).toBe(false);
  });
});

describe('canonical intents', () => {
  it('key order does not change the bytes; any value change changes the challenge', () => {
    const a = { v: 1, action: 'create', key: { scopes: ['markets:read'], name: 'bot', limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: 100 } } };
    const b = { key: { limits: { maxDailyNotionalUsd: 100, maxOrderNotionalUsd: null }, name: 'bot', scopes: ['markets:read'] }, action: 'create', v: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson({ x: undefined, y: 1 })).toBe('{"y":1}');
    const c = { ...a, key: { ...a.key, scopes: ['markets:read', 'orders:execute'] } };
    expect(intentChallenge(canonicalJson(a)).equals(intentChallenge(canonicalJson(b)))).toBe(true);
    expect(intentChallenge(canonicalJson(a)).equals(intentChallenge(canonicalJson(c)))).toBe(false);
    expect(intentChallenge('x')).toHaveLength(32);
  });
});

describe('widening', () => {
  const base: KeyFacts = { name: 'bot', scopes: ['markets:read', 'orders:read'], expiresAt: new Date('2027-01-01T00:00:00Z'), limits: { maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000 },
    restrictions: { networks: ['base'], venues: ['hyperliquid'], instruments: [], ipAllow: ['10.0.0.0/8'] }, rateLimitPerMin: 120, mandateId: null };
  const w = (c: Parameters<typeof applyChanges>[1]) => applyChanges(base, c).widening;
  it('removing authority needs nothing', () => {
    expect(w({ name: 'renamed' })).toEqual([]);
    expect(w({ scopes: ['markets:read'] })).toEqual([]);
    expect(w({ expiresAt: '2026-12-01T00:00:00.000Z' })).toEqual([]);
    expect(w({ limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 5000 } })).toEqual([]);
    expect(w({ restrictions: { networks: ['base'], venues: ['hyperliquid'], instruments: ['hyperliquid:BTC'], ipAllow: ['10.0.0.0/8'] } })).toEqual([]);  // all → a list
    expect(w({ rateLimitPerMin: 60 })).toEqual([]);
  });
  it('every way of giving a key more is detected', () => {
    expect(w({ scopes: ['markets:read', 'orders:read', 'orders:execute'] })).toEqual(['scopes']);
    expect(w({ expiresAt: '2027-02-01T00:00:00.000Z' })).toEqual(['expiresAt']);
    expect(w({ limits: { maxOrderNotionalUsd: 2000, maxDailyNotionalUsd: 5000 } })).toEqual(['limits']);
    expect(w({ limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: 5000 } })).toEqual(['limits']);                                                       // a limit removed
    expect(w({ restrictions: { networks: ['base', 'ethereum'], venues: ['hyperliquid'], instruments: [], ipAllow: ['10.0.0.0/8'] } })).toEqual(['restrictions.networks']);
    expect(w({ restrictions: { networks: ['base'], venues: [], instruments: [], ipAllow: ['10.0.0.0/8'] } })).toEqual(['restrictions.venues']);                 // a list → all
    expect(w({ restrictions: { networks: ['base'], venues: ['hyperliquid'], instruments: [], ipAllow: [] } })).toEqual(['restrictions.ipAllow']);
    expect(w({ rateLimitPerMin: 121 })).toEqual(['rateLimitPerMin']);
    expect(w({ mandateId: '00000000-0000-4000-8000-000000000001' })).toEqual(['mandateId']);
    expect(applyChanges({ ...base, mandateId: '00000000-0000-4000-8000-000000000001' }, { mandateId: null }).widening).toEqual([]);                          // unbinding removes authority
  });
  it('execution scopes are inert without a mandate', () => {
    expect(inertScopes(['markets:read', 'orders:execute', 'orders:prepare', 'positions:manage'], null)).toEqual(['orders:execute', 'positions:manage']);
    expect(inertScopes(['orders:execute'], '00000000-0000-4000-8000-000000000001')).toEqual([]);
  });
});

describe('source addresses', () => {
  it('an empty list allows everything; addresses and CIDR blocks match exactly; garbage never matches', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('192.168.2.7', ['192.168.2.7'])).toBe(true);
    expect(ipAllowed('192.168.2.8', ['192.168.2.7'])).toBe(false);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('10.1.2.3', ['not-an-ip', '10.0.0.0/99'])).toBe(false);
    expect(ipAllowed('not-an-ip', ['10.0.0.0/8'])).toBe(false);
  });
});

describe('contract', () => {
  it('the scope list is closed and has no scope that reaches keys, the signer, security or key management', () => {
    expect(SCOPES).toEqual(['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage']);
    for (const s of SCOPES) expect(s).not.toMatch(/key|signer|security|mandate|developer|recovery|seed|admin/);
    expect(EXECUTION_SCOPES.every((s) => SCOPES.includes(s))).toBe(true);
    expect(KeyCreateSchema.safeParse({ name: 'x', scopes: ['keys:manage'], expiresInDays: 30 }).success).toBe(false);
    expect(KeyCreateSchema.safeParse({ name: 'x', scopes: ['markets:read'] }).success).toBe(false);                    // an expiry is required
    expect(KeyCreateSchema.safeParse({ name: 'x', scopes: ['markets:read'], expiresInDays: 366 }).success).toBe(false);  // at most one year
    expect(KeyCreateSchema.safeParse({ name: 'x', scopes: ['markets:read'], expiresInDays: 365 }).success).toBe(true);
  });
  it('every operation declares a scope; every mutation requires an Idempotency-Key; nothing unimplemented is a GET', () => {
    expect(new Set(OPERATIONS.map((o) => o.id)).size).toBe(OPERATIONS.length);
    expect(new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`)).size).toBe(OPERATIONS.length);
    for (const o of OPERATIONS) {
      expect(o.scope === ANY_SCOPE || SCOPES.includes(o.scope), o.id).toBe(true);
      // (a preview creates nothing and the kill switch is idempotent by nature: the two POSTs that take no Idempotency-Key)
      if (o.method !== 'GET') expect(o.idempotent, o.id).toBe(!['previewOrder', 'engageKillSwitch'].includes(o.id));
      if (o.noMandate) expect(['cancelOrder', 'runCommand', 'engageKillSwitch'], o.id).toContain(o.id);            // only what can remove risk, and the command router
      if (!o.implemented) expect(o.method, o.id).not.toBe('GET');
      if (o.method === 'GET') expect(o.scope === ANY_SCOPE || /:read$/.test(o.scope), o.id).toBe(true);
    }
    expect(OPERATIONS.filter((o) => o.scope === ANY_SCOPE).map((o) => o.id)).toEqual(['getOpenApi']);
  });
});

describe('OpenAPI', () => {
  const doc = buildOpenApi() as any;
  it('is OpenAPI 3.1 with a bearer scheme, the error model, and the scope and idempotency header on every operation', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes.bearerKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components.schemas.Error.required).toEqual(['error', 'message']);
    let n = 0;
    for (const [path, item] of Object.entries(doc.paths) as [string, any][]) {
      expect(path.startsWith(`${TRADING_PREFIX}/`)).toBe(true);
      for (const [method, op] of Object.entries(item) as [string, any][]) {
        n += 1;
        const spec = OPERATIONS.find((o) => o.id === op.operationId)!;
        expect(op['x-spw-scope'], op.operationId).toBe(spec.scope === ANY_SCOPE ? 'any valid key' : spec.scope);
        expect(op.security).toEqual([{ bearerKey: spec.scope === ANY_SCOPE ? [] : [spec.scope] }]);
        expect(op.responses['401'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
        const idem = op.parameters.find((p: any) => p.name === 'Idempotency-Key');
        if (method === 'get' || !spec.idempotent) expect(idem).toBeUndefined(); else expect(idem).toMatchObject({ in: 'header', required: true });
        if (spec.implemented) { expect(op.responses['200']).toBeDefined(); expect(op.responses['501']).toBeUndefined(); }
        else { expect(op.responses['501']).toBeDefined(); expect(Object.keys(op.responses).some((c) => c.startsWith('2'))).toBe(false); }  // an unwired operation documents no success
        for (const p of op.parameters.filter((x: any) => x.in === 'path')) expect(path).toContain(`{${p.name}}`);
      }
    }
    expect(n).toBe(OPERATIONS.length);
    expect(doc['x-spw-webhook-events'].map((e: any) => e.event)).toEqual(WEBHOOK_EVENTS.map((e) => e.event));
  });
  it('the committed files are exactly what the code generates (run: node scripts/gen-openapi.mts)', () => {
    expect(readFileSync(`${REPO_ROOT}/docs/openapi/trading-v1.json`, 'utf8')).toBe(openApiJson());
    expect(readFileSync(`${REPO_ROOT}/docs/TRADING-API-OPENAPI.md`, 'utf8')).toBe(openApiMarkdown());
    expect(openApiJson()).toBe(openApiJson());   // deterministic
  });
});
