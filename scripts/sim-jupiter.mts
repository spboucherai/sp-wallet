// Proof, without funds, of Jupiter swap execution on Solana. NOTHING is sent: every transaction is only *simulated* on the
// public mainnet RPC endpoints (simulateTransaction). No real key is used: the signer runs with a fresh random mnemonic.
//
//  1. the pinned aggregator program (ProgramData header + executable hash) as seen by two RPC endpoints;
//  2. real swaps prepared by the REAL API code (prepareJupiterSwap: guards, GET /build, arrangement, the signer's verification,
//     simulation) for PUBLIC addresses that hold the input asset, then approved with a passkey and signed by the REAL signer
//     code path with that address standing in as "the wallet" (the signature is from the test key, so the bytes are simulated
//     with sigVerify:false) — success and balance changes ≥ the verified minimum;
//  3. the same path for the fresh key's own (unfunded) address with sigVerify:true: the signature is accepted by the node
//     (the transaction then fails for lack of funds), and a corrupted signature is rejected — signature format proven;
//  4. the program's minimum-output rule, probed on-chain around the real output;
//  5. genuine transactions mutated in every way that matters: the signer must refuse each; where useful, what the chain
//     itself would have done with the mutated transaction is shown.
//
//   npx tsx scripts/sim-jupiter.mts            (≈ 3 minutes: Jupiter's keyless limit is one request every two seconds)
//   npx tsx scripts/sim-jupiter.mts --record   (also rewrites packages/core/test/fixtures/jupiter-exec/*.json)
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  arrangeJupiterInstructions, associatedTokenAddress, compileSolV1Message, decodeJupiterRoute, decodeSolV1Message, formatUnits, getAsset, IntentSchema, intentHash, JUPITER_PIN, JUPITER_PROGRAM,
  NETWORKS, solAddress, solMessageHash, solV1Wire, SYSTEM_PROGRAM, TOKEN_PROGRAM, tokenProgramOf, verifyJupiterSwap, WSOL_MINT, type Intent, type SolIxInput, type SolV1Message,
} from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys, type Keys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', RECORD = process.argv.includes('--record');
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 's'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
// The public RPC endpoints limit requests per IP: space the calls of this script (and of the API code it runs) and retry on 429.
{
  const plain = globalThis.fetch, last = new Map<string, number>();
  globalThis.fetch = async (input: any, init?: any) => {
    const host = new URL(typeof input === 'string' ? input : input.url ?? String(input)).host;
    if (!/solana/.test(host)) return plain(input, init);
    for (let k = 0; ; k++) {
      const at = Math.max(Date.now(), (last.get(host) ?? 0) + 350); last.set(host, at);
      await new Promise((r) => setTimeout(r, at - Date.now()));
      const r = await plain(input, init).catch((e) => { if (k >= 4) throw e; return null; });
      if (r && r.status !== 429) return r;
      if (k >= 6) return r!;
      last.set(host, Date.now() + 4000 * (k + 1));
    }
  };
}
const exec = await import('../services/api/src/swap-exec-sol.ts');
const { sql } = await import('../services/api/src/db.ts');
const N = NETWORKS.solana!, RPCS = N.rpc;
const rpcOne = async <T,>(u: string, method: string, params: unknown[]): Promise<T> => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(j.error.message); return j.result; };
const rpc = async <T,>(method: string, params: unknown[]): Promise<T> => { let last: unknown; for (const u of RPCS) { try { return await rpcOne<T>(u, method, params); } catch (e) { last = e; if (!/fetch failed|429|Too many/i.test((e as Error).message)) throw e; } } throw last; };
const sim = async (wire: Uint8Array, o: { sigVerify: boolean; replaceRecentBlockhash?: boolean }) => (await rpc<{ value: any }>('simulateTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: o.sigVerify, replaceRecentBlockhash: o.replaceRecentBlockhash ?? !o.sigVerify }])).value;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tok = (sym: string) => (sym === 'SOL' ? N.native : N.tokens.find((t) => t.symbol === sym)!);
const fmt = (v: bigint, sym: string) => `${formatUnits(v, tok(sym).decimals)} ${sym}`;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failures++; console.log(`   !! FAILED: ${what}`); } };

// --- the signer, with a fresh random key. `standIn` makes a public address play the wallet (signature format aside).
const mnemonic = generateMnemonic(wordlist, 128), realKeys = deriveKeys(mnemonic), FRESH = realKeys.addresses.solana!;
function makeSigner(standIn?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-simjup-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = sha('sim-setup');
  const keys: Keys = standIn ? { ...realKeys, addresses: { ...realKeys.addresses, sol: standIn, solana: standIn } } : realKeys;
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }), pk = new TestPasskey(RP, ORIGIN);
  return { signer, pk, store, keys, ready: signer.enroll({ credential: pk.credential(), setupToken: 'sim-setup' }) };
}
const approveAndSign = async (s: ReturnType<typeof makeSigner>, intent: Intent, message: string) => { await s.ready; return s.signer.sign(intent, s.pk.assert(intentHash(intent)), { swapMessage: message }); };

// --- 1. program pin
console.log('== 1. Jupiter aggregator program, as pinned ==');
for (const u of RPCS) {
  const head = Buffer.from((await rpcOne<any>(u, 'getAccountInfo', [JUPITER_PIN.programData, { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 45 } }])).value.data[0], 'base64');
  const full = Buffer.from((await rpcOne<any>(u, 'getAccountInfo', [JUPITER_PIN.programData, { encoding: 'base64', commitment: 'finalized' }])).value.data[0], 'base64');
  const slot = Number(head.readBigUInt64LE(4)), auth = head[12] ? solAddress(head.subarray(13, 45)) : 'none (immutable)', code = createHash('sha256').update(full.subarray(45)).digest('hex');
  console.log(`   ${new URL(u).host}: last deployed at slot ${slot}, upgrade authority ${auth}, executable ${full.length - 45} bytes sha256 ${code}`);
  check(slot === JUPITER_PIN.lastDeploySlot && auth === JUPITER_PIN.upgradeAuthority && code === JUPITER_PIN.codeSha256, 'program differs from the pin');
}
console.log(`   program ${JUPITER_PROGRAM} is UPGRADEABLE; the API refuses to prepare a swap if the slot, the authority or the hash changes.`);

// --- 2. positive cases
const A = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', B = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', C = '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD';
const CASES: [string, string, string, string, string][] = [
  [A, 'USDC', 'SOL', '25', 'wrapped-SOL account already exists'], [C, 'USDC', 'SOL', '25', 'no wrapped-SOL account before'], [C, 'SOL', 'USDC', '0.05', 'no wrapped-SOL account before'], [A, 'SOL', 'USDC', '0.3', ''],
  [B, 'USDC', 'JUP', '25', 'the JUP token account does not exist: created, rent shown'], [A, 'JUP', 'USDC', '100', ''], [A, 'USDC', 'USDT', '25', ''],
  [A, 'USDC', 'PYUSD', '25', 'Token-2022 output'], [A, 'PYUSD', 'USDC', '25', 'Token-2022 input'], [A, 'USDC', 'BONK', '25', ''],
];
type Done = { wallet: string; from: string; to: string; ps: Awaited<ReturnType<typeof exec.prepareJupiterSwap>>; harness: ReturnType<typeof makeSigner> };
const done: Done[] = [];
console.log('\n== 2. real swaps for public addresses: API preparation, passkey approval, signer verification, simulation of the signed bytes ==');
for (const [wallet, from, to, amount, note] of CASES) {
  const src = tok(from), dst = tok(to), label = `${from} -> ${to}`.padEnd(13);
  try {
    const h = makeSigner(wallet);
    const ps = await exec.prepareJupiterSwap({ n: N, me: wallet, keyId: h.keys.keyId, fromAsset: src.id, toAsset: dst.id, amount: BigInt(Math.round(Number(amount) * 10 ** src.decimals)), slippageBps: 50, policyVersion: h.store.policy.version, proposalId: crypto.randomUUID(), feeCeiling: BigInt(h.store.policy.maxFee.solana!), ttlSec: 120 });
    const signed = await approveAndSign(h, ps.intent, ps.message);
    const s = await sim(new Uint8Array(Buffer.from(signed.raw, 'base64')), { sigVerify: false, replaceRecentBlockhash: false });
    console.log(` ${label} ${amount} ${from} for ${short(wallet)}${note ? ` (${note})` : ''}`);
    console.log(`   route: ${ps.labels.join(' + ')} · ${ps.facts.kind}${ps.converted ? ' (rewritten by the API from route_v2)' : ' (as built by Jupiter)'} · ${ps.attempts} /build call(s) · ${ps.facts.message.keys.length} accounts inline, ${Buffer.from(ps.message, 'base64').length + 64} bytes, no lookup table`);
    console.log(`   expected ${fmt(ps.expected, to)}, signer-verified minimum ${fmt(ps.minOut, to)}; network fee ${fmt(ps.networkFee, 'SOL')} (priority ${ps.networkFee - 5000n} lamports, ${ps.intent.sol!.computeUnitLimit} CU limit, ${ps.unitsConsumed} used)${ps.rent ? `, new token account rent ${fmt(ps.rent, 'SOL')}` : ''}`);
    if (s.err) { check(false, `signed bytes fail in simulation: ${JSON.stringify(s.err)}`); continue; }
    const fx = exec.swapEffects(ps.facts, s);
    console.log(`   signed by the signer (txid ${short(signed.txid)}); simulation of the signed bytes: success, spent ${fmt(fx.spent, from)}, received ${fmt(fx.received, to)} (≥ minimum: ${fx.received >= ps.minOut}), wallet lamports ${fx.lamportsDelta >= 0n ? '+' : ''}${fx.lamportsDelta}, other wallet accounts losing value: ${fx.otherLosses.length}`);
    check(fx.received >= ps.minOut && fx.spent === BigInt(ps.intent.amount) && fx.otherLosses.length === 0, 'simulated effects');
    done.push({ wallet, from, to, ps, harness: h });
    if (RECORD) {
      const dir = new URL('../packages/core/test/fixtures/jupiter-exec/', import.meta.url); mkdirSync(dir, { recursive: true });
      writeFileSync(new URL(`${from}-${to}${wallet === C ? '-nowsol' : ''}.json`.toLowerCase(), dir), JSON.stringify({ recordedAt: new Date().toISOString(), wallet, from, to, build: ps.build, converted: ps.converted, intent: ps.intent, message: ps.message,
        simulation: { fee: s.fee, unitsConsumed: s.unitsConsumed, preBalances: s.preBalances, postBalances: s.postBalances, preTokenBalances: s.preTokenBalances, postTokenBalances: s.postTokenBalances }, effects: { spent: fx.spent.toString(), received: fx.received.toString(), rentKept: fx.rentKept.toString() } }, null, 1));
    }
  } catch (e) { console.log(` ${label} ${amount} ${from} for ${short(wallet)}: NOT PREPARED — ${(e as Error).message}`); }
}
check(done.length >= 6, 'fewer than six pairs could be prepared');

// --- helpers to take a genuine transaction apart and put it back together
const inputs = (m: SolV1Message): SolIxInput[] => m.instructions.map((x) => ({ program: x.program, data: x.data, accounts: x.accounts.map((k) => ({ pubkey: k, signer: k === m.payer, writable: m.keys.indexOf(k) < m.keys.length - m.numReadonlyUnsigned })) }));
const recompile = (m: SolV1Message, ixs: SolIxInput[], o: Partial<{ limit: number; fee: bigint; payer: string }> = {}) => compileSolV1Message({ payer: o.payer ?? m.payer, blockhash: m.blockhash, instructions: ixs, computeUnitLimit: o.limit ?? m.computeUnitLimit, priorityFeeLamports: o.fee ?? m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const acct = (pubkey: string, writable = false, signer = false) => ({ pubkey, writable, signer });

// --- 3. signature format, with the fresh key as the wallet itself (unfunded)
console.log('\n== 3. signature format: the fresh key\'s own (unfunded) address, simulated with signature verification ON ==');
{
  const base = done.find((d) => d.from !== 'SOL' && d.to !== 'SOL') ?? done[0]!;
  const h = makeSigner(), m = base.ps.facts.message, src = tok(base.from), dst = tok(base.to);
  // the same route, re-addressed to the fresh wallet: its own token accounts replace the public address's
  const swap = Object.fromEntries([[base.wallet, FRESH], ...[src, dst].map((a) => { const mint = a.id === 'native' ? WSOL_MINT : a.id, tp = a.id === 'native' ? TOKEN_PROGRAM : tokenProgramOf(a); return [associatedTokenAddress(base.wallet, mint, tp), associatedTokenAddress(FRESH, mint, tp)]; })]);
  const bh = (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value, t = Math.floor(Date.now() / 1000);
  const msg = compileSolV1Message({ payer: FRESH, blockhash: bh.blockhash, instructions: inputs(m).map((x) => ({ ...x, accounts: x.accounts.map((k) => ({ ...k, pubkey: swap[k.pubkey] ?? k.pubkey })) })), computeUnitLimit: m.computeUnitLimit, priorityFeeLamports: m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit });
  const intent = IntentSchema.parse({ ...base.ps.intent, proposalId: crypto.randomUUID(), keyId: realKeys.keyId, from: FRESH, to: FRESH, createdAt: t, expiresAt: t + 60, swap: { ...base.ps.intent.swap!, dataHash: solMessageHash(msg) }, sol: { ...base.ps.intent.sol!, recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight } });
  const signed = await approveAndSign(h, intent, Buffer.from(msg).toString('base64'));
  const wire = new Uint8Array(Buffer.from(signed.raw, 'base64'));
  const verdict = (w: Uint8Array) => sim(w, { sigVerify: true }).then((s) => JSON.stringify(s.err), (e: Error) => `node error: ${e.message}`);
  const good = await verdict(wire);
  const bad = Uint8Array.from(wire); bad[bad.length - 1]! ^= 1;
  const corrupt = await verdict(bad);
  console.log(`   wallet ${short(FRESH)} (random, never funded), ${wire.length}-byte v1 transaction, signature = last 64 bytes`);
  console.log(`   genuine signature : passes signature verification; the node then answers ${good} (the fee payer has never been funded)`);
  console.log(`   one bit flipped   : ${corrupt}`);
  check(!/signature/i.test(good) && /AccountNotFound|InsufficientFunds/i.test(good) && /SignatureFailure|signature verification/i.test(corrupt), 'signature format');
}

// --- 4. the program's minimum-output rule
console.log('\n== 4. the program\'s minimum-output rule, probed on-chain (signer assumes floor(quoted × (10000 − bps) / 10000)) ==');
{
  const base = done.find((d) => d.to === 'JUP') ?? done.find((d) => d.from === 'JUP') ?? done.find((d) => d.to !== 'SOL' && d.from !== 'SOL')!;
  const m = base.ps.facts.message, ixs = inputs(m), k = ixs.findIndex((x) => x.program === JUPITER_PROGRAM);
  const withMin = (quoted: bigint, bps: number) => { const c = structuredClone(ixs), d = Buffer.from(c[k]!.data); d.writeBigUInt64LE(quoted, 17); d.writeUInt16LE(bps, 25); c[k]!.data = new Uint8Array(d); return solV1Wire(new Uint8Array(64), recompile(m, c)); };
  const run = async (quoted: bigint, bps: number) => { const s = await sim(withMin(quoted, bps), { sigVerify: false }); return s.err ? { ok: false as const, err: JSON.stringify(s.err) } : { ok: true as const, out: exec.swapEffects(base.ps.facts, s).received }; };
  // The invariant that matters: a simulation either fails with 6001 (SlippageToleranceExceeded) or delivers at least
  // floor(quoted × (10000 − bps) / 10000). The rounding direction can only be read when the pool does not move meanwhile.
  const need = (q: bigint, bps: number) => (q * BigInt(10_000 - bps)) / 10_000n;
  let violated = 0, probes = 0, rounding = '';
  for (let round = 0; round < 3 && !rounding; round++) {
    const first = await run(1n, 0);
    if (!first.ok) { check(false, `probe failed: ${first.err}`); break; }
    const out = first.out;
    let q = (out * 10_000n) / 9_999n + 1n; while (need(q, 1) !== out || (q * 9_999n) % 10_000n === 0n) q++; // exact product strictly between out and out+1
    let q2 = q; while (need(q2, 1) !== out + 1n) q2++;
    const plan: [bigint, number][] = [[out, 0], [out + 1n, 0], [q, 1], [q2, 1], [out * 2n, 0], [out * 2n, 4000]];
    const res = [];
    for (const [quoted, bps] of plan) { const r = await run(quoted, bps); probes++; res.push(r);
      if (r.ok ? r.out < need(quoted, bps) : !/6001/.test(r.err)) violated++;
      console.log(`   quoted ${quoted}, ${bps} bps (floor minimum ${need(quoted, bps)}) → ${r.ok ? `success, received ${r.out}` : `refused on-chain ${r.err}`}`); }
    const stable = res.every((r) => !r.ok || r.out === out);
    if (stable && res[0]!.ok && !res[1]!.ok) rounding = res[2]!.ok ? 'rounds down (exactly the signer\'s formula)' : 'rounds up: it is one unit stricter than the signer assumes whenever the product is not whole';
    else console.log('   (the pool moved between simulations: rounding not readable in this round)');
  }
  console.log(`   ${base.from} -> ${base.to}: ${probes} probes, ${violated} delivered less than floor(quoted × (10000 − bps) / 10000) or failed for another reason${rounding ? `; with a still pool, the program ${rounding}` : ''}`);
  check(violated === 0 && probes > 0, 'the program does not enforce at least the floor formula');
  console.log('   → what reaches the wallet\'s destination account is never below the signer\'s figure: it is a lower bound of what the program enforces.');
}

// --- 5. mutations
console.log('\n== 5. genuine transactions, mutated: the signer must refuse every one ==');
const T = C, MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
let refused = 0, total = 0;
async function attack(name: string, base: Done, make: (ixs: SolIxInput[], k: number, m: SolV1Message) => Uint8Array | { msg: Uint8Array; intent?: (i: Intent) => Intent; keepHash?: boolean }, o: { chain?: boolean } = {}) {
  total++;
  const m = base.ps.facts.message, ixs = structuredClone(inputs(m)), k = ixs.findIndex((x) => x.program === JUPITER_PROGRAM);
  let msg: Uint8Array, patch: ((i: Intent) => Intent) | undefined, keepHash = false;
  try { const r = make(ixs, k, m); if (r instanceof Uint8Array) msg = r; else { msg = r.msg; patch = r.intent; keepHash = !!r.keepHash; } }
  catch (e) { console.log(` - ${name}: could not even be assembled (${(e as Error).message})`); refused++; return; }
  // the attacker controls the API and the database: every field of the intent that the owner does not read is his to set
  let intent: Intent = { ...base.ps.intent, proposalId: crypto.randomUUID(), swap: { ...base.ps.intent.swap!, dataHash: keepHash ? base.ps.intent.swap!.dataHash : solMessageHash(msg) } };
  if (patch) intent = patch(intent);
  let verdict: string;
  try { await approveAndSign(base.harness, intent, Buffer.from(msg).toString('base64')); verdict = 'SIGNED'; }
  catch (e) { verdict = `refused (${(e as { code?: string }).code}): ${(e as Error).message}`; refused++; }
  let chain = '';
  if (o.chain && msg[0] === 0x81) { try { const s = await sim(solV1Wire(new Uint8Array(64), msg), { sigVerify: false }); chain = s.err ? ` | the chain would have rejected it too: ${JSON.stringify(s.err)}` : ' | THE CHAIN WOULD HAVE EXECUTED IT'; } catch (e) { chain = ` | the node rejects it: ${(e as Error).message.slice(0, 60)}`; } }
  console.log(` - ${name}: ${verdict}${chain}`);
  check(verdict !== 'SIGNED', `${name} was signed`);
}
const tt = done.find((d) => d.from === 'USDC' && d.to === 'USDT') ?? done.find((d) => d.wallet === A && d.from !== 'SOL' && d.to !== 'SOL')!; // token -> token
const other = tok(['JUP', 'BONK', 'USDT'].find((x) => x !== tt.from && x !== tt.to)!); // a registry asset this swap has nothing to do with
const si = done.find((d) => d.from === 'SOL'), so = done.find((d) => d.to === 'SOL' && d.wallet === A);
const setData = (ix: SolIxInput, f: (d: Buffer) => void) => { const d = Buffer.from(ix.data); f(d); ix.data = new Uint8Array(d); };
const tMint = tok(tt.to).id, tTp = tokenProgramOf(tok(tt.to)), sMint = tok(tt.from).id, sTp = tokenProgramOf(tok(tt.from));
const mySrc = associatedTokenAddress(tt.wallet, sMint, sTp), myDst = associatedTokenAddress(tt.wallet, tMint, tTp);
console.log(` base transaction: ${tt.from} -> ${tt.to} for ${short(tt.wallet)}; third party ${short(T)}`);
await attack('another destination token account (third party\'s)', tt, (x, k, m) => { x[k]!.accounts[5]!.pubkey = associatedTokenAddress(T, tMint, tTp); return recompile(m, x); }, { chain: true });
await attack(`another source token account (the wallet's ${other.symbol} account)`, tt, (x, k, m) => { x[k]!.accounts[2]!.pubkey = associatedTokenAddress(tt.wallet, other.id, TOKEN_PROGRAM); return recompile(m, x); });
await attack('platform fee of 1 %', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(100, 27)); return recompile(m, x); }, { chain: true });
await attack('positive-slippage fee of 1 %', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(100, 29)); return recompile(m, x); }, { chain: true });
await attack('lower minimum than approved (quoted amount halved)', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(17) / 2n, 17)); return recompile(m, x); }, { chain: true });
await attack('lower minimum than approved (slippage raised to 50 %)', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(5000, 25)); return recompile(m, x); }, { chain: true });
await attack('another input amount (doubled)', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(9) * 2n, 9)); return recompile(m, x); }, { chain: true });
await attack('extra System transfer of 0.01 SOL to a third party', tt, (x, _k, m) => recompile(m, [...x, { program: SYSTEM_PROGRAM, accounts: [acct(tt.wallet, true, true), acct(T, true)], data: new Uint8Array(Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(10_000_000n)])) }]), { chain: true });
await attack('extra Token approve (third party as delegate of the source account)', tt, (x, _k, m) => recompile(m, [{ program: sTp, accounts: [acct(mySrc, true), acct(T), acct(tt.wallet, false, true)], data: new Uint8Array(Buffer.concat([Buffer.from([4]), u64((1n << 64n) - 1n)])) }, ...x]), { chain: true });
await attack('extra Token setAuthority (source account given away)', tt, (x, _k, m) => recompile(m, [...x, { program: sTp, accounts: [acct(mySrc, true), acct(tt.wallet, false, true)], data: new Uint8Array(Buffer.concat([Buffer.from([6, 2, 1]), Buffer.alloc(32, 7)])) }]));
await attack('extra Token transfer to a third party', tt, (x, _k, m) => recompile(m, [...x, { program: sTp, accounts: [acct(mySrc, true), acct(associatedTokenAddress(T, sMint, sTp), true), acct(tt.wallet, false, true)], data: new Uint8Array(Buffer.concat([Buffer.from([3]), u64(1_000_000n)])) }]), { chain: true });
await attack('token-account creation for a third party (wallet pays the rent)', tt, (x, _k, m) => recompile(m, [{ program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [acct(tt.wallet, true, true), acct(associatedTokenAddress(T, other.id, TOKEN_PROGRAM), true), acct(T), acct(other.id), acct(SYSTEM_PROGRAM), acct(TOKEN_PROGRAM)], data: Uint8Array.of(1) }, ...x]));
await attack('instruction for an unknown program (Memo)', tt, (x, _k, m) => recompile(m, [...x, { program: MEMO, accounts: [], data: new TextEncoder().encode('hi') }]));
await attack('ComputeBudget instruction slipped in', tt, (x, _k, m) => recompile(m, [{ program: 'ComputeBudget111111111111111111111111111111', accounts: [], data: new Uint8Array(Buffer.concat([Buffer.from([3]), u64(50_000_000n)])) }, ...x]));
await attack('two Jupiter instructions', tt, (x, k, m) => recompile(m, [...x.slice(0, k + 1), x[k]!, ...x.slice(k + 1)]));
await attack('another fee payer (the wallet only co-signs)', tt, (x, _k, m) => { // hand-assembled: two signers, the third party pays
  const good = recompile(m, x), g = decodeSolV1Message(good), keys = [T, ...g.keys], out = Buffer.from(good), idx = Buffer.alloc(0);
  const head = Buffer.from(out.subarray(0, 42)); head[1] = 2; head[41] = keys.length;
  const body = Buffer.from(out.subarray(42 + g.keys.length * 32)); // config + headers + payloads: every index moves up by one
  let o = 16; const n = g.instructions.length; for (let q = 0; q < n; q++) body[o + q * 4]! += 1;
  o += n * 4; for (const ix of g.instructions) { for (let q = 0; q < ix.accounts.length; q++) body[o + q]! += 1; o += ix.accounts.length + ix.data.length; }
  void idx; return new Uint8Array(Buffer.concat([head, ...keys.map((kk) => Buffer.from(decodeKey(kk))), body]));
});
await attack('priority fee raised to 0.5 SOL, intent left as approved', tt, (x, _k, m) => recompile(m, x, { fee: 500_000_000n }));
await attack('priority fee raised to 0.5 SOL, intent adjusted to match (policy ceiling)', tt, (x, _k, m) => ({ msg: recompile(m, x, { fee: 500_000_000n }), intent: (i) => ({ ...i, maxFee: '500005000', sol: { ...i.sol!, computeUnitPrice: ((500_000_000n * 1_000_000n) / BigInt(i.sol!.computeUnitLimit)).toString() } }) }));
await attack('compute-unit limit raised to the protocol maximum', tt, (x, _k, m) => recompile(m, x, { limit: 1_400_000 }));
await attack('lookup tables: the same transaction as version 0 (accounts behind tables cannot be checked)', tt, (x, _k, m) => { const b = Uint8Array.from(recompile(m, x)); b[0] = 0x80; return b; });
await attack('legacy message format', tt, (x, _k, m) => recompile(m, x).slice(1));
await attack('trailing bytes after the message', tt, (x, _k, m) => new Uint8Array(Buffer.concat([recompile(m, x), Buffer.from([0])])));
await attack('the wallet itself slipped among the route accounts (a venue would run with its signature)', tt, (x, k, m) => { x[k]!.accounts.push(acct(tt.wallet, false, true)); return recompile(m, x); });
await attack('a route leg redirected to the wallet\'s own source account', tt, (x, k, m) => { x[k]!.accounts[14] = acct(mySrc, true); return recompile(m, x); }, { chain: true });
await attack(`another registry token account of the wallet among the route accounts (${other.symbol})`, tt, (x, k, m) => { x[k]!.accounts.push(acct(associatedTokenAddress(tt.wallet, other.id, TOKEN_PROGRAM), true)); return recompile(m, x); });
await attack('exact-out instruction type', tt, (x, k, m) => { setData(x[k]!, (d) => Buffer.from('3560e5cad8bbfa18', 'hex').copy(d)); return recompile(m, x); });
await attack('owner approved another output asset than the transaction buys', tt, (x, _k, m) => ({ msg: recompile(m, x), intent: (i) => ({ ...i, swap: { ...i.swap!, toAsset: other.id } }) }));
await attack('owner approved a higher minimum than the transaction guarantees', tt, (x, _k, m) => ({ msg: recompile(m, x), intent: (i) => ({ ...i, swap: { ...i.swap!, minOut: (BigInt(i.swap!.minOut) + 1n).toString() } }) }));
await attack('message swapped after approval (hash no longer matches)', tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(51, 25)); return { msg: recompile(m, x), keepHash: true }; });
await attack('blockhash zeroed', tt, (x, _k, m) => ({ msg: compileSolV1Message({ payer: m.payer, blockhash: SYSTEM_PROGRAM, instructions: x, computeUnitLimit: m.computeUnitLimit, priorityFeeLamports: m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit }), intent: (i) => ({ ...i, sol: { ...i.sol!, recentBlockhash: SYSTEM_PROGRAM } }) }));
if (si) {
  const T2 = si.wallet === C ? B : C;
  console.log(` base transaction: SOL -> ${si.to} for ${short(si.wallet)} (wrap, swap, unwrap)`);
  await attack('wrap twice the approved amount', si, (x, _k, m) => { const t = x.find((q) => q.program === SYSTEM_PROGRAM)!; setData(t, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(4) * 2n, 4)); return recompile(m, x); });
  await attack('SOL transfer to a third party instead of the wallet\'s wrapped-SOL account', si, (x, _k, m) => { x.find((q) => q.program === SYSTEM_PROGRAM)!.accounts[1]!.pubkey = T2; return recompile(m, x); });
  await attack('wrapped-SOL account closed to a third party', si, (x, _k, m) => { x[x.length - 1]!.accounts[1] = acct(T2, true); return recompile(m, x); }, { chain: true });
  await attack('unwrap left out (the SOL would stay wrapped)', si, (x, _k, m) => recompile(m, x.slice(0, -1)));
}
if (so) await attack(`${so.from} -> SOL: wrapped-SOL account closed to a third party`, so, (x, _k, m) => { x[x.length - 1]!.accounts[1] = acct(T, true); return recompile(m, x); }, { chain: true });

// route_v2: what Jupiter builds for direct routes. The program does not tie its legs to the declared source account.
console.log(' route_v2 (venue programs act with the wallet\'s signature):');
{
  const usdt = tok('USDT').id, usdc = tok('USDC').id, base = done.find((d) => d.wallet === A)!;
  for (let attempt = 0, shown = false; attempt < 5 && !shown; attempt++) {
    const b = await exec.jupiterBuild({ inputMint: usdt, outputMint: WSOL_MINT, amount: '20000000', taker: A, slippageBps: '50', transactionVersion: '1', ...(attempt ? { maxAccounts: String(30 - attempt * 2) } : {}) }) as any;
    if (b.noRoute || decodeJupiterRoute(new Uint8Array(Buffer.from(b.swapInstruction.data, 'base64')), 0).kind !== 'route_v2') continue;
    shown = true;
    const toIx = (x: any): SolIxInput => ({ program: x.programId, accounts: x.accounts.map((q: any) => ({ pubkey: q.pubkey, signer: q.isSigner, writable: q.isWritable })), data: new Uint8Array(Buffer.from(x.data, 'base64')) });
    const ixs = [...b.setupInstructions.map(toIx), toIx(b.swapInstruction), ...(b.cleanupInstruction ? [toIx(b.cleanupInstruction)] : [])], k = ixs.findIndex((x) => x.program === JUPITER_PROGRAM);
    const m0 = base.ps.facts.message, mk = (x: SolIxInput[]) => compileSolV1Message({ payer: A, blockhash: m0.blockhash, instructions: x, computeUnitLimit: 400_000, priorityFeeLamports: 0n, loadedAccountsDataSizeLimit: m0.loadedAccountsDataSizeLimit });
    // genuine USDT -> SOL route_v2, re-declared as a USDC -> SOL swap: declared source account and mint are USDC, the leg still names the USDT account
    const evil = structuredClone(ixs); evil[k]!.accounts[1]!.pubkey = associatedTokenAddress(A, usdc, TOKEN_PROGRAM); evil[k]!.accounts[3]!.pubkey = usdc;
    const msg = mk(evil), s = await sim(solV1Wire(new Uint8Array(64), msg), { sigVerify: false });
    const pre = (mint: string) => BigInt(s.preTokenBalances?.find((q: any) => q.owner === A && q.mint === mint)?.uiTokenAmount.amount ?? 0), post = (mint: string) => BigInt(s.postTokenBalances?.find((q: any) => q.owner === A && q.mint === mint)?.uiTokenAmount.amount ?? 0);
    console.log(`   a genuine USDT -> SOL route_v2 (${b.routePlan.map((l: any) => l.swapInfo.label).join(',')}) re-declared as "USDC -> SOL, source = the wallet's USDC account": on-chain ${s.err ? `error ${JSON.stringify(s.err)}` : `SUCCESS — USDC ${post(usdc) - pre(usdc)}, USDT ${post(usdt) - pre(usdt)}`}`);
    console.log('   → the declared source account of route_v2 binds nothing; that instruction type is refused whatever it declares:');
    total++; const h = base.harness, usdcA = tok('USDC');
    const intent = IntentSchema.parse({ ...base.ps.intent, proposalId: crypto.randomUUID(), asset: usdcA.id, symbol: 'USDC', decimals: 6, amount: '20000000', maxFee: '2500000',
      swap: { ...base.ps.intent.swap!, toAsset: 'native', minOut: '1', dataHash: solMessageHash(msg) }, sol: { ...base.ps.intent.sol!, createAta: false, computeUnitLimit: 400_000, computeUnitPrice: '0' } });
    try { await approveAndSign(h, intent, Buffer.from(msg).toString('base64')); console.log(' - re-declared route_v2: SIGNED'); check(false, 're-declared route_v2 was signed'); }
    catch (e) { refused++; console.log(` - re-declared route_v2: refused (${(e as { code?: string }).code}): ${(e as Error).message}`); }
    await attack('genuine, unmodified route_v2 as built by Jupiter', base, () => ({ msg: mk(ixs), intent: (i) => IntentSchema.parse({ ...i, asset: tok('USDT').id, symbol: 'USDT', amount: '20000000', swap: { ...i.swap!, toAsset: 'native', minOut: '1' }, sol: { ...i.sol!, createAta: false, computeUnitLimit: 400_000, computeUnitPrice: '0' } }) }));
    // the same route once the API has rewritten it: the venue runs with the program's signature
    const arr = arrangeJupiterInstructions({ setup: b.setupInstructions.map(toIx), swap: toIx(b.swapInstruction), cleanup: b.cleanupInstruction ? toIx(b.cleanupInstruction) : null, authorityId: 0 });
    const s2 = await sim(solV1Wire(new Uint8Array(64), mk(arr.instructions)), { sigVerify: false });
    console.log(`   the same route rewritten to shared_accounts_route_v2: on-chain ${s2.err ? `error ${JSON.stringify(s2.err)} (such a route is simply not offered)` : 'success'}`);
  }
}
console.log(`\n${refused}/${total} mutated transactions refused by the signer.`);
function decodeKey(k: string): Uint8Array { const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of k) n = n * 58n + BigInt(A58.indexOf(c)); const out = Buffer.from(n.toString(16).padStart(64, '0'), 'hex'); if (solAddress(out) !== k) throw new Error('bad key'); return out; }
void getAsset; void verifyJupiterSwap;
await sql.end({ timeout: 1 }).catch(() => {});
console.log(failures === 0 ? '\nJUPITER SIMULATION PROOF OK — nothing was sent to the network' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
