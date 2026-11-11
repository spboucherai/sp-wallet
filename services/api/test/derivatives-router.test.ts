// The router routes (docs/v4/ROUTER.md) through the real server on fixture-backed venue adapters: POST /derivatives/route and
// GET /derivatives/route/assets. Simulation only — the tests also check that nothing reaches a trading endpoint, that no dYdX
// account endpoint is called, and that nothing is stored. Database spw_deriv_router_test (created here if missing). No network.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainCosts } from '@spw/derivatives';
import { BTC, Clock, DYDX_BTC, GMX_BTC, HL_ACCOUNT, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', P = '/api/v1/derivatives';
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, d: import('../src/derivatives/index.ts').Derivatives;
const LIVE_ID = '11111111-1111-4111-8111-111111111111', TESTNET_ID = '22222222-2222-4222-8222-222222222222';
const livePreviews: unknown[] = [];
let rpcCalls = 0;

async function api(method: 'GET' | 'POST', path: string, body?: unknown, opts: { cookie?: string | null; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {};
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET') { headers.origin = ORIGIN; if (opts.csrf !== false) headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const intent = (o: Record<string, unknown> = {}) => ({ base: 'BTC', side: 'long', notionalUsd: '25000', leverage: '3', type: 'market', horizonHours: '24', ...o });
const route = (o: Record<string, unknown> = {}) => api('POST', P + '/route', intent(o));
const cand = (j: any, id: string) => j.candidates.find((c: any) => c.instrument === id);
const codes = (c: any, kind = 'blocker') => c.eligibility.reasons.filter((r: any) => r.kind === kind).map((r: any) => r.code);
const cost = (c: any, id: string) => c.costs.find((x: any) => x.id === id);

beforeAll(async () => {
  await useDatabase('deriv_router');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await sql`truncate deriv_paper_accounts cascade`;
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const mod = await import('../src/derivatives/index.ts'), { UserError } = await import('../src/config.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  const chain = { read: async (eth: { value: string; source: string } | null): Promise<ChainCosts> => { rpcCalls += 1; return { gasPriceEth: '0.00000000002', ethUsd: eth?.value ?? null, ethUsdSource: eth?.source ?? 'none', gmxExecutionFeeEth: '0.00008', gmxExecutionFeeNote: 'fixture', ts: clock.now() }; } };
  // a venue account that was never authorized (its preview refuses), and one on testnet
  const live = {
    list: async () => [{ id: LIVE_ID, venue: 'hyperliquid', network: 'mainnet', label: 'HL réel', mode: 'READ_ONLY', account: HL_ACCOUNT }, { id: TESTNET_ID, venue: 'hyperliquid', network: 'testnet', label: 'HL testnet', mode: 'MANUAL_LIVE', account: HL_ACCOUNT }],
    preview: async (id: string, body: unknown) => { livePreviews.push({ id, body }); throw new UserError('mode_read_only', 'this venue account is read-only: live trading has not been authorized with the owner\'s passkey', 422); },
  };
  d = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now, chain, live });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: d });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); await sql?.end(); });

describe('access and validation', () => {
  it('both routes need the owner session; the POST needs the CSRF header; a malformed intent is a 400', async () => {
    expect((await api('GET', P + '/route/assets', undefined, { cookie: null })).status).toBe(401);
    expect((await api('POST', P + '/route', intent(), { cookie: null })).status).toBe(401);
    expect((await api('POST', P + '/route', intent(), { csrf: false })).status).toBe(403);
    expect(v.hl.calls).toEqual({}); expect(rpcCalls).toBe(0);                                             // nothing was read for a refused request
    for (const bad of [{}, intent({ notionalUsd: undefined }), intent({ sizeBase: '0.1' }), intent({ leverage: '0' }), intent({ notionalUsd: 25000 }), intent({ type: 'limit' }), intent({ price: '70000' }),
      intent({ base: 'B/TC' }), intent({ side: 'buy' }), intent({ horizonHours: '9000' }), intent({ venue: 'gmx' }), intent({ accountIds: ['nope'] }), intent({ accountIds: Array(7).fill(LIVE_ID) })])
      expect((await api('POST', P + '/route', bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await route({ accountIds: ['33333333-3333-4333-8333-333333333333'] })).json.error).toBe('unknown_account');
  });
});

describe('GET /route/assets', () => {
  it('lists the bases with their venues and instruments; a restricted venue is flagged, not counted as a candidate', async () => {
    const r = await api('GET', P + '/route/assets');
    expect(r.status).toBe(200);
    const btc = r.json.assets.find((a: any) => a.base === 'BTC');
    expect(btc.venues.map((x: any) => x.venue)).toEqual(['hyperliquid', 'gmx', 'dydx']); expect(btc.candidateVenues).toBe(2);
    expect(btc.venues[0].instruments).toEqual([BTC]); expect(btc.venues[1].instruments).toContain(GMX_BTC); expect(btc.venues[1].instruments.length).toBe(4);
    expect(btc.venues[2]).toMatchObject({ instruments: [DYDX_BTC] }); expect(btc.venues[2].restriction).toContain('Canada'); expect(btc.venues[0].restriction).toBeNull();
    expect(r.json.assets[0].candidateVenues).toBe(2);                                                    // comparable bases first
    expect(r.json.assets.every((a: any) => a.venues.length >= 1)).toBe(true); expect(r.json.errors).toEqual([]);
    // a venue that cannot be read is named; the others are still listed
    v.gmx.down = true; clock.advance(3_700_000);
    const part = await api('GET', P + '/route/assets');
    expect(part.status).toBe(200); expect(part.json.errors.map((e: any) => e.venue)).toEqual(['gmx']); expect(part.json.assets.find((a: any) => a.base === 'BTC').venues.map((x: any) => x.venue)).toEqual(['hyperliquid', 'dydx']);
    v.gmx.down = false; clock.advance(2_000);                                                            // past the one-second failure backoff
  });
});

describe('POST /route', () => {
  it('one estimate per instrument from fresh snapshots: itemised costs, sources, ranking as information, dYdX shown and never ranked', async () => {
    const before = { ...v.hl.calls };
    const r = await route();
    expect(r.status).toBe(200);
    const j = r.json;
    expect(j.source).toBe('estimate'); expect(j.ts).toBe(clock.t); expect(j.intent).toMatchObject({ base: 'BTC', side: 'long', notionalUsd: '25000', reduceOnly: false, price: null });
    expect(j.candidates.map((c: any) => c.venue)).toEqual(['hyperliquid', 'gmx', 'gmx', 'gmx', 'gmx', 'dydx']);
    const hl = cand(j, BTC), gmx = cand(j, GMX_BTC), dy = cand(j, DYDX_BTC);
    // Hyperliquid: the recorded book walked, base-tier fee, hourly funding with the venue's own last-day range as its uncertainty
    expect(hl.eligibility).toMatchObject({ eligible: true, executableNow: false }); expect(codes(hl, 'setup')).toEqual(['no_collateral_account']);
    expect(hl.fill).toMatchObject({ method: 'order_book_walk', unfilledBase: '0', source: 'estimate' });
    expect(hl.costs.map((c: any) => c.id)).toEqual(['spread_slippage', 'trading_fee', 'funding', 'collateral_transfer']);
    expect(cost(hl, 'funding').uncertainty).toMatch(/last 24 h/); expect(cost(hl, 'trading_fee').inputs[0]).toMatchObject({ value: '0.00045', source: 'constant' });
    expect(Number(cost(hl, 'collateral_transfer').usd)).toBeGreaterThan(0);
    expect(hl.risk).toEqual({ venue: { accepted: true, codes: [], note: expect.stringContaining('Hyperliquid') }, accounts: [] });
    // GMX: oracle range from the Oracle API, impact formula, execution fee and gas from the chain reader, converted at the snapshot's ETH price
    expect(gmx.eligibility.eligible).toBe(true); expect(codes(gmx, 'setup')).toEqual(['wallet_cannot_trade_here', 'no_collateral_account']);
    expect(Number(gmx.fill.gmx.oracleMax)).toBeGreaterThanOrEqual(Number(gmx.fill.gmx.oracleMin)); expect(gmx.fill.gmx.virtualInventory).toBe('none');
    expect(gmx.costs.map((c: any) => c.id)).toEqual(['spread_slippage', 'price_impact', 'trading_fee', 'execution_fee', 'network_gas', 'funding', 'borrow', 'collateral_transfer']);
    // the recorded set has no /markets/values: a market that shares a virtual inventory says its value is unknown
    expect(j.candidates.filter((c: any) => c.venue === 'gmx').map((c: any) => c.fill.gmx.virtualInventory)).toEqual(['none', 'none', 'none', 'none']);
    expect(j.chain).toMatchObject({ gasPriceEth: '0.00000000002', gmxExecutionFeeEth: '0.00008', ethUsdSource: 'Hyperliquid ETH mark price' });
    expect(Number(cost(gmx, 'execution_fee').usd)).toBeCloseTo(0.00008 * Number(j.chain.ethUsd), 5);
    expect(cost(gmx, 'collateral_transfer').usd).toBeNull(); expect(gmx.allIn.unknown).toEqual(['collateral_transfer']);
    // dYdX: public figures shown, restricted, never ranked, no account endpoint touched
    expect(dy.eligibility.eligible).toBe(false); expect(codes(dy)).toEqual(['venue_restricted']); expect(dy.eligibility.reasons[0].message).toMatch(/Canada/);
    expect(dy.fill).not.toBeNull(); expect(dy.risk.venue).toMatchObject({ accepted: false, codes: ['venue_restricted'] });
    expect(j.ranking.rows.some((x: any) => x.venue === 'dydx')).toBe(false); expect(j.ranking.excluded.map((x: any) => x.instrument)).toContain(DYDX_BTC);
    expect(v.dydx.accountCalls).toBe(0);
    // the ranking is information
    expect(j.ranking.selected).toBeNull(); expect(j.ranking.rows.length).toBe(5); expect(j.ranking.note).toMatch(/selects nothing/);
    expect(j.ranking.rows.map((x: any) => Number(x.allInUsd))).toEqual([...j.ranking.rows.map((x: any) => Number(x.allInUsd))].sort((a, b) => a - b));
    expect(j.differences.interchangeable).toBe(false); expect(j.differences.statement).toMatch(/6 different contracts on BTC/); expect(j.differences.fields.length).toBeGreaterThan(8);
    expect(j.warnings.join(' ')).toMatch(/Simulation only/); expect(j.errors).toEqual([]);
    // read-only: no trading endpoint, and only public market reads were added
    expect(v.hl.calls.exchange).toBeUndefined();
    expect(Object.keys(v.hl.calls).filter((k) => (v.hl.calls[k] ?? 0) > (before[k] ?? 0)).sort()).toEqual(['fundingHistory', 'l2Book', 'meta', 'metaAndAssetCtxs'].filter((k) => (v.hl.calls[k] ?? 0) > (before[k] ?? 0)));
    expect(await sql`select count(*)::int as n from deriv_orders`).toEqual([{ n: 0 }]);
  });

  // v8 hardening (D2): the engine messages and the contract terms follow `locale` (query or body); the estimate itself never changes
  it('follows locale: fr translates the engine messages and the contract terms, en (default) is the engine\'s own answer; locale is not part of the intent', async () => {
    const { hasFrench } = await import('../src/derivatives/market-texts.ts');
    const en = (await route()).json, fr = (await api('POST', P + '/route?locale=fr', intent())).json, viaBody = await route({ locale: 'fr' });
    expect(en.locale).toBe('en'); expect(fr.locale).toBe('fr');
    expect(viaBody.status).toBe(200); expect(viaBody.json).toEqual(fr);                                    // the body's `locale` is accepted and stripped before the strict intent schema
    expect(fr.intent).toEqual(en.intent); expect('locale' in fr.intent).toBe(false);
    expect((await route({ locale: 'en' })).json).toEqual(en);
    // every engine message has its French sentence
    expect(fr.warnings.length).toBe(en.warnings.length);
    for (const [i, w] of en.warnings.entries()) { expect(hasFrench(w), w).toBe(true); expect(fr.warnings[i]).not.toBe(w); }
    expect(fr.warnings[0]).toMatch(/^Simulation seulement/);
    // contract terms: sentences are translated, figures and symbols are not
    const TEXT = ['structure', 'execution', 'settlement', 'quote', 'markPrice', 'fundingInterval', 'fundingRule', 'sizeUnit', 'maintenance', 'liquidation', 'fees'];
    for (const [i, c] of fr.candidates.entries()) {
      const e = en.candidates[i];
      for (const k of TEXT) { expect(hasFrench(e.terms[k].value), `${c.venue} ${k}: ${e.terms[k].value}`).toBe(true); expect(c.terms[k].source).toBe(e.terms[k].source); }
      for (const k of ['tick', 'lot']) expect(c.terms[k]).toEqual(e.terms[k]);
      expect(c.terms.collateral).toEqual({ ...e.terms.collateral, value: e.terms.collateral.value.replace(' or ', ' ou ') });
      // the estimate is the same estimate: costs, fill, margin, eligibility, risk
      const { terms: _t, ...rest } = c, { terms: _e, ...enRest } = e;
      expect(rest).toEqual(enRest);
    }
    expect(cand(fr, BTC).terms.fundingInterval.value).toBe('toutes les 1 h'); expect(cand(fr, GMX_BTC).terms.fundingInterval.value).toMatch(/^en continu/);
    expect(cand(fr, GMX_BTC).terms.maxLeverage.value).toMatch(/borne du contrat/);
    const diff = (j: any, f: string) => j.differences.fields.find((x: any) => x.field === f).values.map((x: any) => x.value);
    expect(diff(fr, 'structure')).toEqual(fr.candidates.map((c: any) => c.terms.structure.value));          // the differences table shows the same French values
    expect(fr.ranking).toEqual(en.ranking); expect(fr.chain).toEqual(en.chain); expect(fr.errors).toEqual(en.errors);
    // messages with a figure or a name
    const none = (await api('POST', P + '/route?locale=fr', intent({ base: 'ZZZZ' }))).json;
    expect(none.warnings.join(' ')).toMatch(/Aucune plateforme ne liste de contrat perpétuel sur ZZZZ\./);
  });

  it('another base, a size in base units, a limit order, a short, a reduce-only order', async () => {
    const eth = await route({ base: 'eth', notionalUsd: undefined, sizeBase: '2', side: 'short' });
    expect(eth.status).toBe(200); expect(eth.json.intent.base).toBe('eth');
    const hl = cand(eth.json, 'hyperliquid:ETH');
    // the recorded book fixture is BTC's: the helper serves it for any symbol, which the adapter refuses → said, not estimated
    expect(hl.order === null || hl.order.side === 'sell').toBe(true);
    const g = eth.json.candidates.find((c: any) => c.venue === 'gmx' && c.instrument === 'gmx:ETH/USD [WETH-USDC]');
    expect(g.order).toMatchObject({ side: 'sell', sizeUnit: 'usd', positionSide: 'short' }); expect(Number(g.order.sizeUsd)).toBeCloseTo(2 * Number(g.fill.avgPrice), 4);
    setMarket(v, 73000); clock.advance(2_000);                                                           // past the one-second book cache
    const lim = await route({ notionalUsd: undefined, sizeBase: '1.5', type: 'limit', price: '73005' });
    expect(cand(lim.json, BTC).fill).toMatchObject({ filledBase: '1', restingBase: '0.5', unfilledReason: 'limit_price' });
    const ro = await route({ reduceOnly: true });
    expect(cand(ro.json, BTC).order.side).toBe('sell'); expect(cand(ro.json, BTC).margin).toBeNull();
    const none = await route({ base: 'ZZZZ' });
    expect(none.status).toBe(200); expect(none.json.candidates).toEqual([]); expect(none.json.warnings.join(' ')).toMatch(/No venue lists/);
    v.hl.book = null; v.hl.ticker = null;
  });

  it('refuses to estimate on stale data, and names the venue it could not read', async () => {
    // the venue's own book timestamp is too old: the instrument is not estimated, with the reason
    v.hl.bookAgeMs = 20_000; clock.advance(2_000);
    const old = await route();
    const hl = cand(old.json, BTC);
    expect(codes(hl)).toEqual(['data_unavailable']); expect(hl.eligibility.reasons.find((r: any) => r.code === 'data_unavailable').message).toMatch(/20 s old/);
    expect(hl).toMatchObject({ fill: null, costs: [], allIn: null }); expect(old.json.ranking.rows.some((x: any) => x.venue === 'hyperliquid')).toBe(false);
    v.hl.bookAgeMs = 0;
    // the venue is down and the cached ticker is older than its bound: the venue is in `errors`, the others are still compared
    clock.advance(2_000); await route(); v.hl.down = true; clock.advance(16_000);
    const down = await route();
    expect(down.status).toBe(200); expect(down.json.errors.map((e: any) => e.venue)).toEqual(['hyperliquid']); expect(down.json.candidates.some((c: any) => c.venue === 'hyperliquid')).toBe(false);
    expect(down.json.warnings.join(' ')).toMatch(/Not read: hyperliquid/); expect(down.json.ranking.rows.every((x: any) => x.venue === 'gmx')).toBe(true);
    // a ticker served from the cache within its bound but older than the router's limit would be refused by the router itself (router.test.ts);
    // here every venue down → 503, never an estimate
    v.gmx.down = true; clock.advance(40_000);
    const all = await api('POST', P + '/route', intent({ base: 'DOGE' }));
    expect([200, 503]).toContain(all.status);
    if (all.status === 200) expect(all.json.ranking.rows).toEqual([]);
    v.hl.down = false; v.gmx.down = false; clock.advance(4_000);
  });
});

describe('risk view: what each account\'s own policy says (nothing is placed)', () => {
  let paperId = '';
  it('a paper account: accepted, or refused with the risk engine\'s code; the estimate becomes executable as paper', async () => {
    setMarket(v, 73000, { bids: [['72999', '5'], ['72990', '50']], asks: [['73001', '5'], ['73010', '50']] });
    const made = await api('POST', P + '/accounts', { venue: 'hyperliquid', label: 'Sim routeur', collateral: '10000' });
    expect(made.status).toBe(200); paperId = made.json.id;
    const ok = await route({ notionalUsd: '5000', accountIds: [paperId] });
    const hl = cand(ok.json, BTC);
    expect(hl.risk.accounts).toEqual([{ accountId: paperId, label: 'Sim routeur', kind: 'paper', mode: 'PAPER', network: 'mainnet', accepted: true, code: null, reason: null, source: 'risk_engine' }]);
    expect(hl.eligibility).toMatchObject({ eligible: true, executableNow: true, executableAs: 'paper' });
    expect(cost(hl, 'collateral_transfer').usd).toBe('0'); expect(cost(hl, 'collateral_transfer').basis).toMatch(/SIMULATED/);
    expect(cand(ok.json, GMX_BTC).risk.accounts).toEqual([]);                                            // the account is not on GMX
    // the default paper policy: one order ≤ the collateral, leverage ≤ 3
    const big = await route({ notionalUsd: '25000', leverage: '2', accountIds: [paperId] });                // 12 500 USD of margin on 10 000
    expect(cand(big.json, BTC).risk.accounts[0]).toMatchObject({ accepted: false, code: 'order_notional_exceeded', source: 'risk_engine' });
    expect(cand(big.json, BTC).risk.venue.accepted).toBe(true);                                          // the venue's own limits would take it
    expect(codes(cand(big.json, BTC), 'setup')).toEqual(['insufficient_collateral_there']);
    const lev = await route({ notionalUsd: '5000', leverage: '5', accountIds: [paperId] });
    expect(cand(lev.json, BTC).risk.accounts[0]).toMatchObject({ accepted: false, code: 'leverage_exceeded' });
    // nothing was stored or placed by any of this
    expect(await sql`select count(*)::int as n from deriv_orders`).toEqual([{ n: 0 }]);
    expect((await api('GET', `${P}/accounts/${paperId}`)).json).toMatchObject({ positions: [], openOrders: [], orders: [] });
    expect(v.hl.calls.exchange).toBeUndefined();
  });

  it('a venue account: its collateral is read from the venue; a read-only one refuses with its own code; a testnet one is not asked', async () => {
    const r = await route({ notionalUsd: '1000', accountIds: [LIVE_ID] });
    const hl = cand(r.json, BTC);
    expect(hl.risk.accounts).toEqual([{ accountId: LIVE_ID, label: 'HL réel', kind: 'venue', mode: 'READ_ONLY', network: 'mainnet', accepted: false, code: 'mode_read_only', reason: expect.stringContaining('read-only'), source: 'risk_engine' }]);
    expect(cost(hl, 'collateral_transfer').inputs[0]).toMatchObject({ source: 'venue' });                // the venue's own free collateral
    expect(hl.eligibility.executableAs).toBe('paper');                                                   // not authorized for live: still only a simulation
    expect(livePreviews.length).toBe(1); expect((livePreviews[0] as any).body).toMatchObject({ instrument: BTC, side: 'buy', type: 'market', reduceOnly: false, slippageBps: 50 });
    const t = await route({ notionalUsd: '1000', accountIds: [TESTNET_ID] });
    expect(cand(t.json, BTC).risk.accounts[0]).toMatchObject({ accepted: null, source: 'not_checked' }); expect(cand(t.json, BTC).risk.accounts[0].reason).toMatch(/testnet/);
    expect(livePreviews.length).toBe(1);
    v.hl.book = null; v.hl.ticker = null;
  });
});
