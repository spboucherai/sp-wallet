/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/polkadot.ts
 * Module           : chains
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Polkadot adapter: native DOT on Polkadot Asset Hub (where balances live since the migration of 4 November 2025).
// JSON-RPC over HTTPS, two independent operators (both archive nodes). Everything that feeds the signature — genesis,
// runtime version, metadata, the finalized reference block, the account's nonce and balances, the fee quote, the dry
// run — is read from both sources and must be identical; otherwise the transfer is refused.
//
// Runtime-upgrade safety. A Substrate runtime can change pallet and call indices and the list of transaction extensions.
// Before every transfer this adapter reads the runtime version from both nodes; on a spec version it has not checked yet
// it downloads the metadata from both (they must be byte-identical) and verifies, BY NAME, everything the hand-written
// encoder in @spw/core relies on: spec name, transaction version, extrinsic version, the extension list with the type of
// every explicit and implicit field, the index of pallet Balances and of call transfer_keep_alive with its arguments, the
// MultiAddress::Id and MultiSignature::Ed25519 variants, the layout of System.Account. Any difference → `runtime_changed`,
// sends stop until packages/core/src/plugins/polkadot.ts is reviewed (docs/chains/polkadot.md). The signer independently
// refuses a transaction version other than the reviewed one.
//
// Rules (stated, not worked around):
// - The call is Balances.transfer_keep_alive: the wallet's account always keeps the existential deposit (0.01 DOT) and is
//   never reaped. There is no "send all": the last 0.01 DOT stays (reaping would burn it anyway).
// - A transfer below the existential deposit to an account that does not exist would fail on chain: refused beforehand.
// - The fee is not a field of the transaction: the chain computes it. The quote comes from `payment_queryInfo` on both
//   nodes for the exact bytes (placeholder signature); the tip is always 0. maxFee = twice the quote, capped.
// - Dry run: `system_dryRun` is not served by public nodes; the runtime API `DryRunApi.dry_run_call` is, and executes the
//   exact call as the wallet's account on the reference block of both nodes.
// - There is no transaction index in a Substrate node: a transfer is located by its account nonce (bisection over state
//   at past blocks), then read from the block and its events. Deposits are found the same way: the account's state is
//   compared between the last scanned block and the finalized head, and only the blocks where it changed are decoded.
import { blake2b } from '@noble/hashes/blake2.js';
import {
  buildPolkadotTx, polkadotAccountId, polkadotExtrinsic, polkadotParseRaw, polkadotTxid, POLKADOT_EXTENSIONS, POLKADOT_MAX_ERA_PERIOD, POLKADOT_REVIEWED, POLKADOT_SS58_PREFIX, ScaleReader, ss58Encode,
  type Intent, type NetworkDef,
} from '@spw/core';
import { UserError } from '../config.ts';
import { decodeValue, palletOf, parseMetadata, renderFields, renderType, storageKey, typeByPath, variantsOf, type Metadata, type Value } from './polkadot-metadata.ts';
import { hostOf, rpcOne, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const TTL_SEC = 90, ERA_PERIOD = POLKADOT_MAX_ERA_PERIOD;
/** the fee ceiling offered to the policy: twice the chain's quote, never above this (planck); equals the default policy ceiling */
const FEE_CAP = 500_000_000n;
/** finalized heads of the two sources further apart than this (blocks of 2 s) are not the same view of the chain */
const MAX_FINALITY_SPREAD = 60;
const MAX_FINALITY_AGE_MS = 10 * 60_000;
const DEPOSIT_MAX_SPAN = 43_200, DEPOSIT_MAX_BLOCKS = 12;
/** layouts this adapter decodes by hand or relies on, as rendered by renderType */
const ACCOUNT_INFO = 'AccountInfo{nonce:u32,consumers:u32,providers:u32,sufficients:u32,data:AccountData{free:u128,reserved:u128,frozen:u128,flags:ExtraFlags}}';
const ADDRESS_ID = 'AccountId32{[u8;32]}', SIGNATURE_ED25519 = '[u8;64]';
const BLAKE2_128_CONCAT = 2;

const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (s: unknown, what: string): Uint8Array => {
  if (typeof s !== 'string' || !/^0x([0-9a-f]{2})*$/.test(s)) throw new Error(`polkadot: bad ${what}`);
  return Uint8Array.from(Buffer.from(s.slice(2), 'hex'));
};
const hash = (v: unknown, what: string): string => { if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) throw new Error(`polkadot: bad ${what}`); return v; };
const fmt = (v: bigint) => { const f = (v % 10n ** 10n).toString().padStart(10, '0').replace(/0+$/, ''); return `${v / 10n ** 10n}${f ? '.' + f : ''}`; };
const u32le = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const obj = (v: Value | undefined): Record<string, Value> => { if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) throw new Error('polkadot: unexpected value'); return v; };

interface Account { nonce: number; free: bigint; reserved: bigint; frozen: bigint; providers: number }
interface Runtime {
  specVersion: number; transactionVersion: number; meta: Metadata; existentialDeposit: bigint; accountType: number; eventsType: number;
  /** DryRunApi version (0 = not offered), and the encoded origin prefix `OriginCaller::system(RawOrigin::Signed(` */
  dryRun: number; originPrefix: Uint8Array; dispatchErrorType: number;
}
interface Ref { hash: string; number: number }

/**
 * Check a parsed metadata document against everything the plugin was reviewed for. Throws with the first difference.
 * Exported for the tests and the smoke script.
 */
export function checkPolkadotMetadata(m: Metadata): { existentialDeposit: bigint; accountType: number; eventsType: number; originPrefix: Uint8Array; dispatchErrorType: number } {
  const R = POLKADOT_REVIEWED;
  if (m.extrinsic.version !== R.extrinsicVersion) throw new Error(`extrinsic version ${m.extrinsic.version} (reviewed: ${R.extrinsicVersion})`);
  const ext = m.extrinsic.extensions.map((e) => [e.id, renderType(m, e.type), renderType(m, e.implicit)]);
  if (JSON.stringify(ext) !== JSON.stringify(POLKADOT_EXTENSIONS)) {
    const k = ext.findIndex((e, n) => JSON.stringify(e) !== JSON.stringify(POLKADOT_EXTENSIONS[n]));
    throw new Error(`transaction extensions differ at position ${k < 0 ? ext.length : k}: ${JSON.stringify(ext[k] ?? null)} (reviewed: ${JSON.stringify(POLKADOT_EXTENSIONS[k < 0 ? ext.length : k] ?? null)})`);
  }
  const balances = palletOf(m, R.pallet.name);
  if (balances.index !== R.pallet.index) throw new Error(`pallet ${R.pallet.name} has index ${balances.index} (reviewed: ${R.pallet.index})`);
  const call = variantsOf(m, balances.calls).find((v) => v.name === R.call.name);
  if (!call || call.index !== R.call.index || renderFields(m, call.fields) !== R.call.args) throw new Error(`call ${R.pallet.name}.${R.call.name} is ${call ? `index ${call.index} (${renderFields(m, call.fields)})` : 'missing'} (reviewed: index ${R.call.index} (${R.call.args}))`);
  // the address and signature types of the extrinsic
  const xt = m.types[m.extrinsic.type];
  const param = (name: string): number => { const p = xt?.params.find((x) => x.name === name)?.type; if (p === null || p === undefined) throw new Error(`extrinsic type has no ${name} parameter`); return p; };
  const id = variantsOf(m, param('Address')).find((v) => v.name === 'Id');
  if (!id || id.index !== R.multiAddressId || id.fields.length !== 1 || renderType(m, id.fields[0]!.type) !== ADDRESS_ID) throw new Error('MultiAddress::Id changed');
  const ed = variantsOf(m, param('Signature')).find((v) => v.name === 'Ed25519');
  if (!ed || ed.index !== R.signatureEd25519 || ed.fields.length !== 1 || renderType(m, ed.fields[0]!.type) !== SIGNATURE_ED25519) throw new Error('MultiSignature::Ed25519 changed');
  if (variantsOf(m, call.fields[0]!.type).find((v) => v.name === 'Id')?.index !== R.multiAddressId) throw new Error('destination address type changed');
  // storage read by hand
  const system = palletOf(m, 'System');
  const account = system.storage.find((s) => s.name === 'Account'), events = system.storage.find((s) => s.name === 'Events');
  if (!account || account.hashers.length !== 1 || account.hashers[0] !== BLAKE2_128_CONCAT || renderType(m, account.value) !== ACCOUNT_INFO) throw new Error('System.Account layout changed');
  if (!events || events.key !== null) throw new Error('System.Events layout changed');
  const edConst = balances.constants.find((c) => c.name === 'ExistentialDeposit');
  if (!edConst || edConst.value.length !== 16 || renderType(m, edConst.type) !== 'u128') throw new Error('Balances.ExistentialDeposit changed');
  const prefix = system.constants.find((c) => c.name === 'SS58Prefix');
  if (!prefix || prefix.value.length !== 2 || prefix.value[0] !== POLKADOT_SS58_PREFIX || prefix.value[1] !== 0) throw new Error('SS58 prefix changed');
  const transfer = variantsOf(m, balances.events).find((v) => v.name === 'Transfer');
  if (!transfer || renderFields(m, transfer.fields) !== 'from:AccountId32{[u8;32]},to:AccountId32{[u8;32]},amount:u128') throw new Error('Balances.Transfer event changed');
  // OriginCaller::system(RawOrigin::Signed(account)) for the dry-run runtime API
  const sys = variantsOf(m, typeByPath(m, 'OriginCaller')).find((v) => v.name === 'system');
  const signed = sys && sys.fields.length === 1 ? variantsOf(m, sys.fields[0]!.type).find((v) => v.name === 'Signed') : undefined;
  if (!sys || !signed || signed.fields.length !== 1 || renderType(m, signed.fields[0]!.type) !== ADDRESS_ID) throw new Error('OriginCaller changed');
  const dispatchErrorType = typeByPath(m, 'sp_runtime', 'DispatchError');
  variantsOf(m, dispatchErrorType);
  return { existentialDeposit: new ScaleReader(edConst.value).uint(16), accountType: account.value, eventsType: events.value, originPrefix: Uint8Array.of(sys.index, signed.index), dispatchErrorType };
}

export function polkadotAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc;
  if (sources.length < 2) throw new Error(`${n.name} needs two independent sources`);
  const genesis = '0x' + n.chainRef;
  let identity = false, runtime: Runtime | null = null;

  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const u of sources) { try { return await f(u); } catch (e) { last = e; } }
    throw last;
  };
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
  /** A call that may legitimately answer null (missing storage). */
  const rpcNullable = async <T>(u: string, method: string, params: unknown[]): Promise<T | null> => {
    try { return await rpcOne<T>(u, method, params); } catch (e) { if ((e as Error).message === 'rpc: empty result') return null; throw e; }
  };

  const checkIdentity = async (u: string): Promise<void> => { if (await rpcOne<string>(u, 'chain_getBlockHash', [0]) !== genesis) throw new Error('identity: genesis hash mismatch'); };
  const finalized = async (u: string): Promise<Ref> => {
    const h = hash(await rpcOne(u, 'chain_getFinalizedHead', []), 'finalized head');
    const hd = await rpcOne<{ number?: string }>(u, 'chain_getHeader', [h]);
    const number = typeof hd.number === 'string' && /^0x[0-9a-f]{1,8}$/.test(hd.number) ? parseInt(hd.number, 16) : NaN;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('polkadot: bad header');
    return { hash: h, number };
  };
  const blockHash = async (u: string, number: number): Promise<string> => hash(await rpcOne(u, 'chain_getBlockHash', [number]), 'block hash');
  /** One finalized reference block known to every source: the lowest of their finalized heads, with the same hash everywhere. */
  const reference = async (): Promise<Ref> => {
    const heads = await all('finalized head', finalized);
    const ref = heads.reduce((a, b) => (b.number < a.number ? b : a));
    if (Math.max(...heads.map((h) => h.number)) - ref.number > MAX_FINALITY_SPREAD) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same block; transfer refused`, 503);
    for (const h of await all('reference block', (u) => blockHash(u, ref.number))) if (h !== ref.hash) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (reference block); transfer refused`, 503);
    return ref;
  };
  const timestampAt = async (u: string, at: string): Promise<number> => Number(new ScaleReader(unhex(await rpcOne(u, 'state_getStorage', [storageKey('Timestamp', 'Now'), at]), 'timestamp')).uint(8));

  /** Runtime of both sources, verified against the reviewed pins (metadata is downloaded only when the spec version is new). */
  const checkRuntime = async (): Promise<Runtime> => {
    const paused = (why: string) => new UserError('runtime_changed', `${n.name} runtime changed (${why}); sending is paused until this wallet has been reviewed for it`, 503);
    const v = agree('runtime version', await all('runtime version', async (u) => {
      const r = await rpcOne<{ specName?: string; specVersion?: number; transactionVersion?: number; apis?: [string, number][] }>(u, 'state_getRuntimeVersion', []);
      if (typeof r.specVersion !== 'number' || typeof r.transactionVersion !== 'number' || !Array.isArray(r.apis)) throw new Error('polkadot: bad runtime version');
      return { specName: r.specName, specVersion: r.specVersion, transactionVersion: r.transactionVersion, dryRun: r.apis.find((a) => a[0] === DRY_RUN_API)?.[1] ?? 0 };
    }));
    if (v.specName !== POLKADOT_REVIEWED.specName) throw paused(`spec name ${String(v.specName)}`);
    if (v.specVersion < POLKADOT_REVIEWED.minSpecVersion) throw paused(`spec version ${v.specVersion} is older than the reviewed one`);
    if (v.transactionVersion !== POLKADOT_REVIEWED.transactionVersion) throw paused(`transaction version ${v.transactionVersion}, reviewed ${POLKADOT_REVIEWED.transactionVersion}`);
    if (runtime && runtime.specVersion === v.specVersion) return runtime;
    const docs = await all('metadata', (u) => rpcOne<string>(u, 'state_getMetadata', []));
    if (docs.some((d) => d !== docs[0])) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (runtime metadata); transfer refused`, 503);
    let meta: Metadata, checked: ReturnType<typeof checkPolkadotMetadata>;
    try { meta = parseMetadata(unhex(docs[0], 'metadata')); checked = checkPolkadotMetadata(meta); } catch (e) { throw paused((e as Error).message.slice(0, 160)); }
    runtime = { specVersion: v.specVersion, transactionVersion: v.transactionVersion, meta, ...checked, dryRun: v.dryRun };
    return runtime;
  };

  const accountKey = (addr: string) => storageKey('System', 'Account', polkadotAccountId(addr));
  const rawAccount = (u: string, addr: string, at?: string) => rpcNullable<string>(u, 'state_getStorage', at ? [accountKey(addr), at] : [accountKey(addr)]);
  /** AccountInfo, decoded by hand (layout verified against the metadata): nonce, consumers, providers, sufficients, free, reserved, frozen, flags. */
  const decodeAccount = (raw: string | null): Account | null => {
    if (raw === null) return null;
    const r = new ScaleReader(unhex(raw, 'account'));
    const nonce = Number(r.uint(4)); r.uint(4); const providers = Number(r.uint(4)); r.uint(4);
    const free = r.uint(16), reserved = r.uint(16), frozen = r.uint(16); r.uint(16);
    if (!r.done) throw new Error('polkadot: bad account');
    return { nonce, free, reserved, frozen, providers };
  };

  /** Events of a block, decoded with the current metadata. */
  const eventsAt = async (u: string, rt: Runtime, at: string): Promise<{ phase: Value; pallet: string; name: string; data: Value }[]> => {
    const raw = await rpcNullable<string>(u, 'state_getStorage', [storageKey('System', 'Events'), at]);
    if (raw === null) return [];
    const r = new ScaleReader(unhex(raw, 'events'));
    const list = decodeValue(rt.meta, rt.eventsType, r);
    if (!r.done || !Array.isArray(list)) throw new Error('polkadot: bad events');
    return list.map((rec) => { const e = obj(obj(rec).event), inner = obj(e.value); return { phase: obj(rec).phase!, pallet: String(e.variant), name: String(inner.variant), data: inner.value ?? null }; });
  };
  const extrinsicsAt = async (u: string, at: string): Promise<string[]> => {
    const b = await rpcOne<{ block?: { extrinsics?: string[] } }>(u, 'chain_getBlock', [at]);
    if (!Array.isArray(b.block?.extrinsics)) throw new Error('polkadot: bad block');
    return b.block.extrinsics;
  };
  const dispatchError = (v: Value): string => {
    try { const e = obj(v); const inner = e.value; return `${String(e.variant)}${inner && typeof inner === 'object' && !Array.isArray(inner) && !(inner instanceof Uint8Array) && 'variant' in inner ? '.' + String(inner.variant) : inner && typeof inner === 'object' && !Array.isArray(inner) && !(inner instanceof Uint8Array) && 'index' in inner ? ` (pallet ${String(inner.index)})` : ''}`; }
    catch { return 'dispatch error'; }
  };

  /** outcome of the extrinsic with this hash in one block, or null when the block does not hold it */
  const outcomeIn = async (u: string, rt: Runtime, block: Ref, txid: string): Promise<{ block: Ref; ok: boolean; error?: string } | null> => {
    const index = (await extrinsicsAt(u, block.hash)).findIndex((x) => { try { return polkadotTxid(unhex(x, 'extrinsic')) === txid; } catch { return false; } });
    if (index < 0) return null;
    const mine = (await eventsAt(u, rt, block.hash)).filter((e) => { try { const p = obj(e.phase); return p.variant === 'ApplyExtrinsic' && p.value === BigInt(index); } catch { return false; } });
    const failed = mine.find((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed');
    if (failed) return { block, ok: false, error: dispatchError(obj(failed.data).dispatch_error ?? null) };
    if (!mine.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicSuccess')) throw new Error('polkadot: no outcome event for the extrinsic');
    return { block, ok: true };
  };
  /** blocks of an era window already read without finding the extrinsic (per transaction id), for the slow path below */
  const scanned = new Map<string, number>();
  /**
   * Where a signed extrinsic of ours ended up, looking at the chain up to `head`. Fast path: the account's nonce tells whether
   * SOME extrinsic with that nonce was included; bisection over past state finds the block, and the block tells whether it was
   * this one. Slow path, when the account does not exist at `head` (emptied and deleted, so its nonce says nothing): every
   * block of the mortal era is read once.
   */
  const locate = async (u: string, rt: Runtime, intent: { from: string; nonce: number; eraBlock: number; period: number }, txid: string, head: Ref): Promise<{ block: Ref; ok: boolean; error?: string } | 'replaced' | null> => {
    if (head.number <= intent.eraBlock) return null;
    const accountAt = async (hsh: string) => decodeAccount(await rawAccount(u, intent.from, hsh));
    const atHead = await accountAt(head.hash);
    if (atHead === null) {
      const last = Math.min(head.number, intent.eraBlock + intent.period);
      for (let b = Math.max(intent.eraBlock + 1, (scanned.get(txid) ?? 0) + 1); b <= last; b++) {
        const found = await outcomeIn(u, rt, { number: b, hash: await blockHash(u, b) }, txid);
        if (found) return found;
        scanned.set(txid, b);
        if (scanned.size > 200) scanned.delete(scanned.keys().next().value!);
      }
      return null;
    }
    if (atHead.nonce <= intent.nonce) return null;
    let lo = intent.eraBlock, hi = head.number, hiHash = head.hash; // invariant: nonce(lo) <= intent.nonce < nonce(hi)
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2), h = await blockHash(u, mid);
      if (((await accountAt(h))?.nonce ?? 0) > intent.nonce) { hi = mid; hiHash = h; } else lo = mid;
    }
    return (await outcomeIn(u, rt, { hash: hiHash, number: hi }, txid)) ?? 'replaced';
  };
  const intentOf = (i: any): { from: string; nonce: number; eraBlock: number; period: number } | null => {
    const nonce = Number(i?.x?.nonce), eraBlock = Number(i?.x?.era_block), period = Number(i?.x?.era_period);
    return typeof i?.from === 'string' && Number.isSafeInteger(nonce) && nonce >= 0 && Number.isSafeInteger(eraBlock) && eraBlock > 0 && Number.isSafeInteger(period) && period > 0 ? { from: i.from, nonce, eraBlock, period } : null;
  };

  return {
    async health(): Promise<Health> {
      let height = 0;
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const f = await finalized(url);
          if (!identity) await checkIdentity(url);
          if (Date.now() - (await timestampAt(url, f.hash)) > MAX_FINALITY_AGE_MS) throw new Error('polkadot: finality is stalled');
          height = Math.max(height, f.number);
          return { url: hostOf(url), ok: true, ms: Date.now() - t };
        } catch { return { url: hostOf(url), ok: false, ms: null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok) identity = true; // every source reported the pinned genesis hash
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: height || null, endpoints, checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      polkadotAccountId(addr);
      return { native: decodeAccount(await any((u) => rawAccount(u, addr)))?.free ?? 0n }; // an account that does not exist reads as 0
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', `only ${n.native.symbol} can be sent on ${n.name}`);
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      if (d.memo !== undefined) throw new UserError('bad_memo', `${n.name} transfers do not carry a memo`);
      let sender: Uint8Array;
      try { sender = polkadotAccountId(d.from); polkadotAccountId(d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (!identity) { await all('identity', checkIdentity); identity = true; }
      const rt = await checkRuntime();
      const ref = await reference();
      const ED = rt.existentialDeposit;

      const [srcRaw, dstRaw, next] = await Promise.all([
        all('account', (u) => rawAccount(u, d.from, ref.hash)), all('account', (u) => rawAccount(u, d.to, ref.hash)),
        all('account nonce', (u) => rpcOne<number>(u, 'system_accountNextIndex', [d.from])),
      ]);
      const src = decodeAccount(agree('source account', srcRaw)), dst = decodeAccount(agree('destination account', dstRaw));
      if (!src || src.free === 0n) throw new UserError('insufficient_funds', `this wallet's ${n.name} account holds no ${n.native.symbol}`);
      // the transaction pool of either node already holds (or the chain has just included) a transaction of this account
      if (next.some((x) => x !== src.nonce)) throw new UserError('pending_tx', 'a previous transaction from this wallet is not finalized yet; retry in a minute', 409);

      const draft = (maxFee: bigint): Intent => ({ v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'simulation', createdAt: 1, expiresAt: 2, policyVersion: 0, network: n.id, chainRef: n.chainRef,
        asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: maxFee.toString(),
        x: { spec_version: String(rt.specVersion), tx_version: String(rt.transactionVersion), nonce: String(src.nonce), era_block: String(ref.number), era_hash: ref.hash, era_period: String(ERA_PERIOD) } });
      // the same bytes the signer will produce, with a placeholder signature: the fee depends on their length and on the call only
      const built = buildPolkadotTx(draft(FEE_CAP), n);
      const xt = '0x' + hexOf(polkadotExtrinsic(built, sender, new Uint8Array(64)));
      const quote = BigInt(agree('fee', await all('fee', async (u) => {
        const q = await rpcOne<{ partialFee?: string }>(u, 'payment_queryInfo', [xt, ref.hash]);
        if (typeof q.partialFee !== 'string' || !/^[1-9]\d{0,30}$/.test(q.partialFee)) throw new Error('polkadot: bad fee quote');
        return q.partialFee;
      })));
      const maxFee = quote * 2n;
      if (maxFee > FEE_CAP) throw new UserError('fee_too_high', `the network fee (${fmt(quote)} ${n.native.symbol}) is above this wallet's ceiling; retry later`);

      // keep-alive rule: after the amount and the fee, the account must still hold the existential deposit and whatever is frozen
      const locked = src.frozen > src.reserved ? src.frozen - src.reserved : 0n, keep = locked > ED ? locked : ED;
      const most = src.free - keep - maxFee;
      if (d.amount > most) {
        if (most <= 0n) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol}: the account holds ${fmt(src.free)} ${n.native.symbol}, of which ${fmt(keep)} must stay (existential deposit${locked > ED ? ' and locked funds' : ''}) and the network fee is about ${fmt(quote)}`);
        throw new UserError('insufficient_funds', `${n.name} keeps ${fmt(keep)} ${n.native.symbol} in the account (${locked > ED ? 'locked funds' : 'the existential deposit: an account below it is deleted'}) and the fee is about ${fmt(quote)}: the most that can be sent is ${fmt(most)} ${n.native.symbol}`);
      }
      const warnings: string[] = [];
      if (!dst || dst.providers === 0) {
        // a new account must receive at least the existential deposit, or the transfer fails on chain (and the fee is lost)
        if (d.amount < ED) throw new UserError('bad_amount', `the destination account does not exist yet: it must receive at least ${fmt(ED)} ${n.native.symbol} (the existential deposit) to be created`);
        warnings.push('dt_new_account'); // translated by the web app: the account is created by this transfer and must keep the existential deposit
      }

      // dry run of the exact call, as this account, on the reference block of both sources
      if (rt.dryRun > 0) {
        const param = '0x' + hexOf(Uint8Array.from([...rt.originPrefix, ...sender, ...built.call, ...(rt.dryRun >= 2 ? u32le(DRY_RUN_XCM_VERSION) : [])]));
        const verdicts = await all('simulation', async (u) => {
          // Result<CallDryRunEffects { execution_result: Result<PostDispatchInfo, DispatchErrorWithPostInfo { post_info, error }>, … }, Error>
          const r = new ScaleReader(unhex(await rpcOne(u, 'state_call', ['DryRunApi_dry_run_call', param, ref.hash]), 'dry run'));
          if (r.u8() !== 0) return 'the node could not run the simulation';
          const outcome = r.u8();
          if (outcome === 0) return '';
          if (outcome !== 1) throw new Error('polkadot: bad dry-run result');
          const weight = r.u8(); // post_info.actual_weight: Option<Weight { ref_time, proof_size }>
          if (weight === 1) { r.compact(); r.compact(); } else if (weight !== 0) throw new Error('polkadot: bad dry-run result');
          r.u8(); // post_info.pays_fee
          return dispatchError(decodeValue(rt.meta, rt.dispatchErrorType, r));
        });
        const verdict = agree('simulation', verdicts);
        if (verdict !== '') throw new UserError('simulation_failed', `simulation failed: ${verdict}`);
      }
      return { section: { x: draft(maxFee).x }, maxFee, feeEstimate: quote, warnings, ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const { txid, decoded } = polkadotParseRaw(raw);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        try { if (await rpcOne<string>(u, 'author_submitExtrinsic', [raw]) !== txid) throw new Error('polkadot: node answered with another hash'); }
        catch (e) {
          // 1013 "Transaction Already Imported": it is in this node's pool
          if ((e as { rpcCode?: number }).rpcCode === 1013) return;
          throw e;
        }
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // refused everywhere ("outdated": the nonce is used): fine only if this very extrinsic is in a block
      try {
        const rt = await checkRuntime(), hd = await any(async (u) => { const h = await rpcOne<{ number: string }>(u, 'chain_getHeader', []); const number = parseInt(h.number, 16); return { number, hash: await blockHash(u, number) }; });
        const era = decoded.era;
        if (era && hd.number >= era.phase) {
          // the era began at the last block ≡ phase (mod period) at or before the head, or one period earlier
          const birth = hd.number - ((hd.number - era.phase) % era.period);
          const found = await any((u) => locate(u, rt, { from: ss58Encode(POLKADOT_SS58_PREFIX, decoded.signer), nonce: Number(decoded.nonce), eraBlock: Math.max(1, birth - era.period), period: 2 * era.period }, txid, hd));
          if (found && found !== 'replaced') return;
        }
      } catch { /* fall through to the node's own error */ }
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message).slice(0, 200));
    },

    async track(p): Promise<Tracked> {
      const i = intentOf(p.intent);
      const pending: Tracked = { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true };
      if (!i) return { state: 'broadcast', confirmations: 0 };
      const rt = await checkRuntime().catch(() => runtime);
      if (!rt) return pending;
      const head = await any(finalized);
      const found = await any((u) => locate(u, rt, i, p.txid, head));
      if (found === 'replaced') {
        // another transaction of this account used the nonce; make sure every source says so before declaring it
        const rs = await Promise.allSettled(sources.map((u) => locate(u, rt, i, p.txid, head)));
        return rs.every((r) => r.status === 'fulfilled' && r.value === 'replaced') ? { state: 'replaced', confirmations: 0, error: 'the account nonce was used by another transaction' } : { state: 'broadcast', confirmations: 0 };
      }
      if (found) {
        // in a block that GRANDPA has finalized: irreversible
        if (found.ok) return { state: 'finalized', confirmations: Math.max(1, n.minConf), blockRef: String(found.block.number) };
        return { state: 'failed', confirmations: 0, blockRef: String(found.block.number), error: `rejected by the chain (${found.error}): the transfer was not made (only the network fee was charged)` };
      }
      // not in a finalized block. Dead once the mortal era has ended on the finalized chain of every source.
      const end = i.eraBlock + i.period;
      if (head.number > end) {
        const heads = await Promise.allSettled(sources.map(finalized));
        if (heads.every((h) => h.status === 'fulfilled' && h.value.number > end)) {
          const again = await Promise.allSettled(sources.map(async (u) => locate(u, rt, i, p.txid, (heads.find((h) => h.status === 'fulfilled') as PromiseFulfilledResult<Ref>).value)));
          if (again.every((r) => r.status === 'fulfilled' && r.value === null)) return { state: 'failed', confirmations: 0, error: 'expired before inclusion (mortal era ended); no funds moved' };
        }
        return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0 };
      }
      // included in a block that is not finalized yet?
      try {
        const best = await any(async (u) => { const h = await rpcOne<{ number: string }>(u, 'chain_getHeader', []); const number = parseInt(h.number, 16); return { number, hash: await blockHash(u, number) }; });
        const soft = await any((u) => locate(u, rt, i, p.txid, best));
        if (soft && soft !== 'replaced' && soft.ok) return { state: 'confirming', confirmations: 0, blockRef: 'best:' + soft.block.number };
      } catch { /* stays pending */ }
      return pending;
    },

    async deposits(addr, cursor) {
      const account = polkadotAccountId(addr);
      const items: Deposit[] = [];
      const head = await any(finalized);
      // first pass: start from the finalized head (nothing older is scanned)
      if (cursor === null || cursor >= head.number) return { items, cursor: cursor === null ? head.number : cursor, finalizedHeight: head.number };
      const rt = await checkRuntime().catch(() => null); // events are decoded with the metadata of the reviewed runtime only
      const to = Math.min(head.number, cursor + DEPOSIT_MAX_SPAN);
      if (!rt) return { items, cursor, finalizedHeight: head.number };
      const u = sources[0]!; // one source for the whole pass (state of the same blocks); the next pass retries on failure
      const stateAt = async (number: number): Promise<{ hash: string; raw: string | null }> => { const h = number === head.number ? head.hash : await blockHash(u, number); return { hash: h, raw: await rawAccount(u, addr, h) }; };
      const a = await stateAt(cursor), b = await stateAt(to);
      // blocks in (cursor, to] where the account's state changed (nonce or balances), oldest first
      const changed: { number: number; hash: string }[] = [];
      const walk = async (lo: number, loRaw: string | null, hi: number, hiState: { hash: string; raw: string | null }): Promise<void> => {
        if (loRaw === hiState.raw || changed.length > DEPOSIT_MAX_BLOCKS) return;
        if (hi - lo === 1) { changed.push({ number: hi, hash: hiState.hash }); return; }
        const mid = lo + Math.floor((hi - lo) / 2), m = await stateAt(mid);
        await walk(lo, loRaw, mid, m);
        await walk(mid, m.raw, hi, hiState);
      };
      await walk(cursor, a.raw, to, b);
      const truncated = changed.length > DEPOSIT_MAX_BLOCKS;
      for (const blk of changed.slice(0, DEPOSIT_MAX_BLOCKS)) {
        let events: Awaited<ReturnType<typeof eventsAt>>;
        try { events = await eventsAt(u, rt, blk.hash); } catch { continue; } // a block of an older runtime that this metadata cannot decode
        let xts: string[] | null = null, time: number | null = null;
        for (const [idx, e] of events.entries()) {
          if (e.pallet !== 'Balances' || (e.name !== 'Transfer' && e.name !== 'Minted')) continue;
          const data = obj(e.data), who = e.name === 'Transfer' ? data.to : data.who, from = e.name === 'Transfer' ? data.from : null, amount = data.amount;
          if (!(who instanceof Uint8Array) || hexOf(who) !== hexOf(account) || typeof amount !== 'bigint' || amount <= 0n) continue;
          if (from instanceof Uint8Array && hexOf(from) === hexOf(account)) continue;
          xts ??= await extrinsicsAt(u, blk.hash);
          time ??= Math.floor((await timestampAt(u, blk.hash)) / 1000);
          const phase = obj(e.phase), k = phase.variant === 'ApplyExtrinsic' && typeof phase.value === 'bigint' ? Number(phase.value) : -1;
          items.push({ txid: k >= 0 && xts[k] ? polkadotTxid(unhex(xts[k], 'extrinsic')) : blk.hash, idx, asset: 'native', amount, from: from instanceof Uint8Array ? ss58Encode(POLKADOT_SS58_PREFIX, from) : '', block: blk.number, time });
        }
      }
      return { items, cursor: truncated ? changed[DEPOSIT_MAX_BLOCKS - 1]!.number : to, finalizedHeight: head.number };
    },
  };
}

/** runtime API identifier: blake2b-64 of the trait name */
const DRY_RUN_API = '0x' + hexOf(blake2b(new TextEncoder().encode('DryRunApi'), { dkLen: 8 }));
/** XCM version asked for the (unused) XCM part of the dry-run result */
const DRY_RUN_XCM_VERSION = 5;
