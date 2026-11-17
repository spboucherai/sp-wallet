// NFT feature, delivery 1 (read-only): composition root. `registerNft(app)` is the ONE line server.ts calls; everything a test
// replaces (chain RPC, DAS, the fetcher of creator URLs, the market source, the wallet's addresses, the clock) is a parameter.
// Docs: docs/nft/NFT-ARCHITECTURE.md (model, providers, resolver/proxy), NFT-SOURCES.md (what each source is and costs),
// NFT-AUDIT.md (the per-chain matrix), docs/nft/work/nft-1.md.
import type { FastifyInstance } from 'fastify';
import { config, UserError } from '../config.ts';
import { utxoGuards } from '../chains/btc.ts';
import { rpcAny, rpcOne, rpcQuorum } from '../chains/rpc.ts';
import { sql } from '../db.ts';
import { getSetting } from '../db.ts';
import { signer } from '../signer-client.ts';
import { loop } from '../worker.ts';
import { nftConfig, type NftConfig } from './config.ts';
import { evmProvider } from './evm.ts';
import { magicEdenMarket, type HttpFn, type MarketSource } from './market.ts';
import type { NftDataProvider, RpcFn } from './provider.ts';
import { createResolver } from './resolver.ts';
import { nftRoutes } from './routes.ts';
import type { SafeFetchDeps } from './safe-fetch.ts';
import { createNftService, type NftService } from './service.ts';
import { solanaProvider } from './solana.ts';
import type { AnyFn, QuorumFn } from './transfer.ts';
import { nftTransferRoutes, scanArrivals, type SignerApi } from './transfer-routes.ts';
import { ordSource, utxoGuard, type OrdSource, type UtxoDeps } from './utxo.ts';

export interface NftOptions { cfg?: NftConfig; rpc?: RpcFn; http?: HttpFn; fetch?: SafeFetchDeps; now?: () => Date; addresses?: () => Promise<Record<string, string>>; providers?: NftDataProvider[]; market?: MarketSource | null;
  /** false: nothing is synchronised unless asked (tests drive it); default: a stale inventory refreshes itself when it is read, and on a timer */ autoSync?: boolean;
  /** delivery 2 — what a test replaces: the signer, the two read rules (every endpoint agrees / first that answers), the ord server */
  signer?: SignerApi; quorum?: QuorumFn; any?: AnyFn; ord?: OrdSource | null }

/** "Every endpoint must answer and agree" over an injected transport (tests): the rule of `rpcQuorum`, without its endpoint-health memory. */
export function quorumOver(rpc: RpcFn): QuorumFn {
  return async <T>(urls: string[], method: string, params: unknown[], same: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b)): Promise<T> => {
    const rs = await Promise.allSettled(urls.map((u) => rpc(u, method, params) as Promise<T>));
    const bad = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (bad) { if ((bad.reason as { rpcCode?: number }).rpcCode !== undefined && rs.every((r) => r.status === 'rejected')) throw bad.reason; throw new UserError('rpc_degraded', `network data source unavailable (${method}); transfer refused`, 503); }
    const ok = rs.map((r) => (r as PromiseFulfilledResult<T>).value);
    for (const v of ok) if (!same(ok[0]!, v)) throw new UserError('rpc_disagreement', `network data sources disagree (${method}); transfer refused`, 503);
    return ok[0]!;
  };
}
export function anyOver(rpc: RpcFn): AnyFn {
  return async <T>(urls: string[], method: string, params: unknown[]): Promise<T> => { let last: unknown = new Error('no endpoint'); for (const u of urls) { try { return (await rpc(u, method, params)) as T; } catch (e) { last = e; if ((e as { rpcCode?: number }).rpcCode !== undefined) throw e; } } throw last; };
}

/** The wallet's addresses as the signer derives them; when it cannot be reached, the last ones it gave (settings) — never a client value. */
async function signerAddresses(): Promise<Record<string, string>> {
  try { return (await signer.status()).addresses; }
  catch (e) {
    if ((e as UserError).code !== 'signer_unreachable') throw e;
    const known = await getSetting<{ addresses: Record<string, string> } | null>('signerAddresses', null);
    if (!known) throw e;
    return known.addresses;
  }
}

export function registerNft(app: FastifyInstance, o: NftOptions = {}): NftService | null {
  let cfg: NftConfig;
  try { cfg = o.cfg ?? nftConfig(); } catch (e) { console.error(`[nft] configuration refused: ${(e as Error).message.split(':')[0]} — NFT routes answer nft_misconfigured`); app.all('/api/v1/nfts*', async () => { throw new UserError('nft_misconfigured', 'NFT configuration is invalid on the server', 503); }); return null; }
  if (!cfg.enabled) { app.all('/api/v1/nfts*', async () => { throw new UserError('nft_disabled', 'the NFT inventory is disabled on this server', 503); }); return null; }
  const now = o.now ?? (() => new Date());
  const rpc: RpcFn = o.rpc ?? ((url, method, params) => rpcOne<unknown>(url, method, params as unknown[]));
  const http: HttpFn = o.http ?? ((url, init) => fetch(url, init));
  const providers = o.providers ?? [solanaProvider({ rpc, now, dasUrl: cfg.solanaDasUrl }), evmProvider({ rpc, now, indexers: cfg.evmIndexers, http })];
  const resolver = createResolver({ cfg, fetch: o.fetch, now });
  const market = o.market !== undefined ? o.market : cfg.marketMagicEden ? magicEdenMarket({ http, now }) : null;
  const nft = createNftService({ cfg, providers, resolver, market, addresses: o.addresses ?? signerAddresses, now });
  const autoSync = o.autoSync ?? true;
  // delivery 2 — transfers, the outpoint lock list, the allow-list, arrival detection (transfer-routes.ts)
  const sg: SignerApi = o.signer ?? signer;
  const ord = o.ord !== undefined ? o.ord : cfg.ordinalsApiUrl ? ordSource(cfg.ordinalsApiUrl, http) : null;
  const utxo: UtxoDeps = { ord, signerLocks: async (network) => Object.fromEntries(((await sg.status()).utxoLocks?.[network] ?? []).map((l) => [l.outpoint, { reason: l.reason, at: l.at }])),
    reviewed: async (network) => new Set((await sql<{ outpoint: string }[]>`select outpoint from utxo_reviews where network = ${network} and verdict = 'ordinary'`).map((r) => r.outpoint)) };
  utxoGuards.excluded = utxoGuard(utxo); // every Bitcoin-style coin selection (ordinary send, THORChain swap) now asks it
  const lookup = async (chain: string, ref: { address: string; tokenId?: string }, wallet: string | null) => { const p = providers.find((x) => x.chains().includes(chain)); if (!p) throw new UserError('nft_unsupported_chain', 'no NFT adapter for this network', 422); return p.lookup(chain, ref, wallet); };
  const tdeps = { quorum: o.quorum ?? (o.rpc ? quorumOver(rpc) : (rpcQuorum as QuorumFn)), any: o.any ?? (o.rpc ? anyOver(rpc) : (rpcAny as AnyFn)), lookup, now };
  nftRoutes(app, nft, resolver, { autoSync, signer: sg });
  nftTransferRoutes(app, { nft, transfer: tdeps, signer: sg, utxo, rpc, now });
  if (config.workers && autoSync) loop('nft-arrivals', async () => { await scanArrivals({ nft, rpc, signer: sg }); }, 5 * 60_000);
  // background loops (API workers only): the inventory is refreshed while the wallet runs; everything that grows is pruned
  if (config.workers) {
    if (autoSync) loop('nft-sync', async () => { await nft.sync({ wait: true, onlyStale: true }); }, 10 * 60_000);
    loop('nft-prune', async () => { await nft.prune(); }, 6 * 3600_000);
  }
  return nft;
}
