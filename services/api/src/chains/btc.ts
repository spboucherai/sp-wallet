import { dustOf, estimateBtcVsize, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

interface Utxo { txid: string; vout: number; value: number; confirmed: boolean }
interface Status { found: boolean; confirmed: boolean; height?: number; hash?: string }
/** One indexer of a Bitcoin-style chain. Two independent ones are required for anything that feeds a signature. */
interface Source {
  url: string;
  tip(): Promise<number>;
  genesis(): Promise<string>;
  utxos(addr: string): Promise<Utxo[]>;
  /** confirmed balance minus what is already being spent in the mempool */
  balance(addr: string): Promise<bigint>;
  /** fee rate in base units per virtual byte, ~3 block target */
  feeRate(): Promise<number>;
  broadcast(hex: string): Promise<void>;
  status(txid: string): Promise<Status>;
  rawTx(txid: string): Promise<string>;
}
const j = async <T>(url: string, init?: RequestInit): Promise<T> => { const r = await http(url, init); if (!r.ok) throw Object.assign(new Error(`indexer ${r.status}`), { status: r.status }); return (await r.json()) as T; };
const txt = async (url: string, init?: RequestInit): Promise<string> => { const r = await http(url, init); if (!r.ok) throw Object.assign(new Error((await r.text()).slice(0, 200) || `indexer ${r.status}`), { status: r.status }); return (await r.text()).trim(); };

/** Esplora / mempool.space-style REST API. */
function esplora(u: string): Source {
  return {
    url: u,
    tip: async () => Number(await txt(u + '/blocks/tip/height')),
    genesis: () => txt(u + '/block-height/0'),
    utxos: async (a) => (await j<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }[]>(`${u}/address/${a}/utxo`)).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmed: x.status.confirmed })),
    balance: async (a) => { const s = await j<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { spent_txo_sum: number } }>(`${u}/address/${a}`); return BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum - s.mempool_stats.spent_txo_sum); },
    feeRate: async () => { const f = await j<Record<string, number>>(u + '/fee-estimates'); return f['3'] ?? f['6'] ?? 5; },
    broadcast: async (hex) => { await txt(u + '/tx', { method: 'POST', body: hex }); },
    status: async (id) => { try { const s = await j<{ confirmed: boolean; block_height?: number; block_hash?: string }>(`${u}/tx/${id}/status`); return { found: true, confirmed: s.confirmed, height: s.block_height, hash: s.block_hash }; } catch (e) { if ((e as { status?: number }).status === 404) return { found: false, confirmed: false }; throw e; } },
    rawTx: (id) => txt(`${u}/tx/${id}/hex`),
  };
}
/** Blockbook REST API v2 (amounts are decimal strings in base units). */
function blockbook(u: string): Source {
  return {
    url: u,
    tip: async () => (await j<{ blockbook: { bestHeight: number } }>(u)).blockbook.bestHeight,
    genesis: async () => (await j<{ blockHash: string }>(u + '/block-index/0')).blockHash,
    utxos: async (a) => (await j<{ txid: string; vout: number; value: string; confirmations: number }[]>(`${u}/utxo/${a}`)).map((x) => ({ txid: x.txid, vout: x.vout, value: Number(x.value), confirmed: x.confirmations > 0 })),
    balance: async (a) => { const s = await j<{ balance: string; unconfirmedBalance: string }>(`${u}/address/${a}?details=basic`); const un = BigInt(s.unconfirmedBalance); return BigInt(s.balance) + (un < 0n ? un : 0n); },
    feeRate: async () => { const f = await j<{ result: string }>(u + '/estimatefee/3'); const perKb = Number(f.result); if (!(perKb > 0)) throw new Error('no fee estimate'); return (perKb * 1e8) / 1000; },
    broadcast: async (hex) => { await txt(u + '/sendtx/', { method: 'POST', body: hex }); },
    status: async (id) => { try { const s = await j<{ blockHeight: number; blockHash?: string; confirmations: number }>(`${u}/tx/${id}`); return { found: true, confirmed: s.confirmations > 0, height: s.blockHeight, hash: s.blockHash }; } catch (e) { if ([400, 404].includes((e as { status?: number }).status ?? 0)) return { found: false, confirmed: false }; throw e; } },
    rawTx: async (id) => (await j<{ hex: string }>(`${u}/tx/${id}`)).hex,
  };
}
const sourceOf = (spec: string): Source => (spec.startsWith('blockbook:') ? blockbook(spec.slice(10)) : esplora(spec));

interface EsTx { txid: string; vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[]; vout: { scriptpubkey_address?: string; value: number }[]; status: { confirmed: boolean; block_height?: number; block_time?: number } }

export function btcAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc.map(sourceOf);
  const any = async <T>(f: (s: Source) => Promise<T>): Promise<T> => { let last: unknown; for (const s of sources) { try { return await f(s); } catch (e) { last = e; } } throw last; };
  const all = async <T>(f: (s: Source) => Promise<T>): Promise<T[]> => Promise.all(sources.map(f)).catch((e) => { throw e instanceof UserError ? e : new UserError('rpc_degraded', `${n.name} data source unavailable; transfer refused`, 503); });
  let identity = false;
  const legacy = n.utxo?.kind === 'pkh';
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (s) => {
        const t = Date.now();
        try {
          const h = await s.tip();
          if (!identity && (await s.genesis()) !== n.chainRef) throw new Error('genesis');
          return { url: hostOf(s.url), ok: true, ms: Date.now() - t, h };
        } catch { return { url: hostOf(s.url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    async balances(addr) { return { native: await any((s) => s.balance(addr)) }; },
    async prepare(d): Promise<Prepared> {
      if (!identity) throw new UserError('rpc_degraded', 'chain identity not verified yet; retry shortly', 503);
      // the spendable coin set must be identical on both independent indexers
      const sets = await all((s) => s.utxos(d.from));
      const norm = (s: Utxo[]) => s.filter((u) => u.confirmed).map((u) => `${u.txid}:${u.vout}:${u.value}`).sort();
      const a = norm(sets[0]!);
      for (const s of sets) if (JSON.stringify(norm(s)) !== JSON.stringify(a)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree on spendable coins; transfer refused`, 503);
      const utxos = sets[0]!.filter((u) => u.confirmed).sort((x, y) => y.value - x.value);
      const DUST = dustOf(n);
      const rate = Math.min(n.id === 'bitcoin' ? 200 : 5000, Math.max(1.1, (await any((s) => s.feeRate())) * 1.1));
      const chosen: Utxo[] = []; let total = 0n;
      for (const u of utxos) {
        chosen.push(u); total += BigInt(u.value);
        const feeWithChange = BigInt(Math.ceil(estimateBtcVsize(chosen.length, d.to, true, n) * rate));
        const feeNoChange = BigInt(Math.ceil(estimateBtcVsize(chosen.length, d.to, false, n) * rate));
        if (total >= d.amount + feeNoChange) {
          let change = total - d.amount - feeWithChange, fee = feeWithChange;
          if (change < DUST) { change = 0n; fee = total - d.amount; } // dust change is added to the fee
          if (fee > feeNoChange * 3n + DUST * 2n) continue; // keep adding inputs rather than overpay
          const aux = legacy ? { prevTx: Object.fromEntries(await Promise.all(chosen.map(async (c) => [c.txid, await any((s) => s.rawTx(c.txid))] as const))) } : undefined;
          return { section: { btc: { inputs: chosen.map((c) => ({ txid: c.txid, vout: c.vout, value: String(c.value) })), change: change.toString(), fee: fee.toString() } },
            maxFee: fee, feeEstimate: fee, warnings: [], ttlSec: 240, aux };
        }
        if (chosen.length >= 20) break;
      }
      throw new UserError('insufficient_funds', `insufficient confirmed ${n.native.symbol} for amount plus network fee`);
    },
    async broadcast(raw) {
      const rs = await Promise.allSettled(sources.map((s) => s.broadcast(raw)));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      const msg = String((rs[0] as PromiseRejectedResult).reason?.message);
      if (/already|known|in block chain/i.test(msg)) return;
      throw new Error(msg);
    },
    async track(p): Promise<Tracked> {
      const st = await any((s) => s.status(p.txid));
      if (!st.found) return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true };
      if (!st.confirmed) return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0 };
      const conf = (await any((s) => s.tip())) - st.height! + 1;
      return { state: conf >= n.minConf ? 'finalized' : 'confirming', confirmations: conf, blockRef: st.hash };
    },
    async deposits(addr) {
      const h = await any((s) => s.tip());
      const items: Deposit[] = [];
      const es = n.rpc.find((u) => !u.includes(':http')); // history listing uses the Esplora-style source
      if (!es) return { items, cursor: h, finalizedHeight: h - n.minConf + 1 };
      const txs = await j<EsTx[]>(`${es}/address/${addr}/txs`);
      for (const t of txs) {
        if (!t.status.confirmed) continue;
        if (t.vin.some((v) => v.prevout?.scriptpubkey_address === addr)) continue; // our own send (change output), not a deposit
        t.vout.forEach((o, idx) => { if (o.scriptpubkey_address === addr) items.push({ txid: t.txid, idx, asset: 'native', amount: BigInt(o.value), from: t.vin[0]?.prevout?.scriptpubkey_address ?? '', block: t.status.block_height!, time: t.status.block_time ?? null }); });
      }
      return { items, cursor: h, finalizedHeight: h - n.minConf + 1 };
    },
  };
}
