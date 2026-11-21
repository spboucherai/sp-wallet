/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/sim-deriv-router.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Universal derivatives router against reality — READ ONLY (docs/v4/ROUTER.md, "Validation").
// Public market data of Hyperliquid, GMX and dYdX through the wallet's own adapters, the public GMX trade feed, and
// `eth_gasPrice` / `eth_call` / `eth_getTransactionReceipt` on public Arbitrum RPC endpoints. No trading endpoint is called,
// nothing is signed, no key or secret is read: this script imports no signer, no trading object and no configuration.
//
// Run: npx tsx scripts/sim-deriv-router.mts [SMALLCAP=DOGE]
//  1. the router on BTC and ETH at 1 000, 25 000 and 500 000 USD, and on one smaller-cap asset;
//  2. the Hyperliquid fill simulation against a second, independent computation from the RAW l2Book answer (fetched directly);
//  3. the GMX price-impact formula against what the venue publishes: `closePriceImpactDeltaUsd` of real open positions;
//  4. gas actually used by recent GMX order requests and USDC transfers (receipts), next to the constants the router assumes.
import { ARBITRUM_GAS_UNITS, createDydxAdapter, createGmxAdapter, createHyperliquidAdapter, D, gmxBalanceOi, gmxPriceImpact, routeOrder,
  type ChainCosts, type ExecutionEstimate, type GmxLiquidity, type Instrument, type Ticker, type VenueSnapshot } from '../packages/derivatives/src/index.ts';
import { ARBITRUM_RPCS, createChainCostsReader } from '../services/api/src/derivatives/chain-costs.ts';

const SMALL = (process.argv[2] ?? 'DOGE').toUpperCase();
const hl = createHyperliquidAdapter({ network: 'mainnet' }), gmx = createGmxAdapter({ chain: 'arbitrum' }), dydx = createDydxAdapter({ network: 'mainnet' });
const chainReader = createChainCostsReader();
const DYDX_NOTE = 'dYdX is not available to you: its terms of use exclude Canada';
const f = (x: string | null | undefined, dp = 2): string => (x === null || x === undefined ? 'unknown' : D.str(D.div(D.from(x), D.one, dp, 'half_even')));
const num = (x: string): number => Number(x);
const line = (s = ''): void => console.log(s);
const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch((e: unknown) => { line(`   (read failed: ${e instanceof Error ? e.message.slice(0, 140) : String(e)})`); return null; });

line(`Derivatives router — live read-only simulation  ${new Date().toISOString()}`);
line('No order, no signature, no trading endpoint. Every cost below is an estimate on a snapshot.\n');

const [hlI, gmxI, dyI] = await Promise.all([hl.instruments(), gmx.instruments(), settle(dydx.instruments())]);
const read = async () => {
  const [hlT, gmxT, gmxL, dyT] = await Promise.all([hl.tickers(), gmx.tickers(), gmx.liquidity(), dyI ? settle(dydx.tickers()) : null]);
  return { hlT, gmxT, gmxL, dyT };
};
let live = await read();
const ethTicker = live.gmxT.find((t) => t.instrument === 'gmx:ETH/USD [WETH-USDC]');
const chain: ChainCosts = await chainReader.read(ethTicker ? { value: ethTicker.mark, source: 'GMX oracle mid of ETH/USD' } : null);
line(`Arbitrum gas price ${chain.gasPriceEth ? `${D.str(D.mul(D.from(chain.gasPriceEth), D.from(10n ** 9n)))} gwei` : 'unknown'}; ETH ${f(chain.ethUsd)} USD (${chain.ethUsdSource})`);
line(`GMX execution fee: ${chain.gmxExecutionFeeEth ?? 'unknown'} ETH — ${chain.gmxExecutionFeeNote}\n`);

/** the last 24 h of the hourly funding rate (what longs pay), as the API service supplies it to the router */
const ranges = new Map<string, VenueSnapshot['fundingRange']>();
async function fundingRange(a: { fundingHistory: typeof hl.fundingHistory }, i: Instrument): Promise<VenueSnapshot['fundingRange']> {
  if (ranges.has(i.id)) return ranges.get(i.id)!;
  const h = await a.fundingHistory(i.symbol, { start: Date.now() - 24 * 3_600_000 }).catch(() => []);
  const per = h.map((x) => D.div(D.mul(D.from(x.rate), D.from(3600n)), D.from(BigInt(i.fundingIntervalSec)), 18, 'half_even'));
  const r = per.length >= 2 ? { minPerHour: D.str(per.reduce((x, y) => D.min(x, y))), maxPerHour: D.str(per.reduce((x, y) => D.max(x, y))), hours: 24 } : null;
  ranges.set(i.id, r);
  return r;
}
async function snapshotsFor(base: string): Promise<VenueSnapshot[]> {
  live = await read();
  const out: VenueSnapshot[] = [], common = { chain, account: null };
  const h = hlI.find((i) => i.base === base && i.status !== 'halted');
  if (h) {
    const [book, fr] = await Promise.all([hl.book(h.symbol), fundingRange(hl, h)]);
    out.push({ venue: 'hyperliquid', restriction: null, wallet: { trading: 'paper', note: 'paper trading; the live path exists and is disabled' }, instrument: h, ticker: live.hlT.find((t: Ticker) => t.instrument === h.id)!, book, gmx: null, fundingRange: fr, ...common });
  }
  for (const g of gmxI.filter((i: Instrument) => i.base === base && i.status !== 'halted')) {
    const l = live.gmxL.find((x: GmxLiquidity) => x.instrument === g.id), t = live.gmxT.find((x) => x.instrument === g.id);
    if (l && t) out.push({ venue: 'gmx', restriction: null, wallet: { trading: 'none', note: 'read only: GMX trading is not built in this wallet' }, instrument: g, ticker: t, book: null, gmx: l, fundingRange: await fundingRange(gmx, g), ...common });
  }
  const dy = dyI?.find((i) => i.base === base && i.status !== 'halted'), dt = dy && live.dyT?.find((t) => t.instrument === dy.id);
  if (dy && dt) { const book = await settle(dydx.book(dy.symbol)); if (book) out.push({ venue: 'dydx', restriction: DYDX_NOTE, wallet: { trading: 'none', note: DYDX_NOTE }, instrument: dy, ticker: dt, book, gmx: null, fundingRange: null, ...common }); }
  return out;
}

const cost = (e: ExecutionEstimate, id: string): string => { const c = e.costs.find((x) => x.id === id); return c ? f(c.usd, 4) : '—'; };
function show(e: ExecutionEstimate): void {
  const blockers = e.eligibility.reasons.filter((r) => r.kind === 'blocker');
  const tag = blockers.some((r) => r.code === 'venue_restricted') ? 'NOT AVAILABLE TO YOU' : blockers.length ? `not eligible: ${blockers.map((r) => r.code).join(', ')}` : e.eligibility.executableNow ? `eligible (${e.eligibility.executableAs})` : `eligible in simulation; setup: ${e.eligibility.reasons.filter((r) => r.kind === 'setup').map((r) => r.code).join(', ')}`;
  line(`  ${e.instrument}  [${tag}]`);
  if (!e.fill) { for (const r of blockers) line(`      ${r.message}`); return; }
  const fl = e.fill;
  if (fl.method === 'order_book_walk') line(`      fill: ${fl.filledBase} at avg ${f(fl.avgPrice, 4)} (worst ${f(fl.worstPrice, 4)}), ${f(fl.slippageBps, 3)} bps vs mid ${f(fl.referencePrice, 4)}; ${fl.levelsConsumed}/${fl.snapshotLevels} levels, ${f(fl.depthConsumedPct, 2)} % of the snapshot side${num(fl.unfilledBase) > 0 ? `; UNFILLED ${fl.unfilledBase} — book snapshot ends` : ''}`);
  else line(`      fill: ${f(e.order!.sizeUsd)} USD at oracle ${f(fl.avgPrice, 4)} (range ${f(fl.gmx!.oracleMin, 4)} – ${f(fl.gmx!.oracleMax, 4)}); impact ${f(fl.gmx!.impactUsd, 4)} USD${fl.gmx!.capped ? ' CAPPED' : ''} (caps +${f(fl.gmx!.capPositiveUsd)} / −${f(fl.gmx!.capNegativeUsd)}), imbalance ${f(fl.gmx!.imbalanceBeforeUsd, 0)} → ${f(fl.gmx!.imbalanceAfterUsd, 0)} USD (${fl.gmx!.openInterestBasis}), balance ${fl.gmx!.balanceWasImproved ? 'improved' : 'not improved'}, virtual inventory ${fl.gmx!.virtualInventory}${fl.gmx!.fromVirtualInventory ? ' (it gives the figure)' : ''}; ${f(fl.depthConsumedPct, 3)} % of remaining capacity`);
  line(`      costs USD: spread/slippage ${cost(e, 'spread_slippage')} | fee ${cost(e, 'trading_fee')} | impact ${cost(e, 'price_impact')} | exec fee ${cost(e, 'execution_fee')} | gas ${cost(e, 'network_gas')} | funding ${cost(e, 'funding')} | borrow ${cost(e, 'borrow')} | collateral ${cost(e, 'collateral_transfer')}`);
  if (e.margin) line(`      margin: initial ${f(e.margin.initialMarginUsd)} USD at ${e.margin.leverage}×; maintenance ${e.margin.maintenanceFraction ?? 'unknown'}; liquidation (estimate) ${f(e.margin.liquidationPrice.value, 2)}, ${f(e.margin.liquidationDistanceBps, 0)} bps away`);
  if (e.allIn) line(`      ALL-IN over ${e.allIn.horizonHours} h: ${f(e.allIn.usd, 4)} USD = ${f(e.allIn.bps, 3)} bps ± ${f(e.allIn.uncertaintyUsd, 4)} USD${e.allIn.unknown.length ? `  (unknown, not included: ${e.allIn.unknown.join(', ')})` : ''}${e.exit ? `; closing right away would add ${f(e.exit.usd, 4)} USD → round trip ${f(e.exit.roundTripUsd, 4)} USD (${f(e.exit.roundTripBps, 2)} bps)` : ''}`);
  for (const r of blockers) if (r.code !== 'venue_restricted') line(`      ! ${r.message}`);
}

// ---------------------------------------------------------------- 1. the router
const cases: [string, string][] = [['BTC', '1000'], ['BTC', '25000'], ['BTC', '500000'], ['ETH', '1000'], ['ETH', '25000'], ['ETH', '500000'], [SMALL, '25000']];
for (const [base, usd] of cases) {
  const snaps = await snapshotsFor(base);
  const r = routeOrder({ base, side: 'long', notionalUsd: usd, leverage: '3', type: 'market', horizonHours: '24' }, snaps, { now: Date.now() });
  line(`=== ${base} long ${usd} USD, 3×, market, 24 h — ${r.candidates.length} instruments`);
  for (const e of r.candidates) show(e);
  line(`  ranking by all-in cost (information, nothing selected): ${r.ranking.rows.map((x) => `#${x.rank} ${x.instrument} ${f(x.allInUsd, 4)} USD (${f(x.allInBps, 2)} bps)${x.tiedWith.length ? ' TIE' : ''}${x.nearTieWith.length ? ` ~near tie with ${x.nearTieWith.length}` : ''}${x.roundTripRank ? ` [round trip #${x.roundTripRank}: ${f(x.roundTripUsd, 2)}]` : ''}`).join('  |  ') || 'no eligible instrument'}`);
  if (r.ranking.orderChangesWithExit) line('  NOTE: the order changes when an immediate close is added (round trip).');
  line(`  ${r.differences.statement}`);
  line();
}

// ---------------------------------------------------------------- 2. Hyperliquid: independent recomputation from the raw book
line('=== Cross-check 1 — Hyperliquid fill simulation vs an independent computation on the RAW l2Book (integer arithmetic, own request)');
const rawBook = async (coin: string): Promise<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]]; time: number }> =>
  (await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin }) })).json() as never;
const toInt = (s: string, dp: number): bigint => { const [a, b = ''] = s.split('.'); return BigInt(a + b.padEnd(dp, '0').slice(0, dp)); };
let hlWorst = 0;
for (const [base, usd] of [['BTC', '1000'], ['BTC', '25000'], ['BTC', '500000'], ['ETH', '1000'], ['ETH', '25000'], ['ETH', '500000'], [SMALL, '25000']] as const) {
  for (const side of ['long', 'short'] as const) {
    const inst = hlI.find((i) => i.base === base)!;
    // the same raw answer feeds both computations: the adapter path is replayed on it through an injected fetch
    const raw = await rawBook(inst.symbol);
    const replayFetch = (async (_u: string, init: RequestInit) => {
      const t = (JSON.parse(String(init.body)) as { type: string }).type;
      if (t === 'l2Book') return new Response(JSON.stringify(raw), { status: 200 });
      return fetch('https://api.hyperliquid.xyz/info', init);
    }) as unknown as typeof fetch;
    const a2 = createHyperliquidAdapter({ network: 'mainnet', fetch: replayFetch });
    const [book, tickers] = await Promise.all([a2.book(inst.symbol), a2.tickers()]);
    const snap: VenueSnapshot = { venue: 'hyperliquid', restriction: null, wallet: { trading: 'paper', note: '' }, instrument: inst, ticker: tickers.find((t) => t.instrument === inst.id)!, book, gmx: null, fundingRange: null, chain: null, account: null };
    const e = routeOrder({ base, side, notionalUsd: usd, leverage: '3', type: 'market', horizonHours: '0' }, [snap], { now: Date.now() }).candidates[0]!;
    // independent: integers of 1e-8 USD and 1e-8 base units, straight from the raw levels — no shared code with the router
    const P = 8, S = 8, lv = side === 'long' ? raw.levels[1] : raw.levels[0];
    let left = toInt(e.order!.sizeBase, S), costInt = 0n, worst = 0n, used = 0;
    for (const l of lv) { if (left <= 0n) break; const sz = toInt(l.sz, S), take = left < sz ? left : sz; costInt += take * toInt(l.px, P); left -= take; worst = toInt(l.px, P); used += 1; }
    const filledInt = toInt(e.order!.sizeBase, S) - left;
    const indepPx = Number(costInt) / Number(filledInt || 1n);                              // (1e-16 USD) / (1e-8 base) = 1e-8 USD per base
    const mine = e.fill!.avgPrice ? num(e.fill!.avgPrice) : NaN;
    const diff = filledInt > 0n ? Math.abs(mine - indepPx / 1e8) / mine : 0;
    hlWorst = Math.max(hlWorst, diff);
    const okFill = D.eq(D.from(e.fill!.filledBase), D.div(D.from(filledInt), D.from(10n ** 8n), 8, 'down')) && e.fill!.levelsConsumed === used && (worst === 0n || num(e.fill!.worstPrice!) === Number(worst) / 1e8);
    line(`  ${base} ${side} ${usd} USD: router avg ${f(e.fill!.avgPrice, 6)} | independent avg ${(indepPx / 1e8).toFixed(6)} | rel. diff ${diff.toExponential(2)} | filled, levels, worst price ${okFill ? 'identical' : 'DIFFERENT'}${left > 0n ? ` | remainder ${Number(left) / 1e8} (snapshot ends) in both` : ''}`);
  }
}
line(`  largest relative difference on the average price: ${hlWorst.toExponential(2)} (float rounding of the independent side)\n`);

// ---------------------------------------------------------------- 3. GMX: the formula against the venue's own figures
line('=== Cross-check 2 — GMX price impact: router formula vs the venue\'s closePriceImpactDeltaUsd of real open positions');
line('    (the venue publishes no pre-trade estimate for an OPENING order on a read-only endpoint; POST /orders/txns/prepare is on the order path and is not called)');
const SQUID = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const markets = live.gmxL.filter((l) => ['gmx:BTC/USD [BTC-USDC]', 'gmx:ETH/USD [WETH-USDC]', 'gmx:SOL/USD [SOL-USDC]', `gmx:${SMALL}/USD [WETH-USDC]`].includes(l.instrument));
const seen = new Set<string>(); let checked = 0, worstRel = 0, mismatched = 0, viaVirtual = 0;
for (const m of markets) {
  const q = `{ tradeActions(limit: 40, orderBy: timestamp_DESC, where: { eventName_eq: "OrderExecuted", marketAddress_eq: "${m.market}", orderType_in: [2,3] }) { account transactionHash } }`;
  const r = await settle(fetch(SQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) }).then((x) => x.json() as Promise<{ data: { tradeActions: { account: string }[] } }>));
  const accounts = [...new Set((r?.data.tradeActions ?? []).map((t) => t.account))].filter((a) => !seen.has(a)).slice(0, 12);
  for (const account of accounts) {
    seen.add(account);
    // liquidity and positions read together, so that both sides see (nearly) the same open interest and price
    const got = await settle(Promise.all([gmx.positions(account), gmx.liquidity()]));
    if (!got) continue;
    const [positions, liq] = got;
    for (const p of positions) {
      const l = liq.find((x) => x.instrument === p.instrument);
      if (!l || checked >= 30) continue;
      const venue = D.from(p.gmx.closePriceImpactDeltaUsd), oi = gmxBalanceOi(l), pi = l.priceImpact;
      // a decrease removes TOKENS from the side's open interest: its USD delta is the position's tokens × the current price, not its cost basis
      const mid = D.div(D.add(D.from(l.oracleMin), D.from(l.oracleMax)), D.from(2n), 30, 'half_even'), delta = l.useOpenInterestInTokensForBalance ? D.mul(D.from(p.size), mid) : D.from(p.gmx.sizeUsd);
      const run = (sizeDeltaUsd: typeof delta, virtual: typeof oi.virtualUsd) => gmxPriceImpact({ longOi: oi.long, shortOi: oi.short, sizeDeltaUsd, isLong: p.side === 'long', increase: false, virtualInventoryUsd: virtual,
        factorPositive: D.from(pi.factorPositive), factorNegative: D.from(pi.factorNegative), exponentPositive: D.from(pi.exponentPositive), exponentNegative: D.from(pi.exponentNegative) });
      const full = run(delta, oi.virtualUsd), mine = full.impactUsd, costBasis = D.toNumber(run(D.from(p.gmx.sizeUsd), oi.virtualUsd).impactUsd), noVirtual = D.toNumber(run(delta, null).impactUsd);
      const capPos = D.mul(D.from(p.gmx.sizeUsd), D.from(pi.maxFactorPositive)), capNeg = D.neg(D.mul(D.from(p.gmx.sizeUsd), D.from(pi.maxFactorNegative)));
      const a = D.toNumber(mine), b = D.toNumber(venue), rel = Math.abs(b) > 1e-9 ? Math.abs(a / b - 1) : Math.abs(a - b);
      const note = D.gt(mine, capPos) || D.lt(mine, capNeg) ? ' (beyond the cap before netting)' : '';
      checked += 1; worstRel = Math.max(worstRel, rel); if (rel > 0.02) mismatched += 1; if (full.fromVirtualInventory) viaVirtual += 1;
      line(`  ${p.instrument.slice(4)} ${p.side} ${f(p.gmx.sizeUsd, 0)} USD (now ${f(D.str(delta), 0)}): router ${a.toFixed(6)} | venue ${b.toFixed(6)} | rel. diff ${(rel * 100).toFixed(3)} %${note}${rel > 0.02 ? '  <-- differs' : ''}   [virtual inventory ${oi.virtual}${full.fromVirtualInventory ? `, decisive (market alone: ${noVirtual.toFixed(6)})` : ''}; with the cost-basis size instead of tokens × price: ${costBasis.toFixed(6)}]`);
    }
  }
}
line(`  ${checked} positions compared; largest relative difference ${(worstRel * 100).toFixed(4)} %; ${mismatched} beyond 2 %; ${viaVirtual} decided by the virtual inventory\n`);

// ---------------------------------------------------------------- 4. gas actually used, next to the router's constants
line('=== Cross-check 3 — gas used by recent transactions (receipts), next to the constants the router assumes');
const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (const url of ARBITRUM_RPCS) { try { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000) })).json() as { result?: unknown }; if (j.result !== undefined && j.result !== null) return j.result; } catch { /* next endpoint */ } }
  return null;
};
const created = await settle(fetch(SQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tradeActions(limit: 60, orderBy: timestamp_DESC, where: { eventName_eq: "OrderCreated", orderType_in: [2] }) { transactionHash } }' }) }).then((x) => x.json() as Promise<{ data: { tradeActions: { transactionHash: string }[] } }>));
// Classic requests call ExchangeRouter directly and carry the execution fee as ETH; Express requests are relayed (another `to`, no ETH value)
const EXCHANGE_ROUTER = '0x7de39ff2e232a2203196788d37e234cf8f1b83f1';
const classic: number[] = [], relayed: number[] = [], feeEth: number[] = [];
for (const t of [...new Set((created?.data.tradeActions ?? []).map((x) => x.transactionHash))].slice(0, 40)) {
  const [rc, tx] = await Promise.all([rpc('eth_getTransactionReceipt', [t]), rpc('eth_getTransactionByHash', [t])]);
  if (!rc?.gasUsed || !tx) continue;
  if (String(tx.to).toLowerCase() === EXCHANGE_ROUTER) { classic.push(Number(BigInt(rc.gasUsed))); if (BigInt(tx.value) > 0n) feeEth.push(Number(BigInt(tx.value)) / 1e18); }
  else relayed.push(Number(BigInt(rc.gasUsed)));
}
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const span = (a: number[], dp = 0): string => (a.length ? `min ${Math.min(...a).toFixed(dp)} / median ${med(a).toFixed(dp)} / max ${Math.max(...a).toFixed(dp)}` : 'no sample');
line(`  GMX market-increase requests sent to ExchangeRouter (Classic, ${classic.length} receipts): gas used ${span(classic)} — router constant ${ARBITRUM_GAS_UNITS.gmxCreateOrder}`);
line(`  the same through the relay (Express, ${relayed.length} receipts, gas paid by the relay and charged as a relay fee): gas used ${span(relayed)}`);
line(`  ETH sent with the Classic requests (execution fee; plus the collateral when it is ETH): ${span(feeEth, 8)} — router's figure, the contracts' minimum at the current gas price: ${chain.gmxExecutionFeeEth ?? 'unknown'}`);
// recent USDC transfers on Arbitrum: Transfer logs of the native USDC contract in the last blocks
const tip = await rpc('eth_blockNumber', []);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const logs = tip ? await rpc('eth_getLogs', [{ address: USDC, topics: [TRANSFER], fromBlock: `0x${(BigInt(tip) - 160n).toString(16)}`, toBlock: tip }]) : null;
const plain: number[] = [];
for (const h of [...new Set(((logs ?? []) as { transactionHash: string }[]).map((l) => l.transactionHash))].slice(0, 120)) {
  const [rc, tx] = await Promise.all([rpc('eth_getTransactionReceipt', [h]), rpc('eth_getTransactionByHash', [h])]);
  // a plain transfer: the transaction calls the token itself with transfer(address,uint256) and emits one log
  if (rc?.gasUsed && tx?.to?.toLowerCase() === USDC.toLowerCase() && String(tx.input).startsWith('0xa9059cbb') && rc.logs.length === 1) plain.push(Number(BigInt(rc.gasUsed)));
  if (plain.length >= 10) break;
}
line(`  plain USDC transfers (${plain.length} receipts in the last 160 blocks): gas used ${span(plain)} — router constant ${ARBITRUM_GAS_UNITS.erc20Transfer}`);
hl.close();
line('\ndone — nothing was sent anywhere.');
