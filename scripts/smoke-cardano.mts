/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-cardano.mts
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

// Live READ-ONLY check of the Cardano adapter against mainnet, and the proof of the transaction format without funds:
// health + identity, balances, deposit scan, prepare() from a funded PUBLIC address standing in as the wallet (proves the two
// sources agree on its UTxO set), the prepared transaction decoded by the official serialization library (body hash, minimum
// fee for its size, minimum ADA of each output), evaluated by a node through Koios' Ogmios endpoint (the ledger's own decoder
// reads it and resolves its inputs), a transaction signed end to end with a THROWAWAY random key (signature and key hash
// checked by the official library), real mainnet transactions decoded with the plugin's decoder, tracking, refusals.
// Nothing is broadcast; no real key is used.  Run: npx tsx scripts/smoke-cardano.mts
import { randomBytes } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, buildCardanoTx, cardanoBaseAddress, cardanoDecodeTx, cardanoMinAda, cardanoMinFee, cardanoPlugin, cardanoSignedTx, formatUnits, intentHash, toHex } = await import('@spw/core');
const { cardanoAdapter, REVIEWED_PARAMS } = await import('../services/api/src/chains/cardano.ts');
const { derivePath, icarusMasterKey, xprvPublicKey, xprvSign } = await import('../services/isolated-signer/src/bip32-ed25519.ts');
const CSL = (await import('@emurgo/cardano-serialization-lib-nodejs')).default;

const n = NETWORKS.cardano!, a = cardanoAdapter(n), ada = (v: bigint) => `${formatUnits(v, 6)} ADA`;
const [KOIOS] = n.rpc as [string, string];
const post = async (url: string, body: unknown): Promise<any> => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(44), json(await f())); }
  catch (e) { failed++; console.log(name.padEnd(44), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };

// a throwaway wallet: random entropy, CIP-1852 keys, base address (never funded, never reused)
const master = icarusMasterKey(randomBytes(16));
const pay = derivePath(master, "m/1852'/1815'/0'/0/0"), stake = derivePath(master, "m/1852'/1815'/0'/2/0");
const PUB = Uint8Array.from([...xprvPublicKey(pay), ...xprvPublicKey(stake)]);
const THROWAWAY = cardanoBaseAddress(PUB.subarray(0, 32), PUB.subarray(32));
const key = { curve: 'ed25519' as const, publicKey: PUB, signMessage: (m: Uint8Array) => xprvSign(pay, m) };

// a funded public address holding plain ADA (override with CARDANO_FROM; CARDANO_FROM=auto takes one from a recent block,
// which costs many Koios requests and can time out on the public tier)
async function findFunded(): Promise<string> {
  const fixed = process.env.CARDANO_FROM ?? 'addr1q9ne98myjuf362sy94uajpqac37g2uj25xa844t2wh3gmm564mj3j0l8us0uuesp9tvms082vw5ngd6gae8k2s6gts2qxwcqtr';
  if (fixed !== 'auto') return fixed;
  const tip = (await (await fetch(KOIOS + '/tip')).json())[0];
  for (let h = tip.block_no - 20; h > tip.block_no - 60; h--) {
    const [b] = await (await fetch(`${KOIOS}/blocks?block_height=eq.${h}&select=hash`)).json();
    const hashes = (await post(KOIOS + '/block_txs', { _block_hashes: [b.hash] })).body.map((x: any) => x.tx_hash).slice(0, 20);
    if (!hashes.length) continue;
    const infos = (await post(KOIOS + '/tx_info', { _tx_hashes: hashes, _inputs: false, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false })).body;
    for (const t of infos) for (const o of t.outputs) {
      const addr = o.payment_addr?.bech32;
      if (!/^addr1q/.test(addr ?? '') || o.asset_list.length || BigInt(o.value) < 20_000_000n || BigInt(o.value) > 5_000_000_000n) continue;
      const u = (await post(KOIOS + '/address_utxos', { _addresses: [addr], _extended: true })).body;
      if (u.length >= 1 && u.length <= 20 && u.every((x: any) => x.asset_list.length === 0 && !x.inline_datum && !x.reference_script)) return addr;
    }
  }
  throw new Error('no funded plain-ADA address found in recent blocks');
}
const FUNDED = await findFunded();
console.log('stand-in for the wallet (public, funded):', FUNDED);
console.log('throwaway wallet (random key, unfunded):  ', THROWAWAY);

const intentFor = (from: string, to: string, amount: bigint, p: { maxFee: bigint; ttlSec: number; section: unknown }) => {
  const now = Math.floor(Date.now() / 1000);
  return { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'ADA', decimals: 6,
    amount: amount.toString(), from, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 4, ...(p.section as { x: Record<string, string> }) };
};
const lin = CSL.LinearFee.new(CSL.BigNum.from_str(REVIEWED_PARAMS.minFeeA.toString()), CSL.BigNum.from_str(REVIEWED_PARAMS.minFeeB.toString()));
const evaluate = async (hex: string) => { const r = await post(KOIOS + '/ogmios', { jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: hex } } }); return r.body?.error ? { status: r.status, error: { code: r.body.error.code, message: String(r.body.error.message).slice(0, 160) } } : { status: r.status, result: r.body?.result }; };

await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('protocol parameters (live vs reviewed)', async () => {
  const tip = (await (await fetch(KOIOS + '/tip')).json())[0];
  const [p] = await (await fetch(`${KOIOS}/epoch_params?_epoch_no=${tip.epoch_no}`)).json();
  const live = { epoch: p.epoch_no, minFeeA: p.min_fee_a, minFeeB: p.min_fee_b, coinsPerUtxoByte: p.coins_per_utxo_size, maxTxSize: p.max_tx_size, protocol: `${p.protocol_major}.${p.protocol_minor}` };
  if (BigInt(p.min_fee_a) !== REVIEWED_PARAMS.minFeeA || BigInt(p.min_fee_b) !== REVIEWED_PARAMS.minFeeB || BigInt(p.coins_per_utxo_size) !== REVIEWED_PARAMS.coinsPerUtxoByte) throw new Error(json(live));
  return live;
});
await step('balance (funded public address)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return ada(b.native!); });
await step('balance (address never used)', async () => { const b = await a.balances(THROWAWAY); if (b.native !== 0n) throw new Error('non-zero'); return ada(b.native); });
let seen = '';
await step('deposits (first scan, last ~day)', async () => {
  const d = await a.deposits(FUNDED, null); seen = d.items[0]?.txid ?? '';
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: d.items.length ? { ...d.items[d.items.length - 1]!, amount: ada(d.items[d.items.length - 1]!.amount) } : null };
});
await step('prepare → 2.5 ADA (stand-in wallet)', async () => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 2_500_000n });
  const intent = intentFor(FUNDED, THROWAWAY, 2_500_000n, p), b = buildCardanoTx(intent, n);
  // signed with the throwaway key: a real-format transaction (the chain would refuse it only because that key does not own the inputs)
  const raw = cardanoSignedTx(b.body, PUB.subarray(0, 32), xprvSign(pay, b.hash)), hex = Buffer.from(raw).toString('hex');
  const tx = CSL.Transaction.from_hex(hex), fixed = CSL.FixedTransaction.from_hex(hex);
  if (tx.to_hex() !== hex) throw new Error('the official library re-encodes it differently');
  if (fixed.transaction_hash().to_hex() !== b.txid) throw new Error('body hash differs from the official library');
  const minFeeSdk = BigInt(CSL.min_fee(tx, lin).to_str()), ledgerMin = cardanoMinFee(raw.length - 1, REVIEWED_PARAMS.minFeeA, REVIEWED_PARAMS.minFeeB);
  if (b.fee < minFeeSdk || b.fee < ledgerMin) throw new Error(`fee ${b.fee} below the minimum ${minFeeSdk}`);
  const outs = tx.body().outputs(), mins: string[] = [];
  for (let k = 0; k < outs.len(); k++) {
    const o = outs.get(k), min = BigInt(CSL.min_ada_for_output(o, CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(REVIEWED_PARAMS.coinsPerUtxoByte.toString()))).to_str());
    if (BigInt(o.amount().coin().to_str()) < min || min !== cardanoMinAda(o.address().to_bech32(), BigInt(o.amount().coin().to_str()), REVIEWED_PARAMS.coinsPerUtxoByte)) throw new Error('minimum ADA rule');
    mins.push(`${o.amount().coin().to_str()} >= ${min}`);
  }
  const w = tx.witness_set().vkeys()!.get(0);
  if (!w.vkey().public_key().verify(b.hash, w.signature())) throw new Error('signature does not verify in the official library');
  const ev = await evaluate(hex);
  return { x: intent.x, maxFee: p.maxFee, feeEstimate: p.feeEstimate, warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), txid: b.txid, bytes: raw.length,
    officialLibrary: { roundTripIdentical: true, bodyHashIdentical: true, minFee: minFeeSdk, ledgerMinFee: ledgerMin, feePaid: b.fee, outputsVsMinAda: mins, signatureVerifies: true },
    nodeEvaluate: ev, hex };
});
await step('throwaway wallet signs end to end', async () => {
  // the throwaway wallet "spends" the stand-in's outputs: every byte is produced by plugin.sign() with a real key handle
  const p = await a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 3_000_000n });
  const fake = intentFor(THROWAWAY, FUNDED, 3_000_000n, p);
  const s = cardanoPlugin.sign(fake, n, key);
  const tx = CSL.Transaction.from_hex(s.raw), w = tx.witness_set().vkeys()!.get(0);
  const payCred = CSL.BaseAddress.from_address(CSL.Address.from_bech32(THROWAWAY))!.payment_cred().to_keyhash()!.to_hex();
  if (w.vkey().public_key().hash().to_hex() !== payCred) throw new Error('witness key is not the payment key of the source address');
  if (!w.vkey().public_key().verify(Buffer.from(s.txid, 'hex'), w.signature())) throw new Error('signature does not verify');
  if (CSL.FixedTransaction.from_hex(s.raw).transaction_hash().to_hex() !== s.txid) throw new Error('txid');
  const d = cardanoDecodeTx(Buffer.from(s.raw, 'hex'));
  return { txid: s.txid, bytes: s.raw.length / 2, witnessKeyHashEqualsPaymentCredential: true, signatureVerifiesInOfficialLibrary: true, outputs: d.outputs.map((o) => `${o.address.slice(0, 16)}… ${ada(o.lovelace)}`), nodeEvaluate: await evaluate(s.raw) };
});
await step('real mainnet transactions decoded', async () => {
  const tip = (await (await fetch(KOIOS + '/tip')).json())[0];
  const [b] = await (await fetch(`${KOIOS}/blocks?block_height=eq.${tip.block_no - 5}&select=hash`)).json();
  const hashes = (await post(KOIOS + '/block_txs', { _block_hashes: [b.hash] })).body.map((x: any) => x.tx_hash).slice(0, 12);
  const cbors = (await post(KOIOS + '/tx_cbor', { _tx_hashes: hashes })).body, infos = (await post(KOIOS + '/tx_info', { _tx_hashes: hashes, _inputs: false, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false })).body;
  let ok = 0, sigs = 0;
  for (const c of cbors) {
    const d = cardanoDecodeTx(Buffer.from(c.cbor, 'hex'), { strict: false }), info = infos.find((x: any) => x.tx_hash === c.tx_hash);
    const outs = [...info.outputs].sort((x: any, y: any) => x.tx_index - y.tx_index);
    if (d.txid !== c.tx_hash || d.fee.toString() !== info.fee || d.outputs.length !== outs.length || d.outputs.some((o, k) => o.address !== outs[k].payment_addr.bech32 || o.lovelace.toString() !== outs[k].value || o.assets !== outs[k].asset_list.length)) throw new Error(`decode mismatch for ${c.tx_hash}`);
    if (Buffer.from(c.cbor, 'hex').length - 1 !== info.tx_size) throw new Error('size');
    for (const w of d.witnesses) { if (!CSL.PublicKey.from_bytes(w.publicKey).verify(Buffer.from(d.txid, 'hex'), CSL.Ed25519Signature.from_bytes(w.signature))) throw new Error('real signature does not verify against the recomputed id'); sigs++; }
    ok++;
  }
  return { block: tip.block_no - 5, transactions: ok, idFeeOutputsIdenticalToIndexer: true, realSignaturesVerifiedAgainstRecomputedId: sigs };
});
await step('prepare → below the minimum ADA', expectErr('bad_amount', () => a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 500_000n })));
await step('prepare → more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 40_000_000_000_000_000n })));
await step('prepare ← address holding nothing', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: THROWAWAY, to: FUNDED, amount: 2_000_000n })));
await step('prepare → a script address', expectErr('bad_address', () => a.prepare({ asset: 'native', from: FUNDED, to: 'addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx', amount: 2_000_000n })));
await step('prepare, a native token', expectErr('unsupported_asset', () => a.prepare({ asset: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344', from: FUNDED, to: THROWAWAY, amount: 1n })));
const nowSlot = Math.floor(Date.now() / 1000) - 1_591_566_291;
if (seen) await step('track (real included transaction)', async () => { const t = await a.track({ txid: seen, intent: { x: { ttl: String(nowSlot) } }, blockRef: null, broadcastAt: 0 }); if (t.state !== 'finalized') throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, window still open)', async () => { const t = await a.track({ txid: 'ff'.repeat(32), intent: { x: { ttl: String(nowSlot + 600) } }, blockRef: null, broadcastAt: 0 }); if (t.state !== 'broadcast' || !t.rebroadcast) throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, window closed)', async () => { const t = await a.track({ txid: 'ff'.repeat(32), intent: { x: { ttl: String(nowSlot - 3600) } }, blockRef: null, broadcastAt: 0 }); if (t.state !== 'failed') throw new Error(JSON.stringify(t)); return t; });
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing broadcast, throwaway key only)');
process.exit(failed ? 1 : 0);
