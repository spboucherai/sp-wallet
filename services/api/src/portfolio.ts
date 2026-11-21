/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/portfolio.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT B2 / B3 — balances with provenance, the server-side summary of the wallet, its value over time, and what entered and
// left it. Nothing here signs or sends; every figure says where it comes from and whether it is whole.
//
//   rows      one per (network, asset): the amount as the chain adapters read it, with the height of the read, how many sources
//             gave that amount, and `agreed` / `stale`. An amount that could not be established is null (`error`), never 0.
//   summary   computed once, on the server, with integer arithmetic on base units (18 decimals of working precision; a price
//             is a decimal number taken digit for digit from the source, never multiplied as a float).
//             `complete` is false as soon as one network or asset is missing, one row is not agreed or is stale, or one held
//             asset has no price: a partial total says so.
//   snapshots written every 10 minutes for USD and CAD. A pass that is not complete (or whose prices are stale) IS recorded,
//             flagged, and is NEVER charted: recording it keeps the evidence of the outage (the history route reports how
//             many passes were left out) without ever drawing a falsely low point. Retention: every point for 7 days,
//             one per hour for 90 days, one per day after that (the kept point of a bucket is its first complete one).
//   flows     deposits and finalized plain transfers. A flow is valued with the price the API had when it SAW the event, and
//             only when that was within FLOW_PRICE_WINDOW_MS of the event; otherwise it is listed as not valued. The history
//             route gives the change of value AND the net flows, so that a deposit is never shown as performance; the
//             difference is called an ESTIMATE (`estimatedMarketChange`), not a return.
import { formatUnits, NETWORKS, type AssetDef, type NetworkDef } from '@spw/core';
import { adapterFor } from './chains/index.ts';
import { sql } from './db.ts';

const NETS = Object.values(NETWORKS) as NetworkDef[];
export type Currency = 'USD' | 'CAD';
export interface PriceLike { usd: number; cad: number; change24h?: number | null; stale?: boolean }
export type Prices = Record<string, PriceLike>;

export interface PortfolioRow {
  network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number;
  amount: string | null; display: string | null; error: string | null;
  // NEXT (additive) — provenance of the read
  /** block / slot / tip height of the read; null when the chain adapter gives none or the read failed */ height: number | null;
  /** sources that gave `amount` (0 when unavailable) */ sources: number;
  /** sources asked; null on families read through one path only (no comparison is made there) */ sourcesAsked: number | null;
  /** false: the sources did not give the same amount (the amount shown is the higher block's and is not a fact), or nothing was read */ agreed: boolean;
  /** the state read is older than the freshness window */ stale: boolean;
  /** when the API read it */ readAt: string | null;
  /** why `amount` is null (network_unavailable, no_source_answered, zero_not_confirmed, sources_disagree_on_existence, inconsistent_source, not_read) */ reason: string | null;
  /** Bitcoin-style networks: confirmed coins, what the mempool is spending (net of unconfirmed change), unconfirmed receipts — base units */
  confirmed?: string; pendingOut?: string; pendingIn?: string;
}

// ------------------------------------------------------------------------------------------------------------------ reading
const balCache = new Map<string, { at: number; address: string; rows: PortfolioRow[] }>();
let epoch = 0; // a read started before a reset never writes after it
export const resetBalanceCache = (): void => { epoch += 1; balCache.clear(); inflight.clear(); lastMemo.clear(); };

async function readNetwork(n: NetworkDef, address: string, assets: AssetDef[]): Promise<PortfolioRow[]> {
  const base = (a: AssetDef) => ({ network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals });
  const none = (a: AssetDef, reason: string): PortfolioRow => ({ ...base(a), amount: null, display: null, error: 'unavailable', height: null, sources: 0, sourcesAsked: null, agreed: false, stale: false, readAt: null, reason });
  const ad = adapterFor(n.id);
  try {
    const readAt = new Date().toISOString();
    if (ad.balancesDetailed) {
      const d = await ad.balancesDetailed(address);
      return assets.map((a) => { const r = d.assets[a.id];
        if (!r) return { ...none(a, d.unavailable[a.id] ?? 'not_read'), sourcesAsked: Object.values(d.assets)[0]?.asked ?? null };
        return { ...base(a), amount: r.amount.toString(), display: formatUnits(r.amount, a.decimals), error: null, height: r.height, sources: r.sources, sourcesAsked: r.asked, agreed: r.agreed, stale: r.stale, readAt, reason: null,
          ...(r.confirmed !== undefined ? { confirmed: r.confirmed.toString(), pendingOut: (r.pendingOut ?? 0n).toString(), pendingIn: (r.pendingIn ?? 0n).toString() } : {}) }; });
    }
    const b = await ad.balances(address);
    return assets.map((a) => (b[a.id] === undefined ? none(a, 'not_read')
      : { ...base(a), amount: b[a.id]!.toString(), display: formatUnits(b[a.id]!, a.decimals), error: null, height: null, sources: 1, sourcesAsked: null, agreed: true, stale: false, readAt, reason: null }));
  } catch { return assets.map((a) => none(a, 'network_unavailable')); }
}
// Serving rule (pre-production rehearsal, 2026-11-19: a cold read of the 23 networks took 19 s — one slow source held everybody):
//   - a read younger than `ttlMs` is served as it is;
//   - otherwise the network is read again, ONCE whoever asks (`inflight`), and the caller waits at most `waitMs` for it:
//     past that, the previous read (up to `serveMs` old) is served, each row marked `stale` with its own `readAt` — an
//     old figure that says it is old, instead of a screen that waits; the fresh read lands in the cache for the next call;
//   - with no previous read, the caller waits `firstWaitMs`, then the rows are `unavailable` (`slow_source`), never 0.
// The worker keeps the cache warm (worker.ts `balances`), so a client normally never waits at all.
/** the delays of the serving rule (an object so that tests can shorten them) */
export const balTiming = { ttlMs: 12_000, serveMs: 10 * 60_000, waitMs: 4_000, firstWaitMs: 15_000 };
const inflight = new Map<string, Promise<PortfolioRow[]>>();
const pause = (ms: number) => new Promise<null>((r) => { setTimeout(() => r(null), ms).unref(); });
function refresh(n: NetworkDef, address: string, assets: AssetDef[]): Promise<PortfolioRow[]> {
  const key = `${n.id}:${address}`, running = inflight.get(key);
  if (running) return running;
  const started = epoch;
  const p: Promise<PortfolioRow[]> = readNetwork(n, address, assets).then((rows) => {
    if (started !== epoch) return rows;
    // a read that failed entirely does not replace a recent good one (the good one keeps being served as stale)
    const prev = balCache.get(n.id), failed = rows.every((r) => r.amount === null);
    if (!failed || !prev || prev.address !== address || Date.now() - prev.at > balTiming.serveMs) balCache.set(n.id, { at: Date.now(), address, rows });
    void rememberLast(rows);
    return rows;
  }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
/** Every (network, asset) of the wallet — see the serving rule above. */
export async function readRows(addresses: Record<string, string>, assetsOf: (n: NetworkDef) => AssetDef[]): Promise<PortfolioRow[]> {
  const out = await Promise.all(NETS.filter((n) => addresses[n.id]).map(async (n) => {
    const address = addresses[n.id]!, assets = assetsOf(n), c = balCache.get(n.id), mine = c && c.address === address ? c : null;
    if (mine && Date.now() - mine.at < balTiming.ttlMs) return mine.rows;
    const fresh = refresh(n, address, assets);
    const usable = mine && Date.now() - mine.at < balTiming.serveMs ? mine : null;
    const got = await Promise.race([fresh, pause(usable ? balTiming.waitMs : balTiming.firstWaitMs)]);
    if (got) return got.every((r) => r.amount === null) && usable ? usable.rows.map((r) => ({ ...r, stale: true })) : got;
    if (usable) return usable.rows.map((r) => ({ ...r, stale: true }));
    return assets.map((a): PortfolioRow => ({ network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null, display: null, error: 'unavailable',
      height: null, sources: 0, sourcesAsked: null, agreed: false, stale: false, readAt: null, reason: 'slow_source' }));
  }));
  return out.flat();
}

// the last amount READ for each (network, asset): what lets a snapshot say "that network could not be read, and it held nothing"
const lastMemo = new Map<string, { amount: string; savedAt: number }>();
async function rememberLast(rows: PortfolioRow[]): Promise<void> {
  try {
    for (const r of rows) {
      if (r.amount === null) continue;
      const k = `${r.network}:${r.asset}`, m = lastMemo.get(k);
      if (m && m.amount === r.amount && Date.now() - m.savedAt < 10 * 60_000) continue;
      lastMemo.set(k, { amount: r.amount, savedAt: Date.now() });
      await sql`insert into balance_last (network, asset, amount, read_at) values (${r.network}, ${r.asset}, ${r.amount}, now())
        on conflict (network, asset) do update set amount = excluded.amount, read_at = excluded.read_at`;
    }
  } catch { /* a missed note only makes a later snapshot stricter */ }
}
/** Every unreadable row held nothing the last time it was read, and that was at most `days` ago. */
export async function missingHeldNothing(rows: PortfolioRow[], days = 7): Promise<boolean> {
  const miss = rows.filter((r) => r.amount === null);
  if (!miss.length) return false;
  const known = await sql<{ network: string; asset: string; amount: string }[]>`select network, asset, amount::text as amount from balance_last where read_at > now() - ${days} * interval '1 day' and network in ${sql([...new Set(miss.map((r) => r.network))])}`;
  const zero = new Set(known.filter((k) => k.amount === '0').map((k) => `${k.network}:${k.asset}`));
  return miss.every((r) => zero.has(`${r.network}:${r.asset}`));
}

// ------------------------------------------------------------------------------------------------------------------ exact decimals
const S = 18, ONE = 10n ** BigInt(S);
/** a non-negative decimal (a price as the source wrote it, a numeric of the database) → integer with 18 decimals; null when it is not one */
export function toScaled(v: number | string): bigint | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) && v >= 0 ? String(v) : '') : v.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const exp = Number(m[3] ?? 0);
  if (!Number.isInteger(exp) || Math.abs(exp) > 60) return null;
  const digits = BigInt(m[1]! + (m[2] ?? '')), shift = S + exp - (m[2]?.length ?? 0);
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}
/** 18-decimal integer → a decimal string with `dp` decimals, rounded half away from zero */
export function fixed(v: bigint, dp = 2): string {
  const neg = v < 0n, a = neg ? -v : v, unit = 10n ** BigInt(S - dp), q = (a + unit / 2n) / unit, int = q / 10n ** BigInt(dp), frac = (q % 10n ** BigInt(dp)).toString().padStart(dp, '0');
  return `${neg && q !== 0n ? '-' : ''}${int}${dp ? `.${frac}` : ''}`;
}
/** num / den as a number with `dp` decimals, rounded half away from zero (den > 0) */
const ratio = (num: bigint, den: bigint, dp = 6): number => { if (den <= 0n) return 0; const neg = num < 0n, a = (neg ? -num : num) * 10n ** BigInt(dp), q = Number((a + den / 2n) / den) / 10 ** dp; return neg && q !== 0 ? -q : q; };
/** value of `amount` base units at `price` (18-decimal integer), as an 18-decimal integer; truncated below 1e-18 */
export const valueOf = (amount: bigint, decimals: number, price: bigint): bigint => (amount * price) / 10n ** BigInt(decimals);

// ------------------------------------------------------------------------------------------------------------------ summary
export interface Missing { network: string; asset?: string; reason: string }
export interface PortfolioSummary {
  currency: Currency;
  /** value of what was read AND priced, 2 decimals; null when no price list is available (prices off, or every source down) */ total: string | null;
  /** true only when `total` is the whole wallet: nothing missing, nothing uncertain, nothing unpriced */ complete: boolean;
  /** balances that could not be read: a whole network (no `asset`) or one asset */ missing: Missing[];
  /** balances that are shown but are not facts: sources_disagree, stale_state */ uncertain: { network: string; asset: string; reason: string }[];
  /** held rows that have a price */ priced: number;
  /** held rows that have none: their value is NOT in `total` */ unpriced: { network: string; asset: string; symbol: string }[];
  /** symbols held whose price is past its freshness window (their value IS in `total`) */ stalePrices: string[]; pricesStale: boolean;
  /** how much the CURRENT holdings moved in 24 h from each asset's own 24 h price change (USD change, applied to both currencies);
   *  not the change of the wallet's value: deposits and withdrawals of the day are not in it. null unless every priced holding has a change. */
  change24h: { abs: string; pct: number; basis: 'price_change_24h_of_current_holdings' } | null;
  byNetwork: { network: string; value: string; share: number }[];
  byAsset: { symbol: string; value: string; share: number }[];
}
export interface SummaryDetail { summary: PortfolioSummary; /** per symbol: total amount (decimal), value and price, for the snapshot */ breakdown: { symbol: string; amount: string; value: string; price: string }[] }

export function summarize(rows: PortfolioRow[], px: Prices | null, currency: Currency): SummaryDetail {
  const ck = currency === 'USD' ? 'usd' : 'cad';
  const missing: Missing[] = [], uncertain: PortfolioSummary['uncertain'] = [], unpriced: PortfolioSummary['unpriced'] = [], stale = new Set<string>();
  const byNet = new Map<string, PortfolioRow[]>();
  for (const r of rows) byNet.set(r.network, [...(byNet.get(r.network) ?? []), r]);
  for (const [network, rs] of byNet) {
    const gone = rs.filter((r) => r.amount === null);
    if (gone.length === rs.length && rs.length > 0) missing.push({ network, reason: gone[0]!.reason ?? 'unavailable' });
    else for (const r of gone) missing.push({ network, asset: r.asset, reason: r.reason ?? 'unavailable' });
    for (const r of rs) if (r.amount !== null) { if (!r.agreed) uncertain.push({ network, asset: r.asset, reason: 'sources_disagree' }); else if (r.stale) uncertain.push({ network, asset: r.asset, reason: 'stale_state' }); }
  }
  const netV = new Map<string, bigint>(), symV = new Map<string, bigint>(), symA = new Map<string, bigint>(), symP = new Map<string, bigint>();
  let total = 0n, prev = 0n, priced = 0, changeKnown = true;
  for (const r of rows) {
    if (r.amount === null || r.amount === '0') continue;
    const m = px && Object.hasOwn(px, r.symbol) ? px[r.symbol]! : null, p = m ? toScaled(m[ck]) : null;
    if (!m || p === null) { unpriced.push({ network: r.network, asset: r.asset, symbol: r.symbol }); continue; }
    const amount = BigInt(r.amount), v = valueOf(amount, r.decimals, p);
    priced += 1; total += v;
    if (m.stale) stale.add(r.symbol);
    netV.set(r.network, (netV.get(r.network) ?? 0n) + v); symV.set(r.symbol, (symV.get(r.symbol) ?? 0n) + v); symP.set(r.symbol, p);
    symA.set(r.symbol, (symA.get(r.symbol) ?? 0n) + amount * 10n ** BigInt(36 - r.decimals));
    // the value 24 h ago of what is held now: v / (1 + change/100), the change as an integer number of millionths
    const c = m.change24h, den = typeof c === 'number' && Number.isFinite(c) ? 1_000_000n + BigInt(Math.round(c * 10_000)) : 0n;
    if (den > 0n) prev += (v * 1_000_000n) / den; else changeKnown = false;
  }
  const have = px !== null;
  const share = (v: bigint) => ratio(v, total);
  const sorted = (m: Map<string, bigint>) => [...m].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));
  const summary: PortfolioSummary = {
    currency, total: have ? fixed(total) : null,
    complete: have && missing.length === 0 && uncertain.length === 0 && unpriced.length === 0,
    missing, uncertain, priced, unpriced, stalePrices: [...stale].sort(), pricesStale: stale.size > 0,
    change24h: have && priced > 0 && changeKnown && prev > 0n ? { abs: fixed(total - prev), pct: ratio((total - prev) * 100n, prev, 4), basis: 'price_change_24h_of_current_holdings' } : null,
    byNetwork: sorted(netV).map(([network, v]) => ({ network, value: fixed(v), share: share(v) })),
    byAsset: sorted(symV).map(([symbol, v]) => ({ symbol, value: fixed(v), share: share(v) })),
  };
  return { summary, breakdown: sorted(symV).map(([symbol, v]) => ({ symbol, amount: formatUnits(symA.get(symbol)!, 36), value: fixed(v), price: fixed(symP.get(symbol)!, 8) })) };
}

// ------------------------------------------------------------------------------------------------------------------ wiring
/** Set by the server (it owns the price sources and the wallet's addresses); the workers below do nothing until it is. */
export const portfolioDeps: { read: (() => Promise<{ rows: PortfolioRow[]; px: Prices | null }>) | null; prices: (() => Promise<Prices | null>) | null } = { read: null, prices: null };

// ------------------------------------------------------------------------------------------------------------------ snapshots
export const SNAPSHOT_EVERY_MS = 10 * 60_000, KEEP_ALL_DAYS = 7, KEEP_HOURLY_DAYS = 90;
/** One row per currency. Returns null when there is nothing honest to record (no reader yet, or no price list at all). */
export async function writeSnapshot(now: Date = new Date()): Promise<{ complete: boolean; totals: Record<string, string> } | null> {
  if (!portfolioDeps.read) return null;
  const { rows, px } = await portfolioDeps.read();
  if (!px || rows.length === 0) return null;
  const totals: Record<string, string> = {}; let complete = true;
  for (const currency of ['USD', 'CAD'] as const) {
    const { summary: s, breakdown } = summarize(rows, px, currency);
    if (s.total === null) return null;
    // A network that could not be read and held NOTHING the last time it was read (within a week) does not make the point
    // unusable: the total is the same figure. The point is kept as usable, and says so (`carried_zero`). Anything else that
    // is missing, uncertain, unpriced or stale keeps the point out of the chart, as before.
    const carried = !s.complete && !s.pricesStale && s.uncertain.length === 0 && s.unpriced.length === 0 && await missingHeldNothing(rows);
    const ok = (s.complete && !s.pricesStale) || carried;
    const reasons = [...s.missing.map((m) => ({ kind: carried ? 'carried_zero' : 'missing', ...m })), ...s.uncertain.map((u) => ({ kind: 'uncertain', ...u })), ...s.unpriced.map((u) => ({ kind: 'unpriced', network: u.network, asset: u.asset })), ...s.stalePrices.map((symbol) => ({ kind: 'stale_price', symbol }))].slice(0, 60);
    await sql`insert into portfolio_snapshots (at, currency, total, complete, reasons, breakdown) values (${now}, ${currency}, ${s.total}, ${ok}, ${sql.json(reasons as never)}, ${sql.json(breakdown as never)})`;
    totals[currency] = s.total; complete &&= ok;
  }
  return { complete, totals };
}
/** Retention: all points for 7 days, one per hour up to 90 days, one per day beyond. The point kept in a bucket is its first complete one (else its first). */
export async function pruneSnapshots(now: Date = new Date()): Promise<number> {
  const day = 86_400_000, a = new Date(now.getTime() - KEEP_ALL_DAYS * day), b = new Date(now.getTime() - KEEP_HOURLY_DAYS * day);
  const hourly = await sql`delete from portfolio_snapshots s using (
    select id, row_number() over (partition by currency, date_trunc('hour', at at time zone 'UTC') order by complete desc, at asc, id asc) as rn
    from portfolio_snapshots where at < ${a} and at >= ${b}) k where s.id = k.id and k.rn > 1`;
  const daily = await sql`delete from portfolio_snapshots s using (
    select id, row_number() over (partition by currency, date_trunc('day', at at time zone 'UTC') order by complete desc, at asc, id asc) as rn
    from portfolio_snapshots where at < ${b}) k where s.id = k.id and k.rn > 1`;
  return hourly.count + daily.count;
}
let lastPrune = 0;
/** the worker loop: record, then prune once an hour */
export async function snapshotTick(): Promise<void> {
  await writeSnapshot();
  if (Date.now() - lastPrune > 3600_000) { lastPrune = Date.now(); await pruneSnapshots(); }
}

// ------------------------------------------------------------------------------------------------------------------ flows
export const FLOW_PRICE_WINDOW_MS = 30 * 60_000;
interface FlowSrc { ref_type: 'deposit' | 'proposal'; ref_id: string; at: Date; direction: 'in' | 'out'; scope: 'external' | 'own_account'; network: string; asset: string; symbol: string; decimals: number; amount: string; /** the time of the event is not known (an aggregate deposit): never valued */ undated?: boolean }
/**
 * Record the flows not recorded yet: deposits that are external or come from one of the owner's own accounts outside the wallet
 * (agent vault, venue), and finalized plain transfers (to one of those accounts: `own_account`; else `external`).
 * The results of the wallet's own swaps and bridges are not flows: nothing entered or left.
 */
export async function recordFlows(px: Prices | null, now: Date = new Date()): Promise<number> {
  const found: FlowSrc[] = [];
  // a deposit classified `internal` after its flow was recorded (the operation wrote its transaction id later) is not a flow any more
  await sql`delete from portfolio_flows f using deposits d where f.ref_type = 'deposit' and f.ref_id = d.network || ':' || d.txid || ':' || d.idx || ':' || d.asset
    and d.kind = 'internal' and (d.origin is null or d.origin not in ('agent_withdrawal', 'venue_withdrawal'))`;
  await sql`update portfolio_flows f set scope = 'own_account' from deposits d where f.ref_type = 'deposit' and f.scope = 'external' and f.ref_id = d.network || ':' || d.txid || ':' || d.idx || ':' || d.asset
    and d.kind = 'internal' and d.origin in ('agent_withdrawal', 'venue_withdrawal')`;
  const dep = await sql<{ network: string; txid: string; idx: number; asset: string; amount: string; at: Date; kind: string; origin: string | null; detection: string | null }[]>`
    select d.network, d.txid, d.idx, d.asset, d.amount, coalesce(d.block_time, d.seen_at) as at, d.kind, d.origin, d.detection from deposits d
    where d.kind is not null and (d.kind = 'external' or d.origin in ('agent_withdrawal', 'venue_withdrawal'))
      and not exists (select 1 from portfolio_flows f where f.ref_type = 'deposit' and f.ref_id = d.network || ':' || d.txid || ':' || d.idx || ':' || d.asset)
    order by d.seen_at limit 500`;
  for (const d of dep) {
    const n = NETWORKS[d.network as keyof typeof NETWORKS] as NetworkDef | undefined, a = !n ? undefined : d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset);
    if (!n || !a) continue;
    found.push({ ref_type: 'deposit', ref_id: `${d.network}:${d.txid}:${d.idx}:${d.asset}`, at: d.at, direction: 'in', scope: d.kind === 'external' ? 'external' : 'own_account', network: d.network, asset: d.asset, symbol: a.symbol, decimals: a.decimals, amount: d.amount, undated: d.detection === 'aggregate' });
  }
  const out = await sql<{ id: string; network: string; asset: string; symbol: string; decimals: number; amount: string; at: Date; own: boolean }[]>`
    select p.id, p.network, p.asset, p.symbol, p.decimals, p.amount, coalesce(p.finalized_at, p.updated_at) as at,
      (exists (select 1 from agents g where lower(g.vault_address) = lower(p.to_addr)) or exists (select 1 from deriv_collateral c where c.proposal_id = p.id)) as own
    from proposals p where p.state = 'finalized' and p.kind = 'transfer' and lower(p.to_addr) <> lower(p.from_addr)
      and not exists (select 1 from portfolio_flows f where f.ref_type = 'proposal' and f.ref_id = p.id::text)
    order by p.finalized_at limit 500`;
  for (const p of out) found.push({ ref_type: 'proposal', ref_id: p.id, at: p.at, direction: 'out', scope: p.own ? 'own_account' : 'external', network: p.network, asset: p.asset, symbol: p.symbol, decimals: p.decimals, amount: p.amount });
  let n = 0;
  for (const f of found) {
    const m = px && Object.hasOwn(px, f.symbol) ? px[f.symbol]! : null;
    const near = !f.undated && Math.abs(now.getTime() - new Date(f.at).getTime()) <= FLOW_PRICE_WINDOW_MS;
    const ok = !!m && !m.stale && near && toScaled(m.usd) !== null && toScaled(m.cad) !== null;
    n += (await sql`insert into portfolio_flows (ref_type, ref_id, at, direction, scope, network, asset, symbol, decimals, amount, price_usd, price_cad, priced_at)
      values (${f.ref_type}, ${f.ref_id}, ${f.at}, ${f.direction}, ${f.scope}, ${f.network}, ${f.asset}, ${f.symbol}, ${f.decimals}, ${f.amount},
        ${ok ? fixed(toScaled(m!.usd)!, 12) : null}, ${ok ? fixed(toScaled(m!.cad)!, 12) : null}, ${ok ? now : null}) on conflict do nothing`).count;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------------------------ history
export const RANGES = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, ALL: null } as const;
export type Range = keyof typeof RANGES;
export const HISTORY_MAX_POINTS = 300;
interface Side { in: string; out: string; net: string }
export interface PortfolioHistory {
  range: Range; currency: Currency; asOf: string;
  /** complete snapshots only, oldest first, at most HISTORY_MAX_POINTS (the first and the last are always kept) */ points: { t: string; total: string }[];
  first: { t: string; total: string } | null; last: { t: string; total: string } | null;
  /** last - first: what the wallet's VALUE did, deposits and withdrawals included */ valueChange: { abs: string; pct: number | null } | null;
  /** what entered and left between `first` and `last`, valued at the price the API had when it saw each flow */
  flows: { from: string | null; to: string | null; external: Side; ownAccounts: Side; net: string; valued: number;
    /** flows in the period with no recorded price: they are NOT in the sums above */ unvalued: { refType: string; refId: string; at: string; direction: string; scope: string; network: string; symbol: string; amount: string }[];
    /** false when a flow of the period has no price: the sums, and the estimate below, are then partial */ complete: boolean };
  /** valueChange - net flows: an ESTIMATE of what prices (and fees) did to the wallet over the period. Not a realised return. */
  estimatedMarketChange: { abs: string; pct: number | null; method: 'value_change_minus_net_flows'; estimate: true; complete: boolean } | null;
  /** snapshots of the period that were not complete (a network down, a price missing): never charted */ omitted: { incomplete: number };
  retention: { everyPointDays: number; hourlyDays: number; snapshotEveryMinutes: number };
}
export async function history(range: Range, currency: Currency, now: Date = new Date()): Promise<PortfolioHistory> {
  const days = RANGES[range], since = days === null ? new Date(0) : new Date(now.getTime() - days * 86_400_000);
  const rows = await sql<{ at: Date; total: string; complete: boolean }[]>`select at, total::text as total, complete from portfolio_snapshots where currency = ${currency} and at >= ${since} and at <= ${now} order by at asc, id asc`;
  const good = rows.filter((r) => r.complete).map((r) => ({ t: new Date(r.at).toISOString(), total: fixed(toScaled(r.total)!) }));
  const step = Math.max(1, Math.ceil(good.length / HISTORY_MAX_POINTS));
  const points = good.filter((_, k) => k % step === 0 || k === good.length - 1);
  const first = good[0] ?? null, last = good.at(-1) ?? null, ck = currency === 'USD' ? 'price_usd' : 'price_cad';
  const zero: Side = { in: '0.00', out: '0.00', net: '0.00' };
  const out: PortfolioHistory = { range, currency, asOf: now.toISOString(), points, first, last, valueChange: null,
    flows: { from: first?.t ?? null, to: last?.t ?? null, external: zero, ownAccounts: { ...zero }, net: '0.00', valued: 0, unvalued: [], complete: true },
    estimatedMarketChange: null, omitted: { incomplete: rows.length - good.length }, retention: { everyPointDays: KEEP_ALL_DAYS, hourlyDays: KEEP_HOURLY_DAYS, snapshotEveryMinutes: SNAPSHOT_EVERY_MS / 60_000 } };
  if (!first || !last) return out;
  const f = toScaled(first.total)!, l = toScaled(last.total)!;
  out.valueChange = { abs: fixed(l - f), pct: f > 0n ? ratio((l - f) * 100n, f, 4) : null };
  const fl = await sql<{ ref_type: string; ref_id: string; at: Date; direction: string; scope: string; network: string; symbol: string; decimals: number; amount: string; price: string | null }[]>`
    select ref_type, ref_id, at, direction, scope, network, symbol, decimals, amount::text as amount, ${sql(ck)}::text as price from portfolio_flows where at > ${new Date(first.t)} and at <= ${new Date(last.t)} order by at asc`;
  const sum = { external: { in: 0n, out: 0n }, own_account: { in: 0n, out: 0n } };
  for (const x of fl) {
    const p = x.price === null ? null : toScaled(x.price);
    if (p === null) { if (out.flows.unvalued.length < 50) out.flows.unvalued.push({ refType: x.ref_type, refId: x.ref_id, at: new Date(x.at).toISOString(), direction: x.direction, scope: x.scope, network: x.network, symbol: x.symbol, amount: formatUnits(BigInt(x.amount), x.decimals) }); out.flows.complete = false; continue; }
    sum[x.scope === 'own_account' ? 'own_account' : 'external'][x.direction === 'out' ? 'out' : 'in'] += valueOf(BigInt(x.amount), x.decimals, p); out.flows.valued += 1;
  }
  const side = (s: { in: bigint; out: bigint }): Side => ({ in: fixed(s.in), out: fixed(s.out), net: fixed(s.in - s.out) });
  const net = sum.external.in - sum.external.out + sum.own_account.in - sum.own_account.out;
  out.flows.external = side(sum.external); out.flows.ownAccounts = side(sum.own_account); out.flows.net = fixed(net);
  out.estimatedMarketChange = { abs: fixed(l - f - net), pct: f > 0n ? ratio((l - f - net) * 100n, f, 4) : null, method: 'value_change_minus_net_flows', estimate: true, complete: out.flows.complete };
  return out;
}
