/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/derivatives-collateral.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The pure rules of « Déposer » / « Retirer »: what may be typed, what the review sheet must equal before the passkey is asked,
// which words describe an operation (success exists for exactly two states), and the `hlc` block of the translations.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bridgeLink, COLLATERAL_CODES, depositIntegrity, depositProblem, opDone, opWords, usdcInput, withdrawIntegrity, withdrawProblem, type CollateralOp, type CollateralStatus, type DepositPrepared, type WithdrawPrepared } from '../src/derivatives/collateral.ts';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7', USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const status = (o: Partial<CollateralStatus> = {}): CollateralStatus => ({
  account: ME.toLowerCase(), accountId: 'a', venue: 'hyperliquid', network: 'mainnet', mainnetEnabled: true, venueBalance: { abstraction: 'default', equity: '25', withdrawable: '25', spotUsdc: null, total: '25', error: null, ts: 1 },
  route: { id: 'arbitrum-bridge2', network: 'arbitrum', networkName: 'Arbitrum One', bridge: BRIDGE, bridgeExplorer: '', asset: 'USDC', token: USDC, venueMinimum: '5', minimum: '6', expectedSeconds: 60, credits: 'sender', venueFee: '0', legacy: true, pinnedAt: '2026-11-11', codeSha256: '' },
  withdrawal: { fee: '1', expectedSeconds: 240, destination: ME.toLowerCase(), payoutNetworkName: 'Arbitrum One', arrivalTracked: true, available: '25' },
  wallet: { address: ME, network: 'arbitrum', networkName: 'Arbitrum One', usdc: '40', gas: '0.001', gasSymbol: 'ETH', limits: { perTransfer: '50', perDay: '100', spentToday: '70', maxNow: '30' }, elsewhere: [] }, walletError: null,
  deposit: { available: true, reason: null, bridgeFrom: [] }, withdraw: { available: true, reason: null }, operations: [], ts: 1, ...o });
const op = (o: Partial<CollateralOp>): CollateralOp => ({ id: 'x', kind: 'deposit', state: 'sent', final: false, venueNetwork: 'mainnet', amount: '10', asset: 'USDC', fee: null, expectedReceive: null, chainNetwork: 'arbitrum', chainNetworkName: 'Arbitrum One',
  bridge: BRIDGE, txid: null, explorer: null, hash: null, proposalState: null, confirmations: null, createdAt: 1, expiresAt: null, sentAt: null, venueAt: null, doneAt: null, expectedSeconds: 60, overdue: false, check: [], balanceBefore: null, balanceAfter: null,
  ledger: null, arrival: null, error: null, attempts: 0, arrivalTracked: null, ...o });

describe('amounts', () => {
  it('are decimal strings with at most 6 decimals, never floats', () => {
    expect([usdcInput('10'), usdcInput('12,5'), usdcInput('0.000001'), usdcInput('6.10')]).toEqual(['10', '12.5', '0.000001', '6.1']);
    expect([usdcInput('0'), usdcInput(''), usdcInput('abc'), usdcInput('1.0000001'), usdcInput('-5'), usdcInput('1e3')]).toEqual([null, null, null, null, null, null]);
  });
  it('a deposit below the minimum is refused first, with the reason; then balance and the signer\'s limits', () => {
    const s = status();
    expect(depositProblem('', s)).toEqual({ amount: null, problem: null });
    for (const below of ['5.999999', '5', '4', '0.5']) expect(depositProblem(below, s), below).toEqual({ amount: null, problem: 'hlcErrBelowMin' });
    expect(depositProblem('6', s)).toEqual({ amount: '6', problem: null });
    expect(depositProblem('30', s)).toEqual({ amount: '30', problem: null });
    expect(depositProblem('30.000001', s).problem).toBe('hlcErrAboveDay');          // 100 per day, 70 already sent
    expect(depositProblem('41', s).problem).toBe('hlcErrAboveBalance');
    expect(depositProblem('51', status({ wallet: { ...s.wallet!, usdc: '500' } })).problem).toBe('hlcErrAboveLimit');
    expect(depositProblem('x', s).problem).toBe('hlcErrAmount');
    expect(depositProblem('10', status({ route: null })).problem).toBe('hlcErrAmount');
    expect(depositProblem('3', status({ wallet: { ...s.wallet!, usdc: '2' } })).problem).toBe('hlcErrBelowMin');   // the loss warning wins over "not enough"
  });
  it('a withdrawal must exceed the fee and fit what the venue reports; what arrives is amount − fee, exactly', () => {
    const s = status();
    expect(withdrawProblem('1', s).problem).toBe('hlcErrBelowFee');
    expect(withdrawProblem('0.99', s).problem).toBe('hlcErrBelowFee');
    expect(withdrawProblem('1.000001', s)).toEqual({ amount: '1.000001', receive: '0.000001', problem: null });
    expect(withdrawProblem('12.3', s)).toEqual({ amount: '12.3', receive: '11.3', problem: null });
    expect(withdrawProblem('25.01', s).problem).toBe('hlcErrAboveVenue');
    expect(withdrawProblem('25.01', status({ withdrawal: { ...s.withdrawal, available: null } })).problem).toBeNull();   // unknown at the venue: the server decides
    expect(withdrawProblem('0.1', s).receive).toBeNull();
  });
});

describe('review sheet = what the passkey commits to', () => {
  const dep = (o: Partial<DepositPrepared['intent']> = {}, sec: Partial<NonNullable<DepositPrepared['intent']['venueDeposit']>> = {}): DepositPrepared => ({
    operation: op({ state: 'pending_approval', amount: '10' }), options: {} as never, venueBalance: status().venueBalance,
    intent: { network: 'arbitrum', chainRef: '42161', asset: USDC, symbol: 'USDC', decimals: 6, amount: '10000000', from: ME, to: BRIDGE, expiresAt: 2, venueDeposit: { venue: 'hyperliquid', venueNetwork: 'mainnet', route: 'arbitrum-bridge2', bridge: BRIDGE, minAmount: '6000000', ...sec }, ...o },
    route: { network: 'arbitrum', networkName: 'Arbitrum One', bridge: BRIDGE, minimum: '6', venueMinimum: '5', expectedSeconds: 60 }, fee: { estimate: '0.000004', max: '0.000009', symbol: 'ETH' },
    liveness: { ok: true, checkedAt: 1, checked: 3, credited: 3, detail: '' } });
  it('deposit: amount, pinned bridge, sender = the venue account, native USDC, the minimum', () => {
    const s = status();
    expect(depositIntegrity(dep(), s, '10')).toBeNull();
    expect(depositIntegrity(dep({ amount: '11000000' }), s, '10')).toBe('amount');
    expect(depositIntegrity(dep(), s, '10.5')).toBe('amount');
    expect(depositIntegrity(dep({ to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }), s, '10')).toBe('bridge');
    expect(depositIntegrity(dep({}, { bridge: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }), s, '10')).toBe('bridge');
    expect(depositIntegrity(dep({ network: 'base' }), s, '10')).toBe('bridge');
    expect(depositIntegrity(dep({}, { venueNetwork: 'testnet' }), s, '10')).toBe('bridge');
    expect(depositIntegrity({ ...dep(), intent: { ...dep().intent, venueDeposit: undefined } }, s, '10')).toBe('bridge');   // a plain transfer is not a venue deposit
    expect(depositIntegrity(dep({ from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }), s, '10')).toBe('account');
    expect(depositIntegrity(dep(), status({ account: `0x${'ab'.repeat(20)}` }), '10')).toBe('account');             // the venue would credit another account
    expect(depositIntegrity(dep({ asset: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' }), s, '10')).toBe('asset');
    expect(depositIntegrity(dep({}, { minAmount: '5000000' }), s, '10')).toBe('minimum');
  });
  const wd = (o: Partial<WithdrawPrepared['withdrawal']> = {}, a: Partial<WithdrawPrepared['whatIsSigned']['action']> = {}, receive = '11.3'): WithdrawPrepared => {
    const me = ME.toLowerCase(), w = { network: 'mainnet' as const, account: me, destination: me, amount: '12.3', fee: '1', time: 1794370000123, expiresAt: 2, ...o };
    return { operation: op({ kind: 'withdraw', state: 'pending_approval', amount: '12.3' }), options: {} as never, venueBalance: status().venueBalance, hash: '', receive, withdrawal: w,
      whatIsSigned: { byMainKey: '', byPasskey: '', action: { type: 'withdraw3', hyperliquidChain: 'Mainnet', destination: me, amount: '12.3', time: w.time, ...a } } };
  };
  it('withdrawal: only ever the wallet\'s own address, the fee shown, the chain of the account', () => {
    const s = status(), other = `0x${'ab'.repeat(20)}`;
    expect(withdrawIntegrity(wd(), s, '12.3')).toBeNull();
    expect(withdrawIntegrity(wd({ destination: other }), s, '12.3')).toBe('destination');
    expect(withdrawIntegrity(wd({}, { destination: other }), s, '12.3')).toBe('destination');
    expect(withdrawIntegrity(wd({}, { type: 'usdSend' }), s, '12.3')).toBe('destination');
    expect(withdrawIntegrity(wd({ account: other }), s, '12.3')).toBe('destination');
    expect(withdrawIntegrity(wd({ amount: '13' }), s, '12.3')).toBe('amount');
    expect(withdrawIntegrity(wd({}, { amount: '13' }), s, '12.3')).toBe('amount');
    expect(withdrawIntegrity(wd({ fee: '0.5' }), s, '12.3')).toBe('fee');
    expect(withdrawIntegrity(wd({}, {}, '12.3'), s, '12.3')).toBe('fee');
    expect(withdrawIntegrity(wd({}, { hyperliquidChain: 'Testnet' }), s, '12.3')).toBe('network');
    expect(withdrawIntegrity(wd({ network: 'testnet' }), s, '12.3')).toBe('network');
    expect(withdrawIntegrity(wd({}, { time: 5 }), s, '12.3')).toBe('network');
  });
});

describe('words for an operation', () => {
  it('a deposit is good news only when the venue credited it; everything before says "not yet"', () => {
    for (const state of ['pending_approval', 'signed', 'sent', 'awaiting_credit', 'failed', 'expired', 'cancelled', 'something_new']) {
      const w = opWords(op({ state, final: ['failed', 'expired', 'cancelled'].includes(state) }));
      expect(w.tone, state).not.toBe('ok');
      expect(opDone(op({ state })), state).toBe(false);
    }
    expect(opWords(op({ state: 'awaiting_credit' }))).toEqual({ key: 'hlcOp_dep_awaiting_credit', tone: 'info', waiting: true, step: 2 });
    expect(opWords(op({ state: 'awaiting_credit', overdue: true }))).toMatchObject({ key: 'hlcOp_dep_overdue', tone: 'warn', waiting: true });
    expect(opWords(op({ state: 'credited', final: true }))).toEqual({ key: 'hlcOp_dep_credited', tone: 'ok', waiting: false, step: 3 });
    expect(opDone(op({ state: 'credited' }))).toBe(true);
    expect(opWords(op({ state: 'something_new' }))).toMatchObject({ key: 'hlcOp_other', tone: 'warn' });
  });
  it('a withdrawal is good news only when it arrived; accepted, unknown and overdue are not', () => {
    for (const state of ['pending_approval', 'approved', 'signed', 'submitted', 'unknown', 'rejected', 'failed', 'expired', 'cancelled', 'credited']) {
      expect(opWords(op({ kind: 'withdraw', state })).tone, state).not.toBe('ok');
      expect(opDone(op({ kind: 'withdraw', state })), state).toBe(false);
    }
    expect(opWords(op({ kind: 'withdraw', state: 'submitted' }))).toMatchObject({ key: 'hlcOp_wd_submitted', waiting: true, step: 2 });
    expect(opWords(op({ kind: 'withdraw', state: 'unknown' }))).toMatchObject({ key: 'hlcOp_wd_unknown', tone: 'warn', waiting: true });
    expect(opWords(op({ kind: 'withdraw', state: 'submitted', overdue: true }))).toMatchObject({ key: 'hlcOp_wd_overdue', tone: 'warn' });
    expect(opWords(op({ kind: 'withdraw', state: 'completed', final: true, arrivalTracked: true }))).toMatchObject({ key: 'hlcOp_wd_completed', tone: 'ok' });
    expect(opWords(op({ kind: 'withdraw', state: 'completed', final: true, arrivalTracked: false }))).toMatchObject({ key: 'hlcOp_wd_completed_untracked', tone: 'ok' });
  });
  it('the link to the cross-network transfer is pre-filled and nothing more', () => {
    expect(bridgeLink('base', 'arbitrum')).toBe('/swap?bridgeFrom=base&bridgeTo=arbitrum');
    expect(bridgeLink('base', 'arbitrum', '31.5')).toBe('/swap?bridgeFrom=base&bridgeTo=arbitrum&amount=31.5');
  });
});

describe('translations: the `hlc` block', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../src/i18n.ts'), 'utf8');
  const block = src.slice(src.indexOf('// collateral of a venue account: deposit / withdraw (v6)'), src.indexOf('// end of the `hlc` block'));
  const keys = [...block.matchAll(/(?:^|[\s,])(hlc[A-Za-z0-9_]+): \[/g)].map((m) => m[1]!);
  it('is one contiguous block: every `hlc` key of the file is inside it, each with a French and an English sentence', () => {
    expect(block.length).toBeGreaterThan(1000);
    expect(keys.length).toBeGreaterThan(120);
    expect(new Set(keys).size).toBe(keys.length);
    const all = [...src.matchAll(/(?:^|[\s,])(hlc[A-Za-z0-9_]+): \[/g)].map((m) => m[1]!);
    expect(all).toEqual(keys);
    for (const m of block.matchAll(/hlc[A-Za-z0-9_]+: \[\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)) { expect(m[1]!.length, m[0].slice(0, 30)).toBeGreaterThan(2); expect(m[2]!.length, m[0].slice(0, 30)).toBeGreaterThan(2); }
  });
  it('holds every key the screens use: literal keys, error codes, states, reasons, checks', () => {
    const used = new Set<string>();
    for (const f of ['../src/derivatives/LiveCollateral.tsx', '../src/derivatives/collateral.ts', '../src/derivatives/LiveAccounts.tsx']) for (const m of readFileSync(resolve(here, f), 'utf8').matchAll(/'(hlc[A-Za-z0-9_]+)'/g)) used.add(m[1]!);
    for (const c of COLLATERAL_CODES) used.add(`hlcE_${c}`);
    for (const r of ['no_route', 'mainnet_disabled', 'halted', 'usdc_elsewhere', 'no_usdc', 'no_gas', 'limit_reached', 'wallet_unreadable', 'venue_unreadable']) used.add(`hlcWhy_${r}`);
    for (const c of ['tx_success', 'tx_to_bridge', 'amount_min', 'venue_ledger', 'venue_status', 'bridge_paused', 'wallet_scan']) used.add(`hlcCheck_${c}`);
    for (const i of ['amount', 'bridge', 'account', 'asset', 'minimum', 'destination', 'fee', 'network']) used.add(`hlcIntegrity_${i}`);
    for (const s of ['done', 'stopped', 'late', 'progress']) used.add(`hlcState_${s}`);
    const missing = [...used].filter((k) => !keys.includes(k));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(110);
  });
  it('says the things that must be said, in both languages', () => {
    const row = (k: string) => new RegExp(`${k}: \\[\\s*'((?:[^'\\\\]|\\\\.)*)',\\s*'((?:[^'\\\\]|\\\\.)*)'\\]`).exec(block)!;
    expect(row('hlcOp_dep_awaiting_credit')[1]).toMatch(/en attente du crédit par la plateforme/);
    expect(row('hlcOp_dep_awaiting_credit')[2]).toMatch(/waiting for the venue to credit/);
    expect(row('hlcMinBody')[1]).toMatch(/perdu pour toujours/); expect(row('hlcMinBody')[2]).toMatch(/lost forever/);
    expect(row('hlcCreditsSender')[1]).toMatch(/crédite l’adresse qui envoie/);
    expect(row('hlcOwnOnly')[1]).toMatch(/aucune autre/); expect(row('hlcOwnOnly')[2]).toMatch(/no other/);
    expect(row('hlcOp_dep_overdue')[1]).toMatch(/PAS annoncé comme arrivé/); expect(row('hlcOp_wd_overdue')[2]).toMatch(/NOT reported as arrived/);
    expect(row('hlcWhy_usdc_elsewhere')[1]).toMatch(/Rien n’est transféré automatiquement/);
  });
});
