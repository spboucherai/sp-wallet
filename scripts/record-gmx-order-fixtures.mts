/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-gmx-order-fixtures.mts
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

// Records REAL, recent GMX v2 order transactions of other people from Arbitrum One — read only (eth_getLogs,
// eth_getTransactionByHash on the registry's public RPC endpoints) — as fixtures for the encoding tests of
// packages/derivatives/src/live/gmx.ts: the decoder must round-trip them and the events must decode.
//     node scripts/record-gmx-order-fixtures.mts
// Nothing is signed or sent; no key exists here.
import { writeFileSync } from 'node:fs';
import { keccak256, toHex, toEventSelector, toFunctionSelector } from 'viem';
import { NETWORKS } from '@spw/core';
import { GMX_PINS } from '@spw/derivatives/live';

const rpcs = NETWORKS.arbitrum!.rpc;
let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json() as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) { last = e; }
  }
  throw last;
}
const EVENT_LOG2 = toEventSelector('EventLog2(address,string,string,bytes32,bytes32,(((string,address)[],(string,address[])[]),((string,uint256)[],(string,uint256[])[]),((string,int256)[],(string,int256[])[]),((string,bool)[],(string,bool[])[]),((string,bytes32)[],(string,bytes32[])[]),((string,bytes)[],(string,bytes[])[]),((string,string)[],(string,string[])[])))');
const nameHash = (s: string) => keccak256(toHex(s));
const MULTICALL = toFunctionSelector('multicall(bytes[])'), CANCEL = toFunctionSelector('cancelOrder(bytes32)');
interface Log { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string }
interface Tx { hash: string; from: string; to: string | null; input: string; value: string; blockNumber: string }

const head = Number(await rpc<string>('eth_blockNumber', []));
const out: { kind: string; orderType: number | null; tx: Tx; logs: Log[] }[] = [];
const seen = new Set<string>(), perType = new Map<number, number>();
for (const [event, want] of [['OrderCreated', 10], ['OrderCancelled', 2]] as const) {
  let got = 0;
  for (let to = head - 5; to > head - 400_000 && got < want; to -= 2000) {
    const logs = await rpc<Log[]>('eth_getLogs', [{ address: GMX_PINS.eventEmitter.address, topics: [EVENT_LOG2, nameHash(event)], fromBlock: toHex(to - 1999), toBlock: toHex(to) }]);
    for (const l of logs.reverse()) {
      if (got >= want || seen.has(l.transactionHash)) continue;
      const tx = await rpc<Tx>('eth_getTransactionByHash', [l.transactionHash]);
      if (!tx || tx.to?.toLowerCase() !== GMX_PINS.exchangeRouter.address.toLowerCase()) continue; // Classic requests only (relay routers have another calldata)
      const sel = tx.input.slice(0, 10);
      if (event === 'OrderCreated' ? sel !== MULTICALL : sel !== CANCEL) continue;
      // order type = first uint item of the event; found by decoding in the test — here only spread the sample over transactions
      const all = logs.filter((x) => x.transactionHash === l.transactionHash);
      const key = all.length * 100 + (tx.input.length % 7);
      if ((perType.get(key) ?? 0) >= 3 && event === 'OrderCreated') continue;
      perType.set(key, (perType.get(key) ?? 0) + 1);
      seen.add(l.transactionHash); got++;
      out.push({ kind: event, orderType: null, tx: { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value, blockNumber: tx.blockNumber }, logs: all.map((x) => ({ address: x.address, topics: x.topics, data: x.data, transactionHash: x.transactionHash, blockNumber: x.blockNumber, logIndex: x.logIndex })) });
    }
  }
  console.log(`${event}: ${got} transaction(s)`);
}
const file = new URL('../packages/derivatives/test/fixtures/gmx-live/orders.json', import.meta.url);
writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), chainId: 42161, head, exchangeRouter: GMX_PINS.exchangeRouter.address, eventEmitter: GMX_PINS.eventEmitter.address, items: out }, null, 1));
console.log(`wrote ${out.length} item(s) to ${file.pathname}`);
