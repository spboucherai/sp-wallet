/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-gmx.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Live READ-ONLY check of the GMX v2 adapter: public GETs on the GMX API and the Oracle API, one public GraphQL query.
// Nothing is signed or sent, no RPC transaction, no approval.
// Run: npx tsx scripts/smoke-gmx.mts [arbitrum|avalanche] [0x… account]
// Without an account, the script takes the most recent trader of the public BTC/USD trade feed (a public address) to show the account-read shape.
import { createGmxAdapter, D, VenueError, type GmxChain } from '../packages/derivatives/src/index.ts';

const chain = (process.argv[2] === 'avalanche' ? 'avalanche' : 'arbitrum') as GmxChain;
const g = createGmxAdapter({ chain });
let failed = 0;
const step = async (name: string, f: () => Promise<void>) => {
  const t0 = performance.now();
  try { await f(); console.log(`  ok   ${name}  (${Math.round(performance.now() - t0)} ms)`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e instanceof VenueError ? `${e.code} — ${e.message}` : String(e)}`); }
};
const short = (s: string, n = 12) => (s.length > n ? s.slice(0, n) : s);

console.log(`GMX v2 smoke (${chain})  ${new Date().toISOString()}`);
let btc = '', eth = '';
await step('instruments', async () => {
  const list = await g.instruments();
  console.log(`       ${list.length} perpetual markets, ${list.filter((i) => i.status === 'active').length} listed; ${list.filter((i) => i.base === 'BTC').length} BTC/USD pools, ${list.filter((i) => i.base === 'ETH').length} ETH/USD pools`);
  const pick = (base: string) => list.find((i) => i.base === base && / or USDC$/.test(i.collateral) && !/USDE|USDG/i.test(i.symbol)) ?? list.find((i) => i.base === base);
  for (const i of [pick('BTC'), pick('ETH')]) {
    if (!i) throw new Error('BTC or ETH market missing');
    if (i.base === 'BTC') btc = i.symbol; else eth = i.symbol;
    console.log(`       ${i.symbol}: collateral ${i.collateral}  price step ${i.tickSize}  token step ${i.lotSize}  min position $${i.minNotional}  max leverage ${i.maxLeverage}x (contract bound)  ${i.marginModes.join('/')}`);
  }
});
await step('tickers', async () => {
  const t = await g.tickers();
  for (const s of [btc, eth]) {
    const x = t.find((y) => y.instrument === `gmx:${s}`);
    if (!x) throw new Error(`${s} missing`);
    console.log(`       ${s}: oracle mid ${short(x.mark, 14)}  longs pay/h ${short(x.funding ?? '', 14)}  OI ${short(x.openInterest ?? '', 12)} tokens (long+short)  vol24h $${short(x.volume24h ?? 'n/a', 14)}  chg24h ${x.change24h}`);
  }
});
await step('no order book → liquidity view', async () => {
  try { await g.book(btc); throw new Error('book() answered'); } catch (e) { if (!(e instanceof VenueError) || e.code !== 'unsupported') throw e; }
  for (const s of [btc, eth]) {
    const [l] = await g.liquidity(s);
    if (!l) throw new Error(`${s}: no liquidity row`);
    console.log(`       ${s}: OI long $${short(l.openInterestLongUsd, 11)} / short $${short(l.openInterestShortUsd, 11)}; capacity long $${short(l.capacityLongUsd, 11)} / short $${short(l.capacityShortUsd, 11)} (limited by ${l.capacityLimitedBy.long}/${l.capacityLimitedBy.short})`);
    console.log(`         rates/h (venue sign, + = side receives): funding L ${short(l.fundingRateLongPerHour, 13)} S ${short(l.fundingRateShortPerHour, 13)}; borrow L ${short(l.borrowingRateLongPerHour, 13)} S ${short(l.borrowingRateShortPerHour, 13)}`);
    console.log(`         position fee ${l.positionFeeFactor.balanceImproved}/${l.positionFeeFactor.balanceNotImproved}; impact cap +${l.priceImpact.maxFactorPositive}/−${l.priceImpact.maxFactorNegative}; min collateral factor ${l.minCollateralFactor}`);
  }
});
await step('oracle prices (contract precision) vs GMX API mark', async () => {
  const [ps, t] = await Promise.all([g.oraclePrices(), g.tickers()]);
  for (const [sym, market] of [['BTC', btc], ['ETH', eth]] as const) {
    const p = ps.find((x) => x.symbol === sym), mark = t.find((y) => y.instrument === `gmx:${market}`)?.mark;
    if (!p || !mark) throw new Error(`${sym} missing`);
    const ratio = D.div(D.from(p.min), D.from(mark), 6, 'half_even');
    console.log(`       ${sym}: oracle min ${short(p.min, 14)} max ${short(p.max, 14)}; ratio to API mark ${D.str(ratio)}`);
    if (D.cmp(ratio, D.from('0.98')) < 0 || D.cmp(ratio, D.from('1.02')) > 0) throw new Error('the two price formats disagree by more than 2 %');
  }
});
let account = process.argv[3] ?? '';
await step('public trades / candles / funding history', async () => {
  const [tr, cs, fh] = await Promise.all([g.trades(btc, 20), g.candles(btc, '1h', { limit: 3 }), g.fundingHistory(btc, { start: Date.now() - 12 * 3_600_000 })]);
  console.log(`       ${tr.length} recent executions, last ${tr[0]?.side} ${tr[0]?.size} @ ${short(tr[0]?.price ?? '', 12)}; last 1h close ${cs.at(-1)?.close}; ${fh.length} hourly funding snapshots, last ${short(fh.at(-1)?.rate ?? '', 14)}`);
});
if (!account) {
  // the trade feed carries no account in the normalized model; ask the public GraphQL endpoint for one recent trader
  const r = await fetch(`https://gmx.squids.live/gmx-synthetics-${chain}:prod/api/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ tradeActions(limit: 1, orderBy: timestamp_DESC, where: { eventName_eq: "OrderExecuted", orderType_in: [2,3] }) { account } }' }) });
  account = ((await r.json()) as { data: { tradeActions: { account: string }[] } }).data.tradeActions[0]?.account ?? '';
}
await step(`account read ${account}`, async () => {
  const [s, ps, oo, fs] = await Promise.all([g.account(account), g.positions(account), g.openOrders(account), g.fills(account, { limit: 5 })]);
  console.log(`       equity $${short(s.equity, 12)}  collateral $${short(s.collateral, 12)} in ${ps.length} position(s), ${oo.length} open order(s), ${fs.length} recent fill(s)`);
  for (const p of ps.slice(0, 5)) console.log(`       ${p.instrument} ${p.side} ${short(p.size, 12)} entry ${short(p.entryPrice, 10)} mark ${short(p.markPrice, 10)} liq ${short(p.liquidationPrice ?? '—', 10)} lev ${p.leverage}x  uPnL $${short(p.unrealizedPnl, 10)}  close fee $${short(p.gmx.closingFeeUsd, 8)}  pending impact $${short(p.gmx.pendingImpactUsd, 9)}  borrow $${short(p.gmx.pendingBorrowingFeesUsd, 8)} funding $${short(p.gmx.pendingFundingFeesUsd, 8)}`);
  for (const o of oo.slice(0, 3)) console.log(`       order ${o.gmx.orderType} ${o.side} $${short(o.size, 10)} trigger ${short(o.triggerPrice ?? '—', 10)} ${o.status}${o.gmx.closesWholePosition ? ' (whole position)' : ''}`);
  for (const f of fs.slice(0, 2)) console.log(`       fill ${f.gmx.orderType} ${f.side} ${short(f.size, 10)} @ ${short(f.price, 10)} fee ${f.fee} ${f.feeAsset} impact $${short(f.gmx.priceImpactUsd ?? '—', 9)}`);
});
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
