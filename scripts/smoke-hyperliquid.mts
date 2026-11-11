// Live READ-ONLY check of the Hyperliquid adapter on mainnet and testnet: POST /info and websocket subscriptions only.
// Nothing is signed, nothing is sent to /exchange, no account is needed.
// Run: npx tsx scripts/smoke-hyperliquid.mts            (about 25 requests per network, far below the 1200 weight / minute limit)
import { D, type Book, type Ticker } from '../packages/derivatives/src/index.ts';
import { createHyperliquidAdapter, hlFormatPrice, hlTickAt } from '../packages/derivatives/src/venues/hyperliquid/index.ts';

let failed = 0;
const check = (ok: boolean, what: string) => { if (!ok) failed += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const timed = async <T,>(label: string, f: () => Promise<T>, lat: Record<string, number>): Promise<T> => { const t0 = performance.now(); try { return await f(); } finally { lat[label] = Math.round(performance.now() - t0); } };
const bps = (a: string, b: string) => D.toNumber(D.div(D.mul(D.sub(D.from(a), D.from(b)), D.from('10000')), D.from(b), 2, 'half_even')); // display only

for (const network of ['mainnet', 'testnet'] as const) {
  console.log(`\n=== hyperliquid ${network}  ${new Date().toISOString()}`);
  const adapter = createHyperliquidAdapter({ network }), lat: Record<string, number> = {};
  try {
    const instruments = await timed('instruments', () => adapter.instruments(), lat);
    const active = instruments.filter((i) => i.status === 'active');
    console.log(`  instruments ${instruments.length} (active ${active.length}, delisted ${instruments.length - active.length}, isolated-only ${instruments.filter((i) => i.marginModes.length === 1).length})`);
    check(instruments.length > 50 && instruments.some((i) => i.symbol === 'BTC') && instruments.some((i) => i.symbol === 'ETH'), 'instrument list holds BTC and ETH');

    const tickers = await timed('tickers', () => adapter.tickers(), lat);
    check(tickers.length === instruments.length, 'one ticker per instrument');
    for (const sym of ['BTC', 'ETH']) {
      const i = instruments.find((x) => x.symbol === sym)!, t = tickers.find((x) => x.instrument === i.id) as Ticker;
      const book = await timed(`book ${sym}`, () => adapter.book(sym, 5), lat) as Book;
      const bid = book.bids[0]!, ask = book.asks[0]!, szDecimals = i.lotSize === '1' ? 0 : i.lotSize.length - 2;
      console.log(`  ${sym}: mark ${t.mark}  index ${t.index}  mid ${t.mid}  funding/h ${t.funding}  OI ${t.openInterest}  vol24h ${t.volume24h} USD  change24h ${t.change24h}  lot ${i.lotSize}  max lev ${i.maxLeverage}x`);
      console.log(`       top of book: bid ${bid[0]} × ${bid[1]} | ask ${ask[0]} × ${ask[1]}  spread ${bps(ask[0], bid[0])} bps  book age ${Date.now() - book.ts} ms  step at this price ${hlTickAt(bid[0], szDecimals)}`);
      check(D.cmp(D.from(bid[0]), D.from(ask[0])) < 0, `${sym} book is not crossed`);
      // testnet books are thin and its mark drifts away from the (real) oracle: informative there, a check on mainnet only
      if (network === 'mainnet') check(Math.abs(bps(t.mark, t.index!)) < 300, `${sym} mark within 3 % of the oracle (${bps(t.mark, t.index!)} bps)`);
      else console.log(`  info ${sym} testnet mark is ${bps(t.mark, t.index!)} bps from the oracle`);
      check(Math.abs(bps(t.mark, bid[0])) < 300, `${sym} mark within 3 % of the best bid`);
      check(hlFormatPrice(bid[0], szDecimals).ok && hlFormatPrice(ask[0], szDecimals).ok, `${sym} book prices satisfy the documented price rules (5 significant figures, ${6 - szDecimals} decimals)`);
      check(Math.abs(Date.now() - book.ts) < 60_000, `${sym} book is fresh`);
    }
    const trades = await timed('trades BTC', () => adapter.trades('BTC', 5), lat);
    console.log(`  last BTC trades: ${trades.map((t) => `${t.side} ${t.size}@${t.price}`).join(', ')}`);
    check(trades.length > 0, 'recent trades');
    const candles = await timed('candles BTC 1h', () => adapter.candles('BTC', '1h', { limit: 24 }), lat);
    check(candles.length >= 20 && candles.every((c, k) => k === 0 || c.ts - candles[k - 1]!.ts === 3_600_000), `24 hourly candles, contiguous (${candles.length})`);
    const funding = await timed('funding history BTC', () => adapter.fundingHistory('BTC', { start: Date.now() - 6 * 3_600_000 }), lat);
    console.log(`  BTC funding, last hours: ${funding.map((f) => f.rate).join(', ')}`);
    check(funding.length >= 4, 'hourly funding history');
    const empty = await timed('account (empty address)', () => adapter.account('0x00000000000000000000000000000000000000ff'), lat);
    check(empty.source === 'venue' && empty.marginUsed === '0', `account state of an unused address: equity ${empty.equity}`);
    check((await timed('open orders (empty address)', () => adapter.openOrders('0x00000000000000000000000000000000000000ff'), lat)).length === 0, 'no open orders there');

    // websocket: book + trades + ticker for BTC, 6 seconds
    const got: Record<string, number> = {}, status: string[] = [], t0 = performance.now();
    let firstBookMs = -1;
    const on = (e: unknown) => { const type = (e as { type: string }).type; got[type] = (got[type] ?? 0) + 1; if (type === 'book' && firstBookMs < 0) firstBookMs = Math.round(performance.now() - t0); };
    const stops = (['book', 'trades', 'ticker'] as const).map((type) => adapter.stream({ type, symbol: 'BTC' }, on, (s) => { if (status.at(-1) !== s) status.push(s); }));
    await new Promise((r) => setTimeout(r, 6000));
    for (const stop of stops) stop();
    console.log(`  websocket 6 s: ${Object.entries(got).map(([k, v]) => `${k} ${v}`).join(', ')}  status ${status.join(' → ')}  first book after ${firstBookMs} ms`);
    check(status[0] === 'connected' && (got.book ?? 0) > 0 && (got.ticker ?? 0) > 0 && !got.invalid, 'websocket delivered book and ticker messages, none invalid');

    console.log(`  timing (ms): ${Object.entries(lat).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  rate-limit weight used: ${adapter.http.budget.used()} of 1200 per minute`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${e instanceof Error ? e.message : e}`);
  } finally { adapter.close(); }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
