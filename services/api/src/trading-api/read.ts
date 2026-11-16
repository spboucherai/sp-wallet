// Read side of the trading API: every answer comes from the services the web app itself uses — the derivatives data
// service and venue registry, the spot market-data engine, the signer status and chain adapters, the paper / live / GMX
// account services and the wallet's tables. Nothing is invented: a source that cannot be read is named in `errors`, and a
// call whose every source fails answers 503. Paper and live rows always carry `mode`; no figure adds the two.
//
// A key's restrictions (venues, instruments, networks) apply here too: list answers are filtered, a direct request for a
// restricted object answers 403 `restricted`.
import { formatUnits, getNetwork, NETWORKS, type NetworkDef } from '@spw/core';
import { D, type DecStr, type Instrument, type Position } from '@spw/derivatives';
import { capabilities } from '../capabilities.ts';
import { adapterFor } from '../chains/index.ts';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { DATA_BOUNDS, venueFailure, type CandleInterval } from '../derivatives/data.ts';
import type { Derivatives } from '../derivatives/index.ts';
import type { LiveService } from '../derivatives/exec.ts';
import type { GmxService } from '../derivatives/gmx-exec.ts';
import { positionOf } from '../private-markets/routes.ts';
import { privateMarketsFor } from '../private-markets/service.ts';
import { getSeries } from '../market/series.ts';
import { listQuality } from '../market/store.ts';
import { INTERVAL_MS, expectedLastTs, isInterval, isSymbol, type Interval } from '../market/types.ts';
import { addressFor, signer } from '../signer-client.ts';
import { view as proposalView, type ProposalRow } from '../transfers.ts';
import { hubFor } from '../markets-hub/index.ts';
import { toCompareQuery, type CompareQueryInput } from '../markets-hub/schema.ts';
import { createListing, SPOT, type Access, type MarketRow, type PartialError } from '../markets-hub/listing.ts';
import type { Principal } from './principal.ts';

export interface ReadDeps {
  derivatives: () => Derivatives; live: () => LiveService;
  /** GMX positions are read from the chain through the GMX service */
  gmx: () => Pick<GmxService, 'status'>;
  prices: () => Promise<Record<string, { usd: number }> | null>;
  /** the spot/perp strategy libraries (they start laboratory processes: injectable) */
  library?: () => Promise<{ kind: 'spot' | 'perp'; path: string; sha256: string; meta: unknown }[]>;
  now?: () => number;
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// ---------------------------------------------------------------------------------------------------------------- restrictions
const lists = (p: Principal) => (p.kind === 'api_key' ? p.restrictions : null);
export const venueAllowed = (p: Principal, venue: string): boolean => { const r = lists(p); return !r || r.venues.length === 0 || r.venues.includes(venue); };
export const instrumentAllowed = (p: Principal, id: string | null): boolean => { const r = lists(p); return !r || r.instruments.length === 0 || (id !== null && r.instruments.includes(id)); };
export const networkAllowed = (p: Principal, network: string): boolean => { const r = lists(p); return !r || r.networks.length === 0 || r.networks.includes(network); };
const marketAllowed = (p: Principal, venue: string, id: string | null): boolean => venueAllowed(p, venue) && instrumentAllowed(p, id);
const restricted = (what: string): UserError => new UserError('restricted', `this key is not allowed on ${what}`, 403);

export class AmbiguousSymbol extends UserError {
  constructor(readonly symbol: string, readonly candidates: string[]) { super('ambiguous_symbol', `'${symbol}' exists on several venues: name one of the candidates as venue:symbol`, 409); }
}

export function createReads(deps: ReadDeps) {
  // one clock: the derivatives data service's (ages of venue rows are measured against the clock that stamped them)
  const now = deps.now ?? ((): number => deps.derivatives().data.now());
  const NETS = Object.values(NETWORKS) as NetworkDef[];
  const balCache = new Map<string, { at: number; v: Record<string, bigint> }>();

  // -------------------------------------------------------------------------------------------------------------- markets
  // the unified listing lives in markets-hub/listing.ts (one listing in the service); a key's restrictions are passed as its `Access`
  const listing = createListing({ derivatives: deps.derivatives, now });
  const { spotSymbols, spotRow } = listing;
  const accessOf = (p: Principal): Access => ({ venue: (v) => venueAllowed(p, v), instrument: (id) => instrumentAllowed(p, id), denied: restricted });
  const markets = (p: Principal, q: { venue?: string; kind?: 'perpetual' | 'spot'; q?: string; limit: number }) => listing.markets(accessOf(p), q);

  /** the venue comparator of the markets hub (one computation in the service); a key sees only the venues and instruments it is allowed on */
  async function compare(p: Principal, q: CompareQueryInput) {
    const a = await hubFor(deps.derivatives()).compare.compare(toCompareQuery(q));
    if (p.kind !== 'api_key') return a;
    const rows = a.rows.filter((r) => marketAllowed(p, r.venue, r.instrument)), seen = new Set(rows.map((r) => r.instrument));
    if (rows.length === 0) throw restricted(`the venues listing ${a.underlying}`);
    return { ...a, rows, discrepancies: a.discrepancies.filter((x) => seen.has(x.longInstrument) && seen.has(x.shortInstrument)) };
  }

  type Resolved = { venue: typeof SPOT; id: string; symbol: string } | { venue: string; id: string; inst: Instrument };
  /** `venue:symbol`, or a bare symbol when exactly one market answers to it (409 with the candidates otherwise) */
  async function resolve(p: Principal, raw: string): Promise<Resolved> {
    const d = deps.derivatives(), k = raw.indexOf(':');
    const check = <T extends Resolved>(r: T): T => { if (!marketAllowed(p, r.venue, r.id)) throw restricted(`market ${r.id}`); return r; };
    if (k > 0) {
      const venue = raw.slice(0, k), symbol = raw.slice(k + 1);
      if (venue === SPOT) {
        if (!isSymbol(symbol) || !(await spotSymbols()).includes(symbol)) throw new UserError('unknown_market', `no spot market data for '${symbol.slice(0, 20)}'`, 404);
        return check({ venue: SPOT, id: raw, symbol });
      }
      try { return check({ venue, id: raw, inst: await d.data.instrument(raw) }); } catch (e) { throw venueFailure(e); }
    }
    const want = raw.toUpperCase(), cands: Resolved[] = [], errors: string[] = [];
    await Promise.all(d.registry.list().map(async (v) => {
      try { for (const i of (await d.data.instruments(v.id)).value) if (i.symbol.toUpperCase() === want || i.base.toUpperCase() === want) cands.push({ venue: v.id, id: i.id, inst: i }); }
      catch (e) { errors.push(`${v.id}: ${msg(e)}`); }
    }));
    if (isSymbol(want) && (await spotSymbols().catch(() => [] as string[])).includes(want)) cands.push({ venue: SPOT, id: `${SPOT}:${want}`, symbol: want });
    const allowed = cands.filter((c) => marketAllowed(p, c.venue, c.id));
    if (allowed.length === 1) return allowed[0]!;
    if (allowed.length > 1) throw new AmbiguousSymbol(raw.slice(0, 40), allowed.map((c) => c.id).sort());
    if (cands.length > 0) throw restricted(`market ${raw.slice(0, 40)}`);
    // a venue that could not be read may be the one that lists it: say so instead of "unknown"
    if (errors.length) throw new UserError('venue_unavailable', `'${raw.slice(0, 40)}' was not found on the venues that answered; unread: ${errors.join('; ').slice(0, 200)}`, 503);
    throw new UserError('unknown_market', `unknown market '${raw.slice(0, 40)}'`, 404);
  }

  async function market(p: Principal, raw: string) {
    const r = await resolve(p, raw);
    if (r.venue === SPOT) {
      const quality = await listQuality(), sym = (r as { symbol: string }).symbol;
      return { market: await spotRow(sym, quality), instrument: null, ticker: null, quality: Object.fromEntries(quality.filter((x) => x.symbol === sym).map((x) => [x.interval, { status: x.status, fresh: x.fresh, lastTs: x.last_ts?.getTime() ?? null, gaps: x.gaps }])), ts: now(), source: 'market-data' };
    }
    const d = deps.derivatives(), inst = (r as { inst: Instrument }).inst;
    try {
      const m = await d.data.market(inst.id);
      const row: MarketRow = { id: inst.id, venue: inst.venue, kind: 'perpetual', symbol: inst.symbol, base: inst.base, quote: inst.quote, status: inst.status, mark: m.ticker.mark, ts: m.ticker.ts, stale: now() - m.ticker.ts > DATA_BOUNDS.tickers.maxAge, source: 'venue' };
      return { market: row, instrument: m.instrument, ticker: m.ticker, quality: null, liquidity: m.liquidity, hasOrderBook: d.data.hasBook(inst), errors: m.errors, ts: m.ts, source: 'venue' };
    } catch (e) { throw venueFailure(e); }
  }

  async function orderbook(p: Principal, raw: string, depth: number) {
    const r = await resolve(p, raw);
    if (r.venue === SPOT) throw new UserError('no_orderbook', 'the spot market-data engine stores bars, not order books', 422);
    const d = deps.derivatives(), inst = (r as { inst: Instrument }).inst;
    try {
      const b = await d.data.book(inst);
      if (!b) throw new UserError('no_orderbook', `${inst.venue} has no order book (liquidity pool): see GET /markets/${inst.id}`, 422);
      return { id: inst.id, bids: b.bids.slice(0, depth), asks: b.asks.slice(0, depth), ts: b.ts, stale: now() - b.ts > DATA_BOUNDS.book.maxAge / 2, source: 'venue' };
    } catch (e) { throw venueFailure(e); }
  }

  async function candles(p: Principal, raw: string, interval: string, limit: number) {
    const r = await resolve(p, raw);
    if (r.venue === SPOT) {
      if (!isInterval(interval)) throw new UserError('unsupported_interval', `spot bars exist for ${Object.keys(INTERVAL_MS).join(', ')}`, 422);
      const s = await getSeries((r as { symbol: string }).symbol, interval as Interval, { limit }), last = s.bars.at(-1);
      return { id: r.id, interval, candles: s.bars.map((b) => ({ ts: b.ts, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: String(b.volume), source: b.source })), gaps: s.gaps,
        ts: last ? last.ts + INTERVAL_MS[interval as Interval] : null, stale: !last || last.ts < expectedLastTs(interval as Interval, now()) - INTERVAL_MS[interval as Interval], source: 'market-data' };
    }
    const d = deps.derivatives(), inst = (r as { inst: Instrument }).inst;
    try { const c = await d.data.candles(inst, interval as CandleInterval, limit); return { id: inst.id, interval, candles: c.value, ts: c.ts, stale: c.stale, source: 'venue' }; }
    catch (e) { throw venueFailure(e); }
  }

  // -------------------------------------------------------------------------------------------------------------- wallet
  const liveTokens = (n: NetworkDef) => { const off = new Set(adapterFor(n.id).disabledAssets?.() ?? []); return n.tokens.filter((t) => !off.has(t.id)); };
  async function balances(p: Principal, q: { network?: string }) {
    if (q.network !== undefined) { getNetworkOr404(q.network); if (!networkAllowed(p, q.network)) throw restricted(`network ${q.network}`); }
    const st = await signer.status(); // 503 signer_unreachable: without the signer there is no address to read
    const errors: PartialError[] = [];
    const nets = NETS.filter((n) => st.addresses[n.id] && (q.network === undefined || n.id === q.network) && networkAllowed(p, n.id));
    const rows = await Promise.all(nets.map(async (n) => {
      const assets = [n.native, ...liveTokens(n)];
      try {
        const c = balCache.get(n.id);
        const b = c && now() - c.at < 12_000 ? c.v : await adapterFor(n.id).balances(addressFor(st, n.id)).then((v) => { balCache.set(n.id, { at: now(), v }); return v; });
        return assets.map((a) => (b[a.id] === undefined
          ? { network: n.id as string, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null as string | null, display: null as string | null, error: 'unavailable' as string | null }
          : { network: n.id as string, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: b[a.id]!.toString(), display: formatUnits(b[a.id]!, a.decimals), error: null }));
      } catch (e) {
        errors.push({ source: n.id, message: msg(e) });
        return assets.map((a) => ({ network: n.id as string, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null, display: null, error: 'unavailable' }));
      }
    }));
    if (nets.length > 0 && errors.length === nets.length) throw new UserError('service_unavailable', `no network could be read: ${errors.map((e) => `${e.source}: ${e.message}`).join('; ').slice(0, 300)}`, 503);
    return { asOf: new Date(now()).toISOString(), balances: rows.flat(), errors, halted: st.halted };
  }
  function getNetworkOr404(id: string): NetworkDef { try { return getNetwork(id); } catch { throw new UserError('unknown_network', `unknown network '${id.slice(0, 24)}'`, 404); } }

  const sum = (xs: (DecStr | null)[]): DecStr | null => { const v = xs.filter((x): x is DecStr => x !== null); return v.length ? D.str(v.map((x) => D.from(x)).reduce((a, b) => D.add(a, b))) : null; };
  async function accounts(p: Principal, errors: PartialError[]) {
    const out: { mode: 'paper' | 'live'; venue: string; network: string; accountId: string; label: string; equity: DecStr | null; collateral: DecStr | null; error: string | null; source: string }[] = [];
    try { for (const a of await deps.derivatives().paper.list()) if (venueAllowed(p, a.venue)) out.push({ mode: 'paper', venue: a.venue, network: a.network, accountId: a.id, label: a.label, equity: a.state.equity, collateral: a.state.collateral, error: null, source: 'paper' }); }
    catch (e) { errors.push({ source: 'paper', message: msg(e) }); }
    try {
      const l = deps.live();
      for (const a of await l.list()) {
        if (!venueAllowed(p, a.venue)) continue;
        const c = await l.collateral(a.id).catch((e: unknown) => ({ equity: null, collateral: null, error: msg(e) }));
        out.push({ mode: 'live', venue: a.venue, network: a.network, accountId: a.id, label: a.label, equity: c.equity, collateral: c.collateral, error: c.error, source: 'venue' });
      }
    } catch (e) { errors.push({ source: 'live', message: msg(e) }); }
    return out;
  }
  async function portfolio(p: Principal) {
    const b = await balances(p, {}), px = await deps.prices().catch(() => null), errors: PartialError[] = [...b.errors];
    if (!px) errors.push({ source: 'prices', message: 'the price feed is off or unavailable: the wallet is listed without a value' });
    const rows = b.balances.map((r) => { const usd = px?.[r.symbol]?.usd; return { ...r, valueUsd: r.display !== null && usd !== undefined ? Number(r.display) * usd : null }; });
    const priced = rows.filter((r) => r.valueUsd !== null), held = rows.filter((r) => r.amount !== null && r.amount !== '0');
    const accts = await accounts(p, errors);
    const walletUsd = px ? priced.reduce((s, r) => s + r.valueUsd!, 0) : null;
    return {
      asOf: b.asOf,
      wallet: { valueUsd: walletUsd, priced: held.filter((r) => r.valueUsd !== null).length, unpriced: held.filter((r) => r.valueUsd === null).length,
        /** the price feed is cached for a few minutes: this is the time of this answer, not of the quotes */ pricesAsOf: px ? b.asOf : null, balances: rows },
      accounts: accts,
      totals: { walletUsd, liveVenueEquity: sum(accts.filter((a) => a.mode === 'live' && a.network === 'mainnet').map((a) => a.equity)), paperEquity: sum(accts.filter((a) => a.mode === 'paper').map((a) => a.equity)),
        note: 'three separate figures: the wallet (on-chain, USD), venue accounts on mainnet (live), paper accounts (simulated). They are never added together; testnet accounts are listed but not summed.' },
      halted: b.halted, errors,
    };
  }

  // -------------------------------------------------------------------------------------------------------------- positions
  const posRow = (mode: 'paper' | 'live', venue: string, network: string, accountId: string, x: Position) => ({ id: `${mode}:${venue}:${accountId}:${x.instrument}`, mode, venue, network, accountId, instrument: x.instrument as string | null, side: x.side, size: x.size, entryPrice: x.entryPrice,
    markPrice: x.markPrice as string | null, liquidationPrice: x.liquidationPrice, leverage: x.leverage as string | null, margin: x.margin as string | null, unrealizedPnl: x.unrealizedPnl as string | null, source: x.source as string });
  async function positions(p: Principal, q: { mode?: 'paper' | 'live'; venue?: string }) {
    if (q.venue !== undefined && !venueAllowed(p, q.venue)) throw restricted(`venue ${q.venue}`);
    const errors: PartialError[] = [], rows: ReturnType<typeof posRow>[] = [];
    const want = (mode: 'paper' | 'live', venue: string): boolean => (q.mode === undefined || q.mode === mode) && (q.venue === undefined || q.venue === venue) && venueAllowed(p, venue);
    let asked = 0;
    if (q.mode !== 'live') {
      asked += 1;
      try { for (const a of await deps.derivatives().paper.list()) if (want('paper', a.venue)) rows.push(...a.positions.map((x) => posRow('paper', a.venue, a.network, a.id, x))); }
      catch (e) { errors.push({ source: 'paper', message: msg(e) }); }
    }
    if (want('live', 'hyperliquid')) {
      asked += 1;
      try {
        const l = deps.live();
        for (const a of await l.list()) {
          const g = await l.get(a.id);
          if (g.venueState.error) errors.push({ source: `hyperliquid:${a.id}`, message: g.venueState.error });
          rows.push(...g.venueState.positions.map((x) => posRow('live', a.venue, a.network, a.id, x)));
        }
      } catch (e) { errors.push({ source: 'hyperliquid', message: msg(venueFailure(e)) }); }
    }
    if (want('live', 'gmx')) {
      asked += 1;
      try {
        const s = await deps.gmx().status();
        if (s.positionsError) errors.push({ source: 'gmx', message: s.positionsError });
        for (const x of s.positions) rows.push({ id: `live:gmx:${s.account?.address ?? 'wallet'}:${x.key}`, mode: 'live', venue: 'gmx', network: s.network, accountId: s.account?.address ?? 'wallet', instrument: x.instrument, side: x.side, size: x.sizeTokens, entryPrice: x.entryPrice,
          markPrice: x.markPrice, liquidationPrice: x.liquidationPrice, leverage: x.leverage, margin: x.collateral, unrealizedPnl: x.pnlUsd, source: x.source });
      } catch (e) { errors.push({ source: 'gmx', message: msg(e) }); }
    }
    if (asked > 0 && errors.length >= asked && rows.length === 0) throw new UserError('service_unavailable', `no position source could be read: ${errors.map((e) => `${e.source}: ${e.message}`).join('; ').slice(0, 300)}`, 503);
    return { positions: rows.filter((r) => instrumentAllowed(p, r.instrument)), errors, ts: now() };
  }

  // -------------------------------------------------------------------------------------------------------------- orders
  type Row = Record<string, any>;
  const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
  const PAPER_OPEN = new Set(['pending', 'open', 'partially_filled', 'triggered']);
  const derivOrder = (r: Row, mode: 'paper' | 'live') => ({
    id: `deriv:${r.account_id}:${r.client_id}`, mode, venue: r.venue as string, network: r.network as string, accountId: r.account_id as string, clientId: r.client_id as string, venueOrderId: r.venue_order_id as string | null,
    instrument: r.instrument as string | null, side: r.side as string | null, type: r.type as string, size: r.size as string | null, price: r.price as string | null, triggerPrice: r.trigger_price as string | null, reduceOnly: r.reduce_only as boolean, tif: r.tif as string,
    status: (r.state ?? r.status) as string, final: (r.state !== null && r.state !== undefined ? r.final : !PAPER_OPEN.has(r.status)) as boolean | null, filled: r.filled as string, avgFillPrice: r.avg_fill_price as string | null, reason: r.reject_reason as string | null,
    origin: r.origin as string, mandateId: (r.mandate_id ?? null) as string | null, createdAt: ms(r.created_at)!, updatedAt: ms(r.updated_at)! });
  const gmxOrder = (r: Row) => ({ id: `gmx:${r.id}`, mode: 'live' as const, venue: 'gmx', network: 'arbitrum', accountId: r.account as string | null, instrument: null as string | null, market: r.market as string | null, side: (r.is_long === null ? null : r.is_long ? 'long' : 'short') as string | null,
    type: r.kind as string, status: r.state as string, final: r.final as boolean | null, sizeUsd: r.size_usd as string | null, txid: r.txid as string | null, error: r.error as string | null, createdAt: ms(r.created_at)!, updatedAt: ms(r.updated_at)! });
  const agentOrder = (r: Row) => ({ id: `agent:${r.id}`, mode: (r.mode === 'LIVE' ? 'live' : 'paper') as 'paper' | 'live', venue: SPOT, network: r.network as string, accountId: r.agent_id as string | null, agentId: r.agent_id as string, instrument: `${r.from_symbol}>${r.to_symbol}` as string | null,
    side: null as string | null, type: 'swap', status: r.state as string, final: null as boolean | null, amountIn: r.amount_in as string, expectedOut: r.expected_out as string | null, received: r.received as string | null, txid: r.txid as string | null, reason: r.reason as string | null,
    createdAt: ms(r.ts)!, updatedAt: ms(r.updated_at)! });
  const orderVisible = (p: Principal, o: { venue: string; instrument: string | null; network: string }): boolean => venueAllowed(p, o.venue) && (o.venue === SPOT ? networkAllowed(p, o.network) : instrumentAllowed(p, o.instrument));

  async function orders(p: Principal, q: { mode?: 'paper' | 'live'; venue?: string; open?: 'true' | 'false'; limit: number }) {
    if (q.venue !== undefined && !venueAllowed(p, q.venue)) throw restricted(`venue ${q.venue}`);
    const n = q.limit, all: (ReturnType<typeof derivOrder> | ReturnType<typeof gmxOrder> | ReturnType<typeof agentOrder>)[] = [];
    if (q.mode !== 'live') all.push(...(await sql`select o.*, a.venue, a.network from deriv_orders o join deriv_paper_accounts a on a.id = o.account_id order by o.created_at desc limit ${n}`).map((r) => derivOrder(r, 'paper')));
    if (q.mode !== 'paper') {
      all.push(...(await sql`select o.*, a.venue, a.network from deriv_orders o join deriv_accounts a on a.id = o.account_id order by o.created_at desc limit ${n}`).map((r) => derivOrder(r, 'live')));
      all.push(...(await sql`select * from deriv_gmx_ops order by created_at desc limit ${n}`).map(gmxOrder));
    }
    all.push(...(await sql`select o.*, a.network from agent_orders o join agents a on a.id = o.agent_id ${q.mode === 'paper' ? sql`where o.mode <> 'LIVE'` : q.mode === 'live' ? sql`where o.mode = 'LIVE'` : sql``} order by o.ts desc limit ${n}`).map(agentOrder));
    const out = all.filter((o) => (q.venue === undefined || o.venue === q.venue) && (q.open !== 'true' || o.final === false) && (q.open !== 'false' || o.final !== false) && orderVisible(p, o))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
    return { orders: out, ts: now() };
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const unknownOrder = (): UserError => new UserError('unknown_order', 'unknown order', 404);
  async function order(p: Principal, id: string) {
    const [kind, a, ...rest] = id.split(':'), b = rest.join(':');
    let o: ReturnType<typeof derivOrder> | ReturnType<typeof gmxOrder> | ReturnType<typeof agentOrder> | null = null, fills: unknown[] = [];
    if (kind === 'deriv' && a && UUID.test(a) && b) {
      const [paper] = await sql`select o.*, a.venue, a.network from deriv_orders o join deriv_paper_accounts a on a.id = o.account_id where o.account_id = ${a} and o.client_id = ${b}`;
      const [live] = paper ? [] : await sql`select o.*, a.venue, a.network from deriv_orders o join deriv_accounts a on a.id = o.account_id where o.account_id = ${a} and o.client_id = ${b}`;
      if (paper || live) {
        o = derivOrder((paper ?? live)!, paper ? 'paper' : 'live');
        fills = (await sql`select * from deriv_fills where account_id = ${a} and client_id = ${b} order by ts`).map((f) => ({ id: f.fill_id, instrument: f.instrument, side: f.side, price: f.price, size: f.size, fee: f.fee, feeAsset: f.fee_asset, closedPnl: f.closed_pnl, liquidation: f.liquidation, ts: ms(f.ts) }));
      }
    } else if (kind === 'gmx' && a && UUID.test(a) && !b) { const [r] = await sql`select * from deriv_gmx_ops where id = ${a}`; if (r) o = gmxOrder(r); }
    else if (kind === 'agent' && a && UUID.test(a) && !b) { const [r] = await sql`select o.*, a.network from agent_orders o join agents a on a.id = o.agent_id where o.id = ${a}`; if (r) o = agentOrder(r); }
    if (!o) throw unknownOrder();
    if (!orderVisible(p, o)) throw restricted('this order');
    return { order: o, fills };
  }

  // -------------------------------------------------------------------------------------------------------------- strategies, agents
  async function defaultLibrary() {
    const [spot, perp] = await Promise.all([import('../agents/strategies.ts').then((m) => m.library()), import('../agents/perp-strategies.ts').then((m) => m.perpLibrary())]);
    return [...spot.map((s) => ({ kind: 'spot' as const, path: s.path, sha256: s.sha256, meta: s.meta as unknown })), ...perp.map((s) => ({ kind: 'perp' as const, path: s.path, sha256: s.sha256, meta: s.meta as unknown }))];
  }
  async function strategies(_p: Principal, q: { kind?: 'spot' | 'perp' }) {
    const errors: PartialError[] = [];
    const library = await (deps.library ?? defaultLibrary)().catch((e: unknown) => { errors.push({ source: 'library', message: msg(e) }); return []; });
    const versions = await sql`select v.id, v.agent_id, v.name, v.version, v.code_sha256, v.status, v.meta, v.created_at, v.approved_at, (v.report is not null) as has_report, a.kind from strategy_versions v join agents a on a.id = v.agent_id order by v.created_at desc limit 500`;
    return {
      library: library.filter((s) => !q.kind || s.kind === q.kind),
      versions: versions.filter((v) => !q.kind || (v.kind ?? 'spot') === q.kind).map((v) => ({ id: v.id as string, agentId: v.agent_id as string, kind: (v.kind ?? 'spot') as string, name: v.name as string, version: v.version as string, sha256: v.code_sha256 as string, status: v.status as string,
        hasReport: v.has_report as boolean, createdAt: ms(v.created_at), approvedAt: ms(v.approved_at) })),
      errors,
    };
  }
  async function agents(p: Principal) {
    const rows = await sql`select * from agents order by created_at desc`;
    return { agents: rows.map((a) => {
      const perp = a.kind === 'perp', live = a.mode === 'LIVE';
      return { id: a.id as string, kind: (perp ? 'perp' : 'spot') as 'spot' | 'perp', name: a.name as string, mission: a.mission as string, state: a.state as string, mode: a.mode as string,
        /** research = no order of any kind; paper = simulated orders; live = orders under a signer-enforced mandate */
        tradingMode: (live ? 'live' : a.state === 'PAPER_TRADING' || (perp && a.mode !== 'LIVE' && a.state !== 'CREATED') ? 'paper' : a.mode === 'RESEARCH' ? 'research' : null) as 'research' | 'paper' | 'live' | null,
        venue: perp ? 'hyperliquid' : SPOT, network: a.network as string, universe: a.universe as string[], interval: a.interval as string, strategyVersionId: a.strategy_version_id as string | null,
        mandateId: a.mandate_id as string | null, accountId: (a.live_account_id ?? a.deriv_account_id ?? null) as string | null, lastBar: ms(a.last_bar), stopReason: a.stop_reason as string | null, createdAt: ms(a.created_at)!, updatedAt: ms(a.updated_at)! };
    }).filter((a) => venueAllowed(p, a.venue) && (a.venue !== SPOT || networkAllowed(p, a.network))) };
  }

  // -------------------------------------------------------------------------------------------------------------- risk
  async function risk(p: Principal) {
    const errors: PartialError[] = [];
    const st = await signer.status().catch((e: unknown) => { errors.push({ source: 'signer', message: msg(e) }); return null; });
    const accts: { mode: 'paper' | 'live'; venue: string; network: string; accountId: string; policy: Record<string, unknown> | null; halted: boolean | null; halt: string | null; divergence?: string | null; tradable?: boolean }[] = [];
    try { for (const a of await deps.derivatives().paper.list()) if (venueAllowed(p, a.venue)) accts.push({ mode: 'paper', venue: a.venue, network: a.network, accountId: a.id, policy: a.policy as Record<string, unknown>, halted: (a.policy as { halted?: boolean }).halted ?? null, halt: null }); }
    catch (e) { errors.push({ source: 'paper', message: msg(e) }); }
    try { for (const a of await deps.live().list()) if (venueAllowed(p, a.venue)) accts.push({ mode: 'live', venue: a.venue, network: a.network, accountId: a.id, policy: a.policy as Record<string, unknown>, halted: a.halted !== null, halt: a.halted, divergence: a.divergence, tradable: a.tradable }); }
    catch (e) { errors.push({ source: 'live', message: msg(e) }); }
    return {
      killSwitch: { signerReachable: st !== null, signerHalted: st?.halted ?? null,
        note: 'the signer halt stops signing (reduce-only exits and cancels are still signed since V11) and is lifted on the signer machine only. The global kill switch of the risk engine (`engine.killSwitch`) blocks new risk for every principal and is released with the owner\'s passkey.' },
      signerPolicy: st ? { perTx: st.policy.perTx, daily: st.policy.daily, maxFee: st.policy.maxFee, spentToday: st.spentToday } : null,
      capabilityLocks: capabilities().filter((c) => ['deriv_live_mainnet', 'deriv_mandate_mainnet', 'deriv_gmx_live', 'broadcast', 'workers'].includes(c.id)).map((c) => ({ id: c.id, on: c.on, why: c.why })),
      accounts: accts,
      key: p.kind === 'api_key' ? { limits: p.limits, mandateId: p.mandateId, limitsEnforced: true, note: 'the key\'s notional limits and its venue / instrument / network restrictions are applied to every order it places, before the mandate and the risk engine' } : null,
      errors, ts: now(),
    };
  }

  // -------------------------------------------------------------------------------------------------------------- activity
  async function activity(p: Principal, q: { limit: number }) {
    const out = await sql<ProposalRow[]>`select * from proposals where state <> 'draft' order by created_at desc limit ${q.limit}`;
    const dep = await sql`select d.*, c.finalized from deposits d left join scan_cursor c on c.network = d.network order by coalesce(d.block_time, d.seen_at) desc limit ${q.limit}`;
    const fills = await sql`select f.*, coalesce(pa.venue, la.venue) as venue, (pa.id is not null) as is_paper from deriv_fills f left join deriv_paper_accounts pa on pa.id = f.account_id left join deriv_accounts la on la.id = f.account_id
      where pa.id is not null or la.id is not null order by f.ts desc limit ${q.limit}`;
    const items = [
      ...out.filter((x) => networkAllowed(p, x.network)).map((x) => ({ ...proposalView(x), kind: x.kind === 'swap' || x.kind === 'xswap' ? 'swap' : x.kind === 'bridge' ? 'bridge' : x.kind === 'gmx' ? 'gmx' : 'send', mode: 'live' as const, at: x.created_at.toISOString() })),
      ...dep.filter((d) => networkAllowed(p, d.network)).map((d) => {
        const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset);
        return { kind: 'receive', mode: 'live' as const, at: ((d.block_time ?? d.seen_at) as Date).toISOString(), id: `${d.network}:${d.txid}:${d.idx}`, network: d.network as string, asset: d.asset as string, symbol: a?.symbol ?? '?', amount: d.amount as string,
          amountDisplay: a ? formatUnits(BigInt(d.amount), a.decimals) : null, from: d.from_addr as string, txid: d.txid as string, state: Number(d.block) <= Number(d.finalized ?? 0) ? 'finalized' : 'confirming' };
      }),
      ...fills.filter((f) => marketAllowed(p, f.venue, f.instrument)).map((f) => ({ kind: 'fill', mode: (f.is_paper ? 'paper' : 'live') as 'paper' | 'live', at: (f.ts as Date).toISOString(), id: `${f.account_id}:${f.fill_id}`, venue: f.venue as string, accountId: f.account_id as string,
        instrument: f.instrument as string, side: f.side as string, price: f.price as string, size: f.size as string, fee: f.fee as string, closedPnl: f.closed_pnl as string | null })),
    ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, q.limit);
    return { items };
  }

  // -------------------------------------------------------------------------------------------------------------- private markets (v11)
  // the answers of services/api/src/private-markets, narrowed to what the key may see (venues and instruments)
  type PmQuery = { delisted?: 'true' | 'false'; size?: string; side?: 'long' | 'short'; interval?: '1h' | '1d'; limit?: number };
  const pm = () => privateMarketsFor(deps.derivatives());
  const pmPos = (q: PmQuery) => { const position = positionOf(q); return position ? { position } : {}; };
  async function privateMarkets(p: Principal, q: PmQuery) {
    const a = await pm().list({ delisted: q.delisted === 'true', ...pmPos(q) });
    const keep = new Set(a.markets.filter((m) => marketAllowed(p, m.venue, m.id)).map((m) => m.id));
    return { ...a, markets: a.markets.filter((m) => keep.has(m.id)), venues: a.venues.filter((v) => venueAllowed(p, v.venue)), excluded: a.excluded.filter((e) => marketAllowed(p, e.id.split(':')[0]!, e.id)),
      companies: a.companies.map((c) => ({ ...c, contracts: c.contracts.filter((id) => keep.has(id)), divergence: c.divergence.filter((d) => d.contracts.every((k) => keep.has(k.id))) })).filter((c) => c.contracts.length > 0) };
  }
  async function privateMarket(p: Principal, id: string, q: PmQuery) {
    if (!marketAllowed(p, id.split(':')[0]!, id)) throw restricted(`market ${id.slice(0, 80)}`);
    const a = await pm().detail(id, { ...pmPos(q), ...(q.interval ? { interval: q.interval } : {}), ...(q.limit ? { limit: q.limit } : {}) });
    return { ...a, sameCompany: a.sameCompany.filter((m) => marketAllowed(p, m.id.split(':')[0]!, m.id)) };
  }
  async function privateMarketCompany(p: Principal, slug: string, q: PmQuery) {
    const a = await pm().company(slug, pmPos(q)), ok = (m: { venue: string; id: string }) => marketAllowed(p, m.venue, m.id);
    const contracts = a.contracts.filter(ok), keep = new Set(contracts.map((m) => m.id));
    return { ...a, contracts, delisted: a.delisted.filter(ok), venues: a.venues.filter((v) => venueAllowed(p, v.venue)), divergence: a.divergence.filter((d) => d.contracts.every((k) => keep.has(k.id))) };
  }

  return { markets, compare, market, orderbook, candles, balances, portfolio, positions, orders, order, strategies, agents, risk, activity, resolve, privateMarkets, privateMarket, privateMarketCompany, now };
}
export type Reads = ReturnType<typeof createReads>;
