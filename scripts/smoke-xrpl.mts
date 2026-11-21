/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-xrpl.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// Live READ-ONLY check of the XRP Ledger adapter against mainnet: health + identity, balances, deposit scan, tracking of a
// validated and of an unknown transaction, and prepare() for funded public addresses (proves that the two sources agree).
// Nothing is signed with a real key and nothing is broadcast.
// Run: SPW_ORIGIN=https://smoke.invalid SPW_RP_ID=smoke.invalid DATABASE_URL=postgres://unused SPW_SIGNER_SECRET=unused npx tsx scripts/smoke-xrpl.mts
// (the API config module insists on those variables; none of them is used here)
import { encodeAccountID } from 'xrpl';
import { NETWORKS, formatUnits, pluginFor } from '@spw/core';
import { adapters } from '../services/api/src/chains/index.ts';

const n = NETWORKS.xrpl, a = adapters.xrpl!;
const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'; // the ledger's genesis account (requires a destination tag, master key disabled)
const TEST_MNEMONIC_ADDR = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3'; // m/44'/144'/0'/0/0 of the public test mnemonic (exists on-ledger, master key disabled)
const UNFUNDED = encodeAccountID(new Uint8Array(20).fill(0x5a)); // an account id nobody holds a key for: does not exist on-ledger
// well-known exchange accounts (funded, master key enabled, destination tag required)
const EXCHANGES = ['rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv', 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh'];
const xrp = (v: bigint) => formatUnits(v, 6);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const step = async (name: string, f: () => Promise<unknown>) => {
  try { const r = await f(); console.log(name.padEnd(36), typeof r === 'string' ? r : json(r)); }
  catch (e) { console.log(name.padEnd(36), 'REFUSED', (e as { code?: string }).code ?? '', '-', (e as Error).message); }
};

console.log('sources', n.rpc.join(' , '), '| chainRef', n.chainRef);
const h = await a.health();
console.log('health', json(h));
if (!h.ok || !h.identityVerified) { console.log('FAIL: health'); process.exit(1); }

const post = async (u: string, method: string, p: object) => ((await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [p] }) })).json()) as { result: any }).result;
const state = await Promise.all(n.rpc.map((u) => post(u, 'server_state', {})));
console.log('reserves (drops)', state.map((s) => `${s.state.validated_ledger.reserve_base} base + ${s.state.validated_ledger.reserve_inc}/object, network_id=${s.state.network_id}, build=${s.state.build_version}`).join(' | '), '| activation in registry:', n.activation, 'XRP');

for (const addr of [GENESIS, TEST_MNEMONIC_ADDR, UNFUNDED]) await step(`balance ${addr}`, async () => xrp((await a.balances(addr)).native!) + ' XRP');

const first = await a.deposits(TEST_MNEMONIC_ADDR, null);
console.log('deposits (first scan)'.padEnd(36), `${first.items.length} incoming XRP payments in the latest page, cursor=${first.cursor}, finalized=${first.finalizedHeight}` +
  (first.items[0] ? `; latest: ${xrp(first.items[0].amount)} XRP from ${first.items[0].from} in ledger ${first.items[0].block} (${first.items[0].txid})` : ''));
const older = await a.deposits(TEST_MNEMONIC_ADDR, first.cursor - 300_000);
console.log('deposits (incremental)'.padEnd(36), `${older.items.length} since ledger ${first.cursor - 300_000}, cursor=${older.cursor}` + older.items.map((d) => `; ${xrp(d.amount)} XRP from ${d.from} in ledger ${d.block} (${d.txid})`).join(''));

// tracking: a validated transaction found through the deposit scan, then a hash that does not exist
const dep = first.items[0] ?? older.items[0];
if (dep) await step('track validated tx', () => a.track({ txid: dep.txid, intent: { x: { lastLedgerSequence: String(dep.block + 3) } }, blockRef: null, broadcastAt: 0 }));
const tip = h.height!;
await step('track unknown tx (window open)', () => a.track({ txid: 'AB'.repeat(32), intent: { x: { lastLedgerSequence: String(tip + 15) } }, blockRef: null, broadcastAt: 0 }));
await step('track unknown tx (window passed)', () => a.track({ txid: 'AB'.repeat(32), intent: { x: { lastLedgerSequence: String(tip - 50) } }, blockRef: null, broadcastAt: 0 }));

// prepare(): refusals that need both sources to agree on the accounts first
await step('prepare test-mnemonic → genesis', () => a.prepare({ asset: 'native', from: TEST_MNEMONIC_ADDR, to: GENESIS, amount: 1_000_000n, memo: '1' }));
await step('prepare from unfunded account', () => a.prepare({ asset: 'native', from: UNFUNDED, to: GENESIS, amount: 1_000_000n, memo: '1' }));

// Full path for funded public accounts whose master key is enabled (exchange accounts, then senders of recent payments):
// two-source agreement, reserves, fee, open-ledger sequence, simulate; returns the section of the intent.
const senders = [...new Set([...EXCHANGES, ...[...first.items, ...older.items].map((d) => d.from)])].slice(0, 8);
let done = 0;
for (const from of senders) {
  if (done >= 1) break;
  try {
    const p = await a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: 1_000_000n });
    console.log(`prepare ${from} → ${TEST_MNEMONIC_ADDR} (1 XRP): OK`, json(p));
    // the plugin accepts exactly this section (unsigned build only; no key involved)
    const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: 1, expiresAt: 2, policyVersion: 4, network: n.id, chainRef: n.chainRef,
      asset: 'native', symbol: 'XRP', decimals: 6, amount: '1000000', from, to: TEST_MNEMONIC_ADDR, maxFee: p.maxFee.toString(), ...(p.section as { x: Record<string, string> }) };
    console.log('plugin.build on that section:', json(pluginFor(n).build(intent, n).describe));
    await step('prepare same → genesis, no tag', () => a.prepare({ asset: 'native', from, to: GENESIS, amount: 1_000_000n }));
    await step('prepare same → genesis, tag 7', () => a.prepare({ asset: 'native', from, to: GENESIS, amount: 1_000_000n, memo: '7' }));
    await step('prepare same → new account, 1', () => a.prepare({ asset: 'native', from, to: UNFUNDED, amount: 1_000_000n }));
    await step('prepare same → new account, 0.5', () => a.prepare({ asset: 'native', from, to: UNFUNDED, amount: 500_000n }));
    await step('prepare same, more than balance', () => a.prepare({ asset: 'native', from, to: TEST_MNEMONIC_ADDR, amount: 90_000_000_000_000_000n }));
    done += 1;
  } catch (e) { console.log(`prepare ${from} → …: REFUSED ${(e as { code?: string }).code ?? ''} - ${(e as Error).message}`); }
}
console.log(done ? 'SMOKE OK' : 'SMOKE INCOMPLETE: no candidate account passed prepare()');
process.exit(done ? 0 : 1);
