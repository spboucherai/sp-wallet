/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/stellar.ts
 * Module           : chains
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Stellar adapter: two independent Horizon instances (n.rpc). Everything that feeds the signature (sequence number, destination
// existence, reserve, base fee, ledger time) is read from both and must agree, or the transfer is refused.
// Classic Stellar operations have no simulation endpoint: prepare() checks the documented failure causes instead
// (source/destination existence, spendable balance after reserve, signing weight, required memo).
import { formatUnits, parseUnits, STELLAR_MIN_CREATE, STELLAR_MIN_FEE, stellarDecodeAccount, stellarEnvelopeTxid, stellarMemoType, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

interface Root { network_passphrase: string; history_latest_ledger: number; history_latest_ledger_closed_at: string }
interface Account {
  sequence: string; subentry_count: number; num_sponsoring?: number; num_sponsored?: number;
  balances: { asset_type: string; balance: string; selling_liabilities?: string }[];
  thresholds: { med_threshold: number }; signers: { key: string; weight: number }[]; data?: Record<string, string>;
}
interface Ledger { sequence: number; closed_at: string; base_fee_in_stroops: number; base_reserve_in_stroops: number }
interface FeeStats { last_ledger_base_fee: string; fee_charged: { p90: string } }
interface TxRecord { successful: boolean; ledger: number; hash: string }
interface Op {
  id: string; paging_token: string; type: string; transaction_successful: boolean; transaction_hash: string; created_at: string;
  asset_type?: string; from?: string; to?: string; amount?: string; funder?: string; account?: string; starting_balance?: string;
}
interface Page<T> { _embedded: { records: T[] } }

/** approval window; the transaction itself stays valid a little longer so it can still be included after a late approval */
const TTL_SEC = 120, VALIDITY_SEC = 180;
/** fee bid bounds in stroops: never below 0.0001 XLM, never above 0.02 XLM (the network charges only what inclusion requires) */
const FEE_FLOOR = 1_000n, FEE_CAP = 200_000n;
/** sources may be this many ledgers apart (≈ 5 s each); local clock and ledger close time may differ by this many seconds */
const MAX_LEDGER_GAP = 6, MAX_CLOCK_SKEW_SEC = 60, STALE_SEC = 300;
/** a "not included" verdict needs every source to have ingested a ledger closed this long after the time bound */
const EXPIRY_MARGIN_SEC = 20;
const TX_CODES: Record<number, string> = { [-2]: 'tx_too_early', [-3]: 'tx_too_late', [-5]: 'tx_bad_seq', [-6]: 'tx_bad_auth', [-7]: 'tx_insufficient_balance', [-8]: 'tx_no_source_account', [-9]: 'tx_insufficient_fee', [-1]: 'tx_failed' };

/** GET a Horizon resource. Returns null only for Horizon's own "resource missing" answer; any other failure throws. */
async function get<T>(base: string, path: string): Promise<T | null> {
  const r = await http(base + path, { headers: { accept: 'application/json' } });
  if (r.status === 404) {
    const j = (await r.json().catch(() => null)) as { status?: number; type?: string } | null;
    if (j?.status === 404 && typeof j.type === 'string' && j.type.endsWith('/not_found')) return null;
    throw new Error('horizon: unexpected 404');
  }
  if (!r.ok) throw new Error(`horizon http ${r.status}`);
  return (await r.json()) as T;
}
const must = async <T>(base: string, path: string): Promise<T> => { const v = await get<T>(base, path); if (v === null) throw new Error(`horizon: ${path} missing`); return v; };
const secOf = (iso: string): number => { const t = Date.parse(iso); if (!Number.isFinite(t)) throw new Error('horizon: bad timestamp'); return Math.floor(t / 1000); };
const stroops = (s: string | undefined): bigint => parseUnits(s ?? '0', 7);
const uint = (v: unknown, what: string): bigint => { if (typeof v === 'number' ? !Number.isSafeInteger(v) || v < 0 : typeof v !== 'string' || !/^\d{1,19}$/.test(v)) throw new Error(`horizon: bad ${what}`); return BigInt(v as string | number); };

export function stellarAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc;
  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => { let last: unknown; for (const u of sources) { try { return await f(u); } catch (e) { last = e; } } throw last; };
  /** every source must answer */
  const all = async <T>(f: (u: string) => Promise<T>, what: string): Promise<T[]> => {
    const rs = await Promise.allSettled(sources.map(f));
    if (sources.length < 2 || rs.some((r) => r.status === 'rejected')) throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    return rs.map((r) => (r as PromiseFulfilledResult<T>).value);
  };
  const agree = <T>(vals: T[], what: string): T => {
    for (const v of vals) if (JSON.stringify(v) !== JSON.stringify(vals[0])) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (${what}); transfer refused`, 503);
    return vals[0]!;
  };
  const root = async (u: string): Promise<Root> => {
    const r = await must<Root>(u, '/');
    if (r.network_passphrase !== n.chainRef) throw new Error('network passphrase mismatch');
    if (!Number.isSafeInteger(r.history_latest_ledger) || r.history_latest_ledger <= 0) throw new Error('horizon: bad ledger');
    secOf(r.history_latest_ledger_closed_at);
    return r;
  };
  const account = (u: string, a: string) => get<Account>(u, `/accounts/${a}`);
  const nativeOf = (a: Account) => { const b = a.balances.filter((x) => x.asset_type === 'native'); if (b.length !== 1) throw new Error('horizon: bad balances'); return b[0]!; };
  let identity = false;

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const r = await root(url); // verifies the network passphrase on every check
          if (Date.now() / 1000 - secOf(r.history_latest_ledger_closed_at) > STALE_SEC) throw new Error('stale');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: r.history_latest_ledger };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.length >= 2 && endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      const a = await any((u) => account(u, addr));
      return { native: a ? stroops(nativeOf(a).balance) : 0n }; // an account that does not exist yet holds nothing
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only XLM can be sent on Stellar in this version');
      try { stellarDecodeAccount(d.from); stellarDecodeAccount(d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      let memoType: 'none' | 'text' | 'id';
      try { memoType = stellarMemoType(d.memo); } catch (e) { throw new UserError('bad_memo', (e as Error).message); }
      const warnings: string[] = [];

      // one snapshot per source; both must answer and agree on everything that ends up in the signed bytes
      const snaps = await all(async (u) => {
        const [r, led, fees, src, dst] = await Promise.all([root(u), must<Page<Ledger>>(u, '/ledgers?order=desc&limit=1'), must<FeeStats>(u, '/fee_stats'), account(u, d.from), account(u, d.to)]);
        const l = led._embedded.records[0];
        if (!l) throw new Error('horizon: no ledger');
        const native = src ? nativeOf(src) : null;
        return {
          ledger: Number(uint(l.sequence, 'ledger')), closedAt: secOf(l.closed_at), rootLedger: r.history_latest_ledger,
          protocol: { baseReserve: uint(l.base_reserve_in_stroops, 'reserve').toString(), baseFee: uint(l.base_fee_in_stroops, 'base fee').toString() },
          feeBid: [uint(fees.last_ledger_base_fee, 'fee'), uint(fees.fee_charged.p90, 'fee')].reduce((a, b) => (a > b ? a : b)),
          src: src && native ? {
            sequence: uint(src.sequence, 'sequence').toString(), balance: stroops(native.balance).toString(), selling: stroops(native.selling_liabilities).toString(),
            entries: (uint(src.subentry_count, 'subentries') + uint(src.num_sponsoring ?? 0, 'sponsoring')).toString(), sponsored: uint(src.num_sponsored ?? 0, 'sponsored').toString(),
            medThreshold: Number(uint(src.thresholds.med_threshold, 'threshold')), masterWeight: Number(uint(src.signers.find((s) => s.key === d.from)?.weight ?? 0, 'weight')),
          } : null,
          dstExists: dst !== null, memoRequired: dst?.data?.['config.memo_required'] === 'MQ==',
        };
      }, 'account state');

      const now = Math.floor(Date.now() / 1000);
      const ledgers = snaps.map((s) => s.ledger);
      if (Math.max(...ledgers) - Math.min(...ledgers) > MAX_LEDGER_GAP) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same ledger; transfer refused`, 503);
      for (const s of snaps) if (Math.abs(now - s.closedAt) > MAX_CLOCK_SKEW_SEC) throw new UserError('rpc_degraded', `${n.name} ledger time and server clock differ; transfer refused`, 503);
      const protocol = agree(snaps.map((s) => s.protocol), 'network parameters');
      const src = agree(snaps.map((s) => s.src), 'source account');
      const dstExists = agree(snaps.map((s) => s.dstExists), 'destination account');
      const memoRequired = agree(snaps.map((s) => s.memoRequired), 'destination account');
      const baseReserve = BigInt(protocol.baseReserve), baseFee = BigInt(protocol.baseFee);
      if (baseReserve <= 0n || baseFee < STELLAR_MIN_FEE) throw new UserError('rpc_degraded', `${n.name} network parameters look wrong; transfer refused`, 503);

      if (!src) throw new UserError('insufficient_funds', `this ${n.name} account is not activated yet: it must first receive at least ${n.activation ?? '1'} ${n.native.symbol}`);
      if (src.masterWeight < 1 || src.masterWeight < src.medThreshold) throw new UserError('unsupported_account', 'this Stellar account requires other signers (multi-signature); it cannot send from this wallet');
      if (memoRequired && memoType === 'none') throw new UserError('memo_required', 'the destination requires a memo (it is flagged memo-required, typically an exchange): add the memo it gave you');
      if (memoType === 'id') warnings.push('memo_numeric_id');

      const op = dstExists ? 'payment' : 'createAccount';
      if (!dstExists) {
        const minCreate = STELLAR_MIN_CREATE > 2n * baseReserve ? STELLAR_MIN_CREATE : 2n * baseReserve;
        if (d.amount < minCreate) throw new UserError('below_reserve', `the destination account does not exist yet: send at least ${formatUnits(minCreate, 7)} ${n.native.symbol} to create it`);
        warnings.push('creates_account');
      }

      // fee bid: twice the larger of the base fee and the recent 90th-percentile charged fee, within fixed bounds
      const want = 2n * snaps.map((s) => s.feeBid).reduce((a, b) => (a > b ? a : b));
      if (want > FEE_CAP) warnings.push('network_congested');
      const fee = want > FEE_CAP ? FEE_CAP : want < FEE_FLOOR ? FEE_FLOOR : want;

      // spendable = balance - selling liabilities - (2 + subentries + sponsoring - sponsored) × base reserve
      const reserve = (2n + BigInt(src.entries) - BigInt(src.sponsored)) * baseReserve;
      const spendable = BigInt(src.balance) - BigInt(src.selling) - reserve;
      if (spendable < d.amount + fee) throw new UserError('insufficient_funds',
        `insufficient ${n.native.symbol}: ${formatUnits(spendable > 0n ? spendable : 0n, 7)} spendable (${formatUnits(reserve, 7)} stays locked as the account reserve) for amount plus network fee`);

      const sequence = BigInt(src.sequence) + 1n;
      return { section: { x: { op, sequence: sequence.toString(), fee: fee.toString(), maxTime: String(now + VALIDITY_SEC), memoType } }, maxFee: fee, feeEstimate: fee, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const txid = stellarEnvelopeTxid(n, raw);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        const r = await http(u + '/transactions_async', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'tx=' + encodeURIComponent(raw) });
        const j = (await r.json().catch(() => null)) as { tx_status?: string; hash?: string; errorResultXdr?: string; error_result_xdr?: string; title?: string } | null;
        if (j?.tx_status === 'PENDING' || j?.tx_status === 'DUPLICATE') { if (j.hash !== txid) throw new Error('horizon answered for another transaction'); return; }
        if (j?.tx_status === 'ERROR') {
          const b = Buffer.from(j.errorResultXdr ?? j.error_result_xdr ?? '', 'base64');
          const code = b.length >= 12 ? b.readInt32BE(8) : 0;
          throw new Error(`rejected by the network: ${TX_CODES[code] ?? `code ${code}`}`);
        }
        throw new Error(j?.tx_status === 'TRY_AGAIN_LATER' ? 'network busy, will retry' : `horizon ${r.status} ${j?.title ?? ''}`.trim());
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // "already known": a re-submission after inclusion is refused (bad sequence); the ledger is the judge
      const known = await Promise.allSettled(sources.map((u) => get<TxRecord>(u, `/transactions/${txid}`)));
      if (known.some((k) => k.status === 'fulfilled' && k.value?.hash === txid)) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const maxTime = Number(p.intent?.x?.maxTime);
      if (!Number.isSafeInteger(maxTime) || maxTime <= 0) throw new Error('intent has no time bound');
      // per source: ledger position FIRST, then the lookup — a miss is then known to cover every ledger up to that position
      const rs = await Promise.allSettled(sources.map(async (u) => { const r = await root(u); return { r, tx: await get<TxRecord>(u, `/transactions/${p.txid}`) }; }));
      const up = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const allUp = up.length === sources.length && up.length >= 2;
      const found = up.filter((s) => s.tx !== null);
      for (const s of found) if (s.tx!.hash !== p.txid || !Number.isSafeInteger(s.tx!.ledger) || typeof s.tx!.successful !== 'boolean') throw new Error('horizon: bad transaction record');
      if (found.length > 0) {
        const ledger = found[0]!.tx!.ledger, good = found[0]!.tx!.successful;
        if (found.some((s) => s.tx!.ledger !== ledger || s.tx!.successful !== good)) throw new Error('data sources disagree on the transaction result');
        const blockRef = String(ledger);
        // a ledger that closed is final on Stellar; every reachable source must show the transaction before we say so
        if (found.length < up.length) return { state: 'confirming', confirmations: 1, blockRef };
        if (good) return { state: 'finalized', confirmations: Math.max(1, Math.max(...up.map((s) => s.r.history_latest_ledger)) - ledger + 1), blockRef };
        // included but failed (fee charged, nothing transferred): only final once every source is reachable and agrees
        if (!allUp) return { state: 'confirming', confirmations: 1, blockRef };
        return { state: 'failed', confirmations: 0, blockRef, error: 'included in a ledger but the operation failed; only the network fee was charged, no funds moved' };
      }
      if (allUp && up.every((s) => secOf(s.r.history_latest_ledger_closed_at) > maxTime + EXPIRY_MARGIN_SEC))
        return { state: 'failed', confirmations: 0, error: 'not included before its time bound; no funds moved' };
      return { state: 'broadcast', confirmations: 0, rebroadcast: Date.now() / 1000 <= maxTime };
    },

    async deposits(addr, cursor) {
      return any(async (u) => {
        const latest = (await root(u)).history_latest_ledger; // read before the listing: nothing closed up to here can be missed
        const items: Deposit[] = [];
        const add = (o: Op) => {
          if (o.transaction_successful !== true || !/^\d{1,19}$/.test(o.id)) return;
          const id = BigInt(o.id), block = Number(id >> 32n), idx = Number(id & 0xfffn); // operation id = ledger << 32 | tx order << 12 | op index
          const base = { txid: o.transaction_hash, idx, asset: 'native', block, time: secOf(o.created_at) };
          if (o.type === 'payment' && o.asset_type === 'native' && o.to === addr && o.from !== addr && o.amount) items.push({ ...base, amount: stroops(o.amount), from: o.from ?? '' });
          else if (o.type === 'create_account' && o.account === addr && o.starting_balance) items.push({ ...base, amount: stroops(o.starting_balance), from: o.funder ?? '' });
        };
        const path = (q: string) => `/accounts/${addr}/payments?${q}`;
        if (cursor === null) {
          for (const o of (await get<Page<Op>>(u, path('order=desc&limit=50')))?._embedded.records ?? []) add(o);
        } else {
          let token = ((BigInt(cursor) + 1n) << 32n).toString(); // everything in ledgers after `cursor`
          for (let page = 0; page < 5; page++) {
            const recs = (await get<Page<Op>>(u, path(`order=asc&limit=200&cursor=${token}`)))?._embedded.records ?? [];
            for (const o of recs) add(o);
            if (recs.length < 200) break;
            token = recs[recs.length - 1]!.paging_token;
            if (page === 4) { // still more to read: resume next time from the last ledger fully covered
              const last = Number(BigInt(token) >> 32n) - 1;
              return { items, cursor: Math.max(cursor, last), finalizedHeight: latest };
            }
          }
        }
        // two ledgers of overlap in case a replica behind the same hostname lags (inserts are idempotent)
        return { items, cursor: Math.max(cursor ?? 0, latest - 2), finalizedHeight: latest };
      });
    },
  };
}
