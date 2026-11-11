// v10: the price feed helper. A refused request must not blank the prices for the whole TTL (the cause of « Prix désactivés »
// and of the missing daily change on a fresh stack), concurrent callers must share one request, and a stale value is served
// while the feed is down. Pure: a scripted fetch and a manual clock.
import { describe, expect, it } from 'vitest';
import { createGecko } from '../src/gecko.ts';

function feed(script: (number | unknown)[]) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => { calls.push(url); const next = script.length > 1 ? script.shift() : script[0];
    return typeof next === 'number' ? { ok: false, status: next, json: async () => ({}) } : { ok: true, status: 200, json: async () => next }; };
  return { calls, fetchJson };
}

describe('CoinGecko reads', () => {
  it('a refused request is retried once at once; the value is then cached for its TTL', async () => {
    let t = 1_000_000; const f = feed([429, [{ id: 'bitcoin' }]]), gecko = createGecko(f.fetchJson, { now: () => t, pauseMs: 1 });
    expect(await gecko('markets:usd', 240_000, '/coins/markets?x')).toEqual([{ id: 'bitcoin' }]);
    expect(f.calls).toHaveLength(2); expect(f.calls[0]).toBe('https://api.coingecko.com/api/v3/coins/markets?x');
    t += 239_000; await gecko('markets:usd', 240_000, '/coins/markets?x'); expect(f.calls).toHaveLength(2);
    t += 2_000; await gecko('markets:usd', 240_000, '/coins/markets?x'); expect(f.calls).toHaveLength(3);
  });
  it('a failure with no earlier value answers null for 15 s only — not for the TTL — then asks again', async () => {
    let t = 0; const f = feed([429, 429, 429, 429, [{ id: 'bitcoin' }]]), gecko = createGecko(f.fetchJson, { now: () => t, pauseMs: 1 });
    expect(await gecko('k', 240_000, '/p')).toBeNull(); expect(f.calls).toHaveLength(2);                // the call and its one retry
    t += 14_000; expect(await gecko('k', 240_000, '/p')).toBeNull(); expect(f.calls).toHaveLength(2);    // not hammered meanwhile
    t += 2_000; expect(await gecko('k', 240_000, '/p')).toBeNull(); expect(f.calls).toHaveLength(4);
    t += 16_000; expect(await gecko('k', 240_000, '/p')).toEqual([{ id: 'bitcoin' }]);                  // 32 s after the first refusal, not 240 s
  });
  it('the last good value is served while the feed is down', async () => {
    let t = 0; const f = feed([{ v: 1 }, 500, 500, 500, 500, { v: 2 }]), gecko = createGecko(f.fetchJson, { now: () => t, pauseMs: 1 });
    expect(await gecko('k', 60_000, '/p')).toEqual({ v: 1 });
    t += 61_000; expect(await gecko('k', 60_000, '/p')).toEqual({ v: 1 });
    t += 16_000; expect(await gecko('k', 60_000, '/p')).toEqual({ v: 1 });
    t += 16_000; expect(await gecko('k', 60_000, '/p')).toEqual({ v: 2 });
  });
  it('concurrent callers of one key share one request; different keys do not wait for each other', async () => {
    const f = feed([{ v: 1 }]), gecko = createGecko(f.fetchJson, { pauseMs: 1 });
    const [a, b, c] = await Promise.all([gecko('k', 1000, '/p'), gecko('k', 1000, '/p'), gecko('other', 1000, '/q')]);
    expect(a).toEqual({ v: 1 }); expect(b).toEqual({ v: 1 }); expect(c).toEqual({ v: 1 });
    expect(f.calls).toHaveLength(2);
  });
  it('a network error is a failure like another', async () => {
    const gecko = createGecko(async () => { throw new Error('ECONNRESET'); }, { pauseMs: 1 });
    expect(await gecko('k', 1000, '/p')).toBeNull();
  });
});
