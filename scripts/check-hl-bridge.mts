// READ-ONLY liveness evidence for the Hyperliquid collateral route (docs/v4/venues/hyperliquid.md, section 15).
//   node scripts/check-hl-bridge.mts [--blocks 20000] [--samples 6] [--json out.json]
//
// It answers, from primary data and without sending anything:
//   1. is the bridge contract the pinned one (runtime bytecode hash, on BOTH registry RPC endpoints), is it paused, who guards it;
//   2. does a plain USDC transfer into the bridge still get credited by the venue TODAY: recent `Transfer(→ bridge)` logs on
//      Arbitrum are matched, depositor by depositor, with the venue's own ledger (`userNonFundingLedgerUpdates` → `deposit`);
//   3. do withdrawals still arrive: recent `Transfer(bridge → user)` logs are matched with the venue's `withdraw` ledger entries
//      (amount, fee, delay);
//   4. what happened to deposits below the documented minimum in the same window (expected: no credit).
// Only two kinds of request are made: JSON-RPC reads on Arbitrum and POST /info on the venue (public, keyless). The exchange
// endpoint is never contacted. No key, no seed, no signature.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi } from 'viem';
import { NETWORKS } from '@spw/core';
import { HL_BRIDGE_PINS, HL_DEPOSIT_MIN_USDC } from '@spw/derivatives/live';

const arg = (name: string, d: string) => { const k = process.argv.indexOf(`--${name}`); return k > 0 ? process.argv[k + 1]! : d; };
const BLOCKS = Number(arg('blocks', '20000')), SAMPLES = Number(arg('samples', '6')), OUT = arg('json', '');
const pin = HL_BRIDGE_PINS.mainnet, net = NETWORKS[pin.network]!;
const BRIDGE = pin.bridge.toLowerCase(), USDC = pin.usdc.toLowerCase();
const INFO = 'https://api.hyperliquid.xyz/info';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const abi = parseAbi(['function paused() view returns (bool)', 'function usdcToken() view returns (address)', 'function nValidators() view returns (uint64)', 'function totalValidatorPower() view returns (uint64)',
  'function disputePeriodSeconds() view returns (uint64)', 'function blockDurationMillis() view returns (uint64)', 'function lockerThreshold() view returns (uint64)', 'function epoch() view returns (uint64)',
  'function hotValidatorSetHash() view returns (bytes32)', 'function coldValidatorSetHash() view returns (bytes32)', 'function getLockersVotingLock() view returns (address[])']);
const say = (s = '') => console.log(s);
const report: Record<string, unknown> = { at: new Date().toISOString(), bridge: pin.bridge, usdc: pin.usdc, sources: { rpc: net.rpc, info: INFO } };

let id = 0;
async function one<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let last = '';
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json() as { result?: T; error?: { message: string } };
      if (j.error) last = j.error.message; else return j.result as T;
    } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`${new URL(url).host} ${method}: ${last}`);
}
/** both endpoints must give the same answer */
async function both<T>(method: string, params: unknown[]): Promise<T> {
  const rs = await Promise.all(net.rpc.map((u) => one<T>(u, method, params)));
  if (rs.some((r) => JSON.stringify(r) !== JSON.stringify(rs[0]))) throw new Error(`${method}: the two endpoints disagree`);
  return rs[0]!;
}
const view = async (fn: string) => decodeFunctionResult({ abi, functionName: fn as never, data: await both<`0x${string}`>('eth_call', [{ to: BRIDGE, data: encodeFunctionData({ abi, functionName: fn as never }) }, 'latest']) }) as unknown;
async function info<T>(body: unknown): Promise<T> {
  if (new URL(INFO).pathname !== '/info') throw new Error('only the info endpoint is read');
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`info http ${r.status}`);
  return await r.json() as T;
}
interface Log { transactionHash: string; blockNumber: `0x${string}`; topics: string[]; data: `0x${string}`; logIndex: `0x${string}` }
async function logs(url: string, topics: (string | null)[], from: number, to: number): Promise<Log[]> {
  const out: Log[] = [];
  for (let a = from; a <= to; a += 5000) out.push(...await one<Log[]>(url, 'eth_getLogs', [{ address: USDC, topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(to, a + 4999).toString(16) }]));
  return out;
}
const blockTime = async (bn: `0x${string}`) => Number((await one<{ timestamp: `0x${string}` }>(net.rpc[0]!, 'eth_getBlockByNumber', [bn, false])).timestamp) * 1000;
interface Ledger { time: number; hash: string; delta: { type: string; usdc?: string; fee?: string; nonce?: number } }
const u6 = (v: bigint) => formatUnits(v, 6);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; return ok; };

// ---------------------------------------------------------------------------------------------------------------- 1. the contract
say(`Hyperliquid bridge ${pin.bridge} on ${net.name} — ${report.at}`);
const code = await both<string>('eth_getCode', [BRIDGE, 'latest']);
const codeSha = sha(code);
check(codeSha === pin.codeSha256, `runtime bytecode on both RPC endpoints: ${(code.length - 2) / 2} bytes, sha256 ${codeSha}${codeSha === pin.codeSha256 ? ' = pinned' : ` ≠ pinned ${pin.codeSha256}`}`);
const implSlot = await both<string>('eth_getStorageAt', [BRIDGE, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
check(/^0x0+$/.test(implSlot), 'not an EIP-1967 proxy (implementation slot empty): the code cannot be replaced behind this address');
const state = { paused: await view('paused'), usdcToken: String(await view('usdcToken')), nValidators: String(await view('nValidators')), totalValidatorPower: String(await view('totalValidatorPower')),
  disputePeriodSeconds: String(await view('disputePeriodSeconds')), blockDurationMillis: String(await view('blockDurationMillis')), lockerThreshold: String(await view('lockerThreshold')), epoch: String(await view('epoch')),
  hotValidatorSetHash: await view('hotValidatorSetHash'), coldValidatorSetHash: await view('coldValidatorSetHash'), lockersVotingLock: await view('getLockersVotingLock') };
check(state.paused === false, `paused() = ${String(state.paused)}`);
check(state.usdcToken.toLowerCase() === USDC, `usdcToken() = ${state.usdcToken} (the registry's native USDC on ${net.name})`);
say(`       validators ${state.nValidators} (power ${state.totalValidatorPower}), epoch ${state.epoch}, dispute period ${state.disputePeriodSeconds} s, locker threshold ${state.lockerThreshold}, lockers voting to lock: ${(state.lockersVotingLock as string[]).length}`);
const held = BigInt(await both<string>('eth_call', [{ to: USDC, data: '0x70a08231' + topic(BRIDGE).slice(2) }, 'latest']));
say(`       USDC held by the bridge: ${u6(held)}`);
report.contract = { codeBytes: (code.length - 2) / 2, codeSha256: codeSha, pinned: pin.codeSha256, ...state, usdcHeld: u6(held) };

// ---------------------------------------------------------------------------------------------------------------- 2. deposits
const head = Number(await one<string>(net.rpc[0]!, 'eth_blockNumber', [])), from = head - BLOCKS;
const ins = await logs(net.rpc[0]!, [TRANSFER, null, topic(BRIDGE)], from, head - 40);
/** A SECOND, independent endpoint confirms each sampled log by its receipt. The registry's second endpoint serves only the most
 *  recent blocks without a token, so two other public endpoints are tried after it — for this evidence only, never for signing. */
const SECOND = [net.rpc[1]!, 'https://arbitrum.drpc.org', 'https://1rpc.io/arb'];
async function confirmed(l: Log): Promise<string | null> {
  for (const url of SECOND) {
    try {
      const rc = await one<{ status: string; logs: Log[] } | null>(url, 'eth_getTransactionReceipt', [l.transactionHash]);
      if (rc && Number(rc.status) === 1 && rc.logs.some((x) => x.logIndex === l.logIndex && x.data === l.data && JSON.stringify(x.topics) === JSON.stringify(l.topics))) return new URL(url).host;
    } catch { /* next endpoint */ }
  }
  return null;
}
say(`\nUSDC transfers INTO the bridge, blocks ${from}–${head - 40} (${BLOCKS} blocks ≈ ${Math.round(BLOCKS / 240)} min, read on ${new URL(net.rpc[0]!).host}; each sample below is confirmed by its receipt on a second endpoint): ${ins.length}`);
const min = BigInt(HL_DEPOSIT_MIN_USDC) * 1_000_000n;
const pick = (ls: Log[], n: number) => { const step = Math.max(1, Math.floor(ls.length / n)); return ls.filter((_, k) => k % step === 0).slice(-n); };
const deposits: unknown[] = [];
let credited = 0, checked = 0;
for (const l of pick(ins.filter((x) => BigInt(x.data) >= min), SAMPLES)) {
  const user = '0x' + l.topics[1]!.slice(26), amount = BigInt(l.data), t = await blockTime(l.blockNumber);
  const led = await info<Ledger[]>({ type: 'userNonFundingLedgerUpdates', user, startTime: t - 120_000, endTime: t + 3_600_000 });
  const hit = led.find((x) => x.delta.type === 'deposit' && x.delta.usdc !== undefined && Math.round(Number(x.delta.usdc) * 1e6) === Number(amount) && x.time >= t - 5000);
  const two = await confirmed(l);
  checked++; if (hit && two) credited++;
  deposits.push({ onBothRpc: two, tx: l.transactionHash, block: Number(l.blockNumber), from: user, usdc: u6(amount), chainTime: iso(t), credited: !!hit, venueTime: hit ? iso(hit.time) : null, delaySeconds: hit ? Math.round((hit.time - t) / 1000) : null, venueHash: hit?.hash ?? null });
  check(!!hit && !!two, `${u6(amount)} USDC from ${user} at ${iso(t)} (tx ${l.transactionHash.slice(0, 18)}…) → ${hit ? `venue ledger "deposit" ${hit.delta.usdc} USDC to the SAME address ${Math.round((hit.time - t) / 1000)} s later; receipt also on ${two ?? 'NO second endpoint'}` : `NO matching deposit in the venue ledger (${led.length} entries read)`}`);
}
report.deposits = { window: { from, to: head - 40 }, count: ins.length, checked, credited, samples: deposits };
const small = ins.filter((x) => BigInt(x.data) < min);
const smalls: unknown[] = [];
for (const l of small.slice(-3)) {
  const user = '0x' + l.topics[1]!.slice(26), amount = BigInt(l.data), t = await blockTime(l.blockNumber);
  const led = await info<Ledger[]>({ type: 'userNonFundingLedgerUpdates', user, startTime: t - 120_000, endTime: t + 3_600_000 });
  const hit = led.find((x) => x.delta.type === 'deposit' && Math.round(Number(x.delta.usdc) * 1e6) === Number(amount));
  smalls.push({ tx: l.transactionHash, from: user, usdc: u6(amount), chainTime: iso(t), credited: !!hit });
  say(`  note ${u6(amount)} USDC (below the ${HL_DEPOSIT_MIN_USDC} USDC minimum) from ${user} at ${iso(t)} → ${hit ? 'credited (!)' : 'not credited by the venue'}`);
}
report.belowMinimum = { count: small.length, samples: smalls };

// ---------------------------------------------------------------------------------------------------------------- 3. withdrawals
const outs = await logs(net.rpc[0]!, [TRANSFER, topic(BRIDGE), null], from, head - 40);
say(`\nUSDC transfers OUT of the bridge (finalized withdrawals), same window: ${outs.length}`);
const withdrawals: unknown[] = [];
let wOk = 0, wChecked = 0;
for (const l of pick(outs, SAMPLES)) {
  const dest = '0x' + l.topics[2]!.slice(26), amount = BigInt(l.data), t = await blockTime(l.blockNumber);
  // the venue account that asked is usually the destination itself; when it is not, the ledger of the destination shows nothing
  const led = await info<Ledger[]>({ type: 'userNonFundingLedgerUpdates', user: dest, startTime: t - 3_600_000, endTime: t + 60_000 });
  // read live 2026-11-11: the ledger's `usdc` is the amount RECEIVED (net of the fee), `fee` the venue's withdrawal fee, and the
  // entry is dated a few seconds after the bridge paid out; `nonce` is the request's `time` (seen in ms and, from some clients, in µs)
  const hit = led.find((x) => x.delta.type === 'withdraw' && x.delta.usdc !== undefined && Math.abs(x.time - t) < 3_600_000 && Math.round(Number(x.delta.usdc) * 1e6) === Number(amount));
  const two = await confirmed(l);
  const asked = hit?.delta.nonce !== undefined ? (hit.delta.nonce > 1e14 ? Math.round(hit.delta.nonce / 1000) : hit.delta.nonce) : null;
  wChecked++; if (hit && two) wOk++;
  withdrawals.push({ tx: l.transactionHash, onSecondRpc: two, to: dest, received: u6(amount), chainTime: iso(t), matched: !!hit, venueTime: hit ? iso(hit.time) : null, venueUsdc: hit?.delta.usdc ?? null, fee: hit?.delta.fee ?? null, nonce: hit?.delta.nonce ?? null,
    requestToArrivalSeconds: asked ? Math.round((t - asked) / 1000) : null });
  say(`  ${hit ? 'ok  ' : 'n/a '} ${u6(amount)} USDC to ${dest} at ${iso(t)} → ${hit ? `venue ledger "withdraw" usdc ${hit.delta.usdc} (received), fee ${hit.delta.fee}, request nonce ${hit.delta.nonce}${asked ? ` = ${Math.round((t - asked) / 1000)} s before the payout` : ''}` : 'no withdraw entry on the destination\'s own account (asked by another account)'}`);
}
check(wOk > 0 || outs.length === 0, `withdrawals matched with the venue ledger: ${wOk} of ${wChecked}`);
report.withdrawals = { count: outs.length, checked: wChecked, matched: wOk, samples: withdrawals };

say(`\nSummary: ${credited}/${checked} sampled deposits ≥ ${HL_DEPOSIT_MIN_USDC} USDC credited by the venue to the sending address; ${wOk}/${wChecked} sampled withdrawals matched; bytecode ${codeSha === pin.codeSha256 ? 'as pinned' : 'CHANGED'}; ${failures} check(s) failed.`);
say('Not shown here: the venue side of OUR OWN deposit (nothing was sent), and anything about tomorrow.');
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n'); say(`written: ${OUT}`); }
process.exit(failures || credited < checked || checked === 0 ? 1 : 0);
