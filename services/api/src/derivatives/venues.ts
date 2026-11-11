// Venue registry of the derivatives module (contract: docs/v4/DERIVATIVES-ARCHITECTURE.md, "API contract (wave 2").
// READ side only: the registry hands out a narrowed view of each adapter (market data, account reads, stream). The adapters'
// trading objects, signing helpers and raw HTTP clients are not reachable from here, so nothing that goes through this registry can build,
// sign or send an order to a venue.
import {
  createDydxAdapter, createGmxAdapter, createHyperliquidAdapter, VenueError,
  type Capabilities, type DecStr, type GmxLiquidity, type VenueAdapter, type VenueId,
} from '@spw/derivatives';
import { UserError } from '../config.ts';

/** what the service may call on a venue: reads and the public stream — never `trading`, never a raw HTTP client */
export type ReadAdapter = Pick<VenueAdapter, 'id' | 'network' | 'capabilities' | 'instruments' | 'tickers' | 'book' | 'trades' | 'candles' | 'fundingHistory'
  | 'account' | 'positions' | 'openOrders'> & { stream?: VenueAdapter['stream']; liquidity?: (symbol?: string) => Promise<GmxLiquidity[]> };

/** facts of docs/v4/venues/contract-differences.md used by the comparison table (base fee tier, checked 2026-11-10) */
export interface VenueFacts {
  /** base-tier taker fee in basis points; null when the venue has no maker/taker schedule (read from the venue instead) */
  takerFeeBps: DecStr | null; makerFeeBps: DecStr | null;
  /** fee rates used by a paper account on this venue (fractions of notional) */
  paperFees: { taker: DecStr; maker: DecStr } | null;
  hasOrderBook: boolean;
  notes: string[];
}

export interface VenueEntry {
  id: VenueId; name: string; adapter: ReadAdapter;
  /** a non-null text means: market data only — no account read, no paper account; the UI shows the text */
  restriction: string | null;
  facts: VenueFacts;
}

export type VenueStatus = 'ok' | 'degraded' | 'down';
export interface VenueHealth { status: VenueStatus; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null; consecutiveFailures: number }

export const DYDX_RESTRICTION = 'dYdX is served for market data only: its terms of use exclude Canada (and the United States and the United Kingdom) and its indexer geoblocks account reads from the owner\'s network. No account view and no paper account are offered on this venue, so that it cannot be mistaken for a venue the owner may trade on.';

/** failures in a row before a venue is reported `down` (1 … DOWN_AFTER − 1 = `degraded`) */
export const DOWN_AFTER = 3;
/** VenueError codes that say something about the venue's availability (a refused or unsupported request does not) */
const HEALTH_CODES = new Set(['unavailable', 'bad_answer', 'stale', 'rate_limited']);

function readOnly(a: VenueAdapter & { liquidity?: ReadAdapter['liquidity'] }, restriction: string | null): ReadAdapter {
  const refuse = async (): Promise<never> => { throw new UserError('venue_restricted', restriction ?? 'account reads are not available on this venue', 403); };
  const accountOk = restriction === null && a.capabilities.account;
  const capabilities: Capabilities = restriction === null ? a.capabilities
    // a restricted venue declares only what the wallet really offers on it (principle 7)
    : { ...a.capabilities, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, notes: [restriction, ...a.capabilities.notes] };
  const view: ReadAdapter = {
    id: a.id, network: a.network, capabilities,
    instruments: () => a.instruments(), tickers: () => a.tickers(), book: (s, d) => a.book(s, d), trades: (s, l) => a.trades(s, l),
    candles: (s, i, o) => a.candles(s, i, o), fundingHistory: (s, o) => a.fundingHistory(s, o),
    account: accountOk ? (x) => a.account(x) : refuse, positions: accountOk ? (x) => a.positions(x) : refuse, openOrders: accountOk ? (x) => a.openOrders(x) : refuse,
  };
  if (a.stream) {
    const stream = a.stream.bind(a);
    view.stream = (sub, on, onStatus) => {
      if (sub.type === 'account') throw new UserError('unsupported', 'account streams are not part of this wave', 400);
      return stream(sub, on, onStatus);
    };
  }
  if (a.liquidity) view.liquidity = (s) => a.liquidity!(s);
  return view;
}

export class VenueRegistry {
  readonly entries: Map<VenueId, VenueEntry>;
  private readonly healthOf = new Map<VenueId, VenueHealth>();
  private readonly now: () => number;

  constructor(entries: VenueEntry[], now: () => number = Date.now) {
    this.entries = new Map(entries.map((e) => [e.id, e]));
    this.now = now;
    for (const e of entries) this.healthOf.set(e.id, { status: 'ok', lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0 });
  }

  list(): VenueEntry[] { return [...this.entries.values()]; }
  has(id: string): id is VenueId { return this.entries.has(id as VenueId); }
  get(id: string): VenueEntry {
    const e = this.entries.get(id as VenueId);
    if (!e) throw new UserError('unknown_venue', `unknown venue '${String(id).slice(0, 40)}'`, 404);
    return e;
  }

  /** account reads (watch, future venue accounts) are allowed only where the adapter declares them and nothing restricts the venue */
  accountAllowed(id: string): boolean { const e = this.get(id); return e.restriction === null && e.adapter.capabilities.account; }
  /** throws the restriction text when the venue is market data only */
  assertAccountAllowed(id: string): VenueEntry {
    const e = this.get(id);
    if (e.restriction !== null) throw new UserError('venue_restricted', e.restriction, 403);
    if (!e.adapter.capabilities.account) throw new UserError('venue_no_account', `${e.name} does not expose account reads`, 422);
    return e;
  }

  health(id: VenueId): VenueHealth { return { ...this.healthOf.get(id)! }; }

  /** every venue call of the service goes through here: the outcome feeds the venue's health */
  async call<T>(id: VenueId, fn: (a: ReadAdapter) => Promise<T>): Promise<T> {
    const e = this.get(id), h = this.healthOf.get(id)!;
    try {
      const out = await fn(e.adapter);
      h.lastOkAt = this.now(); h.consecutiveFailures = 0; h.status = 'ok'; h.lastError = null;
      return out;
    } catch (err) {
      if (err instanceof VenueError && HEALTH_CODES.has(err.code)) {
        // the local weight budget refusing a request says nothing about the venue being down: it degrades, it never downs
        const local = err.code === 'rate_limited';
        h.consecutiveFailures = local ? Math.min(h.consecutiveFailures + 1, DOWN_AFTER - 1) : h.consecutiveFailures + 1;
        h.lastErrorAt = this.now(); h.lastError = `${err.code}: ${err.message}`.slice(0, 200);
        h.status = h.consecutiveFailures >= DOWN_AFTER ? 'down' : 'degraded';
      } else if (!(err instanceof VenueError) && !(err instanceof UserError)) {
        h.consecutiveFailures += 1; h.lastErrorAt = this.now(); h.lastError = `error: ${(err as Error)?.message ?? String(err)}`.slice(0, 200);
        h.status = h.consecutiveFailures >= DOWN_AFTER ? 'down' : 'degraded';
      }
      throw err;
    }
  }
}

export const HYPERLIQUID_FACTS: VenueFacts = {
  takerFeeBps: '4.5', makerFeeBps: '1.5', paperFees: { taker: '0.00045', maker: '0.00015' }, hasOrderBook: true,
  notes: [
    'On-chain central limit order book; immediate match.',
    'Mark price = median of oracle + EMA of (book mid − oracle), book median, and a weighted median of CEX perp mids; the oracle is USDT-denominated (quanto: USDT PnL paid in USDC, no conversion).',
    'Funding is paid every hour, peer to peer, on size × oracle price × rate; the hourly rate is one eighth of an 8 h rate; cap 0.5 % per hour.',
    'Cross (default) or isolated margin; maintenance margin is half of the initial margin at maximum leverage (tiered by size).',
    'Fee shown is the base tier (taker 0.045 %, maker 0.015 %); volume tiers and staking discounts exist.',
    'Liquidation through the book, then the liquidator vault; no separate liquidation fee, the maintenance margin is not returned in a backstop.',
  ],
};
export const DYDX_FACTS: VenueFacts = {
  takerFeeBps: '5', makerFeeBps: '1', paperFees: null, hasOrderBook: true,
  notes: [
    'On-chain order book (short-term orders live in validator memory); the book is thin compared with Hyperliquid.',
    'No separate mark price: margin and liquidation use the oracle price (validators\' aggregate of spot exchanges, USD).',
    'Funding is paid every hour on size × oracle price × rate; the rate shown is the estimated next hourly rate.',
    'Cross margin inside a subaccount; no leverage setting (50× bound from a 2 % initial margin); liquidation penalty up to 1.5 %.',
    'Fee shown is the base tier (taker 0.05 %, maker 0.01 %).',
    'Eligibility: the terms exclude the United States, Canada and the United Kingdom.',
  ],
};
export const GMX_FACTS: VenueFacts = {
  takerFeeBps: null, makerFeeBps: null, paperFees: null, hasOrderBook: false,
  notes: [
    'No order book: trades execute against a GM liquidity pool at the signed oracle price (longs open at max, close at min), adjusted by price impact; one instrument per pool.',
    'Execution takes two transactions (request, then keeper execution at a later oracle price); an order can be cancelled or frozen instead of filled.',
    'Funding accrues per second and is quoted per hour; the larger open-interest side also pays a borrowing fee.',
    'Isolated margin per position only; collateral is the pool\'s long or short token (it may move with the market).',
    'Position fee 0.04 % when the trade improves the long/short balance, 0.06 % otherwise (the higher one is shown); plus price impact, an execution fee in ETH and Arbitrum gas.',
    'Maximum leverage is the contract bound; the effective maximum is lower and falls as open interest grows.',
  ],
};

/** the real adapters, on public read endpoints only (mainnet). `fetch` is injectable for the smoke script and tests. */
export function createDefaultRegistry(o: { fetch?: typeof fetch; now?: () => number } = {}): VenueRegistry {
  const now = o.now ?? Date.now, f = o.fetch === undefined ? {} : { fetch: o.fetch };
  // no `assets` and no `trading` option: `adapter.trading` stays undefined, and the read-only view does not expose it anyway
  return createRegistry({
    hyperliquid: createHyperliquidAdapter({ network: 'mainnet', now, ...f }),
    gmx: createGmxAdapter({ chain: 'arbitrum', now, ...f }),
    dydx: createDydxAdapter({ network: 'mainnet', now, ...f }),
  }, now);
}

/** registry over arbitrary adapters (tests: fixture-backed fakes). The same narrowing and the same dYdX restriction apply. */
export function createRegistry(adapters: Partial<Record<VenueId, VenueAdapter & { liquidity?: ReadAdapter['liquidity'] }>>, now: () => number = Date.now): VenueRegistry {
  const out: VenueEntry[] = [];
  if (adapters.hyperliquid) out.push({ id: 'hyperliquid', name: 'Hyperliquid', adapter: readOnly(adapters.hyperliquid, null), restriction: null, facts: HYPERLIQUID_FACTS });
  if (adapters.gmx) out.push({ id: 'gmx', name: 'GMX v2 (Arbitrum)', adapter: readOnly(adapters.gmx, null), restriction: null, facts: GMX_FACTS });
  if (adapters.dydx) out.push({ id: 'dydx', name: 'dYdX v4', adapter: readOnly(adapters.dydx, DYDX_RESTRICTION), restriction: DYDX_RESTRICTION, facts: DYDX_FACTS });
  return new VenueRegistry(out, now);
}
