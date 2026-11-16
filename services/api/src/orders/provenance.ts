// Position provenance (V11 exec2): whose is the position on a venue account?
//
// A venue keeps ONE net position per account and instrument. It does not know who opened it: the owner by hand, an API key, an
// agent. Without a ledger of its own, "close the position" asked by a key would close whatever is there — the owner's included.
// This module derives, from the fills the wallet stored (`deriv_fills`) and the unified orders they belong to, the part of a
// position that is attributable to each principal (its LOT), and the order service bounds what a key or an agent may reduce to
// its own lot (service.ts `place`, `reducePosition`).
//
// Rules of the ledger (`replay`, pure):
//  - a fill that adds to the position (or opens it) adds to the lot of the principal whose order it filled;
//  - a fill that reduces the position consumes the lot of the principal who placed it first; what exceeds that lot — which the
//    order service refuses for a key or an agent, so in practice only the owner — is taken from the other lots, largest first;
//  - a fill of no known order (placed in the venue's own interface, a liquidation) is the owner's: the venue account is the
//    owner's own address, and nobody else can act there outside this wallet;
//  - a fill larger than the whole position flips it: the remainder opens a lot for the principal who placed it.
// The lots are then clamped to the position the venue reports NOW (`attributable`): a lot never exceeds it and never points the
// other way. Whatever the ledger cannot explain is therefore the owner's, never a key's.
//
// Limits, stated: the ledger is as complete as the stored fills (a fill the venue has not published yet is not in it: a key that
// has just been filled may have to ask again a moment later); it is API-side bookkeeping, not a signer rule — the signer bounds
// a reduce-only order by instrument, notional and price only (docs/V11-RISK-MODEL.md, "Enforcement points").
import { D, type Dec, type DecStr } from '@spw/derivatives';
import { sql } from '../db.ts';

export const OWNER_KEY = 'owner:owner';
export const principalKey = (p: { kind: string; id: string }): string => (p.kind === 'owner' ? OWNER_KEY : `${p.kind}:${p.id}`);
export interface LedgerFill { side: 'buy' | 'sell'; size: DecStr; /** `kind:id` of the principal whose order was filled; null = no known order (the owner) */ principal: string | null }

const sign = (x: Dec): -1 | 0 | 1 => (D.isPos(x) ? 1 : D.isNeg(x) ? -1 : 0);
const total = (lots: Map<string, Dec>): Dec => [...lots.values()].reduce((a, x) => D.add(a, x), D.zero);

/** signed lots per principal after the fills, in the order given (oldest first). Every lot has the sign of the net position. */
export function replay(fills: readonly LedgerFill[]): Map<string, Dec> {
  const lots = new Map<string, Dec>();
  const add = (k: string, q: Dec): void => { const v = D.add(lots.get(k) ?? D.zero, q); if (D.isZero(v)) lots.delete(k); else lots.set(k, v); };
  for (const f of fills) {
    const who = f.principal ?? OWNER_KEY, size = D.from(f.size);
    if (!D.isPos(size)) continue;
    const q = f.side === 'buy' ? size : D.neg(size), net = total(lots), dir = sign(net);
    if (dir === 0 || dir === sign(q)) { add(who, q); continue; }
    // reducing: at most the whole position is consumed; the rest (a flip) opens a lot for `who`
    let left = D.min(size, D.abs(net));
    const flip = D.sub(size, left);
    const take = (k: string): void => {
      const lot = lots.get(k);
      if (!lot || !D.isPos(left)) return;
      const t = D.min(D.abs(lot), left);
      add(k, dir === 1 ? D.neg(t) : t); left = D.sub(left, t);
    };
    take(who);
    for (const k of [...lots.keys()].filter((x) => x !== who).sort((a, b) => { const c = D.cmp(D.abs(lots.get(b)!), D.abs(lots.get(a)!)); return c !== 0 ? c : a < b ? -1 : 1; })) take(k);
    if (D.isPos(flip)) add(who, f.side === 'buy' ? flip : D.neg(flip));
  }
  return lots;
}

/**
 * The part of the venue's position that is `who`'s, as an unsigned size: the lot, never more than the position the venue reports
 * and never on the other side. `position` is signed (long positive).
 */
export function attributable(lots: Map<string, Dec>, who: string, position: DecStr): DecStr {
  const pos = D.from(position), lot = lots.get(who) ?? D.zero;
  if (D.isZero(pos) || sign(lot) !== sign(pos)) return '0';
  // the lots of the others that point the same way are honoured first when the ledger holds more than the venue does
  const mine = D.abs(lot), all = [...lots.values()].filter((x) => sign(x) === sign(pos)).reduce((a, x) => D.add(a, D.abs(x)), D.zero);
  if (D.lte(all, D.abs(pos))) return D.str(mine);
  if (who === OWNER_KEY) return D.str(D.min(mine, D.abs(pos)));
  // the ledger explains more than exists (a reduction the wallet did not see): the excess is taken from the keys and agents first
  const others = D.sub(all, mine), room = D.sub(D.abs(pos), D.min(others, D.abs(pos)));
  return D.str(D.min(mine, D.max(room, D.zero)));
}

/**
 * The ORDER fills are replayed in. A venue's timestamp is a millisecond: two fills can carry the same one (an owner's close and
 * a key's open in the same instant), and the ledger's result depends on which comes first. The order is therefore total and
 * deterministic: the fill's time, then the sequence in which the wallet STORED it (`deriv_fills.seq`, the causal order on this
 * side), then the fill id. The same rows always replay to the same lots.
 */
export interface OrderedFill { ts: number; seq: number | string | bigint | null; fillId: string }
export function fillOrder(a: OrderedFill, b: OrderedFill): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const sa = a.seq === null ? null : BigInt(a.seq), sb = b.seq === null ? null : BigInt(b.seq);
  if (sa !== null && sb !== null && sa !== sb) return sa < sb ? -1 : 1;
  if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
  return a.fillId < b.fillId ? -1 : a.fillId > b.fillId ? 1 : 0;
}
/** the lots of one account and instrument, from the stored fills and the unified orders they belong to */
export async function lotsOf(accountId: string, instrument: string): Promise<Map<string, Dec>> {
  if (!/^[0-9a-f-]{36}$/.test(accountId)) return new Map();
  // a fill of a market-making session carries the session's client-id prefix: it is the AGENT's (quotes are not rows of `orders`)
  const rows = await sql<{ side: 'buy' | 'sell'; size: string; kind: string | null; pid: string | null; mm_agent: string | null; ts: Date; seq: string | null; fill_id: string }[]>`
    select f.side, f.size::text as size, o.principal_kind as kind, o.principal_id as pid, f.ts, f.seq::text as seq, f.fill_id,
      (select s.agent_id::text from mm_sessions s where s.mode = 'LIVE' and s.account_id = f.account_id and f.client_id is not null and f.client_id like '0x' || s.session_hex || '%' limit 1) as mm_agent
    from deriv_fills f
    left join deriv_orders e on e.account_id = f.account_id and f.client_id is not null and (e.client_id = f.client_id or e.cloid = f.client_id)
    left join orders o on o.engine in ('paper', 'hyperliquid') and o.engine_ref = f.account_id::text || ':' || e.client_id
    where f.account_id::text = ${accountId} and f.instrument = ${instrument}`;
  rows.sort((a, b) => fillOrder({ ts: a.ts.getTime(), seq: a.seq, fillId: a.fill_id }, { ts: b.ts.getTime(), seq: b.seq, fillId: b.fill_id }));
  return replay(rows.map((r) => ({ side: r.side, size: r.size, principal: r.kind && r.pid ? principalKey({ kind: r.kind, id: r.pid }) : r.mm_agent ? principalKey({ kind: 'agent', id: r.mm_agent }) : null })));
}

/** what `who` has already asked to reduce and that may still execute: the open reduce-only orders of that principal there */
/**
 * `ocoExcept`: the one-cancels-the-other group of the sibling orders of the order being judged (orders/attached.ts — a stop-loss
 * and a take-profit protect the SAME quantity, and only one of them can ever execute: the supervisor cancels the other). Orders
 * of that group are not added to what is already asked.
 */
export async function pendingReduce(who: { kind: string; id: string }, accountId: string, instrument: string, exceptOrderId: string | null, ocoExcept: string | null = null): Promise<DecStr> {
  const [r] = await sql<{ n: string }[]>`select coalesce(sum(greatest((record->>'size')::numeric - (record->>'filledSize')::numeric, 0)), 0)::text as n from orders
    where principal_kind = ${who.kind} and principal_id = ${who.id} and account_id = ${accountId} and instrument = ${instrument} and reduce_only
      and state not in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED') and record->>'size' is not null and id <> ${exceptOrderId ?? ''}
      and coalesce(detail->>'ocoGroup', '') <> ${ocoExcept ?? '-'} and (${ocoExcept === '*'} = false or detail->>'ocoGroup' is null)`;
  return D.str(D.from(r!.n));
}

export interface Provenance { /** signed position the venue reports */ position: DecStr; /** `who`'s part of it, unsigned */ own: DecStr; /** the part that is somebody else's (the owner's, another principal's), unsigned */ foreign: DecStr; /** `who`'s open reduce-only orders */ pending: DecStr; /** own − pending, never negative: what `who` may still ask to reduce */ reducible: DecStr }
export async function provenance(who: { kind: string; id: string }, accountId: string, instrument: string, position: DecStr, exceptOrderId: string | null = null, ocoExcept: string | null = null): Promise<Provenance> {
  const lots = await lotsOf(accountId, instrument), own = attributable(lots, principalKey(who), position), pending = await pendingReduce(who, accountId, instrument, exceptOrderId, ocoExcept);
  const foreign = D.max(D.sub(D.abs(D.from(position)), D.from(own)), D.zero);
  return { position: D.str(D.from(position)), own, foreign: D.str(foreign), pending, reducible: D.str(D.max(D.sub(D.from(own), D.from(pending)), D.zero)) };
}
