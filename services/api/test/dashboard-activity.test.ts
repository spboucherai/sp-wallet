/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/dashboard-activity.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
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

// V11 interface — GET /api/v1/dashboard/activity and its CSV, through the real server (own database, fixture venues, a real
// signer process, a software passkey; PAPER only): the unified timeline composes the wallet activity, the plans, the unified
// orders, the risk engine's denials and the audit chain; filters and the cursor are applied on the merged list; a source
// that fails is named and the others still answer; an API key and a request without a session are refused.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { BTC, Clock, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), A = '/api/v1/dashboard/activity';
const owner = new TestPasskey(RP, ORIGIN);
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, account = '', keySecret = '';

async function call(method: string, path: string, o: { key?: string; body?: unknown; anonymous?: boolean } = {}): Promise<{ status: number; json: any; text: string; headers: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (o.key) headers.authorization = `Bearer ${o.key}`; else if (!o.anonymous) { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['idempotency-key'] = `da-${randomUUID()}`; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, text: r.body, headers: r.headers, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const order = (body: Record<string, unknown> = {}) => call('POST', '/api/v1/trading/orders', { body: { mode: 'paper', accountId: account, instrument: BTC, side: 'buy', type: 'market', size: '0.01', ...body } });
const all = async (query = ''): Promise<any[]> => { const out: any[] = []; let cursor: string | null = null;
  do { const r = await call('GET', `${A}?limit=3${query}${cursor ? `&cursor=${cursor}` : ''}`); expect(r.status, r.text).toBe(200); out.push(...r.json.items); cursor = r.json.nextCursor; } while (cursor);
  return out; };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-dash-activity-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('dashboard_activity');
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  delete process.env.SPW_API_KEY_PEPPER; delete process.env.SPW_TRADING_API_EXECUTION;
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = owner.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  setMarket(v, 50_000);
  const derivs = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: derivs, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });

  // what the timeline will show: a paper account and two filled paper orders, an API key, a kill switch that refuses a third order
  const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label: 'timeline', collateral: '10000' } });
  expect(a.status, a.text).toBe(200); account = a.json.id;
  expect((await order()).status).toBe(200);
  clock.advance(2_000);
  expect((await order({ size: '0.02' })).status).toBe(200);
  const p = await call('POST', '/api/v1/developer/keys/prepare', { body: { name: 'timeline key', scopes: ['markets:read'], expiresInDays: 30, rateLimitPerMin: 600 } });
  expect(p.status, p.text).toBe(200);
  const k = await call('POST', '/api/v1/developer/keys', { body: { intentId: p.json.intentId, assertion: owner.assert(Buffer.from(p.json.options.challenge, 'base64url')) } });
  expect(k.status, k.text).toBe(200); keySecret = k.json.secret;
  expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'timeline test' } })).status).toBe(200);
  clock.advance(2_000);
  const refused = await order({ size: '0.03' });
  expect(refused.status, refused.text).toBe(423);
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('GET /api/v1/dashboard/activity', () => {
  it('one list, newest first, with the kinds of every source: orders (paper, unified states), the risk denial, key and switch events of the audit chain; codes, never sentences', async () => {
    const r = await call('GET', `${A}?limit=200`);
    expect(r.status, r.text).toBe(200);
    const items = r.json.items as any[];
    expect(r.json.errors).toEqual([]);
    expect(r.json.kinds).toContain('order');
    expect(r.json.bounds).toEqual({ perSource: 500, plans: 50 });
    const at = items.map((i) => Date.parse(i.at));
    expect([...at].sort((x, y) => y - x)).toEqual(at);
    const orders = items.filter((i) => i.kind === 'order');
    expect(orders.length).toBeGreaterThanOrEqual(2);
    for (const o of orders) { expect(o.mode).toBe('paper'); expect(o.venue).toBe('hyperliquid'); expect(o.instrument).toBe(BTC); expect(o.ref.type).toBe('order'); expect(o.principal).toEqual({ kind: 'owner', id: 'owner' }); expect(o.code).toBe('order'); }
    expect(orders.filter((o) => o.status === 'FILLED').length).toBe(2);
    expect(orders.find((o) => o.status === 'FILLED').amount).toEqual({ value: expect.any(String), symbol: 'BTC' });
    // the history of an order is read from the existing route with the item's reference
    const one = await call('GET', `/api/v1/trading/orders/${encodeURIComponent(orders[0].ref.id)}`);
    expect(one.status, one.text).toBe(200);
    expect(one.json.history.length).toBeGreaterThan(0);
    const denial = items.find((i) => i.kind === 'risk' && i.code === 'risk.denied');
    expect(denial).toBeTruthy();
    expect(denial.mode).toBe('paper'); expect(String(denial.params.failed)).toContain('kill_switch'); expect(denial.ref.type).toBe('decision');
    expect(items.some((i) => i.kind === 'risk' && i.code === 'risk.kill_switch' && i.params.engaged === true)).toBe(true);
    expect(items.some((i) => i.kind === 'key' && i.code === 'apikey.created')).toBe(true);
    expect(items.some((i) => i.kind === 'security' && i.code === 'deriv.paper.account_created' && i.mode === 'paper')).toBe(true);
    expect(items.some((i) => i.code === 'deriv.paper.order')).toBe(false);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    // the audit chain's own verdict comes with the page
    expect(r.json.audit).toMatchObject({ intact: true, brokenAt: null });
    expect(r.json.audit.total).toBeGreaterThan(0);
  });

  it('filters are applied on the server: kind, mode, venue, principal, dates', async () => {
    const get = async (q: string) => (await call('GET', `${A}?limit=200&${q}`)).json.items as any[];
    expect((await get('kind=order')).every((i) => i.kind === 'order')).toBe(true);
    expect((await get('kind=order')).length).toBeGreaterThanOrEqual(2);
    expect(await get('kind=order&mode=live')).toEqual([]);
    expect((await get('mode=paper')).every((i) => i.mode === 'paper')).toBe(true);
    expect((await get('venue=hyperliquid')).every((i) => i.venue === 'hyperliquid')).toBe(true);
    expect((await get('principal=owner')).every((i) => i.principal.kind === 'owner')).toBe(true);
    expect(await get('principal=agent')).toEqual([]);
    expect(await get(`to=${encodeURIComponent('2001-01-01T00:00:00Z')}`)).toEqual([]);
    expect((await get(`from=${encodeURIComponent('2001-01-01')}`)).length).toBeGreaterThan(3);
    expect((await call('GET', `${A}?kind=nope`)).status).toBe(400);
    expect((await call('GET', `${A}?from=yesterday`)).status).toBe(400);
  });

  it('walking the pages with the cursor gives every item exactly once, in the same order', async () => {
    const whole = (await call('GET', `${A}?limit=200`)).json.items.map((i: any) => i.id);
    const walked = (await all()).map((i) => i.id);
    expect(walked).toEqual(whole);
    expect(new Set(walked).size).toBe(walked.length);
    expect((await all('&kind=order')).map((i) => i.id)).toEqual((await call('GET', `${A}?limit=200&kind=order`)).json.items.map((i: any) => i.id));
    expect((await call('GET', `${A}?cursor=bm9wZQ`)).status).toBe(400);
  });

  it('a source that fails is named; the other sources are still answered', async () => {
    const orders = app.execution.orders, list = orders.list;
    orders.list = async () => { throw new Error('orders table unreadable'); };
    try {
      const r = await call('GET', `${A}?limit=200`);
      expect(r.status, r.text).toBe(200);
      expect(r.json.errors).toEqual([{ source: 'orders', code: 'source_failed', message: 'orders table unreadable' }]);
      expect(r.json.items.some((i: any) => i.kind === 'order')).toBe(false);
      expect(r.json.items.some((i: any) => i.kind === 'risk')).toBe(true);
      expect(r.json.items.some((i: any) => i.kind === 'key')).toBe(true);
    } finally { orders.list = list; }
  });

  it('owner session only: 401 without a session, an API key is refused', async () => {
    expect((await call('GET', A, { anonymous: true })).status).toBe(401);
    expect((await call('GET', `${A}.csv`, { anonymous: true })).status).toBe(401);
    const k = await call('GET', A, { key: keySecret });
    expect(k.status).toBe(403); expect(k.json.error).toBe('key_path_forbidden');
  });

  it('CSV: one header, one row per item of the filtered list, a paper order says mode=paper', async () => {
    const r = await call('GET', `${A}.csv?kind=order`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/csv');
    const lines = r.text.trim().split('\n');
    // NEXT appended six columns at the END of the row: the eighteen earlier ones keep their positions (wallet-next-api.test.ts checks the new ones)
    expect(lines[0]).toBe('time_utc,kind,mode,venue,network,principal,code,instrument_or_asset,side,amount,amount_symbol,received,received_symbol,status,reference_type,reference_id,txid,explorer' + ',lifecycle,fee_paid,fee_symbol,deposit_kind,deposit_origin,contact_label');
    expect(lines.length - 1).toBe((await call('GET', `${A}?limit=200&kind=order`)).json.items.length);
    expect(lines.slice(1).every((l) => l.split(',')[1] === '"order"' && l.split(',')[2] === '"paper"')).toBe(true);
    expect(lines.some((l) => l.includes('"FILLED"') && l.includes(`"${BTC}"`) && l.includes('"buy"'))).toBe(true);
    const whole = (await call('GET', `${A}.csv`)).text.trim().split('\n');
    expect(whole.some((l) => l.split(',')[1] === '"risk"')).toBe(true);
  });
});

describe('pure pieces', () => {
  it('audit events → kinds; wallet repeats are left out; actors → principals', async () => {
    const { kindOfAudit, principalOfActor, walletItem, ACTIVITY_KINDS } = await import('../src/dashboard/activity.ts');
    expect(ACTIVITY_KINDS).toEqual(['transfer', 'receive', 'swap', 'bridge', 'plan', 'order', 'agent', 'mandate', 'risk', 'key', 'security']);
    expect(['agent.start', 'strategy.approved', 'research.submitted'].map(kindOfAudit)).toEqual(['agent', 'agent', 'agent']);
    expect(['mandate.approved', 'deriv.live.mandate_revoked'].map(kindOfAudit)).toEqual(['mandate', 'mandate']);
    expect(['risk.kill_switch', 'halt.on', 'apikey.revoked', 'webhook.created', 'login.ok'].map(kindOfAudit)).toEqual(['risk', 'risk', 'key', 'key', 'security']);
    expect(['transfer.signed', 'swap.prepared', 'bridge.done', 'xswap.prepared', 'deposit.seen'].map(kindOfAudit)).toEqual([null, null, null, null, null]);
    expect(['deriv.paper.order', 'deriv.paper.fill', 'deriv.live.order_submitted'].map(kindOfAudit)).toEqual([null, null, null]);   // the unified order is the item
    expect(['deriv.paper.liquidation', 'deriv.live.authorized'].map(kindOfAudit)).toEqual(['security', 'security']);
    expect(principalOfActor('owner')).toEqual({ kind: 'owner', id: 'owner' });
    expect(principalOfActor('key:abc')).toEqual({ kind: 'api_key', id: 'abc' });
    expect(principalOfActor('agent:7')).toEqual({ kind: 'agent', id: '7' });
    expect(principalOfActor('worker')).toEqual({ kind: 'system', id: 'worker' });
    // a wallet row keeps its original under `wallet`; a GMX order transaction is an order on venue gmx, a swap says what it gave
    const gmx = walletItem({ id: 'p1', kind: 'gmx', at: '2026-11-15T10:00:00Z', network: 'arbitrum', symbol: 'USDC', amountDisplay: '10', state: 'finalized', txid: '0xabc', explorer: 'https://x/0xabc' });
    expect(gmx).toMatchObject({ kind: 'order', venue: 'gmx', mode: 'live', code: 'wallet.gmx', ref: { type: 'proposal', id: 'p1' }, txid: '0xabc' });
    const swap = walletItem({ id: 'p2', kind: 'swap', at: '2026-11-15T10:00:00Z', network: 'base', symbol: 'USDC', amountDisplay: '5', state: 'finalized', swap: { toSymbol: 'ETH', receivedDisplay: '0.002', minOutDisplay: '0.0019' } });
    expect(swap).toMatchObject({ kind: 'swap', received: { value: '0.002', symbol: 'ETH' }, amount: { value: '5', symbol: 'USDC' } });
    expect(walletItem({ id: 'd1', kind: 'receive', at: '2026-11-15T10:00:00Z', network: 'base', symbol: 'ETH', amountDisplay: '1', state: 'finalized' }).ref).toEqual({ type: 'deposit', id: 'd1' });
  });
});
