// Live READ-ONLY check of the Cosmos Hub adapter against mainnet: health + identity, balances, deposit scan, tracking of a
// committed and of an unknown transaction, and prepare() for funded public addresses (proves that the two sources agree at
// one block and that the chain's own simulation accepts the transfer). Nothing is signed with a real key and nothing is broadcast.
// Run: SPW_ORIGIN=https://smoke.invalid SPW_RP_ID=smoke.invalid DATABASE_URL=postgres://unused SPW_SIGNER_SECRET=unused npx tsx scripts/smoke-cosmos.mts
// (the API config module insists on those variables; none of them is used here)
import { NETWORKS, cosmosAddressFromPublicKey, formatUnits, pluginFor } from '@spw/core';
import { adapters } from '../services/api/src/chains/index.ts';

const n = NETWORKS.cosmos, a = adapters.cosmos!;
const TEST_MNEMONIC_ADDR = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4'; // m/44'/118'/0'/0/0 of the public test mnemonic (exists on chain, holds dust)
const FEE_COLLECTOR = 'cosmos13pxn9n3qw79e03844rdadagmg0nshmwf7qvuye'; // module account "feemarket-fee-collector"
const UNFUNDED = cosmosAddressFromPublicKey('cosmos', Uint8Array.from([2, ...new Uint8Array(31), 1])); // address of the curve point with x = 1: on chain nowhere, and nobody knows its private key
const atom = (v: bigint) => formatUnits(v, 6);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const step = async (name: string, f: () => Promise<unknown>) => {
  try { const r = await f(); console.log(name.padEnd(40), typeof r === 'string' ? r : json(r)); }
  catch (e) { console.log(name.padEnd(40), 'REFUSED', (e as { code?: string }).code ?? '', '-', (e as Error).message); }
};
const get = async (u: string, path: string) => (await (await fetch(u + path, { signal: AbortSignal.timeout(15000) })).json()) as any;

console.log('sources', n.rpc.join(' , '), '| chainRef', n.chainRef);
const h = await a.health();
console.log('health', json(h));
if (!h.ok || !h.identityVerified) { console.log('FAIL: health'); process.exit(1); }

for (const u of n.rpc) {
  const [info, price, cfg] = await Promise.all([get(u, '/cosmos/base/tendermint/v1beta1/node_info'), get(u, '/feemarket/v1/gas_price/uatom'), get(u, '/cosmos/base/node/v1beta1/config')]);
  console.log(`node ${new URL(u).host}: network=${info.default_node_info.network} app=${info.application_version.name} ${info.application_version.version} sdk=${info.application_version.cosmos_sdk_version}` +
    ` | feemarket gas price=${price.price.amount}${price.price.denom} | node minimum=${cfg.minimum_gas_price}`);
}

for (const addr of [TEST_MNEMONIC_ADDR, FEE_COLLECTOR, UNFUNDED]) await step(`balance ${addr}`, async () => atom((await a.balances(addr)).native!) + ' ATOM');

// recent plain sends, to find funded public accounts and a committed transaction (read block by block from a source)
const sends: { from: string; to: string; amount: string; height: number }[] = [];
for (let hgt = h.height! - 1; hgt > h.height! - 40 && sends.length < 12; hgt--) {
  let txs: any[] = [];
  for (const u of n.rpc) { try { txs = (await get(u, `/cosmos/tx/v1beta1/txs/block/${hgt}`)).txs ?? []; break; } catch { /* next source */ } }
  for (const t of txs) {
    const m = t.body.messages;
    if (m.length === 1 && m[0]['@type'] === '/cosmos.bank.v1beta1.MsgSend' && m[0].amount.length === 1 && m[0].amount[0].denom === 'uatom') sends.push({ from: m[0].from_address, to: m[0].to_address, amount: m[0].amount[0].amount, height: hgt });
  }
}
console.log(`plain ATOM sends in the last blocks: ${sends.length}`);
const sample = sends[0];
if (!sample) { console.log('SMOKE INCOMPLETE: no recent send found'); process.exit(1); }
const recipient = sample.to;

const first = await a.deposits(recipient, null);
console.log('deposits (first scan)'.padEnd(40), `${first.items.length} incoming ATOM transfers to ${recipient} in the latest page, cursor=${first.cursor}, finalized=${first.finalizedHeight}` +
  (first.items[0] ? `; latest: ${atom(first.items[0].amount)} ATOM from ${first.items[0].from} in block ${first.items[0].block} (${first.items[0].txid}, event ${first.items[0].idx})` : ''));
const found = first.items.find((d) => d.block === sample.height && d.from === sample.from);
console.log('deposit scan finds the sampled send'.padEnd(40), found ? `yes: ${atom(found.amount)} ATOM (the block says ${sample.amount} uatom)` : 'NO');
const inc = await a.deposits(recipient, sample.height - 1);
console.log('deposits (incremental)'.padEnd(40), `${inc.items.length} since block ${sample.height - 1}, cursor=${inc.cursor}`);
const none = await a.deposits(recipient, first.cursor);
console.log('deposits (nothing new)'.padEnd(40), `${none.items.length} since block ${first.cursor}`);
await step('deposits of the test-mnemonic address', async () => `${(await a.deposits(TEST_MNEMONIC_ADDR, null)).items.length} (its history is older than the nodes' index)`);

// tracking
const tip = h.height!;
if (found) await step(`track committed tx ${found.txid.slice(0, 12)}…`, () => a.track({ txid: found.txid, intent: { from: sample.from, x: { sequence: '0', timeout_height: String(sample.height + 5) } }, blockRef: null, broadcastAt: 0 }));
await step('track unknown tx (window open)', () => a.track({ txid: 'AB'.repeat(32), intent: { from: TEST_MNEMONIC_ADDR, x: { sequence: '7', timeout_height: String(tip + 15) } }, blockRef: null, broadcastAt: 0 }));
await step('track unknown tx (expired, seq unused)', async () => {
  const seqNow = (await get(n.rpc[0]!, `/cosmos/auth/v1beta1/accounts/${TEST_MNEMONIC_ADDR}`)).account.sequence as string;
  return a.track({ txid: 'AB'.repeat(32), intent: { from: TEST_MNEMONIC_ADDR, x: { sequence: seqNow, timeout_height: String(tip - 50) } }, blockRef: null, broadcastAt: 0 });
});
await step('track unknown tx (expired, seq used)', () => a.track({ txid: 'AB'.repeat(32), intent: { from: TEST_MNEMONIC_ADDR, x: { sequence: '1', timeout_height: String(tip - 50) } }, blockRef: null, broadcastAt: 0 }));

// prepare(): refusals that need both sources to agree on the accounts first
await step('prepare test-mnemonic → recipient 1 ATOM', () => a.prepare({ asset: 'native', from: TEST_MNEMONIC_ADDR, to: recipient, amount: 1_000_000n }));
await step('prepare from account not on chain', () => a.prepare({ asset: 'native', from: UNFUNDED, to: recipient, amount: 1_000_000n }));
await step('prepare with an IBC denom', () => a.prepare({ asset: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', from: TEST_MNEMONIC_ADDR, to: recipient, amount: 1n }));

// Full path for funded public accounts (senders of recent sends): two-source agreement at one block, fee market price,
// simulation on both sources; returns the section of the intent.
const senders = [...new Set(sends.map((t) => t.from))].slice(0, 8);
let done = 0;
for (const from of senders) {
  if (done >= 1) break;
  try {
    const bal = (await a.balances(from)).native!;
    const p = await a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: 1000n, memo: 'smoke 104588310' });
    console.log(`prepare ${from} (${atom(bal)} ATOM) → ${TEST_MNEMONIC_ADDR} (0.001 ATOM, memo): OK`, json(p));
    // the plugin accepts exactly this section (unsigned build only; no key involved)
    const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: 1, expiresAt: 2, policyVersion: 3, network: n.id, chainRef: n.chainRef,
      asset: 'native', symbol: 'ATOM', decimals: 6, amount: '1000', from, to: TEST_MNEMONIC_ADDR, maxFee: p.maxFee.toString(), memo: 'smoke 104588310', ...(p.section as { x: Record<string, string> }) };
    console.log('plugin.build on that section:', json(pluginFor(n).build(intent, n).describe));
    console.log(`timeout_height − tip = ${Number(intent.x.timeout_height) - tip} blocks; fee ${atom(p.maxFee)} ATOM for gas_limit ${intent.x.gas_limit}`);
    await step('prepare same, no memo', () => a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: 1000n }));
    await step('prepare same → account not on chain', () => a.prepare({ asset: 'native', from, to: UNFUNDED, amount: 1000n }));
    await step('prepare same → module account', () => a.prepare({ asset: 'native', from, to: FEE_COLLECTOR, amount: 1000n }));
    await step('prepare same, more than balance', () => a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: bal + 1n }));
    await step('prepare same, balance minus 1 uatom', () => a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: bal - 1n }));
    await step('prepare same, memo with a trailing space', () => a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: 1000n, memo: '104588310 ' }));
    done += 1;
  } catch (e) { console.log(`prepare ${from} → …: REFUSED ${(e as { code?: string }).code ?? ''} - ${(e as Error).message}`); }
}
console.log(done ? 'SMOKE OK' : 'SMOKE INCOMPLETE: no candidate account passed prepare()');
process.exit(done ? 0 : 1);
