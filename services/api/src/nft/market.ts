/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/market.ts
 * Module           : nft
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// Market READ data (category 4 of the brief) — at most ONE source in delivery 1, and only when the operator turns it on:
// Magic Eden's public Solana API (NFT_MARKET_MAGICEDEN=on). Keyless ("free to use, default limit 120 QPM", docs.magiceden.io,
// read 2026-11-17); its terms ask for attribution and a link back, which the item page provides. What is sent upstream is the
// MINT (and the marketplace's collection symbol) — never the wallet's address. Nothing here is on-chain truth: every value is
// "Market — updated at …", and a failure of this source leaves the item page and the ownership untouched.
//
// Endpoints used (answers recorded live in services/api/test/fixtures/nft/market-magiceden.json):
//   GET /v2/tokens/<mint>            → listStatus, owner (the SELLER for an escrowed listing), collection (symbol)
//   GET /v2/tokens/<mint>/listings   → priceInfo.solPrice.rawAmount (lamports, exact string)
//   GET /v2/collections/<symbol>/stats → floorPrice (lamports)
// No write endpoint exists in this module and none is planned here: market actions are delivery 3.
import { NONE, NftProviderError, known, unknown, type DataSourceStamp, type NftAsset, type NftCurrency, type NftMarketSnapshot } from '@spw/nft';

export const MAGICEDEN_API = 'https://api-mainnet.magiceden.dev/v2';
const SOL: NftCurrency = { network: 'solana', asset: 'native', symbol: 'SOL', decimals: 9 };
export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;
const lamports = (v: unknown): string | null => (typeof v === 'string' && /^[0-9]{1,20}$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null);

/** Links to the item on marketplaces' own sites — always available, opened outside SP Wallet. No request is made to build them. */
export function externalMarketLinks(a: Pick<NftAsset, 'family' | 'chainId' | 'assetId' | 'contractAddress' | 'tokenId' | 'standard'>): { name: string; url: string }[] {
  if (a.family === 'sol') return [{ name: 'Magic Eden', url: `https://magiceden.io/item-details/${a.assetId}` }, { name: 'OpenSea', url: `https://opensea.io/item/solana/${a.assetId}` }];
  // OpenSea's chain names (API reference, enum of `chain`, read 2026-11-17); BNB Smart Chain is not in it
  const os: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', optimism: 'optimism', avalanche: 'avalanche', hyperevm: 'hyperevm' };
  if (a.family === 'evm' && a.contractAddress && a.tokenId && os[a.chainId]) return [{ name: 'OpenSea', url: `https://opensea.io/item/${os[a.chainId]}/${a.contractAddress.toLowerCase()}/${a.tokenId}` }];
  return [];
}

export function magicEdenMarket(deps: { http: HttpFn; now: () => Date }) {
  async function get(path: string): Promise<unknown> {
    let r: Response;
    try { r = await deps.http(`${MAGICEDEN_API}${path}`, { headers: { accept: 'application/json', 'user-agent': 'sp-wallet-nft/1' }, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
    catch { throw new NftProviderError('provider_unavailable', 'magiceden'); }
    if (r.status === 429) throw new NftProviderError('provider_rate_limited', 'magiceden');
    if (r.status === 404 || r.status === 400) throw new NftProviderError('not_found', 'magiceden');
    if (!r.ok) throw new NftProviderError('provider_unavailable', 'magiceden', `http ${r.status}`);
    try { return await r.json(); } catch { throw new NftProviderError('provider_bad_answer', 'magiceden'); }
  }
  return {
    id: 'magiceden',
    supports: (a: NftAsset) => a.family === 'sol' && a.standard !== 'metaplex-bubblegum',
    async snapshot(a: NftAsset): Promise<NftMarketSnapshot> {
      const t = (await get(`/tokens/${a.assetId}`)) as { mintAddress?: string; owner?: string; collection?: string; listStatus?: string };
      if (t?.mintAddress !== a.assetId) throw new NftProviderError('provider_bad_answer', 'magiceden', 'another mint was answered');
      const source: DataSourceStamp = { category: 'market', source: 'magiceden', detail: 'api-mainnet.magiceden.dev', fetchedAt: deps.now().toISOString(), confidence: 'market_reported', freshness: 'fresh', covers: ['market'] };
      const listed = t.listStatus === 'listed' ? true : t.listStatus === 'unlisted' ? false : null;
      const symbol = typeof t.collection === 'string' && /^[a-z0-9_]{1,80}$/.test(t.collection) ? t.collection : null;
      const snap: NftMarketSnapshot = { source, url: `https://magiceden.io/item-details/${a.assetId}`, listed: listed === null ? unknown('the marketplace gave no list status') : known(listed),
        seller: listed && typeof t.owner === 'string' ? known(t.owner) : listed === false ? NONE : unknown(), marketCollection: symbol,
        listingPrice: listed === false ? NONE : unknown(), bestOffer: unknown('not requested from this source'), lastSale: unknown('not requested from this source'), collectionFloor: unknown() };
      if (listed) {
        try { const l = (await get(`/tokens/${a.assetId}/listings`)) as { tokenMint?: string; priceInfo?: { solPrice?: { rawAmount?: unknown; address?: string; decimals?: number } } }[];
          const p = Array.isArray(l) ? l.find((x) => x.tokenMint === a.assetId)?.priceInfo?.solPrice : undefined, amt = lamports(p?.rawAmount);
          // only a price quoted in native SOL with its exact base-unit amount is kept; a float is never converted
          if (amt && p?.decimals === 9 && p.address === 'So11111111111111111111111111111111111111112') snap.listingPrice = known({ amount: amt, currency: SOL });
          else snap.listingPrice = unknown('the listing is not quoted in SOL base units'); } catch { snap.listingPrice = unknown('listing price unavailable'); }
      }
      if (symbol) { try { const s = (await get(`/collections/${symbol}/stats`)) as { floorPrice?: unknown }, f = lamports(s?.floorPrice); snap.collectionFloor = f ? known({ amount: f, currency: SOL }) : unknown(); } catch { snap.collectionFloor = unknown('collection stats unavailable'); } }
      return snap;
    },
  };
}
export type MarketSource = ReturnType<typeof magicEdenMarket>;
