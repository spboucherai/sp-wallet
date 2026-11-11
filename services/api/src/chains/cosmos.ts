// Cosmos SDK adapter (Cosmos Hub): native coin only. LCD/REST (gRPC-gateway) over HTTPS, two independent sources.
// Everything that feeds the signature (account number, sequence, spendable balance, gas price, destination account type)
// is read from both sources at one and the same block height (`x-cosmos-block-height`), whose hash both sources must
// agree on, and must be identical; gas comes from a dry run on both sources. Otherwise the transfer is refused.
//
// Limits (stated, not worked around):
// - Public REST nodes prune early history: no early block hash can be pinned. Identity = the chain id reported by both
//   sources (it is also signed into every transaction) + both sources agreeing on the hash of a recent block.
// - The REST API does not expose the mempool: a transfer of ours that is broadcast but not yet in a block is invisible
//   here; a second transfer prepared meanwhile carries the same sequence and is rejected by the chain (nothing is lost).
// - Deposits come from the nodes' transaction index (`transfer.recipient`), which public nodes prune after a few weeks
//   and which can only be read newest-first: at most 250 new transactions are examined per pass. Balances do not depend on it.
// - Fees follow x/feemarket (Cosmos Hub). A chain without that module needs another fee source before it is registered.
import { cosmosAddressBytes, cosmosMemo, cosmosSimulationTx, cosmosTxid, type Intent, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

/** timeout_height = reference block + 30 ≈ 170 s at 5.7 s per block; the approval window (90 s) leaves ≥ 10 blocks for inclusion */
const BLOCK_WINDOW = 30, TTL_SEC = 90;
/** sources further apart than this are not looking at the same chain tip */
const MAX_TIP_SPREAD = 5;
/** a tip older than this means the node is stalled or still syncing */
const MAX_TIP_AGE_SEC = 180;
/**
 * Gas. `simulate` does not run the fee market's post-handler, so it under-reports: a plain send simulates at ≈ 86 000 gas and
 * really uses 100 000–119 000 (40 recent mainnet sends, 2026-11-10). Limit = max(200 000, 2 × simulated); the fee is paid on
 * the limit, not on the gas used (200 000 gas ≈ 0.0015 ATOM), so the generous limit costs a fraction of a cent.
 */
const GAS_FLOOR = 200_000n, GAS_CEIL = 1_000_000n;
/** gas price offered = 1.5 × the price required at the reference block (the fee market moves by at most 12.5 % per block) */
const PRICE_NUM = 3n, PRICE_DEN = 2n;
/** the fee offered never exceeds this (base units); equals the default policy ceiling */
const FEE_CAP: Record<string, bigint> = { 'cosmoshub-4': 50_000n };
/** not found by either source this many blocks after the timeout, with the sequence consumed: another transaction took its place */
const REPLACED_AFTER = 20;
const DEC = 10n ** 18n;
const NOT_FOUND = 5; // gRPC status
const BASE_ACCOUNT = '/cosmos.auth.v1beta1.BaseAccount', MODULE_ACCOUNT = '/cosmos.auth.v1beta1.ModuleAccount';
const PAGE = 50, MAX_PAGES = 5;

interface BlockRes { block_id?: { hash?: string }; block?: { header?: { height?: string; chain_id?: string; time?: string } } }
interface AccountRes { account?: { '@type'?: string; account_number?: string; sequence?: string; base_account?: { account_number?: string; sequence?: string } } }
interface TxResponse { height?: string; txhash?: string; code?: number; codespace?: string; raw_log?: string; timestamp?: string; events?: { type?: string; attributes?: { key?: string; value?: string }[] }[] }
interface Account { type: string; accountNumber: string; sequence: string }
type Tip = { height: number; hash: string };

const fail = (message: string, extra: object = {}) => Object.assign(new Error(message), extra);
const grpcOf = (e: unknown): number | undefined => (e as { grpc?: number }).grpc;
const uintStr = (v: unknown, what: string): string => { if (typeof v !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(v)) throw new Error(`rest: bad ${what}`); return v; };
/** "0.005000000000000000" → 18-decimal fixed point */
function dec(v: unknown, what: string): bigint {
  const m = typeof v === 'string' ? /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(v) : null;
  if (!m) throw new Error(`rest: bad ${what}`);
  return BigInt(m[1]!) * DEC + BigInt((m[2] ?? '').padEnd(18, '0'));
}
const fmt = (v: bigint, decimals: number) => { const d = 10n ** BigInt(decimals); const f = (v % d).toString().padStart(decimals, '0').replace(/0+$/, ''); return `${v / d}${f ? '.' + f : ''}`; };

/** One REST call. `height` pins the state the node answers from; the answer must say it used exactly that height. */
async function rest<T>(base: string, path: string, opt: { height?: number; body?: unknown } = {}): Promise<T> {
  const r = await http(base + path, { method: opt.body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(opt.body === undefined ? {} : { 'content-type': 'application/json' }), ...(opt.height === undefined ? {} : { 'x-cosmos-block-height': String(opt.height) }) },
    ...(opt.body === undefined ? {} : { body: JSON.stringify(opt.body) }) });
  let j: unknown;
  try { j = JSON.parse(await r.text()); } catch { throw fail(`rest http ${r.status}`, { status: r.status }); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw fail('rest: empty result', { status: r.status });
  const e = j as { code?: unknown; message?: unknown };
  // an error body of the gateway is { code, message, details }; anything not 2xx is an error too
  if (!r.ok || (typeof e.code === 'number' && typeof e.message === 'string' && 'details' in e))
    throw fail(typeof e.message === 'string' ? e.message : `rest http ${r.status}`, { status: r.status, ...(typeof e.code === 'number' && typeof e.message === 'string' ? { grpc: e.code } : {}) });
  if (opt.height !== undefined && r.headers.get('x-cosmos-block-height') !== String(opt.height)) throw fail('rest: answered for another height');
  return j as T;
}

export function cosmosAdapter(n: NetworkDef): Adapter {
  const c = n.cosmos;
  if (!c) throw new Error(`no Cosmos SDK parameters for network ${n.id}`);
  const feeCap = FEE_CAP[n.chainRef];
  if (feeCap === undefined) throw new Error(`no fee ceiling for Cosmos SDK network ${n.id}`);
  const sources = n.rpc;
  if (sources.length < 2) throw new Error(`${n.name} needs two independent sources`);
  const { denom, bech32: prefix } = c;
  let identity = false;

  /** First source that gives an answer about the chain wins (display-only reads). */
  const any = async <T>(f: (u: string) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const u of sources) { try { return await f(u); } catch (e) { last = e; if (grpcOf(e) === NOT_FOUND) throw e; } }
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

  const blockOf = (r: BlockRes, want?: number): Tip & { time: number } => {
    const h = r.block?.header, height = Number(h?.height), hash = r.block_id?.hash, time = Date.parse(String(h?.time));
    if (h?.chain_id !== n.chainRef) throw new Error('identity: chain id mismatch');
    if (!Number.isSafeInteger(height) || height < 1 || (want !== undefined && height !== want) || typeof hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(hash) || !Number.isFinite(time)) throw new Error('rest: bad block');
    return { height, hash, time };
  };
  /** Latest block of a source: right chain id, and recent (a stalled or syncing node is not a source). */
  const tip = async (u: string): Promise<Tip> => {
    const b = blockOf(await rest<BlockRes>(u, '/cosmos/base/tendermint/v1beta1/blocks/latest'));
    if (Date.now() - b.time > MAX_TIP_AGE_SEC * 1000) throw new Error('rest: node is behind');
    return { height: b.height, hash: b.hash };
  };
  const blockAt = async (u: string, height: number): Promise<string> => blockOf(await rest<BlockRes>(u, `/cosmos/base/tendermint/v1beta1/blocks/${height}`), height).hash;
  const checkIdentity = async (u: string): Promise<void> => {
    const r = await rest<{ default_node_info?: { network?: string } }>(u, '/cosmos/base/tendermint/v1beta1/node_info');
    if (r.default_node_info?.network !== n.chainRef) throw new Error('identity: chain id mismatch');
  };
  /** One reference block: the lower of the two tips, with the same hash on both sources. */
  const reference = async (tips: Tip[]): Promise<number> => {
    const height = Math.min(...tips.map((t) => t.height));
    if (Math.max(...tips.map((t) => t.height)) - height > MAX_TIP_SPREAD) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same block; transfer refused`, 503);
    agree('reference block', await all('block', (u) => blockAt(u, height)));
    return height;
  };

  /** Account at one height (latest when omitted); null when it does not exist on chain. */
  const account = async (u: string, addr: string, height?: number): Promise<Account | null> => {
    try {
      const a = (await rest<AccountRes>(u, `/cosmos/auth/v1beta1/accounts/${addr}`, height === undefined ? {} : { height })).account;
      const type = a?.['@type'];
      if (!a || typeof type !== 'string') throw new Error('rest: bad account');
      if (type !== BASE_ACCOUNT) return { type, accountNumber: '', sequence: '' };
      return { type, accountNumber: uintStr(a.account_number, 'account_number'), sequence: uintStr(a.sequence, 'sequence') };
    } catch (e) { if (grpcOf(e) === NOT_FOUND) return null; throw e; }
  };
  const spendable = async (u: string, addr: string, height?: number): Promise<bigint> => {
    const r = await rest<{ balance?: { denom?: string; amount?: string } }>(u, `/cosmos/bank/v1beta1/spendable_balances/${addr}/by_denom?denom=${encodeURIComponent(denom)}`, height === undefined ? {} : { height });
    if (r.balance?.denom !== denom || typeof r.balance.amount !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(r.balance.amount)) throw new Error('rest: bad balance');
    return BigInt(r.balance.amount);
  };
  /** Gas price required by consensus at a height (x/feemarket), 18-decimal fixed point. */
  const marketPrice = async (u: string, height: number): Promise<bigint> => {
    const r = await rest<{ price?: { denom?: string; amount?: string } }>(u, `/feemarket/v1/gas_price/${encodeURIComponent(denom)}`, { height });
    if (r.price?.denom !== denom) throw new Error('rest: bad gas price');
    return dec(r.price.amount, 'gas price');
  };
  /** The node's own mempool floor ("0.005uatom,…"); 0 when it has none for this denom. Per node, so not subject to agreement. */
  const nodeFloor = async (u: string): Promise<bigint> => {
    const r = await rest<{ minimum_gas_price?: string }>(u, '/cosmos/base/node/v1beta1/config');
    if (typeof r.minimum_gas_price !== 'string') throw new Error('rest: bad node config');
    for (const part of r.minimum_gas_price.split(',')) { const m = /^(\d+(?:\.\d+)?)(.+)$/.exec(part.trim()); if (m && m[2] === denom) return dec(m[1], 'minimum gas price'); }
    return 0n;
  };
  const lookup = async (u: string, txid: string): Promise<TxResponse | null> => {
    try {
      const t = (await rest<{ tx_response?: TxResponse }>(u, `/cosmos/tx/v1beta1/txs/${txid}`)).tx_response;
      if (!t || String(t.txhash ?? '').toUpperCase() !== txid.toUpperCase() || !(Number(t.height) > 0) || typeof t.code !== 'number') throw new Error('rest: tx answered for another hash');
      return t;
    } catch (e) { if (grpcOf(e) === NOT_FOUND) return null; throw e; }
  };

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const tp = await tip(url);
          if (!identity) await checkIdentity(url);
          return { url: hostOf(url), ok: true, ms: Date.now() - t, tip: tp as Tip | null };
        } catch { return { url: hostOf(url), ok: false, ms: null, tip: null as Tip | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok && !identity) { try { await reference(endpoints.map((e) => e.tip!)); identity = true; } catch { /* stays unverified */ } }
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.tip?.height ?? 0)) || null,
        endpoints: endpoints.map(({ tip: _t, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      cosmosAddressBytes(prefix, addr);
      return { native: await any((u) => spendable(u, addr)) }; // an account that does not exist yet reads as 0
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', `only ${n.native.symbol} can be sent on ${n.name}`);
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
      try { cosmosMemo(d.memo); } catch (e) { throw new UserError('bad_memo', (e as Error).message); }
      try { cosmosAddressBytes(prefix, d.from); cosmosAddressBytes(prefix, d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (!identity) await all('identity', checkIdentity);

      // one reference block, present on both sources with the same hash
      const ref = await reference(await all('block', tip));
      identity = true;

      const [srcs, dsts, bals, prices, floors] = await Promise.all([
        all('account', (u) => account(u, d.from, ref)),
        all('account', (u) => account(u, d.to, ref)),
        all('balance', (u) => spendable(u, d.from, ref)),
        all('gas price', (u) => marketPrice(u, ref)),
        all('node config', nodeFloor),
      ]);
      const src = agree('source account', srcs), dst = agree('destination account', dsts);
      const balance = BigInt(agree('balance', bals.map(String)));
      let price = BigInt(agree('gas price', prices.map(String)));
      for (const f of floors) if (f > price) price = f;
      if (price <= 0n) throw new UserError('rpc_degraded', `${n.name} fee data unusable; transfer refused`, 503);

      if (!src) throw new UserError('insufficient_funds', `this wallet's ${n.name} account does not exist on chain yet: it has never received funds`);
      if (src.type !== BASE_ACCOUNT) throw new UserError('unsupported_account', `this ${n.name} account is not a plain account (${src.type.split('.').pop()}); this wallet cannot send from it`);
      if (dst && dst.type === MODULE_ACCOUNT) throw new UserError('bad_destination', 'the destination is a module account of the chain; transfers to it are refused');
      // a destination that does not exist yet is created by the transfer; nothing stays locked in it

      const feeFor = (gas: bigint) => (gas * price * PRICE_NUM + PRICE_DEN * DEC - 1n) / (PRICE_DEN * DEC);
      const check = (fee: bigint) => {
        if (fee > feeCap) throw new UserError('fee_too_high', `the network fee (${fmt(fee, n.native.decimals)} ${n.native.symbol}) is above this wallet's ceiling; retry later`);
        if (balance < d.amount + fee) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol}: the amount plus the network fee (${fmt(fee, n.native.decimals)} ${n.native.symbol}) exceeds the spendable balance (${fmt(balance, n.native.decimals)} ${n.native.symbol})`);
      };
      const timeoutHeight = ref + BLOCK_WINDOW;
      const section = (gas: bigint, fee: bigint) => ({ account_number: src.accountNumber, sequence: src.sequence, gas_limit: gas.toString(), fee_amount: fee.toString(), timeout_height: String(timeoutHeight) });
      let gas = GAS_FLOOR, fee = feeFor(gas);
      check(fee);

      // dry run of this exact transfer (no public key, no signature: it cannot be broadcast) on the latest state of both sources
      const draft: Intent = { v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'simulation', createdAt: 1, expiresAt: 2, policyVersion: 0, network: n.id, chainRef: n.chainRef,
        asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: fee.toString(),
        ...(d.memo !== undefined ? { memo: d.memo } : {}), x: section(gas, fee) };
      const tx_bytes = cosmosSimulationTx(draft, n);
      const used = await all('simulation', async (u) => {
        try {
          const r = await rest<{ gas_info?: { gas_used?: string } }>(u, '/cosmos/tx/v1beta1/simulate', { body: { tx_bytes } });
          const g = BigInt(uintStr(r.gas_info?.gas_used, 'gas_used'));
          if (g <= 0n) throw new Error('rest: bad gas_used');
          return g;
        } catch (e) {
          const status = (e as { status?: number }).status, msg = (e as Error).message;
          // the chain's own verdict on the transaction (gRPC Unknown / InvalidArgument carried by HTTP 400 or 500); anything else is the node failing
          if ((grpcOf(e) === 2 || grpcOf(e) === 3) && (status === 400 || status === 500)) {
            if (/account sequence mismatch/.test(msg)) throw new UserError('pending_tx', 'a previous transaction from this wallet has just been confirmed; retry in a few seconds', 409);
            throw new UserError('simulation_failed', `simulation failed: ${msg.replace(/\s*\[[^\]]*\]/g, '').slice(0, 200)}`);
          }
          throw e;
        }
      });
      const simulated = used.reduce((a, b) => (b > a ? b : a));
      if (simulated * 2n > gas) gas = simulated * 2n;
      if (gas > GAS_CEIL) throw new UserError('simulation_failed', `simulation failed: a plain transfer should not need ${simulated} gas`);
      fee = feeFor(gas);
      check(fee);

      return { section: { x: section(gas, fee) }, maxFee: fee, feeEstimate: fee, warnings: [], ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const txid = cosmosTxid(raw);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        let why: string;
        try {
          const t = (await rest<{ tx_response?: TxResponse }>(u, '/cosmos/tx/v1beta1/txs', { body: { tx_bytes: raw, mode: 'BROADCAST_MODE_SYNC' } })).tx_response;
          if (!t || typeof t.code !== 'number') throw new Error('rest: bad broadcast answer');
          // accepted into the mempool, or already there (sdk code 19)
          if ((t.code === 0 && String(t.txhash ?? '').toUpperCase() === txid) || (t.code === 19 && (t.codespace ?? 'sdk') === 'sdk')) return;
          why = `code ${t.code}${t.codespace ? ` (${t.codespace})` : ''}: ${String(t.raw_log ?? '').slice(0, 160)}`;
        } catch (e) { if (grpcOf(e) === undefined) throw e; why = (e as Error).message.slice(0, 160); }
        // "sequence already used", "already in cache", "timed out": fine only if this very transaction is in a block
        if (await lookup(u, txid)) return;
        throw new Error(why);
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const rs = await Promise.allSettled(sources.map((u) => lookup(u, p.txid)));
      const seen = rs.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))[0];
      if (seen) {
        // Tendermint finality: a transaction in a committed block is final
        if (seen.code === 0) return { state: 'finalized', confirmations: Math.max(1, n.minConf), blockRef: String(seen.height) };
        return { state: 'failed', confirmations: 0, blockRef: String(seen.height),
          error: `rejected by the chain (code ${seen.code}${seen.codespace ? ` ${seen.codespace}` : ''}: ${String(seen.raw_log ?? '').slice(0, 160)}): the transfer was not made (only the network fee was charged)` };
      }
      // Not found. It is dead only when every source says so and every source is past timeout_height.
      const timeout = Number(p.intent?.x?.timeout_height), from = p.intent?.from as unknown;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || typeof from !== 'string' || !rs.every((r) => r.status === 'fulfilled')) return { state: 'broadcast', confirmations: 0, rebroadcast: true };
      const tips = await Promise.allSettled(sources.map(tip));
      const heights = tips.flatMap((t) => (t.status === 'fulfilled' ? [t.value.height] : []));
      if (heights.length < sources.length) return { state: 'broadcast', confirmations: 0, rebroadcast: true };
      const past = Math.min(...heights) - timeout;
      if (past <= 0) return { state: 'broadcast', confirmations: 0, rebroadcast: true };
      // Past the timeout the chain can no longer accept it. Proof that it never got in: the sequence it would have consumed is still unused.
      const accts = await Promise.allSettled(sources.map((u) => account(u, from)));
      const seqs = accts.flatMap((a) => (a.status === 'fulfilled' ? [a.value?.sequence ?? p.intent.x.sequence] : []));
      if (seqs.length === sources.length) {
        if (seqs.every((s) => s === p.intent.x.sequence)) return { state: 'failed', confirmations: 0, error: 'expired before inclusion (timeout height passed); no funds moved' };
        // sequence consumed and, well after the timeout, still unknown to both indexes: another transaction used that sequence
        if (past > REPLACED_AFTER) return { state: 'replaced', confirmations: 0, error: 'the sequence was consumed by another transaction' };
      }
      return { state: 'broadcast', confirmations: 0 };
    },

    async deposits(addr, cursor) {
      cosmosAddressBytes(prefix, addr);
      const tipHeight = (await any(tip)).height;
      const items: Deposit[] = [];
      if (cursor !== null && cursor >= tipHeight) return { items, cursor, finalizedHeight: tipHeight };
      const query = encodeURIComponent(`transfer.recipient='${addr}'`);
      // newest first (public nodes refuse height ranges in the query); first scan: the most recent page only
      for (let page = 1, more = true; more && page <= (cursor === null ? 1 : MAX_PAGES); page++) {
        let list: TxResponse[];
        try { list = (await any((u) => rest<{ tx_responses?: TxResponse[] }>(u, `/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&limit=${PAGE}&page=${page}`))).tx_responses ?? []; }
        catch (e) { if (page > 1 && grpcOf(e) !== undefined) break; throw e; } // past the last page
        if (!Array.isArray(list)) throw new Error('rest: bad search answer');
        more = list.length === PAGE;
        for (const t of list) {
          const height = Number(t.height), txid = String(t.txhash ?? '').toUpperCase(), time = Date.parse(String(t.timestamp));
          if (!Number.isSafeInteger(height) || height < 1 || height > tipHeight || !/^[0-9A-F]{64}$/.test(txid)) continue;
          if (cursor !== null && height <= cursor) { more = false; continue; }
          if (t.code !== 0) continue;
          // every `transfer` event of the transaction that credits this address in the native denom (sends, multi-sends, IBC receipts, rewards)
          (t.events ?? []).filter((e) => e.type === 'transfer').forEach((e, idx) => {
            const a = Object.fromEntries((e.attributes ?? []).map((x) => [String(x.key), String(x.value)]));
            if (a.recipient !== addr || a.sender === addr) return;
            let amount = 0n;
            for (const part of String(a.amount ?? '').split(',')) { const m = /^([1-9]\d{0,30})(.+)$/.exec(part); if (m && m[2] === denom) amount += BigInt(m[1]!); }
            if (amount > 0n) items.push({ txid, idx, asset: 'native', amount, from: a.sender ?? '', block: height, time: Number.isFinite(time) ? Math.floor(time / 1000) : null });
          });
        }
      }
      return { items, cursor: tipHeight, finalizedHeight: tipHeight };
    },
  };
}
