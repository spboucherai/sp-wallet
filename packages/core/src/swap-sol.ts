// Solana same-chain swaps through the Jupiter aggregator program (Swap API V2 "Router", GET /build — labelled "Metis").
//
// Jupiter's answer is NOT trusted. The API assembles a Solana **v1 transaction** (SIMD-0385: every account address is
// inline, there are NO address lookup tables, the compute budget sits in the message header) and the signer decodes the
// exact message bytes itself. Refusing v0 removes the lookup-table problem altogether: a table's content cannot be
// verified offline, and with v1 there is nothing behind a table — every account the transaction can touch is visible.
//
// What the decoder proves, from the bytes alone:
//   - one required signature, the fee payer, and it is the wallet; a blockhash; a bounded priority fee;
//   - the instruction list is exactly: [ATA CreateIdempotent for the wallet's own account of the input/output mint]*,
//     [System.Transfer wallet -> its own wSOL account for exactly the input amount, Token.SyncNative] when SOL is sold,
//     ONE Jupiter instruction, `shared_accounts_route_v2` only, [Token.CloseAccount of the wallet's wSOL account
//     back to the wallet] when SOL is sold or bought. Nothing else: no other program, no transfer, approve or authority change;
//   - in the Jupiter instruction: authority = wallet, source = the wallet's associated token account of the input mint,
//     destination = the wallet's associated token account of the output mint, both mints and their token programs, no
//     alternate destination, `in_amount` = the approved amount, floor(quoted_out × (10 000 − slippage_bps) / 10 000) ≥ the
//     approved minimum, `platform_fee_bps` = 0, `positive_slippage_bps` = 0;
//   - among the route's remaining accounts: neither the wallet nor its source/destination account, and nowhere in the
//     transaction any other registry token account of the wallet. The wallet's signature therefore authorises one thing
//     only: the program's own pull of `in_amount` from the source account. `route_v2` (venue programs act with the
//     wallet's signature) is refused; the API rewrites such routes into the shared-accounts form before asking.
//
// What it cannot prove (residual trust, see docs/swap/providers/jupiter.md): the aggregator program's own behaviour. The
// program's source was not read and it is upgradeable; its layout is taken from its on-chain IDL and its behaviour was checked by
// simulation. It is the program that takes at most `in_amount` and reverts below the minimum. The API pins the program's
// last deployment (JUPITER_PIN) and refuses to prepare a swap if it changed.
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { baseUnits } from './amounts.ts';
import { ATA_PROGRAM, associatedTokenAddress, findProgramAddress, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tokenProgramOf } from './build-sol.ts';
import { getAsset, getNetwork } from './networks.ts';
import type { Intent } from './intent.ts';

export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** PDA ["__event_authority"] of the program (constant in the on-chain IDL). */
export const JUPITER_EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/**
 * The reviewed deployment of the aggregator program, read on two RPC endpoints on 2026-11-10. The program is upgradeable:
 * whoever holds `upgradeAuthority` can replace it. An upgrade rewrites the ProgramData header (`lastDeploySlot`), so the
 * API refuses to prepare a swap unless the header still shows this slot and authority on every endpoint, and periodically
 * re-hashes the whole executable.
 */
export const JUPITER_PIN = {
  programData: '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT',
  lastDeploySlot: 462802085,
  upgradeAuthority: 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ',
  /** SHA-256 of the executable bytes (ProgramData account data after its 45-byte header), 2 892 224 bytes */
  codeSha256: '53d53f447f594158a259cbdca1f5e613caf40bc14ce759ffd5953580dc2af8dd',
  reviewed: '2026-11-10: on-chain IDL read (route_v2, shared_accounts_route_v2), behaviour checked by mainnet simulation (scripts/sim-jupiter.mts)',
} as const;

/** Anchor discriminators = sha256("global:<name>")[0..8]; both instructions are in the program's on-chain IDL. */
const DISC_ROUTE_V2 = 'bb64facc31c4af14', DISC_SHARED_ROUTE_V2 = 'd19853937cfed8e9';
export const RENT_TOKEN_ACCOUNT = 2_039_280n; // bound: rent-exempt minimum of a 165-byte SPL Token account at the historical rate (1 488 440 measured on 2026-11-10)
/** Token-2022 accounts carry extensions; this bounds an account of up to 231 bytes at the historical rent rate. */
export const RENT_TOKEN2022_ACCOUNT_MAX = 2_498_640n;
export const SOL_SIGNATURE_FEE = 5000n;
const MAX_COMPUTE_UNITS = 1_400_000, MAX_LOADED_ACCOUNTS_DATA = 64 * 1024 * 1024;
/** v1 config mask: priority fee (bits 0-1), compute-unit limit (bit 2), loaded-accounts data size limit (bit 3). No heap request. */
const V1_CONFIG_MASK = 0x0f;
const V1_VERSION_BYTE = 0x81;

export interface SolIxInput { program: string; accounts: { pubkey: string; signer: boolean; writable: boolean }[]; data: Uint8Array }
export interface SolV1Ix { program: string; accounts: string[]; data: Uint8Array }
export interface SolV1Message {
  payer: string; blockhash: string; priorityFeeLamports: bigint; computeUnitLimit: number; loadedAccountsDataSizeLimit: number;
  keys: string[]; numSigners: number; numReadonlySigned: number; numReadonlyUnsigned: number; instructions: SolV1Ix[];
}

const cat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const pk = (s: string) => { const b = base58.decode(s); if (b.length !== 32) throw new Error('bad public key'); return b; };

/** base58 form of a 32-byte key or blockhash */
export const solAddress = (b: Uint8Array): string => { if (b.length !== 32) throw new Error('bad public key'); return base58.encode(b); };
/** sha256 of the message bytes, lowercase hex: this is what the approved intent commits to. */
export const solMessageHash = (msg: Uint8Array): string => hex(sha256(msg));
/** v1 wire format: the message, then the signatures (no count prefix: the count is the first header byte). */
export function solV1Wire(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== 64 || message[0] !== V1_VERSION_BYTE || message[1] !== 1) throw new Error('bad v1 transaction');
  return cat([message, signature]);
}

/**
 * Assemble a v1 message with a single signer (the fee payer). Key order: payer, writable accounts, read-only accounts, each
 * in order of first use. Throws if any instruction asks for another signer.
 */
export function compileSolV1Message(o: { payer: string; blockhash: string; instructions: SolIxInput[]; computeUnitLimit: number; priorityFeeLamports: bigint; loadedAccountsDataSizeLimit: number }): Uint8Array {
  const writable = new Set<string>(), order: string[] = [];
  const see = (k: string) => { if (k !== o.payer && !order.includes(k)) order.push(k); };
  for (const ix of o.instructions) {
    for (const a of ix.accounts) { if (a.signer && a.pubkey !== o.payer) throw new Error('instruction requires another signer'); see(a.pubkey); if (a.writable) writable.add(a.pubkey); }
    see(ix.program);
  }
  const w = order.filter((k) => writable.has(k)), r = order.filter((k) => !writable.has(k));
  const keys = [o.payer, ...w, ...r];
  if (keys.length > 64) throw new Error('too many accounts for a v1 transaction (64)');
  if (o.instructions.length > 64 || o.instructions.length === 0) throw new Error('bad instruction count');
  const idx = (k: string) => { const n = keys.indexOf(k); if (n < 0) throw new Error('unknown key'); return n; };
  const head = new Uint8Array(1 + 3 + 4 + 32 + 2), dv = new DataView(head.buffer);
  head[0] = V1_VERSION_BYTE; head[1] = 1; head[2] = 0; head[3] = r.length;
  dv.setUint32(4, V1_CONFIG_MASK, true);
  const bh = pk(o.blockhash); head.set(bh, 8);
  head[40] = o.instructions.length; head[41] = keys.length;
  const cfg = new Uint8Array(16), cv = new DataView(cfg.buffer);
  if (o.priorityFeeLamports < 0n || o.priorityFeeLamports >= 1n << 64n) throw new Error('bad priority fee');
  cv.setBigUint64(0, o.priorityFeeLamports, true); cv.setUint32(8, o.computeUnitLimit, true); cv.setUint32(12, o.loadedAccountsDataSizeLimit, true);
  const headers: Uint8Array[] = [], payloads: Uint8Array[] = [];
  for (const ix of o.instructions) {
    if (ix.accounts.length > 255 || ix.data.length > 0xffff) throw new Error('instruction too large');
    const h = new Uint8Array(4); h[0] = idx(ix.program); h[1] = ix.accounts.length; new DataView(h.buffer).setUint16(2, ix.data.length, true);
    headers.push(h); payloads.push(Uint8Array.from(ix.accounts.map((a) => idx(a.pubkey))), ix.data);
  }
  const out = cat([head, ...keys.map(pk), cfg, ...headers, ...payloads]);
  if (out.length + 64 > 4096) throw new Error('transaction larger than 4096 bytes');
  return out;
}

/** Strict decoder of a v1 message: exact length, known config mask, unique keys, indices in range. Throws otherwise. */
export function decodeSolV1Message(msg: Uint8Array): SolV1Message {
  if (msg.length < 42 + 32 + 16 || msg.length + 64 > 4096) throw new Error('message size out of range');
  if (msg[0] !== V1_VERSION_BYTE) throw new Error('not a v1 transaction message (lookup-table transactions are refused)');
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const numSigners = msg[1]!, numReadonlySigned = msg[2]!, numReadonlyUnsigned = msg[3]!;
  if (dv.getUint32(4, true) !== V1_CONFIG_MASK) throw new Error('unexpected transaction config mask');
  const blockhash = base58.encode(msg.subarray(8, 40));
  const nIx = msg[40]!, nKeys = msg[41]!;
  if (nIx < 1 || nIx > 64 || nKeys < 2 || nKeys > 64) throw new Error('instruction or account count out of range');
  if (numSigners < 1 || numSigners > nKeys || numReadonlySigned >= numSigners || numReadonlyUnsigned > nKeys - numSigners) throw new Error('bad message header');
  let o = 42;
  const need = (n: number) => { if (o + n > msg.length) throw new Error('truncated message'); };
  need(nKeys * 32 + 16 + nIx * 4);
  const keys: string[] = [];
  for (let k = 0; k < nKeys; k++, o += 32) keys.push(base58.encode(msg.subarray(o, o + 32)));
  if (new Set(keys).size !== keys.length) throw new Error('duplicate account keys');
  const priorityFeeLamports = dv.getBigUint64(o, true), computeUnitLimit = dv.getUint32(o + 8, true), loadedAccountsDataSizeLimit = dv.getUint32(o + 12, true); o += 16;
  const heads: { p: number; n: number; d: number }[] = [];
  for (let k = 0; k < nIx; k++, o += 4) heads.push({ p: msg[o]!, n: msg[o + 1]!, d: dv.getUint16(o + 2, true) });
  const instructions: SolV1Ix[] = [];
  for (const h of heads) {
    need(h.n + h.d);
    if (h.p >= nKeys || h.p === 0) throw new Error('bad program index');
    const accounts: string[] = [];
    for (let k = 0; k < h.n; k++) { const a = msg[o + k]!; if (a >= nKeys) throw new Error('bad account index'); accounts.push(keys[a]!); }
    o += h.n;
    instructions.push({ program: keys[h.p]!, accounts, data: msg.slice(o, o + h.d) }); o += h.d;
  }
  if (o !== msg.length) throw new Error('trailing bytes after the message');
  return { payer: keys[0]!, blockhash, priorityFeeLamports, computeUnitLimit, loadedAccountsDataSizeLimit, keys, numSigners, numReadonlySigned, numReadonlyUnsigned, instructions };
}

/** The minimum output the signer relies on: never above what the program enforces (floor of the exact product). */
export const jupiterMinOut = (quotedOut: bigint, slippageBps: number): bigint => (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
/** Program authority PDAs: seeds ["authority", id]. */
export const jupiterProgramAuthority = (id: number): string => findProgramAddress([new TextEncoder().encode('authority'), Uint8Array.of(id)], JUPITER_PROGRAM);

export interface JupiterRoute { kind: 'route_v2' | 'shared_accounts_route_v2'; inAmount: bigint; quotedOut: bigint; slippageBps: number; minOut: bigint; legs: number; accounts: number }
/** Decode the fixed head of a whitelisted Jupiter instruction. The route plan after it stays opaque. */
export function decodeJupiterRoute(data: Uint8Array, accounts: number): JupiterRoute & { authorityId: number | null } {
  const disc = hex(data.subarray(0, 8));
  const shared = disc === DISC_SHARED_ROUTE_V2;
  if (!shared && disc !== DISC_ROUTE_V2) throw new Error('Jupiter instruction type is not allowed');
  const o = shared ? 9 : 8;
  if (data.length < o + 26 + 5) throw new Error('Jupiter instruction data too short');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const inAmount = dv.getBigUint64(o, true), quotedOut = dv.getBigUint64(o + 8, true);
  const slippageBps = dv.getUint16(o + 16, true), platformFeeBps = dv.getUint16(o + 18, true), positiveSlippageBps = dv.getUint16(o + 20, true), legs = dv.getUint32(o + 22, true);
  if (platformFeeBps !== 0) throw new Error('Jupiter instruction carries a platform fee');
  if (positiveSlippageBps !== 0) throw new Error('Jupiter instruction carries a positive-slippage fee');
  if (slippageBps > 10_000) throw new Error('slippage out of range');
  if (legs < 1 || legs > 32) throw new Error('route plan length out of range');
  return { kind: shared ? 'shared_accounts_route_v2' : 'route_v2', authorityId: shared ? data[8]! : null, inAmount, quotedOut, slippageBps, minOut: jupiterMinOut(quotedOut, slippageBps), legs, accounts };
}

export interface JupiterSwapFacts extends JupiterRoute {
  message: SolV1Message; sourceAccount: string; destinationAccount: string; inMint: string; outMint: string;
  /** token accounts the transaction may create and leave open (rent stays in the wallet's own account) */
  creates: string[]; wrapsSol: boolean; unwrapsSol: boolean;
  /** signature fee + priority fee, exact */ networkFee: bigint; /** upper bound of the rent locked in accounts created and kept */ rentMax: bigint;
}

const mintOf = (a: { id: string }) => (a.id === 'native' ? WSOL_MINT : a.id);
const programOf = (a: { id: string; program?: 'token' | 'token2022' }) => (a.id === 'native' ? TOKEN_PROGRAM : tokenProgramOf(a));

/**
 * Decode the message and check every value-moving element against the approved intent. Throws on any mismatch.
 * `i.from` stands for the wallet: the signer has already checked that it is its own address.
 */
export function verifyJupiterSwap(i: Intent, msg: Uint8Array): JupiterSwapFacts {
  const n = getNetwork(i.network), s = i.swap;
  if (n.family !== 'sol' || !i.sol || !s) throw new Error('not a Solana swap intent');
  if (i.bridge || i.evm || i.btc || i.x || i.memo !== undefined) throw new Error('unexpected intent section');
  if (s.provider !== 'jupiter') throw new Error('unknown swap provider');
  if (i.chainRef !== n.chainRef) throw new Error('chain identity mismatch');
  if (s.router !== JUPITER_PROGRAM) throw new Error('program is not the pinned Jupiter aggregator');
  if (s.approveGas !== '0') throw new Error('a Solana swap has no approval step');
  if (i.to !== i.from) throw new Error('a swap must deliver to the wallet itself');
  const me = i.from; pk(me);
  const src = getAsset(i.network, i.asset), dst = getAsset(i.network, s.toAsset); // throws unless both are in the registry
  if (src.decimals !== i.decimals || src.symbol !== i.symbol) throw new Error('input asset metadata mismatch');
  if (src.id === dst.id) throw new Error('input and output are the same asset');
  const amount = baseUnits(i.amount), minOut = baseUnits(s.minOut);
  if (amount <= 0n || minOut <= 0n || amount >= 1n << 64n) throw new Error('amounts out of range');
  if (solMessageHash(msg) !== s.dataHash) throw new Error('message does not match the approved hash');

  const m = decodeSolV1Message(msg);
  if (m.numSigners !== 1 || m.numReadonlySigned !== 0) throw new Error('the transaction must have exactly one signer');
  if (m.payer !== me) throw new Error('fee payer is not the wallet');
  if (m.blockhash !== i.sol.recentBlockhash || /^1{32,44}$/.test(m.blockhash)) throw new Error('blockhash does not match the approved one');
  if (i.sol.computeUnitLimit !== m.computeUnitLimit || m.computeUnitLimit < 1 || m.computeUnitLimit > MAX_COMPUTE_UNITS) throw new Error('compute-unit limit does not match the approved one');
  const priority = (BigInt(m.computeUnitLimit) * baseUnits(i.sol.computeUnitPrice) + 999_999n) / 1_000_000n;
  if (m.priorityFeeLamports !== priority) throw new Error('priority fee does not match the approved compute-unit price');
  if (m.loadedAccountsDataSizeLimit < 1 || m.loadedAccountsDataSizeLimit > MAX_LOADED_ACCOUNTS_DATA) throw new Error('loaded-accounts data limit out of range');

  const inMint = mintOf(src), outMint = mintOf(dst), inTp = programOf(src), outTp = programOf(dst);
  const srcAta = associatedTokenAddress(me, inMint, inTp), dstAta = associatedTokenAddress(me, outMint, outTp);
  const wsolAta = src.id === 'native' ? srcAta : dst.id === 'native' ? dstAta : null;
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, k) => x === b[k]);
  const writable = (k: string) => { const p = m.keys.indexOf(k); return p >= 0 && p < m.keys.length - m.numReadonlyUnsigned; };

  // --- instruction grammar: creates*, [wrap], jupiter, [unwrap]
  const ixs = m.instructions;
  let p = 0;
  const creates: string[] = [];
  for (; p < ixs.length && ixs[p]!.program === ATA_PROGRAM; p++) {
    const ix = ixs[p]!;
    if (ix.data.length !== 1 || ix.data[0] !== 1) throw new Error('token-account instruction is not CreateIdempotent');
    const which = eq(ix.accounts, [me, srcAta, me, inMint, SYSTEM_PROGRAM, inTp]) ? srcAta : eq(ix.accounts, [me, dstAta, me, outMint, SYSTEM_PROGRAM, outTp]) ? dstAta : null;
    if (!which) throw new Error('token-account creation is not for the wallet\'s own account of the swapped assets');
    if (creates.includes(which)) throw new Error('duplicate token-account creation');
    creates.push(which);
  }
  let wrapsSol = false;
  if (src.id === 'native') {
    const t = ixs[p], y = ixs[p + 1];
    if (!t || !y || t.program !== SYSTEM_PROGRAM || y.program !== TOKEN_PROGRAM) throw new Error('missing the SOL wrap instructions');
    const td = new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength);
    if (t.data.length !== 12 || td.getUint32(0, true) !== 2 || !eq(t.accounts, [me, srcAta])) throw new Error('SOL transfer is not into the wallet\'s own wrapped-SOL account');
    if (td.getBigUint64(4, true) !== amount) throw new Error('wrapped amount differs from the approved amount');
    if (y.data.length !== 1 || y.data[0] !== 17 || !eq(y.accounts, [srcAta])) throw new Error('unexpected instruction after the SOL transfer');
    if (!creates.includes(srcAta)) throw new Error('the wrapped-SOL account must be created (idempotently) in the same transaction');
    wrapsSol = true; p += 2;
  }
  const jup = ixs[p++];
  if (!jup || jup.program !== JUPITER_PROGRAM) throw new Error(jup ? `instruction for an unexpected program ${jup.program}` : 'no Jupiter instruction');
  let unwrapsSol = false;
  if (wsolAta) {
    const c = ixs[p++];
    if (!c || c.program !== TOKEN_PROGRAM || c.data.length !== 1 || c.data[0] !== 9 || !eq(c.accounts, [wsolAta, me, me])) throw new Error('missing the wrapped-SOL close back to the wallet');
    unwrapsSol = true;
  }
  if (p !== ixs.length) throw new Error(ixs[p]!.program === JUPITER_PROGRAM ? 'more than one Jupiter instruction' : `instruction for an unexpected program ${ixs[p]!.program}`);
  if (dst.id === 'native' && !creates.includes(dstAta)) throw new Error('the wrapped-SOL account must be created (idempotently) in the same transaction');

  // --- the Jupiter instruction
  const r = decodeJupiterRoute(jup.data, jup.accounts.length);
  // `route_v2` hands the wallet's signature to every venue program of the route, and the program does not tie those legs to
  // the declared source account (shown by simulation: a route declared USDC -> SOL spent USDT). It is never signed.
  if (r.kind !== 'shared_accounts_route_v2') throw new Error('this Jupiter instruction type lets the route act with the wallet\'s signature; only the shared-accounts form is signed');
  const a = jup.accounts, named = 12;
  const authority = jupiterProgramAuthority(r.authorityId!);
  const want = [authority, me, srcAta, associatedTokenAddress(authority, inMint, inTp), associatedTokenAddress(authority, outMint, outTp), dstAta, inMint, outMint, inTp, outTp, JUPITER_EVENT_AUTHORITY, JUPITER_PROGRAM];
  if (a.length < named || !eq(a.slice(0, named), want)) throw new Error(describeMismatch(a, me, srcAta, dstAta));
  if (r.inAmount !== amount) throw new Error('the instruction spends another amount');
  if (r.minOut < minOut) throw new Error('the instruction guarantees less than the approved minimum');
  // The wallet signs for one thing only: the program's own pull of `in_amount` from the source account. Neither the wallet
  // nor its two token accounts may appear among the route's accounts, so no venue program ever runs with its signature.
  if (a.slice(named).some((k) => k === me || k === srcAta || k === dstAta)) throw new Error('the route reaches into the wallet\'s accounts');
  // and no other registry token account of the wallet may be referenced anywhere in the transaction
  const others = new Set<string>();
  for (const t of [{ id: WSOL_MINT }, ...n.tokens]) for (const tp of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) { const x = associatedTokenAddress(me, t.id, tp); if (x !== srcAta && x !== dstAta) others.add(x); }
  for (const k of m.keys) if (others.has(k)) throw new Error('the transaction references another token account of the wallet');
  if (!writable(srcAta) || !writable(dstAta)) throw new Error('source or destination account is not writable');

  // --- cost: exact network fee, plus the rent of accounts created and kept (the wrapped-SOL account is closed again)
  const networkFee = SOL_SIGNATURE_FEE + m.priorityFeeLamports;
  const kept = creates.filter((c) => c !== wsolAta);
  const rentMax = kept.reduce((t, c) => t + ((c === srcAta ? inTp : outTp) === TOKEN_2022_PROGRAM ? RENT_TOKEN2022_ACCOUNT_MAX : RENT_TOKEN_ACCOUNT), 0n);
  if (i.sol.createAta !== kept.length > 0) throw new Error('token-account creation does not match the approved intent');
  if (networkFee + rentMax > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  return { ...r, message: m, sourceAccount: srcAta, destinationAccount: dstAta, inMint, outMint, creates: kept, wrapsSol, unwrapsSol, networkFee, rentMax };
}

function describeMismatch(a: string[], me: string, srcAta: string, dstAta: string): string {
  if (a[1] !== me) return 'the transfer authority is not the wallet';
  if (a[2] !== srcAta) return 'the source token account is not the wallet\'s own account of the input asset';
  if (a[5] !== dstAta) return 'the destination token account is not the wallet\'s own account of the output asset';
  return 'the instruction\'s fixed accounts are not the expected ones';
}

/**
 * API side only (never used by the signer): rewrite a `route_v2` instruction into `shared_accounts_route_v2`, the form the
 * signer accepts. Same route plan; the wallet and its token accounts inside the legs are replaced by the program authority
 * `id` and its own token accounts, so the venues run with the program's signature instead of the wallet's. `extra` maps
 * further wallet token accounts (intermediate mints) to the program's. Whether the result works is decided by simulation.
 */
export function jupiterRouteToShared(ix: SolIxInput, id: number, extra: Record<string, string> = {}): SolIxInput {
  if (ix.program !== JUPITER_PROGRAM || hex(ix.data.subarray(0, 8)) !== DISC_ROUTE_V2 || ix.accounts.length < 10) throw new Error('not a route_v2 instruction');
  const [me, src, dst, inMint, outMint, inTp, outTp, alt] = ix.accounts.slice(0, 8).map((x) => x.pubkey) as [string, string, string, string, string, string, string, string];
  if (alt !== JUPITER_PROGRAM) throw new Error('route_v2 instruction names an alternate destination');
  const auth = jupiterProgramAuthority(id), pSrc = associatedTokenAddress(auth, inMint, inTp), pDst = associatedTokenAddress(auth, outMint, outTp);
  const ro = (pubkey: string) => ({ pubkey, signer: false, writable: false }), rw = (pubkey: string) => ({ pubkey, signer: false, writable: true });
  const swap: Record<string, string> = { ...extra, [me]: auth, [src]: pSrc, [dst]: pDst };
  const data = new Uint8Array(ix.data.length + 1);
  data.set(Buffer.from(DISC_SHARED_ROUTE_V2, 'hex')); data[8] = id; data.set(ix.data.subarray(8), 9);
  return { program: JUPITER_PROGRAM, data, accounts: [ro(auth), { pubkey: me, signer: true, writable: false }, rw(src), rw(pSrc), rw(pDst), rw(dst), ro(inMint), ro(outMint), ro(inTp), ro(outTp), ro(JUPITER_EVENT_AUTHORITY), ro(JUPITER_PROGRAM),
    ...ix.accounts.slice(10).map((x) => (swap[x.pubkey] ? { pubkey: swap[x.pubkey]!, signer: false, writable: x.writable } : x))] };
}

/**
 * API side only: put Jupiter's instructions in the order the signer's grammar expects (token-account creations, wrap,
 * swap, unwrap) and, when the swap instruction is `route_v2`, rewrite it to the shared-accounts form with program
 * authority `authorityId`. Creations of the wallet's accounts for intermediate mints are dropped: the rewritten route uses
 * the program's own accounts for them. Nothing here is trusted by the signer.
 */
export function arrangeJupiterInstructions(o: { setup: SolIxInput[]; swap: SolIxInput; cleanup: SolIxInput | null; authorityId: number }): { instructions: SolIxInput[]; converted: boolean; kind: JupiterRoute['kind']; programAccounts: string[] } {
  const kind = decodeJupiterRoute(o.swap.data, o.swap.accounts.length).kind;
  const pos = kind === 'route_v2' ? { me: 0, src: 1, dst: 2 } : { me: 1, src: 2, dst: 5 };
  const me = o.swap.accounts[pos.me]!.pubkey, src = o.swap.accounts[pos.src]!.pubkey, dst = o.swap.accounts[pos.dst]!.pubkey;
  const creates = o.setup.filter((x) => x.program === ATA_PROGRAM), other = o.setup.filter((x) => x.program !== ATA_PROGRAM);
  const own = creates.filter((x) => x.accounts[1]?.pubkey === src || x.accounts[1]?.pubkey === dst);
  let swap = o.swap, converted = false;
  if (kind === 'route_v2') {
    const auth = jupiterProgramAuthority(o.authorityId), extra: Record<string, string> = {};
    for (const c of creates) if (!own.includes(c) && c.accounts.length === 6 && c.accounts[2]!.pubkey === me) extra[c.accounts[1]!.pubkey] = associatedTokenAddress(auth, c.accounts[3]!.pubkey, c.accounts[5]!.pubkey);
    swap = jupiterRouteToShared(o.swap, o.authorityId, extra); converted = true;
  }
  // the program's own token accounts this instruction relies on (they must exist): source, destination, intermediates
  const programAccounts = [swap.accounts[3]!.pubkey, swap.accounts[4]!.pubkey, ...(converted ? swap.accounts.slice(12).map((x) => x.pubkey).filter((k, n) => o.swap.accounts[10 + n]!.pubkey !== k && k !== swap.accounts[0]!.pubkey) : [])];
  return { instructions: [...own, ...other, swap, ...(o.cleanup ? [o.cleanup] : [])], converted, kind, programAccounts: [...new Set(programAccounts)] };
}

/** The bytes the signer signs for a Jupiter swap: the verified message itself. */
export function buildSolSwapMessage(i: Intent, messageB64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(messageB64) || messageB64.length > 5500) throw new Error('swap message is not base64');
  const msg = new Uint8Array(Buffer.from(messageB64, 'base64'));
  verifyJupiterSwap(i, msg);
  return msg;
}
