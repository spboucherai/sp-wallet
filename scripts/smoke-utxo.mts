/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-utxo.mts
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

// Live, read-only check of the Dogecoin and Bitcoin Cash adapters against mainnet. Nothing is signed and nothing is broadcast.
//   npx tsx scripts/smoke-utxo.mts            (ONLY=dogecoin or ONLY=bitcoincash to run one)
// For each network: both indexers' tip and chain-identity block, health, the balance of a funded public address read from each
// indexer, a prepare() run (the two indexers must return the same spendable coins) and a rebuild of the unsigned transaction
// from the resulting intent — for Dogecoin this verifies the previous transactions fetched live against the approved inputs.
process.env.SPW_ORIGIN ??= 'https://wallet.invalid';
process.env.SPW_RP_ID ??= 'wallet.invalid';
process.env.DATABASE_URL ??= 'postgres://unused';
process.env.SPW_SIGNER_SECRET ??= 'unused-unused-unused-unused-unused-unused-unused';
const { buildBtcTx, formatUnits, IntentSchema, NETWORKS, pluginFor } = await import('@spw/core');
const { adapters } = await import('../services/api/src/chains/index.ts');
const { sourceOf } = await import('../services/api/src/chains/btc.ts');

// Funded third-party addresses found on-chain (a single old unspent output each); `to` is the public test-mnemonic address.
const CASES: Record<string, { from: string; to: string; amount: bigint }> = {
  dogecoin: { from: 'DMhCxuxFe98xQhic6QEFdw7gWBCy6u9jMS', to: 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', amount: 1_000_000_000n },
  bitcoincash: { from: 'bitcoincash:qzeer89eku4hkh3w7mrzra8ppwty27jq6vdpg7tpa0', to: 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6', amount: 100_000n },
};
let failed = false;
for (const [id, c] of Object.entries(CASES)) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(id)) continue;
  const n = NETWORKS[id];
  if (!n) { console.log(`${id}: NOT REGISTERED`); failed = true; continue; }
  const a = adapters[id]!, unit = (v: bigint) => `${formatUnits(v, n.native.decimals)} ${n.native.symbol}`;
  console.log(`\n== ${n.name} (${id}, family ${n.family}, coin type ${n.coinType})`);
  try {
    const refHeight = n.utxo?.refHeight ?? 0;
    for (const spec of n.rpc) {
      const s = sourceOf(spec), t = Date.now();
      const [tip, ref, bal] = [await s.tip(), await s.blockHash(refHeight), await s.balance(c.from)];
      console.log(`  source ${new URL(s.url).host.padEnd(26)} tip=${tip} block[${refHeight}]=${ref.slice(0, 20)}… ${ref === n.chainRef ? 'identity OK' : 'IDENTITY MISMATCH'} balance(${c.from.slice(-8)})=${unit(bal)} ${Date.now() - t}ms`);
      if (ref !== n.chainRef) failed = true;
    }
    const h = await a.health();
    console.log(`  health ok=${h.ok} identityVerified=${h.identityVerified} height=${h.height} endpoints=${h.endpoints.map((e) => `${e.url}:${e.ok ? e.ms + 'ms' : 'DOWN'}`).join(' ')}`);
    if (!h.ok) failed = true;
    console.log(`  balance ${c.from} = ${unit((await a.balances(c.from)).native!)}`);
    const d = await a.deposits(c.from, null);
    console.log(`  deposits ${d.items.length} (first: ${d.items[0] ? `${d.items[0].txid.slice(0, 16)}… ${unit(d.items[0].amount)} block ${d.items[0].block}` : '-'}) finalizedHeight=${d.finalizedHeight}`);
    const p = await a.prepare({ asset: 'native', from: c.from, to: c.to, amount: c.amount });
    const now = Math.floor(Date.now() / 1000);
    const intent = IntentSchema.parse({ v: 1, proposalId: '00000000-0000-4000-8000-000000000000', keyId: 'spw-smoke-read-only', network: id, chainRef: n.chainRef, asset: 'native',
      symbol: n.native.symbol, decimals: n.native.decimals, amount: c.amount.toString(), from: c.from, to: c.to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 0, ...p.section });
    console.log(`  prepare: both sources agree on the spendable coins; send ${unit(c.amount)} fee=${unit(p.feeEstimate)} section=${JSON.stringify(p.section).replace(/([0-9a-f]{12})[0-9a-f]{52}/g, '$1…')}`);
    if (n.family === 'btc') {
      const tx = buildBtcTx(intent, p.aux);
      const prev = Object.entries((p.aux?.prevTx ?? {}) as Record<string, string>);
      console.log(`  rebuild: unsigned transaction ${tx.inputsLength} in / ${tx.outputsLength} out; previous transactions verified against the inputs: ${prev.map(([k, v]) => `${k.slice(0, 12)}… (${v.length / 2} bytes)`).join(', ')}`);
    } else {
      const b = pluginFor(n).build(intent, n, p.aux);
      console.log(`  rebuild: ${b.signDocs.length} signature digest(s); ${JSON.stringify(b.describe)}`);
    }
    const st = await a.track({ txid: 'ff'.repeat(32), intent: null, blockRef: null, broadcastAt: now });
    console.log(`  track(unknown txid) = ${JSON.stringify(st)}`);
  } catch (e) { failed = true; console.log(`  ERR ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`); }
}
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK (read-only; nothing signed, nothing broadcast)');
process.exit(failed ? 1 : 0);
