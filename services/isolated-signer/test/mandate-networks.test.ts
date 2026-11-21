/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/mandate-networks.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// V5: mandates on every execution-enabled EVM network. Every check of the signer must hold network by network: chain id,
// pinned router, fee ceiling of the policy for THAT network, the reduced router of HyperEVM, and the price check against
// the UNDERLYING of a wrapped asset.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseTransaction, recoverTransactionAddress } from 'viem';
import { cashLegs, DEFAULT_POLICY, getNetwork, KYBER_NATIVE, KYBER_ROUTER, KYBER_ROUTER_ABI, MANDATE_NETWORKS, mandateHash, swapDataHash, vaultKeyId, type Intent, type Mandate } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
let n = 0;
const uuid = () => `8b2d2f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`;
const PX: Record<string, number> = { ETH: 2000, BTC: 60_000, POL: 0.5, BNB: 600, AVAX: 20, HYPE: 25, LINK: 10, USDC: 1, USDT: 1 };

async function setup(policy?: (maxFee: Record<string, string>) => Record<string, string>) {
  const t = { now: Math.floor(Date.now() / 1000) }, asked: string[][] = [];
  const dir = mkdtempSync(join(tmpdir(), 'spw-mandate-net-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  if (policy) store.policy = { ...store.policy, maxFee: policy({ ...store.policy.maxFee }) };
  // like the real view: a symbol it cannot price throws
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, { get: async (syms) => { asked.push(syms); return Object.fromEntries(syms.map((s) => { if (PX[s] === undefined) throw new Error(`no price source for ${s}`); return [s, PX[s]]; })); } });
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  return { signer, store, pk, t, asked };
}
const asset = (network: string, id: string) => { const net = getNetwork(network); return id === 'native' ? net.native : net.tokens.find((x) => x.id === id)!; };
const mandate = (network: string, index: number, assets: string[], now: number, o: Partial<Mandate> = {}): Mandate => ({ v: 1, mandateId: uuid(), keyId: keys.keyId, vaultIndex: index, vault: keys.vault(index).address, network, provider: 'kyberswap', assets,
  maxOrder: Object.fromEntries(assets.map((a) => [a, (10n ** BigInt(asset(network, a).decimals + 2)).toString()])), maxDaily: Object.fromEntries(assets.map((a) => [a, (10n ** BigInt(asset(network, a).decimals + 3)).toString()])),
  maxOrdersPerDay: 20, maxSlippageBps: 150, createdAt: now, expiresAt: now + 30 * 86400, strategySha256: 'cd'.repeat(32), label: `agent on ${network}`, ...o });
/** A router order of `amount` base units of `from` for `to`, guaranteeing `keep` of the input's value at the prices `pIn` / `pOut`. */
function order(network: string, index: number, now: number, from: string, to: string, amount: bigint, pIn: number, pOut: number, o: { keep?: number; fn?: 'swap' | 'swapGeneric'; flags?: bigint; chainRef?: string; maxFee?: string; maxFeePerGas?: string } = {}) {
  const src = asset(network, from), dst = asset(network, to), vault = keys.vault(index).address;
  const minOut = BigInt(Math.floor((Number(amount) / 10 ** src.decimals) * pIn / pOut * (o.keep ?? 0.99) * 1e8)) * 10n ** BigInt(dst.decimals) / 10n ** 8n;
  const tok = (a: string) => (a === 'native' ? KYBER_NATIVE : a);
  const desc = { srcToken: tok(from), dstToken: tok(to), srcReceivers: [], srcAmounts: [], feeReceivers: [], feeAmounts: [], dstReceiver: vault, amount, minReturnAmount: minOut, flags: o.flags ?? 0n, permit: '0x' };
  const data = encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: o.fn ?? 'swap', args: [{ callTarget: '0x8F10B468b06c6FD214B65F87778827F7D113f996', approveTarget: '0x0000000000000000000000000000000000000000', targetData: '0xabcd', desc, clientData: '0x' }] as never });
  const maxFeePerGas = o.maxFeePerGas ?? '200000000';
  const intent: Intent = { v: 1, proposalId: uuid(), keyId: vaultKeyId(keys.keyId, index), network, chainRef: o.chainRef ?? getNetwork(network).chainRef, asset: from, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
    from: vault, to: vault, maxFee: o.maxFee ?? (670_000n * BigInt(maxFeePerGas)).toString(), createdAt: now, expiresAt: now + 90, policyVersion: DEFAULT_POLICY.version,
    swap: { provider: 'kyberswap', toAsset: to, minOut: minOut.toString(), router: KYBER_ROUTER, dataHash: swapDataHash(data), approveGas: from === 'native' ? '0' : '70000' },
    evm: { nonce: 0, gasLimit: '600000', maxFeePerGas, maxPriorityFeePerGas: '1000000' } };
  return { intent, aux: { swapData: data } };
}
const tokenId = (network: string, symbol: string) => getNetwork(network).tokens.find((x) => x.symbol === symbol)!.id;

describe('delegated orders, network by network', () => {
  it('signs for the mandate network only: its chain id, the pinned router, the vault of that agent', async () => {
    const { signer, pk, t, asked } = await setup();
    const withCash = MANDATE_NETWORKS.filter((id) => cashLegs(getNetwork(id)).length > 0);
    // derived from the registry, so a network that gains a cash leg is exercised with no change here; these eight must be there
    // (BNB Smart Chain since registry v5: Binance-Peg USDC, 18 decimals — the only cash leg that is not in 6 decimals)
    expect(withCash).toEqual(expect.arrayContaining(['base', 'ethereum', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche', 'hyperevm']));
    expect(cashLegs(getNetwork('bsc'))[0]).toMatchObject({ symbol: 'USDC', decimals: 18 });
    const ten = (id: string) => 10n * 10n ** BigInt(cashLegs(getNetwork(id))[0]!.decimals); // 10 units of that network's cash leg, in ITS decimals
    const made: Record<string, { m: Mandate; index: number; cash: string }> = {};
    for (const [k, id] of withCash.entries()) {
      const index = k + 1, cash = cashLegs(getNetwork(id))[0]!, m = mandate(id, index, ['native', cash.id], t.now); // one vault index per agent, whatever its network
      await signer.approveMandate(m, pk.assert(mandateHash(m)));
      made[id] = { m, index, cash: cash.id };
    }
    for (const id of withCash) {
      const { m, index, cash } = made[id]!, net = getNetwork(id);
      const o = order(id, index, t.now, cash, 'native', ten(id), 1, PX[net.native.symbol]!);
      expect(BigInt(o.intent.swap!.minOut) > 0n, id).toBe(true);
      const r = await signer.signDelegated(m.mandateId, o.intent, o.aux);
      const tx = parseTransaction(r.raw as `0x${string}`), pre = parseTransaction(r.pre!.raw as `0x${string}`);
      expect(tx.chainId, id).toBe(Number(net.chainRef)); expect(pre.chainId, id).toBe(Number(net.chainRef)); // a signature valid on that chain only
      expect(tx.to?.toLowerCase(), id).toBe(KYBER_ROUTER.toLowerCase());
      expect(pre.to?.toLowerCase(), id).toBe(cash.toLowerCase()); // exact-amount approval on that network's own token
      expect(await recoverTransactionAddress({ serializedTransaction: r.raw as `0x02${string}` }), id).toBe(keys.vault(index).address);
      expect(asked.at(-1), id).toEqual(['USDC', net.native.symbol]);
    }
    // decimals are the asset's own, network by network: 10 USDC on BNB Smart Chain is 10^19 base units, and the price check values
    // it as 10 USD — an order guaranteeing 90 % of that is refused there exactly as on a 6-decimal network
    for (const id of ['bsc', 'base']) { const { m, index, cash } = made[id]!, net = getNetwork(id);
      const thin = order(id, index, t.now, cash, 'native', ten(id), 1, PX[net.native.symbol]!, { keep: 0.9 });
      await expect(signer.signDelegated(m.mandateId, thin.intent, thin.aux), id).rejects.toThrow(/guaranteed output is worth 90\.00 %/);
      const big = order(id, index, t.now, cash, 'native', 101n * 10n ** BigInt(cashLegs(net)[0]!.decimals), 1, PX[net.native.symbol]!); // the helper's mandate caps an order at 100 units
      await expect(signer.signDelegated(m.mandateId, big.intent, big.aux), id).rejects.toThrow(/order above the per-order limit/); }
    // a mandate never serves another network, even for the same vault key and the same assets by symbol
    const b = made.base!, a = made.arbitrum!;
    const cross = order('arbitrum', b.index, t.now, a.cash, 'native', 10_000000n, 1, 2000);
    await expect(signer.signDelegated(b.m.mandateId, cross.intent, cross.aux)).rejects.toThrow(/network outside the mandate/);
    const wrongChain = order('base', b.index, t.now, b.cash, 'native', 10_000000n, 1, 2000, { chainRef: '42161' });
    await expect(signer.signDelegated(b.m.mandateId, wrongChain.intent, wrongChain.aux)).rejects.toThrow(/chain identity mismatch/);
    const otherVault = order('arbitrum', b.index, t.now, a.cash, 'native', 10_000000n, 1, 2000); // Base agent's key on the Arbitrum mandate
    await expect(signer.signDelegated(a.m.mandateId, otherVault.intent, otherVault.aux)).rejects.toThrow(/not for this vault key/);
  });

  it('applies the fee ceiling of the policy for the order\'s own network', async () => {
    const { signer, store, pk, t } = await setup();
    const eth = mandate('ethereum', 1, ['native', tokenId('ethereum', 'USDC')], t.now), arb = mandate('arbitrum', 2, ['native', tokenId('arbitrum', 'USDC')], t.now);
    await signer.approveMandate(eth, pk.assert(mandateHash(eth))); await signer.approveMandate(arb, pk.assert(mandateHash(arb)));
    expect(BigInt(store.policy.maxFee.ethereum!)).toBeGreaterThan(BigInt(store.policy.maxFee.arbitrum!));
    const fee = { maxFeePerGas: '2000000000', maxFee: (670_000n * 2_000_000_000n).toString() }; // 2 gwei: 0.00134 ETH — fine on Ethereum, far above the Arbitrum ceiling
    const onArb = order('arbitrum', 2, t.now, tokenId('arbitrum', 'USDC'), 'native', 10_000000n, 1, 2000, fee);
    await expect(signer.signDelegated(arb.mandateId, onArb.intent, onArb.aux)).rejects.toThrow(/fee ceiling above policy/);
    const onEth = order('ethereum', 1, t.now, tokenId('ethereum', 'USDC'), 'native', 10_000000n, 1, 2000, fee);
    expect((await signer.signDelegated(eth.mandateId, onEth.intent, onEth.aux)).txid).toMatch(/^0x/);
    const above = order('ethereum', 1, t.now, tokenId('ethereum', 'USDC'), 'native', 10_000000n, 1, 2000, { maxFeePerGas: '20000000000', maxFee: (670_000n * 20_000_000_000n).toString() });
    await expect(signer.signDelegated(eth.mandateId, above.intent, above.aux)).rejects.toThrow(/fee ceiling above policy/); // Ethereum has a ceiling too
  });

  it('refuses a mandate on a network for which the policy sets no fee ceiling', async () => {
    const { signer, pk, t } = await setup((f) => { delete f.optimism; return f; });
    const m = mandate('optimism', 1, ['native', tokenId('optimism', 'USDC')], t.now);
    await expect(signer.approveMandate(m, pk.assert(mandateHash(m)))).rejects.toThrow(/no fee ceiling/);
    const ok = mandate('base', 1, ['native', tokenId('base', 'USDC')], t.now);
    await signer.approveMandate(ok, pk.assert(mandateHash(ok)));
  });

  it('HyperEVM runs a reduced router: swapGeneric and partial fill are refused there, and only there', async () => {
    const { signer, pk, t } = await setup();
    const hl = mandate('hyperevm', 1, ['native', tokenId('hyperevm', 'USDC')], t.now), base = mandate('base', 2, ['native', tokenId('base', 'USDC')], t.now);
    await signer.approveMandate(hl, pk.assert(mandateHash(hl))); await signer.approveMandate(base, pk.assert(mandateHash(base)));
    const at = (net: string, idx: number, o: { fn?: 'swap' | 'swapGeneric'; flags?: bigint }) => order(net, idx, t.now, tokenId(net, 'USDC'), 'native', 10_000000n, 1, net === 'hyperevm' ? 25 : 2000, o);
    for (const bad of [{ fn: 'swapGeneric' as const }, { flags: 0x01n }]) {
      const o = at('hyperevm', 1, bad);
      await expect(signer.signDelegated(hl.mandateId, o.intent, o.aux), JSON.stringify(bad.fn ?? 'partial fill')).rejects.toThrow(/does not exist on this network/);
      const same = at('base', 2, bad); // the full router of Base has both
      expect((await signer.signDelegated(base.mandateId, same.intent, same.aux)).txid).toMatch(/^0x/);
    }
    const plain = at('hyperevm', 1, {});
    expect(parseTransaction((await signer.signDelegated(hl.mandateId, plain.intent, plain.aux)).raw as `0x${string}`).chainId).toBe(999);
  });
});

describe('price check against the underlying (issuer risk)', () => {
  it('values a wrapped asset at the exchange price of what it tracks; a depeg makes the signer refuse', async () => {
    const { signer, pk, t, asked } = await setup();
    const WBTC = tokenId('ethereum', 'WBTC'), WETH = tokenId('ethereum', 'WETH'), USDC = tokenId('ethereum', 'USDC');
    const m = mandate('ethereum', 1, [USDC, WBTC, WETH], t.now);
    await signer.approveMandate(m, pk.assert(mandateHash(m)));
    // selling 0.001 WBTC at the BTC price: accepted, and the signer asked for BTC, never for "WBTC"
    const fair = order('ethereum', 1, t.now, WBTC, USDC, 100_000n, PX.BTC!, 1);
    expect((await signer.signDelegated(m.mandateId, fair.intent, fair.aux)).txid).toMatch(/^0x/);
    expect(asked.at(-1)).toEqual(['BTC', 'USDC']);
    // WBTC has lost its peg: the market only gives 90 % of the bitcoin price for it → the order is refused (fail closed)
    const depegSell = order('ethereum', 1, t.now, WBTC, USDC, 100_000n, PX.BTC!, 1, { keep: 0.9 });
    await expect(signer.signDelegated(m.mandateId, depegSell.intent, depegSell.aux)).rejects.toThrow(/guaranteed output is worth 90\.00 %/);
    // buying WETH is checked at the ETH price: a route delivering too little wrapped ether is refused too
    const buy = order('ethereum', 1, t.now, USDC, WETH, 20_000000n, 1, PX.ETH!);
    expect((await signer.signDelegated(m.mandateId, buy.intent, buy.aux)).txid).toMatch(/^0x/);
    expect(asked.at(-1)).toEqual(['USDC', 'ETH']);
    const thin = order('ethereum', 1, t.now, USDC, WETH, 20_000000n, 1, PX.ETH!, { keep: 0.97 });
    await expect(signer.signDelegated(m.mandateId, thin.intent, thin.aux)).rejects.toThrow(/mandate requires at least 98\.50 %/);
    expect(signer.status().mandates[0]!.today.orders).toBe(2); // refused orders are not counted
  });

  it('refuses any order on an asset it cannot price (no second exchange): fail closed', async () => {
    const { signer, pk, t, asked } = await setup();
    const EURC = tokenId('base', 'EURC'), USDC = tokenId('base', 'USDC');
    const m = mandate('base', 1, [USDC, EURC], t.now);
    await signer.approveMandate(m, pk.assert(mandateHash(m)));
    const o = order('base', 1, t.now, USDC, EURC, 10_000000n, 1, 1.1);
    await expect(signer.signDelegated(m.mandateId, o.intent, o.aux)).rejects.toThrow(/market price unavailable \(no price source for EUR\)/);
    expect(asked.at(-1)).toEqual(['USDC', 'EUR']); // EURC is priced as the euro, which this view does not carry
    expect(signer.status().mandates[0]!.today.orders).toBe(0);
  });
});
