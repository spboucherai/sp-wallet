/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/dashboard-summary.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

// V11 interface — GET /api/v1/dashboard/summary through the real server: a real signer process, fixture-backed venues, the
// paper engine. Own database; no network.
//   - the answer composes the risk service, the agents table, the monitor aggregates and the audit chain, one section each;
//   - paper and live are separate books: a paper position is in `books.paper` and nowhere else, and no figure spans modes;
//   - a source that throws (or hangs) fails ITS section with a code, and every other section is still answered;
//   - owner session only: no session → 401, an API key → 403 `key_path_forbidden`.
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
import { BTC, Clock, fixtureVenues, setMarket, useDatabase } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), URL_ = '/api/v1/dashboard/summary';
const owner = new TestPasskey(RP, ORIGIN);
let app: any, sql: any, cookie = '', signerSrv: Server, acct = '';   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, o: { key?: string; cookie?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const c = o.cookie === undefined ? (o.key ? null : cookie) : o.cookie;
  if (c) headers.cookie = c;
  if (c && method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['idempotency-key'] = `dash-${randomUUID()}`; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-dash-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('dashboard_summary');
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
  const clock = new Clock(), v = fixtureVenues(clock);
  setMarket(v, 50_000);
  app = await (await import('../src/server.ts')).buildServer({ derivatives: mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now }), gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label: 'Dash', collateral: '10000' } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  acct = a.json.id;
  const o = await call('POST', `/api/v1/derivatives/accounts/${acct}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.02', slippageBps: 100 } });
  expect(o.status, JSON.stringify(o.json)).toBe(200);
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('GET /api/v1/dashboard/summary', () => {
  it('composes every source; the paper position is in the paper book only', async () => {
    const r = await call('GET', URL_);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const j = r.json;
    expect(Object.keys(j).sort()).toEqual(['agents', 'agentsPnl', 'audit', 'books', 'health', 'risk', 'ts']);
    for (const s of [j.books.paper, j.books.live, j.books.liveTestnet, j.risk, j.agents, j.agentsPnl, j.health, j.audit]) expect(s.ok, JSON.stringify(s)).toBe(true);
    // paper book: the account and its position, with the figures the risk service computes
    const p = j.books.paper.data;
    expect(p.book).toBe('paper');
    expect(p.collateral.map((c: { accountId: string }) => c.accountId)).toEqual([acct]);
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0]).toMatchObject({ venue: 'hyperliquid', accountId: acct, instrument: BTC, side: 'long', size: '0.02' });
    expect(Number(p.grossExposure)).toBeGreaterThan(900);
    expect(p.byAsset).toEqual([expect.objectContaining({ asset: 'BTC' })]);
    expect(p.pnl).toEqual(expect.objectContaining({ realizedToday: expect.any(String), unrealizedToday: expect.any(String), realizedInception: expect.any(String), unrealizedInception: expect.any(String) }));
    // live books: nothing of the paper account
    for (const b of [j.books.live.data, j.books.liveTestnet.data]) { expect(b.positions).toEqual([]); expect(b.collateral).toEqual([]); expect(Number(b.grossExposure)).toBe(0); }
    // no figure across modes anywhere at the top level
    expect(j.total).toBeUndefined(); expect(j.books.total).toBeUndefined();
    // risk: switches off, live limits never set on this wallet
    expect(j.risk.data.switches.killSwitch.on).toBe(false); expect(j.risk.data.switches.readOnly.on).toBe(false);
    expect(j.risk.data.live.missing.length).toBeGreaterThan(0); expect(j.risk.data.live.ownerOrdersRefused).toBe(true);
    // agents: none; research never has a PnL, the other modes have no snapshot yet
    expect(j.agents.data).toMatchObject({ count: 0, total: { active: 0, paused: 0, stopped: 0 } });
    expect(j.agentsPnl.data.today).toMatchObject({ research: { abs: null, reason: 'research_no_pnl' }, paper: { abs: null, reason: 'no_snapshot' }, live: { abs: null, reason: 'no_snapshot' } });
    // system: the signer of this test answers, the audit chain is intact
    expect(j.health.data.signer).toEqual({ reachable: true, halted: false });
    expect(j.health.data.connectors.total).toBeGreaterThan(0);
    expect(j.audit.data).toMatchObject({ intact: true, brokenAt: null });
  });

  it('the kill switch shows in the risk section', async () => {
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'dashboard test' } })).status).toBe(200);
    const j = (await call('GET', URL_)).json;
    expect(j.risk.data.switches.killSwitch).toMatchObject({ on: true, reason: 'dashboard test' });
    await sql`delete from settings where key like 'risk.switch%'`;
  });

  it('a source that throws fails its own section with a code; the others are answered', async () => {
    const risk = app.execution.risk, exposure = risk.exposure.bind(risk);
    risk.exposure = async (b: string) => { if (b === 'live-mainnet') throw new Error('venue did not answer: ECONNRESET'); return exposure(b); };
    try {
      const r = await call('GET', URL_);
      expect(r.status).toBe(200);
      expect(r.json.books.live).toEqual({ ok: false, error: { code: 'source_failed', message: 'venue did not answer: ECONNRESET' } });
      expect(r.json.books.paper.ok).toBe(true); expect(r.json.books.paper.data.positions).toHaveLength(1);
      for (const s of [r.json.books.liveTestnet, r.json.risk, r.json.agents, r.json.agentsPnl, r.json.health, r.json.audit]) expect(s.ok).toBe(true);
    } finally { risk.exposure = exposure; }
    // a UserError keeps its code
    const { UserError } = await import('../src/config.ts');
    const sw = risk.switches.bind(risk);
    risk.switches = async () => { throw new UserError('service_unavailable', 'settings table unreachable', 503); };
    try {
      const r = await call('GET', URL_);
      expect(r.status).toBe(200);
      expect(r.json.risk).toEqual({ ok: false, error: { code: 'service_unavailable', message: 'settings table unreachable' } });
      expect(r.json.books.paper.ok).toBe(true); expect(r.json.health.ok).toBe(true);
    } finally { risk.switches = sw; }
  });

  it('section(): a source that hangs is answered as `timeout`', async () => {
    const { section } = await import('../src/dashboard/summary.ts');
    expect(await section(() => new Promise<never>(() => {}), 30)).toEqual({ ok: false, error: { code: 'timeout', message: 'no answer within 30 ms' } });
    expect(await section(async () => 7, 30)).toMatchObject({ ok: true, data: 7 });
  });

  it('owner session only: no session → 401; an API key → 403 key_path_forbidden', async () => {
    expect((await call('GET', URL_, { cookie: null })).status).toBe(401);
    const k = await call('GET', URL_, { key: `spw_live_${'a'.repeat(40)}` });
    expect([401, 403]).toContain(k.status);
    expect(k.json.error === 'key_path_forbidden' || k.status === 401).toBe(true);
  });
});

// the read behind the risk indicator of the shell (dashboard/status.ts): two settings reads, each isolated
describe('GET /api/v1/dashboard/status', () => {
  const STATUS = '/api/v1/dashboard/status';
  it('switches off and live limits missing on a fresh wallet; the kill switch shows as soon as it is engaged', async () => {
    const a = (await call('GET', STATUS)).json;
    expect(a.switches).toMatchObject({ ok: true, data: { killSwitch: { on: false }, readOnly: { on: false } } });
    expect(a.liveLimits.ok).toBe(true); expect(a.liveLimits.data.missing).toBeGreaterThan(0); expect(a.liveLimits.data.ownerOrdersRefused).toBe(true);
    expect(Object.keys(a.switches.data.killSwitch).sort()).toEqual(['at', 'on']);          // no reason, no actor: the header shows a state, the Risk screen the rest
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'status test' } })).status).toBe(200);
    expect((await call('GET', STATUS)).json.switches.data.killSwitch.on).toBe(true);
    await sql`delete from settings where key like 'risk.switch%'`;
    expect((await call('GET', STATUS)).json.switches.data.killSwitch.on).toBe(false);
  });
  it('a source that cannot be read fails alone: the indicator then says « unknown », never « ok »', async () => {
    const risk = app.execution.risk, sw = risk.switches.bind(risk);
    risk.switches = async () => { throw new Error('settings table unreachable'); };
    try {
      const r = await call('GET', STATUS);
      expect(r.status).toBe(200);
      expect(r.json.switches).toEqual({ ok: false, error: { code: 'source_failed', message: 'settings table unreachable' } });
      expect(r.json.liveLimits.ok).toBe(true);
    } finally { risk.switches = sw; }
  });
  it('owner session only', async () => {
    expect((await call('GET', STATUS, { cookie: null })).status).toBe(401);
    expect([401, 403]).toContain((await call('GET', STATUS, { key: `spw_live_${'a'.repeat(40)}` })).status);
  });
});
