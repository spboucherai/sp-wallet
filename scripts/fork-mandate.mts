/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-mandate.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Delegated trading on a LOCAL FORK of Base: the owner approves a mandate once with a passkey; an agent vault then swaps
// without any passkey, strictly inside the mandate; funds can only come back to the owner. Nothing reaches the real network.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, numberToHex, parseUnits } from 'viem';
import { KYBER_NATIVE, KYBER_ROUTER, mandateHash, NETWORKS, swapDataHash, vaultKeyId, type Intent, type Mandate } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const FORK = 'http://127.0.0.1:8549';
const keys = deriveKeys(generateMnemonic(wordlist, 128)), OWNER = keys.addresses.evm, VAULT = keys.vault(1).address;
const USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id, WHALE = process.env.USDC_WHALE ?? '0xF977814e90dA44bFA03b6295A0616a897441aceC';
const SOURCES = 'uniswapv3,uniswap,uniswap-v4,aerodrome,aerodrome-cl,pancake-v3,sushiswap,sushiswap-v3,baseswap,alien-base-cl';
let id = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (who: string, token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [who, 'latest'])) : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as `0x${string}`] }) }, 'latest']));
const mine = async (raw: string) => { const h = await rpc<string>('eth_sendRawTransaction', [raw]); for (let k = 0; k < 600; k++) { const rc = await rpc<any>('eth_getTransactionReceipt', [h]); if (rc) return rc; await new Promise((r) => setTimeout(r, 200)); } throw new Error('no receipt'); };
// the keyless KyberSwap tier allows 10 requests per 10 seconds: pace the calls so a refusal below is the signer's, not the provider's
const kyber = async (path: string, init?: RequestInit) => { await new Promise((r) => setTimeout(r, 1300)); const r = await fetch('https://aggregator-api.kyberswap.com/base/api/v1' + path, { ...init, headers: { 'x-client-id': 'swap-router', 'content-type': 'application/json' } }); const j = await r.json() as any; if (j.code !== 0) throw new Error(`PROVIDER ${r.status}: ${j.code} ${j.message}`); return j.data; };
const anvil = spawn('anvil', ['--fork-url', process.env.BASE_RPC ?? 'https://mainnet.base.org', '--port', '8549', '--chain-id', '8453', '--silent'], { stdio: 'ignore' });
try {
  for (let k = 0; k < 80; k++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  // the vault is funded with 60 USDC and a little gas, on the fork only
  await rpc('anvil_setBalance', [VAULT, numberToHex(parseUnits('0.01', 18))]);
  await rpc('anvil_impersonateAccount', [WHALE]); await rpc('anvil_setBalance', [WHALE, numberToHex(parseUnits('1', 18))]);
  await rpc('eth_sendTransaction', [{ from: WHALE, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [VAULT as `0x${string}`, 60_000000n] }) }]);
  await rpc('anvil_stopImpersonatingAccount', [WHALE]);
  console.log(`owner ${OWNER}\nvault ${VAULT} (HD account 1): ${formatUnits(await bal(VAULT, USDC), 6)} USDC, ${formatUnits(await bal(VAULT, 'native'), 18)} ETH`);

  const dir = mkdtempSync(join(tmpdir(), 'spw-mandate-fork-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, base: '5000000000000000' } }; // anvil's inflated priority fee
  const signer = new Signer(keys, store, { rpId: 'wallet.test', origin: 'https://wallet.test' }, undefined, exchangePrices()); // real exchange prices, fetched by the signer itself
  const pk = new TestPasskey('wallet.test', 'https://wallet.test');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  const now = () => Math.floor(Date.now() / 1000);
  const mandate: Mandate = { v: 1, mandateId: randomUUID(), keyId: keys.keyId, vaultIndex: 1, vault: VAULT, network: 'base', provider: 'kyberswap', assets: ['native', USDC],
    maxOrder: { [USDC]: '25000000', native: '15000000000000000' }, maxDaily: { [USDC]: '40000000', native: '30000000000000000' }, maxOrdersPerDay: 3, maxSlippageBps: 150,
    createdAt: now(), expiresAt: now() + 7 * 86400, strategySha256: createHash('sha256').update('demo strategy').digest('hex'), label: 'fork demo' };
  await signer.approveMandate(mandate, pk.assert(mandateHash(mandate))); // the only passkey use in this whole run
  console.log('mandate approved with the passkey: 25 USDC per order, 40 USDC per day, 3 orders per day, 7 days');

  async function order(label: string, fromAsset: string, toAsset: string, amount: bigint, opts: { receiver?: string } = {}) {
    const src = fromAsset === 'native' ? NETWORKS.base.native : NETWORKS.base.tokens.find((t) => t.id === fromAsset)!, dst = toAsset === 'native' ? NETWORKS.base.native : NETWORKS.base.tokens.find((t) => t.id === toAsset)!;
    const tok = (a: string) => (a === 'native' ? KYBER_NATIVE : a);
    const q = await kyber(`/routes?tokenIn=${tok(fromAsset)}&tokenOut=${tok(toAsset)}&amountIn=${amount}&excludeRFQSources=true&includedSources=${SOURCES}`);
    const b = await kyber('/route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q.routeSummary, sender: VAULT, recipient: opts.receiver ?? VAULT, slippageTolerance: 50, deadline: now() + 600 }) });
    const nonce = Number(await rpc<string>('eth_getTransactionCount', [VAULT, 'latest'])), block = await rpc<any>('eth_getBlockByNumber', ['latest', false]);
    const maxFeePerGas = hexToBigInt(block.baseFeePerGas) * 2n + 1_000_000n, approveGas = fromAsset === 'native' ? 0n : 70_000n, gas = BigInt(b.gas) * 2n + 100_000n;
    const minOut = (BigInt(b.amountOut) * 9950n) / 10_000n - 1n;
    const intent: Intent = { v: 1, proposalId: randomUUID(), keyId: vaultKeyId(keys.keyId, 1), network: 'base', chainRef: '8453', asset: fromAsset, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
      from: VAULT, to: VAULT, maxFee: ((gas + approveGas) * maxFeePerGas).toString(), createdAt: now(), expiresAt: now() + 90, policyVersion: store.policy.version,
      swap: { provider: 'kyberswap', toAsset, minOut: minOut.toString(), router: KYBER_ROUTER, dataHash: swapDataHash(b.data), approveGas: approveGas.toString() },
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1000000' } };
    const before = await bal(VAULT, toAsset);
    const signed = await signer.signDelegated(mandate.mandateId, intent, { swapData: b.data }); // no passkey
    if (signed.pre && (await mine(signed.pre.raw)).status !== '0x1') throw new Error('approval reverted');
    const rc = await mine(signed.raw);
    if (rc.status !== '0x1') throw new Error(`${label}: reverted on the fork`);
    console.log(`${label}: vault received ${formatUnits(await bal(VAULT, toAsset) - before, dst.decimals)} ${dst.symbol} (minimum ${formatUnits(minOut, dst.decimals)})`);
  }
  const refused = async (label: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { if ((e as Error).message.startsWith('PROVIDER')) throw e; console.log(`refused by the signer (${label}): ${(e as Error).message}`); return; } throw new Error(`signer accepted: ${label}`); };

  await order('order 1  USDC -> ETH (20 USDC)', USDC, 'native', 20_000000n);
  await refused('order above the per-order limit, 26 USDC', () => order('x', USDC, 'native', 26_000000n));
  await refused('output sent to the owner instead of the vault', () => order('x', USDC, 'native', 5_000000n, { receiver: OWNER }));
  await order('order 2  USDC -> ETH (20 USDC)', USDC, 'native', 20_000000n);
  await refused('daily volume: 40 USDC already sold today', () => order('x', USDC, 'native', 1_000000n));
  await order('order 3  ETH -> USDC (0.005 ETH)', 'native', USDC, 5_000000000000000n);
  await refused('fourth order of the day', () => order('x', 'native', USDC, 1_000000000000000n));

  // funds leave a vault only towards the owner
  const ret = async (to: string) => { const nonce = Number(await rpc<string>('eth_getTransactionCount', [VAULT, 'latest'])), block = await rpc<any>('eth_getBlockByNumber', ['latest', false]);
    const amount = await bal(VAULT, USDC), maxFeePerGas = hexToBigInt(block.baseFeePerGas) * 2n + 1_000_000n;
    const i: Intent = { v: 1, proposalId: randomUUID(), keyId: vaultKeyId(keys.keyId, 1), network: 'base', chainRef: '8453', asset: USDC, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: VAULT, to,
      maxFee: (90_000n * maxFeePerGas).toString(), createdAt: now(), expiresAt: now() + 90, policyVersion: store.policy.version, evm: { nonce, gasLimit: '90000', maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1000000' } };
    return { amount, signed: await signer.signReturn(mandate.mandateId, i) }; };
  await refused('withdrawal to a third party', () => ret('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'));
  signer.revokeMandate(mandate.mandateId);
  await refused('order after revocation', () => order('x', 'native', USDC, 1_000000000000000n));
  const r = await ret(OWNER); if ((await mine(r.signed.raw)).status !== '0x1') throw new Error('return reverted');
  console.log(`returned to the owner after revocation: ${formatUnits(await bal(OWNER, USDC), 6)} USDC; vault now holds ${formatUnits(await bal(VAULT, USDC), 6)} USDC`);
  if ((await bal(OWNER, USDC)) !== r.amount) throw new Error('owner did not receive the vault balance');
  console.log('\nMANDATE FORK TEST OK — nothing was sent to the real network');
} finally { anvil.kill(); }
process.exit(0);
