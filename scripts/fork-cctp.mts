/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-cctp.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// CCTP execution proof on TWO LOCAL FORKS (anvil): source and destination. Nothing reaches a real network; the keys are
// fresh random test keys.     node scripts/fork-cctp.mts [source] [destination]      (default: base arbitrum)
//
//   Part 0  read-only check of Circle's REAL attestation service: a recent public CCTP message is fetched from Iris and its
//           signatures are verified against the attester set enabled on-chain (unmodified fork state).
//   Part 1  signer level: refusals (other recipient, amount, token, messenger), then the real burn on the source fork with the
//           real contracts, then the mint on the destination fork, refusals on the second leg, no double mint.
//   Part 2  full stack: API routes, worker steps, signer over HTTP, passkey — Standard and Fast, "finish" button, missing gas.
//
// WHAT IS SIMULATED: a burn made on a fork is unknown to Circle, so no real attestation can exist for it. On the DESTINATION
// FORK ONLY, two test attester keys are enabled by impersonating the contract's attester manager (anvil), and a local
// stand-in for the attestation service signs the fork's own MessageSent bytes with them. Everything else is the real
// bytecode: TokenMessengerV2, MessageTransmitterV2 (including its signature-threshold and ordering checks), TokenMinterV2, USDC.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, keccak256, numberToHex, parseAbi, parseUnits, recoverAddress, serializeSignature, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import {
  CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_MINTER_SHA256, CCTP_PROXY_SHA256, CCTP_TOKEN_MESSENGER, CCTP_TOKEN_MINTER, cctpBytes32, cctpMintRetryBytes, cctpUsdc, decodeCctpMessage,
  EIP1967_IMPLEMENTATION_SLOT, encodeCctpMessage, intentHash, NETWORKS, type CctpMessage, type Intent,
} from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const [SRC, DST] = [process.argv[2] ?? 'base', process.argv[3] ?? 'arbitrum'];
const src = NETWORKS[SRC]!, dst = NETWORKS[DST]!, sp = CCTP_ENABLED[SRC], dp = CCTP_ENABLED[DST];
if (!sp || !dp || SRC === DST) throw new Error(`usage: fork-cctp.mts <source> <destination>, among ${Object.keys(CCTP_ENABLED).join('|')}`);
const PORT = { [SRC]: 8551, [DST]: 8552 } as Record<string, number>, URL_OF = (n: string) => `http://127.0.0.1:${PORT[n]}`;
const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'c'.repeat(48);
const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm; // fresh throwaway wallet
const OTHER = privateKeyToAccount(generatePrivateKey()).address;
const USDC_S = cctpUsdc(SRC).id, USDC_D = cctpUsdc(DST).id;
const tAbi = parseAbi(['function attesterManager() view returns (address)', 'function enableAttester(address)', 'function isEnabledAttester(address) view returns (bool)', 'function signatureThreshold() view returns (uint256)', 'function feeRecipient() view returns (address)']);
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const say = (s: string) => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
async function refused(label: string, p: Promise<unknown>, re: RegExp) {
  try { await p; check(false, `${label}: was NOT refused`); } catch (e) { const m = (e as Error).message; check(re.test(m), `${label} -> refused: ${m.slice(0, 110)}`); }
}

let rid = 0;
const rpc = async <T>(net: string, method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(URL_OF(net), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as any; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const call = <T = Hex>(net: string, to: string, data: Hex, from?: string) => rpc<T>(net, 'eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const usdcBal = async (net: string, who = ME) => hexToBigInt(await call(net, cctpUsdc(net).id, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as Hex] })));
const allowance = async () => hexToBigInt(await call(SRC, USDC_S, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [ME as Hex, CCTP_TOKEN_MESSENGER as Hex] })));
const mine = async (net: string, raw: string) => { const h = await rpc<string>(net, 'eth_sendRawTransaction', [raw]); for (let k = 0; k < 300; k++) { const rc = await rpc<any>(net, 'eth_getTransactionReceipt', [h]); if (rc) return rc; await new Promise((r) => setTimeout(r, 150)); } throw new Error('no receipt'); };
const u6 = (v: bigint) => formatUnits(v, 6);
/** Give the test wallet USDC on a fork by writing the FiatToken balance slot (mapping at slot 9), then check balanceOf agrees. */
async function dealUsdc(net: string, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ME as Hex, 9n]));
  await rpc(net, 'anvil_setStorageAt', [cctpUsdc(net).id, slot, numberToHex(amount, { size: 32 })]);
  if ((await usdcBal(net)) !== amount) throw new Error(`could not fund the test wallet with USDC on the ${net} fork`);
}

const procs: ChildProcess[] = []; let signerSrv: Server | undefined, irisSrv: Server | undefined, app: any, sql: any;
const cleanup = async () => { for (const p of procs) p.kill(); signerSrv?.close(); irisSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); };
process.on('exit', () => { for (const p of procs) p.kill(); });

// --- test attesters (destination fork only) --------------------------------------------------------------------------------
const attesters = [generatePrivateKey(), generatePrivateKey()].map((k) => ({ key: k, address: privateKeyToAccount(k).address })).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
async function attest(message: Hex, signers = attesters): Promise<Hex> {
  const digest = keccak256(message); let out = '0x';
  for (const a of signers) out += serializeSignature(await sign({ hash: digest, privateKey: a.key })).slice(2);
  return out as Hex;
}
/** What Circle does off-chain: take the MessageSent bytes of a burn, assign a nonce, record the finality and the fee, sign. */
async function attestBurn(net: string, txid: string, o: { fee?: bigint; expirationBlock?: bigint } = {}): Promise<{ message: Hex; attestation: Hex } | null> {
  const rc = await rpc<any>(net, 'eth_getTransactionReceipt', [txid]);
  if (!rc || rc.status !== '0x1') return null;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== CCTP_MESSAGE_TRANSMITTER.toLowerCase()) continue;
    try { const ev = decodeEventLog({ abi: CCTP_ABI, data: l.data, topics: l.topics }); if (ev.eventName !== 'MessageSent') continue;
      const m = decodeCctpMessage(ev.args.message);
      if (m.nonce !== '0'.repeat(64) || m.finalityThresholdExecuted !== 0 || m.body.feeExecuted !== 0n) throw new Error('the on-chain message is not in the pre-attestation form');
      const message = encodeCctpMessage({ ...m, nonce: keccak256(txid as Hex).slice(2), finalityThresholdExecuted: m.minFinalityThreshold, body: { ...m.body, feeExecuted: o.fee ?? 0n, expirationBlock: o.expirationBlock ?? 0n } });
      return { message, attestation: await attest(message) };
    } catch (e) { if (/pre-attestation/.test((e as Error).message)) throw e; }
  }
  return null;
}

try {
  for (const n of [src, dst]) procs.push(spawn('anvil', ['--fork-url', process.env[`FORK_RPC_${n.id.toUpperCase()}`] ?? n.rpc[0]!, '--port', String(PORT[n.id]), '--chain-id', n.chainRef, '--retries', '12', '--fork-retry-backoff', '1500', '--compute-units-per-second', process.env.FORK_CUPS ?? '120', '--silent'], { stdio: 'ignore' }));
  for (const n of [SRC, DST]) for (let k = 0; k < 120; k++) { try { await rpc(n, 'eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  say(`forks: ${src.name} at block ${Number(await rpc<string>(SRC, 'eth_blockNumber'))} (domain ${sp.domain}) -> ${dst.name} at block ${Number(await rpc<string>(DST, 'eth_blockNumber'))} (domain ${dp.domain}); test wallet ${ME}`);

  say('\n[pins] the forks carry the reviewed bytecode');
  for (const [net, pin] of [[SRC, sp], [DST, dp]] as const) for (const [name, proxy, impl] of [['TokenMessengerV2', CCTP_TOKEN_MESSENGER, pin.messengerImpl], ['MessageTransmitterV2', CCTP_MESSAGE_TRANSMITTER, pin.transmitterImpl]] as const) {
    const slot = await rpc<string>(net, 'eth_getStorageAt', [proxy, EIP1967_IMPLEMENTATION_SLOT, 'latest']);
    check(sha(await rpc<string>(net, 'eth_getCode', [proxy, 'latest'])) === CCTP_PROXY_SHA256 && ('0x' + slot.slice(26)).toLowerCase() === impl.address.toLowerCase() && sha(await rpc<string>(net, 'eth_getCode', [impl.address, 'latest'])) === impl.codeSha256, `${net} ${name}: proxy hash, implementation address ${impl.address}, implementation hash`);
  }
  for (const net of [SRC, DST]) check(sha(await rpc<string>(net, 'eth_getCode', [CCTP_TOKEN_MINTER, 'latest'])) === CCTP_MINTER_SHA256, `${net} TokenMinterV2 hash`);

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[part 0] Circle\'s real attestation service, read-only (no fork-made data involved)');
  try {
    // logs are read from the registry's real endpoints directly (read-only), in a few small windows going back in time
    const real = async <T>(method: string, params: unknown[]): Promise<T> => { let last = ''; for (const url of [...src.rpc].reverse()) for (let k = 0; k < 2; k++) { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) }); const j = await r.json() as any; if (j.result !== undefined) return j.result; last = j.error?.message ?? 'no result'; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 700)); } throw new Error(`${method}: ${last}`); };
    const head = Number(await rpc<string>(SRC, 'eth_blockNumber')), span = Number(process.env.IRIS_SPAN ?? 60);
    const topic = keccak256(new TextEncoder().encode('MessageSent(bytes)'));
    const logs: { transactionHash: string }[] = [];
    for (const back of [3000, 12000, 40000, 150000]) { try { logs.push(...await real<{ transactionHash: string }[]>('eth_getLogs', [{ address: CCTP_MESSAGE_TRANSMITTER, topics: [topic], fromBlock: numberToHex(head - back), toBlock: numberToHex(head - back + span) }])); } catch { /* next window */ } if (logs.length >= 30) break; }
    const threshold = Number(hexToBigInt(await call(SRC, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: tAbi, functionName: 'signatureThreshold' }))));
    let verified = 0, seen = 0;
    for (const h of [...new Set(logs.map((l) => l.transactionHash))].slice(0, 30)) {
      const r = await fetch(`https://iris-api.circle.com/v2/messages/${sp.domain}?transactionHash=${h}`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) continue;
      for (const m of ((await r.json()) as any).messages ?? []) {
        if (m.status !== 'complete' || m.cctpVersion !== 2 || !/^0x[0-9a-f]+$/i.test(m.message) || !/^0x[0-9a-f]+$/i.test(m.attestation)) continue;
        seen++;
        const sigs = m.attestation.slice(2), digest = keccak256(m.message as Hex); if (sigs.length !== 130 * threshold) continue;
        let prev = 0n, good = true;
        for (let k = 0; k < threshold; k++) { const a = await recoverAddress({ hash: digest, signature: `0x${sigs.slice(k * 130, (k + 1) * 130)}` });
          const enabled = hexToBigInt(await call(SRC, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: tAbi, functionName: 'isEnabledAttester', args: [a] }))) === 1n;
          if (!enabled || BigInt(a) <= prev) good = false; prev = BigInt(a); }
        if (good) { verified++; if (verified === 1) say(`  example: burn ${h} on ${src.name}, source domain ${parseInt(m.message.slice(10, 18), 16)} -> destination domain ${parseInt(m.message.slice(18, 26), 16)}, ${(m.message.length - 2) / 2}-byte message, ${threshold} signatures`); }
      }
      if (verified >= 3) break;
    }
    check(verified > 0, `${verified} of ${seen} complete public message(s) fetched from iris-api.circle.com carry exactly ${threshold} signatures over keccak256(message), by attesters enabled on-chain, in ascending order`);
  } catch (e) { check(false, `read-only Iris check could not run: ${(e as Error).message.slice(0, 140)}`); }

  // --- fork preparation ------------------------------------------------------------------------------------------------
  await rpc(SRC, 'anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]); await rpc(DST, 'anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]);
  await dealUsdc(SRC, 200_000000n);
  const mgr = ('0x' + (await call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: tAbi, functionName: 'attesterManager' }))).slice(26)) as Hex;
  await rpc(DST, 'anvil_impersonateAccount', [mgr]); await rpc(DST, 'anvil_setBalance', [mgr, numberToHex(parseUnits('1', 18))]);
  for (const a of attesters) await rpc(DST, 'eth_sendTransaction', [{ from: mgr, to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: tAbi, functionName: 'enableAttester', args: [a.address] }) }]);
  await rpc(DST, 'anvil_stopImpersonatingAccount', [mgr]);
  say(`\n[fork only] destination fork: two TEST attesters enabled through the impersonated attester manager ${mgr} (signature threshold stays ${Number(hexToBigInt(await call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: tAbi, functionName: 'signatureThreshold' }))))}); Circle's real attesters are untouched and cannot sign a fork-only burn`);

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[part 1] signer level');
  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-cctp-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  // anvil reports a 1 gwei priority fee (far above the real one on L2s): raise the native fee ceilings FOR THESE FORKS ONLY
  const forkPolicy = { ...store.policy, maxFee: { ...store.policy.maxFee, [SRC]: (BigInt(store.policy.maxFee[SRC]!) * 20n).toString(), [DST]: (BigInt(store.policy.maxFee[DST]!) * 20n).toString() } };
  store.policy = forkPolicy;
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }), pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  const gasNow = async (net: string) => { const b = await rpc<any>(net, 'eth_getBlockByNumber', ['latest', false]); return hexToBigInt(b.baseFeePerGas) * 2n + 1_000_000_000n; };
  async function intentFor(amount: bigint, o: Partial<Intent> = {}, b: Partial<NonNullable<Intent['bridge']>> = {}): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000), nonce = Number(await rpc<string>(SRC, 'eth_getTransactionCount', [ME, 'latest'])), mf = await gasNow(SRC);
    return { v: 1, proposalId: randomUUID(), keyId: keys.keyId, network: SRC, chainRef: src.chainRef, asset: USDC_S, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: ME, to: ME,
      maxFee: (270_000n * mf).toString(), createdAt: now, expiresAt: now + 120, policyVersion: store.policy.version,
      bridge: { provider: 'cctp', toNetwork: DST, toDomain: dp.domain, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', ...b },
      evm: { nonce, gasLimit: '200000', maxFeePerGas: mf.toString(), maxPriorityFeePerGas: '1000000000' }, ...o };
  }
  const signIt = async (i: Intent, approved: Intent = i) => signer.sign(i, pk.assert(intentHash(approved)));
  const mintGas = async () => ({ nonce: Number(await rpc<string>(DST, 'eth_getTransactionCount', [ME, 'latest'])), gasLimit: '300000', maxFeePerGas: (await gasNow(DST)).toString(), maxPriorityFeePerGas: '1000000000' });

  say(' first leg — what the signer refuses (each request carries a valid passkey approval of exactly what is asked, except "another amount")');
  await refused('another recipient', signIt(await intentFor(10_000000n, { to: OTHER })), /deliver to the wallet itself/);
  { const i = await intentFor(10_000000n); await refused('another amount than the one the owner approved', signIt({ ...i, amount: '45000000' }, i), /approval/); }
  await refused('an amount above the per-transfer limit', signIt(await intentFor(60_000000n)), /per-transaction limit/);
  const otherToken = src.tokens.find((t) => t.symbol !== 'USDC');
  if (otherToken) await refused(`another token (${otherToken.symbol})`, signIt(await intentFor(10_000000n, { asset: otherToken.id, symbol: otherToken.symbol, decimals: otherToken.decimals })), /registry USDC|per-transaction|limit/);
  await refused('the same token address under a wrong contract (random address as "USDC")', signIt(await intentFor(10_000000n, { asset: OTHER })), /USDC|allowlist|registry|unknown/i);
  await refused('an unpinned messenger', signIt(await intentFor(10_000000n, {}, { messenger: OTHER })), /pinned TokenMessengerV2/);
  await refused('an unpinned transmitter', signIt(await intentFor(10_000000n, {}, { transmitter: OTHER })), /pinned MessageTransmitterV2/);
  await refused('a destination domain that is not the destination network\'s', signIt(await intentFor(10_000000n, {}, { toDomain: dp.domain + 1 })), /destination domain/);
  check(Object.keys(store.state.bridges ?? {}).length === 0 && (await usdcBal(SRC)) === 200_000000n, 'nothing was recorded, nothing moved');

  say(' first leg — the real burn on the source fork');
  const i1 = await intentFor(25_000000n), s1 = await signIt(i1);
  const supplyBefore = hexToBigInt(await call(SRC, USDC_S, encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' })));
  const rcA = await mine(SRC, s1.pre!.raw), rcB = await mine(SRC, s1.raw);
  check(rcA.status === '0x1' && rcB.status === '0x1', `approval (gas ${Number(rcA.gasUsed)}) and depositForBurn (gas ${Number(rcB.gasUsed)}) mined`);
  check((await usdcBal(SRC)) === 175_000000n, `source balance fell by exactly 25 USDC (now ${u6(await usdcBal(SRC))})`);
  check(supplyBefore - hexToBigInt(await call(SRC, USDC_S, encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }))) === 25_000000n, 'USDC total supply on the source fell by 25: burned, not parked');
  check((await allowance()) === 0n, 'leftover allowance to the TokenMessenger: 0');
  const a1 = (await attestBurn(SRC, s1.txid))!, m1 = decodeCctpMessage(a1.message);
  check(m1.sourceDomain === sp.domain && m1.destinationDomain === dp.domain && m1.body.mintRecipient === cctpBytes32(ME) && m1.body.messageSender === cctpBytes32(ME) && m1.body.amount === 25_000000n && m1.body.burnToken === cctpBytes32(USDC_S) && m1.destinationCaller === '0'.repeat(64) && m1.recipient === cctpBytes32(CCTP_TOKEN_MESSENGER),
    'the message emitted by the real contract: wallet -> wallet, 25 USDC, registry token, destination caller = anyone, 376 bytes (no hook)');

  say(' second leg — what the signer refuses');
  const g = await mintGas(), bad = async (o: Partial<CctpMessage>, body: Partial<CctpMessage['body']> = {}) => { const message = encodeCctpMessage({ ...m1, ...o, body: { ...m1.body, ...body } }); return { proposalId: i1.proposalId, message, attestation: await attest(message), evm: g }; };
  await refused('a message whose mintRecipient is not the wallet', signer.signBridgeMint(await bad({}, { mintRecipient: cctpBytes32(OTHER) })), /another address/);
  await refused('a message for another destination domain', signer.signBridgeMint(await bad({ destinationDomain: dp.domain === 0 ? 2 : 0 })), /another destination domain/);
  await refused('a message with another amount', signer.signBridgeMint(await bad({}, { amount: 26_000000n })), /another amount/);
  await refused('a message with another burn token', signer.signBridgeMint(await bad({}, { burnToken: cctpBytes32(OTHER) })), /another token/);
  await refused('a message with a destination caller', signer.signBridgeMint(await bad({ destinationCaller: cctpBytes32(OTHER) })), /destination caller/);
  await refused('a message charging a fee the owner did not approve', signer.signBridgeMint(await bad({}, { feeExecuted: 5n })), /more than the approved/);
  await refused('a mint for a bridge that was never approved', signer.signBridgeMint({ proposalId: randomUUID(), message: a1.message, attestation: a1.attestation, evm: g }), /no approved bridge/);
  // the contract itself refuses an attestation that is not from enabled attesters (so a wrong attestation can only waste gas)
  const rogue = [generatePrivateKey(), generatePrivateKey()].map((k) => ({ key: k, address: privateKeyToAccount(k).address })).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  await refused('on-chain: receiveMessage with signatures from keys that are not attesters', call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [a1.message, await attest(a1.message, rogue)] }), ME), /not attester/);
  await refused('on-chain: receiveMessage with a single signature', call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [a1.message, await attest(a1.message, attesters.slice(0, 1))] }), ME), /attestation length/);

  say(' second leg — the mint on the destination fork');
  const before = await usdcBal(DST), mint1 = await signer.signBridgeMint({ proposalId: i1.proposalId, message: a1.message, attestation: a1.attestation, evm: g });
  const rcM = await mine(DST, mint1.raw);
  check(rcM.status === '0x1' && rcM.to.toLowerCase() === CCTP_MESSAGE_TRANSMITTER.toLowerCase(), `receiveMessage mined (gas ${Number(rcM.gasUsed)}), signed without a second passkey approval`);
  check((await usdcBal(DST)) - before === 25_000000n, `destination balance rose by exactly 25 USDC (now ${u6(await usdcBal(DST))})`);
  check(hexToBigInt(await call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: CCTP_ABI, functionName: 'usedNonces', args: [`0x${m1.nonce}`] }))) === 1n, 'the message nonce is marked used on the destination');

  say(' second leg — never twice');
  check((await signer.signBridgeMint({ proposalId: i1.proposalId, message: a1.message, attestation: a1.attestation, evm: g })).raw === mint1.raw, 'the identical request returns the same bytes (no new signature)');
  const g2 = await mintGas();
  await refused('a second mint request for the same bridge (new nonce and gas)', signer.signBridgeMint({ proposalId: i1.proposalId, message: a1.message, attestation: a1.attestation, evm: g2 }), /already signed for this bridge/);
  const retry = await signer.signBridgeMint({ proposalId: i1.proposalId, message: a1.message, attestation: a1.attestation, evm: g2, assertion: pk.assert(new Uint8Array(createHash('sha256').update(cctpMintRetryBytes(i1.proposalId, mint1.messageHash, g2)).digest())) });
  const rcR = await mine(DST, retry.raw);
  check(rcR.status === '0x0' && (await usdcBal(DST)) - before === 25_000000n, 'even a passkey-approved second mint transaction reverts on-chain ("Nonce already used"): the balance did not move again');

  say(' Fast transfer — fee semantics with the real contracts');
  if (sp.fastSource) {
    const i2 = await intentFor(40_000000n, {}, { maxFee: '5200', minFinalityThreshold: 1000 }), s2 = await signIt(i2);
    await mine(SRC, s2.pre!.raw); const rc2 = await mine(SRC, s2.raw);
    const head = hexToBigInt(await rpc<string>(DST, 'eth_blockNumber')), a2 = (await attestBurn(SRC, s2.txid, { fee: 5199n, expirationBlock: head + 1_000_000_000n }))!;
    const feeTo = ('0x' + (await call(DST, CCTP_TOKEN_MESSENGER, encodeFunctionData({ abi: tAbi, functionName: 'feeRecipient' }))).slice(26)) as Hex, feeBefore = await usdcBal(DST, feeTo), b2 = await usdcBal(DST);
    const m2 = await signer.signBridgeMint({ proposalId: i2.proposalId, message: a2.message, attestation: a2.attestation, evm: await mintGas() }), rcm2 = await mine(DST, m2.raw);
    check(rc2.status === '0x1' && rcm2.status === '0x1' && (await usdcBal(DST)) - b2 === 40_000000n - 5199n && (await usdcBal(DST, feeTo)) - feeBefore === 5199n && m2.minted === '39994801', `40 USDC burned with maxFee 0.0052: wallet received ${u6((await usdcBal(DST)) - b2)}, Circle's fee recipient ${u6((await usdcBal(DST, feeTo)) - feeBefore)}`);
    const over = encodeCctpMessage({ ...decodeCctpMessage(a2.message), nonce: randomBytes(32).toString('hex'), body: { ...decodeCctpMessage(a2.message).body, feeExecuted: 5201n } });
    await refused('on-chain: a message whose fee exceeds maxFee', call(DST, CCTP_MESSAGE_TRANSMITTER, encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [over, await attest(over)] }), ME), /Fee exceeds max fee/);
  } else say(`  (skipped: Circle does not offer Fast from ${src.name})`);

  // ---------------------------------------------------------------------------------------------------------------------
  say('\n[part 2] full stack: API + worker + signer over HTTP + passkey, on the same forks');
  const held = new Set<string>(); let holdAll = false;
  irisSrv = createServer((req, res) => { void (async () => {
    const send = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url!, 'http://x');
    try {
      // fee schedule and Fast allowance: passed through, read-only, from Circle's real service
      if (u.pathname.startsWith('/v2/burn/USDC/fees/') || u.pathname === '/v2/fastBurn/USDC/allowance') { const r = await fetch(`https://iris-api.circle.com${u.pathname}`, { signal: AbortSignal.timeout(10000) }); return send(r.status, await r.json()); }
      if (u.pathname === `/v2/messages/${sp.domain}`) { // stand-in for the attestation of a fork-only burn
        const h = u.searchParams.get('transactionHash') ?? '';
        if (holdAll || held.has(h)) return send(404, { error: 'Message not found for provided parameters' });
        const rc = await rpc<any>(SRC, 'eth_getTransactionReceipt', [h]); if (!rc) return send(404, { error: 'Message not found for provided parameters' });
        let fee = 0n, exp = 0n;
        for (const l of rc.logs) { try { const ev = decodeEventLog({ abi: CCTP_ABI, data: l.data, topics: l.topics }); if (ev.eventName === 'MessageSent') { const m = decodeCctpMessage(ev.args.message); if (m.minFinalityThreshold <= 1000) { fee = m.body.maxFee > 0n ? m.body.maxFee - 1n : 0n; exp = hexToBigInt(await rpc<string>(DST, 'eth_blockNumber')) + 1_000_000_000n; } } } catch { /* other event */ } }
        const a = await attestBurn(SRC, h, { fee, expirationBlock: exp });
        return a ? send(200, { messages: [{ status: 'complete', cctpVersion: 2, message: a.message, attestation: a.attestation, delayReason: null }] }) : send(404, { error: 'Message not found for provided parameters' });
      }
      send(404, {});
    } catch (e) { send(500, { error: (e as Error).message }); } })(); }).listen(0, '127.0.0.1');
  await new Promise((r) => irisSrv!.once('listening', r));
  const dir2 = mkdtempSync(join(tmpdir(), 'spw-fork-cctp-api-')), store2 = new Store(join(dir2, 'state.json'), join(dir2, 'policy.json'));
  store2.state.setupTokenHash = createHash('sha256').update('fork-setup-token').digest('hex'); store2.policy = forkPolicy;
  signerSrv = createSignerServer(new Signer(keys, store2, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: process.env.FORK_DATABASE_URL ?? 'postgres:///spw_fork_cctp', SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_IRIS_OVERRIDE: `http://127.0.0.1:${(irisSrv.address() as { port: number }).port}`, SPW_RPC_OVERRIDE: JSON.stringify({ [SRC]: [URL_OF(SRC), URL_OF(SRC)], [DST]: [URL_OF(DST), URL_OF(DST)] }) });
  const warn = console.warn; console.warn = () => {}; // the two test-only override banners
  const db = await import('../services/api/src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [] });
  const worker = await import('../services/api/src/worker.ts');
  console.warn = warn;
  let cookie = '';
  const api = async (method: string, url: string, body?: unknown, idem?: string) => { const r = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined }; };
  const pk2 = new TestPasskey(RP, ORIGIN), so = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const sv = await api('POST', '/api/v1/auth/setup/verify', { challengeId: so.challengeId, response: pk2.register(so.options.challenge), setupToken: 'fork-setup-token' });
  if (sv.status !== 200) throw new Error(`setup failed: ${JSON.stringify(sv.json)}`);
  cookie = String(sv.setCookie).split(';')[0]!;
  const tick = async () => { await worker.reconcile(); await sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where kind = 'bridge'`; await worker.advanceBridges(); for (const n of [SRC, DST]) await rpc(n, 'anvil_mine', [numberToHex(70)]); };
  const getP = async (id: string) => (await api('GET', `/api/v1/transfers/proposals/${id}`)).json;
  async function until(id: string, stage: string, max = 60) { const seen: string[] = []; for (let k = 0; k < max; k++) { const p = await getP(id); if (seen[seen.length - 1] !== p.bridge.stage) seen.push(p.bridge.stage); if (p.bridge.stage === stage || p.bridge.stage === 'failed') return { p, seen }; await tick(); await new Promise((r) => setTimeout(r, 150)); } return { p: await getP(id), seen }; }
  async function start(amount: string, speed: 'standard' | 'fast') {
    const prep = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: SRC, toNetwork: DST, amount, speed }, randomUUID());
    if (prep.status !== 200) throw new Error(`prepare failed: ${prep.status} ${JSON.stringify(prep.json)}`);
    const ap = await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: pk2.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    if (ap.status !== 200) throw new Error(`approve failed: ${ap.status} ${JSON.stringify(ap.json)}`);
    return prep.json.proposal;
  }

  const q = (await api('GET', `/api/v1/bridge/quote?from=${SRC}&to=${DST}&amount=20`)).json;
  say(`  quote for 20 USDC: ${q.options.map((o: any) => `${o.speed} fee ${o.feeDisplay} USDC, about ${o.seconds} s${o.available ? '' : ' (unavailable now)'}`).join('; ')}; gas needed on ${dst.name}: ${q.destinationGas.needDisplay} ${q.destinationGas.symbol}`);
  // destination without gas: refused before anything is signed
  await rpc(DST, 'anvil_setBalance', [ME, '0x0']);
  const noGas = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: SRC, toNetwork: DST, amount: '20', speed: 'standard' }, randomUUID());
  check(noGas.status === 422 && noGas.json.error === 'destination_gas', `no ${dst.native.symbol} on ${dst.name} -> refused before approval: "${String(noGas.json.message).slice(0, 150)}"`);
  await rpc(DST, 'anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]);

  let sb = await usdcBal(SRC), db0 = await usdcBal(DST);
  const p1 = await start('20', 'standard'), r1 = await until(p1.id, 'done');
  check(r1.p.bridge.stage === 'done' && sb - (await usdcBal(SRC)) === 20_000000n && (await usdcBal(DST)) - db0 === 20_000000n && r1.p.bridge.received === '20000000' && r1.p.bridge.mintedBy === 'wallet',
    `Standard, worker only: ${r1.seen.join(' -> ')}; source −${u6(sb - (await usdcBal(SRC)))}, destination +${u6((await usdcBal(DST)) - db0)} USDC; burn ${r1.p.txid}, mint ${r1.p.bridge.mintTxid}`);
  check((await allowance()) === 0n, 'leftover allowance: 0');

  if (sp.fastSource) {
    sb = await usdcBal(SRC); db0 = await usdcBal(DST);
    const p2 = await start('30', 'fast'), r2 = await until(p2.id, 'done');
    check(r2.p.bridge.stage === 'done' && sb - (await usdcBal(SRC)) === 30_000000n && (await usdcBal(DST)) - db0 === BigInt(r2.p.bridge.received) && BigInt(r2.p.bridge.received) >= 30_000000n - BigInt(r2.p.bridge.cctpMaxFee) && BigInt(r2.p.bridge.received) < 30_000000n,
      `Fast: approved fee ceiling ${r2.p.bridge.cctpMaxFeeDisplay} USDC (from Circle's live schedule), fee taken ${r2.p.bridge.feeExecutedDisplay}, received ${r2.p.bridge.receivedDisplay} USDC`);
  }

  // attestation held back: the transfer waits; then the owner presses "finish"
  holdAll = true; sb = await usdcBal(SRC); db0 = await usdcBal(DST);
  const p3 = await start('15', 'standard'); let r3 = await until(p3.id, 'done', 8);
  check(r3.p.bridge.stage === 'attesting' && sb - (await usdcBal(SRC)) === 15_000000n && (await usdcBal(DST)) === db0, `attestation not available: stays "${r3.p.bridge.stage}" after ${r3.p.bridge.polls} polls (Circle status: ${r3.p.bridge.irisStatus}); burned on the source, not yet minted`);
  // a transfer started on the destination meanwhile must not collide with the mint; and a restart loses nothing (state is in the database and the signer file)
  holdAll = false;
  const f1 = await api('POST', `/api/v1/bridge/proposals/${p3.id}/finish`, {});
  check(f1.status === 200 && ['minting', 'done'].includes(f1.json.bridge.stage), `"finish" pressed once the attestation exists -> ${f1.json.bridge?.stage}, mint ${f1.json.bridge?.mintTxid}`);
  for (const n of [SRC, DST]) await rpc(n, 'anvil_mine', [numberToHex(70)]);
  const f2 = await api('POST', `/api/v1/bridge/proposals/${p3.id}/finish`, {});
  check(f2.json.bridge.stage === 'done' && f2.json.bridge.mintedBy === 'wallet' && (await usdcBal(DST)) - db0 === 15_000000n, `"finish" again -> ${f2.json.bridge.stage}; destination +${u6((await usdcBal(DST)) - db0)} USDC`);
  const f3 = await api('POST', `/api/v1/bridge/proposals/${p3.id}/finish`, {}); await tick();
  check(f3.json.bridge.stage === 'done' && (await usdcBal(DST)) - db0 === 15_000000n && store2.state.bridges![p3.id]!.mint!.signatures === 1, '"finish" on a finished transfer does nothing: one mint signature, balance unchanged');

  // someone else submits the mint first (it is permissionless): detected, recorded as success, nothing signed
  holdAll = true; db0 = await usdcBal(DST);
  const p4 = await start('12', 'standard'); const r4 = await until(p4.id, 'done', 6);
  const a4 = (await attestBurn(SRC, r4.p.txid))!, relayer = privateKeyToAccount(generatePrivateKey()).address;
  await rpc(DST, 'anvil_setBalance', [relayer, numberToHex(parseUnits('1', 18))]); await rpc(DST, 'anvil_impersonateAccount', [relayer]);
  await rpc(DST, 'eth_sendTransaction', [{ from: relayer, to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [a4.message, a4.attestation] }) }]);
  holdAll = false;
  const r4b = await until(p4.id, 'done', 10);
  check(r4b.p.bridge.stage === 'done' && r4b.p.bridge.mintedBy === 'other' && (await usdcBal(DST)) - db0 === 12_000000n && !store2.state.bridges![p4.id]!.mint, `mint relayed by a third party (${relayer.slice(0, 10)}…): transfer recorded as done by "other", wallet +${u6((await usdcBal(DST)) - db0)} USDC, the signer signed nothing for it`);

  const audit = (await api('GET', '/api/v1/security/audit?limit=400')).json;
  check(audit.intact === true, `audit chain intact; bridge events: ${[...new Set(audit.events.filter((e: any) => e.type.startsWith('bridge.')).map((e: any) => e.type))].sort().join(', ')}`);
  const act = (await api('GET', '/api/v1/activity')).json.items.filter((x: any) => x.kind === 'bridge');
  check(act.length >= 3 && act.every((x: any) => x.bridge.stage === 'done'), `activity lists ${act.length} cross-chain transfers, all done`);

  if (failures) throw new Error(`${failures} check(s) failed`);
  say(`\nFORK CCTP TEST OK (${src.name} -> ${dst.name}) — nothing was sent to a real network; the only data read from Circle is public (fee schedule, allowance, existing messages)`);
} finally { await cleanup(); }
process.exit(failures ? 1 : 0);
