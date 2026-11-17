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
import { type HttpFn, type MarketSource } from './market.ts';
import { alchemyHints, openSeaHints, type EvmHintSource } from './evm-hints.ts';
import { createBudget, type Budget } from './market/budget.ts';
import { magicEdenProvider } from './market/magiceden.ts';
import { openSeaMarket, OPENSEA_CHAINS } from './market/opensea.ts';
import { marketRoutes } from './market/routes.ts';
import { createMarketService, type MarketService, type PriceRow } from './market/service.ts';
import type { AbsentProvider, NftMarketProvider } from './market/types.ts';
import * as nftStore from './store.ts';
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
  signer?: SignerApi; quorum?: QuorumFn; any?: AnyFn; ord?: OrdSource | null;
  /** delivery 3 — the wallet's price list (fiat rates of market amounts); market providers and EVM hint sources a test replaces */
  prices?: () => Promise<Record<string, PriceRow> | null>; marketProviders?: NftMarketProvider[]; marketAbsent?: AbsentProvider[]; evmHints?: EvmHintSource[] }

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

/** The keyed EVM discovery source of NFT_EVM_PROVIDER, when its key is there. Absent otherwise (and reported by the capabilities). */
export function evmHintSources(cfg: NftConfig, http: HttpFn): EvmHintSource[] {
  if (cfg.evmProvider === 'alchemy' && cfg.alchemyApiKey) return [alchemyHints({ http, apiKey: cfg.alchemyApiKey })];
  if (cfg.evmProvider === 'opensea' && cfg.openSeaApiKey) return [openSeaHints({ http, apiKey: cfg.openSeaApiKey })];
  return [];
}
/** The market READ providers this configuration turns on, the slots it leaves absent (reported, never called), and one budget per provider. */
export function marketProviders(cfg: NftConfig, http: HttpFn, now: () => Date): { providers: NftMarketProvider[]; absent: AbsentProvider[]; budgets: Map<string, Budget> } {
  const providers: NftMarketProvider[] = [], absent: AbsentProvider[] = [], budgets = new Map<string, Budget>();
  const budget = (id: string, limits: { perMinute: number; perDay: number }): Budget => { const b = createBudget(id, limits, { now, persist: (p, day, used) => { void nftStore.setBudget(`market:${p}`, day, used).catch(() => {}); } }); budgets.set(id, b);
    void nftStore.budgetToday(now()).then((rows) => { const r = rows.find((x) => x.source === `market:${id}`); if (r) b.restore(now().toISOString().slice(0, 10), r.requests); }).catch(() => {}); return b; };
  const osChains = Object.keys(OPENSEA_CHAINS);
  if (cfg.marketOpenSea && cfg.openSeaApiKey) providers.push(openSeaMarket({ http, now, apiKey: cfg.openSeaApiKey, budget: budget('opensea', { perMinute: 30, perDay: 5000 }) }));
  else absent.push({ id: 'opensea', name: 'OpenSea', state: cfg.openSeaApiKey ? 'off' : 'needs_key', code: cfg.openSeaApiKey ? 'not_enabled' : 'no_api_key', unlockedBy: cfg.openSeaApiKey ? 'NFT_MARKET_OPENSEA' : 'OPENSEA_API_KEY', chains: osChains,
    unlocks: 'asking price, best offer, last sale, market events, collection floor / volume / owners, the marketplace\'s verification badge, trait counts and rarity rank — Solana and 7 EVM networks' });
  if (cfg.marketMagicEden) providers.push(magicEdenProvider({ http, now, budget: budget('magiceden', { perMinute: 40, perDay: 5000 }) }));
  else absent.push({ id: 'magiceden', name: 'Magic Eden', state: 'off', code: 'not_enabled', unlockedBy: 'NFT_MARKET_MAGICEDEN', chains: ['solana'], unlocks: 'Magic Eden\'s own listings, offers, activity and collection floor — Solana (keyless; read its API terms first)' });
  return { providers, absent, budgets };
}

export function registerNft(app: FastifyInstance, o: NftOptions = {}): NftService | null {
  let cfg: NftConfig;
  try { cfg = o.cfg ?? nftConfig(); } catch (e) { console.error(`[nft] configuration refused: ${(e as Error).message.split(':')[0]} — NFT routes answer nft_misconfigured`); app.all('/api/v1/nfts*', async () => { throw new UserError('nft_misconfigured', 'NFT configuration is invalid on the server', 503); }); return null; }
  if (!cfg.enabled) { app.all('/api/v1/nfts*', async () => { throw new UserError('nft_disabled', 'the NFT inventory is disabled on this server', 503); }); return null; }
  const now = o.now ?? (() => new Date());
  const rpc: RpcFn = o.rpc ?? ((url, method, params) => rpcOne<unknown>(url, method, params as unknown[]));
  const http: HttpFn = o.http ?? ((url, init) => fetch(url, init));
  const evmHints = o.evmHints ?? evmHintSources(cfg, http);
  const providers = o.providers ?? [solanaProvider({ rpc, now, dasUrl: cfg.solanaDasUrl }), evmProvider({ rpc, now, indexers: cfg.evmIndexers, http, hints: evmHints })];
  const resolver = createResolver({ cfg, fetch: o.fetch, now });
  // delivery 3: the market READ layer is its own service (one row per source). The single legacy snapshot on the asset (`asset.market`,
  // delivery 1) is no longer filled by default — only when a test injects a source
  const market = o.market !== undefined ? o.market : null;
  const { providers: mps, absent, budgets } = o.marketProviders ? { providers: o.marketProviders, absent: o.marketAbsent ?? [], budgets: new Map<string, Budget>() } : marketProviders(cfg, http, now);
  const marketSvc = createMarketService({ providers: mps, absent, budgets, now, prices: o.prices, registerMedia: (u) => resolver.registerExternalImage(u) });
  const nft = createNftService({ cfg, providers, resolver, market, addresses: o.addresses ?? signerAddresses, now, marketService: marketSvc, evmHints });
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
  marketRoutes(app, nft, marketSvc);
  (app as unknown as { nftMarket?: { nft: NftService; market: MarketService } }).nftMarket = { nft, market: marketSvc }; // read by the trading API's NFT operations
  if (config.workers && autoSync) loop('nft-arrivals', async () => { await scanArrivals({ nft, rpc, signer: sg }); }, 5 * 60_000);
  // background loops (API workers only): the inventory is refreshed while the wallet runs; everything that grows is pruned
  if (config.workers) {
    if (autoSync) loop('nft-sync', async () => { await nft.sync({ wait: true, onlyStale: true }); }, 10 * 60_000);
    loop('nft-prune', async () => { await nft.prune(); }, 6 * 3600_000);
  }
  return nft;
}
