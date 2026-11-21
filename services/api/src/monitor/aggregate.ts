/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/monitor/aggregate.ts
 * Module           : monitor
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Monitoring aggregates — read-only SQL over what the workers already stored (equity snapshots, positions, orders).
// Three kinds of money are NEVER added together: the wallet (real, on chain), agent vaults (real when LIVE, simulated when
// paper) and derivatives accounts (real on a venue, simulated on paper). Each figure says which it is.
import { sql } from '../db.ts';

export interface Pnl { abs: number; pct: number | null; /** the series starts inside the window: the figure covers less than the window */ partial: boolean; from: number }
export interface PnlRow { today: Pnl | null; d7: Pnl | null; d30: Pnl | null; equity: number | null; asOf: number | null }
/** start of the owner's local day */
export function dayStart(now: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Math.floor(now / 1000) * 1000 - (g('hour') * 3600 + g('minute') * 60 + g('second')) * 1000;
}
type Point = { ts: number; equity: number };
type Series = { latest(): Promise<Point | null>; atOrBefore(t: number): Promise<Point | null>; firstAfter(t: number): Promise<Point | null> };
/** PnL of an equity series over a window: latest snapshot minus the last snapshot at or before the window start (else the first inside it) */
export async function pnlOf(s: Series, now: number, tz: string): Promise<PnlRow> {
  const last = await s.latest();
  if (!last) return { today: null, d7: null, d30: null, equity: null, asOf: null };
  const one = async (start: number): Promise<Pnl | null> => {
    const base = (await s.atOrBefore(start)) ?? null, first = base ?? (await s.firstAfter(start));
    if (!first || first.ts >= last.ts) return base ? { abs: 0, pct: 0, partial: false, from: base.ts } : null;
    const abs = last.equity - first.equity;
    return { abs: Math.round(abs * 100) / 100, pct: first.equity > 0 ? Math.round((abs / first.equity) * 10000) / 100 : null, partial: base === null, from: first.ts };
  };
  return { today: await one(dayStart(now, tz)), d7: await one(now - 7 * 86_400_000), d30: await one(now - 30 * 86_400_000), equity: last.equity, asOf: last.ts };
}
const pt = (r: { ts: Date; equity: number | string } | undefined): Point | null => (r ? { ts: r.ts.getTime(), equity: Number(r.equity) } : null);
const agentSeries = (id: string, mode: string): Series => ({
  latest: async () => pt((await sql<{ ts: Date; equity: number }[]>`select ts, equity_usd as equity from agent_equity where agent_id = ${id} and mode = ${mode} order by ts desc limit 1`)[0]),
  atOrBefore: async (t) => pt((await sql<{ ts: Date; equity: number }[]>`select ts, equity_usd as equity from agent_equity where agent_id = ${id} and mode = ${mode} and ts <= ${new Date(t)} order by ts desc limit 1`)[0]),
  firstAfter: async (t) => pt((await sql<{ ts: Date; equity: number }[]>`select ts, equity_usd as equity from agent_equity where agent_id = ${id} and mode = ${mode} and ts > ${new Date(t)} order by ts limit 1`)[0]),
});
const derivSeries = (id: string): Series => ({
  latest: async () => pt((await sql<{ ts: Date; equity: string }[]>`select ts, equity from deriv_equity where account_id = ${id} order by ts desc limit 1`)[0]),
  atOrBefore: async (t) => pt((await sql<{ ts: Date; equity: string }[]>`select ts, equity from deriv_equity where account_id = ${id} and ts <= ${new Date(t)} order by ts desc limit 1`)[0]),
  firstAfter: async (t) => pt((await sql<{ ts: Date; equity: string }[]>`select ts, equity from deriv_equity where account_id = ${id} and ts > ${new Date(t)} order by ts limit 1`)[0]),
});

interface AgentR { id: string; name: string; state: string; network: string; cash: string | null; universe: string[]; capital_usdc: string; last_bar: Date | null; stop_reason: string | null; mandate: { expiresAt?: number } | null }
interface PaperR { id: string; venue: string; network: string; label: string; state: { positions?: { instrument: string; side: string; size: string; markPrice: string }[]; collateral?: string }; policy: { halt?: string | null } }
interface VenueR { id: string; venue: string; network: string; label: string; mode: string; halt: string | null; divergence: string | null; meta: { baseline?: Record<string, string>; baselineTs?: number } }
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'PYUSD', 'USDe', 'FDUSD', 'USDG', 'RLUSD', 'USDT0', 'USDC.e', 'GHO', 'crvUSD', 'frxUSD', 'USDD']);
/** base asset of a derivatives instrument id: `hyperliquid:BTC`, `dydx:BTC-USD`, `gmx:BTC/USD [BTC-USDC]` */
export const baseOf = (instrument: string): string => /^[^:]*:([A-Za-z0-9.]+)/.exec(instrument)?.[1]?.toUpperCase() ?? instrument;
const agentMode = (state: string): 'LIVE' | 'PAPER' => (state === 'LIVE' ? 'LIVE' : 'PAPER');

async function load() {
  const [agents, paper, venue] = await Promise.all([
    sql<AgentR[]>`select id, name, state, network, cash, universe, capital_usdc::text as capital_usdc, last_bar, stop_reason, mandate from agents order by created_at`,
    sql<PaperR[]>`select id, venue, network, label, state, policy from deriv_paper_accounts order by created_at`,
    sql<VenueR[]>`select id, venue, network, label, mode, halt, divergence, meta from deriv_accounts order by created_at`,
  ]);
  return { agents, paper, venue };
}
/** net position per instrument of a venue account, from the fills on record since the baseline the owner accepted (not read from the venue) */
async function venueNets(a: VenueR): Promise<{ instrument: string; net: number; price: number | null }[]> {
  const rows = await sql<{ instrument: string; net: string; price: string | null }[]>`
    select instrument, sum(case when side = 'buy' then size else -size end)::text as net, (array_agg(price order by ts desc))[1]::text as price
    from deriv_fills where account_id = ${a.id} and ts >= ${new Date(a.meta?.baselineTs ?? 0)} group by instrument`;
  const m = new Map<string, { net: number; price: number | null }>();
  for (const [k, v] of Object.entries(a.meta?.baseline ?? {})) m.set(k, { net: Number(v), price: null });
  for (const r of rows) m.set(r.instrument, { net: (m.get(r.instrument)?.net ?? 0) + Number(r.net), price: r.price === null ? null : Number(r.price) });
  return [...m.entries()].map(([instrument, v]) => ({ instrument, ...v })).filter((x) => Math.abs(x.net) > 1e-12);
}
const latestCloses = async (symbols: string[]): Promise<Map<string, number>> => {
  if (!symbols.length) return new Map();
  const rows = await sql<{ symbol: string; close: number | null }[]>`select s as symbol, (select close from candles where symbol = s and interval = '1h' order by ts desc limit 1) as close from unnest(${symbols}::text[]) s`;
  return new Map(rows.filter((r) => r.close !== null).map((r) => [r.symbol, r.close!]));
};

export async function capital(now: number) {
  const { agents, paper, venue } = await load();
  const agentRows = await Promise.all(agents.map(async (a) => {
    const mode = agentMode(a.state);
    const [e] = await sql<{ ts: Date; equity_usd: number; positions: Record<string, number> }[]>`select ts, equity_usd, positions from agent_equity where agent_id = ${a.id} and mode = ${mode} order by ts desc limit 1`;
    const cash = a.cash ?? 'USDC';
    return { id: a.id, name: a.name, state: a.state, network: a.network, mode, real: mode === 'LIVE', capitalUsd: Number(a.capital_usdc) / 1e6, equityUsd: e?.equity_usd ?? null, asOf: e?.ts.getTime() ?? null,
      positions: e ? Object.entries(e.positions).filter(([s, u]) => s !== cash && u > 0).length : 0, lastBar: a.last_bar?.getTime() ?? null, stopReason: a.stop_reason,
      mandateExpiresAt: a.state === 'LIVE' && a.mandate?.expiresAt ? a.mandate.expiresAt * 1000 : null };
  }));
  const eq = async (id: string) => (await sql<{ ts: Date; equity: string; collateral: string; margin_used: string; unrealized_pnl: string }[]>`select ts, equity, collateral, margin_used, unrealized_pnl from deriv_equity where account_id = ${id} order by ts desc limit 1`)[0];
  const openOrders = new Map((await sql<{ account_id: string; n: number }[]>`
    select account_id, count(*)::int as n from deriv_orders where (state is null and status in ('open', 'partially_filled')) or (state is not null and not final and state in ('submitted', 'open', 'partially_filled', 'unknown')) group by account_id`).map((r) => [r.account_id, r.n]));
  const derivRows = [
    ...(await Promise.all(paper.map(async (a) => { const e = await eq(a.id);
      return { id: a.id, label: a.label, venue: a.venue, network: a.network, kind: 'paper' as const, real: false, mode: 'PAPER', equity: e ? Number(e.equity) : Number(a.state.collateral ?? 0), collateral: e ? Number(e.collateral) : Number(a.state.collateral ?? 0),
        marginUsed: e ? Number(e.margin_used) : 0, unrealizedPnl: e ? Number(e.unrealized_pnl) : 0, asOf: e?.ts.getTime() ?? null, halt: a.policy?.halt ?? null, divergence: null as string | null,
        positions: a.state.positions?.length ?? 0, openOrders: openOrders.get(a.id) ?? 0 }; }))),
    ...(await Promise.all(venue.map(async (a) => { const e = await eq(a.id);
      // a testnet account holds test funds: shown, never counted as capital
      return { id: a.id, label: a.label, venue: a.venue, network: a.network, kind: 'venue' as const, real: a.network === 'mainnet', mode: a.mode, equity: e ? Number(e.equity) : null, collateral: e ? Number(e.collateral) : null,
        marginUsed: e ? Number(e.margin_used) : null, unrealizedPnl: e ? Number(e.unrealized_pnl) : null, asOf: e?.ts.getTime() ?? null, halt: a.halt, divergence: a.divergence,
        positions: (await venueNets(a)).length, openOrders: openOrders.get(a.id) ?? 0 }; }))),
  ];
  const [ao] = await sql<{ n: number }[]>`select count(*)::int as n from agent_orders where mode = 'LIVE' and state in ('prepared', 'signed', 'broadcast')`;
  const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;
  const states: Record<string, number> = {};
  for (const a of agents) states[a.state] = (states[a.state] ?? 0) + 1;
  return {
    asOf: now, agents: agentRows, derivatives: derivRows,
    totals: {
      agentsLiveUsd: sum(agentRows.filter((a) => a.real).map((a) => a.equityUsd)), agentsPaperUsd: sum(agentRows.filter((a) => !a.real && (a.state === 'PAPER_TRADING')).map((a) => a.equityUsd)),
      derivVenueUsd: sum(derivRows.filter((a) => a.real).map((a) => a.equity)), derivPaperUsd: sum(derivRows.filter((a) => a.kind === 'paper').map((a) => a.equity)),
      derivTestnetUsd: sum(derivRows.filter((a) => a.kind === 'venue' && !a.real).map((a) => a.equity)),
    },
    counts: { agents: states, openPositions: { agents: agentRows.filter((a) => a.state === 'LIVE' || a.state === 'PAPER_TRADING').reduce((s, a) => s + a.positions, 0), derivatives: derivRows.reduce((s, a) => s + a.positions, 0) },
      openOrders: { agents: ao?.n ?? 0, derivatives: derivRows.reduce((s, a) => s + a.openOrders, 0) } },
  };
}

export async function pnl(now: number, tz: string) {
  const { agents, paper, venue } = await load();
  return {
    asOf: now, tz,
    /** equity differences between stored snapshots: a deposit or a withdrawal inside a window is counted as PnL */
    note: 'flows_included',
    agents: await Promise.all(agents.filter((a) => a.state !== 'CREATED').map(async (a) => ({ id: a.id, name: a.name, mode: agentMode(a.state), real: a.state === 'LIVE', state: a.state, ...(await pnlOf(agentSeries(a.id, agentMode(a.state)), now, tz)) }))),
    derivatives: [
      ...(await Promise.all(paper.map(async (a) => ({ id: a.id, label: a.label, kind: 'paper' as const, real: false, ...(await pnlOf(derivSeries(a.id), now, tz)) })))),
      ...(await Promise.all(venue.map(async (a) => ({ id: a.id, label: a.label, kind: 'venue' as const, real: a.network === 'mainnet', ...(await pnlOf(derivSeries(a.id), now, tz)) })))),
    ],
  };
}

export interface ExposureRow { asset: string; spotUsd: number; perpLongUsd: number; perpShortUsd: number; netUsd: number; grossUsd: number; priced: boolean }
/** Exposure per asset. Spot holdings of agents and perpetual contracts are different instruments (a perp has funding, margin and a
 *  liquidation price; spot has none): the net figure is an indication of direction, not a hedge ratio. Real and simulated apart. */
export async function exposure(now: number) {
  const { agents, paper, venue } = await load();
  const acc = { real: new Map<string, ExposureRow>(), simulated: new Map<string, ExposureRow>() };
  const row = (m: Map<string, ExposureRow>, asset: string): ExposureRow => { let r = m.get(asset); if (!r) { r = { asset, spotUsd: 0, perpLongUsd: 0, perpShortUsd: 0, netUsd: 0, grossUsd: 0, priced: true }; m.set(asset, r); } return r; };
  const active = agents.filter((a) => a.state === 'LIVE' || a.state === 'PAPER_TRADING');
  const spots = await Promise.all(active.map(async (a) => ({ a, e: (await sql<{ positions: Record<string, number> }[]>`select positions from agent_equity where agent_id = ${a.id} and mode = ${agentMode(a.state)} order by ts desc limit 1`)[0] })));
  const nets = await Promise.all(venue.map(async (a) => ({ a, nets: await venueNets(a) })));
  const symbols = new Set<string>();
  for (const { e } of spots) for (const s of Object.keys(e?.positions ?? {})) symbols.add(s);
  for (const { nets: ns } of nets) for (const n of ns) symbols.add(baseOf(n.instrument));
  const px = await latestCloses([...symbols]);
  for (const { a, e } of spots) for (const [s, u] of Object.entries(e?.positions ?? {})) {
    if (s === (a.cash ?? 'USDC') || STABLE.has(s) || !(u > 0)) continue;
    const r = row(a.state === 'LIVE' ? acc.real : acc.simulated, s), p = px.get(s);
    if (p === undefined) { r.priced = false; continue; }
    r.spotUsd += u * p;
  }
  for (const a of paper) for (const p of a.state.positions ?? []) {
    const r = row(acc.simulated, baseOf(p.instrument)), n = Number(p.size) * Number(p.markPrice);
    if (p.side === 'long') r.perpLongUsd += n; else r.perpShortUsd += n;
  }
  for (const { a, nets: ns } of nets) for (const n of ns) {
    const asset = baseOf(n.instrument), r = row(a.network === 'mainnet' ? acc.real : acc.simulated, asset), p = px.get(asset) ?? n.price;
    if (p === null || p === undefined) { r.priced = false; continue; }
    if (n.net > 0) r.perpLongUsd += n.net * p; else r.perpShortUsd += -n.net * p;
  }
  const finish = (m: Map<string, ExposureRow>): ExposureRow[] => [...m.values()].map((r) => {
    const rd = (x: number) => Math.round(x * 100) / 100;
    return { ...r, spotUsd: rd(r.spotUsd), perpLongUsd: rd(r.perpLongUsd), perpShortUsd: rd(r.perpShortUsd), netUsd: rd(r.spotUsd + r.perpLongUsd - r.perpShortUsd), grossUsd: rd(r.spotUsd + r.perpLongUsd + r.perpShortUsd) };
  }).sort((x, y) => y.grossUsd - x.grossUsd);
  return { asOf: now, caveat: 'spot_and_perp_differ', real: finish(acc.real), simulated: finish(acc.simulated) };
}
