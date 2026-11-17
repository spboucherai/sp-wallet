// API Bricks (CoinAPI) — the optional, keyed second market-data source (services/api/src/apibricks/, prices/cross.ts).
// No network, no database: REAL answers of the provider recorded on 2026-11-17 (test/fixtures/apibricks/ — bodies only:
// market data and metadata, no header, no key), a scripted fetch and a manual clock. The key used here is made up.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_LISTINGS, TOKENS } from '@spw/core';
import { ASSET_MAP, MARKET_PAIRS, UNMAPPED } from '../src/apibricks/asset-map.ts';
import { createBudget, utcDay, type BudgetState } from '../src/apibricks/budget.ts';
import { APIBRICKS_BASE, ApiBricksError, createApiBricksClient, parseApiTime, type ApiBricksFetch } from '../src/apibricks/client.ts';
import { PRICE_CHECK_BPS, buildAssetMap } from '../src/apibricks/mapping.ts';
import { apiBricksMarketSource, parseOhlcv } from '../src/apibricks/market-source.ts';
import { createApiBricksPrices, parseRates } from '../src/apibricks/prices.ts';
import { KEY_PREFIX, REDACTED, redact, redactError } from '../src/apibricks/redact.ts';
import { exchangeOf, isIndependent, pickMarketPairs } from '../src/apibricks/venues.ts';
import { capabilities, capabilitiesLine } from '../src/capabilities.ts';
import { evaluate } from '../src/market/quality.ts';
import { INTERVAL_MS, SourceError, type Candle } from '../src/market/types.ts';
import { validateBars } from '../src/market/validate.ts';
import { COINGECKO } from '../src/prices/coingecko-ids.ts';
import { crossCheck, crossSummary } from '../src/prices/cross.ts';
import { QuoteHub } from '../src/quotes/hub.ts';
import { spotUpstream, type SecondSpotSource } from '../src/quotes/upstreams.ts';
import { collect } from './quotes-helpers.ts';

const fx = <T = any>(name: string): { capturedAt: number | string; endpoint: string; status?: number; body: T } => JSON.parse(readFileSync(new URL(`./fixtures/apibricks/${name}.json`, import.meta.url), 'utf8'));
/** a key of the published shape that is not a key: assembled, so that the repository never holds the prefix followed by hex */
const FAKE_KEY = `${KEY_PREFIX}${'0123456789abcdef'.repeat(2)}cafef00d`;
const T0 = Date.parse('2026-11-17T08:00:00Z');

interface Scripted { fetch: ApiBricksFetch; calls: { url: string; headers: Record<string, string> }[] }
/** answers in order; a number is an HTTP status with the provider's error body, `Error` is a network failure */
function scripted(answers: (unknown | (() => unknown))[], o: { cost?: number | null } = {}): Scripted {
  const calls: Scripted['calls'] = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = answers.length > 1 ? answers.shift() : answers[0], a = typeof next === 'function' ? (next as () => unknown)() : next;
    if (a instanceof Error) throw a;
    const status = typeof a === 'object' && a !== null && 'status' in a && 'body' in a ? (a as { status: number }).status : 200;
    const body = typeof a === 'object' && a !== null && 'status' in a && 'body' in a ? (a as { body: unknown }).body : a;
    const headers = new Map<string, string>([['x-tierlimit-rpm-limit', '160'], ['x-tierlimit-rpm-remaining', '159'], ['x-tierlimit-concurrency-limit', '4']]);
    if (status === 200 && o.cost !== null) headers.set('x-ratelimit-request-cost', String(o.cost ?? 1));
    return { status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  } };
}
const clientOf = (s: Scripted, o: { daily?: number; caps?: Record<string, number>; now?: () => number } = {}) => {
  const budget = createBudget({ dailyCredits: o.daily ?? 50, ...(o.caps ? { caps: o.caps } : {}), now: o.now ?? (() => T0) });
  return createApiBricksClient({ key: FAKE_KEY, budget, fetch: s.fetch, now: o.now ?? (() => T0) });
};

// ---------------------------------------------------------------------------------------------------------------- the secret
describe('the key never leaves in a message', () => {
  it('scrubs the key wherever the provider lets it travel: header, query string, URL path, basic auth, any case', () => {
    const basic = Buffer.from(`coinapi:${FAKE_KEY}`).toString('base64');
    for (const leak of [
      `GET https://rest.coinapi.io/v1/exchangerate/BTC?apikey=${FAKE_KEY}&x=1 failed`,
      `GET https://rest.coinapi.io/APIKEY-${FAKE_KEY}/v1/assets 502`,
      `request headers: {"X-CoinAPI-Key":"${FAKE_KEY}","accept":"application/json"}`,
      `x-apibricks-key: ${FAKE_KEY}`, `X-APIKey=${FAKE_KEY}`,
      `Authorization: ${FAKE_KEY}`, `authorization: Basic ${basic}`,
      `upstream said ${FAKE_KEY.toUpperCase()} is over quota`,
      `encoded ${encodeURIComponent(FAKE_KEY)}`,
    ]) {
      const out = redact(leak, FAKE_KEY);
      expect(out).not.toContain(FAKE_KEY); expect(out.toLowerCase()).not.toContain(FAKE_KEY.slice(4)); expect(out).not.toContain(basic);
      expect(out).toContain(REDACTED);
    }
    // without knowing the key: anything of the published shape, or in a place a key travels, is scrubbed too
    expect(redact(`?apikey=${FAKE_KEY}`)).toBe(`?apikey=${REDACTED}`);
    expect(redact(`seen ${KEY_PREFIX}${'ab12'.repeat(10)} in a log`)).toBe(`seen ${REDACTED} in a log`);
    expect(redact('GEMINI_SPOT_BTC_USD 1DAY 64594.61')).toBe('GEMINI_SPOT_BTC_USD 1DAY 64594.61');          // market data is untouched
    expect(redactError(new Error(`fetch failed for ?apikey=${FAKE_KEY}`, { cause: new Error(`header X-CoinAPI-Key: ${FAKE_KEY}`) }), FAKE_KEY)).not.toContain(FAKE_KEY.slice(4));
  });

  it('an upstream error that echoes the key in a URL or a header is scrubbed before it is thrown, kept or logged', async () => {
    const s = scripted([
      { status: 500, body: { error: `internal error while serving /v1/exchangerate/BTC/USD?apikey=${FAKE_KEY} (X-CoinAPI-Key: ${FAKE_KEY})` } },
      new Error(`connect ECONNRESET https://rest.coinapi.io/APIKEY-${FAKE_KEY}/v1/x`),
      { status: 502, body: `<html>bad gateway — Authorization: ${FAKE_KEY}</html>` },
    ]);
    const c = clientOf(s), seen: string[] = [];
    for (let k = 0; k < 3; k++) await c.get('/v1/exchangerate/BTC/USD', { consumer: 'prices' }).catch((e: Error) => { seen.push(`${e.message} ${String(e.stack)}`); });
    expect(seen).toHaveLength(3);
    const everything = `${seen.join('\n')}\n${JSON.stringify(c.stats())}`;
    expect(everything).not.toContain(FAKE_KEY); expect(everything.toLowerCase()).not.toContain(FAKE_KEY.slice(4));
    expect(everything).toContain(REDACTED);
    expect(c.stats().lastError).toMatch(/^apibricks: http 502/);
  });

  it('the key is sent as a header, to the provider\'s host only; a path that could carry it or leave the host is refused', async () => {
    const s = scripted([fx('rate-btc-usd').body]), c = clientOf(s);
    await c.get('/v1/exchangerate/BTC/USD', { consumer: 'prices' });
    expect(s.calls[0]!.url).toBe('https://rest.coinapi.io/v1/exchangerate/BTC/USD'); expect(APIBRICKS_BASE).toBe('https://rest.coinapi.io');
    expect(s.calls[0]!.url).not.toContain(FAKE_KEY); expect(s.calls[0]!.headers['X-CoinAPI-Key']).toBe(FAKE_KEY);
    for (const bad of ['https://evil.example/v1/x', '/v2/x', `/v1/x?apikey=${FAKE_KEY}`, '/v1/redirect?to=https://evil.example'])
      await expect(c.get(bad, { consumer: 'prices' })).rejects.toThrow(/refused path/);
    expect(s.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the budget
describe('credit budgeter', () => {
  it('a hard daily ceiling: past it nothing is reserved, and the refusal is counted', async () => {
    const b = createBudget({ dailyCredits: 3, now: () => T0 });
    expect(await b.reserve('prices')).toBe(true); expect(await b.reserve('market', 2)).toBe(true);
    expect(b.has('prices')).toBe(false); expect(await b.reserve('prices')).toBe(false); expect(await b.reserve('quotes')).toBe(false);
    expect(b.snapshot()).toMatchObject({ day: '2026-11-17', ceiling: 3, used: 3, remaining: 0, exhausted: true, by: { prices: 1, market: 2 }, refusals: 2, resetsAt: '2026-11-18T00:00:00.000Z' });
  });
  it('resets at the UTC day; a consumer has its own smaller ceiling; the provider\'s own cost settles the count', async () => {
    let t = Date.parse('2026-11-17T23:59:00Z');
    const b = createBudget({ dailyCredits: 10, caps: { market: 2 }, now: () => t });
    expect(await b.reserve('market', 2)).toBe(true); expect(await b.reserve('market')).toBe(false);   // its own ceiling
    expect(await b.reserve('prices')).toBe(true);                                                     // the others still pass
    b.settle('prices', 4);                                                                            // the answer cost 5, 1 was reserved
    expect(b.snapshot()).toMatchObject({ used: 7, by: { market: 2, prices: 5 } });
    b.refund('prices', 1); expect(b.snapshot().used).toBe(6);
    t += 2 * 60_000;
    expect(b.snapshot()).toMatchObject({ day: '2026-11-18', used: 0, remaining: 10, exhausted: false, refusals: 0 });
    expect(await b.reserve('market', 2)).toBe(true);
  });
  it('the count survives a restart through the store; a ceiling of 0 never calls', async () => {
    let saved: BudgetState | null = null;
    const store = { load: async () => saved, save: async (s: BudgetState) => { saved = structuredClone(s); } };
    const a = createBudget({ dailyCredits: 5, now: () => T0, store });
    await a.reserve('prices', 4); await new Promise((r) => setTimeout(r, 0));
    expect(saved).toMatchObject({ day: utcDay(T0), used: 4 });
    const again = createBudget({ dailyCredits: 5, now: () => T0, store });                            // the process restarted
    expect(await again.reserve('prices', 2)).toBe(false); expect(await again.reserve('prices', 1)).toBe(true);
    const stale = createBudget({ dailyCredits: 5, now: () => T0 + 86_400_000, store });               // yesterday's count is not today's
    expect(await stale.reserve('prices', 5)).toBe(true);
    expect(await createBudget({ dailyCredits: 0 }).reserve('prices')).toBe(false);
  });
  it('exhausted → the client throws `quota` WITHOUT calling the provider', async () => {
    const s = scripted([fx('rate-btc-usd').body]), c = clientOf(s, { daily: 2 });
    await c.get('/v1/exchangerate/BTC/USD', { consumer: 'prices' }); await c.get('/v1/exchangerate/BTC/USD', { consumer: 'prices' });
    const e = await c.get('/v1/exchangerate/BTC/USD', { consumer: 'prices' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiBricksError); expect((e as ApiBricksError).kind).toBe('quota'); expect((e as Error).message).toMatch(/2 of 2 credits used on 2026-11-17; resets at 2026-11-18T00:00:00.000Z/);
    expect(s.calls).toHaveLength(2);
    expect(c.stats()).toMatchObject({ calls: 2, ok: 2, refusedByBudget: 1, credits: 2, lastErrorKind: 'quota', tier: { rpmLimit: 160, concurrencyLimit: 4 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------- the client
describe('REST client on recorded answers', () => {
  it('a single rate; the provider\'s seven-digit UTC times', async () => {
    const c = clientOf(scripted([fx('rate-btc-usd').body]));
    const r = await c.get<{ time: string; asset_id_base: string; asset_id_quote: string; rate: number }>('/v1/exchangerate/BTC/USD', { consumer: 'prices' });
    expect(r).toMatchObject({ asset_id_base: 'BTC', asset_id_quote: 'USD' }); expect(r.rate).toBeGreaterThan(1000);
    expect(parseApiTime(r.time)).toBe(Date.parse('2026-11-17T07:53:00.700Z'));
    expect(parseApiTime('2026-11-17T07:55:03.4000000Z')).toBe(Date.parse('2026-11-17T07:55:03.400Z'));
    expect(parseApiTime('2026-11-17T07:54:56.4211407Z')).toBe(Date.parse('2026-11-17T07:54:56.421Z'));
    for (const bad of ['2026-11-17 07:55:03', '2026-11-17T07:55:03+01:00', 1763366103, null]) expect(parseApiTime(bad)).toBeNaN();
  });
  it('the recorded errors are typed: bad key, unknown symbol, "no such item"; 429 and an exhausted quota', async () => {
    const kinds: [unknown, string][] = [
      [{ status: 401, body: fx('error-bad-key').body }, 'auth'], [{ status: 400, body: fx('error-unknown-symbol').body }, 'not_found'], [{ status: 550, body: fx('error-no-item').body }, 'not_found'],
      [{ status: 429, body: { error: 'Too many requests' } }, 'rate_limited'], [{ status: 429, body: { error: 'You have exceeded your daily quota' } }, 'quota'],
      [{ status: 403, body: { error: 'Your API key is out of credits or plan quota.' } }, 'quota'], [{ status: 403, body: { error: 'Forbidden' } }, 'auth'], [{ status: 200, body: '<html>' }, 'schema'],
    ];
    for (const [answer, kind] of kinds) {
      const e = await clientOf(scripted([answer])).get('/v1/x', { consumer: 'prices' }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiBricksError); expect((e as ApiBricksError).kind).toBe(kind);
    }
    expect(String(fx('error-bad-key').body.error)).toBe('Invalid API key format.');
  });
  it('a failed call is charged what was reserved (the provider gives no cost on an error); a call that never left is refunded', async () => {
    const c = clientOf(scripted([{ status: 400, body: fx('error-unknown-symbol').body }, new Error('socket hang up')], { cost: null }));
    await c.get('/v1/a', { consumer: 'market' }).catch(() => {}); expect(c.budget.snapshot().used).toBe(1);
    await c.get('/v1/a', { consumer: 'market' }).catch(() => {}); expect(c.budget.snapshot().used).toBe(1);
    expect(c.stats()).toMatchObject({ calls: 2, ok: 0, failed: 2, lastErrorKind: 'network' });
  });
});

// ---------------------------------------------------------------------------------------------------------------- the mapping
describe('wallet symbol → provider asset: certain or not at all', () => {
  const assets = fx('meta-assets').body, rates = parseRates(fx('rates-usd').body), reference = fx<Record<string, number>>('reference-usd').body;
  const providerUsd = Object.fromEntries([...rates].map(([id, r]) => [id, r.usd]));
  const build = (o: Partial<Parameters<typeof buildAssetMap>[0]> = {}) => buildAssetMap({ identities: COINGECKO, assets, tokens: TOKENS, providerUsd, referenceUsd: reference, ...o });

  it('the committed table is exactly what the rules give on the recorded metadata', () => {
    const r = build();
    expect(Object.fromEntries(r.mapped.map((m) => [m.symbol, { assetId: m.assetId, evidence: m.evidence, proof: m.proof, checkBps: m.checkBps }]))).toEqual(ASSET_MAP);
    expect(r.unmapped.map((u) => u.symbol).sort()).toEqual(Object.keys(UNMAPPED).sort());
    expect(r.mapped.length + r.unmapped.length).toBe(Object.keys(COINGECKO).length);
    for (const m of r.mapped) expect(m.checkBps).toBeLessThanOrEqual(PRICE_CHECK_BPS);
  });
  it('certain: a contract address both sides give, or a reviewed native coin — each within the price check', () => {
    expect(ASSET_MAP.USDC).toMatchObject({ assetId: 'USDC', evidence: 'address' }); expect(ASSET_MAP.USDC!.proof).toMatch(/^(ethereum|arbitrum):0x[0-9a-f]{40}$/);
    expect(ASSET_MAP.ARB).toMatchObject({ evidence: 'address', proof: 'arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548' });   // although the provider NAMES it "ARbit"
    expect(assets.find((a: { asset_id: string }) => a.asset_id === 'ARB').name).toBe('ARbit');
    for (const s of ['BTC', 'ETH', 'SOL']) expect(ASSET_MAP[s]).toMatchObject({ assetId: s, evidence: 'reviewed' });
    expect(ASSET_MAP['USDC.e']).toEqual({ ...ASSET_MAP.USDC, evidence: 'alias', proof: 'USDC' });                              // already priced as USDC by the wallet
  });
  it('ambiguous: never mapped — same ticker with another contract, a ticker of another asset, a casing difference, no evidence', () => {
    // the provider's WBTC / WETH / USDS addresses are not the registry's on a network both know
    for (const s of ['WBTC', 'WETH', 'USDS', 'USDG', 'USDD']) { expect(ASSET_MAP[s]).toBeUndefined(); expect(UNMAPPED[s]).toMatch(/^conflict: (ethereum|arbitrum): registry 0x[0-9a-f]{40} ≠ provider 0x[0-9a-f]{40}$/); }
    // `OP` exists at the provider, named "Operand", with no address: a ticker is not an identity
    expect(assets.find((a: { asset_id: string }) => a.asset_id === 'OP').name).toBe('Operand'); expect(ASSET_MAP.OP).toBeUndefined(); expect(UNMAPPED.OP).toMatch(/^no_evidence/);
    // no case folding: the provider's CBETH / USDE / MSOL are not the wallet's cbETH / USDe / mSOL
    for (const s of ['cbETH', 'USDe', 'mSOL', 'cbBTC', 'wstETH']) { expect(ASSET_MAP[s]).toBeUndefined(); expect(UNMAPPED[s]).toMatch(/^no_exact_id/); }
    expect(assets.some((a: { asset_id: string }) => a.asset_id === 'CBETH')).toBe(true);
    // an alias is only followed towards a symbol the wallet ALREADY prices identically; WPOL has its own price identity
    expect(ASSET_MAP.WPOL).toBeUndefined();
  });
  it('the rules, one at a time', () => {
    const one = (o: Partial<Parameters<typeof buildAssetMap>[0]>) => buildAssetMap({ identities: { XYZ: 'xyz' }, assets: [{ asset_id: 'XYZ', name: 'Xyz', type_is_crypto: 1, chain_addresses: null }], tokens: [], providerUsd: { XYZ: 10 }, referenceUsd: { XYZ: 10 }, reviewed: ['XYZ'], ...o });
    expect(one({}).mapped).toEqual([{ symbol: 'XYZ', assetId: 'XYZ', evidence: 'reviewed', proof: 'reviewed list', checkBps: 0 }]);
    expect(one({ reviewed: [] }).unmapped[0]).toMatchObject({ reason: 'no_evidence' });
    expect(one({ providerUsd: { XYZ: 10.3 } }).unmapped[0]).toMatchObject({ reason: 'price_mismatch' });                       // 296 bps: a ticker reused for something else
    expect(one({ providerUsd: { XYZ: 10.1 } }).mapped[0]).toMatchObject({ checkBps: 99.5 });
    expect(one({ providerUsd: {} }).unmapped[0]).toMatchObject({ reason: 'no_provider_price' });
    expect(one({ referenceUsd: {} }).unmapped[0]).toMatchObject({ reason: 'no_reference_price' });
    expect(one({ assets: [{ asset_id: 'XYZ', type_is_crypto: 0 }] }).unmapped[0]).toMatchObject({ reason: 'not_crypto' });
    expect(one({ assets: [{ asset_id: 'xyz', type_is_crypto: 1 }] }).unmapped[0]).toMatchObject({ reason: 'no_exact_id' });
    const A = '0x00000000000000000000000000000000000000aa', B = '0x00000000000000000000000000000000000000bb';
    const withAddr = (reg: string, prov: string, chain = 'ETHEREUM') => one({ reviewed: [], tokens: [{ symbol: 'XYZ', deployments: { ethereum: { address: reg } } }], assets: [{ asset_id: 'XYZ', type_is_crypto: 1, chain_addresses: [{ chain_id: chain, network_id: 'MAINNET', address: prov }] }] });
    expect(withAddr(A.toUpperCase().replace('0X', '0x'), A).mapped[0]).toMatchObject({ evidence: 'address', proof: `ethereum:${A}` });
    expect(withAddr(A, B).unmapped[0]).toMatchObject({ reason: 'conflict' });
    expect(withAddr(A, A, 'BASE').unmapped[0]).toMatchObject({ reason: 'no_evidence' });                                     // a chain the wallet cannot compare: not evidence
    // a conflict is final even for a reviewed symbol
    expect(buildAssetMap({ identities: { XYZ: 'xyz' }, reviewed: ['XYZ'], providerUsd: { XYZ: 1 }, referenceUsd: { XYZ: 1 }, tokens: [{ symbol: 'XYZ', deployments: { ethereum: { address: A } } }],
      assets: [{ asset_id: 'XYZ', type_is_crypto: 1, chain_addresses: [{ chain_id: 'ETHEREUM', network_id: 'MAINNET', address: B }] }] }).mapped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- prices
describe('second price list', () => {
  const body = fx('rates-usd').body, at = Date.parse('2026-11-17T08:01:00Z');
  it('one batched call for every mapped asset and CAD; each price keeps the provider\'s own time', async () => {
    const s = scripted([body]), p = createApiBricksPrices({ client: clientOf(s, { now: () => at }), now: () => at });
    const r = (await p.read())!;
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toMatch(/^https:\/\/rest\.coinapi\.io\/v1\/exchangerate\/USD\?invert=true&filter_asset_id=AAVE;ADA;.*;XRP;CAD$/);
    expect(Object.keys(r.prices).sort()).toEqual(Object.keys(ASSET_MAP).sort());
    const rates = parseRates(body), btc = rates.get('BTC')!, cad = rates.get('CAD')!;
    expect(r.prices.BTC).toEqual({ usd: btc.usd, cad: btc.usd / cad.usd, priceAt: new Date(btc.at).toISOString(), stale: false });
    expect(r.prices.BTC!.usd).toBeGreaterThan(10_000); expect(r.prices.BTC!.cad!).toBeGreaterThan(r.prices.BTC!.usd);
    expect(r.prices['USDC.e']).toEqual(r.prices.USDC);
    expect(r.prices.OP).toBeUndefined(); expect(r.prices.WBTC).toBeUndefined();                                           // not mapped: one source, as before
  });
  it('cached for its window; a fresher read on demand; concurrent callers share one request; an old rate is stale', async () => {
    let t = at; const s = scripted([body]), p = createApiBricksPrices({ client: clientOf(s, { now: () => t }), now: () => t, ttlMs: 30 * 60_000 });
    await Promise.all([p.read(), p.read(), p.read()]); expect(s.calls).toHaveLength(1);
    t += 10 * 60_000; await p.read(); expect(s.calls).toHaveLength(1);
    await p.read({ maxAgeMs: 5 * 60_000 }); expect(s.calls).toHaveLength(2);                                             // the primary is down: fresher
    t += 31 * 60_000; const r = (await p.read())!; expect(s.calls).toHaveLength(3);
    expect(r.prices.BTC!.stale).toBe(true);                                                                             // the recorded rate is now 40 minutes old
  });
  it('a failure serves the last list with its real dates and is not retried at once; an exhausted budget is not retried at all', async () => {
    let t = at; const s = scripted([body, { status: 500, body: { error: 'boom' } }, { status: 500, body: { error: 'boom' } }, body]);
    const p = createApiBricksPrices({ client: clientOf(s, { now: () => t, daily: 4 }), now: () => t, ttlMs: 60_000, retryMs: 60_000 });
    const first = (await p.read())!; t += 61_000;
    const second = (await p.read())!; expect(s.calls).toHaveLength(2); expect(second.prices.BTC).toMatchObject({ usd: first.prices.BTC!.usd, priceAt: first.prices.BTC!.priceAt });
    expect(p.status()).toMatchObject({ lastErrorKind: 'http' });
    t += 30_000; await p.read(); expect(s.calls).toHaveLength(2);                                                       // inside the retry pause
    t += 31_000; await p.read(); expect(s.calls).toHaveLength(3);
    t += 61_000; await p.read(); expect(s.calls).toHaveLength(4); expect(p.status()).toMatchObject({ lastError: null, reads: 2 });
    t += 61_000; await p.read(); expect(p.status()).toMatchObject({ lastErrorKind: 'quota' }); expect(s.calls).toHaveLength(4);
    t += 3_600_000; await p.read(); expect(s.calls).toHaveLength(4);                                                    // still the same UTC day: nothing is asked
    const none = createApiBricksPrices({ client: clientOf(scripted([{ status: 401, body: fx('error-bad-key').body }])), now: () => at });
    expect(await none.read()).toBeNull(); expect(none.status()).toMatchObject({ lastErrorKind: 'auth' });
  });
  it('rows that are not a positive rate with a UTC time are dropped; another answer is a schema error', () => {
    const m = parseRates({ asset_id_base: 'USD', rates: [{ time: '2026-11-17T07:55:03.4000000Z', asset_id_quote: 'A', rate: 2 }, { time: 'yesterday', asset_id_quote: 'B', rate: 2 }, { time: '2026-11-17T07:55:03Z', asset_id_quote: 'C', rate: 0 }, { time: '2026-11-17T07:55:03Z', asset_id_quote: 'D', rate: '2' }] });
    expect([...m.keys()]).toEqual(['A']);
    expect(() => parseRates({ asset_id_base: 'BTC', rates: [] })).toThrow(/unexpected/); expect(() => parseRates(fx('error-bad-key').body)).toThrow(ApiBricksError);
  });
});

describe('two sources, one rule', () => {
  const P = (usd: number, priceAt: string | null, stale = false) => ({ usd, cad: usd * 1.4, priceAt, stale, change24h: 1.5 as number | null });
  const S = (usd: number, priceAt: string, stale = false, cad: number | null = usd * 1.4) => ({ usd, cad, priceAt, stale });
  const blank = (_s: string, s: { usd: number; cad: number | null; priceAt: string }) => (s.cad === null ? null : { usd: s.usd, cad: s.cad, priceAt: s.priceAt, stale: false, change24h: null });
  const at = '2026-11-17T08:00:00.000Z', near = '2026-11-17T08:04:00.000Z', far = '2026-11-17T08:20:00.000Z';

  it('without a second source every price is the primary\'s, labelled — and nothing else changes', () => {
    const primary = { BTC: P(64000, at), OP: P(0.9, at, true) }, r = crossCheck(primary, null, { thresholdBps: 100 }, blank)!;
    expect(r.BTC).toEqual({ ...primary.BTC, source: 'coingecko', fallback: false, sources: [{ source: 'coingecko', usd: 64000, cad: 64000 * 1.4, priceAt: at, stale: false }], divergent: false, divergenceBps: null });
    expect(r.OP).toMatchObject({ stale: true, source: 'coingecko', fallback: false });
    expect(crossCheck(null, null, { thresholdBps: 100 }, blank)).toBeNull();
    expect(crossSummary(r, false)).toEqual({ primary: 'coingecko', second: null, fallback: [], divergent: [], compared: 0, maxDivergenceBps: null });
  });
  it('both answer: both are reported with their own dates, the primary is displayed, nothing is averaged', () => {
    const r = crossCheck({ BTC: P(64000, at) }, { BTC: S(64064, near) }, { thresholdBps: 100 }, blank)!;
    expect(r.BTC).toMatchObject({ usd: 64000, priceAt: at, source: 'coingecko', fallback: false, divergent: false, divergenceBps: 10, change24h: 1.5 });
    expect(r.BTC!.sources).toEqual([{ source: 'coingecko', usd: 64000, cad: 64000 * 1.4, priceAt: at, stale: false }, { source: 'apibricks', usd: 64064, cad: 64064 * 1.4, priceAt: near, stale: false }]);
  });
  it('divergent beyond the threshold — flagged, still the primary\'s price; prices too far apart in time are not compared', () => {
    const r = crossCheck({ BTC: P(64000, at), ETH: P(1800, at), SOL: P(70, at) }, { BTC: S(65300, near), ETH: S(1818, near), SOL: S(75, far) }, { thresholdBps: 100 }, blank)!;
    expect(r.BTC).toMatchObject({ usd: 64000, source: 'coingecko', divergent: true, divergenceBps: 201.1 });
    expect(r.ETH).toMatchObject({ divergent: false, divergenceBps: 99.5 });                                              // at the threshold is not beyond it
    expect(r.SOL).toMatchObject({ usd: 70, divergent: false, divergenceBps: null });                                     // 20 minutes apart: market movement, not a disagreement
    expect(crossSummary(r, true)).toEqual({ primary: 'coingecko', second: 'apibricks', fallback: [], divergent: ['BTC'], compared: 2, maxDivergenceBps: 201.1 });
    expect(crossCheck({ BTC: P(64000, at) }, { BTC: S(65300, near) }, { thresholdBps: 250 }, blank)!.BTC).toMatchObject({ divergent: false, divergenceBps: 201.1 });
  });
  it('failover: the primary is stale or absent → the second source\'s price, LABELLED; a stale second source never replaces anything', () => {
    const r = crossCheck({ BTC: P(64000, at, true), ETH: P(1800, at, true), LINK: P(9, at) }, { BTC: S(64500, far), ETH: S(1790, far, true), SOL: S(72, far), DOT: S(0.7, far, false, null), XRP: S(0.9, far, true) }, { thresholdBps: 100 }, blank)!;
    expect(r.BTC).toMatchObject({ usd: 64500, cad: 64500 * 1.4, priceAt: far, stale: false, source: 'apibricks', fallback: true, change24h: 1.5, divergenceBps: null, divergent: false });
    expect(r.BTC!.sources.map((x) => [x.source, x.usd, x.stale])).toEqual([['coingecko', 64000, true], ['apibricks', 64500, false]]);
    expect(r.ETH).toMatchObject({ usd: 1800, stale: true, source: 'coingecko', fallback: false });                       // both stale: the primary stays, flagged stale
    expect(r.LINK).toMatchObject({ source: 'coingecko', fallback: false, sources: [{ source: 'coingecko' }] });          // one source: as before
    expect(r.SOL).toMatchObject({ usd: 72, source: 'apibricks', fallback: true, change24h: null });                      // the primary has no row at all
    expect(r.DOT).toBeUndefined(); expect(r.XRP).toBeUndefined();                                                        // no CAD rate / only a stale second price: no price
    expect(crossSummary(r, true)).toMatchObject({ fallback: ['BTC', 'SOL'], divergent: [], compared: 0 });
  });
  it('the primary refuses entirely (no list): the list is built from the second source alone, every price labelled', () => {
    const r = crossCheck<ReturnType<typeof P>>(null, { BTC: S(64500, far), ETH: S(1790, far) }, { thresholdBps: 100 }, blank)!;
    expect(Object.keys(r)).toEqual(['BTC', 'ETH']);
    for (const m of Object.values(r)) expect(m).toMatchObject({ source: 'apibricks', fallback: true, stale: false, change24h: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------- market source
describe('additional confirming market source', () => {
  const rec = fx<any[]>('ohlcv-gemini-btc-1h'), H = INTERVAL_MS['1h'], start = Date.parse('2026-11-16T00:00:00Z'), end = start + 23 * H, now = Date.parse('2026-11-17T08:00:00Z');

  it('independence rule: only an exchange the wallet does not read itself may confirm a bar', () => {
    for (const id of ['GEMINI_SPOT_BTC_USD', 'BITFINEX_SPOT_LTC_USD']) expect(isIndependent(id)).toBe(true);
    for (const id of ['COINBASE_SPOT_BTC_USD', 'KRAKEN_SPOT_BTC_USD', 'BITSTAMP_SPOT_BTC_USD', 'KRAKENFTS_SPOT_BTC_USD', 'COINBASEINTX_SPOT_BTC_USD',
      'GEMINI_SPOT_BTC_USDT', 'GEMINI_PERP_BTC_USD', 'BTC', 'USD', '']) expect(isIndependent(id)).toBe(false);
    expect(exchangeOf('GEMINI_SPOT_BTC_USD')).toBe('GEMINI'); expect(exchangeOf('BTC/USD')).toBeNull();
    for (const [symbol, id] of Object.entries(MARKET_PAIRS)) { expect(isIndependent(id)).toBe(true); expect(id).toBe(`${exchangeOf(id)}_SPOT_${ASSET_MAP[symbol]!.assetId}_USD`); expect(ASSET_MAP[symbol]!.evidence).not.toBe('alias'); expect(Object.hasOwn(MARKET_LISTINGS, symbol)).toBe(true); }
    // a table that names one of the wallet's own exchanges is refused by the source itself
    const src = apiBricksMarketSource({ client: clientOf(scripted([rec.body])), symbols: ['BTC', 'ETH'], intervals: ['1h'], pairs: { BTC: 'COINBASE_SPOT_BTC_USD', ETH: 'GEMINI_SPOT_ETH_USD' }, spacingMs: 0 });
    expect(src.pairs).toEqual({ ETH: 'GEMINI_SPOT_ETH_USD' });
  });
  it('the committed pairs are what the selection gives on the recorded symbol metadata', () => {
    const meta = fx('meta-symbols'), reference = fx<Record<string, number>>('reference-usd').body;
    const certain = Object.fromEntries(Object.entries(ASSET_MAP).filter(([s, m]) => m.evidence !== 'alias' && Object.hasOwn(MARKET_LISTINGS, s)).map(([s, m]) => [s, m.assetId]));
    const r = pickMarketPairs({ assets: certain, symbols: meta.body, referenceUsd: reference, now: Number(meta.capturedAt), priceCheckBps: PRICE_CHECK_BPS });
    expect(r.pairs).toEqual(MARKET_PAIRS);
    expect(r.skipped.find((s) => s.symbol === 'BNB')!.reason).toMatch(/GEMINI: daily volume \d+ USD below 50000/);        // listed, but too thin to confirm anything
  });
  it('replays the recorded answer through the SAME validation as the exchanges: 24 closed hourly bars on the grid', async () => {
    const s = scripted([rec.body]), c = clientOf(s, { now: () => now }), src = apiBricksMarketSource({ client: c, symbols: ['BTC'], intervals: ['1h', '1d'], spacingMs: 0 });
    expect(src).toMatchObject({ id: 'apibricks', maxBars: 100, historyBars: 300, pairs: { BTC: 'GEMINI_SPOT_BTC_USD' }, intervals: ['1h', '1d'] });
    const raw = await src.candles('BTC', '1h', { start, end }, now);
    expect(s.calls[0]!.url).toBe(`https://rest.coinapi.io${rec.endpoint.replace('GET ', '')}`);                         // the very request that was recorded
    const v = validateBars(raw, '1h', now);
    expect(v.rejected).toEqual([]); expect(v.bars).toHaveLength(24); expect(v.bars[0]!.ts).toBe(start); expect(v.bars.at(-1)!.ts).toBe(end);
    expect(v.bars[0]).toEqual({ ts: start, open: rec.body[0].price_open, high: rec.body[0].price_high, low: rec.body[0].price_low, close: rec.body[0].price_close, volume: rec.body[0].volume_traded });
    expect(c.budget.snapshot().by).toEqual({ market: 1 });
  });
  it('the bar still open is dropped; a malformed bar is a schema error; bad ranges and intervals it does not serve are refused', async () => {
    const latest = fx<any[]>('ohlcv-gemini-btc-1d-latest'), D = INTERVAL_MS['1d'], captured = Date.parse('2026-11-17T07:55:00Z'), d0 = Date.parse('2026-11-13T00:00:00Z');
    const src = apiBricksMarketSource({ client: clientOf(scripted([latest.body])), symbols: ['BTC'], intervals: ['1d'], spacingMs: 0 });
    const bars = await src.candles('BTC', '1d', { start: d0, end: d0 + 4 * D }, captured);
    expect(parseOhlcv(latest.body)).toHaveLength(5); expect(bars).toHaveLength(4); expect(bars.at(-1)!.ts).toBe(Date.parse('2026-11-16T00:00:00Z'));   // 2026-11-17 was still open
    expect(() => parseOhlcv([{ ...latest.body[0], price_close: '64594.61' }])).toThrow(SourceError); expect(() => parseOhlcv({ error: 'x' })).toThrow(/a list of bars expected/);
    await expect(src.candles('BTC', '1h', { start, end }, now)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(src.candles('BTC', '1d', { start: d0, end: d0 + 100 * D }, now)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(src.candles('DOGE', '1d', { start: d0, end: d0 }, now)).rejects.toMatchObject({ kind: 'unsupported' });
  });
  it('quota: the source is not ready and a call answers rate_limited — the pass leaves it alone; the provider\'s errors are typed', async () => {
    const s = scripted([rec.body]), c = clientOf(s, { daily: 10, caps: { market: 1 } }), src = apiBricksMarketSource({ client: c, symbols: ['BTC'], intervals: ['1h'], spacingMs: 0 });
    expect(src.ready!()).toBe(true); await src.candles('BTC', '1h', { start, end }, now); expect(src.ready!()).toBe(false);
    await expect(src.candles('BTC', '1h', { start, end }, now)).rejects.toMatchObject({ source: 'apibricks', kind: 'rate_limited' });
    expect(s.calls).toHaveLength(1);
    const bad = apiBricksMarketSource({ client: clientOf(scripted([{ status: 400, body: fx('error-unknown-symbol').body }])), symbols: ['BTC'], intervals: ['1h'], spacingMs: 0 });
    await expect(bad.candles('BTC', '1h', { start, end }, now)).rejects.toMatchObject({ kind: 'unsupported' });
  });
  it('REAL bars of the same hours (Coinbase read directly, Gemini through the provider): the gate confirms the good ones and refuses the provider\'s off-market prints', async () => {
    // observed on 2026-11-16: 20 of the 24 hourly closes agree within 5 bps (median 2.3); FOUR bars of the provider's Gemini series
    // close ~470–510 bps above the market (07:00, 15:00, 16:00, 17:00 UTC). The same gate as for the exchanges decides.
    const cb: Candle[] = fx<number[][]>('coinbase-btc-1h-same-hours').body.map(([t, low, high, open, close, volume]) => ({ ts: t! * 1000, open: open!, high: high!, low: low!, close: close!, volume: volume! }));
    const ab = validateBars(parseOhlcv(rec.body), '1h', now).bars;
    expect(cb).toHaveLength(24); expect(ab).toHaveLength(24);
    const dev = ab.map((b, k) => (Math.abs(b.close - cb[k]!.close) / ((b.close + cb[k]!.close) / 2)) * 1e4);
    expect(dev.filter((d) => d <= 5)).toHaveLength(20); expect(dev.filter((d) => d > 400).map((_, k) => k)).toHaveLength(4);
    const opts = { lookback: 3, agreeBars: 3, priority: ['coinbase', 'bitstamp', 'kraken', 'apibricks'] as const };
    const upTo = (hour: number) => ({ coinbase: cb.slice(0, hour + 1), apibricks: ab.slice(0, hour + 1) }), atClose = (hour: number) => start + (hour + 1) * H + 11_000;
    const good = evaluate(upTo(6), '1h', atClose(6), opts);                                                             // 04:00–06:00: confirmed
    expect(good.status).toBe('ok'); expect(good.maxDeviationBps!).toBeLessThan(5); expect(good.provided).toEqual({ coinbase: 3 });
    const bad = evaluate(upTo(7), '1h', atClose(7), opts);                                                              // 07:00 is an off-market print
    expect(bad.status).toBe('disagreement'); expect(bad.maxDeviationBps!).toBeGreaterThan(400);
    // with a real second exchange that agrees, the provider's bad bar is recorded and does not block (the existing rule)
    const third = evaluate({ ...upTo(7), kraken: cb.slice(0, 8).map((c) => ({ ...c, close: c.close * 1.0002 })) }, '1h', atClose(7), opts);
    expect(third.status).toBe('ok'); expect(third.agreement.at(-1)!.closes.apibricks).toBe(ab[7]!.close);
  });
  it('quality gate: it CONFIRMS a bar of an exchange, is never preferred to one, and can never pass alone', async () => {
    const src = apiBricksMarketSource({ client: clientOf(scripted([rec.body])), symbols: ['BTC'], intervals: ['1h'], spacingMs: 0 });
    const ab = validateBars(await src.candles('BTC', '1h', { start, end }, now), '1h', now).bars, at = end + H + 11_000;
    const shifted = (bps: number): Candle[] => ab.map((b) => ({ ...b, open: b.open * (1 + bps / 1e4), high: b.high * (1 + bps / 1e4), low: b.low * (1 + bps / 1e4), close: b.close * (1 + bps / 1e4) }));
    const opts = { lookback: 24, priority: ['coinbase', 'bitstamp', 'kraken', 'apibricks'] as const };
    // one exchange alone: refused, as before
    expect(evaluate({ coinbase: shifted(3) }, '1h', at, opts).status).toBe('insufficient_sources');
    // the same exchange, confirmed by the independent series within 50 bps: usable — and the bar used is the exchange's
    const ok = evaluate({ coinbase: shifted(3), apibricks: ab }, '1h', at, opts);
    expect(ok.status).toBe('ok'); expect(ok.provided).toEqual({ coinbase: 24 }); expect(ok.maxDeviationBps!).toBeLessThan(5);
    // it disagrees beyond the tolerance: the bar is NOT confirmed
    expect(evaluate({ coinbase: shifted(80), apibricks: ab }, '1h', at, opts).status).toBe('disagreement');
    // alone, it is one source: never enough
    expect(evaluate({ apibricks: ab }, '1h', at, opts).status).toBe('insufficient_sources');
    // without it in the priority (no key), its stored bars are simply not read
    expect(evaluate({ coinbase: shifted(3), apibricks: ab }, '1h', at, { lookback: 24 }).status).toBe('insufficient_sources');
  });
});

// ---------------------------------------------------------------------------------------------------------------- wiring
describe('optional: without the key nothing changes', () => {
  let mod: typeof import('../src/apibricks/index.ts');
  beforeAll(async () => {
    Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
    delete process.env.APIBRICKS_API_KEY;
    mod = await import('../src/apibricks/index.ts');
  });
  const cfg = (key: string) => ({ key, dailyCredits: 100, marketDailyCredits: 25, quoteDailyCredits: 30, priceTtlMs: 1_800_000, failoverTtlMs: 300_000, divergenceBps: 100, quotePollMs: 300_000, marketIntervals: ['1d'] as const, marketSymbols: [], marketHistoryBars: 300 });

  it('absent and reported needsKey; no market source is registered; the priority is the three exchanges', async () => {
    expect(mod.createApiBricks(cfg(''))).toBeNull(); expect(mod.apiBricks()).toBeNull();
    expect(mod.apiBricksStatus()).toEqual({ provider: 'apibricks', configured: false, needsKey: true, missing: ['APIBRICKS_API_KEY'] });
    const { defaultSources } = await import('../src/market/sources.ts'), { DEFAULT_PRIORITY, DEFAULT_QUALITY } = await import('../src/market/quality.ts');
    expect(defaultSources({ spacingMs: 0 }).map((s) => s.id)).toEqual(['coinbase', 'bitstamp', 'kraken']);
    expect(DEFAULT_PRIORITY).toEqual(['coinbase', 'bitstamp', 'kraken']); expect(DEFAULT_QUALITY.priority).toEqual(['coinbase', 'bitstamp', 'kraken']);
    const { config } = await import('../src/config.ts');
    expect(config.apibricks).toMatchObject({ key: '', dailyCredits: 100, marketDailyCredits: 25, quoteDailyCredits: 30, priceTtlMs: 1_800_000, failoverTtlMs: 300_000, divergenceBps: 100, marketIntervals: ['1d'] });
  });
  it('capabilities: the variable NAME when the key is missing, never a value when it is set', () => {
    const off = capabilities({}).find((c) => c.id === 'market_data_apibricks')!;
    expect(off).toMatchObject({ on: false, missing: ['APIBRICKS_API_KEY'] }); expect(off.why).toMatch(/^needsKey — APIBRICKS_API_KEY is not set: CoinGecko stays the only price source/);
    expect(capabilitiesLine(capabilities({}))).toContain('market_data_apibricks=OFF(missing APIBRICKS_API_KEY)');
    const on = capabilities({ APIBRICKS_API_KEY: FAKE_KEY, APIBRICKS_DAILY_CREDITS: '250' });
    expect(on.find((c) => c.id === 'market_data_apibricks')).toMatchObject({ on: true, missing: [] });
    expect(JSON.stringify(on) + capabilitiesLine(on)).not.toContain(FAKE_KEY.slice(4)); expect(capabilitiesLine(on)).toContain('market_data_apibricks=on');
  });
  it('with a key: the three uses share one budget; the status shows the counter and says `down: quota` when it is spent', async () => {
    const s = scripted([fx('rates-usd').body]), ab = mod.createApiBricks({ ...cfg(FAKE_KEY), dailyCredits: 2 }, { fetch: s.fetch, now: () => T0 })!;
    expect(ab.market).toMatchObject({ id: 'apibricks', intervals: ['1d'], historyBars: 300 });
    expect(Object.keys(ab.market!.pairs).sort()).toEqual(['AVAX', 'BTC', 'DOGE', 'ETH', 'LINK', 'LTC', 'SOL', 'XRP']);     // the base set ∩ independent series
    expect(ab.status()).toMatchObject({ configured: true, needsKey: false, host: 'rest.coinapi.io', status: 'idle', reason: null, budget: { ceiling: 2, used: 0, caps: { market: 25, quotes: 30 } }, market: { on: true, intervals: ['1d'] } });
    expect(JSON.stringify(ab.status()) + JSON.stringify(ab.cfg)).not.toContain(FAKE_KEY.slice(4));
    await ab.prices.read(); expect(ab.status()).toMatchObject({ status: 'ok', budget: { used: 1, remaining: 1, by: { prices: 1 } }, prices: { mapped: Object.keys(ASSET_MAP).length, reads: 1 } });
    await ab.prices.read({ maxAgeMs: 0 }); await ab.prices.read({ maxAgeMs: 0 });
    expect(ab.status()).toMatchObject({ status: 'down', reason: 'quota', budget: { used: 2, remaining: 0, exhausted: true } });
    expect(s.calls).toHaveLength(2);
    expect(mod.createApiBricks({ ...cfg(FAKE_KEY), marketIntervals: [] })!.market).toBeNull();                           // APIBRICKS_MARKET_INTERVALS=off
  });
});

// ---------------------------------------------------------------------------------------------------------------- quote hub
describe('quote hub: the metered spot source', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });
  type Answer = Awaited<ReturnType<SecondSpotSource['read']>>;
  function fake(o: { has: string[]; room?: () => boolean }) {
    const st = { reads: 0, next: null as Answer | Error | null };
    const src: SecondSpotSource = { source: 'apibricks-rest', pollMs: 300_000, staleAfterMs: 900_000, available: (s) => o.has.includes(s) && (o.room?.() ?? true),
      read: async () => { st.reads += 1; if (st.next instanceof Error) throw st.next; return st.next ?? { down: true, reason: 'no_data', detail: 'nothing scripted' }; }, stats: () => ({ budget: { used: st.reads, ceiling: 30 } }) };
    return { src, st };
  }
  const pairs = (s: string) => ({ BTC: 'BTC-USD' } as Record<string, string>)[s];
  const px = (usd: number, priceAt: string, stale = false): Answer => ({ prices: { TON: { usd, priceAt, stale } } });

  it('same normalised quote, source named, own cadence; reference-counted polling; nothing invented', async () => {
    const f = fake({ has: ['TON'] }); f.st.next = px(1.0331, '2026-11-17T07:59:30.000Z');
    const up = spotUpstream({ pairs, second: f.src, prices: async () => ({ JUP: { usd: 0.25, priceAt: '2026-11-17T07:58:00.000Z', stale: false } }) });
    const hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect();
    await hub.validate({ type: 'quote', id: 'spot:TON' });
    const other = collect(), sub = hub.subscribe({ type: 'quote', id: 'spot:TON' }, c.on), sub2 = hub.subscribe({ type: 'quote', id: 'spot:TON' }, other.on);
    expect(sub.info).toEqual({ source: 'apibricks-rest', transport: 'poll', staleAfterMs: 900_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.st.reads).toBe(1);                                                                                         // two subscribers, ONE feed
    expect(c.of('quote')[0]).toMatchObject({ id: 'spot:TON', last: '1.0331', bid: null, ask: null, mid: null, mark: null, change24h: null, venueTs: Date.parse('2026-11-17T07:59:30.000Z'), source: 'apibricks-rest', stale: false });
    await vi.advanceTimersByTimeAsync(300_000); expect(f.st.reads).toBe(2); expect(new Set(c.of('quote').map((q) => q.last))).toEqual(new Set(['1.0331']));   // same price, same date: not a new quote
    f.st.next = px(1.0402, '2026-11-17T08:09:30.000Z'); await vi.advanceTimersByTimeAsync(300_000);
    expect(c.of('quote').at(-1)).toMatchObject({ last: '1.0402', venueTs: Date.parse('2026-11-17T08:09:30.000Z'), source: 'apibricks-rest' });
    // a symbol it does not have is polled from the price module, as before
    const g = collect(); expect(hub.subscribe({ type: 'quote', id: 'spot:JUP' }, g.on).info).toMatchObject({ source: 'coingecko-rest' });
    expect((up.stats!() as any).second).toMatchObject({ source: 'apibricks-rest', symbols: 1, status: 'connected', reason: null, budget: { ceiling: 30 } });
    sub.unsubscribe(); await vi.advanceTimersByTimeAsync(300_000); const before = f.st.reads;                                 // one subscriber left: still polled
    expect(before).toBeGreaterThan(3);
    sub2.unsubscribe(); await vi.advanceTimersByTimeAsync(60_000);                                                            // the hub keeps an idle feed for its grace time, then closes it
    const idle = f.st.reads; await vi.advanceTimersByTimeAsync(1_200_000); expect(f.st.reads).toBe(idle);                // nobody listens: nothing is asked (no credit spent)
    hub.close();
  });
  it('budget spent → `down` with the reason `quota`: on the venue, on the channel and in the statistics — never silent', async () => {
    const f = fake({ has: ['TON'] }); f.st.next = px(1.0331, '2026-11-17T07:59:30.000Z');
    const up = spotUpstream({ pairs, second: f.src }), hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect(), st = collect();
    hub.subscribe({ type: 'status', id: 'spot' }, st.on); hub.subscribe({ type: 'quote', id: 'spot:TON' }, c.on);
    await vi.advanceTimersByTimeAsync(0); expect(hub.statuses()[0]).toMatchObject({ venue: 'spot', status: 'connected' });
    f.st.next = { down: true, reason: 'quota', detail: 'the daily budget is exhausted (30 of 30 credits used): not called' };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(hub.statuses()[0]).toMatchObject({ venue: 'spot', status: 'down', detail: 'quota' });
    expect(st.of('status').at(-1)).toMatchObject({ status: 'down', detail: 'quota' });
    expect((up.stats!() as any).second).toMatchObject({ status: 'down', reason: 'quota', failures: 1 });
    expect(hub.stats().venues.find((v) => v.venue === 'spot')).toMatchObject({ status: 'down', errors: 1 }); expect(hub.stats().venues[0]!.lastError).toMatch(/^apibricks-rest: quota/);
    expect(c.of('quote')).toHaveLength(1);                                                                              // no quote is made up while it is down
    // a new day: the same feed comes back by itself
    f.st.next = px(1.05, '2026-11-18T00:04:00.000Z'); await vi.advanceTimersByTimeAsync(300_000);
    expect(hub.statuses()[0]).toMatchObject({ status: 'connected' }); expect(c.of('quote').at(-1)).toMatchObject({ last: '1.05' });
    hub.close();
  });
  it('isolated: its failure touches neither the Coinbase stream nor the price-module symbols; with no room in the budget a NEW channel uses the price module', async () => {
    let room = true; const f = fake({ has: ['TON', 'TRX'], room: () => room }); f.st.next = new Error('socket hang up');
    const up = spotUpstream({ pairs, second: f.src, prices: async () => ({ JUP: { usd: 0.25, priceAt: '2026-11-17T07:58:00.000Z', stale: false }, TRX: { usd: 0.3, priceAt: '2026-11-17T07:58:00.000Z', stale: false } }) });
    const hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), a = collect(), b = collect(), d = collect();
    hub.subscribe({ type: 'quote', id: 'spot:TON' }, a.on); hub.subscribe({ type: 'quote', id: 'spot:JUP' }, b.on);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.of('quote')).toHaveLength(0); expect(b.of('quote')[0]).toMatchObject({ last: '0.25', source: 'coingecko-rest' });
    expect((up.stats!() as any).second).toMatchObject({ status: 'stale', reason: 'error', detail: 'socket hang up' });
    room = false;                                                                                                       // the budget has no room left
    expect(hub.subscribe({ type: 'quote', id: 'spot:TRX' }, d.on).info).toMatchObject({ source: 'coingecko-rest' });
    await vi.advanceTimersByTimeAsync(0); expect(d.of('quote')[0]).toMatchObject({ last: '0.3', source: 'coingecko-rest' });
    expect(up.info({ kind: 'ticker', symbol: 'TON' })).toMatchObject({ source: 'apibricks-rest' });                      // an open channel keeps the source it was opened on
    hub.close();
  });
  it('without a second source the upstream is what it was', async () => {
    const up = spotUpstream({ pairs, prices: async () => ({ TON: { usd: 1.03, priceAt: '2026-11-17T07:58:00.000Z', stale: false } }) });
    expect(up.info({ kind: 'ticker', symbol: 'TON' })).toMatchObject({ source: 'coingecko-rest' }); expect(up.stats!()).not.toHaveProperty('second');
  });
});
