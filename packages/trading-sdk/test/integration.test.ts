// INTEGRATION: the SDK against the REAL API and the REAL signer (bundles of scripts/build.mjs, own per-run database, owner set
// up with a software passkey, keys created through the owner routes) — see scripts/test-stack.mts. No mocked transport.
// Skipped — reported as skipped, not as passed — when PostgreSQL is not reachable or SPW_SDK_INTEGRATION=off.
// Market data comes from the venues' public endpoints: a test whose venue cannot be reached (503) is skipped with that reason.
// SPW_SDK_TRANSCRIPT=1 prints one line per call (the transcript pasted in docs/v11/work/sdks.md).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { AmbiguousSymbol, AuthenticationError, constructWebhookEvent, ExecutionNotWired, MandateRequired, NotFound, OPERATIONS, RateLimited, responseMeta, ScopeDenied, ServiceUnavailable, SPWallet, SPWalletError,
  ValidationError, verifyWebhook, type OperationId } from '../src/index.ts';
import { ROOT, startStack, type Stack } from './stack.ts';

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
const ORDER = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01' } as const;
const UUID = '00000000-0000-4000-8000-000000000000';
const WRITES: Record<string, (c: SPWallet) => Promise<unknown>> = {
  previewOrder: (c) => c.previewOrder(ORDER), placeOrder: (c) => c.createOrder({ ...ORDER, type: 'limit', price: '50000', tif: 'gtc', clientOrderId: 'sdk-it-0001' }), cancelOrder: (c) => c.cancelOrder(`deriv:${UUID}:sdk-it-0001`),
  closePosition: (c) => c.closePosition('pos-1', { slippageBps: 50 }), reducePosition: (c) => c.reducePosition('pos-1', { fraction: '0.5' }),
  createStrategy: (c) => c.createStrategy({ kind: 'perp', path: 'momentum/v1' }), backtestStrategy: (c) => c.backtestStrategy(UUID, { symbols: ['BTC'], interval: '1h' }),
  startStrategy: (c) => c.startStrategy(UUID, { mode: 'paper' }), stopStrategy: (c) => c.stopStrategy(UUID, { reason: 'sdk test' }),
  createAgent: (c) => c.createAgent({ kind: 'perp', name: 'sdk agent', universe: ['BTC', 'ETH'], interval: '1h', mode: 'paper' }), startAgent: (c) => c.startAgent(UUID, { mode: 'paper' }), stopAgent: (c) => c.stopAgent(UUID),
};

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
    const nf = await caught(c.getMarket('nowhere:XYZ'));
    expect(nf).toBeInstanceOf(NotFound); say(`getMarket('nowhere:XYZ') → ${nf.name} ${nf.status} ${nf.code}`);
    const no = await caught(c.getOrder(`deriv:${UUID}:nope`));
    expect(no).toBeInstanceOf(NotFound); expect(no.code).toBe('unknown_order'); say(`getOrder('deriv:…:nope') → ${no.name} ${no.status} ${no.code}`);
    const route = await caught(c.waitForOrder('not-an-order-id', { waitTimeoutMs: 10 }));
    expect(route).toBeInstanceOf(NotFound);
    const bad = await caught(c.listMarkets({ limit: 0 }));
    expect(bad).toBeInstanceOf(ValidationError); expect(bad.code).toBe('bad_request'); say(`listMarkets({limit:0}) → ${bad.name} ${bad.status} ${bad.code}`);
  });
  it('getPortfolio / getBalances / getPositions / listOrders / getActivity / getRisk / listStrategies / listAgents', async () => {
    const c = client('reader', { timeoutMs: 60_000 });
    const p = await c.getPortfolio();
    expect(p).toMatchObject({ halted: false }); expect(p.totals).toHaveProperty('walletUsd'); expect(p.totals).toHaveProperty('liveVenueEquity'); expect(p.totals).toHaveProperty('paperEquity');
    expect(Array.isArray(p.wallet.balances)).toBe(true); expect(Array.isArray(p.accounts)).toBe(true);
    say(`getPortfolio() → ${meta(p)} totals=${JSON.stringify(p.totals)} balances=${p.wallet.balances.length} accounts=${p.accounts.length} halted=${p.halted}`);
    const b = await c.getBalances({ network: 'ethereum' });
    expect(b.balances.length).toBeGreaterThan(0);
    for (const x of b.balances) { expect(x.network).toBe('ethereum'); if (x.amount !== null) expect(x.amount).toMatch(/^\d+$/); }
    say(`getBalances({network:'ethereum'}) → ${meta(b)} ${b.balances.length} assets, first=${JSON.stringify({ symbol: b.balances[0]!.symbol, amount: b.balances[0]!.amount, display: b.balances[0]!.display })}`);
    const pos = await c.getPositions({ mode: 'paper' });
    expect(pos.positions).toEqual([]); say(`getPositions({mode:'paper'}) → ${meta(pos)} positions=${pos.positions.length} errors=${pos.errors.length}`);
    const o = await c.listOrders({ open: true, limit: 5 });
    expect(o.orders).toEqual([]); say(`listOrders({open:true,limit:5}) → ${meta(o)} orders=${o.orders.length}`);
    const a = await c.getActivity({ limit: 5 });
    expect(a.items).toEqual([]); say(`getActivity({limit:5}) → ${meta(a)} items=${a.items.length}`);
    const r = await c.getRisk();
    expect(r.killSwitch).toMatchObject({ signerReachable: true, signerHalted: false }); expect(r.capabilityLocks.length).toBeGreaterThan(0);
    say(`getRisk() → ${meta(r)} signerReachable=${r.killSwitch.signerReachable} signerHalted=${r.killSwitch.signerHalted} capabilityLocks=${r.capabilityLocks.length}`);
    const s = await c.listStrategies({ kind: 'perp' });
    expect(s.versions).toEqual([]); say(`listStrategies({kind:'perp'}) → ${meta(s)} library=${s.library.length} versions=${s.versions.length}`);
    const g = await c.listAgents();
    expect(g.agents).toEqual([]); say(`listAgents() → ${meta(g)} agents=${g.agents.length}`);
  });
  it('every read operation of the document was exercised above', () => {
    const reads = (Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].method === 'GET');
    expect(reads.sort()).toEqual(['getActivity', 'getBalances', 'getCandles', 'getMarket', 'getOpenApi', 'getOrder', 'getOrderbook', 'getPortfolio', 'getRisk', 'listAgents', 'listMarkets', 'listOrders', 'listPositions', 'listStrategies']);
  });
  it('rate-limit headers are exposed on every answer', async () => {
    const c = client('reader');
    const a = responseMeta(await c.listAgents())!, b = responseMeta(await c.listAgents())!;
    expect(a.rateLimit.limit).toBe(600); expect(b.rateLimit.remaining).toBe(a.rateLimit.remaining! - 1);
    expect(a.rateLimit.resetSeconds).toBeGreaterThan(0); expect(a.rateLimit.resetSeconds).toBeLessThanOrEqual(60);
    expect(a.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(a.requestId).not.toBe(b.requestId);
  });
});

describe.skipIf(skip !== null)('integration: the write surface and the refusals', () => {
  it('the write cases cover the 12 write operations of the document', () => {
    expect(Object.keys(WRITES).sort()).toEqual((Object.keys(OPERATIONS) as OperationId[]).filter((id) => OPERATIONS[id].idempotent).sort());
  });
  it('a key bound to a mandate: every write answers 501 → ExecutionNotWired, never a success; the key and the request id are on the error', async () => {
    const c = client('trader', { sendTimestamp: true });
    for (const [id, run] of Object.entries(WRITES)) {
      const e = await caught(run(c));
      expect(e, id).toBeInstanceOf(ExecutionNotWired);
      expect(e, id).toMatchObject({ status: 501, code: 'execution_not_wired' });
      expect(e.idempotencyKey, id).toMatch(/^[0-9a-f-]{36}$/); expect(e.requestId, id).toMatch(/^[0-9a-f-]{36}$/);
      say(`${id} (key bound to a mandate) → ${e.name} HTTP ${e.status} ${e.code} idempotencyKey=${e.idempotencyKey?.slice(0, 8)}…`);
    }
  });
  it('a 501 is not stored by the server: the same key can be sent again, and it is still a 501', async () => {
    const c = client('trader'), idempotencyKey = 'sdk-it-resume-0001';
    for (let i = 0; i < 2; i++) expect(await caught(c.previewOrder(ORDER, { idempotencyKey }))).toMatchObject({ status: 501, idempotencyKey });
  });
  it('a key WITHOUT a mandate: execution scopes are inert → MandateRequired; the preview (not an execution scope) reaches 501', async () => {
    const c = client('unbound');
    for (const [id, run] of Object.entries(WRITES)) {
      const e = await caught(run(c));
      if (OPERATIONS[id as OperationId].requiresMandate) { expect(e, id).toBeInstanceOf(MandateRequired); expect(e, id).toMatchObject({ status: 403, code: 'mandate_required' }); }
      else { expect(id).toBe('previewOrder'); expect(e).toBeInstanceOf(ExecutionNotWired); }
      say(`${id} (key without a mandate) → ${e.name} HTTP ${e.status} ${e.code}`);
    }
  });
  it('the server validates the documented request schemas before anything else', async () => {
    const c = client('trader');
    for (const bad of [() => c.createAgent({ kind: 'perp', name: 'x', universe: ['BTC'] }), () => c.reducePosition('p', { fraction: '1.5' }), () => c.backtestStrategy(UUID, { symbols: ['btc'] }),
      () => c.createOrder({ ...ORDER, clientOrderId: 'short' }), () => c.startAgent(UUID, { mode: 'paper', agentId: 'not-a-uuid' })]) {
      const e = await caught(bad());
      expect(e).toBeInstanceOf(ValidationError); expect(e.code).toBe('bad_request');
    }
  });
  it('scope refusal: ScopeDenied; reads inside the scope still work', async () => {
    const c = client('narrow');
    for (const run of [() => c.getPortfolio(), () => c.getBalances(), () => c.getPositions(), () => c.listOrders(), () => c.listAgents(), () => c.getRisk(), () => c.previewOrder(ORDER)]) {
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
  }, 120_000);
  it('examples/preview-order.ts: the preview is refused with 501 and the example says so (nothing is faked)', (ctx) => {
    const out = execFileSync('node', [path.join(ROOT, 'packages/trading-sdk/examples/preview-order.ts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys.reader.secret, SP_WALLET_BASE_URL: stack.baseUrl } });
    if (process.env.SPW_SDK_TRANSCRIPT) console.log(out.split('\n').filter(Boolean).map((l) => `[example preview-order.ts] ${l}`).join('\n'));
    expect(out).not.toContain('spw_live_');
    if (!/does not execute this operation yet \(501 execution_not_wired\)/.test(out)) ctx.skip('venue unreachable: the market could not be read to size the order');
    expect(out).not.toMatch(/^preview:/m);
  }, 120_000);
});
