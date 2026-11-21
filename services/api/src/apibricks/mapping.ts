/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/apibricks/mapping.ts
 * Module           : apibricks
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

// API Bricks (CoinAPI) — which provider asset IS a wallet symbol. Pure: no clock, no network.
//
// A TICKER IS NOT AN IDENTITY. The provider keys its assets by ticker (`asset_id`), and its own metadata shows what that
// costs: on 2026-11-17 `/v1/assets` names `OP` "Operand", `ARB` "ARbit", `GMX` "GoldMaxCoin", `SKY` "Skycoin" and `USDS`
// "StableUSD". A wallet symbol is therefore mapped ONLY when all of this holds, and is otherwise left with one price source:
//
//   1. exact id      the provider has a crypto asset whose `asset_id` equals the wallet symbol character for character
//                    (no case folding, no suffix stripping: `cbBTC`, `USDe`, `USDC.e` do not match anything by themselves);
//   2. evidence      EITHER the provider's own contract address for that asset equals the wallet registry's address of the
//                    symbol on a network both know (Ethereum, Arbitrum One) — `address`;
//                    OR the symbol is in the REVIEWED list below (native coins and assets the provider gives no address
//                    for) — `reviewed`;
//                    and NEVER when the provider's address differs from the registry's on a shared network — `conflict`;
//   3. price check   at generation time the provider's rate and the wallet's existing price of that symbol, read together,
//                    are within PRICE_CHECK_BPS of each other — a ticker reused for another asset fails here.
//
// A symbol the wallet already prices as another one (same CoinGecko id: `USDC.e` → USDC, `LINK.e` → LINK) follows that
// symbol's mapping — `alias` — and nothing else is inferred. The result is a generated, reviewed, static table
// (asset-map.ts, written by scripts/gen-apibricks-assets.mts); nothing is discovered at run time.

export interface ProviderAsset { asset_id: string; name?: string | null; type_is_crypto?: number; chain_addresses?: { chain_id: string; network_id: string; address: string }[] | null }
export interface RegistryToken { symbol: string; deployments: Record<string, { address: string }> }
export type Evidence = 'address' | 'reviewed' | 'alias';
export type Unmapped = 'no_exact_id' | 'not_crypto' | 'no_evidence' | 'conflict' | 'no_reference_price' | 'no_provider_price' | 'price_mismatch';
export interface AssetMapping { symbol: string; assetId: string; evidence: Evidence; /** the address that matched, or the symbol followed */ proof: string; checkBps: number }
export interface MappingResult { mapped: AssetMapping[]; unmapped: { symbol: string; reason: Unmapped; detail: string }[] }

/** provider `chain_id` (with `network_id: MAINNET`) → wallet network id; only the chains the provider publishes addresses for */
export const PROVIDER_CHAINS: Record<string, string> = { ETHEREUM: 'ethereum', ARBITRUM: 'arbitrum' };
export const PRICE_CHECK_BPS = 150;

/**
 * REVIEWED 2026-11-17 — symbols mapped without a contract address: the native coin of a network of the wallet, or an asset
 * the provider publishes no Ethereum / Arbitrum address for. Each still has to pass rules 1 and 3. Deliberately absent:
 * anything whose provider name contradicts the asset (see the header) and every wrapped, staked or bridged representation
 * (their price is not the underlying's by construction, and the provider's coverage of them is thin).
 */
export const REVIEWED_SYMBOLS: readonly string[] = [
  'BTC', 'ETH', 'SOL', 'LTC', 'DOGE', 'BCH', 'XRP', 'XLM', 'ADA', 'DOT', 'ATOM', 'AVAX', 'BNB', 'TRX', 'SUI', 'NEAR', 'TON', 'APT', 'POL', 'HYPE',
];

export const bps = (a: number, b: number): number => (Math.abs(a - b) / ((a + b) / 2)) * 1e4;

export function buildAssetMap(i: {
  /** wallet symbol → the id of its existing price (CoinGecko coin id): two symbols with one id are one priced asset */ identities: Record<string, string>;
  assets: ProviderAsset[]; tokens: RegistryToken[];
  /** USD prices read together: the provider's rate per `asset_id`, the wallet's existing price per symbol */ providerUsd: Record<string, number>; referenceUsd: Record<string, number>;
  reviewed?: readonly string[]; priceCheckBps?: number;
}): MappingResult {
  const reviewed = new Set(i.reviewed ?? REVIEWED_SYMBOLS), limit = i.priceCheckBps ?? PRICE_CHECK_BPS;
  const mapped: AssetMapping[] = [], unmapped: MappingResult['unmapped'] = [];
  const skip = (symbol: string, reason: Unmapped, detail: string): void => { unmapped.push({ symbol, reason, detail }); };
  const direct = new Map<string, AssetMapping>();
  for (const symbol of Object.keys(i.identities)) {
    const same = i.assets.filter((a) => a.asset_id === symbol);
    if (same.length !== 1) { skip(symbol, 'no_exact_id', same.length ? 'several provider assets carry this id' : 'the provider has no asset with exactly this id'); continue; }
    const a = same[0]!;
    if (a.type_is_crypto !== 1) { skip(symbol, 'not_crypto', `the provider lists ${a.asset_id} as a non-crypto asset`); continue; }
    // rule 2: addresses on the networks both sides know
    const deployments = i.tokens.filter((t) => t.symbol === symbol).flatMap((t) => Object.entries(t.deployments));
    let match: string | null = null, conflict: string | null = null;
    for (const c of a.chain_addresses ?? []) {
      const net = c.network_id === 'MAINNET' ? PROVIDER_CHAINS[c.chain_id] : undefined;
      if (!net) continue;
      for (const [n, d] of deployments) {
        if (n !== net) continue;
        if (d.address.toLowerCase() === c.address.toLowerCase()) match ??= `${net}:${d.address.toLowerCase()}`;
        else conflict ??= `${net}: registry ${d.address.toLowerCase()} ≠ provider ${c.address.toLowerCase()}`;
      }
    }
    if (conflict) { skip(symbol, 'conflict', conflict); continue; }
    const evidence: Evidence | null = match ? 'address' : reviewed.has(symbol) ? 'reviewed' : null;
    if (!evidence) { skip(symbol, 'no_evidence', `no shared contract address and not in the reviewed list (provider name: ${a.name ?? 'none'})`); continue; }
    // rule 3
    const ref = i.referenceUsd[symbol] ?? NaN, got = i.providerUsd[a.asset_id] ?? NaN;
    if (!(ref > 0)) { skip(symbol, 'no_reference_price', 'the existing price source had no price at generation time'); continue; }
    if (!(got > 0)) { skip(symbol, 'no_provider_price', 'the provider had no rate at generation time'); continue; }
    const d = bps(ref, got);
    if (d > limit) { skip(symbol, 'price_mismatch', `provider ${got} vs reference ${ref}: ${d.toFixed(0)} bps (allowed ${limit})`); continue; }
    const m: AssetMapping = { symbol, assetId: a.asset_id, evidence, proof: match ?? 'reviewed list', checkBps: Math.round(d * 10) / 10 };
    mapped.push(m); direct.set(symbol, m);
  }
  // aliases: a symbol the wallet already prices as a mapped one
  const byIdentity = new Map<string, AssetMapping>();
  for (const m of mapped) { const id = i.identities[m.symbol]!; if (!byIdentity.has(id)) byIdentity.set(id, m); }
  const still: MappingResult['unmapped'] = [];
  for (const u of unmapped) {
    const lead = byIdentity.get(i.identities[u.symbol]!);
    if (lead && lead.symbol !== u.symbol && u.reason !== 'conflict' && u.reason !== 'price_mismatch') mapped.push({ symbol: u.symbol, assetId: lead.assetId, evidence: 'alias', proof: lead.symbol, checkBps: lead.checkBps });
    else still.push(u);
  }
  return { mapped: mapped.sort((x, y) => x.symbol.localeCompare(y.symbol)), unmapped: still.sort((x, y) => x.symbol.localeCompare(y.symbol)) };
}
