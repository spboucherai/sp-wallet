/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/nft-market-api.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// NFT delivery 3 — the owner's market routes through the real server (own database): /api/v1/nfts/market/*, /nfts/valuation,
// the spam filter of the list. Sources are scripted: recorded chain answers, the LIVE-RECORDED OpenSea answers behind the real
// adapter, Magic Eden absent (off). No network.
// Covered: owner session only; READ only (no write route exists); one row per source with its state; the reference item shows
// what its sources really said and nothing else; external links with the "outside SP Wallet" facts; collection figures with
// opaque media ids; the floor-based estimate is OFF by default, labelled, and never part of a total; spam is hidden, not deleted.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NftAsset } from '@spw/nft';
import { loadFixture, replay } from './nft-helpers.ts';
import { useTestDatabase } from './test-db.ts';

const ORIGIN = 'https://wallet.test', REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', KEY = `sol:solana:${REF}`, COLL = 'sol:solana:phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC';
const REF_OWNER = '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', BAYC_HOLDER = '0x46EFbAedc92067E6d60E84ED6395099723252496', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const dir = mkdtempSync(join(tmpdir(), 'spw-nft-market-'));
let app: any, sql: any, cookie = '', store: typeof import('../src/nft/store.ts'); // eslint-disable-line @typescript-eslint/no-explicit-any
const now = () => new Date('2026-11-17T12:00:00Z');
const asked: string[] = [];

async function call(method: string, path: string, o: { body?: unknown; cookie?: string | null; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }, c = o.cookie === undefined ? cookie : o.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET' && o.csrf !== false) { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: `/api/v1${path}`, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const q = (key: string) => encodeURIComponent(key);

beforeAll(async () => {
  await useTestDatabase('nft_market', { NFT_CACHE_DIR: dir });
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  store = await import('../src/nft/store.ts');
  const { nftConfig } = await import('../src/nft/config.ts'), { openSeaMarket } = await import('../src/nft/market/opensea.ts'), { createBudget } = await import('../src/nft/market/budget.ts');
  const world = replay(...['sol-core-reference', 'evm-lookups', 'evm-events'].map(loadFixture));
  const os = JSON.parse(readFileSync(new URL('./fixtures/nft/market-opensea-live.json', import.meta.url), 'utf8')) as { calls: { path: string; status: number; body: unknown }[] };
  const osHttp = (async (url: string) => { const path = url.slice('https://api.opensea.io/api/v2'.length); asked.push(path); const c = os.calls.find((x) => x.path === path); if (!c) throw new Error('unrecorded'); return new Response(JSON.stringify(c.body), { status: c.status }); }) as never;
  app = await (await import('../src/server.ts')).buildServer({ nft: { cfg: nftConfig({ NFT_CACHE_DIR: dir }), rpc: world.rpc, now, autoSync: false, addresses: async () => ({ solana: REF_OWNER, ethereum: BAYC_HOLDER }),
    fetch: { resolve: async () => [{ address: '93.184.216.34', family: 4 as const }], transport: async () => ({ status: 404, headers: {}, body: new Uint8Array(), truncated: false }), now: () => now().getTime() },
    marketProviders: [openSeaMarket({ http: osHttp, now, apiKey: 'market-api-test-key', budget: createBudget('opensea', { perMinute: 1000, perDay: 100000 }, { now }) })],
    marketAbsent: [{ id: 'magiceden', name: 'Magic Eden', state: 'off', code: 'not_enabled', unlockedBy: 'NFT_MARKET_MAGICEDEN', unlocks: 'Magic Eden\'s own listings', chains: ['solana'] }],
    prices: async () => ({ USDC: { usd: 0.9996, priceAt: '2026-11-17T11:50:00.000Z', source: 'coingecko', stale: false } }) } as never });
}, 120_000);
afterAll(async () => { await app?.close(); await sql?.end(); });

describe('access: owner session only, and nothing that writes', () => {
  const reads = [`/nfts/market?key=${q(KEY)}`, `/nfts/market/listings?key=${q(KEY)}`, `/nfts/market/offers?key=${q(KEY)}`, `/nfts/market/activity?key=${q(KEY)}`, `/nfts/market/collection?key=${q(COLL)}`, '/nfts/market/providers', '/nfts/valuation'];
  it('every market route needs the owner session; an API key is not accepted on these paths', async () => {
    for (const p of reads) { expect((await call('GET', p, { cookie: null })).status, p).toBe(401); expect([401, 403], p).toContain((await call('GET', p, { cookie: null, headers: { authorization: 'Bearer spw_live_0000000000000000000000000000000000000000' } })).status); }
    expect((await call('POST', '/nfts/valuation', { body: { enabled: true }, cookie: null })).status).toBe(401); expect((await call('POST', '/nfts/valuation', { body: { enabled: true }, csrf: false })).status).toBe(403);
  });
  it('NO market write route exists: buy, sell, list, offer, accept, cancel, approve, sign — all 404', async () => {
    for (const p of ['/nfts/market', '/nfts/market/buy', '/nfts/market/sell', '/nfts/market/listings', '/nfts/market/offers', '/nfts/market/accept', '/nfts/market/cancel', '/nfts/market/approve', '/nfts/market/sign', '/nfts/market/fulfill', '/nfts/market/order'])
      for (const m of ['POST', 'PUT', 'DELETE']) expect((await call(m, p, { body: {} })).status, `${m} ${p}`).toBe(404);
  });
  it('provider status: what is on, what is off and which variable turns it on, the budget counters, the actions that do not exist', async () => {
    const r = (await call('GET', '/nfts/market/providers')).json;
    expect(r.providers.map((p: any) => [p.id, p.state, p.unlockedBy, p.verification])).toEqual([['opensea', 'on', null, 'live'], ['magiceden', 'off', 'NFT_MARKET_MAGICEDEN', null]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.providers[0]).toMatchObject({ sends: 'contract_and_token_id', chains: expect.arrayContaining(['solana', 'ethereum', 'hyperevm']), terms: { url: 'https://opensea.io/developer-terms' }, attribution: { text: 'Market data: OpenSea' }, ttlSeconds: { item: 120, collection: 600 } });
    expect(r.providers[0].chains).not.toContain('bsc'); expect(r.providers[0].budget).toBeNull();                 // this test injects the provider without the server's budget registry
    expect(r.actions.every((a: any) => a.available === false && a.reason === 'market_writes_not_built')).toBe(true); expect(r.actions).toHaveLength(7); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.notice).toEqual({ outsideWallet: true, walletConnect: false, keyExport: false, code: 'external_site_needs_a_wallet_connection_this_wallet_does_not_offer' });
    expect(JSON.stringify(r)).not.toContain('market-api-test-key');
  });
});

describe('the reference item', () => {
  it('its market panel: what OpenSea reported, Magic Eden off with its variable — five notions, each its own field; no value', async () => {
    expect((await call('GET', `/nfts/market?key=${q(KEY)}`)).status).toBe(404);                                   // not opened yet: nothing to say
    const item = (await call('POST', '/nfts/lookup', { body: { chain: 'solana', address: REF } })).json;
    expect(item.key).toBe(KEY); expect(item.market).toBeNull(); expect(item.marketSources).toEqual([{ provider: 'opensea', name: 'OpenSea', state: 'on', unlockedBy: null }, { provider: 'magiceden', name: 'Magic Eden', state: 'off', unlockedBy: 'NFT_MARKET_MAGICEDEN' }]);
    const m = (await call('GET', `/nfts/market?key=${q(KEY)}`)).json;
    expect(m.sources.map((s: any) => [s.status.provider, s.status.state, s.status.code])).toEqual([['opensea', 'ok', null], ['magiceden', 'off', 'not_enabled']]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const os = m.sources[0];
    expect(os.listed).toEqual({ state: 'known', value: false }); expect(os.ask).toEqual({ state: 'none' }); expect(os.bestOffer).toEqual({ state: 'none' });
    expect(os.lastSale.value).toMatchObject({ price: { amount: '14500000000', currency: { network: 'solana', asset: USDC, symbol: 'USDC', decimals: 6 }, precision: 'exact' }, at: '2026-11-10T16:38:56.000Z' });
    expect(os.collectionFloor.state).toBe('unknown'); expect(os.verification).toEqual({ state: 'verified', providerValue: 'verified', by: 'OpenSea' });
    expect(os.status.stamp).toMatchObject({ category: 'market', source: 'opensea', confidence: 'market_reported', freshness: 'fresh', fetchedAt: '2026-11-17T12:00:00.000Z' });
    expect(m.sources[1]).toMatchObject({ status: { unlockedBy: 'NFT_MARKET_MAGICEDEN', stamp: null }, listed: { state: 'unknown' }, ask: { state: 'unknown' }, lastSale: { state: 'unknown' }, collectionFloor: { state: 'unknown' } });
    expect(m.value).toEqual({ state: 'unavailable', reason: 'no_valuation_from_floor_or_single_quote' });
    expect(m.rates[`solana:${USDC}`]).toMatchObject({ symbol: 'USDC', usd: '0.9996', source: 'coingecko', priceAt: '2026-11-17T11:50:00.000Z', withheld: null });
    expect(m.actions.every((a: any) => a.available === false)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(m.external.links.map((l: any) => l.name)).toEqual(['Magic Eden', 'OpenSea']); expect(m.external.notice).toMatchObject({ outsideWallet: true, walletConnect: false, keyExport: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
    // what was sent upstream: the mint and the collection slug — never a wallet address
    expect(asked.length).toBeGreaterThan(0); for (const p of asked) { expect(p).not.toContain(REF_OWNER); expect(p).not.toContain(BAYC_HOLDER); }
    // a second read inside the TTL asks nothing again
    const n = asked.length; await call('GET', `/nfts/market?key=${q(KEY)}`); expect(asked.length).toBe(n);
  });
  it('offers and listings per source; market activity: a sale apart from the transfers, filters validated, a cursor only with its source', async () => {
    const off = (await call('GET', `/nfts/market/offers?key=${q(KEY)}`)).json;
    expect(off.sources.map((s: any) => [s.status.provider, s.status.state, s.items.length])).toEqual([['opensea', 'ok', 0], ['magiceden', 'off', 0]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', `/nfts/market/listings?key=${q(KEY)}&provider=opensea`)).json.sources).toHaveLength(1);
    const act = (await call('GET', `/nfts/market/activity?key=${q(KEY)}&provider=opensea`)).json;
    const ev = act.sources[0].events; expect(ev.filter((e: any) => e.type === 'sale')).toHaveLength(1); expect(ev.filter((e: any) => e.type === 'transfer' && e.price === null)).toHaveLength(17); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', `/nfts/market/activity?key=${q(KEY)}&type=sale,steal`)).status).toBe(400); expect((await call('GET', `/nfts/market/activity?key=${q(KEY)}&cursor=abc`)).json.error).toBe('bad_request');
    expect((await call('GET', `/nfts/market/activity?key=${q(KEY)}&after=yesterday`)).status).toBe(400); expect((await call('GET', '/nfts/market?key=nope')).status).toBe(400);
  });
  it('its collection as each source describes it: verified BY OpenSea, floor and volume apart, trait counts with their denominator, images as opaque ids', async () => {
    const c = (await call('GET', `/nfts/market/collection?key=${q(COLL)}`)).json, os = c.sources[0];
    expect(os.status).toMatchObject({ provider: 'opensea', state: 'ok' }); expect(os.slug).toBe('phygitals'); expect(os.verification).toMatchObject({ state: 'verified', by: 'OpenSea' });
    expect(os.floor.value).toMatchObject({ amount: '360000', precision: 'source_decimal', currency: { asset: USDC } }); expect(os.volumes[0]).toMatchObject({ interval: 'all', volume: null, reported: { symbol: 'ETH' } });
    expect(os.totalSupply).toEqual({ state: 'known', value: '344673' }); expect(os.traits.value.total).toBe('344673');
    expect(os.imageId).toMatch(/^m[0-9a-f]{40}$/); expect(os.bannerId).toMatch(/^m[0-9a-f]{40}$/); expect(os.imageUrl).toBeNull(); expect(JSON.stringify(c)).not.toContain('seadn.io');   // the browser never gets a marketplace URL to load
    expect(c.sources[1]).toMatchObject({ status: { provider: 'magiceden', state: 'off' }, floor: { state: 'unknown' } });
    // a collection no source has identified yet (none of its items was opened): said so, not guessed from a name
    const other = (await call('GET', `/nfts/market/collection?key=${q('evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d')}`)).json;
    expect(other.sources[0].status).toMatchObject({ state: 'not_covered', code: 'collection_not_identified' });
    // the page gets the most frequent values only (the source's document was megabytes), and says it was cut
    expect(os.traits.value.categories.every((x: any) => x.values.length <= 12)).toBe(true); expect(os.traits.value.truncated).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it('trait frequency of the item: from the source\'s counts over its STATED total — or not computed, and why', async () => {
    const t = (await call('GET', `/nfts/market/traits?key=${q(KEY)}`)).json;
    // the creator's document could not be fetched in this test (the scripted world answers 404): no attribute, hence no row — and still no invented frequency
    expect(t).toMatchObject({ key: KEY, computed: true, sources: [{ provider: 'opensea', computed: true, total: '344673', fetchedAt: '2026-11-17T12:00:00.000Z' }] });
    expect(t.sources[0].rows).toEqual([]); expect(t.sources[0].method).toContain('both stated by the source');
    const none = (await call('GET', `/nfts/market/traits?key=${q('sol:solana:11111111111111111111111111111111')}`)); expect(none.status).toBe(404);
  });
});

describe('value: unavailable by default; the opt-in estimate is labelled, sourced, and outside every total', () => {
  it('default OFF; once on: per collection the items held, the floor, its source and age — an indicative figure, never a valuation', async () => {
    expect((await call('GET', '/nfts/valuation')).json).toEqual({ enabled: false, state: 'unavailable', reason: 'no_reliable_valuation', excludedFromWalletTotal: true, estimate: null });
    // the wallet of this test holds the reference item (its on-chain owner is the scripted wallet address)
    const add = (await call('POST', '/nfts/manual', { body: { chain: 'solana', address: REF } })).json; expect(add.ownership.heldByWallet).toBe(true);
    expect((await call('GET', '/nfts')).json.valuation).toEqual({ state: 'unavailable', reason: 'no_reliable_valuation' });
    expect((await call('POST', '/nfts/valuation', { body: { enabled: 'yes' } })).status).toBe(400);
    expect((await call('POST', '/nfts/valuation', { body: { enabled: true } })).json).toEqual({ enabled: true });
    const v = (await call('GET', '/nfts/valuation')).json;
    expect(v).toMatchObject({ enabled: true, state: 'unavailable', excludedFromWalletTotal: true, estimate: { label: 'indicative_floor_based_estimate', collectionsCounted: 1, collectionsWithoutFloor: 0 } });
    expect(v.estimate.collections[0]).toMatchObject({ collectionKey: COLL, items: 1, used: { provider: 'opensea', fetchedAt: '2026-11-17T12:00:00.000Z', stale: false, floor: { amount: '360000' }, indicative: { amount: '360000', currency: { asset: USDC } } } });
    expect(v.estimate.indicativeUsd).toBe('0.35'); expect(v.estimate.method).toContain('not the value of the items held');   // 0.36 USDC × 0.9996, rounded down
    expect((await call('GET', '/nfts')).json.valuation.state).toBe('unavailable');                                    // the list and the wallet total never take it
    expect((await sql`select type from audit_events where type = 'nft.floor_estimate'`).length).toBe(1);
    expect((await call('POST', '/nfts/valuation', { body: { enabled: false } })).json).toEqual({ enabled: false }); expect((await call('GET', '/nfts/valuation')).json.estimate).toBeNull();
  });
});

describe('an indexer\'s spam signal: hidden by default, never deleted, always named', () => {
  it('the list hides flagged items and says how many; `spam=show` and `spam=only` reach them', async () => {
    const base = (await store.getAsset(KEY))!.asset;
    const spam: NftAsset = { ...base, key: 'evm:ethereum:0x000000000000000000000000000000000000dead/7', family: 'evm', chainId: 'ethereum', assetId: '0x000000000000000000000000000000000000dead/7', indexerFlags: { spam: true, by: 'Alchemy', classifications: ['SpammyMetadata'] }, origin: 'discovered' };
    await store.upsertAsset(spam, now());
    const hidden = (await call('GET', '/nfts')).json;
    expect(hidden.items.map((i: any) => i.key)).toEqual([KEY]); expect(hidden.total).toBe(1); expect(hidden.hiddenSpam).toBe(1); // eslint-disable-line @typescript-eslint/no-explicit-any
    const shown = (await call('GET', '/nfts?spam=show')).json; expect(shown.total).toBe(2); expect(shown.items.find((i: any) => i.key === spam.key).spam).toEqual({ by: 'Alchemy' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', '/nfts?spam=only')).json.items.map((i: any) => i.key)).toEqual([spam.key]); expect((await store.getAsset(spam.key))).not.toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call('GET', '/nfts?spam=delete')).status).toBe(400);
  });
});
