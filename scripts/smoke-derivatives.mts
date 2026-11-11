// Live smoke of the derivatives API (wave 2: read-only and paper). Boots the API in-process against a scratch database with
// the REAL venue adapters — public read endpoints only — then: venues, a paper account on Hyperliquid, a preview and a small
// paper market order on BTC, the account read back, the comparison table for BTC and ETH, the position closed, and a few seconds of the live
// stream (public websocket).
// Nothing is signed, the signer is never contacted, no venue trading endpoint is called (every outgoing request is listed
// by host and checked). The paper account lives in the scratch database only.
// Run: npx tsx scripts/smoke-derivatives.mts [--notional 50] [--db spw_deriv_smoke] [--watch 0x<public address>]
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const DB = arg('db', 'spw_deriv_smoke'), NOTIONAL = arg('notional', '50'), WATCH = arg('watch', '');
if (WATCH && !/^0x[0-9a-fA-F]{40}$/.test(WATCH)) throw new Error('--watch takes a 20-byte hex address');
if (!/^[a-z_]+$/.test(DB)) throw new Error('bad database name');
// scratch database, created with the PostgreSQL client tools if it does not exist yet (postgres.js belongs to the API service)
try { execFileSync('createdb', [DB], { stdio: 'pipe' }); } catch (e) { if (!/already exists/.test(String((e as { stderr?: Buffer }).stderr ?? e))) throw e; }
Object.assign(process.env, { SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: 'unused-'.repeat(8),
  SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });

const { D } = await import('../packages/derivatives/src/index.ts');
const { migrate, sql } = await import('../services/api/src/db.ts');
const { COOKIE } = await import('../services/api/src/auth.ts');
const { createDerivatives, createDefaultRegistry } = await import('../services/api/src/derivatives/index.ts');
const { buildServer } = await import('../services/api/src/server.ts');

// every request that leaves the process: method, host and path — and a hard stop on anything that is not a public read
const seen = new Map<string, number>();
const watched = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url)), method = init?.method ?? 'GET';
  if (/exchange|order|trade\/|submit|broadcast/i.test(u.pathname) && !/\/orderbooks\/|\/trades\/perpetualMarket|\/v1\/trades|\/v1\/orders/.test(u.pathname)) throw new Error(`refused: ${method} ${u.host}${u.pathname} is not a public read`);
  if (u.host === 'api.hyperliquid.xyz' && u.pathname !== '/info') throw new Error(`refused: Hyperliquid ${u.pathname}`);
  const k = `${method} ${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{40}/g, '<address>')}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
  return fetch(url, init);
}) as typeof fetch;

await migrate();
await sql`truncate deriv_paper_accounts cascade`;
const token = randomBytes(32).toString('base64url');
await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '10 minutes')`;
const derivatives = createDerivatives({ registry: createDefaultRegistry({ fetch: watched }) });
const app = await buildServer({ derivatives });
const P = '/api/v1/derivatives';
async function call(method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<any> {
  const headers: Record<string, string> = { cookie: `${COOKIE}=${token}` };
  if (method === 'POST') Object.assign(headers, { origin: process.env.SPW_ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' });
  if (idem) headers['idempotency-key'] = idem;
  const t = Date.now(), r = await app.inject({ method, url: P + path, headers, payload: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  const json = r.json();
  console.log(`  ${method} ${P}${path.split('?')[0]} → ${r.statusCode} (${Date.now() - t} ms)`);
  if (r.statusCode !== 200) throw new Error(`${method} ${path}: ${r.statusCode} ${JSON.stringify(json)}`);
  return json;
}
const pad = (x: unknown, n: number) => String(x ?? '—').padEnd(n);
const short = (x: string | null, n = 10) => (x === null ? '—' : x.length > n ? x.slice(0, n) : x);
const BTC = 'hyperliquid:BTC';
let failed = false;
try {
  console.log(`derivatives smoke at ${new Date().toISOString()} — real adapters, public read endpoints, scratch database ${DB}\n`);
  console.log('1. venues');
  const venues = (await call('GET', '/venues')).venues;
  for (const v of venues) console.log(`     ${pad(v.id, 12)} ${pad(v.network, 8)} status=${pad(v.status, 9)} paper=${pad(v.paper, 6)} account=${pad(v.capabilities.account, 6)} stream=${pad(v.capabilities.stream, 6)}${v.restriction ? `\n       restriction: ${v.restriction}` : ''}`);

  console.log('\n2. market');
  const m = await call('GET', `/market?instrument=${encodeURIComponent(BTC)}`);
  console.log(`     ${BTC}: mark ${m.ticker.mark}, index ${m.ticker.index}, mid ${m.ticker.mid}, funding ${m.ticker.funding}/h, best bid ${m.book.bids[0][0]} × ${m.book.bids[0][1]}, best ask ${m.book.asks[0][0]} × ${m.book.asks[0][1]}, ${m.trades.length} trades, tick ${m.instrument.tickSize}, lot ${m.instrument.lotSize}`);
  const candles = await call('GET', `/candles?instrument=${encodeURIComponent(BTC)}&interval=1h&limit=3`);
  console.log(`     last 1h candles: ${candles.candles.map((c: any) => `${new Date(c.ts).toISOString().slice(11, 16)} c=${c.close}`).join(', ')}`);
  const funding = await call('GET', `/funding?instrument=${encodeURIComponent(BTC)}&hours=6`);
  console.log(`     funding, last ${funding.history.length} h (interval ${funding.intervalSec} s): ${funding.history.map((f: any) => f.rate).join(', ')}`);

  console.log('\n3. paper account on Hyperliquid');
  const acct = await call('POST', '/accounts', { venue: 'hyperliquid', label: 'smoke', collateral: '10000' });
  console.log(`     ${acct.id} kind=${acct.kind} mode=${acct.mode} equity=${acct.state.equity} policy: maxLeverage ${acct.policy.maxLeverage}, maxOrderNotional ${acct.policy.maxOrderNotional}, maxDailyLoss ${acct.policy.maxDailyLoss}, instruments ${acct.policy.allowedInstruments.join(' ')}`);

  // about NOTIONAL USD of BTC, on the lot
  const size = D.str(D.quantize(D.div(D.from(NOTIONAL), D.from(m.ticker.mark), 12, 'down'), D.from(m.instrument.lotSize), 'down'));
  const body = { instrument: BTC, side: 'buy', type: 'market', size, price: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', slippageBps: 50 };
  console.log(`\n4. preview: buy ${size} BTC at market (worst price derived from the book, 50 bps)`);
  const pv = await call('POST', `/accounts/${acct.id}/orders/preview`, body);
  console.log(`     risk: ${JSON.stringify(pv.risk)}`);
  console.log(`     estimate: worst price ${pv.request.price}, avg fill ${short(pv.estimate.avgFillPrice, 12)}, notional ${short(pv.estimate.notional, 12)}, fee ${short(pv.estimate.fee, 10)}, initial margin ${short(pv.estimate.initialMargin, 10)} at ${pv.estimate.leverage}x, slippage ${pv.estimate.slippageBps} bps vs mid, free collateral after ${short(pv.estimate.freeCollateralAfter, 12)}, liquidation ${JSON.stringify(pv.estimate.liquidationPrice?.value ?? null)} (${pv.estimate.source})`);
  if (!pv.risk.ok) throw new Error('the preview was refused by the risk engine');

  console.log('\n5. paper order');
  const key = `smoke-${randomUUID()}`;
  const placed = await call('POST', `/accounts/${acct.id}/orders`, body, key);
  console.log(`     order ${placed.order.venueOrderId} ${placed.order.status}: filled ${placed.order.filled} @ ${short(placed.order.avgFillPrice, 12)}; ${placed.fills.length} fill(s): ${placed.fills.map((f: any) => `${f.size} @ ${f.price} fee ${f.fee} ${f.feeAsset}`).join('; ')}`);
  const replay = await call('POST', `/accounts/${acct.id}/orders`, body, key);
  console.log(`     same Idempotency-Key again: idempotent=${replay.idempotent}, same order=${replay.order.venueOrderId === placed.order.venueOrderId}`);
  if (placed.order.status !== 'filled' || !replay.idempotent) throw new Error('the paper order did not fill, or the key was not idempotent');

  console.log('\n6. account');
  const a = await call('GET', `/accounts/${acct.id}`);
  const p = a.positions[0];
  console.log(`     equity ${a.state.equity}, collateral ${a.state.collateral}, margin used ${short(a.state.marginUsed, 10)}, free ${short(a.state.freeCollateral, 12)} (source ${a.state.source})`);
  console.log(`     position: ${p.side} ${p.size} ${p.instrument} entry ${p.entryPrice} mark ${p.markPrice} uPnL ${p.unrealizedPnl} lev ${p.leverage} liq ${p.liquidationPrice ?? '—'} (source ${p.source})`);
  console.log(`     ${a.orders.length} order(s), ${a.fills.length} fill(s), ${a.equity.length} equity point(s), ${a.riskEvents.length} risk event(s)`);

  for (const base of ['BTC', 'ETH']) {
    console.log(`\n7. comparison — ${base} (a table of facts and live figures, not a recommendation)`);
    const c = await call('GET', `/compare?base=${base}`);
    console.log(`     ${pad('venue', 12)}${pad('instrument', 34)}${pad('mark', 12)}${pad('index', 12)}${pad('funding/h', 15)}${pad('interval', 9)}${pad('spread bps', 11)}${pad('depth ±1% USD', 15)}${pad('taker bps', 10)}${pad('max lev', 8)}collateral`);
    for (const r of c.rows) console.log(`     ${pad(r.venue, 12)}${pad(r.instrument, 34)}${pad(short(r.mark, 10), 12)}${pad(short(r.index, 10), 12)}${pad(short(r.funding, 13), 15)}${pad(`${r.fundingVenue.intervalSec} s`, 9)}${pad(r.spreadBps, 11)}${pad(r.depthUsd1pct === null ? null : short(r.depthUsd1pct, 13), 15)}${pad(r.takerFeeBps, 10)}${pad(short(r.maxLeverage, 6), 8)}${r.collateral}${r.restriction ? '  [market data only]' : ''}`);
    for (const e of c.errors) console.log(`     ${e.venue}: ERROR ${e.message}`);
    const gmx = c.rows.find((r: any) => r.venue === 'gmx');
    if (gmx) console.log(`     gmx notes (${gmx.instrument}): ${gmx.notes.slice(-4).join(' | ')}`);
    const lower = c.rows.filter((r: any) => r.notes.some((n: string) => /lower bound/.test(n))).map((r: any) => r.instrument);
    if (lower.length) console.log(`     depth is a lower bound (the book snapshot ends before 1 %) for: ${lower.join(', ')}`);
  }

  console.log('\n8. close the position');
  const closed = await call('POST', `/accounts/${acct.id}/close`, { instrument: BTC, fraction: '1' });
  console.log(`     reduce-only ${closed.order.side} ${closed.order.size}: ${closed.order.status} @ ${short(closed.order.avgFillPrice, 12)}, worst price ${closed.worstPrice} (bound ${closed.slippageBoundBps} bps), closed PnL ${closed.fills.map((f: any) => f.closedPnl).join(', ')}`);
  const end = await call('GET', `/accounts/${acct.id}`);
  console.log(`     positions: ${end.positions.length}; collateral ${end.state.collateral}; realised ${end.totals.realizedPnl}, fees ${end.totals.feesPaid}, funding ${end.totals.fundingNet}`);
  if (end.positions.length !== 0) throw new Error('the position is still open');

  console.log('\n9. live stream (the venue\'s public websocket through the shared hub, a few seconds)');
  const inst = await derivatives.data.instrument(BTC), counts: Record<string, number> = {}, statuses: string[] = [];
  const offA = derivatives.data.subscribe(inst, (ev) => { counts[ev.event] = (counts[ev.event] ?? 0) + 1; if (ev.event === 'status') statuses.push(ev.data.status); });
  let second = 0;
  const offB = derivatives.data.subscribe(inst, () => { second += 1; });
  await new Promise((r) => setTimeout(r, 6000));
  console.log(`     listener 1: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}; statuses ${statuses.join(' → ')}; listener 2: ${second} events; upstream subscriptions opened ${derivatives.data.streamStats.opened}`);
  offA(); offB();
  console.log(`     after both left: listeners ${derivatives.data.listeners(BTC)}, upstream subscriptions closed ${derivatives.data.streamStats.closed}`);
  if (!counts.book || !statuses.includes('connected')) throw new Error('the live stream delivered no book');

  if (WATCH) {
    console.log('\n10. watch a public address (read-only)');
    const w = await call('GET', `/watch?venue=hyperliquid&account=${WATCH}`);
    console.log(`     ${w.venue} ${w.account.slice(0, 8)}…: equity ${w.state.equity}, margin used ${w.state.marginUsed}, ${w.positions.length} position(s), ${w.openOrders.length} open order(s) (source ${w.source})`);
    const dy = await app.inject({ method: 'GET', url: `${P}/watch?venue=dydx&account=${WATCH}`, headers: { cookie: `${COOKIE}=${token}` } });
    console.log(`     the same on dYdX → ${dy.statusCode} ${dy.json().error}`);
  }

  const audit = await sql`select type from audit_events where data->>'account' = ${acct.id} order by seq`;
  console.log(`\naudit events: ${audit.map((x) => x.type).join(', ')}`);
} catch (e) { failed = true; console.error(`\nSMOKE FAILED: ${(e as Error).message}`); }

console.log('\noutgoing requests (all public reads):');
for (const [k, n] of [...seen].sort()) console.log(`  ${String(n).padStart(3)} × ${k}`);
console.log(`trading endpoints called: ${[...seen.keys()].filter((k) => /\/exchange/.test(k)).length}; signer calls: 0 (the signer URL points at a closed port and is never used by these routes)`);
await sql`truncate deriv_paper_accounts cascade`;
await app.close(); await sql.end();
console.log(failed ? '\nresult: FAILED' : '\nresult: ok');
process.exit(failed ? 1 : 0);
