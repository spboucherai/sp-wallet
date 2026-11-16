import { UserError } from '../config.ts';

const TIMEOUT = 9000;
/** One retry on connection-level failures (never on an HTTP answer). Safe for reads; re-sending signed bytes is idempotent on-chain. */
export async function http(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), redirect: 'error' }); }
  catch { await new Promise((r) => setTimeout(r, 300)); return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), redirect: 'error' }); }
}

let idc = 0;
export async function rpcOne<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++idc, method, params }) });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
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
export const resetRpcHealth = (): void => endpoints.clear();

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
export interface Deposit { txid: string; idx: number; asset: string; amount: bigint; from: string; block: number; time: number | null }
export interface Adapter {
  health(): Promise<Health>;
  balances(addr: string): Promise<Record<string, bigint>>;
  /** asset ids hidden because their on-chain identity check failed */
  disabledAssets?(): string[];
  prepare(d: { asset: string; from: string; to: string; amount: bigint; memo?: string;
    /** UTXO chains, THORChain vault payment: extra output bytes (the memo), a minimum fee rate, and change always returned to the wallet */
    thor?: { extraBytes: number; minRate: number } }): Promise<Prepared>;
  broadcast(raw: string): Promise<void>;
  track(p: { txid: string; intent: any; blockRef: string | null; broadcastAt: number }): Promise<Tracked>;
  deposits(addr: string, cursor: number | null): Promise<{ items: Deposit[]; cursor: number; finalizedHeight: number }>;
}
export const hostOf = (u: string) => new URL(u.replace(/^[a-z]+:(?=https?:)/, '')).host;
