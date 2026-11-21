/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/prices.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-15
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

// The signer's own price view against tickers recorded from Coinbase Exchange and Kraken (scripts/record-signer-tickers.mts).
// Both exchanges must answer and agree within 1 %; anything else is a refusal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_LISTINGS, hasSignerPrice } from '@spw/core';
import { exchangePrices, KRAKEN_STATUS_URL, pricedSymbols, type JsonGet } from '../src/prices.ts';

const rec = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tickers.json'), 'utf8')) as { recordedAt: string; symbols: string[]; responses: Record<string, any> };
const NOW = Date.parse(rec.recordedAt);
const CB = (pair: string) => `https://api.exchange.coinbase.com/products/${pair}/ticker`, KR = (pair: string) => `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
/** V11: Kraken's own statement that it is trading, dated by its clock. Not in the recording (made before the check existed): the shape is the one read from the public endpoint on 2026-11-16. */
const ST = KRAKEN_STATUS_URL, online = (at: number, status = 'online') => ({ error: [], result: { status, timestamp: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') } });
/** Serves the recorded answers; `over` replaces or removes one. Every URL asked is logged. */
function recorded(over: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const get: JsonGet = async (url) => { asked.push(url); const v = Object.hasOwn(over, url) ? over[url] : url === ST ? online(NOW) : rec.responses[url]; if (v === undefined || v === null) throw new Error('HTTP 404'); if (v instanceof Error) throw v; return structuredClone(v); };
  return { get, asked };
}
const mid = (url: string) => { const r = rec.responses[url]; if (url.includes('coinbase')) return (Number(r.ask) + Number(r.bid)) / 2; const row = Object.values(r.result)[0] as any; return (Number(row.a[0]) + Number(row.b[0])) / 2; };
const view = (over: Record<string, unknown> = {}, now = NOW) => { const r = recorded(over); return { v: exchangePrices(() => now, r.get), asked: r.asked }; };

describe("signer price view: more symbols, same rule", () => {
  it('prices every recorded symbol listed on both exchanges at the mean of the two mids, using the pair names of the reviewed table', async () => {
    const live = rec.symbols.filter((s) => hasSignerPrice(s));
    expect(live).toEqual(expect.arrayContaining(['ETH', 'BTC', 'LINK', 'AAVE', 'UNI', 'POL', 'HYPE', 'AVAX', 'BNB', 'XRP', 'DOGE']));
    for (const s of live) {
      if (s === 'USDT') continue;
      const l = MARKET_LISTINGS[s]!, { v, asked } = view();
      const got = await v.get([s]).then((p) => p[s]!, (e: Error) => e);
      const a = mid(CB(l.coinbase!)), b = mid(KR(l.kraken!));
      if (got instanceof Error) { expect(got.message, s).toMatch(/stale quote|abnormal spread|disagree/); continue; } // a thin book at recording time: refused, never guessed
      expect(asked.sort(), s).toEqual([CB(l.coinbase!), KR(l.kraken!), ST].sort()); // both, Kraken's status, and nothing else
      expect(got, s).toBeCloseTo((a + b) / 2, 10);
      expect(Math.abs(a - b) / Math.min(a, b), s).toBeLessThanOrEqual(0.01);
    }
    // the liquid ones must really have been priced by the loop above
    for (const s of ['ETH', 'BTC', 'LINK']) expect((await view().v.get([s]))[s]).toBeGreaterThan(0);
    expect((await view().v.get(['BTC'])).BTC).toBeCloseTo((mid(CB('BTC-USD')) + mid(KR('XBTUSD'))) / 2, 10); // Kraken's XBT
    expect((await view().v.get(['DOGE'])).DOGE).toBeCloseTo((mid(CB('DOGE-USD')) + mid(KR('XDGUSD'))) / 2, 10);
  });

  it('cash legs are worth one dollar only while the peg holds on the exchange(s)', async () => {
    const usdc = view();
    expect(await usdc.v.get(['USDC'])).toEqual({ USDC: 1 });
    expect(usdc.asked).toEqual([ST, KR('USDCUSD')]); // Kraken alone prices USDC: its status is asked first
    const usdt = view();
    expect(await usdt.v.get(['USDT'])).toEqual({ USDT: 1 });
    expect(usdt.asked.sort()).toEqual([CB('USDT-USD'), KR('USDTUSD'), ST].sort()); // both for USDT
    const off = (pair: string, p: string) => ({ error: [], result: { [pair]: { a: [p, '1', '1'], b: [p, '1', '1'] } } });
    await expect(view({ [KR('USDCUSD')]: off('USDCUSD', '0.9700') }).v.get(['USDC'])).rejects.toThrow(/off its peg/);
    await expect(view({ [KR('USDTUSD')]: off('USDTZUSD', '0.9850') }).v.get(['USDT'])).rejects.toThrow(/disagree|off its peg/);
    await expect(view({ [CB('USDT-USD')]: null }).v.get(['USDT'])).rejects.toThrow(/HTTP 404/);
  });

  it('fails closed: one source down, stale, malformed, or the two disagreeing by more than 1 %', async () => {
    const eth = rec.responses[CB('ETH-USD')], kr = rec.responses[KR('ETHUSD')], row = Object.values(kr.result)[0] as any;
    const krAt = (p: number) => ({ error: [], result: { XETHZUSD: { ...row, a: [p.toFixed(2), '1', '1'], b: [(p - 0.01).toFixed(2), '1', '1'] } } });
    const m = mid(CB('ETH-USD'));
    expect((await view({ [KR('ETHUSD')]: krAt(m * 1.009) }).v.get(['ETH'])).ETH).toBeGreaterThan(m); // 0.9 %: still agreeing
    await expect(view({ [KR('ETHUSD')]: krAt(m * 1.011) }).v.get(['ETH'])).rejects.toThrow(/price sources disagree on ETH/); // 1.1 %
    await expect(view({ [KR('ETHUSD')]: krAt(m * 0.9) }).v.get(['ETH'])).rejects.toThrow(/disagree/);
    await expect(view({ [KR('ETHUSD')]: null }).v.get(['ETH'])).rejects.toThrow(/HTTP 404/); // Kraken down
    await expect(view({ [CB('ETH-USD')]: new Error('timeout') }).v.get(['ETH'])).rejects.toThrow(/timeout/); // Coinbase down
    await expect(view({ [KR('ETHUSD')]: { error: ['EGeneral:Too many requests'] } }).v.get(['ETH'])).rejects.toThrow(/exchange error/);
    await expect(view({ [KR('ETHUSD')]: { error: [], result: { A: row, B: row } } }).v.get(['ETH'])).rejects.toThrow(/unexpected answer/);
    await expect(view({}, NOW + 10 * 60_000).v.get(['ETH'])).rejects.toThrow(/stale quote/); // ten minutes old
    await expect(view({ [CB('ETH-USD')]: { ...eth, ask: '0', bid: '0' } }).v.get(['ETH'])).rejects.toThrow(/bad price/);
    await expect(view({ [CB('ETH-USD')]: { ...eth, ask: String(Number(eth.bid) * 1.05) } }).v.get(['ETH'])).rejects.toThrow(/abnormal spread/);
    await expect(view({ [CB('ETH-USD')]: { ...eth, bid: 2000 } }).v.get(['ETH'])).rejects.toThrow(/bad price/); // a number where a string is specified
    // one bad symbol refuses the whole request (an order needs both of its prices)
    await expect(view({ [KR('LINKUSD')]: null }).v.get(['ETH', 'LINK'])).rejects.toThrow();
  });

  it('V11: a Kraken quote is used only while Kraken itself says it is online, in an answer dated within three minutes', async () => {
    expect((await view().v.get(['ETH'])).ETH).toBeGreaterThan(0);
    for (const status of ['maintenance', 'cancel_only', 'post_only', 'limit_only', '', 'ONLINE']) {
      await expect(view({ [ST]: online(NOW, status as string) }).v.get(['ETH']), String(status)).rejects.toThrow(/Kraken is not trading normally/);
      await expect(view({ [ST]: online(NOW, status as string) }).v.get(['USDC']), String(status)).rejects.toThrow(/Kraken is not trading normally/); // USDC rests on Kraken alone
    }
    await expect(view({ [ST]: online(NOW - 181_000) }).v.get(['USDC'])).rejects.toThrow(/stale quote/);          // an old (cached, replayed) answer
    await expect(view({ [ST]: online(NOW + 181_000) }).v.get(['ETH'])).rejects.toThrow(/stale quote/);           // or a signer clock that is minutes off
    expect((await view({ [ST]: online(NOW - 170_000) }).v.get(['USDC'])).USDC).toBe(1);
    await expect(view({ [ST]: { error: [], result: { status: 'online' } } }).v.get(['ETH'])).rejects.toThrow(/stale quote/); // no time, no trust
    await expect(view({ [ST]: { error: [], result: { status: 'online', timestamp: 1794787499 } } }).v.get(['ETH'])).rejects.toThrow(/stale quote/);
    await expect(view({ [ST]: { error: ['EService:Unavailable'] } }).v.get(['ETH'])).rejects.toThrow(/exchange error/);
    await expect(view({ [ST]: null }).v.get(['ETH'])).rejects.toThrow(/HTTP 404/);                                // status unreachable: no Kraken quote, so no price
    // a refusal is never remembered: the next request asks again; a positive answer is remembered 15 s, like a price
    let now = NOW, down = true; const r = recorded();
    const v = exchangePrices(() => now, async (url) => (url === ST && down ? online(now, 'maintenance') : r.get(url)));
    await expect(v.get(['ETH'])).rejects.toThrow(/not trading normally/);
    down = false; expect((await v.get(['ETH'])).ETH).toBeGreaterThan(0);
    down = true; now += 5_000; expect((await v.get(['LINK'])).LINK).toBeGreaterThan(0);        // inside the 15 s
    now += 16_000; await expect(v.get(['LINK'])).rejects.toThrow(/not trading normally/);
  });

  it('never prices a symbol that is not on both exchanges, whatever is asked', async () => {
    const { v, asked } = view();
    await expect(v.get(['EUR'])).rejects.toThrow(/no price source for EUR: it is not listed on coinbase/); // Bitstamp + Kraken only
    for (const s of ['WBTC', 'cbBTC', 'WETH', 'NOPE', 'eth', '', 'ETH-USD', 'constructor', '__proto__', '../x'])
      await expect(v.get([s]), s).rejects.toThrow(/no price source/); // wrappers are priced as their underlying by the signer, never by ticker
    expect(asked).toEqual([]); // nothing was even requested
    expect(pricedSymbols()).toEqual(expect.arrayContaining(['ETH', 'BTC', 'USDC', 'USDT', 'UNI']));
    expect(pricedSymbols()).not.toContain('EUR');
    for (const s of pricedSymbols()) if (s !== 'USDC') expect(hasSignerPrice(s), s).toBe(true);
  });

  it('caches a price for 15 seconds, per symbol', async () => {
    let now = NOW; const r = recorded(), v = exchangePrices(() => now, r.get);
    await v.get(['ETH']); await v.get(['ETH', 'ETH']);
    expect(r.asked).toHaveLength(3); // the two tickers and Kraken's status
    now += 16_000; await v.get(['ETH']);
    expect(r.asked).toHaveLength(6); // all three again
  });
});
