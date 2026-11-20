import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, hexToString, multicall3Abi, numberToHex, pad, serializeTransaction } from 'viem';
import { getAsset, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, rpcAny, rpcEach, rpcOne, rpcQuorum, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hx = (n: bigint | number) => numberToHex(n);

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
  async function multi(calls: { target: string; data: `0x${string}` }[]): Promise<({ ok: boolean; data: `0x${string}` })[]> {
    const out: { ok: boolean; data: `0x${string}` }[] = [];
    for (let k = 0; k < calls.length; k += 40) {
      const chunk = calls.slice(k, k + 40);
      const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.data }))] });
      const ret = await call<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, 'latest']);
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
      let from = cursor === null ? head - 3000 : cursor + 1;
      if (head - from > 20000) from = head - 20000; // bounded catch-up after long downtime
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
  };
}
