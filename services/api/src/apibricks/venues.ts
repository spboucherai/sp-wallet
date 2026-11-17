// API Bricks (CoinAPI) — which exchange-specific series may CONFIRM a bar of the market module. Pure.
//
// INDEPENDENCE RULE. The market module already reads Coinbase, Bitstamp and Kraken directly, and trusts a bar only when
// another source confirms it. The provider is an aggregator: its OHLCV of `COINBASE_SPOT_BTC_USD` is Coinbase's own trades
// relayed — counting it as a second source would let Coinbase confirm itself. The provider is therefore used ONLY through
// exchange-specific symbols of exchanges the wallet does not read (Gemini first, Bitfinex second), one per market symbol,
// and a symbol id naming one of the wallet's own exchanges is refused here, whatever the table says. The provider's
// aggregated series (exchange rates, indexes) are never bars of the market module: they blend the exchanges it reads.
//
// Selection (scripts/gen-apibricks-assets.mts, from the provider's `/v1/symbols` metadata, reviewed in the diff):
// `symbol_id` is exactly `<EXCHANGE>_SPOT_<asset_id>_USD`, the base is the asset the wallet symbol maps to with certainty
// (asset-map.ts, never an alias), the pair traded in the last two days with at least MIN_DAY_VOLUME_USD, and its last price
// agrees with the wallet's existing price within the mapping's price check.

/** exchanges of the provider whose data the wallet already reads by itself: never a confirming source */
export const OWN_EXCHANGES: readonly string[] = ['COINBASE', 'BITSTAMP', 'KRAKEN'];
/** independent exchanges, in order of preference */
export const INDEPENDENT_EXCHANGES: readonly string[] = ['GEMINI', 'BITFINEX'];
export const MIN_DAY_VOLUME_USD = 50_000;

export interface ProviderSymbol {
  symbol_id: string; exchange_id: string; symbol_type: string; asset_id_base: string; asset_id_quote: string;
  data_trade_end?: string | null; volume_1day_usd?: number | null; price?: number | null;
}

/** the exchange a provider symbol id belongs to (`GEMINI_SPOT_BTC_USD` → GEMINI); null when it is not an exchange spot symbol */
export function exchangeOf(symbolId: string): string | null {
  const m = /^([A-Z0-9]+)_SPOT_[A-Z0-9]+_[A-Z0-9]+$/.exec(symbolId);
  return m ? m[1]! : null;
}
/**
 * May this provider series confirm a bar? Only an exchange spot symbol against USD of an exchange that is none of the
 * wallet's own — including their sub-venues, which the provider names with the same prefix (`KRAKENFTS`, `COINBASEINTX`…).
 */
export function isIndependent(symbolId: string, own: readonly string[] = OWN_EXCHANGES): boolean {
  const ex = exchangeOf(symbolId);
  return ex !== null && symbolId.endsWith('_USD') && !own.some((o) => ex.startsWith(o));
}

export function pickMarketPairs(i: {
  /** wallet market symbol → provider asset id, certain mappings only */ assets: Record<string, string>;
  symbols: ProviderSymbol[]; referenceUsd: Record<string, number>; now: number; priceCheckBps: number;
  exchanges?: readonly string[]; minDayVolumeUsd?: number;
}): { pairs: Record<string, string>; skipped: { symbol: string; reason: string }[] } {
  const pairs: Record<string, string> = {}, skipped: { symbol: string; reason: string }[] = [];
  const minVol = i.minDayVolumeUsd ?? MIN_DAY_VOLUME_USD;
  for (const [symbol, assetId] of Object.entries(i.assets).sort(([a], [b]) => a.localeCompare(b))) {
    const why: string[] = [];
    for (const ex of i.exchanges ?? INDEPENDENT_EXCHANGES) {
      const id = `${ex}_SPOT_${assetId}_USD`, s = i.symbols.find((x) => x.symbol_id === id);
      if (!s) { why.push(`${ex}: not listed`); continue; }
      if (!isIndependent(id) || s.exchange_id !== ex || s.symbol_type !== 'SPOT' || s.asset_id_base !== assetId || s.asset_id_quote !== 'USD') { why.push(`${ex}: not a plain USD spot pair of the asset`); continue; }
      const end = s.data_trade_end ? Date.parse(s.data_trade_end.replace(/\.\d+Z$/, 'Z')) : NaN;
      if (!Number.isFinite(end) || i.now - end > 2 * 86_400_000) { why.push(`${ex}: no recent trade`); continue; }
      if (!((s.volume_1day_usd ?? 0) >= minVol)) { why.push(`${ex}: daily volume ${Math.round(s.volume_1day_usd ?? 0)} USD below ${minVol}`); continue; }
      const ref = i.referenceUsd[symbol] ?? NaN, px = s.price ?? NaN;
      if (!(ref > 0) || !(px > 0) || (Math.abs(px - ref) / ((px + ref) / 2)) * 1e4 > i.priceCheckBps) { why.push(`${ex}: last price ${px} does not agree with the reference ${ref}`); continue; }
      pairs[symbol] = id;
      break;
    }
    if (!pairs[symbol]) skipped.push({ symbol, reason: why.join('; ') });
  }
  return { pairs, skipped };
}
