/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/test/nft-intent.test.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// NFT delivery 2 — core: (1) REGRESSION PINS: every intent kind that existed before hashes exactly as before, the default policy
// and the policy schema's reading of an old file are unchanged; (2) the NFT intent, the lock-list intent and the allow-list
// intent: canonical bytes, domain separation, strictness; (3) the EVM builder cross-checked against viem's ABI decoder, and
// its independent verifier against every forged shape; (4) the Solana builder cross-checked against @solana/kit's message
// decoder, and its independent verifier against added / reordered / smuggled instructions; (5) the NFT policy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeFunctionData, encodeFunctionData, erc721Abi, getAddress, parseAbi, serializeTransaction, parseTransaction } from 'viem';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import {
  ATA_PROGRAM, associatedTokenAddress, buildNftEvmTx, buildNftSolMessage, canonicalBytes, checkNftPolicy, compileNftSolMessage, COMPUTE_BUDGET_PROGRAM, decodeNftSolMessage, DEFAULT_POLICY, defaultNftPolicy, effectiveNftPolicy, intentHash, IntentSchema,
  NETWORKS, NFT_CORE_PROGRAM, NFT_SOL_PINNED, NFT_TOKEN_AUTH_RULES_PROGRAM, NFT_TOKEN_METADATA_PROGRAM, nftAllowHash, nftCanonicalBytes, nftEditionPda, nftIntentHash, NftIntentSchema, nftMetadataPda, NftRefusal, nftTokenRecordPda, planNftSol, PolicySchema,
  SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, toHex, utxoLockHash, UtxoLockIntentSchema, verifyNftEvmTx, verifyNftSolMessage, type Intent, type NftIntent, type NftSolIx,
} from '../src/index.ts';

const ID = '6f1c1f0e-8f5f-4b1e-9c56-0000000000a1', KEY = 'spw-0123456789abcdef', T = 1_800_000_000;
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const SOL_WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', SOL_DEST = '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', MINT = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
const COLLECTION = 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', RULESET = 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9', BH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const code = (f: () => unknown): string => { try { f(); } catch (e) { if (e instanceof NftRefusal) return e.code; throw e; } return 'no refusal'; };

// ── (1) regression pins ─────────────────────────────────────────────────────────────────────────────────────────────────
const base = { v: 1 as const, proposalId: ID, keyId: KEY, createdAt: T, expiresAt: T + 120, policyVersion: 4 };
const evmSec = { evm: { nonce: 7, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } };
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const OLD: Record<string, Intent> = {
  evmTransfer: { ...base, network: 'base', chainRef: '8453', asset: NETWORKS.base.tokens[0]!.id, symbol: 'USDC', decimals: 6, amount: '10000000', from: WALLET, to: DEST, maxFee: '100000000000000', ...evmSec },
  btcTransfer: { ...base, network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '20000', from: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', maxFee: '5000',
    btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: '30000' }, { txid: 'cd'.repeat(32), vout: 0, value: '600' }], change: '9600', fee: '1000' } },
  solTransfer: { ...base, network: 'solana', chainRef: NETWORKS.solana.chainRef, asset: 'native', symbol: 'SOL', decimals: 9, amount: '1000000', from: SOL_WALLET, to: SOL_DEST, maxFee: '10000',
    sol: { recentBlockhash: BH, lastValidBlockHeight: 300000000, createAta: false, computeUnitLimit: 5000, computeUnitPrice: '5000' } },
  pluginTransfer: { ...base, network: 'tron', chainRef: NETWORKS.tron.chainRef, asset: 'native', symbol: 'TRX', decimals: 6, amount: '1000000', from: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', to: 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs', maxFee: '21000000', memo: 'm',
    x: { ref_block_bytes: '2660', expiration: '1800000240000', a: 'b' } },
  swap: { ...base, network: 'base', chainRef: '8453', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000', from: WALLET, to: WALLET, maxFee: '100000000000000', ...evmSec,
    swap: { provider: 'kyberswap', toAsset: A(1), minOut: '5', router: A(2), dataHash: 'ef'.repeat(32), approveGas: '0' } },
  bridge: { ...base, network: 'base', chainRef: '8453', asset: A(3), symbol: 'USDC', decimals: 6, amount: '1000000', from: WALLET, to: WALLET, maxFee: '100000000000000', ...evmSec,
    bridge: { provider: 'cctp', toNetwork: 'arbitrum', toDomain: 3, maxFee: '100', minFinalityThreshold: 2000, messenger: A(4), transmitter: A(5), approveGas: '60000' } },
  bridgeRecipient: { ...base, network: 'base', chainRef: '8453', asset: A(3), symbol: 'USDC', decimals: 6, amount: '1000000', from: WALLET, to: WALLET, maxFee: '100000000000000', ...evmSec,
    bridge: { provider: 'cctp', toNetwork: 'solana', toDomain: 5, maxFee: '100', minFinalityThreshold: 2000, messenger: A(4), transmitter: A(5), approveGas: '60000', recipient: SOL_WALLET } },
  xswap: { ...base, network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000', from: WALLET, to: A(6), maxFee: '100000000000000', ...evmSec,
    xswap: { provider: 'thorchain', toNetwork: 'bitcoin', toAsset: 'native', minOut: '5', limit: '4', memo: '=:b:bc1q:4', vault: A(6), vaultPubKey: 'thorpub1addwnpepq' + 'a'.repeat(40), router: A(7), expiry: T + 600, approveGas: '0' } },
  venueDeposit: { ...base, network: 'arbitrum', chainRef: '42161', asset: A(8), symbol: 'USDC', decimals: 6, amount: '6000000', from: WALLET, to: A(9), maxFee: '100000000000000', ...evmSec,
    venueDeposit: { venue: 'hyperliquid', venueNetwork: 'mainnet', route: 'arbitrum-usdc', bridge: A(9), minAmount: '5500000' } },
  gmx: { ...base, network: 'arbitrum', chainRef: '42161', asset: A(8), symbol: 'USDC', decimals: 6, amount: '6000000', from: WALLET, to: A(10), maxFee: '100000000000000', ...evmSec,
    gmx: { venue: 'gmx-v2', action: 'increase', authorizationId: ID, exchangeRouter: A(10), router: A(11), orderVault: A(12), market: A(13), indexToken: A(14), collateralToken: A(8), orderType: 'MarketIncrease', isLong: true,
      sizeDeltaUsd: '1'.padEnd(31, '0'), acceptablePrice: '2', triggerPrice: '0', executionFee: '3', approveGas: '60000' } },
};
describe('REGRESSION PINS — what existed before NFT delivery 2 is byte-for-byte what it was', () => {
  // The values below were produced with packages/core/src/intent.ts as it is on branch `nft` (the file is not modified by
  // this delivery: `git diff nft -- packages/core/src/intent.ts` is empty). A change of any of them is a change of what the
  // owner's passkey signs for an existing operation.
  const PINS: Record<string, string> = {
    evmTransfer: '479d4b9103c2e4ecc892be380030c9bc4d949ebeb60fff897d13916474ac3806', btcTransfer: '225334a6f1579cb99b45c880bfefb6c1063a10cdea4e607f84385e5cc5e58bed',
    solTransfer: 'ddc1d8803fec1a25e4ff26f78ff8e596d5e0d0e4ba4518610395f9e56b580685', pluginTransfer: '159299eec90d5a006c1d6352b59813550d61b76ae86b9d38b8b7a5348ee27049',
    swap: '33dd38ba497d6c61b4a954c7804b5b2e32551f324130958d749cf8dd27e6aa27', bridge: '830d9ca4bcd13a21ae3aa761c01b5578e052cbbb5cb4d57eecd808bffa4ecc2c',
    bridgeRecipient: 'eb74b84fd2d59b4b00a1a3e585cee0b9e7a473c261527ceed767adec03f2acd4', xswap: '057ca6f2ae1686a38632b02a1c7beb1a180e2eab05d0f2868a8d2dc082656d8a',
    venueDeposit: 'e30e4b66b0793f390b73f759e953d818cf1ce65d8d1f5db46b443b2fdc5a3274', gmx: '4619e60bfc159e5f234a3cfe497c63788b2cae06b1490f7fdb378f85ff99993d',
  };
  for (const [kind, intent] of Object.entries(OLD)) {
    it(`${kind}: the canonical hash is pinned`, () => {
      expect(IntentSchema.safeParse(intent).success).toBe(true);
      expect(toHex(intentHash(intent))).toBe(PINS[kind]);
      expect(Buffer.from(canonicalBytes(intent)).subarray(0, 14).toString()).toBe('SPW-INTENT-v1\0');
    });
  }
  it('an existing intent cannot carry an NFT section, and an NFT intent is not an intent', () => {
    expect(IntentSchema.safeParse({ ...OLD.evmTransfer, nft: { standard: 'erc721' } }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...OLD.evmTransfer, kind: 'nft-transfer' }).success).toBe(false);
    expect(IntentSchema.safeParse(erc721()).success).toBe(false);
    expect(NftIntentSchema.safeParse(OLD.evmTransfer).success).toBe(false);
  });
  it('the default policy written by a new installation is unchanged (no NFT key, same limits, same fee ceilings, version 4)', () => {
    expect(DEFAULT_POLICY.version).toBe(4);
    expect('nft' in DEFAULT_POLICY).toBe(false);
    expect(Object.keys(DEFAULT_POLICY).sort()).toEqual(['allowlist', 'daily', 'maxApprovalTtlSec', 'maxFee', 'perTx', 'version']);
    expect(createHash('sha256').update(JSON.stringify(DEFAULT_POLICY)).digest('hex')).toBe(POLICY_PIN);
  });
  it('a policy.json in the production shape (fixture written before V11) parses to exactly its own content', () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, '../../../services/isolated-signer/test/fixtures/policy-pre-v11.json'), 'utf8'));
    expect(PolicySchema.parse(raw)).toEqual(raw);
    expect(PolicySchema.parse(raw).nft).toBeUndefined();
  });
});
const POLICY_PIN = '022e92907ad7d2becef81a4a6c1fc17d8f92aef83f261c7c3f9809808ff2df0b';

// ── (2) the three new canonical objects ─────────────────────────────────────────────────────────────────────────────────
function erc721(over: Partial<NftIntent> = {}): NftIntent {
  return { v: 1, kind: 'nft-transfer', proposalId: ID, keyId: KEY, network: 'ethereum', chainRef: '1', standard: 'erc721', asset: BAYC, tokenId: '1', quantity: '1', program: BAYC, from: WALLET, to: DEST, maxFee: '3000000000000000',
    createdAt: T, expiresAt: T + 120, policyVersion: 4, nftPolicyVersion: 1, evm: { nonce: 3, gasLimit: '150000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' }, ...over };
}
const erc1155 = (over: Partial<NftIntent> = {}): NftIntent => erc721({ standard: 'erc1155', quantity: '3', tokenId: '115792089237316195423570985008687907853269984665640564039457584007913129639935', ...over });
function sol(standard: NftIntent['standard'], solOver: Partial<NonNullable<NftIntent['sol']>> = {}, over: Partial<NftIntent> = {}): NftIntent {
  const program = standard === 'metaplex-core' ? NFT_CORE_PROGRAM : standard === 'spl-token-2022' ? TOKEN_2022_PROGRAM : NFT_TOKEN_METADATA_PROGRAM;
  const extra = standard === 'metaplex-core' ? {} : standard === 'spl-token-2022' ? { tokenProgram: 'token2022' as const, createAta: true } : { tokenProgram: 'token' as const };
  return { v: 1, kind: 'nft-transfer', proposalId: ID, keyId: KEY, network: 'solana', chainRef: NETWORKS.solana.chainRef, standard, asset: MINT, quantity: '1', program, from: SOL_WALLET, to: SOL_DEST, maxFee: '500000',
    createdAt: T, expiresAt: T + 60, policyVersion: 4, nftPolicyVersion: 1, sol: { recentBlockhash: BH, lastValidBlockHeight: 300000000, computeUnitLimit: 200000, computeUnitPrice: '1000', ...extra, ...solOver }, ...over };
}

describe('NFT intent — canonical form', () => {
  it('is domain-separated from every other signed object and hashes are pinned', () => {
    expect(Buffer.from(nftCanonicalBytes(erc721())).subarray(0, 18).toString()).toBe('SPW-NFT-INTENT-v1\0');
    expect(toHex(nftIntentHash(erc721()))).toMatchInlineSnapshot(`"93d28bcdfea527b24ed84ffffafb84384784fca9a8e7d8be789833fd334af0fa"`);
    expect(toHex(nftIntentHash(sol('metaplex-pnft', { ruleSet: RULESET })))).toMatchInlineSnapshot(`"136892ea5c158bec1eee475ca493e15221f909184e93bc3065e8afbfe831d8e4"`);
  });
  it('does not depend on JSON key order, and an absent optional field is absent from the bytes', () => {
    const i = erc721(), reversed = Object.fromEntries(Object.entries(i).reverse()) as NftIntent;
    expect(toHex(nftIntentHash(reversed))).toBe(toHex(nftIntentHash(i)));
    expect(Buffer.from(nftCanonicalBytes(sol('metaplex-core'))).includes('sol.collection')).toBe(false);
    expect(Buffer.from(nftCanonicalBytes(sol('metaplex-core', { collection: COLLECTION }))).includes('sol.collection')).toBe(true);
  });
  it('refuses unknown fields: there is no calldata, data, instruction or helper field to fill', () => {
    for (const extra of [{ data: '0x00' }, { calldata: '0x095ea7b3' }, { method: 'approve' }, { instructions: [] }, { aux: {} }, { operator: DEST }, { approved: true }, { memo: 'x' }, { swap: {} }])
      expect(NftIntentSchema.safeParse({ ...erc721(), ...extra }).success, JSON.stringify(extra)).toBe(false);
    expect(NftIntentSchema.safeParse({ ...erc721(), evm: { ...erc721().evm, data: '0x' } }).success).toBe(false);
    expect(NftIntentSchema.safeParse({ ...sol('metaplex-core'), sol: { ...sol('metaplex-core').sol, extraAccounts: [] } }).success).toBe(false);
    expect(NftIntentSchema.safeParse({ ...erc721(), standard: 'erc20' }).success).toBe(false);
    expect(NftIntentSchema.safeParse({ ...erc721(), standard: 'metaplex-bubblegum' }).success).toBe(false);
    expect(NftIntentSchema.safeParse({ ...erc721(), tokenId: '0x1' }).success).toBe(false);
    expect(NftIntentSchema.safeParse({ ...erc721(), tokenId: 1 }).success).toBe(false);
    expect(() => nftCanonicalBytes({ ...erc721(), sol: sol('metaplex-core').sol })).toThrow(/exactly one chain section/);
    expect(() => nftCanonicalBytes({ ...erc721(), evm: undefined })).toThrow(/exactly one chain section/);
  });
  it('PROPERTY: changing any single frozen field changes the hash', () => {
    const fields: [string, (i: NftIntent) => NftIntent][] = [
      ['network', (i) => ({ ...i, network: 'base' })], ['chainRef', (i) => ({ ...i, chainRef: '8453' })], ['standard', (i) => ({ ...i, standard: 'erc1155' })], ['asset', (i) => ({ ...i, asset: DEST })],
      ['tokenId', (i) => ({ ...i, tokenId: '2' })], ['quantity', (i) => ({ ...i, quantity: '2' })], ['program', (i) => ({ ...i, program: DEST })], ['from', (i) => ({ ...i, from: DEST })], ['to', (i) => ({ ...i, to: WALLET })],
      ['maxFee', (i) => ({ ...i, maxFee: '1' })], ['createdAt', (i) => ({ ...i, createdAt: i.createdAt + 1 })], ['expiresAt', (i) => ({ ...i, expiresAt: i.expiresAt + 1 })], ['policyVersion', (i) => ({ ...i, policyVersion: 5 })],
      ['nftPolicyVersion', (i) => ({ ...i, nftPolicyVersion: 2 })], ['keyId', (i) => ({ ...i, keyId: 'spw-ffffffffffffffff' })], ['proposalId', (i) => ({ ...i, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0000000000a2' })],
      ['nonce', (i) => ({ ...i, evm: { ...i.evm!, nonce: 4 } })], ['gasLimit', (i) => ({ ...i, evm: { ...i.evm!, gasLimit: '150001' } })], ['maxFeePerGas', (i) => ({ ...i, evm: { ...i.evm!, maxFeePerGas: '1' } })], ['tip', (i) => ({ ...i, evm: { ...i.evm!, maxPriorityFeePerGas: '2' } })],
    ];
    const h0 = toHex(nftIntentHash(erc721()));
    for (const [name, f] of fields) expect(toHex(nftIntentHash(f(erc721()))), name).not.toBe(h0);
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), (a, b) => {
      fc.pre(a !== b);
      return toHex(nftIntentHash(erc721({ tokenId: a.toString() }))) !== toHex(nftIntentHash(erc721({ tokenId: b.toString() })));
    }), { numRuns: 200 });
    const s0 = sol('metaplex-pnft', { ruleSet: RULESET });
    for (const m of [{ ruleSet: COLLECTION }, { tokenProgram: 'token2022' as const }, { computeUnitLimit: 200001 }, { computeUnitPrice: '1001' }, { recentBlockhash: MINT }, { lastValidBlockHeight: 300000001 }])
      expect(toHex(nftIntentHash({ ...s0, sol: { ...s0.sol!, ...m } })), JSON.stringify(m)).not.toBe(toHex(nftIntentHash(s0)));
    expect(toHex(nftIntentHash(sol('spl-token-2022', { createAta: false })))).not.toBe(toHex(nftIntentHash(sol('spl-token-2022', { createAta: true }))));
  });
  it('the lock-list and allow-list intents have their own domains, are strict, and commit to every outpoint in order', () => {
    const lock = { v: 1 as const, kind: 'utxo-locks' as const, requestId: ID, keyId: KEY, network: 'bitcoin', action: 'lock' as const, reason: 'owner' as const, outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }, { txid: 'cd'.repeat(32), vout: 1 }], createdAt: T, expiresAt: T + 120, policyVersion: 4 };
    const h = toHex(utxoLockHash(lock));
    expect(h).toMatchInlineSnapshot(`"d1f75b0bee3b5d5a582a802fa6e57865c0f0c0d0c280aad6837fc8bc5add588e"`);
    expect(toHex(utxoLockHash({ ...lock, action: 'unlock' }))).not.toBe(h);
    expect(toHex(utxoLockHash({ ...lock, outpoints: [...lock.outpoints].reverse() }))).not.toBe(h);
    expect(toHex(utxoLockHash({ ...lock, outpoints: [lock.outpoints[0]!] }))).not.toBe(h);
    expect(toHex(utxoLockHash({ ...lock, outpoints: [{ txid: 'ab'.repeat(32), vout: 1 }, lock.outpoints[1]!] }))).not.toBe(h);
    expect(() => utxoLockHash({ ...lock, outpoints: [lock.outpoints[0]!, lock.outpoints[0]!] })).toThrow(/duplicate/);
    expect(UtxoLockIntentSchema.safeParse({ ...lock, outpoints: [] }).success).toBe(false);
    expect(UtxoLockIntentSchema.safeParse({ ...lock, unlockAll: true }).success).toBe(false);
    const allow = { v: 1 as const, kind: 'nft-allow' as const, requestId: ID, keyId: KEY, network: 'ethereum', action: 'add' as const, address: DEST, createdAt: T, expiresAt: T + 120, policyVersion: 4 };
    expect(toHex(nftAllowHash(allow))).toMatchInlineSnapshot(`"9816a80c22ad90c14c8731494b8ab35507b8b20ec68b94d184e141b0b1d0e699"`);
    expect(toHex(nftAllowHash({ ...allow, action: 'remove' }))).not.toBe(toHex(nftAllowHash(allow)));
    expect(toHex(nftAllowHash({ ...allow, network: 'base' }))).not.toBe(toHex(nftAllowHash(allow)));
  });
});

// ── (3) EVM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const erc1155Abi = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)', 'function setApprovalForAll(address operator, bool approved)', 'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)']);
describe('EVM builder — the only two calls', () => {
  it('ERC-721: exactly safeTransferFrom(wallet, to, tokenId) to the contract, cross-checked with viem\'s ERC-721 ABI', () => {
    const tx = buildNftEvmTx(erc721());
    expect(tx).toMatchObject({ type: 'eip1559', chainId: 1, nonce: 3, to: BAYC, value: 0n, gas: 150000n });
    const d = decodeFunctionData({ abi: erc721Abi, data: tx.data! });
    expect(d.functionName).toBe('safeTransferFrom');
    expect(d.args).toEqual([WALLET, DEST, 1n]);
    expect((tx.data!.length - 2) / 2).toBe(100);
    // the bytes that are signed decode back to the same call (round trip through the serializer)
    const again = parseTransaction(serializeTransaction(tx));
    expect(again.to?.toLowerCase()).toBe(BAYC.toLowerCase()); expect(again.data).toBe(tx.data); expect(again.value ?? 0n).toBe(0n); expect(again.accessList ?? []).toEqual([]);
    verifyNftEvmTx(tx as never, erc721());
  });
  it('ERC-1155: exactly safeTransferFrom(wallet, to, id, quantity, "") — a uint256-max id stays exact, data is empty', () => {
    const i = erc1155(), tx = buildNftEvmTx(i);
    const d = decodeFunctionData({ abi: erc1155Abi, data: tx.data! });
    expect(d.functionName).toBe('safeTransferFrom');
    expect(d.args).toEqual([WALLET, DEST, (1n << 256n) - 1n, 3n, '0x']);
    expect((tx.data!.length - 2) / 2).toBe(196);
    verifyNftEvmTx(tx as never, i);
  });
  it('refuses, each with its own code: bad chain, non-normalized or forbidden addresses, quantities, token ids, gas and fee', () => {
    expect(code(() => buildNftEvmTx(erc721({ chainRef: '8453' })))).toBe('nft_wrong_chain');
    expect(code(() => buildNftEvmTx(erc721({ network: 'base' })))).toBe('nft_wrong_chain');
    expect(code(() => buildNftEvmTx(erc721({ network: 'nowhere' })))).toBe('nft_wrong_chain');
    expect(code(() => buildNftEvmTx(erc721({ network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef })))).toBe('nft_section_mismatch');
    expect(code(() => buildNftEvmTx(erc721({ standard: 'metaplex-core' })))).toBe('nft_standard_network_mismatch');
    expect(code(() => buildNftEvmTx(erc721({ asset: BAYC.toLowerCase(), program: BAYC.toLowerCase() })))).toBe('nft_bad_contract');
    expect(code(() => buildNftEvmTx(erc721({ to: DEST.toLowerCase() })))).toBe('nft_bad_destination');
    expect(code(() => buildNftEvmTx(erc721({ to: '0x0000000000000000000000000000000000000000' })))).toBe('nft_bad_destination');
    expect(code(() => buildNftEvmTx(erc721({ to: BAYC })))).toBe('nft_destination_is_contract_itself');
    expect(code(() => buildNftEvmTx(erc721({ to: WALLET })))).toBe('nft_self_send');
    expect(code(() => buildNftEvmTx(erc721({ program: DEST })))).toBe('nft_program_mismatch');
    const usdc = NETWORKS.ethereum.tokens.find((t) => t.symbol === 'USDC')!.id;
    expect(code(() => buildNftEvmTx(erc721({ asset: usdc, program: usdc })))).toBe('nft_contract_is_fungible_token');
    expect(code(() => buildNftEvmTx(erc721({ tokenId: undefined })))).toBe('nft_bad_token_id');
    expect(code(() => buildNftEvmTx(erc721({ tokenId: (1n << 256n).toString() })))).toBe('nft_bad_token_id');
    expect(code(() => buildNftEvmTx(erc721({ quantity: '0' })))).toBe('nft_bad_quantity');
    expect(code(() => buildNftEvmTx(erc721({ quantity: '2' })))).toBe('nft_bad_quantity');
    expect(code(() => buildNftEvmTx(erc1155({ quantity: '0' })))).toBe('nft_bad_quantity');
    expect(code(() => buildNftEvmTx(erc721({ evm: { ...erc721().evm!, gasLimit: '500001' } })))).toBe('nft_gas_cap');
    expect(code(() => buildNftEvmTx(erc721({ evm: { ...erc721().evm!, gasLimit: '20999' } })))).toBe('nft_gas_cap');
    expect(code(() => buildNftEvmTx(erc721({ maxFee: '2999999999999999' })))).toBe('nft_fee_exceeds_max');
    expect(code(() => buildNftEvmTx(erc721({ evm: { ...erc721().evm!, maxPriorityFeePerGas: '20000000001' } })))).toBe('nft_fee_exceeds_max');
  });
  it('the independent verifier refuses every forged transaction presented as the NFT transfer of the intent', () => {
    const i = erc721(), good = buildNftEvmTx(i), v = (tx: Record<string, unknown>, intent = i) => code(() => verifyNftEvmTx(tx, intent));
    const sel = (abi: string, args: unknown[]) => { const a = parseAbi([`function ${abi}`] as never); return (require_encode(a, args)); };
    expect(v({ ...good })).toBe('no refusal');
    expect(v({ ...good, chainId: 8453 })).toBe('nft_wrong_chain');
    expect(v({ ...good, to: DEST })).toBe('nft_contract_substituted');
    expect(v({ ...good, value: 1n })).toBe('nft_tx_value');
    expect(v({ ...good, nonce: 4 })).toBe('nft_bad_nonce');
    expect(v({ ...good, gas: 150001n })).toBe('nft_fee_exceeds_max');
    expect(v({ ...good, maxFeePerGas: 20000000001n })).toBe('nft_fee_exceeds_max');
    expect(v({ ...good, type: 'legacy' })).toBe('nft_tx_type');
    expect(v({ ...good, accessList: [] })).toBe('nft_tx_unknown_field');
    expect(v({ ...good, authorizationList: [] })).toBe('nft_tx_unknown_field');
    // extra calldata bytes
    expect(v({ ...good, data: good.data + '00' })).toBe('nft_calldata_length');
    expect(v({ ...good, data: good.data + '00'.repeat(32) })).toBe('nft_calldata_length');
    expect(v({ ...good, data: good.data!.slice(0, -2) })).toBe('nft_calldata_length');
    // token id / destination / source substituted
    expect(v(buildNftEvmTx(erc721({ tokenId: '2' })) as never)).toBe('nft_token_id_substituted');
    expect(v(buildNftEvmTx(erc721({ to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' })) as never)).toBe('nft_destination_substituted');
    expect(v({ ...good, data: good.data!.slice(0, 10) + DEST.slice(2).toLowerCase().padStart(64, '0') + good.data!.slice(74) })).toBe('nft_wrong_source');
    expect(v({ ...good, data: good.data!.slice(0, 10) + 'ff' + good.data!.slice(12) })).toBe('nft_calldata'); // dirty upper bytes of an address word
    // another selector presented as the transfer: approve, setApprovalForAll, transferFrom, the 4-argument safeTransferFrom, ERC-20 transfer
    expect(v({ ...good, data: sel('approve(address to, uint256 tokenId)', [DEST, 1n]) })).toBe('nft_selector');
    expect(v({ ...good, data: sel('setApprovalForAll(address operator, bool approved)', [DEST, true]) })).toBe('nft_selector');
    expect(v({ ...good, data: sel('transferFrom(address from, address to, uint256 tokenId)', [WALLET, DEST, 1n]) })).toBe('nft_selector');
    expect(v({ ...good, data: sel('safeTransferFrom(address from, address to, uint256 tokenId, bytes data)', [WALLET, DEST, 1n, '0x']) })).toBe('nft_selector');
    expect(v({ ...good, data: sel('transfer(address to, uint256 amount)', [DEST, 1n]) })).toBe('nft_selector');
    expect(v({ ...good, data: '0x' })).toBe('nft_calldata');
    // ERC-1155: quantity substituted, non-empty data, batch, operator approval
    const j = erc1155(), g2 = buildNftEvmTx(j), v2 = (tx: Record<string, unknown>) => code(() => verifyNftEvmTx(tx, j));
    expect(v2({ ...g2 })).toBe('no refusal');
    expect(v2(buildNftEvmTx(erc1155({ quantity: '4' })) as never)).toBe('nft_quantity_substituted');
    expect(v2({ ...g2, data: sel('safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)', [WALLET, DEST, BigInt(j.tokenId!), 3n, '0x01']) })).toBe('nft_calldata_length');
    expect(v2({ ...g2, data: g2.data!.slice(0, -64) + '1'.padStart(64, '0') })).toBe('nft_data_not_empty'); // a length of 1 with no byte behind it
    expect(v2({ ...g2, data: g2.data!.slice(0, 10 + 4 * 64) + 'c0'.padStart(64, '0') + g2.data!.slice(10 + 5 * 64) })).toBe('nft_calldata'); // moved offset
    expect(v2({ ...g2, data: sel('safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)', [WALLET, DEST, [1n], [1n], '0x']) })).toBe('nft_selector');
    expect(v2({ ...g2, data: sel('setApprovalForAll(address operator, bool approved)', [DEST, true]) })).toBe('nft_selector');
    // an ERC-721 call presented for an ERC-1155 intent and the other way round
    expect(v2({ ...g2, data: good.data })).toBe('nft_selector');
    expect(v({ ...good, data: g2.data })).toBe('nft_selector');
  });
  it('PROPERTY: for any token id, quantity and destination the built call decodes to exactly those values and passes the verifier; any other intent\'s transaction fails it', () => {
    const addr = fc.bigInt({ min: 1n, max: (1n << 160n) - 1n }).map((n) => '0x' + n.toString(16).padStart(40, '0'));
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), fc.bigInt({ min: 1n, max: (1n << 64n) }), addr, fc.boolean(), (id, qty, rawTo, is1155) => {
      const to = normalize(rawTo);
      fc.pre(to !== WALLET && to !== BAYC);
      const i = is1155 ? erc1155({ tokenId: id.toString(), quantity: qty.toString(), to }) : erc721({ tokenId: id.toString(), to });
      const tx = buildNftEvmTx(i);
      const d = decodeFunctionData({ abi: is1155 ? erc1155Abi : erc721Abi, data: tx.data! });
      const ok = d.functionName === 'safeTransferFrom' && d.args![0] === WALLET && d.args![1] === to && d.args![2] === id && (!is1155 || (d.args![3] === qty && d.args![4] === '0x'));
      verifyNftEvmTx(tx as never, i);
      const other = is1155 ? erc1155({ tokenId: (id ^ 1n).toString(), quantity: qty.toString(), to }) : erc721({ tokenId: (id ^ 1n).toString(), to });
      return ok && code(() => verifyNftEvmTx(tx as never, other)) === 'nft_token_id_substituted';
    }), { numRuns: 150 });
  });
});
const require_encode = (abi: never, args: unknown[]) => encodeFunctionData({ abi, args } as never);
const normalize = (a: string) => getAddress(a);

// ── (4) Solana ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const kit = (msg: Uint8Array) => getCompiledTransactionMessageDecoder().decode(msg) as unknown as { version: string; header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }; staticAccounts: string[]; lifetimeToken: string;
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[] };
const ixOf = (msg: Uint8Array, k: number) => { const m = kit(msg), ix = m.instructions[k]!; return { program: m.staticAccounts[ix.programAddressIndex]!, accounts: (ix.accountIndices ?? []).map((a) => m.staticAccounts[a]!), data: Buffer.from(ix.data ?? []).toString('hex'),
  writable: (a: string) => { const j = m.staticAccounts.indexOf(a); return j < m.header.numSignerAccounts - m.header.numReadonlySignerAccounts || (j >= m.header.numSignerAccounts && j < m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts); } }; };

describe('Solana builder — the canonical instruction list per standard (cross-checked with @solana/kit)', () => {
  it('Metaplex Core: TransferV1 with the 7 accounts of the IDL, discriminator 14, no compression proof', () => {
    const i = sol('metaplex-core', { collection: COLLECTION }), msg = buildNftSolMessage(i), m = kit(msg);
    expect(m.version).toBe('legacy');
    expect(m.header).toEqual({ numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 5 });
    expect(m.staticAccounts[0]).toBe(SOL_WALLET); expect(m.lifetimeToken).toBe(BH); expect(m.instructions).toHaveLength(3);
    expect(ixOf(msg, 0)).toMatchObject({ program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: '02400d0300' });
    expect(ixOf(msg, 1)).toMatchObject({ program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: '03e803000000000000' });
    const t = ixOf(msg, 2);
    expect(t.program).toBe(NFT_CORE_PROGRAM);
    expect(t.accounts).toEqual([MINT, COLLECTION, SOL_WALLET, SOL_WALLET, SOL_DEST, SYSTEM_PROGRAM, NFT_CORE_PROGRAM]);
    expect(t.data).toBe('0e00');
    expect([MINT, COLLECTION, SOL_WALLET, SOL_DEST].map(t.writable)).toEqual([true, false, true, false]);
    // without a collection the optional account is the program id itself (Shank convention)
    expect(ixOf(buildNftSolMessage(sol('metaplex-core')), 2).accounts).toEqual([MINT, NFT_CORE_PROGRAM, SOL_WALLET, SOL_WALLET, SOL_DEST, SYSTEM_PROGRAM, NFT_CORE_PROGRAM]);
    verifyNftSolMessage(msg, i);
  });
  it('programmable NFT: Token Metadata Transfer with the 17 accounts of the IDL — both token records, the rule set and its program', () => {
    const i = sol('metaplex-pnft', { ruleSet: RULESET }), msg = buildNftSolMessage(i), t = ixOf(msg, 2);
    const src = associatedTokenAddress(SOL_WALLET, MINT, TOKEN_PROGRAM), dst = associatedTokenAddress(SOL_DEST, MINT, TOKEN_PROGRAM);
    expect(kit(msg).instructions).toHaveLength(3);
    expect(t.program).toBe(NFT_TOKEN_METADATA_PROGRAM);
    expect(t.accounts).toEqual([src, SOL_WALLET, dst, SOL_DEST, MINT, nftMetadataPda(MINT), nftEditionPda(MINT), nftTokenRecordPda(MINT, src), nftTokenRecordPda(MINT, dst), SOL_WALLET, SOL_WALLET,
      SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM, ATA_PROGRAM, NFT_TOKEN_AUTH_RULES_PROGRAM, RULESET]);
    expect(t.data).toBe('3100' + '0100000000000000' + '00'); // Transfer, TransferArgs::V1, amount 1, authorization_data None
    expect([src, dst, nftMetadataPda(MINT), nftTokenRecordPda(MINT, src), nftTokenRecordPda(MINT, dst), SOL_WALLET].map(t.writable)).toEqual([true, true, true, true, true, true]);
    expect([SOL_DEST, MINT, nftEditionPda(MINT), RULESET, NFT_TOKEN_AUTH_RULES_PROGRAM, SYSVAR_INSTRUCTIONS].map(t.writable)).toEqual([false, false, false, false, false, false]);
    verifyNftSolMessage(msg, i);
    // a pNFT without a rule set: the two optional accounts are the program id
    const bare = ixOf(buildNftSolMessage(sol('metaplex-pnft')), 2).accounts;
    expect(bare.slice(15)).toEqual([NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_METADATA_PROGRAM]);
  });
  it('legacy Token Metadata NFT: the same instruction without token records and without a rule set', () => {
    const i = sol('metaplex-token-metadata'), msg = buildNftSolMessage(i), t = ixOf(msg, 2), P = NFT_TOKEN_METADATA_PROGRAM;
    const src = associatedTokenAddress(SOL_WALLET, MINT, TOKEN_PROGRAM), dst = associatedTokenAddress(SOL_DEST, MINT, TOKEN_PROGRAM);
    expect(t.accounts).toEqual([src, SOL_WALLET, dst, SOL_DEST, MINT, nftMetadataPda(MINT), nftEditionPda(MINT), P, P, SOL_WALLET, SOL_WALLET, SYSTEM_PROGRAM, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM, ATA_PROGRAM, P, P]);
    expect(t.data).toBe('3100010000000000000000');
    verifyNftSolMessage(msg, i);
  });
  it('Token-2022 NFT: [CreateIdempotent of the recipient\'s associated account] + TransferChecked(amount 1, decimals 0)', () => {
    const i = sol('spl-token-2022'), msg = buildNftSolMessage(i);
    const src = associatedTokenAddress(SOL_WALLET, MINT, TOKEN_2022_PROGRAM), dst = associatedTokenAddress(SOL_DEST, MINT, TOKEN_2022_PROGRAM);
    expect(kit(msg).instructions).toHaveLength(4);
    expect(ixOf(msg, 2)).toMatchObject({ program: ATA_PROGRAM, accounts: [SOL_WALLET, dst, SOL_DEST, MINT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM], data: '01' });
    expect(ixOf(msg, 3)).toMatchObject({ program: TOKEN_2022_PROGRAM, accounts: [src, MINT, dst, SOL_WALLET], data: '0c' + '0100000000000000' + '00' });
    verifyNftSolMessage(msg, i);
    const j = sol('spl-token-2022', { createAta: false }), m2 = buildNftSolMessage(j);
    expect(kit(m2).instructions).toHaveLength(3);
    expect(ixOf(m2, 2).program).toBe(TOKEN_2022_PROGRAM);
    verifyNftSolMessage(m2, j);
  });
  it('refuses, each with its own code: wrong cluster, a section of another standard, quantities, programs, destinations, budget and fee', () => {
    const p = (i: NftIntent) => code(() => planNftSol(i));
    expect(p(sol('metaplex-core', {}, { chainRef: 'x' }))).toBe('nft_wrong_chain');
    expect(p(sol('metaplex-core', {}, { network: 'ethereum', chainRef: '1' }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-core', {}, { standard: 'erc721' }))).toBe('nft_standard_network_mismatch');
    expect(p(sol('metaplex-core', {}, { tokenId: '1' }))).toBe('nft_bad_token_id');
    expect(p(sol('metaplex-core', {}, { quantity: '2' }))).toBe('nft_bad_quantity');
    expect(p(sol('metaplex-core', {}, { quantity: '0' }))).toBe('nft_bad_quantity');
    expect(p(sol('metaplex-core', {}, { to: SOL_WALLET }))).toBe('nft_self_send');
    expect(p(sol('metaplex-core', { tokenProgram: 'token' }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-core', { ruleSet: RULESET }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-core', { createAta: true }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-pnft', { collection: COLLECTION }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-token-metadata', { ruleSet: RULESET }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-token-metadata', { tokenProgram: undefined }))).toBe('nft_section_mismatch');
    expect(p(sol('spl-token-2022', { tokenProgram: 'token' }))).toBe('nft_section_mismatch');
    expect(p(sol('spl-token-2022', { createAta: undefined }))).toBe('nft_section_mismatch');
    expect(p(sol('metaplex-core', {}, { program: NFT_TOKEN_METADATA_PROGRAM }))).toBe('nft_program_mismatch');
    expect(p(sol('metaplex-pnft', {}, { program: TOKEN_PROGRAM }))).toBe('nft_program_mismatch');
    expect(p(sol('metaplex-core', {}, { program: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }))).toBe('nft_program_mismatch');
    for (const to of [NFT_CORE_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, MINT, COLLECTION]) expect(p(sol('metaplex-core', { collection: COLLECTION }, { to })), to).toBe('nft_bad_destination');
    expect(p(sol('metaplex-pnft', {}, { to: nftMetadataPda(MINT) }))).toBe('nft_bad_destination');
    expect(p(sol('metaplex-pnft', {}, { to: associatedTokenAddress(SOL_WALLET, MINT, TOKEN_PROGRAM) }))).toBe('nft_bad_destination');
    expect(p(sol('metaplex-pnft', { ruleSet: NFT_TOKEN_METADATA_PROGRAM }))).toBe('nft_bad_rule_set');
    expect(p(sol('metaplex-core', { collection: SYSTEM_PROGRAM }))).toBe('nft_bad_collection');
    expect(p(sol('metaplex-core', {}, { to: 'not-base58-0OIl' }))).toBe('nft_bad_destination');
    expect(p(sol('metaplex-core', { computeUnitPrice: '5000001' }, { maxFee: '99999999' }))).toBe('nft_compute_cap');
    expect(p(sol('metaplex-core', { computeUnitLimit: 400000, computeUnitPrice: '2000000' }, { maxFee: '804999' }))).toBe('nft_fee_exceeds_max');
    expect(p(sol('metaplex-core', { computeUnitLimit: 400000, computeUnitPrice: '2000000' }, { maxFee: '805000' }))).toBe('no refusal');
    expect(p(sol('metaplex-core', { recentBlockhash: '11111111111111111111111111111111' }))).toBe('nft_bad_blockhash');
    expect(NftIntentSchema.safeParse(sol('metaplex-core', { computeUnitLimit: 400001 })).success).toBe(false);
  });
  it('the independent verifier refuses an added instruction, a smuggled approval or delegation, an unknown program, reordered or extra accounts, another budget, another signer, a versioned message', () => {
    for (const i of [sol('metaplex-core', { collection: COLLECTION }), sol('metaplex-pnft', { ruleSet: RULESET }), sol('metaplex-token-metadata'), sol('spl-token-2022')]) {
      const plan = planNftSol(i), main = plan.ixs.length - 1, src = plan.sourceToken ?? MINT;
      const forged = (ixs: NftSolIx[], payer = SOL_WALLET, bh = BH) => code(() => verifyNftSolMessage(compileNftSolMessage(payer, ixs, bh), i));
      const ro = (pubkey: string) => ({ pubkey, signer: false, writable: false }), rw = (pubkey: string) => ({ pubkey, signer: false, writable: true }), me = { pubkey: SOL_WALLET, signer: true, writable: true };
      expect(forged(plan.ixs), i.standard).toBe('no refusal');
      // added instruction: a System transfer of lamports to someone else
      expect(forged([...plan.ixs, { program: SYSTEM_PROGRAM, accounts: [me, rw(SOL_DEST)], data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) }])).toBe('nft_instruction_count');
      // smuggled SPL Approve (instruction 4) of the wallet's token account to a delegate, before or instead of the transfer
      const approve: NftSolIx = { program: TOKEN_PROGRAM, accounts: [rw(src), ro(SOL_DEST), me], data: Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0, 0) };
      expect(forged([plan.ixs[0]!, plan.ixs[1]!, approve, ...plan.ixs.slice(2)])).toBe('nft_instruction_count');
      expect(forged([...plan.ixs.slice(0, main), approve])).toMatch(/^nft_instruction_(program|accounts|data)$/);
      // smuggled Token Metadata Delegate (44) / Core ApprovePluginAuthority (8) in place of the transfer: same program, other data
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, data: Uint8Array.of(i.standard === 'metaplex-core' ? 8 : 44, 0) }])).toBe('nft_instruction_data');
      // SetAuthority (6) on the token account, with the same accounts as nothing canonical
      expect(forged([...plan.ixs.slice(0, main), { program: TOKEN_PROGRAM, accounts: [rw(src), me], data: Uint8Array.of(6, 2, 1, ...new Array(32).fill(7)) }])).toMatch(/^nft_instruction_(program|accounts)$/);
      // unknown program (in place of the transfer, and as an extra instruction)
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, program: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }])).toBe('nft_unknown_program');
      expect(forged([...plan.ixs, { program: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', accounts: [], data: Uint8Array.of(1) }])).toBe('nft_unknown_program');
      // reordered accounts, a dropped account, an extra account
      const acc = plan.ixs[main]!.accounts;
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, accounts: [acc[1]!, acc[0]!, ...acc.slice(2)] }])).toBe('nft_instruction_accounts');
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, accounts: acc.slice(0, -1) }])).toBe('nft_instruction_accounts');
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, accounts: [...acc, ro('SysvarRent111111111111111111111111111111111')] }])).toBe('nft_instruction_accounts');
      // destination substituted inside the instruction
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, accounts: acc.map((a) => (a.pubkey === SOL_DEST || a.pubkey === plan.destinationToken ? { ...a, pubkey: 'Vote111111111111111111111111111111111111111' } : a)) }])).toBe('nft_instruction_accounts');
      // a read-only account made writable
      expect(forged([...plan.ixs.slice(0, main), { ...plan.ixs[main]!, accounts: acc.map((a) => (a.pubkey === MINT && i.standard !== 'metaplex-core' ? { ...a, writable: true } : a.pubkey === SOL_DEST ? { ...a, writable: true } : a)) }])).toBe('nft_account_flags');
      // compute budget: another limit, another price, a missing or duplicated budget instruction
      expect(forged([{ ...plan.ixs[0]!, data: Uint8Array.of(2, 0xff, 0xff, 0xff, 0x7f) }, ...plan.ixs.slice(1)])).toBe('nft_instruction_data');
      expect(forged([plan.ixs[0]!, { ...plan.ixs[1]!, data: Uint8Array.of(3, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0) }, ...plan.ixs.slice(2)])).toBe('nft_instruction_data');
      expect(forged(plan.ixs.slice(1))).toBe('nft_instruction_count');
      expect(forged([plan.ixs[0]!, ...plan.ixs])).toBe('nft_instruction_count');
      // another blockhash; another fee payer
      expect(forged(plan.ixs, SOL_WALLET, MINT)).toBe('nft_bad_blockhash');
      expect(code(() => compileNftSolMessage(SOL_DEST, plan.ixs, BH))).toBe('nft_extra_signer');
      // bytes: trailing garbage, a versioned (v0) message, a second required signature, a truncated message
      const good = compileNftSolMessage(SOL_WALLET, plan.ixs, BH);
      expect(code(() => verifyNftSolMessage(Uint8Array.from([...good, 0]), i))).toBe('nft_message_malformed');
      expect(code(() => verifyNftSolMessage(Uint8Array.from([0x80, ...good]), i))).toBe('nft_message_versioned');
      expect(code(() => verifyNftSolMessage(Uint8Array.from([2, ...good.slice(1)]), i))).toBe('nft_extra_signer');
      expect(code(() => verifyNftSolMessage(good.slice(0, -3), i))).toBe('nft_message_malformed');
      // the message of another intent (other asset, other destination) is not the message of this one
      expect(code(() => verifyNftSolMessage(buildNftSolMessage({ ...i, asset: COLLECTION, sol: { ...i.sol!, collection: undefined } }), i))).toBe('nft_instruction_accounts');
      expect(code(() => verifyNftSolMessage(buildNftSolMessage({ ...i, to: 'Vote111111111111111111111111111111111111111' }), i))).toBe('nft_instruction_accounts');
    }
  });
  it('the strict decoder agrees with @solana/kit on every built message', () => {
    for (const i of [sol('metaplex-core', { collection: COLLECTION }), sol('metaplex-core'), sol('metaplex-pnft', { ruleSet: RULESET }), sol('metaplex-pnft'), sol('metaplex-token-metadata'), sol('spl-token-2022'), sol('spl-token-2022', { createAta: false })]) {
      const msg = buildNftSolMessage(i), a = decodeNftSolMessage(msg), b = kit(msg);
      expect(a.keys).toEqual(b.staticAccounts); expect(a.recentBlockhash).toBe(b.lifetimeToken);
      expect(a.ixs.map((x) => [x.program, x.accounts, Buffer.from(x.data).toString('hex')])).toEqual(b.instructions.map((x) => [b.staticAccounts[x.programAddressIndex], (x.accountIndices ?? []).map((k) => b.staticAccounts[k]), Buffer.from(x.data ?? []).toString('hex')]));
      for (const x of a.ixs) expect(Object.values(NFT_SOL_PINNED)).toContain(x.program);
      expect(msg.length).toBeLessThan(1232 - 65);
    }
  });
});

// ── (5) policy ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('NFT policy — defaults, merge-on-load, checks', () => {
  const main = { version: 4, maxFee: { ethereum: '5000000000000000', solana: '3000000' }, maxApprovalTtlSec: 300, allowlist: [] as string[] };
  const ctx = (o: Partial<Parameters<typeof checkNftPolicy>[0]> = {}) => ({ policy: main, signedToday: 0, nowSec: T + 1, halted: false, allowed: new Set<string>(), ...o });
  const p = (c: Parameters<typeof checkNftPolicy>[0], i: NftIntent) => code(() => checkNftPolicy(c, i));
  it('defaults are conservative and complete; a missing key takes its default, a present key is kept exactly', () => {
    const d = defaultNftPolicy();
    expect(d).toMatchObject({ version: 1, maxTransfersPerDay: 5, maxErc1155Quantity: '10', allowlistOnly: false, maxComputeUnits: 400000, maxComputeUnitPrice: '2000000' });
    expect(Object.keys(d.enabled).sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'solana']);
    expect(d.enabled.ethereum).toEqual(['erc721', 'erc1155']);
    expect(effectiveNftPolicy(undefined)).toEqual(d);
    expect(effectiveNftPolicy({})).toEqual(d);
    expect(effectiveNftPolicy({ maxTransfersPerDay: 1 })).toEqual({ ...d, maxTransfersPerDay: 1 });
    expect(effectiveNftPolicy({ enabled: { base: ['erc721'] }, allowlistOnly: true })).toEqual({ ...d, enabled: { base: ['erc721'] }, allowlistOnly: true });
    expect(effectiveNftPolicy({ maxTransfersPerDay: 0 }).maxTransfersPerDay).toBe(0); // zero is a value: it disables, it is not "missing"
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, nft: { maxTransfersPerDay: 2 } }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, nft: { unknownKey: 1 } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, nft: { enabled: { base: ['transferFrom'] } } }).success).toBe(false);
  });
  it('each refusal has its own code', () => {
    expect(p(ctx(), erc721())).toBe('no refusal');
    expect(p(ctx({ halted: true }), erc721())).toBe('nft_halted');
    expect(p(ctx(), erc721({ policyVersion: 3 }))).toBe('nft_policy_version');
    expect(p(ctx(), erc721({ nftPolicyVersion: 0 }))).toBe('nft_policy_version');
    expect(p(ctx({ nowSec: T + 120 }), erc721())).toBe('nft_expired');
    expect(p(ctx({ nowSec: T - 100 }), erc721())).toBe('nft_window');
    expect(p(ctx(), erc721({ expiresAt: T + 301 }))).toBe('nft_window');
    expect(p(ctx({ policy: { ...main, nft: { enabled: { ethereum: ['erc1155'] } } } }), erc721())).toBe('nft_network_disabled');
    expect(p(ctx({ policy: { ...main, nft: { enabled: {} } } }), erc721())).toBe('nft_network_disabled');
    expect(p(ctx(), erc1155({ quantity: '10' }))).toBe('no refusal');
    expect(p(ctx(), erc1155({ quantity: '11' }))).toBe('nft_quantity_cap');
    expect(p(ctx(), erc1155({ quantity: '0' }))).toBe('nft_bad_quantity');
    expect(p(ctx(), erc721({ quantity: '2' }))).toBe('nft_bad_quantity');
    expect(p(ctx({ signedToday: 4 }), erc721())).toBe('no refusal');
    expect(p(ctx({ signedToday: 5 }), erc721())).toBe('nft_daily_count');
    expect(p(ctx({ policy: { ...main, nft: { maxTransfersPerDay: 0 } } }), erc721())).toBe('nft_daily_count');
    expect(p(ctx(), erc721({ maxFee: '5000000000000001' }))).toBe('nft_fee_cap');
    expect(p(ctx({ policy: { ...main, maxFee: {} } }), erc721())).toBe('nft_fee_cap');
    expect(p(ctx({ policy: { ...main, nft: { maxComputeUnits: 100000 } } }), sol('metaplex-core'))).toBe('nft_compute_cap');
    expect(p(ctx({ policy: { ...main, nft: { maxComputeUnitPrice: '999' } } }), sol('metaplex-core'))).toBe('nft_compute_cap');
    expect(p(ctx({ policy: { ...main, allowlist: ['ethereum:0x0000000000000000000000000000000000000001'] } }), erc721())).toBe('nft_not_allowlisted');
    expect(p(ctx({ policy: { ...main, nft: { allowlistOnly: true } } }), erc721())).toBe('nft_not_allowlisted');
    expect(p(ctx({ policy: { ...main, nft: { allowlistOnly: true } }, allowed: new Set([`base:${DEST}`]) }), erc721())).toBe('nft_not_allowlisted'); // listed on another network
    expect(p(ctx({ policy: { ...main, nft: { allowlistOnly: true } }, allowed: new Set([`ethereum:${DEST}`]) }), erc721())).toBe('no refusal');
  });
});
