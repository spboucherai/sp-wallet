// Venue adapters for the markets-hub tests: they serve what the REAL adapters answered on 2026-11-15, recorded read-only in
// the wallet's normalised models (scripts/record-markets-hub-fixtures.mts → test/fixtures/markets-hub/): every instrument and
// ticker of the four venues, the BTC and ETH order books, the GMX pool figures, 24 h of funding. Timestamps are shifted to the
// test clock (the age each figure had when it was recorded is kept). A venue can be scripted to throw or to HANG. No network.
import { readFileSync } from 'node:fs';
import { VenueError, type Book, type DecStr, type GmxLiquidity, type Instrument, type Ticker, type VenueAdapter, type VenueId } from '@spw/derivatives';
import type { SpotPort } from '../src/markets-hub/hub.ts';

export interface Recorded { venue: VenueId; recordedAt: number; instruments: Instrument[]; tickers: Ticker[]; books: Record<string, Book>; funding: Record<string, { ts: number; rate: DecStr }[]>; liquidity?: GmxLiquidity[] }
export const recorded = (v: VenueId): Recorded => JSON.parse(readFileSync(new URL(`./fixtures/markets-hub/${v}.json`, import.meta.url), 'utf8'));
export const VENUES: VenueId[] = ['hyperliquid', 'gmx', 'dydx', 'edgex'];
export class Clock { t: number; constructor(t: number) { this.t = t; } now = (): number => this.t; advance(ms: number): number { this.t += ms; return this.t; } }

export interface Ctl {
  mode: 'ok' | 'throw' | 'hang';
  /** what part of the venue the mode applies to (default: everything) */
  only: ('instruments' | 'tickers' | 'book' | 'liquidity' | 'funding')[] | null;
  calls: Record<string, number>;
  /** lets the hung calls answer (as if the venue finally replied) */
  release(): void;
  /** rewrites a recorded book before it is served (to script a price difference) */
  bookPatch: ((b: Book) => Book) | null;
}
export interface RecordedVenues { adapters: Record<VenueId, VenueAdapter & { liquidity?: (symbol?: string) => Promise<GmxLiquidity[]> }>; ctl: Record<VenueId, Ctl>; rec: Record<VenueId, Recorded> }

const CAPS = { marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, marginModes: [], subaccounts: false, testnet: false, stream: false, notes: [] };

export function recordedVenues(clock: Clock): RecordedVenues {
  const rec = Object.fromEntries(VENUES.map((v) => [v, recorded(v)])) as Record<VenueId, Recorded>;
  const ctl = {} as Record<VenueId, Ctl>, adapters = {} as RecordedVenues['adapters'];
  for (const id of VENUES) {
    const r = rec[id], waiting: (() => void)[] = [];
    const c: Ctl = { mode: 'ok', only: null, calls: {}, bookPatch: null, release: () => { for (const f of waiting.splice(0)) f(); } };
    ctl[id] = c;
    // the age a figure had at recording time is kept: ts' = clock − (recordedAt − ts)
    const at = (ts: number): number => clock.now() - (r.recordedAt - ts);
    const gate = async <T>(what: NonNullable<Ctl['only']>[number], fn: () => T): Promise<T> => {
      c.calls[what] = (c.calls[what] ?? 0) + 1;
      if (c.mode !== 'ok' && (c.only === null || c.only.includes(what))) {
        if (c.mode === 'throw') throw new VenueError('unavailable', `${id}: network error (scripted outage)`, { venue: id });
        await new Promise<void>((resolve) => { waiting.push(resolve); });   // hangs until release()
      }
      return fn();
    };
    const refuse = async (): Promise<never> => { throw new VenueError('unsupported', `${id}: not part of the recorded market data`, { venue: id }); };
    adapters[id] = {
      id, network: 'mainnet', capabilities: CAPS,
      instruments: () => gate('instruments', () => r.instruments),
      tickers: () => gate('tickers', () => r.tickers.map((t) => ({ ...t, ts: at(t.ts) }))),
      book: (symbol) => gate('book', () => { const b = r.books[symbol]; if (!b) throw new VenueError('rejected', `${id}: no recorded book for ${symbol}`, { venue: id }); const out = { ...b, ts: at(b.ts) }; return c.bookPatch ? c.bookPatch(out) : out; }),
      trades: async () => [], candles: async () => [],
      fundingHistory: (symbol, o) => gate('funding', () => (r.funding[symbol] ?? []).map((x) => ({ ts: at(x.ts), rate: x.rate, premium: null })).filter((x) => x.ts >= o.start)),
      account: refuse, positions: refuse, openOrders: refuse, orderHistory: refuse, fills: refuse, funding: refuse,
      ...(r.liquidity ? { liquidity: () => gate('liquidity', () => r.liquidity!.map((l) => ({ ...l, ts: at(l.ts) }))) } : {}),
    };
  }
  return { adapters, ctl, rec };
}

/** 25 hourly bars ending at the last closed hour before `now`: BTC climbs from 64 000 to 64 720, ETH is flat at 1 800 */
export function spotPort(clock: Clock, o: { ingested?: string[]; fresh?: boolean } = {}): SpotPort & { calls: number } {
  const H = 3_600_000;
  const p: SpotPort & { calls: number } = {
    calls: 0,
    ingested: async () => o.ingested ?? ['BTC', 'ETH'],
    quality: async () => (o.ingested ?? ['BTC', 'ETH']).map((symbol) => ({ symbol, interval: '1h', fresh: o.fresh ?? true, status: 'ok' })),
    bars: async (symbol, limit) => {
      p.calls += 1;
      const last = Math.floor((clock.now() - 10_000) / H) * H - H;
      return Array.from({ length: 25 }, (_, k) => ({ ts: last - (24 - k) * H, close: symbol === 'BTC' ? 64000 + 30 * k : 1800, volume: symbol === 'BTC' ? 10 : 100, source: k % 2 ? 'coinbase' : 'kraken' })).slice(-limit);
    },
  };
  return p;
}
