/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/next-web-screens.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
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

// NEXT web — the pure rules behind the core screens: money as text, the value chart's geometry, movements (internal deposits,
// counterparties, CSV), asset preferences, contacts, the passkey list, « Max », payment links, the search index.
import { describe, expect, it } from 'vitest';
import { addDecimal, cmpDecimal, decimalOf, fiatText, mulDecimal, pctText, signOf } from '../src/money.ts';
import { paymentUri } from '../src/payment-uri.ts';
import { localSearch, mergeHits, moveSelection } from '../src/search-index.ts';
import { matchesAsset } from '../src/screens/Assets.tsx';
import { serverFiltered } from '../src/screens/Asset.tsx';
import { matchesContact } from '../src/screens/Contacts.tsx';
import { passkeyRows } from '../src/screens/Security.tsx';
import { acksFor, maxNative } from '../src/screens/Send.tsx';
import { gapThreshold, nearestIndex, scrubKey, segments, toPoints, valueGeometry } from '../src/value-geom.ts';
import { contactFor, summaryOf, withPref } from '../src/wallet.ts';
import { mismatchIds, readAnalytics, readSearch } from '../src/wallet-more.ts';
import { counterpartyLabel, csvOf, foldInternal, originKey, resultsOf, type WalletItem } from '../src/walletItems.ts';

const NB = ' ';
describe('money as text', () => {
  it('writes the server’s decimal string digit for digit, in the owner’s language, without a float', () => {
    expect(fiatText('41154.69', 'CAD', 'fr')).toBe(`41${NB}154,69${NB}$`); expect(fiatText('41154.69', 'CAD', 'en')).toBe('$41,154.69');
    expect(fiatText('123456789012345678.91', 'CAD', 'en')).toBe('$123,456,789,012,345,678.91');   // beyond what a double holds exactly
    expect(fiatText('0.1', 'USD', 'en')).toBe('US$0.10'); expect(fiatText('5', 'CAD', 'en')).toBe('$5.00'); expect(fiatText('1.999', 'CAD', 'en')).toBe('$1.99');   // truncated, never rounded up
    expect(fiatText('-12.5', 'CAD', 'fr')).toBe(`−12,50${NB}$`); expect(fiatText('12.5', 'CAD', 'en', { sign: true })).toBe('+$12.50'); expect(fiatText('0.00', 'CAD', 'en', { sign: true })).toBe('$0.00'); expect(fiatText('-0.00', 'CAD', 'en')).toBe('$0.00');
    for (const bad of [null, undefined, '', 'abc', '1e5', '1,5']) expect(fiatText(bad as never, 'CAD', 'fr')).toBe('—');
  });
  it('amount × price is exact and truncated; a price in exponent notation is expanded, not rounded', () => {
    expect(mulDecimal('0.1', 0.2)).toBe('0.02'); expect(mulDecimal('0.3', '0.1', 4)).toBe('0.0300');                                 // 0.1 × 0.2 is 0.020000000000000004 as floats
    expect(mulDecimal('4250.75', 1.4012)).toBe('5956.15'); expect(mulDecimal('1.84210934', 4781.2)).toBe('8807.49'); expect(mulDecimal('0.999', '0.999')).toBe('0.99');
    expect(mulDecimal('123456789.123456789012345678', '1000000')).toBe('123456789123456.78'); expect(mulDecimal('1000000', 1e-7, 4)).toBe('0.1000');
    expect(decimalOf(1e-7)).toBe('0.0000001'); expect(decimalOf(1.5e21)).toBe('1500000000000000000000'); expect(decimalOf(Number.NaN)).toBeNull(); expect(decimalOf('12.50')).toBe('12.5');
    expect(mulDecimal(null, 1)).toBeNull(); expect(mulDecimal('1', null)).toBeNull(); expect(mulDecimal('x', 1)).toBeNull();
  });
  it('adds, compares and signs decimal strings', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3'); expect(addDecimal('1.5', '-2')).toBe('-0.5'); expect(addDecimal('0.08412345', '-0.0000214')).toBe('0.08410205');
    expect(cmpDecimal('10', '9.99')).toBe(1); expect(cmpDecimal('1.50', '1.5')).toBe(0); expect(cmpDecimal(null, '0')).toBe(-1); expect([signOf('-0.00'), signOf('-1'), signOf('2'), signOf(null)]).toEqual([0, -1, 1, 0]);
    expect(pctText(1.4712, 'fr', 2, 2, true)).toBe(`+1,47${NB}%`); expect(pctText(-0.004, 'en', 2, 2, true)).toBe('0.00%'); expect(pctText(28.4, 'en', 0)).toBe('28%');
  });
});

describe('value chart geometry', () => {
  const row = (min: number, total: string) => ({ t: new Date(Date.UTC(2026, 10, 19, 0, min)).toISOString(), total });
  it('a hole in the series is a hole in the line: nothing joins its two sides', () => {
    const pts = toPoints([row(0, '100.00'), row(10, '101.00'), row(20, '102.00'), row(30, '103.00'), row(300, '90.00'), row(310, '91.00'), row(320, '92.00')]);
    const gap = gapThreshold(pts, 600_000); expect(gap).toBe(1_800_000);
    expect(segments(pts, gap).map((s) => s.length)).toEqual([4, 3]);
    const g = valueGeometry(pts, 400, 200, { t: 20, r: 0, b: 20, l: 0 }, gap)!;
    expect(g.lines).toHaveLength(2); expect(g.gaps).toHaveLength(1); expect(g.gaps[0]!.x1).toBeGreaterThan(g.gaps[0]!.x0); expect(g.min.total).toBe('90.00'); expect(g.max.total).toBe('103.00');
    expect(valueGeometry(pts.slice(0, 1), 400, 200, { t: 0, r: 0, b: 0, l: 0 }, gap)).toBeNull();
  });
  it('a thinned-out history (hourly, daily) is not full of holes; a lone point between two holes is a dot', () => {
    const hourly = toPoints(Array.from({ length: 30 }, (_, k) => row(k * 60, String(100 + k)))); expect(segments(hourly, gapThreshold(hourly, 600_000))).toHaveLength(1);
    const pts = toPoints([row(0, '1'), row(10, '2'), row(20, '2'), row(200, '3'), row(400, '4'), row(410, '5'), row(420, '5')]), g = valueGeometry(pts, 300, 100, { t: 0, r: 0, b: 0, l: 0 }, gapThreshold(pts, 600_000))!;
    expect(g.dots).toHaveLength(1); expect(g.lines).toHaveLength(2);
  });
  it('the scrub snaps to a real point (no interpolated value) and answers the keyboard', () => {
    const pts = toPoints([row(0, '1'), row(10, '2'), row(20, '3')]), g = valueGeometry(pts, 200, 100, { t: 0, r: 0, b: 0, l: 0 }, Infinity)!;
    expect(nearestIndex(pts, g, 0)).toBe(0); expect(nearestIndex(pts, g, 95)).toBe(1); expect(nearestIndex(pts, g, 500)).toBe(2);
    expect(scrubKey('ArrowLeft', null, 50)).toBe(48); expect(scrubKey('ArrowRight', null, 50)).toBe(49); expect(scrubKey('ArrowLeft', 0, 50)).toBe(0); expect(scrubKey('ArrowRight', 10, 50, true)).toBe(20);
    expect(scrubKey('Home', 30, 50)).toBe(0); expect(scrubKey('End', 3, 50)).toBe(49); expect(scrubKey('a', 3, 50)).toBeNull(); expect(scrubKey('End', null, 0)).toBeNull();
  });
});

const item = (o: Partial<WalletItem> & { id: string }): WalletItem => ({ kind: 'send', at: '2026-11-19T12:00:00Z', network: 'base', networkName: 'Base', asset: 'native', symbol: 'ETH', amount: '1', amountDisplay: '0.5', state: 'finalized', txid: null, explorer: null, ...o });
describe('movements', () => {
  const swap = item({ id: 'p1', kind: 'swap' }), result = item({ id: 'd1', kind: 'receive', depositKind: 'internal', origin: 'swap', proposalId: 'p1', symbol: 'USDC', amountDisplay: '812.4' });
  const orphan = item({ id: 'd2', kind: 'receive', depositKind: 'internal', origin: 'agent_withdrawal' }), ext = item({ id: 'd3', kind: 'receive', depositKind: 'external', from: '0xAbC0000000000000000000000000000000000001' });
  it('a deposit that is the result of an operation in the list is shown inside it, not as « received »; the others stay, named by their origin', () => {
    expect(foldInternal([swap, result, orphan, ext]).map((i) => i.id)).toEqual(['p1', 'd2', 'd3']); expect(resultsOf([swap, result, orphan, ext], 'p1').map((i) => i.id)).toEqual(['d1']);
    expect(foldInternal([result, orphan]).map((i) => i.id)).toEqual(['d1', 'd2']);   // its operation is not in the list: it stays visible
    expect(originKey('swap')).toBe('nwOrigin_swap'); expect(originKey('agent_withdrawal')).toBe('nwOrigin_agent_withdrawal'); expect(originKey('something_new')).toBe('nwOrigin_other'); expect(originKey(null)).toBe('nwOrigin_other');
  });
  const contacts = [{ id: 'c1', network: 'base', address: '0xabc0000000000000000000000000000000000001', label: 'Mathieu', note: '', favorite: false }];
  it('the counterparty is named by the server’s label, else by the local contact (EVM addresses compare without case, per network)', () => {
    expect(counterpartyLabel(ext, contacts)).toBe('Mathieu'); expect(counterpartyLabel({ ...ext, network: 'ethereum' }, contacts)).toBeNull();
    expect(counterpartyLabel({ ...ext, contactLabel: 'From the server' }, contacts)).toBe('From the server'); expect(counterpartyLabel(swap, contacts)).toBeNull();
    expect(contactFor(contacts, 'base', '0xABC0000000000000000000000000000000000001')?.id).toBe('c1'); expect(contactFor([{ ...contacts[0]!, network: 'solana', address: 'AbC' }], 'solana', 'abc')).toBeUndefined();
  });
  it('CSV: one line per movement, fee paid next to the estimate, cells that cannot be read as formulas', () => {
    const csv = csvOf([item({ id: 'p', to: '0xabc0000000000000000000000000000000000001', note: '=cmd', feeDisplay: '0.0000021', feePaidDisplay: '0.0000018', feeSymbol: 'ETH', txid: '0xdead', confirmations: 12 }), orphan], contacts, () => 'confirmed').trim().split('\n');
    expect(csv).toHaveLength(3); expect(csv[0]).toMatch(/^time_utc,kind,.*fee_estimate,fee_paid,fee_symbol$/);
    expect(csv[1]).toContain('"Mathieu"'); expect(csv[1]).toContain('"0.0000021","0.0000018","ETH"'); expect(csv[1]).toContain('"confirmed","12","0xdead"'); expect(csv[2]).toContain('"receive_internal:agent_withdrawal"');
  });
  it('an asset page takes an answer as server-filtered only when it holds nothing else than that asset', () => {
    expect(serverFiltered([{ network: 'base', asset: 'native' }], 'base', 'native')).toBe(true); expect(serverFiltered([{ network: 'base', asset: 'native' }, { network: 'base', asset: '0x1' }], 'base', 'native')).toBe(false); expect(serverFiltered([], 'base', 'native')).toBe(false);
  });
});

describe('assets, contacts, preferences', () => {
  const usdc = { symbol: 'USDC', name: 'USD Coin', networkName: 'Base', network: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  it('search finds an asset by name, symbol, network and contract address', () => {
    for (const q of ['usd', 'USDC', 'base', 'coin', '0x833589', '54bda029', ' Base ']) expect(matchesAsset(usdc, q), q).toBe(true);
    for (const q of ['eth', '0x9999', 'bda']) expect(matchesAsset(usdc, q), q).toBe(false);   // three characters of an address are not a search of it
    expect(matchesAsset({ ...usdc, asset: 'native' }, 'native')).toBe(false);
    expect(matchesContact({ label: 'Loyer', note: 'le 1er', address: '0xAbCd', network: 'base' }, 'abcd')).toBe(true); expect(matchesContact({ label: 'Loyer', note: '', address: '0x1', network: 'base' }, 'arbitrum', 'Base')).toBe(false);
  });
  it('an optimistic preference change is a pure step that can be undone by putting the previous map back', () => {
    const m0 = {}, m1 = withPref(m0, 'base', 'native', { favorite: true }), m2 = withPref(m1, 'base', 'native', { hidden: true }), m3 = withPref(m2, 'base', 'native', { favorite: false, hidden: false });
    expect(m0).toEqual({}); expect(m1['base:native']).toMatchObject({ favorite: true, hidden: false }); expect(m2['base:native']).toMatchObject({ favorite: true, hidden: true }); expect(m3).toEqual({});
  });
  it('the summary is taken from the server only when it is the full one', () => {
    expect(summaryOf({ summary: { complete: false, missing: ['solana'] } })).toBeNull(); expect(summaryOf({})).toBeNull();
    expect(summaryOf({ summary: { total: '1.00', complete: true, byAsset: [], byNetwork: [] } })?.total).toBe('1.00');
  });
});

describe('Security Center', () => {
  const dev = (id: string, o: object = {}) => ({ id: id.slice(0, 12), credentialId: id, label: `label-${id.slice(0, 3)}`, enrolledOnSigner: true, backedUp: true, revocable: true, ...o });
  const cred = (id: string, o: object = {}) => ({ id, inCooldown: false, known: true, label: null, revocable: true, ...o });
  it('the SIGNER’s list decides who can approve; what only one side knows is shown as such', () => {
    const r = passkeyRows({ devices: [dev('aaaaaaaaaaaaaaaa'), dev('cccccccccccccccc', { enrolledOnSigner: false })], signerCredentials: [cred('aaaaaaaaaaaaaaaa'), cred('bbbbbbbbbbbbbbbb', { known: false, inCooldown: true })] });
    expect(r.fromSigner).toBe(true); expect(r.rows.map((k) => [k.id.slice(0, 1), k.onSigner, k.known])).toEqual([['a', true, true], ['b', true, false], ['c', false, true]]);
    expect(r.rows[0]!.label).toBe('label-aaa'); expect(r.rows[1]!.label).toBeNull(); expect(r.rows[1]!.inCooldown).toBe(true);
  });
  it('the last passkey of the signer is not revocable; without the signer’s list the application’s is shown and flagged', () => {
    expect(passkeyRows({ devices: [dev('aaaaaaaaaaaaaaaa')], signerCredentials: [cred('aaaaaaaaaaaaaaaa', { revocable: false })] }).rows[0]!.revocable).toBe(false);
    for (const sc of [null, undefined]) { const r = passkeyRows({ devices: [dev('aaaaaaaaaaaaaaaa')], signerCredentials: sc }); expect(r.fromSigner).toBe(false); expect(r.rows).toHaveLength(1); }
    expect(mismatchIds([{ side: 'signer', id: 'x' }, { side: 'api', id: 'y' }, { side: 'api', id: 'z' }])).toEqual({ signerOnly: ['x'], apiOnly: ['y', 'z'], any: true }); expect(mismatchIds(null).any).toBe(false); expect(mismatchIds([]).any).toBe(false);
  });
});

describe('Send', () => {
  it('« Max » of the native coin is net of the last known fee ceiling, exactly; without one it is the balance, flagged approximate', () => {
    expect(maxNative('0.08412345', '0.0000214')).toEqual({ value: '0.08410205', approximate: false }); expect(maxNative('1.5', null)).toEqual({ value: '1.5', approximate: true }); expect(maxNative('0.00001', '0.0002').value).toBe('0');
  });
  it('every warning that needs an acknowledgement has its box; the two address warnings share one', () => {
    expect(acksFor(['new_destination', 'address_poisoning_suspected'])).toEqual(['iChecked']); expect(acksFor(['duplicate_recent'])).toEqual(['nwAckDuplicate']); expect(acksFor(['l1_fee_unknown', 'new_destination', 'duplicate_recent'])).toEqual(['iChecked', 'nwAckDuplicate', 'nwAckL1']);
    expect(acksFor(['contract_destination', 'network_congested'])).toEqual([]);
  });
  it('a payment link only where the network has a standard one, and never with an amount', () => {
    expect(paymentUri({ id: 'bitcoin', family: 'btc' }, 'bc1qxyz')).toEqual({ uri: 'bitcoin:bc1qxyz', standard: 'BIP-21' }); expect(paymentUri({ id: 'base', family: 'evm', chainRef: '8453' }, '0xAbc')?.uri).toBe('ethereum:0xAbc@8453');
    expect(paymentUri({ id: 'base', family: 'evm' }, '0xAbc')).toBeNull(); expect(paymentUri({ id: 'solana', family: 'sol' }, 'So1')?.uri).toBe('solana:So1'); expect(paymentUri({ id: 'tron', family: 'tron' }, 'T1')).toBeNull(); expect(paymentUri({ id: 'xrp', family: 'xrp' }, 'r1')).toBeNull();
    expect(paymentUri({ id: 'bitcoincash', family: 'btc' }, 'bitcoincash:qq1')?.uri).toBe('bitcoincash:qq1'); expect(paymentUri({ id: 'bitcoin', family: 'btc' }, '')).toBeNull();
  });
});

describe('search', () => {
  const src = { netName: (n: string) => (n === 'base' ? 'Base' : n), txTitle: () => 'Envoi à Mathieu', destinations: [{ id: 'security', path: '/security', title: 'Sécurité', keywords: 'clés passkey sessions' }, { id: 'settings', path: '/settings', title: 'Réglages', keywords: 'langue devise' }],
    assets: [{ network: 'base', networkName: 'Base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', amount: '5' }, { network: 'ethereum', networkName: 'Ethereum', asset: 'native', symbol: 'ETH', name: 'Ether', amount: '0' }],
    contacts: [{ id: 'c1', network: 'base', address: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', label: 'Loyer', note: 'mensuel' }],
    items: [{ id: 'p1', kind: 'send', network: 'base', networkName: 'Base', symbol: 'USDC', amountDisplay: '1250', txid: '0xdeadbeefcafe', to: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', at: '2026-11-19T00:00:00Z' }] };
  const types = (q: string) => localSearch(q, src).map((h) => `${h.type}:${h.id}`);
  it('finds assets, contacts, transactions (hash, address, amount) and settings — accents and case do not matter', () => {
    expect(types('usd')).toEqual(['asset:base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'transaction:p1']); expect(types('0x833589f')).toEqual(['asset:base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
    expect(types('loyer')).toEqual(['contact:c1']); expect(types('deadbeef')).toEqual(['transaction:p1']); expect(types('1 250')).toEqual(['transaction:p1']); expect(types('0x8ba1f1')).toEqual(['contact:c1', 'transaction:p1']);
    expect(types('SECURITE')).toEqual(['setting:security']); expect(types('passkey')).toEqual(['setting:security']); expect(types('u')).toEqual([]); expect(types('zzzz')).toEqual([]);
    expect(localSearch('deadbeef', src)[0]!.path).toBe('/activity?tx=p1'); expect(localSearch('usd', src)[0]!.path).toBe('/asset/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
  it('server hits come first, a local hit for the same target is not repeated, the groups keep their order', () => {
    const local = localSearch('usd', src), server = readSearch({ results: [{ type: 'transaction', id: 'p9', title: 'From the server', path: '/activity?tx=p9' }, { type: 'asset', network: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', title: 'USD Coin', symbol: 'USDC' }, { type: 'nonsense', title: 'x' }, { type: 'asset', title: '' }] });
    expect(server).toHaveLength(2);
    expect(mergeHits(server, local).map((h) => `${h.type}:${h.id}`)).toEqual(['asset:/asset/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'transaction:p9', 'transaction:p1']); expect(mergeHits(null, local)).toEqual(local);
  });
  it('the arrow keys walk the list and wrap', () => { expect(moveSelection('ArrowDown', -1, 3)).toBe(0); expect(moveSelection('ArrowDown', 2, 3)).toBe(0); expect(moveSelection('ArrowUp', 0, 3)).toBe(2); expect(moveSelection('ArrowUp', 2, 3)).toBe(1); expect(moveSelection('x', 0, 3)).toBeNull(); expect(moveSelection('ArrowDown', 0, 0)).toBeNull(); });
  it('the analytics answer is read defensively: what is not there is null, never a guess', () => {
    expect(readAnalytics({ feesPaid: { total: '12.84', count: 9, complete: true }, networkFees: [{ network: 'base', symbol: 'ETH', fee: '0.0000021', fiat: '0.01' }] })).toMatchObject({ feesPaid: '12.84', feesCount: 9, networkFees: [{ network: 'base', fiat: '0.01' }] });
    expect(readAnalytics({})).toEqual({ feesPaid: null, feesCount: null, feesComplete: null, inflow: null, outflow: null, networkFees: [] }); expect(readAnalytics(null).feesPaid).toBeNull(); expect(readAnalytics({ feesPaid: 'lots' }).feesPaid).toBeNull();
  });
});
