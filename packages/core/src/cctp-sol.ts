/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/cctp-sol.ts
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

// Circle CCTP V2 on Solana (domain 5): pinned programs, program-derived addresses, the three instructions the wallet uses and
// the message codec they travel in. This file is a leaf: constants and pure encoders only. What may be signed is decided in
// cctp.ts (the message verifier, shared with the EVM side) and cctp-sol-tx.ts (the transactions the signer builds itself).
//
// Everything below was read from Circle's source (github.com/circlefin/solana-cctp-contracts, programs/v2, commit ec16e95d of
// 2026-06-18) and checked against real mainnet transactions fetched on 2026-11-11 (docs/swap/providers/cctp.md §13; fixtures in
// packages/core/test/fixtures/cctp-sol/):
//   - deposit_for_burn (TokenMessengerMinterV2) burns `amount` from `burn_token_account` under the authority of `owner` (a
//     signer; the account must be owned by it and hold the burn mint), then CPIs send_message, which CREATES the event account
//     (`init`, payer = event_rent_payer, owner = MessageTransmitterV2, 428 bytes for a burn message without hook) and stores
//     the message there. The event account must sign because the System program requires the new account's signature;
//   - the message: sender = the TokenMessengerMinterV2 program id, recipient = the remote token messenger registered for the
//     destination domain, body.messageSender = `owner` (the wallet's public key — NOT its token account, NOT the fee payer:
//     verified on eight real messages from seven wallets, three of them paid for by another account), body.burnToken = the mint;
//   - reclaim_event_account (MessageTransmitterV2) closes the event account to `payee`, who must sign and must be the recorded
//     rent payer; the event keypair is NOT needed again. It requires the account to be five days old and an attested message
//     with the same source fields;
//   - receive_message (MessageTransmitterV2) creates the used-nonce record (`init`, payer pays its rent — a second receive of
//     the same nonce fails there), checks the attestation, and CPIs the token messenger, which transfers `amount − feeExecuted`
//     from Circle's custody account to `recipient_token_account` — it must EQUAL body.mintRecipient and must already exist as a
//     token account of the mint — and `feeExecuted` to the fee recipient's associated token account.
import { base58 } from '@scure/base';
import { ATA_PROGRAM, associatedTokenAddress, findProgramAddress, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './build-sol.ts';
import { getNetwork } from './networks.ts';

export const CCTP_SOL_NETWORK = 'solana';
export const CCTP_SOL_DOMAIN = 5;
/** developers.circle.com/cctp/references/solana-programs, read 2026-11-11 (the same ids on devnet). */
export const CCTP_SOL_MESSAGE_TRANSMITTER = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
export const CCTP_SOL_TOKEN_MESSENGER_MINTER = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
/**
 * The reviewed deployments, read on both registry RPC endpoints on 2026-11-11. Both programs are UPGRADEABLE: whoever holds
 * the upgrade authority can replace them (each authority is a system-owned address without data — a plain key or a key
 * behind off-chain custody; not a visible multisig). An upgrade rewrites the ProgramData header, so the API refuses to
 * prepare, mint or reclaim unless slot, authority and executable hash are these on every endpoint.
 */
export const CCTP_SOL_PINS = {
  transmitter: { program: CCTP_SOL_MESSAGE_TRANSMITTER, programData: '2w2zCf9f5iyr7qcuWQH4DFNNahBZHgYkL4UVU3p5T1iS', lastDeploySlot: 343321624, upgradeAuthority: '9SxKDZRge2ianVfwP1MxzwREMHCn28gdGbrvhTNRGWRq',
    /** SHA-256 of the 493 512 executable bytes (ProgramData after its 45-byte header) */ codeSha256: 'abbe67181ec4edcad11f4a0773d8bf658b2e599d6f1365ebfee1ab0f85fe9bb4' },
  messenger: { program: CCTP_SOL_TOKEN_MESSENGER_MINTER, programData: '9ZEnLvCp3weopBnSaoSSjn7hoVk6zMXMpfH3LjNzBFFF', lastDeploySlot: 343322709, upgradeAuthority: 'HaxwvTGZFT7K8yvQKaUNZxyD593jr4gXCppu4uqQhyXK',
    /** SHA-256 of the 716 232 executable bytes */ codeSha256: 'ccdac46adb68c570556bd15f7caddc52dd16fb96e0bbc8f5a46129555adbeeb2' },
  reviewed: '2026-11-11: source read (circlefin/solana-cctp-contracts ec16e95d, programs/v2), account layouts and message fields checked on real mainnet transactions, behaviour checked by mainnet simulation (scripts/sim-solana-cctp.mts). The deployed bytes were NOT rebuilt from that source.',
} as const;
/**
 * `token_messenger.fee_recipient` on 2026-11-11: receive_message must be given this owner's associated USDC account (the
 * program checks it). It is on-chain state Circle can change; the API compares it on both endpoints and refuses on a change.
 */
export const CCTP_SOL_FEE_RECIPIENT = '4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56';
/** Circle's documented time for the attestation to exist (finality table, read 2026-11-11): Standard 32 blocks ≈ 17 s, Fast 2–3 blocks ≈ 0.4–0.6 s. */
export const CCTP_SOL_TIMES = { fastSource: true, standardSeconds: 17, fastSeconds: 1 } as const;
/** MessageTransmitter::EVENT_ACCOUNT_WINDOW_SECONDS: the event account can be closed five days after its creation. */
export const CCTP_SOL_RECLAIM_WINDOW_SEC = 5 * 24 * 3600;
/** Size of the MessageSent account of a burn message without hook: 8 + 32 + 8 + 4 + 376. */
export const CCTP_SOL_EVENT_ACCOUNT_BYTES = 428;
/**
 * Rent-exempt deposits at the rate in force on 2026-11-11 (read with getMinimumBalanceForRentExemption and seen in real
 * transactions): 428-byte event account, 9-byte used-nonce record. The signer has no chain access: it counts these figures
 * inside the approved fee ceiling. The API reads the live rate and refuses when it is higher, so they are bounds as long as
 * the protocol's rent does not rise above that rate without the pin being reviewed.
 */
export const CCTP_SOL_EVENT_RENT = 2_824_480n;
export const CCTP_SOL_NONCE_RENT = 695_960n;
export const CCTP_SOL_NONCE_BYTES = 9;
export const CCTP_SOL_LOADED_DATA_LIMIT = 8 * 1024 * 1024;
/** compute units: real burns used 42–53k, real mints 183–207k, real reclaims 145k (2026-11-11) */
export const CCTP_SOL_CU = { burnMin: 30_000, burnMax: 150_000, mintMin: 150_000, mintMax: 400_000, reclaimMin: 100_000, reclaimMax: 300_000, ataMin: 10_000, ataMax: 80_000 } as const;
/** micro-lamports per compute unit: the same ceiling as the Jupiter path */
export const CCTP_SOL_MAX_CU_PRICE = 2_000_000n;

/** Anchor discriminators: sha256("global:<name>")[0..8]; sha256("account:MessageSent")[0..8] (checked in tests). */
export const CCTP_SOL_DISC = { depositForBurn: 'd73c3d2e723780b0', receiveMessage: '26907fe11fe1ee19', reclaimEventAccount: '5ec6b49f83ec0fae', messageSentAccount: '83648538a6e1973c' } as const;

export interface SolIx { program: string; accounts: { pubkey: string; signer: boolean; writable: boolean }[]; data: Uint8Array }

const enc = new TextEncoder();
const cat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n: bigint) => { if (n < 0n || n >= 1n << 64n) throw new Error('u64 overflow'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const hexToBytes = (h: string) => { if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error('bad hex'); return Uint8Array.from(Buffer.from(h, 'hex')); };
const pk = (s: string) => { let b: Uint8Array; try { b = base58.decode(s); } catch { throw new Error('bad Solana address'); } if (b.length !== 32) throw new Error('bad Solana address'); return b; };
const ro = (pubkey: string) => ({ pubkey, signer: false, writable: false }), rw = (pubkey: string) => ({ pubkey, signer: false, writable: true });

/** A Solana public key as the bytes32 a CCTP message carries: its 32 raw bytes, lowercase hex without 0x. */
export const cctpSolBytes32 = (address: string): string => Buffer.from(pk(address)).toString('hex');
/** Inverse: a message bytes32 as a Solana address. */
export const cctpSolAddress = (hex32: string): string => { const b = hexToBytes(hex32); if (b.length !== 32) throw new Error('bad bytes32'); return base58.encode(b); };

/** The registry USDC on Solana. CCTP burns and mints a classic SPL Token mint: anything else is refused. */
export function cctpSolUsdc() {
  const t = getNetwork(CCTP_SOL_NETWORK).tokens.find((x) => x.symbol === 'USDC');
  if (!t) throw new Error('no native USDC in the registry for Solana');
  if (t.program === 'token2022') throw new Error('the registry USDC on Solana must be a classic SPL Token mint');
  return t;
}
/** The wallet's own USDC token account: the only account a burn spends from and the only one a mint may credit. */
export const cctpSolTokenAccount = (owner: string): string => { pk(owner); return associatedTokenAddress(owner, cctpSolUsdc().id, TOKEN_PROGRAM); };

const T = CCTP_SOL_MESSAGE_TRANSMITTER, M = CCTP_SOL_TOKEN_MESSENGER_MINTER;
const pda = (program: string, ...seeds: (string | Uint8Array)[]) => findProgramAddress(seeds.map((s) => (typeof s === 'string' ? enc.encode(s) : s)), program);
const memo = new Map<string, string>();
const once = (k: string, f: () => string) => { let v = memo.get(k); if (!v) { v = f(); memo.set(k, v); } return v; };
/** Every program-derived address the three instructions need, from the pinned program ids and the seeds in Circle's source. */
export const cctpSolPda = {
  messageTransmitter: () => once('mt', () => pda(T, 'message_transmitter')),
  transmitterEventAuthority: () => once('mtev', () => pda(T, '__event_authority')),
  /** signs the CPI into the receiver: ["message_transmitter_authority", receiver program] */
  transmitterAuthority: () => once('mtauth', () => pda(T, 'message_transmitter_authority', pk(M))),
  usedNonce: (nonceHex: string) => { const n = hexToBytes(nonceHex); if (n.length !== 32) throw new Error('bad nonce'); return pda(T, 'used_nonce', n); },
  tokenMessenger: () => once('tm', () => pda(M, 'token_messenger')),
  tokenMinter: () => once('tmin', () => pda(M, 'token_minter')),
  senderAuthority: () => once('sa', () => pda(M, 'sender_authority')),
  messengerEventAuthority: () => once('mev', () => pda(M, '__event_authority')),
  /** exists only when Circle denylisted the owner: the burn then fails */
  denylist: (owner: string) => pda(M, 'denylist_account', pk(owner)),
  /** the remote domain as a decimal string, as in the source (`domain.to_string()`) */
  remoteTokenMessenger: (domain: number) => once(`rtm${domain}`, () => pda(M, 'remote_token_messenger', String(domain))),
  localToken: (mint: string) => once(`lt${mint}`, () => pda(M, 'local_token', pk(mint))),
  custody: (mint: string) => once(`cu${mint}`, () => pda(M, 'custody', pk(mint))),
  tokenPair: (domain: number, remoteTokenHex: string) => once(`tp${domain}${remoteTokenHex}`, () => { const t = hexToBytes(remoteTokenHex); if (t.length !== 32) throw new Error('bad remote token'); return pda(M, 'token_pair', String(domain), t); }),
};

/** deposit_for_burn: 18 accounts in the order of DepositForBurnContext (+ the two `#[event_cpi]` accounts), 96 bytes of data. */
export function cctpSolDepositForBurnIx(o: { owner: string; eventAccount: string; amount: bigint; destinationDomain: number; mintRecipientHex: string; maxFee: bigint; minFinalityThreshold: number }): SolIx {
  const mint = cctpSolUsdc().id, recipient = hexToBytes(o.mintRecipientHex);
  if (recipient.length !== 32 || recipient.every((b) => b === 0)) throw new Error('bad mint recipient');
  if (o.eventAccount === o.owner) throw new Error('the event account cannot be the wallet');
  const data = cat([hexToBytes(CCTP_SOL_DISC.depositForBurn), u64le(o.amount), u32le(o.destinationDomain), recipient, new Uint8Array(32) /* destination_caller: anyone */, u64le(o.maxFee), u32le(o.minFinalityThreshold)]);
  return { program: M, data, accounts: [
    { pubkey: o.owner, signer: true, writable: false }, { pubkey: o.owner, signer: true, writable: true } /* event_rent_payer */,
    ro(cctpSolPda.senderAuthority()), rw(cctpSolTokenAccount(o.owner)), ro(cctpSolPda.denylist(o.owner)), rw(cctpSolPda.messageTransmitter()), ro(cctpSolPda.tokenMessenger()),
    ro(cctpSolPda.remoteTokenMessenger(o.destinationDomain)), ro(cctpSolPda.tokenMinter()), rw(cctpSolPda.localToken(mint)), rw(mint),
    { pubkey: o.eventAccount, signer: true, writable: true }, ro(T), ro(M), ro(TOKEN_PROGRAM), ro(SYSTEM_PROGRAM), ro(cctpSolPda.messengerEventAuthority()), ro(M)] };
}

/**
 * receive_message for a USDC burn message: the 9 accounts of ReceiveMessageContext, then the 11 the token messenger's handler
 * takes (docs list 10; the deployed program also takes the fee recipient's token account, as the source and every real
 * transaction show). `payer` = `caller` = the wallet; it appears nowhere among the accounts handed on to the receiver.
 */
export function cctpSolReceiveIx(o: { payer: string; message: Uint8Array; attestation: Uint8Array; nonceHex: string; sourceDomain: number; burnTokenHex: string; recipientTokenAccount: string }): SolIx {
  const mint = cctpSolUsdc().id;
  const data = cat([hexToBytes(CCTP_SOL_DISC.receiveMessage), u32le(o.message.length), o.message, u32le(o.attestation.length), o.attestation]);
  return { program: T, data, accounts: [
    { pubkey: o.payer, signer: true, writable: true }, { pubkey: o.payer, signer: true, writable: false } /* caller */,
    ro(cctpSolPda.transmitterAuthority()), ro(cctpSolPda.messageTransmitter()), rw(cctpSolPda.usedNonce(o.nonceHex)), ro(M), ro(SYSTEM_PROGRAM), ro(cctpSolPda.transmitterEventAuthority()), ro(T),
    ro(cctpSolPda.tokenMessenger()), ro(cctpSolPda.remoteTokenMessenger(o.sourceDomain)), rw(cctpSolPda.tokenMinter()), rw(cctpSolPda.localToken(mint)), ro(cctpSolPda.tokenPair(o.sourceDomain, o.burnTokenHex)),
    rw(associatedTokenAddress(CCTP_SOL_FEE_RECIPIENT, mint, TOKEN_PROGRAM)), rw(o.recipientTokenAccount), rw(cctpSolPda.custody(mint)), ro(TOKEN_PROGRAM), ro(cctpSolPda.messengerEventAuthority()), ro(M)] };
}

/** reclaim_event_account: payee (signer, receives the rent), message_transmitter, the event account. Params: attestation, then the attested message. */
export function cctpSolReclaimIx(o: { payee: string; eventAccount: string; message: Uint8Array; attestation: Uint8Array }): SolIx {
  const data = cat([hexToBytes(CCTP_SOL_DISC.reclaimEventAccount), u32le(o.attestation.length), o.attestation, u32le(o.message.length), o.message]);
  return { program: T, data, accounts: [{ pubkey: o.payee, signer: true, writable: true }, rw(cctpSolPda.messageTransmitter()), rw(o.eventAccount)] };
}

/** Associated-token-account CreateIdempotent for the wallet's OWN USDC account, paid by the wallet. */
export function cctpSolCreateTokenAccountIx(owner: string): SolIx {
  const mint = cctpSolUsdc().id;
  return { program: ATA_PROGRAM, data: Uint8Array.of(1), accounts: [{ pubkey: owner, signer: true, writable: true }, rw(cctpSolTokenAccount(owner)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(TOKEN_PROGRAM)] };
}

const V1 = 0x81, V1_CONFIG_MASK = 0x0f;
/**
 * A Solana v1 message (SIMD-0385: every account inline, no lookup table, compute budget in the header) with one or more
 * signers. Key order: fee payer, the other signers (all writable here), writable accounts, read-only accounts, each in order
 * of first use. With no extra signer the bytes are those of compileSolV1Message (swap-sol.ts) — checked in tests.
 */
export function compileSolV1Signed(o: { payer: string; signers: string[]; blockhash: string; instructions: SolIx[]; computeUnitLimit: number; priorityFeeLamports: bigint; loadedAccountsDataSizeLimit: number }): Uint8Array {
  const signers = [o.payer, ...o.signers];
  if (new Set(signers).size !== signers.length) throw new Error('duplicate signer');
  const writable = new Set<string>(), order: string[] = [];
  const see = (k: string) => { if (!signers.includes(k) && !order.includes(k)) order.push(k); };
  for (const ix of o.instructions) {
    for (const a of ix.accounts) { if (a.signer && !signers.includes(a.pubkey)) throw new Error('instruction requires an unexpected signer'); see(a.pubkey); if (a.writable) writable.add(a.pubkey); }
    if (signers.includes(ix.program)) throw new Error('a signer cannot be a program');
    see(ix.program);
  }
  for (const s of o.signers) if (!writable.has(s) || !o.instructions.some((ix) => ix.accounts.some((a) => a.pubkey === s && a.signer))) throw new Error('an extra signer must sign for a writable account');
  const w = order.filter((k) => writable.has(k)), r = order.filter((k) => !writable.has(k));
  const keys = [...signers, ...w, ...r];
  if (keys.length > 64) throw new Error('too many accounts for a v1 transaction (64)');
  if (o.instructions.length > 64 || o.instructions.length === 0) throw new Error('bad instruction count');
  if (!Number.isInteger(o.computeUnitLimit) || o.computeUnitLimit < 1 || o.computeUnitLimit > 1_400_000) throw new Error('bad compute-unit limit');
  if (o.priorityFeeLamports < 0n || o.priorityFeeLamports >= 1n << 64n) throw new Error('bad priority fee');
  const idx = (k: string) => { const n = keys.indexOf(k); if (n < 0) throw new Error('unknown key'); return n; };
  const head = new Uint8Array(42), dv = new DataView(head.buffer);
  head[0] = V1; head[1] = signers.length; head[2] = 0; head[3] = r.length;
  dv.setUint32(4, V1_CONFIG_MASK, true);
  head.set(pk(o.blockhash), 8);
  head[40] = o.instructions.length; head[41] = keys.length;
  const cfg = new Uint8Array(16), cv = new DataView(cfg.buffer);
  cv.setBigUint64(0, o.priorityFeeLamports, true); cv.setUint32(8, o.computeUnitLimit, true); cv.setUint32(12, o.loadedAccountsDataSizeLimit, true);
  const headers: Uint8Array[] = [], payloads: Uint8Array[] = [];
  for (const ix of o.instructions) {
    if (ix.accounts.length > 255 || ix.data.length > 0xffff) throw new Error('instruction too large');
    const h = new Uint8Array(4); h[0] = idx(ix.program); h[1] = ix.accounts.length; new DataView(h.buffer).setUint16(2, ix.data.length, true);
    headers.push(h); payloads.push(Uint8Array.from(ix.accounts.map((a) => idx(a.pubkey))), ix.data);
  }
  const out = cat([head, ...keys.map(pk), cfg, ...headers, ...payloads]);
  if (out.length + 64 * signers.length > 4096) throw new Error('transaction larger than 4096 bytes');
  return out;
}
/** v1 wire format: the message, then one 64-byte signature per signer, in the order of the signer keys. */
export function solV1WireSigned(signatures: Uint8Array[], message: Uint8Array): Uint8Array {
  if (message[0] !== V1 || message[1] !== signatures.length || signatures.length < 1 || signatures.some((s) => s.length !== 64)) throw new Error('bad v1 transaction');
  return cat([message, ...signatures]);
}

/** The message bytes stored in a MessageSent event account (as the chain or a simulation returns it), with who paid its rent and when. */
export function decodeCctpSolEventAccount(data: Uint8Array): { rentPayer: string; createdAt: number; message: Uint8Array } {
  if (data.length < 52 || Buffer.from(data.subarray(0, 8)).toString('hex') !== CCTP_SOL_DISC.messageSentAccount) throw new Error('not a MessageSent account');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), len = dv.getUint32(48, true);
  if (52 + len > data.length) throw new Error('truncated MessageSent account');
  return { rentPayer: base58.encode(data.subarray(8, 40)), createdAt: Number(dv.getBigInt64(40, true)), message: data.slice(52, 52 + len) };
}
