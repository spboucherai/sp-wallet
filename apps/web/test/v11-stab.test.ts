/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/v11-stab.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-19
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

// V11 stabilisation, web side — pure pieces and source checks (no browser):
//  B1 the hero shows what is executed · B2 "signed, not sent" keyed on the state · B3 server texts by code, both languages,
//  one `sv` block · B6 the executor and the quote reference come from the displayed route · the unified execution timeline ·
//  the price freshness indicator.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepDraw, stepReasonKey } from '../src/execution';
import { freshnessText } from '../src/freshness';
import { stateKey, type Key } from '../src/i18n';
import { ago, execReason, flagDetail, holdDetail, pauseText, propError, svText } from '../src/sv';
import { executorOf, heroOf, prepareOf, type BridgeOption, type HeroRoute } from '../src/swapLogic';
import { testNotSent } from '../src/ui';
import { SV } from '../../../services/api/src/sv-texts.ts';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// the translator of the tests: the key and its variables, so that assertions do not depend on wording
const t = (k: Key, v?: Record<string, string | number>) => (v && Object.keys(v).length ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : String(k));
const I18N = src('../src/i18n.ts');
/** every `key: ['fr', 'en']` entry of the dictionary, in source order */
const ENTRIES = [...I18N.matchAll(/(?:^|[\s,{])([A-Za-z][A-Za-z0-9_]*): \[('(?:[^'\\]|\\.)*'), ('(?:[^'\\]|\\.)*')\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!.slice(1, -1), en: m[3]!.slice(1, -1) }));
const DICT = new Map(ENTRIES.map((e) => [e.key, e]));
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('B3 — server texts: one catalogue on the server, one text per code in both languages', () => {
  it('every code of services/api/src/sv-texts.ts has an `sv_<code>` text, FR and EN, with exactly the server\'s parameters', () => {
    expect(Object.keys(SV).length).toBeGreaterThan(50);
    for (const [code, english] of Object.entries(SV)) {
      const e = DICT.get(`sv_${code}`);
      expect(e, `sv_${code}`).toBeDefined();
      expect(e!.fr.length, code).toBeGreaterThan(3); expect(e!.en.length, code).toBeGreaterThan(3);
      expect(holes(e!.fr), `${code} (fr)`).toEqual([...new Set(holes(english))].sort());
      expect(holes(e!.en), `${code} (en)`).toEqual([...new Set(holes(english))].sort());
    }
    // and no orphan: an `sv_<code>` text without a server code would never be shown
    for (const e of ENTRIES) if (e.key.startsWith('sv_')) expect(Object.hasOwn(SV, e.key.slice(3)), e.key).toBe(true);
  });
  it('the `sv` keys are ONE contiguous block, and French is not a copy of English', () => {
    const idx = ENTRIES.map((e, k) => (e.key.startsWith('sv') ? k : -1)).filter((k) => k >= 0);
    expect(idx.length).toBeGreaterThan(120);
    expect(idx[idx.length - 1]! - idx[0]! + 1).toBe(idx.length);                       // nothing else in between
    expect(I18N.indexOf('// >>> `sv` block')).toBeGreaterThan(I18N.indexOf('// <<< end of the `dz` block'));
    const same = ENTRIES.filter((e) => e.key.startsWith('sv') && e.fr === e.en).map((e) => e.key);
    expect(same.sort()).toEqual(['svCardBps', 'svHeroCctp']);                            // figures and a proper name only
    for (const e of ENTRIES) if (e.key.startsWith('sv')) expect(holes(e.fr), e.key).toEqual(holes(e.en)); // same parameters in both languages
  });
  it('a known code is translated with its parameters; an unknown one shows the server\'s sentence; the English is never appended to a translation', () => {
    expect(svText(t, 'swap_would_revert', { detail: 'K' }, 'the swap would revert now (K); it was not sent')).toBe('sv_swap_would_revert(detail=K)');
    expect(svText(t, 'pending_tx', null, 'a previous transfer…')).toBe('e_pending_tx');           // an API error code has its own text
    expect(svText(t, 'a_code_newer_than_this_bundle', null, 'what the server said')).toBe('what the server said');
    expect(svText(t, null, null, 'an old row without a code')).toBe('an old row without a code');
    expect(svText(t, 'never_heard', null, null)).toBe('never_heard'); expect(svText(t, null, null)).toBe('');
    expect(propError(t, { error: 'rejected by owner', errorCode: 'rejected_by_owner', errorParams: null })).toBe('sv_rejected_by_owner');
    expect(propError(t, { error: 'legacy sentence' })).toBe('legacy sentence'); expect(propError(t, null)).toBe('');
  });
  it('holds, risk flags, executability reasons and plan pauses are built from codes and parameters', () => {
    expect(holdDetail(t, { holdCode: 'hold_destination_gas', holdParams: { sym: 'ETH', net: 'Base', need: '0.001', have: '0' }, holdDetail: 'add ETH on Base…' })).toBe('sv_hold_destination_gas(sym=ETH,net=Base,need=0.001,have=0)');
    expect(holdDetail(t, { holdCode: 'hold_technical', holdParams: { detail: 'rpc http 502' }, holdDetail: 'rpc http 502' })).toBe('sv_hold_technical(detail=rpc http 502)');
    expect(holdDetail(t, { holdDetail: 'a row from before v11' })).toBe('a row from before v11');
    expect(flagDetail(t, { code: 'below_market', detail: 'output worth 96.2 % of input', params: { pct: 96.2 } })).toBe('svFlagD_below_market(pct=96.2)');
    expect(flagDetail(t, { code: 'price_impact', detail: '120 bps', params: { bps: 120 } })).toBe('svFlagD_price_impact(bps=120)');
    expect(flagDetail(t, { code: 'opaque_transaction', detail: 'KyberSwap returns…', params: { reasonCode: 'kyber_calldata' } })).toBe('svExec_kyber_calldata');
    expect(flagDetail(t, { code: 'not_executable', detail: 'a provider newer than this bundle', params: { reasonCode: 'something_new' } })).toBe('a provider newer than this bundle');
    expect(flagDetail(t, { code: 'cross_chain' })).toBe('');                                       // the flag's own label says it all
    expect(flagDetail(t, { code: 'a_new_flag', detail: 'x', params: { n: 2 } })).toBe('');         // parameters without a text: never half a sentence
    expect(execReason(t, { class: 'quote_only', code: 'comparison_only', reason: '0x is a price comparison source…' })).toBe('svExec_comparison_only');
    expect(execReason(t, { class: 'opaque', reason: 'no code' })).toBe('no code'); expect(execReason(t, { class: 'verified' })).toBe('');
    expect(pauseText(t, { code: 'floor', message: 'the final result…', params: { estimate: '1', sym: 'LINK', floor: '5' } })).toBe('sv_plan_floor(estimate=1,sym=LINK,floor=5)');
    expect(pauseText(t, { code: 'no_funds', message: '…', params: { sym: 'USDC', net: 'Base' } })).toBe('sv_plan_no_funds(sym=USDC,net=Base)');
    expect(pauseText(t, { code: 'leg_failed', message: 'the swap would revert now (K); it was not sent', reason: { code: 'swap_would_revert', params: { detail: 'K' } } })).toBe('sv_swap_would_revert(detail=K)');
    expect(pauseText(t, { code: 'refused', message: 'rejected by owner', reason: { code: 'rejected_by_owner' } })).toBe('sv_rejected_by_owner');
    expect(pauseText(t, { code: 'insufficient_gas', message: 'not enough ETH on Base…', reason: { code: 'insufficient_gas' } })).toBe('e_insufficient_gas'); // the refusal of the preparation route
    expect(pauseText(t, { code: 'leg_failed', message: 'a plan paused before v11' })).toBe('a plan paused before v11');
  });
  it('the screens no longer print the server\'s sentence where a code exists', () => {
    const swap = src('../src/screens/Swap.tsx'), bridge = src('../src/bridge.tsx'), xswap = src('../src/xswap.tsx'), plan = src('../src/plan.tsx'), act = src('../src/screens/Activity.tsx'), fund = src('../src/screens/AgentFund.tsx');
    expect(swap).not.toMatch(/\{prop\.error\}/); expect(swap.match(/propError\(t, prop\)/g)!.length).toBe(2);
    expect(swap).not.toMatch(/\{f\.detail\}/); expect(swap).not.toMatch(/r\.executability\.reason \?/);
    expect(bridge).not.toMatch(/>\{b\.holdDetail\}</); expect(xswap).not.toMatch(/>\{x\.holdDetail\}</); expect(xswap).not.toMatch(/\{prop\.error\}/);
    expect(plan).not.toMatch(/\{p\.pause\.message\}/); expect(plan).not.toMatch(/\{a\.error\}/); expect(plan).not.toMatch(/skipped\[0\]!\.message\}/);
    expect(act).not.toMatch(/\{i\.error\}/); expect(fund).not.toMatch(/\{l\.txError\}/);
  });
});

describe('B2 — "signed, not sent" is read from the state, never from the wording of a sentence', () => {
  it('testNotSent: the terminal state not_broadcast (or its code); a transfer really in flight is not it', () => {
    expect(testNotSent({ state: 'not_broadcast' })).toBe(true);
    expect(testNotSent({ state: 'not_broadcast', errorCode: 'broadcast_disabled' })).toBe(true);
    expect(testNotSent({ state: 'broadcast' })).toBe(false);
    expect(testNotSent({ state: 'broadcast', error: 'broadcast disabled (test mode)' } as never)).toBe(false); // the old sentence means nothing any more
    expect(testNotSent({ state: 'failed', errorCode: 'swap_would_revert' })).toBe(false);
    expect(testNotSent(null)).toBe(false); expect(testNotSent(undefined)).toBe(false);
    expect(stateKey('not_broadcast')).toBe('qaSignedNotSent'); expect(stateKey('broadcast')).toBe('s_broadcast');
  });
  it('no regular expression on the server\'s English sentence is left in the app', () => {
    for (const f of ['../src/ui.tsx', '../src/screens/AgentFund.tsx', '../src/screens/Swap.tsx', '../src/screens/Send.tsx', '../src/screens/Home.tsx', '../src/screens/Activity.tsx'])
      expect(src(f), f).not.toMatch(/broadcast disabled/i);
    expect(src('../src/screens/AgentFund.tsx')).toMatch(/const NOT_SENT = 'not_broadcast'/);
  });
});

describe('B1 / B6 — what is shown is what is executed', () => {
  const route = (id: string, o: Partial<HeroRoute> = {}): HeroRoute => ({ id, executable: false, executor: null, providers: [id], amountOutDisplay: '0', minAmountOutDisplay: '0', valuation: { outUsd: null }, ...o });
  const kyber = route('kyberswap', { executable: true, executor: 'kyberswap', amountOutDisplay: '19.90', minAmountOutDisplay: '19.80', valuation: { outUsd: 19.9 }, fingerprint: 'a'.repeat(32), amountOut: '19900000', minAmountOut: '19800500', quotedAt: 1_800_000_000_000 });
  const lifi = route('lifi', { amountOutDisplay: '20.40', minAmountOutDisplay: '20.30' });
  const zerox = route('zerox', { amountOutDisplay: '20.10', minAmountOutDisplay: '20.00' });
  const std: BridgeOption = { speed: 'standard', available: true, minReceiveDisplay: '10', quote: { id: 'cctp-standard', provider: 'cctp', fingerprint: 'c'.repeat(32), amountOut: '10000000', minAmountOut: '10000000', quotedAt: 1 } };
  const PAIR = { from: { network: 'base', asset: 'native' }, to: { network: 'base', asset: '0xUSDC' }, amount: '0.01', slippageBps: 50, speed: 'standard' as const };

  it('B1 (CCTP pair): the hero is the SELECTED CCTP option — not LI.FI\'s better quote, not the other speed', () => {
    const fastQuote = route('cctp', { executable: true, executor: 'cctp', exec: { via: 'cctp', speed: 'fast' }, amountOutDisplay: '9.9987', minAmountOutDisplay: '9.9987' });
    const h = heroOf({ isBridge: true, option: std, sorted: [lifi, fastQuote] });
    expect(h.hero).toEqual({ source: 'cctp', out: '10', min: '10', usd: null, provider: 'cctp' });
    expect(h.bestOther).toBeNull();
    expect(heroOf({ isBridge: true, option: { ...std, speed: 'fast', minReceiveDisplay: '9.9987' }, sorted: [lifi] }).hero!.out).toBe('9.9987');
    expect(heroOf({ isBridge: true, option: { ...std, available: false }, sorted: [lifi] }).hero).toBeNull();   // an unavailable option is never shown as an amount
    expect(heroOf({ isBridge: true, option: undefined, sorted: [lifi] }).hero).toBeNull();                      // the CCTP quote has not answered yet: no figure, not LI.FI's
  });
  it('B1 (same-network pair): the hero is the executable route even when a comparison-only quote ranks first, which is named separately', () => {
    const h = heroOf({ isBridge: false, sorted: [lifi, zerox, kyber] });
    expect(h.hero).toEqual({ source: 'kyberswap', out: '19.90', min: '19.80', usd: 19.9, provider: 'kyberswap' });
    expect(h.ex!.id).toBe('kyberswap'); expect(h.bestOther!.id).toBe('lifi');
    expect(heroOf({ isBridge: false, sorted: [kyber, lifi] })).toMatchObject({ hero: { out: '19.90' }, bestOther: null });   // the executable route IS the best: nothing else to say
    // nothing executable here: no amount in the hero at all; the best quote is a comparison
    expect(heroOf({ isBridge: false, sorted: [lifi, zerox] })).toMatchObject({ hero: null, ex: null, bestOther: { id: 'lifi' } });
    expect(heroOf({ isBridge: false, sorted: [] })).toEqual({ hero: null, ex: null, bestOther: null });
  });
  it('B6: the executor is the one the server stated on the route; a route that only CLAIMS to be executable without one is not', () => {
    expect(executorOf(kyber)).toBe('kyberswap');
    expect(executorOf(route('x', { executable: true, exec: { via: 'jupiter' } }))).toBe('jupiter');   // the older field carries the same fact
    expect(executorOf(route('x', { executable: true }))).toBeNull();
    expect(executorOf(route('x', { executable: false, executor: 'kyberswap' }))).toBeNull();
    expect(executorOf(null)).toBeNull();
  });
  it('B6: the request prepares the displayed route, through its executor, with its reference', () => {
    expect(prepareOf({ ...PAIR, isBridge: false, ex: kyber })).toEqual({ via: 'kyberswap', path: '/swap/proposals', body: { network: 'base', fromAsset: 'native', toAsset: '0xUSDC', amount: '0.01', slippageBps: 50,
      quote: { id: 'kyberswap', provider: 'kyberswap', fingerprint: 'a'.repeat(32), amountOut: '19900000', minAmountOut: '19800500', quotedAt: 1_800_000_000_000 } } });
    const thor = route('thorchain', { executable: true, executor: 'thorchain', fingerprint: 'b'.repeat(32), amountOut: '5', minAmountOut: '4', quotedAt: 7 });
    const x = prepareOf({ from: { network: 'bitcoin', asset: 'native' }, to: { network: 'ethereum', asset: 'native' }, amount: '0.0006', slippageBps: 100, speed: 'standard', isBridge: false, ex: thor })!;
    expect(x).toMatchObject({ via: 'thorchain', path: '/xswap/proposals', body: { fromNetwork: 'bitcoin', toNetwork: 'ethereum', quote: { provider: 'thorchain', fingerprint: 'b'.repeat(32) } } });
    // THORChain timed out in this search: there is no executable route — nothing is posted (before v11: a POST to /swap/proposals, answered swap_not_enabled)
    expect(prepareOf({ from: { network: 'bitcoin', asset: 'native' }, to: { network: 'ethereum', asset: 'native' }, amount: '0.0006', slippageBps: 100, speed: 'standard', isBridge: false, ex: null })).toBeNull();
    expect(prepareOf({ ...PAIR, isBridge: false, ex: lifi })).toBeNull();                              // a comparison-only route is never prepared
    // a CCTP pair: the selected option's own reference
    expect(prepareOf({ ...PAIR, to: { network: 'arbitrum', asset: '0xUSDC' }, isBridge: true, option: std, ex: null })).toEqual({ via: 'cctp', path: '/bridge/proposals', body: { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '0.01', speed: 'standard', quote: std.quote } });
    expect(prepareOf({ ...PAIR, isBridge: true, option: { ...std, quote: null }, ex: null })!.body).not.toHaveProperty('quote');
    // a route without a fingerprint (an API older than this bundle): prepared as before, without a reference
    expect(prepareOf({ ...PAIR, isBridge: false, ex: { ...kyber, fingerprint: undefined } })!.body).not.toHaveProperty('quote');
  });
  it('the Swap screen uses these two functions, sends one Idempotency-Key per attempt, and no longer infers THORChain from the stream', () => {
    const swap = src('../src/screens/Swap.tsx');
    expect(swap).toMatch(/heroOf\(\{ isBridge/); expect(swap).toMatch(/prepareOf\(\{ from, to/);
    expect(swap).not.toMatch(/chosen\.amountOutDisplay/); expect(swap).not.toMatch(/chosen\.minAmountOutDisplay/);
    expect(swap).not.toMatch(/exec\?\.via === 'thorchain' && !routes\.some/);
    expect(swap.match(/crypto\.randomUUID\(\)/g)!.length).toBe(1);                                    // one key, kept while the same request is unanswered
    expect(swap).toMatch(/if \(!answerLost\(e\)\) attempt\.current = null/);                            // NEXT W1: kept after ANY lost answer (time-out, network, 5xx), not only `offline`
    expect(swap).toMatch(/data-testid="route-facts"/); expect(swap).toMatch(/svCardNotReported/);    // the normalized card, with "not reported" instead of a zero
  });
});

describe('unified execution status, drawn with the shared Timeline', () => {
  it('each state has one drawing; a refund and an unknown outcome are never drawn as done', () => {
    expect((['pending', 'awaiting_approval', 'signing', 'broadcast', 'confirming', 'confirmed', 'failed', 'refunded', 'unknown'] as const).map(stepDraw))
      .toEqual(['next', 'current', 'current', 'current', 'current', 'done', 'failed', 'failed', 'next']);
    for (const s of ['pending', 'awaiting_approval', 'signing', 'broadcast', 'confirming', 'confirmed', 'failed', 'refunded', 'unknown']) expect(DICT.has(`svExState_${s}`), s).toBe(true);
    for (const k of ['approval', 'send', 'swap', 'burn', 'attestation', 'mint', 'deposit', 'observation', 'outbound', 'order']) expect(DICT.has(`svExStep_${k}`), k).toBe(true);
  });
  it('a step that waits says why with the hold\'s own text; an error code is left to the sheet (it has parameters)', () => {
    expect(stepReasonKey('destination_gas')).toBe('brHold_destination_gas'); expect(stepReasonKey('not_observed')).toBe('xsHold_not_observed');
    expect(stepReasonKey('swap_would_revert')).toBeNull(); expect(stepReasonKey(null)).toBeNull();
  });
  it('it is rendered by the existing Timeline on the swap sheet, in a plan leg and in Activity', () => {
    expect(src('../src/execution.tsx')).toMatch(/<Timeline label=\{t\('svExTitle'\)\}/);
    expect(src('../src/screens/Swap.tsx')).toMatch(/<ExecutionTimeline exec=\{prop\.execution\}/);
    expect(src('../src/plan.tsx')).toMatch(/<ExecutionTimeline exec=\{l\.execution\}/);
    expect(src('../src/screens/Activity.tsx')).toMatch(/<ExecutionTimeline exec=\{i\.execution\}/);
  });
});

describe('resilience — what the owner is told', () => {
  it('price freshness: a coarse age, and a different sentence when the server says the price is stale', () => {
    const now = Date.parse('2026-11-15T12:00:00Z'), at = (s: number) => new Date(now - s * 1000).toISOString();
    expect(ago(t, at(20), now)).toBe('svAgoNow'); expect(ago(t, at(200), now)).toBe('svAgoMin(n=3)'); expect(ago(t, at(3 * 3600), now)).toBe('svAgoH(n=3)'); expect(ago(t, at(3 * 86400), now)).toBe('svAgoD(n=3)');
    expect(ago(t, null, now)).toBe('—'); expect(ago(t, new Date(now + 5000).toISOString(), now)).toBe('svAgoNow'); // a clock slightly ahead is not "in −5 s"
    expect(freshnessText(t, at(200), false, now)).toBe('svPriceAt(age=svAgoMin(n=3))');
    expect(freshnessText(t, at(1800), true, now)).toBe('svPriceStale(age=svAgoMin(n=30))');
  });
  it('Home, Assets and the asset page show it; Home and Receive say when the signer is unreachable', () => {
    for (const f of ['../src/screens/Home.tsx', '../src/screens/Assets.tsx', '../src/screens/Asset.tsx']) expect(src(f), f).toMatch(/<PriceFreshness /);
    const home = src('../src/screens/Home.tsx');
    expect(home).toMatch(/d\.signer && !d\.signer\.reachable/); expect(home).toMatch(/svSignerDown/);
    expect(home).toMatch(/action\('send', 'arrowUp', t\('send'\), false, block !== null\)/); expect(src('../src/hooks.ts')).toMatch(/p\.signer\?\.reachable === false \? 'signer'/);   // NEXT W5: one rule (sendBlock) for every screen                                       // sending is disabled while nothing can be signed
    expect(src('../src/screens/Receive.tsx')).toMatch(/signerReachable === false/);
  });
});
