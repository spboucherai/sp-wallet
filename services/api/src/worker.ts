import { NETWORKS, isTerminal, type NetworkDef } from '@spw/core';
import { adapterFor, type Health } from './chains/index.ts';

const NETS = Object.values(NETWORKS) as NetworkDef[];
import { config } from './config.ts';
import { audit, sql } from './db.ts';
import { signer } from './signer-client.ts';
import { advanceSwap, recordSwapOutcome } from './swap-exec.ts';
import { advanceBridgeBurn, advanceBridges } from './bridge.ts';
import { broadcastNow, move, type ProposalRow } from './transfers.ts';
import { advanceXswapSend, advanceXswaps, xswapMayBroadcast } from './xswap.ts';

export const healthCache = new Map<string, Health>();
const log = (m: string) => console.log(`[worker] ${m}`);

async function expireStale(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where state in ('draft','pending_approval') and expires_at < now()`;
  for (const p of rows) await move(p, 'expired', { error: 'expired before approval' }).catch(() => {});
  // an "approved" row older than a minute means the process died mid-sign: the signer's replay cache makes a retry impossible, so fail it
  const stuck = await sql<ProposalRow[]>`select * from proposals where state = 'approved' and updated_at < now() - interval '1 minute'`;
  for (const p of stuck) await move(p, 'failed', { error: 'interrupted during signing; nothing was broadcast' }).catch(() => {});
}

async function reconcile(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where state in ('signed','broadcast','confirming','reorged')`;
  for (let p of rows) {
    try {
      if (p.state === 'signed') {
        // never relay a transaction whose approval window is long gone
        if (p.expires_at && Date.now() - p.expires_at.getTime() > 10 * 60_000) { await move(p, 'failed', { error: 'could not be broadcast in time; nothing was sent' }); continue; }
        p = p.kind === 'swap' ? await advanceSwap(p) : p.kind === 'bridge' ? await advanceBridgeBurn(p) : p.kind === 'xswap' ? await advanceXswapSend(p) : await broadcastNow(p);
        if (p.state !== 'broadcast') continue;
      }
      if (!config.broadcast || !p.txid || !p.intent) continue;
      const a = adapterFor(p.network);
      // a swap preceded by an approval uses the next nonce
      const tracked = (p.kind === 'swap' || p.kind === 'bridge' || p.kind === 'xswap') && p.pre_raw && p.intent.evm ? { ...p.intent, evm: { ...p.intent.evm, nonce: p.intent.evm.nonce + 1 } } : p.intent;
      const t = await a.track({ txid: p.txid, intent: tracked, blockRef: p.block_ref, broadcastAt: (p.broadcast_at?.getTime() ?? Date.now()) / 1000 });
      if (t.rebroadcast && p.raw && Date.now() - (p.last_broadcast_at?.getTime() ?? 0) > 45_000 && (p.kind !== 'xswap' || xswapMayBroadcast(p))) { // a vault payment is never relayed again late in its window
        await a.broadcast(p.raw).catch(() => {});
        await sql`update proposals set last_broadcast_at = now() where id = ${p.id}`;
      }
      if (t.state !== p.state) {
        const patch: Record<string, unknown> = { confirmations: t.confirmations, block_ref: t.blockRef ?? null, error: t.error ?? null };
        if (t.state === 'finalized') patch.finalized_at = new Date();
        const moved = await move(p, t.state, patch);
        if (t.state === 'finalized' || t.state === 'confirming') await recordSwapOutcome(moved).catch(() => {});
      } else if (t.confirmations !== p.confirmations) await sql`update proposals set confirmations = ${t.confirmations}, block_ref = ${t.blockRef ?? p.block_ref} where id = ${p.id}`;
    } catch (e) { log(`reconcile ${p.id}: ${(e as Error).message}`); }
  }
}

async function scanDeposits(): Promise<void> {
  const st = await signer.status().catch(() => null);
  if (!st) return;
  for (const n of NETS) {
    const address = st.addresses[n.id];
    if (!address) continue;
    try {
      const [c] = await sql<{ cursor: string }[]>`select cursor from scan_cursor where network = ${n.id}`;
      const r = await adapterFor(n.id).deposits(address, c ? Number(c.cursor) : null);
      for (const d of r.items) {
        const ins = await sql`insert into deposits (network, txid, idx, asset, amount, from_addr, block, block_time)
          values (${n.id}, ${d.txid}, ${d.idx}, ${d.asset}, ${d.amount.toString()}, ${d.from}, ${d.block}, ${d.time ? new Date(d.time * 1000) : null})
          on conflict do nothing returning txid`;
        if (ins.length) await audit('deposit.seen', 'chain', { network: n.id, txid: d.txid, asset: d.asset, amount: d.amount.toString() });
      }
      await sql`insert into scan_cursor (network, cursor, finalized) values (${n.id}, ${r.cursor}, ${Math.min(r.finalizedHeight, Number.MAX_SAFE_INTEGER)})
        on conflict (network) do update set cursor = excluded.cursor, finalized = excluded.finalized`;
    } catch (e) { log(`deposits ${n.id}: ${(e as Error).message.slice(0, 120)}`); }
  }
}

async function refreshHealth(): Promise<void> {
  await Promise.all(NETS.map(async (n) => {
    try { healthCache.set(n.id, await adapterFor(n.id).health()); }
    catch { healthCache.set(n.id, { network: n.id, ok: false, readable: false, identityVerified: false, height: null, endpoints: [], checkedAt: new Date().toISOString() }); }
  }));
}

// v6-alerts: heartbeat of every worker loop (read by the monitoring dashboard and the "worker failing" alert) — additive
export interface LoopStat { name: string; everyMs: number; runs: number; lastStartAt: number | null; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null; /** failed passes in a row */ failures: number }
export const loopStats = new Map<string, LoopStat>();

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
  loop('deposits', scanDeposits, 75_000);
}
export { refreshHealth, reconcile, expireStale, isTerminal, advanceBridges };
