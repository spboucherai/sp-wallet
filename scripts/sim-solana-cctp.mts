// Proof, without funds, of the Solana ↔ EVM USDC bridge (Circle CCTP V2, Solana = domain 5). NOTHING is sent to a real network:
// Solana transactions are only *simulated* on the public mainnet RPC endpoints (simulateTransaction), EVM transactions run on
// a local anvil fork of Base. No real key is used: the signer runs with a fresh random mnemonic and a software passkey.
//
//  0  the two Circle programs as pinned (ProgramData header + executable hash) on both RPC endpoints, and the on-chain state the
//     code relies on (fee recipient, registered remote token messengers, USDC mint, rent of the accounts created);
//  a  Solana → EVM: a burn prepared by the REAL API code and signed by the REAL signer (its own one-time event account) for a
//     PUBLIC address that holds USDC and SOL standing in as the wallet (so the wallet signature is the test key's and the
//     bytes are simulated with sigVerify:false): success, exact debit, event account created, and the message it stores read
//     from the simulation — the message our burn WOULD produce passes our own mint check;
//  c  that message, attested by TEST attesters (as in scripts/fork-cctp.mts), minted on the Base fork by the signer-built
//     receiveMessage: the real EVM contracts accept a Solana-sourced message with these fields;
//  s  signature format of the two-signer v1 transaction, with the fresh key's own (unfunded) address and sigVerify:true;
//  d  EVM → Solana: the signer-built burn toward the wallet's Solana token account mined on the fork; the message read from
//     the fork checked by the Solana-side verifier; the signer-built receive_message simulated on mainnet (it stops at the
//     attestation, which only Circle can produce for a real burn);
//  b  REAL attested EVM → Solana messages from Circle's Iris: the signer-built receive_message for each, simulated on mainnet —
//     success for one that is still unminted (when one is found in flight), "already in use" for one that was minted;
//  r  reclaim_event_account as built by our code, simulated for real event accounts (older and younger than five days);
//  e  what the signer refuses.
//
//   npx tsx scripts/sim-solana-cctp.mts          (needs anvil; ≈ 3–5 minutes: the public RPC endpoints are rate-limited)
//   npx tsx scripts/sim-solana-cctp.mts --record (also rewrites packages/core/test/fixtures/cctp-sol/simulated.json)
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, hexToBigInt, keccak256, numberToHex, parseAbi, type Hex } from 'viem';
import {
  bridgeOf, buildCctpSolReclaimMessage, CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_SOL_DISC, CCTP_SOL_EVENT_ACCOUNT_BYTES, CCTP_SOL_EVENT_RENT, CCTP_SOL_FEE_RECIPIENT, CCTP_SOL_MESSAGE_TRANSMITTER, CCTP_SOL_NONCE_RENT,
  CCTP_SOL_PINS, CCTP_SOL_TOKEN_MESSENGER_MINTER, CCTP_TOKEN_MESSENGER, cctpBytes32, cctpEnd, cctpMessageHash, cctpSolAddress, cctpSolBytes32, cctpSolMintRetryBytes, cctpSolPda, cctpSolReclaimBytes, cctpSolTokenAccount, cctpSolUsdc,
  cctpUsdc, decodeCctpMessage, decodeCctpSolEventAccount, decodeSolV1Message, encodeCctpMessage, expectedCctpSolSourceMessage, formatUnits, intentHash, NETWORKS, solAddress, solTokenAccountHash, solV1WireSigned, TOKEN_PROGRAM,
  type CctpBridge, type CctpMessage, type Intent, type SolBudget, type SolTokenAccountRequest,
} from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys, type Keys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';
import { attestMessage, balanceOf, dealToken, enableTestAttesters, mine, setNative, startForks } from './lib/fork-helpers.mts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', FORK_PORT = Number(process.env.SIM_FORK_PORT ?? 8591), EVM = 'base', RECORD = process.argv.includes('--record');
const recorded: Record<string, unknown> = { note: 'Written by scripts/sim-solana-cctp.mts --record: results of mainnet simulations (nothing was sent) and the public message they used.', recordedAt: new Date().toISOString() };
const REAL_RPC = Object.fromEntries(Object.entries(NETWORKS).map(([id, n]) => [id, [...n.rpc]])); // before any override
const say = (s: string) => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const note = (s: string) => say(`  --   ${s}`);
async function refused(label: string, p: Promise<unknown>, re: RegExp) { try { await p; check(false, `${label}: was NOT refused`); } catch (e) { const m = (e as Error).message; check(re.test(m), `${label} -> refused: ${m.slice(0, 120)}`); } }
const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const sol9 = (v: bigint | number) => formatUnits(BigInt(v), 9), u6 = (v: bigint) => formatUnits(v, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The public Solana endpoints limit requests per IP: space the calls of this script (and of the API code it runs) and retry on 429.
{
  const plain = globalThis.fetch, last = new Map<string, number>();
  globalThis.fetch = async (input: any, init?: any) => {
    const host = new URL(typeof input === 'string' ? input : input.url ?? String(input)).host;
    if (!/solana/.test(host)) return plain(input, init);
    for (let k = 0; ; k++) {
      const at = Math.max(Date.now(), (last.get(host) ?? 0) + 300); last.set(host, at);
      await sleep(at - Date.now());
      const r = await plain(input, init).catch((e) => { if (k >= 4) throw e; return null; });
      if (r && r.status !== 429) return r;
      if (k >= 6) return r!;
      last.set(host, Date.now() + 3000 * (k + 1));
    }
  };
}
const SOLRPC = REAL_RPC.solana!;
const rpcOne = async <T,>(u: string, method: string, params: unknown[]): Promise<T> => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(j.error.message); return j.result; };
const rpc = async <T,>(method: string, params: unknown[]): Promise<T> => { let last: unknown; for (let k = 0; k < 3; k++) for (const u of SOLRPC) { try { return await rpcOne<T>(u, method, params); } catch (e) { last = e; if (!/fetch failed|429|Too many|timeout/i.test((e as Error).message)) throw e; } } throw last; };
interface Sim { err: unknown; logs: string[] | null; unitsConsumed?: number; fee?: number; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: any[]; postTokenBalances?: any[]; accounts?: ({ owner: string; lamports: number; data: [string, string] } | null)[] }
const sim = async (rawB64: string, o: { sigVerify: boolean; accounts?: string[] }): Promise<Sim> => (await rpc<{ value: Sim }>('simulateTransaction', [rawB64, { encoding: 'base64', commitment: 'confirmed', sigVerify: o.sigVerify, replaceRecentBlockhash: !o.sigVerify, ...(o.accounts ? { accounts: { encoding: 'base64', addresses: o.accounts } } : {}) }])).value;
const acct = async (a: string, encoding = 'base64') => (await rpc<{ value: any }>('getAccountInfo', [a, { encoding, commitment: 'confirmed' }])).value;
const blockhash = async () => (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
const split = (rawB64: string) => { const wire = new Uint8Array(Buffer.from(rawB64, 'base64')), n = wire[1]!, msg = wire.subarray(0, wire.length - 64 * n); return { wire, msg, d: decodeSolV1Message(msg), sigs: n }; };
const tokDelta = (s: Sim, keys: string[], account: string) => { const k = keys.indexOf(account), f = (t?: any[]) => BigInt(t?.find((b) => b.accountIndex === k)?.uiTokenAmount.amount ?? '0'); return f(s.postTokenBalances) - f(s.preTokenBalances); };
const lamDelta = (s: Sim, keys: string[], account: string) => { const k = keys.indexOf(account); return BigInt(s.postBalances![k]!) - BigInt(s.preBalances![k]!); };
const errLine = (s: Sim) => `${JSON.stringify(s.err)} — ${(s.logs ?? []).filter((l) => /Error|error|already in use|failed/.test(l)).slice(0, 2).join(' | ').slice(0, 230)}`;

// --- the signer: a fresh random key. A stand-in makes a PUBLIC address play the wallet on Solana and/or on the EVM networks.
const realKeys = deriveKeys(generateMnemonic(wordlist, 128)), ME_EVM = realKeys.addresses.evm, ME_SOL = realKeys.addresses.solana!;
function makeSigner(standIn: { sol?: string; evm?: string } = {}, policy?: (s: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-simcctp-')), store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('sim-setup').digest('hex'); policy?.(store);
  const addresses = { ...realKeys.addresses };
  if (standIn.sol) { addresses.sol = standIn.sol; addresses.solana = standIn.sol; }
  if (standIn.evm) for (const n of Object.values(NETWORKS)) if (n.family === 'evm') { addresses[n.id] = standIn.evm; addresses.evm = standIn.evm; }
  const keys: Keys = { ...realKeys, addresses }, t = { now: Math.floor(Date.now() / 1000) };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now), pk = new TestPasskey(RP, ORIGIN);
  return { signer, pk, store, keys, t, ready: signer.enroll({ credential: pk.credential(), setupToken: 'sim-setup' }) };
}
type Harness = ReturnType<typeof makeSigner>;
const approve = async (h: Harness, i: Intent, aux?: Record<string, unknown>) => { await h.ready; h.t.now = Math.floor(Date.now() / 1000); return h.signer.sign(i, h.pk.assert(intentHash(i)), aux); };
/** what Circle does off-chain: assign a nonce, record the executed finality (and, for Fast, the fee and an expiry) */
const asCircle = (m: CctpMessage, o: { fee?: bigint; expiration?: bigint } = {}): Hex => encodeCctpMessage({ ...m, nonce: randomBytes(32).toString('hex'), finalityThresholdExecuted: m.minFinalityThreshold, body: { ...m.body, feeExecuted: o.fee ?? 0n, expirationBlock: o.expiration ?? 0n } });

const forks = await startForks([EVM], FORK_PORT);
process.on('exit', () => forks.kill());
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 's'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ [EVM]: [forks.url(EVM), forks.url(EVM)] }) });
const warn = console.warn; console.warn = () => {}; // the test-only override banner (the Base endpoints are the local fork; Solana's are the real ones)
const bridgeSol = await import('../services/api/src/bridge-sol.ts');
const { sql } = await import('../services/api/src/db.ts');
console.warn = warn;
const N = NETWORKS.solana!, USDC_SOL = cctpSolUsdc().id, USDC_EVM = cctpUsdc(EVM).id, evmNet = NETWORKS[EVM]!;
const frpc = <T,>(method: string, params: unknown[] = []) => forks.rpc<T>(EVM, method, params);
const mineTx = async (raw: string) => { const h = await frpc<string>('eth_sendRawTransaction', [raw]); for (let k = 0; k < 400; k++) { const rc = await frpc<any>('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); } throw new Error('no receipt'); };
const evmGas = async () => { const b = await frpc<any>('eth_getBlockByNumber', ['latest', false]); return hexToBigInt(b.baseFeePerGas) * 2n + 1_000_000_000n; };
const mintGas = async (from: string) => ({ nonce: Number(await frpc<string>('eth_getTransactionCount', [from, 'latest'])), gasLimit: '300000', maxFeePerGas: (await evmGas()).toString(), maxPriorityFeePerGas: '1000000000' });
// anvil reports a 1 gwei priority fee (far above the real one on Base): the native fee ceiling of Base is raised FOR THIS FORK ONLY, as in fork-cctp.mts
const forkPolicy = (s: Store) => { s.policy = { ...s.policy, maxFee: { ...s.policy.maxFee, [EVM]: (BigInt(s.policy.maxFee[EVM]!) * 20n).toString() } }; };

try {
  say(`fresh wallet for this run: EVM ${ME_EVM}, Solana ${ME_SOL} (random, never funded); Base fork at block ${Number(await frpc<string>('eth_blockNumber'))}`);

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[0] the two Circle programs, as pinned, and the state the code relies on (read-only)');
  for (const [name, pin] of [['MessageTransmitterV2', CCTP_SOL_PINS.transmitter], ['TokenMessengerMinterV2', CCTP_SOL_PINS.messenger]] as const) for (const u of SOLRPC) {
    const prog = Buffer.from((await rpcOne<any>(u, 'getAccountInfo', [pin.program, { encoding: 'base64', commitment: 'finalized' }])).value.data[0], 'base64');
    const full = Buffer.from((await rpcOne<any>(u, 'getAccountInfo', [pin.programData, { encoding: 'base64', commitment: 'finalized' }])).value.data[0], 'base64');
    const slot = Number(full.readBigUInt64LE(4)), auth = full[12] ? solAddress(full.subarray(13, 45)) : 'none (immutable)', code = createHash('sha256').update(full.subarray(45)).digest('hex');
    check(solAddress(prog.subarray(4, 36)) === pin.programData && slot === pin.lastDeploySlot && auth === pin.upgradeAuthority && code === pin.codeSha256,
      `${name} ${short(pin.program)} on ${new URL(u).host}: ProgramData ${short(pin.programData)}, last deployed at slot ${slot}, upgrade authority ${auth}, executable ${full.length - 45} bytes sha256 ${code.slice(0, 16)}…`);
  }
  for (const pin of [CCTP_SOL_PINS.transmitter, CCTP_SOL_PINS.messenger]) { const a = await acct(pin.upgradeAuthority); note(`upgrade authority ${pin.upgradeAuthority}: owner ${a?.owner}, ${Buffer.from(a?.data?.[0] ?? '', 'base64').length} bytes of data — a system-owned address (a key, not a visible multisig); it can replace the program at any time`); }
  const tm = Buffer.from((await acct(cctpSolPda.tokenMessenger())).data[0], 'base64');
  check(solAddress(tm.subarray(109, 141)) === CCTP_SOL_FEE_RECIPIENT, `token_messenger state: fee recipient ${solAddress(tm.subarray(109, 141))} (pinned), Standard minimum fee ${tm.readUInt32LE(173)} / 10⁷, message body version ${tm.readUInt32LE(104)}`);
  let remotes = 0;
  for (const [id, p] of Object.entries(CCTP_ENABLED)) { const a = await acct(cctpSolPda.remoteTokenMessenger(p.domain)); const d = a ? Buffer.from(a.data[0], 'base64') : null; if (d && d.readUInt32LE(8) === p.domain && d.subarray(12, 44).toString('hex') === cctpBytes32(CCTP_TOKEN_MESSENGER)) remotes++; else say(`       ${id}: remote token messenger account missing or different`); }
  check(remotes === Object.keys(CCTP_ENABLED).length, `remote_token_messenger PDA of each of the ${remotes} EVM domains holds the pinned EVM TokenMessengerV2 (the "recipient" of a Solana-sourced message)`);
  const remoteOnEvm = await frpc<Hex>('eth_call', [{ to: CCTP_TOKEN_MESSENGER, data: encodeFunctionData({ abi: parseAbi(['function remoteTokenMessengers(uint32) view returns (bytes32)']), functionName: 'remoteTokenMessengers', args: [5] }) }, 'latest']);
  check(remoteOnEvm.slice(2) === cctpSolBytes32(CCTP_SOL_TOKEN_MESSENGER_MINTER), `${evmNet.name}: TokenMessengerV2.remoteTokenMessengers(5) = ${remoteOnEvm.slice(0, 18)}… = the Solana TokenMessengerMinterV2 program id (the "sender" a Solana-sourced message must carry)`);
  const mint = await acct(USDC_SOL, 'jsonParsed');
  check(mint.owner === TOKEN_PROGRAM && mint.data.parsed.info.decimals === 6, `USDC ${USDC_SOL}: a classic SPL Token mint (owner ${short(mint.owner)}), 6 decimals; freeze authority ${mint.data.parsed.info.freezeAuthority ?? 'none'}`);
  const rents = await Promise.all([CCTP_SOL_EVENT_ACCOUNT_BYTES, 9, 165, 0].map((b) => rpc<number>('getMinimumBalanceForRentExemption', [b])));
  check(BigInt(rents[0]!) === CCTP_SOL_EVENT_RENT && BigInt(rents[1]!) === CCTP_SOL_NONCE_RENT, `rent measured now: event account (428 bytes) ${sol9(rents[0]!)} SOL — refundable; used-nonce record (9 bytes) ${sol9(rents[1]!)} SOL; token account (165 bytes) ${sol9(rents[2]!)} SOL; minimum of a wallet account ${sol9(rents[3]!)} SOL`);

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[a] Solana → EVM: the burn, prepared by the API code and signed by the signer, for a public address standing in as the wallet');
  let W = '';
  for (const c of ['GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', 'oMcssxWxgooErb8bsRA4QN34VHhvfeEbdDjrwF6WH45']) {
    const lam = (await rpc<{ value: number }>('getBalance', [c])).value, ta = await acct(cctpSolTokenAccount(c), 'jsonParsed');
    if (lam > 50_000_000 && BigInt(ta?.data?.parsed?.info?.tokenAmount?.amount ?? '0') > 100_000_000n) { W = c; note(`stand-in wallet ${c}: ${sol9(lam)} SOL, ${u6(BigInt(ta.data.parsed.info.tokenAmount.amount))} USDC in its associated token account ${cctpSolTokenAccount(c)}`); break; }
  }
  if (!W) throw new Error('no funded public address found to stand in as the wallet');
  await setNative(forks, EVM, ME_EVM, '1'); await dealToken(forks, EVM, USDC_EVM, ME_EVM, 100_000000n);
  const att = await enableTestAttesters(forks, EVM);
  note(`[fork only] ${evmNet.name} fork: two TEST attesters enabled through the impersonated attester manager ${att.manager} (threshold stays ${att.threshold}); the fresh wallet got 1 ETH and 100 USDC there`);
  const h = makeSigner({ sol: W }, forkPolicy); await h.ready;
  const burns: { speed: 'standard' | 'fast'; intent: Intent; raw: string; eventAccount: string; stored: Uint8Array; fee: bigint }[] = [];
  for (const [speed, amount] of [['standard', 25_000000n], ['fast', 20_000000n]] as const) {
    const ps = await bridgeSol.prepareSolBurn({ n: N, dst: evmNet, me: W, recipient: ME_EVM, keyId: h.keys.keyId, amount, speed, policyVersion: h.store.policy.version, proposalId: crypto.randomUUID(), feeCeiling: BigInt(h.store.policy.maxFee.solana!), destFeeCeiling: BigInt(h.store.policy.maxFee[EVM]!), ttlSec: 120 });
    say(`  ${speed}: ${u6(amount)} USDC → ${evmNet.name}; Circle fee ceiling ${u6(ps.fee)} USDC; network fee ${sol9(ps.networkFee)} SOL (2 signatures + priority, limit ${ps.intent.sol!.computeUnitLimit} CU, ${ps.unitsConsumed} used); refundable deposit ${sol9(ps.deposit)} SOL; approved ceiling ${sol9(BigInt(ps.intent.maxFee))} SOL (policy: ${sol9(BigInt(h.store.policy.maxFee.solana!))})`);
    check(true, `API preparation: both program pins, USDC mint, fee recipient, wallet account, balances, destination gas on ${evmNet.name}, and a simulation of the exact transaction (with a throwaway key as event account) — all passed`);
    const signed = await approve(h, ps.intent);
    const { msg, d } = split(signed.raw), ev = signed.eventAccount!;
    check(d.numSigners === 2 && d.keys[0] === W && d.keys[1] === ev && ev !== ps.eventAccount && d.instructions.length === 1 && d.instructions[0]!.program === CCTP_SOL_TOKEN_MESSENGER_MINTER,
      `signed after the passkey: one instruction (deposit_for_burn, ${d.instructions[0]!.accounts.length} accounts, ${d.keys.length} keys, ${Buffer.from(signed.raw, 'base64').length} bytes), two signers — the wallet and the event account ${ev} generated by the signer for this burn (not the API's throwaway key)`);
    const s = await sim(signed.raw, { sigVerify: false, accounts: [ev] });
    if (s.err) { check(false, `simulation of the signed burn failed: ${errLine(s)}`); continue; }
    const ata = cctpSolTokenAccount(W), evAcc = s.accounts![0]!, evData = new Uint8Array(Buffer.from(evAcc.data[0], 'base64')), stored = decodeCctpSolEventAccount(evData);
    check(tokDelta(s, d.keys, ata) === -amount, `simulation on mainnet: SUCCESS (${s.unitsConsumed} CU); the wallet's USDC token account is debited exactly ${u6(-tokDelta(s, d.keys, ata))} USDC`);
    check(evAcc.owner === CCTP_SOL_MESSAGE_TRANSMITTER && evData.length === CCTP_SOL_EVENT_ACCOUNT_BYTES && BigInt(evAcc.lamports) === ps.deposit && stored.rentPayer === W,
      `event account created: ${evData.length} bytes, owner ${short(evAcc.owner)}, rent ${sol9(evAcc.lamports)} SOL, recorded rent payer = the wallet (so the wallet alone can reclaim it)`);
    check(lamDelta(s, d.keys, W) === -(ps.networkFee + ps.deposit) && BigInt(s.fee!) === ps.networkFee, `the wallet pays ${sol9(-lamDelta(s, d.keys, W))} SOL = fee ${sol9(s.fee!)} + deposit ${sol9(ps.deposit)}; nothing else moves`);
    const m = decodeCctpMessage(`0x${Buffer.from(stored.message).toString('hex')}`);
    check(encodeCctpMessage(m) === encodeCctpMessage(expectedCctpSolSourceMessage(ps.intent)), 'the 376-byte message stored by the program is, byte for byte, the one the approved intent implies');
    say(`       sourceDomain ${m.sourceDomain} → destinationDomain ${m.destinationDomain}; sender ${cctpSolAddress(m.sender)} (TokenMessengerMinterV2); recipient 0x${m.recipient.slice(24)} (EVM TokenMessengerV2)`);
    say(`       burnToken ${cctpSolAddress(m.body.burnToken)}; amount ${m.body.amount}; mintRecipient 0x${m.body.mintRecipient.slice(24)} (the wallet's EVM address); messageSender ${cctpSolAddress(m.body.messageSender)} (the wallet's Solana public key); maxFee ${m.body.maxFee}; minFinality ${m.minFinalityThreshold}; destinationCaller 0`);
    check(cctpSolAddress(m.body.messageSender) === W && m.body.mintRecipient === cctpBytes32(ME_EVM) && m.sender === cctpSolBytes32(CCTP_SOL_TOKEN_MESSENGER_MINTER), 'messageSender = the wallet public key, mintRecipient = the wallet\'s own EVM address, sender = Circle\'s Solana token messenger');
    burns.push({ speed, intent: ps.intent, raw: signed.raw, eventAccount: ev, stored: stored.message, fee: ps.fee });
    if (speed === 'standard') recorded.burn = { wallet: W, intent: ps.intent, eventAccount: ev, eventAccountData: Buffer.from(evData).toString('hex'), eventAccountLamports: evAcc.lamports, fee: s.fee, unitsConsumed: s.unitsConsumed, usdcDelta: tokDelta(s, d.keys, ata).toString(), lamportsDelta: lamDelta(s, d.keys, W).toString() };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say(`\n[c] the EVM mint of those Solana-sourced messages on the ${evmNet.name} fork (real contracts; attestation by the TEST attesters)`);
  const feeTo = ('0x' + (await frpc<Hex>('eth_call', [{ to: CCTP_TOKEN_MESSENGER, data: encodeFunctionData({ abi: parseAbi(['function feeRecipient() view returns (address)']), functionName: 'feeRecipient' }) }, 'latest'])).slice(26)) as Hex;
  for (const b of burns) {
    const src = decodeCctpMessage(`0x${Buffer.from(b.stored).toString('hex')}`), fast = b.speed === 'fast', fee = fast ? b.fee - 1n : 0n;
    const message = asCircle(src, fast ? { fee, expiration: hexToBigInt(await frpc<Hex>('eth_blockNumber')) + 1_000_000n } : {}), attestation = await attestMessage(message, att);
    const before = await balanceOf(forks, EVM, USDC_EVM, ME_EVM), feeBefore = await balanceOf(forks, EVM, USDC_EVM, feeTo), g = await mintGas(ME_EVM);
    const r = await h.signer.signBridgeMint({ proposalId: b.intent.proposalId, message, attestation, evm: g });
    check(r.minted === (BigInt(b.intent.amount) - fee).toString(), `${b.speed}: the signer accepts the message its own burn produces (verifier: source domain 5, Solana token messenger, USDC mint, wallet key as sender, own EVM address as recipient) and signs the one receiveMessage, no second passkey`);
    const rc = await mineTx(r.raw), got = (await balanceOf(forks, EVM, USDC_EVM, ME_EVM)) - before;
    check(rc.status === '0x1' && got === BigInt(b.intent.amount) - fee, `${b.speed}: receiveMessage mined on the fork (gas ${Number(rc.gasUsed)}): the wallet's EVM address received ${u6(got)} USDC${fast ? `, Circle's fee recipient ${u6((await balanceOf(forks, EVM, USDC_EVM, feeTo)) - feeBefore)} USDC (ceiling ${u6(b.fee)})` : ''}`);
    const used = hexToBigInt(await frpc<Hex>('eth_call', [{ to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'usedNonces', args: [`0x${decodeCctpMessage(message).nonce}`] }) }, 'latest']));
    check(used === 1n, `${b.speed}: the nonce is marked used on ${evmNet.name}`);
    if (!fast) {
      await refused('a second mint request for the same bridge (new nonce)', h.signer.signBridgeMint({ proposalId: b.intent.proposalId, message, attestation, evm: { ...g, nonce: g.nonce + 1 } }), /already signed for this bridge/);
      const forged = encodeCctpMessage({ ...decodeCctpMessage(message), nonce: randomBytes(32).toString('hex'), sender: cctpSolBytes32('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') });
      await refused('on-chain: the same message "sent" by another Solana program, attested by the test attesters', frpc('eth_call', [{ from: ME_EVM, to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [forged, await attestMessage(forged, att)] }) }, 'latest']), /Remote TokenMessenger unsupported|revert/i);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[s] signature format of the two-signer transaction: the fresh key\'s own (unfunded) address, simulated with signature verification ON');
  {
    const own = makeSigner(), bh = await blockhash(), t = Math.floor(Date.now() / 1000);
    const i: Intent = { ...burns[0]!.intent, proposalId: crypto.randomUUID(), keyId: own.keys.keyId, from: ME_SOL, to: ME_SOL, createdAt: t, expiresAt: t + 60, sol: { ...burns[0]!.intent.sol!, recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight } };
    const signed = await approve(own, i), { wire } = split(signed.raw);
    const verdict = (w: Uint8Array) => sim(Buffer.from(w).toString('base64'), { sigVerify: true }).then((s) => JSON.stringify(s.err), (e: Error) => `node error: ${e.message}`);
    const good = await verdict(wire), flip = (at: number) => { const b = Uint8Array.from(wire); b[at]! ^= 1; return b; };
    const badWallet = await verdict(flip(wire.length - 128)), badEvent = await verdict(flip(wire.length - 1));
    say(`       ${wire.length}-byte v1 transaction = message + 2 signatures (wallet, event account)`);
    check(!/signature/i.test(good) && /AccountNotFound|InsufficientFunds/i.test(good), `both genuine signatures pass verification; the node then answers ${good} (the fee payer has never been funded)`);
    check(/SignatureFailure|signature verification/i.test(badWallet), `one bit flipped in the wallet's signature: ${badWallet}`);
    check(/SignatureFailure|signature verification/i.test(badEvent), `one bit flipped in the event account's signature: ${badEvent}`);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say(`\n[d] EVM → Solana: the burn toward the wallet's Solana token account, mined on the ${evmNet.name} fork; the mint simulated on mainnet`);
  {
    const ta = await bridgeSol.solTokenAccount(N, W), dest = await bridgeSol.solDestination(N, W);
    check(ta.exists && ta.address === cctpSolTokenAccount(W), `preparation: the wallet's USDC token account on Solana ${ta.address} exists on both RPC endpoints; receiving needs ${sol9(dest.need)} SOL (fee + ${sol9(dest.nonceRent)} for the used-nonce record), the wallet has ${sol9(dest.balance)} available`);
    const fresh = await bridgeSol.solTokenAccount(N, ME_SOL);
    check(!fresh.exists, `an address without a USDC token account (${short(ME_SOL)}): reported missing (${fresh.address}); the API refuses to prepare a burn toward it ("token_account_missing") and offers to create it first (deposit ${sol9(fresh.rent)} SOL)`);
    const now = Math.floor(Date.now() / 1000), mf = await evmGas(), amount = 20_000000n;
    const i: Intent = { v: 1, proposalId: crypto.randomUUID(), keyId: h.keys.keyId, network: EVM, chainRef: evmNet.chainRef, asset: USDC_EVM, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: ME_EVM, to: ME_EVM, maxFee: (270_000n * mf).toString(), createdAt: now, expiresAt: now + 120, policyVersion: h.store.policy.version,
      bridge: { provider: 'cctp', toNetwork: 'solana', toDomain: 5, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', recipient: W },
      evm: { nonce: Number(await frpc<string>('eth_getTransactionCount', [ME_EVM, 'latest'])), gasLimit: '200000', maxFeePerGas: mf.toString(), maxPriorityFeePerGas: '1000000000' } };
    const signed = await approve(h, i), bal0 = await balanceOf(forks, EVM, USDC_EVM, ME_EVM);
    const args = decodeFunctionData({ abi: CCTP_ABI, data: (await import('viem')).parseTransaction(signed.raw as Hex).data! }).args as readonly unknown[];
    check(args[2] === `0x${cctpSolBytes32(ta.address)}` && args[1] === 5 && args[4] === `0x${'0'.repeat(64)}`, `signer-built depositForBurn: destination domain 5, mintRecipient = ${cctpSolAddress(String(args[2]).slice(2))} = the wallet's associated USDC token account (not the wallet address ${short(W)}), destination caller 0`);
    const rcA = await mineTx(signed.pre!.raw), rcB = await mineTx(signed.raw);
    check(rcA.status === '0x1' && rcB.status === '0x1' && bal0 - (await balanceOf(forks, EVM, USDC_EVM, ME_EVM)) === amount, `approval and burn mined on the fork (gas ${Number(rcA.gasUsed)} + ${Number(rcB.gasUsed)}): ${u6(amount)} USDC burned — the real TokenMessengerV2 accepts Solana (domain 5) and this recipient`);
    let onChain: Hex | null = null;
    for (const l of rcB.logs) { if (l.address.toLowerCase() !== CCTP_MESSAGE_TRANSMITTER.toLowerCase()) continue; try { const e = decodeEventLog({ abi: CCTP_ABI, data: l.data, topics: l.topics }); if (e.eventName === 'MessageSent') onChain = e.args.message; } catch { /* another event */ } }
    const m = decodeCctpMessage(onChain!);
    check(m.sourceDomain === CCTP_ENABLED[EVM]!.domain && m.destinationDomain === 5 && cctpSolAddress(m.recipient) === CCTP_SOL_TOKEN_MESSENGER_MINTER && cctpSolAddress(m.body.mintRecipient) === ta.address && m.body.messageSender === cctpBytes32(ME_EVM) && m.body.amount === amount && m.destinationCaller === '0'.repeat(64),
      `the message emitted by the real contract: domain ${m.sourceDomain} → 5, recipient = ${cctpSolAddress(m.recipient)} (the Solana token messenger program), mintRecipient = the wallet's token account, messageSender = the wallet's EVM address, ${u6(m.body.amount)} USDC, no destination caller, 376 bytes`);
    const message = asCircle(m), attestation = await attestMessage(message, att), bh = await blockhash();
    const g: SolBudget = { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 400_000, computeUnitPrice: '0' };
    const mintTx = await h.signer.signBridgeMint({ proposalId: i.proposalId, message, attestation, sol: g }), { d } = split(mintTx.raw);
    check(d.numSigners === 1 && d.payer === W && d.instructions.length === 1 && d.instructions[0]!.program === CCTP_SOL_MESSAGE_TRANSMITTER && d.instructions[0]!.accounts[15] === ta.address && mintTx.minted === amount.toString(),
      `the Solana-side verifier accepts it and the signer builds receive_message (${d.instructions[0]!.accounts.length} accounts, ${Buffer.from(mintTx.raw, 'base64').length} bytes, no lookup table): payer = caller = the wallet, credited account = its own token account`);
    const s = await sim(mintTx.raw, { sigVerify: false });
    check(!!s.err && /InvalidAttesterSignature|InvalidSignatureOrderOrDupe|InvalidAttestation/.test((s.logs ?? []).join(' ')), `simulated on mainnet, it is refused exactly where expected — at the attestation, which only Circle can sign for a real burn (the test attesters' is not): ${errLine(s)}`);
    note('what ran before that check, on mainnet: the nine accounts of the instruction were validated, the used-nonce record was allocated, the message version matched. The eleven accounts handed on to the token messenger are exercised with a real attestation in [b]');
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[b] REAL attested EVM → Solana messages (Circle Iris): the signer-built receive_message simulated on mainnet');
  interface Cand { network: string; txHash: string; message: Hex; attestation: Hex; m: CctpMessage; owner: string; used: boolean }
  const usdcSolHex = cctpSolBytes32(USDC_SOL);
  async function candidate(network: string, txHash: string, wantUsed: boolean, maxAmount: bigint): Promise<Cand | null> {
    const r = await fetch(`https://iris-api.circle.com/v2/messages/${CCTP_ENABLED[network]!.domain}?transactionHash=${txHash}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r?.ok) return null;
    for (const im of ((await r.json()) as any).messages ?? []) {
      if (im.status !== 'complete' || im.cctpVersion !== 2 || typeof im.message !== 'string' || im.message.length !== 2 + 376 * 2) continue;
      const m = decodeCctpMessage(im.message);
      if (m.destinationDomain !== 5 || m.destinationCaller !== '0'.repeat(64) || m.body.amount > maxAmount || m.body.amount < 1000n || m.body.burnToken !== cctpEnd(network)!.usdc || usdcSolHex === '') continue;
      const used = (await acct(cctpSolPda.usedNonce(m.nonce))) !== null;
      if (used !== wantUsed) continue;
      const tokenAccount = cctpSolAddress(m.body.mintRecipient), a = await acct(tokenAccount, 'jsonParsed');
      const owner = a?.data?.parsed?.info?.owner as string | undefined;
      if (!owner || a.owner !== TOKEN_PROGRAM || a.data.parsed.info.mint !== USDC_SOL || cctpSolTokenAccount(owner) !== tokenAccount) continue; // must be the owner's associated account (ours always is)
      if ((await rpc<{ value: number }>('getBalance', [owner])).value < 2_000_000) continue;
      return { network, txHash, message: im.message.toLowerCase(), attestation: im.attestation.toLowerCase(), m, owner, used };
    }
    return null;
  }
  /** recent burns toward Solana on an EVM network, read from its real endpoints (small log windows, read-only) */
  async function scan(network: string, minutesBack: number, blockSec: number, wantUsed: boolean, budgetMs: number, maxAmount = 50_000000n): Promise<Cand | null> {
    const t0 = Date.now(), urls = [...REAL_RPC[network]!].reverse();
    const real = async <T,>(method: string, params: unknown[]): Promise<T> => { let last = ''; for (const u of urls) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) }); const j = await r.json() as any; if (j.result !== undefined) return j.result; last = j.error?.message ?? 'no result'; } catch (e) { last = (e as Error).message; } } throw new Error(last); };
    const topic = keccak256(new TextEncoder().encode('MessageSent(bytes)'));
    let head: number; try { head = Number(await real<string>('eth_blockNumber', [])); } catch { return null; }
    const span = Math.max(20, Math.min(400, Math.round(300 / blockSec)));
    for (let to = head; to > head - (minutesBack * 60) / blockSec && Date.now() - t0 < budgetMs; to -= span) {
      let logs: { transactionHash: string; data: Hex }[] = [];
      try { logs = await real('eth_getLogs', [{ address: CCTP_MESSAGE_TRANSMITTER, topics: [topic], fromBlock: numberToHex(to - span + 1), toBlock: numberToHex(to) }]); } catch { continue; }
      for (const l of logs.reverse()) {
        const hex = l.data.slice(2 + 128); if (hex.length < 376 * 2 || parseInt(hex.slice(16, 24), 16) !== 5 || parseInt(l.data.slice(2 + 64, 2 + 128), 16) !== 376) continue; // destination domain 5, no hook
        if (!/^0{64}$/.test(hex.slice(108 * 2, 140 * 2)) || BigInt('0x' + hex.slice((148 + 68) * 2, (148 + 100) * 2)) > maxAmount) continue; // anyone may mint it; within the amount looked for
        const c = await candidate(network, l.transactionHash, wantUsed, maxAmount).catch(() => null);
        if (c) return c;
      }
    }
    return null;
  }
  /** above the wallet's per-transfer limit the signer would (rightly) never have approved the burn: the transaction is then built by the very function the signer calls, without a signer */
  async function receiveLarge(c: Cand, label: string) {
    const net = NETWORKS[c.network]!, rec: CctpBridge = { fromNetwork: c.network, toNetwork: 'solana', wallet: `0x${c.m.body.messageSender.slice(24)}`, recipient: c.owner, amount: c.m.body.amount.toString(), maxFee: c.m.body.maxFee.toString(), minFinalityThreshold: c.m.minFinalityThreshold };
    const bh = await blockhash(), g: SolBudget = { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 400_000, computeUnitPrice: '0' };
    const core = await import('@spw/core'), built = core.buildCctpSolMintMessage(rec, c.message, c.attestation, g, 3_000_000n), keys = decodeSolV1Message(built.msg).keys, nonce = cctpSolPda.usedNonce(c.m.nonce);
    say(`  ${label}: burn ${c.txHash} on ${net.name} (${u6(c.m.body.amount)} USDC — above the wallet's 50 USDC limit, so no signer record can exist for it: built by buildCctpSolMintMessage, the function the signer calls) → token account ${built.tokenAccount} of ${c.owner}`);
    const s = await sim(Buffer.from(solV1WireSigned([new Uint8Array(64)], built.msg)).toString('base64'), { sigVerify: false, accounts: [nonce] }), got = s.err ? 0n : tokDelta(s, keys, built.tokenAccount);
    check(!s.err && got === c.m.body.amount - c.m.body.feeExecuted && lamDelta(s, keys, c.owner) === -(5000n + CCTP_SOL_NONCE_RENT) && s.accounts?.[0]?.owner === CCTP_SOL_MESSAGE_TRANSMITTER,
      s.err ? `NOT yet minted, but the simulation failed: ${errLine(s)}` : `NOT yet minted: the simulation SUCCEEDS (${s.unitsConsumed} CU) with Circle's real attestation — the token account is credited ${u6(got)} USDC (amount − fee), the payer spends ${sol9(5000n + CCTP_SOL_NONCE_RENT)} SOL (fee + used-nonce record), the record is created`);
  }
  async function receive(c: Cand, label: string) {
    const sender = `0x${c.m.body.messageSender.slice(24)}`, hh = makeSigner({ sol: c.owner, evm: sender }); await hh.ready;
    const now = Math.floor(Date.now() / 1000), net = NETWORKS[c.network]!;
    // the record the owner's passkey would have created when approving that burn: here the public sender and recipient stand in as the wallet
    const i: Intent = { v: 1, proposalId: crypto.randomUUID(), keyId: hh.keys.keyId, network: c.network, chainRef: net.chainRef, asset: cctpUsdc(c.network).id, symbol: 'USDC', decimals: 6, amount: c.m.body.amount.toString(), from: sender, to: sender, maxFee: '200000000000', createdAt: now, expiresAt: now + 120, policyVersion: hh.store.policy.version,
      bridge: { provider: 'cctp', toNetwork: 'solana', toDomain: 5, maxFee: c.m.body.maxFee.toString(), minFinalityThreshold: c.m.minFinalityThreshold, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '0', recipient: c.owner },
      evm: { nonce: 0, gasLimit: '200000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000000' } };
    await approve(hh, i);
    const bh = await blockhash(), g: SolBudget = { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 400_000, computeUnitPrice: '0' };
    const tx = await hh.signer.signBridgeMint({ proposalId: i.proposalId, message: c.message, attestation: c.attestation, sol: g }), { d } = split(tx.raw), ta = cctpSolTokenAccount(c.owner), nonce = cctpSolPda.usedNonce(c.m.nonce);
    say(`  ${label}: burn ${c.txHash} on ${net.name} (${u6(c.m.body.amount)} USDC, fee ${u6(c.m.body.feeExecuted)}, finality ${c.m.finalityThresholdExecuted}) → token account ${ta} of ${c.owner}`);
    const s = await sim(tx.raw, { sigVerify: false, accounts: [nonce] });
    recorded[c.used ? 'receiveUsed' : 'receiveInFlight'] = { network: c.network, burnTx: c.txHash, message: c.message, attestation: c.attestation, owner: c.owner, tokenAccount: ta, usedNonceAccount: nonce, budget: g,
      simulation: { err: s.err, unitsConsumed: s.unitsConsumed ?? null, credited: s.err ? null : tokDelta(s, d.keys, ta).toString(), payerLamportsDelta: s.err ? null : lamDelta(s, d.keys, c.owner).toString(), log: (s.logs ?? []).find((l) => /already in use/.test(l)) ?? null } };
    if (c.used) {
      check(!!s.err && (s.logs ?? []).some((l) => l.includes(nonce) && /already in use/.test(l)), `already minted: the simulation fails where the program records the nonce — "${(s.logs ?? []).find((l) => /already in use/.test(l))?.slice(0, 120)}" (${JSON.stringify(s.err)}); that address is the used-nonce record our code derives`);
    } else {
      const got = s.err ? 0n : tokDelta(s, d.keys, ta);
      check(!s.err && got === c.m.body.amount - c.m.body.feeExecuted && lamDelta(s, d.keys, c.owner) === -(5000n + CCTP_SOL_NONCE_RENT) && s.accounts?.[0]?.owner === CCTP_SOL_MESSAGE_TRANSMITTER,
        s.err ? `NOT yet minted, but the simulation failed: ${errLine(s)}` : `NOT yet minted: the simulation SUCCEEDS (${s.unitsConsumed} CU) with Circle's real attestation — the token account is credited ${u6(got)} USDC (amount − fee), the payer spends ${sol9(5000n + CCTP_SOL_NONCE_RENT)} SOL (fee + used-nonce record), the record is created`);
    }
    return { hh, i, tx, g };
  }
  // an already-minted one: the most recent burn toward Solana that qualifies, on a network where relayers mint within seconds
  let usedC: Cand | null = null, freshC: Cand | null = null;
  for (const [net, sec] of [['polygon', 2], ['base', 2], ['arbitrum', 0.25], ['avalanche', 2]] as const) { usedC = await scan(net, 240, sec, true, 60_000); if (usedC) break; }
  // one still in flight: attested, not minted yet (a short window — relayers are fast)
  // (a burn nobody claimed stays mintable for ever, so the search goes back a day; relayers mint most within seconds)
  const FRESH = [['base', 2, 1440], ['polygon', 2, 1440], ['ethereum', 12, 1440], ['optimism', 2, 1440], ['avalanche', 2, 1440], ['arbitrum', 0.25, 240]] as const;
  // burns seen unminted in an earlier run are looked at first (they are used only if still unminted now); SIM_INFLIGHT=<network>:<burn tx> adds one
  const HINTS = [process.env.SIM_INFLIGHT, 'ethereum:0x65edb84e5cca3894b032c86491243f8bd58d57e6c47ea1e0b5344d1a28bec74c'].filter((x): x is string => !!x).map((x) => x.split(':') as [string, string]);
  for (const [net, tx] of HINTS) { if (!CCTP_ENABLED[net]) continue; freshC = await candidate(net, tx, false, 50_000000n).catch(() => null); if (freshC) break; }
  if (!freshC) for (const [net, sec, back] of FRESH) { freshC = await scan(net, back, sec, false, 40_000); if (freshC) break; }
  let large: Cand | null = null;
  if (!freshC) for (const [net, sec, back] of FRESH) { large = await scan(net, back, sec, false, 40_000, 10n ** 13n); if (large) break; }
  let usedRun: Awaited<ReturnType<typeof receive>> | null = null;
  if (freshC) await receive(freshC, 'in flight');
  else if (large) await receiveLarge(large, 'in flight');
  else note('no attested-but-unminted EVM → Solana message without destination caller was found at run time (relayers mint within seconds): the success case is NOT shown in this run');
  if (usedC) usedRun = await receive(usedC, 'already minted'); else check(false, 'no recent EVM → Solana message could be fetched from Iris');
  if (usedRun && usedC) {
    const { hh, i, tx, g } = usedRun;
    check((await hh.signer.signBridgeMint({ proposalId: i.proposalId, message: usedC.message, attestation: usedC.attestation, sol: g })).raw === tx.raw, 'the identical request returns the same bytes (no new signature)');
    const g2 = { ...g, computeUnitPrice: '1000' };
    await refused('a second mint for the same bridge without the passkey', hh.signer.signBridgeMint({ proposalId: i.proposalId, message: usedC.message, attestation: usedC.attestation, sol: g2 }), /already signed for this bridge/);
    const again = await hh.signer.signBridgeMint({ proposalId: i.proposalId, message: usedC.message, attestation: usedC.attestation, sol: g2, assertion: hh.pk.assert(sha(cctpSolMintRetryBytes(i.proposalId, cctpMessageHash(usedC.message), g2))) });
    check(again.raw !== tx.raw, 'with a passkey assertion over the exact new parameters a second mint transaction is signed (for a mint that expired or failed)');
    const tampered = encodeCctpMessage({ ...usedC.m, body: { ...usedC.m.body, mintRecipient: cctpSolBytes32(usedC.owner) } });
    await refused('the same real message with the OWNER address as mint recipient instead of the token account', hh.signer.signBridgeMint({ proposalId: i.proposalId, message: tampered, attestation: usedC.attestation, sol: g }), /another address/);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[r] reclaim_event_account as our code builds it, simulated for REAL event accounts (public data; the payee is their rent payer)');
  {
    const fixture = JSON.parse((await import('node:fs')).readFileSync(new URL('../packages/core/test/fixtures/cctp-sol/real-transactions.json', import.meta.url), 'utf8')) as { burns: { signature: string; accounts: string[]; eventAccount: string; iris: { message: Hex; attestation: Hex }[] }[] };
    const recOf = (owner: string, m: CctpMessage): CctpBridge | null => { const dstNet = Object.entries(CCTP_ENABLED).find(([, p]) => p.domain === m.destinationDomain)?.[0]; return dstNet ? { fromNetwork: 'solana', toNetwork: dstNet, wallet: owner, recipient: `0x${m.body.mintRecipient.slice(24)}`, amount: m.body.amount.toString(), maxFee: m.body.maxFee.toString(), minFinalityThreshold: m.minFinalityThreshold } : null; };
    async function tryReclaim(owner: string, eventAccount: string, message: Hex, attestation: Hex) {
      const rec = recOf(owner, decodeCctpMessage(message)); if (!rec) return null;
      const bh = await blockhash(), g: SolBudget = { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 300_000, computeUnitPrice: '0' };
      const built = buildCctpSolReclaimMessage(rec, eventAccount, message, attestation, g, 3_000_000n);
      return { s: await sim(Buffer.from(solV1WireSigned([new Uint8Array(64)], built.msg)).toString('base64'), { sigVerify: false, accounts: [eventAccount] }), keys: decodeSolV1Message(built.msg).keys };
    }
    // younger than five days: the recorded burns of 2026-11-11
    let young = false;
    for (const b of fixture.burns) {
      const ev = await acct(b.eventAccount); if (!ev || b.accounts[0] !== b.accounts[1]) continue;
      const created = decodeCctpSolEventAccount(new Uint8Array(Buffer.from(ev.data[0], 'base64'))).createdAt;
      if (Date.now() / 1000 - created > 5 * 86400) continue;
      const r = await tryReclaim(b.accounts[0]!, b.eventAccount, b.iris[0]!.message, b.iris[0]!.attestation); if (!r) continue;
      check(!!r.s.err && /EventAccountWindowNotExpired|window not expired/i.test((r.s.logs ?? []).join(' ')), `an event account ${Math.round((Date.now() / 1000 - created) / 3600)} h old (${short(b.eventAccount)}): refused by the program — ${errLine(r.s)}`);
      young = true; break;
    }
    if (!young) note('no recorded event account younger than five days is still open: the "too early" refusal is not shown in this run');
    // older than five days and still open: walk back the burns (the sender-authority PDA appears only in deposit_for_burn)
    let before: string | undefined, old: { owner: string; ev: string; sig: string; created: number } | null = null; const t0 = Date.now();
    for (let page = 0; page < 60 && !old && Date.now() - t0 < 150_000; page++) {
      const sigs = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>('getSignaturesForAddress', [cctpSolPda.senderAuthority(), { limit: 1000, ...(before ? { before } : {}) }]);
      if (!sigs.length) break; before = sigs[sigs.length - 1]!.signature;
      if ((sigs[sigs.length - 1]!.blockTime ?? Date.now() / 1000) > Date.now() / 1000 - 5 * 86400 - 3600) continue;
      for (const sg of sigs.filter((x) => !x.err && (x.blockTime ?? 0) < Date.now() / 1000 - 5 * 86400 - 3600).slice(0, 40)) {
        const tx = await rpc<any>('getTransaction', [sg.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]).catch(() => null);
        if (!tx || tx.meta?.loadedAddresses?.writable?.length || tx.meta?.loadedAddresses?.readonly?.length) continue;
        const keys: string[] = tx.transaction.message.accountKeys;
        for (const ix of tx.transaction.message.instructions) {
          if (keys[ix.programIdIndex] !== CCTP_SOL_TOKEN_MESSENGER_MINTER || ix.accounts.length !== 18) continue;
          const a = ix.accounts.map((k: number) => keys[k]!) as string[], ev = await acct(a[11]!);
          if (a[0] === a[1] && ev && ev.owner === CCTP_SOL_MESSAGE_TRANSMITTER) { old = { owner: a[0]!, ev: a[11]!, sig: sg.signature, created: sg.blockTime ?? 0 }; break; }
        }
        if (old) break;
      }
    }
    if (old) {
      const ir = await fetch(`https://iris-api.circle.com/v2/messages/5?transactionHash=${old.sig}`).then((x) => x.json() as Promise<any>).catch(() => null), im = ir?.messages?.find((x: any) => x.status === 'complete' && x.message?.length === 2 + 752);
      const r = im ? await tryReclaim(old.owner, old.ev, im.message, im.attestation) : null;
      const closed = !r?.s.accounts?.[0] || r.s.accounts[0].lamports === 0; // a closed account comes back as null or as an empty system account
      if (r) check(!r.s.err && lamDelta(r.s, r.keys, old.owner) === CCTP_SOL_EVENT_RENT - 5000n && closed,
        r.s.err ? `an event account ${Math.round((Date.now() / 1000 - old.created) / 86400)} days old (${short(old.ev)}): simulation failed — ${errLine(r.s)}` : `an event account ${((Date.now() / 1000 - old.created) / 86400).toFixed(1)} days old (${old.ev}, burn ${short(old.sig)}): SUCCESS (${r.s.unitsConsumed} CU) — the account is closed and its rent payer receives ${sol9(lamDelta(r.s, r.keys, old.owner))} SOL (the ${sol9(CCTP_SOL_EVENT_RENT)} deposit less the 0.000005 fee), signed by the payee alone`);
      else note('an old open event account was found but its attested message could not be used (destination outside the wallet\'s networks or Iris unavailable): the successful reclaim is NOT shown in this run');
    } else note('no event account older than five days and still open was found within the time budget: the successful reclaim is NOT shown in this run');
  }

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[e] what the signer refuses (each request carries a valid passkey approval of exactly what is asked, unless said)');
  {
    const base = burns[0]!.intent, T = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', OTHER_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const mk = (o: Partial<Intent> = {}, b: Partial<NonNullable<Intent['bridge']>> = {}, s: Partial<NonNullable<Intent['sol']>> = {}): Intent => { const t = Math.floor(Date.now() / 1000); return { ...base, proposalId: crypto.randomUUID(), createdAt: t, expiresAt: t + 60, ...o, bridge: { ...base.bridge!, ...b }, sol: { ...base.sol!, ...s } }; };
    const before = Object.keys(h.store.state.bridges ?? {}).length;
    say(' burn on Solana:');
    await refused('another mint recipient (someone else\'s EVM address)', approve(h, mk({}, { recipient: OTHER_EVM })), /not this wallet's own address/);
    await refused('a Solana token account as mint recipient of a burn toward an EVM network', approve(h, mk({}, { recipient: cctpSolTokenAccount(T) })), /EVM address/);
    { const i = mk(); await h.ready; await refused('another amount than the one the owner approved', h.signer.sign({ ...i, amount: '45000000' }, h.pk.assert(intentHash(i))), /approval/); }
    await refused('an amount above the per-transfer limit', approve(h, mk({ amount: '60000000' })), /per-transaction limit/);
    await refused('another mint (USDT)', approve(h, mk({ asset: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' })), /registry USDC/);
    await refused('another destination domain than the destination network\'s', approve(h, mk({}, { toDomain: 3 })), /destination domain/);
    await refused('another payer / owner (a burn "from" another address)', approve(h, mk({ from: T, to: T })), /not controlled by this signer/);
    await refused('an unpinned program as token messenger', approve(h, mk({}, { messenger: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' })), /pinned TokenMessengerMinterV2/);
    await refused('an unpinned program as message transmitter', approve(h, mk({}, { transmitter: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' })), /pinned MessageTransmitterV2/);
    await refused('extra instructions handed over as helper data (a transaction message from the API)', approve(h, mk(), { swapMessage: Buffer.from(split(burns[0]!.raw).msg).toString('base64') }), /no helper data/);
    await refused('an event account that the signer did not generate (handed over by the API)', approve(h, mk(), { eventAccount: T }), /no helper data/);
    await refused('a fee ceiling above the policy', approve(h, mk({ maxFee: '3000001' })), /fee ceiling above policy/);
    await refused('a replay of an approved burn', h.signer.sign(base, h.pk.assert(intentHash(base))), /already signed/);
    check(Object.keys(h.store.state.bridges ?? {}).length === before, 'nothing was recorded by any of these');
    say(' mint on an EVM network of a Solana-sourced message:');
    const j = mk({ amount: '5000000' }), sj = await approve(h, j), src = expectedCctpSolSourceMessage(j), g = await mintGas(ME_EVM);
    const bad = async (o: Partial<CctpMessage>, body: Partial<CctpMessage['body']> = {}) => { const message = asCircle({ ...src, ...o, body: { ...src.body, ...body } }); return { proposalId: j.proposalId, message, attestation: await attestMessage(message, att), evm: g }; };
    await refused('mint recipient = another EVM address', h.signer.signBridgeMint(await bad({}, { mintRecipient: cctpBytes32(OTHER_EVM) })), /another address/);
    await refused('messageSender = the wallet\'s token account instead of its public key', h.signer.signBridgeMint(await bad({}, { messageSender: cctpSolBytes32(cctpSolTokenAccount(W)) })), /not burned by this wallet/);
    await refused('messageSender = another Solana wallet', h.signer.signBridgeMint(await bad({}, { messageSender: cctpSolBytes32(T) })), /not burned by this wallet/);
    await refused('another amount', h.signer.signBridgeMint(await bad({}, { amount: 6_000000n })), /another amount/);
    await refused('another mint', h.signer.signBridgeMint(await bad({}, { burnToken: cctpSolBytes32('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') })), /another token/);
    await refused('another source domain', h.signer.signBridgeMint(await bad({ sourceDomain: 3 })), /another source domain/);
    await refused('a destination caller', h.signer.signBridgeMint(await bad({ destinationCaller: cctpBytes32(OTHER_EVM) })), /destination caller/);
    await refused('a sender that is not Circle\'s Solana token messenger', h.signer.signBridgeMint(await bad({ sender: cctpSolBytes32(T) })), /pinned TokenMessengers/);
    await refused('a mint for a bridge that was never approved', h.signer.signBridgeMint({ ...(await bad({})), proposalId: crypto.randomUUID() }), /no approved bridge/);
    say(' reclaim of the event-account deposit, and the wallet\'s token account:');
    const okMsg = asCircle(src), okAtt = await attestMessage(okMsg, att), bh = await blockhash(), rg: SolBudget = { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 200_000, computeUnitPrice: '0' };
    const rc = (ev: string, b = rg) => h.pk.assert(sha(cctpSolReclaimBytes(j.proposalId, ev, cctpMessageHash(okMsg), b)));
    await refused('a reclaim before five days', h.signer.signBridgeReclaim({ proposalId: j.proposalId, message: okMsg, attestation: okAtt, sol: rg, assertion: rc(sj.eventAccount!) }), /five days/);
    h.t.now += 5 * 86400 + 120; // the signer's clock, five days later (the program has its own)
    await refused('a reclaim without the passkey', h.signer.signBridgeReclaim({ proposalId: j.proposalId, message: okMsg, attestation: okAtt, sol: rg }), /passkey/);
    await refused('a reclaim naming another event account (the request has no such field; the approval is bound to the recorded one)', h.signer.signBridgeReclaim({ proposalId: j.proposalId, message: okMsg, attestation: okAtt, sol: rg, eventAccount: T, assertion: rc(T) } as never), /approval/);
    const rr = await h.signer.signBridgeReclaim({ proposalId: j.proposalId, message: okMsg, attestation: okAtt, sol: rg, assertion: rc(sj.eventAccount!) }), rd = split(rr.raw).d;
    check(rd.numSigners === 1 && rd.payer === W && JSON.stringify(rd.instructions[0]!.accounts) === JSON.stringify([W, cctpSolPda.messageTransmitter(), sj.eventAccount]) && Buffer.from(rd.instructions[0]!.data.subarray(0, 8)).toString('hex') === CCTP_SOL_DISC.reclaimEventAccount,
      'with the passkey, five days later: one reclaim_event_account for the event account recorded with the burn, payee = the wallet, signed by the wallet alone');
    const ata = (o: Partial<SolTokenAccountRequest> = {}): SolTokenAccountRequest => ({ v: 1, requestId: crypto.randomUUID(), keyId: h.keys.keyId, network: 'solana', chainRef: N.chainRef, owner: W, mint: USDC_SOL, tokenAccount: cctpSolTokenAccount(W), maxFee: '2100000',
      createdAt: h.t.now, expiresAt: h.t.now + 50, policyVersion: h.store.policy.version, sol: { recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: 40_000, computeUnitPrice: '0' }, ...o });
    const a1 = ata({ owner: T, tokenAccount: cctpSolTokenAccount(T) }), a2 = ata({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }), a3 = ata();
    await refused('a token account for someone else', h.signer.signSolTokenAccount(a1, h.pk.assert(solTokenAccountHash(a1))), /not for this wallet/);
    await refused('a token account of another mint', h.signer.signSolTokenAccount(a2, h.pk.assert(solTokenAccountHash(a2))), /registry USDC/);
    await refused('a token account without the passkey', h.signer.signSolTokenAccount(a3), /passkey/);
    const made = await h.signer.signSolTokenAccount(a3, h.pk.assert(solTokenAccountHash(a3))), ms = await sim(made.raw, { sigVerify: false });
    check(!ms.err && BigInt(ms.fee ?? 0) === 5000n, `the wallet's own token account, with the passkey: one CreateIdempotent, simulated on mainnet: success (${ms.unitsConsumed} CU, fee ${sol9(ms.fee ?? 0)} SOL; the account of this stand-in already exists, so nothing is created)`);
    // for a public address that holds SOL and has NO USDC token account (the upgrade authority of Circle's own program): the simulation shows the account and its deposit
    for (const cand of [CCTP_SOL_PINS.transmitter.upgradeAuthority, CCTP_SOL_PINS.messenger.upgradeAuthority]) {
      if (await acct(cctpSolTokenAccount(cand))) continue;
      const hc = makeSigner({ sol: cand }); await hc.ready;
      const rq: SolTokenAccountRequest = { ...ata({ owner: cand, tokenAccount: cctpSolTokenAccount(cand) }), keyId: hc.keys.keyId, createdAt: hc.t.now, expiresAt: hc.t.now + 50 };
      const tx = await hc.signer.signSolTokenAccount(rq, hc.pk.assert(solTokenAccountHash(rq))), sc = await sim(tx.raw, { sigVerify: false, accounts: [cctpSolTokenAccount(cand)] }), keys = split(tx.raw).d.keys;
      check(!sc.err && sc.accounts?.[0]?.owner === TOKEN_PROGRAM && lamDelta(sc, keys, cand) === -(5000n + BigInt(sc.accounts![0]!.lamports)),
        sc.err ? `creating a missing token account failed in simulation: ${errLine(sc)}` : `for a public address without a USDC token account (${short(cand)}): simulation SUCCESS (${sc.unitsConsumed} CU) — the account ${cctpSolTokenAccount(cand)} is created, owned by the Token program, with a deposit of ${sol9(sc.accounts![0]!.lamports)} SOL paid by its owner (fee 0.000005 SOL)`);
      break;
    }
    const own = makeSigner(); await own.ready;
    const a4: SolTokenAccountRequest = { ...ata({ owner: ME_SOL, tokenAccount: cctpSolTokenAccount(ME_SOL) }), keyId: own.keys.keyId, createdAt: own.t.now, expiresAt: own.t.now + 50 };
    const made4 = await own.signer.signSolTokenAccount(a4, own.pk.assert(solTokenAccountHash(a4))), s4 = await sim(made4.raw, { sigVerify: true }).then((s) => JSON.stringify(s.err), (e: Error) => e.message);
    check(/AccountNotFound|InsufficientFunds/.test(s4) && !/signature/i.test(s4), `the same for the fresh key's own address, signature checked by the node: accepted, then ${s4} (never funded)`);
  }
} catch (e) { failures++; say(`\n!! ${(e as Error).stack ?? e}`); }
forks.kill();
await sql.end({ timeout: 1 }).catch(() => {});
if (RECORD && failures === 0) { (await import('node:fs')).writeFileSync(new URL('../packages/core/test/fixtures/cctp-sol/simulated.json', import.meta.url), JSON.stringify(recorded, null, 1)); say('\nrecorded packages/core/test/fixtures/cctp-sol/simulated.json'); }
say(failures === 0 ? '\nSOLANA CCTP PROOF OK — nothing was sent to a real network; Solana transactions were simulated on mainnet, EVM transactions ran on a local fork' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
void bridgeOf; void mine;
