/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/mandate.test.ts
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

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from 'viem';
import { intentHash, KYBER_NATIVE, KYBER_ROUTER, KYBER_ROUTER_ABI, mandateHash, NETWORKS, swapDataHash, vaultKeyId, type Intent, type Mandate } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id, LINK = NETWORKS.base.tokens.find((t) => t.symbol === 'LINK')!.id;
const VAULT = keys.vault(1).address;
let n = 0;
const uuid = () => `7a1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`;

async function setup() {
  const t = { now: Math.floor(Date.now() / 1000) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-mandate-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px = { ETH: 2000, USDC: 1, LINK: 10, fail: '' };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, { get: async (syms) => { if (px.fail) throw new Error(px.fail); return Object.fromEntries(syms.map((s) => [s, (px as unknown as Record<string, number>)[s]!])); } });
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  return { signer, store, pk, t, px };
}
const mandate = (now: number, o: Partial<Mandate> = {}): Mandate => ({ v: 1, mandateId: uuid(), keyId: keys.keyId, vaultIndex: 1, vault: VAULT, network: 'base', provider: 'kyberswap',
  assets: ['native', USDC], maxOrder: { [USDC]: '20000000', native: '10000000000000000' }, maxDaily: { [USDC]: '50000000', native: '20000000000000000' }, maxOrdersPerDay: 4, maxSlippageBps: 150,
  createdAt: now, expiresAt: now + 30 * 86400, strategySha256: 'ab'.repeat(32), label: 'ETH trend', ...o });
/** A swap order for the vault: USDC -> ETH by default, with router calldata paying `receiver`. */
function order(now: number, o: { amount?: bigint; to?: string; receiver?: string; from?: string; fromAsset?: string; toAsset?: string; keyId?: string; minOut?: bigint; network?: string } = {}) {
  const amount = o.amount ?? 10_000000n, fromAsset = o.fromAsset ?? USDC, toAsset = o.toAsset ?? 'native', minOut = o.minOut ?? (amount * 10n ** 12n * 99n) / (2000n * 100n); // USDC -> ETH at 2000 USD/ETH, guaranteeing 99 % of the value
  const tok = (a: string) => (a === 'native' ? KYBER_NATIVE : a);
  const desc = { srcToken: tok(fromAsset), dstToken: tok(toAsset), srcReceivers: [], srcAmounts: [], feeReceivers: [], feeAmounts: [], dstReceiver: o.receiver ?? VAULT, amount, minReturnAmount: minOut, flags: 0n, permit: '0x' };
  const data = encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: 'swap', args: [{ callTarget: '0x8F10B468b06c6FD214B65F87778827F7D113f996', approveTarget: '0x0000000000000000000000000000000000000000', targetData: '0xabcd', desc, clientData: '0x' }] as never });
  const src = fromAsset === 'native' ? NETWORKS.base.native : NETWORKS.base.tokens.find((t) => t.id === fromAsset)!;
  const intent: Intent = { v: 1, proposalId: uuid(), keyId: o.keyId ?? vaultKeyId(keys.keyId, 1), network: o.network ?? 'base', chainRef: '8453', asset: fromAsset, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
    from: o.from ?? VAULT, to: o.to ?? VAULT, maxFee: '200000000000000', createdAt: now, expiresAt: now + 90, policyVersion: 4,
    swap: { provider: 'kyberswap', toAsset, minOut: minOut.toString(), router: KYBER_ROUTER, dataHash: swapDataHash(data), approveGas: fromAsset === 'native' ? '0' : '70000' },
    evm: { nonce: 0, gasLimit: '600000', maxFeePerGas: '200000000', maxPriorityFeePerGas: '1000000' } };
  return { intent, aux: { swapData: data } };
}

describe('agent vaults', () => {
  it('a vault is a separate key from the owner wallet and from other vaults', () => {
    expect(VAULT).not.toBe(keys.addresses.evm);
    expect(keys.vault(2).address).not.toBe(VAULT);
    expect(() => keys.vault(0)).toThrow(); // account 0 is the owner's wallet: never a vault
  });
});

describe('mandate approval (passkey over the canonical hash)', () => {
  it('needs the owner passkey, the right vault derivation and sane limits', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now);
    await expect(signer.approveMandate(m, new TestPasskey(RP, ORIGIN).assert(mandateHash(m)))).rejects.toThrow(/enrolled/);
    await expect(signer.approveMandate(m, pk.assert(mandateHash(mandate(t.now, { maxDaily: { [USDC]: '99999000000', native: '20000000000000000' } }))))).rejects.toThrow(); // approval for other limits
    for (const bad of [{ vault: keys.addresses.evm }, { vault: keys.vault(2).address }, { keyId: 'spw-ffffffffffffffff' }, { network: 'ethereum' }, { expiresAt: t.now + 200 * 86400 }, { expiresAt: t.now - 1 },
      { assets: ['native', '0xdAC17F958D2ee523a2206206994597C13D831ec7'] }, { maxOrder: { [USDC]: '60000000' }, maxDaily: { [USDC]: '50000000' } }, { maxOrder: { [LINK]: '1' }, maxDaily: { [LINK]: '1' } }, { createdAt: t.now - 3600 }] as Partial<Mandate>[]) {
      const x = mandate(t.now, bad);
      await expect(signer.approveMandate(x, pk.assert(mandateHash(x))), JSON.stringify(bad)).rejects.toThrow();
    }
    const ok = await signer.approveMandate(m, pk.assert(mandateHash(m)));
    expect(ok.mandateId).toBe(m.mandateId);
    await expect(signer.approveMandate(m, pk.assert(mandateHash(m)))).rejects.toThrow(/already recorded/);
    expect(signer.status().mandates.length).toBe(1);
  });
  it('every field is part of the hash', () => {
    const now = 1_800_000_000, base = mandate(now), h = Buffer.from(mandateHash(base)).toString('hex');
    const muts: Mandate[] = [{ ...base, maxOrdersPerDay: 5 }, { ...base, expiresAt: base.expiresAt + 1 }, { ...base, maxOrder: { ...base.maxOrder, [USDC]: '20000001' } }, { ...base, maxDaily: { ...base.maxDaily, native: '20000000000000001' } },
      { ...base, assets: ['native', USDC, LINK] }, { ...base, strategySha256: 'cd'.repeat(32) }, { ...base, vaultIndex: 2 }, { ...base, label: 'x' }];
    const hs = new Set(muts.map((m) => Buffer.from(mandateHash(m)).toString('hex')));
    expect(hs.size).toBe(muts.length); expect(hs.has(h)).toBe(false);
    expect(Buffer.from(mandateHash({ ...base, assets: [USDC, 'native'] })).toString('hex')).toBe(h); // order of the list is not meaningful
  });
});

describe('delegated orders', () => {
  it('signs an order that fits the mandate, with the vault key, without a passkey', async () => {
    const { signer, pk, t, store } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const { intent, aux } = order(t.now);
    const r = await signer.signDelegated(m.mandateId, intent, aux);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(VAULT);
    expect(await recoverTransactionAddress({ serializedTransaction: r.pre!.raw as never })).toBe(VAULT);
    const approve = parseTransaction(r.pre!.raw as `0x${string}`);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data! }).args).toEqual([KYBER_ROUTER, 10_000000n]);
    expect(parseTransaction(r.raw as `0x${string}`).to!.toLowerCase()).toBe(KYBER_ROUTER.toLowerCase());
    expect(store.state.journal.some((j) => j.type === 'delegated.ok')).toBe(true);
    expect(signer.status().mandates[0]!.today).toEqual({ sold: { [USDC]: '10000000' }, orders: 1 });
  });
  it('refuses everything outside the mandate', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const no = async (label: string, o: Parameters<typeof order>[1], re: RegExp) => { const x = order(t.now, o); await expect(signer.signDelegated(m.mandateId, x.intent, x.aux), label).rejects.toThrow(re); };
    await no('above the per-order limit', { amount: 20_000001n }, /per-order/);
    await no('asset outside the mandate', { toAsset: LINK }, /outside the mandate/);
    await no('output paid elsewhere (calldata)', { receiver: keys.addresses.evm }, /another address/);
    await no('intent recipient is not the vault', { to: keys.addresses.evm }, /vault itself/);
    await no('spending from the owner wallet', { from: keys.addresses.evm, to: keys.addresses.evm, receiver: keys.addresses.evm }, /vault itself/);
    await no('owner key id', { keyId: keys.keyId }, /vault key/);
    await no('another vault key id', { keyId: vaultKeyId(keys.keyId, 2) }, /vault key/);
    await no('zero minimum output', { minOut: 0n }, /positive/);
    await no('sold far below market: guarantees 80 % of the value', { minOut: 4_000000000000000n }, /at market price/);
    await expect(signer.signDelegated('7a1c1f0e-8f5f-4b1e-9c56-999999999999', order(t.now).intent, order(t.now).aux)).rejects.toThrow(/unknown mandate/);
    // a plain transfer is not a delegated order
    const x = order(t.now); const transfer = { ...x.intent, swap: undefined, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' };
    await expect(signer.signDelegated(m.mandateId, transfer, {})).rejects.toThrow(/only swaps/);
    // tampered calldata
    const y = order(t.now); await expect(signer.signDelegated(m.mandateId, y.intent, { swapData: y.aux.swapData.slice(0, -2) + '11' })).rejects.toThrow(/approved hash/);
  });
  it('enforces daily volume, order count, replay, expiry, revocation and halt', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const go = (o?: Parameters<typeof order>[1]) => { const x = order(t.now, o); return signer.signDelegated(m.mandateId, x.intent, x.aux); };
    const first = order(t.now, { amount: 20_000000n });
    await signer.signDelegated(m.mandateId, first.intent, first.aux);
    await expect(signer.signDelegated(m.mandateId, first.intent, first.aux)).rejects.toThrow(/already signed/);
    await go({ amount: 20_000000n });
    await expect(go({ amount: 10_000001n })).rejects.toThrow(/daily volume/); // 40 + 10.000001 > 50
    await go({ amount: 5_000000n }); await go({ amount: 1_000000n });
    await expect(go({ amount: 1n })).rejects.toThrow(/order count/); // 4 orders today
    t.now += 86400; await go({ amount: 1_000000n }); // limits are per UTC day
    signer.revokeMandate(m.mandateId);
    await expect(go({ amount: 1_000000n })).rejects.toThrow(/revoked/);
    // an expired mandate, and a halted signer
    const m2 = mandate(t.now, { expiresAt: t.now + 3600 }); await signer.approveMandate(m2, pk.assert(mandateHash(m2)));
    t.now += 3601; const late = order(t.now); await expect(signer.signDelegated(m2.mandateId, late.intent, late.aux)).rejects.toThrow(/expired/);
    const m3 = mandate(t.now); await signer.approveMandate(m3, pk.assert(mandateHash(m3)));
    signer.halt(); const h = order(t.now); await expect(signer.signDelegated(m3.mandateId, h.intent, h.aux)).rejects.toThrow(/halt/);
    const m4 = mandate(t.now); await expect(signer.approveMandate(m4, pk.assert(mandateHash(m4)))).rejects.toThrow(/halt/);
  });
  it('the owner path cannot be used for a vault, and a vault order cannot be signed with an owner approval', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const x = order(t.now);
    await expect(signer.sign(x.intent, pk.assert(intentHash(x.intent)), x.aux)).rejects.toThrow(/another key|not controlled/);
  });
});

describe('the signer\'s own price view', () => {
  it('refuses an order when prices cannot be established, and applies the mandate tolerance exactly', async () => {
    const { signer, pk, t, px } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const at = (minOut: bigint) => { const x = order(t.now, { minOut }); return signer.signDelegated(m.mandateId, x.intent, x.aux); };
    await expect(at(4_924000000000000n)).rejects.toThrow(/at market price/); // 98.48 % < 98.5 %
    await at(4_926000000000000n);                                             // 98.52 % ≥ 98.5 %
    px.ETH = 1000; // the market halves: the same guaranteed ETH is now worth half the USDC given up
    await expect(at(4_950000000000000n)).rejects.toThrow(/at market price/);
    px.ETH = 2000; px.fail = 'price sources disagree on ETH';
    await expect(at(4_950000000000000n)).rejects.toThrow(/market price unavailable/);
    px.fail = '';
    await at(4_950000000000000n);
    expect(signer.status().mandates[0]!.today.orders).toBe(2); // refused orders are not counted
  });
});

describe('returning funds', () => {
  it('without any mandate, on any EVM network: a vault still only pays the owner (funds sent to a vault on another network can come back)', async () => {
    const { signer, t } = await setup();
    const ETH_USDC = NETWORKS.ethereum.tokens.find((x) => x.symbol === 'USDC')!.id;
    const ret = (to: string, o: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: uuid(), keyId: vaultKeyId(keys.keyId, 1), network: 'ethereum', chainRef: '1', asset: ETH_USDC, symbol: 'USDC', decimals: 6, amount: '20000000',
      from: VAULT, to, maxFee: '2000000000000000', createdAt: t.now, expiresAt: t.now + 90, policyVersion: 2, evm: { nonce: 0, gasLimit: '90000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' }, ...o });
    await expect(signer.signVaultReturn(1, ret('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'))).rejects.toThrow(/owner/);
    await expect(signer.signVaultReturn(1, ret(keys.addresses.evm, { from: keys.addresses.evm }))).rejects.toThrow(/vault/);
    await expect(signer.signVaultReturn(2, ret(keys.addresses.evm))).rejects.toThrow(/not for this vault/);          // another vault's key cannot be borrowed
    await expect(signer.signVaultReturn(0, ret(keys.addresses.evm))).rejects.toThrow(/vault index/);                 // index 0 is the owner's own key
    await expect(signer.signVaultReturn(1, ret(keys.addresses.evm, { maxFee: '900000000000000000' }))).rejects.toThrow(/fee ceiling/);
    await expect(signer.signVaultReturn(1, ret(keys.addresses.evm, { network: 'solana', chainRef: 'x' }))).rejects.toThrow();
    const ok = ret(keys.addresses.evm), r = await signer.signVaultReturn(1, ok);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(VAULT);
    await expect(signer.signVaultReturn(1, ok)).rejects.toThrow(/already signed/);
  });
  it('a vault only ever pays the owner\'s own address, even after revocation', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const ret = (to: string, o: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: uuid(), keyId: vaultKeyId(keys.keyId, 1), network: 'base', chainRef: '8453', asset: USDC, symbol: 'USDC', decimals: 6, amount: '30000000',
      from: VAULT, to, maxFee: '200000000000000', createdAt: t.now, expiresAt: t.now + 90, policyVersion: 4, evm: { nonce: 3, gasLimit: '90000', maxFeePerGas: '200000000', maxPriorityFeePerGas: '1000000' }, ...o });
    await expect(signer.signReturn(m.mandateId, ret('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'))).rejects.toThrow(/owner/);
    await expect(signer.signReturn(m.mandateId, ret(keys.addresses.evm, { from: keys.addresses.evm }))).rejects.toThrow(/vault/);
    signer.revokeMandate(m.mandateId);
    const r = await signer.signReturn(m.mandateId, ret(keys.addresses.evm));
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(VAULT);
    const tx = parseTransaction(r.raw as `0x${string}`);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args).toEqual([keys.addresses.evm, 30_000000n]); // more than any order limit: returning is not limited
  });
});

// V11 Phase B (D2): one mandate in force per vault, and a revocation that needs no passkey
describe('V11 — one active mandate per vault', () => {
  it('a second mandate on the same vault is refused while the first is in force — also on another network; never after revocation or expiry', async () => {
    const { signer, store, pk, t } = await setup();
    const first = mandate(t.now); await signer.approveMandate(first, pk.assert(mandateHash(first)));
    const second = mandate(t.now, { maxOrdersPerDay: 400 });
    await expect(signer.approveMandate(second, pk.assert(mandateHash(second)))).rejects.toThrow(/another mandate is active on this vault: revoke it first/);
    // the same vault address exists on every EVM network: a mandate there would add its caps to the first one's
    const arb = mandate(t.now, { network: 'arbitrum', assets: ['native', NETWORKS.arbitrum.tokens.find((x) => x.symbol === 'USDC')!.id], maxOrder: { native: '10000000000000000' }, maxDaily: { native: '20000000000000000' } });
    await expect(signer.approveMandate(arb, pk.assert(mandateHash(arb)))).rejects.toMatchObject({ code: 'conflict' });
    expect(signer.status().mandates.filter((x) => !x.revoked)).toHaveLength(1);
    expect(store.state.journal.filter((j) => j.type === 'mandate.denied').at(-1)!.data).toMatchObject({ code: 'conflict' });
    // the first still signs, the refused ones never do
    const o0 = order(t.now);
    expect((await signer.signDelegated(first.mandateId, o0.intent, o0.aux)).txid).toMatch(/^0x/);
    const ox = order(t.now);
    await expect(signer.signDelegated(second.mandateId, ox.intent, ox.aux)).rejects.toThrow(/unknown mandate/);
    // another vault is another matter
    const other = mandate(t.now, { vaultIndex: 2, vault: keys.vault(2).address });
    await signer.approveMandate(other, pk.assert(mandateHash(other)));
    // revocation — no passkey — frees the vault; the revoked mandate never signs again, the new one does
    signer.revokeMandate(first.mandateId);
    const o1 = order(t.now);
    await expect(signer.signDelegated(first.mandateId, o1.intent, o1.aux)).rejects.toThrow(/mandate revoked/);
    await signer.approveMandate(second, pk.assert(mandateHash(second)));
    const o2 = order(t.now);
    expect((await signer.signDelegated(second.mandateId, o2.intent, o2.aux)).txid).toMatch(/^0x/);
    // expiry frees it too
    t.now += 31 * 86400;
    const third = mandate(t.now);
    await signer.approveMandate(third, pk.assert(mandateHash(third)));
    expect(signer.status().mandates.filter((x) => x.mandate.vaultIndex === 1 && !x.revoked && !x.expired).map((x) => x.mandate.mandateId)).toEqual([third.mandateId]);
  });
  it('revoking is idempotent, needs no passkey, and an unknown id is an error — not a silent success', async () => {
    const { signer, pk, t } = await setup();
    const m = mandate(t.now); await signer.approveMandate(m, pk.assert(mandateHash(m)));
    signer.revokeMandate(m.mandateId); const at = signer.status().mandates[0]!.revokedAt;
    t.now += 50; signer.revokeMandate(m.mandateId);
    expect(signer.status().mandates[0]).toMatchObject({ revoked: true, revokedAt: at });
    expect(() => signer.revokeMandate(uuid())).toThrow(/unknown mandate/);
  });
});
