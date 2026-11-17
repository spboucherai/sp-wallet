// NFT delivery 1 — measurement behind docs/nft/NFT-SOURCES.md §EVM: can the wallet's own public RPC endpoints answer the
// "wallet-shaped" discovery query — every ERC-721 `Transfer` whose recipient is ONE address, over a block range, with NO contract
// address in the filter? Read-only (eth_blockNumber + eth_getLogs); the address is a public one passed as argument (default:
// a well-known public address), never the wallet's. Prints one line per endpoint and range; nothing is stored.
// Run: npx tsx scripts/nft-measure-evm-logs.mts [0xaddress]
import { NETWORKS, type NetworkDef } from '@spw/core';
import { keccak256, pad, toHex } from 'viem';

const who = (process.argv[2] ?? '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045') as `0x${string}`;
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const to = pad(who.toLowerCase() as `0x${string}`, { size: 32 });
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
async function rpc(url: string, method: string, params: unknown[]): Promise<{ status: number; body: string; ms: number }> {
  const t = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: (await r.text()).slice(0, 4_000_000), ms: Date.now() - t };
  } catch (e) { return { status: 0, body: String((e as Error).message).slice(0, 120), ms: Date.now() - t }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const n of (Object.values(NETWORKS) as NetworkDef[]).filter((x) => x.family === 'evm')) {
  for (const url of n.rpc) {
    const h = await rpc(url, 'eth_blockNumber', []);
    let head: number;
    try { head = Number(BigInt((JSON.parse(h.body) as { result: string }).result)); } catch { console.log(`${n.id} ${url} head: http ${h.status} ${h.body.slice(0, 100)}`); continue; }
    for (const [label, filter] of [['no-address', {}], ['with-address', { address: BAYC }]] as const) {
      for (const span of [100, 1000, 10_000, 50_000, 500_000]) {
        await sleep(1500);
        const r = await rpc(url, 'eth_getLogs', [{ fromBlock: toHex(head - span), toBlock: toHex(head), topics: [TRANSFER, null, to], ...filter }]);
        let out: string;
        try { const j = JSON.parse(r.body) as { result?: unknown[]; error?: { code: number; message: string } }; out = j.result ? `ok logs=${j.result.length}` : `error ${j.error?.code} ${j.error?.message.slice(0, 110)}`; } catch { out = `http ${r.status} ${r.body.slice(0, 80).replace(/\s+/g, ' ')}`; }
        console.log(`${n.id} ${new URL(url).host} ${label} span=${span} → ${out} (${r.ms} ms)`);
        if (!out.startsWith('ok')) break;
      }
    }
  }
}
