/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/aptos.ts
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

// Aptos adapter: two independent REST full nodes (n.rpc). Everything that feeds the signature (sequence number, authentication
// key, balance) is read from both at the same ledger version and must agree; the exact transaction is then simulated on both
// and must succeed and show the expected credit, or the transfer is refused.
// Identity: chain id 1 (node and on-chain 0x1::chain_id resource), a pinned ledger checkpoint, and the same block hash on both
// sources for the same recent height. Public full nodes prune history (about two to three weeks are kept), so they cannot show
// the genesis transaction; the keyless Aptos Labs archive node can, and when it answers it must show the pinned genesis hash
// and the same recent block as both sources (an unreachable archive does not block transfers, a contradicting one does).
import {
  APTOS_MAX_GAS_AMOUNT, APTOS_MIN_GAS_UNIT_PRICE, aptosAptStore, aptosDecodeAddress, aptosEncodeTransfer, aptosRawBytes, aptosSimulationTx, aptosTxid,
  formatUnits, type NetworkDef,
} from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

interface Head { chain: number; version: bigint; height: bigint; epoch: bigint; timeSec: number }
interface Event { type: string; data: Record<string, unknown> }
interface Tx {
  type: string; hash: string; version?: string; success?: boolean; vm_status?: string; gas_used?: string; timestamp?: string;
  sender?: string; sequence_number?: string; max_gas_amount?: string; gas_unit_price?: string; expiration_timestamp_secs?: string;
  payload?: { type?: string; function?: string; type_arguments?: unknown[]; arguments?: unknown[] }; events?: Event[];
}

/** approval window; the transaction itself stays valid a little longer so it can still be included after a late approval */
const TTL_SEC = 120, VALIDITY_SEC = 180;
/** ledger state the sources must have reached: a chain that claims chain id 1 below this point is not the main network (read 2026-11-10) */
const CHECKPOINT = { height: 1_175_000_000n, version: 7_990_000_000n, epoch: 17_954n };
/** gas price bid bounds in octas per unit: the network minimum, and ten times it */
const PRICE_CAP = 1_000n;
/** highest fee this adapter proposes (0.1 APT, the default policy ceiling) */
const FEE_CEILING = 10_000_000n;
/** gas limit of the first, estimating simulation; margin applied to the gas it used; smallest limit proposed */
const SIM_GAS = 20_000n, GAS_FLOOR = 200n;
const MAX_CLOCK_SKEW_SEC = 60, STALE_SEC = 120, IDENTITY_TTL_MS = 600_000;
/** a "not included" verdict needs every source's ledger time to be this far past the expiration */
const EXPIRY_MARGIN_SEC = 20;
/** full-history node (Aptos Labs, keyless): genesis anchor, and reading deposits older than the sources keep */
const ARCHIVE = 'https://archive.mainnet.aptoslabs.com/v1';
/** hash of the genesis transaction (ledger version 0) of the main network, read from the archive node on 2026-11-10 */
const GENESIS_TX = '0xf650d76ea0a3176f0412b7e6bea5eb6fbf1d7adb0c39ab18e378adefb9247309';
const APT_COIN = '0x1::aptos_coin::AptosCoin', APT_FA = '0x' + '0'.repeat(63) + 'a';
const TRANSFER_FN = '0x1::aptos_account::transfer';
const BCS_TX = 'application/x.aptos.signed_transaction+bcs';
const PAGE = 100, FIRST_PAGE = 50, MAX_PAGES = 3;

class ApiError extends Error { constructor(public status: number, public apiCode: string, message: string) { super(message); } }
async function read<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as (T & { error_code?: string; message?: string; vm_error_code?: number | null }) | null;
  if (!r.ok || j === null) throw new ApiError(r.status, String(j?.error_code ?? ''), `aptos http ${r.status} ${j?.error_code ?? ''} ${String(j?.message ?? '').slice(0, 160)}`.trim());
  return j;
}
const get = async <T>(base: string, path: string): Promise<T> => read<T>(await http(base + path, { headers: { accept: 'application/json' } }));
const postJson = async <T>(url: string, body: unknown): Promise<T> => read<T>(await http(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }));
const postBcs = async <T>(url: string, body: Uint8Array): Promise<T> => read<T>(await http(url, { method: 'POST', headers: { 'content-type': BCS_TX, accept: 'application/json' }, body: body as BodyInit }));
const uint = (v: unknown, what: string): bigint => {
  if (typeof v === 'number' ? !Number.isSafeInteger(v) || v < 0 : typeof v !== 'string' || !/^\d{1,20}$/.test(v)) throw new Error(`aptos: bad ${what}`);
  return BigInt(v as string | number);
};
const hash32 = (v: unknown, what: string): string => { if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) throw new Error(`aptos: bad ${what}`); return v; };
/** the REST API prints account addresses without leading zeros: restore the canonical 64-digit form before comparing */
const canon = (v: unknown): string => (typeof v === 'string' && /^0x[0-9a-f]{1,64}$/.test(v) ? '0x' + v.slice(2).padStart(64, '0') : '');
const big = (a: bigint, b: bigint) => (a > b ? a : b), small = (a: bigint, b: bigint) => (a < b ? a : b);

export function aptosAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc;
  const apt = (v: bigint) => `${formatUnits(v, n.native.decimals)} ${n.native.symbol}`;
  const any = async <T>(f: (u: string) => Promise<T>, urls: string[] = sources): Promise<T> => { let last: unknown; for (const u of urls) { try { return await f(u); } catch (e) { last = e; } } throw last; };
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
  /** ledger position of one source; verifies the chain id and the pinned checkpoint on every call */
  const head = async (u: string): Promise<Head> => {
    const r = await get<Record<string, unknown>>(u, '');
    const h: Head = { chain: r.chain_id as number, version: uint(r.ledger_version, 'ledger version'), height: uint(r.block_height, 'block height'), epoch: uint(r.epoch, 'epoch'),
      timeSec: Number(uint(r.ledger_timestamp, 'ledger timestamp') / 1_000_000n) };
    if (h.chain !== Number(n.chainRef) || h.chain !== 1) throw new Error('aptos: wrong chain id');
    if (h.height < CHECKPOINT.height || h.version < CHECKPOINT.version || h.epoch < CHECKPOINT.epoch) throw new Error('aptos: ledger is behind the pinned checkpoint');
    return h;
  };
  /** APT balance in octas: the framework view covers both the legacy CoinStore and the fungible-asset store */
  const balance = async (u: string, addr: string, version?: bigint): Promise<bigint> => {
    const r = await postJson<unknown[]>(`${u}/view${version === undefined ? '' : `?ledger_version=${version}`}`, { function: '0x1::coin::balance', type_arguments: [APT_COIN], arguments: [addr] });
    if (!Array.isArray(r) || r.length !== 1) throw new Error('aptos: bad balance answer');
    return uint(r[0], 'balance');
  };
  /** an account that was never created on-chain has sequence number 0 and its address as authentication key */
  const account = async (u: string, addr: string, version: bigint): Promise<{ sequence: string; authKey: string }> => {
    try {
      const a = await get<{ sequence_number: unknown; authentication_key: unknown }>(u, `/accounts/${addr}?ledger_version=${version}`);
      return { sequence: uint(a.sequence_number, 'sequence number').toString(), authKey: hash32(canon(a.authentication_key), 'authentication key') };
    } catch (e) { if (e instanceof ApiError && e.status === 404 && e.apiCode === 'account_not_found') return { sequence: '0', authKey: addr }; throw e; }
  };
  /** transaction by hash (the caller checks the record); null only for the node's own "not found" answer */
  const byHash = async (u: string, txid: string): Promise<Tx | null> => {
    try {
      return await get<Tx>(u, `/transactions/by_hash/${txid}`);
    } catch (e) { if (e instanceof ApiError && e.status === 404 && e.apiCode === 'transaction_not_found') return null; throw e; }
  };
  const simulate = async (u: string, rawTx: Uint8Array): Promise<Tx> => {
    const body = aptosSimulationTx(rawTx);
    const r = await postBcs<Tx[]>(`${u}/transactions/simulate`, body);
    if (!Array.isArray(r) || r.length !== 1 || typeof r[0]?.success !== 'boolean' || typeof r[0].vm_status !== 'string') throw new Error('aptos: bad simulation answer');
    if (r[0].hash !== aptosTxid(body)) throw new Error('aptos: simulation answered for another transaction');
    return r[0];
  };
  /** octas credited to `addr` by the events of one transaction: fungible-asset deposits into its APT store, or legacy coin deposits */
  const credited = (events: Event[] | undefined, addr: string, store: string): { idx: number; amount: bigint }[] => (events ?? []).flatMap((e, idx) => {
    const d = e?.data ?? {};
    const hit = (e?.type === '0x1::fungible_asset::Deposit' && canon(d.store) === store) || (e?.type === '0x1::coin::CoinDeposit' && canon(d.account) === addr && d.coin_type === APT_COIN);
    return hit ? [{ idx, amount: uint(d.amount, 'event amount') }] : [];
  });

  let identity = false, identityAt = 0;
  /** on-chain chain id on every source, and the same block hash for the same recent height */
  const blockAt = async (u: string, height: bigint): Promise<string> => {
    const b = await get<Record<string, unknown>>(u, `/blocks/by_height/${height}`);
    return [hash32(b.block_hash, 'block hash'), uint(b.first_version, 'version'), uint(b.last_version, 'version'), uint(b.block_timestamp, 'timestamp')].join('|');
  };
  const verifyIdentity = async (heads: Head[]): Promise<void> => {
    const height = heads.map((h) => h.height).reduce(small) - 5n;
    const [seen, anchor] = await Promise.all([
      Promise.all(sources.map(async (u) => {
        const c = await get<{ data?: { id?: unknown } }>(u, '/accounts/0x1/resource/0x1::chain_id::ChainId');
        if (c.data?.id !== 1) throw new Error('aptos: on-chain chain id mismatch');
        return blockAt(u, height);
      })),
      (async () => {
        try { return { genesis: (await get<Tx>(ARCHIVE, '/transactions/by_version/0')).hash, block: await blockAt(ARCHIVE, height) }; }
        catch { return null; } // archive unreachable: the two-source checks stand alone
      })(),
    ]);
    if (seen.length < 2 || seen.some((s) => s !== seen[0])) throw new Error('aptos: sources are not on the same ledger');
    if (anchor && (anchor.genesis !== GENESIS_TX || anchor.block !== seen[0])) throw new Error('aptos: sources are not on the ledger that starts at the pinned genesis');
  };

  return {
    async health(): Promise<Health> {
      const probes = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const h = await head(url);
          if (Date.now() / 1000 - h.timeSec > STALE_SEC) throw new Error('stale');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: h as Head | null };
        } catch { return { url: hostOf(url), ok: false, ms: null as number | null, h: null as Head | null }; }
      }));
      const up = probes.length >= 2 && probes.every((e) => e.ok);
      if (up && (!identity || Date.now() - identityAt > IDENTITY_TTL_MS)) {
        try { await verifyIdentity(probes.map((p) => p.h!)); identity = true; identityAt = Date.now(); } catch { identity = false; }
      }
      const heights = probes.flatMap((p) => (p.h ? [Number(p.h.height)] : []));
      return { network: n.id, ok: up && identity, readable: probes.some((e) => e.ok), identityVerified: identity, height: heights.length ? Math.max(...heights) : null,
        endpoints: probes.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      aptosDecodeAddress(addr);
      return { native: await any((u) => balance(u, addr)) };
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only APT can be sent on Aptos in this version');
      let sender: Uint8Array, recipient: Uint8Array;
      try { sender = aptosDecodeAddress(d.from); recipient = aptosDecodeAddress(d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (d.amount <= 0n || d.amount >= 1n << 64n) throw new UserError('bad_amount', 'amount must be greater than zero');
      if (d.memo !== undefined) throw new UserError('bad_memo', 'Aptos transfers carry no memo');
      const warnings: string[] = [];

      // ledger position of both sources, then the account state of both at the same ledger version
      const heads = await all(head, 'ledger position');
      const now = Math.floor(Date.now() / 1000);
      for (const h of heads) if (Math.abs(now - h.timeSec) > MAX_CLOCK_SKEW_SEC) throw new UserError('rpc_degraded', `${n.name} ledger time and server clock differ; transfer refused`, 503);
      const version = heads.map((h) => h.version).reduce(small);
      const snaps = await all(async (u) => {
        const [acct, bal, gas] = await Promise.all([account(u, d.from, version), balance(u, d.from, version), get<{ gas_estimate: unknown }>(u, '/estimate_gas_price')]);
        return { state: { ...acct, balance: bal.toString() }, gasPrice: uint(gas.gas_estimate, 'gas estimate') };
      }, 'account state');
      const state = agree(snaps.map((s) => s.state), 'source account');
      if (state.authKey !== d.from) throw new UserError('unsupported_account', 'the authentication key of this Aptos account was rotated; it cannot send from this wallet');
      const bal = BigInt(state.balance), sequence = BigInt(state.sequence);

      // gas price: the larger of the two estimates, never below the network minimum, capped
      const want = big(snaps.map((s) => s.gasPrice).reduce(big), APTOS_MIN_GAS_UNIT_PRICE);
      if (want > PRICE_CAP) warnings.push('network_congested');
      const gasPrice = small(want, PRICE_CAP);

      const short = () => new UserError('insufficient_funds', `insufficient ${n.native.symbol}: ${apt(bal)} available for amount plus network fee`);
      if (bal <= d.amount) throw short();
      const expiration = BigInt(now + VALIDITY_SEC);
      const encode = (maxGas: bigint) => aptosEncodeTransfer({ sender, recipient, amount: d.amount, sequence, maxGas, gasPrice, expiration });
      const store = aptosAptStore(d.to);
      /** simulate on both sources; both must execute the transfer and show the exact credit to the recipient */
      const run = async (maxGas: bigint, what: string): Promise<bigint> => {
        const rawTx = encode(maxGas);
        const sims = await all((u) => simulate(u, rawTx), what);
        for (const s of sims) {
          if (!s.success) {
            const vm = s.vm_status ?? '';
            if (/INSUFFICIENT_BALANCE|EINSUFFICIENT_BALANCE|ECOIN_STORE_NOT_PUBLISHED/.test(vm)) throw short();
            if (/SEQUENCE_NUMBER/.test(vm)) throw new UserError('pending_tx', 'this account has a transaction in progress; try again in a moment', 409);
            throw new UserError('simulation_failed', `the network would reject this transfer: ${vm.slice(0, 160)}`);
          }
          const args = s.payload?.arguments;
          const echo = [canon(s.sender), s.sequence_number, s.max_gas_amount, s.gas_unit_price, s.expiration_timestamp_secs, s.payload?.function, JSON.stringify(s.payload?.type_arguments), JSON.stringify(Array.isArray(args) && args.length === 2 ? [canon(args[0]), args[1]] : null)];
          const sent = [d.from, sequence.toString(), maxGas.toString(), gasPrice.toString(), expiration.toString(), TRANSFER_FN, '[]', JSON.stringify([d.to, d.amount.toString()])];
          if (JSON.stringify(echo) !== JSON.stringify(sent)) throw new UserError('rpc_disagreement', `${n.name} simulated a different transaction; transfer refused`, 503);
          const credit = credited(s.events, d.to, store);
          if (credit.length !== 1 || credit[0]!.amount !== d.amount) throw new UserError('simulation_failed', 'the simulation does not credit the recipient with the exact amount; transfer refused');
        }
        const used = sims.map((s) => uint(s.gas_used, 'gas used')).reduce(big);
        if (used <= 0n || used > maxGas) throw new UserError('rpc_degraded', `${n.name} simulation returned an implausible gas figure; transfer refused`, 503);
        return used;
      };

      // first pass: how much gas the transfer needs (a recipient without an APT store costs a one-time storage fee)
      const affordable = (bal - d.amount) / gasPrice;
      if (affordable < 1n) throw short();
      const estimate = await run(small(SIM_GAS, affordable), 'simulation');
      const maxGas = big(estimate + estimate / 2n + 1n, GAS_FLOOR);
      const maxFee = maxGas * gasPrice;
      if (maxGas > APTOS_MAX_GAS_AMOUNT || maxFee > FEE_CEILING) throw new UserError('fee_too_high', `the network fee for this transfer (up to ${apt(maxFee)}) is above the wallet limit`);
      if (bal < d.amount + maxFee) throw short();
      // second pass: the exact transaction that will be signed
      const used = await run(maxGas, 'simulation of the exact transaction');

      return {
        section: { x: { sequence_number: sequence.toString(), max_gas_amount: maxGas.toString(), gas_unit_price: gasPrice.toString(), expiration_timestamp_secs: expiration.toString() } },
        maxFee, feeEstimate: used * gasPrice, warnings, ttlSec: TTL_SEC,
      };
    },

    async broadcast(raw) {
      const bytes = aptosRawBytes(raw), txid = aptosTxid(bytes);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        const r = await postBcs<{ hash?: string }>(`${u}/transactions`, bytes);
        if (r.hash !== txid) throw new Error('aptos node answered for another transaction');
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // "already known": a re-submission after inclusion is refused (sequence number too old); the ledger is the judge
      const known = await Promise.allSettled(sources.map((u) => byHash(u, txid)));
      if (known.some((k) => k.status === 'fulfilled' && k.value?.hash === txid)) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const exp = Number(p.intent?.x?.expiration_timestamp_secs);
      if (!Number.isSafeInteger(exp) || exp <= 0) throw new Error('intent has no expiration');
      hash32(p.txid, 'transaction id');
      // per source: ledger position FIRST, then the lookup — a miss is then known to cover the ledger up to that position
      const rs = await Promise.allSettled(sources.map(async (u) => { const h = await head(u); return { h, tx: await byHash(u, p.txid) }; }));
      const up = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const allUp = up.length === sources.length && up.length >= 2;
      for (const s of up) if (s.tx !== null && (s.tx.hash !== p.txid || typeof s.tx.type !== 'string')) throw new Error('aptos: bad transaction record');
      const committed = up.filter((s) => s.tx !== null && s.tx.type !== 'pending_transaction');
      for (const s of committed) if (s.tx!.type !== 'user_transaction' || typeof s.tx!.success !== 'boolean') throw new Error('aptos: bad transaction record');
      if (committed.length > 0) {
        const version = uint(committed[0]!.tx!.version, 'version'), good = committed[0]!.tx!.success!;
        if (committed.some((s) => uint(s.tx!.version, 'version') !== version || s.tx!.success !== good)) throw new Error('data sources disagree on the transaction result');
        const blockRef = version.toString();
        // a committed transaction is final on Aptos (BFT); every reachable source must show it before we say so
        if (committed.length < up.length) return { state: 'confirming', confirmations: 1, blockRef };
        if (good) return { state: 'finalized', confirmations: Math.max(1, Number(up.map((s) => s.h.version).reduce(big) - version) + 1), blockRef };
        // committed but aborted (gas charged, nothing transferred): only final once every source is reachable and agrees
        if (!allUp) return { state: 'confirming', confirmations: 1, blockRef };
        return { state: 'failed', confirmations: 0, blockRef, error: `committed but the transfer aborted (${String(committed[0]!.tx!.vm_status).slice(0, 120)}); only the network fee was charged, no funds moved` };
      }
      // a transaction can only be committed in a block whose time is before its expiration
      if (allUp && up.every((s) => s.tx === null && s.h.timeSec > exp + EXPIRY_MARGIN_SEC))
        return { state: 'failed', confirmations: 0, error: 'not included before its expiration; no funds moved' };
      return { state: 'broadcast', confirmations: 0, rebroadcast: Date.now() / 1000 < exp };
    },

    // Full nodes have no per-account index of incoming transfers. Discovery uses the keyless Aptos Labs indexer (GraphQL, same
    // host as rpc[0]); the indexer is never trusted: each transaction it names is read from a full node (the other source
    // first) and only the credit shown by that node's events is recorded.
    async deposits(addr, cursor) {
      aptosDecodeAddress(addr);
      const index = sources.find((u) => /(^|\.)aptoslabs\.com$/.test(new URL(u).hostname));
      const store = aptosAptStore(addr);
      return any(async (u) => {
        const latest = Number((await head(u)).version); // read before the listing: every version up to here is final and readable on this node
        if (!index) return { items: [], cursor: cursor ?? 0, finalizedHeight: latest };
        const versions = new Set<number>();
        let bound = latest, from = cursor, cut = false;
        for (let page = 0; page < (cursor === null ? 1 : MAX_PAGES); page++) {
          const where = `owner_address:{_eq:"${addr}"}, asset_type:{_in:["${APT_FA}","${APT_COIN}"]}, type:{_in:["0x1::fungible_asset::Deposit","0x1::coin::CoinDeposit"]}, is_transaction_success:{_eq:true}`
            + (from === null ? '' : `, transaction_version:{_gt:${from}}`);
          const q = `{ processor_status(where:{processor:{_eq:"fungible_asset_processor"}}) { last_success_version } `
            + `fungible_asset_activities(limit:${from === null ? FIRST_PAGE : PAGE}, where:{${where}}, order_by:{transaction_version:${from === null ? 'desc' : 'asc'}}) { transaction_version } }`;
          const r = await postJson<{ data?: { processor_status?: { last_success_version: unknown }[]; fungible_asset_activities?: { transaction_version: unknown }[] }; errors?: unknown }>(`${index}/graphql`, { query: q });
          const rows = r.data?.fungible_asset_activities, status = r.data?.processor_status;
          if (r.errors || !Array.isArray(rows) || !Array.isArray(status) || status.length !== 1) throw new Error('aptos: history index unavailable');
          // nothing beyond what the index has fully processed, nor beyond what the verifying node holds, is consumed in this pass
          bound = Math.min(bound, Number(uint(status[0]!.last_success_version, 'index position')));
          const vs = rows.map((x) => Number(uint(x.transaction_version, 'version')));
          for (const v of vs) if (v <= bound) versions.add(v);
          cut = from !== null && vs.length >= PAGE;
          if (!cut) break;
          from = Math.max(...vs);
          if (from >= bound) { cut = false; break; }
        }
        const items: Deposit[] = [];
        /** null when this node has pruned the version */
        const byVersion = async (node: string, v: number): Promise<Tx | null> => {
          try {
            const t = await get<Tx>(node, `/transactions/by_version/${v}`);
            if (uint(t.version, 'version') !== BigInt(v)) throw new Error('aptos: bad transaction record');
            return t;
          } catch (e) { if (e instanceof ApiError && e.status === 410 && e.apiCode === 'version_pruned') return null; throw e; }
        };
        for (const v of [...versions].sort((a, b) => a - b)) {
          const t = await byVersion(u, v) ?? await byVersion(ARCHIVE, v).catch((e) => { if (cursor === null) return null; throw e; });
          if (t === null) { if (cursor === null) continue; throw new Error('aptos: deposit transaction no longer readable'); } // history only on a first scan
          if (t.type !== 'user_transaction' || t.success !== true || canon(t.sender) === addr) continue;
          const time = Number(uint(t.timestamp, 'timestamp') / 1_000_000n);
          for (const c of credited(t.events, addr, store)) if (c.amount > 0n) items.push({ txid: hash32(t.hash, 'hash'), idx: c.idx, asset: 'native', amount: c.amount, from: hash32(canon(t.sender), 'sender'), block: v, time });
        }
        // more to read: resume next time after the last version fully covered
        return { items, cursor: cut ? Math.max(cursor ?? 0, from ?? 0) : Math.max(cursor ?? 0, bound), finalizedHeight: latest };
      }, index ? [...sources.filter((s) => s !== index), index] : sources);
    },
  };
}
