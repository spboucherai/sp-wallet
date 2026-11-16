// Fixture-backed venue adapters for the derivatives tests: the REAL adapters of @spw/derivatives over a replaying fetch
// (answers recorded from the venues' public endpoints, packages/derivatives/test/fixtures/), wrapped so that a test can script
// the Hyperliquid BTC ticker, book and funding rates, cut a venue off, and drive a fake stream. No network.
import { useTestDatabase } from './test-db.ts';
import { readFileSync } from 'node:fs';
import { createDydxAdapter, createGmxAdapter, createHyperliquidAdapter, VenueError, type Book, type DecStr, type Ticker, type VenueAdapter } from '@spw/derivatives';
import { fx, replay, type Route } from '../../../packages/derivatives/test/venue-helpers.ts';

/** just after the fixtures were recorded */
export const T0 = Date.parse('2026-11-11T03:05:30Z');
export const BTC = 'hyperliquid:BTC';
export const GMX_BTC = 'gmx:BTC/USD [BTC-USDC]';
export const DYDX_BTC = 'dydx:BTC-USD';

const hlFx = (name: string): { status: number; body: unknown; request: { user?: string } } =>
  JSON.parse(readFileSync(new URL(`../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-${name}.json`, import.meta.url), 'utf8'));
export const HL_ACCOUNT = hlFx('clearinghouseState').request.user!;
export const GMX_ACCOUNT = '0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6';

/**
 * V11 (B-08): what `verifyOwnerAssertion` (auth.ts) does against the API's credentials table, against ONE software passkey:
 * a real WebAuthn verification of the assertion over `challenge`, user verification required.
 */
export function passkeyVerifier(pk: { id: string; publicKey: string }, rpId: string, origin: string) {
  let counter = 0;
  return async (assertion: unknown, challenge: Uint8Array): Promise<void> => {
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const response = assertion as { id?: string };
    if (response?.id !== pk.id) throw new Error('unknown credential');
    const v = await verifyAuthenticationResponse({ response: assertion as never, expectedChallenge: Buffer.from(challenge).toString('base64url'), expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true,
      credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')), counter } });
    if (!v.verified || !v.authenticationInfo.userVerified) throw new Error('approval not verified');
    counter = v.authenticationInfo.newCounter;
  };
}

export class Clock { t: number; constructor(t = T0) { this.t = t; } now = (): number => this.t; advance(ms: number): number { this.t += ms; return this.t; } }

export interface FakeStream {
  subs: { type: string; symbol: string; on: (ev: unknown) => void; onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void; open: boolean }[];
  open(): FakeStream['subs']; emit(ev: unknown): void; status(s: 'connected' | 'reconnecting' | 'stale'): void;
}
function fakeStream(): FakeStream & { stream: NonNullable<VenueAdapter['stream']> } {
  const subs: FakeStream['subs'] = [];
  const open = () => subs.filter((s) => s.open);
  return {
    subs, open,
    emit: (ev) => { for (const s of open()) if ((ev as { type: string }).type === s.type || (ev as { type: string }).type === 'gap') s.on(ev); },
    status: (st) => { for (const s of open()) s.onStatus(st); },
    stream: (sub, on, onStatus) => {
      if (sub.type === 'account') throw new Error('account streams are not used');
      const s = { type: sub.type, symbol: sub.symbol, on, onStatus, open: true };
      subs.push(s);
      return () => { s.open = false; };
    },
  };
}

export interface Venues {
  adapters: { hyperliquid: VenueAdapter; gmx: VenueAdapter; dydx: VenueAdapter };
  /** scripted Hyperliquid BTC market (null = the recorded fixture) */
  hl: { ticker: Partial<Ticker> | null; book: { bids: [DecStr, DecStr][]; asks: [DecStr, DecStr][] } | null; funding: { ts: number; rate: DecStr }[] | null;
    /** how old the venue's own book timestamp is (0 = stamped now) */ bookAgeMs: number;
    down: boolean; /** the adapter's local weight budget refuses every request */ rateLimited: boolean; calls: Record<string, number>; stream: FakeStream };
  dydx: { accountCalls: number; stream: FakeStream };
  gmx: { down: boolean };
}

export function fixtureVenues(clock: Clock): Venues {
  const now = clock.now;
  const HL: Record<string, string> = { meta: 'meta', metaAndAssetCtxs: 'metaAndAssetCtxs', l2Book: 'l2Book-BTC', recentTrades: 'recentTrades-BTC', candleSnapshot: 'candleSnapshot-BTC-1h',
    fundingHistory: 'fundingHistory-BTC', clearinghouseState: 'clearinghouseState', frontendOpenOrders: 'frontendOpenOrders' };
  const hlState: Venues['hl'] = { ticker: null, book: null, funding: null, bookAgeMs: 0, down: false, rateLimited: false, calls: {}, stream: null as never };
  const hlFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string };
    if (String(url).endsWith('/exchange')) throw new Error('the trading endpoint must never be called');
    hlState.calls[body.type] = (hlState.calls[body.type] ?? 0) + 1;
    const name = HL[body.type];
    if (!name) throw new Error(`no fixture for ${body.type}`);
    const f = hlFx(name);
    return new Response(JSON.stringify(f.body), { status: f.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const hlReal = createHyperliquidAdapter({ network: 'mainnet', fetch: hlFetch, now });
  const hlStream = fakeStream(), dydxStream = fakeStream();
  hlState.stream = hlStream;
  const guard = (): void => {
    if (hlState.rateLimited) throw new VenueError('rate_limited', 'hyperliquid: local weight budget exhausted (1200/1200 per minute) before info metaAndAssetCtxs', { venue: 'hyperliquid' });
    if (hlState.down) throw new VenueError('unavailable', 'hyperliquid: network error (scripted outage)', { venue: 'hyperliquid' });
  };
  const hyperliquid: VenueAdapter = {
    ...hlReal, stream: hlStream.stream,
    instruments: async () => { guard(); return hlReal.instruments(); },
    tickers: async () => { guard(); const all = await hlReal.tickers(); return all.map((t) => (t.instrument === BTC && hlState.ticker ? { ...t, ...hlState.ticker, ts: now() } : t)); },
    book: async (symbol, depth) => {
      guard();
      if (symbol === 'BTC' && hlState.book) return { instrument: BTC, bids: hlState.book.bids, asks: hlState.book.asks, ts: now() - hlState.bookAgeMs };
      return { ...(await hlReal.book(symbol, depth)), ts: now() - hlState.bookAgeMs };      // the recorded book, stamped with the test clock
    },
    trades: async (s, l) => { guard(); return hlReal.trades(s, l); },
    candles: async (s, i, o) => { guard(); return hlReal.candles(s, i, o); },
    fundingHistory: async (s, o) => { guard(); return hlState.funding ? hlState.funding.filter((x) => x.ts >= o.start).map((x) => ({ ...x, premium: null })) : hlReal.fundingHistory(s, o); },
  };

  const gmxState = { down: false };
  const GMX_ROUTES: Route[] = [
    ['/markets/tickers', fx('gmx', 'v1-markets-tickers')], ['/markets/config', fx('gmx', 'v1-markets-config')], [/\/v1\/markets$/, fx('gmx', 'v1-markets')],
    ['/tokens/info', fx('gmx', 'v1-tokens-info')], ['/pairs', fx('gmx', 'v1-pairs')], ['/prices/ohlcv', fx('gmx', 'v1-ohlcv-BTC-1h')], ['/rates', fx('gmx', 'v1-rates-BTC-7d')],
    ['squids.live', fx('gmx', 'graphql-tradeActions-BTC')], ['/positions', fx('gmx', 'v1-positions')], ['/orders', fx('gmx', 'v1-orders')], ['/trades', fx('gmx', 'v1-trades')],
  ];
  const gmxReplay = replay(GMX_ROUTES);
  const gmxFetch = (async (url: string, init?: RequestInit) => { if (gmxState.down) return new Response('bad gateway', { status: 502 }); return gmxReplay.fetch(url, init); }) as unknown as typeof fetch;
  const gmx = createGmxAdapter({ fetch: gmxFetch, now, cacheMs: 0 });

  const dydxState = { accountCalls: 0, stream: dydxStream };
  const DYDX_ROUTES: Route[] = [
    [/\/v4\/perpetualMarkets$/, fx('dydx', 'perpetualMarkets')], ['/orderbooks/perpetualMarket/BTC-USD', fx('dydx', 'orderbook-BTC-USD')], ['/trades/perpetualMarket/', fx('dydx', 'trades-BTC-USD')],
    ['/candles/perpetualMarkets/', fx('dydx', 'candles-BTC-USD-1HOUR')], ['/historicalFunding/', fx('dydx', 'historicalFunding-BTC-USD')],
  ];
  const dydxReplay = replay(DYDX_ROUTES);
  const dydxFetch = (async (url: string, init?: RequestInit) => {
    if (/\/addresses\/|\/orders|\/fills|\/fundingPayments/.test(String(url))) { dydxState.accountCalls += 1; throw new Error('a dYdX account endpoint must never be called'); }
    return dydxReplay.fetch(url, init);
  }) as unknown as typeof fetch;
  const dydx: VenueAdapter = { ...createDydxAdapter({ fetch: dydxFetch, now }), stream: dydxStream.stream };

  return { adapters: { hyperliquid, gmx, dydx }, hl: hlState, dydx: dydxState, gmx: gmxState };
}

/** a simple BTC market around `mid`: one level each side 5 away, a second one 10 away */
export function setMarket(v: Venues, mid: number, o: { bids?: [DecStr, DecStr][]; asks?: [DecStr, DecStr][] } = {}): void {
  v.hl.ticker = { mark: String(mid), index: String(mid), mid: String(mid), funding: '0.0000125' };
  v.hl.book = { bids: o.bids ?? [[String(mid - 5), '1'], [String(mid - 10), '2']], asks: o.asks ?? [[String(mid + 5), '1'], [String(mid + 10), '2']] };
}

/** creates the database if needed (like the market tests) and points the API's environment at it; call before importing src/ */
export async function useDatabase(label: string): Promise<void> {
  // v8: `label` names the test file; the database itself is unique per checkout and per run (test-db.ts) and
  // is dropped by vitest's global teardown — two checkouts running the suite at once no longer share anything
  await useTestDatabase(label);
}
export type { Book };
