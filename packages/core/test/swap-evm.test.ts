import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import { buildEvmSwapTxs, buildEvmTx, intentHash, KYBER_NATIVE, KYBER_ROUTER, KYBER_ROUTER_ABI, NETWORKS, swapDataHash, toHex, verifyKyberSwap, type Intent } from '../src/index.ts';

const ME = '0x1111111111111111111111111111111111111111', EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
const USDC = NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id, LINK = NETWORKS.base.tokens.find((t) => t.symbol === 'LINK')!.id;
type Desc = { srcToken: string; dstToken: string; srcReceivers: string[]; srcAmounts: bigint[]; feeReceivers: string[]; feeAmounts: bigint[]; dstReceiver: string; amount: bigint; minReturnAmount: bigint; flags: bigint; permit: string };
const desc = (o: Partial<Desc> = {}): Desc => ({ srcToken: USDC, dstToken: KYBER_NATIVE, srcReceivers: [EXECUTOR], srcAmounts: [25_000000n], feeReceivers: [], feeAmounts: [], dstReceiver: ME, amount: 25_000000n, minReturnAmount: 12_000000000000000n, flags: 0x200n, permit: '0x', ...o });
const call = (d: Desc, fn: 'swap' | 'swapGeneric' | 'swapSimpleMode' = 'swap') => fn === 'swapSimpleMode'
  ? encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: fn, args: [EXECUTOR, d, '0x1234', '0x'] as never })
  : encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: fn, args: [{ callTarget: EXECUTOR, approveTarget: '0x0000000000000000000000000000000000000000', targetData: '0xabcdef', desc: d, clientData: '0x' }] as never });
const now = 1_800_000_000;
function intent(data: string, o: Partial<Intent> = {}, swap: Partial<NonNullable<Intent['swap']>> = {}): Intent {
  return { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', network: 'base', chainRef: '8453', asset: USDC, symbol: 'USDC', decimals: 6, amount: '25000000',
    from: ME, to: ME, maxFee: '2000000000000000', createdAt: now, expiresAt: now + 120, policyVersion: 4,
    swap: { provider: 'kyberswap', toAsset: 'native', minOut: '12000000000000000', router: KYBER_ROUTER, dataHash: swapDataHash(data), approveGas: '70000', ...swap },
    evm: { nonce: 5, gasLimit: '600000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...o };
}
const good = call(desc());

describe('KyberSwap calldata verification (what the signer enforces without trusting the provider)', () => {
  it('accepts genuine calldata for all three router entry points and builds exact-approval + swap', () => {
    for (const fn of ['swap', 'swapGeneric', 'swapSimpleMode'] as const) expect(verifyKyberSwap(intent(call(desc(), fn)), call(desc(), fn)).functionName).toBe(fn);
    const { approve, swap } = buildEvmSwapTxs(intent(good), good);
    expect(approve!.nonce).toBe(5); expect(swap.nonce).toBe(6);
    expect(approve!.to!.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data! }).args).toEqual([KYBER_ROUTER, 25_000000n]); // exact, never unlimited
    expect(swap.to).toBe(KYBER_ROUTER); expect(swap.value).toBe(0n); expect(swap.data).toBe(good);
  });
  it('native input: no approval, value equals the amount exactly', () => {
    const d = call(desc({ srcToken: KYBER_NATIVE, dstToken: USDC, amount: 10n ** 16n, srcAmounts: [], srcReceivers: [], minReturnAmount: 20_000000n }));
    const i = intent(d, { asset: 'native', symbol: 'ETH', decimals: 18, amount: (10n ** 16n).toString() }, { toAsset: USDC, minOut: '20000000', approveGas: '0' });
    const { approve, swap } = buildEvmSwapTxs(i, d);
    expect(approve).toBeNull(); expect(swap.nonce).toBe(5); expect(swap.value).toBe(10n ** 16n);
    expect(() => buildEvmSwapTxs({ ...i, swap: { ...i.swap!, approveGas: '70000' } }, d)).toThrow(/approval gas/);
    // token input with an allowance already in place: a single transaction at the first nonce
    const t = buildEvmSwapTxs(intent(good, {}, { approveGas: '0' }), good);
    expect(t.approve).toBeNull(); expect(t.swap.nonce).toBe(5); expect(t.swap.value).toBe(0n);
  });
  it.each([
    ['pays another address', desc({ dstReceiver: '0x000000000000000000000000000000000000dEaD' }), /another address/],
    ['pays the zero address (router would use msg.sender, but it is not what was approved)', desc({ dstReceiver: '0x0000000000000000000000000000000000000000' }), /another address/],
    ['guarantees less than approved', desc({ minReturnAmount: 11_999999999999999n }), /less than the approved minimum/],
    ['spends more', desc({ amount: 26_000000n, srcAmounts: [26_000000n] }), /another amount/],
    ['spends another token', desc({ srcToken: LINK }), /spends another token/],
    ['buys another token', desc({ dstToken: LINK }), /buys another token/],
    ['takes a fee', desc({ feeReceivers: ['0x000000000000000000000000000000000000dEaD'], feeAmounts: [1n] }), /fee receivers/],
    ['carries a permit', desc({ permit: '0x1234' }), /permit/],
    ['asks for extra native coin', desc({ flags: 0x202n }), /extra native coin/],
    ['distributes more than the input', desc({ srcAmounts: [25_000001n] }), /more than the input/],
  ] as [string, Desc, RegExp][])('refuses calldata that %s', (_n, d, re) => { const data = call(d); expect(() => verifyKyberSwap(intent(data), data)).toThrow(re); });
  it('refuses what the intent does not cover', () => {
    expect(() => verifyKyberSwap(intent(good), good + '00')).toThrow(/approved hash/);
    const padded = good + '00'.repeat(32);
    expect(() => verifyKyberSwap(intent(padded), padded)).toThrow(/canonical/); // trailing bytes the decoder would ignore
    expect(() => verifyKyberSwap(intent(good, {}, { router: '0x000000000000000000000000000000000000dEaD' }), good)).toThrow(/pinned/);
    expect(() => verifyKyberSwap(intent(good, { to: '0x000000000000000000000000000000000000dEaD' }), good)).toThrow(/wallet itself/);
    expect(() => verifyKyberSwap(intent(good, { network: 'solana', chainRef: 'x' }), good)).toThrow();
    // calldata built for Base is not valid on another enabled network: it names Base's token addresses
    expect(() => verifyKyberSwap(intent(good, { network: 'ethereum', chainRef: '1', asset: NETWORKS.ethereum.tokens.find((t) => t.symbol === 'USDC')!.id }), good)).toThrow();
    expect(() => verifyKyberSwap(intent(good, {}, { toAsset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }), good)).toThrow(/allowlisted/);
    expect(() => verifyKyberSwap(intent(good, {}, { minOut: '0' }), good)).toThrow(/positive/);
    const other = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1n] });
    expect(() => verifyKyberSwap(intent(other), other)).toThrow(/rejected/);
    expect(() => buildEvmSwapTxs(intent(good, { maxFee: '1' }), good)).toThrow(/fee exceeds/);
    expect(() => buildEvmSwapTxs(intent(good, { evm: { nonce: 5, gasLimit: '5000000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }), good)).toThrow(/gas limit/);
  });
  it('a swap intent cannot be signed as a transfer, and every swap field is part of the approved hash', () => {
    expect(() => buildEvmTx(intent(good))).toThrow(/swap intent/);
    const h = toHex(intentHash(intent(good)));
    const muts = [intent(good, {}, { minOut: '12000000000000001' }), intent(good, {}, { toAsset: LINK }), intent(good, {}, { approveGas: '70001' }), intent(good, {}, { dataHash: 'ab'.repeat(32) }), intent(good, {}, { router: ME })];
    const hs = new Set(muts.map((m) => toHex(intentHash(m))));
    expect(hs.size).toBe(muts.length); expect(hs.has(h)).toBe(false);
    expect(() => intentHash({ ...intent(good), network: 'solana', chainRef: NETWORKS.solana.chainRef, evm: undefined, sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1, createAta: false, computeUnitLimit: 1000, computeUnitPrice: '1' } })).toThrow(/EVM/);
  });
});
