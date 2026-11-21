/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/ton.ts
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

// TON adapter. Two independent keyless sources with different software and operators:
//   n.rpc[0]  TON Center HTTP API v2 (tonlib over liteservers: every answer is anchored to a masterchain block)
//   n.rpc[1]  TonAPI v2 (Tonkeeper's indexer)
// Everything that feeds the signed message (wallet state, sequence number, destination state for the bounce flag) is read from
// both and must agree, or the transfer is refused. Both are rate-limited to about one request per second without a key, so
// requests to one source are queued and a 429 is retried after a pause.
//
// Fees: a TON message carries no fee field; the network charges the wallet from its own price table. prepare() estimates it with
// TON Center's estimateFee, simulates the whole transfer on TonAPI, and budgets maxFee with a margin that the balance must cover.
// The first outgoing transfer deploys the wallet contract: the API does not hold the public key, so that single case cannot be
// simulated and uses a fixed, conservative estimate.
import {
  formatUnits, TON_MAINNET_ZEROSTATE, TON_SEND_MODE, TON_SUBWALLET_ID, TON_V4R2_CODE_HASH, tonAddressOf, tonCommentBytes, tonExternalMessage, tonNormalizeAddress,
  tonNormalizedHash, tonParseAddress, tonParseBoc, tonRawAddress, tonReadExternal, tonSerializeBoc, tonSignedBody, tonSigningMessage, tonWalletData, toHex, type NetworkDef, type TonCell,
} from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

/** approval window; the message itself stays valid longer so it can still be included after a late approval */
const TTL_SEC = 120, VALIDITY_SEC = 300;
/** fee budget in nanotons: three times the estimate, never below 0.005 TON, never above 0.05 TON */
const FEE_FLOOR = 5_000_000n, FEE_CAP = 50_000_000n;
/** measured 2026-11-10: about 0.0004 TON for a transfer, about 0.001 TON when the wallet contract is deployed with it */
const DEPLOY_FEE_ESTIMATE = 1_500_000n;
/** masterchain blocks are about half a second apart: sources may differ by a minute; clocks by a minute */
const MAX_MC_GAP = 150, MAX_CLOCK_SKEW_SEC = 60, STALE_SEC = 120;
/** how long a verified chain identity is trusted before it is checked again */
const IDENTITY_TTL_MS = 120_000;
/** a "not included" verdict needs chain time this far past valid_until on every source */
const EXPIRY_MARGIN_SEC = 60;
const RETRY_429_MS = 1100, RETRIES_429 = 3;
const MC_SHARD = '-9223372036854775808';

type State = 'active' | 'uninit' | 'frozen';
interface TcTxId { lt: string; hash: string }
interface TcMsg { hash?: string; source: string; destination: string; value: string; msg_data?: { '@type'?: string; body?: string } }
interface TcTx { utime: number; transaction_id: TcTxId; in_msg?: TcMsg; out_msgs: TcMsg[] }
interface TaAccount { balance: number; status: string; last_transaction_lt?: number; code?: string; data?: string }
interface TaMsg { msg_type: string; value: number; bounce?: boolean; source?: { address: string }; destination?: { address: string } }
interface TaTx {
  hash: string; lt: number; utime: number; success: boolean; aborted: boolean; account: { address: string }; in_msg?: TaMsg; out_msgs: TaMsg[];
  compute_phase?: { success?: boolean }; action_phase?: { success: boolean; total_actions: number; skipped_actions: number };
}
interface TaTrace { transaction: TaTx; children?: TaTrace[] }
/** where a transfer was found and what it did: the approved transfer, nothing (action skipped), or something else (a source is wrong) */
interface Found { lt: string; hash: string; outcome: 'sent' | 'nothing' | 'mismatch' }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nat = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' ? !Number.isSafeInteger(v) || v < 0 : typeof v !== 'string' || !/^\d{1,30}$/.test(v)) throw new Error(`ton: bad ${what}`);
  return BigInt(v as string | number);
};
const int = (v: unknown, what: string): number => { const b = nat(v, what); if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ton: bad ${what}`); return Number(b); };
const hex64 = (v: unknown, what: string): string => { if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`ton: bad ${what}`); return v.toLowerCase(); };
const b64ToHex = (v: unknown, what: string): string => { const b = typeof v === 'string' ? Buffer.from(v, 'base64') : null; if (!b || b.length !== 32) throw new Error(`ton: bad ${what}`); return b.toString('hex'); };
const bocOf = (c: TonCell) => Buffer.from(tonSerializeBoc(c)).toString('base64');
const idHex = (addr: string) => toHex(tonParseAddress(addr));
const stateOf = (s: unknown): State => {
  if (s === 'active') return 'active';
  if (s === 'uninitialized' || s === 'uninit' || s === 'nonexist') return 'uninit'; // no contract at this address (it may still hold coins)
  if (s === 'frozen') return 'frozen';
  throw new Error('ton: bad account state');
};

export function tonAdapter(n: NetworkDef): Adapter {
  const [TC, TA] = n.rpc as [string, string];
  if (n.rpc.length !== 2 || n.chainRef !== TON_MAINNET_ZEROSTATE) throw new Error('TON adapter needs exactly two sources (TON Center v2, TonAPI v2) on the main network');
  const sources = [TC, TA];

  // one request at a time per source; a 429 pauses that source's queue and retries
  const queues = new Map<string, Promise<unknown>>();
  const request = (base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await http(base + path, { ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
        if (r.status === 429 && attempt < RETRIES_429) { await r.arrayBuffer().catch(() => {}); await sleep(RETRY_429_MS); continue; }
        return { status: r.status, body: await r.json().catch(() => null) };
      }
    };
    const p = (queues.get(base) ?? Promise.resolve()).then(run, run);
    queues.set(base, p.catch(() => {}));
    return p;
  };
  /** TON Center: { ok: true, result } or an error */
  const tc = async <T>(path: string, post?: unknown): Promise<T> => {
    const { status, body } = await request(TC, path, post === undefined ? {} : { method: 'POST', body: JSON.stringify(post) });
    if (status !== 200 || body?.ok !== true || body.result === undefined) throw new Error(`toncenter ${status}${typeof body?.error === 'string' ? ': ' + body.error.slice(0, 160) : ''}`);
    return body.result as T;
  };
  /** TonAPI: the JSON document; `null` only for its own "not found" answer when `missing` is allowed */
  const ta = async <T>(path: string, opts: { post?: unknown; missing?: boolean } = {}): Promise<T | null> => {
    const { status, body } = await request(TA, path, opts.post === undefined ? {} : { method: 'POST', body: JSON.stringify(opts.post) });
    if (status === 200) return (body !== null && typeof body === 'object' ? body : {}) as T; // callers validate every field they use
    if (opts.missing && status === 404 && typeof body?.error === 'string' && /not found/i.test(body.error)) return null;
    throw Object.assign(new Error(`tonapi ${status}${typeof body?.error === 'string' ? ': ' + body.error.slice(0, 160) : ''}`), { status, detail: typeof body?.error === 'string' ? body.error : '' });
  };
  const taMust = async <T>(path: string): Promise<T> => (await ta<T>(path))!;
  /** TonAPI answers "entity not found" for an address that never appeared on-chain: that is an empty, non-existent account */
  const accountTa = async (raw: string): Promise<TaAccount> => (await ta<TaAccount>(`/blockchain/accounts/${raw}`, { missing: true })) ?? { balance: 0, status: 'nonexist', last_transaction_lt: 0 };

  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => { let last: unknown; for (const u of sources) { try { return await f(u); } catch (e) { last = e; } } throw last; };
  /** every source must answer */
  const both = async <A, B>(fa: () => Promise<A>, fb: () => Promise<B>, what: string): Promise<[A, B]> => {
    const [a, b] = await Promise.allSettled([fa(), fb()]);
    for (const r of [a, b]) if (r.status === 'rejected' && r.reason instanceof UserError) throw r.reason;
    if (a.status === 'rejected' || b.status === 'rejected') throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    return [a.value, b.value];
  };
  const agree = <T>(a: T, b: T, what: string): T => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (${what}); transfer refused`, 503);
    return a;
  };

  // ---- chain identity: masterchain zero-state root hash, and the current masterchain head ----
  const verifiedAt = new Map<string, number>();
  const headOf = async (u: string): Promise<{ seqno: number; time: number | null }> => {
    if (u === TC) {
      const r = await tc<{ last: { seqno: number }; init: { root_hash: string } }>('/getMasterchainInfo');
      if (b64ToHex(r.init?.root_hash, 'zero state') !== n.chainRef) throw new Error('zero-state hash mismatch');
      verifiedAt.set(u, Date.now());
      return { seqno: int(r.last?.seqno, 'seqno'), time: null };
    }
    const r = await taMust<{ init: { root_hash: string } }>('/liteserver/get_masterchain_info');
    if (hex64(r.init?.root_hash, 'zero state') !== n.chainRef) throw new Error('zero-state hash mismatch');
    const h = await taMust<{ seqno: number; gen_utime: number }>('/blockchain/masterchain-head');
    verifiedAt.set(u, Date.now());
    return { seqno: int(h.seqno, 'seqno'), time: int(h.gen_utime, 'time') };
  };
  const identityFresh = (u: string) => Date.now() - (verifiedAt.get(u) ?? -Infinity) < IDENTITY_TTL_MS;
  const ensureIdentity = async () => {
    const rs = await Promise.allSettled(sources.map(async (u) => { if (!identityFresh(u)) await headOf(u); }));
    if (rs.some((r) => r.status === 'rejected')) throw new UserError('rpc_degraded', `${n.name} data source unavailable or on another network (chain identity); transfer refused`, 503);
  };

  // ---- the wallet account, as each source sees it ----
  interface Wallet { state: State; balance: string; lastLt: string; seqno: number }
  const walletTc = async (addr: string): Promise<Wallet & { mcSeqno?: number }> => {
    const w = await tc<{ wallet: boolean; balance: string; account_state: string; wallet_type?: string; seqno?: number; wallet_id?: number; last_transaction_id: TcTxId }>(`/getWalletInformation?address=${tonRawAddress(addr)}`);
    const state = stateOf(w.account_state), base = { state, balance: nat(w.balance, 'balance').toString(), lastLt: nat(w.last_transaction_id?.lt, 'lt').toString() };
    if (state !== 'active') return { ...base, seqno: 0 };
    if (w.wallet !== true || w.wallet_type !== 'wallet v4 r2' || w.wallet_id !== TON_SUBWALLET_ID) throw new Error('toncenter: the account is not this wallet contract');
    return { ...base, seqno: int(w.seqno, 'seqno') };
  };
  /** decode and verify the on-chain code and data of an active wallet: v4R2 code, default subwallet, the key behind this address */
  const walletSeqno = (addr: string, code: Uint8Array, data: Uint8Array): number => {
    if (toHex(tonParseBoc(code).hash) !== TON_V4R2_CODE_HASH) throw new Error('ton: the account does not run the wallet v4R2 code');
    const d = tonWalletData(tonParseBoc(data));
    if (d.subwalletId !== TON_SUBWALLET_ID || tonAddressOf(d.publicKey) !== addr) throw new Error('ton: the account is not this wallet contract');
    return d.seqno;
  };
  const walletTa = async (addr: string): Promise<Wallet> => {
    const a = await accountTa(tonRawAddress(addr));
    const state = stateOf(a.status), base = { state, balance: nat(a.balance, 'balance').toString(), lastLt: nat(a.last_transaction_lt ?? 0, 'lt').toString() };
    if (state !== 'active') return { ...base, seqno: 0 };
    if (typeof a.code !== 'string' || typeof a.data !== 'string' || !/^([0-9a-f]{2})+$/i.test(a.code) || !/^([0-9a-f]{2})+$/i.test(a.data)) throw new Error('tonapi: bad account code or data');
    return { ...base, seqno: walletSeqno(addr, Buffer.from(a.code, 'hex'), Buffer.from(a.data, 'hex')) };
  };

  // ---- finding a transfer ----
  const sameTransfer = (dest: string | undefined, value: unknown, intent: any): boolean => {
    try { return dest !== undefined && idHex(dest) === idHex(intent.to) && nat(value, 'value') === BigInt(intent.amount); } catch { return false; }
  };
  /** TON Center transaction → Found when its inbound external message is the one with this normalized hash */
  const matchTc = (t: TcTx, txid: string, intent: any): Found | null => {
    const m = t.in_msg;
    if (!m || m.source !== '' || typeof m.msg_data?.body !== 'string') return null;
    let hash: string;
    try { hash = toHex(tonNormalizedHash(tonParseAddress(intent.from), tonParseBoc(Buffer.from(m.msg_data.body, 'base64')))); } catch { return null; }
    if (hash !== txid) return null;
    const outs = Array.isArray(t.out_msgs) ? t.out_msgs : [];
    const outcome = outs.length === 0 ? 'nothing' : outs.length === 1 && sameTransfer(outs[0]!.destination, outs[0]!.value, intent) ? 'sent' : 'mismatch';
    return { lt: nat(t.transaction_id.lt, 'lt').toString(), hash: b64ToHex(t.transaction_id.hash, 'transaction hash'), outcome };
  };
  const findTa = async (txid: string, intent: any): Promise<Found | null> => {
    const t = await ta<TaTx>(`/blockchain/messages/${txid}/transaction`, { missing: true });
    if (t === null) return null;
    if (t.in_msg?.msg_type !== 'ext_in_msg' || typeof t.account?.address !== 'string' || t.account.address.toLowerCase() !== tonRawAddress(intent.from)) throw new Error('tonapi: answered with another transaction');
    const outs = Array.isArray(t.out_msgs) ? t.out_msgs : [];
    const outcome = outs.length === 0 ? 'nothing' : t.success === true && t.aborted === false && outs.length === 1 && sameTransfer(outs[0]!.destination?.address, outs[0]!.value, intent) ? 'sent' : 'mismatch';
    return { lt: nat(t.lt, 'lt').toString(), hash: hex64(t.hash, 'transaction hash'), outcome };
  };
  /** TON Center: the exact transaction when its position is known, otherwise a scan of the wallet's latest transactions */
  const findTc = async (txid: string, intent: any, hint: Found | null): Promise<Found | null> => {
    const q = `/getTransactions?address=${tonRawAddress(intent.from)}`;
    const list = await tc<TcTx[]>(hint ? `${q}&limit=1&lt=${hint.lt}&hash=${hint.hash}` : `${q}&limit=30`);
    if (!Array.isArray(list)) throw new Error('toncenter: bad transaction list');
    for (const t of list) { const f = matchTc(t, txid, intent); if (f) return f; }
    return null;
  };

  let identity = false;
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const h = await headOf(url); // verifies the zero-state hash on every check
          if (h.time !== null && Date.now() / 1000 - h.time > STALE_SEC) throw new Error('stale');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: h.seqno as number | null };
        } catch { verifiedAt.delete(url); return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const heads = endpoints.map((e) => e.h ?? 0);
      const ok = endpoints.every((e) => e.ok) && Math.max(...heads) - Math.min(...heads) <= MAX_MC_GAP;
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...heads) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      const raw = tonRawAddress(addr);
      return { native: await any(async (u) => (u === TC ? nat(await tc<string>(`/getAddressBalance?address=${raw}`), 'balance') : nat((await accountTa(raw)).balance, 'balance'))) };
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only Toncoin can be sent on TON in this version');
      let to: Uint8Array;
      try { to = tonParseAddress(d.to); if (tonNormalizeAddress(d.from) !== d.from || tonNormalizeAddress(d.to) !== d.to) throw new Error('address is not in canonical form'); }
      catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      let comment: Uint8Array | undefined;
      try { comment = d.memo === undefined ? undefined : tonCommentBytes(d.memo); } catch (e) { throw new UserError('bad_memo', (e as Error).message); }
      const warnings: string[] = [];
      await ensureIdentity();

      // one snapshot per source; both must answer and agree on everything that ends up in the signed message
      const toRaw = tonRawAddress(d.to);
      const [a, b] = await both(
        async () => {
          const src = await walletTc(d.from);
          const dst = await tc<{ state: string; sync_utime: number; block_id: { seqno: number } }>(`/getAddressInformation?address=${toRaw}`);
          return { src, dst: stateOf(dst.state), time: int(dst.sync_utime, 'time'), mc: int(dst.block_id?.seqno, 'seqno') };
        },
        async () => {
          const head = await taMust<{ seqno: number; gen_utime: number }>('/blockchain/masterchain-head');
          const src = await walletTa(d.from);
          const dst = await accountTa(toRaw);
          return { src, dst: stateOf(dst.status), time: int(head.gen_utime, 'time'), mc: int(head.seqno, 'seqno') };
        }, 'account state');

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(a.mc - b.mc) > MAX_MC_GAP) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same block; transfer refused`, 503);
      for (const s of [a, b]) if (Math.abs(now - s.time) > MAX_CLOCK_SKEW_SEC) throw new UserError('rpc_degraded', `${n.name} chain time and server clock differ; transfer refused`, 503);
      const src = agree(a.src, b.src, 'wallet state');
      const dst = agree(a.dst, b.dst, 'destination account');

      if (src.state === 'frozen') throw new UserError('unsupported_account', 'this TON wallet is frozen (unpaid storage fees); it cannot send');
      if (dst === 'frozen') throw new UserError('bad_destination', 'the destination account is frozen; a transfer to it would be lost or returned');
      const balance = BigInt(src.balance);
      if (balance === 0n) throw new UserError('insufficient_funds', `this ${n.name} wallet holds no ${n.native.symbol}`);
      if (balance < d.amount + FEE_FLOOR) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol}: ${formatUnits(balance, 9)} available for amount plus network fee`);
      const stateInit = src.state !== 'active'; // no contract yet: this message must deploy it
      const bounce = dst === 'active'; // nothing at the destination to refuse the coins: they must not be bounced back
      if (stateInit) warnings.push('deploys_wallet');
      if (!bounce) warnings.push('destination_not_initialized');

      const validUntil = now + VALIDITY_SEC;
      let feeEstimate: bigint;
      if (stateInit) feeEstimate = DEPLOY_FEE_ESTIMATE + 10_000n * BigInt(comment?.length ?? 0);
      else {
        // same message as the one that will be signed, with an all-zero signature
        const body = tonSignedBody(tonSigningMessage({ to, amount: d.amount, comment, seqno: src.seqno, validUntil, bounce }), new Uint8Array(64));
        const from = tonParseAddress(d.from);
        const [fees, sim] = await both(
          async () => {
            const f = (await tc<{ source_fees: Record<string, unknown> }>('/estimateFee', { address: tonRawAddress(d.from), body: bocOf(body), ignore_chksig: true })).source_fees ?? {};
            return { inFwd: nat(f.in_fwd_fee, 'fee'), storage: nat(f.storage_fee, 'fee'), gas: nat(f.gas_fee, 'fee'), fwd: nat(f.fwd_fee, 'fee') };
          },
          async () => {
            let trace: TaTrace | undefined;
            try { trace = (await ta<{ trace: TaTrace }>('/wallet/emulate', { post: { boc: bocOf(tonExternalMessage(from, body)) } }))!.trace; }
            catch (e) { // 4xx with a reason = the emulator refused the message itself
              const st = (e as { status?: number }).status ?? 0;
              if (st >= 400 && st < 500 && st !== 429 && (e as { detail?: string }).detail) throw new UserError('simulation_failed', `simulation: ${(e as { detail: string }).detail.slice(0, 200)}`);
              throw e;
            }
            const t = trace?.transaction, sent = trace?.children ?? [], child = sent[0]?.transaction;
            if (!t || typeof t.success !== 'boolean' || !Array.isArray(sent)) throw new Error('tonapi: bad emulation result');
            let value: bigint | null = null;
            try { value = nat(child?.in_msg?.value, 'value'); } catch { /* no usable child message */ }
            const sends = t.success === true && t.aborted === false && t.action_phase?.success === true && t.action_phase.total_actions === 1 && t.action_phase.skipped_actions === 0
              && sent.length === 1 && child?.account?.address?.toLowerCase() === toRaw && child.in_msg?.bounce === bounce && value === d.amount;
            return { sends, returned: child?.aborted === true };
          }, 'fee estimate and simulation');
        // estimateFee has no verdict of its own: gas and a forwarding fee are only charged when the wallet accepted the message and emitted the transfer
        if (fees.gas === 0n || fees.fwd === 0n || !sim.sends) throw new UserError('simulation_failed', 'simulation: the wallet would not send this transfer');
        if (bounce && sim.returned) throw new UserError('simulation_failed', 'simulation: the destination contract rejects a plain transfer (it would be returned, minus fees)');
        feeEstimate = fees.inFwd + fees.storage + fees.gas + fees.fwd;
      }
      if (feeEstimate > FEE_CAP) throw new UserError('fee_too_high', `${n.name} network fee estimate is abnormally high (${formatUnits(feeEstimate, 9)} ${n.native.symbol}); transfer refused`, 503);
      const want = 3n * feeEstimate;
      const maxFee = want > FEE_CAP ? FEE_CAP : want < FEE_FLOOR ? FEE_FLOOR : want;
      // send mode 3 ignores a failed action: an underfunded wallet would pay the fee and send nothing. Refuse here instead.
      if (balance < d.amount + maxFee) throw new UserError('insufficient_funds',
        `insufficient ${n.native.symbol}: ${formatUnits(balance, 9)} available for amount plus network fee budget (${formatUnits(maxFee, 9)})`);

      return { section: { x: { seqno: String(src.seqno), validUntil: String(validUntil), bounce: bounce ? '1' : '0', sendMode: String(TON_SEND_MODE), stateInit: stateInit ? '1' : '0' } }, maxFee, feeEstimate, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const m = tonReadExternal(raw);
      const rs = await Promise.allSettled([tc<unknown>('/sendBoc', { boc: raw }), ta<unknown>('/blockchain/message', { post: { boc: raw } })]);
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // "already known": once included, a re-submission is refused by the wallet (wrong seqno); the chain is the judge
      const intent = { from: tonNormalizeAddress('0:' + toHex(m.accountId)), to: '', amount: '0' };
      const known = await Promise.allSettled([findTa(m.txid, intent), findTc(m.txid, intent, null)]);
      if (known.some((k) => k.status === 'fulfilled' && k.value !== null)) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const i = p.intent, validUntil = Number(i?.x?.validUntil), seqno = Number(i?.x?.seqno);
      if (!Number.isSafeInteger(validUntil) || validUntil <= 0 || !Number.isSafeInteger(seqno) || !/^[0-9a-f]{64}$/.test(p.txid)) throw new Error('intent has no valid_until');
      // TonAPI finds by message hash; TON Center (anchored to the masterchain) is then asked for that exact transaction, or scanned
      const viaTa = await findTa(p.txid, i).then((v) => ({ up: true, v }), (e) => { if (/another transaction/.test((e as Error).message)) throw e; return { up: false, v: null }; });
      const viaTc = await findTc(p.txid, i, viaTa.v).then((v) => ({ up: true, v }), () => ({ up: false, v: null as Found | null }));
      const tcFound = viaTc.v, taFound = viaTa.v;
      if (tcFound && taFound && (tcFound.lt !== taFound.lt || tcFound.hash !== taFound.hash || tcFound.outcome !== taFound.outcome)) throw new Error('data sources disagree on the transaction result');
      const f = tcFound ?? taFound;
      if (f) {
        const blockRef = f.lt;
        // the message is ours (its hash commits to the signed body), so its only possible effects are this transfer or nothing
        if (f.outcome === 'mismatch') throw new Error('data source reports an effect that does not match the approved transfer');
        // final = part of the account's transaction chain as served by a liteserver (committed by a masterchain block),
        // and confirmed by the second source whenever it is reachable
        if (!tcFound || (viaTa.up && !taFound)) return { state: 'confirming', confirmations: 0, blockRef };
        if (f.outcome === 'sent') return { state: 'finalized', confirmations: 1, blockRef };
        if (!taFound) return { state: 'confirming', confirmations: 1, blockRef }; // a failure verdict needs both sources
        return { state: 'failed', confirmations: 0, blockRef, error: 'accepted by the wallet contract but the transfer was not carried out; only the network fee was charged, no funds moved' };
      }
      const now = Date.now() / 1000;
      if (now <= validUntil + EXPIRY_MARGIN_SEC || !viaTa.up || !viaTc.up) return { state: 'broadcast', confirmations: 0, rebroadcast: now <= validUntil };
      // Expired locally. "Not included, and never will be" needs, on both sources, chain time past valid_until and a wallet
      // whose sequence number is still the one this message was signed for (inclusion would have advanced it).
      const rs = await Promise.allSettled([
        (async () => {
          const acc = await tc<{ state: string; data: string; code: string; block_id: { seqno: number } }>(`/getAddressInformation?address=${tonRawAddress(i.from)}`);
          const hdr = await tc<{ gen_utime: number }>(`/getBlockHeader?workchain=-1&shard=${MC_SHARD}&seqno=${int(acc.block_id?.seqno, 'seqno')}`);
          const cur = stateOf(acc.state) === 'active' ? walletSeqno(i.from, Buffer.from(acc.code, 'base64'), Buffer.from(acc.data, 'base64')) : 0;
          return { time: int(hdr.gen_utime, 'time'), seqno: cur };
        })(),
        (async () => {
          const head = await taMust<{ gen_utime: number }>('/blockchain/masterchain-head');
          return { time: int(head.gen_utime, 'time'), seqno: (await walletTa(i.from)).seqno };
        })(),
      ]);
      if (rs.every((r) => r.status === 'fulfilled' && r.value.time > validUntil + EXPIRY_MARGIN_SEC && r.value.seqno === seqno))
        return { state: 'failed', confirmations: 0, error: 'not included before valid_until; no funds moved' };
      return { state: 'broadcast', confirmations: 0, rebroadcast: false };
    },

    async deposits(addr, cursor) {
      const raw = tonRawAddress(addr);
      const fromOf = (s: string) => { try { return tonNormalizeAddress(s); } catch { return s; } };
      // an inbound message with value that the wallet kept: a bounced-back or forwarded one has an outgoing message
      const item = (lt: string, hash: string, time: number, value: bigint, from: string, outs: number): Deposit[] =>
        value > 0n && outs === 0 ? [{ txid: hash, idx: 0, asset: 'native', amount: value, from: fromOf(from), block: Number(lt), time }] : [];
      return any(async (u) => {
        const items: Deposit[] = [], seen = new Set<string>();
        let top = cursor ?? 0;
        if (u === TC) {
          // newest first, from the account state at the latest masterchain block down to the cursor
          let page = `/getTransactions?address=${raw}&limit=50${cursor === null ? '' : `&to_lt=${cursor}`}`;
          for (let k = 0; ; k++) {
            const list = await tc<TcTx[]>(page);
            if (!Array.isArray(list)) throw new Error('toncenter: bad transaction list');
            for (const t of list) {
              const lt = nat(t.transaction_id.lt, 'lt').toString(), m = t.in_msg;
              if (Number(lt) <= (cursor ?? -1) || seen.has(lt)) continue;
              seen.add(lt);
              top = Math.max(top, Number(lt));
              if (m && m.source !== '') items.push(...item(lt, b64ToHex(t.transaction_id.hash, 'transaction hash'), int(t.utime, 'time'), nat(m.value, 'value'), m.source, Array.isArray(t.out_msgs) ? t.out_msgs.length : 1));
            }
            if (cursor === null || list.length < 50) break;
            if (k === 4) throw new Error('toncenter: too many new transactions for one scan'); // let the other source page forward
            const last = list[list.length - 1]!.transaction_id;
            page = `/getTransactions?address=${raw}&limit=50&to_lt=${cursor}&lt=${nat(last.lt, 'lt')}&hash=${b64ToHex(last.hash, 'transaction hash')}`;
          }
          return { items, cursor: top, finalizedHeight: top };
        }
        // TonAPI (indexer): oldest first after the cursor; the last seconds are left for the next scan
        const head = await taMust<{ gen_utime: number }>('/blockchain/masterchain-head');
        const settled = int(head.gen_utime, 'time') - 15;
        const path = `/blockchain/accounts/${raw}/transactions`;
        const take = (list: TaTx[]): boolean => {
          for (const t of list) {
            const lt = nat(t.lt, 'lt').toString(), m = t.in_msg;
            if (int(t.utime, 'time') > settled) return false;
            top = Math.max(top, Number(lt));
            if (m?.msg_type === 'int_msg' && m.source) items.push(...item(lt, hex64(t.hash, 'transaction hash'), t.utime, nat(m.value, 'value'), m.source.address, Array.isArray(t.out_msgs) ? t.out_msgs.length : 1));
          }
          return true;
        };
        if (cursor === null) {
          const list = (await ta<{ transactions: TaTx[] }>(`${path}?limit=50&sort_order=desc`, { missing: true }))?.transactions ?? [];
          take([...list].reverse());
        } else {
          for (let k = 0; k < 5; k++) {
            const list = (await ta<{ transactions: TaTx[] }>(`${path}?limit=100&sort_order=asc&after_lt=${top}`, { missing: true }))?.transactions ?? [];
            if (!take(list) || list.length < 100) break;
          }
        }
        return { items, cursor: top, finalizedHeight: top };
      });
    },
  };
}
