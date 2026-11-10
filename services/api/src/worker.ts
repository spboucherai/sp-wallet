import { NETWORKS, isTerminal, type NetworkId } from '@spw/core';
import { adapters, type Health } from './chains/index.ts';
import { config } from './config.ts';
import { audit, sql } from './db.ts';
import { signer } from './signer-client.ts';
import { broadcastNow, move, type ProposalRow } from './transfers.ts';

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
        p = await broadcastNow(p);
        if (p.state === 'signed') continue;
      }
      if (!config.broadcast || !p.txid || !p.intent) continue;
      const a = adapters[p.network as NetworkId];
      const t = await a.track({ txid: p.txid, intent: p.intent, blockRef: p.block_ref, broadcastAt: (p.broadcast_at?.getTime() ?? Date.now()) / 1000 });
      if (t.rebroadcast && p.raw && Date.now() - (p.last_broadcast_at?.getTime() ?? 0) > 45_000) {
        await a.broadcast(p.raw).catch(() => {});
        await sql`update proposals set last_broadcast_at = now() where id = ${p.id}`;
      }
      if (t.state !== p.state) {
        const patch: Record<string, unknown> = { confirmations: t.confirmations, block_ref: t.blockRef ?? null, error: t.error ?? null };
        if (t.state === 'finalized') patch.finalized_at = new Date();
        await move(p, t.state, patch);
      } else if (t.confirmations !== p.confirmations) await sql`update proposals set confirmations = ${t.confirmations}, block_ref = ${t.blockRef ?? p.block_ref} where id = ${p.id}`;
    } catch (e) { log(`reconcile ${p.id}: ${(e as Error).message}`); }
  }
}

async function scanDeposits(): Promise<void> {
  const st = await signer.status().catch(() => null);
  if (!st) return;
  for (const n of Object.values(NETWORKS)) {
    try {
      const [c] = await sql<{ cursor: string }[]>`select cursor from scan_cursor where network = ${n.id}`;
      const r = await adapters[n.id].deposits(st.addresses[n.family], c ? Number(c.cursor) : null);
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
  await Promise.all(Object.values(NETWORKS).map(async (n) => {
    try { healthCache.set(n.id, await adapters[n.id].health()); }
    catch { healthCache.set(n.id, { network: n.id, ok: false, identityVerified: false, height: null, endpoints: [], checkedAt: new Date().toISOString() }); }
  }));
}

function loop(name: string, fn: () => Promise<void>, everyMs: number): void {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await fn(); } catch (e) { log(`${name}: ${(e as Error).message}`); } finally { running = false; } };
  void tick();
  setInterval(tick, everyMs).unref();
}

export function startWorkers(): void {
  loop('health', refreshHealth, 60_000);
  loop('expire', expireStale, 15_000);
  loop('reconcile', reconcile, 8_000);
  loop('deposits', scanDeposits, 75_000);
}
export { refreshHealth, reconcile, expireStale, isTerminal };
