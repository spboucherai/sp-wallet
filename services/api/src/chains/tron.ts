// TRON adapter: two independent java-tron HTTP APIs (/wallet = head state, /walletsolidity = irreversible state).
// Everything that feeds the signature (reference block, account existence, balances, chain fee parameters, energy)
// is read from both sources and must agree, otherwise prepare() fails closed.
import {
  buildTronTx, formatUnits, getAsset, tronAddressBytes, tronAddressFromBytes, TRON_ACTIVATION_FEE, TRON_BANDWIDTH_PRICE, TRON_CREATE_ACCOUNT_BANDWIDTH_FEE,
  TRON_MAX_FEE_LIMIT, type Intent, type NetworkDef,
} from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, http, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Lifetime of the signed transaction from the moment it is prepared (the protocol allows < 24 h). */
const TX_LIFETIME_MS = 240_000;
const APPROVAL_TTL_SEC = 120;
/** Tolerated distance between our clock and the chain's latest irreversible block (which normally trails by ~1 minute). */
const MAX_CLOCK_DRIFT_MS = 5 * 60_000;
/** Safety margin on the simulated energy: an exhausted fee_limit burns the whole limit and moves nothing. */
const ENERGY_MARGIN_NUM = 5n, ENERGY_MARGIN_DEN = 4n;
const ZERO_OWNER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // 0x41 || 00…00, used as the caller of read-only metadata calls

/** Integers beyond 2^53 (balances in sun can get there) are kept exact as bigint. */
const parseJson = (text: string): any => JSON.parse(text, ((_k: string, v: unknown, ctx?: { source?: string }) =>
  (typeof v === 'number' && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v)) as never);
const big = (v: unknown): bigint => (v === undefined || v === null ? 0n : BigInt(v as number | bigint | string));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const word = (addr: string) => Buffer.from(tronAddressBytes(addr).subarray(1)).toString('hex').padStart(64, '0');

/** Keyless public endpoints are rate limited (TronGrid: 3 requests/s, then a 5 s suspension): one request at a time per host, spaced. */
const queues = new Map<string, Promise<unknown>>();
function throttled<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const gap = /trongrid/.test(base) ? 380 : 40;
  const run = (queues.get(base) ?? Promise.resolve()).then(fn);
  queues.set(base, run.then(() => sleep(gap), () => sleep(gap)));
  return run;
}

interface Src { url: string; post<T = any>(path: string, body?: unknown): Promise<T>; get<T = any>(path: string): Promise<T> }
function source(url: string): Src {
  const call = (path: string, init: RequestInit) => throttled(url, async () => {
    let r = await http(url + path, init);
    if (r.status === 429) { await sleep(5300); r = await http(url + path, init); }
    if (!r.ok) throw new Error(`tron http ${r.status}`);
    const j = parseJson(await r.text());
    if (j && typeof j === 'object' && typeof j.Error === 'string') throw new Error(`tron node error: ${j.Error.slice(0, 120)}`);
    return j;
  });
  return {
    url,
    post: (path, body = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: (path) => call(path, { method: 'GET', headers: { accept: 'application/json' } }),
  };
}

interface Account { exists: boolean; balance: bigint; contract: boolean }
interface Resources { freeNet: bigint; stakedNet: bigint; energy: bigint }
interface BlockRef { number: number; id: string; timestamp: number }
interface ConstantCall { ok: boolean; message: string; result: string; energy: bigint }

const account = async (s: Src, addr: string, solidity = false): Promise<Account> => {
  const a = await s.post(`/${solidity ? 'walletsolidity' : 'wallet'}/getaccount`, { address: addr, visible: true });
  if (!a || typeof a !== 'object') throw new Error('bad getaccount answer');
  if (a.address === undefined) return { exists: false, balance: 0n, contract: false };
  if (a.address !== addr) throw new Error('getaccount answered for another address');
  return { exists: true, balance: big(a.balance), contract: a.type === 'Contract' };
};
const resources = async (s: Src, addr: string): Promise<Resources> => {
  const r = await s.post('/wallet/getaccountresource', { address: addr, visible: true });
  const left = (limit: unknown, used: unknown) => { const v = big(limit) - big(used); return v > 0n ? v : 0n; };
  return { freeNet: left(r.freeNetLimit, r.freeNetUsed), stakedNet: left(r.NetLimit, r.NetUsed), energy: left(r.EnergyLimit, r.EnergyUsed) };
};
const blockRef = (b: any): BlockRef => {
  const number = Number(b?.block_header?.raw_data?.number ?? 0), id = String(b?.blockID ?? ''), timestamp = Number(b?.block_header?.raw_data?.timestamp ?? 0);
  if (!/^[0-9a-f]{64}$/.test(id) || parseInt(id.slice(0, 16), 16) !== number) throw new Error('bad block answer');
  return { number, id, timestamp };
};
const solidHead = async (s: Src) => blockRef(await s.post('/walletsolidity/getnowblock'));
const blockAt = async (s: Src, num: number) => blockRef(await s.post('/wallet/getblockbynum', { num }));
/** Read-only contract execution against head state. A revert is reported in `ok`/`message`, never thrown. */
const constantCall = async (s: Src, owner: string, contract: string, selector: string, parameter: string): Promise<ConstantCall> => {
  const r = await s.post('/wallet/triggerconstantcontract', { owner_address: owner, contract_address: contract, function_selector: selector, parameter, visible: true });
  if (r?.result?.result !== true) throw new Error(`constant call rejected: ${String(r?.result?.message ?? r?.result?.code ?? 'no result').slice(0, 100)}`);
  const failed = !!r.result.message || r.transaction?.ret?.[0]?.ret === 'FAILED';
  return { ok: !failed, message: String(r.result.message ?? ''), result: String(r.constant_result?.[0] ?? ''), energy: big(r.energy_used) };
};
const PARAM_KEYS = ['getTransactionFee', 'getEnergyFee', 'getCreateAccountFee', 'getCreateNewAccountFeeInSystemContract', 'getCreateNewAccountBandwidthRate', 'getMaxFeeLimit'] as const;
type ChainParams = Record<(typeof PARAM_KEYS)[number], bigint>;
const chainParams = async (s: Src): Promise<ChainParams> => {
  const r = await s.post('/wallet/getchainparameters');
  const m = new Map<string, unknown>((r.chainParameter ?? []).map((p: { key: string; value?: unknown }) => [p.key, p.value]));
  return Object.fromEntries(PARAM_KEYS.map((k) => { if (!m.has(k)) throw new Error(`chain parameter ${k} missing`); return [k, big(m.get(k))]; })) as ChainParams;
};

export function tronAdapter(n: NetworkDef): Adapter {
  const sources = n.rpc.map(source);
  const any = async <T>(f: (s: Src) => Promise<T>): Promise<T> => { let last: unknown; for (const s of sources) { try { return await f(s); } catch (e) { last = e; } } throw last; };
  /** first source that knows the object (a source that fails or answers "unknown" is skipped) */
  const firstHit = async <T>(f: (s: Src) => Promise<T | null>): Promise<T | null> => {
    let failures = 0, last: unknown;
    for (const s of sources) { try { const v = await f(s); if (v !== null) return v; } catch (e) { failures += 1; last = e; } }
    if (failures === sources.length) throw last;
    return null;
  };
  /** every source must answer */
  const all = async <T>(what: string, f: (s: Src) => Promise<T>): Promise<T[]> => {
    if (sources.length < 2) throw new UserError('rpc_degraded', `${n.name} needs two independent data sources; transfer refused`, 503);
    const rs = await Promise.allSettled(sources.map(f));
    if (rs.some((r) => r.status === 'rejected')) throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    return rs.map((r) => (r as PromiseFulfilledResult<T>).value);
  };
  /** every source must answer and give the same value */
  const agree = async <T>(what: string, f: (s: Src) => Promise<T>): Promise<T> => {
    const vs = await all(what, f);
    const key = (v: T) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    for (const v of vs) if (key(v) !== key(vs[0]!)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (${what}); transfer refused`, 503);
    return vs[0]!;
  };
  let identity = false;
  const disabled = new Set<string>();
  let tokensChecked = false;
  const tokenBalance = async (s: Src, token: string, owner: string): Promise<bigint> => {
    const c = await constantCall(s, owner, token, 'balanceOf(address)', word(owner));
    if (!c.ok || !/^[0-9a-f]{64}$/.test(c.result)) throw new Error('balanceOf failed');
    return BigInt('0x' + c.result);
  };
  /** the contract itself must report the pinned decimals and symbol, on every source that answers (at least one) */
  async function verifyTokens(): Promise<void> {
    for (const t of n.tokens) {
      const checks = await Promise.allSettled(sources.map(async (s) => {
        const d = await constantCall(s, ZERO_OWNER, t.id, 'decimals()', ''), y = await constantCall(s, ZERO_OWNER, t.id, 'symbol()', '');
        if (!d.ok || !y.ok || !/^[0-9a-f]{64}$/.test(d.result) || y.result.length < 192) return false;
        const len = Number(BigInt('0x' + y.result.slice(64, 128)));
        const sym = Buffer.from(y.result.slice(128, 128 + len * 2), 'hex').toString('utf8');
        return BigInt('0x' + d.result) === BigInt(t.decimals) && sym === (t.onchainSymbol ?? t.symbol);
      }));
      const answers = checks.flatMap((c) => (c.status === 'fulfilled' ? [c.value] : []));
      if (answers.length === 0) throw new Error('token check unavailable');
      if (answers.every(Boolean)) disabled.delete(t.id);
      else { disabled.add(t.id); console.error(`[tron] token ${t.symbol} ${t.id} failed on-chain decimals/symbol check — disabled`); }
    }
    tokensChecked = true;
  }
  const genesisOk = async (s: Src) => (await blockAt(s, 0)).id === n.chainRef;

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (s) => {
        const t = Date.now();
        try {
          const h = blockRef(await s.post('/wallet/getnowblock')).number;
          if (!identity && !(await genesisOk(s))) throw new Error('genesis');
          return { url: hostOf(s.url), ok: true, ms: Date.now() - t, h };
        } catch { return { url: hostOf(s.url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok) && endpoints.length >= 2;
      if (ok) identity = true;
      if (identity && !tokensChecked) await verifyTokens().catch(() => {});
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      const out: Record<string, bigint> = { native: (await any((s) => account(s, addr))).balance };
      for (const t of n.tokens) if (!disabled.has(t.id)) out[t.id] = await any((s) => tokenBalance(s, t.id, addr));
      return out;
    },
    disabledAssets: () => [...disabled],

    async prepare(d): Promise<Prepared> {
      if (d.memo !== undefined && d.memo !== '') throw new UserError('bad_memo', `${n.name} transfers do not carry a memo`);
      if (!(await agree('genesis block', genesisOk))) throw new UserError('rpc_degraded', 'chain identity mismatch; transfer refused', 503);
      const asset = getAsset(n.id, d.asset), native = asset.id === 'native', warnings: string[] = [];
      if (!tokensChecked) await verifyTokens().catch(() => { throw new UserError('rpc_degraded', 'token identity check unavailable; transfer refused', 503); });
      if (disabled.has(asset.id)) throw new UserError('unsupported_asset', 'this token failed its on-chain identity check and is disabled');
      if (n.tokens.some((t) => t.id === d.to)) throw new UserError('bad_destination', 'destination is a token contract');

      // protocol fee parameters: the builder pins the bandwidth price, the account-creation fees are pinned here
      const cp = await agree('chain parameters', chainParams);
      if (cp.getTransactionFee !== TRON_BANDWIDTH_PRICE || cp.getCreateNewAccountFeeInSystemContract !== TRON_ACTIVATION_FEE
        || cp.getCreateAccountFee !== TRON_CREATE_ACCOUNT_BANDWIDTH_FEE || cp.getCreateNewAccountBandwidthRate !== 1n || cp.getEnergyFee <= 0n)
        throw new UserError('rpc_degraded', `${n.name} fee parameters changed on-chain; the wallet must be updated before sending`, 503);

      const src = await agree('source account', (s) => account(s, d.from));
      const dst = await agree('destination account', (s) => account(s, d.to));
      // resource counters recover continuously, so two nodes may differ by a few units: use the lowest
      const res = (await all('account resources', (s) => resources(s, d.from))).reduce((a, b) => ({
        freeNet: a.freeNet < b.freeNet ? a.freeNet : b.freeNet, stakedNet: a.stakedNet < b.stakedNet ? a.stakedNet : b.stakedNet, energy: a.energy < b.energy ? a.energy : b.energy }));
      if (dst.contract) warnings.push('contract_destination');

      // reference block: the newest block that is irreversible on both sources, with the same id on both
      const heads = await all('irreversible block', solidHead);
      const refNum = Math.min(...heads.map((h) => h.number));
      const ref = await agree('reference block', (s) => blockAt(s, refNum));
      if (ref.number !== refNum) throw new UserError('rpc_degraded', 'reference block unavailable; transfer refused', 503);
      const now = Date.now();
      if (heads.some((h) => Math.abs(now - h.timestamp) > MAX_CLOCK_DRIFT_MS)) throw new UserError('rpc_degraded', `${n.name} data sources are behind (or the server clock is off); transfer refused`, 503);
      const x: Record<string, string> = {
        ref_block_bytes: ref.id.slice(12, 16), ref_block_hash: ref.id.slice(16, 32),
        expiration: String(now + TX_LIFETIME_MS), timestamp: String(now),
      };

      // size the transaction with the real builder (placeholder fee values: the size does not depend on maxFee)
      const sized = (fee_limit?: bigint) => buildTronTx({ v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'size-only', network: n.id, chainRef: n.chainRef,
        asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, amount: d.amount.toString(), from: d.from, to: d.to, maxFee: (TRON_MAX_FEE_LIMIT * 2n).toString(),
        createdAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + APPROVAL_TTL_SEC, policyVersion: 0,
        x: fee_limit === undefined ? x : { ...x, fee_limit: fee_limit.toString() } } as Intent, n);
      const bandwidth = (bytes: number) => { const b = BigInt(bytes); return res.stakedNet >= b || res.freeNet >= b ? 0n : b * TRON_BANDWIDTH_PRICE; };

      if (native) {
        const tx = sized();
        let feeEstimate: bigint, maxFee = tx.worstFee;
        if (!dst.exists) {
          // creating the recipient account: 1 TRX, plus 0.1 TRX unless staked bandwidth covers the transaction; no ordinary bandwidth charge
          feeEstimate = TRON_ACTIVATION_FEE + (res.stakedNet >= BigInt(tx.bandwidthBytes) ? 0n : TRON_CREATE_ACCOUNT_BANDWIDTH_FEE);
          const worst = TRON_ACTIVATION_FEE + TRON_CREATE_ACCOUNT_BANDWIDTH_FEE;
          if (worst > maxFee) maxFee = worst;
          warnings.push('activates_account');
        } else feeEstimate = bandwidth(tx.bandwidthBytes);
        if (src.balance < d.amount + feeEstimate) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol} for amount plus network fee${dst.exists ? '' : ' (the recipient address is new: activating it costs about 1.1 TRX)'}`);
        return { section: { x }, maxFee, feeEstimate, warnings, ttlSec: APPROVAL_TTL_SEC };
      }

      // TRC-20: balance and a full simulation of the exact call on both sources
      const held = await agree(`${asset.symbol} balance`, (s) => tokenBalance(s, asset.id, d.from));
      if (held < d.amount) throw new UserError('insufficient_funds', `insufficient ${asset.symbol} balance`);
      const param = word(d.to) + d.amount.toString(16).padStart(64, '0');
      const sims = await all('transfer simulation', (s) => constantCall(s, d.from, asset.id, 'transfer(address,uint256)', param));
      const bad = sims.find((s) => !s.ok);
      if (bad) throw new UserError('simulation_failed', `simulation failed: ${bad.message.slice(0, 120) || 'reverted'}`);
      if (sims.some((s) => s.energy !== sims[0]!.energy || s.energy <= 0n)) throw new UserError('rpc_disagreement', `${n.name} data sources disagree (energy estimate); transfer refused`, 503);
      const energy = sims[0]!.energy;
      const energyCap = (energy * ENERGY_MARGIN_NUM + ENERGY_MARGIN_DEN - 1n) / ENERGY_MARGIN_DEN;
      const feeLimit = energyCap * cp.getEnergyFee;
      if (feeLimit > cp.getMaxFeeLimit || feeLimit > TRON_MAX_FEE_LIMIT) throw new UserError('fee_too_high', 'energy cost exceeds the protocol fee limit');
      const tx = sized(feeLimit);
      const burnFor = (e: bigint) => (e > res.energy ? (e - res.energy) * cp.getEnergyFee : 0n);
      const feeEstimate = bandwidth(tx.bandwidthBytes) + burnFor(energy);
      // the account must be able to pay for the whole margin, otherwise the call could run out of energy and burn the fee for nothing
      const needed = bandwidth(tx.bandwidthBytes) + burnFor(energyCap);
      if (!src.exists || src.balance < needed) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} to pay for the energy of this ${asset.symbol} transfer (about ${formatUnits(needed, n.native.decimals)} ${n.native.symbol} needed)`);
      return { section: { x: { ...x, fee_limit: feeLimit.toString() } }, maxFee: tx.worstFee, feeEstimate, warnings, ttlSec: APPROVAL_TTL_SEC };
    },

    async broadcast(raw) {
      if (!/^([0-9a-f]{2})+$/.test(raw)) throw new Error('bad transaction encoding');
      const rs = await Promise.allSettled(sources.map(async (s) => {
        const r = await s.post('/wallet/broadcasthex', { transaction: raw });
        if (r?.result === true || r?.code === 'SUCCESS' || r?.code === 'DUP_TRANSACTION_ERROR') return;
        const msg = typeof r?.message === 'string' && /^([0-9a-f]{2})+$/i.test(r.message) ? Buffer.from(r.message, 'hex').toString('utf8') : String(r?.message ?? '');
        throw new Error(`${r?.code ?? 'rejected'}: ${msg}`.slice(0, 200));
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const value = p.txid;
      // 1. irreversible state: the only place a transfer is reported finalized or failed-on-chain
      const solid = await firstHit(async (s) => {
        const info = await s.post('/walletsolidity/gettransactioninfobyid', { value });
        if (info?.id !== value) return null;
        const tx = await s.post('/walletsolidity/gettransactionbyid', { value });
        if (tx?.txID !== value) return null;
        return { info, tx };
      });
      if (solid) {
        const blockRef = String(solid.info.blockNumber), ret = solid.tx.ret?.[0]?.contractRet, receipt = solid.info.receipt?.result;
        if (ret !== 'SUCCESS' || solid.info.result === 'FAILED' || (receipt !== undefined && receipt !== 'SUCCESS')) {
          const why = typeof solid.info.resMessage === 'string' ? Buffer.from(solid.info.resMessage, 'hex').toString('utf8') : '';
          return { state: 'failed', confirmations: n.minConf, blockRef, error: `on-chain failure: ${ret ?? receipt ?? 'unknown'}${why ? ` (${why.slice(0, 80)})` : ''}; the network fee was still charged` };
        }
        return { state: 'finalized', confirmations: n.minConf, blockRef };
      }
      // 2. included but not yet irreversible
      const pending = await firstHit(async (s) => { const info = await s.post('/wallet/gettransactioninfobyid', { value }); return info?.id === value ? info : null; });
      if (pending) {
        const head = await any(async (s) => blockRef(await s.post('/wallet/getnowblock')).number);
        return { state: 'confirming', confirmations: Math.max(1, Math.min(n.minConf - 1, head - Number(pending.blockNumber) + 1)), blockRef: String(pending.blockNumber) };
      }
      // 3. not in any block. It can only be declared dead when BOTH sources have irreversible blocks past its expiration and neither knows it.
      const expiration = Number(p.intent?.x?.expiration ?? 0);
      if (expiration > 0) {
        const dead = await Promise.allSettled(sources.map(async (s) => {
          const h = await solidHead(s);
          const info = await s.post('/wallet/gettransactioninfobyid', { value });
          return h.timestamp > expiration + 6000 && info?.id !== value;
        }));
        if (dead.length >= 2 && dead.every((r) => r.status === 'fulfilled' && r.value))
          return { state: 'failed', confirmations: 0, error: 'expired before inclusion; no funds moved' };
      }
      return { state: p.blockRef ? 'reorged' : 'broadcast', confirmations: 0, rebroadcast: true };
    },

    /**
     * Discovery uses the TronGrid history index (confirmed = irreversible only); every candidate is then re-read from the
     * irreversible state of a full node — the independent second source when it answers — and amounts/recipient/success
     * are taken from the node, never from the index. Cursor = block timestamp (ms) of the newest deposit already seen.
     */
    async deposits(addr, cursor) {
      const finalizedHeight = (await any(solidHead)).number;
      const index = sources.find((s) => /trongrid/.test(s.url));
      const items: Deposit[] = [];
      if (!index) return { items, cursor: cursor ?? 0, finalizedHeight };
      const PAGE = 30;
      const page = cursor === null ? `limit=${PAGE}&order_by=block_timestamp,desc` : `limit=${PAGE}&order_by=block_timestamp,asc&min_timestamp=${cursor + 1}`;
      const found = new Map<string, number>(); // txid -> block timestamp
      // when a listing is cut by the page size, nothing newer than its last full block may be consumed in this pass
      let bound = Number.MAX_SAFE_INTEGER;
      const list = async (path: string) => {
        const r = await index.get(path);
        if (r?.success !== true || !Array.isArray(r.data)) throw new Error('history index unavailable');
        const data = r.data as { block_timestamp: number }[];
        if (cursor !== null && data.length >= PAGE) {
          const lastTs = Number(data[data.length - 1]!.block_timestamp);
          bound = Math.min(bound, data.some((t) => Number(t.block_timestamp) < lastTs) ? lastTs - 1 : lastTs);
        }
        return data as any[];
      };
      for (const t of await list(`/v1/accounts/${addr}/transactions?only_confirmed=true&only_to=true&${page}`))
        if (t?.raw_data?.contract?.[0]?.type === 'TransferContract' && /^[0-9a-f]{64}$/.test(t.txID)) found.set(t.txID, Number(t.block_timestamp));
      for (const tok of n.tokens) {
        if (disabled.has(tok.id)) continue;
        for (const t of await list(`/v1/accounts/${addr}/transactions/trc20?only_confirmed=true&only_to=true&contract_address=${tok.id}&${page}`))
          if (/^[0-9a-f]{64}$/.test(t?.transaction_id)) found.set(t.transaction_id, Number(t.block_timestamp));
      }
      const verifiers = [...sources.filter((s) => s !== index), index];
      const me = word(addr);
      let next = cursor ?? 0;
      // the index treats min_timestamp loosely (the boundary block comes back): keep strictly newer entries only
      const ordered = [...found].filter(([, ts]) => ts <= bound && ts > (cursor ?? -1)).sort((a, b) => a[1] - b[1]);
      for (const [txid] of ordered) {
        const v = await (async () => { let last: unknown; for (const s of verifiers) { try {
          const info = await s.post('/walletsolidity/gettransactioninfobyid', { value: txid });
          const tx = await s.post('/walletsolidity/gettransactionbyid', { value: txid, visible: true });
          if (info?.id !== txid || tx?.txID !== txid) throw new Error('not irreversible on the verifying node yet');
          return { info, tx };
        } catch (e) { last = e; } } throw last; })();
        const block = Number(v.info.blockNumber), time = Math.floor(Number(v.info.blockTimeStamp) / 1000) || null, ts = Number(v.info.blockTimeStamp);
        const c = v.tx.raw_data?.contract?.[0], pv = c?.parameter?.value;
        const success = v.tx.ret?.[0]?.contractRet === 'SUCCESS' && v.info.result !== 'FAILED' && (v.info.receipt?.result ?? 'SUCCESS') === 'SUCCESS';
        if (success && c?.type === 'TransferContract' && pv?.to_address === addr && pv.owner_address !== addr && big(pv.amount) > 0n)
          items.push({ txid, idx: 0, asset: 'native', amount: big(pv.amount), from: String(pv.owner_address), block, time });
        if (success) (v.info.log ?? []).forEach((l: { address: string; topics?: string[]; data?: string }, k: number) => {
          const tok = n.tokens.find((t) => !disabled.has(t.id) && Buffer.from(tronAddressBytes(t.id).subarray(1)).toString('hex') === l.address);
          if (!tok || l.topics?.length !== 3 || l.topics[0] !== TRANSFER_TOPIC || l.topics[2] !== me || !/^[0-9a-f]{64}$/.test(l.data ?? '')) return;
          const amount = BigInt('0x' + l.data), from = tronAddressFromBytes(Uint8Array.from(Buffer.from('41' + l.topics[1]!.slice(24), 'hex')));
          if (amount > 0n && from !== addr) items.push({ txid, idx: 1 + k, asset: tok.id, amount, from, block, time });
        });
        if (ts > next) next = ts;
      }
      return { items, cursor: next, finalizedHeight };
    },
  };
}
