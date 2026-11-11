import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, keccak256, recoverAddress, type Hex } from 'viem';
import {
  bridgeOf, buildCctpBurnTxs, buildCctpMintTx, buildEvmSwapTxs, buildEvmTx, canonicalBytes, CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_TOKEN_MESSENGER, cctpBurnData, cctpBytes32, cctpMessageHash,
  cctpMintRetryBytes, checkPolicy, decodeCctpMessage, DEFAULT_POLICY, encodeCctpMessage, intentHash, NETWORKS, toHex, verifyCctpBridge, verifyCctpMint, type CctpMessage, type Intent,
} from '../src/index.ts';

const ME = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;
const now = 1_800_000_000;
function intent(o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}): Intent {
  return { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a22', keyId: 'spw-0123456789abcdef', network: 'base', chainRef: '8453', asset: usdc('base'), symbol: 'USDC', decimals: 6, amount: '25000000',
    from: ME, to: ME, maxFee: '400000000000000', createdAt: now, expiresAt: now + 75, policyVersion: 3,
    bridge: { provider: 'cctp', toNetwork: 'arbitrum', toDomain: 3, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', ...bridge },
    evm: { nonce: 5, gasLimit: '200000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...o };
}
/** The attested message Circle would return for the burn of `i` (nonce, executed finality and fee are filled in by Circle). */
function messageFor(i: Intent, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}): Hex {
  const b = i.bridge!, m = cctpBytes32(CCTP_TOKEN_MESSENGER);
  return encodeCctpMessage({ version: 1, sourceDomain: CCTP_ENABLED[i.network]!.domain, destinationDomain: b.toDomain, nonce: 'ab'.repeat(32), sender: m, recipient: m, destinationCaller: '0'.repeat(64),
    minFinalityThreshold: b.minFinalityThreshold, finalityThresholdExecuted: b.minFinalityThreshold, ...o,
    body: { version: 1, burnToken: cctpBytes32(i.asset), mintRecipient: cctpBytes32(i.from), amount: BigInt(i.amount), messageSender: cctpBytes32(i.from), maxFee: BigInt(b.maxFee), feeExecuted: 0n, expirationBlock: 0n, ...body } });
}
const ATT = `0x${'11'.repeat(130)}` as Hex;
const GAS = { nonce: 9, gasLimit: '240000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };

describe('CCTP pins', () => {
  it('every enabled network is an EVM network with registry USDC, a distinct domain and pinned implementations', () => {
    const domains = new Set<number>();
    for (const [id, p] of Object.entries(CCTP_ENABLED)) {
      expect(NETWORKS[id]!.family).toBe('evm'); expect(usdc(id)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(domains.has(p.domain)).toBe(false); domains.add(p.domain);
      for (const impl of [p.messengerImpl, p.transmitterImpl]) { expect(impl.address).toMatch(/^0x[0-9a-fA-F]{40}$/); expect(impl.codeSha256).toMatch(/^[0-9a-f]{64}$/); }
      if (p.fastSource) expect(p.fastSeconds).not.toBeNull();
    }
    expect(Object.keys(CCTP_ENABLED).sort()).toEqual(['arbitrum', 'avalanche', 'base', 'ethereum', 'hyperevm', 'optimism', 'polygon']);
    expect(CCTP_ENABLED.bsc).toBeUndefined(); // domain 17 carries no USDC
  });
});

describe('CCTP message format', () => {
  const fx = JSON.parse(readFileSync(new URL('../../swap/test/fixtures/cctp/message-arbitrum-base-fast.json', import.meta.url), 'utf8')).messages[0] as { message: string; attestation: string; decodedMessage: any };
  it('decodes a real attested mainnet message exactly as Circle describes it, and re-encodes it byte for byte', () => {
    const m = decodeCctpMessage(fx.message), d = fx.decodedMessage, b = d.decodedMessageBody;
    expect([m.version, m.sourceDomain, m.destinationDomain, m.minFinalityThreshold, m.finalityThresholdExecuted]).toEqual([1, Number(d.sourceDomain), Number(d.destinationDomain), Number(d.minFinalityThreshold), Number(d.finalityThresholdExecuted)]);
    expect(`0x${m.nonce}`).toBe(d.nonce); expect(m.sender).toBe(cctpBytes32(d.sender)); expect(m.recipient).toBe(cctpBytes32(d.recipient)); expect(m.destinationCaller).toBe('0'.repeat(64));
    expect(m.body.burnToken).toBe(cctpBytes32(b.burnToken)); expect(m.body.mintRecipient).toBe(cctpBytes32(b.mintRecipient)); expect(m.body.messageSender).toBe(cctpBytes32(b.messageSender));
    expect([m.body.amount, m.body.maxFee, m.body.feeExecuted, m.body.expirationBlock].map(String)).toEqual([b.amount, b.maxFee, b.feeExecuted, b.expirationBlock]);
    expect(encodeCctpMessage(m)).toBe(fx.message.toLowerCase());
    expect(cctpMessageHash(fx.message)).toBe(keccak256(fx.message as Hex).slice(2));
  });
  it('the real attestation is two signatures over keccak256(message) by the attesters enabled on-chain, in ascending order', async () => {
    const digest = keccak256(fx.message as Hex), sigs = fx.attestation.slice(2);
    expect(sigs.length).toBe(130 * 2);
    const a = await recoverAddress({ hash: digest, signature: `0x${sigs.slice(0, 130)}` }), b = await recoverAddress({ hash: digest, signature: `0x${sigs.slice(130)}` });
    // getEnabledAttester(0..1) on every enabled network on 2026-11-11 (scripts/cctp-pins.mts)
    expect([a, b].sort()).toEqual(['0x52Ed4cBff8DcE6A19748043F3240ec03c834bCeF', '0x725b06F73ff761eF5390e39315e2BfbF60d33F96']);
    expect(BigInt(a) < BigInt(b)).toBe(true);
  });
  it('that real message verifies as the mint of the transfer it came from, and of no other', () => {
    const b = { fromNetwork: 'arbitrum', toNetwork: 'base', wallet: '0xb143f6ca55358fac056eca7ac1a228a1f018b048', amount: '100584300', maxFee: '14363', minFinalityThreshold: 1000 };
    const v = verifyCctpMint(b, fx.message, fx.attestation);
    expect(v.minted).toBe(100584300n - 14081n);
    expect(() => verifyCctpMint({ ...b, wallet: ME }, fx.message, fx.attestation)).toThrow(/another address/);
    expect(() => verifyCctpMint({ ...b, toNetwork: 'optimism' }, fx.message, fx.attestation)).toThrow(/destination domain/);
    expect(() => verifyCctpMint({ ...b, amount: '100584301' }, fx.message, fx.attestation)).toThrow(/another amount/);
  });
  it('refuses anything that is not a 376-byte burn message (hook data, truncation, garbage)', () => {
    expect(() => decodeCctpMessage(fx.message + 'ab')).toThrow(/376/);
    expect(() => decodeCctpMessage(fx.message.slice(0, 300))).toThrow();
    expect(() => decodeCctpMessage('nope')).toThrow(/hex/);
    expect(() => decodeCctpMessage(fx.message.slice(0, -1))).toThrow();
  });
});

describe('bridge intent', () => {
  it('builds the exact-amount approval and the burn from the intent alone', () => {
    const i = intent(), { approve, burn } = buildCctpBurnTxs(i);
    expect(approve!.nonce).toBe(5); expect(approve!.to).toBe(usdc('base')); expect(approve!.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data! }).args).toEqual([CCTP_TOKEN_MESSENGER, 25_000000n]); // exact, never unlimited
    expect(burn.nonce).toBe(6); expect(burn.to).toBe(CCTP_TOKEN_MESSENGER); expect(burn.value).toBe(0n); expect(burn.chainId).toBe(8453);
    const d = decodeFunctionData({ abi: CCTP_ABI, data: burn.data! });
    expect(d.functionName).toBe('depositForBurn');
    expect(d.args).toEqual([25_000000n, 3, `0x${cctpBytes32(ME)}`, usdc('base'), `0x${'0'.repeat(64)}`, 0n, 2000]);
    expect(burn.data!.slice(0, 10)).toBe('0x8e0250ee'); // selector seen in real mainnet burns (dossier §7.1)
    expect((burn.data!.length - 2) / 2).toBe(4 + 7 * 32);
    // allowance already in place: a single transaction at the first nonce
    const t = buildCctpBurnTxs(intent({}, { approveGas: '0' }));
    expect(t.approve).toBeNull(); expect(t.burn.nonce).toBe(5);
  });
  it('Fast: fee ceiling and threshold 1000 go into the calldata', () => {
    const d = decodeFunctionData({ abi: CCTP_ABI, data: cctpBurnData(intent({}, { maxFee: '3250', minFinalityThreshold: 1000 })) });
    expect(d.args!.slice(5)).toEqual([3250n, 1000]);
  });
  it.each([
    ['another recipient', { to: OTHER }, {}, /wallet itself/],
    ['another token (USDT is not in CCTP)', { asset: NETWORKS.ethereum.tokens.find((t) => t.symbol === 'USDT')!.id, network: 'ethereum', chainRef: '1', symbol: 'USDT' }, {}, /registry USDC/],
    ['a token that only claims to be USDC', { asset: OTHER }, {}, /registry USDC|not allowlisted|unknown/i],
    ['the native coin', { asset: 'native', symbol: 'ETH', decimals: 18 }, {}, /registry USDC/],
    ['wrong decimals', { decimals: 18 }, {}, /metadata/],
    ['zero amount', { amount: '0' }, {}, /positive|below/],
    ['wrong chain id', { chainRef: '1' }, {}, /chain id/],
    ['an unpinned messenger', {}, { messenger: OTHER }, /pinned TokenMessengerV2/],
    ['the V1 messenger', {}, { messenger: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962' }, /pinned TokenMessengerV2/],
    ['an unpinned transmitter', {}, { transmitter: OTHER }, /pinned MessageTransmitterV2/],
    ['a destination that is the source', {}, { toNetwork: 'base', toDomain: 6 }, /same network/],
    ['a domain that is not the destination network\'s', {}, { toDomain: 0 }, /destination domain/],
    ['a network without CCTP USDC (BNB Chain)', {}, { toNetwork: 'bsc', toDomain: 17 }, /not enabled/],
    ['Solana without naming the wallet\'s Solana address (v8: Solana is a destination, see cctp-sol.test.ts)', {}, { toNetwork: 'solana', toDomain: 5 }, /names the wallet's Solana address/],
    ['a fee ceiling equal to the amount', {}, { maxFee: '25000000', minFinalityThreshold: 1000 }, /below the amount/],
    ['a fee ceiling above 1 %', {}, { maxFee: '250001', minFinalityThreshold: 1000 }, /1 %/],
    ['a finality threshold Circle does not define', {}, { minFinalityThreshold: 500 }, /1000 .* or 2000/],
    ['Fast from a network where Circle does not offer it', { network: 'polygon', chainRef: '137', asset: usdc('polygon') }, { minFinalityThreshold: 1000, maxFee: '1' }, /Fast Transfer is not offered/],
    ['a swap section next to the bridge', { swap: { provider: 'kyberswap', toAsset: 'native', minOut: '1', router: OTHER, dataHash: '0'.repeat(64), approveGas: '0' } }, {}, /not both|exclude/],
  ] as [string, Partial<Intent>, Partial<NonNullable<Intent['bridge']>>, RegExp][])('refuses %s', (_n, o, b, re) => {
    expect(() => buildCctpBurnTxs(intent(o, b))).toThrow(re);
  });
  it('bounds gas and fee like a swap', () => {
    expect(() => buildCctpBurnTxs(intent({ evm: { nonce: 5, gasLimit: '500000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1' } }))).toThrow(/gas limit/);
    expect(() => buildCctpBurnTxs(intent({}, { approveGas: '500000' }))).toThrow(/approval gas/);
    expect(() => buildCctpBurnTxs(intent({ maxFee: '1000' }))).toThrow(/fee exceeds/);
    expect(() => buildCctpBurnTxs(intent({ evm: { nonce: 5, gasLimit: '200000', maxFeePerGas: '1', maxPriorityFeePerGas: '2' } }))).toThrow(/priority/);
  });
  it('the approval hash commits to every bridge field, and a bridge is neither a transfer nor a swap', () => {
    const base = toHex(intentHash(intent()));
    for (const b of [{ toNetwork: 'optimism', toDomain: 2 }, { toDomain: 2 }, { maxFee: '1' }, { minFinalityThreshold: 1000 }, { messenger: OTHER }, { transmitter: OTHER }, { approveGas: '0' }] as Partial<NonNullable<Intent['bridge']>>[])
      expect(toHex(intentHash(intent({}, b)))).not.toBe(base);
    const { bridge: _b, ...plain } = intent({ to: OTHER });
    expect(toHex(intentHash(plain as Intent))).not.toBe(base);
    expect(new TextDecoder().decode(canonicalBytes(plain as Intent))).not.toContain('bridge.'); // intents without a bridge hash exactly as before
    expect(() => buildEvmTx(intent())).toThrow(/bridge intent/);
    expect(() => buildEvmSwapTxs(intent(), '0x00')).toThrow();
    expect(() => intentHash({ ...intent(), network: 'solana', chainRef: 'x' } as Intent)).toThrow();
  });
  it('policy applies as for a send: per-transfer and daily limits on the source, fee ceiling, expiry, halt', () => {
    const i = intent({ maxFee: '270000000000000' });
    expect(checkPolicy(DEFAULT_POLICY, i, 0n, now, false)).toEqual({ ok: true });
    expect(checkPolicy(DEFAULT_POLICY, intent({ amount: '50000001', maxFee: '270000000000000' }), 0n, now, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/per-transaction/) });
    expect(checkPolicy(DEFAULT_POLICY, i, 80_000000n, now, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/daily/) });
    expect(checkPolicy(DEFAULT_POLICY, intent(), 0n, now, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/fee ceiling/) }); // 0.0004 ETH > 0.0003 on Base
    expect(checkPolicy(DEFAULT_POLICY, i, 0n, now + 76, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, i, 0n, now, true).ok).toBe(false);
    expect(checkPolicy({ ...DEFAULT_POLICY, allowlist: ['base:' + OTHER] }, i, 0n, now, false).ok).toBe(false);
  });
});

describe('mint leg: the attested message must be exactly the approved burn', () => {
  const i = intent({}, { maxFee: '3250', minFinalityThreshold: 1000 }), b = bridgeOf(i);
  it('accepts the genuine message and builds one receiveMessage to the pinned transmitter of the destination', () => {
    const msg = messageFor(i, {}, { feeExecuted: 3249n, expirationBlock: 123n });
    const v = verifyCctpMint(b, msg, ATT);
    expect(v.minted).toBe(25_000000n - 3249n); expect(v.messageHash).toBe(keccak256(msg).slice(2));
    const tx = buildCctpMintTx(b, msg, ATT, GAS, 300_000_000_000_000n);
    expect(tx.to).toBe(CCTP_MESSAGE_TRANSMITTER); expect(tx.chainId).toBe(42161); expect(tx.value).toBe(0n); expect(tx.nonce).toBe(9);
    const d = decodeFunctionData({ abi: CCTP_ABI, data: tx.data! });
    expect(d.functionName).toBe('receiveMessage'); expect(d.args).toEqual([msg, ATT]);
    expect(tx.data!.slice(0, 10)).toBe('0x57ecfd28');
    // a Fast request attested at full finality is fine (Circle degraded it to Standard: no fee)
    expect(verifyCctpMint(b, messageFor(i, { finalityThresholdExecuted: 2000 }), ATT).minted).toBe(25_000000n);
  });
  it.each([
    ['mintRecipient is not the wallet', {}, { mintRecipient: cctpBytes32(OTHER) }, /another address/],
    ['burned by someone else', {}, { messageSender: cctpBytes32(OTHER) }, /not burned by this wallet/],
    ['another destination domain', { destinationDomain: 2 }, {}, /destination domain/],
    ['another source domain', { sourceDomain: 0 }, {}, /source domain/],
    ['another amount', {}, { amount: 25_000001n }, /another amount/],
    ['another burn token', {}, { burnToken: cctpBytes32(OTHER) }, /another token/],
    ['another fee ceiling', {}, { maxFee: 9999n }, /fee ceiling/],
    ['a fee above the ceiling', {}, { feeExecuted: 3251n }, /more than the approved/],
    ['a restricted destination caller', { destinationCaller: cctpBytes32(OTHER) }, {}, /destination caller/],
    ['a sender that is not the TokenMessenger', { sender: cctpBytes32(OTHER) }, {}, /pinned TokenMessengers/],
    ['a recipient contract that is not the TokenMessenger', { recipient: cctpBytes32(OTHER) }, {}, /pinned TokenMessengers/],
    ['CCTP V1 (version 0)', { version: 0 }, {}, /not CCTP V2/],
    ['another body version', {}, { version: 2 }, /not CCTP V2/],
    ['an unattested message (zero nonce)', { nonce: '0'.repeat(64) }, {}, /no nonce/],
    ['another requested finality', { minFinalityThreshold: 2000, finalityThresholdExecuted: 2000 }, {}, /another finality/],
    ['attested below the approved finality', { finalityThresholdExecuted: 500 }, {}, /below the approved finality/],
  ] as [string, Partial<CctpMessage>, Partial<CctpMessage['body']>, RegExp][])('refuses a message with %s', (_n, o, body, re) => {
    expect(() => buildCctpMintTx(b, messageFor(i, o, body), ATT, GAS, 10n ** 18n)).toThrow(re);
  });
  it('refuses a malformed attestation, a Standard approval attested early, hook data, and gas outside the bounds', () => {
    const msg = messageFor(i);
    for (const att of ['0x', `0x${'11'.repeat(64)}`, `0x${'11'.repeat(66)}`, 'zz', `0x${'11'.repeat(65 * 9)}`]) expect(() => verifyCctpMint(b, msg, att)).toThrow(/attestation/);
    const std = intent();
    expect(() => verifyCctpMint(bridgeOf(std), messageFor(std, { finalityThresholdExecuted: 1000 }), ATT)).toThrow(/below the approved finality/);
    expect(() => verifyCctpMint(b, msg + '00', ATT)).toThrow(/376/);
    expect(() => buildCctpMintTx(b, msg, ATT, { ...GAS, gasLimit: '900000' }, 10n ** 18n)).toThrow(/gas limit/);
    expect(() => buildCctpMintTx(b, msg, ATT, GAS, 1000n)).toThrow(/policy ceiling/);
    expect(() => buildCctpMintTx(b, msg, ATT, { ...GAS, maxPriorityFeePerGas: '100000001' }, 10n ** 18n)).toThrow(/priority/);
    expect(() => buildCctpMintTx({ ...b, toNetwork: 'base' }, msg, ATT, GAS, 10n ** 18n)).toThrow(/not enabled/);
  });
  it('the retry challenge binds the bridge, the message and the gas parameters', () => {
    const a = Buffer.from(cctpMintRetryBytes('id-1', 'aa', GAS)).toString();
    for (const x of [cctpMintRetryBytes('id-2', 'aa', GAS), cctpMintRetryBytes('id-1', 'ab', GAS), cctpMintRetryBytes('id-1', 'aa', { ...GAS, nonce: 10 }), cctpMintRetryBytes('id-1', 'aa', { ...GAS, maxFeePerGas: '2' })])
      expect(Buffer.from(x).toString()).not.toBe(a);
  });
});
