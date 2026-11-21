/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/fork-hl-deposit.mts
 * Module           : scripts
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

// Venue deposit proof on a LOCAL FORK of Arbitrum One (anvil). Nothing reaches a real network; the key is a fresh random
// test key (a BIP-39 phrase generated in memory, never printed, gone when the process ends), funded ON THE FORK ONLY.
//     npx tsx scripts/fork-hl-deposit.mts [amount in USDC, default 10]      (tsx: the signer class is not strip-only TypeScript)
//
//   1. the fork's bridge is the pinned bytecode, not paused, pays native USDC — the checks the API makes before preparing;
//   2. the REAL isolated signer class (real WebAuthn assertion from a software passkey) refuses: below the minimum, another
//      token, another destination, a plain send to the bridge, no passkey;
//   3. it signs the deposit; the transaction is mined on the fork; the receipt shows the USDC `Transfer` from the wallet to
//      the pinned bridge, the balances move by exactly the amount, and the bridge contract itself emits NO event (a deposit is
//      a plain transfer: the venue's validators watch USDC transfers into the bridge).
//
// WHAT THIS CANNOT SHOW: the Hyperliquid side. The venue is not a chain that can be forked; whether a transfer made on a fork
// "would be credited" has no meaning. That the venue credits such transfers TODAY is shown by scripts/check-hl-bridge.mts from
// real, recent deposits by other people.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, hexToNumber, keccak256, numberToHex, parseAbi, parseTransaction, parseUnits, type Hex } from 'viem';
import { cctpUsdc, intentHash, NETWORKS, type Intent } from '@spw/core';
import { HL_BRIDGE_PINS, HL_DEPOSIT_FLOOR_USDC, HL_DEPOSIT_MIN_USDC, venueDepositSection } from '@spw/derivatives/live';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const pin = HL_BRIDGE_PINS.mainnet!, net = NETWORKS[pin.network]!, PORT = 8561, URL_ = `http://127.0.0.1:${PORT}`;
const AMOUNT = parseUnits(process.argv[2] ?? '10', 6), RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm; // fresh throwaway wallet
const USDC = cctpUsdc(pin.network).id;
const say = (s = '') => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
let id = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  if (!URL_.startsWith('http://127.0.0.1:')) throw new Error('this script only talks to the local fork');
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json() as { result?: T; error?: { message: string } }; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T;
};
const balanceOf = async (who: string) => hexToBigInt(await rpc<Hex>('eth_call', [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as Hex] }) }, 'latest']));
const bridgeAbi = parseAbi(['function paused() view returns (bool)', 'function usdcToken() view returns (address)']);
const view = async (fn: 'paused' | 'usdcToken') => decodeFunctionResult({ abi: bridgeAbi, functionName: fn, data: await rpc<Hex>('eth_call', [{ to: pin.bridge, data: encodeFunctionData({ abi: bridgeAbi, functionName: fn }) }, 'latest']) });
async function refused(label: string, p: Promise<unknown>, re: RegExp) {
  try { await p; check(false, `${label}: was NOT refused`); } catch (e) { const m = `${(e as { code?: string }).code}: ${(e as Error).message}`; check(re.test(m), `${label} → refused (${m.slice(0, 120)})`); }
}

let anvil: ChildProcess | undefined;
process.on('exit', () => anvil?.kill());
try {
  say(`Fork of ${net.name} (chain ${net.chainRef}) on ${URL_} — throwaway wallet ${ME} (seed in memory only)`);
  anvil = spawn('anvil', ['--fork-url', process.env.FORK_RPC_ARBITRUM ?? net.rpc[0]!, '--port', String(PORT), '--chain-id', net.chainRef, '--retries', '12', '--fork-retry-backoff', '1500', '--silent'], { stdio: 'ignore' });
  for (let k = 0; ; k++) { try { await rpc('eth_chainId'); break; } catch { if (k > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
  check(hexToNumber(await rpc<Hex>('eth_chainId')) === pin.chainId, `fork chain id ${pin.chainId}, forked at block ${hexToNumber(await rpc<Hex>('eth_blockNumber'))}`);

  say('\n1. The bridge on the fork (unmodified mainnet state)');
  const code = await rpc<string>('eth_getCode', [pin.bridge, 'latest']);
  check(sha(code) === pin.codeSha256 && (code.length - 2) / 2 === pin.codeBytes, `runtime bytecode ${(code.length - 2) / 2} bytes, sha256 ${sha(code)} = pinned`);
  check((await view('paused')) === false, 'paused() = false');
  check(String(await view('usdcToken')).toLowerCase() === USDC.toLowerCase(), `usdcToken() = ${USDC} = the registry's native USDC`);

  // fund the throwaway wallet on the fork: ETH for gas, USDC by writing the FiatToken balance slot (mapping at slot 9)
  await rpc('anvil_setBalance', [ME, numberToHex(parseUnits('0.01', 18))]);
  const funded = AMOUNT + parseUnits('20', 6);
  await rpc('anvil_setStorageAt', [USDC, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ME as Hex, 9n])), numberToHex(funded, { size: 32 })]);
  if ((await balanceOf(ME)) !== funded) throw new Error('could not fund the test wallet with USDC on the fork');

  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-hl-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });

  const base = hexToBigInt((await rpc<{ baseFeePerGas: Hex }>('eth_getBlockByNumber', ['latest', false])).baseFeePerGas), tip = 1_000_000n, maxFeePerGas = base * 2n + tip;
  const nonce = hexToNumber(await rpc<Hex>('eth_getTransactionCount', [ME, 'pending']));
  let seq = 0;
  const intent = (amount: bigint, over: Partial<Intent> = {}): Intent => {
    const now = Math.floor(Date.now() / 1000), gas = 90_000n;
    return { v: 1, proposalId: `9c3d1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, keyId: keys.keyId, network: net.id, chainRef: net.chainRef, asset: USDC, symbol: 'USDC', decimals: 6, amount: amount.toString(), from: ME, to: pin.bridge,
      maxFee: (gas * maxFeePerGas).toString(), createdAt: now, expiresAt: now + 120, policyVersion: store.policy.version, venueDeposit: venueDepositSection('mainnet'),
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() }, ...over };
  };
  const sign = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));

  say(`\n2. What the signer refuses (minimum of the venue ${HL_DEPOSIT_MIN_USDC} USDC, floor of the wallet ${HL_DEPOSIT_FLOOR_USDC} USDC)`);
  await refused('4 USDC', sign(intent(parseUnits('4', 6))), /venue_deposit: a deposit below 6 USDC/);
  await refused('5.999999 USDC', sign(intent(5_999_999n)), /venue_deposit: a deposit below 6 USDC/);
  await refused('another destination', sign(intent(AMOUNT, { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })), /venue_deposit: the destination is not the pinned bridge/);
  await refused('ETH instead of USDC', sign(intent(10n ** 15n, { asset: 'native', symbol: 'ETH', decimals: 18, evm: { nonce, gasLimit: '21000', maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } })), /venue_deposit: only native USDC/);
  { const { venueDeposit: _s, ...plain } = intent(parseUnits('2', 6)); await refused('plain send of 2 USDC to the bridge', sign(plain as Intent), /venue_deposit: this destination is a venue bridge/); }
  await refused('no passkey', signer.sign(intent(AMOUNT), undefined as never), /bad_approval/);

  say(`\n3. The deposit of ${formatUnits(AMOUNT, 6)} USDC, signed by the signer and mined ON THE FORK`);
  const dep = intent(AMOUNT), before = { me: await balanceOf(ME), bridge: await balanceOf(pin.bridge) };
  const signed = await sign(dep);
  const tx = parseTransaction(signed.raw as Hex), call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  check(tx.chainId === pin.chainId && tx.to?.toLowerCase() === USDC.toLowerCase() && call.functionName === 'transfer' && String(call.args[0]) === pin.bridge && call.args[1] === AMOUNT, `signed transaction: USDC.transfer(${call.args[0]}, ${call.args[1]}) on chain ${tx.chainId}`);
  const hash = await rpc<Hex>('eth_sendRawTransaction', [signed.raw]);
  check(hash === signed.txid, `transaction ${hash} accepted by the fork (same hash as the signer returned)`);
  let rc: { status: Hex; gasUsed: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] } | null = null;
  for (let k = 0; k < 200 && !rc; k++) { rc = await rpc('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 100)); }
  if (!rc) throw new Error('no receipt');
  check(hexToNumber(rc.status) === 1, `receipt status 1, gas used ${hexToNumber(rc.gasUsed)}`);
  const transfers = rc.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()).map((l) => decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] })).filter((e) => e.eventName === 'Transfer');
  const t0 = transfers[0]?.args as { from: string; to: string; value: bigint } | undefined;
  check(transfers.length === 1 && !!t0 && t0.from === ME && t0.to === pin.bridge && t0.value === AMOUNT, `USDC Transfer(from ${t0?.from}, to ${t0?.to}, value ${t0 ? formatUnits(t0.value, 6) : '?'})`);
  const own = rc.logs.filter((l) => l.address.toLowerCase() === pin.bridge.toLowerCase());
  check(own.length === 0, `events emitted by the bridge contract itself: ${own.length} (a deposit is a plain transfer; the declared Deposit event is never emitted by this bytecode)`);
  const after = { me: await balanceOf(ME), bridge: await balanceOf(pin.bridge) };
  check(before.me - after.me === AMOUNT && after.bridge - before.bridge === AMOUNT, `wallet −${formatUnits(before.me - after.me, 6)} USDC, bridge +${formatUnits(after.bridge - before.bridge, 6)} USDC`);
  await refused('the same approval again', sign(dep), /replay/);
  check(store.state.journal.filter((j) => j.type === 'sign.ok').length === 1, 'signer journal: exactly one signature');

  say(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`} Not shown: the venue's credit — Hyperliquid cannot be forked; see scripts/check-hl-bridge.mts for today's real deposits.`);
} finally { anvil?.kill(); }
process.exit(failures ? 1 : 0);
