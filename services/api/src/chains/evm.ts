import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, hexToString, multicall3Abi, numberToHex, pad, serializeTransaction } from 'viem';
import { getAsset, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { benchOnFailure, FAST, hostOf, notBenched, rpcAny, rpcEach, rpcOne, rpcQuorum, settle, type Adapter, type BalancesDetailed, type Deposit, type Health, type NativeScanNote, type NativeScanState, type Prepared, type Tracked } from './rpc.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hx = (n: bigint | number) => numberToHex(n);
/** NEXT: a balance whose block is older than this is flagged `stale` (the sources answer, but from an old state) */
export const EVM_STALE_SEC = 180;
/** an endpoint saying it does not keep the state of that block (a pruned, non-archive node) — not a failure of the endpoint */
const NO_HISTORY = /missing trie node|state .*(not available|unavailable|pruned|is not)|historical state|header not found|unknown block|block not found|archive|pruned|old data not available|state at block|no state available|required historical/i;
/** `idx` of the rows of the native scan: above any log index, so that (txid, idx) never collides with a token transfer of the same transaction */
export const NATIVE_IDX = 1_000_000;
class ScanRetry extends Error {} // the pass stops here and is tried again later; nothing is recorded past the resolved frontier

/** OP-stack predeploy (the same address on every OP-stack chain): what Ethereum data costs for a given transaction */
const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_ORACLE_ABI = [{ type: 'function', name: 'getL1Fee', stateMutability: 'view', inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ type: 'uint256' }] }] as const;

export function evmAdapter(n: NetworkDef): Adapter {
  const call = <T>(m: string, p: unknown[]) => rpcAny<T>(n.rpc, m, p);
  let identity = false;
  /** tokens whose on-chain symbol/decimals do not match the pinned registry: hidden and unsendable */
  const disabled = new Set<string>();
  let tokensChecked = false;
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  /** One eth_call for many read-only calls (Multicall3.aggregate3, failures allowed per call). */
  async function multi(calls: { target: string; data: `0x${string}` }[], exec: <T>(m: string, p: unknown[]) => Promise<T> = call, tag = 'latest'): Promise<({ ok: boolean; data: `0x${string}` })[]> {
    const out: { ok: boolean; data: `0x${string}` }[] = [];
    for (let k = 0; k < calls.length; k += 40) {
      const chunk = calls.slice(k, k + 40);
      const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.data }))] });
      const ret = await exec<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, tag]);
      for (const r of decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: ret })) out.push({ ok: r.success, data: r.returnData });
    }
    return out;
  }
  const symbolOf = (d: `0x${string}`): string => { // string, or bytes32 for a few old tokens
    try { return decodeAbiParameters([{ type: 'string' }], d)[0]; } catch { try { return hexToString(d, { size: 32 }); } catch { return ''; } }
  };
  async function verifyTokens(): Promise<void> {
    const dec = encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }), sym = encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' });
    const rs = await multi(n.tokens.flatMap((t) => [{ target: t.id, data: dec }, { target: t.id, data: sym }]));
    n.tokens.forEach((t, k) => {
      const d = rs[2 * k]!, y = rs[2 * k + 1]!;
      // a token whose contract returns another symbol than the ticker (registry field onchainSymbol, e.g. "USD₮0", or "USDC" for USDC.e) must return exactly that
      const sy = y.ok ? symbolOf(y.data) : '';
      const good = d.ok && y.ok && d.data !== '0x' && hexToNumber(d.data) === t.decimals && (t.onchainSymbol !== undefined ? sy === t.onchainSymbol : sy.replace(/[^\x20-\x7e]/g, '').toUpperCase() === t.symbol.toUpperCase());
      if (good) disabled.delete(t.id); else { disabled.add(t.id); console.error(`[evm] ${n.id}: token ${t.symbol} ${t.id} failed on-chain metadata check — disabled`); }
    });
    tokensChecked = true;
  }
  async function verifyIdentity(): Promise<boolean> {
    try {
      const id = await rpcQuorum<string>(n.rpc, 'eth_chainId', []);
      if (hexToNumber(id as `0x${string}`) !== Number(n.chainRef)) return (identity = false);
      if (!tokensChecked) await verifyTokens();
      return (identity = true);
    } catch { return (identity = false); }
  }
  const live = () => n.tokens.filter((t) => !disabled.has(t.id));
  /**
   * NEXT (E1) — OP-stack chains: the Ethereum data fee of this transaction, from the chain's own GasPriceOracle, plus 25 %.
   * 0n on other chains; null when the oracle could not be read (the caller says so instead of showing a fee that omits it).
   */
  const l1Fee = async (t: { to: `0x${string}`; value: bigint; data?: `0x${string}`; gas: bigint; maxFeePerGas: bigint; tip: bigint; nonce: number }): Promise<bigint | null> => {
    if (n.evm?.l1Fee !== 'opstack') return 0n;
    try {
      // the signed size: the unsigned EIP-1559 bytes plus a 65-byte signature (r, s, y parity and their RLP prefixes: 67 bytes)
      const unsigned = serializeTransaction({ type: 'eip1559', chainId: Number(n.chainRef), nonce: t.nonce, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.tip, to: t.to, value: t.value, data: t.data ?? '0x' });
      const bytes = (unsigned + 'ff'.repeat(67)) as `0x${string}`;
      const ret = await call<`0x${string}`>('eth_call', [{ to: OP_GAS_ORACLE, data: encodeFunctionData({ abi: OP_ORACLE_ABI, functionName: 'getL1Fee', args: [bytes] }) }, 'latest']);
      return hexToBigInt(ret) * 5n / 4n;
    } catch { return null; }
  };
  const finalizedHeight = async (): Promise<number> => {
    try { const b = await call<{ number: `0x${string}` } | null>('eth_getBlockByNumber', ['finalized', false]); if (b) return hexToNumber(b.number); } catch { /* tag unsupported */ }
    return hexToNumber(await call<`0x${string}`>('eth_blockNumber', [])) - n.minConf;
  };
  return {
    async health(): Promise<Health> {
      const endpoints = await Promise.all(n.rpc.map(async (url) => {
        const t = Date.now();
        try { const h = hexToNumber(await rpcOne<`0x${string}`>(url, 'eth_blockNumber', [])); return { url: hostOf(url), ok: true, ms: Date.now() - t, h }; }
        catch { return { url: hostOf(url), ok: false, ms: null, h: null as number | null }; }
      }));
      const ok = endpoints.every((e) => e.ok);
      if (ok && !identity) await verifyIdentity();
      return { network: n.id, ok: ok && identity, readable: endpoints.some((e) => e.ok), identityVerified: identity, height: Math.max(0, ...endpoints.map((e) => e.h ?? 0)) || null,
        endpoints: endpoints.map(({ h: _h, ...e }) => e), checkedAt: new Date().toISOString() };
    },
    async balances(addr) {
      const out: Record<string, bigint> = { native: hexToBigInt(await call<`0x${string}`>('eth_getBalance', [addr, 'latest'])) };
      const toks = live();
      if (!toks.length) return out;
      const rs = await multi(toks.map((t) => ({ target: t.id, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [addr as `0x${string}`] }) })));
      toks.forEach((t, k) => { const r = rs[k]!; if (r.ok && r.data.length === 66) out[t.id] = hexToBigInt(r.data); });
      return out;
    },
    /**
     * NEXT B2 — every endpoint is asked and the answers are compared AT THE SAME BLOCK: the heads are read first, then the native
     * balance and the token balances are read at `min(heads) - 1` on each endpoint (one block behind the slowest head, so that
     * a load-balanced endpoint whose backends are not all at its head still has the block). An endpoint that cannot serve the
     * pinned block is read at `latest` and its answer carries its own head. Per asset: all answers equal = agreed; otherwise
     * the row is not a fact (`agreed: false`, amount of the higher block). A token no endpoint could read is `unavailable`.
     * Cost: 3 calls per endpoint (2 on a network without tokens) + 1 block header for the age of the state.
     * Time: one attempt of 7 s per call; an endpoint that failed at the connection level sits out for a minute (rpc.ts).
     */
    async balancesDetailed(addr): Promise<BalancesDetailed> {
      const toks = live();
      const urls = notBenched(n.rpc);
      const heads = await Promise.all(urls.map(async (url) => { try { return hexToNumber(await rpcOne<`0x${string}`>(url, 'eth_blockNumber', [], FAST)); } catch (e) { benchOnFailure(url, e); return null; } }));
      const up = heads.filter((h): h is number => h !== null);
      if (!up.length) throw new Error('no endpoint answered');
      const pin = Math.max(0, Math.min(...up) - 1);
      const readOn = async (url: string, tag: string): Promise<Record<string, bigint>> => {
        const one = <T>(m: string, p: unknown[]) => rpcOne<T>(url, m, p, FAST);
        const out: Record<string, bigint> = { native: hexToBigInt(await one<`0x${string}`>('eth_getBalance', [addr, tag])) };
        if (toks.length) {
          const rs = await multi(toks.map((t) => ({ target: t.id, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [addr as `0x${string}`] }) })), one, tag);
          toks.forEach((t, k) => { const r = rs[k]!; if (r.ok && r.data.length === 66) out[t.id] = hexToBigInt(r.data); });
        }
        return out;
      };
      const reads = (await Promise.all(urls.map(async (url, k) => {
        if (heads[k] === null) return null;
        try { return { url, height: pin, v: await readOn(url, hx(pin)) }; }
        catch (e) {
          benchOnFailure(url, e);
          if ((e as { rpcCode?: number }).rpcCode === undefined) return null; // it does not answer: asking it again at `latest` would only wait once more
          try { return { url, height: heads[k]!, v: await readOn(url, 'latest') }; } catch (e2) { benchOnFailure(url, e2); return null; }
        }
      }))).filter((r): r is { url: string; height: number; v: Record<string, bigint> } => r !== null);
      if (!reads.length) throw new Error('no endpoint answered');
      let stale = false; // unknown age (header not served) is not called stale
      try { const b = await rpcOne<{ timestamp: `0x${string}` } | null>(reads[0]!.url, 'eth_getBlockByNumber', [hx(pin), false], FAST); if (b) stale = Date.now() / 1000 - hexToNumber(b.timestamp) > EVM_STALE_SEC; } catch { /* age unknown */ }
      const assets: BalancesDetailed['assets'] = {}, unavailable: Record<string, string> = {};
      for (const id of ['native', ...toks.map((t) => t.id)]) {
        const got = reads.filter((r) => r.v[id] !== undefined).map((r) => ({ amount: r.v[id]!, height: r.height }));
        if (got.length) assets[id] = settle(got, n.rpc.length, stale); else unavailable[id] = 'no_source_answered';
      }
      return { assets, unavailable };
    },
    disabledAssets: () => [...disabled],
    async prepare(d): Promise<Prepared> {
      if (!identity && !(await verifyIdentity())) throw new UserError('rpc_degraded', 'chain identity could not be verified; transfer refused', 503);
      const asset = getAsset(n.id, d.asset), warnings: string[] = [];
      if (disabled.has(asset.id)) throw new UserError('unsupported_asset', 'this token failed its on-chain identity check and is disabled');
      const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [d.from, 'pending']));
      const latest = hexToNumber(await call<`0x${string}`>('eth_getTransactionCount', [d.from, 'latest']));
      if (nonce !== latest) throw new UserError('pending_tx', 'a previous transaction from this wallet is still pending on this network');
      const block = await call<{ baseFeePerGas?: `0x${string}` }>('eth_getBlockByNumber', ['latest', false]);
      if (!block.baseFeePerGas) throw new UserError('rpc_degraded', 'network did not report a base fee', 503);
      const baseFee = hexToBigInt(block.baseFeePerGas);
      let tip = 1_000_000n;
      try { tip = hexToBigInt(await call<`0x${string}`>('eth_maxPriorityFeePerGas', [])); } catch { /* keep floor */ }
      if (n.id === 'polygon' && tip < 30_000_000_000n) tip = 30_000_000_000n; // Polygon PoS enforces a 30 gwei minimum tip
      const maxFeePerGas = baseFee * 2n + tip;
      const code = await call<string>('eth_getCode', [d.to, 'latest']);
      const balances = await this.balances(d.from);
      if (asset.id !== 'native' && balances[asset.id] === undefined) throw new UserError('rpc_degraded', 'token balance could not be read; transfer refused', 503);
      let gas: bigint, l1: bigint | null;
      if (asset.id === 'native') {
        if (code !== '0x') throw new UserError('contract_destination', 'native transfers to contract addresses are not supported');
        gas = 21000n;
        if (n.evm?.nativeGasMax) { // NEXT (E1): the rollup charges its Ethereum posting cost through the gas limit — 21 000 is refused there
          let est: bigint;
          // both endpoints must answer, within 20 % of each other (the estimate moves with the Ethereum base fee between two calls)
          const near = (x: `0x${string}`, y: `0x${string}`) => { const [p, q] = [hexToBigInt(x), hexToBigInt(y)]; return (p > q ? p - q : q - p) * 5n <= (p > q ? p : q); };
          try { est = hexToBigInt(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_estimateGas', [{ from: d.from, to: d.to, value: numberToHex(d.amount) }], near)); }
          catch (e) { if (e instanceof UserError) throw e; throw new UserError('simulation_failed', `gas estimate refused: ${(e as Error).message.slice(0, 160)}`); }
          gas = est * 12n / 10n; if (gas < 21000n) gas = 21000n;
          if (gas > BigInt(n.evm.nativeGasMax)) throw new UserError('simulation_failed', `unexpectedly high gas estimate for a ${n.native.symbol} transfer on ${n.name}`);
        }
        l1 = await l1Fee({ to: d.to as `0x${string}`, value: d.amount, gas, maxFeePerGas, tip, nonce });
        if ((balances.native ?? 0n) < d.amount + gas * maxFeePerGas + (l1 ?? 0n)) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol} for amount plus network fee`);
      } else {
        if (code !== '0x') warnings.push('contract_destination');
        if ((balances[asset.id] ?? 0n) < d.amount) throw new UserError('insufficient_funds', `insufficient ${asset.symbol} balance`);
        const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.to as `0x${string}`, d.amount] });
        let est: bigint;
        try { est = hexToBigInt(await call<`0x${string}`>('eth_estimateGas', [{ from: d.from, to: asset.id, data }])); }
        catch (e) { throw new UserError('simulation_failed', `simulation reverted: ${(e as Error).message.slice(0, 160)}`); }
        // simulate the exact call and require the ERC-20 boolean success value
        const ret = await call<`0x${string}`>('eth_call', [{ from: d.from, to: asset.id, data }, 'latest']);
        if (ret !== '0x' && hexToBigInt(ret) !== 1n) throw new UserError('simulation_failed', 'token transfer simulation returned false');
        gas = (est * 13n) / 10n + 5000n;
        if (gas > 200_000n) throw new UserError('simulation_failed', 'unexpectedly high gas estimate for a token transfer');
        l1 = await l1Fee({ to: asset.id as `0x${string}`, value: 0n, data, gas, maxFeePerGas, tip, nonce });
        if ((balances.native ?? 0n) < gas * maxFeePerGas + (l1 ?? 0n)) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
      }
      return { section: { evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } },
        // the approved maximum bounds what the transaction's own fields can cost; the OP-stack data fee is charged on top by the
        // chain and is part of the ESTIMATE only (it is not a field the signer could bound)
        maxFee: gas * maxFeePerGas, feeEstimate: gas * (baseFee + tip) + (l1 ?? 0n), warnings: l1 === null ? [...warnings, 'l1_fee_unknown'] : warnings, ttlSec: 180 };
    },
    async broadcast(raw) {
      const rs = await Promise.allSettled(n.rpc.map((u) => rpcOne<string>(u, 'eth_sendRawTransaction', [raw])));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      // NEXT: every endpoint's answer is read, not only the first one's. "Already known" from any of them is a relay.
      // "nonce too low" is NOT treated as success here: it only says the nonce is used — by this transaction or by
      // another one. The caller settles that by looking the transaction up (transfers.ts `broadcastNow`).
      const msgs = rs.map((r) => String((r as PromiseRejectedResult).reason?.message ?? 'broadcast failed'));
      if (msgs.some((m) => /already known|already imported|ALREADY_EXISTS|known transaction/i.test(m))) return;
      throw new Error([...new Set(msgs)].join(' | ').slice(0, 300));
    },
    /**
     * NEXT — a verdict never rests on one endpoint's silence:
     *  - a receipt from ANY endpoint places the transaction in a block (a lagging endpoint cannot hide it);
     *  - "not in a block and unknown" needs every endpoint to have answered both lookups;
     *  - `replaced` needs, in addition, the nonce to be consumed according to every endpoint (quorum);
     *  - the worker applies a negative verdict only after it was repeated on consecutive passes (worker.ts).
     */
    async track(p): Promise<Tracked> {
      type Receipt = { status: `0x${string}`; blockNumber: `0x${string}`; blockHash: string; gasUsed?: `0x${string}`; effectiveGasPrice?: `0x${string}`; l1Fee?: `0x${string}` };
      const rcs = await rpcEach<Receipt | null>(n.rpc, 'eth_getTransactionReceipt', [p.txid]);
      const rc = rcs.values.find((v) => v && v.blockHash) ?? null;
      if (!rc) {
        if (rcs.values.length === 0) throw new Error(`no ${n.name} endpoint answered (receipt)`);
        const txs = await rpcEach<{ hash: string } | null>(n.rpc, 'eth_getTransactionByHash', [p.txid]);
        const known = txs.values.some((v) => v), everyone = rcs.all && txs.all;
        const pending: Tracked['state'] = p.blockRef ? 'reorged' : 'broadcast';
        if (known) return { state: pending, confirmations: 0, seen: true, rebroadcast: !!p.blockRef };
        if (everyone && Date.now() / 1000 - p.broadcastAt > 90) {
          const latest = await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [p.intent.from, 'latest']).then(hexToNumber, () => null);
          if (latest !== null && latest > p.intent.evm.nonce) return { state: 'replaced', confirmations: 0, seen: false, error: 'nonce was consumed by another transaction' };
        }
        return { state: pending, confirmations: 0, rebroadcast: true, seen: everyone ? false : undefined };
      }
      const paid = rc.gasUsed && rc.effectiveGasPrice ? hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice) + (rc.l1Fee ? hexToBigInt(rc.l1Fee) : 0n) : undefined; // l1Fee: OP-stack data fee
      if (hexToNumber(rc.status) !== 1) return { state: 'failed', confirmations: 0, blockRef: rc.blockHash, error: 'transaction reverted on-chain', seen: true, feePaid: paid };
      const bn = hexToNumber(rc.blockNumber), head = hexToNumber(await call<`0x${string}`>('eth_blockNumber', []));
      const fin = await finalizedHeight();
      return { state: bn <= fin ? 'finalized' : 'confirming', confirmations: Math.max(1, head - bn + 1), blockRef: rc.blockHash, seen: true, feePaid: paid };
    },
    async deposits(addr, cursor) {
      const head = hexToNumber(await call<`0x${string}`>('eth_blockNumber', []));
      const fin = await finalizedHeight();
      // NEXT H2: a backlog is never jumped over. Each pass reads at most 12 ranges of 2 000 blocks from the cursor and stops
      // there; the cursor is the last block actually read, so the catch-up continues on the next passes until the head.
      const from = cursor === null ? Math.max(0, head - 3000) : cursor + 1;
      const items: Deposit[] = [];
      const topicTo = pad(addr as `0x${string}`).toLowerCase();
      let done = from - 1;
      for (let a = from, span = 2000, calls = 0; a <= head && calls < 12; calls++) {
        const b = Math.min(head, a + span - 1);
        try {
          const toks = live();
          if (toks.length) {
            const logs = await call<{ address: string; transactionHash: string; logIndex: `0x${string}`; data: `0x${string}`; topics: string[]; blockNumber: `0x${string}`; removed?: boolean }[]>(
              'eth_getLogs', [{ address: toks.map((t) => t.id), topics: [TRANSFER_TOPIC, null, topicTo], fromBlock: hx(a), toBlock: hx(b) }]);
            for (const l of logs) {
              const t = toks.find((x) => x.id.toLowerCase() === l.address.toLowerCase());
              if (t && !l.removed && l.topics.length === 3 && l.data.length === 66)
                items.push({ txid: l.transactionHash, idx: hexToNumber(l.logIndex), asset: t.id, amount: hexToBigInt(l.data), from: '0x' + l.topics[1]!.slice(26), block: hexToNumber(l.blockNumber), time: null });
            }
          }
          done = b; a = b + 1;
        } catch { if (span <= 125) break; span = Math.floor(span / 2); }
      }
      return { items, cursor: Math.max(done, (cursor ?? done)), finalizedHeight: fin };
    },
    /**
     * NEXT H1 — incoming NATIVE coins, with no trace API and no indexer.
     *
     * The scan keeps the wallet's balance and nonce (count of sent transactions) at the last block it resolved (`prev`). A
     * pass reads both at a later block, at most `maxWindow` blocks further and never beyond `head - minConf`:
     *   - same balance, same nonce: nothing happened in the window (a native balance cannot change otherwise);
     *   - the nonce moved by exactly the wallet's own transactions known to the API (`own`, looked up by receipt) and the
     *     balance moved by exactly their cost (value + gasUsed x effectiveGasPrice + the L1 fee of an OP-stack receipt): explained;
     *   - anything else: the window is bisected on (balance, nonce) until single blocks remain; each such block is read with
     *     its transactions. Value transfers `to == wallet` are deposits with their txid; the wallet's own transactions are
     *     costed from their receipts; what is still unexplained and positive arrived inside a contract call: it is recorded as
     *     `internal_call` under the wallet's own transaction of that block when there is exactly one (a swap paying out the
     *     native coin), otherwise under the BLOCK hash — never under a transaction id that is not known.
     * Every state read is asked to every endpoint; those that answer must agree, else the pass stops and is retried.
     * Public endpoints differ on old state (observed 2026-11-19: some refuse it with `missing trie node` / `historical
     * state`, some with HTTP 403, one by never answering): a state read uses one attempt of 4 s, and an endpoint that
     * refused or failed a state read is not asked again for the BISECTION points of the pass, so a pass is not slowed by
     * it. The end of each window — the state the next pass starts from — is always asked to every endpoint.
     * When no endpoint keeps the state of a block (pruned nodes): the part that cannot be bisected is recorded as ONE
     * `aggregate` deposit at the end block of that part, with a note — never dropped. A decrease that nothing explains is
     * reported in `notes` (the caller writes it to the audit chain) and records nothing.
     *
     * RPC bound per pass: state points <= maxPoints (40) + maxWindows (4), each = 2 calls x endpoints; full blocks <= maxLeaves
     * (6); receipts <= 2 x min(own, 25) + per full block (own transactions + at most 25 incoming); + 1 head + headers of
     * aggregates. A quiet pass costs 1 + 2 x endpoints calls. When the bound is reached the pass returns the state at the
     * last block fully resolved (the bisection is left-first), and the next pass continues from there.
     */
    async nativeDeposits(addr, prev, opts = {}) {
      const maxPoints = opts.maxPoints ?? 40, maxWindow = opts.maxWindow ?? 2048, maxWindows = opts.maxWindows ?? 4, maxLeaves = opts.maxLeaves ?? 6;
      const me = addr.toLowerCase(), items: Deposit[] = [], notes: NativeScanNote[] = [];
      let calls = 0, points = 0, leaves = 0;
      const count = <T>(p: Promise<T>): Promise<T> => { calls += 1; return p; };
      /** balance and nonce at a block, from every endpoint; `null` = no endpoint keeps that state */
      const skipped = new Set<string>(), fast = { timeoutMs: 4000, retry: false };
      /** the endpoint says it does not keep that state: a JSON-RPC error naming it, or a plain HTTP refusal (403 on publicnode) */
      const isRefusal = (e: unknown): boolean => { const x = e as { rpcCode?: number; httpStatus?: number; message?: string };
        return (x.rpcCode !== undefined && NO_HISTORY.test(String(x.message))) || [400, 403, 404, 410].includes(x.httpStatus ?? 0); };
      const stateAt = async (block: number, everyEndpoint = false): Promise<NativeScanState | null> => {
        points += 1;
        const urls = !everyEndpoint && n.rpc.some((u) => !skipped.has(u)) ? n.rpc.filter((u) => !skipped.has(u)) : n.rpc;
        const rs = await Promise.allSettled(urls.map(async (url) => {
          const [b, c] = await Promise.all([count(rpcOne<`0x${string}`>(url, 'eth_getBalance', [addr, hx(block)], fast)), count(rpcOne<`0x${string}`>(url, 'eth_getTransactionCount', [addr, hx(block)], fast))]);
          return { balance: hexToBigInt(b), nonce: hexToNumber(c) };
        }));
        if (!everyEndpoint) rs.forEach((r, k) => { if (r.status === 'rejected') skipped.add(urls[k]!); });
        const ok = rs.filter((r): r is PromiseFulfilledResult<{ balance: bigint; nonce: number }> => r.status === 'fulfilled').map((r) => r.value);
        if (!ok.length) {
          // "no endpoint keeps it" only when EVERY endpoint was asked and every one refused; anything else is a failure to retry
          const all = urls.length === n.rpc.length ? rs : await Promise.allSettled(n.rpc.map((url) => count(rpcOne<`0x${string}`>(url, 'eth_getBalance', [addr, hx(block)], fast))));
          if (all.some((r) => r.status === 'fulfilled')) throw new ScanRetry(`state at block ${block}: endpoints answer unevenly`);
          if (all.every((r) => r.status === 'rejected' && isRefusal(r.reason))) return null;
          throw new ScanRetry(`state at block ${block} unavailable`);
        }
        if (ok.some((v) => v.balance !== ok[0]!.balance || v.nonce !== ok[0]!.nonce)) throw new ScanRetry(`endpoints disagree on the state at block ${block}`);
        return { block, ...ok[0]! };
      };
      type Rc = { status: `0x${string}`; blockNumber: `0x${string}`; from: string; to: string | null; gasUsed: `0x${string}`; effectiveGasPrice?: `0x${string}`; l1Fee?: `0x${string}` };
      type Tx = { hash: string; from: string; to: string | null; value: `0x${string}`; gasPrice?: `0x${string}` };
      const receipt = (h: string) => count(call<Rc | null>('eth_getTransactionReceipt', [h]));
      /** what one of the wallet's own transactions took from its native balance */
      const costOf = (tx: Tx, rc: Rc): bigint => hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? '0x0') + (rc.l1Fee ? hexToBigInt(rc.l1Fee) : 0n)
        + (hexToNumber(rc.status) === 1 && (tx.to ?? '').toLowerCase() !== me ? hexToBigInt(tx.value) : 0n);
      /** the wallet's own transactions the API knows, by block (loaded once, only when a nonce moved) */
      let own: { hash: string; block: number; cost: bigint }[] | null = null;
      const loadOwn = async (): Promise<{ hash: string; block: number; cost: bigint }[]> => {
        if (own) return own;
        const out: { hash: string; block: number; cost: bigint }[] = [];
        for (const h of [...new Set((opts.own ?? []).map((x) => x.toLowerCase()))].slice(0, 25)) {
          try {
            const rc = await receipt(h);
            if (!rc || rc.from.toLowerCase() !== me) continue;
            const tx = await count(call<Tx | null>('eth_getTransactionByHash', [h]));
            if (tx) out.push({ hash: h, block: hexToNumber(rc.blockNumber), cost: costOf(tx, rc) });
          } catch (e) { throw new ScanRetry(`receipt of ${h.slice(0, 12)}: ${(e as Error).message.slice(0, 80)}`); }
        }
        return (own = out);
      };
      const ownIn = async (lo: number, hi: number) => (await loadOwn()).filter((t) => t.block > lo && t.block <= hi);
      const headerHash = async (block: number): Promise<string> => { try { const b = await count(call<{ hash: string } | null>('eth_getBlockByNumber', [hx(block), false])); if (b?.hash) return b.hash; } catch { /* below */ } return `block:${block}`; };
      /** a part that cannot be located: one deposit for its net unexplained increase, and a note in every case */
      const aggregate = async (lo: NativeScanState, hi: NativeScanState, code: NativeScanNote['code']): Promise<void> => {
        const known = hi.nonce !== lo.nonce ? await ownIn(lo.block, hi.block) : [];
        const amount = hi.balance - lo.balance + known.reduce((s, t) => s + t.cost, 0n), unknownOwnTxs = hi.nonce - lo.nonce - known.length;
        if (amount === 0n && unknownOwnTxs === 0) return;
        notes.push({ code: amount < 0n ? 'unexplained_decrease' : code, fromBlock: lo.block + 1, toBlock: hi.block, amount: amount.toString(), unknownOwnTxs });
        if (amount > 0n) items.push({ txid: await headerHash(hi.block), idx: NATIVE_IDX + 1, asset: 'native', amount, from: '', block: hi.block, time: null, via: 'aggregate' });
      };
      const leaf = async (lo: NativeScanState, hi: NativeScanState): Promise<void> => {
        let b: { hash: string; timestamp: `0x${string}`; transactions: Tx[] } | null;
        try { b = await count(call<{ hash: string; timestamp: `0x${string}`; transactions: Tx[] } | null>('eth_getBlockByNumber', [hx(hi.block), true])); } catch (e) { throw new ScanRetry(`block ${hi.block}: ${(e as Error).message.slice(0, 80)}`); }
        if (!b) throw new ScanRetry(`block ${hi.block} not served`);
        const time = hexToNumber(b.timestamp);
        const mine = b.transactions.filter((t) => t.from.toLowerCase() === me);
        const incoming = b.transactions.filter((t) => (t.to ?? '').toLowerCase() === me && t.from.toLowerCase() !== me && hexToBigInt(t.value) > 0n);
        const found: Deposit[] = [];
        let cost = 0n, direct = 0n;
        try {
          for (const t of mine) { const rc = await receipt(t.hash); if (!rc) throw new Error('no receipt'); cost += costOf(t, rc); }
          for (const [k, t] of incoming.entries()) {
            // a transfer to an account that runs code can revert: only a successful one moved value (the first 25 are checked)
            if (k < 25) { const rc = await receipt(t.hash); if (!rc) throw new Error('no receipt'); if (hexToNumber(rc.status) !== 1) continue; }
            direct += hexToBigInt(t.value);
            found.push({ txid: t.hash, idx: NATIVE_IDX, asset: 'native', amount: hexToBigInt(t.value), from: t.from.toLowerCase(), block: hi.block, time, via: 'tx', blockHash: b.hash });
          }
        } catch (e) { throw new ScanRetry(`block ${hi.block}: ${(e as Error).message.slice(0, 80)}`); }
        const residual = hi.balance - lo.balance + cost - direct;
        if (residual > 0n) {
          const sole = mine.length === 1 ? mine[0]! : null;
          found.push({ txid: sole ? sole.hash : b.hash, idx: NATIVE_IDX, asset: 'native', amount: residual, from: sole ? (sole.to ?? '').toLowerCase() : '', block: hi.block, time, via: 'internal_call', blockHash: b.hash });
        } else if (residual < 0n) notes.push({ code: 'unexplained_decrease', fromBlock: hi.block, toBlock: hi.block, amount: residual.toString() });
        items.push(...found);
      };
      /** everything up to `frontier.block` is resolved; a left-first bisection keeps that true at every step */
      let frontier: NativeScanState = prev ?? { block: 0, balance: 0n, nonce: 0 };
      const resolve = async (lo: NativeScanState, hi: NativeScanState): Promise<boolean> => {
        frontier = lo;
        if (hi.nonce === lo.nonce && hi.balance === lo.balance) { frontier = hi; return true; }
        if (hi.nonce !== lo.nonce) {
          const known = await ownIn(lo.block, hi.block);
          if (hi.nonce - lo.nonce === known.length && hi.balance - lo.balance + known.reduce((s, t) => s + t.cost, 0n) === 0n) { frontier = hi; return true; }
        }
        if (hi.block - lo.block === 1) {
          if (leaves >= maxLeaves) return false;
          leaves += 1; await leaf(lo, hi); frontier = hi; return true;
        }
        if (points >= maxPoints) return false;
        const mid = await stateAt(lo.block + Math.floor((hi.block - lo.block) / 2));
        if (!mid) { await aggregate(lo, hi, 'state_unavailable'); frontier = hi; return true; }
        if (!(await resolve(lo, mid))) return false;
        return resolve(mid, hi);
      };
      const head = hexToNumber(await count(call<`0x${string}`>('eth_blockNumber', [])));
      const safe = head - n.minConf;
      if (safe < 0) return { items, state: frontier, notes, calls };
      if (!prev) { // first pass: a baseline, nothing to compare with
        const s = await stateAt(safe, true);
        if (!s) throw new Error('recent state not served by any endpoint');
        return { items, state: s, notes, calls };
      }
      try {
        for (let w = 0; w < maxWindows && frontier.block < safe; w++) {
          const lo: NativeScanState = frontier, end = Math.min(safe, lo.block + maxWindow);
          const hi = await stateAt(end, true);
          if (!hi) {
            // no endpoint keeps the state of that (old) block: everything up to the recent safe block becomes one aggregate
            const now = end === safe ? null : await stateAt(safe, true);
            if (!now) throw new ScanRetry('recent state not served by any endpoint');
            await aggregate(lo, now, 'window_too_old'); frontier = now; break;
          }
          if (!(await resolve(lo, hi))) { notes.push({ code: 'budget_exhausted', fromBlock: frontier.block + 1, toBlock: hi.block, amount: '0' }); break; }
        }
      } catch (e) {
        if (!(e instanceof ScanRetry)) throw e;
        // stop at the frontier: what is before it is resolved and its deposits are kept; the rest is tried again
        const at = frontier.block;
        return { items: items.filter((d) => d.block <= at), state: frontier, notes: notes.filter((x) => x.toBlock <= at), calls };
      }
      return { items, state: frontier, notes, calls };
    },
  };
}
