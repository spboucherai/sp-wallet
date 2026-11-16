// V11 exec2 on PAPER, through the real server (own database, fixture venues, a real signer process, a software passkey):
//   - position provenance: a key reduces only what its own fills opened — never the owner's part, never another principal's;
//   - the checks of a creation are a superset of the checks its preview showed;
//   - the engines' gate reuses a decision only for the very same engine request;
//   - ONE guard for every command kind: each kind against each scope;
//   - risk deny tests that were missing: instrument_status, drawdown; mandate stop conditions loss_gte and drawdown_gte.
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

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer';
const owner = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'];
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, ipSeq = 0, derivs: any, paperStep: any;
/** the market moves AND the paper worker marks the accounts to it (what the derivatives worker does every few seconds) */
const mark = async (mid: number): Promise<void> => { clock.advance(5_000); setMarket(v, mid); const s = await paperStep(derivs.paper); if (s.errors.length) throw new Error(`paper step: ${s.errors.join('; ')}`); };

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`; else { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.203.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const idem = () => ({ 'idempotency-key': `x2-${randomUUID()}` });
const assertion = (options: { challenge: string }) => owner.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(body: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'x2 key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600, ...body } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}
const MANDATE = { mode: 'paper', instruments: [BTC], orderTypes: ['market', 'limit'], maxCapitalUsd: '5000', maxOrderNotionalUsd: '2000', maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '500', floorEquityUsd: '1000', days: 7,
  frequency: { perMinute: 30, perHour: 200, perDay: 400 }, maxSlippageBps: 100, maxFeeUsd: '10', label: 'x2 mandate' };
async function tradingKey(account: string, over: Record<string, unknown> = {}, keyBody: Record<string, unknown> = {}) {
  const k = await newKey(keyBody);
  const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [account], ...over } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  expect((await call('POST', `/api/v1/mandates/${m.json.mandate.id}/approve`, { body: {} })).status).toBe(200);
  const p = await call('POST', `${DEV}/keys/${k.id}/update/prepare`, { body: { changes: { mandateId: m.json.mandate.id } } });
  expect((await call('POST', `${DEV}/keys/${k.id}/update`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } })).status).toBe(200);
  return { ...k, mandateId: m.json.mandate.id as string };
}
const paperAccount = async (label: string): Promise<string> => { const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label, collateral: '10000' } }); expect(a.status, JSON.stringify(a.json)).toBe(200); return a.json.id as string; };
const order = (accountId: string, body: Record<string, unknown> = {}) => ({ mode: 'paper', accountId, instrument: BTC, side: 'buy', type: 'market', size: '0.02', ...body });
const place = (accountId: string, key: string | null, body: Record<string, unknown> = {}) => call('POST', `${T}/orders`, { key, headers: idem(), body: order(accountId, body) });
const posId = (accountId: string) => encodeURIComponent(`paper:hyperliquid:${accountId}:${BTC}`);
const positionOf = async (accountId: string): Promise<string> => { const a = (await app.execution.orders.deps.derivatives().paper.list()).find((x: any) => x.id === accountId); const p = a.positions.find((x: any) => x.instrument === BTC); return p ? `${p.side} ${p.size}` : 'flat'; };
const setLimits = async (limits: object) => { await sql`insert into settings (key, value) values ('risk.limits.paper', ${sql.json(limits)}) on conflict (key) do update set value = excluded.value`; };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-exec2-paper-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('execution_exec2_paper');
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
  derivs = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  paperStep = (await import('../src/derivatives/worker.ts')).paperStep;
  app = await (await import('../src/server.ts')).buildServer({ derivatives: derivs, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('position provenance: whose position is it?', () => {
  it('the ledger (pure): a fill adds to the lot of who placed it; a reduction consumes the reducer\'s own lot first; an unknown fill is the owner\'s; the lots never exceed the venue\'s position', async () => {
    const { replay, attributable, OWNER_KEY } = await import('../src/orders/provenance.ts');
    const { D } = await import('@spw/derivatives');
    const show = (m: Map<string, any>) => Object.fromEntries([...m].map(([k, x]) => [k, D.str(x)]));
    const K = 'api_key:k1', A = 'agent:a1';
    expect(show(replay([{ side: 'buy', size: '0.03', principal: OWNER_KEY }, { side: 'buy', size: '0.02', principal: K }]))).toEqual({ [OWNER_KEY]: '0.03', [K]: '0.02' });
    // the key sells 0.02: its own lot goes, the owner's is untouched
    expect(show(replay([{ side: 'buy', size: '0.03', principal: OWNER_KEY }, { side: 'buy', size: '0.02', principal: K }, { side: 'sell', size: '0.02', principal: K }]))).toEqual({ [OWNER_KEY]: '0.03' });
    // the owner closes 0.04 by hand: his own 0.03 first, then 0.01 of the key's
    expect(show(replay([{ side: 'buy', size: '0.03', principal: OWNER_KEY }, { side: 'buy', size: '0.02', principal: K }, { side: 'sell', size: '0.04', principal: OWNER_KEY }]))).toEqual({ [K]: '0.01' });
    // a fill of no known order (the venue's own interface, a liquidation) is the owner's
    expect(show(replay([{ side: 'buy', size: '0.02', principal: K }, { side: 'buy', size: '0.01', principal: null }, { side: 'sell', size: '0.01', principal: null }]))).toEqual({ [K]: '0.02' });
    // a flip: the remainder opens a lot, on the other side, for who placed the fill
    expect(show(replay([{ side: 'buy', size: '0.02', principal: K }, { side: 'sell', size: '0.05', principal: A }]))).toEqual({ [A]: '-0.03' });
    // shorts
    expect(show(replay([{ side: 'sell', size: '0.02', principal: K }, { side: 'sell', size: '0.01', principal: OWNER_KEY }, { side: 'buy', size: '0.02', principal: K }]))).toEqual({ [OWNER_KEY]: '-0.01' });
    const lots = replay([{ side: 'buy', size: '0.03', principal: OWNER_KEY }, { side: 'buy', size: '0.02', principal: K }]);
    expect([attributable(lots, K, '0.05'), attributable(lots, OWNER_KEY, '0.05'), attributable(lots, A, '0.05')]).toEqual(['0.02', '0.03', '0']);
    expect(attributable(lots, K, '-0.05')).toBe('0');                                                    // the venue is short: nothing of a long lot is there
    expect(attributable(lots, K, '0')).toBe('0');
    // the venue holds LESS than the ledger explains (a reduction the wallet did not see): the shortfall is taken from the key first
    expect([attributable(lots, K, '0.04'), attributable(lots, OWNER_KEY, '0.04')]).toEqual(['0.01', '0.03']);
    expect([attributable(lots, K, '0.02'), attributable(lots, OWNER_KEY, '0.02')]).toEqual(['0', '0.02']);
  });

  it('a key cannot close, reduce or sell into what the owner opened by hand, nor what another key opened; it closes ITS part; the owner closes anything', async () => {
    await mark(50_000);
    const a = await paperAccount('Provenance');
    expect((await place(a, null, { size: '0.03' })).json.order.status).toBe('FILLED');                  // the owner, by hand
    const k = await tradingKey(a), n0 = (await sql`select count(*)::int as n from orders`)[0].n;
    const close = await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([close.status, close.json.error], JSON.stringify(close.json)).toEqual([403, 'position_not_attributable']);
    expect(close.json.data.provenance).toMatchObject({ position: '0.03', own: '0', foreign: '0.03', reducible: '0' });
    const ro = await place(a, k.secret, { side: 'sell', size: '0.01', reduceOnly: true });
    expect([ro.status, ro.json.error]).toEqual([403, 'position_not_attributable']);
    const plain = await place(a, k.secret, { side: 'sell', size: '0.01' });                               // not flagged reduce-only: it would still eat into the owner's position
    expect([plain.status, plain.json.error]).toEqual([403, 'position_not_attributable']);
    const pv = await call('POST', `${T}/orders/preview`, { key: k.secret, body: order(a, { side: 'sell', size: '0.01', reduceOnly: true }) });
    expect(pv.json.refusals.find((r: any) => r.stage === 'provenance')).toMatchObject({ code: 'position_not_attributable' });
    expect(pv.json.wouldExecute).toBe(false);
    expect((await sql`select count(*)::int as n from orders`)[0].n).toBe(n0);                            // nothing was created
    expect(await positionOf(a)).toBe('long 0.03');

    // the key opens 0.02 of its own, then closes: exactly its 0.02 — the owner's 0.03 stays
    expect((await place(a, k.secret)).json.order.status).toBe('FILLED');
    expect(await positionOf(a)).toBe('long 0.05');
    const tooMuch = await place(a, k.secret, { side: 'sell', size: '0.03', reduceOnly: true });
    expect([tooMuch.json.error, tooMuch.json.data.provenance.own]).toEqual(['position_not_attributable', '0.02']);
    const half = await call('POST', `${T}/positions/${posId(a)}/reduce`, { key: k.secret, headers: idem(), body: { fraction: '0.5' } });
    expect([half.status, half.json.order?.status, half.json.order?.size], JSON.stringify(half.json)).toEqual([200, 'FILLED', '0.01']);
    const mine = await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([mine.status, mine.json.order?.status, mine.json.order?.size], JSON.stringify(mine.json)).toEqual([200, 'FILLED', '0.01']);
    expect(await positionOf(a)).toBe('long 0.03');
    expect((await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} })).json.error).toBe('position_not_attributable');

    // a second key on the same paper account: each one's lot is its own
    const k2 = await tradingKey(a);
    expect((await place(a, k2.secret, { size: '0.01' })).json.order.status).toBe('FILLED');
    expect((await place(a, k.secret, { side: 'sell', size: '0.01', reduceOnly: true })).json.error).toBe('position_not_attributable');
    // what a key already asked to reduce and that still rests counts against its lot: two resting exits cannot both be sized to it
    const rest = await place(a, k2.secret, { side: 'sell', type: 'limit', price: '50900', size: '0.01', reduceOnly: true });
    expect(rest.json.order?.status, JSON.stringify(rest.json)).toBe('SUBMITTED');
    const again = await place(a, k2.secret, { side: 'sell', type: 'limit', price: '50950', size: '0.01', reduceOnly: true });
    expect([again.json.error, again.json.data.provenance.pending, again.json.data.provenance.reducible]).toEqual(['position_not_attributable', '0.01', '0']);
    expect((await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k2.secret, headers: idem() })).json.order.status).toBe('CANCELLED');
    const c2 = await call('POST', `${T}/positions/${posId(a)}/close`, { key: k2.secret, headers: idem(), body: {} });
    expect([c2.json.order?.status, c2.json.order?.size], JSON.stringify(c2.json)).toEqual(['FILLED', '0.01']);
    expect(await positionOf(a)).toBe('long 0.03');

    // the owner is not bound: the account is his — through the trading API and through the route that existed before
    const own = await call('POST', `${T}/positions/${posId(a)}/reduce`, { headers: idem(), body: { fraction: '0.5' } });
    expect([own.json.order?.status, own.json.order?.size], JSON.stringify(own.json)).toEqual(['FILLED', '0.015']);
    expect((await call('POST', `/api/v1/derivatives/accounts/${a}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() })).status).toBe(200);
    expect(await positionOf(a)).toBe('flat');
  });

  it('a position the key opened and the OWNER then closed by hand is gone for the key too: a later position of the owner is not the key\'s', async () => {
    await mark(50_000);
    const a = await paperAccount('Provenance 2'), k = await tradingKey(a);
    expect((await place(a, k.secret)).json.order.status).toBe('FILLED');                                 // the key's 0.02
    expect((await call('POST', `/api/v1/derivatives/accounts/${a}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() })).status).toBe(200);   // the owner closes it in the Futures screen
    expect((await place(a, null, { size: '0.02' })).json.order.status).toBe('FILLED');                  // and later opens his own 0.02
    const c = await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([c.status, c.json.error, c.json.data.provenance.own]).toEqual([403, 'position_not_attributable', '0']);
    expect(await positionOf(a)).toBe('long 0.02');
  });
});

describe('preview and creation', () => {
  it('whatever a preview refuses, the creation refuses with one of the same codes; the creation runs every check the preview listed (and may run more)', async () => {
    await mark(50_000);
    const a = await paperAccount('Compare'), k = await tradingKey(a, {}, { limits: { maxOrderNotionalUsd: 1500, maxDailyNotionalUsd: null } });
    const stages = new Set<string>();
    const compare = async (label: string, body: Record<string, unknown>, expectCode: string | null) => {
      const pv = await call('POST', `${T}/orders/preview`, { key: k.secret, body: order(a, body) });
      expect(pv.status, `${label}: ${JSON.stringify(pv.json)}`).toBe(200);
      const codes: string[] = pv.json.refusals.map((r: any) => r.code);
      for (const r of pv.json.refusals) stages.add(r.stage);
      const last = (await sql`select coalesce(max(id), 0)::int as id from risk_decisions`)[0].id;
      const cr = await place(a, k.secret, body);
      if (expectCode === null) { expect(codes, label).toEqual([]); expect(pv.json.wouldExecute).toBe(true); expect(cr.status, `${label}: ${JSON.stringify(cr.json)}`).toBe(200); }
      else { expect(codes, label).toContain(expectCode); expect(pv.json.wouldExecute).toBe(false); expect(cr.status, label).toBeGreaterThanOrEqual(400); expect(codes, `${label}: the creation answered ${cr.json.error}`).toContain(cr.json.error); }
      // the risk checks: every check the preview listed was run at the creation too
      const rows = await sql`select checks from risk_decisions where id > ${last} and kind = 'order' order by id`;
      expect(rows.length, label).toBeGreaterThan(0);
      const created = new Set<string>(rows.flatMap((r: any) => r.checks.map((c: any) => c.id)));
      for (const id of pv.json.risk.checks.map((c: any) => c.id)) expect(created.has(id), `${label}: check ${id} shown in the preview and not run at the creation`).toBe(true);
    };
    await compare('allowed', {}, null);
    await compare('key limit', { size: '0.035' }, 'key_limit_exceeded');
    await compare('mandate: order type', { type: 'stop_market', triggerPrice: '50400', size: '0.01' }, 'mandate_denied');
    await compare('mandate: order type is fine, notional is not', { size: '0.029', type: 'limit', price: '70000' }, 'key_limit_exceeded');
    await compare('provenance', { side: 'sell', size: '0.03', reduceOnly: true }, 'position_not_attributable');
    await setLimits({ maxOrderNotional: '100' });
    await compare('risk engine', { size: '0.01' }, 'risk_denied');
    await setLimits({});
    await compare('risk engine: reduce-only without a position on that side', { side: 'buy', size: '0.01', reduceOnly: true }, 'risk_denied');
    expect([...stages]).toEqual(expect.arrayContaining(['key', 'mandate', 'provenance', 'risk']));
  });

  it('the engines\' gate reuses the decision of the order service only for the very same engine request: a client id presented again with another order is judged on its own', async () => {
    await mark(50_000);
    const a = await paperAccount('Gate'), risk = app.execution.risk, s0 = { ...risk.gateStats };
    const o = await place(a, null, { type: 'limit', price: '49000', size: '0.01', tif: 'gtc' });
    expect(o.json.order?.status, JSON.stringify(o.json)).toBe('SUBMITTED');
    const id = o.json.order.id as string;
    expect([risk.gateStats.reused - s0.reused, risk.gateStats.evaluated - s0.evaluated]).toEqual([1, 0]);   // the paper engine's gate found the decision the service had just made
    expect((await sql`select count(*)::int as n from risk_decisions where client_order_id = ${id} and not preview`)[0].n).toBe(1);
    const [acc] = await sql`select network from deriv_paper_accounts where id = ${a}`;
    const m = await risk.market('paper', 'hyperliquid', acc.network, BTC);
    const paper = (await app.execution.orders.deps.derivatives().paper.list()).find((x: any) => x.id === a);
    const leverage = paper.settings.leverageByInstrument[BTC] ?? String(Math.min(Number(paper.settings.leverage), Number(m.instrument.maxLeverage)));
    const req = { instrument: BTC, side: 'buy', type: 'limit', size: '0.01', price: '49000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: id };
    const gate = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}, lev: string = leverage) => risk.gate({ mode: 'paper', venue: 'hyperliquid', network: acc.network, accountId: a, req: { ...req, ...over }, instrument: m.instrument, origin: 'owner',
      known: { ticker: m.ticker, book: m.book, account: null, positions: null, leverage: lev }, ...top });
    let s = { ...risk.gateStats };
    expect(await gate()).toEqual({ ok: true });
    expect([risk.gateStats.reused - s.reused, risk.gateStats.evaluated - s.evaluated]).toEqual([1, 0]);   // the same request: reused
    // a limit under which the SAME client id with a larger or dearer order must be refused: if the old decision were reused, these would pass
    await setLimits({ maxOrderNotional: '600' });
    const other = await paperAccount('Gate other');
    const variants: [string, Promise<unknown>, boolean][] = [];
    const run = async (label: string, p: () => Promise<{ ok: boolean; code?: string }>, denied: boolean) => {
      s = { ...risk.gateStats };
      const r = await p();
      expect([risk.gateStats.reused - s.reused, risk.gateStats.evaluated - s.evaluated], label).toEqual([0, 1]);
      if (denied) expect(r, label).toMatchObject({ ok: false, code: 'risk_denied' }); else expect(typeof r.ok, label).toBe('boolean');
      variants.push([label, Promise.resolve(r), denied]);
    };
    await run('a larger size', () => gate({ size: '0.02' }), true);                                       // 980 > 600
    await run('a dearer price', () => gate({ price: '61000' }), true);                                    // 610 > 600
    await run('another type', () => gate({ type: 'market', price: '50100', tif: 'ioc' }), false);
    await run('a trigger', () => gate({ type: 'stop_limit', triggerPrice: '50500', price: '50600' }), false);
    await run('another time in force', () => gate({ tif: 'alo' }), false);
    await run('reduce-only', () => gate({ reduceOnly: true }), false);
    await run('the other side', () => gate({ side: 'sell' }), false);
    await run('another leverage setting', () => gate({}, {}, String(Number(leverage) + 1)), false);
    await run('another account', () => gate({}, { accountId: other }), false);
    expect(variants).toHaveLength(9);
    await setLimits({});
    // a preview is never the decision of an order
    const pv = await call('POST', `${T}/orders/preview`, { body: order(a, { type: 'limit', price: '49000', size: '0.01', clientOrderId: `pv-${randomUUID()}` }) });
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    s = { ...risk.gateStats };
    expect((await gate({ clientId: pv.json.order.clientOrderId })).ok).toBe(true);
    expect([risk.gateStats.reused - s.reused, risk.gateStats.evaluated - s.evaluated]).toEqual([0, 1]);
    // …and a decision older than the reuse window is not reused either
    await sql`update risk_decisions set at = at - interval '61 seconds' where client_order_id = ${id}`;
    s = { ...risk.gateStats };
    await gate();
    expect([risk.gateStats.reused - s.reused, risk.gateStats.evaluated - s.evaluated]).toEqual([0, 1]);
    await call('DELETE', `${T}/orders/${id}`, { headers: idem() });
  });
});

describe('commands: ONE guard', () => {
  it('every command kind against every scope: only the scope of the operation the command resolves to opens it — nothing of the wallet is touched before', async () => {
    const { runCommand, commandOperation, COMMAND_KINDS, CommandGrant } = await import('../src/trading-api/commands.ts');
    const { parseCommand } = await import('@spw/trading');
    const { SCOPES } = await import('../src/trading-api/spec.ts');
    const lines: Record<string, string[]> = { spot_buy: ['BUY ETH 100 USDC'], spot_sell: ['SELL ETH 50%'], perp_open: ['LONG BTC-PERP 100 x2'], perp_close: ['CLOSE BTC-PERP'], cancel_order: ['CANCEL ORDER abcdef123456'], cancel_all: ['CANCEL ALL'],
      show: ['SHOW POSITIONS', 'SHOW BALANCES', 'SHOW ORDERS', 'SHOW RISK'], stop_all_agents: ['STOP ALL AGENTS'], kill: ['KILL'] };
    expect(Object.keys(lines).sort()).toEqual([...COMMAND_KINDS].sort());                                // every kind the executor table knows has a line here
    let touched = 0;
    const tripwire = (name: string): any => new Proxy(function () {}, { get: (_t, prop) => { if (prop === 'then') return undefined; touched += 1; throw new Error(`REACHED ${name}.${String(prop)}`); }, apply: () => { touched += 1; throw new Error(`REACHED ${name}()`); } });
    const key = (scopes: string[], mandateId: string | null) => ({ kind: 'api_key' as const, id: 'spk_matrix', name: 'm', scopes: scopes as never, limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: null }, restrictions: { networks: [], venues: [], instruments: [], ipAllow: [] }, mandateId, rateLimitPerMin: 60 });
    const caller = (mandateId: string | null) => ({ principal: { kind: 'api_key' as const, id: 'spk_matrix' }, mandateId });
    let cases = 0;
    for (const [kind, texts] of Object.entries(lines)) for (const text of texts) for (const dryRun of [true, false]) {
      const parsed = parseCommand(text);
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.command.type).toBe(kind);
      const op = commandOperation(parsed.command, dryRun);
      expect(SCOPES).toContain(op.scope);
      for (const scope of SCOPES) {
        cases += 1; touched = 0;
        const err = await runCommand(tripwire('ex'), tripwire('reads'), key([scope], 'm-1'), caller('m-1'), { text, mode: 'paper', dryRun }, `matrix-${cases}`).then(() => null, (e: any) => e);
        if (scope !== op.scope) { expect([err?.code, touched], `${text} (dryRun ${dryRun}) with only ${scope}; needs ${op.scope}`).toEqual(['insufficient_scope', 0]); continue; }
        expect(err?.code, `${text} (dryRun ${dryRun}) with ${scope}`).not.toBe('insufficient_scope');    // the guard let it through: whatever follows is the executor's own answer
        // the same key without a mandate: an operation that needs one stops at the guard, before anything is touched
        touched = 0;
        const bare = await runCommand(tripwire('ex'), tripwire('reads'), key([scope], null), caller(null), { text, mode: 'paper', dryRun }, `matrix-${cases}-bare`).then(() => null, (e: any) => e);
        if (op.needsMandate) expect([bare?.code, touched], `${text}: no mandate`).toEqual(['mandate_required', 0]); else expect(bare?.code, `${text}: no mandate needed`).not.toBe('mandate_required');
      }
      // every scope EXCEPT the right one, all together: still refused
      touched = 0;
      const others = await runCommand(tripwire('ex'), tripwire('reads'), key(SCOPES.filter((x) => x !== op.scope), 'm-1'), caller('m-1'), { text, mode: 'paper', dryRun }, `matrix-all-${cases}`).then(() => null, (e: any) => e);
      expect([others?.code, touched], `${text}: every scope but ${op.scope}`).toEqual(['insufficient_scope', 0]);
    }
    expect(cases).toBe(12 * 2 * SCOPES.length);
    // an executor cannot be handed a grant made elsewhere: the class has no public constructor
    expect(() => new (CommandGrant as any)({ type: 'kill' }, { scope: 'positions:manage', needsMandate: false }, false)).not.toThrow();   // (JavaScript does not enforce `private`; the type checker does — see the comment in commands.ts)
    expect(typeof CommandGrant.authorize).toBe('function');
  });
});

describe('risk checks that had no deny test', () => {
  it('instrument_status: an instrument the venue has halted takes no new risk; a strictly reducing order is exempt', async () => {
    await mark(50_000);
    const a = await paperAccount('Status'), risk = app.execution.risk;
    expect((await place(a, null, { size: '0.01' })).json.order.status).toBe('FILLED');
    const [acc] = await sql`select network from deriv_paper_accounts where id = ${a}`;
    const m = await risk.market('paper', 'hyperliquid', acc.network, BTC), now = clock.now();
    const base = { v: 1, venue: 'hyperliquid', network: acc.network, instrument: BTC, marketKind: 'perp', side: 'buy', type: 'limit', size: '0.01', notional: null, limitPrice: '50000', triggerPrice: null, reduceOnly: false, tif: 'gtc', maxSlippageBps: 50, maxFeeUsd: '1',
      leverage: null, marginMode: null, clientOrderId: `status-${randomUUID()}`, mode: 'paper', principal: { kind: 'owner', id: 'owner' }, mandateId: null, createdAt: now, expiresAt: now + 60_000 };
    const known = { ticker: m.ticker, book: m.book, account: null, positions: null, leverage: null };
    const active = await risk.evaluateOrder(base, { accountId: a, preview: true, known, instrument: m.instrument });
    expect(active.decision, JSON.stringify(active.failed)).toBe('allow');
    for (const status of ['halted', 'reduce_only'].filter((s) => s !== m.instrument.status)) {
      const ev = await risk.evaluateOrder({ ...base, clientOrderId: `status-${randomUUID()}` }, { accountId: a, preview: true, known, instrument: { ...m.instrument, status } }).catch((e: Error) => ({ decision: 'error', failed: [e.message] } as any));
      if (ev.decision === 'error') continue;                                                             // a status the instrument schema does not know: not a case
      expect([ev.decision, ev.failed], status).toEqual(['deny', ['instrument_status']]);
      const out = await risk.evaluateOrder({ ...base, side: 'sell', reduceOnly: true, clientOrderId: `status-${randomUUID()}` }, { accountId: a, preview: true, known, instrument: { ...m.instrument, status } });
      expect([out.decision, out.reducing, out.checks.find((c: any) => c.id === 'instrument_status')?.exempt], status).toEqual(['allow', true, true]);
    }
    expect((await sql`select count(*)::int as n from risk_decisions where 'instrument_status' = any(failed)`)[0].n).toBeGreaterThan(0);
  });

  it('drawdown: after a real loss the equity is below its peak by more than the limit — new risk is denied through the HTTP API, the exit is not', async () => {
    await mark(50_000);
    const a = await paperAccount('Drawdown');
    expect((await place(a, null, { size: '0.1' })).json.order.status).toBe('FILLED');
    await mark(52_000);
    expect((await call('POST', `${T}/orders/preview`, { body: order(a, { size: '0.01' }) })).json.risk.decision).toBe('allow');       // the peak of the paper book is recorded here
    const peak = (await sql`select value from settings where key = 'risk.peak.paper'`)[0].value.equity;
    await mark(48_000);                                                                                 // 0.1 BTC × 4 000 = 400 USD below the peak
    const x = await app.execution.risk.exposure('paper');
    expect(Number(peak) - Number(x.equity)).toBeGreaterThan(350);
    const bps = Math.floor(((Number(peak) - Number(x.equity)) / Number(peak)) * 10_000);
    await setLimits({ maxDrawdownBps: String(bps - 1) });
    const denied = await place(a, null, { size: '0.01' });
    expect([denied.status, denied.json.error, denied.json.data.failed], JSON.stringify(denied.json)).toEqual([422, 'risk_denied', ['drawdown']]);
    expect(denied.json.data.checks[0]).toMatchObject({ id: 'drawdown', ok: false, limit: String(bps - 1) });
    const exit = await call('POST', `${T}/positions/${posId(a)}/close`, { headers: idem(), body: {} });
    expect(exit.json.order?.status, JSON.stringify(exit.json)).toBe('FILLED');
    await setLimits({ maxDrawdownBps: String(bps + 50) });
    expect((await place(a, null, { size: '0.01' })).json.order?.status).toBe('FILLED');                  // inside the limit again
    await setLimits({});
    await call('POST', `${T}/positions/${posId(a)}/close`, { headers: idem(), body: {} });
  });
});

describe('mandate stop conditions that had no test', () => {
  it('loss_gte: the mandated account lost the amount → the supervisor revokes the mandate (stop_condition), cancels what rests; only the exit passes', async () => {
    await mark(50_000);
    const a = await paperAccount('Stop loss'), k = await tradingKey(a, { stopConditions: [{ kind: 'loss_gte', usd: '50' }] });
    expect((await place(a, k.secret)).json.order.status).toBe('FILLED');                                  // long 0.02
    const rest = await place(a, k.secret, { side: 'sell', type: 'limit', price: '50900', size: '0.01' });   // rests above the market; not reduce-only: it could still add risk once the position is gone
    expect(rest.json.order?.status, JSON.stringify(rest.json)).toBe('SUBMITTED');
    expect((await app.execution.mandates.supervise()).stopped).not.toContain(k.mandateId);               // a few dollars of fees: not 50
    await mark(47_000);                                                                                 // 0.02 × 3 000 = 60 USD lost
    expect((await app.execution.mandates.supervise()).stopped).toContain(k.mandateId);
    const m = (await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate;
    expect(m).toMatchObject({ state: 'revoked', phase: 'wind_down', stop: { code: 'STOP_LOSS_GTE' } });
    expect(m.revocation.record).toMatchObject({ reason: 'stop_condition', revokedBy: { kind: 'system' } });
    expect((await sql`select state from orders where id = ${rest.json.order.id}`)[0].state).toBe('CANCELLED');
    const more = await place(a, k.secret, { size: '0.001' });
    expect([more.status, more.json.error]).toEqual([403, 'mandate_denied']);
    expect(more.json.data.reasons).toEqual(expect.arrayContaining(['MANDATE_REVOKED']));
    expect((await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} })).json.order?.status).toBe('FILLED');
    expect((await app.execution.mandates.supervise()).stopped).toEqual([]);                               // once
  });

  it('drawdown_gte: measured from the highest equity seen since the approval, not from the start', async () => {
    await mark(50_000);
    const a = await paperAccount('Stop drawdown'), k = await tradingKey(a, { stopConditions: [{ kind: 'drawdown_gte', bps: 60 }] });
    expect((await place(a, k.secret)).json.order.status).toBe('FILLED');                                  // long 0.02
    await mark(56_000);                                                                                 // +120: a new peak near 10 120
    expect((await app.execution.mandates.supervise()).stopped).toEqual([]);
    const peak = Number((await sql`select peak_equity from trading_mandate_usage where mandate_id = ${k.mandateId}`)[0].peak_equity);
    expect(peak).toBeGreaterThan(10_100);
    await mark(53_500);                                                                                 // −50 from the peak ≈ 49 bps: still above the START, and inside 60 bps
    expect((await app.execution.mandates.supervise()).stopped).toEqual([]);
    await mark(52_500);                                                                                 // −70 from the peak ≈ 69 bps, although the account is still UP since the approval
    expect((await app.execution.mandates.supervise()).stopped).toEqual([k.mandateId]);
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate).toMatchObject({ state: 'revoked', stop: { code: 'STOP_DRAWDOWN_GTE' } });
    expect((await call('POST', `${T}/positions/${posId(a)}/close`, { key: k.secret, headers: idem(), body: {} })).json.order?.status).toBe('FILLED');
  });

  it('a paper mandate whose stored row was altered is unusable (the stored object no longer hashes to its recorded hash)', async () => {
    await mark(50_000);
    const a = await paperAccount('Tamper'), k = await tradingKey(a);
    expect((await place(a, k.secret, { size: '0.001' })).json.order.status).toBe('FILLED');
    await sql`update trading_mandates set mandate = jsonb_set(mandate, '{maxOrderNotionalUsd}', '"900000"') where id = ${k.mandateId}`;
    const r = await place(a, k.secret, { size: '0.001' });
    expect([r.status, r.json.error]).toEqual([403, 'mandate_integrity']);
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate.integrity).toMatchObject({ ok: false });
    expect((await app.execution.mandates.supervise()).stopped).toContain(k.mandateId);                   // and the supervisor ends it
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate.state).toBe('revoked');
  });
});
