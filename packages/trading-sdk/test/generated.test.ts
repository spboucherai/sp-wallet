// The generated types are what the committed OpenAPI document gives; the webhook helper matches the server's code; the
// fixtures the Python SDK tests read are produced by the server's code; the built package loads without any dependency.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyWebhook as serverVerify, webhookSignature as serverSignature } from '../../../services/api/src/alerts/webhook.ts';
import { canonicalJson as serverCanonicalJson } from '../../../services/api/src/trading-api/key-model.ts';
import { openApiJson } from '../../../services/api/src/trading-api/openapi.ts';
import { generate, OPENAPI_PATH, OUTPUT_PATH, tsType } from '../scripts/gen-types.mts';
import { ORDER_STATES as SERVER_STATES } from '../../../services/api/src/trading-api/spec.ts';
import { API_VERSION, constructWebhookEvent, EXECUTION_SCOPES, FINAL_ORDER_STATES, IDEMPOTENCY_KEY_RE, MANDATE_DENY_REASONS, OPERATION_ERRORS, OPERATIONS, ORDER_STATES, RISK_CHECK_IDS, SCOPES, verifyWebhook, WEBHOOK_EVENTS,
  WEBHOOK_TOLERANCE_SECONDS, webhookSignature, WebhookVerificationError, type OperationId } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../../..');
const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));

describe('generated types', () => {
  it('src/generated/openapi.ts is exactly what gen-types.mts gives for docs/openapi/trading-v1.json', () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8'), 'run: node packages/trading-sdk/scripts/gen-types.mts').toBe(generate(doc));
  });
  it('the committed OpenAPI document is the one the server code generates (so the SDK types follow the server)', () => {
    expect(readFileSync(OPENAPI_PATH, 'utf8')).toBe(openApiJson());
  });
  it('the operation table, the scopes and the events are the document\'s', () => {
    const ids = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(Object.keys(OPERATIONS).sort()).toEqual(ids.sort());
    expect(ids).toHaveLength(32);
    const writes = (Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].method !== 'GET');
    expect(writes.filter((id) => OPERATIONS[id].implemented).sort()).toEqual(['cancelOrder', 'closePosition', 'engageKillSwitch', 'placeOrder', 'previewOrder', 'reducePosition', 'runCommand']);
    // the strategy and agent writes answer 501; a preview and the kill switch take no Idempotency-Key, every other write requires one
    expect(writes.filter((id) => !OPERATIONS[id].implemented)).toHaveLength(7);
    expect(writes.filter((id) => !OPERATIONS[id].idempotent).sort()).toEqual(['engageKillSwitch', 'previewOrder']);
    expect((Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].requiresMandate && OPERATIONS[id].implemented).sort()).toEqual(['closePosition', 'placeOrder', 'reducePosition']);
    expect([...ORDER_STATES]).toEqual([...SERVER_STATES]); expect([...FINAL_ORDER_STATES]).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'FAILED']);
    expect([...MANDATE_DENY_REASONS]).toEqual(doc['x-spw-mandate-deny-reasons']); expect([...RISK_CHECK_IDS]).toEqual(doc['x-spw-risk-checks']);
    for (const [p, item] of Object.entries(doc.paths as Record<string, Record<string, { operationId: OperationId; 'x-spw-errors': { status: number; code: string }[] }>>)) for (const o of Object.values(item)) {
      expect(OPERATION_ERRORS[o.operationId], p).toEqual(o['x-spw-errors'].map((e) => [e.status, e.code]));
      expect([...OPERATIONS[o.operationId].statuses].filter((s) => s !== 200), p).toEqual([...new Set(o['x-spw-errors'].map((e) => e.status))].sort());
    }
    expect(OPERATION_ERRORS.placeOrder).toContainEqual([403, 'execution_disabled']); expect(OPERATION_ERRORS.getOrderbook).toContainEqual([422, 'no_orderbook']);
    expect([...SCOPES]).toEqual(doc['x-spw-scopes'].map((s: { scope: string }) => s.scope));
    expect([...EXECUTION_SCOPES]).toEqual(['orders:execute', 'orders:cancel', 'positions:manage', 'strategies:manage', 'agents:manage']);
    expect([...WEBHOOK_EVENTS]).toEqual(doc['x-spw-webhook-events'].map((e: { event: string }) => e.event));
    expect(API_VERSION).toBe(doc.info.version);
  });
  it('the generator refuses what it does not understand instead of guessing', () => {
    expect(() => tsType({ type: 'string', oneOf: [] })).toThrow(/unsupported JSON Schema keyword/);
    expect(() => tsType({ type: 'tuple' })).toThrow(/unsupported type/);
    expect(tsType({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }], items: false })).toBe('[string, string]');
    expect(tsType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(tsType({ type: ['number', 'null'] })).toBe('number | null');
    expect(tsType({})).toBe('unknown');
    expect(tsType({ const: true })).toBe('true'); expect(tsType({ type: 'string', const: 'perpetual' })).toBe('"perpetual"'); expect(tsType({ const: null })).toBe('null');
    expect(tsType({ $ref: '#/components/schemas/Order' })).toBe('Order'); expect(tsType({ $ref: '#/components/schemas/Error' })).toBe('ApiErrorBody');
    expect(tsType({ anyOf: [{ $ref: '#/components/schemas/Order', description: 'x' }, { type: 'null' }] })).toBe('Order | null');
    expect(() => tsType({ $ref: 'https://elsewhere.example/schema.json' })).toThrow(/unsupported \$ref/);
    expect(() => tsType({ $ref: '#/paths/x' })).toThrow(/unsupported \$ref/);
  });
  it('local constants are the server\'s', () => {
    // read from the source text: importing idempotency.ts would load the server's configuration and database modules
    const src = readFileSync(path.join(ROOT, 'services/api/src/trading-api/idempotency.ts'), 'utf8');
    expect(src).toContain(`export const IDEMPOTENCY_RE = ${String(IDEMPOTENCY_KEY_RE)};`);
    expect(readFileSync(path.join(ROOT, 'services/api/src/alerts/webhook.ts'), 'utf8')).toContain(`toleranceSec = ${WEBHOOK_TOLERANCE_SECONDS})`);
  });
});

describe('webhook verification matches services/api/src/alerts/webhook.ts', () => {
  const secret = 'whsec_test_0123456789abcdefghijklmnopqrstuvwxyz', now = 1_794_789_400_000, ts = Math.floor(now / 1000);
  const body = JSON.stringify({ app: 'sp-wallet', id: '5b0c7c0e-7a43-4c2c-9d0e-6f1c3b6c9a11', event: 'key.revoked', ts: '2026-11-16T00:36:40.000Z', data: { keyId: 'spk_0123456789ab', name: 'ré — 漢字 ✓', reason: 'rotated' } });
  it('the SDK computes the signature the server computes, and accepts what the server sends', async () => {
    const sig = serverSignature(secret, ts, body);
    expect(await webhookSignature(secret, ts, body)).toBe(sig);
    expect(await verifyWebhook({ secret, timestamp: String(ts), signature: sig, body, now })).toBe(true);
    expect(await verifyWebhook({ secret, timestamp: ts, signature: sig, body: new TextEncoder().encode(body), now })).toBe(true);
    expect((await constructWebhookEvent<{ keyId: string }>({ secret, timestamp: String(ts), signature: sig, body, now })).data.keyId).toBe('spk_0123456789ab');
  });
  it('same verdict as the server\'s verifyWebhook on good and bad inputs', async () => {
    const sig = serverSignature(secret, ts, body);
    const cases: [string, string, string, string, number][] = [
      [secret, String(ts), sig, body, now], [secret, String(ts), sig, body, now + 300_000], [secret, String(ts), sig, body, now + 301_000], [secret, String(ts), sig, body, now - 301_000],
      ['other secret', String(ts), sig, body, now], [secret, String(ts + 1), sig, body, now], [secret, String(ts), sig, body + ' ', now], [secret, String(ts), sig.replace('v1=', 'v2='), body, now],
      [secret, String(ts), sig.slice(0, -1), body, now], [secret, String(ts), sig.toUpperCase(), body, now], [secret, 'abc', sig, body, now], [secret, '1794789400.5', sig, body, now], [secret, String(ts), '', body, now],
    ];
    const verdicts: boolean[] = [];
    for (const [s, t, g, b, n] of cases) {
      const mine = await verifyWebhook({ secret: s, timestamp: t, signature: g, body: b, now: n });
      expect(mine, JSON.stringify([t, g.slice(0, 12), n - now])).toBe(serverVerify(s, t, g, b, n));
      verdicts.push(mine);
    }
    expect(verdicts).toEqual([true, true, false, false, false, false, false, false, false, false, false, false, false]);
    expect(await verifyWebhook({ secret, timestamp: null, signature: sig, body, now })).toBe(false);
    expect(await verifyWebhook({ secret, timestamp: String(ts), signature: undefined, body, now })).toBe(false);
    await expect(constructWebhookEvent({ secret, timestamp: String(ts), signature: 'v1=00', body, now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });
  it('the vectors read by the Python SDK tests are produced by the server\'s code', () => {
    const f = JSON.parse(readFileSync(path.join(ROOT, 'sdk/python/tests/fixtures/server-vectors.json'), 'utf8')) as {
      webhooks: { secret: string; timestamp: number; body: string; signature: string }[]; canonical: { value: unknown; json: string }[] };
    expect(f.webhooks.length).toBeGreaterThanOrEqual(3);
    for (const v of f.webhooks) expect(serverSignature(v.secret, v.timestamp, v.body)).toBe(v.signature);
    expect(f.canonical.length).toBeGreaterThanOrEqual(6);
    for (const v of f.canonical) expect(serverCanonicalJson(v.value)).toBe(v.json);
  });
});

describe('the built package', () => {
  it('dist/index.js loads in a bare Node process (no node_modules) and exports the surface; declarations are emitted', () => {
    execFileSync('node', [path.join(HERE, '../scripts/build.mts')], { stdio: 'pipe' });
    const out = execFileSync('node', ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(path.join(HERE, '../dist/index.js'))}); const c = new m.SPWallet({ apiKey: 'spw_live_x' }); console.log(JSON.stringify({ n: Object.keys(m).length, base: c.baseUrl, s: String(c), v: m.SDK_VERSION, k: m.newIdempotencyKey().length }));`],
    { encoding: 'utf8', cwd: '/', env: { PATH: process.env.PATH ?? '' } });
    const r = JSON.parse(out) as { n: number; base: string; s: string; v: string; k: number };
    expect(r).toMatchObject({ base: 'https://wallet.spboucher.ai', s: 'SPWallet(https://wallet.spboucher.ai, apiKey=<redacted>)', k: 36 });
    expect(r.n).toBeGreaterThan(40);
    const js = readFileSync(path.join(HERE, '../dist/index.js'), 'utf8');
    expect(js).not.toMatch(/from\s+["'](?!\.)/); // no bare import: zero runtime dependency
    expect(js).not.toMatch(/\brequire\(/);
    const dts = readFileSync(path.join(HERE, '../dist/index.d.ts'), 'utf8');
    expect(dts).toContain("from './client.js'"); expect(dts).not.toMatch(/\.ts['"]/);
  }, 60_000);
});
