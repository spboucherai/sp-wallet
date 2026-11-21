/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/analytics.ts
 * Module           : wallet-api
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

// NEXT — GET /api/v1/analytics: what entered and left the wallet, the network fees it paid, how its operations ended and
// who it deals with most. READ-ONLY and from the database only: no chain read, no price call, nothing signed.
//
// What each figure is, so that none is read as more than it is:
//   flows          in  = deposits the scan recorded;  out = operations that are FINAL (state `finalized`), nothing else.
//                  Classification — the rule of portfolio.ts `recordFlows`, extended with the movements that rule leaves out:
//                    external     a deposit from someone else; a plain transfer to someone else
//                    ownAccounts  a withdrawal from an agent vault or a venue account; a transfer to one of them
//                    internal     the result, or the outgoing leg, of the wallet's own swap / bridge / native swap / GMX
//                                 order, and a transfer to itself: nothing entered or left
//                  Amounts are summed per asset in base units. Amounts of different assets are never added.
//   fiat           only where a price was RECORDED when the movement was seen (portfolio_flows.price_*: within 30 minutes of
//                  the event, from a fresh price). A movement without one is counted in `unvalued` and is in no sum.
//                  Internal movements are not valued at all. Nothing here is a return, a profit or a performance.
//   fees           the sum of `fee_paid` (what the network charged, recorded by the tracker) per network, in its native coin,
//                  with the number of on-chain transactions whose fee was never recorded — rows older than NEXT have none —
//                  so that the figure says what it covers. Not valued in fiat: no price is recorded with a fee.
//   outcomes       every operation created in the period, by `lifecycle` and by kind.
//   counterparties external only: addresses paid most often / paying most often, with the contact label when there is one.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, getNetwork, lifecycleOf, NETWORKS, type NetworkDef, type ProposalState } from '@spw/core';
import { sql } from '../db.ts';
import { fixed, toScaled, type Currency } from '../portfolio.ts';
import { contactLabeler } from './labels.ts';

export const ANALYTICS_RANGES = { '1M': 30, '3M': 90, '1Y': 365, ALL: null } as const;
export type AnalyticsRange = keyof typeof ANALYTICS_RANGES;
export const COUNTERPARTY_LIMIT = 10;
const SCOPES = ['external', 'internal', 'ownAccounts'] as const;
type Scope = (typeof SCOPES)[number];
interface Bucket { count: number; amount: string; display: string; value: string | null; valued: number; unvalued: number }
type Scoped<T> = Record<Scope, T>;
type Frag = import('postgres').PendingQuery<import('postgres').Row[]>;
interface FlowRow { network: string; asset: string; scope: Scope; n: number; amount: string; valued: number; value_raw: string }

const assetOf = (network: string, asset: string): { symbol: string; decimals: number } | null => {
  const n = NETWORKS[network as keyof typeof NETWORKS] as NetworkDef | undefined;
  const a = !n ? undefined : asset === 'native' ? n.native : n.tokens.find((t) => t.id.toLowerCase() === asset.toLowerCase());
  return a ? { symbol: a.symbol, decimals: a.decimals } : null;
};
const netName = (id: string): string => { try { return getNetwork(id).name; } catch { return id; } };
/** Σ(base units × price) as PostgreSQL wrote it (an exact numeric) → fiat with 2 decimals; null when it cannot be read */
const fiatOf = (raw: string, decimals: number): bigint | null => { const s = toScaled(raw); return s === null ? null : s / 10n ** BigInt(decimals); };
const scoped = <T>(f: () => T): Scoped<T> => ({ external: f(), internal: f(), ownAccounts: f() });

/** Where an outgoing proposal went — the SQL of portfolio.ts `recordFlows` for plain transfers; everything else is the wallet's own operation. */
const OUT_SCOPE = sql`case when p.kind = 'transfer' and lower(p.to_addr) <> lower(p.from_addr) then
    case when exists (select 1 from agents g where lower(g.vault_address) = lower(p.to_addr)) or exists (select 1 from deriv_collateral c where c.proposal_id = p.id) then 'ownAccounts' else 'external' end
  else 'internal' end`;
const IN_SCOPE = sql`case when d.kind = 'internal' and d.origin in ('agent_withdrawal', 'venue_withdrawal') then 'ownAccounts' when d.kind = 'internal' then 'internal' else 'external' end`;

export async function analytics(range: AnalyticsRange, currency: Currency, now: Date = new Date()) {
  const days = ANALYTICS_RANGES[range], since = days === null ? null : new Date(now.getTime() - days * 86_400_000);
  const px = sql(currency === 'USD' ? 'price_usd' : 'price_cad');
  const depAt = sql`coalesce(d.block_time, d.seen_at)`, outAt = sql`coalesce(p.finalized_at, p.updated_at)`;
  const after = (col: Frag) => (since ? sql`and ${col} >= ${since}` : sql``);

  const [ins, outs, fees, states, sent, received, label] = await Promise.all([
    sql<FlowRow[]>`select d.network, d.asset, ${IN_SCOPE} as scope, count(*)::int as n, sum(d.amount)::text as amount,
        (count(*) filter (where f.px is not null))::int as valued, coalesce(sum(d.amount * f.px), 0)::text as value_raw
      from deposits d left join (select ref_id, ${px} as px from portfolio_flows where ref_type = 'deposit') f on f.ref_id = d.network || ':' || d.txid || ':' || d.idx || ':' || d.asset
      where ${depAt} <= ${now} ${after(depAt)} group by 1, 2, 3`,
    sql<FlowRow[]>`select p.network, p.asset, ${OUT_SCOPE} as scope, count(*)::int as n, sum(p.amount)::text as amount,
        (count(*) filter (where f.px is not null))::int as valued, coalesce(sum(p.amount * f.px), 0)::text as value_raw
      from proposals p left join (select ref_id, ${px} as px from portfolio_flows where ref_type = 'proposal') f on f.ref_id = p.id::text
      where p.state = 'finalized' and p.kind <> 'nft' and ${outAt} <= ${now} ${after(outAt)} group by 1, 2, 3`,
    sql<{ network: string; paid: string; known: number; unknown: number }[]>`select p.network, coalesce(sum(p.fee_paid), 0)::text as paid, (count(*) filter (where p.fee_paid is not null))::int as known,
        (count(*) filter (where p.fee_paid is null and (p.state in ('confirming', 'finalized', 'reorged') or (p.state = 'failed' and p.block_ref is not null))))::int as unknown
      from proposals p where p.created_at <= ${now} ${after(sql`p.created_at`)} group by p.network`,
    sql<{ state: ProposalState; relay: boolean; expired_onchain: boolean; kind: string; n: number }[]>`select p.state, (p.relay_attempted_at is not null) as relay, (p.error_code is not distinct from 'expired_onchain') as expired_onchain, p.kind, count(*)::int as n
      from proposals p where p.state <> 'draft' and p.created_at <= ${now} ${after(sql`p.created_at`)} group by 1, 2, 3, 4`,
    sql<{ network: string; address: string; asset: string; n: number; amount: string; last: Date }[]>`select p.network, p.to_addr as address, p.asset, count(*)::int as n, sum(p.amount)::text as amount, max(${outAt}) as last
      from proposals p where p.state = 'finalized' and p.kind = 'transfer' and ${OUT_SCOPE} = 'external' and ${outAt} <= ${now} ${after(outAt)} group by 1, 2, 3`,
    sql<{ network: string; address: string; asset: string; n: number; amount: string; last: Date }[]>`select d.network, d.from_addr as address, d.asset, count(*)::int as n, sum(d.amount)::text as amount, max(${depAt}) as last
      from deposits d where d.from_addr <> '' and ${IN_SCOPE} = 'external' and ${depAt} <= ${now} ${after(depAt)} group by 1, 2, 3`,
    contactLabeler(),
  ]);

  // ---- flows per asset and per network; fiat totals of what really entered and left (exact integers until the answer is written)
  interface Acc { count: number; amount: bigint; v: bigint | null; valued: number; unvalued: number }
  const acc = (): Acc => ({ count: 0, amount: 0n, v: null, valued: 0, unvalued: 0 });
  const byAsset = new Map<string, { network: string; networkName: string; asset: string; symbol: string; decimals: number; in: Scoped<Acc>; out: Scoped<Acc> }>();
  const byNetwork = new Map<string, { network: string; networkName: string; in: Scoped<number>; out: Scoped<number> }>();
  const fiat = { in: scoped(acc), out: scoped(acc) };
  const add = (dir: 'in' | 'out', r: FlowRow): void => {
    const meta = assetOf(r.network, r.asset) ?? { symbol: '?', decimals: 0 }, k = `${r.network}\n${r.asset.toLowerCase()}`;
    const row = byAsset.get(k) ?? { network: r.network, networkName: netName(r.network), asset: r.asset, ...meta, in: scoped(acc), out: scoped(acc) };
    // internal movements are never valued; a group none of whose movements has a recorded price has no value at all
    const v = r.scope === 'internal' || r.valued === 0 ? null : fiatOf(r.value_raw, meta.decimals), valued = v === null ? 0 : r.valued;
    for (const b of [row[dir][r.scope], fiat[dir][r.scope]]) { b.count += r.n; b.amount += BigInt(r.amount); if (v !== null) b.v = (b.v ?? 0n) + v; b.valued += valued; b.unvalued += r.n - valued; }
    byAsset.set(k, row);
    const net = byNetwork.get(r.network) ?? { network: r.network, networkName: netName(r.network), in: scoped(() => 0), out: scoped(() => 0) };
    net[dir][r.scope] += r.n; byNetwork.set(r.network, net);
  };
  for (const r of ins) add('in', r);
  for (const r of outs) add('out', r);
  const bucket = (b: Acc, decimals: number): Bucket => ({ count: b.count, amount: b.amount.toString(), display: formatUnits(b.amount, decimals), value: b.v === null ? null : fixed(b.v), valued: b.valued, unvalued: b.unvalued });
  const buckets = (m: Scoped<Acc>, decimals: number): Scoped<Bucket> => ({ external: bucket(m.external, decimals), internal: bucket(m.internal, decimals), ownAccounts: bucket(m.ownAccounts, decimals) });
  const side = (f: Acc) => ({ value: fixed(f.v ?? 0n), valued: f.valued, unvalued: f.unvalued, complete: f.unvalued === 0 });
  const total = (m: Scoped<Acc>): number => m.external.count + m.internal.count + m.ownAccounts.count;

  // ---- outcomes
  const lc = new Map<string, number>(), kinds = new Map<string, number>(); let operations = 0;
  for (const s of states) {
    const l = lifecycleOf(s.state, { relayAttempted: s.relay, errorCode: s.expired_onchain ? 'expired_onchain' : null });
    lc.set(l, (lc.get(l) ?? 0) + s.n); kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + s.n); operations += s.n;
  }
  const desc = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  // ---- counterparties
  const parties = (rows: { network: string; address: string; asset: string; n: number; amount: string; last: Date }[]) => {
    const m = new Map<string, { network: string; address: string; contactLabel: string | null; count: number; lastAt: string; assets: { asset: string; symbol: string; amount: string; display: string; count: number }[] }>();
    for (const r of rows) {
      const k = `${r.network}\n${r.address}`, meta = assetOf(r.network, r.asset) ?? { symbol: '?', decimals: 0 }, at = new Date(r.last).toISOString();
      const p = m.get(k) ?? { network: r.network, address: r.address, contactLabel: label(r.network, r.address), count: 0, lastAt: at, assets: [] };
      p.count += r.n; if (at > p.lastAt) p.lastAt = at;
      p.assets.push({ asset: r.asset, symbol: meta.symbol, amount: r.amount, display: formatUnits(BigInt(r.amount), meta.decimals), count: r.n });
      m.set(k, p);
    }
    return [...m.values()].map((p) => ({ ...p, assets: p.assets.sort((a, b) => b.count - a.count || (a.symbol < b.symbol ? -1 : 1)) }))
      .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || (a.address < b.address ? -1 : 1)).slice(0, COUNTERPARTY_LIMIT);
  };

  return {
    range, currency, from: since ? since.toISOString() : null, to: now.toISOString(), asOf: now.toISOString(),
    flows: {
      byAsset: [...byAsset.values()].sort((a, b) => total(b.in) + total(b.out) - (total(a.in) + total(a.out)) || (a.network + a.symbol < b.network + b.symbol ? -1 : 1))
        .map((r) => ({ ...r, in: buckets(r.in, r.decimals), out: buckets(r.out, r.decimals) })),
      byNetwork: [...byNetwork.values()].sort((a, b) => (a.network < b.network ? -1 : 1)),
      fiat: { in: { external: side(fiat.in.external), ownAccounts: side(fiat.in.ownAccounts) }, out: { external: side(fiat.out.external), ownAccounts: side(fiat.out.ownAccounts) }, method: 'price_recorded_when_seen' as const,
        note: 'Each movement is valued with the price recorded when the API saw it (within 30 minutes of the event). Movements without a recorded price are counted in `unvalued` and are in no sum. Internal movements are not valued.' },
      basis: { in: 'deposits recorded by the scan, at their block time (else the time they were seen)', out: 'operations that are final (state finalized), at the time they became final', classification: 'external | internal (the wallet\'s own operations) | ownAccounts (agent vaults, venue accounts) — the rule of the portfolio flows' },
    },
    fees: {
      byNetwork: fees.filter((f) => f.known + f.unknown > 0).map((f) => { const n = getNetwork(f.network);
        return { network: f.network, networkName: n.name, symbol: n.native.symbol, decimals: n.native.decimals, paid: f.paid, paidDisplay: formatUnits(BigInt(f.paid), n.native.decimals), known: f.known, unknown: f.unknown, complete: f.unknown === 0 }; })
        .sort((a, b) => (a.network < b.network ? -1 : 1)),
      covers: 'the fee the network charged for the main transaction of each operation created in the period, where the tracker recorded it; `unknown` counts the on-chain transactions without a recorded fee (not in `paid`); the fee of a separate token-approval transaction is not recorded',
      fiat: null,
    },
    outcomes: { total: operations, byLifecycle: desc(lc).map(([lifecycle, count]) => ({ lifecycle, count })), byKind: desc(kinds).map(([kind, count]) => ({ kind, count })), basis: 'operations created in the period, drafts excluded' },
    counterparties: { sentTo: parties(sent), receivedFrom: parties(received), limit: COUNTERPARTY_LIMIT, rankedBy: 'count' as const },
    disclaimer: 'Recorded movements and fees. A fiat figure exists only where a price was recorded at the time; nothing here is a realised return or a profit.',
  };
}

export function analyticsRoutes(app: FastifyInstance, deps: { currency: () => Promise<Currency> }): void {
  app.get('/api/v1/analytics', async (req) => {
    const q = z.object({ range: z.enum(Object.keys(ANALYTICS_RANGES) as [AnalyticsRange, ...AnalyticsRange[]]).default('1M'), currency: z.enum(['USD', 'CAD']).optional() }).parse(req.query);
    return analytics(q.range, q.currency ?? await deps.currency());
  });
}
