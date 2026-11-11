// XRP Ledger adapter: native XRP only. JSON-RPC over HTTPS (rippled / Clio), two independent sources.
// Everything that feeds the signature (sequence, reference ledger, fee, reserves, account existence and flags) is read
// from both sources at the same validated ledger and must be identical, otherwise the transfer is refused.
import { xrplTxid, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

/** Chain identity: a pinned early ledger (index → hash = chainRef) and the network id reported by the servers. */
const IDENTITY: Record<string, { ledger: number; networkId: number }> = {
  '4109C6F2045FC7EFF4CDE8F9905D19C28820D86304080FF886B299F0206E42B5': { ledger: 32570, networkId: 0 },
};
const LSF_REQUIRE_DEST_TAG = 0x0002_0000, LSF_DISALLOW_XRP = 0x0008_0000, LSF_DISABLE_MASTER = 0x0010_0000, LSF_DEPOSIT_AUTH = 0x0100_0000;
const TF_FULLY_CANONICAL_SIG = 0x8000_0000;
/** validated ledger + 20 ≈ 70–80 s; the approval window (45 s) leaves several ledgers for inclusion */
const LEDGER_WINDOW = 20, TTL_SEC = 45;
/** the fee offered never exceeds this (drops); equals the default policy ceiling */
const FEE_CAP = 100_000n;
const RIPPLE_EPOCH = 946_684_800;
/** Answers about the ledger's content (as opposed to a server being unable to answer). */
const DEFINITE = new Set(['actNotFound', 'txnNotFound']);

interface AccountRoot { Sequence: number; Balance: string; Flags: number; OwnerCount: number }
interface AccountInfo { account_data: AccountRoot; ledger_hash?: string; ledger_index?: number; ledger_current_index?: number; validated?: boolean }
interface LedgerRes { ledger_hash?: string; ledger_index?: number | string; validated?: boolean; ledger?: { ledger_hash?: string; ledger_index?: number | string; closed?: boolean } }
interface FeeRes { drops: { base_fee: string; minimum_fee: string; open_ledger_fee: string } }
interface StateRes { state: { network_id?: number; validated_ledger?: { seq: number; hash: string; base_fee: number; reserve_base: number; reserve_inc: number } } }
interface TxRes { hash?: string; validated?: boolean; ledger_index?: number; meta?: { TransactionResult?: string; delivered_amount?: unknown }; tx_json?: { hash?: string } }
interface SubmitRes { engine_result?: string; engine_result_message?: string }
interface AccountTxEntry { validated?: boolean; hash?: string; ledger_index?: number; meta?: { TransactionResult?: string; delivered_amount?: unknown } | string;
  tx?: Record<string, unknown>; tx_json?: Record<string, unknown> }
interface AccountTxRes { transactions: AccountTxEntry[]; marker?: unknown }

async function call<T>(url: string, method: string, params: Record<string, unknown>): Promise<T> {
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const j = (await r.json()) as { result?: { status?: string; error?: string; error_message?: string; error_exception?: string } };
  const res = j.result;
  if (!res || typeof res !== 'object') throw new Error('rpc: empty result');
  if (res.error !== undefined || res.status === 'error')
    throw Object.assign(new Error(String(res.error_message ?? res.error_exception ?? res.error ?? 'rpc error')), { xrpl: String(res.error ?? 'error'), body: res });
  return res as T;
}
const codeOf = (e: unknown): string | undefined => (e as { xrpl?: string }).xrpl;
const isDefinite = (e: unknown) => DEFINITE.has(codeOf(e) ?? '');
const uint = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`rpc: bad ${what}`); return v; };
const dropsOf = (v: unknown, what: string): bigint => { if (typeof v !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(v)) throw new Error(`rpc: bad ${what}`); return BigInt(v); };
const fmtXrp = (d: bigint) => { const f = (d % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${d / 1_000_000n}${f ? '.' + f : ''}`; };

export function xrplAdapter(n: NetworkDef): Adapter {
  const ident = IDENTITY[n.chainRef];
  if (!ident) throw new Error(`no pinned identity for XRP Ledger network ${n.id}`);
  const sources = n.rpc;
  if (sources.length < 2) throw new Error('XRP Ledger needs two independent sources');
  let identity = false;

  /** First source that gives an answer about the ledger wins (display-only reads). */
  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const u of sources) { try { return await f(u); } catch (e) { last = e; if (isDefinite(e)) throw e; } }
    throw last;
  };
  /** Every source must answer; used for anything that feeds a signature or declares a transfer dead. */
  const all = async <T>(what: string, f: (u: string) => Promise<T>): Promise<T[]> => {
    const rs = await Promise.allSettled(sources.map(f));
    return rs.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      if (r.reason instanceof UserError) throw r.reason;
      throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    });
  };
  const agree = <T>(what: string, vs: T[]): T => {
    for (const v of vs) if (JSON.stringify(v) !== JSON.stringify(vs[0])) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (${what}); transfer refused`, 503);
    return vs[0]!;
  };

  const validated = async (u: string): Promise<{ index: number; hash: string }> => {
    const r = await call<LedgerRes>(u, 'ledger', { ledger_index: 'validated' });
    const index = Number(r.ledger_index ?? r.ledger?.ledger_index), hash = r.ledger_hash ?? r.ledger?.ledger_hash;
    if (!Number.isSafeInteger(index) || index <= ident.ledger || typeof hash !== 'string' || !/^[0-9A-F]{64}$/.test(hash)) throw new Error('rpc: bad validated ledger');
    return { index, hash };
  };
  /** The pinned early ledger must carry the pinned hash and the server must report the expected network id. */
  const checkIdentity = async (u: string): Promise<void> => {
    const r = await call<LedgerRes>(u, 'ledger', { ledger_index: ident.ledger });
    if ((r.ledger_hash ?? r.ledger?.ledger_hash) !== n.chainRef) throw new Error('identity: pinned ledger hash mismatch');
    const s = await call<StateRes>(u, 'server_state', {});
    if (s.state.network_id !== undefined && s.state.network_id !== ident.networkId) throw new Error('identity: network id mismatch');
  };
  /** Account root at one exact validated ledger; null when the account does not exist in that ledger. */
  const accountAt = async (u: string, addr: string, ledger: number): Promise<{ seq: number; balance: string; flags: number; owners: number; ledgerHash: string } | null> => {
    try {
      const r = await call<AccountInfo>(u, 'account_info', { account: addr, ledger_index: ledger });
      const d = r.account_data;
      if (r.ledger_index !== ledger || typeof r.ledger_hash !== 'string') throw new Error('rpc: account_info answered for another ledger');
      return { seq: uint(d.Sequence, 'Sequence'), balance: dropsOf(d.Balance, 'Balance').toString(), flags: uint(d.Flags, 'Flags'), owners: uint(d.OwnerCount, 'OwnerCount'), ledgerHash: r.ledger_hash };
    } catch (e) { if (codeOf(e) === 'actNotFound') return null; throw e; }
  };
  const lookup = async (u: string, txid: string, range?: { min: number; max: number }): Promise<{ found: TxRes | null; searchedAll: boolean }> => {
    try { return { found: await call<TxRes>(u, 'tx', { transaction: txid, binary: false, ...(range ? { min_ledger: range.min, max_ledger: range.max } : {}) }), searchedAll: false }; }
    catch (e) { if (codeOf(e) === 'txnNotFound') return { found: null, searchedAll: (e as { body?: { searched_all?: unknown } }).body?.searched_all === true }; throw e; }
  };

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const v = await validated(url);
          if (!identity) await checkIdentity(url);
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: v.index };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      try {
        const r = await any((u) => call<AccountInfo>(u, 'account_info', { account: addr, ledger_index: 'validated' }));
        return { native: dropsOf(r.account_data.Balance, 'Balance') };
      } catch (e) { if (codeOf(e) === 'actNotFound') return { native: 0n }; throw e; } // not activated yet
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only XRP can be sent on the XRP Ledger');
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      if (d.memo !== undefined && (!/^(0|[1-9]\d{0,9})$/.test(d.memo) || Number(d.memo) > 0xffff_ffff)) throw new UserError('bad_memo', 'the destination tag must be a whole number between 0 and 4294967295');
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (!identity) { await all('identity', checkIdentity); identity = true; }

      // one reference ledger, validated on both sources, with the same hash on both
      const tips = await all('ledger', validated);
      const ledger = Math.min(...tips.map((t) => t.index));
      if (Math.max(...tips.map((t) => t.index)) - ledger > 5) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same ledger; transfer refused`, 503);

      const [states, fees, srcs, dsts] = await Promise.all([
        all('server_state', async (u) => { const v = (await call<StateRes>(u, 'server_state', {})).state.validated_ledger; if (!v) throw new Error('no validated ledger');
          return { base: uint(v.base_fee, 'base_fee'), reserve: uint(v.reserve_base, 'reserve_base'), inc: uint(v.reserve_inc, 'reserve_inc') }; }),
        all('fee', async (u) => { const f = (await call<FeeRes>(u, 'fee', {})).drops; return { base: dropsOf(f.base_fee, 'base_fee'), open: dropsOf(f.open_ledger_fee, 'open_ledger_fee') }; }),
        all('account_info', (u) => accountAt(u, d.from, ledger)),
        all('account_info', (u) => accountAt(u, d.to, ledger)),
      ]);
      const rules = agree('reserves', states);
      const src = agree('source account', srcs), dst = agree('destination account', dsts);
      const baseFee = agree('base fee', fees.map((f) => f.base.toString()));
      if (BigInt(rules.base) !== BigInt(baseFee) || rules.reserve <= 0 || rules.inc < 0) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (fee settings); transfer refused`, 503);
      const reserveBase = BigInt(rules.reserve), reserveInc = BigInt(rules.inc);

      // fee: the highest open-ledger cost seen by either source plus 20 % (the whole fee is destroyed, so no more than that)
      let fee = BigInt(baseFee);
      for (const f of fees) if (f.open > fee) fee = f.open;
      fee = (fee * 12n + 9n) / 10n;
      if (fee <= 0n) throw new UserError('rpc_degraded', `${n.name} fee data unusable; transfer refused`, 503);
      // congestion spike: never pay more than the cap; a payment at the cap waits in the queue and, if it is not included
      // by LastLedgerSequence, expires without moving anything
      if (fee > FEE_CAP) fee = FEE_CAP;

      if (!src) throw new UserError('insufficient_funds', `this wallet's XRP account is not activated yet: it must first receive at least ${fmtXrp(reserveBase)} XRP`);
      if (src.flags & LSF_DISABLE_MASTER) throw new UserError('bad_source', 'the master key of this XRP account is disabled; this wallet cannot sign for it');
      const warnings: string[] = [];
      if (dst) {
        if (dst.flags & LSF_REQUIRE_DEST_TAG && d.memo === undefined) throw new UserError('bad_memo', 'this destination requires a destination tag: without it the deposit would be refused or lost');
        if (dst.flags & LSF_DEPOSIT_AUTH) throw new UserError('bad_destination', 'this destination only accepts payments from pre-authorized senders (Deposit Authorization)');
        if (dst.flags & LSF_DISALLOW_XRP) throw new UserError('bad_destination', 'this destination has declared that it does not accept XRP');
      } else {
        if (d.amount < reserveBase) throw new UserError('below_rent', `destination account does not exist yet: send at least ${fmtXrp(reserveBase)} XRP to activate it`);
        // the payment creates the account; the base reserve then stays locked in it (no warning key exists in the web app for this)
      }
      // the source keeps its own reserve: base + one increment per owned object
      const locked = reserveBase + BigInt(src.owners) * reserveInc, balance = BigInt(src.balance);
      if (balance < d.amount + fee + locked) throw new UserError('insufficient_funds', `insufficient XRP: ${fmtXrp(locked)} XRP must remain in the wallet as the account reserve (spendable: ${fmtXrp(balance > locked + fee ? balance - locked - fee : 0n)} XRP)`);

      // nothing of ours may still be in flight: the open ledger of every source must show the same sequence
      const open = await all('account_info', async (u) => uint((await call<AccountInfo>(u, 'account_info', { account: d.from, ledger_index: 'current' })).account_data.Sequence, 'Sequence'));
      if (open.some((s) => s !== src.seq)) throw new UserError('pending_tx', 'a previous transaction from this wallet is still being confirmed; retry in a few seconds', 409);

      const lastLedgerSequence = ledger + LEDGER_WINDOW;
      // dry run of the exact payment on the current open ledger (rippled `simulate`; nothing is signed or submitted)
      const tx_json = { TransactionType: 'Payment', Account: d.from, Destination: d.to, Amount: d.amount.toString(), Fee: fee.toString(), Flags: TF_FULLY_CANONICAL_SIG,
        Sequence: src.seq, LastLedgerSequence: lastLedgerSequence, ...(d.memo !== undefined ? { DestinationTag: Number(d.memo) } : {}) };
      let sim: { engine_result?: string; engine_result_message?: string };
      try { sim = await any((u) => call<{ engine_result?: string; engine_result_message?: string }>(u, 'simulate', { tx_json })); }
      catch (e) { throw new UserError('rpc_degraded', `${n.name} simulation unavailable (${(e as Error).message.slice(0, 80)}); transfer refused`, 503); }
      if (sim.engine_result !== 'tesSUCCESS' && sim.engine_result !== 'terQUEUED') throw new UserError('simulation_failed', `simulation failed: ${String(sim.engine_result)} ${String(sim.engine_result_message ?? '').slice(0, 160)}`);

      return { section: { x: { sequence: String(src.seq), lastLedgerSequence: String(lastLedgerSequence), fee: fee.toString() } }, maxFee: fee, feeEstimate: fee, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const txid = xrplTxid(raw);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        const r = await call<SubmitRes>(u, 'submit', { tx_blob: raw });
        const code = String(r.engine_result ?? '');
        // applied to the open ledger, queued, or already there. "tec" = relayed and will be included but only burns the fee: track() reports it as failed.
        if (code.startsWith('tes') || code === 'terQUEUED' || code === 'tefALREADY' || code.startsWith('tec')) return;
        // "sequence already used" / "too late": fine only if this very transaction is the one that made it into a ledger
        if ((code === 'tefPAST_SEQ' || code === 'tefMAX_LEDGER') && (await lookup(u, txid)).found) return;
        throw new Error(`${code || 'rejected'}: ${String(r.engine_result_message ?? '').slice(0, 160)}`);
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const last = Number(p.intent?.x?.lastLedgerSequence);
      const range = Number.isSafeInteger(last) && last > 2 * LEDGER_WINDOW ? { min: last - 2 * LEDGER_WINDOW, max: last } : undefined;
      const rs = await Promise.allSettled(sources.map((u) => lookup(u, p.txid, range)));
      const seen = rs.flatMap((r) => (r.status === 'fulfilled' && r.value.found ? [r.value.found] : []));
      const done = seen.find((t) => t.validated === true);
      if (done) {
        if (String(done.hash ?? done.tx_json?.hash ?? '').toUpperCase() !== p.txid.toUpperCase()) throw new Error('rpc: tx answered for another hash');
        const code = String(done.meta?.TransactionResult ?? '');
        const blockRef = done.ledger_index !== undefined ? String(done.ledger_index) : undefined;
        if (code === 'tesSUCCESS') return { state: 'finalized', confirmations: Math.max(1, n.minConf), blockRef };
        return { state: 'failed', confirmations: 0, blockRef, error: `ledger result ${code || 'unknown'}: the payment was not made (only the network fee was charged)` };
      }
      if (seen.length > 0) return { state: 'confirming', confirmations: 0 };
      // Not found. It is dead only when every source has searched every ledger up to LastLedgerSequence and is past it.
      if (range && rs.every((r) => r.status === 'fulfilled' && r.value.searchedAll)) {
        const tips = await Promise.allSettled(sources.map(validated));
        if (tips.every((t) => t.status === 'fulfilled' && t.value.index > last))
          return { state: 'failed', confirmations: 0, error: 'expired before inclusion (LastLedgerSequence passed); no funds moved' };
      }
      return { state: 'broadcast', confirmations: 0, rebroadcast: true };
    },

    async deposits(addr, cursor) {
      const tip = (await any(validated)).index;
      const items: Deposit[] = [];
      if (cursor !== null && cursor >= tip) return { items, cursor, finalizedHeight: tip };
      let marker: unknown, lastLedger = 0, pages = 0;
      do {
        let r: AccountTxRes;
        try {
          r = await any((u) => call<AccountTxRes>(u, 'account_tx', { account: addr, ledger_index_min: cursor === null ? -1 : cursor + 1, ledger_index_max: tip, limit: 50, forward: cursor !== null, ...(marker !== undefined ? { marker } : {}) }));
        } catch (e) { if (codeOf(e) === 'actNotFound') return { items, cursor: tip, finalizedHeight: tip }; throw e; } // not activated yet
        for (const e of r.transactions) {
          const t = e.tx ?? e.tx_json, m = e.meta;
          if (e.validated !== true || !t || !m || typeof m !== 'object') continue;
          const ledger = Number(t.ledger_index ?? e.ledger_index), txid = String(t.hash ?? e.hash ?? '');
          if (!Number.isSafeInteger(ledger) || !/^[0-9A-F]{64}$/.test(txid)) continue;
          lastLedger = Math.max(lastLedger, ledger);
          // incoming, successful, native: delivered_amount is a string of drops for XRP (an object for issued currencies, which are ignored)
          if (t.TransactionType !== 'Payment' || t.Destination !== addr || t.Account === addr || m.TransactionResult !== 'tesSUCCESS') continue;
          if (typeof m.delivered_amount !== 'string' || !/^[1-9]\d{0,17}$/.test(m.delivered_amount)) continue;
          items.push({ txid, idx: 0, asset: 'native', amount: BigInt(m.delivered_amount), from: String(t.Account ?? ''), block: ledger, time: typeof t.date === 'number' ? t.date + RIPPLE_EPOCH : null });
        }
        marker = cursor === null ? undefined : r.marker; // first scan: the most recent page only
        pages += 1;
      } while (marker !== undefined && pages < 5);
      // more history than five pages: resume from the last ledger seen (re-read on the next pass; duplicates are ignored by the caller)
      const next = marker !== undefined && cursor !== null && lastLedger - 1 > cursor ? lastLedger - 1 : tip;
      return { items, cursor: next, finalizedHeight: tip };
    },
  };
}
