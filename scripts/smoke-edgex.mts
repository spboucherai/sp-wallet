// Live READ-ONLY check of the edgeX adapter: public GETs and a short public websocket subscription. No key, no account, no
// private endpoint; nothing is signed or sent. edgeX is a market-data-only venue in SP Wallet (its Terms of Use exclude Canada).
// Run: npx tsx scripts/smoke-edgex.mts [--symbol MOONSHOTUSDC]
import { createEdgeXAdapter, D, VenueUnavailable, type Book, type Ticker } from '../packages/derivatives/src/index.ts';

// The sample pre-IPO contract. It was ANTHROPICUSDC until edgeX took that contract off its list (observed 2026-11-17: absent from
// getMetaData and from ticker.all, last trade 01:29:45Z, two days before the company's listing) — a fixed name is a venue fact that expires.
const SYMBOL = process.argv.includes('--symbol') ? process.argv[process.argv.indexOf('--symbol') + 1]! : 'MOONSHOTUSDC';
const iso = (ts: number) => new Date(ts).toISOString();
const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(26)} ${String(v)}`);
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => { console.log(`\n== ${name}`); try { await fn(); } catch (e) { failed += 1; console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`); } };

const a = createEdgeXAdapter();
console.log(`edgeX smoke (read-only)  ${new Date().toISOString()}`);
console.log(`capabilities: marketData ${a.capabilities.marketData}, account ${a.capabilities.account}, orders ${a.capabilities.orders}, trading object ${a.trading === undefined ? 'absent' : 'PRESENT'}`);

await step('instruments (getMetaData + category tabs)', async () => {
  const list = await a.instruments();
  const by: Record<string, number> = {};
  for (const i of list) by[i.category ?? '(none)'] = (by[i.category ?? '(none)'] ?? 0) + 1;
  line('markets listed', list.length);
  for (const [c, n] of Object.entries(by).sort((x, y) => y[1] - x[1])) line(`  ${c}`, n);
  line('category source', [...new Set(list.map((i) => i.edgex.categorySource))].join(', '));
  line('pre_ipo', list.filter((i) => i.category === 'pre_ipo').map((i) => i.symbol).join(', '));
  line('status', Object.entries(list.reduce<Record<string, number>>((m, i) => { m[i.status] = (m[i.status] ?? 0) + 1; return m; }, {})).map(([k, n]) => `${k} ${n}`).join(', '));
  line('funding interval (s)', [...new Set(list.map((i) => i.fundingIntervalSec))].join(', '));
  const i = list.find((x) => x.symbol === SYMBOL);
  if (!i) throw new Error(`${SYMBOL} is not listed`);
  line(SYMBOL, `contractId ${i.edgex.contractId}, category ${i.category}, tick ${i.tickSize}, lot ${i.lotSize}, min ${i.minOrderSize}, max leverage ${i.maxLeverage}×`);
  line('  fees / tiers', `maker ${i.edgex.makerFeeRate}, taker ${i.edgex.takerFeeRate}; ${i.edgex.riskTiers.map((t) => `tier ${t.tier}: ${t.maxLeverage}× mm ${t.maintenanceMarginRate}`).join('; ')}`);
});

const show = (t: Ticker) => {
  line('last / mark / index', `${t.last ?? '—'} / ${t.mark} / ${t.index ?? '—'}`);
  line('mid', t.mid ?? '—');
  line('funding (forecast)', `${t.funding ?? '—'}  next settlement ${t.nextFundingTs ? iso(t.nextFundingTs) : '—'}`);
  line('open interest (base)', t.openInterest ?? '—');
  line('24 h volume', `${t.volumeBase24h ?? '—'} base, ${t.volume24h ?? '—'} USDC`);
  line('24 h change', t.change24h === null ? '—' : `${D.str(D.mul(D.from(t.change24h), D.from(100n)))} %`);
  line('received at', iso(t.ts));
};
await step('tickers (websocket ticker.all.1s, REST fallback)', async () => {
  const t0 = Date.now(), all = await a.tickers();
  line('tickers', `${all.length} in ${Date.now() - t0} ms, source ${a.diagnostics().tickerSource}`);
  const t = all.find((x) => x.instrument === `edgex:${SYMBOL}`);
  if (!t) throw new Error(`no ticker for ${SYMBOL}`);
  show(t);
});

await step(`book ${SYMBOL} (getDepth level 15 and 200)`, async () => {
  const top = (b: Book) => `bid ${b.bids[0]?.[0]} × ${b.bids[0]?.[1]}  |  ask ${b.asks[0]?.[0]} × ${b.asks[0]?.[1]}  (${b.bids.length} bids, ${b.asks.length} asks)`;
  const b15 = await a.book(SYMBOL, 15), b200 = await a.book(SYMBOL, 200);
  line('level 15', top(b15)); line('level 200', top(b200));
  if (b15.bids[0] && b15.asks[0]) line('spread', D.str(D.sub(D.from(b15.asks[0][0]), D.from(b15.bids[0][0]))));
});

await step(`candles ${SYMBOL}`, async () => {
  for (const iv of ['1m', '1h', '1d'] as const) { const c = await a.candles(SYMBOL, iv, { limit: 3 }); line(iv, c.map((x) => `${iso(x.ts).slice(0, 16)} c=${x.close} v=${x.volume}`).join('  ')); }
  const many = await a.candles(SYMBOL, '1m', { limit: 1500 });
  line('1m × 1500 (2 pages)', `${many.length} candles, ${iso(many[0]!.ts)} → ${iso(many.at(-1)!.ts)}, contiguous ${many.every((x, k) => k === 0 || x.ts > many[k - 1]!.ts)}`);
});

await step(`funding history ${SYMBOL} (getFundingRatePage, settlements)`, async () => {
  const f = await a.fundingHistory(SYMBOL, { start: Date.now() - 48 * 3_600_000 });
  line('settlements in 48 h', f.length);
  for (const x of f.slice(-4)) line(`  ${iso(x.ts)}`, `rate ${x.rate}  premium ${x.premium ?? '—'}`);
  line('spacing (h)', [...new Set(f.slice(1).map((x, k) => (x.ts - f[k]!.ts) / 3_600_000))].join(', '));
});

await step(`trades ${SYMBOL} (websocket snapshot: no REST endpoint exists)`, async () => {
  const t = await a.trades(SYMBOL, 5);
  line('recent trades', t.length);
  for (const x of t) line(`  ${iso(x.ts)}`, `${x.side} ${x.size} @ ${x.price}`);
});

await step(`websocket ticker.{contractId} for ${SYMBOL}: a frame within 15 s`, async () => {
  const t0 = Date.now(), status: string[] = [];
  let n = 0, off = () => {};
  const first = await new Promise<{ ticker: Ticker; ms: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ticker frame within 15 s')), 15_000);
    off = a.stream({ type: 'ticker', symbol: SYMBOL }, (ev) => {
      const e = ev as { type: string; ticker?: Ticker; message?: string };
      if (e.type === 'error') { clearTimeout(timer); reject(new Error(e.message ?? 'stream error')); }
      if (e.type === 'ticker' && e.ticker) { n += 1; if (n === 1) { clearTimeout(timer); resolve({ ticker: e.ticker, ms: Date.now() - t0 }); } }
    }, (s) => status.push(s));
  });
  line('first frame after', `${first.ms} ms (status: ${status.join(' → ')})`);
  line('mark', first.ticker.mark);
  await new Promise((r) => setTimeout(r, 12_000));                 // long enough to see a server ping answered
  off();
  const d = a.diagnostics().stream;
  line('in 12 s more', `${n} ticker frames; ${d.frames} frames in all, ${d.pongs} pong(s) sent, ${d.invalid} invalid, ${d.resyncs} depth resync(s), ${d.connects} connection(s)`);
});

await step('websocket depth: versions contiguous, book never crossed (10 s, levels 15 and 200)', async () => {
  for (const level of [15, 200] as const) {
    const b = createEdgeXAdapter({ streamBookLevel: level });
    let books = 0, gaps = 0, crossed = 0, levels = 0, bad = 0;
    const off = b.stream({ type: 'book', symbol: 'BTCUSDC' }, (ev) => {
      const e = ev as { type: string; book?: Book };
      if (e.type === 'gap') gaps += 1;
      if (e.type === 'invalid') bad += 1;
      if (e.type === 'book' && e.book) { books += 1; levels = Math.max(levels, e.book.bids.length); if (e.book.bids[0] && e.book.asks[0] && D.gte(D.from(e.book.bids[0][0]), D.from(e.book.asks[0][0]))) crossed += 1; }
    }, () => {});
    await new Promise((r) => setTimeout(r, 10_000));
    off(); b.close();
    line(`BTCUSDC depth.${level}`, `${books} books, ${gaps} gap(s), ${bad} invalid, ${crossed} crossed, up to ${levels} bid levels emitted`);
    if (books === 0) throw new Error(`no book on depth.${level}`);
  }
});

await step('account and trading: refused before any request', async () => {
  const calls = a.diagnostics().restCalls;
  for (const [name, p] of [['account', a.account('0x0')], ['positions', a.positions('0x0')], ['openOrders', a.openOrders('0x0')]] as const) {
    const e = await p.then(() => null, (x: unknown) => x);
    if (!(e instanceof VenueUnavailable)) throw new Error(`${name} did not throw VenueUnavailable`);
    line(name, `VenueUnavailable(${e.reason})`);
  }
  line('requests sent for these', a.diagnostics().restCalls - calls);
  line('note', a.capabilities.notes[0]!.slice(0, 150) + '…');
});

const d = a.diagnostics();
console.log(`\nREST calls ${d.restCalls}, rate-limit backoff ${d.rateLimitedUntil > Date.now() ? 'ACTIVE' : 'none'}, websocket connections ${d.stream.connects}`);
a.close();
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall steps passed');
process.exit(failed ? 1 : 0);
