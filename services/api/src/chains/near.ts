/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/near.ts
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

// NEAR adapter: two independent JSON-RPC sources (n.rpc). Everything that feeds the signature (access key nonce, reference
// block hash) or decides whether a transfer is proposed (balances, destination existence, protocol fee parameters) is read from
// both at one agreed FINAL block and must be identical, or the transfer is refused.
//
// NEAR has no pre-signature simulation endpoint: prepare() checks the documented failure causes instead (source account and
// full-access key present, balance after the upfront gas purchase and the storage requirement, destination existence).
// A NEAR transaction does not state its fee; see packages/core/src/plugins/near.ts for the worst-case bound (maxFee).
//
// Public RPC nodes keep about a day of history and there is no history index in the protocol. Incoming transfers are therefore
// discovered through FastNEAR's keyless Transfers API and every row is re-verified against RPC before it is reported; lookups
// that the two regular sources can no longer answer fall back to FastNEAR's keyless archival RPC (display and tracking only).
import {
  formatUnits, NEAR_GAS_BOUND_IMPLICIT, NEAR_GAS_BOUND_NAMED, NEAR_MAX_GAS_PRICE, nearAccountKind, nearDecodeHash, nearFeeCeiling, nearSignedTxInfo, type NetworkDef,
} from '@spw/core';
import { base58 } from '@scure/base';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

export const NEAR_ARCHIVAL_RPC = 'https://archival-rpc.mainnet.fastnear.com';
export const NEAR_TRANSFERS_API = 'https://transfers.main.fastnear.com/v0/transfers';

/** approval window, seconds */
const TTL_SEC = 120;
/** the two sources may be this many blocks apart (≈ 0.6 s each); the agreed final block may be this old */
const MAX_FINAL_GAP = 100, MAX_BLOCK_AGE_SEC = 90, MAX_CLOCK_SKEW_SEC = 60, STALE_SEC = 120;
/** a transaction is valid while the chain is at most this many blocks past its reference block (genesis transaction_validity_period) */
const VALIDITY_BLOCKS = 86_400, EXPIRY_MARGIN_BLOCKS = 100;
/** accounts using at most this many bytes need no balance for storage (NEP-448; nearcore runtime verifier) */
const ZERO_BALANCE_STORAGE = 770n;
/** deposits: rows re-read behind the final block on every scan (the index may lag), pages of 100 per scan */
const SCAN_OVERLAP_BLOCKS = 3000, SCAN_PAGES = 10, FIRST_SCAN_ROWS = 20;
/** regular nodes keep roughly a day of blocks; older rows are looked up on the archival node first */
const RECENT_BLOCKS = 80_000;
/** a row that no source can verify is retried on every scan until it is this far behind the final block (≈ 3 days) */
const GIVE_UP_BLOCKS = 430_000;

interface Header { height: number; hash: string; time: number; gasPrice: bigint }
interface AccountView { amount: string; locked: string; storage_usage: number }
interface KeyView { nonce: number; permission: unknown }
interface Fee { send_not_sir: number; execution: number }
interface TxView {
  final_execution_status: string; status: Record<string, unknown>;
  transaction: { hash: string; signer_id: string; receiver_id: string; nonce: number; actions: unknown[] };
  transaction_outcome: { block_hash: string };
  receipts?: { predecessor_id: string; receiver_id: string; receipt_id: string; receipt: { Action?: { actions: unknown[] } } }[];
  receipts_outcome: { id: string; block_hash: string; outcome: { executor_id: string; status: Record<string, unknown> } }[];
}
interface TransferRow { block_height: string; transaction_id: string | null; receipt_id: string; signer_id: string; account_id: string; asset_id: string }

/** an answer from the node itself (not a transport failure); `kind` is nearcore's error cause, e.g. UNKNOWN_ACCOUNT */
class NearRpcError extends Error { constructor(public kind: string, message: string, public data: unknown) { super(message); } }
const isKind = (e: unknown, kind: string) => e instanceof NearRpcError && e.kind === kind;

let idc = 0;
async function call<T>(url: string, method: string, params: unknown): Promise<T> {
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  const j = (await r.json().catch(() => null)) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: unknown } } } | null;
  if (!j || typeof j !== 'object') throw new Error(`near rpc http ${r.status}`);
  if (j.error) {
    const kind = j.error.cause?.name;
    if (typeof kind === 'string' && r.status !== 429) throw new NearRpcError(kind, `${kind}: ${typeof j.error.data === 'string' ? j.error.data : JSON.stringify(j.error.data ?? '')}`.slice(0, 300), j.error.data);
    throw new Error(`near rpc: ${String(j.error.message ?? r.status).slice(0, 120)}`);
  }
  if (!r.ok || j.result === undefined || j.result === null) throw new Error(`near rpc http ${r.status}`);
  return j.result;
}

const uint = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' ? !Number.isSafeInteger(v) || v < 0 : typeof v !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(v)) throw new Error(`near rpc: bad ${what}`);
  return BigInt(v as string | number);
};
const hashOf = (v: unknown, what: string): string => { try { nearDecodeHash(v as string); } catch { throw new Error(`near rpc: bad ${what}`); } return v as string; };
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const near = (v: bigint) => formatUnits(v > 0n ? v : 0n, 24);
/** sum of the deposits when every action is a plain Transfer; null otherwise */
function transferSum(actions: unknown): bigint | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  let sum = 0n;
  for (const a of actions) {
    const t = (a as { Transfer?: { deposit?: unknown } } | null)?.Transfer;
    if (!a || typeof a !== 'object' || Object.keys(a).length !== 1 || !t) return null;
    sum += uint(t.deposit, 'deposit');
  }
  return sum;
}
const succeeded = (status: Record<string, unknown> | undefined) => !!status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status);

export function nearAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc;
  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => { let last: unknown; for (const u of sources) { try { return await f(u); } catch (e) { last = e; } } throw last; };
  /** every source must answer */
  const all = async <T>(f: (u: string) => Promise<T>, what: string): Promise<T[]> => {
    const rs = await Promise.allSettled(sources.map(f));
    const bad = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (bad?.reason instanceof UserError) throw bad.reason;
    if (sources.length < 2 || bad) throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    return rs.map((r) => (r as PromiseFulfilledResult<T>).value);
  };
  const agree = <T>(vals: T[], what: string): T => {
    for (const v of vals) if (JSON.stringify(v) !== JSON.stringify(vals[0])) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (${what}); transfer refused`, 503);
    return vals[0]!;
  };

  /** node status; throws unless the node is on this network (chain id and genesis hash) and synced */
  const status = async (u: string): Promise<{ height: number; time: number }> => {
    const s = await call<{ chain_id?: string; genesis_hash?: string; sync_info?: { latest_block_height?: number; latest_block_time?: string; syncing?: boolean } }>(u, 'status', []);
    if (s.chain_id !== 'mainnet' || s.genesis_hash !== n.chainRef) throw new Error('chain identity mismatch');
    const height = Number(uint(s.sync_info?.latest_block_height, 'height')), time = Date.parse(String(s.sync_info?.latest_block_time));
    if (s.sync_info?.syncing !== false || !Number.isFinite(time) || height <= 0) throw new Error('node is syncing');
    return { height, time: Math.floor(time / 1000) };
  };
  const header = async (u: string, ref: { finality: 'final' } | { block_id: string | number }): Promise<Header> => {
    const b = await call<{ header?: { height?: number; hash?: string; timestamp_nanosec?: string; gas_price?: string } }>(u, 'block', ref);
    const h = b.header;
    const height = Number(uint(h?.height, 'height')), gasPrice = uint(h?.gas_price, 'gas price');
    if (height <= 0) throw new Error('near rpc: bad height');
    return { height, hash: hashOf(h?.hash, 'block hash'), time: Number(uint(h?.timestamp_nanosec, 'timestamp') / 1_000_000_000n), gasPrice };
  };
  const account = async (u: string, id: string, ref: object): Promise<{ amount: string; locked: string; storage: string } | null> => {
    try {
      const a = await call<AccountView>(u, 'query', { request_type: 'view_account', account_id: id, ...ref });
      return { amount: uint(a.amount, 'balance').toString(), locked: uint(a.locked, 'locked balance').toString(), storage: uint(a.storage_usage, 'storage usage').toString() };
    } catch (e) { if (isKind(e, 'UNKNOWN_ACCOUNT')) return null; throw e; }
  };
  /** the wallet's own access key (an implicit account's key is its account id); null when the account or the key does not exist */
  const accessKey = async (u: string, id: string, ref: object): Promise<{ nonce: string; fullAccess: boolean } | null> => {
    const publicKey = 'ed25519:' + base58.encode(Uint8Array.from(id.match(/../g)!, (h) => parseInt(h, 16)));
    try {
      const k = await call<KeyView & { error?: unknown }>(u, 'query', { request_type: 'view_access_key', account_id: id, public_key: publicKey, ...ref });
      if (k.error !== undefined) { if (/does not exist/.test(String(k.error))) return null; throw new Error('near rpc: access key query failed'); }
      return { nonce: uint(k.nonce, 'nonce').toString(), fullAccess: k.permission === 'FullAccess' };
    } catch (e) { if (isKind(e, 'UNKNOWN_ACCESS_KEY') || isKind(e, 'UNKNOWN_ACCOUNT')) return null; throw e; }
  };
  /** the protocol parameters that decide the cost of a transfer, as strings (compared across sources) */
  const paramCache = new Map<string, { at: number; v: Record<string, string> }>();
  const params = async (u: string, ref: object): Promise<Record<string, string>> => {
    const c = paramCache.get(u);
    if (c && Date.now() - c.at < 600_000) return c.v;
    const p = await call<{ transaction_validity_period?: number; runtime_config?: { storage_amount_per_byte?: string; min_gas_purchase_price?: string; account_creation_charge?: string;
      transaction_costs?: { action_receipt_creation_config?: Fee; action_creation_config?: { transfer_cost?: Fee; create_account_cost?: Fee; add_key_cost?: { full_access_cost?: Fee } } } } }>(u, 'EXPERIMENTAL_protocol_config', ref);
    const rc = p.runtime_config, tc = rc?.transaction_costs, ac = tc?.action_creation_config;
    const fee = (f: Fee | undefined, what: string) => ({ [`${what}.send`]: uint(f?.send_not_sir, what).toString(), [`${what}.exec`]: uint(f?.execution, what).toString() });
    const v = {
      validity: uint(p.transaction_validity_period, 'validity period').toString(), storagePerByte: uint(rc?.storage_amount_per_byte, 'storage price').toString(),
      minGasPurchasePrice: uint(rc?.min_gas_purchase_price, 'minimum gas purchase price').toString(), accountCreationCharge: uint(rc?.account_creation_charge, 'account creation charge').toString(),
      ...fee(tc?.action_receipt_creation_config, 'receipt'), ...fee(ac?.transfer_cost, 'transfer'), ...fee(ac?.create_account_cost, 'createAccount'), ...fee(ac?.add_key_cost?.full_access_cost, 'addKey'),
    };
    paramCache.set(u, { at: Date.now(), v });
    return v;
  };
  /** transaction lookup; null only for the node's own "unknown transaction" answer */
  const txStatus = async (u: string, txid: string, sender: string, withReceipts = false): Promise<TxView | null> => {
    try {
      const t = await call<TxView>(u, withReceipts ? 'EXPERIMENTAL_tx_status' : 'tx', { tx_hash: txid, sender_account_id: sender, wait_until: 'NONE' });
      if (t.transaction?.hash !== txid || t.transaction.signer_id !== sender || typeof t.final_execution_status !== 'string' || !Array.isArray(t.receipts_outcome)) throw new Error('near rpc: bad transaction record');
      return t;
    } catch (e) { if (isKind(e, 'UNKNOWN_TRANSACTION')) return null; throw e; }
  };
  const baseHeights = new Map<string, number>(), trackMemo = new Map<string, { at: number; v: Tracked }>(), verified = new Map<string, Deposit | null>();

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const s = await status(url); // verifies chain id and genesis hash on every check
          if (Date.now() / 1000 - s.time > STALE_SEC) throw new Error('stale');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: s.height as number | null };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.length >= 2 && endpoints.every((e) => e.ok);
      return { network: n.id, ok, readable: endpoints.some((e) => e.ok), identityVerified: ok, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      const a = await any((u) => account(u, addr, { finality: 'final' }));
      return { native: a ? BigInt(a.amount) : 0n }; // an implicit account that never received NEAR does not exist and holds nothing
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only NEAR can be sent on NEAR Protocol in this version');
      let kind: 'implicit' | 'named';
      try { if (nearAccountKind(d.from) !== 'implicit') throw new Error('the source must be an implicit account'); kind = nearAccountKind(d.to); }
      catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      if (d.memo !== undefined) throw new UserError('bad_memo', 'NEAR transfers do not carry a memo');
      const warnings: string[] = [];

      // 1. both sources are on mainnet (chain id + genesis hash) and report a final block; the older of the two is the reference
      const heads = await all(async (u) => { await status(u); return header(u, { finality: 'final' }); }, 'final block');
      const ref = heads.reduce((a, b) => (b.height < a.height ? b : a));
      if (Math.max(...heads.map((h) => h.height)) - ref.height > MAX_FINAL_GAP) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same block; transfer refused`, 503);
      const now = Math.floor(Date.now() / 1000);
      if (now - ref.time > MAX_BLOCK_AGE_SEC || ref.time - now > MAX_CLOCK_SKEW_SEC) throw new UserError('rpc_degraded', `${n.name} data sources are behind (or the server clock is off); transfer refused`, 503);
      // 2. every source has that exact block at that height on its canonical chain (so it is final everywhere)
      const canon = await all(async (u) => (await header(u, { block_id: ref.height })).hash, 'reference block');
      if (canon.some((h) => h !== ref.hash)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (reference block); transfer refused`, 503);
      // 3. one snapshot per source, all at the reference block; they must be identical
      const at = { block_id: ref.hash };
      const snap = agree(await all(async (u) => {
        const [src, key, dst, p] = await Promise.all([account(u, d.from, at), accessKey(u, d.from, at), account(u, d.to, at), params(u, at)]);
        return { src, key, dstExists: dst !== null, p };
      }, 'account state'), 'account state');

      const { src, key, p } = snap;
      if (!src) throw new UserError('insufficient_funds', `this ${n.name} account is not activated yet: it exists on-chain only after it first receives ${n.native.symbol}`);
      if (!key || !key.fullAccess) throw new UserError('unsupported_account', 'the key of this wallet is not a full-access key of its NEAR account; it cannot send');
      if (kind === 'named' && !snap.dstExists) throw new UserError('bad_destination', `the account ${d.to} does not exist on ${n.name}: a transfer to it would fail. Check the name.`);
      const creates = kind === 'implicit' && !snap.dstExists;
      if (creates) warnings.push('near_creates_account');

      // protocol parameters: the live costs must stay within the bounds the signer enforces (see the plugin)
      const g = (k: string) => BigInt(p[k]!);
      const send = g('receipt.send') + g('transfer.send') + (kind === 'implicit' ? g('createAccount.send') + g('addKey.send') : 0n);
      const exec = g('receipt.exec') + g('transfer.exec') + (kind === 'implicit' ? g('createAccount.exec') + g('addKey.exec') : 0n);
      const gasPrice = ref.gasPrice, minBuy = g('minGasPurchasePrice');
      if (send + exec > (kind === 'implicit' ? NEAR_GAS_BOUND_IMPLICIT : NEAR_GAS_BOUND_NAMED) || gasPrice <= 0n || gasPrice > NEAR_MAX_GAS_PRICE || minBuy > NEAR_MAX_GAS_PRICE || g('validity') !== BigInt(VALIDITY_BLOCKS))
        throw new UserError('rpc_degraded', `${n.name} fee parameters changed on-chain; the wallet must be updated before sending`, 503);
      const maxFee = nearFeeCeiling(d.to);

      // what the network takes when it accepts the transaction: gas burnt now at the block price, the rest bought at
      // max(block price, minimum purchase price) and partly refunded later. Checked with the price doubled as headroom.
      const price = gasPrice * 2n > NEAR_MAX_GAS_PRICE ? NEAR_MAX_GAS_PRICE : gasPrice * 2n;
      const upfront = send * price + exec * max(price, minBuy);
      const storage = BigInt(src.storage);
      const reserve = storage <= ZERO_BALANCE_STORAGE ? 0n : max(0n, storage * g('storagePerByte') - BigInt(src.locked));
      const spendable = BigInt(src.amount) - reserve - upfront;
      if (spendable < d.amount) throw new UserError('insufficient_funds',
        `insufficient ${n.native.symbol}: ${near(spendable)} can be sent (${near(upfront)} is set aside for the network fee${reserve > 0n ? `, ${near(reserve)} stays locked for account storage` : ''})`);

      // expected final cost after refunds: all gas at the block price, plus the account creation charge when the transfer creates the account
      const createExecCost = g('createAccount.exec') * gasPrice;
      const estimate = (send + exec) * gasPrice + (creates ? max(0n, g('accountCreationCharge') - createExecCost) : 0n);
      const nonce = BigInt(key.nonce) + 1n;
      return { section: { x: { nonce: nonce.toString(), blockHash: ref.hash } }, maxFee, feeEstimate: estimate > maxFee ? maxFee : estimate, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const { txid, signerId } = nearSignedTxInfo(raw);
      // INCLUDED: the node validates the transaction first (and reports why it refuses it), then answers once it is in a block.
      // Re-sending an included transaction is answered as success by the node itself.
      const rs = await Promise.allSettled(sources.map(async (u) => {
        try { await call<unknown>(u, 'send_tx', { signed_tx_base64: raw, wait_until: 'INCLUDED' }); }
        catch (e) {
          if (isKind(e, 'TIMEOUT_ERROR')) return; // accepted, not in a block yet
          if (e instanceof NearRpcError) throw new Error(`rejected by the network: ${e.message}`);
          throw e;
        }
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // "already known": the chain is the judge
      const known = await Promise.allSettled(sources.map((u) => txStatus(u, txid, signerId)));
      if (known.some((k) => k.status === 'fulfilled' && k.value !== null)) return;
      const reasons = rs.map((r) => String((r as PromiseRejectedResult).reason?.message ?? 'broadcast failed'));
      throw new Error(reasons.find((m) => m.startsWith('rejected')) ?? reasons[0]);
    },

    async track(p): Promise<Tracked> {
      const from = String(p.intent?.from ?? ''), to = String(p.intent?.to ?? ''), x = p.intent?.x ?? {};
      if (!/^[1-9]\d{0,19}$/.test(String(x.nonce)) || nearAccountKind(from) !== 'implicit') throw new Error('intent has no NEAR parameters');
      const txNonce = BigInt(x.nonce), refHash = hashOf(x.blockHash, 'reference block');
      const memo = trackMemo.get(p.txid);
      if (memo && Date.now() - memo.at < 60_000) return memo.v;
      trackMemo.delete(p.txid);

      const verdict = (t: TxView): { final: boolean; ok: boolean | null; blockRef: string; error?: string } => {
        if (t.transaction.receiver_id !== to || transferSum(t.transaction.actions)?.toString() !== String(p.intent.amount)) throw new Error('near rpc: transaction does not match the approved intent');
        const failure = (t.status as { Failure?: unknown } | undefined)?.Failure;
        return { final: t.final_execution_status === 'FINAL', ok: failure !== undefined ? false : t.status && 'SuccessValue' in t.status ? true : null,
          blockRef: hashOf(t.transaction_outcome?.block_hash, 'block hash'), ...(failure !== undefined ? { error: JSON.stringify(failure).slice(0, 160) } : {}) };
      };
      const FAILED_TEXT = 'included in a block but the transfer failed; the amount was returned to this wallet, only the network fee was charged';

      // per source: final block FIRST, then the lookup — a miss then covers every block up to that position
      const rs = await Promise.allSettled(sources.map(async (u) => { const head = await header(u, { finality: 'final' }); const t = await txStatus(u, p.txid, from); return { u, head, v: t ? verdict(t) : null }; }));
      const up = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const allUp = up.length === sources.length && up.length >= 2;
      const found = up.filter((s) => s.v !== null);
      if (found.length > 0) {
        const v = found[0]!.v!;
        // success or failure is only announced once every reachable source shows the same final result
        if (found.length < up.length || found.some((s) => !s.v!.final || s.v!.ok === null || s.v!.ok !== v.ok)) return { state: 'confirming', confirmations: 1, blockRef: v.blockRef };
        if (v.ok) return { state: 'finalized', confirmations: n.minConf, blockRef: v.blockRef };
        if (!allUp) return { state: 'confirming', confirmations: 1, blockRef: v.blockRef };
        return { state: 'failed', confirmations: 0, blockRef: v.blockRef, error: `${FAILED_TEXT} (${v.error})` };
      }
      // once seen in a block and now unknown again: the block was not kept (the state machine has a name for that)
      const pending: Tracked = { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true };
      if (!allUp) return pending;

      // Unknown to both sources. The access key nonce tells whether it can still be, or ever was, included:
      // an included transaction sets the key's nonce to its own, and a nonce is never accepted twice.
      const keys = await Promise.allSettled(sources.map((u) => accessKey(u, from, { finality: 'final' })));
      if (keys.some((k) => k.status === 'rejected')) return pending;
      const nonces = keys.map((k) => { const v = (k as PromiseFulfilledResult<{ nonce: string } | null>).value; return v ? BigInt(v.nonce) : null; });
      const age = Date.now() / 1000 - p.broadcastAt;
      const remember = (v: Tracked): Tracked => { if (age > 300) { trackMemo.set(p.txid, { at: Date.now(), v }); if (trackMemo.size > 200) trackMemo.delete(trackMemo.keys().next().value!); } return v; };
      if (nonces.some((k) => k !== null && k >= txNonce)) {
        // The nonce is used: by this transaction (included, but the regular nodes no longer keep it) or by another one.
        if (age < 120) return pending;
        let old: TxView | null;
        try { old = await txStatus(NEAR_ARCHIVAL_RPC, p.txid, from); } catch { return remember({ ...pending, rebroadcast: false }); }
        if (old) {
          const v = verdict(old);
          if (!v.final || v.ok === null) return { state: 'confirming', confirmations: 1, blockRef: v.blockRef };
          return v.ok ? { state: 'finalized', confirmations: n.minConf, blockRef: v.blockRef } : { state: 'failed', confirmations: 0, blockRef: v.blockRef, error: `${FAILED_TEXT} (${v.error})` };
        }
        return { state: p.blockRef ? 'failed' : 'replaced', confirmations: 0, error: 'its nonce was used by another transaction of this account; it can no longer be included and moved no funds' };
      }
      // The nonce is unused on both sources at a final block: the transaction has not been included. It can no longer be once
      // the chain is past its reference block by the validity period.
      let base = baseHeights.get(refHash);
      if (base === undefined) {
        const hs = await Promise.allSettled(sources.map((u) => header(u, { block_id: refHash })));
        const ok = hs.flatMap((h) => (h.status === 'fulfilled' ? [h.value.height] : []));
        if (ok.length === sources.length && ok.every((h) => h === ok[0])) { base = ok[0]!; baseHeights.set(refHash, base); if (baseHeights.size > 200) baseHeights.delete(baseHeights.keys().next().value!); }
        // public nodes drop blocks after about a day; three days after the approval the reference block is expired for certain
        else if (hs.every((h) => h.status === 'rejected' && isKind(h.reason, 'UNKNOWN_BLOCK')) && Date.now() / 1000 - Number(p.intent.createdAt) > 3 * 86_400) base = 0;
        else return remember(pending);
      }
      if (up.every((s) => s.head.height > base! + VALIDITY_BLOCKS + EXPIRY_MARGIN_BLOCKS)) return { state: 'failed', confirmations: 0, error: 'not included before its reference block expired; no funds moved' };
      return remember(pending);
    },

    async deposits(addr, cursor) {
      const finalHeight = (await any((u) => header(u, { finality: 'final' }))).height; // read first: the listing below cannot be ahead of it
      /** Re-verify one indexed row against RPC. null = definitively not an incoming transfer; throws when no source can tell. */
      const verify = async (row: TransferRow): Promise<Deposit | null> => {
        const txid = row.transaction_id!, receiptId = row.receipt_id;
        let last: unknown = null;
        const recent = finalHeight - Number(row.block_height) < RECENT_BLOCKS;
        for (const u of recent ? [...sources, NEAR_ARCHIVAL_RPC] : [NEAR_ARCHIVAL_RPC, ...sources]) {
          try {
            const t = await txStatus(u, txid, row.signer_id, true);
            if (!t) continue; // this node no longer keeps (or never saw) the transaction
            if (t.final_execution_status !== 'FINAL') throw new Error('not final yet');
            const idx = (t.receipts ?? []).findIndex((r) => r.receipt_id === receiptId);
            const rc = t.receipts?.[idx], out = t.receipts_outcome.find((o) => o.id === receiptId);
            if (!rc || !out) return null;
            const amount = transferSum(rc.receipt?.Action?.actions);
            if (rc.receiver_id !== addr || out.outcome?.executor_id !== addr || rc.predecessor_id === 'system' || rc.predecessor_id === addr || amount === null || amount <= 0n || !succeeded(out.outcome.status)) return null;
            const block = await header(u, { block_id: hashOf(out.block_hash, 'block hash') });
            return { txid, idx, asset: 'native', amount, from: rc.predecessor_id, block: block.height, time: block.time };
          } catch (e) { last = e; }
        }
        if (last) throw last;
        return null; // unknown to every source, archival included
      };

      const rows: TransferRow[] = [];
      let token: string | null = null, complete = cursor === null;
      for (let page = 0; page < (cursor === null ? 1 : SCAN_PAGES); page++) {
        const r = await http(NEAR_TRANSFERS_API, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ account_id: addr, direction: 'receiver', asset_id: 'native:near', ignore_system: true, desc: true, limit: cursor === null ? FIRST_SCAN_ROWS : 100, ...(token ? { resume_token: token } : {}) }) });
        if (!r.ok) throw new Error(`near transfers index http ${r.status}`);
        const j = (await r.json()) as { transfers?: TransferRow[]; resume_token?: string | null };
        if (!Array.isArray(j.transfers)) throw new Error('near transfers index: bad answer');
        const fresh = j.transfers.filter((t) => cursor === null || Number(uint(t.block_height, 'height')) > cursor);
        rows.push(...fresh);
        token = j.resume_token ?? null;
        if (fresh.length < j.transfers.length || !token || j.transfers.length === 0) { complete = true; break; }
      }
      const items: Deposit[] = [], seen = new Set<string>();
      const wellFormed = (row: TransferRow) => { try { nearDecodeHash(row.transaction_id!); nearDecodeHash(row.receipt_id); return /^[a-z0-9._-]{2,64}$/.test(row.signer_id) && /^\d{1,15}$/.test(row.block_height); } catch { return false; } };
      let held = Infinity; // lowest block of a row that could not be checked this time: the cursor must stay below it
      for (const row of rows) {
        if (row.account_id !== addr || row.asset_id !== 'native:near' || !wellFormed(row) || seen.has(row.receipt_id)) continue;
        seen.add(row.receipt_id);
        const key = `${addr}:${row.receipt_id}`;
        let d = verified.get(key);
        if (d === undefined) {
          try { d = await verify(row); }
          catch { // no source could answer: report nothing for this row and come back to it, unless it is hopelessly old
            if (cursor !== null && finalHeight - Number(row.block_height) < GIVE_UP_BLOCKS) held = Math.min(held, Number(row.block_height));
            continue;
          }
          verified.set(key, d);
          if (verified.size > 2000) verified.delete(verified.keys().next().value!);
        }
        if (d && d.block <= finalHeight) items.push(d);
      }
      // The index may lag behind the chain: keep re-reading a window behind the final block (inserts are idempotent).
      // When more rows were pending than one scan reads, the cursor stays where it was so that nothing is skipped.
      const next = complete ? Math.max(cursor ?? 0, Math.min(finalHeight - SCAN_OVERLAP_BLOCKS, held - 1)) : cursor!;
      return { items, cursor: next, finalizedHeight: finalHeight };
    },
  };
}
