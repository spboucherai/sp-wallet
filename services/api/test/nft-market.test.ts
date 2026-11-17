// NFT delivery 3 — the market READ layer, without any network and without a database (the routes are in nft-market-api.test.ts).
//
// Fixtures and their provenance (each file says it in its `provenance` field):
//   market-opensea-live.json       LIVE-RECORDED with a key, 2026-11-17 (reference Solana Core item, a listed Solana item, ERC-721, ERC-1155)
//   market-opensea-doc.json        DOCUMENTATION-DERIVED (a 429 that could not be provoked)
//   market-magiceden-live.json     LIVE-RECORDED keyless
//   market-seaport-receipts.json   LIVE-RECORDED keyless (5 mainnet receipts)
//   evm-hints-live.json            LIVE-RECORDED with keys (Alchemy, OpenSea account listing) — no URL kept
// Covered (brief §15): adapters; contradictory sources; stale cache; quota exhaustion; missing provider; a fake badge and a fake
// price never promoted; sale vs transfer; exact currencies (no cross-network mix); big integers; secrets never in an error.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NftProviderError, contradictions, decimalToUnits, money, sameCurrency, traitFrequency, unitsToDecimal, SOL_NATIVE, type CollectionTraits, type ItemMarket, type NftAsset } from '@spw/nft';
import type { ReceiptLog } from '../src/nft/market/seaport.ts';
import type { AbsentProvider, MarketRef, NftMarketProvider } from '../src/nft/market/types.ts';
import { loadFixture, replay, clockOf } from './nft-helpers.ts';

// the modules under test reach config.ts through the store: the environment is set before they load (no database is opened here)
Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { createBudget, providerGet } = await import('../src/nft/market/budget.ts');
const { magicEdenProvider } = await import('../src/nft/market/magiceden.ts');
const { openSeaMarket } = await import('../src/nft/market/opensea.ts');
const { interpretSeaportSale, seaportOrders, SEAPORT_CONTRACTS, solanaMarketProgram, TOPIC_ORDER_FULFILLED } = await import('../src/nft/market/seaport.ts');
const { createMarketService, fiatValue, registrySymbol } = await import('../src/nft/market/service.ts');
const { alchemyHints, openSeaHints, scrubSecrets } = await import('../src/nft/evm-hints.ts');
const { evmProvider } = await import('../src/nft/evm.ts');

const fx = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/nft/${name}.json`, import.meta.url), 'utf8')) as T;
const NOW = new Date('2026-11-17T11:30:00Z'), now = () => NOW;
const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', SOL_LISTED = '8UCVi19cqARoYRy6y2ydmfvm6wNNTSAbenHnM8bHfgce', BAYC = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', MEMES = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const solRef = (mint: string, standard = 'metaplex-core'): MarketRef => ({ key: `sol:solana:${mint}`, family: 'sol', chain: 'solana', standard, contract: null, tokenId: null, mint });
const evmRef = (contract: string, tokenId: string, standard = 'erc721', chain = 'ethereum'): MarketRef => ({ key: `evm:${chain}:${contract}/${tokenId}`, family: 'evm', chain, standard, contract, tokenId, mint: null });
const bigBudget = (id = 'x') => createBudget(id, { perMinute: 10_000, perDay: 100_000 }, { now });
const KEY = 'test-opensea-key-0123456789';
/** the failure of a call that must fail */
const errOf = (p: Promise<unknown>): Promise<NftProviderError> => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as NftProviderError);

// ── OpenSea: an HTTP double that answers the recorded calls and nothing else ────────────────────────────────────────────
const os = fx<{ calls: { path: string; status: number; body: unknown }[]; keyless401: { status: number; body: unknown } }>('market-opensea-live');
const asked: string[] = [];
const osHttp = (extra: Record<string, { status: number; body: unknown; headers?: Record<string, string> }> = {}) => (async (url: string, init?: RequestInit) => {
  expect(url.startsWith('https://api.opensea.io/api/v2/')).toBe(true);                       // the official host and nothing else
  expect(url).not.toContain(KEY);                                                            // the key is never in a URL
  if ((init?.headers as Record<string, string>)['x-api-key'] !== KEY) return new Response(JSON.stringify(os.keyless401.body), { status: 401 });
  const path = url.slice('https://api.opensea.io/api/v2'.length); asked.push(path);
  const c = extra[path] ?? extra['*'] ?? os.calls.find((x) => x.path === path);
  if (!c) throw new Error(`unrecorded OpenSea call ${path}`);
  return new Response(JSON.stringify(c.body), { status: c.status, headers: (c as { headers?: Record<string, string> }).headers });
}) as never;
const opensea = (http = osHttp(), budget = bigBudget('opensea')) => openSeaMarket({ http, now, apiKey: KEY, budget });

describe('model: amounts, currencies, frequencies', () => {
  it('a decimal becomes base units digit by digit — never through a float product; what does not fit is refused, not rounded', () => {
    expect(decimalToUnits(0.36, 6)).toBe('360000'); expect(decimalToUnits('6.049', 18)).toBe('6049000000000000000'); expect(decimalToUnits(8.58608, 9)).toBe('8586080000');
    expect(decimalToUnits(0.1 + 0.2, 18)).toBe('300000000000000040');                         // the double's own decimal text: nothing is "fixed up"
    expect(decimalToUnits(1e-7, 9)).toBe('100'); expect(decimalToUnits('1.5e3', 2)).toBe('150000'); expect(decimalToUnits(1e21, 0)).toBe('1000000000000000000000');
    expect(decimalToUnits('0.1234567', 6)).toBeNull();                                         // more digits than the currency has
    for (const bad of [-1, NaN, Infinity, '1,5', '0x10', '', null, {}, '1e9999']) expect(decimalToUnits(bad, 9), String(bad)).toBeNull();
    expect(decimalToUnits('0', 9)).toBe('0'); expect(decimalToUnits('000.5', 1)).toBe('5');
  });
  it('big integers stay exact (uint256 range) in both directions', () => {
    const max = (2n ** 256n - 1n).toString();
    expect(unitsToDecimal(max, 18)).toBe(`${max.slice(0, -18)}.${max.slice(-18).replace(/0+$/, '')}`);
    expect(money(max, SOL_NATIVE).amount).toBe(max); expect(() => money('1.5', SOL_NATIVE)).toThrow(); expect(() => money('-1', SOL_NATIVE)).toThrow();
    expect(fiatValue('14500000000', 6, '0.999598')).toBe('14494.17');                         // 14 500 USDC × 0.999598, rounded down
    expect(fiatValue(max, 18, '1795.77')).toMatch(/^\d+\.\d{2}$/);
  });
  it('a currency is network + exact asset + decimals: the same symbol or the same address on another network is another currency', () => {
    const usdcSol = { network: 'solana', asset: USDC_SOL, symbol: 'USDC', decimals: 6 }, usdcEth = { network: 'ethereum', asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 };
    expect(sameCurrency(usdcSol, usdcEth)).toBe(false);
    expect(sameCurrency({ network: 'ethereum', asset: WETH, symbol: 'WETH', decimals: 18 }, { network: 'base', asset: WETH, symbol: 'WETH', decimals: 18 })).toBe(false);
    expect(sameCurrency({ network: 'ethereum', asset: WETH.toUpperCase().replace('0X', '0x'), symbol: 'x', decimals: 18 }, { network: 'ethereum', asset: WETH, symbol: 'WETH', decimals: 18 })).toBe(true);
    // the wallet's price symbol comes from the registry by identifier — a marketplace's symbol on an unknown mint gives none
    expect(registrySymbol(usdcSol)).toBe('USDC'); expect(registrySymbol({ network: 'solana', asset: 'FakeUSDC11111111111111111111111111111111111', symbol: 'USDC', decimals: 6 })).toBeNull();
    expect(registrySymbol({ network: 'ethereum', asset: 'native', symbol: 'ETH', decimals: 18 })).toBe('ETH'); expect(registrySymbol({ ...usdcSol, decimals: 9 })).toBeNull();
  });
  it('trait frequency exists only with a stated total: « 20.61 % of 344 673 »; a count above the total is not a frequency', () => {
    const t: CollectionTraits = { total: '344673', categories: [{ type: 'Grader', values: [{ value: 'PSA', count: '71052' }, { value: 'CGC', count: '66452' }] }] };
    expect(traitFrequency(t, 'Grader', 'PSA')).toEqual({ count: '71052', total: '344673', percent: '20.61' });
    expect(traitFrequency(t, 'Grader', 'psa')).toBeNull(); expect(traitFrequency(t, 'Missing', 'x')).toBeNull();
    expect(traitFrequency({ total: '10', categories: [{ type: 'a', values: [{ value: 'b', count: '11' }] }] }, 'a', 'b')).toBeNull();
    expect(traitFrequency({ total: '0', categories: [{ type: 'a', values: [{ value: 'b', count: '0' }] }] }, 'a', 'b')).toBeNull();
    expect(traitFrequency({ total: '8421', categories: [{ type: 'a', values: [{ value: 'b', count: '269' }] }] }, 'a', 'b')!.percent).toBe('3.19');
  });
});

describe('budget and the provider transport', () => {
  it('per-minute and per-day windows; a refused request is not sent; the counters are visible', async () => {
    let t = NOW.getTime(); const clock = () => new Date(t), saved: [string, string, number][] = [];
    const b = createBudget('p', { perMinute: 2, perDay: 3 }, { now: clock, persist: (p, d, u) => saved.push([p, d, u]) });
    let sent = 0; const http = (async () => { sent += 1; return new Response('{}'); }) as never;
    await providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' }); await providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' });
    await expect(providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(sent).toBe(2); expect(b.counter()).toMatchObject({ minute: { used: 2, limit: 2 }, day: { used: 2, limit: 3 }, refused: 1 });
    t += 61_000; await providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' });
    t += 61_000; await expect(providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' })).rejects.toThrow(/per_day/);
    expect(sent).toBe(3); expect(saved.at(-1)).toEqual(['p', '2026-11-17', 3]);
    t += 24 * 3600_000; await providerGet({ provider: 'p', budget: b, http, url: 'https://x.example/a' });                // a new day
    expect(b.counter().day).toMatchObject({ used: 1, date: '2026-11-18' });
    const r = createBudget('p', { perMinute: 9, perDay: 3 }, { now: () => NOW }); r.restore('2026-11-17', 3);              // a restart does not reset the day
    expect(() => r.take()).toThrow(/per_day/);
  });
  it('an upstream 429 pauses the provider; failures are stable codes — never a URL, a header or a body', async () => {
    let t = NOW.getTime(); const b = createBudget('p', { perMinute: 100, perDay: 1000 }, { now: () => new Date(t) });
    const secret = 'sk-SECRET-123456', url = `https://api.example/v1/thing?apikey=${secret}`;
    const run = (http: unknown) => errOf(providerGet({ provider: 'p', budget: b, http: http as never, url, headers: { 'x-api-key': secret } }));
    const e429 = await run(async () => new Response(`slow down ${secret}`, { status: 429 }));
    expect(e429.code).toBe('provider_rate_limited'); expect((await run(async () => new Response('{}'))).code).toBe('budget_exhausted'); expect(b.counter().upstreamLimited).toBe(1);
    t += 61_000;
    const errs = [e429, await run(async () => { throw new Error(`connect ECONNREFUSED ${url}`); }), await run(async () => new Response(`<html>${secret}</html>`, { status: 500 })), await run(async () => new Response(`not json ${secret}`)),
      await run(async () => new Response('{}', { status: 401 })), await run(async () => new Response('{}', { status: 404 })), await run(async () => new Response('x'.repeat(2_100_000)))];
    expect(errs.map((e) => e.code)).toEqual(['provider_rate_limited', 'provider_unavailable', 'provider_unavailable', 'provider_bad_answer', 'provider_not_configured', 'not_found', 'provider_bad_answer']);
    for (const e of errs) { expect(e).toBeInstanceOf(NftProviderError); expect(`${e.message} ${e.stack} ${JSON.stringify(e)}`).not.toContain('SECRET'); expect(e.message).not.toContain('api.example'); }
  });
});

describe('OpenSea adapter (live-recorded with a key)', () => {
  it('the reference Core item: not listed, no offer — and a real last sale in USDC, with the exact mint; verified BY OpenSea; nothing invented', async () => {
    const m = await opensea().item(solRef(REF));
    expect(m.listed).toEqual({ state: 'known', value: false }); expect(m.ask.state).toBe('none'); expect(m.bestOffer.state).toBe('none');
    expect(m.lastSale).toMatchObject({ state: 'known', value: { price: { amount: '14500000000', precision: 'exact', currency: { network: 'solana', asset: USDC_SOL, symbol: 'USDC', decimals: 6 } }, at: '2026-11-10T16:38:56.000Z',
      tx: '2BPek83JWw4EkJFnut4bMfLEh9f3GxdoCWaYQ8eezrvvKD3FLnVoVwfgx5QLb4KhVAX4i6ucyidnugD8HXxsTgLp', buyer: '8d56BJgENF7v9A6YJnMinXqrQb7KKLxMhe3WmUf1Pa4N', seller: 'H7NdPnwqwQkv2XdJaAWAEb3yH9Eg6YTkkwfX5Cz5Wyek' } });
    expect(m.collection).toEqual({ slug: 'phygitals', name: 'Phygitals' }); expect(m.verification).toEqual({ state: 'verified', providerValue: 'verified', by: 'OpenSea' });
    expect(m.rarity.state).toBe('none'); expect(m.flags.suspicious).toEqual({ state: 'known', value: false });
    expect(m.url).toBe(`https://opensea.io/assets/solana/${REF}/${REF}`);
    expect(m.collectionFloor.state).toBe('unknown');                                           // the floor belongs to the collection answer, not copied onto an item
  });
  it('a listed Solana item: the price is named by SYMBOL — tied to an exact mint only through the collection\'s own pricing currency (same source)', async () => {
    const m = await opensea().item(solRef(SOL_LISTED));
    expect(m.listed).toEqual({ state: 'known', value: true });
    expect(m.ask).toMatchObject({ state: 'known', value: { price: { amount: '360000', currency: { network: 'solana', asset: USDC_SOL, decimals: 6 } }, seller: 'BikuW9BejshrnjPcajHBdHMwKSSpGaSo13nUKAq8PHKR', protocol: { name: 'os_tensor', address: '7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V' }, quantity: '1' } });
    expect(m.lastSale).toMatchObject({ state: 'known', value: { price: { amount: '100000' } } });
    // the same listing when the collection answer is not available: the symbol alone identifies no currency → unknown, never a guess
    const m2 = await opensea(osHttp({ '/collections/phygitals': { status: 500, body: {} } })).item(solRef(SOL_LISTED));
    expect(m2.listed).toEqual({ state: 'known', value: true }); expect(m2.ask).toEqual({ state: 'unknown', reason: 'currency_symbol_only' }); expect(m2.verification).toBeNull();
  });
  it('ERC-721: a best offer in WETH (by contract), a rank only with the named method and its denominator; a listing in native ETH with what goes to others', async () => {
    const a = await opensea().item(evmRef(BAYC, '1'));
    expect(a.listed).toEqual({ state: 'known', value: false }); expect(a.lastSale.state).toBe('none');
    expect(a.bestOffer).toMatchObject({ state: 'known', value: { price: { amount: '8030000000000000000', currency: { network: 'ethereum', asset: WETH, symbol: 'WETH', decimals: 18 } }, bidder: '0x421f26be890341fa59d4b1427a0b59245a66ae29', scope: 'item', orderId: '0xaf79c3c8d03cfcbab6d1382c7eeeab18d83e1889d902c7f48cd68c8c3ddd36a2' } });
    expect(a.rarity).toMatchObject({ state: 'known', value: { rank: '2664', outOf: '9996', method: 'openrarity 1.0' } });
    const b = await opensea().item(evmRef(BAYC, '4339'));
    expect(b.ask).toMatchObject({ state: 'known', value: { price: { amount: '6049000000000000000', currency: { network: 'ethereum', asset: 'native', symbol: 'ETH', decimals: 18 } }, seller: '0x625202e9583039bd61cf599593d269b70521bfa1', protocol: { name: 'seaport', address: '0x0000000000000068f116a894984e2db1123eb395' },
      fees: [{ kind: 'other', amount: { amount: '60490000000000000' }, recipient: '0x0000a26b00c1f0df003000390027140000faa719' }] } });
    expect(b.lastSale).toMatchObject({ state: 'known', value: { price: { amount: '6000000000000000000', currency: { asset: WETH } }, tx: '0x871281da374119d37ca47ac90b75ae8d9035a9023210cb89c3b9535a44f8e082' } });
  });
  it('ERC-1155: listing, offer and a sale; the offers list and its filter by type', async () => {
    const m = await opensea().item(evmRef(MEMES, '501', 'erc1155'));
    expect(m.ask).toMatchObject({ state: 'known', value: { price: { amount: '66900000000000000' } } }); expect(m.bestOffer.state).toBe('known');
    expect(m.lastSale).toMatchObject({ state: 'known', value: { price: { amount: '52000000000000000', currency: { asset: 'native' } }, buyer: '0xbf6ccf49cc2874f01916d747a8fe97f14a082be0' } });
    const offers = await opensea().offers!(evmRef(BAYC, '1'), null);
    expect(offers.items.length).toBeGreaterThan(0); for (const o of offers.items) { expect(o.price.currency.asset).toBe(WETH); expect(o.price.amount).toMatch(/^[1-9]\d+$/); }
    const ev = await opensea().events!(evmRef(BAYC, '1'), { cursor: null, types: ['offer'], after: null, before: null, limit: 10 });
    expect(ev.items.every((e) => e.type === 'offer' && e.providerType === 'order:item_offer' && e.to === null && e.flags.washTrade.state === 'unknown')).toBe(true); expect(ev.items).toHaveLength(10);
  });
  it('market events of the reference item: ONE sale with its payment; transfers carry no price; no cancellation is ever produced', async () => {
    const ev = await opensea().events!(solRef(REF), { cursor: null, types: null, after: null, before: null, limit: 20 });
    const sales = ev.items.filter((e) => e.type === 'sale');
    expect(sales).toHaveLength(1); expect(sales[0]!.price).toMatchObject({ amount: '14500000000', currency: { asset: USDC_SOL } });
    const transfers = ev.items.filter((e) => e.type === 'transfer');
    expect(transfers.length).toBe(17); expect(transfers.every((e) => e.price === null && e.from && e.to)).toBe(true);
    expect(ev.items.some((e) => e.type === 'delist' || e.type === 'cancel-offer')).toBe(false); expect(typeof ev.cursor).toBe('string');
    expect((await opensea().events!(solRef(REF), { cursor: null, types: ['delist'], after: null, before: null, limit: 20 })).items).toEqual([]);  // not served: nothing is asked, nothing is made up
  });
  it('a collection: floor in the listing currency (exact mint), volumes named by symbol kept AS REPORTED, fees as given, trait counts with their denominator', async () => {
    const c = await opensea().collection!({ chain: 'solana', slug: 'phygitals' });
    expect(c.verification).toMatchObject({ state: 'verified', by: 'OpenSea' }); expect(c.totalSupply).toEqual({ state: 'known', value: '344673' }); expect(c.owners).toEqual({ state: 'known', value: '31787' });
    expect(c.floor).toEqual({ state: 'known', value: { amount: '360000', precision: 'source_decimal', currency: { network: 'solana', asset: USDC_SOL, symbol: 'USDC', decimals: 6 } } });
    // the volume of this SOLANA collection is reported "in ETH": a symbol with no network — it is shown as reported, attached to no currency
    expect(c.volumes[0]).toMatchObject({ interval: 'all', volume: null, reported: { symbol: 'ETH' }, sales: '89244' }); expect(c.volumes.map((v) => v.interval)).toEqual(['all', '1d', '7d', '30d']);
    expect(c.fees).toEqual([{ kind: 'other', bps: 100, amount: null, recipient: '0x0000a26b00c1f0df003000390027140000faa719', required: true }]);
    expect(c.traits.state).toBe('known'); const t = (c.traits as { value: CollectionTraits }).value;
    expect(traitFrequency(t, 'Grader', 'PSA')).toEqual({ count: '71052', total: '344673', percent: '20.61' }); expect(traitFrequency(t, 'Name', 'Pikachu')!.count).toBe('3014');
    expect(c.imageUrl).toMatch(/^https:\/\/i2c\.seadn\.io\//); expect(c.definitions.floor).toContain('cheapest current listing');
    const e = await opensea().collection!({ chain: 'ethereum', slug: 'thememes6529' });
    expect(e.floor).toMatchObject({ state: 'known', value: { amount: '26888888888000000', currency: { asset: 'native', symbol: 'ETH' }, precision: 'source_decimal' } });
    expect(e.volumes[0]!.volume).toMatchObject({ currency: { network: 'ethereum', asset: 'native' } }); expect(e.fees!.map((f) => [f.bps, f.required])).toEqual([[100, true], [690, false]]);
    expect(e.traits).toEqual({ state: 'unknown', reason: 'trait_counts_unavailable' });      // no trait document recorded for it: not computed
  });
  it('coverage, a fake answer, a missing key, the rate limit', async () => {
    const p = opensea();
    expect(p.notCovered(evmRef(BAYC, '1', 'erc721', 'bsc'))).toBe('chain_not_covered'); expect(p.notCovered(solRef(REF, 'metaplex-bubblegum'))).toBe('standard_not_covered'); expect(p.notCovered(solRef(REF))).toBeNull();
    await expect(opensea().item(evmRef(BAYC, '99999999'))).rejects.toThrow(/unrecorded|provider_unavailable/);
    // the provider answers ANOTHER asset than the one asked (a compromised or confused source): refused, never displayed
    const other = os.calls.find((c) => c.path.endsWith(`/nfts/${SOL_LISTED}`))!;
    await expect(opensea(osHttp({ [`/chain/solana/contract/${REF}/nfts/${REF}`]: other })).item(solRef(REF))).rejects.toMatchObject({ code: 'provider_bad_answer' });
    await expect(opensea().collection!({ chain: 'solana', slug: 'this-collection-does-not-exist-spw' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(opensea().collection!({ chain: 'solana', slug: '../../etc' })).rejects.toMatchObject({ code: 'bad_identifier' });
    const noKey = openSeaMarket({ http: osHttp(), now, apiKey: 'wrong-key-000000', budget: bigBudget() });
    await expect(noKey.item(solRef(REF))).rejects.toMatchObject({ code: 'provider_not_configured' });
    const doc = fx<{ calls: { status: number; headers: Record<string, string>; body: unknown }[] }>('market-opensea-doc').calls[0]!, b = bigBudget('opensea');
    const limited = await errOf(opensea(osHttp({ '*': doc }), b).item(solRef(REF)));
    expect(limited.code).toBe('provider_rate_limited'); expect(b.counter().upstreamLimited).toBe(1); expect(`${limited.message}${limited.stack}`).not.toContain(KEY);
  });
});

describe('Magic Eden adapter (live-recorded keyless)', () => {
  const me = fx<{ calls: { url: string; status: number; body: unknown }[] }>('market-magiceden-live');
  const http = (async (url: string) => { const c = me.calls.find((x) => x.url.split('?')[0] === url.split('?')[0]); if (!c) throw new Error(`unrecorded ${url}`); return new Response(JSON.stringify(c.body), { status: c.status }); }) as never;
  const p = magicEdenProvider({ http, now, budget: bigBudget('magiceden') });
  it('the reference item: unlisted, no offer, no activity on this marketplace — which reports no sale of it (OpenSea does: two markets, two statements)', async () => {
    const m = await p.item(solRef(REF));
    expect(m.listed).toEqual({ state: 'known', value: false }); expect(m.ask.state).toBe('none'); expect(m.bestOffer.state).toBe('none'); expect(m.lastSale.state).toBe('none');
    expect(m.collection).toEqual({ slug: 'phygitals___', name: 'Phygitals' }); expect(m.collectionFloor).toEqual({ state: 'known', value: { amount: '4000000', currency: SOL_NATIVE, precision: 'exact' } });
    expect(m.verification).toBeNull(); expect(m.rarity.state).toBe('unknown');
  });
  it('a listed item: exact lamports that agree with the decimal; expired offers are not "the best offer"; an activity\'s mis-scaled rawAmount is never used', async () => {
    const mint = 'GZyHkx77yWjomRtVxyVW84Qso9AU574y7kN5KZzD2CjX', m = await p.item(solRef(mint, 'metaplex-pnft'));
    expect(m.listed).toEqual({ state: 'known', value: true }); expect(m.ask).toMatchObject({ state: 'known', value: { price: { amount: '8890000000', precision: 'exact', currency: SOL_NATIVE }, protocol: { name: 'magiceden_v2' } } });
    const raw = me.calls.find((c) => c.url.includes(`${mint}/offers_received`))!.body as { price: number; expiry: number }[];
    const live = raw.filter((o) => o.expiry > NOW.getTime() / 1000 || o.expiry <= 0);
    expect(raw.length).toBeGreaterThan(live.length);                                           // the answer does contain expired offers
    if (live.length) expect(m.bestOffer).toMatchObject({ state: 'known', value: { price: { amount: decimalToUnits(Math.max(...live.map((o) => o.price)), 9), precision: 'source_decimal' } } }); else expect(m.bestOffer.state).toBe('none');
    const ev = await p.events!(solRef(mint), { cursor: null, types: null, after: null, before: null, limit: 100 });
    expect(new Set(ev.items.map((e) => e.type)).has('list')).toBe(true);
    for (const e of ev.items.filter((x) => x.price)) { expect(e.price!.precision).toBe('source_decimal'); expect(BigInt(e.price!.amount) < 10n ** 15n).toBe(true); } // lamports, not the ×10^18 figure of the answer
    expect((await p.events!(solRef(mint), { cursor: null, types: ['sale'], after: null, before: null, limit: 100 })).items.every((e) => e.type === 'sale')).toBe(true);
    const c = await p.collection!({ chain: 'solana', slug: 'mad_lads' });
    expect(c.floor).toMatchObject({ state: 'known', value: { amount: '8890000000' } }); expect(c.volumes[0]!.volume).toBeNull(); // 518825709999.99994 is not a whole number of lamports: not kept
    expect(c.traits).toEqual({ state: 'unknown', reason: 'no_stated_item_total' }); expect(c.verification).toBeNull();
  });
  it('listing fields that disagree with each other give no price', async () => {
    const mint = '9c6YJfF47QEJvHfWUA9QGjfymcX4r5mq57Kikx3MwHAL', bad = JSON.parse(JSON.stringify(me.calls.find((c) => c.url.endsWith(`${mint}/listings`))!.body)) as { price: number }[];
    bad[0]!.price = 4;                                                                         // 4 SOL, while rawAmount says 0.004 SOL
    const h = (async (url: string) => new Response(JSON.stringify(url.endsWith('/listings') ? bad : url.endsWith(mint) ? { mintAddress: mint, listStatus: 'listed', collection: 'phygitals___', owner: 'x' } : []), { status: 200 })) as never;
    expect((await magicEdenProvider({ http: h, now, budget: bigBudget() }).item(solRef(mint))).ask).toEqual({ state: 'unknown', reason: 'source_fields_disagree' });
    expect(p.notCovered(evmRef(BAYC, '1'))).toBe('chain_not_covered'); expect(p.notCovered(solRef(REF, 'metaplex-bubblegum'))).toBe('standard_not_covered');
  });
});

describe('sale interpretation from a transaction (Seaport, keyless) — and what is NOT a sale', () => {
  const rc = fx<{ receipts: { name: string; tx: string; logs: ReceiptLog[] }[] }>('market-seaport-receipts'), logs = (n: string) => rc.receipts.find((r) => r.name === n)!.logs;
  /** addresses are compared without their checksum case */
  const low = <T>(x: T): T => JSON.parse(JSON.stringify(x).toLowerCase()) as T;
  const sale = (...a: Parameters<typeof interpretSeaportSale>) => low(interpretSeaportSale(...a));
  const F = '0x0000a26b00c1F0DF003000390027140000fAa719', APES = '0x60E4d786628Fea6478F785A6d7e704777c86a7c6';
  it('the event topic and the recognised contracts are the sourced ones', () => {
    expect(TOPIC_ORDER_FULFILLED).toBe('0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31');
    expect(SEAPORT_CONTRACTS.find((c) => c.version === '1.6')).toMatchObject({ address: '0x0000000000000068F116a894984e2DB1123eB395' }); expect(SEAPORT_CONTRACTS.find((c) => c.version === '1.5')!.networks).not.toContain('hyperevm');
    expect(seaportOrders('ethereum', logs('4-bulk'))).toHaveLength(3);
  });
  it('a listing filled for native ETH: price = everything the buyer paid; the parties are those of the token\'s own Transfer log', () => {
    expect(sale('ethereum', logs('1'), { contract: APES, tokenId: '3806', standard: 'erc721' })).toMatchObject({ side: 'listing', amount: '1090000000000000000', token: 'native', quantity: '1',
      seller: '0xdce67c79937453bc7801bfba56c399d798943b3f', buyer: '0x44dda7c0915c2523d0ed7957785132e76b3483e4', seaport: { version: '1.6' }, fees: [{ recipient: F.toLowerCase(), amount: '10900000000000000' }] });
  });
  it('an accepted WETH offer: the roles are inverted (the offerer is the BUYER), the fee comes out of the seller\'s proceeds', () => {
    expect(sale('ethereum', logs('2'), { contract: '0x259619951adc9cb843a884e756f68b31bde3b4fc', tokenId: '157', standard: 'erc721' })).toMatchObject({ side: 'offer', amount: '800000000000000', token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      buyer: '0x4a1ed406e00cf85d8e538c581fc659a083c5ad4c', seller: '0xf9cb18d9a84e91aa2dd8386f20bc2685f59c75c8', fees: [{ recipient: F.toLowerCase(), amount: '8000000000000' }] });
  });
  it('matched orders emit two events for ONE sale: it is counted once, at what the buyer paid', () => {
    const s = sale('ethereum', logs('3-match'), { contract: APES, tokenId: '6099', standard: 'erc721' });
    expect(s).toMatchObject({ side: 'offer', amount: '1010000000000000000', buyer: '0xa7a7f03a05ef4f360cc36d94a9f8157067c4f33c', seller: '0x020ca66c30bec2c4fe3861a94e4db4a498a35872' });
  });
  it('a bulk purchase: each token has its own price; a token that is not in the transaction has none', () => {
    const c = '0x920a8d9e9f0defd6f86e4388a5503b04cac83b57';
    const three = ['5662', '8575', '12852'].map((id) => sale('ethereum', logs('4-bulk'), { contract: c, tokenId: id, standard: 'erc721' }));
    expect(three.every((s) => s && s.side === 'listing' && s.buyer === '0xe7c692c29450554f18ee5ac781d670de54e09564')).toBe(true);
    expect(three.reduce((t, s) => t + BigInt(s!.amount), 0n)).toBeLessThanOrEqual(6111099999960000n);
    expect(interpretSeaportSale('ethereum', logs('4-bulk'), { contract: c, tokenId: '1', standard: 'erc721' })).toBeNull();
  });
  it('ERC-1155 — and the figure equals what OpenSea itself reports for the same transaction (two independent readings agree)', () => {
    const s = sale('ethereum', logs('5-erc1155'), { contract: MEMES, tokenId: '501', standard: 'erc1155' })!;
    expect(s).toMatchObject({ amount: '52000000000000000', token: 'native', quantity: '1', seller: '0xc5af7c22ce278cc5ffc008a59612d4db8bd14c7c', buyer: '0xbf6ccf49cc2874f01916d747a8fe97f14a082be0' });
    const reported = (os.calls.find((c) => c.path.includes(`${MEMES}/nfts/501?event_type=sale`))!.body as { asset_events: { transaction: string; payment: { quantity: string } }[] }).asset_events[0]!;
    expect(reported.transaction).toBe(rc.receipts.find((r) => r.name === '5-erc1155')!.tx); expect(reported.payment.quantity).toBe(s.amount);
  });
  it('never a sale: a bare transfer; the same event from an unknown contract (a fake marketplace); the wrong network; the wrong standard; a tampered payment', () => {
    const l = logs('1'), a = { contract: APES, tokenId: '3806', standard: 'erc721' as const };
    expect(interpretSeaportSale('ethereum', l.filter((x) => x.topics[0] !== TOPIC_ORDER_FULFILLED), a)).toBeNull();
    expect(interpretSeaportSale('ethereum', l.map((x) => (x.topics[0] === TOPIC_ORDER_FULFILLED ? { ...x, address: '0x1111111111111111111111111111111111111111' } : x)), a)).toBeNull();
    expect(interpretSeaportSale('hyperevm', l.map((x) => (x.topics[0] === TOPIC_ORDER_FULFILLED ? { ...x, address: '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC' } : x)), a)).toBeNull();
    expect(interpretSeaportSale('ethereum', l, { ...a, standard: 'erc1155' })).toBeNull(); expect(interpretSeaportSale('ethereum', l, { ...a, tokenId: '3807' })).toBeNull();
    expect(interpretSeaportSale('ethereum', l.filter((x) => x.address.toLowerCase() !== APES.toLowerCase()), a)).toBeNull();     // the order without the token's transfer
    expect(interpretSeaportSale('ethereum', l.map((x) => (x.topics[0] === TOPIC_ORDER_FULFILLED ? { ...x, data: `${x.data.slice(0, 200)}ff${x.data.slice(202)}` } : x)), a)).toBeNull(); // does not decode
    expect(interpretSeaportSale('ethereum', [...l, ...l.filter((x) => x.address.toLowerCase() === APES.toLowerCase())], a)).toBeNull();                                     // two transfers of the token: not one sale
  });
  it('in the EVM activity: the transfer stays a transfer WITHOUT a price; the sale is a second event, labelled as interpreted by SP Wallet — and absent when the receipt has no Seaport event', async () => {
    const r1 = rc.receipts.find((r) => r.name === '1')! as { name: string; tx: string; blockNumber: string; blockHash: string; logs: (ReceiptLog & { transactionHash: string; blockNumber: string; blockHash: string })[] };
    const transfer = r1.logs.find((l) => l.address.toLowerCase() === APES.toLowerCase() && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')!; // the Transfer log (an Approval log precedes it)
    const events = async (withSeaport: boolean, withHints = false) => {
      const rpc = async (_u: string, method: string, params: unknown) => {
        if (method === 'eth_blockNumber') return `0x${(BigInt(r1.blockNumber) + 100n).toString(16)}`;
        if (method === 'eth_getLogs') return withHints ? [] : [transfer];
        if (method === 'eth_getTransactionReceipt') { expect((params as string[])[0]).toBe(r1.tx); return { blockNumber: r1.blockNumber, blockHash: r1.blockHash, logs: withSeaport ? r1.logs : r1.logs.filter((l) => l.topics[0] !== TOPIC_ORDER_FULFILLED) }; }
        throw new Error(`unexpected ${method}`);
      };
      const hints = withHints ? [{ id: 'alchemy', name: 'Alchemy', unlockedBy: 'ALCHEMY_API_KEY', notCovered: () => null, host: () => 'eth-mainnet.g.alchemy.com', list: async () => ({ hints: [], truncated: false }), history: async () => [{ tx: r1.tx, block: BigInt(r1.blockNumber).toString() }] }] : [];
      const p = evmProvider({ rpc, now, indexers: {}, http: (async () => { throw new Error('none'); }) as never, hints });
      return p.events({ key: `evm:ethereum:${APES.toLowerCase()}/3806`, family: 'evm', chainId: 'ethereum', standard: 'erc721', contractAddress: APES, tokenId: '3806', ownerAddress: withHints ? '0x44DDA7C0915c2523d0eD7957785132e76b3483E4' : null } as NftAsset, null);
    };
    const page = await events(true), t = page.events.find((e) => e.type === 'transfer')!, s = page.events.find((e) => e.type === 'sale')!;
    expect(page.events).toHaveLength(2); expect(t.price).toBeNull(); expect(t.interpretation.by).toBe('spw:evm-transfer-log');
    expect(s).toMatchObject({ tx: r1.tx, quantity: '1', price: { amount: '1090000000000000000', currency: { network: 'ethereum', asset: 'native', symbol: 'ETH', decimals: 18 } }, interpretation: { by: 'spw:seaport-order-fulfilled' }, market: { provider: 'spw-seaport', venue: 'Seaport 1.6', washTrade: { state: 'unknown' } } });
    expect(s.interpretation.note).toContain('interpreted from the transaction by SP Wallet'); expect(s.id).not.toBe(t.id); expect(s.market!.fees).toHaveLength(1); expect(s.source.category).toBe('onchain');
    const bare = await events(false); expect(bare.events.map((e) => e.type)).toEqual(['transfer']); expect(bare.events[0]!.price).toBeNull();   // the same transfer with no marketplace event: never a sale
    expect(bare.completeness).toBe('recent_window');
    // with a keyed provider naming the transaction (outside the recent window): the events are still READ FROM THE CHAIN
    const old = await events(true, true); expect(old.completeness).toBe('partial'); expect(old.note).toMatch(/_and_provider_history$/);
    expect(old.events.map((e) => e.type).sort()).toEqual(['sale', 'transfer-in']); expect(old.events.find((e) => e.type === 'transfer-in')!.source).toMatchObject({ category: 'onchain' }); expect(old.events.find((e) => e.type === 'transfer-in')!.source.detail).toContain('named by Alchemy, read from the chain');
  });
  it('Solana: a marketplace program is NAMED from a sourced list — nothing else', () => {
    expect(solanaMarketProgram('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp')).toMatchObject({ name: 'Tensor Marketplace' }); expect(solanaMarketProgram('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K')!.source).toContain('me-foundation/m2');
    expect(solanaMarketProgram('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d')).toBeNull();
  });
});

describe('EVM discovery hints (Alchemy, OpenSea) — hints only, and no secret in anything that leaves', () => {
  const h = fx<{ alchemy: { ownerFlat: { body: unknown }; ownerBayc: { body: unknown }; networkNotEnabled: { status: number; text: string }; transfers: { body: unknown } }; opensea: { accountNfts: { body: unknown } } }>('evm-hints-live');
  const AK = 'alch-KEY-abcdefghijklmnop', HOLDER = '0x46EFbAedc92067E6d60E84ED6395099723252496';
  it('Alchemy: the flat answer is parsed (identifiers, the spam signal passed through); the key is in the URL path only', async () => {
    const urls: string[] = [];
    const page1 = h.alchemy.ownerFlat.body as { ownedNfts: { isSpam: boolean }[]; pageKey: string };
    const src = alchemyHints({ apiKey: AK, http: (async (url: string) => { urls.push(url); return new Response(JSON.stringify(urls.length === 1 ? page1 : { ownedNfts: [], pageKey: null })); }) as never });
    const r = await src.list('ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 100);
    expect(r.hints).toHaveLength(page1.ownedNfts.length); expect(r.hints[0]).toMatchObject({ contract: '0x0000000000696760E15f265e828DB644A0c242EB', spam: { flagged: false, classifications: ['SpammyMetadata'] } });
    expect(r.hints.map((x) => x.spam!.flagged)).toEqual(page1.ownedNfts.map((x) => x.isSpam));                        // the signal is passed through as given
    expect(r.hints[0]!.id).toBe('34454361969670104802583458346517400542074712368450903800518897101070583190115'); expect(r.truncated).toBe(false);
    expect(urls).toHaveLength(2); expect(urls[1]).toContain(`pageKey=${page1.pageKey}`);                                // the second page is asked with the cursor of the first
    expect(urls[0]).toMatch(new RegExp(`^https://eth-mainnet\\.g\\.alchemy\\.com/nft/v3/${AK}/getNFTsForOwner\\?owner=`)); expect(src.host('ethereum')).toBe('eth-mainnet.g.alchemy.com');
    expect(src.notCovered('hyperevm')).toBe('chain_not_covered'); expect(src.notCovered('base')).toBeNull();
    expect(() => alchemyHints({ apiKey: 'bad key/../x', http: fetch })).toThrow(/format/);
  });
  it('REDACTION: "network not enabled", a transport error quoting the URL, an HTML error page — none carries the key, the app id or a URL', async () => {
    const cases: [string, () => Promise<Response>][] = [
      ['network', async () => new Response(h.alchemy.networkNotEnabled.text.replace('<app-id>', 'APPID123secret'), { status: 403 })],
      ['transport', async () => { throw new Error(`request to https://base-mainnet.g.alchemy.com/nft/v3/${AK}/getNFTsForOwner failed, reason: ECONNRESET`); }],
      ['html', async () => new Response(`<html>upstream https://x/${AK}</html>`, { status: 502 })], ['auth', async () => new Response('Must be authenticated!', { status: 401 })], ['429', async () => new Response('', { status: 429 })]];
    const seen: Record<string, string> = {};
    for (const [name, http] of cases) {
      const e = await errOf(alchemyHints({ apiKey: AK, http: http as never }).list('base', HOLDER, 10));
      expect(e, name).toBeInstanceOf(NftProviderError); seen[name] = e.message;
      const everything = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${String((e as { cause?: unknown }).cause ?? '')}`;
      expect(everything, name).not.toContain(AK); expect(everything, name).not.toContain('APPID123secret'); expect(everything, name).not.toMatch(/https?:\/\//);
    }
    expect(seen).toEqual({ network: 'alchemy: provider_not_configured (network_not_enabled:base_mainnet)', transport: 'alchemy: provider_unavailable', html: 'alchemy: provider_unavailable (http_502)', auth: 'alchemy: provider_not_configured (key_refused)', '429': 'alchemy: provider_rate_limited' });
    expect(scrubSecrets(`GET https://eth-mainnet.g.alchemy.com/v2/${AK} failed; token ${AK}; see https://dashboard.alchemy.com/apps/abc/networks`, [AK])).toBe('GET https://eth-mainnet.g.alchemy.com/<redacted> failed; token <redacted>; see https://dashboard.alchemy.com/<redacted>');
  });
  it('the inventory: a hinted item enters ONLY if the chain confirms it; a network the key does not cover is "blocked by provider", never "no NFT"', async () => {
    const f = loadFixture('evm-lookups'), w = replay(f);
    const body = { ownedNfts: [...(h.alchemy.ownerBayc.body as { ownedNfts: unknown[] }).ownedNfts, { contractAddress: '0x000000000000000000000000000000000000dEaD', tokenId: '7', balance: '1', isSpam: true, spamClassifications: [] }], pageKey: null };
    const http = (async (url: string) => (url.includes('base-mainnet') ? new Response(h.alchemy.networkNotEnabled.text, { status: 403 }) : new Response(JSON.stringify(body)))) as never;
    const p = evmProvider({ rpc: w.rpc, now: clockOf(f), indexers: {}, http: (async () => { throw new Error('no blockscout'); }) as never, hints: [alchemyHints({ apiKey: AK, http })] });
    const inv = await p.inventory('ethereum', HOLDER, { manual: [], max: 50 });
    expect(inv.assets.map((a) => a.key)).toEqual([`evm:ethereum:${BAYC}/1`]);              // the invented item (0x…dEaD #7) is not in the inventory
    expect(inv.assets[0]!.ownership).toMatchObject({ heldByWallet: true, source: { category: 'onchain', confidence: 'chain_verified' } });
    expect(inv.assets[0]!.sources.some((s) => s.category === 'indexed' && s.source === 'alchemy' && s.detail === 'eth-mainnet.g.alchemy.com')).toBe(true);
    expect(inv.assets[0]!.indexerFlags).toEqual({ spam: false, by: 'Alchemy', classifications: [] });
    expect(inv.sections[0]).toMatchObject({ section: 'indexer', status: 'ok', count: 1, code: 'not_confirmed_on_chain:1', source: 'alchemy (eth-mainnet.g.alchemy.com)' });
    expect(JSON.stringify(inv)).not.toContain(AK);
    const base = await p.inventory('base', HOLDER, { manual: [], max: 50 });
    expect(base.assets).toEqual([]); expect(base.sections[0]).toMatchObject({ section: 'indexer', status: 'blocked_by_provider', code: 'network_not_enabled_for_key:base_mainnet', unlockedBy: 'ALCHEMY_API_KEY' });
    const hyper = await p.inventory('hyperevm', HOLDER, { manual: [], max: 50 });
    expect(hyper.sections[0]).toMatchObject({ status: 'blocked_by_provider', code: 'no_indexer_configured', unlockedBy: 'NFT_EVM_PROVIDER / NFT_EVM_INDEXER_URLS' });
  });
  it('OpenSea account listing as a hint source; Alchemy history hints are transaction hashes only', async () => {
    const src = openSeaHints({ apiKey: KEY, http: (async (url: string, init?: RequestInit) => { expect((init!.headers as Record<string, string>)['x-api-key']).toBe(KEY); expect(url).not.toContain(KEY); return new Response(JSON.stringify(h.opensea.accountNfts.body)); }) as never });
    const r = await src.list('ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 100);
    expect(r.hints.length).toBe(3); expect(r.hints[0]).toEqual({ contract: '0x1e656f771367d935707f5f13992ccaa1dc6aa742', id: '129', spam: null }); expect(src.notCovered('bsc')).toBe('chain_not_covered');
    const al = alchemyHints({ apiKey: AK, http: (async () => new Response(JSON.stringify(h.alchemy.transfers.body))) as never });
    expect(await al.history!('ethereum', HOLDER, BAYC)).toEqual([{ tx: '0xe93e858f9330afa4581e260198195623aa7f5cd2809012440ea291d317be9f2f', block: '12344148' }]);
  });
});

// ── the market service: one row per source, isolation, cache, missing providers, rates ──────────────────────────────────
const asset = (o: Partial<NftAsset>): NftAsset => ({ key: `sol:solana:${REF}`, family: 'sol', chainId: 'solana', assetId: REF, standard: 'metaplex-core', tokenId: null, contractAddress: null, mintAddress: REF, collection: null, ...o } as NftAsset);
const memCache = () => { const m = new Map<string, { data: unknown; fetched_at: Date }>(); return { m, get: async (p: string, k: string, r: string) => m.get(`${p}|${k}|${r}`) ?? null, put: (async (p: string, k: string, r: string, data: unknown, at: Date) => { m.set(`${p}|${k}|${r}`, { data: JSON.parse(JSON.stringify(data)), fetched_at: at }); }) as never }; };
const ABSENT: AbsentProvider[] = [{ id: 'magiceden', name: 'Magic Eden', state: 'off', code: 'not_enabled', unlockedBy: 'NFT_MARKET_MAGICEDEN', unlocks: 'x', chains: ['solana'] }, { id: 'opensea', name: 'OpenSea', state: 'needs_key', code: 'no_api_key', unlockedBy: 'OPENSEA_API_KEY', unlocks: 'y', chains: ['solana', 'ethereum'] }];
const fake = (id: string, item: Partial<ItemMarket>, o: { fail?: () => string | null } = {}): NftMarketProvider => ({ id, name: id.toUpperCase(), describe: () => ({ chains: ['solana'], sends: 'mint_only', attribution: null, terms: null, limits: { perMinute: 1, perDay: 1 }, verification: 'documentation' }),
  notCovered: (r) => (r.chain === 'solana' ? null : 'chain_not_covered'),
  item: async () => { const c = o.fail?.(); if (c) throw new NftProviderError(c as never, id); return { url: null, listed: { state: 'unknown' }, ask: { state: 'unknown' }, bestOffer: { state: 'unknown' }, lastSale: { state: 'unknown' }, collection: null, collectionFloor: { state: 'unknown' }, verification: null, flags: { suspicious: { state: 'unknown' }, disabled: { state: 'unknown' }, nsfw: { state: 'unknown' } }, rarity: { state: 'unknown' }, ...item }; } });
const sol = (amount: string) => ({ state: 'known' as const, value: money(amount, SOL_NATIVE) });

describe('market service', () => {
  it('no provider configured: every source is reported with its reason and the variable that unlocks it — and nothing else (never an invented figure)', async () => {
    const s = createMarketService({ providers: [], absent: ABSENT, budgets: new Map(), now, cache: memCache() });
    const r = await s.item(asset({}));
    expect(r.sources.map((x) => [x.status.provider, x.status.state, x.status.code, x.status.unlockedBy])).toEqual([['magiceden', 'off', 'not_enabled', 'NFT_MARKET_MAGICEDEN'], ['opensea', 'needs_key', 'no_api_key', 'OPENSEA_API_KEY']]);
    for (const x of r.sources) { expect([x.listed, x.ask, x.bestOffer, x.lastSale, x.collectionFloor].every((k) => k.state === 'unknown')).toBe(true); expect(x.status.stamp).toBeNull(); expect(x.verification).toBeNull(); }
    expect(r.contradictions).toEqual([]); expect(r.rates).toEqual({});
    expect((await s.item(asset({ chainId: 'base', family: 'evm', key: 'evm:base:0xabc/1' }))).sources).toEqual([]);     // no source of this version concerns that chain
    expect(s.providers().map((p) => [p.id, p.state, p.unlockedBy])).toEqual([['magiceden', 'off', 'NFT_MARKET_MAGICEDEN'], ['opensea', 'needs_key', 'OPENSEA_API_KEY']]);
  });
  it('contradictory sources stay two rows and are NAMED; a source that fails does not touch the other; a fake badge stays the statement of whoever made it', async () => {
    const a = fake('a', { listed: { state: 'known', value: true }, ask: { state: 'known', value: { orderId: null, price: money('5000000000', SOL_NATIVE), quantity: '1', seller: null, venue: 'A', protocol: null, createdAt: null, expiresAt: null, fees: null } }, collectionFloor: sol('4000000'), verification: { state: 'verified', providerValue: 'verified', by: 'A' } });
    const b = fake('b', { listed: { state: 'known', value: false }, ask: { state: 'none' }, collectionFloor: sol('3500000'), verification: { state: 'not_verified', providerValue: 'not_requested', by: 'B' } });
    const c = fake('c', {}, { fail: () => 'provider_unavailable' });
    const r = await createMarketService({ providers: [a, b, c], absent: [], budgets: new Map(), now, cache: memCache() }).item(asset({}));
    expect(r.sources.map((x) => [x.status.provider, x.status.state, x.status.code])).toEqual([['a', 'ok', null], ['b', 'ok', null], ['c', 'error', 'provider_unavailable']]);
    expect(r.contradictions.map((x) => x.field).sort()).toEqual(['collection_floor', 'listed', 'verification']);
    expect(r.sources[0]!.verification!.by).toBe('A'); expect(r.sources[0]!.status.stamp).toMatchObject({ category: 'market', confidence: 'market_reported', source: 'a' });
    // a floor in another currency is not "a different floor": nothing is compared across currencies
    const d = fake('d', { collectionFloor: { state: 'known', value: money('360000', { network: 'solana', asset: USDC_SOL, symbol: 'USDC', decimals: 6 }) } });
    expect(contradictions([(await createMarketService({ providers: [a, d], absent: [], budgets: new Map(), now, cache: memCache() }).item(asset({}))).sources].flat()).filter((x) => x.field === 'collection_floor')).toEqual([]);
  });
  it('cache: fresh within the TTL; after it, a failing provider serves the last answer marked STALE with the failure code — for a day, then nothing', async () => {
    let t = NOW.getTime(), calls = 0, down: string | null = null; const clock = () => new Date(t), cache = memCache();
    const p = fake('a', { collectionFloor: sol('4000000') }, { fail: () => { calls += 1; return down; } });
    const s = createMarketService({ providers: [p], absent: [], budgets: new Map(), now: clock, cache });
    const first = (await s.item(asset({}))).sources[0]!; expect(first.status).toMatchObject({ state: 'ok', stale: false }); expect(calls).toBe(1);
    t += 60_000; await s.item(asset({})); expect(calls).toBe(1);                                                        // inside the 2-minute TTL: not asked again
    t += 120_000; down = 'provider_rate_limited';
    const stale = (await s.item(asset({}))).sources[0]!;
    expect(calls).toBe(2); expect(stale.status).toMatchObject({ state: 'ok', stale: true, code: 'provider_rate_limited', stamp: { freshness: 'stale', fetchedAt: NOW.toISOString() } }); expect(stale.collectionFloor).toEqual(sol('4000000'));
    down = 'budget_exhausted'; expect((await s.item(asset({}))).sources[0]!.status).toMatchObject({ stale: true, code: 'budget_exhausted' });   // quota exhausted: the same honest answer
    t += 25 * 3600_000; const gone = (await s.item(asset({}))).sources[0]!;
    expect(gone.status).toMatchObject({ state: 'error', code: 'budget_exhausted', stamp: null }); expect(gone.collectionFloor.state).toBe('unknown');
    down = null; expect((await s.item(asset({}), { force: true })).sources[0]!.status).toMatchObject({ state: 'ok', stale: false });
    for (const k of cache.m.keys()) expect(k).not.toMatch(/https?:/);                                                   // the cache key is provider + kind + reference, never a URL
  });
  it('fiat is secondary: a rate with its source and date, only for a currency of the registry; a licensed price source is withheld from an API key', async () => {
    const p = fake('a', { collectionFloor: sol('4000000'), lastSale: { state: 'known', value: { price: money('14500000000', { network: 'solana', asset: USDC_SOL, symbol: 'USDC', decimals: 6 }), quantity: '1', at: null, tx: null, buyer: null, seller: null, venue: null } },
      ask: { state: 'known', value: { orderId: null, price: money('1', { network: 'solana', asset: 'FakeUSDC11111111111111111111111111111111111', symbol: 'USDC', decimals: 6 }), quantity: '1', seller: null, venue: null, protocol: null, createdAt: null, expiresAt: null, fees: null } } });
    const prices = async () => ({ SOL: { usd: 142.5, cad: 199.1, priceAt: '2026-11-17T11:25:00.000Z', source: 'coingecko', stale: false }, USDC: { usd: 0.9996, priceAt: '2026-11-17T11:20:00.000Z', source: 'apibricks', stale: true } });
    const s = createMarketService({ providers: [p], absent: [], budgets: new Map(), now, cache: memCache(), prices });
    const owner = (await s.item(asset({}))).rates;
    expect(Object.keys(owner).sort()).toEqual([`solana:${USDC_SOL}`, 'solana:native']);                                 // the look-alike "USDC" on an unknown mint has no rate
    expect(owner['solana:native']).toMatchObject({ symbol: 'SOL', usd: '142.5', cad: '199.1', source: 'coingecko', priceAt: '2026-11-17T11:25:00.000Z', stale: false, withheld: null });
    expect(owner[`solana:${USDC_SOL}`]).toMatchObject({ usd: '0.9996', source: 'apibricks', stale: true, withheld: null });
    const key = (await s.item(asset({}), { thirdParty: true })).rates;
    expect(key[`solana:${USDC_SOL}`]).toMatchObject({ usd: null, cad: null, source: 'apibricks', withheld: 'price_source_licence_internal_use_only' }); expect(key['solana:native']!.usd).toBe('142.5');
    expect((await createMarketService({ providers: [p], absent: [], budgets: new Map(), now, cache: memCache(), prices: async () => null }).item(asset({}))).rates).toEqual({});
  });
  it('the real OpenSea adapter through the service: the reference item, then its collection by the slug the SOURCE gave', async () => {
    const s = createMarketService({ providers: [opensea()], absent: [ABSENT[0]!], budgets: new Map(), now, cache: memCache() });
    const r = await s.item(asset({}));
    expect(r.sources.map((x) => [x.status.provider, x.status.state])).toEqual([['opensea', 'ok'], ['magiceden', 'off']]);
    expect(r.sources[0]!.lastSale).toMatchObject({ state: 'known', value: { price: { amount: '14500000000' } } }); expect(r.sources[0]!.status.attribution).toEqual({ text: 'Market data: OpenSea', url: 'https://opensea.io' });
    const ev = await s.events(asset({}), { cursor: null, types: null, after: null, before: null, limit: 20, provider: 'opensea' });
    expect(ev.sources).toHaveLength(1); expect(ev.sources[0]!.events.filter((e) => e.type === 'sale')).toHaveLength(1); expect(Object.keys(ev.rates)).toEqual([]);
    // a query that was not recorded: the double refuses it, the source is reported in error, no event is made up
    const miss = await s.events(asset({}), { cursor: null, types: ['sale'], after: null, before: null, limit: 20, provider: 'opensea' });
    expect(miss.sources[0]).toMatchObject({ status: { state: 'error', code: 'provider_unavailable' }, events: [] });
  });
});
