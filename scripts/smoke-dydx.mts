/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-dydx.mts
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

// Live READ-ONLY check of the dYdX v4 adapter: public indexer GETs and a short websocket subscription. Nothing is signed or sent.
// Run: npx tsx scripts/smoke-dydx.mts [dydx1…/n testnet account]
// Market data comes from mainnet. The account read is done on TESTNET (public test accounts): the mainnet indexer refuses
// account endpoints from blocked locations (HTTP 403 GEOBLOCKED) — the script shows what mainnet answers, and does not work around it.
import { createDydxAdapter, D, VenueError } from '../packages/derivatives/src/index.ts';

const main = createDydxAdapter(), test = createDydxAdapter({ network: 'testnet' });
const TESTNET_ACCOUNT = process.argv[2] ?? 'dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7';
let failed = 0;
const step = async (name: string, f: () => Promise<void>) => {
  const t0 = performance.now();
  try { await f(); console.log(`  ok   ${name}  (${Math.round(performance.now() - t0)} ms)`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e instanceof VenueError ? `${e.code} — ${e.message}` : String(e)}`); }
};

console.log(`dYdX v4 smoke  ${new Date().toISOString()}`);
await step('indexer height', async () => { const h = await main.height(); console.log(`       height ${h.height}, ${Math.round((Date.now() - h.ts) / 1000)} s behind this clock`); });
await step('instruments', async () => {
  const list = await main.instruments();
  const active = list.filter((i) => i.status === 'active');
  console.log(`       ${list.length} perpetuals, ${active.length} active, ${list.length - active.length} halted (mostly final settlement)`);
  for (const s of ['BTC-USD', 'ETH-USD']) {
    const i = list.find((x) => x.symbol === s);
    if (!i) throw new Error(`${s} missing`);
    console.log(`       ${s}: tick ${i.tickSize}  lot ${i.lotSize}  min ${i.minOrderSize}  max leverage ${i.maxLeverage}x  modes ${i.marginModes.join('/')}  funding every ${i.fundingIntervalSec}s  collateral ${i.collateral}`);
  }
});
await step('tickers', async () => {
  const t = await main.tickers();
  for (const s of ['BTC-USD', 'ETH-USD']) {
    const x = t.find((y) => y.instrument === `dydx:${s}`);
    if (!x) throw new Error(`${s} missing`);
    console.log(`       ${s}: oracle ${x.mark}  funding(1h) ${x.funding}  OI ${x.openInterest}  vol24h $${x.volume24h}  chg24h ${x.change24h}`);
  }
});
await step('order book BTC-USD', async () => {
  const b = await main.book('BTC-USD', 5);
  if (!b.bids.length || !b.asks.length) throw new Error('empty book');
  const spread = D.sub(D.from(b.asks[0]![0]), D.from(b.bids[0]![0]));
  console.log(`       best bid ${b.bids[0]![0]} × ${b.bids[0]![1]}   best ask ${b.asks[0]![0]} × ${b.asks[0]![1]}   spread ${D.str(spread)}`);
});
await step('trades / candles / funding history BTC-USD', async () => {
  const [tr, cs, fh] = await Promise.all([main.trades('BTC-USD', 5), main.candles('BTC-USD', '1h', { limit: 3 }), main.fundingHistory('BTC-USD', { start: Date.now() - 6 * 3_600_000 })]);
  console.log(`       last trade ${tr[0]?.side} ${tr[0]?.size} @ ${tr[0]?.price}; last 1h candle close ${cs.at(-1)?.close} vol ${cs.at(-1)?.volume}; ${fh.length} funding rates in 6 h, last ${fh.at(-1)?.rate}`);
});
await step('mainnet account endpoint (expected to be refused from a blocked location)', async () => {
  try { const s = await main.account('dydx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd4mhgw'); console.log(`       answered: equity ${s.equity}`); }
  catch (e) { if (!(e instanceof VenueError) || e.code !== 'rejected') throw e; console.log(`       refused: ${e.message.slice(0, 150)}`); }
});
await step(`testnet account read ${TESTNET_ACCOUNT}`, async () => {
  const [s, ps, oo, fs, fp] = await Promise.all([test.account(TESTNET_ACCOUNT), test.positions(TESTNET_ACCOUNT), test.openOrders(TESTNET_ACCOUNT), test.fills(TESTNET_ACCOUNT, { limit: 5 }), test.funding(TESTNET_ACCOUNT)]);
  console.log(`       equity ${s.equity}  free ${s.freeCollateral}  collateral ${s.collateral}  margin used ${s.marginUsed}`);
  for (const p of ps) console.log(`       ${p.instrument} ${p.side} ${p.size} entry ${p.entryPrice} mark ${p.markPrice} uPnL ${p.unrealizedPnl} lev ${p.leverage} (${p.marginMode})`);
  console.log(`       ${oo.length} open orders, ${fs.length} recent fills, ${fp.length} funding payments (last ${fp[0]?.amount ?? '—'} on ${fp[0]?.instrument ?? '—'})`);
});
await step('websocket: book + trades + ticker for 8 s', async () => {
  const seen: Record<string, number> = {}, status: string[] = [];
  const on = (e: unknown) => { const t = (e as { type: string }).type; seen[t] = (seen[t] ?? 0) + 1; };
  const offs = (['book', 'trades', 'ticker'] as const).map((type) => main.stream({ type, symbol: 'BTC-USD' }, on, (s) => { if (status.at(-1) !== s) status.push(s); }));
  await new Promise((r) => setTimeout(r, 8000));
  for (const off of offs) off();
  console.log(`       status ${status.join(' → ')}; events ${JSON.stringify(seen)}`);
  if (!seen.book || !seen.trades || !seen.ticker || status[0] !== 'connected' || status.length !== 1) throw new Error('stream did not deliver a clean snapshot on every channel');
});
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
