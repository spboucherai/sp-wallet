// Sui adapter: two independent full nodes (n.rpc) reached over gRPC (sui.rpc.v2; see sui-grpc.ts — public nodes no longer serve
// JSON-RPC). Everything that feeds the signature — the sender's coin objects (id, version, digest, balance), the epoch, the
// reference gas price — is read from both nodes and must agree, and the exact bytes to be signed are simulated on both nodes with
// identical results, or the transfer is refused.
//
// Finality: a transaction included in a checkpoint is final on Sui (checkpoints are certified by a validator quorum and never
// reorganised). A transaction that was not executed by the end of its expiration epoch can never execute.
import { buildSuiTx, formatUnits, SUI_MAX_GAS_COINS, suiAddressBytes, suiFormatPayment, suiParseRaw, type Intent, type NetworkDef, type SuiObjectRef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';
import {
  decode, encode, GRPC_NOT_FOUND, GRPC_OUT_OF_RANGE, grpcCall, GrpcError, M,
  type BalanceMsg, type EpochMsg, type ExecutedTx, type GasMsg, type GrpcCall, type ListedTx, type ObjectMsg, type Schema, type ServiceInfo,
} from './sui-grpc.ts';

const SUI_TYPE = `0x${'0'.repeat(63)}2::sui::SUI`;
const SUI_COIN_TYPE = `0x${'0'.repeat(63)}2::coin::Coin<${SUI_TYPE}>`;
const LEDGER = '/sui.rpc.v2.LedgerService/', STATE = '/sui.rpc.v2.StateService/', EXEC = '/sui.rpc.v2.TransactionExecutionService/';
const OWNER_ADDRESS = 1; // Owner.OwnerKind.ADDRESS
const END_ITEM_LIMIT = 1, END_SCAN_LIMIT = 2; // QueryEndReason

/** approval window in seconds (the transaction itself stays valid until the end of the current epoch, at most about a day) */
const TTL_SEC = 120;
/** budget used for the first simulation, and the most this adapter ever asks the owner to approve as a fee ceiling: 0.02 SUI */
const PROBE_BUDGET = 20_000_000n;
/** the protocol refuses a budget below this many gas units at the transaction's gas price (base_tx_cost_fixed is 1000) */
const MIN_BUDGET_UNITS = 2_000n;
/** coins of the sender read per source, at most (5 pages of 200) */
const PAGE = 200, MAX_PAGES = 5;
/** sources may be this many checkpoints apart (about 4 per second); node time and server clock may differ by this many seconds */
const MAX_CHECKPOINT_GAP = 240n, MAX_CLOCK_SKEW_SEC = 60, STALE_SEC = 300;
/** a "not executed" verdict needs every source this many checkpoints past the end of the expiration epoch */
const EXPIRY_MARGIN = 40n;
const EXECUTE_TIMEOUT_MS = 20_000;

const big = (v: bigint | undefined, what: string): bigint => { if (typeof v !== 'bigint') throw new Error(`sui: missing ${what}`); return v; };
const safe = (v: bigint | undefined, what: string): number => { const b = big(v, what); if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sui: ${what} out of range`); return Number(b); };
const notFound = (e: unknown) => e instanceof GrpcError && e.grpcCode === GRPC_NOT_FOUND;

interface Coin extends SuiObjectRef { balance: bigint }
interface Sim { success: boolean; error: string; gas: { computation: string; storage: string; rebate: string }; changes: string[] }

export function suiAdapter(n: NetworkDef, call: GrpcCall = grpcCall): Adapter {
  const sources = n.rpc;
  const rpc = async <T>(u: string, method: string, reqS: Schema, resS: Schema, req: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
    const frames = await call(u, method, encode(reqS, req), timeoutMs);
    if (frames.length !== 1) throw new Error('sui: expected exactly one response message');
    return decode<T>(resS, frames[0]!);
  };
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

  /** node position; verifies the chain identity (genesis checkpoint digest) on every call */
  const info = async (u: string) => {
    const r = await rpc<ServiceInfo>(u, LEDGER + 'GetServiceInfo', M.GetServiceInfoRequest, M.GetServiceInfoResponse, {});
    if (r.chainId !== n.chainRef || r.chain !== 'mainnet') throw new Error('sui: chain identity mismatch');
    return { epoch: big(r.epoch, 'epoch'), height: big(r.checkpointHeight, 'checkpoint height'), time: safe(r.timestamp?.seconds, 'timestamp'), lowest: r.lowestAvailableCheckpoint ?? null };
  };
  const epochInfo = async (u: string, epoch?: bigint): Promise<EpochMsg> => {
    const r = await rpc<{ epoch?: EpochMsg }>(u, LEDGER + 'GetEpoch', M.GetEpochRequest, M.GetEpochResponse, { ...(epoch === undefined ? {} : { epoch }), readMask: { paths: ['epoch', 'first_checkpoint', 'last_checkpoint', 'start', 'end', 'reference_gas_price'] } });
    if (!r.epoch || typeof r.epoch.epoch !== 'bigint' || (epoch !== undefined && r.epoch.epoch !== epoch)) throw new Error('sui: bad epoch answer');
    return r.epoch;
  };
  const balance = async (u: string, addr: string): Promise<BalanceMsg> => {
    const r = await rpc<{ balance?: BalanceMsg }>(u, STATE + 'GetBalance', M.GetBalanceRequest, M.GetBalanceResponse, { owner: addr, coinType: SUI_TYPE });
    if (r.balance?.coinType !== SUI_TYPE) throw new Error('sui: bad balance answer');
    return r.balance;
  };
  /** every SUI coin object owned by the address, sorted by id; throws when there are more than this adapter reads */
  const coins = async (u: string, addr: string): Promise<Coin[]> => {
    const out: Coin[] = [];
    let pageToken: Uint8Array | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new UserError('too_many_coins', `this address holds more than ${PAGE * MAX_PAGES} separate SUI coin objects; merge them with another wallet first`);
      const r = await rpc<{ objects: ObjectMsg[]; nextPageToken?: Uint8Array }>(u, STATE + 'ListOwnedObjects', M.ListOwnedObjectsRequest, M.ListOwnedObjectsResponse,
        { owner: addr, pageSize: PAGE, objectType: SUI_COIN_TYPE, readMask: { paths: ['object_id', 'version', 'digest', 'owner', 'object_type', 'balance'] }, ...(pageToken ? { pageToken } : {}) });
      for (const o of r.objects) {
        if (o.objectType !== SUI_COIN_TYPE || o.owner?.kind !== OWNER_ADDRESS || o.owner.address !== addr) throw new Error('sui: unexpected object in coin list');
        if (typeof o.objectId !== 'string' || typeof o.digest !== 'string') throw new Error('sui: bad coin object');
        suiAddressBytes(o.objectId);
        out.push({ objectId: o.objectId, version: big(o.version, 'object version'), digest: o.digest, balance: big(o.balance, 'coin balance') });
      }
      if (!r.nextPageToken || r.nextPageToken.length === 0) break;
      pageToken = r.nextPageToken;
    }
    if (new Set(out.map((c) => c.objectId)).size !== out.length) throw new Error('sui: duplicate coin object');
    return out.sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
  };
  /** does any object live at this id? (a destination that is an object id is not a wallet) */
  const objectExists = async (u: string, id: string): Promise<boolean> => {
    try { await rpc(u, LEDGER + 'GetObject', M.GetObjectRequest, M.GetObjectResponse, { objectId: id, readMask: { paths: ['object_id'] } }); return true; }
    catch (e) { if (notFound(e)) return false; throw e; }
  };
  const getTx = async (u: string, digest: string): Promise<ExecutedTx | null> => {
    try {
      const r = await rpc<{ transaction?: ExecutedTx }>(u, LEDGER + 'GetTransaction', M.GetTransactionRequest, M.GetTransactionResponse, { digest, readMask: { paths: ['digest', 'checkpoint', 'effects.status'] } });
      if (r.transaction?.digest !== digest || typeof r.transaction.effects?.status?.success !== 'boolean') throw new Error('sui: bad transaction record');
      return r.transaction;
    } catch (e) { if (notFound(e)) return null; throw e; }
  };
  const gasOf = (g: GasMsg | undefined) => ({ computation: big(g?.computationCost, 'gas').toString(), storage: big(g?.storageCost, 'gas').toString(), rebate: big(g?.storageRebate, 'gas').toString() });
  /** dry run of exact TransactionData bytes with every validity check on (signature excepted) */
  const simulate = async (u: string, tx: Uint8Array): Promise<Sim> => {
    const r = await rpc<{ transaction?: ExecutedTx }>(u, EXEC + 'SimulateTransaction', M.SimulateTransactionRequest, M.SimulateTransactionResponse,
      { transaction: { bcs: { value: tx } }, checks: 0, doGasSelection: false, readMask: { paths: ['transaction.effects.status', 'transaction.effects.gas_used', 'transaction.balance_changes'] } });
    const t = r.transaction, st = t?.effects?.status;
    if (!t || typeof st?.success !== 'boolean') throw new Error('sui: bad simulation answer');
    const changes = t.balanceChanges.map((c) => { if (typeof c.address !== 'string' || typeof c.coinType !== 'string' || !/^-?\d{1,30}$/.test(c.amount ?? '')) throw new Error('sui: bad balance change'); return `${c.address}|${c.coinType}|${BigInt(c.amount!)}`; }).sort();
    return { success: st.success, error: st.success ? '' : (st.error?.description ?? 'execution failed').slice(0, 200), gas: gasOf(t.effects!.gasUsed), changes };
  };
  const simulateBoth = async (tx: Uint8Array, what: string): Promise<Sim> => {
    const rs = await Promise.allSettled(sources.map((u) => simulate(u, tx)));
    const refused = rs.find((r) => r.status === 'rejected' && r.reason instanceof GrpcError) as PromiseRejectedResult | undefined;
    // a node refusing the transaction outright (invalid input, stale object, …) is an answer, not an outage
    if (refused && rs.every((r) => r.status === 'rejected' && r.reason instanceof GrpcError)) throw new UserError('simulation_failed', `the network refuses this transfer: ${(refused.reason as Error).message}`);
    if (rs.some((r) => r.status === 'rejected')) throw new UserError('rpc_degraded', `${n.name} data source unavailable (${what}); transfer refused`, 503);
    return agree(rs.map((r) => (r as PromiseFulfilledResult<Sim>).value), what);
  };
  let identity = false;

  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(sources.map(async (url) => {
        const t = Date.now();
        try {
          const i = await info(url); // verifies the genesis checkpoint digest on every check
          if (Date.now() / 1000 - i.time > STALE_SEC) throw new Error('stale');
          return { url: hostOf(url), ok: true, ms: Date.now() - t, h: Number(i.height) };
        } catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.length >= 2 && endpoints.every((e) => e.ok);
      if (ok) identity = true;
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },

    async balances(addr) {
      // everything the address owns: coin objects plus its "address balance" (funds received without a coin object)
      return { native: big((await any((u) => balance(u, addr))).balance ?? 0n, 'balance') };
    },

    async prepare(d): Promise<Prepared> {
      if (d.asset !== 'native') throw new UserError('unsupported_asset', 'only SUI can be sent on Sui in this version');
      if (d.memo !== undefined) throw new UserError('bad_memo', 'Sui transfers do not carry a memo');
      try { suiAddressBytes(d.from); suiAddressBytes(d.to); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (d.from === d.to) throw new UserError('bad_address', 'destination is this wallet');
      if (d.amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');

      // one snapshot per source; both must answer and agree on everything that ends up in the signed bytes
      const snaps = await all(async (u) => {
        const i = await info(u);
        const [ep, cs, bal, toIsObject] = await Promise.all([epochInfo(u), coins(u, d.from), balance(u, d.from), objectExists(u, d.to)]);
        return {
          height: i.height, time: i.time,
          epoch: i.epoch.toString(), epochSeen: big(ep.epoch, 'epoch').toString(), gasPrice: big(ep.referenceGasPrice, 'reference gas price').toString(),
          coins: cs.map((c) => `${c.objectId}:${c.version}:${c.digest}:${c.balance}`), total: (bal.balance ?? 0n).toString(), toIsObject,
        };
      }, 'account state');

      const now = Math.floor(Date.now() / 1000);
      const heights = snaps.map((s) => s.height).sort((a, b) => (a < b ? -1 : 1));
      if (heights[heights.length - 1]! - heights[0]! > MAX_CHECKPOINT_GAP) throw new UserError('rpc_disagreement', `${n.name} data sources are not at the same checkpoint; transfer refused`, 503);
      for (const s of snaps) if (Math.abs(now - s.time) > MAX_CLOCK_SKEW_SEC) throw new UserError('rpc_degraded', `${n.name} checkpoint time and server clock differ; transfer refused`, 503);
      const epoch = BigInt(agree(snaps.flatMap((s) => [s.epoch, s.epochSeen]), 'epoch'));
      const gasPrice = BigInt(agree(snaps.map((s) => s.gasPrice), 'reference gas price'));
      if (gasPrice <= 0n) throw new UserError('rpc_degraded', `${n.name} network parameters look wrong; transfer refused`, 503);
      const coinList = agree(snaps.map((s) => s.coins), 'coin objects of this wallet').map((s) => { const [objectId, version, digest, bal] = s.split(':') as [string, string, string, string]; return { objectId, version: BigInt(version), digest, balance: BigInt(bal) }; });
      const total = BigInt(agree(snaps.map((s) => s.total), 'balance'));
      if (agree(snaps.map((s) => s.toIsObject), 'destination')) throw new UserError('bad_address', 'the destination is an object or a package on Sui, not a wallet address; funds sent there could be lost');

      // deterministic coin selection: largest first, until amount + probe budget is covered
      const sorted = [...coinList].sort((a, b) => (a.balance === b.balance ? (a.objectId < b.objectId ? -1 : 1) : a.balance > b.balance ? -1 : 1));
      const want = d.amount + PROBE_BUDGET;
      const picked: Coin[] = [];
      let sum = 0n;
      for (const c of sorted) { if (sum >= want || picked.length >= SUI_MAX_GAS_COINS) break; if (c.balance === 0n) continue; picked.push(c); sum += c.balance; }
      const minBudget = MIN_BUDGET_UNITS * gasPrice;
      const sui = (v: bigint) => formatUnits(v > 0n ? v : 0n, n.native.decimals);
      if (sum < d.amount + minBudget) {
        const inCoins = coinList.reduce((a, c) => a + c.balance, 0n);
        if (inCoins >= d.amount + minBudget) throw new UserError('too_many_coins', `the balance is spread over too many small coin objects: at most ${sui(sum)} ${n.native.symbol} can be sent in one transfer`);
        if (total >= d.amount + minBudget) throw new UserError('unsupported_funds', `insufficient ${n.native.symbol} held as coins: ${sui(inCoins)} spendable; ${sui(total - inCoins)} is held as an address balance, which this version cannot send`);
        throw new UserError('insufficient_funds', `insufficient ${n.native.symbol}: ${sui(inCoins)} available for amount plus network fee`);
      }
      const payment = suiFormatPayment(picked.sort((a, b) => (a.objectId < b.objectId ? -1 : 1)));
      const probeBudget = sum - d.amount < PROBE_BUDGET ? sum - d.amount : PROBE_BUDGET;
      const txFor = (budget: bigint): Uint8Array => {
        const intent: Intent = { v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'spw-simulation', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: n.native.symbol, decimals: n.native.decimals,
          amount: d.amount.toString(), from: d.from, to: d.to, maxFee: budget.toString(), createdAt: now, expiresAt: now + TTL_SEC, policyVersion: 0,
          x: { payment, gasPrice: gasPrice.toString(), gasBudget: budget.toString(), expiration: epoch.toString() } };
        try { return buildSuiTx(intent, n).tx; } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      };

      // first simulation: learn the cost; second: the exact bytes that will be signed
      const probe = await simulateBoth(txFor(probeBudget), 'simulation');
      if (!probe.success) throw new UserError(/InsufficientGas|InsufficientCoinBalance/.test(probe.error) ? 'insufficient_funds' : 'simulation_failed',
        /InsufficientGas|InsufficientCoinBalance/.test(probe.error) ? `insufficient ${n.native.symbol} for amount plus network fee` : `the network would reject this transfer: ${probe.error}`);
      const gross = BigInt(probe.gas.computation) + BigInt(probe.gas.storage);
      let budget = 2n * gross; // the budget must cover computation + storage before the storage rebate; doubled for headroom
      if (budget < minBudget) budget = minBudget;
      if (budget > probeBudget) budget = probeBudget;
      const final = budget === probeBudget ? probe : await simulateBoth(txFor(budget), 'simulation');
      if (!final.success) throw new UserError('simulation_failed', `the network would reject this transfer: ${final.error}`);
      const net = BigInt(final.gas.computation) + BigInt(final.gas.storage) - BigInt(final.gas.rebate);
      // the simulated effects must be exactly this payment: recipient + amount, sender - (amount + net gas), nothing else
      const expected = [`${d.to}|${SUI_TYPE}|${d.amount}`, `${d.from}|${SUI_TYPE}|${-(d.amount + net)}`].sort();
      if (JSON.stringify(final.changes) !== JSON.stringify(expected)) throw new UserError('simulation_failed', 'the simulated transfer does not match the request; transfer refused');
      return { section: { x: { payment, gasPrice: gasPrice.toString(), gasBudget: budget.toString(), expiration: epoch.toString() } }, maxFee: budget, feeEstimate: net > 0n ? net : 0n, warnings: [], ttlSec: TTL_SEC };
    },

    async broadcast(raw) {
      const { tx, signature, txid } = suiParseRaw(raw);
      const rs = await Promise.allSettled(sources.map(async (u) => {
        const r = await rpc<{ transaction?: ExecutedTx }>(u, EXEC + 'ExecuteTransaction', M.ExecuteTransactionRequest, M.ExecuteTransactionResponse,
          { transaction: { bcs: { value: tx } }, signatures: [{ bcs: { value: signature } }], readMask: { paths: ['digest'] } }, EXECUTE_TIMEOUT_MS);
        if (r.transaction?.digest !== txid) throw new Error('node answered for another transaction');
      }));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // "already known": a node may refuse a transaction it has already executed; the ledger is the judge
      const known = await Promise.allSettled(sources.map((u) => getTx(u, txid)));
      if (known.some((k) => k.status === 'fulfilled' && k.value !== null)) return;
      throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message));
    },

    async track(p): Promise<Tracked> {
      const xs = p.intent?.x?.expiration;
      if (typeof xs !== 'string' || !/^\d{1,20}$/.test(xs)) throw new Error('intent has no expiration epoch');
      const expiration = BigInt(xs);
      // per source: position FIRST, then the lookup — a miss is then known to cover everything up to that position
      const rs = await Promise.allSettled(sources.map(async (u) => { const i = await info(u); return { u, i, tx: await getTx(u, p.txid) }; }));
      const up = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const allUp = up.length === sources.length && up.length >= 2;
      const found = up.filter((s) => s.tx !== null);
      if (found.length > 0) {
        const good = found[0]!.tx!.effects!.status!.success!;
        const cps = found.flatMap((s) => (typeof s.tx!.checkpoint === 'bigint' ? [s.tx!.checkpoint] : []));
        if (found.some((s) => s.tx!.effects!.status!.success !== good) || cps.some((c) => c !== cps[0])) throw new Error('data sources disagree on the transaction result');
        // executed but not yet in a checkpoint on some source: not final yet
        if (cps.length < found.length) return { state: 'confirming', confirmations: 0 };
        const cp = cps[0]!, blockRef = cp.toString();
        // a source that does not show it must be unable to: it prunes that checkpoint already (some public nodes keep seconds of history)
        for (const s of up) if (s.tx === null && !(s.i.lowest !== null && s.i.lowest > cp)) return { state: 'confirming', confirmations: 1, blockRef };
        const tip = up.map((s) => s.i.height).reduce((a, b) => (a > b ? a : b));
        if (good) return { state: 'finalized', confirmations: Math.max(1, Number(tip - cp) + 1), blockRef };
        // executed but aborted (gas charged, nothing transferred): only final once every source is reachable
        if (!allUp) return { state: 'confirming', confirmations: 1, blockRef };
        return { state: 'failed', confirmations: 0, blockRef, error: `executed but failed (${(found[0]!.tx!.effects!.status!.error?.description ?? 'execution error').slice(0, 120)}); only the network fee was charged, no funds moved` };
      }
      const maxEpoch = up.length ? up.map((s) => s.i.epoch).reduce((a, b) => (a > b ? a : b)) : 0n;
      if (allUp && up.every((s) => s.i.epoch > expiration)) {
        // expired everywhere. "Not executed" additionally needs a source whose history covers the whole life of the transaction:
        // created inside the expiration epoch (so it could only execute there), that epoch closed, and nothing of it pruned.
        const cover = await Promise.allSettled(up.map(async (s) => {
          const e = await epochInfo(s.u, expiration);
          const first = big(e.firstCheckpoint, 'first checkpoint'), last = big(e.lastCheckpoint, 'last checkpoint'), start = safe(e.start?.seconds, 'epoch start');
          return s.i.lowest !== null && s.i.lowest <= first && s.i.height >= last + EXPIRY_MARGIN && start <= Number(p.intent.createdAt);
        }));
        if (cover.some((c) => c.status === 'fulfilled' && c.value)) return { state: 'failed', confirmations: 0, error: 'not executed before its expiration epoch ended; no funds moved' };
      }
      return { state: 'broadcast', confirmations: 0, rebroadcast: up.length > 0 && maxEpoch <= expiration };
    },

    async deposits(addr, cursor) {
      const scan = async (u: string, from: bigint | null): Promise<{ items: Deposit[]; cursor: number; finalizedHeight: number }> => {
        const latest = (await info(u)).height; // read before the listing: nothing checkpointed up to here can be missed
        const frames = await call(u, LEDGER + 'ListTransactions', encode(M.ListTransactionsRequest, {
          filter: { terms: [{ literals: [{ affectedAddress: { address: addr } }] }] }, ...(from === null ? { options: { limit: 50, ordering: 1 } } : { startCheckpoint: from, options: { limit: 200, ordering: 0 } }),
          readMask: { paths: ['digest', 'checkpoint', 'timestamp', 'effects.status', 'balance_changes', 'transaction.sender'] } }));
        const items: Deposit[] = [];
        let covered: bigint | null = null, lastItem: bigint | null = null, partial = false;
        for (const f of frames) {
          const m = decode<ListedTx>(M.ListTransactionsResponse, f), t = m.transaction;
          if (m.end && (m.end.reason === END_ITEM_LIMIT || m.end.reason === END_SCAN_LIMIT)) partial = true;
          if (typeof m.watermark?.checkpoint === 'bigint') covered = m.watermark.checkpoint; // everything up to here has been delivered
          if (!t || typeof t.checkpoint !== 'bigint' || typeof t.digest !== 'string') continue;
          lastItem = t.checkpoint;
          const sender = t.transaction?.sender ?? '';
          if (t.effects?.status?.success !== true || sender === addr) continue;
          let amount = 0n;
          for (const c of t.balanceChanges) if (c.address === addr && c.coinType === SUI_TYPE && /^\d{1,30}$/.test(c.amount ?? '')) amount += BigInt(c.amount!);
          if (amount > 0n) items.push({ txid: t.digest, idx: 0, asset: 'native', amount, from: sender, block: safe(t.checkpoint, 'checkpoint'), time: t.timestamp?.seconds !== undefined ? Number(t.timestamp.seconds) : null });
        }
        // first scan (newest 50) or a listing that reached the tip: everything up to `latest` is covered; two checkpoints of overlap
        // (inserts are idempotent). A listing cut short resumes from the last checkpoint known to be fully delivered.
        let next = latest - 2n;
        if (from !== null && partial) next = (covered !== null ? covered : lastItem !== null ? lastItem - 1n : from - 1n) - 1n;
        if (next > latest - 2n) next = latest - 2n;
        return { items, cursor: Math.max(cursor ?? 0, Number(next)), finalizedHeight: Number(latest) };
      };
      if (cursor === null) return any((u) => scan(u, null));
      const errs: unknown[] = [];
      for (const u of sources) { try { return await scan(u, BigInt(cursor) + 1n); } catch (e) { errs.push(e); } }
      // every source answered that it no longer holds history that far back (long downtime): resume from the oldest checkpoint kept
      if (!errs.every((e) => e instanceof GrpcError && e.grpcCode === GRPC_OUT_OF_RANGE)) throw errs[errs.length - 1];
      return any(async (u) => { const i = await info(u); if (i.lowest === null) throw errs[0]; return scan(u, i.lowest + 1n); });
    },
  };
}
