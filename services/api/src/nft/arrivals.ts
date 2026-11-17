// NFT delivery 2 — arrival detection of RECEIVED EVM NFTs without an indexer: a per-contract log scan.
//
// Public endpoints refuse wallet-wide log queries (NFT-SOURCES.md §4.1) but accept a query on ONE contract over a short block
// range. So, for the contracts the wallet already knows (an NFT it holds or tracks there), the logs `Transfer(…, to = wallet, …)`
// (ERC-721) and `TransferSingle / TransferBatch(…, to = wallet, …)` (ERC-1155) are read from a persisted cursor up to the
// chain's FINALIZED block — an arrival is therefore never shown before the chain's finality — in bounded steps. Every token id
// found is then looked up on-chain (ownerOf / balanceOf on every endpoint): only what the chain confirms as held enters the
// inventory. Limits, stated: a contract the wallet has never seen is not scanned (add one of its tokens by hand once); after a
// long stop the scan resumes from the recent window only and says so (`gap`).
import { decodeAbiParameters, pad } from 'viem';
import { getNetwork } from '@spw/core';
import type { RpcFn } from './provider.ts';
import { TOPIC_BATCH, TOPIC_SINGLE, TOPIC_TRANSFER } from './evm.ts';

export const ARRIVAL_SPAN = 1000, ARRIVAL_STEPS = 4;
export interface ArrivalCursor { cursor: number; gap: boolean }
export interface ArrivalHit { contract: string; tokenId: string; tx: string; logIndex: string; block: string; blockHash: string; from: string | null; quantity: string }
type Log = { topics: `0x${string}`[]; data: `0x${string}`; blockNumber: `0x${string}`; blockHash: `0x${string}`; transactionHash: `0x${string}`; logIndex: `0x${string}`; removed?: boolean };

/** One bounded scan of one contract. Returns the hits and the cursor to store; throws when no endpoint accepts the query. */
export async function scanContractArrivals(rpc: RpcFn, chain: string, contract: string, wallet: string, from: ArrivalCursor | null): Promise<{ hits: ArrivalHit[]; next: ArrivalCursor; finalized: number }> {
  const n = getNetwork(chain);
  const first = async <T>(method: string, params: unknown[]): Promise<T> => { let last: unknown = new Error('no endpoint'); for (const u of n.rpc) { try { return (await rpc(u, method, params)) as T; } catch (e) { last = e; } } throw last; };
  let fin: number;
  try { const b = await first<{ number: `0x${string}` } | null>('eth_getBlockByNumber', ['finalized', false]); if (!b) throw new Error('no finalized block'); fin = Number(BigInt(b.number)); }
  catch { fin = Number(BigInt(await first<`0x${string}`>('eth_blockNumber', []))) - n.minConf; }
  let start = from ? from.cursor + 1 : fin - ARRIVAL_SPAN + 1, gap = from?.gap ?? false;
  if (fin - start + 1 > ARRIVAL_SPAN * ARRIVAL_STEPS) { start = fin - ARRIVAL_SPAN * ARRIVAL_STEPS + 1; gap = true; } // blocks before are not scanned: said, not hidden
  if (start < 0) start = 0;
  const to = pad(wallet as `0x${string}`).toLowerCase(), hits: ArrivalHit[] = [];
  let done = start - 1;
  for (let a = start; a <= fin; a += ARRIVAL_SPAN) {
    const b = Math.min(fin, a + ARRIVAL_SPAN - 1), range = { address: contract, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` };
    const [l721, l1155] = await Promise.all([first<Log[]>('eth_getLogs', [{ ...range, topics: [TOPIC_TRANSFER, null, to] }]), first<Log[]>('eth_getLogs', [{ ...range, topics: [[TOPIC_SINGLE, TOPIC_BATCH], null, null, to] }])]);
    for (const l of [...l721, ...l1155]) {
      if (l.removed) continue;
      const base = { contract, tx: l.transactionHash, logIndex: BigInt(l.logIndex).toString(10), block: BigInt(l.blockNumber).toString(10), blockHash: l.blockHash };
      try {
        if (l.topics[0] === TOPIC_TRANSFER && l.topics.length === 4) hits.push({ ...base, tokenId: BigInt(l.topics[3]!).toString(10), from: `0x${l.topics[1]!.slice(26)}`, quantity: '1' });
        else if (l.topics[0] === TOPIC_SINGLE) { const [id, v] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], l.data); hits.push({ ...base, tokenId: id.toString(10), from: `0x${l.topics[2]!.slice(26)}`, quantity: v.toString(10) }); }
        else if (l.topics[0] === TOPIC_BATCH) { const [ids, vs] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], l.data); ids.forEach((id, k) => hits.push({ ...base, logIndex: `${base.logIndex}.${k}`, tokenId: id.toString(10), from: `0x${l.topics[2]!.slice(26)}`, quantity: (vs[k] ?? 0n).toString(10) })); }
      } catch { /* a log that does not decode as the standard event is not an arrival */ }
    }
    done = b;
  }
  return { hits, next: { cursor: Math.max(done, from?.cursor ?? done), gap }, finalized: fin };
}
