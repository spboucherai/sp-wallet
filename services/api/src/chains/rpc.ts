import { UserError } from '../config.ts';

const TIMEOUT = 9000;
/** One retry on connection-level failures (never on an HTTP answer). Safe for reads; re-sending signed bytes is idempotent on-chain. */
export async function http(url: string, init: RequestInit = {}, o: { timeoutMs?: number; retry?: boolean } = {}): Promise<Response> {
  const ms = o.timeoutMs ?? TIMEOUT;
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms), redirect: 'error' }); }
  catch (e) { if (o.retry === false) throw e; await new Promise((r) => setTimeout(r, 300)); return fetch(url, { ...init, signal: AbortSignal.timeout(ms), redirect: 'error' }); }
}

let idc = 0;
/** `o` (NEXT): a shorter time-out and no second attempt, for reads that are asked to several endpoints anyway */
export async function rpcOne<T>(url: string, method: string, params: unknown[], o: { timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) }, o);
  if (!r.ok) throw Object.assign(new Error(`rpc http ${r.status}`), { httpStatus: r.status });
  const j = (await r.json()) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw Object.assign(new Error(j.error.message), { rpcCode: j.error.code });
  if (j.result === undefined) throw new Error('rpc: empty result');
  return j.result;
}

/** First endpoint that answers wins (failover). Use for display-only reads. */
export async function rpcAny<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const u of urls) { try { return await rpcOne<T>(u, method, params); } catch (e) { last = e; if ((e as { rpcCode?: number }).rpcCode !== undefined) throw e; } }
  throw last;
}

// ── endpoint health (v11) ───────────────────────────────────────────────────────────────────────────────────────────────
// `rpcQuorum` feeds signatures (nonce, chain identity, contract code): its rule — EVERY endpoint asked must answer and agree —
// is a deliberate safety property and is NOT relaxed. What v11 adds is which endpoints are asked: an endpoint that keeps
// failing at the connection level is EJECTED for a while and re-admitted on probation, as long as at least two healthy
// endpoints remain. So:
//   - two endpoints configured (every network by default): nothing changes — both must answer and agree; one down = refused;
//   - three or more (SPW_RPC_EXTRA, rpc-extra.ts): one degraded endpoint no longer blocks the network, and the answer still
//     comes from at least two independent endpoints that agree;
//   - a disagreement between endpoints that answered always fails closed, whoever is "in the majority".
export interface EndpointHealth { url: string; fails: number; ejectedUntil: number; ejections: number; lastOkAt: number | null; lastFailAt: number | null }
const endpoints = new Map<string, EndpointHealth>();
export const RPC_EJECT_AFTER = 3, RPC_EJECT_MS = 60_000, RPC_EJECT_MAX_MS = 10 * 60_000;
/** A quorum never rests on fewer endpoints than this (or than all of them, when fewer are configured). */
export const RPC_MIN_QUORUM = 2;
const healthOf = (url: string): EndpointHealth => { let h = endpoints.get(url); if (!h) { h = { url, fails: 0, ejectedUntil: 0, ejections: 0, lastOkAt: null, lastFailAt: null }; endpoints.set(url, h); } return h; };
const markOk = (url: string, now: number) => { const h = healthOf(url); h.fails = 0; h.ejections = 0; h.ejectedUntil = 0; h.lastOkAt = now; };
const markFail = (url: string, now: number) => {
  const h = healthOf(url); h.fails += 1; h.lastFailAt = now;
  if (h.fails >= RPC_EJECT_AFTER) { h.ejections += 1; h.ejectedUntil = now + Math.min(RPC_EJECT_MAX_MS, RPC_EJECT_MS * 2 ** (h.ejections - 1)); }
};
/** A JSON-RPC error is an ANSWER (the endpoint is alive); only connection-level and HTTP failures count against an endpoint. */
const isEndpointFailure = (e: unknown) => (e as { rpcCode?: number }).rpcCode === undefined;
/**
 * Split the configured endpoints: `core` must all answer and agree; `probation` are ejected endpoints whose pause is over —
 * they are asked too, re-admitted when they answer, and never make the call fail by being silent. Ejection never leaves
 * fewer than RPC_MIN_QUORUM endpoints in `core`: when it would, every endpoint is asked as before (fail closed).
 */
export function rpcAdmitted(urls: string[], now = Date.now()): { core: string[]; probation: string[]; ejected: string[] } {
  const ejected = urls.filter((u) => healthOf(u).fails >= RPC_EJECT_AFTER);
  const core = urls.filter((u) => !ejected.includes(u));
  if (core.length < Math.min(RPC_MIN_QUORUM, urls.length)) return { core: urls, probation: [], ejected: [] };
  return { core, probation: ejected.filter((u) => healthOf(u).ejectedUntil <= now), ejected: ejected.filter((u) => healthOf(u).ejectedUntil > now) };
}
export const rpcEndpointHealth = (): EndpointHealth[] => [...endpoints.values()].map((h) => ({ ...h }));
export const resetRpcHealth = (): void => { endpoints.clear(); benched.clear(); };

// ── NEXT: compared DISPLAY reads (balancesDetailed) ─────────────────────────────────────────────────────────────────────
// A balance read asks every endpoint, so the slowest one sets the time of the answer. Two bounds: one attempt of 7 s per
// call (FAST), and an endpoint that failed at the connection level (time-out, HTTP error) sits out for a minute — the read
// is then made by the others and says so (`sources` < `sourcesAsked`). This is for display reads only: `rpcQuorum`, which
// feeds signatures, keeps its own stricter rule above and is not touched.
export const FAST = { timeoutMs: 7000, retry: false } as const;
const benched = new Map<string, number>();
export const BENCH_MS = 60_000;
/** the endpoints to ask now (all of them when every one is benched: something must be asked) */
export const notBenched = (urls: string[], now = Date.now()): string[] => { const ok = urls.filter((u) => (benched.get(u) ?? 0) <= now); return ok.length ? ok : urls; };
/** call after a failure: only a connection-level failure benches (a JSON-RPC error is an answer) */
export const benchOnFailure = (url: string, e: unknown, now = Date.now()): void => { if ((e as { rpcCode?: number }).rpcCode === undefined) benched.set(url, now + BENCH_MS); };

/**
 * Every admitted endpoint must answer and agree. Use for anything that feeds a signature (nonce, chain identity).
 * See "endpoint health" above for which endpoints are admitted; the strictness itself is unchanged.
 */
export async function rpcQuorum<T>(urls: string[], method: string, params: unknown[], same: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b), now: () => number = Date.now): Promise<T> {
  const { core, probation } = rpcAdmitted(urls, now());
  const asked = [...core, ...probation];
  const rs = await Promise.allSettled(asked.map((u) => rpcOne<T>(u, method, params)));
  const t = now(), ok: T[] = [];
  let coreOk = 0;
  rs.forEach((r, k) => {
    const u = asked[k]!, isCore = k < core.length;
    if (r.status === 'fulfilled') { markOk(u, t); ok.push(r.value as T); if (isCore) coreOk += 1; }
    else if (isEndpointFailure(r.reason)) markFail(u, t);
  });
  if (coreOk < core.length || ok.length === 0) throw new UserError('rpc_degraded', `network data source unavailable (${method}); transfer refused`, 503);
  // every endpoint that answered — a re-admitted one included — must say the same thing
  for (const v of ok) if (!same(ok[0]!, v)) throw new UserError('rpc_disagreement', `network data sources disagree (${method}); transfer refused`, 503);
  return ok[0]!;
}

export interface Health { network: string; /** every source up and identity verified: transfers possible */ ok: boolean; /** at least one source up: balances readable */ readable: boolean; identityVerified: boolean; height: number | null; endpoints: { url: string; ok: boolean; ms: number | null }[]; checkedAt: string }
export interface Prepared {
  /** chain section merged into the intent (hashed and approved) */
  section: Record<string, unknown>; maxFee: bigint; feeEstimate: bigint; warnings: string[]; ttlSec: number;
  /** unauthenticated helper data for the signer (it re-verifies everything in it against the intent) */
  aux?: Record<string, unknown>;
}
export interface Tracked { state: 'broadcast' | 'confirming' | 'finalized' | 'failed' | 'replaced' | 'reorged'; confirmations: number; blockRef?: string; error?: string; rebroadcast?: boolean }
export interface Deposit { txid: string; idx: number; asset: string; amount: bigint; from: string; block: number; time: number | null;
  /** NEXT — how the row was found when it is not the chain's ordinary listing: `tx` a value transfer to the wallet located by the
   *  balance scan, `internal_call` value that arrived inside a contract call (txid = the wallet's own transaction of that block when
   *  there is exactly one, else the BLOCK hash), `aggregate` a balance increase that could not be located (txid = the block hash) */
  via?: 'tx' | 'internal_call' | 'aggregate'; blockHash?: string }

// ── NEXT: balances with provenance ──────────────────────────────────────────────────────────────────────────────────────
/** One asset as read from the chain. `amount` is a fact only when `agreed`; otherwise it is the answer of the source at the higher height. */
export interface BalanceRead {
  amount: bigint;
  /** block / slot / tip height of the read, when the chain gives one */ height: number | null;
  /** sources whose answer is `amount` */ sources: number; /** sources asked */ asked: number;
  /** false: the sources that answered did not give the same amount */ agreed: boolean;
  /** the block of the read is older than the freshness window (the sources answer, but from an old state) */ stale: boolean;
  /** Bitcoin-style: confirmed coins; what the mempool is spending net of unconfirmed change; net unconfirmed receipts. amount = confirmed - pendingOut */
  confirmed?: bigint; pendingOut?: bigint; pendingIn?: bigint;
}
export interface BalancesDetailed { assets: Record<string, BalanceRead>; /** asset id -> why no balance is given (never a silent 0) */ unavailable: Record<string, string> }
/** Compare the answers of several sources for one asset (rule of NEXT B2): all equal = a fact; otherwise the higher height wins
 *  the display and the row is flagged; at the same height the LOWER amount is displayed. */
export function settle(reads: { amount: bigint; height: number | null }[], asked: number, stale = false): BalanceRead {
  if (!reads.length) throw new Error('settle: no read');
  const top = (r: { height: number | null }) => r.height ?? -1;
  const high = Math.max(...reads.map(top));
  if (reads.every((r) => r.amount === reads[0]!.amount)) return { amount: reads[0]!.amount, height: high < 0 ? null : high, sources: reads.length, asked, agreed: true, stale };
  const best = [...reads].sort((a, b) => top(b) - top(a) || (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0]!;
  return { amount: best.amount, height: best.height, sources: reads.filter((r) => r.amount === best.amount).length, asked, agreed: false, stale };
}
/** State of the native-coin scan of an account-based chain: the balance and the count of sent transactions at a block. */
export interface NativeScanState { block: number; balance: bigint; nonce: number }
export interface NativeScanNote { code: 'window_too_old' | 'state_unavailable' | 'unexplained_decrease' | 'budget_exhausted'; fromBlock: number; toBlock: number; amount: string; unknownOwnTxs?: number }
export interface Adapter {
  health(): Promise<Health>;
  balances(addr: string): Promise<Record<string, bigint>>;
  /** NEXT: the same read asked to every source and compared, with its height. Absent on families that have one read path only. */
  balancesDetailed?(addr: string): Promise<BalancesDetailed>;
  /** NEXT (EVM): incoming native coins, found by comparing the balance between blocks (no trace API). See chains/evm.ts. */
  nativeDeposits?(addr: string, prev: NativeScanState | null, opts?: { own?: string[]; maxPoints?: number; maxWindow?: number; maxWindows?: number; maxLeaves?: number }): Promise<{ items: Deposit[]; state: NativeScanState; notes: NativeScanNote[]; calls: number }>;
  /** asset ids hidden because their on-chain identity check failed */
  disabledAssets?(): string[];
  prepare(d: { asset: string; from: string; to: string; amount: bigint; memo?: string;
    /** UTXO chains, THORChain vault payment: extra output bytes (the memo), a minimum fee rate, and change always returned to the wallet */
    thor?: { extraBytes: number; minRate: number } }): Promise<Prepared>;
  broadcast(raw: string): Promise<void>;
  track(p: { txid: string; intent: any; blockRef: string | null; broadcastAt: number }): Promise<Tracked>;
  deposits(addr: string, cursor: number | null): Promise<{ items: Deposit[]; cursor: number; finalizedHeight: number; /** NEXT: transactions listed by the chain that no source serves any more (reported, never silently skipped) */ gaps?: { txid: string; block: number }[] }>;
  /** Bitcoin-style networks (NFT delivery 2): the confirmed coins of an address, agreed by every indexer; a raw transaction */
  utxos?(addr: string): Promise<{ txid: string; vout: number; value: number; confirmed: boolean }[]>;
  rawTx?(txid: string): Promise<string>;
}
export const hostOf = (u: string) => new URL(u.replace(/^[a-z]+:(?=https?:)/, '')).host;
