// NFT feature, delivery 1 (read-only): composition root. `registerNft(app)` is the ONE line server.ts calls; everything a test
// replaces (chain RPC, DAS, the fetcher of creator URLs, the market source, the wallet's addresses, the clock) is a parameter.
// Docs: docs/nft/NFT-ARCHITECTURE.md (model, providers, resolver/proxy), NFT-SOURCES.md (what each source is and costs),
// NFT-AUDIT.md (the per-chain matrix), docs/nft/work/nft-1.md.
import type { FastifyInstance } from 'fastify';
import { config, UserError } from '../config.ts';
import { rpcOne } from '../chains/rpc.ts';
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

export interface NftOptions { cfg?: NftConfig; rpc?: RpcFn; http?: HttpFn; fetch?: SafeFetchDeps; now?: () => Date; addresses?: () => Promise<Record<string, string>>; providers?: NftDataProvider[]; market?: MarketSource | null }

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
  nftRoutes(app, nft, resolver);
  // background loops (API workers only): the inventory is refreshed while the wallet runs; everything that grows is pruned
  if (config.workers) {
    loop('nft-sync', async () => { await nft.sync({ wait: true, onlyStale: true }); }, 10 * 60_000);
    loop('nft-prune', async () => { await nft.prune(); }, 6 * 3600_000);
  }
  return nft;
}
