// End-to-end swap execution on a LOCAL FORK of Base mainnet (anvil). No real funds, nothing reaches the real network:
// a real KyberSwap route and calldata for today's chain state, verified and signed by the real Signer with a passkey
// approval, then executed on the fork. Proves: the signer's checks accept genuine calldata, the signed transactions are
// valid, and the wallet really receives at least the approved minimum.
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
import { dealTokenRpc } from './lib/fork-helpers.mts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const FORK = 'http://127.0.0.1:8546', UP = process.env.BASE_RPC ?? 'https://mainnet.base.org';
// A fresh throwaway key for every run. The public BIP-39 test mnemonic must NOT be used here: its address carries an EIP-7702
// delegation on mainnet (a sweeper), so any coin it receives is forwarded away and a swap to it can never succeed.
const keys = deriveKeys(generateMnemonic(wordlist, 128));
const ME = keys.addresses.evm, USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id;
const WHALE = process.env.USDC_WHALE ?? '0xF977814e90dA44bFA03b6295A0616a897441aceC';
// classic on-chain AMMs only: proprietary market makers price from oracles refreshed every block, which a frozen fork cannot reproduce
const SOURCES = process.env.KYBER_SOURCES ?? 'uniswapv3,uniswap,uniswap-v4,aerodrome,aerodrome-cl,pancake-v3,sushiswap,sushiswap-v3,baseswap,alien-base-cl';
let id = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const bal = async (token: string) => token === 'native' ? hexToBigInt(await rpc<`0x${string}`>('eth_getBalance', [ME, 'latest']))
  : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ME as `0x${string}`] }) }, 'latest']));
const mine = async (raw: string) => { const h = await rpc<string>('eth_sendRawTransaction', [raw]); for (let k = 0; k < 600; k++) { const rc = await rpc<any>("eth_getTransactionReceipt", [h]); if (rc) return rc; await new Promise((r) => setTimeout(r, 200)); } throw new Error('no receipt'); };
const kyber = async (path: string, init?: RequestInit) => { const r = await fetch('https://aggregator-api.kyberswap.com/base/api/v1' + path, { ...init, headers: { 'x-client-id': 'swap-router', 'content-type': 'application/json' } }); const j = await r.json() as any; if (j.code !== 0) throw new Error(`kyber ${path.split('?')[0]}: ${j.code} ${j.message}`); return j.data; };

const anvil = spawn('anvil', ['--fork-url', UP, '--port', '8546', '--chain-id', '8453', '--silent'], { stdio: 'ignore' });
const stop = () => anvil.kill();
process.on('exit', stop);
try {
  for (let k = 0; k < 60; k++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  console.log('fork of Base at block', Number(await rpc<string>('eth_blockNumber')), '— router code', KYBER_ENABLED.base ? 'pinned' : 'NOT pinned');
  const code = await rpc<string>('eth_getCode', [KYBER_ROUTER, 'latest']);
  const codeHash = createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
  if (codeHash !== KYBER_ENABLED.base!.codeSha256) throw new Error(`router bytecode hash ${codeHash} is not the pinned one`);
  console.log('router bytecode matches the pinned hash');
  if ((await rpc<string>('eth_getCode', [ME, 'latest'])) !== '0x') throw new Error('test address has code');
  // fund the test wallet on the fork only
  await rpc('anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]);
  // 100 USDC for the test wallet, on the fork only. V11 final validation: written in the token's storage and read back (dealTokenRpc) —
  // the transfer from a fixed holder was unchecked and failed silently once that holder had no USDC left on Base (2026-11-17).
  // USDC_WHALE=<holder> keeps the old way, now checked.
  if (process.env.USDC_WHALE) { await rpc('anvil_impersonateAccount', [WHALE]); await rpc('anvil_setBalance', [WHALE, numberToHex(parseUnits('1', 18))]);
    await rpc('eth_sendTransaction', [{ from: WHALE, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ME as `0x${string}`, 100_000000n] }) }]);
    await rpc('anvil_stopImpersonatingAccount', [WHALE]); }
  else await dealTokenRpc(rpc as never, USDC, ME, 100_000000n, 'base');
  if ((await bal(USDC)) !== 100_000000n) throw new Error(`the test wallet holds ${await bal(USDC)} base units of USDC on the fork, 100000000 expected: the funding did not land`);
  console.log(`funded on the fork: ${formatUnits(await bal('native'), 18)} ETH, ${formatUnits(await bal(USDC), 6)} USDC`);

  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  const signer = new Signer(keys, store, { rpId: 'wallet.test', origin: 'https://wallet.test' });
  const pk = new TestPasskey('wallet.test', 'https://wallet.test');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });

  async function swap(label: string, fromAsset: string, toAsset: string, amount: bigint, slippageBps: number) {
    const src = fromAsset === 'native' ? NETWORKS.base.native : NETWORKS.base.tokens.find((t) => t.id === fromAsset)!;
    const dst = toAsset === 'native' ? NETWORKS.base.native : NETWORKS.base.tokens.find((t) => t.id === toAsset)!;
    const tIn = fromAsset === 'native' ? KYBER_NATIVE : fromAsset, tOut = toAsset === 'native' ? KYBER_NATIVE : toAsset;
    // on-chain liquidity only: off-chain signed orders (RFQ, limit orders) can expire or be filled by someone else before inclusion
    const q = await kyber(`/routes?tokenIn=${tIn}&tokenOut=${tOut}&amountIn=${amount}&excludeRFQSources=true&includedSources=${SOURCES}`);
    const b = await kyber('/route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q.routeSummary, sender: ME, recipient: ME, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 600, source: 'swap-router' }) });
    const expected = BigInt(b.amountOut), minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n - 1n;
    const now = Math.floor(Date.now() / 1000), nonce = Number(await rpc<string>('eth_getTransactionCount', [ME, 'latest']));
    const block = await rpc<any>('eth_getBlockByNumber', ['latest', false]);
    const maxFeePerGas = hexToBigInt(block.baseFeePerGas) * 2n + 1_000_000n, approveGas = fromAsset === 'native' ? 0n : 70_000n;
    // the node's own estimate when it can be run (native input); the provider's figure with a wide margin otherwise
    const est = fromAsset === 'native' ? await rpc<`0x${string}`>('eth_estimateGas', [{ from: ME, to: KYBER_ROUTER, data: b.data, value: numberToHex(amount) }]).then(hexToBigInt, (e) => { console.log(`  (estimateGas failed: ${(e as Error).message})`); return 0n; }) : 0n;
    const gasWanted = est > 0n ? (est * 13n) / 10n + 30_000n : BigInt(b.gas) * 2n + 100_000n, gas = gasWanted > 2_000_000n ? 2_000_000n : gasWanted;
    console.log(`  ${label}: provider gas ${b.gas}, node estimate ${est || 'n/a'}, limit ${gas}, route ${q.routeSummary.route.flat().map((h: any) => h.exchange).join('>')}`);
    const intent: Intent = { v: 1, proposalId: randomUUID(), keyId: keys.keyId, network: 'base', chainRef: '8453', asset: fromAsset, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
      from: ME, to: ME, maxFee: ((gas + approveGas) * maxFeePerGas).toString(), createdAt: now, expiresAt: now + 120, policyVersion: store.policy.version,
      swap: { provider: 'kyberswap', toAsset, minOut: minOut.toString(), router: b.routerAddress, dataHash: swapDataHash(b.data), approveGas: approveGas.toString() },
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1000000' } };
    buildEvmSwapTxs(intent, b.data); // the same check the API runs before asking for approval
    const before = { src: await bal(fromAsset), dst: await bal(toAsset) };
    const signed = await signer.sign(intent, pk.assert(intentHash(intent)), { swapData: b.data });
    let gasCost = 0n;
    if (signed.pre) { const rc = await mine(signed.pre.raw); if (rc.status !== '0x1') throw new Error('approval reverted'); gasCost += hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice) + (rc.l1Fee ? hexToBigInt(rc.l1Fee) : 0n); }
    const rc = await mine(signed.raw);
    if (rc.status !== '0x1') {
      // replay as a call at the same block to read the revert reason
      const why = await rpc<string>('eth_call', [{ from: ME, to: KYBER_ROUTER, data: b.data, value: fromAsset === 'native' ? numberToHex(amount) : '0x0', gas: numberToHex(gas) }, 'latest']).then(() => 'call succeeds now (state moved)', (e) => (e as Error).message);
      throw new Error(`${label}: swap reverted on the fork — gasUsed ${hexToBigInt(rc.gasUsed)} of ${gas}; ${why}`);
    }
    gasCost += hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice) + (rc.l1Fee ? hexToBigInt(rc.l1Fee) : 0n); // Base also charges an L1 data fee
    const after = { src: await bal(fromAsset), dst: await bal(toAsset) };
    const spent = before.src - after.src - (fromAsset === 'native' ? gasCost : 0n), got = after.dst - before.dst + (toAsset === 'native' ? gasCost : 0n);
    const allowance = fromAsset === 'native' ? 0n : hexToBigInt(await rpc<`0x${string}`>('eth_call', [{ to: fromAsset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as `0x${string}`, KYBER_ROUTER as `0x${string}`] }) }, 'latest']));
    console.log(`${label}: spent ${formatUnits(spent, src.decimals)} ${src.symbol}, received ${formatUnits(got, dst.decimals)} ${dst.symbol} (quoted ${formatUnits(expected, dst.decimals)}, approved minimum ${formatUnits(minOut, dst.decimals)}), gas used ${hexToBigInt(rc.gasUsed)}${signed.pre ? ' + approval' : ''}, leftover allowance ${allowance}`);
    // token input: exactly the approved amount. Native input: the amount plus gas, whose accounting on a forked rollup is only
    // approximate (the L1 data fee is not itemised in the fork's receipt) — allow a millionth of a coin.
    const slack = fromAsset === 'native' ? 10n ** 12n : 0n;
    if (spent < amount || spent > amount + slack) throw new Error(`${label}: spent ${spent}, expected ${amount}`);
    if (got < minOut) throw new Error(`${label}: received less than the approved minimum`);
    if (allowance !== 0n) throw new Error(`${label}: an allowance was left behind`);
    return { intent, data: b.data as string };
  }
  await swap('ETH -> USDC ', 'native', USDC, parseUnits('0.01', 18), 50);
  const last = await swap('USDC -> ETH ', USDC, 'native', 25_000000n, 50);
  const link = NETWORKS.base.tokens.find((t) => t.symbol === 'LINK');
  if (link) await swap('USDC -> LINK', USDC, link.id, 10_000000n, 100);

  // negative checks with genuine calldata: the signer must refuse what the owner did not approve
  const refuse = async (what: string, mut: (i: Intent) => Intent, data = last.data) => {
    const i = mut({ ...last.intent, proposalId: randomUUID() });
    try { await signer.sign(i, pk.assert(intentHash(i)), { swapData: data }); throw new Error('SIGNED'); }
    catch (e) { if ((e as Error).message === 'SIGNED') throw new Error(`signer accepted: ${what}`); console.log(`refused (${what}): ${(e as Error).message}`); }
  };
  await refuse('higher minimum than the calldata guarantees', (i) => ({ ...i, swap: { ...i.swap!, minOut: (BigInt(i.swap!.minOut) * 2n).toString() } }));
  await refuse('another output token', (i) => ({ ...i, swap: { ...i.swap!, toAsset: link?.id ?? USDC } }));
  await refuse('another input amount', (i) => ({ ...i, amount: '26000000' }));
  await refuse('calldata swapped after approval', (i) => i, last.data.slice(0, -2) + (last.data.endsWith('00') ? '01' : '00'));
  await refuse('unpinned router', (i) => ({ ...i, swap: { ...i.swap!, router: '0x000000000000000000000000000000000000dEaD' } }));
  await refuse('output to another address', (i) => ({ ...i, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }));
  await refuse('network where swaps are not enabled', (i) => ({ ...i, network: 'ethereum', chainRef: '1', asset: NETWORKS.ethereum.tokens.find((t) => t.symbol === 'USDC')!.id }));
  console.log('\nFORK TEST OK — nothing was sent to the real network');
} finally { stop(); }
