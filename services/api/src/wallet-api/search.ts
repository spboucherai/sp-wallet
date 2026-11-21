/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/search.ts
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

// NEXT — GET /api/v1/search?q=: one search box for the three clients. Owner session only (every /api route is).
//
//   assets        the verified registry, in memory: symbol, name, network (id or name), contract / mint address
//   contacts      the address book: label, address, note
//   transactions  proposals and deposits: transaction id (prefix, with or without 0x), address (substring), exact amount, note
//
// Nothing leaves the server: no chain, no indexer, no price source is asked. Every SQL value is a bound parameter; the
// wildcards of LIKE (% _ \) in the query are escaped, so `%` searches for a percent sign and matches nothing else.
// Groups are capped (`limit` per group) and say when they were cut (`truncated`). Queries shorter than 2 characters are
// refused by validation; address and transaction-id matching need 4, so that two letters do not match half the history.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, getNetwork, lifecycleOf, legacyState, NETWORKS, parseUnits, type NetworkDef, type ProposalState } from '@spw/core';
import { adapterFor } from '../chains/index.ts';
import { sql } from '../db.ts';
import { contactLabeler, NO_CONTROL } from './labels.ts';

export const SEARCH_MIN = 2, SEARCH_MAX = 120, SEARCH_ID_MIN = 4;
const NETS = Object.values(NETWORKS) as NetworkDef[];
/** the query as a LIKE operand that matches only itself */
export const likeLiteral = (q: string): string => q.replace(/[\\%_]/g, '\\$&');
const has = (hay: string | null | undefined, needle: string): boolean => !!hay && hay.toLowerCase().includes(needle);
const DECIMAL = /^\d{1,30}(?:[.,]\d{1,18})?$/;
/** every integer of base units the query can be, one per number of decimals an asset can have (a row is kept only when its own decimals give the match) */
function amountCandidates(q: string): string[] {
  if (!DECIMAL.test(q)) return [];
  const out = new Set<string>();
  for (let d = 0; d <= 18; d += 1) { try { const v = parseUnits(q.replace(',', '.'), d); if (v > 0n) out.add(v.toString()); } catch { /* more decimals than this asset has */ } }
  return [...out];
}
const amountIs = (q: string, amount: string, decimals: number): boolean => { try { return DECIMAL.test(q) && parseUnits(q.replace(',', '.'), decimals) === BigInt(amount); } catch { return false; } };
const rowKind = (k: string | null): string => (k === 'swap' || k === 'xswap' ? 'swap' : k === 'bridge' ? 'bridge' : k === 'gmx' ? 'gmx' : 'send');
type Frag = import('postgres').PendingQuery<import('postgres').Row[]>;
const anyOf = (conds: Frag[]): Frag => conds.reduce((a, c) => sql`${a} or ${c}`);

function searchAssets(q: string, limit: number) {
  const hits: { rank: number; item: { type: 'asset'; network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; matched: string } }[] = [];
  for (const n of NETS) {
    const off = new Set(adapterFor(n.id).disabledAssets?.() ?? []);
    for (const a of [n.native, ...n.tokens.filter((t) => !off.has(t.id))]) {
      const sym = a.symbol.toLowerCase();
      const m = sym === q ? ['symbol', 0] as const : sym.startsWith(q) ? ['symbol', 1] as const : sym.includes(q) ? ['symbol', 2] as const : has(a.name, q) ? ['name', 3] as const
        : a.id !== 'native' && q.length >= SEARCH_ID_MIN && has(a.id, q) ? ['contract', 3] as const : n.id === q || has(n.name, q) ? ['network', 4] as const : null;
      if (m) hits.push({ rank: m[1], item: { type: 'asset', network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, matched: m[0] } });
    }
  }
  hits.sort((a, b) => a.rank - b.rank || (a.item.symbol + a.item.network < b.item.symbol + b.item.network ? -1 : 1));
  return { items: hits.slice(0, limit).map((h) => h.item), truncated: hits.length > limit };
}

export async function search(raw: string, limit: number) {
  const q = raw.trim(), lq = q.toLowerCase(), like = `%${likeLiteral(q)}%`, long = q.length >= SEARCH_ID_MIN;
  // a transaction id is matched from its start; EVM ids are stored with 0x, so a query typed without it is tried with it too
  const prefixes = long ? [`${likeLiteral(q)}%`, ...(/^0x/i.test(q) ? [] : [`0x${likeLiteral(q)}%`])] : [];
  const amounts = amountCandidates(q), label = await contactLabeler();

  const contactRows = await sql<{ id: string; network: string; address: string; label: string; note: string; favorite: boolean }[]>`select id, network, address, label, note, favorite from address_book
    where label ilike ${like} or note ilike ${like} ${long ? sql`or address ilike ${like}` : sql``} order by favorite desc, lower(label), id limit ${limit + 1}`;
  const contacts = contactRows.slice(0, limit).map((c) => ({ type: 'contact' as const, ...c, matched: has(c.label, lq) ? 'label' : has(c.address, lq) ? 'address' : 'note' }));

  const pc: Frag[] = [sql`p.note ilike ${like}`], dc: Frag[] = [];
  if (long) { pc.push(sql`p.to_addr ilike ${like}`, sql`p.txid ilike any(${prefixes})`); dc.push(sql`d.from_addr ilike ${like}`, sql`d.txid ilike any(${prefixes})`); }
  if (amounts.length) { pc.push(sql`p.amount::text = any(${amounts})`); dc.push(sql`d.amount::text = any(${amounts})`); }
  const [props, deps] = await Promise.all([
    sql<{ id: string; state: ProposalState; kind: string | null; network: string; asset: string; symbol: string; decimals: number; amount: string; to_addr: string; note: string; txid: string | null; created_at: Date; relay_attempted_at: Date | null; error_code: string | null }[]>`
      select p.id, p.state, p.kind, p.network, p.asset, p.symbol, p.decimals, p.amount::text as amount, p.to_addr, p.note, p.txid, p.created_at, p.relay_attempted_at, p.error_code
      from proposals p where p.state <> 'draft' and (${anyOf(pc)}) order by p.created_at desc, p.id limit ${limit + 1}`,
    dc.length ? sql<{ network: string; txid: string; idx: number; asset: string; amount: string; from_addr: string; at: Date; finalized: boolean }[]>`
      select d.network, d.txid, d.idx, d.asset, d.amount::text as amount, d.from_addr, coalesce(d.block_time, d.seen_at) as at, (d.block <= coalesce(c.finalized, 0)) as finalized
      from deposits d left join scan_cursor c on c.network = d.network where (${anyOf(dc)}) order by coalesce(d.block_time, d.seen_at) desc, d.txid limit ${limit + 1}` : Promise.resolve([]),
  ]);
  const idHit = (txid: string | null): boolean => long && !!txid && (txid.toLowerCase().startsWith(lq) || txid.toLowerCase().startsWith(`0x${lq}`));
  const tx = [
    ...props.map((p) => {
      const matched = idHit(p.txid) ? 'txid' : long && has(p.to_addr, lq) ? 'address' : amountIs(q, p.amount, p.decimals) ? 'amount' : has(p.note, lq) ? 'note' : null;
      return matched === null ? null : { type: 'proposal' as const, id: p.id, kind: rowKind(p.kind), network: p.network, networkName: getNetwork(p.network).name, asset: p.asset, symbol: p.symbol, amount: p.amount, amountDisplay: formatUnits(BigInt(p.amount), p.decimals),
        counterparty: p.to_addr, contactLabel: label(p.network, p.to_addr), txid: p.txid, at: p.created_at.toISOString(), lifecycle: lifecycleOf(p.state, { relayAttempted: !!p.relay_attempted_at, errorCode: p.error_code }) as string | null, state: legacyState(p.state) as string, matched };
    }),
    ...deps.map((d) => {
      const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset);
      if (!a) return null;
      const matched = idHit(d.txid) ? 'txid' : long && has(d.from_addr, lq) ? 'address' : amountIs(q, d.amount, a.decimals) ? 'amount' : null;
      return matched === null ? null : { type: 'deposit' as const, id: `${d.network}:${d.txid}:${d.idx}`, kind: 'receive', network: d.network, networkName: n.name, asset: d.asset, symbol: a.symbol, amount: d.amount, amountDisplay: formatUnits(BigInt(d.amount), a.decimals),
        counterparty: d.from_addr, contactLabel: label(d.network, d.from_addr), txid: d.txid, at: new Date(d.at).toISOString(), lifecycle: null as string | null, state: d.finalized ? 'finalized' : 'confirming', matched };
    }),
  ].filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));

  return { q, limit, assets: searchAssets(lq, limit), contacts: { items: contacts, truncated: contactRows.length > limit },
    transactions: { items: tx.slice(0, limit), truncated: tx.length > limit || props.length > limit || deps.length > limit } };
}

export function searchRoutes(app: FastifyInstance): void {
  app.get('/api/v1/search', async (req) => {
    const q = z.object({ q: z.string().trim().min(SEARCH_MIN).max(SEARCH_MAX).regex(NO_CONTROL), limit: z.coerce.number().int().min(1).max(25).default(8) }).parse(req.query);
    return search(q.q, q.limit);
  });
}
