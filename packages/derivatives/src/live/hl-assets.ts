// Hyperliquid asset table PINNED for live trading, per network. `describe()` turns the integer of an action (`a`, `asset`) into an
// instrument through this table, so it is a trust input: the isolated signer uses THIS table, shipped in its bundle, and never
// one handed over by the API.
//
// Trade-off. A pinned table cannot be falsified by a compromised API ("index 7 is BTC"), and the signer needs no call to the
// venue. But it is only true while the venue keeps these indices and lot sizes. Hyperliquid appends new assets at the end of
// `meta.universe` and has not renumbered existing ones, but nothing in its documentation promises it. Therefore:
//   - the API compares the venue's live `meta` with this table before every proposal and refuses to trade on any difference
//     (`hlPinnedMismatch`); the table is then updated here, reviewed, and both bundles redeployed;
//   - the signer independently requires each price of an order to be near its own exchange price for the NAMED asset, so an
//     order priced for another asset does not pass as "BTC".
// Only the instruments listed here can be allowed in a venue authorization. Values read from `meta` on 2026-11-11 (fixtures
// packages/derivatives/test/fixtures/hyperliquid/{mainnet,testnet}-meta.json; test/live.test.ts checks them against the fixtures).
// Since 2026-11-17 the mainnet table is the venue's whole own dex (generated file); the testnet table keeps three assets.
import type { HlNetwork } from '../venues/hyperliquid/signing.ts';
import type { HlAsset } from '../venues/hyperliquid/trading.ts';

import { HL_MAINNET_ASSETS } from './hl-assets-mainnet.gen.ts';

export const HL_PINNED_AT = '2026-11-17';
export const HL_PINNED_ASSETS: Record<HlNetwork, readonly HlAsset[]> = {
  // 2026-11-17 (owner: every Hyperliquid asset): all listed perpetuals of the venue's own dex, not three (hl-assets-mainnet.gen.ts)
  mainnet: HL_MAINNET_ASSETS,
  testnet: [
    { symbol: 'BTC', asset: 3, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false },
    { symbol: 'ETH', asset: 4, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false },
    { symbol: 'SOL', asset: 0, szDecimals: 2, maxLeverage: 10, isolatedOnly: false, delisted: false },
  ],
};

export const hlPinnedAssets = (network: HlNetwork): HlAsset[] => HL_PINNED_ASSETS[network].map((a) => ({ ...a }));
const BY_INSTRUMENT = { mainnet: new Map(HL_PINNED_ASSETS.mainnet.map((a) => [`hyperliquid:${a.symbol}`, a])), testnet: new Map(HL_PINNED_ASSETS.testnet.map((a) => [`hyperliquid:${a.symbol}`, a])) };
export const hlPinnedAsset = (network: HlNetwork, instrument: string): HlAsset | null => BY_INSTRUMENT[network].get(instrument) ?? null;

/**
 * Compares the venue's live asset table with the pinned one. Returns null when it cannot mislead; otherwise the first difference,
 * in words. Two kinds of difference:
 *  - IDENTITY (an asset is gone, moved to another index, or its index now names another asset): checked for EVERY pinned asset,
 *    because a renumbering makes the signer's reading of any action wrong;
 *  - ATTRIBUTES of one asset (lot decimals, delisted, margin-mode rule): checked only for the instruments in `only` — with the
 *    whole dex pinned, one delisting must not suspend trading on every other asset. Without `only`, every pinned asset is checked
 *    (the strict reading). A LOWER venue maximum leverage is not a difference that can mislead the signer (the venue refuses what
 *    exceeds it), so it is not one here.
 */
export function hlPinnedMismatch(network: HlNetwork, live: readonly HlAsset[], only?: readonly string[]): string | null {
  const byIndex = new Map(live.map((a) => [a.asset, a])), byName = new Map(live.map((a) => [a.symbol, a]));
  const scope = only ? new Set(only) : null;
  for (const p of HL_PINNED_ASSETS[network]) {
    const at = byIndex.get(p.asset), named = byName.get(p.symbol);
    if (!named) return `${p.symbol} is no longer in the venue's ${network} asset table`;
    if (named.asset !== p.asset) return `${p.symbol} moved from index ${p.asset} to ${named.asset} on ${network}`;
    if (!at || at.symbol !== p.symbol) return `index ${p.asset} on ${network} is now ${at?.symbol ?? 'empty'}, not ${p.symbol}`;
    if (scope && !scope.has(`hyperliquid:${p.symbol}`)) continue;
    if (named.szDecimals !== p.szDecimals) return `${p.symbol}: lot decimals changed from ${p.szDecimals} to ${named.szDecimals} on ${network}`;
    if (named.delisted) return `${p.symbol} is delisted on ${network}`;
    if (named.isolatedOnly !== p.isolatedOnly) return `${p.symbol}: margin mode rules changed on ${network}`;
  }
  return null;
}
