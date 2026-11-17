// NFT delivery 2 — Solana. The signer builds the COMPLETE transaction of an NFT intent here: a legacy message (every account
// inline, no address lookup table), fee payer = the wallet, and exactly this instruction list — nothing can be added to it:
//
//   [0] ComputeBudget SetComputeUnitLimit(limit)                     ┐ both always present, both from the intent,
//   [1] ComputeBudget SetComputeUnitPrice(micro-lamports)            ┘ bounded by the schema, by MAX_CU_PRICE and by the policy
//   then, by standard:
//   spl-token-2022            [2] ATA CreateIdempotent(payer, recipient ATA, recipient, mint)   only when `sol.createAta`
//                             [n] Token-2022 TransferChecked(source ATA, mint, recipient ATA, owner) amount 1, decimals 0
//   metaplex-token-metadata   [2] Token Metadata Transfer (discriminator 49, TransferArgs::V1 { amount: 1, authorization_data: None })
//   metaplex-pnft             [2] the same instruction with both token records and, when the pNFT has one, its rule set
//   metaplex-core             [2] Core TransferV1 (discriminator 14, compression_proof: None)
//
// Account lists follow the official Shank IDLs (mpl-token-metadata `idls/token_metadata.json` 1.14.0, instruction "Transfer",
// 17 accounts; mpl-core `idls/mpl_core.json` 0.2.0 / program 0.4.2, instruction "TransferV1", 7 accounts — read 2026-11-17). An
// optional account that is absent is the program's own id, as those programs define. Every address is either a pinned
// constant, derived here (associated token accounts, metadata / edition / token-record PDAs), or a frozen intent field shown
// to the owner (`to`, `asset`, `sol.ruleSet`, `sol.collection`). The recent blockhash is the only other chain-derived input.
//
// `verifyNftSolMessage` is an independent reader of message bytes (its own decoder): one signer = the wallet, only pinned
// programs, the exact instruction list, the exact writable set. The signer runs it on its own output before signing.
import { base58 } from '@scure/base';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import { ATA_PROGRAM, associatedTokenAddress, COMPUTE_BUDGET_PROGRAM, findProgramAddress, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './build-sol.ts';
import { getNetwork } from './networks.ts';
import { NftRefusal, type NftIntent } from './nft-intent.ts';

export const NFT_TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const NFT_TOKEN_AUTH_RULES_PROGRAM = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
export const NFT_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
/** Every program an NFT transaction of this wallet may invoke or name. Nothing outside this list can appear as a program id. */
export const NFT_SOL_PINNED = { tokenMetadata: NFT_TOKEN_METADATA_PROGRAM, tokenAuthRules: NFT_TOKEN_AUTH_RULES_PROGRAM, core: NFT_CORE_PROGRAM, splToken: TOKEN_PROGRAM, token2022: TOKEN_2022_PROGRAM,
  associatedToken: ATA_PROGRAM, system: SYSTEM_PROGRAM, sysvarInstructions: SYSVAR_INSTRUCTIONS, computeBudget: COMPUTE_BUDGET_PROGRAM } as const;
/** Hard ceiling of the priority price (micro-lamports per compute unit), whatever the policy says. */
export const NFT_SOL_MAX_CU_PRICE = 5_000_000n;
export const NFT_SOL_SIGNATURE_FEE = 5000n;

const enc = new TextEncoder();
const refuse = (code: string, msg: string): never => { throw new NftRefusal(code, msg); };
const pk = (s: string) => base58.decode(s);
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...a: (Uint8Array | number[])[]) => Uint8Array.from(a.flatMap((x) => Array.from(x)));
function compactU16(n: number): number[] { const out: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); return out; } out.push(b | 0x80); } }

export const nftMetadataPda = (mint: string) => findProgramAddress([enc.encode('metadata'), pk(NFT_TOKEN_METADATA_PROGRAM), pk(mint)], NFT_TOKEN_METADATA_PROGRAM);
export const nftEditionPda = (mint: string) => findProgramAddress([enc.encode('metadata'), pk(NFT_TOKEN_METADATA_PROGRAM), pk(mint), enc.encode('edition')], NFT_TOKEN_METADATA_PROGRAM);
export const nftTokenRecordPda = (mint: string, tokenAccount: string) =>
  findProgramAddress([enc.encode('metadata'), pk(NFT_TOKEN_METADATA_PROGRAM), pk(mint), enc.encode('token_record'), pk(tokenAccount)], NFT_TOKEN_METADATA_PROGRAM);

export interface NftSolMeta { pubkey: string; signer: boolean; writable: boolean }
export interface NftSolIx { program: string; accounts: NftSolMeta[]; data: Uint8Array }
const ro = (pubkey: string): NftSolMeta => ({ pubkey, signer: false, writable: false });
const rw = (pubkey: string): NftSolMeta => ({ pubkey, signer: false, writable: true });

export interface NftSolPlan {
  ixs: NftSolIx[]; fee: bigint;
  /** what the review sheet shows: every account the main instruction touches, by role */
  accounts: { role: string; address: string; derived: 'intent' | 'derived' | 'pinned' }[];
  sourceToken: string | null; destinationToken: string | null; ownerTokenRecord: string | null; destinationTokenRecord: string | null;
}

/** Every check of a Solana NFT intent that needs no chain state, and the canonical instruction list. Throws an NftRefusal. */
export function planNftSol(i: NftIntent): NftSolPlan {
  let n; try { n = getNetwork(i.network); } catch { return refuse('nft_wrong_chain', 'unknown network'); }
  if (n.family !== 'sol' || !i.sol || i.evm) refuse('nft_section_mismatch', 'not a Solana NFT intent');
  if (i.chainRef !== n.chainRef) refuse('nft_wrong_chain', 'cluster identity does not match the network');
  const s = i.sol!, std = i.standard;
  if (std === 'erc721' || std === 'erc1155') refuse('nft_standard_network_mismatch', `${std} is not a Solana standard`);
  if (i.tokenId !== undefined) refuse('nft_bad_token_id', 'a Solana NFT has no token id: the mint or asset address is its identity');
  const addr = (v: string, what: string): string => { try { if (normalizeAddress(i.network, v) !== v) throw new Error('not canonical'); return v; } catch (e) { return refuse(`nft_bad_${what}`, `invalid ${what}: ${(e as Error).message}`); } };
  const asset = addr(i.asset, 'asset'), from = addr(i.from, 'source'), to = addr(i.to, 'destination');
  if (baseUnits(i.quantity) !== 1n) refuse('nft_bad_quantity', 'a Solana NFT transfer moves exactly one unit');
  if (to === from) refuse('nft_self_send', 'the destination is the wallet itself');
  const core = std === 'metaplex-core', tm = std === 'metaplex-token-metadata' || std === 'metaplex-pnft', pnft = std === 'metaplex-pnft';
  // sections that do not belong to the standard are refused rather than ignored: the owner approved exactly what is used
  if (core ? s.tokenProgram !== undefined : s.tokenProgram === undefined) refuse('nft_section_mismatch', core ? 'a Core asset has no token program' : 'the token program of the mint is required');
  if (std === 'spl-token-2022' ? s.tokenProgram !== 'token2022' || s.createAta === undefined : s.createAta !== undefined) refuse('nft_section_mismatch', 'createAta belongs to a Token-2022 transfer only, which names the Token-2022 program');
  if (!pnft && s.ruleSet !== undefined) refuse('nft_section_mismatch', 'a rule set belongs to a programmable NFT only');
  if (!core && s.collection !== undefined) refuse('nft_section_mismatch', 'a collection account belongs to a Core transfer only');
  const tp = s.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const program = core ? NFT_CORE_PROGRAM : tm ? NFT_TOKEN_METADATA_PROGRAM : tp;
  if (i.program !== program) refuse('nft_program_mismatch', `the program of a ${std} transfer is ${program}`);
  const ruleSet = s.ruleSet !== undefined ? addr(s.ruleSet, 'rule_set') : null, collection = s.collection !== undefined ? addr(s.collection, 'collection') : null;

  const price = baseUnits(s.computeUnitPrice);
  if (price > NFT_SOL_MAX_CU_PRICE) refuse('nft_compute_cap', 'compute-unit price above the ceiling');
  const fee = NFT_SOL_SIGNATURE_FEE + (BigInt(s.computeUnitLimit) * price + 999_999n) / 1_000_000n;
  if (fee > baseUnits(i.maxFee)) refuse('nft_fee_exceeds_max', 'fee exceeds the approved maximum');
  let bh: Uint8Array; try { bh = pk(s.recentBlockhash); } catch { return refuse('nft_bad_blockhash', 'malformed blockhash'); }
  if (bh.length !== 32 || bh.every((b) => b === 0)) refuse('nft_bad_blockhash', 'malformed blockhash');

  const ixs: NftSolIx[] = [
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([2], u32le(s.computeUnitLimit)) },
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([3], u64le(price)) },
  ];
  const signer: NftSolMeta = { pubkey: from, signer: true, writable: true };
  const accounts: NftSolPlan['accounts'] = [];
  let sourceToken: string | null = null, destinationToken: string | null = null, ownerTokenRecord: string | null = null, destinationTokenRecord: string | null = null;
  const reserved = new Set<string>([...Object.values(NFT_SOL_PINNED), asset, from]);
  if (core) {
    if (collection) reserved.add(collection);
    // IDL order: asset (w), collection (optional), payer (w, signer), authority (optional signer), newOwner, systemProgram (optional), logWrapper (optional)
    ixs.push({ program: NFT_CORE_PROGRAM, data: Uint8Array.of(14, 0),
      accounts: [rw(asset), ro(collection ?? NFT_CORE_PROGRAM), signer, signer, ro(to), ro(SYSTEM_PROGRAM), ro(NFT_CORE_PROGRAM)] });
    accounts.push({ role: 'asset', address: asset, derived: 'intent' }, ...(collection ? [{ role: 'collection', address: collection, derived: 'intent' as const }] : []), { role: 'payer and authority', address: from, derived: 'derived' },
      { role: 'new owner', address: to, derived: 'intent' }, { role: 'program', address: NFT_CORE_PROGRAM, derived: 'pinned' });
  } else {
    sourceToken = associatedTokenAddress(from, asset, tp); destinationToken = associatedTokenAddress(to, asset, tp);
    reserved.add(sourceToken); reserved.add(destinationToken);
    if (!tm) {
      if (s.createAta) ixs.push({ program: ATA_PROGRAM, data: Uint8Array.of(1), accounts: [signer, rw(destinationToken), ro(to), ro(asset), ro(SYSTEM_PROGRAM), ro(tp)] });
      ixs.push({ program: tp, data: cat([12], u64le(1n), [0]), accounts: [rw(sourceToken), ro(asset), rw(destinationToken), signer] });
      accounts.push({ role: 'source token account', address: sourceToken, derived: 'derived' }, { role: 'mint', address: asset, derived: 'intent' }, { role: 'destination token account', address: destinationToken, derived: 'derived' },
        { role: 'owner', address: from, derived: 'derived' }, { role: 'destination owner', address: to, derived: 'intent' }, { role: 'program', address: tp, derived: 'pinned' });
    } else {
      const metadata = nftMetadataPda(asset), edition = nftEditionPda(asset), none = ro(NFT_TOKEN_METADATA_PROGRAM);
      reserved.add(metadata); reserved.add(edition);
      if (pnft) { ownerTokenRecord = nftTokenRecordPda(asset, sourceToken); destinationTokenRecord = nftTokenRecordPda(asset, destinationToken); reserved.add(ownerTokenRecord); reserved.add(destinationTokenRecord); }
      if (ruleSet) reserved.add(ruleSet);
      // IDL order (17): token, tokenOwner, destination, destinationOwner, mint, metadata, edition, ownerTokenRecord, destinationTokenRecord,
      // authority, payer, systemProgram, sysvarInstructions, splTokenProgram, splAtaProgram, authorizationRulesProgram, authorizationRules
      ixs.push({ program: NFT_TOKEN_METADATA_PROGRAM, data: cat([49, 0], u64le(1n), [0]),
        accounts: [rw(sourceToken), ro(from), rw(destinationToken), ro(to), ro(asset), rw(metadata), ro(edition), pnft ? rw(ownerTokenRecord!) : none, pnft ? rw(destinationTokenRecord!) : none,
          signer, signer, ro(SYSTEM_PROGRAM), ro(SYSVAR_INSTRUCTIONS), ro(tp), ro(ATA_PROGRAM), ruleSet ? ro(NFT_TOKEN_AUTH_RULES_PROGRAM) : none, ruleSet ? ro(ruleSet) : none] });
      accounts.push({ role: 'source token account', address: sourceToken, derived: 'derived' }, { role: 'destination token account', address: destinationToken, derived: 'derived' }, { role: 'destination owner', address: to, derived: 'intent' },
        { role: 'mint', address: asset, derived: 'intent' }, { role: 'metadata', address: metadata, derived: 'derived' }, { role: 'edition', address: edition, derived: 'derived' },
        ...(pnft ? [{ role: 'owner token record', address: ownerTokenRecord!, derived: 'derived' as const }, { role: 'destination token record', address: destinationTokenRecord!, derived: 'derived' as const }] : []),
        ...(ruleSet ? [{ role: 'rule set', address: ruleSet, derived: 'intent' as const }, { role: 'rule set program', address: NFT_TOKEN_AUTH_RULES_PROGRAM, derived: 'pinned' as const }] : []),
        { role: 'authority and payer', address: from, derived: 'derived' }, { role: 'token program', address: tp, derived: 'pinned' }, { role: 'program', address: NFT_TOKEN_METADATA_PROGRAM, derived: 'pinned' });
    }
  }
  // the destination is a wallet: never a program, the asset, one of the accounts of this very transfer, or the wallet itself
  if (reserved.has(to)) refuse('nft_bad_destination', 'the destination is a program, the asset itself or an account of this transfer');
  if (ruleSet && [...Object.values(NFT_SOL_PINNED), asset, from, to].includes(ruleSet)) refuse('nft_bad_rule_set', 'the rule set is not a rule set account');
  if (collection && [...Object.values(NFT_SOL_PINNED), asset, from, to].includes(collection)) refuse('nft_bad_collection', 'the collection is not a collection account');
  return { ixs, fee, accounts, sourceToken, destinationToken, ownerTokenRecord, destinationTokenRecord };
}

/** Compile a legacy message with ONE signer (the fee payer). Order: payer, writable non-signers, read-only non-signers — each in order of first use. */
export function compileNftSolMessage(payer: string, ixs: NftSolIx[], recentBlockhash: string): Uint8Array {
  const flags = new Map<string, { writable: boolean }>();
  for (const ix of ixs) {
    for (const a of ix.accounts) {
      if (a.signer && a.pubkey !== payer) throw new NftRefusal('nft_extra_signer', 'only the wallet signs an NFT transfer');
      if (a.pubkey === payer) continue;
      const f = flags.get(a.pubkey); if (f) f.writable ||= a.writable; else flags.set(a.pubkey, { writable: a.writable });
    }
    if (ix.program === payer) throw new NftRefusal('nft_unknown_program', 'the wallet is not a program');
    if (!flags.has(ix.program)) flags.set(ix.program, { writable: false });
  }
  const writable = [...flags].filter(([, f]) => f.writable).map(([k]) => k), readonly = [...flags].filter(([, f]) => !f.writable).map(([k]) => k);
  const keys = [payer, ...writable, ...readonly];
  const idx = (k: string) => keys.indexOf(k);
  const body: (Uint8Array | number[])[] = [[1, 0, readonly.length], compactU16(keys.length)];
  for (const k of keys) body.push(pk(k));
  body.push(pk(recentBlockhash), compactU16(ixs.length));
  for (const ix of ixs) body.push([idx(ix.program)], compactU16(ix.accounts.length), ix.accounts.map((a) => idx(a.pubkey)), compactU16(ix.data.length), ix.data);
  return cat(...body);
}

/** Build the exact message bytes of a Solana NFT intent. */
export function buildNftSolMessage(i: NftIntent): Uint8Array {
  const plan = planNftSol(i);
  return compileNftSolMessage(i.from, plan.ixs, i.sol!.recentBlockhash);
}

export interface DecodedSolMessage { signers: number; readonlySigned: number; readonlyUnsigned: number; keys: string[]; recentBlockhash: string; ixs: { program: string; accounts: string[]; data: Uint8Array }[] }
/** A strict legacy-message decoder of its own (no dependency on the compiler above): every byte is consumed, nothing is skipped. */
export function decodeNftSolMessage(msg: Uint8Array): DecodedSolMessage {
  let o = 0;
  const need = (n: number) => { if (o + n > msg.length) throw new NftRefusal('nft_message_malformed', 'truncated message'); };
  const u8 = () => { need(1); return msg[o++]!; };
  const cu16 = () => { let v = 0, shift = 0; for (let k = 0; k < 3; k++) { const b = u8(); v |= (b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7; } throw new NftRefusal('nft_message_malformed', 'bad length prefix'); };
  const take = (n: number) => { need(n); const b = msg.slice(o, o + n); o += n; return b; };
  if (msg.length === 0 || msg[0]! & 0x80) throw new NftRefusal('nft_message_versioned', 'only legacy messages are signed for NFT transfers (no address lookup tables)');
  const signers = u8(), readonlySigned = u8(), readonlyUnsigned = u8();
  const nKeys = cu16(), keys: string[] = [];
  for (let k = 0; k < nKeys; k++) keys.push(base58.encode(take(32)));
  if (new Set(keys).size !== keys.length) throw new NftRefusal('nft_message_malformed', 'duplicate account keys');
  const recentBlockhash = base58.encode(take(32));
  const nIx = cu16(), ixs: DecodedSolMessage['ixs'] = [];
  const key = (k: number) => { const v = keys[k]; if (v === undefined) throw new NftRefusal('nft_message_malformed', 'account index out of range'); return v; };
  for (let k = 0; k < nIx; k++) { const program = key(u8()), n = cu16(), accounts: string[] = []; for (let j = 0; j < n; j++) accounts.push(key(u8())); ixs.push({ program, accounts, data: take(cu16()) }); }
  if (o !== msg.length) throw new NftRefusal('nft_message_malformed', 'trailing bytes after the last instruction');
  return { signers, readonlySigned, readonlyUnsigned, keys, recentBlockhash, ixs };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, k) => v === b[k]);
/**
 * Independent reading of message bytes that claim to be the transfer of `i`: one signer (the wallet, fee payer), the intent's
 * blockhash, only pinned programs, exactly the canonical instructions (program, account order, data), exactly the canonical
 * writable set, no account that is not used. Throws an NftRefusal naming the first difference.
 */
export function verifyNftSolMessage(msg: Uint8Array, i: NftIntent): void {
  const plan = planNftSol(i), d = decodeNftSolMessage(msg);
  if (d.signers !== 1 || d.readonlySigned !== 0) refuse('nft_extra_signer', 'an NFT transfer has exactly one signer');
  if (d.keys[0] !== i.from) refuse('nft_wrong_source', 'the fee payer is not the wallet');
  if (d.recentBlockhash !== i.sol!.recentBlockhash) refuse('nft_bad_blockhash', 'the blockhash differs from the intent');
  const pinned = new Set<string>(Object.values(NFT_SOL_PINNED));
  for (const ix of d.ixs) if (!pinned.has(ix.program)) refuse('nft_unknown_program', `program ${ix.program} is not one of the pinned programs`);
  if (d.ixs.length !== plan.ixs.length) refuse('nft_instruction_count', `expected ${plan.ixs.length} instructions, found ${d.ixs.length}`);
  plan.ixs.forEach((want, k) => {
    const got = d.ixs[k]!;
    if (got.program !== want.program) refuse('nft_instruction_program', `instruction ${k} calls ${got.program}, expected ${want.program}`);
    if (got.accounts.length !== want.accounts.length || got.accounts.some((a, j) => a !== want.accounts[j]!.pubkey)) refuse('nft_instruction_accounts', `instruction ${k} does not carry the canonical account list`);
    if (!sameBytes(got.data, want.data)) refuse('nft_instruction_data', `instruction ${k} does not carry the canonical data`);
  });
  // writable / read-only, as the message header declares them, against the canonical flags
  const wantWritable = new Set<string>([i.from]), used = new Set<string>([i.from]);
  for (const ix of plan.ixs) { used.add(ix.program); for (const a of ix.accounts) { used.add(a.pubkey); if (a.writable) wantWritable.add(a.pubkey); } }
  if (d.keys.length !== used.size || d.keys.some((k) => !used.has(k))) refuse('nft_extra_account', 'the message names an account the transfer does not use');
  const firstReadonly = d.keys.length - d.readonlyUnsigned;
  d.keys.forEach((k, j) => { if ((j < firstReadonly) !== wantWritable.has(k)) refuse('nft_account_flags', `account ${k} is not ${wantWritable.has(k) ? 'writable' : 'read-only'} as the canonical transfer requires`); });
}

/** Wire format: one signature + the message (same as an ordinary legacy Solana transaction). */
export function nftSolWire(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('bad signature length');
  return cat([1], signature, message);
}
