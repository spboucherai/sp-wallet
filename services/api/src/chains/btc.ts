import { BTC_DUST, estimateBtcVsize, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }
interface EsTx { txid: string; vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[]; vout: { scriptpubkey_address?: string; value: number }[]; status: { confirmed: boolean; block_height?: number; block_time?: number } }

export function btcAdapter(n: NetworkDef): Adapter {
  async function get<T>(path: string, text = false): Promise<T> {
    let last: unknown;
    for (const u of n.rpc) {
      try { const r = await http(u + path); if (!r.ok) throw Object.assign(new Error(`esplora ${r.status}`), { status: r.status }); return (text ? await r.text() : await r.json()) as T; }
      catch (e) { last = e; }
    }
    throw last;
  }
  async function getAll<T>(path: string, text = false): Promise<T[]> {
    return Promise.all(n.rpc.map(async (u) => { const r = await http(u + path); if (!r.ok) throw new UserError('rpc_degraded', 'Bitcoin data source unavailable; transfer refused', 503); return (text ? await r.text() : await r.json()) as T; }))
      .catch((e) => { throw e instanceof UserError ? e : new UserError('rpc_degraded', 'Bitcoin data source unavailable; transfer refused', 503); });
  }
  let identity = false;
  const tip = async () => Number(await get<string>('/blocks/tip/height', true));
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(n.rpc.map(async (url) => {
        const t = Date.now();
        try {
          const r = await http(url + '/blocks/tip/height'); if (!r.ok) throw new Error();
          const h = Number(await r.text());
          if (!identity) { const g = await http(url + '/block-height/0'); if ((await g.text()).trim() !== n.chainRef) throw new Error('genesis'); }
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    async balances(addr) {
      const a = await get<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(`/address/${addr}`);
      // confirmed balance, minus anything already being spent in the mempool (never count unconfirmed incoming)
      return { native: BigInt(a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum - a.mempool_stats.spent_txo_sum) };
    },
    async prepare(d): Promise<Prepared> {
      if (!identity) throw new UserError('rpc_degraded', 'chain identity not verified yet; retry shortly', 503);
      // UTXO set must be identical on both independent indexers
      const sets = await getAll<Utxo[]>(`/address/${d.from}/utxo`);
      const norm = (s: Utxo[]) => s.filter((u) => u.status.confirmed).map((u) => `${u.txid}:${u.vout}:${u.value}`).sort();
      const a = norm(sets[0]!);
      for (const s of sets) if (JSON.stringify(norm(s)) !== JSON.stringify(a)) throw new UserError('rpc_disagreement', 'Bitcoin data sources disagree on spendable coins; transfer refused', 503);
      const utxos = sets[0]!.filter((u) => u.status.confirmed).sort((x, y) => y.value - x.value);
      const fees = await get<Record<string, number>>('/fee-estimates');
      const rate = Math.min(200, Math.max(1.1, (fees['3'] ?? fees['6'] ?? 5) * 1.1)); // sat/vB, target ≈ 3 blocks
      const chosen: Utxo[] = []; let total = 0n;
      for (const u of utxos) {
        chosen.push(u); total += BigInt(u.value);
        const feeWithChange = BigInt(Math.ceil(estimateBtcVsize(chosen.length, d.to, true) * rate));
        const feeNoChange = BigInt(Math.ceil(estimateBtcVsize(chosen.length, d.to, false) * rate));
        if (total >= d.amount + feeNoChange) {
          let change = total - d.amount - feeWithChange, fee = feeWithChange;
          if (change < BTC_DUST) { change = 0n; fee = total - d.amount; } // dust change is added to the fee
          if (fee > feeNoChange * 3n + 1000n) continue; // keep adding inputs rather than overpay
          return { section: { btc: { inputs: chosen.map((c) => ({ txid: c.txid, vout: c.vout, value: String(c.value) })), change: change.toString(), fee: fee.toString() } },
            maxFee: fee, feeEstimate: fee, warnings: [], ttlSec: 240 };
        }
        if (chosen.length >= 20) break;
      }
      throw new UserError('insufficient_funds', 'insufficient confirmed BTC for amount plus network fee');
    },
    async broadcast(raw) {
      const rs = await Promise.allSettled(n.rpc.map(async (u) => { const r = await http(u + '/tx', { method: 'POST', body: raw }); if (!r.ok) throw new Error((await r.text()).slice(0, 200)); }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      const msg = String((rs[0] as PromiseRejectedResult).reason?.message);
      if (/already|known|in block chain/i.test(msg)) return;
      throw new Error(msg);
    },
    async track(p): Promise<Tracked> {
      let st: { confirmed: boolean; block_height?: number; block_hash?: string };
      try { st = await get(`/tx/${p.txid}/status`); }
      catch (e) { if ((e as { status?: number }).status === 404) return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true }; throw e; }
      if (!st.confirmed) return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0 };
      const conf = (await tip()) - st.block_height! + 1;
      return { state: conf >= n.minConf ? 'finalized' : 'confirming', confirmations: conf, blockRef: st.block_hash };
    },
    async deposits(addr) {
      const txs = await get<EsTx[]>(`/address/${addr}/txs`);
      const h = await tip();
      const items: Deposit[] = [];
      for (const t of txs) {
        if (!t.status.confirmed) continue;
        const spentByUs = t.vin.some((v) => v.prevout?.scriptpubkey_address === addr);
        if (spentByUs) continue; // our own send (change output), not a deposit
        t.vout.forEach((o, idx) => { if (o.scriptpubkey_address === addr) items.push({ txid: t.txid, idx, asset: 'native', amount: BigInt(o.value), from: t.vin[0]?.prevout?.scriptpubkey_address ?? '', block: t.status.block_height!, time: t.status.block_time ?? null }); });
      }
      return { items, cursor: h, finalizedHeight: h - n.minConf + 1 };
    },
  };
}
