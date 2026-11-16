// Pure pieces of the QA/polish pass of 2026-11-11: who issues a registry deployment, what an API error says, what
// "signed but never broadcast" means, and locale-aware numbers.
import { describe, expect, it } from 'vitest';
import { errText, type Key } from '../src/i18n';
import { issuerOf, LIQUID_HINT } from '../src/issuer';
import { numFmt, testNotSent, trimAmt } from '../src/ui';

// the translator of the tests: the key and its variables, so that assertions do not depend on wording
const t = (k: Key, v?: Record<string, string | number>) => (v ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : String(k));

describe('issuerOf', () => {
  it('reads the issuer of a pegged token from the deployment name, whatever its ticker', () => {
    expect(issuerOf(t, 'ETH', 'Binance-Peg Ethereum')).toEqual({ kind: 'pegged', text: 'qaIssBinancePeg' });
    expect(issuerOf(t, 'USDC', 'Binance-Peg USD Coin')?.kind).toBe('pegged');
    expect(issuerOf(t, 'USDT', 'Binance-Peg BSC-USD (USDT)')?.kind).toBe('pegged');
    expect(issuerOf(t, 'BTCB', 'Binance-Peg BTCB')).toEqual({ kind: 'pegged', text: 'qaIss_BTCB' });       // the custodian sentence of the reviewed table
  });
  it('names the bridge of a bridged token', () => {
    expect(issuerOf(t, 'USDT', 'Bridged USDT (Base Standard Bridge)')).toEqual({ kind: 'bridged', text: 'qaIssBridged(bridge=Base Standard Bridge)' });
    expect(issuerOf(t, 'USDC.e', 'Bridged USDC (Arbitrum bridge)')?.text).toBe('qaIssBridged(bridge=Arbitrum Bridge)');
  });
  it('keeps the custodian of a reviewed wrapper and adds the bridge it came through', () => {
    expect(issuerOf(t, 'WBTC', 'Wrapped Bitcoin')).toEqual({ kind: 'wrapped', text: 'qaIss_WBTC(sym=WBTC,under=BTC)' });
    expect(issuerOf(t, 'WBTC', 'Wrapped BTC (Arbitrum bridge)')?.text).toBe('qaIss_WBTC(sym=WBTC,under=BTC) ; qaIssVia(bridge=Arbitrum Bridge)');
    expect(issuerOf(t, 'cbXRP', 'Coinbase Wrapped XRP')?.text).toBe('qaIss_cb(sym=cbXRP,under=XRP)');
    expect(issuerOf(t, 'EURC', 'EURC')?.kind).toBe('pegged');
  });
  it('says nothing about an original issue or a native coin', () => {
    for (const [sym, name] of [['USDC', 'USD Coin'], ['USDT', 'Tether USD'], ['LINK', 'Chainlink'], ['ETH', 'Ether'], ['AERO', 'Aerodrome']] as const) expect(issuerOf(t, sym, name)).toBeNull();
  });
  it('falls back to the server sentence for a wrapper it does not know', () => expect(issuerOf(t, 'xFOO', 'Foo', 'someone (custodian)')).toEqual({ kind: 'wrapped', text: 'someone (custodian)' }));
  it('the liquidity hint is a hint: BTCB on BNB Chain, nothing else', () => expect(LIQUID_HINT).toEqual({ bsc: { BTC: 'BTCB' } }));
});

describe('errText', () => {
  const e = (code: string, message: string) => ({ code, message });
  it('a translated code speaks for itself; the English detail is kept only when it carries a figure', () => {
    expect(errText(t, e('bad_address', 'invalid Base address: invalid EVM address'))).toBe('e_bad_address');
    expect(errText(t, e('bad_address', 'invalid Solana address: Unknown letter "0". Allowed: 123456789ABC'))).toBe('e_bad_address');
    expect(errText(t, e('insufficient_funds', 'balance 3.5 USDC, needed 5'))).toBe('e_insufficient_funds (balance 3.5 USDC, needed 5)');
    expect(errText(t, e('insufficient_funds', 'insufficient balance'))).toBe('e_insufficient_funds');
  });
  it('an unknown code still shows what the server said', () => expect(errText(t, e('never_heard_of_it', 'something specific'))).toBe('something specific'));
  it('a generic server failure is not shown as "internal error"', () => expect(errText(t, e('internal', 'internal error'))).toBe('e_internal'));
  it('an account that is not activated yet is explained', () => expect(errText(t, e('insufficient_funds', "this wallet's XRP account is not activated yet: it must first receive at least 1 XRP"))).toBe('qaErrNotActivated'));
  it('a cancelled passkey prompt is silent', () => expect(errText(t, { name: 'NotAllowedError' })).toBe(''));
});

describe('display helpers', () => {
  it('signed on a server that does not broadcast is not "sent"', () => {
    // v11 (B2): the server gives such a transfer its own terminal state; the app reads the state, not the wording of an English sentence
    expect(testNotSent({ state: 'not_broadcast', errorCode: 'broadcast_disabled' })).toBe(true);
    expect(testNotSent({ state: 'broadcast', errorCode: null })).toBe(false);
    expect(testNotSent({ state: 'failed', errorCode: 'swap_would_revert' })).toBe(false);
    expect(testNotSent(null)).toBe(false);
  });
  it('numbers follow the locale', () => {
    expect(numFmt(1.2649, 'fr', 2)).toBe('1,26');
    expect(numFmt(1.2649, 'en', 2)).toBe('1.26');
    expect(numFmt(0.5, 'fr', 2, 2)).toBe('0,50');
  });
  it('an 18-decimal amount is trimmed, never rounded up', () => {
    expect(trimAmt('7.344872000000000000', 8)).toBe('7.344872');
    expect(trimAmt('0.999999999999999999', 6)).toBe('0.999999');
    expect(trimAmt('100.000000000000000000')).toBe('100');
  });
});
