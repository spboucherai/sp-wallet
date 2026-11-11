// Solana ↔ EVM USDC through Circle CCTP V2: the hand-written codec and the message verifier against REAL mainnet transactions
// and attested messages recorded on 2026-11-11 (fixtures/cctp-sol/real-transactions.json; see its `note`).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import {
  associatedTokenAddress, bridgeOf, buildCctpBurnTxs, buildCctpMintTx, buildCctpSolBurnMessage, buildCctpSolMintMessage, buildCctpSolReclaimMessage, buildSolTokenAccountMessage, canonicalBytes, CCTP_ABI, CCTP_ENABLED,
  CCTP_MESSAGE_TRANSMITTER, CCTP_SOL_DISC, CCTP_SOL_DOMAIN, CCTP_SOL_EVENT_ACCOUNT_BYTES, CCTP_SOL_EVENT_RENT, CCTP_SOL_FEE_RECIPIENT, CCTP_SOL_MESSAGE_TRANSMITTER, CCTP_SOL_NONCE_RENT, CCTP_SOL_PINS, CCTP_SOL_TOKEN_MESSENGER_MINTER,
  CCTP_TOKEN_MESSENGER, cctpBurnData, cctpBytes32, cctpEnd, cctpRecipient32, cctpRouteEnabled, cctpSender32, cctpSolAddress, cctpSolBytes32, cctpSolDepositForBurnIx, cctpSolMintRetryBytes, cctpSolPda, cctpSolReceiveIx, cctpSolReclaimBytes,
  cctpSolReclaimIx, cctpSolTokenAccount, cctpSolUsdc, compileSolV1Message, compileSolV1Signed, decodeCctpMessage, decodeCctpSolEventAccount, decodeSolV1Message, encodeCctpMessage, expectedCctpSolSourceMessage, intentHash, NETWORKS,
  solTokenAccountHash, solV1WireSigned, SYSTEM_PROGRAM, TOKEN_PROGRAM, verifyCctpBridge, verifyCctpMint, verifyCctpSolBurn, type CctpBridge, type CctpMessage, type Intent, type SolBudget, type SolTokenAccountRequest,
} from '../src/index.ts';
import { decodeFunctionData, type Hex } from 'viem';

interface RealTx { signature: string; blockTime: number; signers: number; feePayer: string; accounts: string[]; data: string; fee: number; unitsConsumed: number; tokenDeltas: { account: string; owner: string; mint: string; program: string; delta: string }[]; lamportDeltas: { key: string; delta: number }[] }
interface RealBurn extends RealTx { eventAccount: string; eventAccountOwner: string; eventAccountLamports: number; eventAccountData: string; iris: { status: string; cctpVersion: number; message: string; attestation: string }[] }
const real = JSON.parse(readFileSync(new URL('./fixtures/cctp-sol/real-transactions.json', import.meta.url), 'utf8')) as { burns: RealBurn[]; mints: RealTx[]; reclaims: RealTx[] };

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_ME = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', EVM_ME = '0x1111111111111111111111111111111111111111', OTHER_EVM = '0x2222222222222222222222222222222222222222';
const EVENT = '7KFhjLVYHNS4SxmQvf3VVxuwFM7Mskv9TtRwPtqP9Ewo', BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;
const now = 1_800_000_000, ATT = `0x${'11'.repeat(130)}`;
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** a bridge intent whose source is Solana */
function solIntent(o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}, sol: Partial<NonNullable<Intent['sol']>> = {}): Intent {
  return { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a22', keyId: 'spw-0123456789abcdef', network: 'solana', chainRef: NETWORKS.solana!.chainRef, asset: USDC_SOL, symbol: 'USDC', decimals: 6, amount: '25000000',
    from: SOL_ME, to: SOL_ME, maxFee: '2994480', createdAt: now, expiresAt: now + 75, policyVersion: 3,
    bridge: { provider: 'cctp', toNetwork: 'base', toDomain: 6, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_SOL_TOKEN_MESSENGER_MINTER, transmitter: CCTP_SOL_MESSAGE_TRANSMITTER, approveGas: '0', recipient: EVM_ME, ...bridge },
    sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000, createAta: false, computeUnitLimit: 80_000, computeUnitPrice: '2000000', ...sol }, ...o };
}
/** a bridge intent from an EVM network to Solana */
function toSolIntent(o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}): Intent {
  return { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a23', keyId: 'spw-0123456789abcdef', network: 'base', chainRef: '8453', asset: usdc('base'), symbol: 'USDC', decimals: 6, amount: '25000000',
    from: EVM_ME, to: EVM_ME, maxFee: '400000000000000', createdAt: now, expiresAt: now + 75, policyVersion: 3,
    bridge: { provider: 'cctp', toNetwork: 'solana', toDomain: 5, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', recipient: SOL_ME, ...bridge },
    evm: { nonce: 5, gasLimit: '200000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...o };
}
const BUDGET: SolBudget = { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000, computeUnitLimit: 260_000, computeUnitPrice: '100000' };
/** what Circle returns for a burn: the source message with nonce, executed finality (and fee, expiry) filled in */
const attested = (m: CctpMessage, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}): string =>
  encodeCctpMessage({ ...m, nonce: 'ab'.repeat(32), finalityThresholdExecuted: m.minFinalityThreshold, ...o, body: { ...m.body, ...body } });

describe('pinned programs and derived addresses', () => {
  it('discriminators are the Anchor hashes of the instruction and account names', () => {
    expect(CCTP_SOL_DISC.depositForBurn).toBe(sha8('global:deposit_for_burn'));
    expect(CCTP_SOL_DISC.receiveMessage).toBe(sha8('global:receive_message'));
    expect(CCTP_SOL_DISC.reclaimEventAccount).toBe(sha8('global:reclaim_event_account'));
    expect(CCTP_SOL_DISC.messageSentAccount).toBe(sha8('account:MessageSent'));
  });
  it('the registry USDC on Solana is the classic SPL mint Circle burns; a Token-2022 mint would be refused', () => {
    expect(cctpSolUsdc().id).toBe(USDC_SOL); expect(cctpSolUsdc().program).toBeUndefined(); expect(cctpSolUsdc().decimals).toBe(6);
    for (const b of real.burns) expect(b.tokenDeltas.every((d) => d.mint === USDC_SOL && d.program === TOKEN_PROGRAM)).toBe(true);
  });
  it('every program-derived address equals the account real transactions carry', () => {
    const b = real.burns.find((x) => x.accounts.length === 18)!, m = real.mints[0]!;
    expect(cctpSolPda.senderAuthority()).toBe(b.accounts[2]);
    expect(cctpSolPda.messageTransmitter()).toBe(b.accounts[5]);
    expect(cctpSolPda.tokenMessenger()).toBe(b.accounts[6]);
    expect(cctpSolPda.tokenMinter()).toBe(b.accounts[8]);
    expect(cctpSolPda.localToken(USDC_SOL)).toBe(b.accounts[9]);
    expect(cctpSolPda.messengerEventAuthority()).toBe(b.accounts[16]);
    expect(cctpSolPda.transmitterAuthority()).toBe(m.accounts[2]);
    expect(cctpSolPda.transmitterEventAuthority()).toBe(m.accounts[7]);
    expect(cctpSolPda.custody(USDC_SOL)).toBe(m.accounts[16]);
    expect(associatedTokenAddress(CCTP_SOL_FEE_RECIPIENT, USDC_SOL, TOKEN_PROGRAM)).toBe(m.accounts[14]);
    expect(CCTP_SOL_PINS.transmitter.program).toBe(CCTP_SOL_MESSAGE_TRANSMITTER); expect(CCTP_SOL_PINS.messenger.program).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
  });
  it('routes: the seven EVM networks with each other and with Solana; nothing else', () => {
    expect(cctpRouteEnabled('solana', 'base')).toBe(true); expect(cctpRouteEnabled('ethereum', 'solana')).toBe(true); expect(cctpRouteEnabled('base', 'arbitrum')).toBe(true);
    expect(cctpRouteEnabled('solana', 'solana')).toBe(false); expect(cctpRouteEnabled('solana', 'bsc')).toBe(false); expect(cctpRouteEnabled('tron', 'solana')).toBe(false);
    expect(cctpEnd('solana')).toMatchObject({ family: 'sol', domain: CCTP_SOL_DOMAIN, fastSource: true, standardSeconds: 17 });
    expect(cctpEnd('solana')!.messenger).toBe(cctpSolBytes32(CCTP_SOL_TOKEN_MESSENGER_MINTER)); expect(cctpEnd('solana')!.usdc).toBe(cctpSolBytes32(USDC_SOL));
    expect(CCTP_ENABLED.solana).toBeUndefined(); // the EVM pin table is untouched
  });
});

describe('real Solana → EVM burns (ground truth for the burn layout and for messageSender)', () => {
  it('there are at least three complete attested messages from at least three wallets', () => {
    const ok = real.burns.filter((b) => b.iris[0]?.status === 'complete');
    expect(ok.length).toBeGreaterThanOrEqual(3); expect(new Set(ok.map((b) => b.accounts[0])).size).toBeGreaterThanOrEqual(3);
  });
  it('messageSender is the OWNER signer (the wallet public key) — not the token account, not the fee payer; sender is the token-messenger program', () => {
    let otherPayer = 0, plain = 0;
    for (const b of real.burns) {
      const m = decodeCctpMessage(b.iris[0]!.message), owner = b.accounts[0]!, tokenAccount = b.accounts[3]!;
      expect(cctpSolAddress(m.body.messageSender)).toBe(owner);
      expect(m.body.messageSender).toBe(cctpSender32(cctpEnd('solana')!, owner));
      expect(cctpSolAddress(m.body.messageSender)).not.toBe(tokenAccount);
      if (b.feePayer !== owner) { otherPayer++; expect(cctpSolAddress(m.body.messageSender)).not.toBe(b.feePayer); }
      expect(m.sender).toBe(cctpEnd('solana')!.messenger); expect(cctpSolAddress(m.sender)).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
      expect(m.body.burnToken).toBe(cctpEnd('solana')!.usdc); expect(m.sourceDomain).toBe(5); expect(m.version).toBe(1); expect(m.body.version).toBe(1);
      // the debited account is the owner's token account of the mint, for exactly the amount
      if (b.tokenDeltas.length === 1) { plain++; expect(b.tokenDeltas[0]).toMatchObject({ account: tokenAccount, owner, delta: `-${m.body.amount}` }); } // (other burns move tokens in the same transaction first)
    }
    expect(plain).toBeGreaterThanOrEqual(3);
    expect(otherPayer).toBeGreaterThanOrEqual(2); // burns paid for by a third party: messageSender still is the owner
  });
  it('toward an EVM network the message names the pinned EVM TokenMessengerV2 as recipient and a left-padded address as mint recipient', () => {
    const evm = real.burns.filter((b) => Object.values(CCTP_ENABLED).some((p) => p.domain === decodeCctpMessage(b.iris[0]!.message).destinationDomain));
    expect(evm.length).toBeGreaterThanOrEqual(3);
    for (const b of evm) { const m = decodeCctpMessage(b.iris[0]!.message); expect(m.recipient).toBe(cctpBytes32(CCTP_TOKEN_MESSENGER)); expect(m.body.mintRecipient).toMatch(/^0{24}[0-9a-f]{40}$/); }
  });
  it('the event account: 428 bytes owned by the transmitter program, rent 2 824 480 lamports paid by the rent payer, and it stores the message Circle attests', () => {
    for (const b of real.burns) {
      const data = Uint8Array.from(Buffer.from(b.eventAccountData, 'hex')), ev = decodeCctpSolEventAccount(data), m = decodeCctpMessage(b.iris[0]!.message);
      expect(data.length).toBe(CCTP_SOL_EVENT_ACCOUNT_BYTES); expect(b.eventAccountOwner).toBe(CCTP_SOL_MESSAGE_TRANSMITTER); expect(b.eventAccount).toBe(b.accounts[11]);
      expect(ev.rentPayer).toBe(b.accounts[1]); expect(ev.createdAt).toBe(b.blockTime);
      expect(b.lamportDeltas.find((d) => d.key === b.eventAccount)!.delta).toBeGreaterThanOrEqual(Number(CCTP_SOL_EVENT_RENT));
      // on-chain bytes = the attested message with the four fields Circle fills in set back to zero
      expect(`0x${hx(ev.message)}`).toBe(encodeCctpMessage({ ...m, nonce: '0'.repeat(64), finalityThresholdExecuted: 0, body: { ...m.body, feeExecuted: 0n, expirationBlock: 0n } }));
    }
    expect(real.burns.filter((b) => b.eventAccountLamports === Number(CCTP_SOL_EVENT_RENT)).length).toBeGreaterThanOrEqual(6);
  });
  it('our instruction encoder reproduces a real burn byte for byte (data and the 18 accounts)', () => {
    for (const b of real.burns.filter((x) => x.accounts.length === 18 && x.accounts[0] === x.accounts[1])) {
      const d = Buffer.from(b.data, 'hex'), m = decodeCctpMessage(b.iris[0]!.message);
      if (!d.subarray(52, 84).every((x) => x === 0)) continue; // a burn with a destination caller: never built here
      const owner = b.accounts[0]!;
      if (b.accounts[3] !== cctpSolTokenAccount(owner)) continue; // spent from a non-associated account
      const ix = cctpSolDepositForBurnIx({ owner, eventAccount: b.eventAccount, amount: m.body.amount, destinationDomain: m.destinationDomain, mintRecipientHex: m.body.mintRecipient, maxFee: m.body.maxFee, minFinalityThreshold: m.minFinalityThreshold });
      expect(hx(ix.data)).toBe(b.data); expect(ix.accounts.map((a) => a.pubkey)).toEqual(b.accounts); expect(ix.program).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
      expect(ix.accounts.map((a, k) => (a.signer ? k : -1)).filter((k) => k >= 0)).toEqual([0, 1, 11]);
      expect(ix.accounts.map((a, k) => (a.writable ? k : -1)).filter((k) => k >= 0)).toEqual([1, 3, 5, 9, 10, 11]);
    }
    expect(real.burns.some((x) => x.accounts.length === 18 && x.accounts[0] === x.accounts[1] && x.accounts[3] === cctpSolTokenAccount(x.accounts[0]!))).toBe(true);
  });
  it('a real attested message passes the mint verifier for exactly the wallet that burned it, and no other', () => {
    for (const b of real.burns) {
      const m = decodeCctpMessage(b.iris[0]!.message), dstNet = Object.entries(CCTP_ENABLED).find(([, p]) => p.domain === m.destinationDomain)?.[0];
      if (!dstNet) continue;
      const rec: CctpBridge = { fromNetwork: 'solana', toNetwork: dstNet, wallet: b.accounts[0]!, recipient: `0x${m.body.mintRecipient.slice(24)}`, amount: m.body.amount.toString(), maxFee: m.body.maxFee.toString(), minFinalityThreshold: m.minFinalityThreshold };
      const v = verifyCctpMint(rec, b.iris[0]!.message, b.iris[0]!.attestation);
      expect(v.minted).toBe(m.body.amount - m.body.feeExecuted);
      // the EVM mint transaction is the existing one
      const tx = buildCctpMintTx(rec, b.iris[0]!.message, b.iris[0]!.attestation, { nonce: 1, gasLimit: '240000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' }, 10n ** 18n);
      expect(tx.to).toBe(CCTP_MESSAGE_TRANSMITTER); expect(decodeFunctionData({ abi: CCTP_ABI, data: tx.data as Hex }).args![0]).toBe(b.iris[0]!.message);
      expect(() => verifyCctpMint({ ...rec, wallet: b.accounts[3]! }, b.iris[0]!.message, b.iris[0]!.attestation)).toThrow(/not burned by this wallet/); // the token account is not the sender
      expect(() => verifyCctpMint({ ...rec, wallet: SOL_ME }, b.iris[0]!.message, b.iris[0]!.attestation)).toThrow(/not burned by this wallet/);
      expect(() => verifyCctpMint({ ...rec, recipient: OTHER_EVM }, b.iris[0]!.message, b.iris[0]!.attestation)).toThrow(/another address/);
      expect(() => verifyCctpMint({ ...rec, amount: (m.body.amount + 1n).toString() }, b.iris[0]!.message, b.iris[0]!.attestation)).toThrow(/another amount/);
    }
  });
});

describe('real EVM → Solana mints (ground truth for receive_message and for the recipient)', () => {
  const parse = (t: RealTx) => { const d = Buffer.from(t.data, 'hex'), ml = d.readUInt32LE(8), message = d.subarray(12, 12 + ml), al = d.readUInt32LE(12 + ml); return { message, attestation: d.subarray(16 + ml, 16 + ml + al), m: decodeCctpMessageAny(message) }; };
  /** header + fixed body fields of a message that may carry hook data */
  const decodeCctpMessageAny = (message: Uint8Array) => decodeCctpMessage(`0x${hx(message.subarray(0, 376))}`);
  it('the mint recipient is a TOKEN ACCOUNT (account 15 of the instruction), credited with amount − fee; its owner is someone else', () => {
    expect(real.mints.length).toBeGreaterThanOrEqual(3);
    for (const t of real.mints) {
      const { m } = parse(t), recipient = cctpSolAddress(m.body.mintRecipient);
      expect(recipient).toBe(t.accounts[15]);
      const credit = t.tokenDeltas.find((d) => d.account === recipient)!;
      expect(BigInt(credit.delta)).toBe(m.body.amount - m.body.feeExecuted); expect(credit.owner).not.toBe(recipient); expect(credit.mint).toBe(USDC_SOL);
      expect(m.destinationDomain).toBe(5); expect(cctpSolAddress(m.recipient)).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER); expect(m.sender).toBe(cctpBytes32(CCTP_TOKEN_MESSENGER));
      // the payer funds the used-nonce record: 695 960 lamports
      expect(t.lamportDeltas.find((d) => d.key === t.accounts[4])!.delta).toBe(Number(CCTP_SOL_NONCE_RENT));
    }
  });
  it('our instruction encoder reproduces real mints byte for byte (data and the 20 accounts, incl. the fee recipient\'s token account)', () => {
    let n = 0;
    for (const t of real.mints) {
      const { message, attestation, m } = parse(t);
      const ix = cctpSolReceiveIx({ payer: t.accounts[0]!, message, attestation, nonceHex: m.nonce, sourceDomain: m.sourceDomain, burnTokenHex: m.body.burnToken, recipientTokenAccount: t.accounts[15]! });
      expect(hx(ix.data)).toBe(t.data); expect(ix.accounts.map((a) => a.pubkey)).toEqual(t.accounts); expect(ix.program).toBe(CCTP_SOL_MESSAGE_TRANSMITTER);
      expect(ix.accounts.map((a, k) => (a.writable ? k : -1)).filter((k) => k >= 0)).toEqual([0, 4, 11, 12, 14, 15, 16]);
      expect(ix.accounts.slice(9).some((a) => a.pubkey === t.accounts[0] || a.signer)).toBe(false); // the payer is never handed to the receiver
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });
  it('a real message passes the verifier for the wallet whose associated USDC account it names, and the signer-built transaction is that mint', () => {
    let n = 0;
    for (const t of real.mints) {
      const { message, attestation, m } = parse(t);
      if (message.length !== 376) { expect(() => decodeCctpMessage(`0x${hx(message)}`)).toThrow(/376/); continue; } // a message with hook data is refused outright
      const credit = t.tokenDeltas.find((d) => d.account === t.accounts[15])!, srcNet = Object.entries(CCTP_ENABLED).find(([, p]) => p.domain === m.sourceDomain)?.[0];
      if (!srcNet || cctpSolTokenAccount(credit.owner) !== t.accounts[15]) continue;
      const rec: CctpBridge = { fromNetwork: srcNet, toNetwork: 'solana', wallet: `0x${m.body.messageSender.slice(24)}`, recipient: credit.owner, amount: m.body.amount.toString(), maxFee: m.body.maxFee.toString(), minFinalityThreshold: m.minFinalityThreshold };
      const msgHex = `0x${hx(message)}`, attHex = `0x${hx(attestation)}`;
      expect(verifyCctpMint(rec, msgHex, attHex).minted).toBe(BigInt(credit.delta));
      const built = buildCctpSolMintMessage(rec, msgHex, attHex, BUDGET, 3_000_000n), d = decodeSolV1Message(built.msg);
      expect(d.numSigners).toBe(1); expect(d.payer).toBe(credit.owner); expect(d.instructions.length).toBe(1);
      expect(hx(d.instructions[0]!.data)).toBe(t.data); expect(d.instructions[0]!.accounts).toEqual([credit.owner, credit.owner, ...t.accounts.slice(2)]);
      expect(built.tokenAccount).toBe(t.accounts[15]);
      // the owner address itself is not a recipient; another wallet's record does not accept the message
      expect(() => verifyCctpMint({ ...rec, recipient: SOL_ME }, msgHex, attHex)).toThrow(/another address/);
      expect(m.body.mintRecipient).not.toBe(cctpSolBytes32(credit.owner));
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('real reclaims', () => {
  it('one signer (the payee = the recorded rent payer), three accounts; our encoder reproduces the instruction', () => {
    expect(real.reclaims.length).toBeGreaterThanOrEqual(2);
    for (const t of real.reclaims) {
      const d = Buffer.from(t.data, 'hex'), al = d.readUInt32LE(8), attestation = d.subarray(12, 12 + al), ml = d.readUInt32LE(12 + al), message = d.subarray(16 + al, 16 + al + ml);
      expect(t.signers).toBe(1); expect(t.accounts[0]).toBe(t.feePayer);
      const ix = cctpSolReclaimIx({ payee: t.accounts[0]!, eventAccount: t.accounts[2]!, message, attestation });
      expect(hx(ix.data)).toBe(t.data); expect(ix.accounts.map((a) => a.pubkey)).toEqual(t.accounts);
      expect(t.lamportDeltas.find((x) => x.key === t.accounts[2])!.delta).toBe(-Number(CCTP_SOL_EVENT_RENT)); // the whole deposit leaves the event account…
      expect(t.lamportDeltas.find((x) => x.key === t.accounts[0])!.delta).toBe(Number(CCTP_SOL_EVENT_RENT) - t.fee); // …to the payee
    }
  });
});

describe('the burn the signer builds (Solana → EVM)', () => {
  it('one instruction, two signers (wallet + event account), every account derived; the stored message would pass our own mint check', () => {
    const i = solIntent(), msg = buildCctpSolBurnMessage(i, EVENT), d = decodeSolV1Message(msg);
    expect(d.numSigners).toBe(2); expect(d.numReadonlySigned).toBe(0); expect(d.keys.slice(0, 2)).toEqual([SOL_ME, EVENT]); expect(d.blockhash).toBe(BLOCKHASH);
    expect(d.instructions.length).toBe(1); expect(d.instructions[0]!.program).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
    expect(d.computeUnitLimit).toBe(80_000); expect(d.priorityFeeLamports).toBe(160_000n);
    const a = d.instructions[0]!.accounts, dv = Buffer.from(d.instructions[0]!.data);
    expect(a[0]).toBe(SOL_ME); expect(a[1]).toBe(SOL_ME); expect(a[3]).toBe(associatedTokenAddress(SOL_ME, USDC_SOL, TOKEN_PROGRAM)); expect(a[4]).toBe(cctpSolPda.denylist(SOL_ME));
    expect(a[7]).toBe(cctpSolPda.remoteTokenMessenger(6)); expect(a[10]).toBe(USDC_SOL); expect(a[11]).toBe(EVENT); expect(a[14]).toBe(TOKEN_PROGRAM); expect(a[15]).toBe(SYSTEM_PROGRAM);
    expect(dv.readBigUInt64LE(8)).toBe(25_000_000n); expect(dv.readUInt32LE(16)).toBe(6); expect(dv.subarray(20, 52).toString('hex')).toBe(cctpBytes32(EVM_ME));
    expect(dv.subarray(52, 84).every((x) => x === 0)).toBe(true); expect(dv.readBigUInt64LE(84)).toBe(0n); expect(dv.readUInt32LE(92)).toBe(2000); expect(dv.length).toBe(96);
    // wire: message, then one signature per signer
    expect(solV1WireSigned([new Uint8Array(64), new Uint8Array(64)], msg).length).toBe(msg.length + 128);
    expect(() => solV1WireSigned([new Uint8Array(64)], msg)).toThrow();
    // the message the program stores, attested as Circle does, is accepted by the EVM-side verifier with the record of this very intent
    const m = attested(expectedCctpSolSourceMessage(i));
    expect(bridgeOf(i)).toEqual({ fromNetwork: 'solana', toNetwork: 'base', wallet: SOL_ME, recipient: EVM_ME, amount: '25000000', maxFee: '0', minFinalityThreshold: 2000 });
    expect(verifyCctpMint(bridgeOf(i), m, ATT).minted).toBe(25_000_000n);
    expect(decodeCctpMessage(m).body.messageSender).toBe(cctpSolBytes32(SOL_ME));
  });
  it('with no extra signer the v1 compiler produces the bytes of the Jupiter path\'s compiler', () => {
    const ix = cctpSolReclaimIx({ payee: SOL_ME, eventAccount: EVENT, message: new Uint8Array(376), attestation: new Uint8Array(130) });
    const o = { payer: SOL_ME, blockhash: BLOCKHASH, instructions: [ix], computeUnitLimit: 200_000, priorityFeeLamports: 123n, loadedAccountsDataSizeLimit: 1 << 20 };
    expect(hx(compileSolV1Signed({ ...o, signers: [] }))).toBe(hx(compileSolV1Message(o)));
    expect(() => compileSolV1Signed({ ...o, signers: [EVENT] })).toThrow(/extra signer/); // a signer that signs for nothing
    expect(() => compileSolV1Signed({ ...o, signers: [SOL_ME] })).toThrow(/duplicate/);
  });
  it('refuses every departure from the approved shape', () => {
    const bad = (i: Intent, re: RegExp, ev = EVENT) => expect(() => buildCctpSolBurnMessage(i, ev)).toThrow(re);
    bad(solIntent({ to: EVENT }), /wallet itself/);
    bad(solIntent({}, { recipient: undefined }), /names the wallet/);
    bad(solIntent({}, { recipient: SOL_ME }), /EVM address/); // a Solana address is not a recipient on an EVM network
    bad(solIntent({ asset: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' }), /registry USDC/);
    bad(solIntent({ asset: 'native', symbol: 'SOL', decimals: 9 }), /registry USDC/);
    bad(solIntent({}, { toNetwork: 'solana', toDomain: 5 }), /not enabled on the destination/);
    bad(solIntent({}, { toNetwork: 'bsc', toDomain: 17 }), /not enabled on the destination/);
    bad(solIntent({}, { toDomain: 3 }), /destination domain/);
    bad(solIntent({}, { messenger: CCTP_TOKEN_MESSENGER }), /pinned TokenMessengerMinterV2/);
    bad(solIntent({}, { messenger: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }), /pinned TokenMessengerMinterV2/);
    bad(solIntent({}, { transmitter: CCTP_SOL_TOKEN_MESSENGER_MINTER }), /pinned MessageTransmitterV2/);
    bad(solIntent({}, { maxFee: '25000000' }), /below the amount/);
    bad(solIntent({}, { maxFee: '250001' }), /1 %/);
    bad(solIntent({}, { minFinalityThreshold: 500 }), /1000 \(Fast\) or 2000/);
    bad(solIntent({}, { approveGas: '70000' }), /no approval step/);
    bad(solIntent({ amount: '0' }), /out of range/);
    bad(solIntent({ amount: (1n << 64n).toString() }), /out of range/);
    bad(solIntent({}, {}, { createAta: true }), /no token account/);
    bad(solIntent({}, {}, { computeUnitLimit: 400_000 }), /compute-unit limit/);
    bad(solIntent({}, {}, { computeUnitPrice: '2000001' }), /above the ceiling/);
    bad(solIntent({ maxFee: '2994479' }), /exceed the approved maximum/); // 10 000 + 160 000 + the 2 824 480 deposit
    bad(solIntent({}, {}, { recentBlockhash: '11111111111111111111111111111111' }), /blockhash is zero/);
    bad(solIntent(), /bad event account/, SOL_ME);
    bad(solIntent(), /bad event account/, cctpSolTokenAccount(SOL_ME));
    bad(solIntent({ swap: { provider: 'jupiter', toAsset: 'native', minOut: '1', router: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', dataHash: '0'.repeat(64), approveGas: '0' } }), /unexpected intent section/);
    expect(verifyCctpSolBurn(solIntent({}, { minFinalityThreshold: 1000, maxFee: '2500' })).maxFee).toBe(2500n); // Fast is offered from Solana
  });
  it('the intent hash commits to the recipient; EVM ↔ EVM intents hash as before', () => {
    const a = solIntent(), b = solIntent({}, { recipient: OTHER_EVM });
    expect(hx(intentHash(a))).not.toBe(hx(intentHash(b)));
    expect(Buffer.from(canonicalBytes(a)).toString('latin1')).toContain('bridge.recipient');
    const evm: Intent = { ...toSolIntent(), bridge: { ...toSolIntent().bridge!, toNetwork: 'arbitrum', toDomain: 3, recipient: undefined } };
    delete (evm.bridge as { recipient?: string }).recipient;
    expect(Buffer.from(canonicalBytes(evm)).toString('latin1')).not.toContain('bridge.recipient');
    expect(() => canonicalBytes(solIntent({}, { recipient: undefined }))).toThrow(/names the wallet/);
  });
});

describe('the burn toward Solana (EVM → Solana)', () => {
  it('mintRecipient is the wallet\'s associated USDC token account on Solana, never the wallet address', () => {
    const i = toSolIntent(), args = decodeFunctionData({ abi: CCTP_ABI, data: cctpBurnData(i) }).args as readonly unknown[];
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(`0x${cctpSolBytes32(associatedTokenAddress(SOL_ME, USDC_SOL, TOKEN_PROGRAM))}`);
    expect(args[2]).not.toBe(`0x${cctpSolBytes32(SOL_ME)}`);
    expect(args[4]).toBe(`0x${'0'.repeat(64)}`);
    expect(verifyCctpBridge(i).mintRecipient).toBe(cctpRecipient32(cctpEnd('solana')!, SOL_ME));
    expect(buildCctpBurnTxs(i).burn.to).toBe(CCTP_TOKEN_MESSENGER);
  });
  it('refuses a missing or malformed recipient, and a recipient between EVM networks', () => {
    expect(() => cctpBurnData(toSolIntent({}, { recipient: undefined }))).toThrow(/names the wallet's Solana address/);
    expect(() => cctpBurnData(toSolIntent({}, { recipient: EVM_ME }))).toThrow();
    expect(() => cctpBurnData(toSolIntent({}, { toDomain: 6 }))).toThrow(/destination domain/);
    expect(() => cctpBurnData(toSolIntent({}, { toNetwork: 'arbitrum', toDomain: 3 }))).toThrow(/names no other recipient/);
  });
  it('the mint on Solana: only the message of the approved burn, only to the wallet\'s own token account, bounded cost', () => {
    const i = toSolIntent({ amount: '40000000' }, { maxFee: '5200', minFinalityThreshold: 1000 }), rec = bridgeOf(i);
    const src = cctpEnd('base')!, dst = cctpEnd('solana')!;
    const base: CctpMessage = { version: 1, sourceDomain: 6, destinationDomain: 5, nonce: 'cd'.repeat(32), sender: src.messenger, recipient: dst.messenger, destinationCaller: '0'.repeat(64), minFinalityThreshold: 1000, finalityThresholdExecuted: 1000,
      body: { version: 1, burnToken: src.usdc, mintRecipient: cctpRecipient32(dst, SOL_ME), amount: 40_000_000n, messageSender: cctpBytes32(EVM_ME), maxFee: 5200n, feeExecuted: 5199n, expirationBlock: 468_648_788n } };
    const mk = (o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}) => encodeCctpMessage({ ...base, ...o, body: { ...base.body, ...body } });
    const ok = buildCctpSolMintMessage(rec, mk(), ATT, BUDGET, 3_000_000n), d = decodeSolV1Message(ok.msg), a = d.instructions[0]!.accounts;
    expect(ok.networkFee).toBe(5000n + 26_000n); expect(d.numSigners).toBe(1); expect(d.payer).toBe(SOL_ME); expect(d.instructions.length).toBe(1);
    expect(a[15]).toBe(associatedTokenAddress(SOL_ME, USDC_SOL, TOKEN_PROGRAM)); expect(a[4]).toBe(cctpSolPda.usedNonce('cd'.repeat(32)));
    expect(a[10]).toBe(cctpSolPda.remoteTokenMessenger(6)); expect(a[13]).toBe(cctpSolPda.tokenPair(6, src.usdc)); expect(a[5]).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
    const bad = (m: string, re: RegExp, r: CctpBridge = rec, g: SolBudget = BUDGET, ceiling = 3_000_000n) => expect(() => buildCctpSolMintMessage(r, m, ATT, g, ceiling)).toThrow(re);
    bad(mk({}, { mintRecipient: cctpSolBytes32(SOL_ME) }), /another address/); // the wallet address instead of its token account
    bad(mk({}, { mintRecipient: cctpRecipient32(dst, EVENT) }), /another address/); // someone else's token account
    bad(mk({}, { mintRecipient: cctpBytes32(EVM_ME) }), /another address/);
    bad(mk({}, { amount: 40_000_001n }), /another amount/);
    bad(mk({}, { burnToken: cctpBytes32(usdc('arbitrum')) }), /another token/);
    bad(mk({ sourceDomain: 3 }), /another source domain/);
    bad(mk({ destinationDomain: 6 }), /another destination domain/);
    bad(mk({ destinationCaller: cctpSolBytes32(EVENT) }), /destination caller/);
    bad(mk({ recipient: cctpBytes32(CCTP_TOKEN_MESSENGER) }), /pinned TokenMessengers/);
    bad(mk({ sender: dst.messenger }), /pinned TokenMessengers/);
    bad(mk({}, { messageSender: cctpBytes32(OTHER_EVM) }), /not burned by this wallet/);
    bad(mk({}, { feeExecuted: 5201n }), /more than the approved/);
    bad(mk({}, { maxFee: 5300n }), /another fee ceiling/);
    bad(mk({ nonce: '0'.repeat(64) }), /no nonce/);
    bad(mk({}, { expirationBlock: 1n << 64n }), /64-bit/);
    bad(`${mk()}00`, /376/);
    bad(mk(), /recipient as its route requires/, { ...rec, recipient: undefined });
    bad(mk(), /bad Solana address|another address/, { ...rec, recipient: EVM_ME });
    bad(mk(), /compute-unit limit/, rec, { ...BUDGET, computeUnitLimit: 1_400_000 });
    bad(mk(), /above the ceiling/, rec, { ...BUDGET, computeUnitPrice: '2000001' });
    bad(mk(), /policy ceiling/, rec, BUDGET, 5000n + 26_000n + CCTP_SOL_NONCE_RENT - 1n);
    // an EVM mint builder never serves a Solana destination, and vice versa
    expect(() => buildCctpMintTx(rec, mk(), ATT, { nonce: 1, gasLimit: '240000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' }, 10n ** 18n)).toThrow(/not on an EVM network/);
    expect(() => buildCctpSolMintMessage(bridgeOf(solIntent()), attested(expectedCctpSolSourceMessage(solIntent())), ATT, BUDGET, 3_000_000n)).toThrow(/not on Solana/);
  });
});

describe('reclaim and token-account creation', () => {
  it('reclaim: only for a bridge that started on Solana, only with that bridge\'s own attested message, to the wallet', () => {
    const i = solIntent(), rec = bridgeOf(i), m = attested(expectedCctpSolSourceMessage(i)), g = { ...BUDGET, computeUnitLimit: 200_000 };
    const r = buildCctpSolReclaimMessage(rec, EVENT, m, ATT, g, 3_000_000n), d = decodeSolV1Message(r.msg);
    expect(d.numSigners).toBe(1); expect(d.payer).toBe(SOL_ME); expect(d.instructions.length).toBe(1); expect(d.instructions[0]!.accounts).toEqual([SOL_ME, cctpSolPda.messageTransmitter(), EVENT]);
    expect(hx(d.instructions[0]!.data.subarray(0, 8))).toBe(CCTP_SOL_DISC.reclaimEventAccount);
    expect(() => buildCctpSolReclaimMessage(rec, SOL_ME, m, ATT, g, 3_000_000n)).toThrow(/bad event account/);
    expect(() => buildCctpSolReclaimMessage(rec, EVENT, attested(expectedCctpSolSourceMessage(solIntent({ amount: '26000000' }))), ATT, g, 3_000_000n)).toThrow(/another amount/);
    expect(() => buildCctpSolReclaimMessage(bridgeOf(toSolIntent()), EVENT, m, ATT, g, 3_000_000n)).toThrow(/did not start on Solana/);
    expect(() => buildCctpSolReclaimMessage(rec, EVENT, m, ATT, g, 5000n)).toThrow(/policy ceiling/);
    expect(hx(cctpSolReclaimBytes('p', EVENT, 'h', g))).not.toBe(hx(cctpSolMintRetryBytes('p', 'h', g)));
  });
  it('token account: only the wallet\'s own associated USDC account, fee and deposit inside the approved ceiling', () => {
    const req: SolTokenAccountRequest = { v: 1, requestId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a24', keyId: 'spw-0123456789abcdef', network: 'solana', chainRef: NETWORKS.solana!.chainRef, owner: SOL_ME, mint: USDC_SOL,
      tokenAccount: cctpSolTokenAccount(SOL_ME), maxFee: '2100000', createdAt: now, expiresAt: now + 60, policyVersion: 3, sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 1, computeUnitLimit: 40_000, computeUnitPrice: '100000' } };
    const r = buildSolTokenAccountMessage(req), d = decodeSolV1Message(r.msg);
    expect(d.instructions.length).toBe(1); expect(d.instructions[0]!.program).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'); expect([...d.instructions[0]!.data]).toEqual([1]);
    expect(d.instructions[0]!.accounts).toEqual([SOL_ME, cctpSolTokenAccount(SOL_ME), SOL_ME, USDC_SOL, SYSTEM_PROGRAM, TOKEN_PROGRAM]);
    expect(() => buildSolTokenAccountMessage({ ...req, mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })).toThrow(/registry USDC/);
    expect(() => buildSolTokenAccountMessage({ ...req, tokenAccount: cctpSolTokenAccount(EVENT) })).toThrow(/own associated/);
    expect(() => buildSolTokenAccountMessage({ ...req, maxFee: '2000000' })).toThrow(/exceed the approved maximum/);
    expect(hx(solTokenAccountHash(req))).not.toBe(hx(solTokenAccountHash({ ...req, owner: EVENT, tokenAccount: cctpSolTokenAccount(EVENT) })));
    expect(base58.decode(req.tokenAccount).length).toBe(32);
  });
});

describe('recorded mainnet simulations (scripts/sim-solana-cctp.mts --record; nothing was sent)', () => {
  interface Recv { network: string; burnTx: string; message: string; attestation: string; owner: string; tokenAccount: string; usedNonceAccount: string; budget: SolBudget; simulation: { err: unknown; unitsConsumed: number | null; credited: string | null; payerLamportsDelta: string | null; log: string | null } }
  const simu = JSON.parse(readFileSync(new URL('./fixtures/cctp-sol/simulated.json', import.meta.url), 'utf8')) as { burn: { wallet: string; intent: Intent; eventAccount: string; eventAccountData: string; eventAccountLamports: number; fee: number; unitsConsumed: number; usdcDelta: string; lamportsDelta: string }; receiveInFlight?: Recv; receiveUsed?: Recv };
  const recOf = (r: Recv): CctpBridge => { const m = decodeCctpMessage(r.message); return { fromNetwork: r.network, toNetwork: 'solana', wallet: `0x${m.body.messageSender.slice(24)}`, recipient: r.owner, amount: m.body.amount.toString(), maxFee: m.body.maxFee.toString(), minFinalityThreshold: m.minFinalityThreshold }; };
  it('our burn, as the real program executed it in simulation: exact debit, the measured deposit, and a stored message that is the one the intent implies and that passes our mint check', () => {
    const b = simu.burn, stored = decodeCctpSolEventAccount(Uint8Array.from(Buffer.from(b.eventAccountData, 'hex')));
    expect(stored.rentPayer).toBe(b.wallet); expect(BigInt(b.eventAccountLamports)).toBe(CCTP_SOL_EVENT_RENT); expect(b.usdcDelta).toBe(`-${b.intent.amount}`);
    expect(BigInt(b.lamportsDelta)).toBe(-(BigInt(b.fee) + CCTP_SOL_EVENT_RENT)); expect(BigInt(b.fee) + CCTP_SOL_EVENT_RENT).toBeLessThanOrEqual(BigInt(b.intent.maxFee));
    expect(`0x${hx(stored.message)}`).toBe(encodeCctpMessage(expectedCctpSolSourceMessage(b.intent)));
    const d = decodeSolV1Message(buildCctpSolBurnMessage(b.intent, b.eventAccount));
    expect(d.keys.slice(0, 2)).toEqual([b.wallet, b.eventAccount]);
    expect(verifyCctpMint(bridgeOf(b.intent), attested(decodeCctpMessage(`0x${hx(stored.message)}`)), ATT).minted).toBe(BigInt(b.intent.amount));
  });
  it('real attested EVM → Solana messages: the transaction built for them is the one that was simulated — success while unminted, "already in use" on the derived used-nonce record once minted', () => {
    expect(simu.receiveInFlight ?? simu.receiveUsed).toBeDefined();
    for (const r of [simu.receiveInFlight, simu.receiveUsed]) {
      if (!r) continue;
      const m = decodeCctpMessage(r.message), built = buildCctpSolMintMessage(recOf(r), r.message, r.attestation, r.budget, 3_000_000n), d = decodeSolV1Message(built.msg);
      expect(built.tokenAccount).toBe(r.tokenAccount); expect(cctpSolTokenAccount(r.owner)).toBe(r.tokenAccount); expect(cctpSolPda.usedNonce(m.nonce)).toBe(r.usedNonceAccount);
      expect(d.instructions[0]!.accounts[4]).toBe(r.usedNonceAccount); expect(d.instructions[0]!.accounts[15]).toBe(r.tokenAccount);
      if (r === simu.receiveInFlight) { expect(r.simulation.err).toBeNull(); expect(r.simulation.credited).toBe((m.body.amount - m.body.feeExecuted).toString()); expect(r.simulation.payerLamportsDelta).toBe((-(5000n + CCTP_SOL_NONCE_RENT)).toString()); }
      else { expect(r.simulation.err).not.toBeNull(); expect(r.simulation.log).toContain(r.usedNonceAccount); expect(r.simulation.log).toMatch(/already in use/); }
    }
  });
});
