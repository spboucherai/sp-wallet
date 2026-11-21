/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-tron.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Live READ-ONLY check of the TRON integration against mainnet. Nothing is signed with a real key, nothing is broadcast.
//   npx tsx scripts/smoke-tron.mts
// 1. health + identity (genesis block id) on both sources, 2. balances of a well-known funded address,
// 3. prepare() for TRX and USDT transfers from that address (two-source agreement, activation and energy accounting),
// 4. byte-equality: our encoder vs what each full node builds itself (/wallet/createtransaction, /wallet/triggersmartcontract),
// 5. tracking and deposit scan on irreversible data. Exits 1 on any mismatch.
import { buildTronTx, formatUnits, NETWORKS, tronAddressBytes, type Intent } from '@spw/core';

// the API config module wants its environment; this script uses none of it (no database, no signer, no broadcast)
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'http://localhost', SPW_RP_ID: 'localhost', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'unused', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' })) process.env[k] ??= v;
const { tronAdapter } = await import('../services/api/src/chains/tron.ts');

const n = NETWORKS.tron, a = tronAdapter(n);
const USDT = n.tokens[0]!;
const FUNDED = process.env.TRON_ADDR ?? 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi'; // long-lived public exchange wallet holding TRX and USDT
const EXISTING = 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs'; // Tether treasury: activated account
const NEVER_USED = 'TQGfKPHs3AwiBT44ibkCU64u1G4ttojUXU'; // valid address with no account on-chain (checked below)
const KNOWN_TX = '9dc1c48fc17d0bb3ff8942095b24d3a2d4f147e0debc779d0372126d4d00d1b3'; // irreversible TRX transfer to FUNDED (block 87880468)
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) failures += 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trx = (v: bigint) => `${formatUnits(v, 6)} TRX`;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function node(url: string, path: string, body: unknown): Promise<any> {
  for (let k = 0; ; k++) {
    await sleep(/trongrid/.test(url) ? 450 : 60);
    const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (r.status === 429 && k < 3) { await sleep(5500); continue; }
    if (!r.ok) throw new Error(`${url}${path}: http ${r.status}`);
    return r.json();
  }
}

// ---- 1. health / identity
const h = await a.health();
check(h.ok && h.identityVerified, 'health: both sources up, genesis block id verified', `height=${h.height} ${h.endpoints.map((e) => `${e.url}:${e.ok ? e.ms + 'ms' : 'DOWN'}`).join(' ')}`);
for (const url of n.rpc) {
  const g = await node(url, '/wallet/getblockbynum', { num: 0 });
  check(g.blockID === n.chainRef, `genesis on ${new URL(url).host}`, g.blockID);
}
check((a.disabledAssets?.() ?? []).length === 0, 'USDT contract reports decimals=6 symbol=USDT on-chain (token not disabled)');

// ---- 2. balances
const bal = await a.balances(FUNDED);
check((bal.native ?? 0n) > 0n && (bal[USDT.id] ?? 0n) > 0n, `balances of ${FUNDED}`, `${trx(bal.native ?? 0n)}, ${formatUnits(bal[USDT.id] ?? 0n, 6)} USDT`);
const fresh = await a.balances(NEVER_USED);
check(fresh.native === 0n && fresh[USDT.id] === 0n, `balances of a never-used address are zero (${NEVER_USED})`);

// ---- 3 + 4. prepare() and byte-equality against the nodes
const now = () => Math.floor(Date.now() / 1000);
const intentOf = (asset: string, to: string, amount: bigint, x: Record<string, string>, maxFee: bigint): Intent => ({
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'smoke-test-only', network: n.id, chainRef: n.chainRef, asset,
  symbol: asset === 'native' ? 'TRX' : USDT.symbol, decimals: 6, amount: amount.toString(), from: FUNDED, to, maxFee: maxFee.toString(),
  createdAt: now(), expiresAt: now() + 120, policyVersion: 0, x });

async function scenario(label: string, asset: string, to: string, amount: bigint): Promise<void> {
  console.log(`\n-- ${label}`);
  const p = await a.prepare({ asset, from: FUNDED, to, amount });
  const x = (p.section as { x: Record<string, string> }).x;
  console.log(`   prepare: x=${JSON.stringify(x)} feeEstimate=${trx(p.feeEstimate)} maxFee=${trx(p.maxFee)} warnings=[${p.warnings.join(',')}] ttl=${p.ttlSec}s`);
  // the prepared intent goes through the same builder the signer uses
  const mine = buildTronTx(intentOf(asset, to, amount, x, p.maxFee), n);
  check(mine.worstFee <= p.maxFee, 'prepared intent builds; fee within the approved ceiling', `txid=${hex(mine.txid)} bandwidth=${mine.bandwidthBytes} bytes fee_limit=${trx(mine.feeLimit)}`);
  // the reference block chosen by prepare() really is that block on both nodes
  for (const url of n.rpc) {
    const sh = await node(url, '/walletsolidity/getnowblock', {});
    const num = Number(sh.block_header.raw_data.number);
    const cand = [num, num - 1, num - 2, num - 3, num - 4, num - 5, num - 6, num - 7, num - 8].find((k) => (k & 0xffff) === parseInt(x.ref_block_bytes!, 16));
    const b = cand === undefined ? null : await node(url, '/wallet/getblockbynum', { num: cand });
    check(!!b && b.blockID.slice(16, 32) === x.ref_block_hash, `reference block is irreversible and identical on ${new URL(url).host}`, b ? `#${cand} ${b.blockID}` : 'not found in the last irreversible blocks');
  }
  // what the node builds for the same transfer (it picks its own reference block and timestamps: feed those to our encoder)
  for (const url of n.rpc) {
    const host = new URL(url).host;
    const r = asset === 'native'
      ? await node(url, '/wallet/createtransaction', { owner_address: FUNDED, to_address: to, amount: Number(amount), visible: true })
      : (await node(url, '/wallet/triggersmartcontract', { owner_address: FUNDED, contract_address: asset, function_selector: 'transfer(address,uint256)',
        parameter: hex(tronAddressBytes(to).subarray(1)).padStart(64, '0') + amount.toString(16).padStart(64, '0'), fee_limit: Number(x.fee_limit), call_value: 0, visible: true })).transaction;
    if (!r?.raw_data_hex) { check(false, `${host} built the transaction`, JSON.stringify(r).slice(0, 200)); continue; }
    const rd = r.raw_data;
    const nx: Record<string, string> = { ref_block_bytes: rd.ref_block_bytes, ref_block_hash: rd.ref_block_hash, expiration: String(rd.expiration), timestamp: String(rd.timestamp),
      ...(asset === 'native' ? {} : { fee_limit: String(rd.fee_limit) }) };
    const ours = buildTronTx(intentOf(asset, to, amount, nx, p.maxFee), n);
    check(hex(ours.rawData) === r.raw_data_hex && hex(ours.txid) === r.txID, `byte-identical to ${host} ${asset === 'native' ? '/wallet/createtransaction' : '/wallet/triggersmartcontract'}`,
      `txID=${r.txID} (${r.raw_data_hex.length / 2} bytes of raw_data)`);
    if (hex(ours.rawData) !== r.raw_data_hex) console.log(`   node: ${r.raw_data_hex}\n   ours: ${hex(ours.rawData)}`);
  }
}
await scenario('TRX 1.5 -> activated account', 'native', EXISTING, 1_500_000n);
await scenario('TRX 2 -> never-used address (activation)', 'native', NEVER_USED, 2_000_000n);
await scenario('USDT 3.25 -> account that already holds USDT', USDT.id, EXISTING, 3_250_000n);
await scenario('USDT 1 -> never-used address (first-time holder: more energy)', USDT.id, NEVER_USED, 1_000_000n);

// ---- prepare() refusals (read-only)
console.log('\n-- refusals');
const refuses = async (label: string, f: () => Promise<unknown>, re: RegExp) => { try { await f(); check(false, label, 'was accepted'); } catch (e) { check(re.test((e as Error).message), label, (e as Error).message.slice(0, 110)); } };
await refuses('amount above the TRX balance', () => a.prepare({ asset: 'native', from: FUNDED, to: EXISTING, amount: (bal.native ?? 0n) + 1n }), /insufficient/);
await refuses('amount above the USDT balance', () => a.prepare({ asset: USDT.id, from: FUNDED, to: EXISTING, amount: (bal[USDT.id] ?? 0n) + 1n }), /insufficient/);
await refuses('USDT from an account with no USDT and no TRX', () => a.prepare({ asset: USDT.id, from: NEVER_USED, to: EXISTING, amount: 1n }), /insufficient/);
await refuses('TRX from an account that does not exist', () => a.prepare({ asset: 'native', from: NEVER_USED, to: EXISTING, amount: 1n }), /insufficient/);
await refuses('destination = USDT contract', () => a.prepare({ asset: 'native', from: FUNDED, to: USDT.id, amount: 1n }), /token contract/);

// ---- 5. tracking + deposits (irreversible data only)
console.log('\n-- tracking / deposits');
const t1 = await a.track({ txid: KNOWN_TX, intent: { x: { expiration: '1794315258000' } }, blockRef: null, broadcastAt: 0 });
check(t1.state === 'finalized' && t1.blockRef === '87880468', 'track: known irreversible transfer is finalized', JSON.stringify(t1));
const ghost = 'f'.repeat(64);
const t2 = await a.track({ txid: ghost, intent: { x: { expiration: String(Date.now() - 3_600_000) } }, blockRef: null, broadcastAt: 0 });
check(t2.state === 'failed' && /expired/.test(t2.error ?? ''), 'track: unknown txid past its expiration (both sources agree) is failed/expired', JSON.stringify(t2));
const t3 = await a.track({ txid: ghost, intent: { x: { expiration: String(Date.now() + 200_000) } }, blockRef: null, broadcastAt: 0 });
check(t3.state === 'broadcast' && t3.rebroadcast === true, 'track: unknown txid before its expiration stays "broadcast" (a hash is never success)', JSON.stringify(t3));
const dep = await a.deposits(FUNDED, null);
const kinds = dep.items.reduce((m, d) => { const k = d.asset === 'native' ? 'TRX' : 'USDT'; m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>);
check(dep.items.length > 0 && dep.finalizedHeight > 87_000_000, 'deposits: incoming TRX / USDT transfers re-verified on irreversible node data', `${JSON.stringify(kinds)} cursor=${dep.cursor} solidified=${dep.finalizedHeight}`);
for (const d of dep.items.slice(-3)) console.log(`   ${d.asset === 'native' ? 'TRX ' : 'USDT'} ${formatUnits(d.amount, 6).padStart(14)} from ${d.from} block ${d.block} ${d.txid}`);
const dep2 = await a.deposits(FUNDED, dep.cursor);
check(dep2.cursor >= dep.cursor && dep2.items.every((d) => !dep.items.some((o) => o.txid === d.txid && o.idx === d.idx)), 'deposits: scanning again from the cursor returns nothing already seen', `new=${dep2.items.length}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — read-only, nothing signed with a real key, nothing broadcast`);
process.exit(failures === 0 ? 0 : 1);
