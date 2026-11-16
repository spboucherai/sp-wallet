/**
 * Router routes of the in-browser mock (DEVELOPMENT BUILDS ONLY, see mock.ts): `POST /derivatives/route` and
 * `GET /derivatives/route/assets`. The estimates are the repository's REAL router (`packages/derivatives/src/router.ts`) run on
 * the mock's simulated books and on GMX market state rebuilt from the recorded fixtures with the adapter's own mapping; the
 * risk view is the mock's real `checkOrder` preview. What is simulated here is the data, not the arithmetic. Chain costs are
 * fixed sample values (no RPC in the browser). Nothing here is evidence that the real backend behaves the same way.
 */
import gmxConfigRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-markets-config.json?raw';
import gmxTickersRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-markets-tickers.json?raw';
import gmxValuesRaw from '../../../../packages/derivatives/test/fixtures/gmx-router/v1-markets-values.json?raw';
import { D } from '../../../../packages/derivatives/src/decimal.ts';
import { ROUTER_FACTS, orderBodyFor, routeOrder, type ChainCosts, type VenueSnapshot } from '../../../../packages/derivatives/src/router.ts';
import type { GmxLiquidity } from '../../../../packages/derivatives/src/venues/gmx/adapter.ts';
import type { Book, Instrument, RiskResult, Ticker, VenueId } from './types';

const E30 = D.from(10n ** 30n);
const f30 = (raw: string | bigint): string => D.str(D.div(D.from(BigInt(raw)), E30, 30, 'down'));
const tok = (raw: string, dec: number): string => D.str(D.div(D.from(BigInt(raw)), D.from(10n ** BigInt(dec)), dec, 'down'));
const body = (raw: string): any => JSON.parse(JSON.parse(raw).text);
const DYDX_NOTE = 'market data only on this venue';
const WALLET: Record<VenueId, VenueSnapshot['wallet']> = {
  hyperliquid: { trading: 'paper', note: 'this wallet trades Hyperliquid in simulation (paper account); live trading exists and stays off until the owner authorizes a venue account with his passkey' },
  gmx: { trading: 'none', note: 'this wallet only READS GMX: no GMX order can be built or sent from it today' },
  dydx: { trading: 'none', note: DYDX_NOTE },
  edgex: { trading: 'none', note: DYDX_NOTE },   // v11: market data only (the mock lists no edgeX instrument)
};

export interface MockMarket { inst: Instrument; ticker: Ticker; book: Book | null }
export interface MockAccount { id: string; venue: VenueId; label: string; mode: string; equity: string; freeCollateral: string; preview: (body: Record<string, unknown>) => { status: number; json: any } }
export interface RouterMockDeps {
  instruments: () => Instrument[];
  /** the simulated markets of one base asset, advanced to now */ markets: (base: string) => MockMarket[];
  restriction: (venue: VenueId) => string | null;
  account: (id: string) => MockAccount | null;
  /** decimals of a GMX index token */ gmxDecimals: (base: string) => number;
}

/** the adapter's `liquidity()` mapping (packages/derivatives/src/venues/gmx/adapter.ts) on the recorded tickers and configuration */
function gmxState(decimals: (base: string) => number): Map<string, Omit<GmxLiquidity, 'ts' | 'oracleMin' | 'oracleMax'>> {
  const out = new Map<string, Omit<GmxLiquidity, 'ts' | 'oracleMin' | 'oracleMax'>>();
  const cfg = new Map((body(gmxConfigRaw) as any[]).map((g) => [String(g.marketTokenAddress).toLowerCase(), g]));
  // the virtual inventory comes from a later recording that holds two markets only: the others say "unknown", as the real service does when /markets/values cannot be read
  const vals = new Map((body(gmxValuesRaw) as any[]).map((v) => [String(v.marketTokenAddress).toLowerCase(), v]));
  for (const t of body(gmxTickersRaw) as any[]) {
    const g = cfg.get(String(t.marketTokenAddress).toLowerCase()), base = String(t.symbol).split('/')[0]!;
    if (!g) continue;
    const dec = decimals(base), v = vals.get(String(t.marketTokenAddress).toLowerCase());
    out.set(`gmx:${t.symbol}`, {
      instrument: `gmx:${t.symbol}`, symbol: t.symbol, market: t.marketTokenAddress,
      openInterestLongUsd: f30(t.longInterestUsd), openInterestShortUsd: f30(t.shortInterestUsd), maxOpenInterestLongUsd: f30(g.maxOpenInterestLong), maxOpenInterestShortUsd: f30(g.maxOpenInterestShort),
      openInterestLongTokens: tok(t.longInterestInTokens, dec), openInterestShortTokens: tok(t.shortInterestInTokens, dec), useOpenInterestInTokensForBalance: g.useOpenInterestInTokensForBalance ?? null,
      virtualInventory: { applies: typeof g.virtualIndexTokenId === 'string' ? BigInt(g.virtualIndexTokenId) !== 0n : null, tokens: v ? tok(v.virtualInventoryForPositionsInTokens, dec) : null, usd: v ? f30(v.virtualInventoryForPositions) : null },
      availableLiquidityLongUsd: f30(t.availableLiquidityLong), availableLiquidityShortUsd: f30(t.availableLiquidityShort), capacityLongUsd: f30(t.capacityLong.availableLiquidity), capacityShortUsd: f30(t.capacityShort.availableLiquidity),
      capacityLimitedBy: { long: t.capacityLong.limitingFactor, short: t.capacityShort.limitingFactor },
      fundingRateLongPerHour: f30(t.fundingRateLong), fundingRateShortPerHour: f30(t.fundingRateShort), borrowingRateLongPerHour: f30(t.borrowingRateLong), borrowingRateShortPerHour: f30(t.borrowingRateShort),
      netRateLongPerHour: f30(t.netRateLong), netRateShortPerHour: f30(t.netRateShort),
      priceImpact: { factorPositive: f30(g.positionImpactFactorPositive), factorNegative: f30(g.positionImpactFactorNegative), exponentPositive: f30(g.positionImpactExponentFactorPositive), exponentNegative: f30(g.positionImpactExponentFactorNegative),
        maxFactorPositive: f30(g.maxPositionImpactFactorPositive), maxFactorNegative: f30(g.maxPositionImpactFactorNegative), maxFactorForLiquidations: f30(g.maxPositionImpactFactorForLiquidations) },
      positionFeeFactor: { balanceImproved: f30(g.positionFeeFactorForBalanceWasImproved), balanceNotImproved: f30(g.positionFeeFactorForBalanceWasNotImproved) },
      minCollateralFactor: f30(g.minCollateralFactor), minCollateralFactorForLiquidation: f30(g.minCollateralFactorForLiquidation),
      minCollateralFactorPerUsdOfOpenInterest: { long: f30(g.minCollateralFactorForOpenInterestLong), short: f30(g.minCollateralFactorForOpenInterestShort) },
    });
  }
  return out;
}

export function createRouterMock(deps: RouterMockDeps) {
  let state: ReturnType<typeof gmxState> | null = null;
  const ORDER: VenueId[] = ['hyperliquid', 'gmx', 'dydx', 'edgex'];
  const json = (status: number, j: unknown) => ({ status, json: j });

  function assets() {
    const by = new Map<string, Map<VenueId, string[]>>();
    for (const i of deps.instruments()) { if (i.status === 'halted') continue; const b = i.base.toUpperCase(), v = by.get(b) ?? new Map<VenueId, string[]>(); v.set(i.venue, [...(v.get(i.venue) ?? []), i.id]); by.set(b, v); }
    const list = [...by.entries()].map(([base, m]) => {
      const venues = ORDER.filter((v) => m.has(v)).map((v) => ({ venue: v, name: ROUTER_FACTS[v].name, instruments: m.get(v)!, restriction: deps.restriction(v) }));
      return { base, venues, candidateVenues: venues.filter((v) => v.restriction === null).length };
    }).sort((a, b) => b.candidateVenues - a.candidateVenues || b.venues.length - a.venues.length || a.base.localeCompare(b.base));
    return json(200, { assets: list, errors: [], ts: Date.now() });
  }

  function route(b: any) {
    const now = Date.now(), { accountIds = [], ...intent } = (b && typeof b === 'object' ? b : {}) as { accountIds?: unknown } & Record<string, unknown>;
    if (!Array.isArray(accountIds) || accountIds.length > 6 || accountIds.some((x) => typeof x !== 'string')) return json(400, { error: 'bad_request', message: 'invalid request' });
    const accounts: MockAccount[] = [];
    for (const id of [...new Set(accountIds as string[])]) { const a = deps.account(id); if (!a) return json(404, { error: 'unknown_account', message: `unknown derivatives account ${id}` }); accounts.push(a); }
    state ??= gmxState(deps.gmxDecimals);
    const want = typeof intent.base === 'string' ? intent.base.toUpperCase() : '';
    const all = deps.markets(want), eth = deps.markets('ETH').find((m) => m.inst.id === 'hyperliquid:ETH');
    // sample chain values (2026-11-11): 0.02 gwei, and the GMX minimum execution fee at that gas price
    const chain: ChainCosts = { gasPriceEth: '0.00000000002', ethUsd: eth?.ticker.mark ?? null, ethUsdSource: 'Hyperliquid ETH mark price', gmxExecutionFeeEth: '0.0000824',
      gmxExecutionFeeNote: 'MOCK: sample of the contracts\' minimum (4 122 171 gas × 0.02 gwei); the real service reads the gas price and the DataStore', ts: now };
    const snaps: VenueSnapshot[] = all.map((m): VenueSnapshot => {
      const v = m.inst.venue, acct = accounts.find((a) => a.venue === v), f = m.ticker.funding;
      const g = v === 'gmx' ? state!.get(m.inst.id) : undefined;
      return {
        venue: v, restriction: deps.restriction(v), wallet: WALLET[v], instrument: m.inst, ticker: { ...m.ticker, ts: now },
        book: m.book ? { ...m.book, ts: now } : null, gmx: g ? { ...g, oracleMin: m.ticker.mark, oracleMax: m.ticker.mark, ts: now } : null,
        // the mock's funding history moves between 0.6 and 1.4 times the current rate
        fundingRange: f !== null && f !== undefined ? { minPerHour: D.str(D.min(D.mul(D.from(f), D.from('0.6')), D.mul(D.from(f), D.from('1.4')))), maxPerHour: D.str(D.max(D.mul(D.from(f), D.from('0.6')), D.mul(D.from(f), D.from('1.4')))), hours: 24 } : null,
        chain, account: acct ? { id: acct.id, label: acct.label, kind: 'paper', mode: acct.mode, equity: acct.equity, freeCollateral: acct.freeCollateral } : null,
      };
    }).sort((x, y) => ORDER.indexOf(x.venue) - ORDER.indexOf(y.venue) || x.instrument.id.localeCompare(y.instrument.id));
    let r: ReturnType<typeof routeOrder>;
    try { r = routeOrder(intent as never, snaps, { now }); } catch { return json(400, { error: 'bad_request', message: 'invalid request' }); }
    const candidates = r.candidates.map((e) => {
      const blockers = e.eligibility.reasons.filter((x) => x.kind === 'blocker').map((x) => x.code);
      return { ...e, risk: {
        venue: { accepted: blockers.length === 0, codes: blockers, note: blockers.length === 0 ? `within the limits ${ROUTER_FACTS[e.venue].name} publishes for this instrument (lot, minimum, leverage, liquidity) as far as the snapshot shows` : 'refused by the venue\'s own limits or by the data' },
        accounts: accounts.filter((a) => a.venue === e.venue).map((a) => {
          const head = { accountId: a.id, label: a.label, kind: 'paper' as const, mode: a.mode, network: 'mainnet' }, ob = orderBodyFor(e);
          if (!ob) return { ...head, accepted: null, code: null, reason: 'the order could not be sized on this instrument', source: 'not_checked' as const };
          const p = a.preview({ ...ob, triggerPrice: null, tif: ob.type === 'market' ? 'ioc' : 'gtc' }), risk = p.json?.risk as RiskResult | undefined;
          if (p.status !== 200 || !risk) return { ...head, accepted: false, code: String(p.json?.error ?? 'error'), reason: String(p.json?.message ?? ''), source: 'risk_engine' as const };
          return risk.ok ? { ...head, accepted: true, code: null, reason: null, source: 'risk_engine' as const } : { ...head, accepted: false, code: risk.code, reason: risk.reason, source: 'risk_engine' as const };
        }),
      } };
    });
    return json(200, { ...r, candidates, errors: [], chain });
  }
  return { assets, route };
}
