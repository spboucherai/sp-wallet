import { dustOf, estimateBtcVsize, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, settle, type Adapter, type BalancesDetailed, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

export interface Utxo { txid: string; vout: number; value: number; confirmed: boolean }
interface Status { found: boolean; confirmed: boolean; height?: number; hash?: string }
/** One indexer of a Bitcoin-style chain. Two independent ones are required for anything that feeds a signature. */
export interface Source {
  url: string;
  tip(): Promise<number>;
  /** hash of the main-chain block at a height (chain identity: genesis, or the first block after a fork) */
  blockHash(height: number): Promise<string>;
  utxos(addr: string): Promise<Utxo[]>;
  /** confirmed balance minus what is already being spent in the mempool */
  balance(addr: string): Promise<bigint>;
  /**
   * NEXT B2 — the same two figures from every indexer: `confirmed` = coins in blocks not spent in a block; `net` = what the
   * mempool adds minus what it spends (negative while one of the wallet's sends is unconfirmed: the amount sent plus the fee,
   * the unconfirmed change already counted back). The displayed balance is `confirmed + min(net, 0)` on every indexer.
   * Before NEXT each indexer had its own rule: Esplora subtracted the coins being spent WITHOUT counting the unconfirmed
   * change back (a send of 1 from a coin of 5 showed 0 until confirmed, not 4), Blockbook used the net, Bitcore ignored the mempool.
   */
  detail?(addr: string): Promise<{ confirmed: bigint; net: bigint }>;
  /** fee rate in base units per virtual byte, ~3 block target */
  feeRate(): Promise<number>;
  broadcast(hex: string): Promise<void>;
  status(txid: string): Promise<Status>;
  rawTx(txid: string): Promise<string>;
  /** confirmed incoming transfers to an address (most recent page), when the indexer can list history */
  history?(addr: string): Promise<Deposit[]>;
}
const j = async <T>(url: string, init?: RequestInit): Promise<T> => { const r = await http(url, init); if (!r.ok) throw Object.assign(new Error(`indexer ${r.status}`), { status: r.status }); return (await r.json()) as T; };
const txt = async (url: string, init?: RequestInit): Promise<string> => { const r = await http(url, init); if (!r.ok) throw Object.assign(new Error((await r.text()).slice(0, 200) || `indexer ${r.status}`), { status: r.status }); return (await r.text()).trim(); };
/** Amount in base units as an exact JavaScript integer; anything else is refused rather than rounded. */
const exact = (v: string | number): number => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0 || String(n) !== String(v)) throw new Error('indexer returned an amount that is not an exact integer'); return n; };
const feePerKb = (v: string | number): number => { const perKb = Number(v); if (!(perKb > 0)) throw new Error('no fee estimate'); return (perKb * 1e8) / 1000; };
const TXID = /^[0-9a-f]{64}$/;

interface EsTx { txid: string; vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[]; vout: { scriptpubkey_address?: string; value: number }[]; status: { confirmed: boolean; block_height?: number; block_time?: number } }

async function esploraDetail(u: string, a: string): Promise<{ confirmed: bigint; net: bigint }> {
  const s = await j<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum?: number; spent_txo_sum: number } }>(`${u}/address/${a}`);
  const int = (v: unknown): bigint => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('indexer returned an amount that is not an exact integer'); return BigInt(v); };
  return { confirmed: int(s.chain_stats.funded_txo_sum) - int(s.chain_stats.spent_txo_sum), net: int(s.mempool_stats.funded_txo_sum ?? 0) - int(s.mempool_stats.spent_txo_sum) };
}

/** Esplora / mempool.space-style REST API. */
export function esplora(u: string): Source {
  return {
    url: u,
    tip: async () => Number(await txt(u + '/blocks/tip/height')),
    blockHash: (h) => txt(`${u}/block-height/${h}`),
    utxos: async (a) => (await j<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }[]>(`${u}/address/${a}/utxo`)).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmed: x.status.confirmed })),
    balance: async (a) => { const d = await esploraDetail(u, a); return d.confirmed + (d.net < 0n ? d.net : 0n); },
    detail: (a) => esploraDetail(u, a),
    feeRate: async () => { const f = await j<Record<string, number>>(u + '/fee-estimates'); return f['3'] ?? f['6'] ?? 5; },
    broadcast: async (hex) => { await txt(u + '/tx', { method: 'POST', body: hex }); },
    status: async (id) => { try { const s = await j<{ confirmed: boolean; block_height?: number; block_hash?: string }>(`${u}/tx/${id}/status`); return { found: true, confirmed: s.confirmed, height: s.block_height, hash: s.block_hash }; } catch (e) { if ((e as { status?: number }).status === 404) return { found: false, confirmed: false }; throw e; } },
    rawTx: (id) => txt(`${u}/tx/${id}/hex`),
    history: async (addr) => {
      const items: Deposit[] = [];
      for (const t of await j<EsTx[]>(`${u}/address/${addr}/txs`)) {
        if (!t.status.confirmed) continue;
        if (t.vin.some((v) => v.prevout?.scriptpubkey_address === addr)) continue; // our own send (change output), not a deposit
        t.vout.forEach((o, idx) => { if (o.scriptpubkey_address === addr) items.push({ txid: t.txid, idx, asset: 'native', amount: BigInt(o.value), from: t.vin[0]?.prevout?.scriptpubkey_address ?? '', block: t.status.block_height!, time: t.status.block_time ?? null }); });
      }
      return items;
    },
  };
}

interface BbTx { txid: string; vin: { addresses?: string[] }[]; vout: { value: string; n: number; addresses?: string[] }[]; blockHeight: number; confirmations: number; blockTime?: number }

/** Blockbook REST API v2 (amounts are decimal strings in base units). */
export function blockbook(u: string): Source {
  return {
    url: u,
    tip: async () => (await j<{ blockbook: { bestHeight: number } }>(u)).blockbook.bestHeight,
    blockHash: async (h) => (await j<{ blockHash: string }>(`${u}/block-index/${h}`)).blockHash,
    utxos: async (a) => (await j<{ txid: string; vout: number; value: string; confirmations: number }[]>(`${u}/utxo/${a}`)).map((x) => ({ txid: x.txid, vout: x.vout, value: exact(x.value), confirmed: x.confirmations > 0 })),
    // `unconfirmedBalance` is absent from some Blockbook builds when the address has nothing in the mempool (seen 2026-11-19 on the
    // Litecoin instance: with the other source down, the missing member made this one fail too and the balance read "unavailable").
    // Absent = nothing unconfirmed. `balance` itself must be there: without it the answer is not a balance.
    balance: async (a) => { const s = await j<{ balance?: string; unconfirmedBalance?: string }>(`${u}/address/${a}?details=basic`); if (typeof s.balance !== 'string') throw new Error('indexer: no balance in the answer'); const un = BigInt(s.unconfirmedBalance ?? '0'); return BigInt(s.balance) + (un < 0n ? un : 0n); },
    detail: async (a) => { const s = await j<{ balance?: string; unconfirmedBalance?: string }>(`${u}/address/${a}?details=basic`); if (typeof s.balance !== 'string') throw new Error('indexer: no balance in the answer'); return { confirmed: BigInt(s.balance), net: BigInt(s.unconfirmedBalance ?? '0') }; },
    feeRate: async () => feePerKb((await j<{ result: string }>(u + '/estimatefee/3')).result),
    broadcast: async (hex) => { await txt(u + '/sendtx/', { method: 'POST', body: hex }); },
    status: async (id) => { try { const s = await j<{ blockHeight: number; blockHash?: string; confirmations: number }>(`${u}/tx/${id}`); return { found: true, confirmed: s.confirmations > 0, height: s.blockHeight, hash: s.blockHash }; } catch (e) { if ([400, 404].includes((e as { status?: number }).status ?? 0)) return { found: false, confirmed: false }; throw e; } },
    rawTx: async (id) => (await j<{ hex: string }>(`${u}/tx/${id}`)).hex,
    history: async (addr) => {
      const items: Deposit[] = [];
      const page = await j<{ transactions?: BbTx[] }>(`${u}/address/${addr}?details=txs&pageSize=50`);
      for (const t of page.transactions ?? []) {
        if (!(t.confirmations > 0)) continue;
        if (t.vin.some((v) => v.addresses?.includes(addr))) continue; // our own send (change output), not a deposit
        for (const o of t.vout) if (o.addresses?.length === 1 && o.addresses[0] === addr) items.push({ txid: t.txid, idx: o.n, asset: 'native', amount: BigInt(o.value), from: t.vin[0]?.addresses?.[0] ?? '', block: t.blockHeight, time: t.blockTime ?? null });
      }
      return items;
    },
  };
}

/** Coins per address this adapter is willing to compare; a wallet address holding more is refused rather than truncated. */
const BITCORE_PAGE = 1000;
interface BcCoin { mintTxid: string; mintIndex: number; mintHeight: number; spentHeight: number; value: number }

/**
 * Bitcore REST API (BitPay's indexer, https://github.com/bitpay/bitcore — `/api/<CHAIN>/mainnet`).
 * It serves no raw transactions (rawTx throws; the other source provides them and the signer verifies them by hash).
 * Heights: mintHeight ≥ 0 = confirmed, -1 = mempool; spentHeight -2 = unspent, -1 = being spent in the mempool.
 * Addresses are passed without their CashAddr prefix (with it, Bitcore answers an empty list).
 */
export function bitcore(u: string): Source {
  const bare = (a: string) => a.slice(a.indexOf(':') + 1);
  return {
    url: u,
    tip: async () => (await j<{ height: number }>(u + '/block/tip')).height,
    blockHash: async (h) => (await j<{ hash: string }>(`${u}/block/${h}`)).hash,
    utxos: async (a) => {
      const coins = await j<BcCoin[]>(`${u}/address/${bare(a)}/?unspent=true&limit=${BITCORE_PAGE}`);
      if (!Array.isArray(coins) || coins.length >= BITCORE_PAGE) throw new Error('too many coins on this address to compare');
      return coins.filter((c) => c.spentHeight === -2 && c.mintHeight >= -1).map((c) => {
        if (!TXID.test(c.mintTxid) || !Number.isInteger(c.mintIndex)) throw new Error('malformed coin');
        return { txid: c.mintTxid, vout: c.mintIndex, value: exact(c.value), confirmed: c.mintHeight >= 0 };
      });
    },
    balance: async (a) => BigInt(exact((await j<{ confirmed: number }>(`${u}/address/${bare(a)}/balance`)).confirmed)),
    // from the coin list (heights as documented above): confirmed coins not spent in a block; mempool mints minus confirmed coins the mempool spends
    detail: async (a) => {
      const coins = await j<BcCoin[]>(`${u}/address/${bare(a)}/?unspent=true&limit=${BITCORE_PAGE}`);
      if (!Array.isArray(coins) || coins.length >= BITCORE_PAGE) throw new Error('too many coins on this address to compare');
      let confirmed = 0n, net = 0n;
      for (const c of coins) {
        const v = BigInt(exact(c.value));
        if (c.mintHeight >= 0 && (c.spentHeight === -2 || c.spentHeight === -1)) { confirmed += v; if (c.spentHeight === -1) net -= v; }
        else if (c.mintHeight === -1 && c.spentHeight === -2) net += v;
      }
      return { confirmed, net };
    },
    feeRate: async () => feePerKb((await j<{ feerate: number }>(u + '/fee/3')).feerate),
    broadcast: async (hex) => {
      // Bitcore answers 500 with the node's message as plain text; keep it so "already known" is recognised
      const r = await http(u + '/tx/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawTx: hex }) });
      const body = (await r.text()).trim();
      if (!r.ok) throw Object.assign(new Error(body.slice(0, 200) || `indexer ${r.status}`), { status: r.status });
      let txid: unknown;
      try { txid = (JSON.parse(body) as { txid?: unknown }).txid; } catch { /* not JSON: not an acknowledgement */ }
      if (typeof txid !== 'string' || !TXID.test(txid)) throw new Error('broadcast not acknowledged');
    },
    status: async (id) => { try { const s = await j<{ blockHeight: number; blockHash?: string }>(`${u}/tx/${id}`); return s.blockHeight > 0 ? { found: true, confirmed: true, height: s.blockHeight, hash: s.blockHash } : { found: true, confirmed: false }; } catch (e) { if ((e as { status?: number }).status === 404) return { found: false, confirmed: false }; throw e; } },
    rawTx: async () => { throw new Error('raw transactions are not served by Bitcore'); },
  };
}
export const sourceOf = (spec: string): Source => (spec.startsWith('blockbook:') ? blockbook(spec.slice(10)) : spec.startsWith('bitcore:') ? bitcore(spec.slice(8)) : esplora(spec));

/** What differs between Bitcoin-style chains once the coins are selected: transaction size and the intent's chain section. */
export interface UtxoShape {
  /** upper bound of the serialized size in (virtual) bytes */
  size(nInputs: number, to: string, hasChange: boolean): number;
  /** chain section of the intent, plus unauthenticated helper data for the signer when the chain needs it */
  section(chosen: Utxo[], change: bigint, fee: bigint, rawTx: (txid: string) => Promise<string>): Promise<{ section: Record<string, unknown>; aux?: Record<string, unknown> }>;
}

/**
 * NFT delivery 2 — inscription safety. Outpoints that must NEVER be chosen by the coin selection of an ordinary send or of a
 * cross-chain swap: the signer's lock list, what an ord server reports as carrying an inscription or a rune, and — without an
 * ord server — small outputs flagged by a heuristic (services/api/src/nft/utxo.ts sets this guard). The guard receives the
 * coin set the indexers agreed on. It is asked on every preparation; when it is absent, or returns an empty set, the
 * selection below is exactly what it was before. A guard that throws refuses the preparation (fail closed).
 */
export const utxoGuards: { excluded: ((network: string, address: string, utxos: Utxo[], rawTx: (txid: string) => Promise<string>) => Promise<ReadonlySet<string>>) | null } = { excluded: null };

export function utxoAdapter(n: NetworkDef, shape: UtxoShape, sources: Source[] = n.rpc.map(sourceOf)): Adapter {
  const any = async <T>(f: (s: Source) => Promise<T>): Promise<T> => { let last: unknown; for (const s of sources) { try { return await f(s); } catch (e) { last = e; } } throw last; };
  const all = async <T>(f: (s: Source) => Promise<T>): Promise<T[]> => Promise.all(sources.map(f)).catch((e) => { throw e instanceof UserError ? e : new UserError('rpc_degraded', `${n.name} data source unavailable; transfer refused`, 503); });
  let identity = false;
  const refHeight = n.utxo?.refHeight ?? 0;
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (s) => {
        const t = Date.now();
        try {
          const h = await s.tip();
          if (!Number.isInteger(h) || h <= refHeight) throw new Error('height');
          if (!identity && (await s.blockHash(refHeight)) !== n.chainRef) throw new Error('identity');
          return { url: hostOf(s.url), ok: true, ms: Date.now() - t, h: h as number | null };
        } catch { return { url: hostOf(s.url), ok: false, ms: null, h: null as number | null }; }
      }));
      // a source that trails the best one by more than the confirmation depth is stale: it counts as down
      const best = Math.max(0, ...endpoints.map((e) => e.h ?? 0));
      for (const e of endpoints) if (e.ok && best - e.h! > n.minConf) { e.ok = false; e.ms = null; }
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: best || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    async balances(addr) { return { native: await any((s) => s.balance(addr)) }; },
    /**
     * NEXT B2 — every indexer is asked for (confirmed, mempool net) and its tip. `confirmed` is compared between the indexers
     * that answered (equal: agreed; else `agreed: false` and the figure of the higher tip). The mempool is each indexer's own
     * view and is NOT compared: `pendingOut` / `pendingIn` are those of the indexer whose confirmed figure is shown.
     * amount = confirmed - pendingOut, the same rule whatever the indexer. A source without `detail` gives its balance as confirmed.
     */
    async balancesDetailed(addr): Promise<BalancesDetailed> {
      const rs = (await Promise.all(sources.map(async (s) => {
        try { const [d, tip] = await Promise.all([s.detail ? s.detail(addr) : s.balance(addr).then((b) => ({ confirmed: b, net: 0n })), s.tip().catch(() => null)]); return d.confirmed < 0n ? null : { ...d, height: tip }; }
        catch { return null; }
      }))).filter((r): r is { confirmed: bigint; net: bigint; height: number | null } => r !== null);
      if (!rs.length) throw new Error('no indexer answered');
      const c = settle(rs.map((r) => ({ amount: r.confirmed, height: r.height })), sources.length);
      const shown = rs.find((r) => r.confirmed === c.amount && r.height === c.height) ?? rs.find((r) => r.confirmed === c.amount)!;
      const pendingOut = shown.net < 0n ? (-shown.net > c.amount ? c.amount : -shown.net) : 0n, pendingIn = shown.net > 0n ? shown.net : 0n;
      return { assets: { native: { ...c, amount: c.amount - pendingOut, confirmed: c.amount, pendingOut, pendingIn } }, unavailable: {} };
    },
    async prepare(d): Promise<Prepared> {
      if (!identity) throw new UserError('rpc_degraded', 'chain identity not verified yet; retry shortly', 503);
      // the spendable coin set must be identical on both independent indexers
      const sets = await all((s) => s.utxos(d.from));
      const norm = (s: Utxo[]) => s.filter((u) => u.confirmed).map((u) => `${u.txid}:${u.vout}:${u.value}`).sort();
      const a = norm(sets[0]!);
      for (const s of sets) if (JSON.stringify(norm(s)) !== JSON.stringify(a)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree on spendable coins; transfer refused`, 503);
      const agreed = sets[0]!.filter((u) => u.confirmed);
      const excluded = utxoGuards.excluded ? await utxoGuards.excluded(n.id, d.from, agreed, (txid) => any((x) => x.rawTx(txid))) : null;
      const utxos = (excluded && excluded.size ? agreed.filter((u) => !excluded.has(`${u.txid}:${u.vout}`)) : agreed).sort((x, y) => y.value - x.value);
      const held = agreed.length - utxos.length;
      const DUST = dustOf(n);
      // chains with registry bounds (fixed-fee chains) do not depend on the node's estimate being available
      const fr = n.utxo?.feeRate;
      const est = fr ? await any((s) => s.feeRate()).catch(() => 0) : await any((s) => s.feeRate());
      const cap = fr ? fr.max : n.id === 'bitcoin' ? 200 : 5000;
      let rate = fr ? Math.min(fr.max, Math.max(fr.min, est * 1.1)) : Math.min(cap, Math.max(1.1, est * 1.1));
      const extra = d.thor?.extraBytes ?? 0;
      if (d.thor) { // THORChain's recommended rate when it is higher than ours; never above this wallet's own cap
        if (!(d.thor.minRate >= 0) || d.thor.minRate > cap) throw new UserError('fee_ceiling', `THORChain recommends a fee rate above this wallet's ceiling for ${n.name}; swap refused`, 422);
        rate = Math.max(rate, d.thor.minRate);
      }
      // NEXT: one still-unspent coin of every dropped transfer goes first and is always spent (transfers.ts `droppedCoins`):
      // the dropped transaction and this one then conflict, and at most one of them can ever confirm.
      const forced: Utxo[] = [];
      for (const coins of d.mustSpend ?? []) { const u = utxos.find((x) => coins.includes(`${x.txid}:${x.vout}`)); if (u && !forced.includes(u)) forced.push(u); }
      if (forced.length) utxos.sort((x, y) => Number(forced.includes(y)) - Number(forced.includes(x)) || y.value - x.value);
      const chosen: Utxo[] = []; let total = 0n;
      for (const u of utxos) {
        chosen.push(u); total += BigInt(u.value);
        const feeWithChange = BigInt(Math.ceil((shape.size(chosen.length, d.to, true) + extra) * rate));
        const feeNoChange = BigInt(Math.ceil((shape.size(chosen.length, d.to, false) + extra) * rate));
        if (chosen.length >= forced.length && total >= d.amount + feeNoChange) {
          let change = total - d.amount - feeWithChange, fee = feeWithChange;
          if (change < DUST && d.thor) { if (chosen.length >= 20) break; continue; } // a vault payment always returns change to the wallet: add a coin
          if (change < DUST) { change = 0n; fee = total - d.amount; } // dust change is added to the fee
          if (fee > feeNoChange * 3n + DUST * 2n) continue; // keep adding inputs rather than overpay
          const s = await shape.section(chosen, change, fee, (txid) => any((x) => x.rawTx(txid)));
          return { section: s.section, maxFee: fee, feeEstimate: fee, warnings: [], ttlSec: 240, aux: s.aux };
        }
        if (chosen.length >= 20) break;
      }
      if (held > 0) throw Object.assign(new UserError('insufficient_unlocked_funds', `insufficient confirmed ${n.native.symbol} outside the ${held} protected output(s) (locked, or possibly carrying an inscription): they are never spent by an ordinary send`), { data: { protectedOutputs: held } });
      throw new UserError('insufficient_funds', `insufficient confirmed ${n.native.symbol} for amount plus network fee`);
    },
    /** the confirmed coins both indexers agree on (NFT delivery 2: the lock-list screen) */
    async utxos(addr) {
      const sets = await all((s) => s.utxos(addr));
      const norm = (s: Utxo[]) => s.filter((u) => u.confirmed).map((u) => `${u.txid}:${u.vout}:${u.value}`).sort();
      for (const s of sets) if (JSON.stringify(norm(s)) !== JSON.stringify(norm(sets[0]!))) throw new UserError('rpc_disagreement', `${n.name} data sources disagree on the wallet's coins`, 503);
      return sets[0]!.filter((u) => u.confirmed).sort((x, y) => y.value - x.value);
    },
    rawTx: (txid) => any((x) => x.rawTx(txid)),
    async broadcast(raw) {
      const rs = await Promise.allSettled(sources.map((s) => s.broadcast(raw)));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      const msgs = rs.map((r) => String((r as PromiseRejectedResult).reason?.message));
      if (msgs.some((m) => /already|known|in block chain/i.test(m))) return;
      // "inputs missing or spent" is not a relay: the coins are gone — spent by this transaction (already mined) or by another one.
      // The caller settles that by looking the transaction up (transfers.ts `broadcastNow`).
      throw new Error([...new Set(msgs)].join(' | ').slice(0, 300));
    },
    /**
     * NEXT — every indexer is asked. The transaction is placed by any indexer that has it confirmed; "unknown to the
     * network" (`seen: false`) needs every indexer to have answered that it does not know it.
     */
    async track(p): Promise<Tracked> {
      const rs = await Promise.allSettled(sources.map((s) => s.status(p.txid)));
      const sts = rs.filter((r): r is PromiseFulfilledResult<Status> => r.status === 'fulfilled').map((r) => r.value);
      if (!sts.length) throw (rs[0] as PromiseRejectedResult).reason;
      const st = sts.find((x) => x.found && x.confirmed) ?? sts.find((x) => x.found);
      const pending: Tracked['state'] = p.blockRef ? 'reorged' : 'broadcast';
      if (!st) return { state: pending, confirmations: 0, rebroadcast: true, seen: sts.length === sources.length ? false : undefined };
      if (!st.confirmed) return { state: pending, confirmations: 0, seen: true };
      const conf = (await any((s) => s.tip())) - st.height! + 1;
      return { state: conf >= n.minConf ? 'finalized' : 'confirming', confirmations: conf, blockRef: st.hash, seen: true };
    },
    async deposits(addr) {
      const h = await any((s) => s.tip());
      const lister = sources.find((s) => s.history); // history listing uses the first source able to list it
      const items = lister ? await lister.history!(addr) : [];
      return { items, cursor: h, finalizedHeight: h - n.minConf + 1 };
    },
  };
}

/** Bitcoin, Litecoin (native SegWit) and Dogecoin (legacy P2PKH: the previous transactions travel as unauthenticated aux data). */
export function btcAdapter(n: NetworkDef, sources?: Source[]): Adapter {
  const legacy = n.utxo?.kind === 'pkh';
  return utxoAdapter(n, {
    size: (k, to, hasChange) => estimateBtcVsize(k, to, hasChange, n),
    section: async (chosen, change, fee, rawTx) => ({
      section: { btc: { inputs: chosen.map((c) => ({ txid: c.txid, vout: c.vout, value: String(c.value) })), change: change.toString(), fee: fee.toString() } },
      aux: legacy ? { prevTx: Object.fromEntries(await Promise.all(chosen.map(async (c) => [c.txid, await rawTx(c.txid)] as const))) } : undefined,
    }),
  }, sources);
}
