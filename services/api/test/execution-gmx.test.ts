// V11 execution on GMX, through the real server: the trading API → the order service → the REAL GMX engine (gmx-exec.ts) → the
// REAL isolated signer class (public test mnemonic, a software passkey, a scripted price view) → the scripted chain of
// gmx-world.ts, which "mines" what it is handed. GMX market data is replayed from recorded fixtures. No network, no real key,
// nothing is broadcast anywhere.
//
//   - the owner's order: a unified row AWAITING_APPROVAL linked to the engine's operation, approved with the passkey through the
//     EXISTING GMX route, then the projection follows the engine (created on-chain → executed by the keeper); a replay creates nothing;
//   - what GMX cannot express is refused with a precise code, the same in the preview and at creation;
//   - SPW_DERIV_GMX_LIVE off: refused with the engine's code, visible in the preview;
//   - the gate path of the engine itself (prepareOrder): a risk denial and the kill switch stop an increase before anything is
//     stored; a proposal prepared before the kill switch is refused at its approval;
//   - a decrease (close) and a cancellation pass under the kill switch AND with the lock off;
//   - an API key or an agent is refused: there is no signer-side mandate for GMX.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import { GMX_REQUEST_EXPIRATION_SEC } from '@spw/derivatives/live';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { fixtureVenues, T0, useDatabase } from './derivatives-helpers.ts';
import { liveWorld, ORIGIN, RP, type LiveWorld } from './perp-live-world.ts';

const SECRET = 'k'.repeat(48), T = '/api/v1/trading', G = '/api/v1/derivatives/gmx';
let app: any, sql: any, cookie = '', w: LiveWorld, signerSrv: Server, svc: import('../src/derivatives/gmx-exec.ts').GmxService, chain: import('./gmx-world.ts').FakeChain;
let gw: typeof import('./gmx-world.ts'), INST = '', settings = { liveMainnet: true, gmxLive: true };

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers, cookie };
  if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const idem = () => ({ 'idempotency-key': `gmx-exec-${randomUUID()}` });
const LIMITS = { allowedVenues: ['gmx'], allowedInstruments: [] as string[], maxOrderNotional: '200', maxDailyNotional: '5000', maxPositionNotional: { per: {}, default: '300' }, maxOrderLeverage: '5', maxAccountLeverage: '5', maxGrossExposure: '500',
  maxNetExposure: '500', maxAssetExposure: { per: {}, default: '500' }, maxVenueExposure: { per: {}, default: '500' }, maxVenueCollateralShareBps: '10000', maxDailyLoss: '100', maxTotalLoss: '200', maxDrawdownBps: '9000', minPriceSources: 1, maxOrdersPerMinute: 60 };
const setLimits = async (over: Record<string, unknown> = {}) => { await sql`insert into settings (key, value) values ('risk.limits.live', ${sql.json({ ...LIMITS, allowedInstruments: [INST], ...over })}) on conflict (key) do update set value = excluded.value`; };
const order = (body: Record<string, unknown> = {}) => ({ mode: 'live', instrument: INST, side: 'buy', type: 'market', size: '0.02', leverage: '3', slippageBps: 50, ...body });
const orderRow = async (id: string) => (await sql`select * from orders where id = ${id}`)[0];
const states = async (id: string) => (await sql`select to_state, event from order_events where order_id = ${id} order by seq`).map((e: any) => `${e.to_state}:${e.event}`);
const count = async (table: 'deriv_gmx_ops' | 'proposals' | 'orders') => (table === 'orders' ? (await sql`select count(*)::int as n from orders`)[0].n : table === 'proposals' ? (await sql`select count(*)::int as n from proposals`)[0].n : (await sql`select count(*)::int as n from deriv_gmx_ops`)[0].n) as number;
const approve = (a: { approve: { path: string }; hash: string }) => call('POST', a.approve.path, { body: { assertion: w.pk.assert(Buffer.from(a.hash, 'hex')) } });
/** the approval (when there is one) is mined and the order transaction leaves; then the order transaction is mined */
const mineAll = async () => { const first = chain.mine(); await svc.step(); const made = [...first, ...chain.mine()]; await svc.step(); return made; };
const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error('was not refused'); }, (e: any) => ({ code: e.code as string, status: e.status as number }));
const release = async () => { const p = await call('POST', '/api/v1/risk/kill-switch/release/prepare'); return call('POST', '/api/v1/risk/kill-switch/release', { body: p.json.needed ? { assertion: w.pk.assert(Buffer.from(p.json.options.challenge, 'base64url')) } : {} }); };

beforeAll(async () => {
  await useDatabase('execution_gmx');
  delete process.env.SPW_API_KEY_PEPPER; process.env.SPW_TRADING_API_EXECUTION = 'on';
  let inner: Server | null = null;
  signerSrv = createServer((req, res) => { if (inner) inner.emit('request', req, res); else { res.statusCode = 503; res.end(); } }).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}` });
  w = await liveWorld({ start: T0 });
  inner = createSignerServer(w.signer, SECRET);
  await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = w.pk.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  gw = await import('./gmx-world.ts');
  INST = gw.GMX_ETH.instrument;
  const dv = await import('../src/derivatives/index.ts'), ex = await import('../src/derivatives/gmx-exec.ts'), mod = await import('@spw/derivatives/live');
  const v = fixtureVenues(w.clock), d = dv.createDerivatives({ registry: dv.createRegistry(v.adapters, w.clock.now), now: w.clock.now });
  const m = await d.data.market(INST), mid = D.str(D.div(D.add(D.from(m.liquidity!.oracleMin), D.from(m.liquidity!.oracleMax)), D.from('2'), 6, 'half_even'));
  Object.assign(w.px, { ETH: Number(mid), USDC: 1 });                                               // the signer's OWN prices
  chain = new gw.FakeChain(w.clock);
  chain.dec = (l) => mod.decodeGmxEvent(l);
  const port = { checkPins: () => chain.checkPins(), balances: () => chain.balances(), txParams: () => chain.txParams(), executionGas: () => chain.executionGas(), positions: async () => chain.positions, orders: () => chain.orders2(), order: (k: string) => chain.order(k),
    estimateGas: () => chain.estimateGas(), simulate: () => chain.simulate(), broadcast: (r: string) => chain.broadcast(r), receipt: (t: string) => chain.receipt(t), orderEvents: (k: string) => chain.orderEvents(k) };
  const sp = { status: async () => w.signer.status() as never, sign: (i: unknown, a: unknown) => w.signer.sign(i, a as never), gmxAuthorize: (a: unknown, as: unknown) => w.signer.gmxAuthorize(a, as as never), gmxRevoke: async (id: string) => w.signer.gmxRevoke(id) };
  svc = new ex.GmxService({ chain: port as never, signer: sp, now: w.clock.now, rpId: RP, credentials: async () => [{ id: w.pk.id, transports: ['internal'] }], settings: () => settings,
    market: { market: async (id) => { const x = await d.data.market(id); return { instrument: x.instrument, ticker: x.ticker, liquidity: x.liquidity }; }, apiPositions: async () => [] } });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: d, live: w.svc, gmx: svc });
  // the venue policy of the tests, approved with the passkey: ETH, 3×, 100 USD per order
  const prep = await svc.prepareAuthorization({ allowedMarkets: [gw.GMX_ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 20, maxPriceDeviationBps: 100, days: 7, locale: 'fr' });
  await svc.approveAuthorization({ authorization: prep.authorization, assertion: w.pk.assert(Buffer.from(prep.hash, 'hex')) as never }, 'fr');
  await setLimits();
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('GMX through the trading API: the owner', () => {
  let opened: { id: string; key: string };

  it('what GMX cannot express is refused with a precise code — the same in the preview and at creation; nothing reaches the engine', async () => {
    const ops = await count('deriv_gmx_ops'), orders = await count('orders');
    for (const [body, code] of [[{ type: 'limit', price: '2000' }, 'gmx_market_orders_only'], [{ type: 'stop_market', triggerPrice: '1900' }, 'gmx_market_orders_only'], [{ leverage: undefined }, 'gmx_leverage_required']] as const) {
      const p = await call('POST', `${T}/orders/preview`, { body: order(body) });
      expect([p.status, p.json.error], JSON.stringify(p.json)).toEqual([422, code]);
      const r = await call('POST', `${T}/orders`, { headers: idem(), body: order(body) });
      expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([422, code]);
    }
    expect([await count('deriv_gmx_ops'), await count('orders')]).toEqual([ops, orders]);                // refused before an order exists
    // the GMX account is the wallet's own address: an accountId names nothing; an unknown market is not in the pinned table
    expect((await call('POST', `${T}/orders`, { headers: idem(), body: order({ accountId: randomUUID() }) })).json.error).toBe('unknown_account');
  });

  it('an owner order waits AWAITING_APPROVAL, linked to the engine\'s operation; the passkey goes through the existing GMX route; the projection follows the engine to FILLED; a replay creates nothing twice', async () => {
    const pv = await call('POST', `${T}/orders/preview`, { body: order() });
    expect(pv.json, JSON.stringify(pv.json.refusals)).toMatchObject({ wouldExecute: true, refusals: [], approval: { required: true, by: 'owner_passkey' }, risk: { decision: 'allow' }, engine: { name: 'gmx', estimate: { source: 'estimate' } } });
    const h = idem(), before = { ops: await count('deriv_gmx_ops'), orders: await count('orders'), calls: app.execution.orders.engineCalls.gmxPrepare };
    const o = await call('POST', `${T}/orders`, { headers: h, body: order() });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    expect(o.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', mode: 'live', venue: 'gmx', network: 'arbitrum', engine: 'gmx', origin: 'trading_api', principal: { kind: 'owner' }, instrument: INST, side: 'buy', reduceOnly: false });
    const opId = o.json.order.engineRef as string;
    const [op] = await sql`select * from deriv_gmx_ops where id = ${opId}`;
    expect(op).toMatchObject({ kind: 'increase', state: 'pending_approval', idempotency_key: id, is_long: true });
    expect(o.json.approval).toMatchObject({ by: 'owner_passkey', engine: 'gmx', operationId: opId, hash: op.op_hash, approve: { method: 'POST', path: `${G}/operations/${opId}/approve` } });
    // the size in USD is the size × the venue mark, to the cent, and the collateral is that ÷ the leverage, rounded up
    const d = (await orderRow(id)).detail.gmx, usd = D.from(d.sizeUsd);
    expect(D.gt(usd, D.from('30')) && D.lt(usd, D.from('60'))).toBe(true);
    expect(D.gte(D.mul(D.from(d.collateral), D.from('3')), usd) && D.lt(D.sub(D.mul(D.from(d.collateral), D.from('3')), usd), D.from('0.00001'))).toBe(true);
    expect(d).toMatchObject({ action: 'increase', side: 'long', leverage: '3' });
    expect(chain.broadcasts).toHaveLength(0);                                                       // nothing was signed or sent
    // a replay of the request: the same order, no second operation, no second engine call
    // (the same HTTP key answers the stored HTTP answer; the same clientOrderId under another HTTP key reaches the order service, which answers the same order)
    const again = await call('POST', `${T}/orders`, { headers: h, body: order() });
    expect([again.status, again.json.order.id, again.json.approval.operationId]).toEqual([200, id, opId]);
    const cid = h['idempotency-key'], viaService = await call('POST', `${T}/orders`, { headers: idem(), body: order({ clientOrderId: cid }) });
    expect([viaService.status, viaService.json.idempotent, viaService.json.order.id, viaService.json.approval.operationId], JSON.stringify(viaService.json)).toEqual([200, true, id, opId]);
    expect([await count('deriv_gmx_ops'), await count('orders'), app.execution.orders.engineCalls.gmxPrepare]).toEqual([before.ops + 1, before.orders + 1, before.calls + 1]);
    expect((await call('POST', `${T}/orders`, { headers: idem(), body: order({ size: '0.03', clientOrderId: cid }) })).json.error).toBe('idempotency_conflict');

    // the owner approves with the passkey, through the route that existed before
    const a = await approve(o.json.approval);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const made = await mineAll();
    expect(made).toHaveLength(1);
    expect((await call('GET', `${T}/orders/${id}`)).json.order).toMatchObject({ status: 'SUBMITTED', engineStatus: 'created', venueOrderId: made[0] });
    chain.keeper(made[0]!, 'execute'); await svc.step();
    const done = (await call('GET', `${T}/orders/${id}`)).json;
    expect(done.order).toMatchObject({ status: 'FILLED', final: true, engineStatus: 'executed', projectionError: null });
    expect(await states(id)).toEqual(['VALIDATED:validated', 'AWAITING_APPROVAL:approval_requested', 'APPROVED:approved', 'SUBMITTING:submit_started', 'SUBMITTED:venue_accepted', 'FILLED:reconciled_found']);
    // ONE unified order for the operation: the engine row was linked, never adopted as a second order
    expect((await sql`select count(*)::int as n from orders where engine = 'gmx' and engine_ref = ${opId}`)[0].n).toBe(1);
    expect((await sql`select count(*)::int as n from orders where id like 'adopt-%'`)[0].n).toBe(0);
    expect(chain.positions).toHaveLength(1);
    opened = { id, key: made[0]! };
  });

  it('SPW_DERIV_GMX_LIVE off: an increase is refused with the engine\'s code — a REJECTED row, no operation — and the preview says the same', async () => {
    settings.gmxLive = false;
    try {
      const ops = await count('deriv_gmx_ops'), props = await count('proposals');
      const pv = await call('POST', `${T}/orders/preview`, { body: order() });
      expect(pv.json.refusals.find((r: any) => r.code === 'gmx_disabled')).toMatchObject({ stage: 'lock' });
      expect(pv.json.wouldExecute).toBe(false);
      const r = await call('POST', `${T}/orders`, { headers: idem(), body: order() });
      expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([403, 'gmx_disabled']);
      // the refusal comes from the ENGINE, after the order service created the order: the order exists and says why it went nowhere
      expect(r.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'VENUE_NOT_ALLOWED', rejectCode: 'gmx_disabled', engineRef: null });
      expect([await count('deriv_gmx_ops'), await count('proposals')]).toEqual([ops, props]);
      settings.gmxLive = true; settings.liveMainnet = false;
      expect((await call('POST', `${T}/orders`, { headers: idem(), body: order() })).json.error).toBe('mainnet_disabled');
      expect((await call('POST', `${T}/orders/preview`, { body: order() })).json.refusals.map((x: any) => x.code)).toContain('mainnet_disabled');
    } finally { settings.gmxLive = true; settings.liveMainnet = true; }
  });

  it('the engine\'s own gate (prepareOrder): a risk denial and the kill switch stop an increase before anything is stored; a proposal prepared before the kill switch is refused at its approval', async () => {
    w.clock.advance(1_000);
    const LONG = { market: gw.GMX_ETH.market, side: 'long' as const, action: 'increase' as const, collateral: '10', leverage: '2', slippageBps: 50 };
    const ops = await count('deriv_gmx_ops'), props = await count('proposals'), decisions = (await sql`select count(*)::int as n from risk_decisions where venue = 'gmx' and not preview`)[0].n;
    // 1 — a limit of the unified engine (not of the GMX engine): refused by the gate, through the route that existed before too
    await setLimits({ maxOrderNotional: '5' });
    expect(await refusal(svc.prepareOrder(LONG, `gate-${randomUUID()}`))).toEqual({ code: 'risk_denied', status: 422 });
    const old = await call('POST', `${G}/orders`, { headers: idem(), body: LONG });
    expect([old.status, old.json.error]).toEqual([422, 'risk_denied']);
    const [dec] = await sql`select decision, failed, principal_kind from risk_decisions where venue = 'gmx' and not preview order by id desc limit 1`;
    expect(dec).toMatchObject({ decision: 'deny', principal_kind: 'owner' });
    expect(dec.failed).toContain('order_notional');
    expect((await sql`select count(*)::int as n from risk_decisions where venue = 'gmx' and not preview`)[0].n).toBe(decisions + 2);       // the gate judged each of them itself
    await setLimits();
    expect([await count('deriv_gmx_ops'), await count('proposals')]).toEqual([ops, props]);

    // 2 — a proposal prepared BEFORE the kill switch (through the trading API: a unified order waits for the passkey)
    const o = await call('POST', `${T}/orders`, { headers: idem(), body: order({ size: '0.01' }) });
    expect(o.json.order?.status, JSON.stringify(o.json)).toBe('AWAITING_APPROVAL');
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'gmx gate test' } })).status).toBe(200);
    // 3 — the kill switch stops a new increase at the gate: nothing is stored, by the engine's own route and by the trading API
    const n = { ops: await count('deriv_gmx_ops'), props: await count('proposals') };
    expect(await refusal(svc.prepareOrder(LONG, `gate-${randomUUID()}`))).toEqual({ code: 'kill_switch_active', status: 423 });
    const viaApi = await call('POST', `${T}/orders`, { headers: idem(), body: order({ size: '0.01' }) });
    expect([viaApi.status, viaApi.json.error]).toEqual([423, 'kill_switch_active']);
    expect(viaApi.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'KILL_SWITCH_ACTIVE', engineRef: null });
    expect([await count('deriv_gmx_ops'), await count('proposals')]).toEqual([n.ops, n.props]);
    // …and the proposal made before it is refused at its approval: withdrawn, nothing signed
    const signed = chain.broadcasts.length;
    const a = await approve(o.json.approval);
    expect([a.status, a.json.error]).toEqual([423, 'kill_switch_active']);
    expect((await sql`select state from deriv_gmx_ops where id = ${o.json.order.engineRef}`)[0].state).toBe('withdrawn');
    expect((await call('GET', `${T}/orders/${o.json.order.id}`)).json.order).toMatchObject({ status: 'CANCELLED', reasonCode: 'WITHDRAWN_BEFORE_APPROVAL' });
    expect(chain.broadcasts).toHaveLength(signed);
  });

  it('a decrease (close) and a cancellation pass under the kill switch AND with the GMX lock off — each with its own passkey', async () => {
    expect((await call('GET', '/api/v1/risk/state')).json.switches.killSwitch.on).toBe(true);
    settings.gmxLive = false; settings.liveMainnet = false;
    try {
      // the position opened earlier, as GET /positions names it
      const pos = (await call('GET', `${T}/positions?mode=live`)).json.positions.find((p: any) => p.venue === 'gmx');
      expect(pos, 'the GMX position').toBeTruthy();
      expect(pos.id.startsWith(`live:gmx:${gw.ME}:`)).toBe(true);
      // KNOWN LIMIT (not of this change): that id — wallet address + 32-byte position key — is 118 characters, above the HTTP
      // server's 100-character limit for a path parameter, so it cannot be used in the path as listed (414). The position is
      // named here by its instrument id, which the order service accepts when the wallet holds one position on the market.
      expect((await call('POST', `${T}/positions/${encodeURIComponent(pos.id)}/close`, { headers: idem(), body: {} })).status).toBe(414);
      pos.id = `live:gmx:${gw.ME}:${INST}`;
      const c = await call('POST', `${T}/positions/${encodeURIComponent(pos.id)}/close`, { headers: idem(), body: {} });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      expect(c.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', engine: 'gmx', side: 'sell', reduceOnly: true });
      expect((await sql`select kind, state from deriv_gmx_ops where id = ${c.json.order.engineRef}`)[0]).toEqual({ kind: 'decrease', state: 'pending_approval' });
      const [dec] = await sql`select reducing, checks from risk_decisions where order_id = ${c.json.order.id} order by id desc limit 1`;
      expect(dec.reducing).toBe(true);
      expect(dec.checks.find((x: any) => x.id === 'kill_switch')).toMatchObject({ ok: true, exempt: true });
      expect((await approve(c.json.approval)).status).toBe(200);
      const made = await mineAll();
      expect(made).toHaveLength(1);
      expect((await call('GET', `${T}/orders/${c.json.order.id}`)).json.order).toMatchObject({ status: 'SUBMITTED', engineStatus: 'created' });

      // the keeper does not come: once GMX's request expiration has passed, the owner cancels the pending order — a wallet transaction
      const early = await call('DELETE', `${T}/orders/${c.json.order.id}`, { headers: idem() });
      expect([early.status, early.json.error]).toEqual([409, 'not_yet_cancellable']);
      w.clock.advance((GMX_REQUEST_EXPIRATION_SEC + 5) * 1000);
      const x = await call('DELETE', `${T}/orders/${c.json.order.id}`, { headers: idem() });
      expect(x.status, JSON.stringify(x.json)).toBe(200);
      expect(x.json).toMatchObject({ sent: false, changed: false, order: { status: 'SUBMITTED' }, approval: { by: 'owner_passkey', engine: 'gmx', operation: 'cancel' } });
      expect((await sql`select kind, state, target_op from deriv_gmx_ops where id = ${x.json.approval.operationId}`)[0]).toEqual({ kind: 'cancel', state: 'pending_approval', target_op: c.json.order.engineRef });
      expect((await approve(x.json.approval)).status).toBe(200);
      chain.mine(); await svc.step(); await svc.step();
      expect((await call('GET', `${T}/orders/${c.json.order.id}`)).json.order).toMatchObject({ status: 'CANCELLED', reasonCode: 'CANCELLED_AT_VENUE', final: true });
      // a cancel operation acts on another order: it is not an order of its own
      expect((await sql`select count(*)::int as n from orders where engine = 'gmx' and engine_ref = ${x.json.approval.operationId}`)[0].n).toBe(0);
      expect(chain.positions).toHaveLength(1);                                                       // the position is still there: the close was cancelled

      // an order that still waits for the passkey is withdrawn at once by a cancel: nothing was signed
      w.clock.advance(-(GMX_REQUEST_EXPIRATION_SEC + 5) * 1000);                                     // (the recorded market data is dated)
      const c2 = await call('POST', `${T}/positions/${encodeURIComponent(pos.id)}/reduce`, { headers: idem(), body: { fraction: '0.5' } });
      expect(c2.json.order?.status, JSON.stringify(c2.json)).toBe('AWAITING_APPROVAL');
      const wd = await call('DELETE', `${T}/orders/${c2.json.order.id}`, { headers: idem() });
      expect([wd.status, wd.json.changed, wd.json.order.status, wd.json.order.reasonCode]).toEqual([200, true, 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL']);
      // an increase is still refused, under both
      expect((await call('POST', `${T}/orders`, { headers: idem(), body: order({ size: '0.01' }) })).json.error).toBe('kill_switch_active');
    } finally { settings.gmxLive = true; settings.liveMainnet = true; }
    expect((await release()).status).toBe(200);
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
    expect(opened.id).toBeTruthy();
  });
});

describe('GMX through the trading API: an API key or an agent', () => {
  it('is refused with gmx_requires_owner_passkey — preview, creation, close and commands alike: the signer has no mandate for GMX', async () => {
    const orders = await count('orders');
    for (const kind of ['api_key', 'agent'] as const) {
      const caller = { principal: { kind, id: kind === 'api_key' ? 'spk_test0000000000' : randomUUID() }, mandateId: randomUUID() };
      const input = { ...order(), reduceOnly: false, tif: 'gtc' } as never;
      expect(await refusal(app.execution.orders.preview(caller, input, `k-${randomUUID()}`))).toEqual({ code: 'gmx_requires_owner_passkey', status: 403 });
      expect(await refusal(app.execution.orders.submit(caller, input, `k-${randomUUID()}`))).toEqual({ code: 'gmx_requires_owner_passkey', status: 403 });
      expect(await refusal(app.execution.orders.reducePosition(caller, `live:gmx:${gw.ME}:0x${'ab'.repeat(32)}`, '1', undefined, `k-${randomUUID()}`))).toEqual({ code: 'gmx_requires_owner_passkey', status: 403 });
    }
    expect(await count('orders')).toBe(orders);
  });
});
