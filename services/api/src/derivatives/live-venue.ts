// Venue access of the live execution engine: one full Hyperliquid adapter per network (testnet and mainnet are separate
// accounts with separate keys), the trading object bound to the PINNED asset table (the same table the signer uses), and the few
// venue reads the engine needs beyond the adapter's contract (order status by client id, API-wallet role, leverage setting).
//
// The read-only registry of venues.ts is untouched: paper trading and market data never see a trading object.
import { z } from 'zod';
import { createHlTrading, hlPinnedAssets, hlPinnedMismatch, type HlNetwork, type HlTrading } from '@spw/derivatives/live';
import { createHyperliquidAdapter, hlAccount, hlFrontendOrder, hlOrder, parseHl, VenueError, type Book, type HyperliquidAdapter, type Instrument, type Order, type Ticker } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { venueFailure } from './data.ts';

/** every L1 action carries `expiresAfter = nonce + this`: the venue itself refuses the signature after that time */
export const LIVE_ACTION_TTL_MS = 90_000;
const INSTRUMENTS_TTL_MS = 600_000;

// answers of the info requests used here — shapes read live on testnet, 2026-11-11 (docs/v4/venues/hyperliquid.md, section 13)
const orderStatusAnswer = z.union([
  z.looseObject({ status: z.literal('unknownOid') }),
  z.looseObject({ status: z.literal('order'), order: z.looseObject({ order: hlFrontendOrder, status: z.string().max(60), statusTimestamp: z.number().int().nonnegative() }) }),
]);
const userRoleAnswer = z.looseObject({ role: z.string().max(40), data: z.looseObject({ user: z.string().optional() }).optional() });
const activeAssetDataAnswer = z.looseObject({ leverage: z.looseObject({ type: z.enum(['cross', 'isolated']), value: z.number().int().min(1).max(1000) }) });

export interface LiveVenue {
  readonly network: HlNetwork;
  readonly adapter: HyperliquidAdapter;
  /** builder / submitter on the pinned table; `submit` reaches the mainnet exchange endpoint only when the server setting allows it.
   *  `ttlMs`: venue expiry of the actions it builds and sends, after their nonce (default LIVE_ACTION_TTL_MS; mandate orders use a shorter one) */
  trading(ttlMs?: number): HlTrading;
  instrument(id: string): Promise<Instrument>;
  /** ticker and book read NOW (never a cached value): the context of a live order */
  market(inst: Instrument): Promise<{ ticker: Ticker; book: Book }>;
  /** refuses to trade when the venue's live `meta` no longer matches the pinned asset table */
  assertPinned(): Promise<void>;
  /** the venue's own record of an order, by client order id (cloid) or order id; null = the venue knows no such order */
  orderStatus(account: string, id: string): Promise<Order | null>;
  /** `agent` + the account it signs for, once an API wallet is approved; `missing` for an address the venue has never seen */
  userRole(address: string): Promise<{ role: string; user: string | null }>;
  /** leverage setting of one instrument on the account (the venue keeps one per asset) */
  leverageOf(account: string, symbol: string): Promise<{ leverage: string; marginMode: 'cross' | 'isolated' }>;
}

export class LiveVenues {
  private readonly made = new Map<HlNetwork, LiveVenue>();
  private readonly o: { fetch?: typeof fetch; now: () => number; mainnetEnabled: () => boolean };
  constructor(o: { fetch?: typeof fetch; now?: () => number; mainnetEnabled: () => boolean }) { this.o = { ...o, now: o.now ?? Date.now }; }

  get(network: string): LiveVenue {
    if (network !== 'mainnet' && network !== 'testnet') throw new UserError('bad_request', 'network must be mainnet or testnet', 400);
    let v = this.made.get(network);
    if (!v) { v = this.make(network); this.made.set(network, v); }
    return v;
  }
  close(): void { for (const v of this.made.values()) v.adapter.close(); }

  private make(network: HlNetwork): LiveVenue {
    const { now, mainnetEnabled } = this.o;
    const adapter = createHyperliquidAdapter({ network, now, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
    let instruments: { at: number; list: Instrument[] } | null = null;
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw venueFailure(e); } };
    return {
      network, adapter,
      trading: (ttlMs = LIVE_ACTION_TTL_MS) => createHlTrading({ network, assets: hlPinnedAssets(network), http: adapter.http, now, expiresAfterMs: ttlMs,
        // two locks on the mainnet exchange endpoint: the adapter's own flag, set only from the server setting
        allowMainnetExchange: network === 'mainnet' && mainnetEnabled(),
        // V11 (B-02): with the server lock closed, cancels and reduce-only orders of an EXISTING position still leave (the adapter reads the action itself)
        allowMainnetExits: network === 'mainnet' }),
      async instrument(id) {
        if (!instruments || now() - instruments.at > INSTRUMENTS_TTL_MS) instruments = { at: now(), list: await wrap(() => adapter.instruments()) };
        const inst = instruments.list.find((i) => i.id === id);
        if (!inst) throw new UserError('unknown_instrument', `unknown instrument '${String(id).slice(0, 80)}' on Hyperliquid ${network}`, 404);
        return inst;
      },
      async market(inst) {
        const [tickers, book] = await wrap(() => Promise.all([adapter.tickers(), adapter.book(inst.symbol)]));
        const ticker = tickers.find((t) => t.instrument === inst.id);
        if (!ticker) throw new UserError('venue_unavailable', `Hyperliquid publishes no ticker for ${inst.symbol}`, 503);
        return { ticker, book };
      },
      async assertPinned() {
        const why = hlPinnedMismatch(network, await wrap(() => adapter.assets()));
        if (why) throw new UserError('asset_table_mismatch', `live trading is suspended: the venue's asset table no longer matches the table pinned in the wallet and in the signer (${why}). Nothing was signed.`, 503);
      },
      async orderStatus(account, id) {
        const oid = /^0x[0-9a-f]{32}$/.test(id) ? id : /^(0|[1-9]\d{0,15})$/.test(id) ? Number(id) : null;
        if (oid === null) throw new VenueError('unsupported', 'hyperliquid: order id must be a client order id or a numeric order id', { venue: 'hyperliquid' });
        return wrap(async () => {
          const a = parseHl(orderStatusAnswer, await adapter.http.info({ type: 'orderStatus', user: hlAccount(account), oid }), 'orderStatus');
          return a.status === 'unknownOid' ? null : hlOrder(a.order.order, a.order.status, a.order.statusTimestamp);
        });
      },
      async userRole(address) {
        return wrap(async () => {
          const a = parseHl(userRoleAnswer, await adapter.http.info({ type: 'userRole', user: hlAccount(address) }), 'userRole');
          return { role: a.role, user: a.data?.user ? a.data.user.toLowerCase() : null };
        });
      },
      async leverageOf(account, symbol) {
        return wrap(async () => {
          const a = parseHl(activeAssetDataAnswer, await adapter.http.info({ type: 'activeAssetData', user: hlAccount(account), coin: symbol }), 'activeAssetData');
          return { leverage: String(a.leverage.value), marginMode: a.leverage.type };
        });
      },
    };
  }
}
