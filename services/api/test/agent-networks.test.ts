// V5 through the real API and a real signer process boundary (own database, own fake JSON-RPC node, no outside network):
// agents on several networks, the tradable-symbols endpoint, vault indices, the gas reserve gate, mandates per network,
// registration of universe-generic strategies (the laboratory is called for real when its environment is installed).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashLegs, DEFAULT_POLICY, getNetwork, hasMarketData, mandateHash, MANDATE_NETWORKS, MARKET_LISTINGS, NETWORKS, tradableSymbols } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), DB_LABEL = 'agent_networks';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const owner = new TestPasskey(RP, ORIGIN);
const LAB = existsSync(join(import.meta.dirname, '../../../research/.venv')); // `cd research && uv sync` (or any `uv run`) creates it
let signerSrv: Server, node: Server, app: any, sql: any, adapters: any, cookie = '';
const gasPrice: Record<string, bigint> = {}; // wei per gas the fake node reports, per network
const native: Record<string, bigint> = {}; // native balance of every vault, per network
const rpcBackup: Record<string, string[]> = {};
const RISK = { maxExposurePct: 80, maxLossPct: 5, maxOrderUsd: 20, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 100 };

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (method !== 'GET') Object.assign(headers, { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' });
  const r = await app.inject({ method, url: `/api/v1${path}`, headers, payload: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const create = (o: Record<string, unknown>) => api('POST', '/agents', { name: 'Agent', interval: '1h', capitalUsdc: '100', risk: RISK, ...o });

beforeAll(async () => {
  const DB = (await createTestDb(DB_LABEL)).name;
  const dir = mkdtempSync(join(tmpdir(), 'spw-v5-agents-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('the-setup-token').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  // a JSON-RPC node that only knows the fee history; the network id is in the path
  node = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b), id = req.url!.slice(1), p = gasPrice[id];
    const result = j.method === 'eth_feeHistory' && p !== undefined ? { baseFeePerGas: Array(21).fill(`0x${p.toString(16)}`), reward: Array(20).fill(['0x0']) } : undefined;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: j.id, result } : { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'not available in this test' } })); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => node.once('listening', r));
  const nodeUrl = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
  for (const id of MANDATE_NETWORKS) { rpcBackup[id] = NETWORKS[id]!.rpc; NETWORKS[id]!.rpc = [`${nodeUrl}/${id}`]; gasPrice[id] = id === 'ethereum' ? 3_000_000_000n : 10_000_000n; } // 0.01 gwei on the cheap networks, 3 gwei on Ethereum (the reserve is cached one minute)
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET,
    SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts');
  sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  await db.setSetting('prices', false); // no outside price feed: prices come from stored candles
  adapters = (await import('../src/chains/index.ts')).adapters;
  for (const id of MANDATE_NETWORKS) adapters[id].balances = async () => ({ native: native[id] ?? 0n });
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  const o = (await api('POST', '/auth/setup/options')).json;
  const s = await api('POST', '/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'the-setup-token' });
  expect(s.status).toBe(200);
  cookie = String(s.setCookie).split(';')[0]!;
  // one fresh hourly bar per symbol, on two sources
  const ts = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000);
  for (const [symbol, close] of Object.entries({ ETH: 2000, LINK: 10, UNI: 5, AAVE: 100, AVAX: 20, BTC: 60_000, POL: 0.5, HYPE: 25, BNB: 600 })) for (const source of ['coinbase', 'kraken'])
    await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values (${source}, ${symbol}, '1h', ${ts}, ${close}, ${close}, ${close}, ${close}, 1)`;
}, 60_000);
afterAll(async () => { for (const [id, rpc] of Object.entries(rpcBackup)) NETWORKS[id]!.rpc = rpc; await app?.close(); signerSrv?.close(); node?.close(); await sql?.end(); });

describe('what an agent can trade, per network', () => {
  it('GET /agents/networks lists the eight networks with cash legs, symbols, representations, data availability and gas', async () => {
    await sql`insert into market_quality (symbol, interval, checked_at, last_ts, fresh, gaps, status) values ('ETH', '1h', now(), now(), true, 0, 'ok'), ('LINK', '1h', now(), now(), false, 3, 'gap')`;
    const r = await api('GET', '/agents/networks');
    expect(r.status).toBe(200);
    expect(r.json.networks.map((n: any) => n.id)).toEqual([...MANDATE_NETWORKS]); // every execution-enabled network, in that order
    expect(r.json.networks.map((n: any) => n.id)).toEqual(expect.arrayContaining(['base', 'ethereum', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche', 'hyperevm']));
    expect(r.json).toMatchObject({ maxSymbols: 12, maxLiveSymbols: 11 });
    const by = Object.fromEntries(r.json.networks.map((n: any) => [n.id, n]));
    expect(by.base).toMatchObject({ name: 'Base', native: 'ETH', enabled: true, defaultCash: 'USDC', feeWarning: false });
    expect(by.base.symbols.map((s: any) => s.symbol)).toEqual(expect.arrayContaining(['ETH', 'LINK', 'AAVE']));
    const eth = by.ethereum.symbols.find((s: any) => s.symbol === 'ETH'), btc = by.ethereum.symbols.find((s: any) => s.symbol === 'BTC');
    expect(eth.representations.map((x: any) => [x.assetSymbol, x.kind])).toEqual([['ETH', 'native'], ['WETH', 'wrapped']]);
    expect(eth).toMatchObject({ defaultAsset: 'native', live: true });
    expect(btc.representations[0]).toMatchObject({ assetSymbol: 'WBTC', name: 'Wrapped Bitcoin', kind: 'wrapped', issuer: expect.stringMatching(/BitGo/) });
    expect(by.ethereum.feeWarning).toBe(true); // always flagged
    expect(by.base.symbols.find((s: any) => s.symbol === 'ETH').data['1h']).toMatchObject({ status: 'ok', fresh: true });
    expect(by.base.symbols.find((s: any) => s.symbol === 'LINK').data['1h']).toMatchObject({ status: 'gap', fresh: false });
    expect(by.base.symbols.find((s: any) => s.symbol === 'AAVE').data).toEqual({ '1h': null, '1d': null }); // no data yet
    expect(by.base.symbols.find((s: any) => s.symbol === 'EUR')).toMatchObject({ live: false, sources: ['bitstamp', 'kraken'] });
    // network by network, exactly what the registry says: the cash legs (by registry id and name), the symbols and their default asset
    for (const id of MANDATE_NETWORKS) { const n = getNetwork(id), legs = cashLegs(n), t = tradableSymbols(n);
      expect(by[id].cash, id).toEqual(legs.map((c) => ({ symbol: c.symbol, asset: c.id, name: c.name })));
      expect(by[id], id).toMatchObject({ enabled: legs.length > 0 && t.length > 0, defaultCash: legs.some((c) => c.symbol === 'USDC') ? 'USDC' : null, native: n.native.symbol });
      expect(by[id].symbols.map((x: any) => [x.symbol, x.defaultAsset, x.live]), id).toEqual(t.map((x) => [x.symbol, x.defaultId, x.live]));
      for (const x of by[id].symbols) for (const rep of x.representations) if (rep.kind === 'wrapped' || rep.kind === 'pegged') expect(rep.issuer, `${id}:${rep.assetSymbol}`).toBeTruthy(); }
    // BNB Smart Chain is enabled since registry v5: Binance-Peg USDC (default) and USDT, named as such
    expect(by.bsc).toMatchObject({ enabled: true, defaultCash: 'USDC', cash: [{ symbol: 'USDC', name: 'Binance-Peg USD Coin' }, { symbol: 'USDT', name: 'Binance-Peg BSC-USD (USDT)' }] });
    expect(by.bsc.symbols.find((x: any) => x.symbol === 'BTC').representations.map((x: any) => x.assetSymbol)).toEqual(['WBTC', 'BTCB']);
    expect(by.bsc.symbols.find((x: any) => x.symbol === 'ETH').representations).toEqual([expect.objectContaining({ assetSymbol: 'ETH', name: 'Binance-Peg Ethereum', kind: 'token' })]); // a token there, not the native coin
    expect(by.ethereum.symbols.find((x: any) => x.symbol === 'BTC').representations.map((x: any) => x.assetSymbol)).toEqual(expect.arrayContaining(['WBTC', 'cbBTC', 'tBTC']));
    for (const id of MANDATE_NETWORKS) for (const x of by[id].symbols) for (const rep of x.representations) expect(['USDC.e', 'USDT0', 'BTC.b', 'WETH.e', 'LINK.e'], `${id}:${rep.assetSymbol}`).not.toContain(rep.assetSymbol); // bridged variants: not offered
    expect(by.avalanche.cash.map((c: any) => c.symbol)).toEqual(['USDC', 'USDT']);
    // gas: 450 000 gas at 0.01 gwei per order; the reserve is the floor of two orders at the policy ceiling
    expect(by.arbitrum.gas).toMatchObject({ perOrder: '0.0000045', gasPriceGwei: 0.01, reserve: '0.0006' });
    expect(by.arbitrum.gas.perOrderUsd).toBeCloseTo(0.009, 6); // priced from the stored ETH candle
    expect(by.polygon.gas.reserve).toBe('1'); // 2 × 0.5 POL
  });
});

describe('agents on several networks', () => {
  let base: any, arb: any, avax: any;
  it('creates agents on Base, Arbitrum and Avalanche: one vault index each, the chosen assets recorded', async () => {
    base = (await create({ name: 'Base five', universe: ['ETH', 'LINK', 'AAVE'] })).json; // network defaults to Base, as before V5
    const r = await create({ name: 'Arb four', network: 'arbitrum', universe: ['ETH', 'LINK', 'UNI', 'AAVE'] });
    expect(r.status).toBe(200); arb = r.json;
    avax = (await create({ name: 'Avax', network: 'avalanche', universe: ['AVAX', 'BTC'], cash: 'USDT' })).json;
    expect([base.network, arb.network, avax.network]).toEqual(['base', 'arbitrum', 'avalanche']);
    expect([base.vaultIndex, arb.vaultIndex, avax.vaultIndex]).toEqual([1, 2, 3]); // never shared: the same index is the same address on every EVM network
    expect(new Set([base.vaultAddress, arb.vaultAddress, avax.vaultAddress]).size).toBe(3);
    expect(arb.vaultAddress).toBe(keys.vault(2).address);
    const A = getNetwork('arbitrum'), id = (s: string) => A.tokens.find((t) => t.symbol === s)!.id;
    expect(arb.holdings.map((h: any) => [h.symbol, h.asset])).toEqual([['USDC', id('USDC')], ['ETH', 'native'], ['LINK', id('LINK')], ['UNI', id('UNI')], ['AAVE', id('AAVE')]]);
    expect(avax.cash).toBe('USDT');
    expect(avax.holdings.map((h: any) => [h.symbol, h.assetSymbol, h.kind])).toEqual([['USDT', 'USDT', 'cash'], ['AVAX', 'AVAX', 'native'], ['BTC', 'WBTC', 'wrapped']]);
    expect(avax.holdings[2].issuer).toMatch(/BitGo/);
    const rows = await sql`select network, cash, assets, vault_index from agents order by vault_index`;
    expect(rows.map((x: any) => [x.network, x.cash])).toEqual([['base', 'USDC'], ['arbitrum', 'USDC'], ['avalanche', 'USDT']]);
    expect(rows[1].assets).toEqual({ ETH: 'native', LINK: id('LINK'), UNI: id('UNI'), AAVE: id('AAVE') }); // recorded: a later registry change cannot move it
    await expect(sql`update agents set vault_index = 1 where id = ${arb.id}`).rejects.toThrow(/unique|duplicate/i); // the database refuses a shared index too
    expect((await api('GET', `/agents/${arb.id}`)).json.vault.map((v: any) => [v.symbol, v.role])).toEqual([['USDC', 'cash'], ['ETH', 'asset'], ['LINK', 'asset'], ['UNI', 'asset'], ['AAVE', 'asset']]);
    const v = (await api('GET', `/agents/${avax.id}`)).json.vault;
    expect(v.map((x: any) => x.assetSymbol)).toEqual(['USDT', 'AVAX', 'WBTC']);
  });

  // v8 hardening (D4): the agent page lists the SIMULATED positions next to the real (empty) vault
  it('GET /agents/:id carries the paper book read-only, apart from the real vault: null before any simulation, never seeded by the read', async () => {
    const before = (await api('GET', `/agents/${base.id}`)).json;
    expect(before.paper).toBeNull();                                                              // never ran on paper: no book
    expect(await sql`select 1 from agent_paper where agent_id = ${base.id}`).toHaveLength(0);      // and the read did not create one
    // a book as the engine leaves it after paper fills: 60 of cash, three symbols (one sold back to zero, one the server cannot price)
    for (const [symbol, units] of [['USDC', 60], ['LINK', 2], ['ETH', 0.01], ['AAVE', 0], ['ZZZ', 5]] as const) await sql`insert into agent_paper (agent_id, symbol, units) values (${base.id}, ${symbol}, ${units})`;
    try {
      const t0 = Date.now(), d = (await api('GET', `/agents/${base.id}`)).json;
      expect(d.paper.positions).toEqual([{ symbol: 'ETH', units: '0.01', usd: 20 }, { symbol: 'LINK', units: '2', usd: 20 }, { symbol: 'ZZZ', units: '5', usd: null }]);   // universe order; no price = null, not 0
      expect(d.paper).toMatchObject({ cashSymbol: 'USDC', cashUsd: 60 });
      expect(d.paper.asOf).toBeGreaterThanOrEqual(t0);
      expect(d.vault.map((x: any) => [x.symbol, x.amount])).toEqual([['USDC', '0'], ['ETH', '0'], ['LINK', '0'], ['AAVE', '0']]);   // the real vault is untouched and still empty
      expect((await sql`select symbol, units from agent_paper where agent_id = ${base.id} order by symbol`).map((r: any) => [r.symbol, r.units])).toEqual([['AAVE', 0], ['ETH', 0.01], ['LINK', 2], ['USDC', 60], ['ZZZ', 5]]);   // read-only
      expect((await api('GET', `/agents/${arb.id}`)).json.paper).toBeNull();                         // another agent's book is its own
    } finally { await sql`delete from agent_paper where agent_id = ${base.id}`; }
  });

  it('refuses what the registry or the listings do not support, with a reason', async () => {
    // derived from the registry, so they stay refusals when it grows: a symbol the exchanges list but that no asset of Base tracks,
    // and a network whose only cash leg is USDC (a bridged USDT0 or USDC.e there is NOT a cash leg)
    const absent = Object.keys(MARKET_LISTINGS).find((x) => /^[A-Z0-9]{2,10}$/.test(x) && hasMarketData(x) && !['USDC', 'USDT'].includes(x) && !tradableSymbols(getNetwork('base')).some((t) => t.symbol === x))!;
    const usdcOnly = getNetwork(MANDATE_NETWORKS.find((id) => cashLegs(getNetwork(id)).map((c) => c.symbol).join() === 'USDC')!);
    expect(absent).toBeTruthy(); expect(usdcOnly.tokens.some((t) => t.symbol === 'USDT0' || t.symbol === 'USDC.e')).toBe(true);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ network: 'solana', universe: ['SOL'] }, /agents trade on Base, Ethereum/],
      [{ network: 'nowhere', universe: ['ETH'] }, /agents trade on/],
      [{ network: 'base', universe: [absent] }, new RegExp(`no asset of the wallet registry tracks ${absent} on Base`)],
      [{ network: 'base', universe: ['NOPE'] }, /no market data/],
      [{ network: usdcOnly.id, universe: [usdcOnly.native.symbol], cash: 'USDT' }, new RegExp(`USDT is not in the wallet registry on ${usdcOnly.name}; choose USDC`)],
      [{ network: 'avalanche', universe: ['ETH'] }, /no asset of the wallet registry tracks ETH on Avalanche/], // WETH.e is not ETH without a reviewed entry
      [{ network: 'avalanche', universe: ['AVAX'], assets: { AVAX: getNetwork('avalanche').tokens.find((t) => t.symbol === 'BTC.b')!.id } }, /does not track/],
      [{ network: 'bsc', universe: ['BNB'], assets: { BNB: getNetwork('bsc').tokens.find((t) => t.symbol === 'ETH')!.id } }, /does not track/], // Binance-Peg ETH is not BNB
      [{ network: 'base', universe: ['ETH', 'ETH'] }, /duplicate/],
      [{ network: 'base', universe: ['USDC'] }, /cash leg/],
      [{ network: 'ethereum', universe: ['ETH'], assets: { ETH: getNetwork('ethereum').tokens.find((t) => t.symbol === 'LINK')!.id } }, /does not track/],
    ];
    for (const [body, why] of cases) { const r = await create(body); expect(r.status, JSON.stringify(body)).toBe(422); expect(r.json.message, JSON.stringify(body)).toMatch(why); }
    expect((await create({ universe: [] })).status).toBe(400);
    expect((await create({ universe: Array.from({ length: 13 }, (_, k) => `S${k}X`) })).status).toBe(400); // 12 symbols at most
    expect((await sql`select count(*)::int as n from agents`)[0].n).toBe(3); // a refused creation takes no vault index
  });

  it('warns — without blocking — when fees eat the orders or a symbol can only be paper traded', async () => {
    // Ethereum at 3 gwei: 0.00135 ETH ≈ 2.70 USD per order, 13.5 % of a 20 USD order
    const r = await create({ name: 'Mainnet small', network: 'ethereum', universe: ['ETH', 'BTC'], assets: { ETH: getNetwork('ethereum').tokens.find((t) => t.symbol === 'WETH')!.id } });
    expect(r.status).toBe(200);
    expect(r.json.holdings.map((h: any) => h.assetSymbol)).toEqual(['USDC', 'WETH', 'WBTC']); // the owner's choice of representation
    expect(r.json.warnings.map((w: any) => w.code)).toEqual(['fees']);
    expect(r.json.warnings[0].message).toMatch(/one order costs about 2\.70 USD in network fees: 13\.5 % of this agent's largest order/);
    const paper = await create({ name: 'Euro', network: 'base', universe: ['ETH', 'EUR'] });
    expect(paper.json.warnings).toEqual([expect.objectContaining({ code: 'paper_only', message: expect.stringMatching(/EUR: not listed on both Coinbase and Kraken/) })]);
    expect(base.warnings).toEqual([]);
    // WETH as ETH: the native coin is then held for gas only, shown apart
    const v = (await api('GET', `/agents/${r.json.id}`)).json.vault;
    expect(v.map((x: any) => [x.symbol, x.assetSymbol, x.role])).toEqual([['USDC', 'USDC', 'cash'], ['ETH', 'WETH', 'asset'], ['BTC', 'WBTC', 'asset'], ['ETH', 'ETH', 'gas']]);
  });

  it('BNB Smart Chain: an 18-decimal cash leg end to end — creation, vault view, mandate caps, signer approval', async () => {
    const B = getNetwork('bsc'), id = (x: string) => B.tokens.find((t) => t.symbol === x)!.id;
    const r = await create({ name: 'BNB three', network: 'bsc', universe: ['BNB', 'ETH', 'BTC'], capitalUsdc: '100' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ network: 'bsc', cash: 'USDC', capitalUsdc: '100' }); // the allocated capital is a USD amount: 100, not 100 × 10^-12
    expect(r.json.holdings.map((h: any) => [h.symbol, h.asset, h.assetSymbol, h.kind])).toEqual([['USDC', id('USDC'), 'USDC', 'cash'], ['BNB', 'native', 'BNB', 'native'], ['ETH', id('ETH'), 'ETH', 'token'], ['BTC', id('WBTC'), 'WBTC', 'wrapped']]);
    expect((await sql`select capital_usdc from agents where id = ${r.json.id}`)[0].capital_usdc).toBe('100000000'); // stored in 6-decimal units by design, whatever the cash leg
    // the vault holds 12.5 USDC (18 decimals) and 0.01 BNB: shown and valued in the asset's own decimals
    const saved = adapters.bsc.balances;
    adapters.bsc.balances = async () => ({ native: 10_000_000_000_000_000n, [id('USDC')]: 12_500_000_000_000_000_000n, [id('WBTC')]: 50_000n });
    try {
      const v = (await api('GET', `/agents/${r.json.id}`)).json.vault;
      expect(v.map((x: any) => [x.symbol, x.display, x.usd])).toEqual([['USDC', '12.5', 12.5], ['BNB', '0.01', 6], ['ETH', '0', 0], ['BTC', '0.0005', 30]]);
      const vid = '7a1c1f0e-8f5f-4b1e-9c56-0000000000b5';
      await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report) values (${vid}, ${r.json.id}, 'ts_momentum', '3', ${'ef'.repeat(32)}, 'strategies/ts_momentum/3', 'approved', '{"metrics":{}}')`;
      await sql`update agents set strategy_version_id = ${vid}, state = 'AWAITING_APPROVAL' where id = ${r.json.id}`;
      const ok = await api('POST', `/agents/${r.json.id}/mandate/prepare`);
      expect(ok.status).toBe(200);
      const m = ok.json.mandate;
      expect(m).toMatchObject({ network: 'bsc', vault: r.json.vaultAddress, provider: 'kyberswap' });
      expect(m.assets).toEqual([id('USDC'), 'native', id('ETH'), id('WBTC')]);
      // RISK: 20 USD per order, 100 USD a day — in base units of each asset: USDC 18 decimals, BNB at 600 USD, Binance-Peg ETH at 2 000 USD, WBTC (8 decimals) at 60 000 USD
      expect(m.maxOrder).toEqual({ [id('USDC')]: '20000000000000000000', native: '33333330000000000', [id('ETH')]: '10000000000000000', [id('WBTC')]: '33333' });
      expect(m.maxDaily[id('USDC')]).toBe('100000000000000000000');
      expect(ok.json.limits.map((l: any) => [l.symbol, l.maxOrder, l.maxDaily])).toEqual([['USDC', '20', '100'], ['BNB', '0.03333333', '0.16666667'], ['ETH', '0.01', '0.05'], ['WBTC (BTC)', '0.00033333', '0.00166667']]);
      expect(ok.json.gasReserve).toMatchObject({ symbol: 'BNB', required: '0.002', held: '0.01' }); // two orders at the policy's fee ceiling for BNB Smart Chain
      const live = await api('POST', `/agents/${r.json.id}/mandate/approve`, { assertion: owner.assert(Buffer.from(ok.json.options.challenge, 'base64url')) });
      expect(live.status).toBe(200); expect(live.json.state).toBe('LIVE'); // the signer validated the same mandate against its own registry
      const st = (await api('GET', `/agents/${r.json.id}`)).json.mandateStatus;
      expect(st).toMatchObject({ active: true, maxOrder: m.maxOrder });
    } finally { adapters.bsc.balances = saved; }
  });

  it('prepares a mandate for the agent\'s own network only with the gas reserve in the vault', async () => {
    const vid = '7a1c1f0e-8f5f-4b1e-9c56-0000000000aa';
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report) values (${vid}, ${arb.id}, 'ts_momentum', '3', ${'ab'.repeat(32)}, 'strategies/ts_momentum/3', 'approved', '{"metrics":{}}')`;
    await sql`update agents set strategy_version_id = ${vid}, state = 'AWAITING_APPROVAL' where id = ${arb.id}`;
    const dry = await api('POST', `/agents/${arb.id}/mandate/prepare`);
    expect(dry.status).toBe(409);
    expect(dry.json).toMatchObject({ error: 'insufficient_gas', message: expect.stringMatching(/the vault holds 0 ETH; live trading on Arbitrum One needs a gas reserve of 0\.0006 ETH/) });
    native.arbitrum = 599_999_999_999_999n; // one wei short
    expect((await api('POST', `/agents/${arb.id}/mandate/prepare`)).status).toBe(409);
    native.arbitrum = 600_000_000_000_000n;
    gasPrice.arbitrum = 1_000_000_000n; // gas rises to 1 gwei: 8 orders × 0.00045 ETH, capped per order by the 0.0003 ETH ceiling → 0.0024 ETH
    await new Promise((r) => setTimeout(r, 10));
    const st = await import('../src/agents/gas.ts');
    expect((await st.gasReserve(getNetwork('arbitrum'), DEFAULT_POLICY.maxFee.arbitrum, Date.now() + 61_000)).reserve).toBe(2_400_000_000_000_000n);
    native.arbitrum = 5_000_000_000_000_000n;
    const ok = await api('POST', `/agents/${arb.id}/mandate/prepare`);
    expect(ok.status).toBe(200);
    const A = getNetwork('arbitrum'), m = ok.json.mandate;
    expect(m).toMatchObject({ network: 'arbitrum', vaultIndex: 2, vault: keys.vault(2).address, provider: 'kyberswap', strategySha256: 'ab'.repeat(32) });
    expect(m.assets).toEqual([cashLegs(A)[0]!.id, 'native', ...['LINK', 'UNI', 'AAVE'].map((s) => A.tokens.find((t) => t.symbol === s)!.id)]);
    expect(m.maxOrder.native).toBe('10000000000000000'); // 20 USD of ETH at 2 000 USD, from the stored candle
    expect(ok.json.limits.map((l: any) => l.symbol)).toEqual(['USDC', 'ETH', 'LINK', 'UNI', 'AAVE']);
    expect(ok.json.gasReserve).toMatchObject({ symbol: 'ETH', held: '0.005' });
    // the signer accepts it for Arbitrum (passkey over the hash) and reports it; then the agent is LIVE
    const live = await api('POST', `/agents/${arb.id}/mandate/approve`, { assertion: owner.assert(Buffer.from(ok.json.options.challenge, 'base64url')) });
    expect(live.status).toBe(200); expect(live.json.state).toBe('LIVE');
    const detail = (await api('GET', `/agents/${arb.id}`)).json;
    expect(detail.mandateStatus).toMatchObject({ active: true });
    // paper-only universes cannot get a mandate at all
    const euro = (await sql`select id from agents where name = 'Euro'`)[0].id;
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report) values (${'7a1c1f0e-8f5f-4b1e-9c56-0000000000ab'}, ${euro}, 'x', '3', ${'cd'.repeat(32)}, 'strategies/ts_momentum/3', 'approved', '{"metrics":{}}')`;
    await sql`update agents set strategy_version_id = ${'7a1c1f0e-8f5f-4b1e-9c56-0000000000ab'} where id = ${euro}`;
    await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values ('kraken', 'EUR', '1h', ${new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000)}, 1.1, 1.1, 1.1, 1.1, 1)`;
    const no = await api('POST', `/agents/${euro}/mandate/prepare`);
    expect(no.status).toBe(422); expect(no.json.error).toBe('no_signer_price');
  });
});

describe.skipIf(!LAB)('registration of library strategies (the laboratory describes them for real)', () => {
  it('GET /strategies reports which versions are universe-generic', async () => {
    const lib = (await api('GET', '/strategies')).json.strategies as any[];
    const of = (name: string, v: string) => lib.find((x) => x.meta.name === name && x.meta.version === v);
    for (const name of ['ts_momentum', 'ma_trend', 'donchian_breakout', 'vol_target_trend', 'mean_reversion', 'xs_momentum']) {
      expect(of(name, '3'), name).toMatchObject({ generic: true, meta: { universe: ['*'] }, maxSymbols: 12 });
      expect(of(name, '1'), name).toMatchObject({ generic: false, minSymbols: 4, maxSymbols: 4 });
      expect(of(name, '3').readme).toMatch(/Universe-generic version/);
    }
    expect(of('xs_momentum', '3').minSymbols).toBe(3); expect(of('ts_momentum', '3').minSymbols).toBe(1);
    expect(of('garch_regime', '1').generic).toBe(false);
  }, 120_000);

  it('accepts a generic strategy for any agent universe, a fixed one only for its own symbols', async () => {
    const two = (await create({ name: 'Two', network: 'optimism', universe: ['ETH', 'UNI'] })).json;
    const four = (await sql`select id from agents where name = 'Arb four'`)[0].id as string;
    await sql`update agents set state = 'STOPPED' where id = ${four}`; // registration is refused on nothing but a bad fit; LIVE is irrelevant here
    const reg = (id: string, path: string) => api('POST', `/agents/${id}/strategies`, { path });
    const fixed = await reg(two.id, 'ts_momentum/1'); // written for ETH, BTC, LINK, SOL
    expect(fixed.status).toBe(422); expect(fixed.json).toMatchObject({ error: 'universe_mismatch', message: expect.stringMatching(/this strategy trades ETH, BTC, LINK, SOL; the agent's assets are ETH, UNI/) });
    const xs = await reg(two.id, 'xs_momentum/3'); // a ranking needs three symbols
    expect(xs.status).toBe(422); expect(xs.json).toMatchObject({ error: 'universe_size', message: expect.stringMatching(/between 3 and 12 symbols; the agent trades 2/) });
    const ok = await reg(two.id, 'ts_momentum/3');
    expect(ok.status).toBe(200); expect(ok.json).toMatchObject({ generic: true, symbols: ['ETH', 'UNI'], status: 'backtesting' });
    const xs4 = await reg(four, 'xs_momentum/3');
    expect(xs4.status).toBe(200); expect(xs4.json.symbols).toEqual(['ETH', 'LINK', 'UNI', 'AAVE']);
    expect((await reg(four, 'ma_trend/2')).json.error).toBe('universe_mismatch'); // ETH, LINK, AAVE: not this agent's four
    const rows = await sql`select meta, code_sha256 from strategy_versions where agent_id = ${two.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ name: 'ts_momentum', version: '3', universe: ['*'], generic: true, symbols: ['ETH', 'UNI'] });
    // the backtest was started with the agent's symbols; there is no history in this database, so it ends without a report and says why
    let v: any;
    for (let k = 0; k < 120; k++) { v = (await sql`select status, notes, report from strategy_versions where agent_id = ${two.id}`)[0]; if (v.status === 'draft' && v.notes) break; await new Promise((r) => setTimeout(r, 500)); }
    expect(v.report).toBeNull(); expect(v.notes).toMatch(/backtest failed/);
    const early = await api('POST', `/agents/${two.id}/strategies/${(await sql`select id from strategy_versions where agent_id = ${two.id}`)[0].id}/approve`);
    expect(early.status).toBe(409); // approval still needs the report
    for (let k = 0; k < 120; k++) { const left = await sql`select 1 from strategy_versions where status = 'backtesting'`; if (!left.length) break; await new Promise((r) => setTimeout(r, 500)); }
  }, 180_000);
});

// =========================================================================================================================
// V11 Phase B — D2 (a mandate must not outlive its agent on the signer), D4 (no approval on a failed look-ahead check)

describe('V11 D2: when an agent leaves LIVE, its mandate is revoked AT THE SIGNER', () => {
  const signerMandates = async () => ((await (await import('../src/signer-client.ts')).signer.status(true)).mandates ?? []) as { mandate: { mandateId: string; vaultIndex: number }; revoked: boolean; expired: boolean; approvedAt: string }[];
  const liveAgain = async (id: string) => {
    const p = await api('POST', `/agents/${id}/mandate/prepare`);
    expect(p.status).toBe(200);
    const r = await api('POST', `/agents/${id}/mandate/approve`, { assertion: owner.assert(Buffer.from(p.json.options.challenge, 'base64url')) });
    expect(r.status).toBe(200); expect(r.json.state).toBe('LIVE');
    return p.json.mandate.mandateId as string;
  };
  /** the Arbitrum agent of the tests above: vault 2, LIVE under its first mandate */
  const arb = { id: '' };
  beforeAll(async () => { arb.id = (await sql`select id from agents where vault_index = 2`)[0].id; });
  const active = async (vault = 2) => (await signerMandates()).filter((m) => m.mandate.vaultIndex === vault && !m.revoked && !m.expired).map((m) => m.mandate.mandateId);

  it('paused or stopped by the owner: revoked on the signer at once; a new mandate is then the only one in force on the vault', async () => {
    // (when the laboratory is installed, the registration test above has set this agent STOPPED in the database: it is made LIVE again here)
    if ((await sql`select state from agents where id = ${arb.id}`)[0].state !== 'LIVE') await liveAgain(arb.id);
    const [row] = await sql`select state, mandate_id from agents where id = ${arb.id}`;
    expect(row.state).toBe('LIVE');
    const first = row.mandate_id as string;
    expect(await active()).toEqual([first]);
    // PAUSED used to leave the mandate in force for up to 90 days
    expect((await api('POST', `/agents/${arb.id}/mode`, { mode: 'PAUSED' })).json.state).toBe('PAUSED');
    expect(await active()).toEqual([]);
    expect((await api('GET', `/agents/${arb.id}`)).json.mandateStatus).toMatchObject({ active: false, revoked: true });
    expect((await sql`select type, actor, data from audit_events where type = 'mandate.revoked' order by seq desc limit 1`)[0]).toMatchObject({ actor: 'engine', data: { agent: arb.id, mandateId: first } });
    // back to paper is allowed now — and signs nothing: the mandate is gone
    expect((await api('POST', `/agents/${arb.id}/mode`, { mode: 'PAPER' })).json.state).toBe('PAPER_TRADING');
    const second = await liveAgain(arb.id);
    expect(second).not.toBe(first);
    expect(await active()).toEqual([second]);
    expect((await api('POST', `/agents/${arb.id}/mode`, { mode: 'STOPPED' })).json.state).toBe('STOPPED');
    expect(await active()).toEqual([]);
    const third = await liveAgain(arb.id);
    expect((await api('POST', `/agents/${arb.id}/mode`, { mode: 'RESEARCH' })).status).toBe(200);
    expect(await active()).toEqual([]);
    expect((await signerMandates()).filter((m) => [first, second, third].includes(m.mandate.mandateId)).every((m) => m.revoked)).toBe(true);
  });

  it('the signer refuses a second mandate on the vault; the approve route ends the previous one first, so a replacement is never two mandates', async () => {
    const one = await liveAgain(arb.id);
    // the API state is forced back (a bug, a restore): the route would let a second mandate be prepared while the first is in force
    await sql`update agents set state = 'PAPER_TRADING' where id = ${arb.id}`;
    const p = await api('POST', `/agents/${arb.id}/mandate/prepare`);
    expect(p.status).toBe(200);
    // straight to the signer, as a compromised API would: refused
    const client = (await import('../src/signer-client.ts')).signer;
    await expect(client.mandateApprove(p.json.mandate, owner.assert(Buffer.from(p.json.options.challenge, 'base64url')))).rejects.toMatchObject({ code: 'signer_conflict' });
    expect(await active()).toEqual([one]);
    // through the route: the previous mandate is revoked first, then the new one is approved
    const r = await api('POST', `/agents/${arb.id}/mandate/approve`, { assertion: owner.assert(Buffer.from(p.json.options.challenge, 'base64url')) });
    expect(r.status).toBe(200);
    expect(await active()).toEqual([p.json.mandate.mandateId]);
  });

  it('stopped by the ENGINE (loss limit, strategy no longer the approved one, expiry): revoked on the signer by the engine itself', async () => {
    const live = await import('../src/agents/live.ts'), engine = await import('../src/agents/engine.ts');
    const [a0] = await sql`select * from agents where id = ${arb.id}`;
    expect(a0.state).toBe('LIVE');
    const bars = Array.from({ length: 60 }, (_, k) => ({ ts: Math.floor(Date.now() / 3_600_000) * 3_600_000 - (60 - k) * 3_600_000, open: 2000, high: 2000, low: 2000, close: 2000, volume: 1 }));
    // 50 USD left of the 100 allocated, all in the cash leg: far past the 5 % loss limit, and nothing left to sell
    const held = (a0.mandate.assets as string[]).map((id, k) => ({ symbol: ['USDC', 'ETH', 'LINK', 'UNI', 'AAVE'][k]!, id, decimals: k === 0 ? 6 : 18, units: k === 0 ? 50 : 0 }));
    const deps = { series: async () => bars, assertFresh: async () => {}, signal: async () => ({}), holdings: async () => held, quote: async () => 0n, placeLive: async () => { throw new Error('no order is expected'); },
      inFlight: async () => false, halted: async () => false, now: () => Date.now(), revokeMandate: async (a: never, reason: string) => { await live.revokeAgentMandate(a, reason); } };
    // (1) loss limit
    expect(await engine.tickAgent(a0, deps as never)).toBe('stopped: loss limit');
    expect((await sql`select state, stop_reason from agents where id = ${arb.id}`)[0]).toMatchObject({ state: 'STOPPED', stop_reason: expect.stringMatching(/^loss limit reached/) });
    expect(await active()).toEqual([]);                                                                                    // before V11 the mandate stayed in force on the signer
    expect((await sql`select data from audit_events where type = 'mandate.revoked' order by seq desc limit 1`)[0].data).toMatchObject({ agent: arb.id, reason: expect.stringMatching(/^loss limit reached/) });
    // (2) the approved code is no longer the code of the mandate
    await liveAgain(arb.id);
    await sql`update strategy_versions set code_sha256 = ${'99'.repeat(32)} where id = (select strategy_version_id from agents where id = ${arb.id})`;
    expect(await engine.tickAgent((await sql`select * from agents where id = ${arb.id}`)[0], deps as never)).toBe('stopped');
    expect(await active()).toEqual([]);
    await sql`update strategy_versions set code_sha256 = ${'ab'.repeat(32)} where id = (select strategy_version_id from agents where id = ${arb.id})`;
    // (3) the engine could not reach the signer when it stopped the agent: the next pass does it (the signer's own list decides)
    const kept = await liveAgain(arb.id);
    await sql`update agents set state = 'STOPPED', stop_reason = 'stopped while the signer was unreachable' where id = ${arb.id}`;
    const down = { status: async () => { throw new Error('unreachable'); }, mandateRevoke: async () => { throw new Error('unreachable'); } };
    expect(await live.revokeAgentMandate({ id: arb.id, mandate_id: kept }, 'x', down)).toBe(false);
    expect(await live.revokeStaleMandates(down)).toEqual([]);
    expect(await active()).toEqual([kept]);
    expect((await sql`select type from audit_events where type = 'mandate.revoke_failed' order by seq desc limit 1`)).toHaveLength(1);
    expect(await live.revokeStaleMandates()).toEqual([kept]);
    expect(await active()).toEqual([]);
    expect(await live.revokeStaleMandates()).toEqual([]);                                                                  // nothing left
  });

  it('a mandate no agent holds (an approval whose answer was lost) is revoked after the grace; a LIVE agent\'s mandate and a just-approved one are left alone', async () => {
    const live = await import('../src/agents/live.ts'), client = (await import('../src/signer-client.ts')).signer;
    const mine = await liveAgain(arb.id);
    // an approval that reached the signer but never the database: vault 7, no agent
    const [a0] = await sql`select * from agents where id = ${arb.id}`;
    const now = Math.floor(Date.now() / 1000), st = await client.status(true);
    const orphan = { ...a0.mandate, mandateId: randomUUID(), vaultIndex: 7, vault: keys.vault(7).address, createdAt: now, expiresAt: now + 86400, keyId: st.keyId };
    await client.mandateApprove(orphan, owner.assert(mandateHash(orphan)));
    expect(await live.revokeStaleMandates(client, Date.now())).toEqual([]);                                                // inside the grace: its database write may still be on its way
    expect(await active(7)).toEqual([orphan.mandateId]);
    expect(await live.revokeStaleMandates(client, Date.now() + 121_000)).toEqual([orphan.mandateId]);
    expect(await active(7)).toEqual([]);
    expect(await active()).toEqual([mine]);                                                                                // the LIVE agent keeps its mandate
    expect((await sql`select state from agents where id = ${arb.id}`)[0].state).toBe('LIVE');
  });
});

describe('V11 D4: a spot strategy is not approved on a failed look-ahead check', () => {
  it('refuses a report whose look-ahead check failed or is missing; approves one that passed', async () => {
    const a = (await create({ name: 'D4', network: 'base', universe: ['ETH'] })).json;
    expect(a.id).toBeTruthy();
    const version = async (report: unknown) => {
      const id = randomUUID();
      await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report) values (${id}, ${a.id}, 'x', ${id.slice(0, 8)}, ${createHash('sha256').update(id).digest('hex')}, 'strategies/ts_momentum/3', 'draft', ${report === null ? null : sql.json(report as never)})`;
      return api('POST', `/agents/${a.id}/strategies/${id}/approve`);
    };
    expect((await version(null)).json).toMatchObject({ error: 'no_report' });
    for (const bad of [{ metrics: {} }, { metrics: {}, checks: {} }, { metrics: {}, checks: { lookahead: 'fail', data_quality: 'pass' } }, { metrics: {}, checks: { lookahead: 'skipped' } }, { metrics: {}, checks: { lookahead: true } }, { metrics: {}, checks: { data_quality: 'pass' } }]) {
      const r = await version(bad);
      expect(r.status, JSON.stringify(bad)).toBe(409);
      expect(r.json).toMatchObject({ error: 'bad_report', message: expect.stringMatching(/look-ahead check did not pass/) });
    }
    expect((await sql`select 1 from strategy_versions where agent_id = ${a.id} and status = 'approved'`)).toHaveLength(0);
    expect((await sql`select strategy_version_id from agents where id = ${a.id}`)[0].strategy_version_id).toBeNull();
    const ok = await version({ metrics: {}, checks: { lookahead: 'pass', data_quality: 'fail' } });
    expect(ok.status).toBe(200); expect(ok.json.state).toBe('AWAITING_APPROVAL');
  });
});
