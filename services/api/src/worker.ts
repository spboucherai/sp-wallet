import { NETWORKS, isTerminal, type NetworkDef } from '@spw/core';
import { adapterFor, type Health } from './chains/index.ts';

const NETS = Object.values(NETWORKS) as NetworkDef[];
import { config } from './config.ts';
import { audit, sql, walletEvent } from './db.ts';
import { signer } from './signer-client.ts';
import { advanceSwap, recordSwapOutcome } from './swap-exec.ts';
import { advanceBridgeBurn, advanceBridges } from './bridge.ts';
import { broadcastNow, failure, knownToNetwork, move, proposalHooks, trackedIntent, type ProposalRow } from './transfers.ts';
import { advanceXswapSend, advanceXswaps, xswapMayBroadcast, xswapSent } from './xswap.ts';
import { advancePlans } from './plan-exec.ts'; // v7 any-to-any plans
import { pruneSwapQuotes } from './swap.ts'; // v11
import { pruneEvents } from './events.ts';
import { advanceWithdrawals } from './agents/withdrawals.ts'; // v8
import { scanDepositsPass } from './deposit-scan.ts'; // NEXT: deposits (native coins on EVM, backlog, classification)
import { SNAPSHOT_EVERY_MS, snapshotTick } from './portfolio.ts'; // NEXT: value of the wallet over time

export const healthCache = new Map<string, Health>();
const log = (m: string) => console.log(`[worker] ${m}`);

async function expireStale(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where state in ('draft','pending_approval') and expires_at < now()`;
  for (const p of rows) await move(p, 'expired', failure('expired_before_approval')).catch(() => {});
  // an "approved" row older than a minute means the process died mid-sign: the signer's replay cache makes a retry impossible, so fail it
  const stuck = await sql<ProposalRow[]>`select * from proposals where state = 'approved' and updated_at < now() - interval '1 minute'`;
  for (const p of stuck) await move(p, 'failed', failure('interrupted_signing')).catch(() => {});
}

// ── NEXT: transfer life cycle v2 ────────────────────────────────────────────────────────────────────────────────────────
// The rules this loop follows (docs/next/SP-WALLET-ARCHITECTURE.md, "Transfer life cycle"):
//  1. Once a relay has STARTED (`relay_attempted_at`), only the chain can say that nothing was sent. A time-out is not a failure.
//  2. A negative verdict (replaced, expired) is applied only after every source repeated it: NEG_PASSES consecutive passes
//     spread over at least NEG_HOLD_MS.
//  3. A transaction no source knows any more, whose validity cannot be proven over (EVM: nonce unused; Bitcoin-style: coins
//     unspent), becomes `dropped` after DROP_AFTER_MS: it frees the network, stays watched, and a new send conflicts with it.
//  4. `dropped` and (for a day) `replaced` rows keep being looked up: if the transaction is in a block after all, the row says so.
export const NEG_PASSES = 3, NEG_HOLD_MS = 60_000, LATE_MS = 10 * 60_000, RECHECK_REPLACED_MS = 24 * 3600_000;
/** How long every source must have said "unknown" before a pending transfer is called dropped, by family (others: never — their validity window ends by itself). */
export const DROP_AFTER_MS: Record<string, number> = { evm: 30 * 60_000, btc: 6 * 3600_000 };
const familyOf = (network: string) => (NETWORKS[network] as NetworkDef).family;
const sideKind = (p: ProposalRow) => p.kind === 'swap' || p.kind === 'bridge' || p.kind === 'xswap' || p.kind === 'gmx';
/** A relay that reached the network: the row says so, with the kind's own bookkeeping. */
const adopt = async (p: ProposalRow): Promise<ProposalRow> =>
  xswapSent(await move(p, 'broadcast', { broadcast_at: p.relay_attempted_at ?? new Date(), last_broadcast_at: new Date(), error: null }));
/**
 * One step for a `signed` row inside its window. Swaps, bridges and native swaps simulate before they relay and fail the row
 * when the simulation refuses or the window closes — true statements only while NO relay has started. Once one has
 * (`relay_attempted_at`), their transaction may be in a block: the chain is asked first, and their "nothing was sent"
 * failures no longer apply (the simulation of a swap that is already mined reverts). Then only the relay is retried.
 */
async function advanceSigned(p: ProposalRow): Promise<ProposalRow> {
  if (sideKind(p) && p.kind !== 'gmx' && p.relay_attempted_at && p.txid && p.intent && config.broadcast) {
    const known = await knownToNetwork(p).catch(() => null);
    if (known === null) return p; // no source answered: nothing is decided without the chain
    if (known) return adopt(p);
    if (p.kind === 'xswap' && !xswapMayBroadcast(p)) return p; // a vault payment is never relayed late in its window; the late rule settles it
    return xswapSent(await broadcastNow(p));
  }
  return p.kind === 'swap' ? advanceSwap(p) : p.kind === 'bridge' ? advanceBridgeBurn(p) : p.kind === 'xswap' ? advanceXswapSend(p)
    : p.kind === 'gmx' ? (await import('./derivatives/gmx-live.ts')).gmx().advanceSend(p) /* v8: approval mined first, then the order transaction, simulated */ : broadcastNow(p);
}

/** A `signed` row whose approval window is long gone. Returns the row to keep tracking in this pass, or null. */
async function settleLateSigned(p: ProposalRow): Promise<ProposalRow | null> {
  // no relay ever started for this transaction: nothing left this server — the one case where "nothing was sent" is a fact
  if (!config.broadcast || !p.relay_attempted_at || !p.txid || !p.intent) { await move(p, 'failed', failure('not_broadcast_in_time')); return null; }
  const a = adapterFor(p.network);
  const t = await a.track({ txid: p.txid, intent: trackedIntent(p), blockRef: null, broadcastAt: p.relay_attempted_at.getTime() / 1000 });
  const placed = t.seen === true || t.state === 'confirming' || t.state === 'finalized' || (t.state === 'failed' && !!t.blockRef);
  if (placed) { // the network has it: an earlier relay was accepted and its answer lost
    return adopt(p);
  }
  // a negative verdict from every source (validity window closed, nonce used by another transaction): the tracker applies it,
  // with its repetition rule, from the `broadcast` state
  if (t.state === 'failed' || t.state === 'replaced') return adopt(p);
  // nobody knows it and nothing proves it dead
  if (t.seen === false && DROP_AFTER_MS[familyOf(p.network)] !== undefined) { await move(p, 'dropped', failure('relay_unconfirmed')); return null; }
  return null; // a source did not answer, or the family has a validity window that will close: ask again next pass
}

/** Bitcoin-style: a dropped transaction one of whose coins is gone from the confirmed, agreed coin set can no longer be included. */
async function coinsSpentElsewhere(p: ProposalRow): Promise<boolean> {
  const a = adapterFor(p.network), inputs = p.intent?.btc?.inputs;
  if (!a.utxos || !inputs?.length) return false;
  const have = new Set((await a.utxos(p.from_addr)).map((u) => `${u.txid}:${u.vout}`));
  return inputs.some((i) => !have.has(`${i.txid}:${i.vout}`));
}

async function reconcile(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where state in ('signed', 'broadcast', 'confirming', 'reorged', 'dropped')
    or (state = 'replaced' and updated_at > now() - ${RECHECK_REPLACED_MS / 1000} * interval '1 second')`;
  for (let p of rows) {
    try {
      if (p.state === 'signed') {
        if (p.expires_at && Date.now() - p.expires_at.getTime() > LATE_MS) { // never relay a transaction whose approval window is long gone
          const q = await settleLateSigned(p);
          if (!q) continue;
          p = q;
        } else {
          p = await advanceSigned(p);
          if (p.state !== 'broadcast') continue;
        }
      }
      if (!config.broadcast || !p.txid || !p.intent) continue;
      const a = adapterFor(p.network), family = familyOf(p.network), watched = p.state === 'dropped' || p.state === 'replaced';
      let t = await a.track({ txid: p.txid, intent: trackedIntent(p), blockRef: p.block_ref, broadcastAt: (p.broadcast_at?.getTime() ?? p.relay_attempted_at?.getTime() ?? Date.now()) / 1000 });
      // a watched row only moves when the transaction is IN A BLOCK (or, dropped, provably dead); a mempool sighting changes nothing
      if (watched && (t.state === 'broadcast' || t.state === 'reorged')) {
        if (p.state === 'dropped' && family === 'btc' && t.seen === false && await coinsSpentElsewhere(p).catch(() => false)) t = { state: 'replaced', confirmations: 0, seen: false, error: 'its coins were spent by another transaction' };
        else { if (p.neg_streak) await sql`update proposals set neg_verdict = null, neg_since = null, neg_streak = 0 where id = ${p.id}`; continue; }
      }
      if (p.state === 'replaced' && t.state !== 'confirming' && t.state !== 'finalized') continue;
      // an adapter that only says "pending" about a transaction that was in a block: it left that block
      if (p.state === 'confirming' && t.state === 'broadcast') t = { ...t, state: 'reorged' };
      if (!watched && t.rebroadcast && p.raw && Date.now() - (p.last_broadcast_at?.getTime() ?? 0) > 45_000 && (p.kind !== 'xswap' || xswapMayBroadcast(p))) { // a vault payment is never relayed again late in its window
        await a.broadcast(p.raw).catch(() => {});
        await sql`update proposals set last_broadcast_at = now() where id = ${p.id}`;
      }
      // rule 2: a negative verdict waits until it was repeated
      const negative = t.state === 'replaced' || (t.state === 'failed' && !t.blockRef);
      if (negative) {
        const key = t.expired ? 'expired' : t.state, same = p.neg_verdict === key && p.neg_since;
        const streak = same ? (p.neg_streak ?? 0) + 1 : 1, since = same ? p.neg_since! : new Date();
        if (streak < NEG_PASSES || Date.now() - since.getTime() < NEG_HOLD_MS) { await sql`update proposals set neg_verdict = ${key}, neg_since = ${since}, neg_streak = ${streak} where id = ${p.id}`; continue; }
      } else if (p.neg_streak) { await sql`update proposals set neg_verdict = null, neg_since = null, neg_streak = 0 where id = ${p.id}`; p = { ...p, neg_streak: 0 }; }
      // rule 3: unknown to every source for long enough → dropped
      if ((p.state === 'broadcast' || p.state === 'reorged') && (t.state === 'broadcast' || t.state === 'reorged')) {
        const after = DROP_AFTER_MS[family];
        if (t.seen === false && after !== undefined) {
          if (!p.unseen_since) await sql`update proposals set unseen_since = now() where id = ${p.id}`;
          else if (Date.now() - p.unseen_since.getTime() > after) { await move(p, 'dropped', { ...failure('dropped'), confirmations: 0 }); continue; }
        } else if (t.seen === true && p.unseen_since) await sql`update proposals set unseen_since = null where id = ${p.id}`;
      }
      if (t.state !== p.state) {
        const why = !t.error ? { error: null } : t.expired ? failure('expired_onchain', {}, t.error) : t.state === 'replaced' ? failure('replaced_onchain', {}, t.error) : failure('tx_failed', { detail: t.error.slice(0, 200) }, t.error);
        const patch: Record<string, unknown> = { confirmations: t.confirmations, block_ref: t.blockRef ?? null, neg_verdict: null, neg_since: null, neg_streak: 0, unseen_since: null, ...why };
        if (t.state === 'finalized') patch.finalized_at = new Date();
        // the fee the network charged; Bitcoin-style: the fee is fixed by the transaction itself (inputs − outputs)
        const paid = t.feePaid ?? (t.state === 'finalized' && family === 'btc' && p.intent?.btc ? BigInt(p.intent.btc.fee) : undefined);
        if (paid !== undefined) patch.fee_paid = paid.toString();
        const moved = await move(p, t.state, patch);
        if (t.state === 'finalized' || t.state === 'confirming') await recordSwapOutcome(moved).catch(() => {});
        for (const h of proposalHooks.tracked) await h(moved).catch(() => {}); // NFT delivery 2: activity + inventory of an NFT transfer (never signs)
      } else if (t.confirmations !== p.confirmations || (t.feePaid !== undefined && !p.fee_paid)) {
        await sql`update proposals set confirmations = ${t.confirmations}, block_ref = ${t.blockRef ?? p.block_ref}, fee_paid = ${t.feePaid !== undefined ? t.feePaid.toString() : p.fee_paid ?? null} where id = ${p.id}`;
        if (t.confirmations !== p.confirmations) await walletEvent('transfer.confirmations', p.id, { network: p.network, confirmations: t.confirmations, txid: p.txid });
      }
    } catch (e) { log(`reconcile ${p.id}: ${(e as Error).message}`); }
  }
}

async function scanDeposits(): Promise<void> {
  const st = await signer.status().catch(() => null);
  if (!st) return;
  await scanDepositsPass(st.addresses); // NEXT: deposit-scan.ts
}

async function refreshHealth(): Promise<void> {
  await Promise.all(NETS.map(async (n) => {
    try { healthCache.set(n.id, await adapterFor(n.id).health()); }
    catch { healthCache.set(n.id, { network: n.id, ok: false, readable: false, identityVerified: false, height: null, endpoints: [], checkedAt: new Date().toISOString() }); }
  }));
}

// v6-alerts: heartbeat of every worker loop (read by the monitoring dashboard and the "worker failing" alert) — additive
import { loopStats, type LoopStat } from './loop-stats.ts'; // v8: the map lives in its own module (the agent engines report there too)
export { loopStats, type LoopStat };

export function loop(name: string, fn: () => Promise<void>, everyMs: number): void {
  let running = false;
  const st: LoopStat = { name, everyMs, runs: 0, lastStartAt: null, lastOkAt: null, lastErrorAt: null, lastError: null, failures: 0 };
  loopStats.set(name, st);
  const tick = async () => { if (running) return; running = true; st.lastStartAt = Date.now(); st.runs += 1;
    try { await fn(); st.lastOkAt = Date.now(); st.failures = 0; }
    catch (e) { log(`${name}: ${(e as Error).message}`); st.lastErrorAt = Date.now(); st.lastError = (e as Error).message.slice(0, 200); st.failures += 1; }
    finally { running = false; } };
  void tick();
  setInterval(tick, everyMs).unref();
}

export function startWorkers(): void {
  loop('health', refreshHealth, 45_000);
  loop('expire', expireStale, 15_000);
  loop('reconcile', reconcile, 8_000);
  loop('bridges', advanceBridges, 5_000);
  loop('xswaps', advanceXswaps, 10_000);
  loop('plans', advancePlans, 6_000); // v7: reads the proposals of open plans and moves the plans; never signs
  loop('deposits', scanDeposits, 75_000);
  loop('portfolio-snapshots', snapshotTick, SNAPSHOT_EVERY_MS); // NEXT: one value point per currency every 10 min; reads only
  loop('swap-quotes-prune', async () => { await pruneSwapQuotes(); }, 6 * 3600_000); // v11: retention of the quote log (swap.ts)
  loop('events-prune', async () => { await pruneEvents(); }, 6 * 3600_000); // NEXT: retention of the wallet event log (events.ts)
  loop('withdrawals', () => advanceWithdrawals(), 8_000); // v8: agent-vault withdrawals — receipt and arrival at the owner's address; never signs
}
export { refreshHealth, reconcile, expireStale, isTerminal, advanceBridges, scanDeposits };
