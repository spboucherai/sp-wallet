// Universal derivatives router — service side (docs/v4/ROUTER.md). SIMULATION ONLY: this file reads public market data
// through `DerivData`, public chain data through `ChainCostsReader`, and asks the paper / live services what their risk policy
// would SAY about the order (their `preview`, which places nothing). It builds no order, signs nothing, calls no signer and no
// venue trading endpoint. The estimates themselves are the pure functions of @spw/derivatives (router.ts).
import { z } from 'zod';
import {
  D, OrderIntentSchema, ROUTER_FACTS, orderBodyFor, routeOrder,
  type ChainCosts, type DecStr, type ExecutionEstimate, type Instrument, type RiskResult, type RouteResult, type RouterAccount, type VenueId, type VenueSnapshot,
} from '@spw/derivatives';
import { UserError } from '../config.ts';
import { createChainCostsReader, type ChainCostsReader } from './chain-costs.ts';
import type { DerivData } from './data.ts';
import type { OrderBody, PaperService } from './paper.ts';
import type { VenueEntry, VenueRegistry } from './venues.ts';

export const MAX_ROUTE_ACCOUNTS = 6;
/** instruments estimated per venue for one base (GMX lists one per pool) */
export const MAX_INSTRUMENTS_PER_VENUE = 8;
const FUNDING_RANGE_HOURS = 24;
const AccountIds = z.array(z.uuid()).max(MAX_ROUTE_ACCOUNTS).default([]);

/** what the router needs from controlled live trading: the accounts, and its `preview` (risk engine on the venue's real state; nothing is placed) */
export interface LivePort {
  list(): Promise<{ id: string; venue: string; network: string; label: string; mode: string; account: string }[]>;
  preview(id: string, body: OrderBody): Promise<{ risk: RiskResult }>;
}
export interface PolicyCheck {
  accountId: string; label: string; kind: 'paper' | 'venue'; mode: string; network: string;
  /** null: the policy was not asked (the reason says why) */
  accepted: boolean | null; code: string | null; reason: string | null;
  source: 'risk_engine' | 'not_checked';
}
export interface VenueLimits { accepted: boolean; codes: string[]; note: string }
export type RoutedCandidate = ExecutionEstimate & { risk: { venue: VenueLimits; accounts: PolicyCheck[] } };
export interface RouteAnswer extends Omit<RouteResult, 'candidates'> { candidates: RoutedCandidate[]; errors: { venue: VenueId; message: string }[]; chain: ChainCosts }

interface Acct { id: string; venue: VenueId; network: string; label: string; kind: 'paper' | 'venue'; mode: string; equity: DecStr | null; freeCollateral: DecStr | null; error: string | null }
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const WALLET: Record<VenueId, { trading: 'paper' | 'none'; note: string }> = {
  hyperliquid: { trading: 'paper', note: 'this wallet trades Hyperliquid in simulation (paper account); live trading exists and stays off until the owner authorizes a venue account with his passkey' },
  gmx: { trading: 'none', note: 'this wallet only READS GMX: no GMX order can be built or sent from it today' },
  dydx: { trading: 'none', note: 'market data only on this venue' },
};

export class RouteService {
  readonly data: DerivData; readonly paper: PaperService; readonly registry: VenueRegistry;
  private readonly chain: ChainCostsReader; private readonly live: LivePort | null;

  constructor(o: { data: DerivData; paper: PaperService; chain?: ChainCostsReader; live?: LivePort | null }) {
    this.data = o.data; this.paper = o.paper; this.registry = o.data.registry; this.live = o.live ?? null;
    this.chain = o.chain ?? createChainCostsReader({ now: o.data.now });
  }

  /** bases listed on at least one venue, with the venues and instruments; a restricted venue is flagged, not hidden */
  async assets(): Promise<{ assets: { base: string; venues: { venue: VenueId; name: string; instruments: string[]; restriction: string | null }[]; candidateVenues: number }[]; errors: { venue: VenueId; message: string }[]; ts: number }> {
    const errors: { venue: VenueId; message: string }[] = [], by = new Map<string, Map<VenueId, string[]>>();
    await Promise.all(this.registry.list().map(async (v) => {
      try {
        for (const i of (await this.data.instruments(v.id)).value) {
          if (i.status === 'halted') continue;
          const base = i.base.toUpperCase(), m = by.get(base) ?? new Map<VenueId, string[]>();
          m.set(v.id, [...(m.get(v.id) ?? []), i.id]); by.set(base, m);
        }
      } catch (e) { errors.push({ venue: v.id, message: msg(e) }); }
    }));
    const order = this.registry.list().map((v) => v.id);
    const assets = [...by.entries()].map(([base, m]) => {
      const venues = order.filter((id) => m.has(id)).map((id) => { const v = this.registry.get(id); return { venue: id, name: v.name, instruments: m.get(id)!, restriction: v.restriction }; });
      return { base, venues, candidateVenues: venues.filter((v) => v.restriction === null).length };
    }).filter((a) => /^[A-Z0-9]{1,15}$/.test(a.base))
      // the bases that can be compared across venues first; then by name — an order of the list, not of the venues
      .sort((a, b) => b.candidateVenues - a.candidateVenues || b.venues.length - a.venues.length || a.base.localeCompare(b.base));
    if (errors.length === order.length && errors.length > 0) throw new UserError('venue_unavailable', errors[0]!.message, 503);
    return { assets, errors, ts: this.data.now() };
  }

  private async accounts(ids: string[]): Promise<Acct[]> {
    if (!ids.length) return [];
    const [paper, live] = await Promise.all([this.paper.list(), this.live ? this.live.list().catch(() => []) : Promise.resolve([])]);
    return Promise.all(ids.map(async (id): Promise<Acct> => {
      const p = paper.find((a) => a.id === id);
      if (p) return { id, venue: p.venue, network: p.network, label: p.label, kind: 'paper', mode: p.mode, equity: p.state.equity, freeCollateral: p.state.freeCollateral, error: null };
      const l = live.find((a) => a.id === id);
      if (!l) throw new UserError('unknown_account', `unknown derivatives account ${id}`, 404);
      const base = { id, venue: l.venue as VenueId, network: l.network, label: l.label, kind: 'venue' as const, mode: l.mode };
      // the router's market data is mainnet: a testnet account's collateral is play money on another book
      if (l.network !== this.registry.get(l.venue).adapter.network) return { ...base, equity: null, freeCollateral: null, error: `this account is on ${l.network}; the router prices ${this.registry.get(l.venue).adapter.network} markets` };
      try { const w = await this.data.watch(base.venue, l.account); return { ...base, equity: w.state.equity, freeCollateral: w.state.freeCollateral, error: null }; }
      catch (e) { return { ...base, equity: null, freeCollateral: null, error: msg(e) }; }
    }));
  }

  private async snapshot(v: VenueEntry, inst: Instrument, chain: ChainCosts, acct: Acct | undefined): Promise<VenueSnapshot> {
    const ticker = await this.data.ticker(inst);
    const s: VenueSnapshot = {
      venue: v.id, restriction: v.restriction,
      wallet: acct?.kind === 'venue' && acct.mode === 'MANUAL_LIVE' && acct.error === null ? { trading: 'live', note: `« ${acct.label} » is a venue account authorized for live trading (passkey per order)` } : WALLET[v.id],
      instrument: inst, ticker, book: null, gmx: null, fundingRange: null, chain,
      account: acct && acct.equity !== null && acct.freeCollateral !== null ? { id: acct.id, label: acct.label, kind: acct.kind, mode: acct.mode, equity: acct.equity, freeCollateral: acct.freeCollateral } satisfies RouterAccount : null,
    };
    const soft = async (fn: () => Promise<void>): Promise<void> => { try { await fn(); } catch (e) { s.unavailable = msg(e); } };
    if (v.facts.hasOrderBook) await soft(async () => { s.book = await this.data.book(inst); });
    else await soft(async () => { s.gmx = await this.data.liquidity(inst); });
    // the last day of the hourly rate, to say how much the carry can move; without it the router assumes ±100 %
    try {
      const h = (await this.data.funding(inst, FUNDING_RANGE_HOURS)).value;
      if (h.length >= 2) {
        const perHour = h.map((x) => D.div(D.mul(D.from(x.rate), D.from(3600n)), D.from(BigInt(inst.fundingIntervalSec)), 18, 'half_even'));
        s.fundingRange = { minPerHour: D.str(perHour.reduce((a, b) => D.min(a, b))), maxPerHour: D.str(perHour.reduce((a, b) => D.max(a, b))), hours: FUNDING_RANGE_HOURS };
      }
    } catch { /* no history: the estimate says so */ }
    return s;
  }

  /** what an account's own risk policy says about the order — through the service's `preview`, which stores and places nothing */
  private async policy(e: ExecutionEstimate, a: Acct): Promise<PolicyCheck> {
    const head = { accountId: a.id, label: a.label, kind: a.kind, mode: a.mode, network: a.network };
    const skip = (reason: string): PolicyCheck => ({ ...head, accepted: null, code: null, reason, source: 'not_checked' });
    if (a.error) return skip(a.error);
    const body = orderBodyFor(e);
    if (!body) return skip(e.order ? 'no order of this account\'s kind can be formed from this estimate' : 'the order could not be sized on this instrument');
    try {
      const r = a.kind === 'paper' ? await this.paper.preview(a.id, { ...body, triggerPrice: null, tif: body.type === 'market' ? 'ioc' : 'gtc' })
        : await this.live!.preview(a.id, { ...body, triggerPrice: null, tif: body.type === 'market' ? 'ioc' : 'gtc' });
      return r.risk.ok ? { ...head, accepted: true, code: null, reason: null, source: 'risk_engine' } : { ...head, accepted: false, code: r.risk.code, reason: r.risk.reason, source: 'risk_engine' };
    } catch (err) {
      // the service refused before its risk engine ran (read-only account, mainnet off, venue unreadable): that refusal is the answer
      if (err instanceof UserError) return { ...head, accepted: false, code: err.code, reason: err.message.slice(0, 240), source: 'risk_engine' };
      throw err;
    }
  }

  async route(input: unknown): Promise<RouteAnswer> {
    const raw = z.record(z.string(), z.unknown()).parse(input ?? {}), { accountIds: ids, ...rest } = raw;
    const intent = OrderIntentSchema.parse(rest), accountIds = [...new Set(AccountIds.parse(ids))];
    const want = intent.base.toUpperCase(), errors: { venue: VenueId; message: string }[] = [];
    const accounts = await this.accounts(accountIds);
    // the ETH price that converts chain costs comes from the same snapshot as everything else
    const eth = await this.ethPrice();
    const chain = await this.chain.read(eth);
    const snaps: VenueSnapshot[] = [];
    await Promise.all(this.registry.list().map(async (v) => {
      try {
        const insts = (await this.data.instruments(v.id)).value.filter((i) => i.base.toUpperCase() === want).slice(0, MAX_INSTRUMENTS_PER_VENUE);
        const acct = accounts.find((a) => a.venue === v.id);
        for (const s of await Promise.all(insts.map((i) => this.snapshot(v, i, chain, acct)))) snaps.push(s);
      } catch (e) { errors.push({ venue: v.id, message: msg(e) }); }
    }));
    if (snaps.length === 0 && errors.length > 0) throw new UserError('venue_unavailable', errors[0]!.message, 503);
    const order = this.registry.list().map((v) => v.id);
    snaps.sort((a, b) => order.indexOf(a.venue) - order.indexOf(b.venue) || a.instrument.id.localeCompare(b.instrument.id));
    const r = routeOrder(intent, snaps, { now: this.data.now() });
    const candidates = await Promise.all(r.candidates.map(async (e): Promise<RoutedCandidate> => {
      const blockers = e.eligibility.reasons.filter((x) => x.kind === 'blocker').map((x) => x.code);
      const mine = accounts.filter((a) => a.venue === e.venue);
      return { ...e, risk: {
        venue: { accepted: blockers.length === 0, codes: blockers, note: blockers.length === 0 ? `within the limits ${ROUTER_FACTS[e.venue].name} publishes for this instrument (lot, minimum, leverage, liquidity) as far as the snapshot shows` : 'refused by the venue\'s own limits or by the data' },
        accounts: await Promise.all(mine.map((a) => this.policy(e, a))),
      } };
    }));
    const warnings = [...r.warnings];
    if (errors.length) warnings.push(`Not read: ${errors.map((e) => e.venue).join(', ')}. The comparison is missing those venues.`);
    for (const a of accounts) if (!r.candidates.some((e) => e.venue === a.venue)) warnings.push(`« ${a.label} » is on ${a.venue}, which lists no ${want} perpetual: its policy was not asked.`);
    return { ...r, candidates, warnings, errors, chain };
  }

  private async ethPrice(): Promise<{ value: DecStr; source: string } | null> {
    for (const [venue, id, source] of [['hyperliquid', 'hyperliquid:ETH', 'Hyperliquid ETH mark price'], ['gmx', 'gmx:ETH/USD [WETH-USDC]', 'GMX oracle mid of ETH/USD']] as const) {
      if (!this.registry.has(venue)) continue;
      try { const t = (await this.data.tickers(venue)).value.find((x) => x.instrument === id); if (t) return { value: t.mark, source }; } catch { /* next */ }
    }
    return null;
  }
}
