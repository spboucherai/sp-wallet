// INTEGRATION: the SDK against the REAL API and the REAL signer (bundles of scripts/build.mjs, own per-run database, owner set
// up with a software passkey, keys created through the owner routes) — see scripts/test-stack.mts. No mocked transport.
// Skipped — reported as skipped, not as passed — when PostgreSQL is not reachable or SPW_SDK_INTEGRATION=off.
// Market data comes from the venues' public endpoints: a test whose venue cannot be reached (503) is skipped with that reason.
// SPW_SDK_TRANSCRIPT=1 prints one line per call (the transcript pasted in docs/v11/work/sdks.md).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { AmbiguousCommand, AmbiguousSymbol, AuthenticationError, Conflict, ConfigurationError, constructWebhookEvent, errorFromResponse, ExecutionDisabled, FINAL_ORDER_STATES, IdempotencyConflict, MandateDenied, MandateRequired,
  newIdempotencyKey, NotFound, OPERATION_ERRORS, OPERATIONS, ORDER_STATES, RateLimited, responseMeta, RiskDenied, ScopeDenied, ServiceUnavailable, SPWallet, SPWalletError, ValidationError, verifyWebhook, type OperationId, type Order } from '../src/index.ts';
import { ROOT, startStack, type Stack } from './stack.ts';

// Every test talks to a real API in another process, which talks to PostgreSQL, the signer and the venues' public endpoints.
// With the whole suite on the same machine a call can wait seconds: the bound is explicit and generous — a guard against a
// hang, not a measure. No assertion depends on a duration (the waits below are polls that return as soon as the state is there).
vi.setConfig({ testTimeout: 240_000 });

const started = await startStack('ts');
const skip = 'skip' in started ? started.skip : null;
const stack = started as Stack;
if (skip) console.warn(`[trading-sdk] integration tests SKIPPED: ${skip}`);
afterAll(async () => { if (!skip) await stack.stop(); });

const say = (line: string): void => { if (process.env.SPW_SDK_TRANSCRIPT) console.log(`[sdk-ts] ${line}`); };
const client = (k: keyof Stack['keys'], o: ConstructorParameters<typeof SPWallet>[0] = {}): SPWallet => new SPWallet({ apiKey: stack.keys[k].secret, baseUrl: stack.baseUrl, maxRetries: 0, ...o });
const caught = async (p: Promise<unknown>): Promise<SPWalletError> => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as SPWalletError);
const meta = (r: object): string => { const m = responseMeta(r)!; return `HTTP ${m.status} request=${m.requestId?.slice(0, 8)}… ratelimit=${m.rateLimit.remaining}/${m.rateLimit.limit} reset=${m.rateLimit.resetSeconds}s`; };
/** a read that depends on a venue's public endpoint: unreachable venue = skipped test, anything else is asserted */
async function venue<R>(ctx: TestContext, run: () => Promise<R>): Promise<R> {
  try { return await run(); }
  catch (e) { if (e instanceof ServiceUnavailable) { say(`venue unreachable (${e.code}): test skipped`); ctx.skip(`venue unreachable: ${e.code}`); } throw e; }
}
const DEC = /^\d+(\.\d+)?$/;
const ORDER = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.001' } as const;
const UUID = '00000000-0000-4000-8000-000000000000';
/** every error this file receives from the server is one the document declares for the operation (`x-spw-errors`) */
function declared(op: OperationId, e: SPWalletError): SPWalletError {
  expect(OPERATION_ERRORS[op].some(([status, code]) => status === e.status && code === e.code), `${op} answered ${e.status} ${e.code}: not in x-spw-errors`).toBe(true);
  return e;
}
/** an owner action through the stack's control endpoint (a key can never do these) */
async function ownerAction(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<void> {
  const r = await fetch(stack.control + path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  if (!r.ok) throw new Error(`control ${method} ${path} → ${r.status} ${await r.text()}`);
}
const short = (id: string): string => `${id.slice(0, 12)}…`;
const line = (o: Order): string => `status=${o.status} final=${o.final} engineStatus=${o.engineStatus} size=${o.size} filled=${o.filled} avg=${o.avgFillPrice}`;

describe.skipIf(skip !== null)('integration: reads against the real route handlers', () => {
  it('openapi(): the served document is the committed contract the SDK was generated from', async () => {
    const d = await client('reader').openapi();
    expect(d).toEqual(JSON.parse(readFileSync(path.join(ROOT, 'docs/openapi/trading-v1.json'), 'utf8')));
    say(`openapi() → ${meta(d)} openapi=${d.openapi} paths=${Object.keys(d.paths as object).length}`);
  });
  it('listMarkets / getMarket / getOrderbook / getCandles (public venue data)', async (ctx) => {
    const c = client('reader');
    const l = await venue(ctx, () => c.listMarkets({ venue: 'hyperliquid', q: 'BTC', limit: 3 }));
    expect(l.markets.length).toBeGreaterThan(0);
    expect(l.markets.length).toBeLessThanOrEqual(3);
    const btc = l.markets.find((m) => m.id === 'hyperliquid:BTC')!;
    expect(btc).toMatchObject({ venue: 'hyperliquid', kind: 'perpetual', symbol: 'BTC' });
    expect(btc.mark).toMatch(/^\d+(\.\d+)?$/); // a decimal STRING
    expect(typeof l.total).toBe('number'); expect(typeof l.truncated).toBe('boolean'); expect(Array.isArray(l.errors)).toBe(true);
    say(`listMarkets({venue:'hyperliquid',q:'BTC',limit:3}) → ${meta(l)} total=${l.total} truncated=${l.truncated} first=${btc.id} mark="${btc.mark}" stale=${btc.stale}`);
    const all = await venue(ctx, () => c.listMarkets({ limit: 2 }));
    expect(all.truncated).toBe(true); expect(all.total).toBeGreaterThan(2);
    say(`listMarkets({limit:2}) → total=${all.total} truncated=${all.truncated} errors=${JSON.stringify(all.errors.map((e) => e.source))}`);

    const m = await venue(ctx, () => c.getMarket('hyperliquid:BTC'));
    expect(m.market.id).toBe('hyperliquid:BTC'); expect(typeof m.ts).toBe('number'); expect(m.source).toBe('venue');
    say(`getMarket('hyperliquid:BTC') → ${meta(m)} mark="${m.market.mark}" lotSize="${String((m.instrument as { lotSize?: string } | null)?.lotSize)}"`);
    const b = await venue(ctx, () => c.getOrderbook('hyperliquid:BTC', { depth: 2 }));
    expect(b.bids.length).toBeLessThanOrEqual(2);
    for (const lvl of [...b.bids, ...b.asks]) { expect(lvl).toHaveLength(2); expect(lvl[0]).toMatch(/^\d+(\.\d+)?$/); expect(lvl[1]).toMatch(/^\d+(\.\d+)?$/); }
    say(`getOrderbook('hyperliquid:BTC',{depth:2}) → ${meta(b)} bids=${JSON.stringify(b.bids)} asks=${JSON.stringify(b.asks)}`);
    const k = await venue(ctx, () => c.getCandles('hyperliquid:BTC', { interval: '1h', limit: 2 }));
    expect(k.interval).toBe('1h'); expect(k.candles.length).toBeLessThanOrEqual(2);
    for (const x of k.candles) for (const f of ['open', 'high', 'low', 'close', 'volume'] as const) expect(x[f]).toMatch(/^\d+(\.\d+)?$/);
    say(`getCandles('hyperliquid:BTC',{interval:'1h',limit:2}) → ${meta(k)} ${JSON.stringify(k.candles.at(-1))}`);
  });
  it('a bare symbol on several venues: AmbiguousSymbol with the candidates; unknown market and order: NotFound; a bad parameter: ValidationError', async (ctx) => {
    const c = client('reader');
    const e = await venue(ctx, () => caught(c.getMarket('BTC'))) as AmbiguousSymbol;
    if (e instanceof ServiceUnavailable) ctx.skip('venue unreachable');
    expect(e).toBeInstanceOf(AmbiguousSymbol);
    expect(e.candidates).toEqual(expect.arrayContaining(['hyperliquid:BTC']));
    expect(e).toMatchObject({ status: 409, code: 'ambiguous_symbol' }); expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/);
    say(`getMarket('BTC') → AmbiguousSymbol HTTP 409 candidates=${JSON.stringify(e.candidates.slice(0, 4))}…`);
    // an id with ':' '/' ' ' '[' ']' goes through the real router as ONE path segment, and a venue without a book answers 422
    const gmx = e.candidates.find((x) => x.startsWith('gmx:'));
    if (gmx) {
      const g = await c.getMarket(gmx);
      expect(g.market.id).toBe(gmx);
      const nb = await caught(c.getOrderbook(gmx));
      expect(nb).toBeInstanceOf(ValidationError); expect(nb).toMatchObject({ status: 422, code: 'no_orderbook' });
      say(`getMarket('${gmx}') → ${meta(g)} id=${g.market.id}; getOrderbook('${gmx}') → ${nb.name} HTTP ${nb.status} ${nb.code}`);
    }
    const spot = await caught(c.getOrderbook('spot:BTC'));
    expect(spot).toBeInstanceOf(ValidationError); expect(spot).toMatchObject({ status: 422, code: 'no_orderbook' });
    const nf = await caught(c.getMarket('nowhere:XYZ'));
    expect(nf).toBeInstanceOf(NotFound); say(`getMarket('nowhere:XYZ') → ${nf.name} ${nf.status} ${nf.code}`);
    const nv = await caught(c.listMarkets({ venue: 'nowhere' }));
    expect(nv).toBeInstanceOf(NotFound); expect(nv.code).toBe('unknown_venue'); say(`listMarkets({venue:'nowhere'}) → ${nv.name} ${nv.status} ${nv.code}`);
    const no = await caught(c.getOrder(`deriv:${UUID}:nope`));
    expect(no).toBeInstanceOf(NotFound); expect(no.code).toBe('unknown_order'); say(`getOrder('deriv:…:nope') → ${no.name} ${no.status} ${no.code}`);
    const route = await caught(c.waitForOrder('not-an-order-id', { waitTimeoutMs: 10 }));
    expect(route).toBeInstanceOf(NotFound); expect(route.code).toBe('unknown_order');
    for (const [op, e] of [['getOrderbook', spot], ['getMarket', nf], ['listMarkets', nv], ['getOrder', no]] as const) declared(op, e);
    // a path that is not an operation: the API's own error model, with a stable code (the SDK has no method for it: raw request)
    for (const [method, path] of [['GET', '/nope'], ['PUT', '/orders'], ['POST', '/markets/x/y/z']] as const) {
      const r = await fetch(`${stack.baseUrl}/api/v1/trading${path}`, { method, headers: { authorization: `Bearer ${stack.keys.reader.secret}` } });
      const body = await r.json() as { error: string; message: string };
      expect([r.status, body.error, typeof body.message], `${method} ${path}`).toEqual([404, 'not_found', 'string']);
      expect(errorFromResponse(r.status, body)).toBeInstanceOf(NotFound); expect(errorFromResponse(r.status, body).code).toBe('not_found');
    }
    say(`GET /api/v1/trading/nope (not an operation) → HTTP 404 not_found`);
    const bad = await caught(c.listMarkets({ limit: 0 }));
    expect(bad).toBeInstanceOf(ValidationError); expect(bad.code).toBe('bad_request'); say(`listMarkets({limit:0}) → ${bad.name} ${bad.status} ${bad.code}`);
  });
  it('getPortfolio / getBalances / getPositions / listOrders / getActivity / getRisk / listStrategies / listAgents', async () => {
    const c = client('reader', { timeoutMs: 60_000 });
    const p = await c.getPortfolio();
    expect(p).toMatchObject({ halted: false }); expect(typeof p.totals.note).toBe('string');
    // money is a decimal STRING (or null when the price feed gives nothing): never a JSON number
    for (const x of [p.totals.walletUsd, p.wallet.valueUsd, p.totals.liveVenueEquity, p.totals.paperEquity, ...p.wallet.balances.map((y) => y.valueUsd)]) expect(x === null || (typeof x === 'string' && DEC.test(x)), String(x)).toBe(true);
    expect(p.totals.paperEquity).toMatch(DEC); expect(p.accounts.some((a) => a.mode === 'paper' && a.accountId === stack.paper.accountId)).toBe(true);
    expect(Array.isArray(p.wallet.balances)).toBe(true); expect(Array.isArray(p.accounts)).toBe(true);
    say(`getPortfolio() → ${meta(p)} totals=${JSON.stringify(p.totals)} balances=${p.wallet.balances.length} accounts=${p.accounts.length} halted=${p.halted}`);
    const b = await c.getBalances({ network: 'ethereum' });
    expect(b.balances.length).toBeGreaterThan(0);
    for (const x of b.balances) { expect(x.network).toBe('ethereum'); if (x.amount !== null) expect(x.amount).toMatch(/^\d+$/); }
    say(`getBalances({network:'ethereum'}) → ${meta(b)} ${b.balances.length} assets, first=${JSON.stringify({ symbol: b.balances[0]!.symbol, amount: b.balances[0]!.amount, display: b.balances[0]!.display })}`);
    const pos = await c.getPositions({ mode: 'paper' });
    expect(pos.positions).toEqual([]); say(`getPositions({mode:'paper'}) → ${meta(pos)} positions=${pos.positions.length} errors=${pos.errors.length}`);
    const o = await c.listOrders({ open: true, limit: 5 });
    expect(o.orders).toEqual([]); expect(o.nextCursor).toBeNull(); say(`listOrders({open:true,limit:5}) → ${meta(o)} orders=${o.orders.length} nextCursor=${o.nextCursor}`);
    const a = await c.getActivity({ limit: 5 });
    expect(a.items).toEqual([]); expect(a.nextCursor).toBeNull(); say(`getActivity({limit:5}) → ${meta(a)} items=${a.items.length} nextCursor=${a.nextCursor}`);
    const r = await c.getRisk();
    expect(r.killSwitch).toMatchObject({ signerReachable: true, signerHalted: false }); expect(r.capabilityLocks.length).toBeGreaterThan(0);
    expect(r.engine).toMatchObject({ killSwitch: { on: false }, readOnly: { on: false } });
    say(`getRisk() → ${meta(r)} signerReachable=${r.killSwitch.signerReachable} signerHalted=${r.killSwitch.signerHalted} capabilityLocks=${r.capabilityLocks.length}`);
    const s = await c.listStrategies({ kind: 'perp' });
    expect(s.versions).toEqual([]); say(`listStrategies({kind:'perp'}) → ${meta(s)} library=${s.library.length} versions=${s.versions.length}`);
    const g = await c.listAgents();
    expect(g.agents).toEqual([]); say(`listAgents() → ${meta(g)} agents=${g.agents.length}`);
  });
  it('compareMarkets and the private markets (display only: none is tradable)', async (ctx) => {
    const c = client('reader', { timeoutMs: 60_000 });
    const cmp = await venue(ctx, () => c.compareMarkets({ underlying: 'BTC', side: 'long', notional: '1000' }));
    expect(cmp.underlying).toBe('BTC'); expect(cmp.rows.length).toBeGreaterThan(0); expect(cmp.rows.some((r) => r.venue === 'hyperliquid')).toBe(true); expect(typeof cmp.texts.disclaimer).toBe('string');
    say(`compareMarkets({underlying:'BTC',side:'long',notional:'1000'}) → ${meta(cmp)} rows=${cmp.rows.map((r) => `${r.venue}${r.tradable ? '' : '(not tradable)'}`).join(',')} discrepancies=${cmp.discrepancies.length}`);
    declared('compareMarkets', await caught(c.compareMarkets({ underlying: 'ZZZZZ', side: 'long', notional: '1000' })));
    const pm = await venue(ctx, () => c.listPrivateMarkets());
    expect(pm.notice.tradable).toBe(false); expect(Array.isArray(pm.markets)).toBe(true);
    for (const m of pm.markets) expect(m.tradable).toBe(false);
    say(`listPrivateMarkets() → ${meta(pm)} markets=${pm.markets.length} companies=${pm.companies.length} venues=${pm.venues.map((v) => `${v.venue}:${v.status}`).join(',')} notice=${pm.notice.code}`);
    const first = pm.markets.find((m) => m.error === null);
    if (first) {
      const one = await venue(ctx, () => c.getPrivateMarket(first.id, { interval: '1d', limit: 5 }));
      expect(one.market.id).toBe(first.id); expect(one.market.tradable).toBe(false);
      say(`getPrivateMarket('${first.id}') → ${meta(one)} status=${one.market.status} review=${one.market.review.state} price=${JSON.stringify(one.market.market.price.value)}`);
    }
    const company = pm.companies[0];
    if (company) {
      const co = await venue(ctx, () => c.getPrivateMarketCompany(company.slug));
      expect(co.company.slug).toBe(company.slug); expect(co.merged).toBeNull();
      say(`getPrivateMarketCompany('${company.slug}') → ${meta(co)} contracts=${co.contracts.length} merged=${co.merged}`);
    }
    const unknown = declared('getPrivateMarketCompany', await caught(c.getPrivateMarketCompany('no-such-company')));
    expect(unknown).toBeInstanceOf(NotFound); expect(unknown.code).toBe('unknown_company');
  }, 300_000);
  it('every read operation of the document is exercised in this file', () => {
    const reads = (Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].method === 'GET');
    expect(reads.sort()).toEqual(['compareMarkets', 'getActivity', 'getAgent', 'getAgentPerformance', 'getBalances', 'getCandles', 'getJob', 'getMarket', 'getOpenApi', 'getOrder', 'getOrderbook', 'getPortfolio', 'getPrivateMarket',
      'getPrivateMarketCompany', 'getRisk', 'listAgentJournal', 'listAgentOrders', 'listAgentSignals', 'listAgentTemplates', 'listAgents', 'listMarkets', 'listOrders', 'listPositions', 'listPrivateMarkets', 'listStrategies']);
  });
  it('rate-limit headers are exposed on every answer', async () => {
    const c = client('reader');
    const a = responseMeta(await c.listAgents())!, b = responseMeta(await c.listAgents())!;
    expect(a.rateLimit.limit).toBe(600); expect(b.rateLimit.remaining).toBe(a.rateLimit.remaining! - 1);
    expect(a.rateLimit.resetSeconds).toBeGreaterThan(0); expect(a.rateLimit.resetSeconds).toBeLessThanOrEqual(60);
    expect(a.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(a.requestId).not.toBe(b.requestId);
  });
});

describe.skipIf(skip !== null)('integration: the PAPER write path, end to end, against the real server', () => {
  const I = (): string => stack.paper.instrument, acct = (): string => stack.paper.accountId;
  /** a limit price ~1 % under the mark: inside the paper engine's price band, under the best ask — it rests. An integer: on every
   *  tick, and within Hyperliquid's five significant figures */
  async function restingPrice(c: SPWallet): Promise<string> {
    return String(Math.floor(Number((await c.getMarket(I())).market.mark) * 0.99));
  }
  const flat = async (c: SPWallet): Promise<void> => { for (const p of (await c.getPositions({ mode: 'paper' })).positions) await c.closePosition(p.id); };

  it('preview → create → wait until FILLED → positions → reduce → close → a resting limit → cancel; replay and conflict; pagination', async (ctx) => {
    const c = client('trader', { timeoutMs: 60_000 });
    const order = { mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '200' } as const;
    const market = await venue(ctx, () => c.getMarket(I()));
    const inst = market.instrument!;
    for (const f of ['lotSize', 'tickSize', 'maxLeverage'] as const) expect(inst[f], f).toMatch(DEC);
    say(`getMarket('${I()}') → mark=${market.market.mark} instrument: lotSize=${inst.lotSize} tickSize=${inst.tickSize} minOrderSize=${inst.minOrderSize} minNotional=${inst.minNotional} maxLeverage=${inst.maxLeverage} status=${inst.status}`);

    // --- preview: nothing is created; the SERVER turned the notional into a size
    const pv = await venue(ctx, () => c.previewOrder(order));
    expect(pv).toMatchObject({ wouldExecute: true, refusals: [], approval: { required: false, by: 'mandate' }, mandate: { id: stack.keys.trader.mandateId, decision: 'allow' }, risk: { decision: 'allow' }, engine: { name: 'paper' }, account: { id: acct(), withheld: false } });
    expect(pv.order).toMatchObject({ v: 1, instrument: I(), side: 'buy', type: 'market', mode: 'paper', notional: null, principal: { kind: 'api_key', id: stack.keys.trader.id } });
    expect(pv.order.size).toMatch(DEC); expect(pv.resolved!.size).toBe(pv.order.size); expect(pv.account.equity).toMatch(DEC); expect(pv.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(pv.order.size) * Number(market.market.mark)).toBeGreaterThan(190); expect(Number(pv.order.size) * Number(market.market.mark)).toBeLessThan(210);
    expect(responseMeta(pv)!.idempotencyKey).toBeNull();
    expect((await c.listOrders()).orders).toEqual([]);
    say(`previewOrder({mode:'paper',instrument,side:'buy',type:'market',notional:'200'}) → ${meta(pv)} wouldExecute=${pv.wouldExecute} size=${pv.order.size} (sized by the server) approval=${pv.approval.by} mandate=${pv.mandate!.decision} risk=${pv.risk.decision} (${pv.risk.checks.length} checks) equity=${pv.account.equity}`);

    // --- create, with one Idempotency-Key for the logical order
    const idempotencyKey = newIdempotencyKey();
    const placed = await c.createOrder(order, { idempotencyKey });
    const id = placed.order.id;
    expect(placed).toMatchObject({ idempotent: false, approval: null, order: { mode: 'paper', venue: 'hyperliquid', instrument: I(), side: 'buy', type: 'market', accountId: acct(), mandateId: stack.keys.trader.mandateId } });
    expect(ORDER_STATES).toContain(placed.order.status); expect(responseMeta(placed)).toMatchObject({ status: 200, idempotencyKey, idempotentReplay: false });
    say(`createOrder(…, {idempotencyKey:'${short(idempotencyKey)}'}) → ${meta(placed)} order=${short(id)} ${line(placed.order)}`);
    const done = await c.waitForOrder(id, { waitTimeoutMs: 90_000, pollIntervalMs: 250 });
    expect(done.order).toMatchObject({ id, status: 'FILLED', final: true, engineStatus: 'filled' }); expect(done.order.filled).toBe(done.order.size); expect(done.order.avgFillPrice).toMatch(DEC);
    expect(done.fills.length).toBeGreaterThan(0); for (const f of done.fills) { expect(f.price).toMatch(DEC); expect(f.size).toMatch(DEC); }
    say(`waitForOrder('${short(id)}') → ${line(done.order)} fills=${done.fills.length} history=${(done.history ?? []).length} transitions`);

    // --- the same key and the same order: the SAME order, nothing sent again; the same key and another order: a conflict
    const replay = await c.createOrder(order, { idempotencyKey });
    expect(replay.order.id).toBe(id); expect(responseMeta(replay)!.idempotentReplay).toBe(true);
    expect((await c.listOrders({ limit: 50 })).orders.filter((o) => !o.reduceOnly)).toHaveLength(1);
    say(`createOrder(same order, same key) → ${meta(replay)} same order=${replay.order.id === id} Idempotent-Replay=${responseMeta(replay)!.idempotentReplay}`);
    const conflict = declared('placeOrder', await caught(c.createOrder({ ...order, notional: '210' }, { idempotencyKey })));
    expect(conflict).toBeInstanceOf(IdempotencyConflict); expect(conflict).toMatchObject({ status: 409, code: 'idempotency_conflict', idempotencyKey });
    say(`createOrder(ANOTHER order, same key) → ${conflict.name} HTTP ${conflict.status} ${conflict.code}`);
    // the order's own idempotency key (clientOrderId) with another body, under a fresh header key: refused by the order service too
    const cid = `sdk-ts-${Date.now()}`;
    const first = await c.createOrder({ ...order, notional: '150', clientOrderId: cid });
    const sameCid = await c.createOrder({ ...order, notional: '150', clientOrderId: cid });
    expect(sameCid.order.id).toBe(first.order.id); expect(responseMeta(sameCid)!.idempotentReplay).toBe(true);        // the stored answer of that clientOrderId: no price is read again
    expect(declared('placeOrder', await caught(c.createOrder({ ...order, notional: '160', clientOrderId: cid })))).toBeInstanceOf(IdempotencyConflict);
    say(`createOrder(clientOrderId) twice → same order=${sameCid.order.id === first.order.id} Idempotent-Replay=${responseMeta(sameCid)!.idempotentReplay}; another body → IdempotencyConflict`);

    // --- the position, reduced by half, then closed
    const pos = (await c.getPositions({ mode: 'paper' })).positions.find((p) => p.instrument === I())!;
    expect(pos).toMatchObject({ mode: 'paper', venue: 'hyperliquid', accountId: acct(), side: 'long' }); expect(pos.size).toMatch(DEC); expect(pos.entryPrice).toMatch(DEC);
    say(`getPositions({mode:'paper'}) → ${pos.side} ${pos.size} @ ${pos.entryPrice} id=${pos.id.replace(acct(), '<account>')}`);
    const reduced = await c.reducePosition(pos.id, { fraction: '0.5' });
    expect(reduced.order).toMatchObject({ status: 'FILLED', final: true, reduceOnly: true, side: 'sell' });
    const after = (await c.getPositions({ mode: 'paper' })).positions.find((p) => p.instrument === I())!;
    expect(Number(after.size)).toBeLessThan(Number(pos.size));
    say(`reducePosition(id, {fraction:'0.5'}) → ${meta(reduced)} ${line(reduced.order)} reduceOnly=${reduced.order.reduceOnly}; position now ${after.size}`);
    const closed = await c.closePosition(pos.id);
    expect(closed.order).toMatchObject({ status: 'FILLED', final: true, reduceOnly: true, side: 'sell' });
    expect((await c.getPositions({ mode: 'paper' })).positions.filter((p) => p.instrument === I())).toEqual([]);
    say(`closePosition(id) → ${meta(closed)} ${line(closed.order)}; positions on ${I()}: 0`);
    const none = declared('closePosition', await caught(c.closePosition(pos.id)));
    expect(none).toBeInstanceOf(ValidationError); expect(none.code).toBe('no_position');

    // --- a resting limit order, then its cancel
    const price = await restingPrice(c);
    const resting = await c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'limit', price, notional: '200', tif: 'gtc' });
    expect(resting.order).toMatchObject({ status: 'SUBMITTED', final: false, engineStatus: 'open', price });
    say(`createOrder({type:'limit',price:'${price}',notional:'200'}) → ${meta(resting)} order=${short(resting.order.id)} ${line(resting.order)}`);
    const waiting = await caught(c.waitForOrder(resting.order.id, { waitTimeoutMs: 300, pollIntervalMs: 100 }));
    expect(waiting.code).toBe('wait_timeout'); expect(waiting.message).toMatch(/not failed/);
    const open = await c.listOrders({ open: true });
    expect(open.orders.map((o) => o.id)).toEqual([resting.order.id]);
    const cancelled = await c.cancelOrder(resting.order.id);
    expect(cancelled).toMatchObject({ changed: true, order: { id: resting.order.id, status: 'CANCELLED', final: true } });
    expect((await c.waitForOrder(resting.order.id)).order.status).toBe('CANCELLED');
    expect(await c.cancelOrder(resting.order.id)).toMatchObject({ changed: false, sent: false });
    say(`cancelOrder('${short(resting.order.id)}') → ${meta(cancelled)} status=${cancelled.order.status} changed=${cancelled.changed}; again → changed=false`);

    // --- pagination: the iterators give the unpaged list, once each
    const all = await c.listOrders({ limit: 500 });
    expect(all.nextCursor).toBeNull(); expect(all.orders.length).toBeGreaterThanOrEqual(5);
    for (const o of all.orders) { expect(ORDER_STATES).toContain(o.status); expect(o.final).toBe((FINAL_ORDER_STATES as readonly string[]).includes(o.status)); }
    const paged: string[] = [];
    for await (const o of c.iterateOrders({ limit: 2 })) paged.push(o.id);
    expect(paged).toEqual(all.orders.map((o) => o.id)); expect(new Set(paged).size).toBe(paged.length);
    const firstPage = await c.listOrders({ limit: 2 });
    expect(firstPage.orders).toHaveLength(2); expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const three: string[] = []; for await (const o of c.iterateOrders({ limit: 2 }, { maxItems: 3 })) three.push(o.id);
    expect(three).toEqual(paged.slice(0, 3));
    const acts = await c.getActivity({ limit: 500 }), items: string[] = [];
    for await (const a of c.iterateActivity({ limit: 2 })) items.push(String(a.id));
    expect(items).toEqual(acts.items.map((a) => String(a.id))); expect(items.length).toBeGreaterThanOrEqual(4); expect(acts.items.every((a) => a.kind === 'fill' && a.mode === 'paper')).toBe(true);
    expect(declared('listOrders', await caught(c.listOrders({ cursor: 'AAAA' }))).code).toBe('invalid_cursor');
    say(`listOrders({limit:2}) → ${firstPage.orders.length} orders, nextCursor=${firstPage.nextCursor!.slice(0, 16)}…; iterateOrders({limit:2}) → ${paged.length} orders in ${Math.ceil(paged.length / 2)} pages = listOrders({limit:500}); iterateActivity({limit:2}) → ${items.length} fills`);
  }, 300_000);

  it('refusals: a live order with the execution lock off → ExecutionDisabled; out of the mandate → MandateDenied with the reasons and the REJECTED order', async (ctx) => {
    const c = client('trader', { timeoutMs: 60_000 });
    const before = (await c.listOrders({ limit: 500 })).orders.length;
    const live = await venue(ctx, () => caught(c.createOrder({ mode: 'live', accountId: stack.live.accountId, instrument: I(), side: 'buy', type: 'market', size: '0.001' })));
    if (live instanceof ServiceUnavailable) ctx.skip(`venue unreachable: ${live.code}`);
    declared('placeOrder', live);
    expect(live).toBeInstanceOf(ExecutionDisabled); expect(live).toMatchObject({ status: 403, code: 'execution_disabled' }); expect(live.order).toBeNull();
    expect((await c.listOrders({ limit: 500 })).orders).toHaveLength(before);                              // nothing was created
    say(`createOrder({mode:'live',…}) with SPW_TRADING_API_EXECUTION off → ${live.name} HTTP ${live.status} ${live.code}; order created: ${live.order !== null}`);
    const lp = await c.previewOrder({ mode: 'live', accountId: stack.live.accountId, instrument: I(), side: 'buy', type: 'market', size: '0.001' });
    expect(lp.wouldExecute).toBe(false); expect(lp.refusals.find((r) => r.code === 'execution_disabled')).toMatchObject({ stage: 'lock' });

    const denied = declared('placeOrder', await caught(c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '800' }))) as MandateDenied;
    expect(denied).toBeInstanceOf(MandateDenied); expect(denied).toMatchObject({ status: 403, code: 'mandate_denied' });
    expect(denied.reasons).toContain('ORDER_NOTIONAL_EXCEEDED'); expect(denied.order).toMatchObject({ status: 'REJECTED', final: true, rejectCode: 'mandate_denied' });
    expect((await c.getOrder(denied.order!.id)).order.status).toBe('REJECTED');
    say(`createOrder({notional:'800'}) under a mandate of ${stack.paper.maxOrderNotionalUsd} USD an order → ${denied.name} HTTP ${denied.status} reasons=${JSON.stringify(denied.reasons)} error.order.status=${denied.order!.status}`);
    const eth = declared('placeOrder', await caught(c.createOrder({ mode: 'paper', accountId: acct(), instrument: 'hyperliquid:ETH', side: 'buy', type: 'market', notional: '100' }))) as MandateDenied;
    expect(eth).toBeInstanceOf(MandateDenied); expect(eth.reasons).toContain('INSTRUMENT_NOT_ALLOWED');
    // another key's order is not this key's to cancel
    const mine = await c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'limit', price: await restingPrice(c), notional: '100' });
    const theirs = declared('cancelOrder', await caught(client('trader2').cancelOrder(mine.order.id)));
    expect(theirs).toMatchObject({ status: 403, code: 'not_your_order' });
    expect((await c.cancelOrder(mine.order.id)).order.status).toBe('CANCELLED');
  }, 300_000);

  it('the kill switch: new risk → RiskDenied; a cancel and a close still pass; only the owner releases it', async (ctx) => {
    const c = client('trader', { timeoutMs: 60_000 });
    const entry = await venue(ctx, () => c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '150' }));
    expect(entry.order.status).toBe('FILLED');
    const resting = await c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'limit', price: await restingPrice(c), notional: '100' });
    expect(resting.order.status).toBe('SUBMITTED');
    try {
      const ks = await client('trader2').engageKillSwitch('sdk-ts integration test');
      expect(ks.killSwitch).toMatchObject({ on: true, reason: 'sdk-ts integration test', by: { kind: 'api_key', id: stack.keys.trader2.id } });
      expect((await c.getRisk()).engine.killSwitch.on).toBe(true);
      say(`engageKillSwitch('sdk-ts integration test') → ${meta(ks)} killSwitch.on=${ks.killSwitch.on} by=${ks.killSwitch.by!.kind}`);
      const blocked = declared('placeOrder', await caught(c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '100' }))) as RiskDenied;
      expect(blocked).toBeInstanceOf(RiskDenied); expect(blocked).toMatchObject({ status: 423, code: 'kill_switch_active', killSwitch: true });
      expect(blocked.failed).toContain('kill_switch'); expect(blocked.checks.find((x) => x.id === 'kill_switch')).toMatchObject({ ok: false }); expect(blocked.order).toMatchObject({ status: 'REJECTED', final: true });
      say(`createOrder(new risk) → ${blocked.name} HTTP ${blocked.status} ${blocked.code} failed=${JSON.stringify(blocked.failed)} error.order.status=${blocked.order!.status}`);
      const pvw = await c.previewOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '100' });
      expect(pvw.wouldExecute).toBe(false); expect(pvw.refusals.some((r) => r.code === 'kill_switch_active')).toBe(true);
      // what only removes risk still passes
      const cancelled = await c.cancelOrder(resting.order.id);
      expect(cancelled.order.status).toBe('CANCELLED');
      const pos = (await c.getPositions({ mode: 'paper' })).positions.find((p) => p.instrument === I())!;
      const closed = await c.closePosition(pos.id);
      expect(closed.order).toMatchObject({ status: 'FILLED', reduceOnly: true });
      say(`with the kill switch on: cancelOrder → ${cancelled.order.status}; closePosition → ${closed.order.status} (reduce-only)`);
    } finally { await ownerAction('POST', '/kill-switch/release'); }
    expect((await c.getRisk()).engine.killSwitch.on).toBe(false);
    const again = await c.createOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '100' });
    expect(again.order.status).toBe('FILLED');
    await flat(c);
    say(`owner released the kill switch (passkey) → createOrder → ${again.order.status}`);
  }, 300_000);

  it('commands: an ambiguous command → AmbiguousCommand with the questions; a dry run places nothing; a query', async (ctx) => {
    const c = client('trader', { timeoutMs: 60_000 });
    await ownerAction('PUT', '/command-defaults', { defaults: {} });
    const amb = declared('runCommand', await venue(ctx, () => caught(c.runCommand('LONG BTC-PERP 100', { accountId: acct(), dryRun: true })))) as AmbiguousCommand;
    if (amb instanceof ServiceUnavailable) ctx.skip('venue unreachable');
    expect(amb).toBeInstanceOf(AmbiguousCommand); expect(amb).toMatchObject({ status: 409, code: 'ambiguous_command' }); expect(amb.questions.length).toBeGreaterThan(0);
    for (const q of amb.questions) { expect(typeof q.field).toBe('string'); expect(Array.isArray(q.options)).toBe(true); expect(q.message.length).toBeGreaterThan(0); }
    say(`runCommand('LONG BTC-PERP 100', {dryRun:true}) without owner defaults → ${amb.name} HTTP ${amb.status} questions=${JSON.stringify(amb.questions.map((q) => q.field))}`);
    await ownerAction('PUT', '/command-defaults', { defaults: { perpVenue: 'hyperliquid', perpNetworkByVenue: { hyperliquid: 'mainnet' }, perpLeverage: '2', perpMarginMode: 'cross', maxFeeBps: 10, maxSlippageBps: 50, orderTtlMs: 60_000 } });
    const before = (await c.listOrders({ limit: 500 })).orders.length;
    const dry = await c.runCommand('LONG BTC-PERP 100', { accountId: acct(), dryRun: true });
    expect(dry).toMatchObject({ kind: 'order', command: 'perp_open', mode: 'paper', dryRun: true, executed: false, order: { instrument: I(), side: 'buy' } }); expect(dry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await c.listOrders({ limit: 500 })).orders).toHaveLength(before);
    if (dry.kind !== 'order' || dry.executed) throw new Error('expected the dry run of an order');
    say(`runCommand('LONG BTC-PERP 100', {dryRun:true}) → ${meta(dry)} kind=${dry.kind} executed=${dry.executed} order=${JSON.stringify({ instrument: dry.order.instrument, side: dry.order.side, notional: dry.order.notional, size: dry.order.size })} (the canonical order); orders created: 0`);
    const show = await c.runCommand('SHOW POSITIONS', { accountId: acct() });
    if (show.kind !== 'query') throw new Error('expected a query');
    expect(show.query).toBe('positions'); expect(Array.isArray((show.data as { positions?: unknown[] }).positions)).toBe(true);
    const kill = await c.runCommand('KILL', { dryRun: true });
    expect(kill).toMatchObject({ kind: 'control', control: { type: 'kill_switch_on' }, executed: false });
    expect((await c.getRisk()).engine.killSwitch.on).toBe(false);
    const bad = declared('runCommand', await caught(c.runCommand('FROBNICATE THE MARKET')));
    expect(bad).toBeInstanceOf(ValidationError); expect(bad.code).toBe('parse_error');
    say(`runCommand('SHOW POSITIONS') → kind=${show.kind} query=${show.query}; runCommand('KILL', {dryRun:true}) → kind=${kill.kind} executed=${String((kill as { executed?: boolean }).executed)}; runCommand('FROBNICATE…') → ${bad.name} ${bad.code}`);
  }, 300_000);

  it('a preview answers the account\'s figures only to a key that may read the account', async (ctx) => {
    const p = await venue(ctx, () => client('prepare').previewOrder({ mode: 'paper', accountId: acct(), instrument: I(), side: 'buy', type: 'market', notional: '100' }));
    expect(p.account).toEqual({ id: acct(), venue: 'hyperliquid', network: p.account.network, withheld: true });
    expect('positionBefore' in p.risk.derived!).toBe(false); expect(p.wouldExecute).toBe(true); expect(p.risk.checks.some((x) => x.detail.startsWith('withheld'))).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/"(equity|freeCollateral|freeCollateralAfter|liquidationPrice)"/);
    say(`previewOrder with a key holding orders:prepare + markets:read only → account=${JSON.stringify({ ...p.account, id: '<account>' })} refusals=${JSON.stringify(p.refusals.map((r) => r.code))}`);
  });
});

describe.skipIf(skip !== null)('integration: agents on PAPER, against the real server', () => {
  it('templates → create from the stream template → start paper → signals / journal / orders / performance (one mode per call) → pause → backtest job → stop', async (ctx) => {
    const c = client('unbound', { timeoutMs: 60_000 });        // every scope and NO trading mandate: managing agents needs none (research and paper sign nothing)
    const t = await c.listAgentTemplates();
    const mm = t.templates.find((x) => x.id === 'market-making')!;
    expect(mm).toMatchObject({ engine: 'stream' }); expect(mm.modes).toContain('paper');
    say(`listAgentTemplates() → ${meta(t)} ${t.templates.map((x) => `${x.id}(${x.engine}: ${x.modes.join('/')})`).join(', ')}`);
    const created = await venue(ctx, () => c.createAgent({ template: 'market-making', name: `SDK MM ${Date.now() % 100000}`, venues: ['hyperliquid'], universe: ['BTC'], capitalUsdc: '1000' }));
    const id = created.agent.id;
    expect(created.agent).toMatchObject({ state: 'stopped', mode: 'research' });
    say(`createAgent({template:'market-making',venues:['hyperliquid'],universe:['BTC']}) → ${meta(created)} agent=${short(id)} state=${created.agent.state} mode=${created.agent.mode}`);
    const started = await c.startAgent(id, { mode: 'paper' });
    expect(started.agent).toMatchObject({ id, state: 'active', mode: 'paper' });
    say(`startAgent(id, {mode:'paper'}) → ${meta(started)} state=${started.agent.state} mode=${started.agent.mode}`);
    const one = await c.getAgent(id);
    expect(one.agent).toMatchObject({ id, family: mm.family, state: 'active', mode: 'paper' });
    expect((await c.listAgents()).agents.find((a) => a.id === id)).toMatchObject({ kind: 'stream', lifecycle: 'active', tradingMode: 'paper' });
    const signals = await c.listAgentSignals(id, { mode: 'paper', limit: 20 }), journal = await c.listAgentJournal(id, { mode: 'paper' }), orders = await c.listAgentOrders(id, { mode: 'paper', open: false }), perf = await c.getAgentPerformance(id, { mode: 'paper' });
    for (const r of [signals, journal, orders, perf]) expect(r.mode).toBe('paper');
    expect(journal.entries.length).toBeGreaterThan(0); expect(journal.entries.every((e) => e.mode === 'paper')).toBe(true);
    expect(Array.isArray(signals.signals) && Array.isArray(orders.orders)).toBe(true); expect(typeof perf.label).toBe('string');
    expect((await c.listAgentJournal(id, { mode: 'live' })).entries).toEqual([]);                           // another mode is another answer: nothing of paper in it
    say(`listAgentSignals/Journal/Orders(id, {mode:'paper'}), getAgentPerformance(id, {mode:'paper'}) → signals=${signals.signals.length} journal=${journal.entries.length} ("${journal.entries[0]!.title}") orders=${orders.orders.length} performance: "${perf.label}" points=${perf.points}`);
    // one mode per call: required by the SDK, and `all` is a 400 of the API
    expect(() => c.listAgentSignals(id, {} as never)).toThrow(ConfigurationError);
    const raw = await fetch(`${stack.baseUrl}/api/v1/trading/agents/${id}/signals?mode=all`, { headers: { authorization: `Bearer ${stack.keys.unbound.secret}` } });
    expect([raw.status, (await raw.json() as { error: string }).error]).toEqual([400, 'bad_request']);
    const paused = await c.pauseAgent(id, { reason: 'sdk test' });
    expect(paused.agent.state).toBe('paused');
    const bt = await c.backtestAgent(id, { hours: 1 });
    expect(bt.job).toMatchObject({ kind: 'backtest' }); expect(bt.label).toBe('backtest');
    const job = await c.getJob(bt.job.id);
    expect(job.job.id).toBe(bt.job.id); expect(['queued', 'running', 'done', 'failed', 'cancelled']).toContain(job.job.status);
    const waited = await c.waitForJob(bt.job.id, { waitTimeoutMs: 20_000, pollIntervalMs: 500 }).catch((e: SPWalletError) => e);
    say(`pauseAgent(id) → state=${paused.agent.state}; backtestAgent(id, {hours:1}) → job=${short(bt.job.id)} status=${bt.job.status}; getJob → ${job.job.status}; waitForJob(20 s) → ${waited instanceof SPWalletError ? `${waited.name} (not a failure: the job is still ${((waited as { last?: { job: { status: string } } }).last)?.job.status})` : waited.job.status}`);
    const stopped = await c.stopAgent(id, { reason: 'sdk test' });
    expect(stopped.agent.state).toBe('stopped');
    say(`stopAgent(id) → ${meta(stopped)} state=${stopped.agent.state}`);
    // the refusals: live without an owner-approved mandate for the agent; an unknown agent; a spot agent (the owner's app)
    const live = declared('startAgent', await caught(c.startAgent(id, { mode: 'live' })));
    expect(live).toBeInstanceOf(Conflict); expect(['mandate_required', 'live_unavailable']).toContain(live.code);
    const ghost = declared('getAgent', await caught(c.getAgent(UUID)));
    expect(ghost).toBeInstanceOf(NotFound); expect(ghost.code).toBe('not_found');
    expect(declared('getJob', await caught(c.getJob(UUID)))).toBeInstanceOf(NotFound);
    expect(declared('createAgent', await caught(c.createAgent({ kind: 'spot', name: 'spot via key', universe: ['BTC'] }))).code).toBe('owner_required');
    expect(declared('createStrategy', await caught(c.createStrategy({ kind: 'perp', path: 'momentum/v1' }))).code).toBe('bad_request');
    for (const run of [() => c.backtestStrategy(UUID), () => c.startStrategy(UUID, { mode: 'paper' }), () => c.stopStrategy(UUID)]) expect(await caught(run())).toBeInstanceOf(NotFound);
    say(`startAgent(id, {mode:'live'}) without an owner-approved mandate → ${live.name} HTTP ${live.status} ${live.code}; getAgent(unknown) → ${ghost.name} ${ghost.code}`);
  }, 300_000);
});

describe.skipIf(skip !== null)('integration: the write surface and the refusals', () => {
  it('a key WITHOUT a mandate: what would move risk on the wallet\'s accounts is refused → MandateRequired, a preview included; a cancel needs no mandate', async () => {
    const c = client('unbound');
    const gated: Record<string, (c: SPWallet) => Promise<unknown>> = { placeOrder: (x) => x.createOrder(ORDER), closePosition: (x) => x.closePosition('pos-1'), reducePosition: (x) => x.reducePosition('pos-1', { fraction: '0.5' }) };
    expect(Object.keys(gated).sort()).toEqual((Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].requiresMandate).sort());
    for (const [id, run] of Object.entries(gated)) {
      const e = declared(id as OperationId, await caught(run(c)));
      expect(e, id).toBeInstanceOf(MandateRequired); expect(e, id).toMatchObject({ status: 403, code: 'mandate_required' });
      say(`${id} (key without a mandate) → ${e.name} HTTP ${e.status} ${e.code}`);
    }
    const cmd = declared('runCommand', await caught(c.runCommand('LONG BTC-PERP 100', { accountId: stack.paper.accountId })));
    expect(cmd).toBeInstanceOf(MandateRequired);
    const nf = declared('cancelOrder', await caught(c.cancelOrder('no-such-order-0001')));
    expect(nf).toBeInstanceOf(NotFound); expect(nf.code).toBe('unknown_order');
    const pv = declared('previewOrder', await caught(c.previewOrder({ ...ORDER, accountId: stack.paper.accountId })));
    expect(pv).toBeInstanceOf(MandateRequired); expect(OPERATIONS.previewOrder.requiresMandate).toBe(false);          // the scope needs no mandate; the previewed order does
    say(`previewOrder (key without a mandate) → ${pv.name} HTTP ${pv.status} ${pv.code}`);
  });
  it('the server validates the documented request schemas before anything else', async () => {
    const c = client('trader');
    for (const bad of [() => c.createAgent({ kind: 'perp', name: 'x', universe: ['BTC'] }), () => c.reducePosition('p', { fraction: '1.5' }), () => c.backtestStrategy(UUID, { symbols: ['btc'] }),
      () => c.createOrder({ ...ORDER, clientOrderId: 'short' }), () => c.startAgent(UUID, { mode: 'paper', agentId: 'not-a-uuid' }), () => c.runCommand('x'.repeat(301)), () => c.backtestAgent(UUID, { hours: 0 })]) {
      const e = await caught(bad());
      expect(e).toBeInstanceOf(ValidationError); expect(e.code).toBe('bad_request');
    }
  });
  it('scope refusal: ScopeDenied; reads inside the scope still work', async () => {
    const c = client('narrow');
    for (const run of [() => c.getPortfolio(), () => c.getBalances(), () => c.getPositions(), () => c.listOrders(), () => c.listAgents(), () => c.getRisk(), () => c.previewOrder(ORDER), () => c.engageKillSwitch('no scope'), () => c.createOrder(ORDER)]) {
      const e = await caught(run());
      expect(e).toBeInstanceOf(ScopeDenied); expect(e).toMatchObject({ status: 403, code: 'insufficient_scope' });
    }
    const e = await caught(c.getPortfolio());
    say(`getPortfolio() with a markets:read key → ${e.name} HTTP ${e.status} ${e.code}: ${e.message}`);
    expect((await c.openapi()).openapi).toBe('3.1.0'); // any valid key
  });
  it('a revoked key and an unknown key: AuthenticationError, one answer for both', async () => {
    const r = await caught(client('revoked').listAgents());
    expect(r).toBeInstanceOf(AuthenticationError); expect(r).toMatchObject({ status: 401, code: 'unauthenticated' });
    say(`listAgents() with a REVOKED key → ${r.name} HTTP ${r.status} ${r.code}`);
    const u = await caught(new SPWallet({ apiKey: `spw_live_spk_000000000000_${'A'.repeat(43)}`, baseUrl: stack.baseUrl, maxRetries: 0 }).listAgents());
    expect(u).toBeInstanceOf(AuthenticationError); expect(u.message).toBe(r.message.replace(r.requestId!, u.requestId!));
    for (const e of [r, u]) expect(JSON.stringify([e.message, e.body, String(e)])).not.toContain('spw_live_');
  });
  it('rate limit: RateLimit-* on the answers, then RateLimited with the wait the server asks; a GET is retried after that wait', async () => {
    const c = client('limited'), seen: (number | null)[] = [];
    for (let i = 0; i < 3; i++) { const m = responseMeta(await c.listAgents())!; expect(m.rateLimit.limit).toBe(3); seen.push(m.rateLimit.remaining); }
    expect(seen).toEqual([2, 1, 0]);
    const e = await caught(c.listAgents()) as RateLimited;
    expect(e).toBeInstanceOf(RateLimited); expect(e).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(e.retryAfterSeconds).toBeGreaterThan(0); expect(e.retryAfterSeconds).toBeLessThanOrEqual(60);
    say(`listAgents() ×4 with a 3/min key → remaining ${JSON.stringify(seen)} then ${e.name} HTTP ${e.status} ${e.code} retryAfterSeconds=${e.retryAfterSeconds}`);
    // with retries on, the SDK waits exactly what the server asks before trying again (the sleep is recorded, not slept)
    const sleeps: number[] = [];
    const again = await caught(client('limited', { maxRetries: 1, maxRetryDelayMs: 120_000, sleep: async (ms) => { sleeps.push(ms); } }).listAgents());
    expect(again).toBeInstanceOf(RateLimited); expect(sleeps).toHaveLength(1); expect(sleeps[0]).toBeGreaterThan(0); expect(sleeps[0]).toBeLessThanOrEqual(60_000);
  });
});

describe.skipIf(skip !== null)('integration: webhook, examples', () => {
  it('a signature produced by the server code verifies', async () => {
    const w = stack.webhook, now = w.timestamp * 1000 + 1000;
    expect(await verifyWebhook({ ...w, now })).toBe(true);
    expect(await verifyWebhook({ ...w, body: w.body.replace('key.revoked', 'key.created'), now })).toBe(false);
    expect(await verifyWebhook({ ...w, now: now + 301_000 })).toBe(false);
    expect((await constructWebhookEvent({ ...w, now })).event).toBe('key.revoked');
    say(`verifyWebhook(server signature ${w.signature.slice(0, 14)}…) → true; tampered body → false; 301 s late → false`);
  });
  it('examples/read-only.ts runs against the real API and prints no secret', (ctx) => {
    const out = execFileSync('node', [path.join(ROOT, 'packages/trading-sdk/examples/read-only.ts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys.reader.secret, SP_WALLET_BASE_URL: stack.baseUrl } });
    if (process.env.SPW_SDK_TRANSCRIPT) console.log(out.split('\n').filter(Boolean).map((l) => `[example read-only.ts] ${l}`).join('\n'));
    expect(out).toContain('apiKey=<redacted>'); expect(out).not.toContain('spw_live_');
    expect(out).toMatch(/portfolio: wallet/); expect(out).toMatch(/risk: signer reachable=true, halted=false/); expect(out.trimEnd().endsWith('done')).toBe(true);
    if (/markets: ServiceUnavailable/.test(out)) ctx.skip('venue unreachable');
    expect(out).toMatch(/orderbook: best bid \d/);
  }, 300_000);
  it('examples/preview-order.ts: a real preview, with a key that may preview and may not read the account', (ctx) => {
    const out = execFileSync('node', [path.join(ROOT, 'packages/trading-sdk/examples/preview-order.ts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys.prepare.secret, SP_WALLET_BASE_URL: stack.baseUrl } });
    if (process.env.SPW_SDK_TRANSCRIPT) console.log(out.split('\n').filter(Boolean).map((l) => `[example preview-order.ts] ${l}`).join('\n'));
    expect(out).not.toContain('spw_live_'); expect(out.trimEnd().endsWith('done')).toBe(true);
    if (/cannot be read now/.test(out)) ctx.skip('venue unreachable');
    expect(out).toMatch(/preview: would execute=true/); expect(out).toMatch(/order: buy 0\.\d+ hyperliquid:BTC \(market\)/); expect(out).toMatch(/approval: mandate; risk engine: allow/); expect(out).toMatch(/account figures: withheld/);
    // the same example with a key that has no mandate says what is missing
    const unbound = execFileSync('node', [path.join(ROOT, 'packages/trading-sdk/examples/preview-order.ts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys.reader.secret, SP_WALLET_BASE_URL: stack.baseUrl } });
    expect(unbound).toMatch(/not bound to an owner-approved trading mandate/); expect(unbound.trimEnd().endsWith('done')).toBe(true);
  }, 300_000);
  it('examples/paper-order.ts: preview → place → replay → final → position → close, on the paper account', (ctx) => {
    const out = execFileSync('node', [path.join(ROOT, 'packages/trading-sdk/examples/paper-order.ts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys.trader2.secret, SP_WALLET_BASE_URL: stack.baseUrl } });
    if (process.env.SPW_SDK_TRANSCRIPT) console.log(out.split('\n').filter(Boolean).map((l) => `[example paper-order.ts] ${l}`).join('\n'));
    expect(out).not.toContain('spw_live_');
    if (/venue_unavailable|venue_timeout|venue_rate_limited/.test(out)) ctx.skip('venue unreachable');
    expect(out).toMatch(/preview: would execute=true/); expect(out).toMatch(/placed: order .* status=FILLED final=true/); expect(out).toMatch(/replay: same order=true, answered from the idempotency store=true/);
    expect(out).toMatch(/final: status=FILLED/); expect(out).toMatch(/position: long /); expect(out).toMatch(/closed: status=FILLED reduceOnly=true/); expect(out.trimEnd().endsWith('done')).toBe(true);
  }, 300_000);
});
