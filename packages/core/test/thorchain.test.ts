/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/test/thorchain.test.ts
 * Module           : core
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

// THORChain native swaps: memo, units, vault key → address, the unanimity rule, and the source transactions.
// The vault key and addresses below were read from five public THORNode operators on 2026-11-11 (public network data).
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2pkh, p2wpkh, Script, Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { decodeFunctionData, erc20Abi } from 'viem';
import {
  btcParams, buildBtcTx, buildEvmTx, buildThorMemo, buildXswapBtcTx, buildXswapEvmTxs, canonicalBytes, checkThorVault, fetchThorView, fromThorAmount, IntentSchema, intentHash, NETWORKS, parseThorMemo, pickThorVault,
  THOR_ASSETS, THOR_ROUTER_ABI, THOR_ROUTERS, thorAsset, thorOpReturn, thorPairEnabled, thorTxId, thorVaultAddress, toThorAmount, utxoPaymentTo, verifyXswap, type Intent, type ThorAnswer, type ThorView,
} from '../src/index.ts';

const VAULT_KEY = 'thorpub1addwnpepqgwpafz6l99mkevlz7spaezgzcxy5t2896hgm7e6kytqrkmulex4wxjp8az';
const VAULT = { bitcoin: 'bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx', litecoin: 'ltc1qup236qj2mr87ml9388ydm33tuhtdckk34wqrck', dogecoin: 'DRbFs1GDf9F3MGnHy24vPP8h7wCE8nCBAU', ethereum: '0x718f6C9df785BC4e323086De024CA822efbE8aB9' };
const OTHER_KEY = 'thorpub1addwnpepqvlena222zluk5p3r0s9uey758rd43qedtxf2xalprynuaxp69rscr0jy4h';
const ROUTER = THOR_ROUTERS.ethereum!.address, USDC = NETWORKS.ethereum!.tokens.find((t) => t.symbol === 'USDC')!.id;
const priv = randomBytes(32), pub = secp256k1.getPublicKey(priv, true); // fresh key per run: no funds, never leaves the test
const ME_BTC = p2wpkh(pub, btcParams(NETWORKS.bitcoin!)).address!, ME_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const eth = thorAsset('ethereum', 'native'), btc = thorAsset('bitcoin', 'native'), usdc = thorAsset('ethereum', USDC);
const T0 = 1_794_000_000;

function btcIntent(o: Partial<Intent> = {}, x: Partial<NonNullable<Intent['xswap']>> = {}): Intent {
  const limit = x.limit ?? '2098152';
  return IntentSchema.parse({ v: 1, proposalId: '7a1c1f0e-8f5f-4b1e-9c56-000000000001', keyId: 'spw-0123456789abcdef', network: 'bitcoin', chainRef: NETWORKS.bitcoin!.chainRef, asset: 'native', symbol: 'BTC', decimals: 8,
    amount: '60000', from: ME_BTC, to: VAULT.bitcoin, maxFee: '2000', createdAt: T0, expiresAt: T0 + 120, policyVersion: 4,
    btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '100000' }], change: '39000', fee: '1000' },
    xswap: { provider: 'thorchain', toNetwork: 'ethereum', toAsset: 'native', minOut: '20981520000000000', limit, memo: `=:e:${ME_EVM}:${limit}`, vault: VAULT.bitcoin, vaultPubKey: VAULT_KEY, router: '', expiry: T0 + 900, approveGas: '0', ...x }, ...o });
}
function evmIntent(o: Partial<Intent> = {}, x: Partial<NonNullable<Intent['xswap']>> = {}): Intent {
  return IntentSchema.parse({ v: 1, proposalId: '7a1c1f0e-8f5f-4b1e-9c56-000000000002', keyId: 'spw-0123456789abcdef', network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18,
    amount: '20000000000000000', from: ME_EVM, to: VAULT.ethereum, maxFee: '3000000000000000', createdAt: T0, expiresAt: T0 + 120, policyVersion: 4,
    evm: { nonce: 7, gasLimit: '80000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' },
    xswap: { provider: 'thorchain', toNetwork: 'bitcoin', toAsset: 'native', minOut: '54436', limit: '54436', memo: `=:b:${ME_BTC}:54436`, vault: VAULT.ethereum, vaultPubKey: VAULT_KEY, router: ROUTER, expiry: T0 + 900, approveGas: '0', ...x }, ...o });
}

describe('units (THORChain counts every asset in 1e-8)', () => {
  it('converts exactly both ways and refuses what THORChain would not credit', () => {
    expect(toThorAmount(60_000n, 8)).toBe(60_000n);
    expect(toThorAmount(45_000_000n, 6)).toBe(4_500_000_000n);
    expect(toThorAmount(20_000_000_000_000_000n, 18)).toBe(2_000_000n);
    expect(() => toThorAmount(20_000_000_000_000_001n, 18)).toThrow(/finer/);
    expect(fromThorAmount(4_335_455_817n, 6)).toBe(43_354_558n); // rounded down: the chain cannot pay 0.17 of a base unit
    expect(fromThorAmount(2_098_152n, 18)).toBe(20_981_520_000_000_000n);
    expect(() => toThorAmount(-1n, 8)).toThrow();
  });
});

describe('memo', () => {
  it('builds exactly what THORNode writes in its own quotes (recorded 2026-11-11) and reads it back', () => {
    // quote BTC.BTC -> ETH.ETH and -> ETH.USDC for destination 0x1111…: "=:e:0x1111…:2098152" and "=:ETH.USDC:0x1111…:4335455817"
    const d = '0x1111111111111111111111111111111111111111';
    expect(buildThorMemo(eth, d, 2_098_152n)).toBe('=:e:0x1111111111111111111111111111111111111111:2098152');
    expect(buildThorMemo(usdc, d, 4_335_455_817n)).toBe('=:ETH.USDC:0x1111111111111111111111111111111111111111:4335455817');
    expect(buildThorMemo(btc, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 54_436n)).toBe('=:b:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq:54436');
    expect(buildThorMemo(thorAsset('dogecoin', 'native'), 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', 66_148_801_492n)).toBe('=:d:DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L:66148801492');
    for (const a of THOR_ASSETS) {
      const dest = a.network === 'ethereum' ? ME_EVM : a.network === 'bitcoin' ? ME_BTC : a.network === 'litecoin' ? VAULT.litecoin : VAULT.dogecoin;
      const m = buildThorMemo(a, dest, 123_456_789n), back = parseThorMemo(m);
      expect(back).toEqual({ asset: a, destination: dest, limit: 123_456_789n });
      expect(new TextEncoder().encode(m).length).toBeLessThanOrEqual(80); // every enabled destination fits in OP_RETURN
    }
  });
  it.each([
    ['another handler', `+:e:${ME_EVM}:1000`, /market swap/],
    ['long handler', `SWAP:e:${ME_EVM}:1000`, /market swap/],
    ['limit order', `=<:e:${ME_EVM}:1000`, /market swap/],
    ['no limit', `=:e:${ME_EVM}`, /no limit/],
    ['empty limit', `=:e:${ME_EVM}:`, /plain positive integer/],
    ['zero limit', `=:e:${ME_EVM}:0`, /plain positive integer/],
    ['scientific notation', `=:e:${ME_EVM}:2e6`, /plain positive integer/],
    ['leading zero', `=:e:${ME_EVM}:0123`, /plain positive integer/],
    ['streaming', `=:e:${ME_EVM}:1000/1/1`, /streaming/],
    ['rapid streaming', `=:e:${ME_EVM}:1000/0/5`, /streaming/],
    ['refund override', `=:e:${ME_EVM}/${ME_EVM}:1000`, /refund address/],
    ['affiliate', `=:e:${ME_EVM}:1000:t:10`, /affiliate/],
    ['empty affiliate fields', `=:e:${ME_EVM}:1000::`, /affiliate/],
    ['full notation (not what the wallet writes)', `=:ETH.ETH:${ME_EVM}:1000`, /not pinned/],
    ['unknown short code', `=:r:${ME_EVM}:1000`, /not pinned/],
    ['lower-case token', `=:eth.usdc:${ME_EVM}:1000`, /not pinned/],
    ['destination of another chain', `=:e:${ME_BTC}:1000`, /destination/],
    ['unchecksummed destination', `=:e:${ME_EVM.toLowerCase()}:1000`, /destination/],
    ['THORName destination', '=:e:somethorname:1000', /destination/],
    ['whitespace', `=:e:${ME_EVM}:1000 `, /ASCII/],
    ['non-ASCII', `=:e:${ME_EVM}:１０００`, /ASCII/],
    ['too long', `=:e:${ME_EVM}:1${'0'.repeat(240)}`, /ASCII|plain positive/],
  ])('refuses %s', (_l, memo, re) => { expect(() => parseThorMemo(memo)).toThrow(re); });
  it('never writes a limit it cannot write in full', () => {
    expect(() => buildThorMemo(eth, ME_EVM, 0n)).toThrow(); expect(() => buildThorMemo(eth, ME_EVM, -5n)).toThrow();
    expect(() => buildThorMemo(eth, ME_EVM.toLowerCase(), 5n)).toThrow(/normalized/);
    expect(() => buildThorMemo(eth, ME_BTC, 5n)).toThrow();
  });
  it('only pinned assets; pairs need a source that is enabled and two different networks', () => {
    expect(() => thorAsset('ethereum', '0x514910771AF9Ca656af840dff83E8264EcF986CA')).toThrow(); // LINK: no Available pool
    expect(() => thorAsset('base', 'native')).toThrow(); expect(() => thorAsset('solana', 'native')).toThrow();
    expect(thorPairEnabled({ network: 'bitcoin', asset: 'native' }, { network: 'ethereum', asset: USDC })).toBe(true);
    expect(thorPairEnabled({ network: 'ethereum', asset: USDC.toLowerCase() }, { network: 'bitcoin', asset: 'native' })).toBe(true);
    expect(thorPairEnabled({ network: 'dogecoin', asset: 'native' }, { network: 'bitcoin', asset: 'native' })).toBe(false); // destination only
    expect(thorPairEnabled({ network: 'litecoin', asset: 'native' }, { network: 'dogecoin', asset: 'native' })).toBe(true);
    expect(thorPairEnabled({ network: 'ethereum', asset: 'native' }, { network: 'ethereum', asset: USDC })).toBe(false);
    expect(thorPairEnabled({ network: 'bitcoin', asset: 'native' }, { network: 'base', asset: 'native' })).toBe(false);
  });
});

describe('vault key → address (derived locally, never taken from an API)', () => {
  it('gives the addresses the network publishes for that key', () => {
    for (const [n, a] of Object.entries(VAULT)) expect(thorVaultAddress(VAULT_KEY, n)).toBe(a);
    expect(thorVaultAddress(OTHER_KEY, 'bitcoin')).toBe('bc1qh2aq97wafs7px4jnajnpleu0njaqmque8dku3p');
    expect(thorVaultAddress(OTHER_KEY, 'ethereum').toLowerCase()).toBe('0x6b4068070d95d87b321909bb21c8979fba2b8876');
  });
  it('refuses anything that is not a secp256k1 THORChain key', () => {
    expect(() => thorVaultAddress(VAULT_KEY.slice(0, -1) + 'q', 'bitcoin')).toThrow(); // checksum
    expect(() => thorVaultAddress('mayapub1addwnpepqdskxhlw2esmzy82w', 'bitcoin')).toThrow();
    expect(() => thorVaultAddress(VAULT.bitcoin, 'bitcoin')).toThrow();
    expect(() => thorVaultAddress(VAULT_KEY, 'solana')).toThrow();
  });
});

// ---- the unanimity rule ----
const view = (o: { height?: number; status?: string; halted?: boolean; paused?: boolean; router?: string | null; dust?: bigint; since?: number; key?: string; chains?: string[]; chain?: string } = {}): ThorView => ({
  height: o.height ?? 28_622_900,
  inbound: [{ chain: o.chain ?? 'BTC', pubKey: OTHER_KEY, address: 'bc1qh2aq97wafs7px4jnajnpleu0njaqmque8dku3p', router: o.router ?? null, halted: !!o.halted, paused: !!o.paused, gasRate: 3n, dustThreshold: o.dust ?? 1000n, outboundFee: 1059n }],
  vaults: [{ pubKey: o.key ?? VAULT_KEY, status: o.status ?? 'ActiveVault', statusSince: o.since ?? 28_203_871, chains: o.chains ?? ['BTC', 'ETH', 'LTC', 'DOGE'], members: 19 }, { pubKey: OTHER_KEY, status: 'ActiveVault', statusSince: 28_203_871, chains: ['BTC', 'ETH'], members: 18 }],
});
const ok = (n: number, v: ThorView = view()): ThorAnswer[] => Array.from({ length: n }, (_x, k) => ({ operator: `op${k}`, view: v }));
const WANT = { chain: 'BTC', vaultPubKey: VAULT_KEY, router: null, amount: 60_000n };

describe('vault unanimity (the same rule runs in the signer and in the API)', () => {
  it('accepts when every operator that answered confirms, and reports who', () => {
    const v = checkThorVault([...ok(4), { operator: 'down', error: 'timeout' }], WANT);
    expect(v).toMatchObject({ operators: ['op0', 'op1', 'op2', 'op3'], silent: ['down'], statusSince: 28_203_871, gasRate: 3n, dustThreshold: 1000n, members: 19 });
    expect(checkThorVault(ok(3), WANT).operators).toHaveLength(3);
  });
  it('needs three distinct operators, whatever the caller asks for', () => {
    expect(() => checkThorVault([...ok(2), { operator: 'a', error: 'x' }, { operator: 'b', error: 'x' }, { operator: 'c', error: 'x' }], WANT)).toThrow(/only 2 THORNode operator/);
    expect(() => checkThorVault(ok(2), WANT, 1)).toThrow(/only 2/);
    expect(() => checkThorVault([], WANT)).toThrow(/only 0/);
    expect(() => checkThorVault([...ok(2), { operator: 'op0', view: view() }], WANT)).toThrow(/twice/); // one operator cannot vote twice
  });
  it.each([
    ['one lying operator that does not know the vault (an attacker\'s address named by the others would look like this to an honest node)', view({ key: 'thorpub1addwnpepq2dxvtsjwz8de5k96ct7aap2d7ccgjeekr02n0eudcankqa02d89udx7767' }), /does not list this vault/],
    ['an operator that lists it as retiring (churn in progress)', view({ status: 'RetiringVault' }), /RetiringVault/],
    ['an operator that lists it as inactive', view({ status: 'InactiveVault' }), /InactiveVault/],
    ['a stale operator (behind by more than five minutes of blocks)', view({ height: 28_622_900 - 51 }), /blocks behind/],
    ['an operator far ahead of the others (the others then look stale: refuse, never drop)', view({ height: 28_622_900 + 500 }), /blocks behind/],
    ['a halted chain', view({ halted: true }), /halted/],
    ['paused trading', view({ paused: true }), /paused/],
    ['another churn height', view({ since: 28_300_000 }), /churn height/],
    ['a vault that does not serve the chain', view({ chains: ['ETH'] }), /without BTC/],
    ['a dust threshold at the amount', view({ dust: 60_000n }), /dust/],
    ['a router on a chain that has none', view({ router: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146' }), /router/],
    ['no inbound entry for the chain', view({ chain: 'ETH' }), /no inbound address/],
  ])('refuses on %s, even when four others agree', (_l, bad, re) => {
    expect(() => checkThorVault([...ok(4), { operator: 'odd', view: bad }], WANT)).toThrow(re);
    expect(() => checkThorVault([{ operator: 'odd', view: bad }, ...ok(4)], WANT)).toThrow(re);
  });
  it('checks the pinned router for an EVM source', () => {
    const w = { chain: 'ETH', vaultPubKey: VAULT_KEY, router: ROUTER, amount: 2_000_000n };
    expect(checkThorVault(ok(3, view({ chain: 'ETH', router: ROUTER.toLowerCase() })), w).operators).toHaveLength(3);
    expect(() => checkThorVault(ok(3, view({ chain: 'ETH', router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' })), w)).toThrow(/another router/);
    expect(() => checkThorVault(ok(3, view({ chain: 'ETH' })), w)).toThrow(/another router/);
  });
  it('proposes the vault most operators name, and parses an operator\'s raw answers strictly', async () => {
    expect(pickThorVault([...ok(3), { operator: 'x', view: { ...view(), inbound: [{ ...view().inbound[0]!, pubKey: VAULT_KEY }] } }], 'BTC')).toBe(OTHER_KEY);
    expect(pickThorVault([{ operator: 'x', error: 'down' }], 'BTC')).toBeNull();
    const answers: Record<string, unknown> = {
      'https://n/thorchain/inbound_addresses': [{ chain: 'BTC', pub_key: VAULT_KEY, address: VAULT.bitcoin, halted: false, global_trading_paused: false, chain_trading_paused: true, gas_rate: '3', dust_threshold: '1000', outbound_fee: '1059' }],
      'https://n/thorchain/vaults/asgard': [{ pub_key: VAULT_KEY, status: 'ActiveVault', status_since: 28_203_871, chains: ['BTC'], membership: ['a', 'b'] }],
      'https://n/thorchain/lastblock': [{ chain: 'BTC', thorchain: 28_622_877 }, { chain: 'ETH', thorchain: 28_622_878 }],
    };
    const v = await fetchThorView('https://n', async (u) => answers[u]);
    expect(v).toMatchObject({ height: 28_622_878, inbound: [{ chain: 'BTC', paused: true, halted: false, gasRate: 3n, router: null }], vaults: [{ status: 'ActiveVault', members: 2 }] });
    await expect(fetchThorView('https://n', async (u) => (u.endsWith('lastblock') ? { height: 1 } : answers[u]))).rejects.toThrow();
    await expect(fetchThorView('https://n', async (u) => (u.endsWith('asgard') ? [] : answers[u]))).rejects.toThrow();
  });
});

describe('intent', () => {
  it('is part of the approved hash, field by field', () => {
    const a = btcIntent(), h = (i: Intent) => Buffer.from(intentHash(i)).toString('hex');
    expect(h(a)).not.toBe(h({ ...a, xswap: { ...a.xswap!, vault: VAULT.bitcoin.replace('qx', 'qy') } }));
    expect(h(a)).not.toBe(h({ ...a, xswap: { ...a.xswap!, vaultPubKey: OTHER_KEY } }));
    expect(h(a)).not.toBe(h({ ...a, xswap: { ...a.xswap!, memo: a.xswap!.memo + '0' } }));
    expect(h(a)).not.toBe(h({ ...a, xswap: { ...a.xswap!, minOut: '1' } }));
    expect(h(a)).not.toBe(h({ ...a, xswap: { ...a.xswap!, expiry: T0 + 901 } }));
    expect(() => canonicalBytes({ ...a, bridge: { provider: 'cctp', toNetwork: 'base', toDomain: 6, maxFee: '0', minFinalityThreshold: 2000, messenger: 'x'.repeat(20), transmitter: 'x'.repeat(20), approveGas: '0' } } as Intent)).toThrow();
  });
  it('a swap intent is never signed as a plain transfer', () => {
    expect(() => buildBtcTx(btcIntent())).toThrow(/cross-chain swap/);
    expect(() => buildEvmTx(evmIntent())).toThrow(/cross-chain swap/);
  });
  it('accepts the swap it describes', () => {
    const p = verifyXswap(btcIntent(), ME_EVM);
    expect(p).toMatchObject({ amount: 60_000n, amount1e8: 60_000n, limit: 2_098_152n, memo: `=:e:${ME_EVM}:2098152`, want: { chain: 'BTC', vaultPubKey: VAULT_KEY, router: null, amount: 60_000n } });
    expect(verifyXswap(evmIntent(), ME_BTC).want).toEqual({ chain: 'ETH', vaultPubKey: VAULT_KEY, router: ROUTER, amount: 2_000_000n });
  });
  const OTHER_EVM = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  it.each<[string, () => Intent, string, RegExp]>([
    ['a memo that pays another address', () => btcIntent({}, { memo: `=:e:${OTHER_EVM}:2098152` }), ME_EVM, /memo does not match/],
    ['a destination that is not the wallet\'s (signer derives its own)', () => btcIntent(), OTHER_EVM, /memo does not match/],
    ['a memo for another asset', () => btcIntent({}, { memo: `=:ETH.USDC:${ME_EVM}:2098152` }), ME_EVM, /memo does not match/],
    ['a memo with a lower limit than committed', () => btcIntent({}, { memo: `=:e:${ME_EVM}:1` }), ME_EVM, /memo does not match/],
    ['a limit below the approved minimum', () => btcIntent({}, { limit: '2098151', memo: `=:e:${ME_EVM}:2098151` }), ME_EVM, /below the approved minimum/],
    ['a limit shortened in scientific notation', () => btcIntent({}, { memo: `=:e:${ME_EVM}:2e6` }), ME_EVM, /memo does not match/],
    ['a streaming memo', () => btcIntent({}, { memo: `=:e:${ME_EVM}:2098152/1/1` }), ME_EVM, /memo does not match/],
    ['an affiliate', () => btcIntent({}, { memo: `=:e:${ME_EVM}:2098152:t:10` }), ME_EVM, /memo does not match/],
    ['a refund override', () => btcIntent({}, { memo: `=:e:${ME_EVM}/${ME_BTC}:2098152` }), ME_EVM, /memo does not match/],
    ['a vault address that is not the address of the vault key', () => btcIntent({ to: 'bc1qh2aq97wafs7px4jnajnpleu0njaqmque8dku3p' }, { vault: 'bc1qh2aq97wafs7px4jnajnpleu0njaqmque8dku3p' }), ME_EVM, /not the address of the committed vault key/],
    ['a transfer that goes elsewhere than the committed vault', () => btcIntent({ to: 'bc1qh2aq97wafs7px4jnajnpleu0njaqmque8dku3p' }), ME_EVM, /does not go to the committed vault/],
    ['a router on a UTXO swap', () => btcIntent({}, { router: ROUTER }), ME_EVM, /no router/],
    ['an unknown destination asset', () => btcIntent({}, { toAsset: '0x514910771AF9Ca656af840dff83E8264EcF986CA' }), ME_EVM, /cannot be swapped/],
    ['a destination-only source', () => btcIntent({ network: 'dogecoin', chainRef: NETWORKS.dogecoin!.chainRef, symbol: 'DOGE', from: VAULT.dogecoin, to: VAULT.dogecoin }), ME_EVM, /cannot be the input/],
    ['the same network on both sides', () => evmIntent({}, { toNetwork: 'ethereum', toAsset: USDC }), ME_EVM, /same network/],
    ['an expiry too far away', () => btcIntent({}, { expiry: T0 + 901 }), ME_EVM, /expiry/],
    ['an expiry before the approval window ends', () => btcIntent({}, { expiry: T0 + 120 }), ME_EVM, /expiry/],
    ['another router', () => evmIntent({}, { router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' }), ME_BTC, /pinned THORChain router/],
    ['an amount finer than 1e-8', () => evmIntent({ amount: '20000000000000001' }), ME_BTC, /finer/],
    ['a destination tag riding along', () => btcIntent({ memo: '123' }), ME_EVM, /memo in the swap section/],
    ['wrong input metadata', () => btcIntent({ symbol: 'LTC' }), ME_EVM, /metadata/],
    ['another chain identity', () => btcIntent({ chainRef: NETWORKS.litecoin!.chainRef }), ME_EVM, /chain identity/],
    ['the wallet itself as vault', () => { const k = OTHER_KEY; return btcIntent({ from: thorVaultAddress(k, 'bitcoin'), to: thorVaultAddress(k, 'bitcoin') }, { vault: thorVaultAddress(k, 'bitcoin'), vaultPubKey: k }); }, ME_EVM, /wallet itself/],
  ])('refuses %s', (_l, make, dest, re) => { expect(() => verifyXswap(make(), dest)).toThrow(re); });
});

describe('Bitcoin source transaction', () => {
  it('has exactly three outputs in THORChain\'s order — vault, change to the wallet, OP_RETURN(memo) — and signs', () => {
    const i = btcIntent(), tx = buildXswapBtcTx(i, ME_EVM);
    tx.sign(priv); tx.finalize();
    const back = Transaction.fromRaw(hex.decode(tx.hex), { allowUnknownOutputs: true });
    expect(back.outputsLength).toBe(3); expect(back.inputsLength).toBe(1);
    const P = btcParams(NETWORKS.bitcoin!), o = [0, 1, 2].map((k) => back.getOutput(k));
    expect(hex.encode(o[0]!.script!)).toBe(hex.encode(p2wpkh(hex.decode('021c1ea45af94bbb659f17a01ee448160c4a2d472ea' + 'e8dfb3ab11601db7cfe4d57'), P).script)); // the vault key itself
    expect(o[0]!.amount).toBe(60_000n);
    expect(hex.encode(o[1]!.script!)).toBe(hex.encode(p2wpkh(pub, P).script)); expect(o[1]!.amount).toBe(39_000n);
    expect(o[2]!.amount).toBe(0n);
    const memo = `=:e:${ME_EVM}:2098152`;
    expect(hex.encode(o[2]!.script!)).toBe('6a' + (memo.length).toString(16).padStart(2, '0') + Buffer.from(memo).toString('hex')); // OP_RETURN + one push
    expect(Script.decode(o[2]!.script!)).toHaveLength(2);
    expect(100_000n - o.reduce((s, x) => s + x!.amount!, 0n)).toBe(1000n); // the fee is what the intent says
    expect(back.getInput(0).sequence).toBe(0xfffffffd);
    expect(utxoPaymentTo(tx.hex, 'bitcoin', VAULT.bitcoin)).toEqual({ txid: tx.id, paid: 60_000n, memo });
  });
  it('a 76–80 byte memo uses OP_PUSHDATA1; longer does not fit', () => {
    expect(hex.encode(thorOpReturn('x'.repeat(80))).slice(0, 6)).toBe('6a4c50');
    expect(hex.encode(thorOpReturn('x'.repeat(75))).slice(0, 4)).toBe('6a4b');
    expect(() => thorOpReturn('x'.repeat(81))).toThrow();
  });
  it.each<[string, () => Intent, RegExp]>([
    ['no change (two outputs only)', () => btcIntent({ btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '61000' }], change: '0', fee: '1000' } }), /change/],
    ['dust change', () => btcIntent({ btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '61100' }], change: '100', fee: '1000' } }), /change/],
    ['a fee above the approved maximum', () => btcIntent({ btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '100000' }], change: '37000', fee: '3000' } }), /fee exceeds/],
    ['inputs that do not add up', () => btcIntent({ btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '100001' }], change: '39000', fee: '1000' } }), /inputs != outputs/],
    ['a duplicate input', () => btcIntent({ btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '50000' }, { txid: 'ab'.repeat(32), vout: 1, value: '50000' }], change: '39000', fee: '1000' } }), /duplicate/],
    ['a source that is not the wallet\'s script type', () => btcIntent({ from: p2pkh(pub, btcParams(NETWORKS.bitcoin!)).address! }), /SegWit/],
  ])('refuses %s', (_l, make, re) => { expect(() => buildXswapBtcTx(make(), ME_EVM)).toThrow(re); });
});

describe('Ethereum source transaction', () => {
  it('native coin: one call to the pinned router, value = amount, memo and vault exactly as approved', () => {
    const { approve, deposit } = buildXswapEvmTxs(evmIntent(), ME_BTC);
    expect(approve).toBeNull();
    expect(deposit).toMatchObject({ to: ROUTER, value: 20_000_000_000_000_000n, nonce: 7, gas: 80_000n, chainId: 1 });
    const d = decodeFunctionData({ abi: THOR_ROUTER_ABI, data: deposit.data! });
    expect(d.functionName).toBe('depositWithExpiry');
    expect(d.args).toEqual([VAULT.ethereum, '0x0000000000000000000000000000000000000000', 20_000_000_000_000_000n, `=:b:${ME_BTC}:54436`, BigInt(T0 + 900)]);
  });
  it('token: exact-amount approval of the router, then the deposit with no value', () => {
    const i = evmIntent({ asset: USDC, symbol: 'USDC', decimals: 6, amount: '45000000' }, { approveGas: '70000' });
    const { approve, deposit } = buildXswapEvmTxs(i, ME_BTC);
    expect(approve).toMatchObject({ to: USDC, value: 0n, nonce: 7, gas: 70_000n });
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data! }).args).toEqual([ROUTER, 45_000_000n]);
    expect(deposit).toMatchObject({ to: ROUTER, value: 0n, nonce: 8 });
    expect(decodeFunctionData({ abi: THOR_ROUTER_ABI, data: deposit.data! }).args).toEqual([VAULT.ethereum, USDC, 45_000_000n, `=:b:${ME_BTC}:54436`, BigInt(T0 + 900)]);
  });
  it.each<[string, () => Intent, RegExp]>([
    ['an approval for the native coin', () => evmIntent({}, { approveGas: '70000' }), /approval gas/],
    ['a fee above the approved maximum', () => evmIntent({ maxFee: '1000' }), /fee exceeds/],
    ['a gas limit out of range', () => evmIntent({ evm: { nonce: 7, gasLimit: '900000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } }), /gas limit/],
    ['a tip above the max fee', () => evmIntent({ evm: { nonce: 7, gasLimit: '80000', maxFeePerGas: '1', maxPriorityFeePerGas: '2' } }), /priority fee/],
  ])('refuses %s', (_l, make, re) => { expect(() => buildXswapEvmTxs(make(), ME_BTC)).toThrow(re); });
});

it('spells a transaction id as THORChain does', () => { expect(thorTxId('0xabCDef')).toBe('ABCDEF'); expect(thorTxId('abcd')).toBe('ABCD'); });
