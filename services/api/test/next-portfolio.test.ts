/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/next-portfolio.test.ts
 * Module           : services
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

// NEXT B2 / B3 / H5 through the real server (own database, a real signer process, scripted chain reads and prices):
//   summary      exact arithmetic; `complete` false when a network is down, sources disagree or a held asset has no price
//   /portfolio   the rows carry the provenance of their read; every earlier field is still there
//   snapshots    complete points only are charted; ranges, down-sampling, retention
//   flows        deposits and finalized transfers valued at the price of the moment; a deposit is not performance
//   deposits     the worker pass: native scan state, classification internal / external, the audit event, alert suppression,
//                the fields of /activity and /dashboard/activity
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { useTestDatabase } from './test-db.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48);
const NETS = Object.values(NETWORKS) as NetworkDef[], BASE = NETWORKS.base as NetworkDef, USDC = BASE.tokens.find((t) => t.symbol === 'USDC')!;
const ETH = 10n ** 18n;
let app: any, sql: any, db: typeof import('../src/db.ts'), pf: typeof import('../src/portfolio.ts'), scan: typeof import('../src/deposit-scan.ts'), worker: typeof import('../src/worker.ts');
let adapters: Record<string, any>, signerSrv: Server, cookie = '', ME = '', dispatcher: any;
const realFetch = globalThis.fetch;
/** the price list of the scripted CoinGecko: [usd, cad, 24 h change in %] */
const PRICES: Record<string, [number, number, number]> = { ethereum: [2000, 2800, 5], 'usd-coin': [1, 1.4, 0], bitcoin: [60000, 84000, -2] };

const get = async (path: string) => { const r = await app.inject({ method: 'GET', url: path, headers: { cookie } }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
const read = (o: { amount: bigint; height?: number | null; sources?: number; agreed?: boolean; stale?: boolean; extra?: object }) => ({ amount: o.amount, height: o.height === undefined ? 99 : o.height, sources: o.sources ?? 2, asked: 2, agreed: o.agreed ?? true, stale: o.stale ?? false, ...o.extra });
/** a scripted cross-checked read of one network: the listed assets, every other asset of the registry at 0 */
const detailed = (n: NetworkDef, held: Record<string, ReturnType<typeof read>>, unavailable: Record<string, string> = {}) => async () => ({
  assets: Object.fromEntries([n.native, ...n.tokens].filter((a) => !unavailable[a.id]).map((a) => [a.id, held[a.id] ?? read({ amount: 0n })])), unavailable });
/** every network answers 0 for everything through the plain read (no provenance); a test then scripts the networks it is about */
function quietChains(): void {
  for (const n of NETS) { const a = adapters[n.id]; delete a.balancesDetailed; a.balances = async () => Object.fromEntries([n.native, ...n.tokens].map((x) => [x.id, 0n])); }
  pf.resetBalanceCache();
}
function holdings(): void {
  quietChains();
  adapters.base.balancesDetailed = detailed(BASE, { native: read({ amount: 15n * ETH / 10n }), [USDC.id]: read({ amount: 250_500_000n }) });
  adapters.ethereum.balancesDetailed = detailed(NETWORKS.ethereum as NetworkDef, { native: read({ amount: ETH / 4n, height: 21_000_000 }) });
  adapters.bitcoin.balancesDetailed = detailed(NETWORKS.bitcoin as NetworkDef, { native: read({ amount: 1_000_000n, height: 900_000, extra: { confirmed: 1_200_000n, pendingOut: 200_000n, pendingIn: 0n } }) });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-next-portfolio-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  delete process.env.APIBRICKS_API_KEY;
  await useTestDatabase('next_portfolio', { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  // prices: the scripted CoinGecko; everything else (the signer) is the real fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.includes('api.coingecko.com')) return realFetch(input, init);
    const cur = new URL(url).searchParams.get('vs_currency') === 'usd' ? 0 : 1;
    return Response.json(Object.entries(PRICES).map(([id, p]) => ({ id, current_price: p[cur], last_updated: new Date().toISOString(), price_change_percentage_24h_in_currency: p[2] })));
  }) as typeof fetch;
  db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  adapters = (await import('../src/chains/index.ts')).adapters;
  pf = await import('../src/portfolio.ts'); scan = await import('../src/deposit-scan.ts'); worker = await import('../src/worker.ts');
  quietChains();
  app = await (await import('../src/server.ts')).buildServer();
  ME = (await get('/api/v1/accounts')).json.accounts.find((a: any) => a.network === 'base').address;
  const store = await import('../src/alerts/store.ts'), mod = await import('../src/alerts/dispatcher.ts');
  await store.migrateAlerts(true);
  dispatcher = new mod.AlertDispatcher({ now: () => Date.now(), fetch: (async () => new Response(null, { status: 201 })) as typeof fetch, origin: ORIGIN, settleMs: -1e12, allowHttpWebhook: true,
    signerStatus: async () => ({ keyId: 'k', addresses: {}, halted: false, enrollmentOpen: false, credentials: [], policy: { version: 3, perTx: {}, daily: {} }, spentToday: {}, journalHead: null, journalLength: 0 }) as never,
    rpcHealth: () => [], loops: () => [], backup: () => null, disk: async () => null,
    lab: async () => ({ mode: 'sandbox-exec', ok: true, reason: null, python: '/x/python', checkedAt: 0, lastFailureAt: null, lastFailure: null, calls: 0, refused: 0 }) as never });
});
afterAll(async () => { globalThis.fetch = realFetch; app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

// ================================================================================================================ arithmetic
describe('summary arithmetic (portfolio.ts)', () => {
  const row = (o: Partial<import('../src/portfolio.ts').PortfolioRow>) => ({ network: 'base', networkName: 'Base', asset: 'native', symbol: 'ETH', name: 'Ether', decimals: 18, amount: '0', display: '0', error: null, height: 1, sources: 2, sourcesAsked: 2, agreed: true, stale: false, readAt: 'x', reason: null, ...o });
  it('decimal prices are taken digit for digit: 0.1 + 0.2 units at 0.1 is exactly 0.03, sums do not drift', () => {
    expect(pf.toScaled(0.1)).toBe(10n ** 17n); expect(pf.toScaled(1e-7)).toBe(10n ** 11n); expect(pf.toScaled('123.456')).toBe(123_456n * 10n ** 15n); expect(pf.toScaled(1.5e21)).toBe(15n * 10n ** 38n);
    expect(pf.toScaled(NaN)).toBeNull(); expect(pf.toScaled(-1)).toBeNull(); expect(pf.toScaled('abc')).toBeNull();
    expect(pf.fixed(5n * 10n ** 15n)).toBe('0.01'); expect(pf.fixed(4_999n * 10n ** 12n)).toBe('0.00'); expect(pf.fixed(-15n * 10n ** 15n)).toBe('-0.02'); expect(pf.fixed(-1n)).toBe('0.00');
    const px = { ETH: { usd: 0.1, cad: 0.7, change24h: 0 }, BIG: { usd: 123456789.123456, cad: 1, change24h: 0 } };
    const s = pf.summarize([row({ amount: (ETH / 10n).toString() }), row({ network: 'ethereum', amount: (ETH / 5n).toString() }), row({ asset: 'big', symbol: 'BIG', decimals: 6, amount: '987654321000001' })], px, 'USD').summary;
    expect(s.byAsset).toEqual([{ symbol: 'BIG', value: '121932631234567244.31', share: 1 }, { symbol: 'ETH', value: '0.03', share: 0 }]); // 987654321.000001 x 123456789.123456, to the cent
    expect(s.total).toBe('121932631234567244.34'); // a float sum of these two loses the cents
    expect(pf.summarize([row({ amount: (3n * ETH).toString() })], { ETH: { usd: 0.1, cad: 0.7, change24h: 0 } }, 'CAD').summary.total).toBe('2.10'); // 3 x 0.7 is 2.0999999999999996 in floating point
  });
  it('no price list at all: no total is invented', () => {
    const s = pf.summarize([row({ amount: ETH.toString() })], null, 'USD').summary;
    expect(s).toMatchObject({ total: null, complete: false, priced: 0, change24h: null, byAsset: [], byNetwork: [], unpriced: [{ network: 'base', asset: 'native', symbol: 'ETH' }] });
  });
  it('a 24 h change is given only when every priced holding has one', () => {
    const rows = [row({ amount: ETH.toString() }), row({ asset: 'u', symbol: 'USDC', decimals: 6, amount: '1000000' })];
    expect(pf.summarize(rows, { ETH: { usd: 2100, cad: 1, change24h: 5 }, USDC: { usd: 1, cad: 1, change24h: null } }, 'USD').summary.change24h).toBeNull();
    expect(pf.summarize(rows, { ETH: { usd: 2100, cad: 1, change24h: 5 }, USDC: { usd: 1, cad: 1, change24h: 0 } }, 'USD').summary.change24h).toEqual({ abs: '100.00', pct: 4.9975, basis: 'price_change_24h_of_current_holdings' });
  });
});

// ================================================================================================================ /portfolio
describe('GET /api/v1/portfolio: provenance per row and the server-side summary', () => {
  beforeEach(async () => { holdings(); await db.setSetting('currency', 'USD'); });

  it('rows say at which height they were read and by how many sources; the summary is whole and exact', async () => {
    const r = await get('/api/v1/portfolio');
    expect(r.status).toBe(200);
    const b = (network: string, asset: string) => r.json.balances.find((x: any) => x.network === network && x.asset === asset);
    expect(b('base', 'native')).toEqual({ network: 'base', networkName: 'Base', asset: 'native', symbol: 'ETH', name: BASE.native.name, decimals: 18, amount: '1500000000000000000', display: '1.5', error: null,
      height: 99, sources: 2, sourcesAsked: 2, agreed: true, stale: false, readAt: expect.stringMatching(/^20\d\d-/), reason: null });
    expect(b('ethereum', 'native')).toMatchObject({ amount: '250000000000000000', height: 21_000_000, sources: 2 });
    expect(b('bitcoin', 'native')).toMatchObject({ amount: '1000000', display: '0.01', height: 900_000, confirmed: '1200000', pendingOut: '200000', pendingIn: '0' });
    // a family read through one path: one source, no comparison claimed, no height
    expect(b('polygon', 'native')).toMatchObject({ amount: '0', error: null, height: null, sources: 1, sourcesAsked: null, agreed: true, stale: false });
    expect(r.json.summary).toEqual({
      currency: 'USD', total: '4350.50', complete: true, missing: [], uncertain: [], priced: 4, unpriced: [], stalePrices: [], pricesStale: false,
      change24h: { abs: '154.42', pct: 3.6801, basis: 'price_change_24h_of_current_holdings' },
      byNetwork: [{ network: 'base', value: '3250.50', share: 0.747155 }, { network: 'bitcoin', value: '600.00', share: 0.137915 }, { network: 'ethereum', value: '500.00', share: 0.114929 }],
      byAsset: [{ symbol: 'ETH', value: '3500.00', share: 0.804505 }, { symbol: 'BTC', value: '600.00', share: 0.137915 }, { symbol: 'USDC', value: '250.50', share: 0.05758 }] });
    // what was there before NEXT is still there, under the same names
    for (const k of ['asOf', 'prices', 'priceSource', 'priceSources', 'pricesAsOf', 'pricesStale', 'balances', 'pending', 'halted', 'signer']) expect(r.json, k).toHaveProperty(k);
    expect(r.json.prices.ETH).toMatchObject({ usd: 2000, cad: 2800 });
  });

  it('the summary follows the currency of the settings', async () => {
    await db.setSetting('currency', 'CAD');
    const s = (await get('/api/v1/portfolio')).json.summary;
    expect(s).toMatchObject({ currency: 'CAD', total: '6090.70', complete: true });
    expect(s.byAsset).toEqual([{ symbol: 'ETH', value: '4900.00', share: 0.804505 }, { symbol: 'BTC', value: '840.00', share: 0.137915 }, { symbol: 'USDC', value: '350.70', share: 0.05758 }]);
  });

  it('a network that does not answer: its rows are unavailable (never 0) and the total says it is partial', async () => {
    adapters.ethereum.balancesDetailed = async () => { throw new Error('no endpoint answered'); };
    pf.resetBalanceCache();
    const r = (await get('/api/v1/portfolio')).json;
    expect(r.balances.find((x: any) => x.network === 'ethereum' && x.asset === 'native')).toMatchObject({ amount: null, display: null, error: 'unavailable', height: null, sources: 0, agreed: false, reason: 'network_unavailable' });
    expect(r.summary).toMatchObject({ total: '3850.50', complete: false, missing: [{ network: 'ethereum', reason: 'network_unavailable' }], uncertain: [], unpriced: [] });
    expect(r.summary.byNetwork.map((x: any) => x.network)).toEqual(['base', 'bitcoin']);
  });

  it('one asset unavailable on a network that answers: named with its asset and its reason', async () => {
    adapters.base.balancesDetailed = detailed(BASE, { native: read({ amount: 15n * ETH / 10n }) }, { [USDC.id]: 'no_source_answered' });
    pf.resetBalanceCache();
    const r = (await get('/api/v1/portfolio')).json;
    expect(r.balances.find((x: any) => x.network === 'base' && x.asset === USDC.id)).toMatchObject({ amount: null, error: 'unavailable', reason: 'no_source_answered', sourcesAsked: 2 });
    expect(r.summary).toMatchObject({ total: '4100.00', complete: false, missing: [{ network: 'base', asset: USDC.id, reason: 'no_source_answered' }] });
  });

  it('sources that disagree: the amount is shown, flagged, and the total is not called complete', async () => {
    adapters.base.balancesDetailed = detailed(BASE, { native: read({ amount: 15n * ETH / 10n, height: 102, sources: 1, agreed: false }), [USDC.id]: read({ amount: 250_500_000n }) });
    pf.resetBalanceCache();
    const r = (await get('/api/v1/portfolio')).json;
    expect(r.balances.find((x: any) => x.network === 'base' && x.asset === 'native')).toMatchObject({ amount: '1500000000000000000', agreed: false, sources: 1, height: 102 });
    expect(r.summary).toMatchObject({ total: '4350.50', complete: false, missing: [], uncertain: [{ network: 'base', asset: 'native', reason: 'sources_disagree' }] });
  });

  it('a held asset without a price is not in the total and makes it partial; a state too old is uncertain', async () => {
    const SOLN = NETWORKS.solana as NetworkDef;
    adapters.solana.balancesDetailed = detailed(SOLN, { native: read({ amount: 3_000_000_000n, height: 300 }) }); // the scripted price list has no SOL
    adapters.ethereum.balancesDetailed = detailed(NETWORKS.ethereum as NetworkDef, { native: read({ amount: ETH / 4n, stale: true }) });
    pf.resetBalanceCache();
    const s = (await get('/api/v1/portfolio')).json.summary;
    expect(s).toMatchObject({ total: '4350.50', complete: false, priced: 4, unpriced: [{ network: 'solana', asset: 'native', symbol: 'SOL' }], uncertain: [{ network: 'ethereum', asset: 'native', reason: 'stale_state' }] });
  });
});

// ================================================================================================================ history
describe('value history: snapshots, ranges, flows, retention', () => {
  const T0 = new Date('2026-11-19T12:00:00.000Z'), min = 60_000, day = 86_400_000;
  const at = (ms: number) => new Date(T0.getTime() + ms);
  beforeEach(async () => { await sql`truncate portfolio_snapshots, portfolio_flows, deposits, proposals restart identity cascade`; holdings(); await db.setSetting('currency', 'USD'); });
  const point = (t: Date, total: string, complete = true, currency = 'USD') => sql`insert into portfolio_snapshots (at, currency, total, complete) values (${t}, ${currency}, ${total}, ${complete})`;

  it('a pass writes one row per currency with its breakdown; an incomplete pass is recorded, flagged, and never charted', async () => {
    expect(await pf.writeSnapshot(at(0))).toEqual({ complete: true, totals: { USD: '4350.50', CAD: '6090.70' } });
    adapters.ethereum.balancesDetailed = async () => { throw new Error('down'); }; pf.resetBalanceCache();
    expect(await pf.writeSnapshot(at(10 * min))).toEqual({ complete: false, totals: { USD: '3850.50', CAD: '5390.70' } }); // 500 USD lower only because a network is down
    holdings();
    expect(await pf.writeSnapshot(at(20 * min))).toMatchObject({ complete: true });
    const rows = await sql`select currency, total::text as total, complete, reasons, breakdown from portfolio_snapshots order by at, currency`;
    expect(rows.map((r: any) => [r.currency, r.total, r.complete])).toEqual([['CAD', '6090.70', true], ['USD', '4350.50', true], ['CAD', '5390.70', false], ['USD', '3850.50', false], ['CAD', '6090.70', true], ['USD', '4350.50', true]]);
    expect(rows[1].breakdown).toEqual([{ symbol: 'ETH', amount: '1.75', value: '3500.00', price: '2000.00000000' }, { symbol: 'BTC', amount: '0.01', value: '600.00', price: '60000.00000000' }, { symbol: 'USDC', amount: '250.5', value: '250.50', price: '1.00000000' }]);
    expect(rows[3].reasons).toEqual([{ kind: 'missing', network: 'ethereum', reason: 'network_unavailable' }]);
    const h = await pf.history('1D', 'USD', at(30 * min));
    expect(h.points).toEqual([{ t: at(0).toISOString(), total: '4350.50' }, { t: at(20 * min).toISOString(), total: '4350.50' }]); // the falsely low point is not drawn
    expect(h.omitted).toEqual({ incomplete: 1 });
    expect(h.valueChange).toEqual({ abs: '0.00', pct: 0 });
  });

  it('ranges select by time, per currency; first, last and the change come from complete points', async () => {
    await point(at(-400 * day), '1000.00'); await point(at(-200 * day), '1500.00'); await point(at(-60 * day), '1800.00'); await point(at(-20 * day), '2000.00');
    await point(at(-5 * day), '2200.00'); await point(at(-12 * 3600_000), '2300.00'); await point(at(-1 * 3600_000), '9.99', false); await point(at(0), '2530.00');
    await point(at(-5 * day), '7777.00', true, 'CAD');
    const first = async (range: any) => { const h = await pf.history(range, 'USD', at(0)); return [h.first?.total, h.last?.total, h.valueChange, h.points.length]; };
    expect(await first('1D')).toEqual(['2300.00', '2530.00', { abs: '230.00', pct: 10 }, 2]);
    expect(await first('1W')).toEqual(['2200.00', '2530.00', { abs: '330.00', pct: 15 }, 3]);
    expect(await first('1M')).toEqual(['2000.00', '2530.00', { abs: '530.00', pct: 26.5 }, 4]);
    expect(await first('3M')).toEqual(['1800.00', '2530.00', { abs: '730.00', pct: 40.5556 }, 5]);
    expect(await first('1Y')).toEqual(['1500.00', '2530.00', { abs: '1030.00', pct: 68.6667 }, 6]);
    expect(await first('ALL')).toEqual(['1000.00', '2530.00', { abs: '1530.00', pct: 153 }, 7]);
    expect((await pf.history('1W', 'CAD', at(0))).points).toEqual([{ t: at(-5 * day).toISOString(), total: '7777.00' }]);
    const empty = await pf.history('1D', 'USD', at(-500 * day));
    expect(empty).toMatchObject({ points: [], first: null, last: null, valueChange: null, estimatedMarketChange: null });
  });

  it('a long series is down-sampled to at most 300 points and keeps its first and its last', async () => {
    await sql`insert into portfolio_snapshots (at, currency, total, complete) select ${at(0)}::timestamptz - (g * interval '10 minutes'), 'USD', 1000 + g, true from generate_series(0, 999) g`;
    const h = await pf.history('1W', 'USD', at(0));
    expect(h.points.length).toBeLessThanOrEqual(pf.HISTORY_MAX_POINTS); expect(h.points.length).toBeGreaterThan(200);
    expect(h.points[0]).toEqual({ t: at(-9990 * min).toISOString(), total: '1999.00' }); expect(h.points.at(-1)).toEqual({ t: at(0).toISOString(), total: '1000.00' });
    expect(h.first!.total).toBe('1999.00'); expect(h.last!.total).toBe('1000.00');
    for (let k = 1; k < h.points.length; k++) expect(h.points[k]!.t > h.points[k - 1]!.t).toBe(true);
  });

  it('a deposit is a flow, not performance: the change of value is given with the net flows and the estimate of the rest', async () => {
    await point(at(-6 * 3600_000), '4000.00'); await point(at(0), '6350.00');
    // inside the period: 1 ETH received from outside (seen and priced at once), 300 USDC sent out, 0.2 ETH withdrawn from the owner's own agent vault
    const depAt = Math.floor(at(-3 * 3600_000).getTime() / 1000), now = at(-3 * 3600_000 + 2 * min);
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address) values (${randomUUID()}, 'a', '[]', '{}', 1, '0x00000000000000000000000000000000000000aa')`;
    const [agent] = await sql`select id from agents`;
    await sql`insert into agent_withdrawals (id, agent_id, network, asset, symbol, decimals, amount, from_addr, to_addr, nonce, state, txid) values (${randomUUID()}, ${agent.id}, 'base', 'native', 'ETH', 18, 1, '0xaa', ${ME}, 1, 'confirmed', '0xw1')`;
    await scan.recordDeposits('base', [{ txid: '0xd1', idx: 1_000_000, asset: 'native', amount: ETH, from: '0xabc', block: 10, time: depAt, via: 'tx' }, { txid: '0xw1', idx: 1_000_000, asset: 'native', amount: ETH / 5n, from: '0xaa', block: 11, time: depAt, via: 'tx' }]);
    const send = (to: string, amount: string, kind = 'transfer') => sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, kind, finalized_at)
      values (${randomUUID()}, ${randomUUID()}, 'finalized', 'base', ${USDC.id}, 'USDC', 6, ${amount}, ${ME}, ${to}, ${kind}, ${now})`;
    await send('0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '300000000');
    await send('0x00000000000000000000000000000000000000AA', '50000000');   // to the agent vault: the owner's own account
    await send('0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '999000000', 'swap'); // a swap is not a flow
    const px = { ETH: { usd: 2000, cad: 2800 }, USDC: { usd: 1, cad: 1.4 } };
    expect(await pf.recordFlows(px, now)).toBe(4);
    expect(await pf.recordFlows(px, now)).toBe(0); // idempotent
    const h = await pf.history('1D', 'USD', at(0));
    expect(h.valueChange).toEqual({ abs: '2350.00', pct: 58.75 });
    expect(h.flows).toEqual({ from: at(-6 * 3600_000).toISOString(), to: at(0).toISOString(), external: { in: '2000.00', out: '300.00', net: '1700.00' }, ownAccounts: { in: '400.00', out: '50.00', net: '350.00' }, net: '2050.00', valued: 4, unvalued: [], complete: true });
    // 2 350 of change, 2 050 of which simply entered: the rest (300) is the estimate of what prices did — never called a return
    expect(h.estimatedMarketChange).toEqual({ abs: '300.00', pct: 7.5, method: 'value_change_minus_net_flows', estimate: true, complete: true });
    expect((await pf.history('1D', 'CAD', at(0))).flows.external).toEqual({ in: '0.00', out: '0.00', net: '0.00' }); // no CAD snapshots: no period, no sums
  });

  it('a flow the API saw long after it happened has no price: listed as not valued, and the estimate says it is partial', async () => {
    await point(at(-6 * day), '1000.00'); await point(at(0), '3000.00');
    await scan.recordDeposits('base', [{ txid: '0xold', idx: 1_000_000, asset: 'native', amount: ETH, from: '0xabc', block: 10, time: Math.floor(at(-3 * day).getTime() / 1000), via: 'aggregate' }]);
    expect(await pf.recordFlows({ ETH: { usd: 2000, cad: 2800 } }, at(0))).toBe(1);
    const h = await pf.history('1W', 'USD', at(0));
    expect(h.flows).toMatchObject({ net: '0.00', valued: 0, complete: false, unvalued: [{ refType: 'deposit', refId: `base:0xold:1000000:native`, direction: 'in', scope: 'external', network: 'base', symbol: 'ETH', amount: '1' }] });
    expect(h.estimatedMarketChange).toMatchObject({ abs: '2000.00', estimate: true, complete: false });
  });

  it('retention: every point for 7 days, one per hour to 90 days, one per day beyond; the kept point is the first complete one', async () => {
    const now = at(0);
    await sql`insert into portfolio_snapshots (at, currency, total, complete) select ${now}::timestamptz - (g * interval '10 minutes'), 'USD', g, (g % 6) <> 0 from generate_series(0, 6 * 24 * 120) g`; // 120 days of 10-minute points; the point on the hour is incomplete
    const before = Number((await sql`select count(*) as n from portfolio_snapshots`)[0].n);
    const removed = await pf.pruneSnapshots(now);
    const A = at(-7 * day), B = at(-90 * day);
    expect(Number((await sql`select count(*) as n from portfolio_snapshots where at >= ${A}`)[0].n)).toBe(6 * 24 * 7 + 1); // the last 7 days: untouched (both ends included)
    const hourly = (await sql`select count(*)::int as n, count(distinct date_trunc('hour', at at time zone 'UTC'))::int as buckets from portfolio_snapshots where at < ${A} and at >= ${B}`)[0];
    expect(hourly.n).toBe(hourly.buckets); expect(hourly.n).toBeGreaterThanOrEqual(24 * 83 - 1); expect(hourly.n).toBeLessThanOrEqual(24 * 83 + 1); // one per hour
    const daily = (await sql`select count(*)::int as n, count(distinct date_trunc('day', at at time zone 'UTC'))::int as buckets from portfolio_snapshots where at < ${B}`)[0];
    expect(daily.n).toBe(daily.buckets); expect(daily.n).toBeGreaterThanOrEqual(30); expect(daily.n).toBeLessThanOrEqual(31); // one per day
    expect(before - removed).toBe(Number((await sql`select count(*) as n from portfolio_snapshots`)[0].n));
    expect((await sql`select bool_and(complete) as ok from portfolio_snapshots where at < ${at(-7 * day)}`)[0].ok).toBe(true); // the incomplete point of each hour was not the one kept
    expect(await pf.pruneSnapshots(now)).toBe(0); // idempotent
  });

  it('GET /api/v1/portfolio/history: the route, its default currency, its validation', async () => {
    await point(new Date(Date.now() - 3600_000), '100.00'); await point(new Date(Date.now() - 60_000), '110.00');
    const r = await get('/api/v1/portfolio/history?range=1D');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ range: '1D', currency: 'USD', first: { total: '100.00' }, last: { total: '110.00' }, valueChange: { abs: '10.00', pct: 10 }, omitted: { incomplete: 0 }, retention: { everyPointDays: 7, hourlyDays: 90, snapshotEveryMinutes: 10 } });
    expect(Object.keys(r.json).sort()).toEqual(['asOf', 'currency', 'estimatedMarketChange', 'first', 'flows', 'last', 'omitted', 'points', 'range', 'retention', 'valueChange']);
    expect((await get('/api/v1/portfolio/history')).json.range).toBe('1W');
    expect((await get('/api/v1/portfolio/history?range=1D&currency=CAD')).json).toMatchObject({ currency: 'CAD', points: [] });
    expect((await get('/api/v1/portfolio/history?range=2D')).status).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/portfolio/history' })).statusCode).toBe(401);
  });
});

// ================================================================================================================ deposits
describe('the deposit pass: native scan state, internal / external, alerts, activity', () => {
  const SWAP_TX = '0x' + 'a1'.repeat(32), EXT_TX = '0x' + 'b2'.repeat(32), NATIVE_TX = '0x' + 'c3'.repeat(32), BLOCK_HASH = '0x' + 'd4'.repeat(32), MINT_TX = '0x' + 'e5'.repeat(32), OUT_TX = 'F6'.repeat(32), LATE_TX = '0x' + '07'.repeat(32);
  let swapId = '', bridgeId = '', xswapId = '', auditFrom = 0;
  const nativeCalls: any[] = [];
  // the bridge and the cross-chain swap carry only what the classification reads (their transaction ids): they are kept in a state
  // the activity list does not show, since this test does not build the rest of their record
  const proposal = async (o: { kind: string; network?: string; txid?: string | null; bridge?: object; xswap?: object }) => { const id = randomUUID();
    await sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, kind, txid, bridge, xswap)
      values (${id}, ${id}, ${o.kind === 'swap' ? 'finalized' : 'draft'}, ${o.network ?? 'base'}, 'native', 'ETH', 18, 1000, ${ME}, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', ${o.kind}, ${o.txid ?? null}, ${o.bridge ? sql.json(o.bridge as never) : null}, ${o.xswap ? sql.json(o.xswap as never) : null})`;
    return id; };
  const dep = async (txid: string) => (await sql`select kind, origin, proposal_id, detection, block_hash from deposits where txid = ${txid}`)[0];

  beforeAll(async () => {
    await sql`truncate portfolio_snapshots, portfolio_flows, deposits, proposals, scan_cursor restart identity cascade`;
    for (const n of NETS) { const a = adapters[n.id]; a.deposits = async () => ({ items: [], cursor: 7, finalizedHeight: 5 }); delete a.nativeDeposits; }
    swapId = await proposal({ kind: 'swap', txid: SWAP_TX });
    bridgeId = await proposal({ kind: 'bridge', network: 'arbitrum', txid: '0x' + '99'.repeat(32), bridge: { toNetwork: 'base', mintTxid: MINT_TX, mintedBy: 'other', phase: 'done' } });
    xswapId = await proposal({ kind: 'xswap', network: 'bitcoin', txid: 'ab'.repeat(32), xswap: { toNetwork: 'base', outTxid: OUT_TX, outKind: 'out' } });
    await dispatcher.tail(); // the alert cursors start at the present
    auditFrom = Number((await sql`select coalesce(max(seq), 0) as m from audit_events`)[0].m);
  });

  it('pass 1: token deposits are classified before their event is written; the native scan takes its baseline', async () => {
    const now = Math.floor(Date.now() / 1000);
    adapters.base.deposits = async (_a: string, cursor: number | null) => ({ cursor: (cursor ?? 100) + 10, finalizedHeight: 1000, items: [
      { txid: SWAP_TX, idx: 3, asset: USDC.id, amount: 5_000_000n, from: '0xrouter', block: 500, time: now },      // the output of the wallet's own swap
      { txid: EXT_TX, idx: 1, asset: USDC.id, amount: 7_000_000n, from: '0xabc', block: 501, time: now },          // someone paid the wallet
      { txid: MINT_TX, idx: 9, asset: USDC.id, amount: 9_000_000n, from: '0x0', block: 502, time: now },           // the mint of the wallet's own bridge, relayed by someone else
      { txid: '0x' + OUT_TX.toLowerCase(), idx: 2, asset: USDC.id, amount: 1_000_000n, from: '0xthor', block: 503, time: now }, // the outbound of its cross-chain swap
      { txid: LATE_TX, idx: 4, asset: USDC.id, amount: 2_000_000n, from: '0xrelayer', block: 504, time: now },      // an own operation whose record arrives later
    ] });
    adapters.base.nativeDeposits = async (addr: string, prev: any, opts: any) => { nativeCalls.push({ addr, prev, own: opts.own });
      if (!prev) return { items: [], state: { block: 988, balance: 3n * ETH, nonce: 5 }, notes: [], calls: 5 };
      return { calls: 60, state: { block: 1200, balance: 4n * ETH, nonce: 6 }, notes: [{ code: 'state_unavailable', fromBlock: 1100, toBlock: 1200, amount: '40', unknownOwnTxs: 0 }, { code: 'budget_exhausted', fromBlock: 1201, toBlock: 1300, amount: '0' }], items: [
        { txid: NATIVE_TX, idx: 1_000_000, asset: 'native', amount: ETH, from: '0xabc', block: 1000, time: now, via: 'tx', blockHash: '0x' + '11'.repeat(32) },
        { txid: SWAP_TX, idx: 1_000_000, asset: 'native', amount: ETH / 2n, from: '0xrouter', block: 1001, time: now, via: 'internal_call', blockHash: '0x' + '12'.repeat(32) },
        { txid: BLOCK_HASH, idx: 1_000_000, asset: 'native', amount: 30n, from: '', block: 1002, time: now, via: 'internal_call', blockHash: BLOCK_HASH },
        { txid: '0x' + '13'.repeat(32), idx: 1_000_001, asset: 'native', amount: 40n, from: '', block: 1200, time: null, via: 'aggregate' }] }; };
    await worker.scanDeposits();
    expect(await dep(SWAP_TX)).toEqual({ kind: 'internal', origin: 'swap', proposal_id: swapId, detection: null, block_hash: null });
    expect(await dep(EXT_TX)).toEqual({ kind: 'external', origin: null, proposal_id: null, detection: null, block_hash: null });
    expect(await dep(MINT_TX)).toMatchObject({ kind: 'internal', origin: 'bridge', proposal_id: bridgeId });
    expect(await dep('0x' + OUT_TX.toLowerCase())).toMatchObject({ kind: 'internal', origin: 'xswap', proposal_id: xswapId });
    expect(await dep(LATE_TX)).toMatchObject({ kind: 'external', proposal_id: null });
    // the native scan ran after the ordinary one, with no previous state, and its baseline is stored for this address
    expect(nativeCalls).toEqual([{ addr: ME, prev: null, own: [SWAP_TX] }]);
    expect((await sql`select cursor::int as cursor, native_cursor::int as native_cursor, native_balance::text as native_balance, native_nonce::int as native_nonce, native_addr from scan_cursor where network = 'base'`)[0])
      .toEqual({ cursor: 110, native_cursor: 988, native_balance: (3n * ETH).toString(), native_nonce: 5, native_addr: ME.toLowerCase() });
    const seen = await sql`select data from audit_events where type = 'deposit.seen' and seq > ${auditFrom} order by seq`;
    expect(seen.map((e: any) => [e.data.txid, e.data.kind, e.data.origin ?? null, e.data.proposal ?? null])).toEqual([[SWAP_TX, 'internal', 'swap', swapId], [EXT_TX, 'external', null, null], [MINT_TX, 'internal', 'bridge', bridgeId], ['0x' + OUT_TX.toLowerCase(), 'internal', 'xswap', xswapId], [LATE_TX, 'external', null, null]]);
  });

  it('`deposit.received` fires for what came from outside and not for the results of the wallet\'s own operations', async () => {
    await dispatcher.tail();
    const alerts = await sql`select kind, subject, params from alerts order by id`;
    expect(alerts.map((a: any) => [a.kind, a.subject.id, a.params.amount])).toEqual([['deposit.received', EXT_TX, '7'], ['deposit.received', LATE_TX, '2']]);
  });

  it('pass 2: the native scan resumes from the stored state; its rows, its notes and the late classification', async () => {
    // the relayer's operation is now recorded by the wallet (an agent-vault withdrawal whose transaction id was written after the deposit was seen)
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address) values (${randomUUID()}, 'b', '[]', '{}', 2, '0x00000000000000000000000000000000000000bb')`;
    await sql`insert into agent_withdrawals (id, agent_id, network, asset, symbol, decimals, amount, from_addr, to_addr, nonce, state, txid) select ${randomUUID()}, id, 'base', ${USDC.id}, 'USDC', 6, 2000000, '0xbb', ${ME}, 1, 'confirmed', ${LATE_TX} from agents where name = 'b'`;
    adapters.base.deposits = async (_a: string, cursor: number | null) => ({ cursor: cursor!, finalizedHeight: 1000, items: [] });
    await worker.scanDeposits();
    expect(nativeCalls[1]).toEqual({ addr: ME, prev: { block: 988, balance: 3n * ETH, nonce: 5 }, own: [SWAP_TX] });
    expect(await dep(NATIVE_TX)).toEqual({ kind: 'external', origin: null, proposal_id: null, detection: 'tx', block_hash: '0x' + '11'.repeat(32) });
    const [swapNative] = await sql`select kind, origin, proposal_id, detection from deposits where txid = ${SWAP_TX} and asset = 'native'`;
    expect(swapNative).toEqual({ kind: 'internal', origin: 'swap', proposal_id: swapId, detection: 'internal_call' }); // a swap paying out the native coin
    expect(await dep(BLOCK_HASH)).toMatchObject({ kind: 'external', detection: 'internal_call', block_hash: BLOCK_HASH });
    expect(await dep('0x' + '13'.repeat(32))).toMatchObject({ kind: 'external', detection: 'aggregate' });
    expect((await sql`select native_cursor::int as c, native_balance::text as b, native_nonce::int as n from scan_cursor where network = 'base'`)[0]).toEqual({ c: 1200, b: (4n * ETH).toString(), n: 6 });
    // what could not be located is in the audit chain; reaching the RPC bound is not an event
    expect((await sql`select data from audit_events where type = 'deposit.native_window'`).map((e: any) => e.data)).toEqual([{ network: 'base', code: 'state_unavailable', fromBlock: 1100, toBlock: 1200, amount: '40', unknownOwnTxs: 0 }]);
    expect(await dep(LATE_TX)).toMatchObject({ kind: 'internal', origin: 'agent_withdrawal', proposal_id: null });
    await dispatcher.tail();
    const alerts = await sql`select subject from alerts where kind = 'deposit.received' order by id`;
    expect(alerts.map((a: any) => a.subject.id)).toEqual([EXT_TX, LATE_TX, NATIVE_TX, BLOCK_HASH, '0x' + '13'.repeat(32)]); // nothing for the swap's native payout
  });

  it('flows: external deposits and own-account withdrawals only; the swap output, the mint and the outbound are not flows', async () => {
    const flows = await sql`select ref_id, direction, scope, symbol, price_usd::float as usd from portfolio_flows order by ref_id`;
    expect(flows.map((f: any) => [f.ref_id.split(':')[1], f.scope, f.symbol])).toEqual([[LATE_TX, 'own_account', 'USDC'], ['0x' + '13'.repeat(32), 'external', 'ETH'], [EXT_TX, 'external', 'USDC'], [NATIVE_TX, 'external', 'ETH'], [BLOCK_HASH, 'external', 'ETH']]);
    expect(flows.find((f: any) => f.ref_id.includes(NATIVE_TX)).usd).toBe(2000); // valued with the price of the pass that saw it
    expect(flows.find((f: any) => f.ref_id.includes('13'.repeat(32))).usd).toBeNull(); // an aggregate has no known time: it is never valued
  });

  it('GET /api/v1/activity: `depositKind`, the link to the operation, and a block link when the transaction is not known', async () => {
    const r = await get('/api/v1/activity?limit=200');
    const rec = (txid: string, asset?: string) => r.json.items.find((x: any) => x.kind === 'receive' && x.txid === txid && (!asset || x.asset === asset));
    expect(rec(EXT_TX)).toMatchObject({ kind: 'receive', id: `base:${EXT_TX}:1`, network: 'base', symbol: 'USDC', amount: '7000000', amountDisplay: '7', from: '0xabc', txid: EXT_TX, explorer: BASE.explorerTx + EXT_TX,
      depositKind: 'external', origin: null, proposalId: null, detection: null, txidIsBlock: false, blockHash: null, block: 501 });
    expect(rec(SWAP_TX, USDC.id)).toMatchObject({ depositKind: 'internal', origin: 'swap', proposalId: swapId });
    expect(rec(SWAP_TX, 'native')).toMatchObject({ depositKind: 'internal', origin: 'swap', proposalId: swapId, detection: 'internal_call', txidIsBlock: false, explorer: BASE.explorerTx + SWAP_TX });
    expect(rec(BLOCK_HASH)).toMatchObject({ depositKind: 'external', detection: 'internal_call', txidIsBlock: true, blockHash: BLOCK_HASH, block: 1002, explorer: 'https://basescan.org/block/1002' });
    expect(rec('0x' + '13'.repeat(32))).toMatchObject({ detection: 'aggregate', txidIsBlock: true, explorer: 'https://basescan.org/block/1200' });
    expect(rec(LATE_TX)).toMatchObject({ depositKind: 'internal', origin: 'agent_withdrawal' });
    // the ids of a token row and of a native row of the same transaction do not collide
    expect(new Set(r.json.items.map((x: any) => x.id)).size).toBe(r.json.items.length);
  });

  it('GET /api/v1/dashboard/activity: the same field in `params` and in the wallet row', async () => {
    const r = await get('/api/v1/dashboard/activity?kind=receive&limit=200');
    expect(r.status).toBe(200);
    const item = (txid: string, asset: string) => r.json.items.find((x: any) => x.txid === txid && x.wallet.asset === asset);
    expect(item(SWAP_TX, USDC.id)).toMatchObject({ kind: 'receive', code: 'wallet.receive', params: { depositKind: 'internal', symbol: 'USDC' }, wallet: { depositKind: 'internal', proposalId: swapId } });
    expect(item(EXT_TX, USDC.id)).toMatchObject({ kind: 'receive', params: { depositKind: 'external' }, wallet: { depositKind: 'external', proposalId: null } });
    expect(r.json.items.every((x: any) => x.params.depositKind === 'internal' || x.params.depositKind === 'external')).toBe(true);
  });

  it('a baseline taken for another address is not reused', async () => {
    await sql`update scan_cursor set native_addr = '0x0000000000000000000000000000000000000001' where network = 'base'`;
    nativeCalls.length = 0;
    adapters.base.nativeDeposits = async (addr: string, prev: any) => { nativeCalls.push({ addr, prev }); return { items: [], state: { block: 1300, balance: 1n, nonce: 9 }, notes: [], calls: 5 }; };
    await worker.scanDeposits();
    expect(nativeCalls).toEqual([{ addr: ME, prev: null }]);
  });
});
