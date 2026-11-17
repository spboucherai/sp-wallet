// Magic Eden public Solana API — market READ adapter (docs/nft/NFT-SOURCES.md §10.2). OPT-IN: exists only with
// NFT_MARKET_MAGICEDEN=on. Keyless ("This public API is free to use, and the default limit is 120 QPM or 2 QPS",
// docs.magiceden.io/reference/solana-api-keys). Its API terms page (magiceden.io/legal-policies/api-terms) still answers a
// bot challenge to this server (403, 2026-11-17): the terms could not be read FROM THE OFFICIAL SITE, which is why the
// source stays off unless the owner — who can read the page in a browser — turns it on.
//
// Every endpoint below was called live on 2026-11-17 (recorded: services/api/test/fixtures/nft/market-magiceden-live.json):
//   GET /v2/tokens/<mint>                      listStatus, owner (the SELLER of an escrowed listing), collection (symbol)
//   GET /v2/tokens/<mint>/listings             priceInfo.solPrice.rawAmount (lamports) + price (SOL, decimal), seller, expiry, auctionHouse
//   GET /v2/tokens/<mint>/offers_received      price (SOL, decimal — no base-unit field), buyer, expiry
//   GET /v2/tokens/<mint>/activities           type (list, delist, buyNow, bid, cancelBid, mint, poolUpdate…), price (SOL, decimal), buyer, seller, signature, slot, blockTime, source
//   GET /v2/collections/<symbol>/stats         floorPrice (lamports, integer), listedCount, avgPrice24hr, volume7d
//
// Observed and handled:
//  - in `activities`, `priceInfo.solPrice.rawAmount` is NOT lamports (it is the price × 10^18 while `decimals` says 9; the same
//    listing reads 4 000 000 in /listings and 4 000 000 000 000 000 in /activities). An activity's amount is therefore taken
//    from `price` (a decimal number of SOL), converted digit by digit and marked `source_decimal`; in /listings the base-unit
//    field is used and must agree with `price`, else the price is `unknown (source_fields_disagree)`;
//  - `collections/<symbol>/attributes` gives counts among LISTED items, with no item total: no frequency is derived from it;
//  - no wash-trade flag, no verification badge, no rarity in these answers: `unknown` / absent, never `false`.
// Sent upstream: the mint and the marketplace's collection symbol — never the wallet's address.
import { NONE, NftProviderError, SOL_NATIVE, decimalToUnits, isUnits, known, money, unknown, type Known, type MarketEvent, type MarketListing, type MarketMoney, type MarketOffer, type MarketSale, type Page } from '@spw/nft';
import { providerGet, type Budget } from './budget.ts';
import type { CollectionMarketData, CollectionMarketRef, EventQuery, HttpFn, ItemMarketData, MarketRef, NftMarketProvider } from './types.ts';

export const MAGICEDEN_API = 'https://api-mainnet.magiceden.dev/v2';
const WSOL = 'So11111111111111111111111111111111111111112';
type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const SYMBOL = /^[a-z0-9_]{1,80}$/;
/** a decimal number of SOL → lamports, exactly; null when it does not fit 9 decimals */
const solToLamports = (v: unknown): MarketMoney | null => { const u = decimalToUnits(v, 9); return u && u !== '0' ? money(u, SOL_NATIVE, 'source_decimal') : null; };
const when = (sec: unknown): string | null => (typeof sec === 'number' && sec > 0 && sec < 4_102_444_800 ? new Date(sec * 1000).toISOString() : null);
const TYPE: Record<string, MarketEvent['type']> = { list: 'list', delist: 'delist', buyNow: 'sale', bid: 'offer', cancelBid: 'cancel-offer', mint: 'mint' };

export function magicEdenProvider(deps: { http: HttpFn; now: () => Date; budget: Budget }): NftMarketProvider {
  // the API answers 400 "Not Found." for an unknown object
  const get = (path: string) => providerGet({ provider: 'magiceden', budget: deps.budget, http: deps.http, url: `${MAGICEDEN_API}${path}`, notFound: [404, 400] });
  function listingOf(raw: unknown, mint: string): MarketListing | 'disagree' | null {
    const l = obj(raw); if (!l || l.tokenMint !== mint) return null;
    const p = obj(obj(l.priceInfo)?.solPrice), rawAmt = typeof p?.rawAmount === 'string' && isUnits(p.rawAmount) ? p.rawAmount : null, dec = solToLamports(l.price);
    // only a price quoted in SOL with its exact base-unit amount, agreeing with the decimal the same answer carries
    if (!rawAmt || p?.decimals !== 9 || p.address !== WSOL) return null;
    if (dec && dec.amount !== rawAmt) return 'disagree';
    const exp = typeof l.expiry === 'number' && l.expiry > 0 ? when(l.expiry) : null;
    return { orderId: str(l.pdaAddress), price: money(rawAmt, SOL_NATIVE), quantity: typeof l.tokenSize === 'number' && Number.isSafeInteger(l.tokenSize) && l.tokenSize > 0 ? String(l.tokenSize) : '1', seller: str(l.seller), venue: 'Magic Eden',
      protocol: { name: 'magiceden_v2', address: str(l.auctionHouse) }, createdAt: null, expiresAt: exp, fees: null };
  }
  function eventOf(raw: unknown): MarketEvent | null {
    const e = obj(raw), t = str(e?.type, 40); if (!e || !t) return null;
    const type = TYPE[t] ?? 'unknown', price = type === 'delist' || type === 'unknown' ? null : solToLamports(e.price);
    return { type, providerType: `${t}${str(e.source, 40) ? `:${e.source as string}` : ''}`, at: when(e.blockTime), tx: str(e.signature, 120), index: null, from: str(e.seller), to: str(e.buyer), quantity: '1',
      price: type === 'mint' ? null : price, venue: 'Magic Eden', orderId: null, flags: { washTrade: unknown('the source has no wash-trade flag') }, fees: null };
  }
  const activities = async (mint: string, offset: number, limit: number): Promise<unknown[]> => { const j = await get(`/tokens/${mint}/activities?offset=${offset}&limit=${limit}`); if (!Array.isArray(j)) throw new NftProviderError('provider_bad_answer', 'magiceden', 'no_activity_list'); return j; };
  const soft = async <T>(f: () => Promise<T>, onError: (code: string) => T): Promise<T> => { try { return await f(); } catch (e) { return onError(e instanceof NftProviderError ? e.code : 'provider_bad_answer'); } };

  return {
    id: 'magiceden', name: 'Magic Eden',
    describe: () => ({ chains: ['solana'], sends: 'mint_only', attribution: { text: 'Market data: Magic Eden', url: 'https://magiceden.io' },
      terms: { url: 'https://magiceden.io/legal-policies/api-terms', readAt: '2026-11-17', note: 'the page answered a bot challenge (403) to this server: NOT read from the official site; the documentation asks for attribution and a link back' },
      limits: { perMinute: 40, perDay: 5000 }, verification: 'live' }),
    notCovered: (r) => (r.chain !== 'solana' ? 'chain_not_covered' : r.standard === 'metaplex-bubblegum' || !r.mint ? 'standard_not_covered' : null),

    async item(r): Promise<ItemMarketData> {
      const mint = r.mint!, t = obj(await get(`/tokens/${mint}`));
      if (!t || t.mintAddress !== mint) throw new NftProviderError('provider_bad_answer', 'magiceden', 'another_asset_answered');
      const listed = t.listStatus === 'listed' ? true : t.listStatus === 'unlisted' ? false : null, symbol = str(t.collection, 80), slug = symbol && SYMBOL.test(symbol) ? symbol : null;
      const out: ItemMarketData = { url: `https://magiceden.io/item-details/${mint}`, listed: listed === null ? unknown('the marketplace gave no list status') : known(listed), ask: listed === false ? NONE : unknown(), bestOffer: unknown(), lastSale: unknown(),
        collection: slug ? { slug, name: str(t.collectionName) } : null, collectionFloor: unknown(), verification: null, flags: { suspicious: unknown(), disabled: unknown(), nsfw: unknown() }, rarity: unknown('not reported by this source') };
      if (listed) out.ask = await soft<Known<MarketListing>>(async () => { const ls = await get(`/tokens/${mint}/listings`); const l = Array.isArray(ls) ? ls.map((x) => listingOf(x, mint)).find((x) => x !== null) : null;
        return l === 'disagree' ? unknown('source_fields_disagree') : l ? known({ ...l, seller: l.seller ?? str(t.owner) }) : unknown('the listing is not quoted in SOL base units'); }, (c) => unknown(c));
      out.bestOffer = await soft<Known<MarketOffer>>(async () => {
        const os = await get(`/tokens/${mint}/offers_received?offset=0&limit=100`); if (!Array.isArray(os)) return unknown('provider_bad_answer');
        const nowSec = deps.now().getTime() / 1000;
        const live = os.map(obj).filter((o): o is J => !!o && o.tokenMint === mint && (typeof o.expiry !== 'number' || o.expiry <= 0 || o.expiry > nowSec)).map((o) => ({ o, p: solToLamports(o.price) })).filter((x): x is { o: J; p: MarketMoney } => !!x.p);
        if (!live.length) return NONE;
        const best = live.reduce((a, b) => (BigInt(b.p.amount) > BigInt(a.p.amount) ? b : a));
        return known({ orderId: str(best.o.pdaAddress), price: best.p, quantity: '1', bidder: str(best.o.buyer), venue: 'Magic Eden', scope: 'item', createdAt: null, expiresAt: typeof best.o.expiry === 'number' && best.o.expiry > 0 ? when(best.o.expiry) : null, fees: null });
      }, (c) => unknown(c));
      out.lastSale = await soft<Known<MarketSale>>(async () => { const evs = (await activities(mint, 0, 100)).map(eventOf).filter((e): e is MarketEvent => !!e), s = evs.find((e) => e.type === 'sale' && e.price);
        return s ? known({ price: s.price!, quantity: '1', at: s.at, tx: s.tx, buyer: s.to, seller: s.from, venue: 'Magic Eden' }) : evs.length < 100 ? NONE : unknown('no sale among the 100 most recent activities'); }, (c) => unknown(c));
      if (slug) out.collectionFloor = await soft<Known<MarketMoney>>(async () => { const s = obj(await get(`/collections/${slug}/stats`)), f = s?.floorPrice; return typeof f === 'number' && Number.isSafeInteger(f) && f > 0 ? known(money(String(f), SOL_NATIVE)) : f === 0 || f === undefined || f === null ? NONE : unknown('floor_not_an_integer_of_lamports'); }, (c) => unknown(c));
      return out;
    },
    async listings(r, cursor): Promise<Page<MarketListing>> {
      if (cursor) return { items: [], cursor: null };
      const ls = await get(`/tokens/${r.mint}/listings`); if (!Array.isArray(ls)) throw new NftProviderError('provider_bad_answer', 'magiceden', 'no_listings_list');
      return { items: ls.map((x) => listingOf(x, r.mint!)).filter((x): x is MarketListing => !!x && x !== 'disagree'), cursor: null };
    },
    async offers(r, cursor): Promise<Page<MarketOffer>> {
      const off = cursor && /^[0-9]{1,6}$/.test(cursor) ? Number(cursor) : 0;
      const os = await get(`/tokens/${r.mint}/offers_received?offset=${off}&limit=50`); if (!Array.isArray(os)) throw new NftProviderError('provider_bad_answer', 'magiceden', 'no_offers_list');
      const items = os.map(obj).flatMap((o): MarketOffer[] => { const p = o && o.tokenMint === r.mint ? solToLamports(o.price) : null; return o && p ? [{ orderId: str(o.pdaAddress), price: p, quantity: '1', bidder: str(o.buyer), venue: 'Magic Eden', scope: 'item', createdAt: null, expiresAt: typeof o.expiry === 'number' && o.expiry > 0 ? when(o.expiry) : null, fees: null }] : []; });
      return { items, cursor: os.length === 50 ? String(off + 50) : null };
    },
    async events(r, q: EventQuery): Promise<Page<MarketEvent>> {
      const off = q.cursor && /^[0-9]{1,6}$/.test(q.cursor) ? Number(q.cursor) : 0, n = Math.min(q.limit, 100), raw = await activities(r.mint!, off, n);
      const after = q.after ? Date.parse(q.after) : null, before = q.before ? Date.parse(q.before) : null;
      const items = raw.map(eventOf).filter((e): e is MarketEvent => !!e && (!q.types || q.types.includes(e.type)) && (after === null || (e.at !== null && Date.parse(e.at) >= after)) && (before === null || (e.at !== null && Date.parse(e.at) <= before)));
      return { items, cursor: raw.length === n ? String(off + n) : null };
    },
    async collection(ref: CollectionMarketRef): Promise<CollectionMarketData> {
      if (!SYMBOL.test(ref.slug)) throw new NftProviderError('bad_identifier', 'magiceden');
      const s = obj(await get(`/collections/${ref.slug}/stats`));
      if (!s || s.symbol !== ref.slug) throw new NftProviderError('provider_bad_answer', 'magiceden', 'another_collection_answered');
      const lam = (v: unknown): MarketMoney | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? money(String(v), SOL_NATIVE) : null);
      return { slug: ref.slug, name: null, description: null, url: `https://magiceden.io/marketplace/${ref.slug}`, imageUrl: null, bannerUrl: null, verification: null,
        floor: lam(s.floorPrice) ? known(lam(s.floorPrice)!) : s.floorPrice === 0 || s.floorPrice === undefined ? NONE : unknown('floor_not_an_integer_of_lamports'),
        volumes: s.volume7d !== undefined ? [{ interval: '7d', volume: lam(s.volume7d), reported: null, sales: null }] : [],
        listedCount: typeof s.listedCount === 'number' && Number.isSafeInteger(s.listedCount) && s.listedCount >= 0 ? known(String(s.listedCount)) : unknown(), owners: unknown('not reported by this source'), totalSupply: unknown('not reported by this source'), fees: null,
        traits: unknown('no_stated_item_total'),
        definitions: { floor: 'Magic Eden: `floorPrice` of the collection on Magic Eden, in lamports', volume: 'Magic Eden: `volume7d`, in lamports; kept only when the source gives a whole number of lamports', traits: 'Magic Eden gives trait counts among listed items without a collection total: no frequency is computed from them' } };
    },
  };
}
