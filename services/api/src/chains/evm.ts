import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, hexToString, multicall3Abi, numberToHex, pad } from 'viem';
import { getAsset, type NetworkDef } from '@spw/core';
import { UserError } from '../config.ts';
import { hostOf, rpcAny, rpcOne, rpcQuorum, type Adapter, type Deposit, type Health, type Prepared, type Tracked } from './rpc.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hx = (n: bigint | number) => numberToHex(n);

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
      let gas: bigint;
      if (asset.id === 'native') {
        if (code !== '0x') throw new UserError('contract_destination', 'native transfers to contract addresses are not supported');
        gas = 21000n;
        if ((balances.native ?? 0n) < d.amount + gas * maxFeePerGas) throw new UserError('insufficient_funds', `insufficient ${n.native.symbol} for amount plus network fee`);
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
        if ((balances.native ?? 0n) < gas * maxFeePerGas) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
      }
      return { section: { evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } },
        maxFee: gas * maxFeePerGas, feeEstimate: gas * (baseFee + tip), warnings, ttlSec: 180 };
    },
    async broadcast(raw) {
      const rs = await Promise.allSettled(n.rpc.map((u) => rpcOne<string>(u, 'eth_sendRawTransaction', [raw])));
      if (rs.some((r) => r.status === 'fulfilled')) return;
      const msg = String((rs[0] as PromiseRejectedResult).reason?.message ?? 'broadcast failed');
      if (/already known|already imported|ALREADY_EXISTS/i.test(msg)) return;
      throw new Error(msg);
    },
    async track(p): Promise<Tracked> {
      const rc = await call<{ status: `0x${string}`; blockNumber: `0x${string}`; blockHash: string } | null>('eth_getTransactionReceipt', [p.txid]).catch((e) => { if ((e as { rpcCode?: number }).rpcCode !== undefined) return null; throw e; });
      if (!rc) {
        if (p.blockRef) return { state: 'reorged', confirmations: 0, rebroadcast: true };
        const latest = hexToNumber(await call<`0x${string}`>('eth_getTransactionCount', [p.intent.from, 'latest']));
        if (latest > p.intent.evm.nonce && Date.now() / 1000 - p.broadcastAt > 90) return { state: 'replaced', confirmations: 0, error: 'nonce was consumed by another transaction' };
        return { state: 'broadcast', confirmations: 0, rebroadcast: true };
      }
      if (hexToNumber(rc.status) !== 1) return { state: 'failed', confirmations: 0, blockRef: rc.blockHash, error: 'transaction reverted on-chain' };
      const bn = hexToNumber(rc.blockNumber), head = hexToNumber(await call<`0x${string}`>('eth_blockNumber', []));
      const fin = await finalizedHeight();
      return { state: bn <= fin ? 'finalized' : 'confirming', confirmations: Math.max(1, head - bn + 1), blockRef: rc.blockHash };
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
