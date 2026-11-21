/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/native-vectors.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-18
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

// Test vectors for the native Swift clients (macOS / iOS): the canonical serialization and the SHA-256 hash (= the WebAuthn
// challenge) of every object the owner approves with a passkey, produced by the REAL canonical functions of this repository.
//
//   npx tsx scripts/native-vectors.mts
//
// Writes one JSON file per domain (and README.md, copied from tests/native-vectors/README.md) into
//   tests/native-vectors/                                                             (this worktree)
//   ../../apple/SPWalletCore/Tests/SPWalletCoreTests/Vectors/   (override: SPW_NATIVE_VECTORS_DIR; skipped when absent)
//
// Deterministic: fixed UUIDs, fixed timestamps, no randomness, no clock, no network, no database (the API modules are imported
// with dummy environment values; `postgres()` is lazy and no query is ever issued). Running it twice gives identical bytes.
//
// Rule of this file: NO canonical function is re-implemented. Where the real function returns only a hash, the bytes written in
// `canonicalHex` are rebuilt from EXPORTED pieces (the real framing `canonicalEncode`, the real `canonicalJson`) and the script
// asserts sha256(canonicalHex) === the hash returned by the real function, for every vector. See README.md.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SPW_ORIGIN ??= 'https://example.test';
process.env.SPW_RP_ID ??= 'example.test';
process.env.DATABASE_URL ??= 'postgres://127.0.0.1:1/none';
process.env.SPW_SIGNER_SECRET ??= 'x'.repeat(40);
process.env.SPW_WORKERS ??= 'off';
process.env.SPW_BROADCAST ??= 'off';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => join(ROOT, p);

const core = await import(src('packages/core/src/index.ts'));
const live = await import(src('packages/derivatives/src/live/index.ts'));
const deriv = await import(src('packages/derivatives/src/index.ts'));
const trading = await import(src('packages/trading/src/index.ts'));
const keyModel = await import(src('services/api/src/trading-api/keys.ts')).then(() => import(src('services/api/src/trading-api/key-model.ts')));
const apiSpec = await import(src('services/api/src/trading-api/spec.ts'));
const exec = await import(src('services/api/src/derivatives/exec.ts'));
const gmxExec = await import(src('services/api/src/derivatives/gmx-exec.ts'));
const riskService = await import(src('services/api/src/risk/service.ts'));
const mandateService = await import(src('services/api/src/mandates/service.ts'));
const signerMod = await import(src('services/isolated-signer/src/signer.ts'));

const hex = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('hex');
const sha256 = (b: Uint8Array | Buffer | string): Buffer => createHash('sha256').update(b).digest();
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

interface Vector { name: string; domain: string; source: string; object: unknown; canonicalHex?: string; hashHex: string }
const files = new Map<string, Vector[]>();
function add(file: string, v: { name: string; domain: string; source: string; object: unknown; bytes?: Uint8Array | Buffer; hash: Uint8Array | Buffer | string }): void {
  const hashHex = typeof v.hash === 'string' ? v.hash : hex(v.hash);
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error(`${v.name}: not a SHA-256 hash`);
  // the object must survive a JSON round trip unchanged: it is what the API serves
  const object = JSON.parse(JSON.stringify(v.object));
  const out: Vector = { name: v.name, domain: v.domain, source: v.source, object, hashHex };
  if (v.bytes) {
    if (hex(sha256(v.bytes)) !== hashHex) throw new Error(`${v.name}: sha256(canonical bytes) is not the hash of the real function`);
    if (!Buffer.from(v.bytes).subarray(0, v.domain.length).equals(utf8(v.domain))) throw new Error(`${v.name}: bytes do not start with the domain`);
    out.canonicalHex = hex(v.bytes);
    out.hashHex = hashHex;
    files.set(file, [...(files.get(file) ?? []), { name: out.name, domain: out.domain, source: out.source, object: out.object, canonicalHex: out.canonicalHex, hashHex: out.hashHex }]);
    return;
  }
  files.set(file, [...(files.get(file) ?? []), out]);
}

// ------------------------------------------------------------------------------------------------------------------ constants
const T0 = 1_794_000_000;            // unix seconds
const T0_MS = 1_794_000_000_000;     // unix milliseconds
const uuid = (n: number): string => `7a1c1f0e-8f5f-4b1e-9c56-${n.toString(16).padStart(12, '0')}`;
const KEY_ID = 'spw-0123456789abcdef';
const ME_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', ME_EVM_LC = ME_EVM.toLowerCase();
const DEST_EVM = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const AGENT_LC = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const VAULT_EVM = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const ME_BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', DEST_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ME_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', DEST_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const ME_XRP = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', DEST_XRP = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const ME_COSMOS = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02', DEST_COSMOS = 'cosmos1zcjduepq0vu2zgkgk49efa0nqwzndanq5m4c7pa3u4apz4g';
const N = core.NETWORKS;
const token = (network: string, symbol: string): string => N[network].tokens.find((t: { symbol: string }) => t.symbol === symbol).id;
const USDC_ETH = token('ethereum', 'USDC'), USDC_BASE = token('base', 'USDC'), USDC_ARB = token('arbitrum', 'USDC'), USDC_SOL = token('solana', 'USDC');
const SHA_A = 'a1'.repeat(32), SHA_B = 'b2'.repeat(32), SHA_C = 'c3'.repeat(32), TXID_1 = 'ab'.repeat(32), TXID_2 = 'cd'.repeat(32);
const evmGas = { nonce: 7, gasLimit: '21000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' };
const solSection = (createAta: boolean) => ({ recentBlockhash: BLOCKHASH, lastValidBlockHeight: 312345678, createAta, computeUnitLimit: 200000, computeUnitPrice: '5000' });
const head = (n: number, o: Record<string, unknown>) => ({ v: 1, proposalId: uuid(n), keyId: KEY_ID, ...o, createdAt: T0, expiresAt: T0 + 120, policyVersion: 4 });

// ------------------------------------------------------------------------------------------------------------------ 1. SPW-INTENT-v1
{
  const D = 'SPW-INTENT-v1', S = 'packages/core/src/intent.ts canonicalBytes / intentHash', F = 'SPW-INTENT-v1.json';
  const put = (name: string, object: Record<string, unknown>) => add(F, { name, domain: D, source: S, object, bytes: core.canonicalBytes(object), hash: core.intentHash(object) });

  put('transfer-evm-native', { ...head(1, { network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1500000000000000000', from: ME_EVM, to: DEST_EVM, maxFee: '420000000000000' }), evm: evmGas });
  put('transfer-evm-erc20', { ...head(2, { network: 'base', chainRef: '8453', asset: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '25000000', from: ME_EVM, to: DEST_EVM, maxFee: '1300000000000000' }), evm: { nonce: 0, gasLimit: '65000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '0' } });
  put('transfer-bitcoin-2-inputs', { ...head(3, { network: 'bitcoin', chainRef: N.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '150000', from: ME_BTC, to: DEST_BTC, maxFee: '2000' }),
    btc: { inputs: [{ txid: TXID_1, vout: 1, value: '100000' }, { txid: TXID_2, vout: 0, value: '90000' }], change: '38600', fee: '1400' } });
  put('transfer-solana-token-create-ata', { ...head(4, { network: 'solana', chainRef: N.solana.chainRef, asset: USDC_SOL, symbol: 'USDC', decimals: 6, amount: '12500000', from: ME_SOL, to: DEST_SOL, maxFee: '2100000' }), sol: solSection(true) });
  put('transfer-solana-native-no-ata', { ...head(5, { network: 'solana', chainRef: N.solana.chainRef, asset: 'native', symbol: 'SOL', decimals: 9, amount: '250000000', from: ME_SOL, to: DEST_SOL, maxFee: '6000' }), sol: solSection(false) });
  const xrp = head(6, { network: 'xrpl', chainRef: N.xrpl.chainRef, asset: 'native', symbol: 'XRP', decimals: 6, amount: '2500000', from: ME_XRP, to: DEST_XRP, maxFee: '12' });
  put('transfer-xrpl-x-map-no-memo', { ...xrp, x: { sequence: '210', lastLedgerSequence: '108249099', fee: '12' } });
  put('transfer-xrpl-x-map-with-memo', { ...xrp, proposalId: uuid(7), memo: '4294967295', x: { sequence: '210', lastLedgerSequence: '108249099', fee: '12' } });
  const atom = head(8, { network: 'cosmos', chainRef: N.cosmos.chainRef, asset: 'native', symbol: 'ATOM', decimals: 6, amount: '1000000', from: ME_COSMOS, to: DEST_COSMOS, maxFee: '5000' });
  const cosmosX = { timeout_height: '24000000', sequence: '12', gas_limit: '200000', fee_amount: '5000', account_number: '123456' };   // deliberately NOT in sorted order
  put('transfer-cosmos-x-map-no-memo', { ...atom, x: cosmosX });
  put('transfer-cosmos-x-map-with-memo-utf8', { ...atom, proposalId: uuid(9), memo: 'dépôt n° 42 — merci', x: cosmosX });
  put('transfer-cosmos-empty-memo', { ...atom, proposalId: uuid(10), memo: '', x: cosmosX });
  put('synthetic-x-map-key-sort-order', { ...xrp, proposalId: uuid(11), x: { b: '1', B: '2', a_1: '3', 'a.1': '4', a1: '5', A: '6', aB: '7', ab: '8' } });

  put('swap-kyberswap-evm', { ...head(12, { network: 'base', chainRef: '8453', asset: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '100000000', from: ME_EVM, to: ME_EVM, maxFee: '9000000000000000' }),
    evm: { nonce: 12, gasLimit: '450000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000' },
    swap: { provider: 'kyberswap', toAsset: 'native', minOut: '31250000000000000', router: core.KYBER_ROUTER, dataHash: SHA_A, approveGas: '60000' } });
  put('swap-jupiter-solana', { ...head(13, { network: 'solana', chainRef: N.solana.chainRef, asset: 'native', symbol: 'SOL', decimals: 9, amount: '500000000', from: ME_SOL, to: ME_SOL, maxFee: '2500000' }),
    sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 312345678, createAta: false, computeUnitLimit: 400000, computeUnitPrice: '25000' },
    swap: { provider: 'jupiter', toAsset: USDC_SOL, minOut: '74250000', router: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', dataHash: SHA_B, approveGas: '0' } });

  const bridge = (toNetwork: string, toDomain: number, extra: Record<string, unknown> = {}) => ({ provider: 'cctp', toNetwork, toDomain, maxFee: '15000', minFinalityThreshold: 1000, messenger: core.CCTP_TOKEN_MESSENGER, transmitter: core.CCTP_MESSAGE_TRANSMITTER, approveGas: '60000', ...extra });
  put('bridge-evm-to-evm', { ...head(14, { network: 'base', chainRef: '8453', asset: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '50000000', from: ME_EVM, to: ME_EVM, maxFee: '6000000000000000' }),
    evm: { nonce: 13, gasLimit: '300000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000' }, bridge: bridge('arbitrum', 3) });
  put('bridge-evm-to-solana-recipient', { ...head(15, { network: 'ethereum', chainRef: '1', asset: USDC_ETH, symbol: 'USDC', decimals: 6, amount: '50000000', from: ME_EVM, to: ME_EVM, maxFee: '6000000000000000' }),
    evm: { nonce: 14, gasLimit: '300000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000' }, bridge: bridge('solana', 5, { minFinalityThreshold: 2000, maxFee: '0', recipient: ME_SOL }) });
  put('bridge-solana-to-evm-recipient', { ...head(16, { network: 'solana', chainRef: N.solana.chainRef, asset: USDC_SOL, symbol: 'USDC', decimals: 6, amount: '50000000', from: ME_SOL, to: ME_SOL, maxFee: '6000000' }),
    sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 312345678, createAta: false, computeUnitLimit: 300000, computeUnitPrice: '10000' },
    bridge: { provider: 'cctp', toNetwork: 'base', toDomain: 6, maxFee: '15000', minFinalityThreshold: 1000, messenger: core.CCTP_SOL_TOKEN_MESSENGER_MINTER, transmitter: core.CCTP_SOL_MESSAGE_TRANSMITTER, approveGas: '0', recipient: ME_EVM } });

  const THOR_VAULT_KEY = 'thorpub1addwnpepqgwpafz6l99mkevlz7spaezgzcxy5t2896hgm7e6kytqrkmulex4wxjp8az';
  put('xswap-thorchain-evm-source', { ...head(17, { network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '20000000000000000', from: ME_EVM, to: '0x718f6C9df785BC4e323086De024CA822efbE8aB9', maxFee: '3000000000000000' }),
    evm: { nonce: 7, gasLimit: '80000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' },
    xswap: { provider: 'thorchain', toNetwork: 'bitcoin', toAsset: 'native', minOut: '54436', limit: '54436', memo: `=:b:${ME_BTC}:54436`, vault: '0x718f6C9df785BC4e323086De024CA822efbE8aB9', vaultPubKey: THOR_VAULT_KEY,
      router: core.THOR_ROUTERS.ethereum.address, expiry: T0 + 900, approveGas: '0' } });
  put('xswap-thorchain-btc-source', { ...head(18, { network: 'bitcoin', chainRef: N.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '60000', from: ME_BTC, to: 'bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx', maxFee: '2000' }),
    btc: { inputs: [{ txid: TXID_1, vout: 1, value: '100000' }], change: '39000', fee: '1000' },
    xswap: { provider: 'thorchain', toNetwork: 'ethereum', toAsset: 'native', minOut: '20981520000000000', limit: '2098152', memo: `=:e:${ME_EVM}:2098152`, vault: 'bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx', vaultPubKey: THOR_VAULT_KEY,
      router: '', expiry: T0 + 900, approveGas: '0' } });

  const hlPin = live.HL_BRIDGE_PINS.mainnet;
  put('venue-deposit-hyperliquid', { ...head(19, { network: 'arbitrum', chainRef: '42161', asset: hlPin.usdc, symbol: 'USDC', decimals: 6, amount: '250000000', from: ME_EVM, to: hlPin.bridge, maxFee: '260000000000000' }),
    evm: { nonce: 21, gasLimit: '120000', maxFeePerGas: '40000000', maxPriorityFeePerGas: '1000000' },
    venueDeposit: { venue: 'hyperliquid', venueNetwork: 'mainnet', route: live.HL_DEPOSIT_ROUTE, bridge: hlPin.bridge, minAmount: '6000000' } });

  const P = live.GMX_PINS, ETHM = live.GMX_MARKETS[1], COLL = live.GMX_MARKETS[0].collateral[0], ZERO = '0x0000000000000000000000000000000000000000';
  const gmxBase = (n: number, o: Record<string, unknown> = {}) => head(n, { network: 'arbitrum', chainRef: '42161', asset: COLL.token, symbol: 'USDC', decimals: 6, amount: '20000000', from: ME_EVM, to: P.exchangeRouter.address, maxFee: '260000000000000', ...o });
  const gmxEvm = { nonce: 7, gasLimit: '2000000', maxFeePerGas: '40000000', maxPriorityFeePerGas: '1000000' };
  const gmxSection = (o: Record<string, unknown> = {}) => ({ venue: 'gmx-v2', action: 'increase', authorizationId: uuid(0xaa), exchangeRouter: P.exchangeRouter.address, router: P.router.address, orderVault: P.orderVault.address,
    market: ETHM.market, indexToken: ETHM.indexToken, collateralToken: COLL.token, orderType: 'MarketIncrease', isLong: true, sizeDeltaUsd: live.gmxUsdToRaw('60').toString(), acceptablePrice: live.gmxPriceToRaw('2080.5', 18).toString(),
    triggerPrice: '0', executionFee: '170000000000000', approveGas: '60000', ...o });
  put('gmx-increase-long', { ...gmxBase(20), evm: gmxEvm, gmx: gmxSection() });
  put('gmx-decrease-short', { ...gmxBase(21, { amount: '0' }), evm: gmxEvm, gmx: gmxSection({ action: 'decrease', orderType: 'MarketDecrease', isLong: false, approveGas: '0', acceptablePrice: live.gmxPriceToRaw('2055', 18).toString() }) });
  put('gmx-cancel-with-order-key', { ...gmxBase(22, { asset: 'native', symbol: 'ETH', decimals: 18, amount: '0', maxFee: '90000000000000' }), evm: gmxEvm,
    gmx: gmxSection({ action: 'cancel', orderType: 'None', market: ZERO, indexToken: ZERO, collateralToken: ZERO, isLong: false, sizeDeltaUsd: '0', acceptablePrice: '0', executionFee: '0', approveGas: '0', orderKey: `0x${'ab'.repeat(32)}` }) });
}

// ------------------------------------------------------------------------------------------------------------------ 2. NFT intents
{
  const S = 'packages/core/src/nft-intent.ts';
  const nft = (n: number, o: Record<string, unknown>) => ({ v: 1, kind: 'nft-transfer', proposalId: uuid(0x100 + n), keyId: KEY_ID, ...o, createdAt: T0, expiresAt: T0 + 120, policyVersion: 4, nftPolicyVersion: 2 });
  const put = (name: string, object: Record<string, unknown>) => add('SPW-NFT-INTENT-v1.json', { name, domain: core.NFT_INTENT_DOMAIN, source: `${S} nftCanonicalBytes / nftIntentHash`, object, bytes: core.nftCanonicalBytes(object), hash: core.nftIntentHash(object) });
  const CONTRACT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', MINT = 'DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4x', COLLECTION = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w', RULESET = 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9';
  const solNft = (o: Record<string, unknown> = {}) => ({ recentBlockhash: BLOCKHASH, lastValidBlockHeight: 312345678, computeUnitLimit: 120000, computeUnitPrice: '5000', ...o });
  put('erc721', { ...nft(1, { network: 'ethereum', chainRef: '1', standard: 'erc721', asset: CONTRACT, tokenId: '8520', quantity: '1', program: CONTRACT, from: ME_EVM, to: DEST_EVM, maxFee: '3000000000000000' }),
    evm: { nonce: 31, gasLimit: '120000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } });
  put('erc1155-quantity-5-large-token-id', { ...nft(2, { network: 'base', chainRef: '8453', standard: 'erc1155', asset: '0x495f947276749Ce646f68AC8c248420045cb7b5e', tokenId: '115792089237316195423570985008687907853269984665640564039457584007913129639935', quantity: '5',
    program: '0x495f947276749Ce646f68AC8c248420045cb7b5e', from: ME_EVM, to: DEST_EVM, maxFee: '3000000000000000' }), evm: { nonce: 32, gasLimit: '150000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '0' } });
  const solHead = (n: number, standard: string, program: string, asset = MINT) => nft(n, { network: 'solana', chainRef: N.solana.chainRef, standard, asset, quantity: '1', program, from: ME_SOL, to: DEST_SOL, maxFee: '2100000' });
  put('solana-spl-token-2022-create-ata', { ...solHead(3, 'spl-token-2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), sol: solNft({ tokenProgram: 'token2022', createAta: true }) });
  put('solana-spl-token-2022-no-ata', { ...solHead(4, 'spl-token-2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), sol: solNft({ tokenProgram: 'token2022', createAta: false }) });
  put('solana-metaplex-token-metadata', { ...solHead(5, 'metaplex-token-metadata', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'), sol: solNft({ tokenProgram: 'token' }) });
  put('solana-metaplex-pnft-with-rule-set', { ...solHead(6, 'metaplex-pnft', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'), sol: solNft({ tokenProgram: 'token', ruleSet: RULESET }) });
  put('solana-metaplex-pnft-no-rule-set', { ...solHead(7, 'metaplex-pnft', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'), sol: solNft({ tokenProgram: 'token' }) });
  put('solana-metaplex-core-in-collection', { ...solHead(8, 'metaplex-core', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), sol: solNft({ collection: COLLECTION }) });
  put('solana-metaplex-core-no-collection', { ...solHead(9, 'metaplex-core', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), sol: solNft() });

  const allow = (n: number, o: Record<string, unknown>) => ({ v: 1, kind: 'nft-allow', requestId: uuid(0x200 + n), keyId: KEY_ID, ...o, createdAt: T0, expiresAt: T0 + 120, policyVersion: 4 });
  const putAllow = (name: string, object: Record<string, unknown>) => add('SPW-NFT-ALLOW-v1.json', { name, domain: core.NFT_ALLOW_DOMAIN, source: `${S} nftAllowBytes / nftAllowHash`, object, bytes: core.nftAllowBytes(object), hash: core.nftAllowHash(object) });
  putAllow('add-evm', allow(1, { network: 'ethereum', action: 'add', address: DEST_EVM }));
  putAllow('remove-evm', allow(2, { network: 'ethereum', action: 'remove', address: DEST_EVM }));
  putAllow('add-solana', allow(3, { network: 'solana', action: 'add', address: DEST_SOL }));

  const lock = (n: number, o: Record<string, unknown>) => ({ v: 1, kind: 'utxo-locks', requestId: uuid(0x300 + n), keyId: KEY_ID, network: 'bitcoin', ...o, createdAt: T0, expiresAt: T0 + 120, policyVersion: 4 });
  const putLock = (name: string, object: Record<string, unknown>) => add('SPW-UTXO-LOCKS-v1.json', { name, domain: core.UTXO_LOCK_DOMAIN, source: `${S} utxoLockBytes / utxoLockHash`, object, bytes: core.utxoLockBytes(object), hash: core.utxoLockHash(object) });
  putLock('lock-one-owner', lock(1, { action: 'lock', reason: 'owner', outpoints: [{ txid: TXID_1, vout: 0 }] }));
  putLock('lock-three-ord-order-kept', lock(2, { action: 'lock', reason: 'ord', outpoints: [{ txid: TXID_2, vout: 4294967295 }, { txid: TXID_1, vout: 3 }, { txid: TXID_1, vout: 1 }] }));
  putLock('unlock-heuristic', lock(3, { action: 'unlock', reason: 'heuristic', outpoints: [{ txid: TXID_1, vout: 0 }, { txid: TXID_2, vout: 1 }] }));
}

// ------------------------------------------------------------------------------------------------------------------ 3. SPW-MANDATE-v1 (spot agent mandate)
{
  const put = (name: string, object: Record<string, unknown>) => add('SPW-MANDATE-v1.json', { name, domain: 'SPW-MANDATE-v1', source: 'packages/core/src/mandate.ts mandateBytes / mandateHash', object, bytes: core.mandateBytes(object), hash: core.mandateHash(object) });
  const WETH = '0x4200000000000000000000000000000000000006';
  put('spot-mandate-base-two-assets', { v: 1, mandateId: uuid(0x400), keyId: KEY_ID, vaultIndex: 1, vault: VAULT_EVM, network: 'base', provider: 'kyberswap', assets: ['native', USDC_BASE],
    maxOrder: { native: '50000000000000000', [USDC_BASE]: '100000000' }, maxDaily: { native: '200000000000000000', [USDC_BASE]: '400000000' }, maxOrdersPerDay: 24, maxSlippageBps: 100,
    createdAt: T0, expiresAt: T0 + 30 * 86400, strategySha256: SHA_A, label: 'DCA hebdomadaire' });
  // lists and maps deliberately unsorted; one asset (WETH) can be bought but not sold: it has no limit
  put('spot-mandate-unsorted-three-assets-one-buy-only', { v: 1, mandateId: uuid(0x401), keyId: KEY_ID, vaultIndex: 100000, vault: VAULT_EVM, network: 'base', provider: 'kyberswap', assets: ['native', WETH, USDC_BASE],
    maxOrder: { native: '50000000000000000', [USDC_BASE]: '100000000' }, maxDaily: { [USDC_BASE]: '400000000', native: '200000000000000000' }, maxOrdersPerDay: 500, maxSlippageBps: 10,
    createdAt: T0, expiresAt: T0 + 90 * 86400, strategySha256: SHA_B, label: 'Stratégie « momentum » n° 2' });
}

// ------------------------------------------------------------------------------------------------------------------ 4. derivatives (venue) objects
const venueAuth = { v: 1, authorizationId: uuid(0x500), keyId: KEY_ID, venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, agentAddress: AGENT_LC, agentName: 'spw-live', mode: 'MANUAL_LIVE',
  policy: { allowedInstruments: ['hyperliquid:ETH', 'hyperliquid:BTC', 'hyperliquid:SOL'], maxLeverage: 5, maxOrderNotional: '2500.50', maxPositionNotional: '10000', maxGrossExposure: '25000.000', maxOrdersPerDay: 200, maxPriceDeviationBps: 300 },
  createdAt: T0, expiresAt: T0 + 30 * 86400, approveNonce: T0_MS + 1234, ackSha256: SHA_C };
{
  const C = 'packages/derivatives/src/live/canonical.ts';
  const putAuth = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-AUTH-v1.json', { name, domain: 'SPW-VENUE-AUTH-v1', source: `${C} venueAuthorizationBytes / venueAuthorizationHash`, object, bytes: live.venueAuthorizationBytes(object), hash: live.venueAuthorizationHash(object) });
  putAuth('authorization-mainnet-unsorted-instruments-noncanonical-decimals', venueAuth);
  putAuth('authorization-testnet-one-instrument', { ...venueAuth, authorizationId: uuid(0x501), network: 'testnet', agentName: 'a_B-9', policy: { allowedInstruments: ['hyperliquid:BTC'], maxLeverage: 20, maxOrderNotional: '0.5', maxPositionNotional: '100', maxGrossExposure: '100', maxOrdersPerDay: 1, maxPriceDeviationBps: 10 } });

  const orderHead = (n: number) => ({ v: 1, authorizationId: uuid(0x500), venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, nonce: T0_MS + n, expiresAt: T0_MS + n + 90_000 });
  const putOrder = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-ORDER-v1.json', { name, domain: 'SPW-VENUE-ORDER-v1', source: `${C} venueOrderBytes / venueOrderHash`, object, bytes: live.venueOrderBytes(object), hash: live.venueOrderHash(object) });
  const order = (n: number, o: Record<string, unknown>) => ({ ...orderHead(n), kind: 'order', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.0100', price: '68500.0', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `0x${n.toString(16).padStart(32, '0')}`, ...o });
  putOrder('limit-buy-gtc-noncanonical-decimals', order(1, {}));
  putOrder('market-as-limit-ioc-sell', order(2, { side: 'sell', size: '0.25', price: '66000', tif: 'ioc' }));
  putOrder('post-only-alo', order(3, { instrument: 'hyperliquid:ETH', size: '1.5', price: '2050.25', tif: 'alo' }));
  putOrder('stop-market-reduce-only-with-trigger', order(4, { side: 'sell', type: 'stop_market', size: '0.01', price: '61000', triggerPrice: '64000.00', reduceOnly: true, tif: 'ioc' }));
  putOrder('take-profit-limit-reduce-only', order(5, { side: 'sell', type: 'take_profit_limit', size: '0.01', price: '74900', triggerPrice: '75000', reduceOnly: true }));
  putOrder('stop-limit-buy-small-decimals', order(6, { instrument: 'hyperliquid:kPEPE', type: 'stop_limit', size: '150000', price: '0.0000123400', triggerPrice: '0.00001230', tif: 'gtc' }));

  const putLev = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-LEVERAGE-v1.json', { name, domain: 'SPW-VENUE-LEVERAGE-v1', source: `${C} venueLeverageBytes / venueLeverageHash`, object, bytes: live.venueLeverageBytes(object), hash: live.venueLeverageHash(object) });
  putLev('leverage-cross-5', { ...orderHead(10), kind: 'leverage', instrument: 'hyperliquid:BTC', leverage: 5, marginMode: 'cross' });
  putLev('leverage-isolated-20-testnet', { ...orderHead(11), network: 'testnet', kind: 'leverage', instrument: 'hyperliquid:ETH', leverage: 20, marginMode: 'isolated' });

  const putW = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-WITHDRAW-v1.json', { name, domain: 'SPW-VENUE-WITHDRAW-v1', source: 'packages/derivatives/src/live/collateral.ts venueWithdrawalBytes / venueWithdrawalHash', object, bytes: live.venueWithdrawalBytes(object), hash: live.venueWithdrawalHash(object) });
  const w = { v: 1, withdrawalId: uuid(0x520), keyId: KEY_ID, venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, destination: ME_EVM_LC, amount: '150.25', fee: '1', time: T0_MS + 500, createdAt: T0, expiresAt: T0 + 120 };
  putW('withdraw-150.25', w);
  putW('withdraw-noncanonical-decimals', { ...w, withdrawalId: uuid(0x521), amount: '1000.500000', fee: '1.0' });

  const mandate = { v: 1, mandateId: uuid(0x530), authorizationId: uuid(0x500), keyId: KEY_ID, venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, agentAddress: AGENT_LC, strategySha256: SHA_A, agentId: 'agent:trend-01',
    instruments: [{ instrument: 'hyperliquid:ETH', maxLeverage: 3, maxPositionNotional: '4000.0' }, { instrument: 'hyperliquid:BTC', maxLeverage: 5, maxPositionNotional: '8000' }],
    maxOrderNotional: '2000', maxGrossExposure: '12000.00', maxOrdersPerDay: 120, maxOrdersPerHour: 30, maxDailyTurnover: '50000', floorEquity: '2500.5', maxPriceDeviationBps: 150, createdAt: T0, expiresAt: T0 + 14 * 86400, ackSha256: SHA_C };
  const putM = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-MANDATE-v1.json', { name, domain: 'SPW-VENUE-MANDATE-v1', source: 'packages/derivatives/src/live/mandate.ts venueMandateBytes / venueMandateHash', object, bytes: live.venueMandateBytes(object), hash: live.venueMandateHash(object) });
  putM('derivative-mandate-two-instruments-unsorted', mandate);
  putM('derivative-mandate-one-instrument', { ...mandate, mandateId: uuid(0x531), instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 1, maxPositionNotional: '500' }], maxOrderNotional: '500', maxGrossExposure: '500', maxDailyTurnover: '5000', floorEquity: '100' });

  const quoting = { v: 1, mandateId: uuid(0x540), authorizationId: uuid(0x500), keyId: KEY_ID, venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, agentAddress: AGENT_LC, strategySha256: SHA_B, agentId: 'agent:mm-01',
    instruments: [{ instrument: 'hyperliquid:ETH', maxLeverage: 3, maxQuoteNotional: '250.0', maxRestingPerSide: 3, maxRestingNotionalPerSide: '750', maxInventoryNotional: '2000.00' },
      { instrument: 'hyperliquid:BTC', maxLeverage: 3, maxQuoteNotional: '250', maxRestingPerSide: 3, maxRestingNotionalPerSide: '750', maxInventoryNotional: '2000' }],
    maxRestingTotal: 12, maxGrossExposure: '6000', minHalfSpreadBps: 2, maxDistanceBps: 200, maxReduceDeviationBps: 100, floorEquity: '1500',
    rate: { burstActions: 10, actionsPerMinute: 30, ordersPerHour: 1800, ordersPerDay: 10000, dailyTurnover: '500000.0' }, deadManSeconds: 30, createdAt: T0, expiresAt: T0 + 7 * 86400, ackSha256: SHA_C };
  const putQ = (name: string, object: Record<string, unknown>) => add('SPW-VENUE-QUOTING-MANDATE-v1.json', { name, domain: live.QUOTING_MANDATE_DOMAIN, source: 'packages/derivatives/src/live/quoting.ts venueQuotingMandateBytes / venueQuotingMandateHash', object, bytes: live.venueQuotingMandateBytes(object), hash: live.venueQuotingMandateHash(object) });
  putQ('quoting-mandate-two-instruments-unsorted', quoting);
  putQ('quoting-mandate-one-instrument', { ...quoting, mandateId: uuid(0x541), instruments: [quoting.instruments[1]], maxRestingTotal: 6 });

  const P = live.GMX_PINS, markets = live.GMX_MARKETS.map((m: { market: string }) => m.market);
  const gmxAuth = { v: 1, authorizationId: uuid(0xaa), keyId: KEY_ID, venue: 'gmx', network: 'arbitrum', account: ME_EVM_LC, mode: 'MANUAL_LIVE', contracts: P.id, exchangeRouter: P.exchangeRouter.address,
    policy: { allowedMarkets: [markets[1], markets[0]], maxLeverage: 5, maxOrderSizeUsd: '500.00', maxOrdersPerDay: 20, maxPriceDeviationBps: 150, maxExecutionFeeWei: '1000000000000000' }, createdAt: T0, expiresAt: T0 + 30 * 86400, ackSha256: SHA_C };
  const putG = (name: string, object: Record<string, unknown>) => add('SPW-GMX-AUTH-v1.json', { name, domain: 'SPW-GMX-AUTH-v1', source: 'packages/derivatives/src/live/gmx.ts gmxAuthorizationBytes / gmxAuthorizationHash', object, bytes: live.gmxAuthorizationBytes(object), hash: live.gmxAuthorizationHash(object) });
  putG('gmx-authorization-two-markets-mixed-case-sort', gmxAuth);
  putG('gmx-authorization-all-pinned-markets-reversed', { ...gmxAuth, authorizationId: uuid(0xab), policy: { ...gmxAuth.policy, allowedMarkets: [...markets].reverse(), maxOrderSizeUsd: '1234.5' } });
}

// ------------------------------------------------------------------------------------------------------------------ 5. CCTP second legs (line-joined) and the Solana token account
{
  const MSG_HASH = `0x${'5e'.repeat(32)}`, EVENT_ACCOUNT = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmpgBgs55bnpH';
  const gas = { nonce: 42, gasLimit: '250000', maxFeePerGas: '30000000000', maxPriorityFeePerGas: '1000000000' };
  const sol = { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 312345678, computeUnitLimit: 250000, computeUnitPrice: '10000' };
  {
    const bytes = core.cctpMintRetryBytes(uuid(0x600), MSG_HASH, gas);
    add('SPW-BRIDGE-MINT-v1.json', { name: 'mint-retry-evm', domain: 'SPW-BRIDGE-MINT-v1', source: 'packages/core/src/cctp.ts cctpMintRetryBytes (hash = SHA-256 of those bytes, taken by the caller)', object: { proposalId: uuid(0x600), messageHash: MSG_HASH, gas }, bytes, hash: sha256(bytes) });
    const g0 = { nonce: 0, gasLimit: '160000', maxFeePerGas: '1', maxPriorityFeePerGas: '0' }, b0 = core.cctpMintRetryBytes(uuid(0x601), MSG_HASH, g0);
    add('SPW-BRIDGE-MINT-v1.json', { name: 'mint-retry-evm-nonce-0', domain: 'SPW-BRIDGE-MINT-v1', source: 'packages/core/src/cctp.ts cctpMintRetryBytes (hash = SHA-256 of those bytes, taken by the caller)', object: { proposalId: uuid(0x601), messageHash: MSG_HASH, gas: g0 }, bytes: b0, hash: sha256(b0) });
  }
  {
    const bytes = core.cctpSolMintRetryBytes(uuid(0x610), MSG_HASH, sol);
    add('SPW-BRIDGE-MINT-SOL-v1.json', { name: 'mint-retry-solana', domain: 'SPW-BRIDGE-MINT-SOL-v1', source: 'packages/core/src/cctp-sol-tx.ts cctpSolMintRetryBytes (hash = SHA-256 of those bytes, taken by the caller)', object: { proposalId: uuid(0x610), messageHash: MSG_HASH, sol }, bytes, hash: sha256(bytes) });
    // extra members of `sol` (the API's budget object may carry createAta for other uses) are NOT part of the bytes
    const sol2 = { ...sol, computeUnitLimit: 400000, computeUnitPrice: '0' }, b2 = core.cctpSolMintRetryBytes(uuid(0x611), MSG_HASH, sol2);
    add('SPW-BRIDGE-MINT-SOL-v1.json', { name: 'mint-retry-solana-zero-price', domain: 'SPW-BRIDGE-MINT-SOL-v1', source: 'packages/core/src/cctp-sol-tx.ts cctpSolMintRetryBytes (hash = SHA-256 of those bytes, taken by the caller)', object: { proposalId: uuid(0x611), messageHash: MSG_HASH, sol: sol2 }, bytes: b2, hash: sha256(b2) });
  }
  {
    const bytes = core.cctpSolReclaimBytes(uuid(0x620), EVENT_ACCOUNT, MSG_HASH, sol);
    add('SPW-BRIDGE-RECLAIM-v1.json', { name: 'reclaim-event-account', domain: 'SPW-BRIDGE-RECLAIM-v1', source: 'packages/core/src/cctp-sol-tx.ts cctpSolReclaimBytes (hash = SHA-256 of those bytes, taken by the caller)', object: { proposalId: uuid(0x620), eventAccount: EVENT_ACCOUNT, messageHash: MSG_HASH, sol }, bytes, hash: sha256(bytes) });
  }
  {
    const req = { v: 1, requestId: uuid(0x630), keyId: KEY_ID, network: 'solana', chainRef: N.solana.chainRef, owner: ME_SOL, mint: USDC_SOL, tokenAccount: core.cctpSolTokenAccount(ME_SOL), maxFee: '2100000', createdAt: T0, expiresAt: T0 + 45, policyVersion: 4, sol };
    const hash = core.solTokenAccountHash(req);
    // the real function returns the hash only. The bytes below are rebuilt with the REAL framing (canonicalEncode) from the field
    // list of the README; `add` asserts that their SHA-256 is the hash of the real function.
    const bytes = live.canonicalEncode('SPW-SOL-TOKEN-ACCOUNT-v1', [['v', '1'], ['requestId', req.requestId], ['keyId', req.keyId], ['network', req.network], ['chainRef', req.chainRef], ['owner', req.owner], ['mint', req.mint], ['tokenAccount', req.tokenAccount],
      ['maxFee', req.maxFee], ['createdAt', String(req.createdAt)], ['expiresAt', String(req.expiresAt)], ['policyVersion', String(req.policyVersion)],
      ['sol.recentBlockhash', sol.recentBlockhash], ['sol.lastValidBlockHeight', String(sol.lastValidBlockHeight)], ['sol.computeUnitLimit', String(sol.computeUnitLimit)], ['sol.computeUnitPrice', sol.computeUnitPrice]]);
    add('SPW-SOL-TOKEN-ACCOUNT-v1.json', { name: 'open-usdc-token-account', domain: 'SPW-SOL-TOKEN-ACCOUNT-v1', source: 'packages/core/src/cctp-sol-tx.ts solTokenAccountHash (hash only; canonicalHex rebuilt with canonicalEncode and asserted against it)', object: req, bytes, hash });
  }
}

// ------------------------------------------------------------------------------------------------------------------ 6. API-side objects
// 6a. JSON-canonical intents: SHA-256 of `${domain}\n${JSON with keys sorted at every depth}` (services/api/src/derivatives/exec.ts
// `canonicalIntentHash`; its `stableJson` is not exported). canonicalHex = `${domain}\n` + the exported `canonicalJson` of
// trading-api/key-model.ts, asserted against the real hash by `add`.
const jsonBytes = (domain: string, o: unknown): Buffer => utf8(`${domain}\n${keyModel.canonicalJson(o)}`);
const stamp = (n: number) => ({ nonce: uuid(0x700 + n), createdAt: T0_MS, expiresAt: T0_MS + 300_000 });
{
  const R = 'services/api/src/risk/service.ts', E = 'services/api/src/derivatives/exec.ts canonicalIntentHash';
  const putJ = (file: string, domain: string, source: string, name: string, object: unknown) => add(file, { name, domain, source, object, bytes: jsonBytes(domain, object), hash: exec.canonicalIntentHash(domain, object) });

  const limits = trading.RiskLimitsSchema.parse({ allowedVenues: ['hyperliquid', 'gmx'], allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxPositionNotional: { per: { 'hyperliquid:BTC': '20000', 'hyperliquid:ETH': '10000.50' }, default: '5000' },
    maxOrderLeverage: '5', maxAccountLeverage: '3', maxDailyLoss: '500', maxTotalLoss: '2000', maxDrawdownBps: '1500', maxGrossExposure: '40000', maxNetExposure: '25000', maxOrdersPerMinute: 10, maxOrdersPerHour: 100, maxOrdersPerDay: 500,
    maxOrderNotional: '5000', minPriceSources: 2 });
  putJ('SPW-RISK-LIMITS-INTENT-v1.json', 'SPW-RISK-LIMITS-INTENT-v1', `${R} prepareLimits (risk/passkey.ts prepareIntent → ${E})`, 'limits-live-loosened-two',
    { v: 1, kind: 'limits', mode: 'live', limits, loosened: ['maxDailyLoss', 'maxGrossExposure'], ...stamp(1) });
  putJ('SPW-RISK-LIMITS-INTENT-v1.json', 'SPW-RISK-LIMITS-INTENT-v1', `${R} prepareLimits (risk/passkey.ts prepareIntent → ${E})`, 'limits-paper-minimal',
    { v: 1, kind: 'limits', mode: 'paper', limits: trading.RiskLimitsSchema.parse({ maxDailyLoss: '100' }), loosened: ['maxDailyLoss'], ...stamp(2) });

  const SW = `${R} prepareRelease (risk/passkey.ts prepareIntent → ${E})`;
  putJ('SPW-RISK-SWITCH-INTENT-v1.json', 'SPW-RISK-SWITCH-INTENT-v1', SW, 'release-kill-switch-engaged-by-owner', { v: 1, kind: 'kill_switch', engagedAt: T0_MS - 60_000, engagedBy: 'owner:owner', reason: 'arrêt d\'urgence / "test" — \\ fin', ...stamp(3) });
  putJ('SPW-RISK-SWITCH-INTENT-v1.json', 'SPW-RISK-SWITCH-INTENT-v1', SW, 'release-read-only-nulls', { v: 1, kind: 'read_only', engagedAt: T0_MS - 60_000, engagedBy: null, reason: null, ...stamp(4) });
  putJ('SPW-RISK-SWITCH-INTENT-v1.json', 'SPW-RISK-SWITCH-INTENT-v1', SW, 'release-kill-switch-engaged-by-api-key-control-chars', { v: 1, kind: 'kill_switch', engagedAt: T0_MS - 1, engagedBy: 'api_key:spk_0123456789ab', reason: 'line 1\nline 2\ttab \u0001 \u007f é 😀 </script>', ...stamp(5) });

  const auto = (o: Record<string, boolean>) => riskService.AutoKillSchema.parse(o);
  const AU = `${R} prepareAutoKill (risk/passkey.ts prepareIntent → ${E})`;
  putJ('SPW-RISK-AUTO-INTENT-v1.json', 'SPW-RISK-AUTO-INTENT-v1', AU, 'auto-kill-switch-off-total-loss', { v: 1, kind: 'auto', auto: auto({ totalLoss: false, drawdown: true, dailyLoss: false }), loosened: ['totalLoss'], ...stamp(6) });
  putJ('SPW-RISK-AUTO-INTENT-v1.json', 'SPW-RISK-AUTO-INTENT-v1', AU, 'auto-kill-switch-all-off', { v: 1, kind: 'auto', auto: auto({ totalLoss: false, drawdown: false, dailyLoss: false }), loosened: ['totalLoss', 'drawdown', 'dailyLoss'], ...stamp(7) });

  // SPW-RISK-INTENT-v1 (per venue account): exec.ts riskIntentHash
  const policy = deriv.RiskPolicySchema.parse({ mode: 'MANUAL_LIVE', allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], halt: null, maxDataAgeMs: 5000, maxDeviationBps: '300', maxMarkIndexBps: '100', maxLeverage: '5',
    maxOrderNotional: '2500.5', maxGrossExposure: '25000', maxPositionNotional: '10000', minFreeCollateral: '50', minLiquidationDistanceBps: '500', maxDailyLoss: '1250', maxTotalLoss: '5000', maxOrdersPerMinute: 10, maxOrdersPerDay: 200 });
  const riskHead = { v: 1, accountId: uuid(0x710), venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC, authorizationId: uuid(0x500) };
  const putR = (name: string, object: unknown) => add('SPW-RISK-INTENT-v1.json', { name, domain: 'SPW-RISK-INTENT-v1', source: 'services/api/src/derivatives/exec.ts riskIntentHash (prepareRisk)', object, bytes: jsonBytes('SPW-RISK-INTENT-v1', object), hash: exec.riskIntentHash(object) });
  putR('policy-loosened', { ...riskHead, kind: 'policy', policy, loosened: ['maxOrderNotional', 'maxDailyLoss'], subject: null, ...stamp(8) });
  putR('resume-after-halt', { ...riskHead, kind: 'resume', policy: null, loosened: [], subject: 'daily loss limit reached (1250 USDC)', ...stamp(9) });
  putR('rebase-divergence', { ...riskHead, kind: 'rebase', policy: null, loosened: [], subject: 'position hyperliquid:BTC: venue 0.02, wallet 0.01', ...stamp(10) });
  putR('rebase-no-divergence-null-subject', { ...riskHead, kind: 'rebase', policy: null, loosened: [], subject: null, ...stamp(11) });

  const putGR = (name: string, object: unknown) => add('SPW-GMX-RISK-INTENT-v1.json', { name, domain: 'SPW-GMX-RISK-INTENT-v1', source: 'services/api/src/derivatives/gmx-exec.ts gmxRiskIntentHash', object, bytes: jsonBytes('SPW-GMX-RISK-INTENT-v1', object), hash: gmxExec.gmxRiskIntentHash(object) });
  putGR('gmx-limits-loosened', { v: 1, kind: 'gmx-limits', authorizationId: uuid(0xaa), limits: { maxDailyLoss: '150', maxTotalLoss: '600.5' }, loosened: ['maxDailyLoss', 'maxTotalLoss'], subject: null, ...stamp(12) });
  putGR('gmx-resume', { v: 1, kind: 'gmx-resume', authorizationId: uuid(0xaa), limits: null, loosened: [], subject: 'total loss limit reached', ...stamp(13) });

  // SPW-TRADING-MANDATE-APPROVAL-v1: built further down, once the trading mandate and its compiled shapes have hashes
}

// 6b. SPW-APIKEY-INTENT-v1: trading-api/key-model.ts canonicalJson + intentChallenge
{
  const S = 'services/api/src/trading-api/key-model.ts canonicalJson + intentChallenge (services/api/src/trading-api/keys.ts storeIntent)', D = 'SPW-APIKEY-INTENT-v1';
  const put = (name: string, object: unknown) => { const canonical = keyModel.canonicalJson(object); add('SPW-APIKEY-INTENT-v1.json', { name, domain: D, source: S, object, bytes: utf8(`${D}\n${canonical}`), hash: keyModel.intentChallenge(canonical) }); };
  const base = (n: number, action: string) => ({ v: 1, action, intentId: uuid(0x800 + n), origin: 'https://wallet.example.test', preparedAt: '2026-11-18T12:34:56.789Z' });
  const restrictions = apiSpec.RestrictionsSchema.parse({ networks: ['arbitrum', 'mainnet'], venues: ['gmx', 'hyperliquid'], instruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], ipAllow: ['192.0.2.0/24', '2001:db8::1'] });
  put('create-read-only-key-defaults', { ...base(1, 'create'), key: { id: 'spk_0123456789ab', name: 'Tableau de bord (lecture)', scopes: ['markets:read', 'orders:read', 'wallet:read'], expiresAt: '2027-02-16T12:34:56.789Z',
    limits: apiSpec.LimitsSchema.parse({}), restrictions: apiSpec.RestrictionsSchema.parse({}), rateLimitPerMin: 120, mandateId: null } });
  put('create-trading-key-limits-restrictions-mandate', { ...base(2, 'create'), key: { id: 'spk_ba9876543210', name: 'bot / "alpha" n° 1', scopes: ['orders:cancel', 'orders:execute', 'orders:prepare', 'orders:read'], expiresAt: '2026-12-18T12:34:56.789Z',
    limits: { maxOrderNotionalUsd: 2500.5, maxDailyNotionalUsd: 100000000 }, restrictions, rateLimitPerMin: 600, mandateId: uuid(0x900) } });
  put('rotate', { ...base(3, 'rotate'), keyId: 'spk_0123456789ab', newKeyId: 'spk_00ff00ff00ff' });
  put('update-widening-scopes-and-limits', { ...base(4, 'update'), keyId: 'spk_0123456789ab', changes: { scopes: ['orders:execute', 'orders:read'], limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: 0.1 }, rateLimitPerMin: 300 }, widening: ['scopes', 'limits', 'rateLimitPerMin'] });
  put('update-bind-mandate', { ...base(5, 'update'), keyId: 'spk_0123456789ab', changes: { mandateId: uuid(0x900) }, widening: ['mandateId'] });
}

// 6c. trading layer: SPW-TRADING-MANDATE-v1, SPW-QUOTING-SECTION-v1, SPW-ORDER-INTENT-v1, SPW-ORDER-BODY-v1, and the approval intent
{
  const TM = 'packages/trading/src/mandate/trading-mandate.ts tradingMandateBytes / tradingMandateHash';
  const putTM = (name: string, object: Record<string, unknown>) => { add('SPW-TRADING-MANDATE-v1.json', { name, domain: trading.TRADING_MANDATE_DOMAIN, source: TM, object, bytes: trading.tradingMandateBytes(object), hash: trading.tradingMandateHash(object) }); return trading.tradingMandateHashHex(object) as string; };
  const liveAgent = { v: 1, mandateId: uuid(0x900), principal: { kind: 'agent', id: 'agent:trend-01' },
    accounts: [{ kind: 'venue_account', venue: 'hyperliquid', network: 'mainnet', account: ME_EVM_LC }], venues: ['hyperliquid'], networks: ['mainnet'], instruments: ['hyperliquid:ETH', 'hyperliquid:BTC'], marketKinds: ['perp'],
    orderTypes: ['market', 'limit', 'stop', 'take_profit'], maxCapitalUsd: '5000.00', maxOrderNotionalUsd: '2000', maxPositionNotionalUsd: '8000', maxLeverage: '3', maxDailyLossUsd: '250.50', floorEquityUsd: '2500',
    createdAt: T0, notBefore: T0, notAfter: T0 + 14 * 86400, frequency: { perMinute: 5, perHour: 30, perDay: 120 }, maxSlippageBps: 150, maxFeeUsd: '5.0',
    stopConditions: [{ kind: 'signer_unreachable_gte', ms: 120000 }, { kind: 'loss_gte', usd: '1000.0' }, { kind: 'drawdown_gte', bps: 1500 }, { kind: 'data_stale_gte', ms: 30000 }, { kind: 'consecutive_rejects_gte', count: 5 }],
    mode: 'live', strategySha256: SHA_A, label: 'Tendance BTC/ETH' };
  const hLive = putTM('live-agent-perp-all-stop-conditions-unsorted', liveAgent);
  const paperKey = { ...liveAgent, mandateId: uuid(0x901), principal: { kind: 'api_key', id: 'spk_0123456789ab' },
    accounts: [{ kind: 'venue_account', venue: 'hyperliquid', network: 'testnet', account: 'paper-account-1' }, { kind: 'vault', vaultIndex: 2, address: VAULT_EVM, network: 'base' }], venues: ['kyberswap', 'hyperliquid'], networks: ['testnet', 'base'],
    instruments: ['kyberswap:*', 'hyperliquid:*'], marketKinds: ['spot', 'perp'], orderTypes: ['limit', 'market'], floorEquityUsd: '0.00', stopConditions: [], mode: 'paper', strategySha256: null, label: 'clé API — papier' };
  putTM('paper-api-key-two-accounts-wildcards-null-strategy', paperKey);
  const mmAgent = { ...liveAgent, mandateId: uuid(0x902), principal: { kind: 'agent', id: 'agent:mm-01' }, orderTypes: ['limit'], maxOrderNotionalUsd: '250', maxPositionNotionalUsd: '2000', maxCapitalUsd: '2000', notAfter: T0 + 7 * 86400, strategySha256: SHA_B, label: 'Tenue de marché' };
  const hMm = putTM('live-agent-market-making', mmAgent);

  const QS = 'packages/trading/src/mandate/quoting-mandate.ts quotingSectionBytes / quotingSectionHashHex';
  const putQS = (name: string, object: Record<string, unknown>) => { add('SPW-QUOTING-SECTION-v1.json', { name, domain: trading.QUOTING_SECTION_DOMAIN, source: QS, object, bytes: trading.quotingSectionBytes(object), hash: trading.quotingSectionHashHex(object) }); return trading.quotingSectionHashHex(object) as string; };
  const section = { v: 1, mandateId: uuid(0x902), tradingMandateHash: hMm,
    terms: { levelsPerSide: 3, minHalfSpreadBps: 2, maxDistanceBps: 200, burstActions: 10, actionsPerMinute: 30, quotesPerHour: 1800, quotesPerDay: 10000, dailyTurnoverUsd: '500000.00', deadManSeconds: 30 },
    engine: { policy: 'spread_inventory', configSha256: SHA_C, quoteSizeUsd: '100.0', softInventoryUsd: '600', hardInventoryUsd: '1200', maxSessionMinutes: 480, hours: { startUtcMinute: 780, endUtcMinute: 60 }, maxSessionLossUsd: '75.50', stopBeforeExpiryS: 600,
      breakers: { vol_spike: 'pull', data_stale: 'pull', drawdown_session: 'flatten', kill_switch: 'halt' }, flattenOnStop: true } };
  const hSection = putQS('section-hours-wrapping-midnight-breakers-unsorted', section);
  putQS('section-any-time-no-breakers', { ...section, engine: { ...section.engine, policy: 'avellaneda_stoikov', hours: null, breakers: {}, flattenOnStop: false } });

  const OI = 'packages/trading/src/orders/canonical.ts canonicalOrderBytes / canonicalOrderHash', OB = 'packages/trading/src/orders/canonical.ts orderBodyHashHex (hash only; canonicalHex rebuilt with canonicalEncode from canonicalOrderFields minus its last three pairs, asserted against it)';
  const putO = (name: string, object: Record<string, unknown>) => {
    add('SPW-ORDER-INTENT-v1.json', { name, domain: trading.ORDER_DOMAIN, source: OI, object, bytes: trading.canonicalOrderBytes(object), hash: trading.canonicalOrderHash(object) });
    const fields = trading.canonicalOrderFields(object) as [string, string][];
    if (fields.slice(-3).map((f) => f[0]).join() !== trading.ORDER_BODY_EXCLUDED.join()) throw new Error('the last three fields of an order are not the excluded ones');
    add('SPW-ORDER-BODY-v1.json', { name, domain: trading.ORDER_BODY_DOMAIN, source: OB, object, bytes: live.canonicalEncode(trading.ORDER_BODY_DOMAIN, fields.slice(0, -3)), hash: trading.orderBodyHashHex(object) });
  };
  const order = (n: number, o: Record<string, unknown>) => ({ v: 1, venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'limit', size: '0.0100', notional: null, limitPrice: '68500.0', triggerPrice: null,
    reduceOnly: false, tif: 'gtc', maxSlippageBps: 50, maxFeeUsd: '2.50', leverage: '3.0', marginMode: 'cross', clientOrderId: `spw-order-${n.toString().padStart(4, '0')}`, mode: 'live', principal: { kind: 'owner', id: 'owner' }, mandateId: null,
    createdAt: T0_MS, expiresAt: T0_MS + 60_000, ...o });
  putO('owner-perp-limit-buy', order(1, {}));
  putO('owner-perp-market-notional-nulls', order(2, { type: 'market', size: null, notional: '250', limitPrice: null, leverage: null, marginMode: null, tif: 'ioc', maxFeeUsd: '0' }));
  putO('agent-perp-stop-reduce-only-under-mandate', order(3, { side: 'sell', type: 'stop', limitPrice: null, triggerPrice: '64000.00', reduceOnly: true, principal: { kind: 'agent', id: 'agent:trend-01' }, mandateId: uuid(0x900), marginMode: 'isolated' }));
  putO('api-key-take-profit-limit-paper', order(4, { side: 'sell', type: 'take_profit', limitPrice: '74900', triggerPrice: '75000', mode: 'paper', principal: { kind: 'api_key', id: 'spk_0123456789ab' }, mandateId: uuid(0x901), leverage: null, marginMode: null }));
  putO('owner-spot-market-kyberswap', order(5, { venue: 'kyberswap', network: 'base', instrument: 'kyberswap:ETH/USDC', marketKind: 'spot', type: 'market', size: null, notional: '100.00', limitPrice: null, leverage: null, marginMode: null, tif: 'ioc', maxSlippageBps: 100, maxFeeUsd: '1' }));

  // the approval intent: it names the trading mandate hash and the hash of the signer shape compiled from it
  const A = `services/api/src/mandates/service.ts MANDATE_APPROVAL_DOMAIN (prepare / prepareQuoting → risk/passkey.ts prepareIntent → services/api/src/derivatives/exec.ts canonicalIntentHash)`;
  const putA = (name: string, object: unknown) => add('SPW-TRADING-MANDATE-APPROVAL-v1.json', { name, domain: mandateService.MANDATE_APPROVAL_DOMAIN, source: A, object, bytes: jsonBytes(mandateService.MANDATE_APPROVAL_DOMAIN, object), hash: exec.canonicalIntentHash(mandateService.MANDATE_APPROVAL_DOMAIN, object) });
  const venueMandateHashHex = files.get('SPW-VENUE-MANDATE-v1.json')![0]!.hashHex, quotingMandateHashHex = files.get('SPW-VENUE-QUOTING-MANDATE-v1.json')![0]!.hashHex;
  putA('approval-directional-mandate', { v: 1, kind: 'trading_mandate_approval', mandateId: uuid(0x900), tradingMandateHash: hLive, principal: 'agent:agent:trend-01', mode: 'live', signer: { shape: 'SPW-VENUE-MANDATE-v1', mandateHash: venueMandateHashHex }, ...stamp(0x20) });
  putA('approval-quoting-mandate-with-section-hash', { v: 1, kind: 'trading_mandate_approval', mandateId: uuid(0x902), tradingMandateHash: hMm, principal: 'agent:agent:mm-01', mode: 'live', signer: { shape: 'SPW-VENUE-QUOTING-MANDATE-v1', mandateHash: quotingMandateHashHex },
    quotingSectionHash: hSection, ...stamp(0x21) });
}

// ------------------------------------------------------------------------------------------------------------------ 7. SPW-ENROLL-v1
{
  // services/api/src/auth.ts:16 `enrollChallenge` is not exported: sha256("SPW-ENROLL-v1\n" + id + "\n" + publicKey). The isolated
  // signer has its own exported copy (services/isolated-signer/src/signer.ts `enrollChallenge`), which is the function used here;
  // the bytes are the same string, asserted against it by `add`.
  const S = 'services/isolated-signer/src/signer.ts enrollChallenge (same string as the unexported services/api/src/auth.ts enrollChallenge)';
  const put = (name: string, credentialId: string, publicKey: string) => add('SPW-ENROLL-v1.json', { name, domain: 'SPW-ENROLL-v1', source: S, object: { credentialId, publicKey }, bytes: utf8(`SPW-ENROLL-v1\n${credentialId}\n${publicKey}`), hash: signerMod.enrollChallenge(credentialId, publicKey) });
  // a COSE ES256 public key (77 bytes) and a credential id, both base64url without padding, as @simplewebauthn stores them
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from('11'.repeat(32), 'hex'), Buffer.from('225820', 'hex'), Buffer.from('22'.repeat(32), 'hex')]).toString('base64url');
  put('enroll-es256-16-byte-credential-id', Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex').toString('base64url'), cose);
  put('enroll-es256-32-byte-credential-id-url-safe-chars', Buffer.from('fbff'.repeat(16), 'hex').toString('base64url'), cose);
}

// ------------------------------------------------------------------------------------------------------------------ 8. SPW-CRED-v2 (NEXT)
{
  // packages/core/src/credential.ts — the request an ENROLLED passkey approves to add another passkey or to revoke one. It replaces
  // SPW-ENROLL-v1 for every passkey after the first (the signer no longer accepts the v1 challenge). Eight framed fields, always
  // all of them, in this order: v, action, requestId, keyId, credentialId, publicKey ("" for a revocation), createdAt, expiresAt.
  const put = (name: string, object: Record<string, unknown>) => add('SPW-CRED-v2.json', { name, domain: core.CRED_DOMAIN, source: 'packages/core/src/credential.ts credentialBytes / credentialHash', object, bytes: core.credentialBytes(object), hash: core.credentialHash(object) });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from('11'.repeat(32), 'hex'), Buffer.from('225820', 'hex'), Buffer.from('22'.repeat(32), 'hex')]).toString('base64url');
  const id16 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex').toString('base64url'), id32 = Buffer.from('fbff'.repeat(16), 'hex').toString('base64url');
  const cred = (n: number, o: Record<string, unknown>) => ({ v: 2, requestId: uuid(0x900 + n), keyId: KEY_ID, ...o, createdAt: T0, expiresAt: T0 + 300 });
  put('add-es256-16-byte-credential-id', cred(1, { action: 'add', credentialId: id16, publicKey: cose }));
  put('add-es256-32-byte-credential-id-url-safe-chars', cred(2, { action: 'add', credentialId: id32, publicKey: cose }));
  put('add-shorter-validity', { ...cred(3, { action: 'add', credentialId: id16, publicKey: cose }), expiresAt: T0 + 120 });
  put('revoke-no-public-key', cred(4, { action: 'revoke', credentialId: id16 }));
  put('revoke-32-byte-credential-id', cred(5, { action: 'revoke', credentialId: id32 }));
}

// ------------------------------------------------------------------------------------------------------------------ write
const here = join(ROOT, 'tests/native-vectors');
const swift = process.env.SPW_NATIVE_VECTORS_DIR ?? resolve(ROOT, '../../apple/SPWalletCore/Tests/SPWalletCoreTests/Vectors');
mkdirSync(here, { recursive: true });
const targets = [here, ...(existsSync(swift) ? [swift] : [])];
let total = 0;
const index: { file: string; domain: string; vectors: number }[] = [];
for (const [file, vectors] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const names = new Set(vectors.map((v) => v.name));
  if (names.size !== vectors.length) throw new Error(`${file}: duplicate vector name`);
  if (new Set(vectors.map((v) => v.domain)).size !== 1 || `${vectors[0]!.domain}.json` !== file) throw new Error(`${file}: one domain per file, named after it`);
  const body = `${JSON.stringify(vectors, null, 2)}\n`;
  for (const dir of targets) writeFileSync(join(dir, file), body);
  index.push({ file, domain: vectors[0]!.domain, vectors: vectors.length });
  total += vectors.length;
}
const readme = join(here, 'README.md');
if (existsSync(readme)) for (const dir of targets) if (dir !== here) copyFileSync(readme, join(dir, 'README.md'));
for (const i of index) console.log(`${String(i.vectors).padStart(3)}  ${i.file}`);
console.log(`${total} vectors, ${index.length} domains → ${targets.join(' and ')}${existsSync(swift) ? '' : ` (Swift package directory not found: ${swift})`}`);
process.exit(0);
