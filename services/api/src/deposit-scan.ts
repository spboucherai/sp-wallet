// NEXT H1 / H2 / H3 / H5 — one pass of the deposit worker (called by worker.ts every 75 s). Reads only; never signs.
//
// Per network: the adapter's ordinary scan (token logs, indexer history, Solana transactions) from the stored cursor, then —
// on EVM networks — the native-coin scan (chains/evm.ts `nativeDeposits`) from its own stored state. Each new row is
// classified BEFORE its event is written to the audit chain: `deposit.seen` carries `kind`, and the alert rule does not
// announce an `internal` one (the result of the wallet's own swap, bridge, cross-chain swap or withdrawal).
// Then the flows of the wallet are recorded with the price of this moment (portfolio.ts).
import { NETWORKS, type NetworkDef } from '@spw/core';
import { adapterFor } from './chains/index.ts';
import type { Deposit, NativeScanState } from './chains/rpc.ts';
import { audit, classifyDeposits, sql } from './db.ts';
import { portfolioDeps, recordFlows } from './portfolio.ts';

const NETS = Object.values(NETWORKS) as NetworkDef[];
const log = (m: string) => console.log(`[worker] ${m}`);

/** Insert the rows that are new; classify them; write their audit events. Returns the number of new rows. */
export async function recordDeposits(network: string, items: Deposit[]): Promise<number> {
  const fresh: Deposit[] = [];
  for (const d of items) {
    const ins = await sql`insert into deposits (network, txid, idx, asset, amount, from_addr, block, block_time, detection, block_hash)
      values (${network}, ${d.txid}, ${d.idx}, ${d.asset}, ${d.amount.toString()}, ${d.from}, ${d.block}, ${d.time ? new Date(d.time * 1000) : null}, ${d.via ?? null}, ${d.blockHash ?? null})
      on conflict do nothing returning txid`;
    if (ins.length) fresh.push(d);
  }
  if (!fresh.length) return 0;
  await classifyDeposits();
  for (const d of fresh) {
    const [r] = await sql<{ kind: string; origin: string | null; proposal_id: string | null }[]>`select kind, origin, proposal_id from deposits where network = ${network} and txid = ${d.txid} and idx = ${d.idx} and asset = ${d.asset}`;
    await audit('deposit.seen', 'chain', { network, txid: d.txid, asset: d.asset, amount: d.amount.toString(), kind: r?.kind ?? 'external',
      ...(r?.origin ? { origin: r.origin } : {}), ...(r?.proposal_id ? { proposal: r.proposal_id } : {}), ...(d.via ? { detection: d.via } : {}) });
  }
  return fresh.length;
}

/** The wallet's own transactions on a network that the API knows (hints for the native scan; it finds the others by itself). */
async function ownTxids(network: string): Promise<string[]> {
  const rows = await sql<{ txid: string | null; pre_txid: string | null; mint: string | null }[]>`
    select txid, pre_txid, null as mint from proposals where network = ${network} and txid is not null and coalesce(broadcast_at, created_at) > now() - interval '14 days'
    union all select null, null, bridge->>'mintTxid' from proposals where kind = 'bridge' and bridge->>'toNetwork' = ${network} and bridge->>'mintedBy' = 'wallet' and created_at > now() - interval '14 days'
    limit 60`;
  return rows.flatMap((r) => [r.txid, r.pre_txid, r.mint]).filter((x): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x));
}

async function scanNative(n: NetworkDef, address: string): Promise<void> {
  const a = adapterFor(n.id);
  if (!a.nativeDeposits) return;
  const [c] = await sql<{ native_cursor: string | null; native_balance: string | null; native_nonce: string | null; native_addr: string | null }[]>`select native_cursor, native_balance, native_nonce, native_addr from scan_cursor where network = ${n.id}`;
  if (!c) return; // the ordinary scan creates the row; the native scan starts on the pass after
  // a baseline taken for another address means nothing for this one
  const prev: NativeScanState | null = c.native_cursor !== null && c.native_balance !== null && c.native_nonce !== null && c.native_addr === address.toLowerCase()
    ? { block: Number(c.native_cursor), balance: BigInt(c.native_balance), nonce: Number(c.native_nonce) } : null;
  const r = await a.nativeDeposits(address, prev, { own: await ownTxids(n.id) });
  await recordDeposits(n.id, r.items);
  for (const note of r.notes) {
    if (note.code === 'budget_exhausted') { log(`native ${n.id}: scan bound reached at block ${note.fromBlock}, continuing on the next pass`); continue; }
    await audit('deposit.native_window', 'chain', { network: n.id, ...note });
  }
  await sql`update scan_cursor set native_cursor = ${r.state.block}, native_balance = ${r.state.balance.toString()}, native_nonce = ${r.state.nonce}, native_addr = ${address.toLowerCase()} where network = ${n.id}`;
}

/** networks scanned at once: each one talks to its own endpoints; the pass is as long as its slowest fifth, not their sum */
export const SCAN_CONCURRENCY = 5;
async function scanOne(n: NetworkDef, address: string): Promise<void> {
  try {
    const [c] = await sql<{ cursor: string }[]>`select cursor from scan_cursor where network = ${n.id}`;
    const r = await adapterFor(n.id).deposits(address, c ? Number(c.cursor) : null);
    await recordDeposits(n.id, r.items);
    for (const g of r.gaps ?? []) await audit('deposit.scan_gap', 'chain', { network: n.id, txid: g.txid, block: g.block, reason: 'transaction no longer served by any source' });
    await sql`insert into scan_cursor (network, cursor, finalized) values (${n.id}, ${r.cursor}, ${Math.min(r.finalizedHeight, Number.MAX_SAFE_INTEGER)})
      on conflict (network) do update set cursor = excluded.cursor, finalized = excluded.finalized`;
  } catch (e) { log(`deposits ${n.id}: ${(e as Error).message.slice(0, 120)}`); }
  try { await scanNative(n, address); } catch (e) { log(`native deposits ${n.id}: ${(e as Error).message.slice(0, 120)}`); }
}
export async function scanDepositsPass(addresses: Record<string, string>): Promise<void> {
  const todo = NETS.filter((n) => addresses[n.id]);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, todo.length) }, async () => {
    for (;;) { const n = todo[next++]; if (!n) return; await scanOne(n, addresses[n.id]!); }
  }));
  // an operation can record its own transaction id after the deposit was seen: look again at the recent external rows
  await classifyDeposits(true).catch((e) => log(`classify: ${(e as Error).message.slice(0, 120)}`));
  try { await recordFlows(portfolioDeps.prices ? await portfolioDeps.prices().catch(() => null) : null); } catch (e) { log(`flows: ${(e as Error).message.slice(0, 120)}`); }
}
