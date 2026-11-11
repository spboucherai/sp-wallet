// GMX v2 (GMX Synthetics) — READ side of the venue adapter (see docs/v4/venues/gmx.md).
// Plain HTTP on the documented public surfaces: the GMX API (`https://{chain}.gmxapi.io/v1`), the Oracle API
// (`https://{chain}-api.gmxinfra.io`) and the Subsquid GraphQL endpoint for the public trade feed. No SDK, no transaction.
//
// GMX is not an order-book venue: traders open against a liquidity pool at the signed oracle price, adjusted by price impact.
// `book()` therefore throws `unsupported`; what the venue really has is exposed by `liquidity()`.
import { D, type DecStr } from '../../decimal.ts';
import type { AccountState, Book, Candle, Fill, FundingPayment, Instrument, Order, Position, PublicTrade, Ticker } from '../../models.ts';
import type { Capabilities, VenueAdapter } from '../../venue.ts';
import { ds, jsonNumberToDecStr, venueError, venueHttp, type HttpAnswer } from '../http.ts';
import * as W from './wire.ts';
import { z } from 'zod';

const GMX = 'gmx' as const;
export type GmxChain = 'arbitrum' | 'avalanche';
/** Pinned public endpoints — https://docs.gmx.io/docs/api/overview/ , /rest-api/fallback-urls/ , /graphql/ */
export const GMX_ENDPOINTS: Record<GmxChain, { api: string; apiPeer: string; oracle: string; oracleFallbacks: string[]; graphql: string; chainId: number }> = {
  arbitrum: { api: 'https://arbitrum.gmxapi.io/v1', apiPeer: 'https://arbitrum.gmxapi.ai/v1', oracle: 'https://arbitrum-api.gmxinfra.io',
    oracleFallbacks: ['https://arbitrum-api-fallback.gmxinfra.io', 'https://arbitrum-api-fallback.gmxinfra2.io'],
    graphql: 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', chainId: 42161 },
  avalanche: { api: 'https://avalanche.gmxapi.io/v1', apiPeer: 'https://avalanche.gmxapi.ai/v1', oracle: 'https://avalanche-api.gmxinfra.io',
    oracleFallbacks: ['https://avalanche-api-fallback.gmxinfra.io', 'https://avalanche-api-fallback.gmxinfra2.io'],
    graphql: 'https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql', chainId: 43114 },
};
/** Funding accrues continuously (per second); the venue quotes it per hour, which is the interval used for `Ticker.funding`. */
export const GMX_FUNDING_INTERVAL_SEC = 3600;
export const GMX_SETTLEMENT = 'isolated position against a GM liquidity pool; PnL is computed in USD and paid in the pool token of the side (long token for longs, short token for shorts) on top of the returned collateral; settlement happens on chain when a keeper executes the order';
export const GMX_MARK_METHOD = 'no order book and no separate mark price: orders execute at the Chainlink Data Streams signed min/max oracle price (longs open at max, close at min) adjusted by price impact; the displayed mark is (min + max) / 2';

export const GMX_CAPABILITIES: Capabilities = {
  marketData: true, account: true, orders: false, orderTypes: [], tif: [], modify: false, leverage: false,
  marginModes: ['isolated'], subaccounts: false, testnet: false, stream: false,
  notes: [
    'Read-only delivery: no order, approval or transaction is built or sent.',
    'Trading would require two on-chain steps: ExchangeRouter.multicall([sendWnt, sendTokens, createOrder]) signed by the account (or by a registered GMX subaccount, or relayed through GMX Express), then execution by a keeper at a signed oracle price; an order can be cancelled or frozen instead of filled — see docs/v4/venues/gmx.md.',
    'NO ORDER BOOK: book() throws "unsupported". Use liquidity(symbol): available liquidity and open interest per side, price-impact parameters, funding and borrowing rates.',
    'One instrument per GM market: the same index (e.g. BTC/USD) is listed against several pools with different collateral, liquidity and rates; they are distinct instruments.',
    'Instrument.tickSize is the price precision of the contracts (10^-(30 − token decimals)), lotSize the token precision; orders are sized in USD (30 decimals), minNotional is the venue minimum position size. Instrument.maxLeverage is the contract bound published by the API; the effective maximum is lower and falls as open interest grows.',
    'Order.size is in USD on this venue (GMX orders carry sizeDeltaUsd), Position.size and Fill.size are in index tokens. A decrease order for the whole position has gmx.closesWholePosition = true.',
    'Ticker: mark = index = oracle mid; mid is null; funding is the rate longs pay per hour (negative = longs receive); openInterest is long + short in index tokens (the two sides are not matched against each other); volume24h comes from the /pairs listing feed.',
    'Candles carry no volume (GMX publishes none): Candle.volume is "0", not a measurement.',
    'account(): GMX has no account-level margin. equity = sum of position net values, collateral = marginUsed = sum of position collateral, freeCollateral = 0; wallet balances are not venue state.',
    'funding(account) throws "unsupported": funding is settled into collateral at each position change (Fill.gmx.fundingFeeAmount) and pending amounts are on Position.gmx. Swap orders are not derivatives and are left out of order lists.',
    'No documented public websocket; no testnet API host. Avalanche is served by the same code (chain option); MegaETH is not wired.',
  ],
};

export interface GmxLiquidity {
  instrument: string; symbol: string; market: string;
  /** USD */ openInterestLongUsd: DecStr; openInterestShortUsd: DecStr; maxOpenInterestLongUsd: DecStr; maxOpenInterestShortUsd: DecStr;
  /** USD that can still be opened on each side: pool view, then the JIT-aware capacity the venue recommends for sizing */
  availableLiquidityLongUsd: DecStr; availableLiquidityShortUsd: DecStr; capacityLongUsd: DecStr; capacityShortUsd: DecStr; capacityLimitedBy: { long: string; short: string };
  /** per hour, as a fraction; sign as published by the venue: positive = the side RECEIVES, negative = the side PAYS */
  fundingRateLongPerHour: DecStr; fundingRateShortPerHour: DecStr; borrowingRateLongPerHour: DecStr; borrowingRateShortPerHour: DecStr; netRateLongPerHour: DecStr; netRateShortPerHour: DecStr;
  /** price impact = f(change in |long OI − short OI|): factor × imbalance^exponent, capped at the max factors (fractions of size) */
  priceImpact: { factorPositive: DecStr; factorNegative: DecStr; exponentPositive: DecStr; exponentNegative: DecStr; maxFactorPositive: DecStr; maxFactorNegative: DecStr; maxFactorForLiquidations: DecStr };
  positionFeeFactor: { balanceImproved: DecStr; balanceNotImproved: DecStr };
  minCollateralFactor: DecStr; minCollateralFactorForLiquidation: DecStr; minCollateralFactorPerUsdOfOpenInterest: { long: DecStr; short: DecStr };
  oracleMin: DecStr; oracleMax: DecStr; ts: number;
}
export interface GmxPositionDetail {
  key: string; contractKey: string; market: string; collateralToken: string; collateralSymbol: string;
  sizeUsd: DecStr; collateralAmount: DecStr; collateralUsd: DecStr; remainingCollateralUsd: DecStr; netValueUsd: DecStr; netValueAfterAllFeesUsd: DecStr;
  pnlAfterFeesUsd: DecStr; pnlAfterAllFeesUsd: DecStr; hasLowCollateral: boolean;
  pendingBorrowingFeesUsd: DecStr; pendingFundingFeesUsd: DecStr; pendingClaimableFundingFeesUsd: DecStr; closingFeeUsd: DecStr; uiFeeUsd: DecStr;
  pendingImpactUsd: DecStr; closePriceImpactDeltaUsd: DecStr; netPriceImpactDeltaUsd: DecStr; priceImpactDiffUsd: DecStr;
  increasedAt: number; decreasedAt: number;
}
export type GmxPosition = Position & { gmx: GmxPositionDetail };
export interface GmxOrderDetail {
  key: string; orderType: string; isLong: boolean; market: string; sizeUnit: 'usd'; closesWholePosition: boolean;
  collateralToken: string; collateralSymbol: string; collateralDelta: DecStr; swapPath: string[];
  /** native token (wei → 18 decimals) */ executionFee: DecStr | null; isFrozen: boolean; autoCancel: boolean; receiver: string | null; validFrom: number | null; cancelReason: string | null;
}
export type GmxOrder = Order & { gmx: GmxOrderDetail };
export interface GmxFillDetail {
  orderKey: string; orderType: string; txHash: string; isLong: boolean; sizeDeltaUsd: DecStr; feeToken: string;
  positionFeeAmount: DecStr; borrowingFeeAmount: DecStr; fundingFeeAmount: DecStr; liquidationFeeAmount: DecStr; traderDiscountAmount: DecStr;
  priceImpactUsd: DecStr | null; totalImpactUsd: DecStr | null; proportionalPendingImpactUsd: DecStr | null; priceImpactDiffUsd: DecStr | null;
  swapImpactUsd: DecStr | null; swapFeeUsd: DecStr | null; basePnlUsd: DecStr | null; indexPriceMin: DecStr | null; indexPriceMax: DecStr | null;
}
export type GmxFill = Fill & { gmx: GmxFillDetail };

export interface GmxAdapterOptions { chain?: GmxChain; fetch?: typeof fetch; now?: () => number; apiUrl?: string; oracleUrl?: string; graphqlUrl?: string; cacheMs?: number }
export interface GmxAdapter extends VenueAdapter {
  readonly chain: GmxChain;
  positions(account: string): Promise<GmxPosition[]>;
  openOrders(account: string): Promise<GmxOrder[]>;
  orderHistory(account: string, o?: { limit?: number }): Promise<GmxOrder[]>;
  fills(account: string, o?: { start?: number; limit?: number }): Promise<GmxFill[]>;
  /** what GMX has instead of a book: liquidity, open interest, rates and price-impact parameters of one market (or all) */
  liquidity(symbol?: string): Promise<GmxLiquidity[]>;
  /** raw signed-oracle price range per token from the Oracle API (contract precision converted exactly) */
  oraclePrices(): Promise<{ token: string; symbol: string; min: DecStr; max: DecStr; ts: number }[]>;
}

interface Ctx { markets: W.Market[]; byAddress: Map<string, W.Market>; bySymbol: Map<string, W.Market>; tokens: Map<string, { symbol: string; decimals: number }> }
const lc = (a: string) => a.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

export function createGmxAdapter(o: GmxAdapterOptions = {}): GmxAdapter {
  const chain = o.chain ?? 'arbitrum', now = o.now ?? Date.now, ep = GMX_ENDPOINTS[chain];
  const api = o.apiUrl ?? ep.api, oracle = o.oracleUrl ?? ep.oracle, graphql = o.graphqlUrl ?? ep.graphql, cacheMs = o.cacheMs ?? 60_000;
  const http = venueHttp(GMX, o.fetch);
  const bad = (m: string) => venueError(GMX, 'bad_answer', m);
  const on4xx = (a: HttpAnswer) => {
    let msg = a.text.slice(0, 200);
    try { const p = z.object({ message: z.string() }).safeParse(JSON.parse(a.text)); if (p.success) msg = p.data.message; } catch { /* keep the raw text */ }
    return venueError(GMX, 'rejected', `HTTP ${a.status}: ${msg.slice(0, 200)}`);
  };
  const get = <T>(url: string, schema: z.ZodType<T>, exact = false) => http.get(url, schema, { on4xx, exact });

  let cache: { at: number; ctx: Promise<Ctx> } | null = null;
  const context = (): Promise<Ctx> => {
    if (cache && now() - cache.at < cacheMs) return cache.ctx;
    const ctx = (async (): Promise<Ctx> => {
      const [ms, ts] = await Promise.all([get(`${api}/markets`, W.markets), get(`${api}/tokens/info`, W.tokensInfo)]);
      return { markets: ms, byAddress: new Map(ms.map((m) => [lc(m.marketTokenAddress), m])), bySymbol: new Map(ms.map((m) => [m.symbol, m])),
        tokens: new Map(ts.map((t) => [lc(t.address), { symbol: t.symbol, decimals: t.decimals }])) };
    })();
    cache = { at: now(), ctx };
    ctx.catch(() => { if (cache?.ctx === ctx) cache = null; });
    return ctx;
  };
  const token = (c: Ctx, addr: string) => { const t = c.tokens.get(lc(addr)); if (!t) throw bad(`unknown token ${addr}`); return t; };
  const perp = (c: Ctx, symbol: string) => {
    const m = c.bySymbol.get(symbol);
    if (!m || m.isSpotOnly) throw venueError(GMX, 'rejected', `unknown perpetual market "${symbol.slice(0, 60)}"`);
    return m;
  };
  const marketAt = (c: Ctx, addr: string) => { const m = c.byAddress.get(lc(addr)); if (!m) throw bad(`unknown market ${addr}`); return m; };
  const instrumentId = (symbol: string) => `${GMX}:${symbol}`;
  const baseOf = (symbol: string) => { const i = symbol.indexOf('/'); if (i <= 0) throw bad(`market symbol ${symbol}`); return symbol.slice(0, i); };
  const indexDecimals = (c: Ctx, m: W.Market) => token(c, m.indexTokenAddress).decimals;
  const evm = (account: string) => { if (!W.address.safeParse(account).success) throw venueError(GMX, 'rejected', 'account must be an EVM address'); return account; };
  /** token a swap path ends in (each hop swaps the market's long token for its short token or the reverse) */
  const afterSwaps = (c: Ctx, tokenIn: string, path: string[]): string => path.reduce((t, mk) => {
    const m = marketAt(c, mk);
    return lc(t) === lc(m.longTokenAddress) ? m.shortTokenAddress : m.longTokenAddress;
  }, tokenIn);

  const instrumentOf = (c: Ctx, m: W.Market): Instrument => {
    const dec = indexDecimals(c, m), long = token(c, m.longTokenAddress).symbol, short = token(c, m.shortTokenAddress).symbol;
    return {
      venue: GMX, symbol: m.symbol, id: instrumentId(m.symbol), base: baseOf(m.symbol), quote: 'USD', kind: 'perpetual',
      collateral: long === short ? long : `${long} or ${short}`, settlement: GMX_SETTLEMENT,
      tickSize: W.priceStep(dec), lotSize: W.tokenAmount(1n, dec), minOrderSize: null, minNotional: W.usd(m.minPositionSizeUsd),
      maxLeverage: W.bps(m.leverageTiers[0]!.maxLeverage), marginModes: ['isolated'],
      fundingIntervalSec: GMX_FUNDING_INTERVAL_SEC, markPriceMethod: GMX_MARK_METHOD, status: m.isListed ? 'active' : 'halted',
    };
  };

  const ORDER_KIND: Record<number, Order['type']> = { 2: 'market', 3: 'limit', 4: 'market', 5: 'take_profit_market', 6: 'stop_market', 7: 'market', 8: 'stop_market' };
  const orderShape = (c: Ctx, w: { orderType: number; isLong: boolean; marketAddress: string; sizeDeltaUsd: string; triggerPrice: string; acceptablePrice: string;
    initialCollateralTokenAddress: string; initialCollateralDeltaAmount: string; swapPath: string[] }, key: string) => {
    const type = ORDER_KIND[w.orderType];
    if (!type) throw venueError(GMX, 'unsupported', `order ${key}: type ${W.ORDER_TYPE[w.orderType] ?? w.orderType} is not a position order`);
    const m = marketAt(c, w.marketAddress), dec = indexDecimals(c, m), increase = W.isIncrease(w.orderType);
    const whole = BigInt(w.sizeDeltaUsd) === W.MAX_UINT256, acceptable = BigInt(w.acceptablePrice), trigger = BigInt(w.triggerPrice);
    const coll = token(c, w.initialCollateralTokenAddress);
    return {
      m, whole,
      base: {
        instrument: instrumentId(m.symbol), side: (increase === w.isLong ? 'buy' : 'sell') as Order['side'], type,
        size: whole ? '0' : W.usd(w.sizeDeltaUsd),
        // acceptable price: the worst execution price the order tolerates; 0 or a value near max uint256 mean "no bound"
        price: acceptable === 0n || acceptable >= 1n << 200n ? null : W.contractPrice(acceptable, dec),
        triggerPrice: trigger === 0n ? null : W.contractPrice(trigger, dec),
        reduceOnly: !increase, tif: 'gtc' as const, clientId: key, venueOrderId: key,
      },
      detail: { key, orderType: W.ORDER_TYPE[w.orderType]!, isLong: w.isLong, market: m.marketTokenAddress, sizeUnit: 'usd' as const, closesWholePosition: whole,
        collateralToken: w.initialCollateralTokenAddress, collateralSymbol: coll.symbol, collateralDelta: W.tokenAmount(w.initialCollateralDeltaAmount, coll.decimals), swapPath: w.swapPath },
    };
  };

  const readPositions = async (account: string) => Promise.all([context(), get(`${api}/positions?address=${evm(account)}`, W.positions)]);
  const positionOf = (c: Ctx, p: W.WirePosition): GmxPosition => {
    const m = marketAt(c, p.marketAddress), dec = indexDecimals(c, m), coll = token(c, p.collateralTokenAddress);
    return {
      instrument: instrumentId(m.symbol), side: p.isLong ? 'long' : 'short', size: W.tokenAmount(p.sizeInTokens, dec),
      entryPrice: p.entryPrice === undefined ? '0' : W.apiPrice(p.entryPrice), markPrice: W.apiPrice(p.markPrice),
      liquidationPrice: p.liquidationPrice === undefined ? null : W.apiPrice(p.liquidationPrice),
      leverage: p.leverage === undefined ? '0' : W.bps(p.leverage), marginMode: 'isolated', margin: W.usd(p.collateralUsd),
      unrealizedPnl: W.usd(p.pnl),                                // before fees and price impact; see gmx.pnlAfterAllFeesUsd
      realizedPnl: null, fundingPaid: null, source: 'venue',
      gmx: {
        key: p.key, contractKey: p.contractKey, market: m.marketTokenAddress, collateralToken: p.collateralTokenAddress, collateralSymbol: coll.symbol,
        sizeUsd: W.usd(p.sizeInUsd), collateralAmount: W.tokenAmount(p.collateralAmount, coll.decimals), collateralUsd: W.usd(p.collateralUsd),
        remainingCollateralUsd: W.usd(p.remainingCollateralUsd), netValueUsd: W.usd(p.netValue), netValueAfterAllFeesUsd: W.usd(p.netValueAfterAllFees),
        pnlAfterFeesUsd: W.usd(p.pnlAfterFees), pnlAfterAllFeesUsd: W.usd(p.pnlAfterAllFees), hasLowCollateral: p.hasLowCollateral,
        pendingBorrowingFeesUsd: W.usd(p.pendingBorrowingFeesUsd), pendingFundingFeesUsd: W.usd(p.pendingFundingFeesUsd),
        pendingClaimableFundingFeesUsd: W.usd(p.pendingClaimableFundingFeesUsd), closingFeeUsd: W.usd(p.closingFeeUsd), uiFeeUsd: W.usd(p.uiFeeUsd),
        pendingImpactUsd: W.usd(p.pendingImpactUsd), closePriceImpactDeltaUsd: W.usd(p.closePriceImpactDeltaUsd),
        netPriceImpactDeltaUsd: W.usd(p.netPriceImapctDeltaUsd), priceImpactDiffUsd: W.usd(p.priceImpactDiffUsd),
        increasedAt: Number(p.increasedAtTime) * 1000, decreasedAt: Number(p.decreasedAtTime) * 1000,
      },
    };
  };
  const tradeActions = async (account: string, limit: number) =>
    Promise.all([context(), get(`${api}/trades?address=${evm(account)}&limit=${Math.min(Math.max(1, limit), 1000)}`, W.tradesList)]);
  const sum = (xs: string[]) => ds(xs.reduce((a, x) => D.add(a, D.from(x)), D.from('0')));

  return {
    id: GMX, network: 'mainnet', chain, capabilities: GMX_CAPABILITIES,

    async instruments(): Promise<Instrument[]> { const c = await context(); return c.markets.filter((m) => !m.isSpotOnly).map((m) => instrumentOf(c, m)); },

    async tickers(): Promise<Ticker[]> {
      const ts = now();
      const [c, tk, vol] = await Promise.all([
        context(), get(`${api}/markets/tickers`, W.marketTickers),
        // the listing feed is the only place the venue publishes 24 h volume; if it is down the tickers are still valid without it
        get(`${api}/pairs`, W.pairs, true).then((p) => new Map(p.filter((x) => x.product_type === 'Perpetual').map((x) => [lc(x.pool_id), jsonNumberToDecStr(x.target_volume)])), () => null),
      ]);
      const out: Ticker[] = [];
      for (const t of tk) {
        const m = c.byAddress.get(lc(t.marketTokenAddress));
        if (!m || m.isSpotOnly) continue;
        const dec = indexDecimals(c, m), mark = W.apiPrice(t.markPrice);
        out.push({
          instrument: instrumentId(m.symbol), mark, index: mark, mid: null,
          funding: W.factor(-BigInt(t.fundingRateLong)),             // venue sign is "what the side receives"; normalized to "what longs pay", per hour
          openInterest: W.tokenAmount(BigInt(t.longInterestInTokens) + BigInt(t.shortInterestInTokens), dec),
          volume24h: vol?.get(lc(t.marketTokenAddress)) ?? null,
          change24h: W.bps(t.priceChangePercent24hBps), ts,
        });
      }
      return out;
    },

    async book(): Promise<Book> { throw venueError(GMX, 'unsupported', 'GMX has no order book; use liquidity(symbol)'); },

    async liquidity(symbol?: string): Promise<GmxLiquidity[]> {
      const ts = now();
      const [c, tk, cf] = await Promise.all([context(), get(`${api}/markets/tickers`, W.marketTickers), get(`${api}/markets/config`, W.marketConfigs)]);
      if (symbol !== undefined) perp(c, symbol);
      const config = new Map(cf.map((x) => [lc(x.marketTokenAddress), x]));
      const out: GmxLiquidity[] = [];
      for (const t of tk) {
        const m = c.byAddress.get(lc(t.marketTokenAddress)), g = config.get(lc(t.marketTokenAddress));
        if (!m || m.isSpotOnly || (symbol !== undefined && m.symbol !== symbol)) continue;
        if (!g) throw bad(`no configuration for market ${m.symbol}`);
        out.push({
          instrument: instrumentId(m.symbol), symbol: m.symbol, market: m.marketTokenAddress,
          openInterestLongUsd: W.usd(t.longInterestUsd), openInterestShortUsd: W.usd(t.shortInterestUsd),
          maxOpenInterestLongUsd: W.usd(g.maxOpenInterestLong), maxOpenInterestShortUsd: W.usd(g.maxOpenInterestShort),
          availableLiquidityLongUsd: W.usd(t.availableLiquidityLong), availableLiquidityShortUsd: W.usd(t.availableLiquidityShort),
          capacityLongUsd: W.usd(t.capacityLong.availableLiquidity), capacityShortUsd: W.usd(t.capacityShort.availableLiquidity),
          capacityLimitedBy: { long: t.capacityLong.limitingFactor, short: t.capacityShort.limitingFactor },
          fundingRateLongPerHour: W.factor(t.fundingRateLong), fundingRateShortPerHour: W.factor(t.fundingRateShort),
          borrowingRateLongPerHour: W.factor(t.borrowingRateLong), borrowingRateShortPerHour: W.factor(t.borrowingRateShort),
          netRateLongPerHour: W.factor(t.netRateLong), netRateShortPerHour: W.factor(t.netRateShort),
          priceImpact: { factorPositive: W.factor(g.positionImpactFactorPositive), factorNegative: W.factor(g.positionImpactFactorNegative),
            exponentPositive: W.factor(g.positionImpactExponentFactorPositive), exponentNegative: W.factor(g.positionImpactExponentFactorNegative),
            maxFactorPositive: W.factor(g.maxPositionImpactFactorPositive), maxFactorNegative: W.factor(g.maxPositionImpactFactorNegative),
            maxFactorForLiquidations: W.factor(g.maxPositionImpactFactorForLiquidations) },
          positionFeeFactor: { balanceImproved: W.factor(g.positionFeeFactorForBalanceWasImproved), balanceNotImproved: W.factor(g.positionFeeFactorForBalanceWasNotImproved) },
          minCollateralFactor: W.factor(g.minCollateralFactor), minCollateralFactorForLiquidation: W.factor(g.minCollateralFactorForLiquidation),
          minCollateralFactorPerUsdOfOpenInterest: { long: W.factor(g.minCollateralFactorForOpenInterestLong), short: W.factor(g.minCollateralFactorForOpenInterestShort) },
          oracleMin: W.apiPrice(t.minPrice), oracleMax: W.apiPrice(t.maxPrice), ts,
        });
      }
      return out;
    },

    async oraclePrices() {
      const [tk, tokens] = await Promise.all([get(`${oracle}/prices/tickers`, W.oracleTickers), get(`${oracle}/tokens`, W.oracleTokens)]);
      const dec = new Map(tokens.tokens.map((t) => [lc(t.address), t.decimals]));
      return tk.flatMap((t) => {
        const d = dec.get(lc(t.tokenAddress));
        // GM/GLV pseudo-tokens of the ticker list are not in /tokens: no decimals, no conversion
        return d === undefined ? [] : [{ token: t.tokenAddress, symbol: t.tokenSymbol, min: W.contractPrice(t.minPrice, d), max: W.contractPrice(t.maxPrice, d), ts: t.updatedAt }];
      });
    },

    /** Executed position orders of one market from the public Subsquid feed, newest first. */
    async trades(symbol: string, limit = 100): Promise<PublicTrade[]> {
      const c = await context(), m = perp(c, symbol), dec = indexDecimals(c, m), n = Math.min(Math.max(1, Math.trunc(limit)), 1000);
      const query = `{ tradeActions(limit: ${n}, orderBy: timestamp_DESC, where: { eventName_eq: "OrderExecuted", marketAddress_eq: "${m.marketTokenAddress}", orderType_in: [2,3,4,5,6,7,8] }) { id orderType isLong sizeDeltaInTokens executionPrice timestamp } }`;
      const r = await http.get(graphql, W.graphqlTrades, { body: { query }, on4xx });
      // an executed order with no size change is a collateral deposit/withdrawal, not a trade
      return r.data.tradeActions.filter((t) => BigInt(t.sizeDeltaInTokens) > 0n).map((t): PublicTrade => ({
        instrument: instrumentId(m.symbol), price: W.contractPrice(t.executionPrice, dec), size: W.tokenAmount(t.sizeDeltaInTokens, dec),
        side: W.isIncrease(t.orderType) === t.isLong ? 'buy' : 'sell', ts: t.timestamp * 1000, id: t.id,
      }));
    },

    async candles(symbol, interval, q): Promise<Candle[]> {
      const c = await context(), m = perp(c, symbol);
      const qs = `symbol=${encodeURIComponent(baseOf(m.symbol))}&timeframe=${interval}&limit=${Math.min(Math.max(1, q.limit ?? 500), 10_000)}${q.start === undefined ? '' : `&since=${Math.trunc(q.start)}`}`;
      const r = await get(`${api}/prices/ohlcv?${qs}`, W.ohlcv);
      const price = (s: string) => { try { return ds(D.from(s)); } catch { throw bad(`candle price ${s.slice(0, 30)}`); } };
      return r.filter((x) => (q.start === undefined || x.timestamp >= q.start) && (q.end === undefined || x.timestamp <= q.end))
        .map((x): Candle => ({ ts: x.timestamp, open: price(x.open), high: price(x.high), low: price(x.low), close: price(x.close), volume: '0' }))
        .sort((a, b) => a.ts - b.ts);
    },

    /** Hourly snapshots of the funding rate, normalized like Ticker.funding (what longs pay per hour). */
    async fundingHistory(symbol, f) {
      const c = await context(), m = perp(c, symbol), age = now() - f.start, DAY = 86_400_000;
      const period = age <= DAY ? '1d' : age <= 7 * DAY ? '7d' : age <= 30 * DAY ? '30d' : age <= 90 * DAY ? '90d' : age <= 180 * DAY ? '180d' : age <= 365 * DAY ? '1y' : 'total';
      const r = await get(`${api}/rates?period=${period}&address=${m.marketTokenAddress}`, W.rates);
      const mine = r.find((x) => lc(x.marketAddress) === lc(m.marketTokenAddress));
      return (mine?.ratesSnapshots ?? [])
        .map((s) => ({ ts: s.timestamp * 1000, rate: W.perSecondToHourly(-BigInt(s.fundingRateLong)), premium: null }))
        .filter((x) => x.ts >= f.start && (f.end === undefined || x.ts <= f.end)).sort((a, b) => a.ts - b.ts);
    },

    async account(account: string): Promise<AccountState> {
      const [, ps] = await readPositions(account);
      const collateral = sum(ps.map((p) => W.usd(p.collateralUsd)));
      return { venue: GMX, account, equity: sum(ps.map((p) => W.usd(p.netValue))), collateral, freeCollateral: '0', marginUsed: collateral,
        maintenanceMargin: null, withdrawable: null, ts: now(), source: 'venue' };
    },
    async positions(account: string): Promise<GmxPosition[]> { const [c, ps] = await readPositions(account); return ps.map((p) => positionOf(c, p)); },

    async openOrders(account: string): Promise<GmxOrder[]> {
      const [c, os, ps] = await Promise.all([context(), get(`${api}/orders?address=${evm(account)}`, W.orders), get(`${api}/positions?address=${evm(account)}`, W.positions)]);
      return os.filter((w) => w.orderType >= 2 && w.orderType <= 8 && lc(w.marketAddress) !== ZERO).map((w): GmxOrder => {
        const s = orderShape(c, w, w.key), at = Number(w.updatedAtTime) * 1000;
        // a decrease order sized max uint256 closes the whole position: report that position's current USD size
        const target = s.whole ? ps.find((p) => lc(p.marketAddress) === lc(w.marketAddress) && p.isLong === w.isLong && lc(p.collateralTokenAddress) === lc(afterSwaps(c, w.initialCollateralTokenAddress, W.isIncrease(w.orderType) ? w.swapPath : []))) : undefined;
        return {
          // a market order that is still listed is waiting for its keeper; limit and trigger orders rest until their price is reached
          ...s.base, size: target ? W.usd(target.sizeInUsd) : s.base.size, status: s.base.type === 'market' ? 'pending' : 'open', filled: '0', avgFillPrice: null, createdAt: at, updatedAt: at, rejectReason: null,
          gmx: { ...s.detail, executionFee: W.tokenAmount(w.executionFee, 18), isFrozen: w.isFrozen, autoCancel: w.autoCancel, receiver: w.receiver,
            validFrom: w.validFromTime === '0' ? null : Number(w.validFromTime) * 1000, cancelReason: null },
        };
      });
    },

    /** Order life cycles rebuilt from the account's trade actions (created → executed / cancelled / frozen), newest first. */
    async orderHistory(account: string, h?: { limit?: number }): Promise<GmxOrder[]> {
      const limit = Math.max(1, h?.limit ?? 100);
      const [c, r] = await tradeActions(account, limit * 4);
      const byKey = new Map<string, W.TradeAction[]>();
      for (const t of r.trades) { if (t.orderType < 2 || t.orderType > 8 || !t.marketAddress) continue; const l = byKey.get(t.orderKey) ?? []; l.push(t); byKey.set(t.orderKey, l); }
      const out: GmxOrder[] = [];
      for (const [key, evs] of byKey) {
        evs.sort((a, b) => a.timestamp - b.timestamp);
        const last = evs[evs.length - 1]!, first = evs[0]!;
        if (last.isLong === undefined || last.sizeDeltaUsd === undefined) throw bad(`trade action ${last.id}: missing order fields`);
        const s = orderShape(c, { orderType: last.orderType, isLong: last.isLong, marketAddress: last.marketAddress!, sizeDeltaUsd: last.sizeDeltaUsd, triggerPrice: last.triggerPrice ?? '0',
          acceptablePrice: last.acceptablePrice ?? '0', initialCollateralTokenAddress: last.initialCollateralTokenAddress, initialCollateralDeltaAmount: last.initialCollateralDeltaAmount, swapPath: last.swapPath }, key);
        const executed = last.eventName === 'OrderExecuted', dec = indexDecimals(c, s.m);
        const status: Order['status'] = executed ? 'filled' : last.eventName === 'OrderCancelled' ? 'cancelled' : last.eventName === 'OrderFrozen' || s.base.type === 'market' ? 'pending' : 'open';
        out.push({
          ...s.base, status, filled: executed ? s.base.size : '0',
          avgFillPrice: executed && last.executionPrice !== undefined ? W.contractPrice(last.executionPrice, dec) : null,
          createdAt: first.timestamp * 1000, updatedAt: last.timestamp * 1000, rejectReason: last.reason ?? null,
          gmx: { ...s.detail, executionFee: null, isFrozen: last.eventName === 'OrderFrozen', autoCancel: false, receiver: null, validFrom: null, cancelReason: last.reason ?? null },
        });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    },

    async fills(account: string, f?: { start?: number; limit?: number }): Promise<GmxFill[]> {
      const [c, r] = await tradeActions(account, (f?.limit ?? 100) * 3);
      const out: GmxFill[] = [];
      for (const t of r.trades) {
        if (t.eventName !== 'OrderExecuted' || t.orderType < 2 || t.orderType > 8 || !t.marketAddress) continue;
        if (f?.start !== undefined && t.timestamp * 1000 < f.start) continue;
        if (t.isLong === undefined || t.sizeDeltaInTokens === undefined || t.executionPrice === undefined || t.sizeDeltaUsd === undefined) throw bad(`trade action ${t.id}: missing execution fields`);
        if (BigInt(t.sizeDeltaInTokens) === 0n) continue;             // collateral-only change: no size traded
        const m = marketAt(c, t.marketAddress), dec = indexDecimals(c, m), increase = W.isIncrease(t.orderType);
        // fee amounts are in the position's collateral token: for an increase that is what the swap path ends in
        const feeToken = increase ? afterSwaps(c, t.initialCollateralTokenAddress, t.swapPath) : t.initialCollateralTokenAddress, ft = token(c, feeToken);
        const amt = (x?: string) => W.tokenAmount(x ?? '0', ft.decimals), u = (x?: string) => (x === undefined ? null : W.usd(x));
        out.push({
          instrument: instrumentId(m.symbol), orderId: t.orderKey, clientId: null, side: increase === t.isLong ? 'buy' : 'sell',
          price: W.contractPrice(t.executionPrice, dec), size: W.tokenAmount(t.sizeDeltaInTokens, dec),
          fee: amt(t.positionFeeAmount),                              // position (open/close) fee only; borrowing, funding, liquidation fees are in `gmx`
          feeAsset: ft.symbol, closedPnl: increase ? null : u(t.pnlUsd), ts: t.timestamp * 1000, id: t.id, liquidation: t.orderType === 7,
          gmx: { orderKey: t.orderKey, orderType: W.ORDER_TYPE[t.orderType]!, txHash: t.transactionHash, isLong: t.isLong, sizeDeltaUsd: W.usd(t.sizeDeltaUsd), feeToken,
            positionFeeAmount: amt(t.positionFeeAmount), borrowingFeeAmount: amt(t.borrowingFeeAmount), fundingFeeAmount: amt(t.fundingFeeAmount),
            liquidationFeeAmount: amt(t.liquidationFeeAmount), traderDiscountAmount: amt(t.traderDiscountAmount),
            priceImpactUsd: u(t.priceImpactUsd), totalImpactUsd: u(t.totalImpactUsd), proportionalPendingImpactUsd: u(t.proportionalPendingImpactUsd),
            priceImpactDiffUsd: u(t.priceImpactDiffUsd), swapImpactUsd: u(t.swapImpactUsd), swapFeeUsd: u(t.swapFeeUsd), basePnlUsd: u(t.basePnlUsd),
            indexPriceMin: t.indexTokenPriceMin === undefined ? null : W.contractPrice(t.indexTokenPriceMin, dec),
            indexPriceMax: t.indexTokenPriceMax === undefined ? null : W.contractPrice(t.indexTokenPriceMax, dec) },
        });
      }
      return out.slice(0, f?.limit ?? 100);
    },

    async funding(): Promise<FundingPayment[]> {
      throw venueError(GMX, 'unsupported', 'GMX settles funding into collateral at each position change: see fills()[].gmx.fundingFeeAmount and positions()[].gmx.pendingFundingFeesUsd');
    },
  };
}
