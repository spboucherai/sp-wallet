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
import type { HlNetwork } from '../venues/hyperliquid/signing.ts';
import type { HlAsset } from '../venues/hyperliquid/trading.ts';

export const HL_PINNED_AT = '2026-11-11';
export const HL_PINNED_ASSETS: Record<HlNetwork, readonly HlAsset[]> = {
  mainnet: [
    { symbol: 'BTC', asset: 0, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false },
    { symbol: 'ETH', asset: 1, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false },
    { symbol: 'SOL', asset: 5, szDecimals: 2, maxLeverage: 20, isolatedOnly: false, delisted: false },
  ],
  testnet: [
    { symbol: 'BTC', asset: 3, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false },
    { symbol: 'ETH', asset: 4, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false },
    { symbol: 'SOL', asset: 0, szDecimals: 2, maxLeverage: 10, isolatedOnly: false, delisted: false },
  ],
};

export const hlPinnedAssets = (network: HlNetwork): HlAsset[] => HL_PINNED_ASSETS[network].map((a) => ({ ...a }));
export const hlPinnedAsset = (network: HlNetwork, instrument: string): HlAsset | null =>
  HL_PINNED_ASSETS[network].find((a) => `hyperliquid:${a.symbol}` === instrument) ?? null;

/**
 * Compares the venue's live asset table with the pinned one. Returns null when every pinned asset still sits at its index with
 * its lot size and is still listed; otherwise the first difference, in words. A LOWER venue maximum leverage is not a
 * difference that can mislead the signer (the venue refuses what exceeds it), so it is not one here.
 */
export function hlPinnedMismatch(network: HlNetwork, live: readonly HlAsset[]): string | null {
  for (const p of HL_PINNED_ASSETS[network]) {
    const at = live.find((a) => a.asset === p.asset), named = live.find((a) => a.symbol === p.symbol);
    if (!named) return `${p.symbol} is no longer in the venue's ${network} asset table`;
    if (named.asset !== p.asset) return `${p.symbol} moved from index ${p.asset} to ${named.asset} on ${network}`;
    if (!at || at.symbol !== p.symbol) return `index ${p.asset} on ${network} is now ${at?.symbol ?? 'empty'}, not ${p.symbol}`;
    if (named.szDecimals !== p.szDecimals) return `${p.symbol}: lot decimals changed from ${p.szDecimals} to ${named.szDecimals} on ${network}`;
    if (named.delisted) return `${p.symbol} is delisted on ${network}`;
    if (named.isolatedOnly !== p.isolatedOnly) return `${p.symbol}: margin mode rules changed on ${network}`;
  }
  return null;
}
