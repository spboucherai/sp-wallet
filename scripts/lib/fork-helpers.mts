// Shared by scripts/fork-plan.mts: local anvil forks, test funding, and the TEST attestation stand-in for CCTP burns made on
// a fork — the same technique as scripts/fork-cctp.mts (read its header): on the DESTINATION FORK ONLY, two test attester keys
// are enabled by impersonating the contract's attester manager, and a local stand-in for Circle's attestation service signs
// the fork's own MessageSent bytes with them. Everything else is the real bytecode. Nothing here can reach a real network.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, hexToBigInt, keccak256, numberToHex, parseAbi, parseUnits, serializeSignature, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, decodeCctpMessage, encodeCctpMessage, NETWORKS } from '@spw/core';

export interface Forks { url: (net: string) => string; rpc: <T>(net: string, method: string, params?: unknown[]) => Promise<T>; procs: ChildProcess[]; kill: () => void }

/** One anvil fork per network, on consecutive ports. The upstream is the registry's first RPC unless FORK_RPC_<NETWORK> is set. */
export async function startForks(nets: string[], firstPort: number): Promise<Forks> {
  const port = Object.fromEntries(nets.map((n, k) => [n, firstPort + k])), url = (n: string) => `http://127.0.0.1:${port[n]}`;
  let rid = 0;
  // node:http, not fetch: a transaction that makes the fork download a lot of state can take longer than fetch's five-minute limit
  const rpc = <T>(net: string, method: string, params: unknown[] = []): Promise<T> => new Promise<T>((ok, ko) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params });
    const req = request(url(net), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let out = ''; res.on('data', (c: Buffer) => { out += c.toString(); }); res.on('end', () => {
        try { const j = JSON.parse(out) as { result?: T; error?: { message: string } }; if (j.error) ko(new Error(`${method}: ${j.error.message}`)); else ok(j.result as T); } catch { ko(new Error(`${method}: bad answer from the fork`)); } }); });
    req.on('error', (e) => ko(new Error(`${method}: ${e.message}`))); req.end(body); });
  const procs = nets.map((id) => { const n = NETWORKS[id]!;
    return spawn('anvil', ['--fork-url', process.env[`FORK_RPC_${id.toUpperCase()}`] ?? n.rpc[0]!, '--port', String(port[id]), '--chain-id', n.chainRef, '--retries', '12', '--fork-retry-backoff', '1500', '--compute-units-per-second', process.env.FORK_CUPS ?? '120', '--silent'], { stdio: 'ignore' }); });
  const kill = () => { for (const p of procs) p.kill(); };
  process.on('exit', kill);
  for (const n of nets) { let up = false; for (let k = 0; k < 160 && !up; k++) { try { await rpc(n, 'eth_chainId'); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } } if (!up) throw new Error(`the ${n} fork did not start (is anvil installed, is the RPC reachable?)`); }
  return { url, rpc, procs, kill };
}

export const balanceOf = async (f: Forks, net: string, token: string, who: string): Promise<bigint> => token === 'native' ? hexToBigInt(await f.rpc<Hex>(net, 'eth_getBalance', [who, 'latest']))
  : hexToBigInt(await f.rpc<Hex>(net, 'eth_call', [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who as Hex] }) }, 'latest']));
export const setNative = (f: Forks, net: string, who: string, eth: string) => f.rpc(net, 'anvil_setBalance', [who, numberToHex(parseUnits(eth, 18))]);

/**
 * Give an address a token balance on a fork by writing the balance mapping's storage slot. The slot index differs per token
 * (USDC: 9, OpenZeppelin upgradeable: 51, …): it is found by trying, and `balanceOf` must agree before the write is kept.
 */
export async function dealToken(f: Forks, net: string, token: string, who: string, amount: bigint): Promise<number> {
  for (const k of [9, 51, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 52, 101, 151]) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who as Hex, BigInt(k)]));
    const before = await f.rpc<Hex>(net, 'eth_getStorageAt', [token, slot, 'latest']);
    await f.rpc(net, 'anvil_setStorageAt', [token, slot, numberToHex(amount, { size: 32 })]);
    if ((await balanceOf(f, net, token, who)) === amount) return k;
    await f.rpc(net, 'anvil_setStorageAt', [token, slot, before]);
  }
  throw new Error(`could not find the balance slot of ${token} on the ${net} fork`);
}

/** Mine blocks without moving the fork's clock ahead of the real one more than needed (provider deadlines are wall-clock). */
export async function mine(f: Forks, net: string, blocks: number): Promise<void> {
  try { await f.rpc(net, 'anvil_mine', [numberToHex(blocks), '0x0']); } catch { await f.rpc(net, 'anvil_mine', [numberToHex(blocks)]); }
}

const tAbi = parseAbi(['function attesterManager() view returns (address)', 'function enableAttester(address)', 'function signatureThreshold() view returns (uint256)']);
export interface TestAttesters { keys: { key: Hex; address: Hex }[]; manager: string; threshold: number }
/** FORK ONLY: enable two test attesters on a destination fork through the impersonated attester manager. */
export async function enableTestAttesters(f: Forks, dst: string): Promise<TestAttesters> {
  const keys = [generatePrivateKey(), generatePrivateKey()].map((k) => ({ key: k, address: privateKeyToAccount(k).address })).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const call = (data: Hex) => f.rpc<Hex>(dst, 'eth_call', [{ to: CCTP_MESSAGE_TRANSMITTER, data }, 'latest']);
  const manager = ('0x' + (await call(encodeFunctionData({ abi: tAbi, functionName: 'attesterManager' }))).slice(26)) as Hex;
  await f.rpc(dst, 'anvil_impersonateAccount', [manager]); await setNative(f, dst, manager, '1');
  for (const a of keys) await f.rpc(dst, 'eth_sendTransaction', [{ from: manager, to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: tAbi, functionName: 'enableAttester', args: [a.address] }) }]);
  await f.rpc(dst, 'anvil_stopImpersonatingAccount', [manager]);
  return { keys, manager, threshold: Number(hexToBigInt(await call(encodeFunctionData({ abi: tAbi, functionName: 'signatureThreshold' })))) };
}
/** FORK ONLY: the test attesters' signatures over a message (v8: also used for messages that did not start on a fork, scripts/sim-solana-cctp.mts). */
export const attestMessage = (message: Hex, a: TestAttesters): Promise<Hex> => attest(message, a);
async function attest(message: Hex, a: TestAttesters): Promise<Hex> {
  const digest = keccak256(message); let out = '0x';
  for (const k of a.keys) out += serializeSignature(await sign({ hash: digest, privateKey: k.key })).slice(2);
  return out as Hex;
}
/** What Circle does off-chain for a burn: take its MessageSent bytes, assign a nonce, record the finality and the fee, sign. */
export async function attestBurn(f: Forks, src: string, dst: string, txid: string, a: TestAttesters): Promise<{ message: Hex; attestation: Hex } | null> {
  const rc = await f.rpc<{ status: string; logs: { address: string; data: Hex; topics: [Hex, ...Hex[]] }[] } | null>(src, 'eth_getTransactionReceipt', [txid]);
  if (!rc || rc.status !== '0x1') return null;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== CCTP_MESSAGE_TRANSMITTER.toLowerCase()) continue;
    let ev; try { ev = decodeEventLog({ abi: CCTP_ABI, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { message: Hex } }; } catch { continue; }
    if (ev.eventName !== 'MessageSent') continue;
    const m = decodeCctpMessage(ev.args.message);
    if (m.nonce !== '0'.repeat(64) || m.finalityThresholdExecuted !== 0 || m.body.feeExecuted !== 0n) throw new Error('the on-chain message is not in the pre-attestation form');
    const fast = m.minFinalityThreshold <= 1000;
    const message = encodeCctpMessage({ ...m, nonce: keccak256(txid as Hex).slice(2), finalityThresholdExecuted: m.minFinalityThreshold,
      body: { ...m.body, feeExecuted: fast && m.body.maxFee > 0n ? m.body.maxFee - 1n : 0n, expirationBlock: fast ? hexToBigInt(await f.rpc<Hex>(dst, 'eth_blockNumber')) + 1_000_000_000n : 0n } });
    return { message, attestation: await attest(message, a) };
  }
  return null;
}

/**
 * Local stand-in for Circle's attestation service. Fee schedule and Fast allowance are passed through, read-only, from Circle's
 * real service; the attestation of a fork-only burn is signed by the test attesters. `hold` = "Circle has not attested yet".
 */
export async function startTestIris(f: Forks, routes: { src: string; dst: string }[], a: Record<string, TestAttesters>): Promise<{ server: Server; url: string; state: { hold: boolean; asked: number } }> {
  const state = { hold: false, asked: 0 };
  const server = createServer((req, res) => { void (async () => {
    const send = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url!, 'http://x');
    try {
      if (u.pathname.startsWith('/v2/burn/USDC/fees/') || u.pathname === '/v2/fastBurn/USDC/allowance') { const r = await fetch(`https://iris-api.circle.com${u.pathname}`, { signal: AbortSignal.timeout(10000) }); return send(r.status, await r.json()); }
      const m = /^\/v2\/messages\/(\d+)$/.exec(u.pathname);
      if (m) {
        state.asked += 1;
        const h = u.searchParams.get('transactionHash') ?? '';
        if (state.hold) return send(404, { error: 'Message not found for provided parameters' });
        for (const r of routes) { if (CCTP_ENABLED[r.src]!.domain !== Number(m[1])) continue;
          const x = await attestBurn(f, r.src, r.dst, h, a[r.dst]!).catch(() => null);
          if (x) return send(200, { messages: [{ status: 'complete', cctpVersion: 2, message: x.message, attestation: x.attestation, delayReason: null }] }); }
        return send(404, { error: 'Message not found for provided parameters' });
      }
      send(404, {});
    } catch (e) { send(500, { error: (e as Error).message }); } })(); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, state };
}
