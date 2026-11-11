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

/** Every endpoint must answer and agree. Use for anything that feeds a signature (nonce, chain identity). */
export async function rpcQuorum<T>(urls: string[], method: string, params: unknown[], same: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b)): Promise<T> {
  const rs = await Promise.allSettled(urls.map((u) => rpcOne<T>(u, method, params)));
  const ok = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value as T] : []));
  if (ok.length < urls.length || ok.length === 0) throw new UserError('rpc_degraded', `network data source unavailable (${method}); transfer refused`, 503);
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
