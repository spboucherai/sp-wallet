import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_TOKEN_MESSENGER, cctpBytes32, cctpMintRetryBytes, encodeCctpMessage, intentHash, NETWORKS, verifyAuditChain, type CctpMessage, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', ME = keys.addresses.evm, OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-bridge-')), nowRef = { t: Math.floor(Date.now() / 1000) };
  const open = () => { const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')); return { store, signer: new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t) }; };
  const { store, signer } = open(), pk = new TestPasskey(RP, ORIGIN);
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  return { store, signer, pk, nowRef, reopen: open };
}
let seq = 0;
function intent(now: number, o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}): Intent {
  seq += 1;
  return { v: 1, proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(seq).padStart(12, '0')}`, keyId: keys.keyId, network: 'base', chainRef: '8453', asset: usdc('base'), symbol: 'USDC', decimals: 6, amount: '10000000',
    from: ME, to: ME, maxFee: '270000000000000', createdAt: now, expiresAt: now + 75, policyVersion: 3,
    bridge: { provider: 'cctp', toNetwork: 'arbitrum', toDomain: 3, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', ...bridge },
    evm: { nonce: 3, gasLimit: '200000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...o };
}
function messageFor(i: Intent, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}, nonce = 'cd'.repeat(32)): Hex {
  const b = i.bridge!, m = cctpBytes32(CCTP_TOKEN_MESSENGER);
  return encodeCctpMessage({ version: 1, sourceDomain: CCTP_ENABLED[i.network]!.domain, destinationDomain: b.toDomain, nonce, sender: m, recipient: m, destinationCaller: '0'.repeat(64),
    minFinalityThreshold: b.minFinalityThreshold, finalityThresholdExecuted: b.minFinalityThreshold, ...o,
    body: { version: 1, burnToken: cctpBytes32(i.asset), mintRecipient: cctpBytes32(i.from), amount: BigInt(i.amount), messageSender: cctpBytes32(i.from), maxFee: BigInt(b.maxFee), feeExecuted: 0n, expirationBlock: 0n, ...body } });
}
const ATT = `0x${'22'.repeat(130)}`;
const GAS = { nonce: 4, gasLimit: '240000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

describe('bridge, first leg (passkey approval of the whole transfer)', () => {
  it('signs the exact approval and the burn it built itself; both recover to the wallet; the bridge is recorded', async () => {
    const { signer, store, pk, nowRef } = await setup(), i = intent(nowRef.t);
    const out = await signer.sign(i, pk.assert(intentHash(i)));
    const burn = parseTransaction(out.raw as Hex), approve = parseTransaction(out.pre!.raw as Hex);
    expect(await recoverTransactionAddress({ serializedTransaction: out.raw as never })).toBe(ME);
    expect(await recoverTransactionAddress({ serializedTransaction: out.pre!.raw as never })).toBe(ME);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data! }).args).toEqual([CCTP_TOKEN_MESSENGER, 10_000000n]);
    expect(approve.to!.toLowerCase()).toBe(usdc('base').toLowerCase()); expect(approve.nonce).toBe(3);
    expect(burn.to!.toLowerCase()).toBe(CCTP_TOKEN_MESSENGER.toLowerCase()); expect(burn.nonce).toBe(4); expect(burn.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: CCTP_ABI, data: burn.data! }).args).toEqual([10_000000n, 3, `0x${cctpBytes32(ME)}`, usdc('base'), `0x${'0'.repeat(64)}`, 0n, 2000]);
    expect(store.state.bridges![i.proposalId]).toMatchObject({ burnTxid: out.txid, bridge: { fromNetwork: 'base', toNetwork: 'arbitrum', wallet: ME, amount: '10000000', maxFee: '0', minFinalityThreshold: 2000 } });
    expect(store.state.spent[`${new Date(nowRef.t * 1000).toISOString().slice(0, 10)}|base:USDC`]).toBe('10000000'); // counted like a send
    expect(signer.status().bridges).toHaveLength(1);
  });
  it.each([
    ['another recipient', { to: OTHER }, {}, 'self_send'],
    ['another amount than the one approved', {}, {}, 'bad_approval'],
    ['another token', { asset: NETWORKS.base.tokens.find((t) => t.symbol === 'LINK')!.id }, {}, 'unsupported'],
    ['an unpinned messenger', {}, { messenger: OTHER }, 'unsupported'],
    ['an unpinned transmitter', {}, { transmitter: OTHER }, 'unsupported'],
    ['a destination outside CCTP', {}, { toNetwork: 'bsc', toDomain: 17 }, 'unsupported'],
    ['an amount above the per-transfer limit', { amount: '50000001' }, {}, 'policy'],
    ['a network fee above the policy ceiling', { maxFee: '400000000000000' }, {}, 'policy'],
    ['a CCTP fee above 1 %', {}, { maxFee: '100001', minFinalityThreshold: 1000 }, 'unsupported'],
  ] as [string, Partial<Intent>, Partial<NonNullable<Intent['bridge']>>, string][])('refuses %s', async (name, o, b, code) => {
    const { signer, store, pk, nowRef } = await setup(), i = intent(nowRef.t, o, b);
    const approved = name.startsWith('another amount') ? { ...i, amount: '9000000' } : i; // the owner approved 9 USDC, the API asks for 10
    await expect(signer.sign(i, pk.assert(intentHash(approved)))).rejects.toMatchObject({ code });
    expect(store.state.bridges ?? {}).toEqual({});
    expect(store.state.spent).toEqual({});
  });
  it('a bridge cannot be replayed, signed without a passkey, or signed while halted', async () => {
    const { signer, pk, nowRef } = await setup(), i = intent(nowRef.t);
    await expect(signer.sign(i, new TestPasskey(RP, ORIGIN).assert(intentHash(i)))).rejects.toMatchObject({ code: 'unknown_credential' });
    await signer.sign(i, pk.assert(intentHash(i)));
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'replay' });
    signer.halt();
    const j = intent(nowRef.t);
    await expect(signer.sign(j, pk.assert(intentHash(j)))).rejects.toMatchObject({ code: 'policy' });
  });
});

describe('bridge, second leg (the one matching mint)', () => {
  async function burned(bridge: Partial<NonNullable<Intent['bridge']>> = {}) {
    const s = await setup(), i = intent(s.nowRef.t, {}, bridge);
    await s.signer.sign(i, s.pk.assert(intentHash(i)));
    return { ...s, i };
  }
  it('signs exactly the receiveMessage of the approved burn, to the pinned transmitter on the destination chain, without a second passkey', async () => {
    const { signer, i, store } = await burned(), msg = messageFor(i);
    const out = await signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS });
    const tx = parseTransaction(out.raw as Hex);
    expect(await recoverTransactionAddress({ serializedTransaction: out.raw as never })).toBe(ME);
    expect(tx.to!.toLowerCase()).toBe(CCTP_MESSAGE_TRANSMITTER.toLowerCase()); expect(tx.chainId).toBe(42161); expect(tx.value ?? 0n).toBe(0n); expect(tx.nonce).toBe(4);
    expect(decodeFunctionData({ abi: CCTP_ABI, data: tx.data! })).toMatchObject({ functionName: 'receiveMessage', args: [msg, ATT] });
    expect(out).toMatchObject({ minted: '10000000', replayed: false });
    expect(store.state.bridges![i.proposalId]!.mint).toMatchObject({ txid: out.txid, signatures: 1 });
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    expect(store.state.journal.map((j) => j.type)).toContain('bridge.mint.ok');
  });
  it.each([
    ['whose mintRecipient is not the wallet', {}, { mintRecipient: cctpBytes32(OTHER) }],
    ['for another destination domain', { destinationDomain: 2 }, {}],
    ['from another source domain', { sourceDomain: 0 }, {}],
    ['with another amount', {}, { amount: 10_000001n }],
    ['with another burn token', {}, { burnToken: cctpBytes32(OTHER) }],
    ['burned by another account', {}, { messageSender: cctpBytes32(OTHER) }],
    ['with a destination caller', { destinationCaller: cctpBytes32(OTHER) }, {}],
    ['charging a fee although none was approved', {}, { feeExecuted: 1n }],
    ['of CCTP V1', { version: 0 }, {}],
  ] as [string, Partial<CctpMessage>, Partial<CctpMessage['body']>][])('refuses a message %s, and the bridge stays mintable', async (_n, o, body) => {
    const { signer, i } = await burned();
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: messageFor(i, o, body), attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'unsupported' });
    expect((await signer.signBridgeMint({ proposalId: i.proposalId, message: messageFor(i), attestation: ATT, evm: GAS })).replayed).toBe(false);
  });
  it('refuses an unknown bridge, a bridge that was never approved, a fee above the destination ceiling, hook data, and a halted signer', async () => {
    const { signer, i, nowRef } = await burned(), msg = messageFor(i);
    await expect(signer.signBridgeMint({ proposalId: '7a1c1f0e-0000-4000-8000-000000000000', message: msg, attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'not_found' });
    const never = intent(nowRef.t); // prepared, never approved
    await expect(signer.signBridgeMint({ proposalId: never.proposalId, message: messageFor(never), attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'not_found' });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: { ...GAS, maxFeePerGas: '100000000000' } })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/policy ceiling/) });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg + 'ff', attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: { ...GAS, gasLimit: 'x' } as never })).rejects.toMatchObject({ code: 'bad_request' });
    signer.halt();
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'policy' });
  });
  it('a second mint request for the same bridge: identical → same bytes, anything else → refused without the passkey', async () => {
    const { signer, i, store, pk } = await burned(), msg = messageFor(i);
    const first = await signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS });
    const again = await signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS });
    expect(again).toMatchObject({ raw: first.raw, txid: first.txid, replayed: true });
    for (const evm of [{ ...GAS, nonce: 5 }, { ...GAS, maxFeePerGas: '200000000' }, { ...GAS, gasLimit: '250000' }])
      await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm })).rejects.toMatchObject({ code: 'replay' });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: messageFor(i, {}, {}, 'ee'.repeat(32)), attestation: ATT, evm: GAS })).rejects.toMatchObject({ code: 'replay' });
    expect(store.state.bridges![i.proposalId]!.mint!.signatures).toBe(1);
    // with the owner's passkey over the exact new parameters, one more signature is possible (stuck or replaced transaction)
    const evm = { ...GAS, nonce: 6 }, h = store.state.bridges![i.proposalId]!.mint!.messageHash;
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm, assertion: pk.assert(sha(cctpMintRetryBytes(i.proposalId, h, GAS))) })).rejects.toMatchObject({ code: 'bad_approval' }); // approval of other parameters
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm, assertion: new TestPasskey(RP, ORIGIN).assert(sha(cctpMintRetryBytes(i.proposalId, h, evm))) })).rejects.toMatchObject({ code: 'unknown_credential' });
    const retry = await signer.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm, assertion: pk.assert(sha(cctpMintRetryBytes(i.proposalId, h, evm))) });
    expect(parseTransaction(retry.raw as Hex).nonce).toBe(6); expect(store.state.bridges![i.proposalId]!.mint!.signatures).toBe(2);
  });
  it('one message serves one bridge: two identical transfers cannot both be "minted" with the same message', async () => {
    const s = await setup(), a = intent(s.nowRef.t), b = intent(s.nowRef.t, { evm: { nonce: 5, gasLimit: '200000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } });
    await s.signer.sign(a, s.pk.assert(intentHash(a))); await s.signer.sign(b, s.pk.assert(intentHash(b)));
    const msg = messageFor(a);
    await s.signer.signBridgeMint({ proposalId: a.proposalId, message: msg, attestation: ATT, evm: GAS });
    await expect(s.signer.signBridgeMint({ proposalId: b.proposalId, message: msg, attestation: ATT, evm: { ...GAS, nonce: 5 } })).rejects.toMatchObject({ code: 'replay' });
    expect((await s.signer.signBridgeMint({ proposalId: b.proposalId, message: messageFor(b, {}, {}, 'ef'.repeat(32)), attestation: ATT, evm: { ...GAS, nonce: 5 } })).replayed).toBe(false);
  });
  it('survives a signer restart and days of waiting: the approval does not expire, the single signature is not forgotten', async () => {
    const { i, nowRef, reopen } = await burned({ maxFee: '1300', minFinalityThreshold: 1000 });
    nowRef.t += 9 * 86400;
    const restarted = reopen().signer, msg = messageFor(i, {}, { feeExecuted: 1300n, expirationBlock: 777n });
    const out = await restarted.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS });
    expect(out.minted).toBe('9998700');
    nowRef.t += 86400;
    const again = reopen().signer;
    expect((await again.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: GAS })).raw).toBe(out.raw);
    await expect(again.signBridgeMint({ proposalId: i.proposalId, message: msg, attestation: ATT, evm: { ...GAS, nonce: 8 } })).rejects.toMatchObject({ code: 'replay' });
  });
  it('is reachable through the authenticated gateway only, as its own narrow route', async () => {
    const { signer, i } = await burned(), secret = 's'.repeat(40);
    const srv = createSignerServer(signer, secret).listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`, body = JSON.stringify({ proposalId: i.proposalId, message: messageFor(i), attestation: ATT, evm: GAS });
    try {
      expect((await fetch(`${url}/bridge/mint`, { method: 'POST', body })).status).toBe(401);
      const ok = await fetch(`${url}/bridge/mint`, { method: 'POST', body, headers: { 'x-spw-auth': authHeader(secret, 'POST', '/bridge/mint', body) } });
      expect(ok.status).toBe(200); expect((await ok.json() as { replayed: boolean }).replayed).toBe(false);
      const bad = JSON.stringify({ proposalId: i.proposalId, message: messageFor(i, {}, { mintRecipient: cctpBytes32(OTHER) }), attestation: ATT, evm: GAS });
      const no = await fetch(`${url}/bridge/mint`, { method: 'POST', body: bad, headers: { 'x-spw-auth': authHeader(secret, 'POST', '/bridge/mint', bad) } });
      expect(no.status).toBe(422); expect((await no.json() as { message: string }).message).toMatch(/another address/);
    } finally { srv.close(); }
  });
});
