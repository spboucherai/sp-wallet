/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-swap-net.mts
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

// Swap execution proof on a LOCAL FORK (anvil) of any EVM network listed in KYBER_ENABLED. Nothing reaches the real network.
//   node scripts/fork-swap-net.mts <network>            (TOKEN=<symbol> swaps native → that registry token → native instead of the stablecoin)
// Real KyberSwap route and calldata for today's state → verified and signed by the real Signer (passkey approval) → executed
// on the fork: native → stablecoin, then stablecoin → native (with the exact-amount approval). Checks amounts and allowance.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, numberToHex, parseUnits } from 'viem';
import { buildEvmSwapTxs, intentHash, KYBER_ENABLED, KYBER_NATIVE, KYBER_ROUTER, NETWORKS, swapDataHash, type Intent } from '@spw/core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const NET = process.argv[2] ?? '', n = NETWORKS[NET];
if (!n || n.family !== 'evm' || !KYBER_ENABLED[NET]) throw new Error(`usage: fork-swap-net.mts <${Object.keys(KYBER_ENABLED).join('|')}>`);
const PORT = 8547, FORK = `http://127.0.0.1:${PORT}`, UP = process.env.FORK_RPC ?? n.rpc[0]!;
const keys = deriveKeys(generateMnemonic(wordlist, 128)); // fresh throwaway key (never the public test mnemonic)
const ME = keys.addresses.evm, stable = n.tokens.find((t) => t.symbol === 'USDC') ?? n.tokens.find((t) => t.symbol === 'USDT') ?? n.tokens.find((t) => t.symbol === 'FDUSD');
if (!stable) throw new Error(`no stablecoin in the registry for ${n.name}`);
// optional: any registry token of this network, by its registry symbol (the swap is still native -> token -> native)
const via = process.env.TOKEN ? n.tokens.find((t) => t.symbol === process.env.TOKEN) : stable;
if (!via) throw new Error(`TOKEN=${process.env.TOKEN} is not in the registry of ${n.name}`);
const SRC = process.env.KYBER_SOURCES; // optional includedSources
let id = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [ME, 'latest']))
  : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ME as `0x${string}`] }) }, 'latest']));
const mine = async (raw: string) => { const h = await rpc<string>('eth_sendRawTransaction', [raw]); for (let k = 0; k < 600; k++) { const rc = await rpc<any>('eth_getTransactionReceipt', [h]); if (rc) return rc; await new Promise((r) => setTimeout(r, 200)); } throw new Error('no receipt'); };
const kyber = async (path: string, init?: RequestInit) => { await new Promise((r) => setTimeout(r, 1300)); const r = await fetch(`https://aggregator-api.kyberswap.com/${NET}/api/v1${path}`, { ...init, headers: { 'x-client-id': 'swap-router', 'content-type': 'application/json' } }); const j = await r.json() as any; if (j.code !== 0) throw new Error(`kyber ${path.split('?')[0]}: ${j.message}`); return j.data; };

const anvil = spawn('anvil', ['--fork-url', UP, '--port', String(PORT), '--chain-id', n.chainRef, '--retries', '12', '--fork-retry-backoff', '1500', '--compute-units-per-second', process.env.FORK_CUPS ?? '120', '--silent'], { stdio: 'ignore' });
const stop = () => anvil.kill();
process.on('exit', stop);
try {
  for (let k = 0; k < 80; k++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  console.log(`fork of ${n.name} at block`, Number(await rpc<string>('eth_blockNumber')));
  const code = await rpc<string>('eth_getCode', [KYBER_ROUTER, 'latest']);
  if (createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex') !== KYBER_ENABLED[NET]!.codeSha256) throw new Error('router bytecode is not the pinned one');
  if ((await rpc<string>('eth_getCode', [ME, 'latest'])) !== '0x') throw new Error('test address has code');
  const nativeIn = parseUnits(process.env.NATIVE_IN ?? ({ ETH: '0.01', POL: '60', BNB: '0.03', AVAX: '1', HYPE: '0.5' } as Record<string, string>)[n.native.symbol] ?? '0.01', 18);
  await rpc('anvil_setBalance', [ME, numberToHex(nativeIn * 3n + parseUnits('0.2', 18))]);
  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  const signer = new Signer(keys, store, { rpId: 'wallet.test', origin: 'https://wallet.test' });
  const pk = new TestPasskey('wallet.test', 'https://wallet.test');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });

  async function swap(label: string, fromAsset: string, toAsset: string, amount: bigint, slippageBps: number) {
    const src = fromAsset === 'native' ? n.native : n.tokens.find((t) => t.id === fromAsset)!, dst = toAsset === 'native' ? n.native : n.tokens.find((t) => t.id === toAsset)!;
    const tIn = fromAsset === 'native' ? KYBER_NATIVE : fromAsset, tOut = toAsset === 'native' ? KYBER_NATIVE : toAsset;
    const q = await kyber(`/routes?tokenIn=${tIn}&tokenOut=${tOut}&amountIn=${amount}&excludeRFQSources=true${SRC ? `&includedSources=${SRC}` : '&excludedSources=kyberswap-limit-order-v2,kyberswap-limit-order'}`);
    const b = await kyber('/route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q.routeSummary, sender: ME, recipient: ME, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 600, source: 'swap-router' }) });
    if (b.routerAddress.toLowerCase() !== KYBER_ROUTER.toLowerCase()) throw new Error(`provider uses another router on ${n.name}: ${b.routerAddress}`);
    const expected = BigInt(b.amountOut), minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n - 1n;
    const now = Math.floor(Date.now() / 1000), nonce = Number(await rpc<string>('eth_getTransactionCount', [ME, 'latest']));
    const block = await rpc<any>('eth_getBlockByNumber', ['latest', false]);
    const maxFeePerGas = hexToBigInt(block.baseFeePerGas) * 2n + 1_000_000n, approveGas = fromAsset === 'native' ? 0n : 70_000n;
    const want = BigInt(b.gas) * 2n + 100_000n, gas = want > 2_000_000n ? 2_000_000n : want;
    const intent: Intent = { v: 1, proposalId: randomUUID(), keyId: keys.keyId, network: NET, chainRef: n.chainRef, asset: fromAsset, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
      from: ME, to: ME, maxFee: ((gas + approveGas) * maxFeePerGas).toString(), createdAt: now, expiresAt: now + 120, policyVersion: store.policy.version,
      swap: { provider: 'kyberswap', toAsset, minOut: minOut.toString(), router: KYBER_ROUTER, dataHash: swapDataHash(b.data), approveGas: approveGas.toString() },
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1000000' } };
    buildEvmSwapTxs(intent, b.data);
    const before = { src: await bal(fromAsset), dst: await bal(toAsset) };
    const signed = await signer.sign(intent, pk.assert(intentHash(intent)), { swapData: b.data });
    let gasCost = 0n; const cost = (rc: any) => hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice) + (rc.l1Fee ? hexToBigInt(rc.l1Fee) : 0n);
    if (signed.pre) { const rc = await mine(signed.pre.raw); if (rc.status !== '0x1') throw new Error('approval reverted'); gasCost += cost(rc); }
    const rc = await mine(signed.raw);
    if (rc.status !== '0x1') {
      const why = await rpc<string>('eth_call', [{ from: ME, to: KYBER_ROUTER, data: b.data, value: fromAsset === 'native' ? numberToHex(amount) : '0x0', gas: numberToHex(gas) }, 'latest']).then(() => 'call succeeds now', (e) => (e as Error).message);
      throw new Error(`${label}: swap reverted on the fork (route ${q.routeSummary.route.flat().map((h: any) => h.exchange).join('>')}); ${why}`);
    }
    gasCost += cost(rc);
    const after = { src: await bal(fromAsset), dst: await bal(toAsset) };
    const spent = before.src - after.src - (fromAsset === 'native' ? gasCost : 0n), got = after.dst - before.dst + (toAsset === 'native' ? gasCost : 0n);
    const allowance = fromAsset === 'native' ? 0n : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: fromAsset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as `0x${string}`, KYBER_ROUTER as `0x${string}`] }) }, 'latest']));
    console.log(`${label}: spent ${formatUnits(spent, src.decimals)} ${src.symbol}, received ${formatUnits(got, dst.decimals)} ${dst.symbol} (quoted ${formatUnits(expected, dst.decimals)}, minimum ${formatUnits(minOut, dst.decimals)}), route ${q.routeSummary.route.flat().map((h: any) => h.exchange).join('>')}`);
    const slack = fromAsset === 'native' ? 10n ** 13n : 0n;
    if (spent < amount || spent > amount + slack) throw new Error(`${label}: spent ${spent}, expected ${amount}`);
    if (got < minOut) throw new Error(`${label}: received less than the approved minimum`);
    if (allowance !== 0n) throw new Error(`${label}: an allowance was left behind`);
    return got;
  }
  const got = await swap(`${n.native.symbol} -> ${via.symbol}`, 'native', via.id, nativeIn, 100);
  await swap(`${via.symbol} -> ${n.native.symbol}`, via.id, 'native', got / 2n, 100);
  console.log(`FORK TEST OK on ${n.name} — nothing was sent to the real network`);
} finally { stop(); }
