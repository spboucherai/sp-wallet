/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/venue-collateral.test.ts
 * Module           : services
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

// Collateral of a venue account, signer side: the `venueDeposit` intent (pinned bridge, native USDC, floor above the venue
// minimum, wallet limits) and the `withdraw3` signature of the main key (passkey, own address only). No network; nothing is sent.
// Mnemonic: the public BIP-39 test vector. SDK key: the published test key of the official SDK's tests.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cctpUsdc, intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import {
  buildVenueWithdraw, checkVenueDepositIntent, createHlTrading, hex, HL_BRIDGE_ADDRESSES, HL_BRIDGE_PINS, HL_DEPOSIT_FLOOR_USDC, HL_DEPOSIT_MIN_USDC, HL_WITHDRAW_FEE_USDC, HL_WITHDRAWALS_PER_DAY, hlPinnedAssets,
  jurisdictionAck, recoverTypedDataSigner, usdcDecimal, usdcUnits, venueAuthorizationHash, venueDepositSection, venueWithdrawalBytes, venueWithdrawalHash,
  type HlTypedData, type SignRequest, type VenueAuthorization, type VenueWithdrawal,
} from '@spw/derivatives/live';
import { buildApproveAgent, buildUsdClassTransferTypedDataOnly, buildWithdraw3TypedDataOnly, HL_PRIMARY, HL_USD_SEND_TYPES, userSignedTypedData } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';
import { raw as fixture, sameSig, SDK_TEST_KEY, signWith } from '../../../packages/derivatives/test/hyperliquid/helpers.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys, type Keys } from '../src/keys.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.evm, ACCOUNT = ME.toLowerCase();
const PIN = HL_BRIDGE_PINS.mainnet!, USDC = cctpUsdc('arbitrum').id, OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
let n = 0;
const uuid = () => `8b2c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`;

async function setup(k: Keys = keys) {
  const t = { now: Math.floor(Date.now() / 1000) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-collateral-'));
  const paths = [join(dir, 'state.json'), join(dir, 'policy.json')] as const;
  const store = new Store(...paths);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const prices = { get: async (syms: string[]) => Object.fromEntries(syms.map((s) => [s, 70_000])) };
  const signer = new Signer(k, store, { rpId: RP, origin: ORIGIN }, () => t.now, prices);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const restart = () => new Signer(k, new Store(...paths), { rpId: RP, origin: ORIGIN }, () => t.now, prices);
  return { signer, store, pk, t, restart };
}
type World = Awaited<ReturnType<typeof setup>>;
const code = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? `${e.code}: ${e.message}` : 'ok'; };
const journal = (w: World, type: string) => w.store.state.journal.filter((j) => j.type === type);

/** a venue deposit exactly as the API prepares it: 10 USDC on Arbitrum to the pinned bridge */
function deposit(now: number, over: Partial<Intent> = {}): Intent {
  return { v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'arbitrum', chainRef: '42161', asset: USDC, symbol: 'USDC', decimals: 6, amount: '10000000', from: ME, to: PIN.bridge,
    maxFee: '100000000000000', createdAt: now, expiresAt: now + 120, policyVersion: 4, venueDeposit: venueDepositSection('mainnet'),
    evm: { nonce: 4, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...over };
}
const sign = (w: World, i: Intent, assertion = w.pk.assert(intentHash(i))) => w.signer.sign(i, assertion);

describe('pinned route', () => {
  it('pins the documented mainnet bridge, the registry\'s native USDC on Arbitrum, and no testnet route', () => {
    expect(PIN).toEqual({ network: 'arbitrum', chainId: 42161, bridge: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      codeSha256: '37ff6a58c3c80d99fd85ba0898ba3a5ae8d55b82c4a4d758dd258af3b05fc3c7', codeBytes: 19394 });
    expect(USDC).toBe(PIN.usdc);
    expect(NETWORKS.arbitrum!.chainRef).toBe(String(PIN.chainId));
    expect(HL_BRIDGE_PINS.testnet).toBeUndefined();
    expect(() => venueDepositSection('testnet')).toThrow(/no deposit route/);
    expect(HL_BRIDGE_ADDRESSES).toContain(PIN.bridge.toLowerCase());
    expect([HL_DEPOSIT_MIN_USDC, HL_DEPOSIT_FLOOR_USDC, HL_WITHDRAW_FEE_USDC]).toEqual(['5', '6', '1']);
    expect(usdcUnits(HL_DEPOSIT_FLOOR_USDC)).toBeGreaterThan(usdcUnits(HL_DEPOSIT_MIN_USDC));
    expect([usdcUnits('12.3'), usdcDecimal(12_300_000n), usdcDecimal(5_000_001n), usdcDecimal(7_000_000n)]).toEqual([12_300_000n, '12.3', '5.000001', '7']);
    expect(() => usdcUnits('1.0000001')).toThrow();
  });
});

describe('venue deposit: canonical intent', () => {
  const fixed = (): Intent => ({ ...deposit(1794370000), proposalId: '8b2c1f0e-8f5f-4b1e-9c56-0000000000aa', policyVersion: 3 }); // golden hash recorded under policy version 3: unchanged, the canonical serialization did not move
  it('the section is part of the hash the passkey signs', () => {
    const i = fixed(), { venueDeposit: _s, ...plain } = i;
    expect(hex(intentHash(i))).toBe('e127c8313791b42c4dd7260521c52a95b75e7b349c1cd8770c910431b2c02bd6');
    expect(hex(intentHash(i))).not.toBe(hex(intentHash(plain as Intent)));
    for (const patch of [{ venueNetwork: 'testnet' as const }, { route: 'other-route' }, { bridge: OTHER }, { minAmount: '5000000' }])
      expect(hex(intentHash({ ...i, venueDeposit: { ...i.venueDeposit!, ...patch } }))).not.toBe(hex(intentHash(i)));
  });
  it('excludes a swap, a bridge and a memo in the same intent', () => {
    const i = fixed();
    expect(() => intentHash({ ...i, memo: 'x' })).toThrow(/venue deposit/);
    expect(() => intentHash({ ...i, bridge: { provider: 'cctp', toNetwork: 'base', toDomain: 6, maxFee: '0', minFinalityThreshold: 2000, messenger: OTHER, transmitter: OTHER, approveGas: '70000' } })).toThrow();
    expect(() => intentHash({ ...i, network: 'solana' })).toThrow();
  });
});

describe('venue deposit: what the signer signs', () => {
  it('signs a transfer of native USDC on Arbitrum from the wallet to the pinned bridge, and records it', async () => {
    const w = await setup(), i = deposit(w.t.now);
    const r = await sign(w, i);
    const tx = parseTransaction(r.raw as `0x${string}`);
    expect(tx.chainId).toBe(42161);
    expect(tx.to?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe('transfer');
    expect(call.args).toEqual([PIN.bridge, 10_000_000n]);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as `0x02${string}` })).toBe(ME); // the venue credits the sender: the wallet's own address
    expect(r.hash).toBe(hex(intentHash(i)));
    expect(journal(w, 'sign.ok').at(-1)!.data).toMatchObject({ network: 'arbitrum', symbol: 'USDC', amount: '10000000', to: PIN.bridge, venueDeposit: 'hyperliquid', venueNetwork: 'mainnet', route: 'arbitrum-bridge2' });
    expect(w.signer.status().spentToday['arbitrum:USDC']).toBe('10000000');
    expect(verifyAuditChain(w.store.state.journal)).toBeNull();
  });

  it('accepts exactly the floor and refuses anything below it (the venue would credit nothing)', async () => {
    const w = await setup();
    expect(await code(sign(w, deposit(w.t.now, { amount: '6000000' })))).toBe('ok');
    for (const amount of ['5999999', '5000000', '4000000', '1'])
      expect(await code(sign(w, deposit(w.t.now, { amount }))), amount).toMatch(/^venue_deposit: a deposit below 6 USDC is refused: the venue credits nothing under 5 USDC/);
    // a lower minimum written in the section does not lower the signer's floor
    expect(await code(sign(w, deposit(w.t.now, { amount: '5000000', venueDeposit: { ...venueDepositSection('mainnet'), minAmount: '5000000' } })))).toMatch(/^venue_deposit: the minimum shown for approval is not the one this signer enforces/);
    expect(journal(w, 'sign.ok')).toHaveLength(1);
  });

  it('refuses another token, another network, another bridge, another source', async () => {
    const w = await setup(), t = w.t.now, bridged = NETWORKS.arbitrum!.tokens.find((x) => x.symbol !== 'USDC' && x.decimals === 6)!;
    const cases: [string, Partial<Intent>, RegExp][] = [
      ['bridged USDC.e', { asset: bridged.id, symbol: bridged.symbol }, /^venue_deposit: only native USDC can be deposited/],
      ['native ETH', { asset: 'native', symbol: 'ETH', decimals: 18, amount: '10000000000000000', evm: { nonce: 4, gasLimit: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } }, /^venue_deposit: only native USDC/],
      ['USDC on Base', { network: 'base', chainRef: '8453', asset: cctpUsdc('base').id }, /^venue_deposit: a Hyperliquid mainnet deposit is made on arbitrum only/],
      ['Arbitrum with another chain id', { chainRef: '8453' }, /^wrong_chain/],
      ['bridge of the section is not the pinned one', { to: OTHER, venueDeposit: { ...venueDepositSection('mainnet'), bridge: OTHER } }, /^venue_deposit: the destination is not the pinned bridge/],
      ['destination differs from the section', { to: OTHER }, /^venue_deposit: the destination is not the pinned bridge/],
      ['testnet venue network (no pinned route)', { venueDeposit: { ...venueDepositSection('mainnet'), venueNetwork: 'testnet' } }, /^venue_deposit: no deposit route is pinned for Hyperliquid testnet/],
      ['unknown route', { venueDeposit: { ...venueDepositSection('mainnet'), route: 'cctp-forwarder' } }, /^venue_deposit: unknown deposit route/],
      ['another source address', { from: OTHER }, /^wrong_source/],
      ['another key', { keyId: 'spw-0000000000000000' }, /^wrong_key/],
    ];
    for (const [label, over, re] of cases) expect(await code(sign(w, deposit(t, over))), label).toMatch(re);
    expect(journal(w, 'sign.ok')).toHaveLength(0);
    expect(journal(w, 'sign.denied')).toHaveLength(cases.length);
  });

  it('refuses a plain transfer to a venue bridge (any network, any amount): the minimum cannot be bypassed by an ordinary send', async () => {
    const w = await setup(), t = w.t.now;
    const { venueDeposit: _s, ...plain } = deposit(t);
    expect(await code(sign(w, plain as Intent))).toMatch(/^venue_deposit: this destination is a venue bridge/);
    expect(await code(sign(w, { ...plain, amount: '1000000' } as Intent))).toMatch(/^venue_deposit: this destination is a venue bridge/);
    expect(await code(sign(w, { ...plain, to: '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89' } as Intent))).toMatch(/^venue_deposit: this destination is a venue bridge/);     // testnet bridge address
    expect(await code(sign(w, { ...plain, network: 'base', chainRef: '8453', asset: cctpUsdc('base').id } as Intent))).toMatch(/^venue_deposit: this destination is a venue bridge/); // same address on another chain
    expect(await code(sign(w, { ...plain, asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000000000000000', evm: { ...plain.evm!, gasLimit: '21000' } } as Intent))).toMatch(/^venue_deposit: this destination is a venue bridge/);
    // an ordinary transfer elsewhere is untouched
    expect(await code(sign(w, { ...plain, to: OTHER } as Intent))).toBe('ok');
  });

  it('applies the wallet limits of a send: per transfer, per day, fee ceiling, approval window, halt, allowlist', async () => {
    const w = await setup(), t = w.t.now;
    expect(w.store.policy.perTx['arbitrum:USDC']).toBe('50000000');
    expect(w.store.policy.daily['arbitrum:USDC']).toBe('100000000');
    expect(await code(sign(w, deposit(t, { amount: '50000001' })))).toMatch(/^policy: amount above per-transaction limit for arbitrum:USDC/);
    expect(await code(sign(w, deposit(t, { maxFee: '300000000000001' })))).toMatch(/^policy: fee ceiling above policy/);
    expect(await code(sign(w, deposit(t, { expiresAt: t + 301 })))).toMatch(/^policy: approval window too long/);
    expect(await code(sign(w, deposit(t, { createdAt: t - 300, expiresAt: t - 1 })))).toMatch(/^policy: approval window expired/);
    expect(await code(sign(w, deposit(t, { policyVersion: 2 })))).toMatch(/^policy: policy version changed/);
    expect(await code(sign(w, deposit(t, { amount: '50000000' })))).toBe('ok');
    expect(await code(sign(w, deposit(t, { amount: '44000000' })))).toBe('ok');
    expect(await code(sign(w, deposit(t, { amount: '6000001' })))).toMatch(/^policy: daily limit exceeded for arbitrum:USDC/); // 94 + 6.000001 > 100
    expect(await code(sign(w, deposit(t, { amount: '6000000' })))).toBe('ok');
    // a non-empty allowlist stays binding: the bridge must be listed like any destination
    w.store.policy = { ...w.store.policy, daily: { ...w.store.policy.daily, 'arbitrum:USDC': '500000000' }, allowlist: [`arbitrum:${OTHER}`] };
    expect(await code(sign(w, deposit(t)))).toMatch(/^policy: destination not in signer allowlist/);
    w.store.policy = { ...w.store.policy, allowlist: [`arbitrum:${OTHER}`, `arbitrum:${PIN.bridge}`] };
    expect(await code(sign(w, deposit(t)))).toBe('ok');
    w.signer.halt();
    expect(await code(sign(w, deposit(t)))).toMatch(/^policy: emergency halt is active/);
  });

  it('needs the owner\'s passkey over this exact intent, once', async () => {
    const w = await setup(), t = w.t.now, i = deposit(t);
    expect(await code(w.signer.sign(i, undefined as never))).toMatch(/^bad_approval/);
    expect(await code(sign(w, i, w.pk.assert(intentHash(deposit(t, { amount: '11000000' })))))).toMatch(/^bad_approval/);          // approval of another amount
    expect(await code(sign(w, i, w.pk.assert(intentHash({ ...i, venueDeposit: undefined, to: OTHER }))))).toMatch(/^bad_approval/);  // approval of a plain send
    expect(await code(sign(w, i, new TestPasskey(RP, ORIGIN).assert(intentHash(i))))).toMatch(/^unknown_credential/);
    expect(await code(sign(w, i, w.pk.assert(intentHash(i), { origin: 'https://evil.test' })))).toMatch(/^bad_approval/);
    expect(await code(sign(w, i))).toBe('ok');
    expect(await code(sign(w, i))).toMatch(/^replay: proposal already signed/);
    expect(await code(w.restart().sign(i, w.pk.assert(intentHash(i))))).toMatch(/^replay/);
    expect(journal(w, 'sign.ok')).toHaveLength(1);
  });

  it('checkVenueDepositIntent is the same rule for the API (pure)', () => {
    const i = deposit(1794370000);
    expect(checkVenueDepositIntent(i, ME)).toBe(PIN);
    expect(checkVenueDepositIntent({ ...i, venueDeposit: undefined, to: OTHER }, ME)).toBeNull();
    expect(() => checkVenueDepositIntent({ ...i, swap: {} }, ME)).toThrow(/neither a swap/);
    expect(() => checkVenueDepositIntent(i, OTHER)).toThrow(/wallet's own address/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

const withdrawal = (now: number, o: Partial<VenueWithdrawal> = {}): VenueWithdrawal => ({
  v: 1, withdrawalId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'mainnet', account: ACCOUNT, destination: ACCOUNT, amount: '12.3', fee: '1', time: now * 1000 + ++n, createdAt: now, expiresAt: now + 180, ...o });
const withdraw = (w: World, x: VenueWithdrawal, assertion = w.pk.assert(venueWithdrawalHash(x))) => w.signer.venueWithdraw(x, assertion);

describe('venue withdrawal: canonical object', () => {
  const fixed: VenueWithdrawal = { v: 1, withdrawalId: '8b2c1f0e-8f5f-4b1e-9c56-0000000000bb', keyId: 'spw-0123456789abcdef', venue: 'hyperliquid', network: 'mainnet', account: ACCOUNT, destination: ACCOUNT,
    amount: '12.3', fee: '1', time: 1794370000123, createdAt: 1794370000, expiresAt: 1794370180 };
  it('has a pinned hash that every field changes, and a normal form for decimals', () => {
    expect(hex(venueWithdrawalHash(fixed))).toBe('e13a5ae262e2d6cbf292e782678453ce6b95994d2c91352741c50110da3cd4a5');
    expect(new TextDecoder().decode(venueWithdrawalBytes(fixed)).startsWith('SPW-VENUE-WITHDRAW-v1\0')).toBe(true);
    const patches: Partial<VenueWithdrawal>[] = [{ withdrawalId: '8b2c1f0e-8f5f-4b1e-9c56-0000000000bc' }, { keyId: 'spw-0123456789abcdee' }, { network: 'testnet' }, { account: OTHER.toLowerCase() }, { destination: OTHER.toLowerCase() },
      { amount: '12.31' }, { fee: '2' }, { time: 1794370000124 }, { createdAt: 1794370001 }, { expiresAt: 1794370181 }];
    const seen = new Set([hex(venueWithdrawalHash(fixed))]);
    for (const p of patches) seen.add(hex(venueWithdrawalHash({ ...fixed, ...p })));
    expect(seen.size).toBe(patches.length + 1);
    expect(() => venueWithdrawalHash({ ...fixed, destination: OTHER } as VenueWithdrawal)).toThrow();          // upper case: not canonical
    expect(() => venueWithdrawalHash({ ...fixed, amount: '1.0000001' })).toThrow();
    expect(() => venueWithdrawalHash({ ...fixed, extra: 1 } as never)).toThrow();
  });

  it('builds exactly the SDK\'s withdraw3 typed data: official vectors, mainnet and testnet', async () => {
    // tests/signing_test.py::test_sign_withdraw_from_bridge_action (Testnet) and the cross-vectors made with the SDK itself (fixtures/hyperliquid/sdk-vectors.json)
    const dest = '0x5e9ee1089755c3435139848e47e6635505d5a13a';
    const a = buildVenueWithdraw({ ...fixed, network: 'testnet', account: dest, destination: dest, amount: '1', time: 1687816341423 }, dest);
    expect(a.action).toEqual({ type: 'withdraw3', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination: dest, amount: '1', time: 1687816341423 });
    expect(sameSig(await signWith(SDK_TEST_KEY, a.typedData), { r: '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9', s: '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881', v: 28 })).toBe(true);
    const vectors = (fixture('sdk-vectors.json') as { user: { kind: string; network: 'mainnet' | 'testnet'; action: { destination: string; amount: string; time: number; hyperliquidChain: string; signatureChainId: string }; signature: { r: string; s: string; v: number } }[] }).user.filter((v) => v.kind === 'withdraw3');
    expect(vectors.map((v) => v.network).sort()).toEqual(['mainnet', 'testnet']);
    for (const v of vectors) {
      const b = buildVenueWithdraw({ ...fixed, network: v.network, account: v.action.destination, destination: v.action.destination, amount: v.action.amount, time: v.action.time }, v.action.destination);
      expect(b.action).toEqual({ type: 'withdraw3', hyperliquidChain: v.action.hyperliquidChain, signatureChainId: v.action.signatureChainId, destination: v.action.destination, amount: v.action.amount, time: v.action.time });
      expect(b.nonce).toBe(v.action.time);
      expect(b.typedData.domain).toEqual({ name: 'HyperliquidSignTransaction', version: '1', chainId: 0x66eee, verifyingContract: '0x0000000000000000000000000000000000000000' });
      expect(sameSig(await signWith(SDK_TEST_KEY, b.typedData), v.signature), v.network).toBe(true);
    }
    expect(() => buildVenueWithdraw({ ...fixed, destination: OTHER.toLowerCase() }, ACCOUNT)).toThrow(/own address only/);
    expect(() => buildVenueWithdraw(fixed, OTHER)).toThrow(/own address only/);
  });
});

describe('venue withdrawal: what the main key signs', () => {
  it('signs withdraw3 to the wallet\'s own address after the passkey approved the canonical withdrawal — recovered from the typed data', async () => {
    const w = await setup();
    for (const network of ['mainnet', 'testnet'] as const) {
      const x = withdrawal(w.t.now, { network, amount: '25.5' });
      const r = await withdraw(w, x);
      expect(r.action).toEqual({ type: 'withdraw3', hyperliquidChain: network === 'mainnet' ? 'Mainnet' : 'Testnet', signatureChainId: '0x66eee', destination: ACCOUNT, amount: '25.5', time: x.time });
      expect(r.nonce).toBe(x.time);
      expect(r.signer).toBe(ACCOUNT);
      expect(r.hash).toBe(hex(venueWithdrawalHash(x)));
      // an independent rebuild of the typed data from the returned action alone recovers the wallet address — what the venue does
      const td = buildWithdraw3TypedDataOnly({ network, destination: r.action.destination, amount: r.action.amount, time: r.action.time }).typedData;
      expect(await recoverTypedDataSigner(td, r.signature)).toBe(ACCOUNT);
      // and it is not valid for the other network's chain name
      const other = buildWithdraw3TypedDataOnly({ network: network === 'mainnet' ? 'testnet' : 'mainnet', destination: r.action.destination, amount: r.action.amount, time: r.action.time }).typedData;
      expect(await recoverTypedDataSigner(other, r.signature)).not.toBe(ACCOUNT);
    }
    expect(journal(w, 'venue.withdraw.ok').map((j) => j.data)).toMatchObject([{ network: 'mainnet', destination: ACCOUNT, amount: '25.5', fee: '1' }, { network: 'testnet', destination: ACCOUNT }]);
    expect(verifyAuditChain(w.store.state.journal)).toBeNull();
  });

  it('with the SDK\'s test key as wallet key, the signature is the one the SDK computes', async () => {
    const sdk = privateKeyToAccount(SDK_TEST_KEY), own = sdk.address.toLowerCase();
    const k: Keys = { ...keys, evmPriv: Uint8Array.from(Buffer.from(SDK_TEST_KEY.slice(2), 'hex')), addresses: { ...keys.addresses, evm: sdk.address, arbitrum: sdk.address } };
    const w = await setup(k), x = withdrawal(w.t.now, { account: own, destination: own, amount: '12.3' });
    const r = await withdraw(w, x);
    const expected = await signWith(SDK_TEST_KEY, buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: own, amount: '12.3', time: x.time }).typedData);
    expect(sameSig(r.signature, expected)).toBe(true);
    expect(r.signer).toBe('0x14791697260e4c9a71f18484c9f997b308e59325');
  });

  it('refuses any destination but the wallet\'s own address, even approved by the passkey', async () => {
    const w = await setup(), t = w.t.now, other = OTHER.toLowerCase();
    expect(await code(withdraw(w, withdrawal(t, { destination: other })))).toMatch(/^wrong_destination: a withdrawal is paid to the wallet's own address only/);
    expect(await code(withdraw(w, withdrawal(t, { account: other, destination: other })))).toMatch(/^wrong_source/);
    expect(await code(withdraw(w, withdrawal(t, { account: other })))).toMatch(/^wrong_source/);
    expect(await code(withdraw(w, withdrawal(t, { keyId: 'spw-0000000000000000' })))).toMatch(/^wrong_key/);
    expect(await code(withdraw(w, { ...withdrawal(t), destination: ME } as VenueWithdrawal, w.pk.assert(new Uint8Array(32))))).toMatch(/^bad_request/);     // not lower case: not canonical
    expect(journal(w, 'venue.withdraw.ok')).toHaveLength(0);
    expect(journal(w, 'venue.withdraw.denied').length).toBe(4);
  });

  it('refuses an amount that is not above the fee, a wrong fee, a stale or future time, a long or expired window', async () => {
    const w = await setup(), t = w.t.now;
    const cases: [Partial<VenueWithdrawal>, RegExp][] = [
      [{ amount: '1' }, /^unsupported: the amount must be greater than the venue's withdrawal fee \(1 USDC\)/],
      [{ amount: '0.5' }, /^unsupported: the amount must be greater/],
      [{ fee: '0.5' }, /^unsupported: the fee shown is not the venue's documented withdrawal fee/],
      [{ fee: '2' }, /^unsupported: the fee shown/],
      [{ time: (t + 61) * 1000 }, /^policy: withdrawal time is dated in the future/],
      [{ time: (t - 301) * 1000 }, /^policy: withdrawal time is stale/],
      [{ createdAt: t - 400, expiresAt: t - 100 }, /^policy: approval window expired/],
      [{ expiresAt: t + 301 }, /^policy: approval window too long/],
      [{ createdAt: t + 61, expiresAt: t + 120 }, /^policy: withdrawal dated in the future/],
    ];
    for (const [o, re] of cases) expect(await code(withdraw(w, withdrawal(t, o))), JSON.stringify(o)).toMatch(re);
    for (const bad of [{ amount: '-5' }, { amount: '1e3' }, { amount: '0' }, { amount: '5.1234567' }, { network: 'Mainnet' }, { venue: 'dydx' }, { time: 1.5 }, { v: 2 }])
      expect(await code(withdraw(w, { ...withdrawal(t), ...bad } as never, w.pk.assert(new Uint8Array(32)))), JSON.stringify(bad)).toMatch(/^bad_request/);
    expect(await code(withdraw(w, withdrawal(t, { amount: '1.000001' })))).toBe('ok');
    expect(journal(w, 'venue.withdraw.ok')).toHaveLength(1);
  });

  it('needs the owner\'s passkey over this exact withdrawal', async () => {
    const w = await setup(), t = w.t.now, x = withdrawal(t);
    expect(await code(w.signer.venueWithdraw(x, undefined))).toMatch(/^bad_approval: the owner's passkey approval is required/);
    expect(await code(withdraw(w, x, w.pk.assert(venueWithdrawalHash({ ...x, amount: '12.4' }))))).toMatch(/^bad_approval/);
    expect(await code(withdraw(w, x, w.pk.assert(venueWithdrawalHash({ ...x, network: 'testnet' }))))).toMatch(/^bad_approval/);   // an approval for testnet does not sign for mainnet
    expect(await code(withdraw(w, x, w.pk.assert(venueWithdrawalHash({ ...x, time: x.time + 1 }))))).toMatch(/^bad_approval/);
    expect(await code(withdraw(w, x, new TestPasskey(RP, ORIGIN).assert(venueWithdrawalHash(x))))).toMatch(/^unknown_credential/);
    expect(await code(withdraw(w, x, w.pk.assert(venueWithdrawalHash(x), { uv: false })))).toMatch(/^bad_approval/);
    // an approval of a DEPOSIT intent or of a venue authorization is not an approval of a withdrawal
    expect(await code(withdraw(w, x, w.pk.assert(intentHash(deposit(t)))))).toMatch(/^bad_approval/);
    expect(journal(w, 'venue.withdraw.ok')).toHaveLength(0);
    expect(await code(withdraw(w, x))).toBe('ok');
  });

  it('never signs the same withdrawal twice, nor an older time, across a restart; bounded per day; nothing under the halt', async () => {
    const w = await setup(), t = w.t.now, x = withdrawal(t);
    expect(await code(withdraw(w, x))).toBe('ok');
    expect(await code(withdraw(w, x))).toMatch(/^replay: withdrawal already signed/);
    const again = w.restart();
    expect(await code(again.venueWithdraw(x, w.pk.assert(venueWithdrawalHash(x))))).toMatch(/^replay/);
    const older = withdrawal(t, { time: x.time - 1 }), same = withdrawal(t, { time: x.time });
    expect(await code(again.venueWithdraw(older, w.pk.assert(venueWithdrawalHash(older))))).toMatch(/^stale_nonce/);
    expect(await code(again.venueWithdraw(same, w.pk.assert(venueWithdrawalHash(same))))).toMatch(/^stale_nonce/);
    // the other network has its own venue nonces
    const test = withdrawal(t, { network: 'testnet', time: x.time - 1 });
    expect(await code(again.venueWithdraw(test, w.pk.assert(venueWithdrawalHash(test))))).toBe('ok');
    const w2 = await setup();
    for (let k = 0; k < HL_WITHDRAWALS_PER_DAY; k++) expect(await code(withdraw(w2, withdrawal(w2.t.now)))).toBe('ok');
    expect(await code(withdraw(w2, withdrawal(w2.t.now)))).toMatch(/^policy: daily withdrawal count reached/);
    w2.t.now += 86400;
    expect(await code(withdraw(w2, withdrawal(w2.t.now)))).toBe('ok');
    w2.signer.halt();
    expect(await code(withdraw(w2, withdrawal(w2.t.now)))).toMatch(/^policy: emergency halt is active/);
  });
});

describe('nothing else is reachable with the main key on the venue', () => {
  const ACK = jurisdictionAck('hyperliquid', 'fr').sha256;
  const user = (network: 'mainnet' | 'testnet', action: unknown, typedData: HlTypedData): SignRequest => ({ venue: 'hyperliquid', network, kind: 'hl_user', payload: { scheme: 'user', action, typedData } });

  it('/venue/withdraw signs nothing it is handed: a smuggled action, typed data or destination is refused or ignored', async () => {
    const w = await setup(), t = w.t.now, x = withdrawal(t), other = OTHER.toLowerCase();
    const usdSend = { type: 'usdSend', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', destination: other, amount: '12.3', time: x.time };
    const td = userSignedTypedData(HL_PRIMARY.usdSend, HL_USD_SEND_TYPES, { hyperliquidChain: 'Mainnet', destination: other, amount: '12.3', time: x.time }, '0x66eee');
    for (const extra of [{ action: usdSend }, { typedData: td }, { sign: user('mainnet', usdSend, td) }, { type: 'usdSend' }, { toPerp: true }, { agentAddress: other }, { hyperliquidChain: 'Mainnet' }, { signatureChainId: '0xa4b1' }, { vaultAddress: other }, { subaccount: other }])
      expect(await code(withdraw(w, { ...x, ...extra } as never, w.pk.assert(venueWithdrawalHash(x)))), JSON.stringify(extra).slice(0, 40)).toMatch(/^bad_request: malformed venue withdrawal/);
    expect(journal(w, 'venue.withdraw.ok')).toHaveLength(0);
    // what does get signed is withdraw3 and only withdraw3: the signature verifies for NO other user-signed action with the same fields
    const r = await withdraw(w, x);
    const asUsdSend = userSignedTypedData(HL_PRIMARY.usdSend, HL_USD_SEND_TYPES, { hyperliquidChain: 'Mainnet', destination: ACCOUNT, amount: '12.3', time: x.time }, '0x66eee');
    expect(await recoverTypedDataSigner(asUsdSend, r.signature)).not.toBe(ACCOUNT);
    expect(await recoverTypedDataSigner(buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: ACCOUNT, amount: '12.3', time: x.time }).typedData, r.signature)).toBe(ACCOUNT);
  });

  it('/venue/sign (trading key) still refuses withdraw3, usdSend, spotSend, usdClassTransfer and an approveAgent', async () => {
    const w = await setup(), t = w.t.now, other = OTHER.toLowerCase();
    const a: VenueAuthorization = { v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'mainnet', account: ACCOUNT, agentAddress: keys.venueKey('hyperliquid', 'mainnet').address, agentName: 'spw-live', mode: 'MANUAL_LIVE',
      policy: { allowedInstruments: ['hyperliquid:BTC'], maxLeverage: 3, maxOrderNotional: '200', maxPositionNotional: '400', maxGrossExposure: '600', maxOrdersPerDay: 5, maxPriceDeviationBps: 300 },
      createdAt: t, expiresAt: t + 30 * 86400, approveNonce: t * 1000, ackSha256: ACK };
    await w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a)));
    const nonce = t * 1000 + 7;
    const wd = buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: other, amount: '5', time: nonce });
    const own = buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: ACCOUNT, amount: '5', time: nonce });
    const xfer = buildUsdClassTransferTypedDataOnly({ network: 'mainnet', amount: '5', toPerp: false, nonce });
    const send = { type: 'usdSend', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', destination: other, amount: '5', time: nonce };
    const sendTd = userSignedTypedData(HL_PRIMARY.usdSend, HL_USD_SEND_TYPES, { hyperliquidChain: 'Mainnet', destination: other, amount: '5', time: nonce }, '0x66eee');
    const spot = { type: 'spotSend', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', destination: other, token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '5', time: nonce };
    const spotTd = userSignedTypedData('HyperliquidTransaction:SpotSend', [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'token', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
      { hyperliquidChain: 'Mainnet', destination: other, token: spot.token, amount: '5', time: nonce }, '0x66eee');
    const agent = buildApproveAgent({ network: 'mainnet', agentAddress: other, agentName: 'evil', nonce });
    const tryIt = (sign: SignRequest) => code(w.signer.venueSign({ authorizationId: a.authorizationId, sign, assertion: w.pk.assert(new Uint8Array(32)) }));
    expect(await tryIt(user('mainnet', wd.action, wd.typedData))).toMatch(/^unsupported: this payload is not an order.*withdraw3/);
    expect(await tryIt(user('mainnet', own.action, own.typedData))).toMatch(/^unsupported: this payload is not an order.*withdraw3/);     // even to the own address: only /venue/withdraw, with its own passkey object
    expect(await tryIt(user('mainnet', xfer.action, xfer.typedData))).toMatch(/^unsupported: this payload is not an order.*usdClassTransfer/);
    expect(await tryIt(user('mainnet', send, sendTd))).toMatch(/^unsupported: this payload is not an order.*usdSend/);
    expect(await tryIt(user('mainnet', spot, spotTd))).toMatch(/^unsupported: this payload is not an order.*spotSend/);
    expect(await tryIt(user('mainnet', agent.action, agent.typedData))).toMatch(/^unsupported: an agent approval can only be signed through \/venue\/authorize/);
    // and a describe() of the pinned trading object calls every one of them `other`
    const trading = createHlTrading({ network: 'mainnet', assets: hlPinnedAssets('mainnet') });
    for (const [act, td] of [[wd.action, wd.typedData], [send, sendTd], [spot, spotTd], [xfer.action, xfer.typedData]] as const) expect(trading.describe(user('mainnet', act, td)).kind).toBe('other');
    expect(journal(w, 'venue.sign.ok')).toHaveLength(0);
  });

  it('an approveAgent for another agent cannot pass through the withdrawal path, and the authorization path still names only the signer\'s own trading key', async () => {
    const w = await setup(), t = w.t.now;
    const a = { v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'mainnet', account: ACCOUNT, agentAddress: OTHER.toLowerCase(), agentName: 'spw-live', mode: 'MANUAL_LIVE',
      policy: { allowedInstruments: ['hyperliquid:BTC'], maxLeverage: 3, maxOrderNotional: '200', maxPositionNotional: '400', maxGrossExposure: '600', maxOrdersPerDay: 5, maxPriceDeviationBps: 300 },
      createdAt: t, expiresAt: t + 86400, approveNonce: t * 1000, ackSha256: ACK } as VenueAuthorization;
    expect(await code(w.signer.venueWithdraw(a, w.pk.assert(venueAuthorizationHash(a))))).toMatch(/^bad_request: malformed venue withdrawal/);
    expect(await code(w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a))))).toMatch(/^wrong_agent/);
  });

  it('the HTTP surface has one collateral route; no transfer, send or generic typed-data route exists', async () => {
    const w = await setup(), secret = 's'.repeat(48);
    const srv = createSignerServer(w.signer, secret).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown) => { const b = JSON.stringify(body); const r = await fetch(url + path, { method: 'POST', headers: { 'x-spw-auth': authHeader(secret, 'POST', path, b) }, body: b }); return { status: r.status, json: await r.json() as { error?: string; action?: { type: string; destination: string } } }; };
    for (const path of ['/venue/usdSend', '/venue/send', '/venue/transfer', '/venue/spotSend', '/venue/usdClassTransfer', '/venue/deposit', '/venue/sign-typed-data', '/venue/withdraw/other', '/sign-typed-data'])
      expect((await post(path, { withdrawal: withdrawal(w.t.now) })).status, path).toBe(404);
    const x = withdrawal(w.t.now);
    expect((await post('/venue/withdraw', { withdrawal: x })).json.error).toBe('bad_approval');
    expect((await post('/venue/withdraw', { withdrawal: { ...x, destination: OTHER.toLowerCase() }, assertion: w.pk.assert(venueWithdrawalHash({ ...x, destination: OTHER.toLowerCase() })) })).json.error).toBe('wrong_destination');
    const ok = await post('/venue/withdraw', { withdrawal: x, assertion: w.pk.assert(venueWithdrawalHash(x)) });
    expect(ok.status).toBe(200);
    expect(ok.json.action).toMatchObject({ type: 'withdraw3', destination: ACCOUNT });
    srv.close();
  });

  it('source scan: the wallet key is used for the venue in exactly two places, and no other user-signed builder is imported by the signer', () => {
    const dir = new URL('../src/', import.meta.url);
    const src = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
    const uses = (f: string) => (src[f]!.match(/keys\.evmPriv/g) ?? []).length;
    expect(uses('venue.ts')).toBe(1);             // approveAgent, inside venueAuthorize
    expect(uses('venue-collateral.ts')).toBe(1);  // withdraw3, inside venueWithdraw
    expect(Object.keys(src).filter((f) => /evmPriv/.test(src[f]!)).sort()).toEqual(['keys.ts', 'signer.ts', 'venue-collateral.ts', 'venue.ts']);
    const code = Object.values(src).join('\n').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of ['usdSend', 'spotSend', 'sendAsset', 'UsdClassTransfer', 'userSignedTypedData', 'buildWithdraw3TypedDataOnly', 'signTypedData', 'signMessage('])
      expect(code.includes(forbidden), forbidden).toBe(false);
    // the only two typed-data signatures of the main key: over what buildApproveAgent and buildVenueWithdraw produced
    expect(src['venue-collateral.ts']!).toMatch(/typedDataDigest\(built\.typedData\)/);
    expect(src['venue.ts']!).toMatch(/typedDataDigest\(\(built\.sign\.payload as HlUserSignPayload\)\.typedData\)/);
  });
});
