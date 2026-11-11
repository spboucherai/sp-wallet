// Live READ-ONLY check of the Polkadot adapter against Polkadot Asset Hub, and the proof of the extrinsic format without funds:
// where DOT lives (issuance on Asset Hub vs relay chain), health + identity, the runtime pins checked BY NAME in the live
// metadata, balances, prepare() from a funded PUBLIC account standing in as the wallet (two sources agree; fee quote and
// DryRunApi run inside), the prepared bytes decoded by @polkadot/types with the live metadata, the node's own verdict on
//   (a) the stand-in extrinsic with a placeholder signature  → InvalidTransaction::BadProof (as it must be),
//   (b) an extrinsic signed with a THROWAWAY random key      → InvalidTransaction::Payment: the node ACCEPTED the signature
//       over our signing payload and stopped only because that account has no funds,
//   (c) the same with one signature bit flipped / a wrong genesis → BadProof,
// independent ed25519 verification, real transfers decoded, tracking of a real transfer, the deposit scan finding it.
// Nothing is broadcast (author_submitExtrinsic is never called); no real key is used.  Run: npx tsx scripts/smoke-polkadot.mts
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, buildPolkadotTx, formatUnits, intentHash, polkadotAccountId, polkadotDecodeExtrinsic, polkadotExtrinsic, polkadotPlugin, polkadotTxid, POLKADOT_EXTENSIONS, POLKADOT_REVIEWED, ss58Encode, toHex } = await import('@spw/core');
const { polkadotAdapter, checkPolkadotMetadata } = await import('../services/api/src/chains/polkadot.ts');
const { parseMetadata, storageKey } = await import('../services/api/src/chains/polkadot-metadata.ts');
const { Metadata, TypeRegistry } = await import('@polkadot/types');
const { signatureVerify } = await import('@polkadot/util-crypto');

const n = NETWORKS.polkadot!, a = polkadotAdapter(n), dot = (v: bigint) => `${formatUnits(v, 10)} DOT`;
const RELAY = 'https://rpc.polkadot.io';
const rpc = async (url: string, method: string, params: unknown[] = []): Promise<any> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j: any = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error }); return j.result;
};
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const le = (h: string) => BigInt('0x' + (h.slice(2).match(/../g) ?? []).reverse().join(''));
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(46), json(await f())); }
  catch (e) { failed++; console.log(name.padEnd(46), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };

// a throwaway account: random ed25519 key made by node:crypto (independent of @noble), never funded, never reused
const kp = generateKeyPairSync('ed25519');
const PUB = Uint8Array.from(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'));
const THROWAWAY = ss58Encode(0, PUB);
const key = { curve: 'ed25519' as const, publicKey: PUB, signMessage: (m: Uint8Array) => Uint8Array.from(nodeSign(null, m, kp.privateKey)) };

// real transfers of recent blocks; the sender of one of them, still funded and idle, stands in for the wallet (override with POLKADOT_FROM)
const head = await rpc(n.rpc[0]!, 'chain_getFinalizedHead'), headNo = parseInt((await rpc(n.rpc[0]!, 'chain_getHeader', [head])).number, 16);
const real: { block: number; hash: string; index: number; hex: string }[] = [];
for (let b = headNo; b > headNo - 1200 && real.length < 6; b--) {
  const h = await rpc(n.rpc[0]!, 'chain_getBlockHash', [b]);
  for (const [index, x] of ((await rpc(n.rpc[0]!, 'chain_getBlock', [h])).block.extrinsics as string[]).entries())
    if (x.length < 420 && /^0x[0-9a-f]{2,6}8400/.test(x) && /0a0[03]00[0-9a-f]{64}/.test(x)) { try { polkadotDecodeExtrinsic(Buffer.from(x.slice(2), 'hex')); real.push({ block: b, hash: h, index, hex: x }); } catch { /* another call that happens to match */ } }
}
let FUNDED = process.env.POLKADOT_FROM ?? '';
for (const t of real) {
  if (FUNDED) break;
  const d = polkadotDecodeExtrinsic(Buffer.from(t.hex.slice(2), 'hex'));
  for (const acc of [d.dest, d.signer]) {
    const addr = ss58Encode(0, acc), raw = await rpc(n.rpc[0]!, 'state_getStorage', [storageKey('System', 'Account', acc)]);
    if (!raw || le('0x' + raw.slice(2 + 32, 2 + 64)) < 30_000_000_000n) continue;
    // idle right now (a busy exchange account always has a transaction waiting for finality): prepare() must go through
    try { await a.prepare({ asset: 'native', from: addr, to: ss58Encode(0, acc === d.dest ? d.signer : d.dest), amount: 10_000_000_000n }); FUNDED = addr; break; } catch { /* next candidate */ }
  }
}
if (!FUNDED) throw new Error('no idle funded account found in recent blocks; set POLKADOT_FROM');
console.log('stand-in for the wallet (public, funded):', FUNDED);
console.log('throwaway account (random key, unfunded):', THROWAWAY);

const metaHex: string = await rpc(n.rpc[0]!, 'state_getMetadata');
const registry = new TypeRegistry(); registry.setMetadata(new Metadata(registry, metaHex));
const intentFor = (from: string, to: string, amount: bigint, p: { maxFee: bigint; ttlSec: number; section: unknown }) => {
  const now = Math.floor(Date.now() / 1000);
  return { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'DOT', decimals: 10,
    amount: amount.toString(), from, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 4, ...(p.section as { x: Record<string, string> }) };
};
const VALIDITY = ['Call', 'Payment', 'Future', 'Stale', 'BadProof', 'AncientBirthBlock', 'ExhaustsResources', 'Custom', 'BadMandatory', 'MandatoryValidation', 'BadSigner', 'IndeterminateImplicit', 'UnknownOrigin'];
/** TaggedTransactionQueue.validate_transaction(source = External, extrinsic, block hash): the node's verdict without submitting anything */
const validate = async (url: string, xtHex: string, at: string): Promise<string> => {
  const r: string = await rpc(url, 'state_call', ['TaggedTransactionQueue_validate_transaction', '0x02' + xtHex.slice(2) + at.slice(2), at]);
  if (r.startsWith('0x00')) return 'Valid';
  return r.startsWith('0x0100') ? `Invalid::${VALIDITY[parseInt(r.slice(6, 8), 16)] ?? r}` : `Unknown (${r})`;
};

await step('where DOT lives (total issuance)', async () => {
  const K = storageKey('Balances', 'TotalIssuance');
  const hub = le(await rpc(n.rpc[0]!, 'state_getStorage', [K])), relay = le(await rpc(RELAY, 'state_getStorage', [K]));
  if (hub < relay * 100n) throw new Error('balances are not on Asset Hub');
  return { assetHub: dot(hub), relayChain: dot(relay) };
});
await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('runtime pins, by name in the live metadata', async () => {
  const out: unknown[] = [];
  for (const u of n.rpc) {
    const v = await rpc(u, 'state_getRuntimeVersion'), m = parseMetadata(Buffer.from((await rpc(u, 'state_getMetadata')).slice(2), 'hex')), c = checkPolkadotMetadata(m);
    if (v.specName !== POLKADOT_REVIEWED.specName || v.transactionVersion !== POLKADOT_REVIEWED.transactionVersion) throw new Error(json(v));
    out.push({ source: new URL(u).host, specName: v.specName, specVersion: v.specVersion, transactionVersion: v.transactionVersion, extensions: m.extrinsic.extensions.length === POLKADOT_EXTENSIONS.length ? `${POLKADOT_EXTENSIONS.length} as reviewed` : 'DIFFERENT',
      call: `${POLKADOT_REVIEWED.pallet.name}.${POLKADOT_REVIEWED.call.name} = [${POLKADOT_REVIEWED.pallet.index}, ${POLKADOT_REVIEWED.call.index}]`, existentialDeposit: dot(c.existentialDeposit) });
  }
  return out;
});
await step('balance (funded public account)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return dot(b.native!); });
await step('balance (account never used)', async () => { const b = await a.balances(THROWAWAY); if (b.native !== 0n) throw new Error('non-zero'); return dot(b.native); });
let prepared: ReturnType<typeof intentFor> | null = null;
await step('prepare → 1.25 DOT (stand-in wallet)', async () => {
  const dest = ss58Encode(0, polkadotDecodeExtrinsic(Buffer.from(real[0]!.hex.slice(2), 'hex')).dest); // an existing account
  const to = dest === FUNDED ? ss58Encode(0, polkadotDecodeExtrinsic(Buffer.from(real[0]!.hex.slice(2), 'hex')).signer) : dest;
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount: 12_500_000_000n });
  const intent = prepared = intentFor(FUNDED, to, 12_500_000_000n, p), b = buildPolkadotTx(intent, n);
  const xt = polkadotExtrinsic(b, polkadotAccountId(FUNDED), new Uint8Array(64).fill(0x2a)), xtHex = '0x' + hex(xt); // placeholder signature
  const sdk = registry.createType('Extrinsic', xt);
  if (sdk.toHex() !== xtHex || sdk.method.section + '.' + sdk.method.method !== 'balances.transferKeepAlive' || sdk.signer.toString() !== FUNDED || sdk.nonce.toString() !== intent.x.nonce) throw new Error('@polkadot/types decodes it differently');
  const quotes = await Promise.all(n.rpc.map((u) => rpc(u, 'payment_queryInfo', [xtHex, intent.x.era_hash]).then((q: any) => q.partialFee)));
  const verdicts = await Promise.all(n.rpc.map((u) => validate(u, xtHex, intent.x.era_hash!)));
  if (verdicts.some((v) => v !== 'Invalid::BadProof')) throw new Error(`expected BadProof for a placeholder signature, got ${verdicts}`);
  return { x: intent.x, maxFee: dot(p.maxFee), feeEstimate: dot(p.feeEstimate), warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), bytes: xt.length, payloadBytes: b.payload.length,
    decodedByPolkadotJs: { identicalBytes: true, call: 'balances.transferKeepAlive', dest: (sdk.method.args[0] as any).value.toString(), value: sdk.method.args[1]!.toString(), era: sdk.era.toHuman() },
    paymentQueryInfo: quotes, dryRunApiOnBothSources: 'Ok (ran inside prepare)', nodeVerdictWithPlaceholderSignature: verdicts, hex: xtHex };
});
await step('throwaway key: signed, verified, judged by nodes', async () => {
  if (!prepared) throw new Error('no prepared intent');
  // same chain parameters, source = the throwaway account (nonce 0): every byte is produced by plugin.sign() with a real key handle
  const intent = { ...prepared, from: THROWAWAY, to: FUNDED, x: { ...prepared.x, nonce: '0' } };
  const s = polkadotPlugin.sign(intent, n, key), b = buildPolkadotTx(intent, n), raw = Buffer.from(s.raw.slice(2), 'hex');
  const sig = raw.subarray(raw.length - b.call.length - b.extra.length - 64, raw.length - b.call.length - b.extra.length);
  const indep = signatureVerify(b.payload, sig, THROWAWAY); // @polkadot/util-crypto (its own ed25519)
  if (!indep.isValid || indep.crypto !== 'ed25519') throw new Error('independent verification failed');
  const sdk = registry.createType('Extrinsic', raw);
  if (sdk.toHex() !== s.raw || sdk.hash.toHex() !== s.txid || sdk.signer.toString() !== THROWAWAY) throw new Error('@polkadot/types decodes it differently');
  const good = await Promise.all(n.rpc.map((u) => validate(u, s.raw, intent.x.era_hash!)));
  // controls: one bit of the signature flipped; the same transfer signed for another chain (relay-chain genesis)
  const flipped = Buffer.from(raw); flipped[flipped.length - b.call.length - b.extra.length - 1]! ^= 1;
  const bad = await Promise.all(n.rpc.map((u) => validate(u, '0x' + flipped.toString('hex'), intent.x.era_hash!)));
  const wrongChain = Buffer.concat([b.payload.subarray(0, b.payload.length - 65), Buffer.from('91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3', 'hex'), b.payload.subarray(b.payload.length - 33)]);
  const other = await Promise.all(n.rpc.map((u) => validate(u, '0x' + hex(polkadotExtrinsic(b, PUB, key.signMessage(wrongChain))), intent.x.era_hash!)));
  if (good.some((v) => v !== 'Invalid::Payment') || bad.some((v) => v !== 'Invalid::BadProof') || other.some((v) => v !== 'Invalid::BadProof')) throw new Error(json({ good, bad, other }));
  return { txid: s.txid, bytes: raw.length, independentVerify: indep.crypto, decodedByPolkadotJs: 'identical bytes and hash', nodeVerdict: good, meaning: 'signature and encoding accepted; refused only because the throwaway account cannot pay',
    control_bitFlippedSignature: bad, control_signedForRelayChainGenesis: other, hex: s.raw };
});
await step('real Asset Hub transfers decoded', async () => {
  const out: string[] = [];
  for (const t of real) {
    const raw = Buffer.from(t.hex.slice(2), 'hex'), d = polkadotDecodeExtrinsic(raw), sdk = registry.createType('Extrinsic', raw);
    if (ss58Encode(0, d.signer) !== sdk.signer.toString() || d.nonce.toString() !== sdk.nonce.toString() || d.value.toString() !== sdk.method.args[1]!.toString() || ss58Encode(0, d.dest) !== (sdk.method.args[0] as any).value.toString() || polkadotTxid(raw) !== sdk.hash.toHex()) throw new Error(`decode mismatch at ${t.block}/${t.index}`);
    out.push(`#${t.block}/${t.index} ${['ed25519', 'sr25519', 'ecdsa'][d.signatureType]} ${sdk.method.method} ${dot(d.value)}`);
  }
  if (out.length < 3) throw new Error('too few real transfers found');
  return out;
});
await step('track (real finalized transfer)', async () => {
  const t = [...real].reverse().find((x) => polkadotDecodeExtrinsic(Buffer.from(x.hex.slice(2), 'hex')).era)!, d = polkadotDecodeExtrinsic(Buffer.from(t.hex.slice(2), 'hex'));
  if (!d.era) throw new Error('immortal');
  const birth = t.block - 1 - ((t.block - 1 - d.era.phase) % d.era.period);
  const r = await a.track({ txid: polkadotTxid(Buffer.from(t.hex.slice(2), 'hex')), intent: { from: ss58Encode(0, d.signer), x: { nonce: d.nonce.toString(), era_block: String(birth), era_period: String(d.era.period) } }, blockRef: null, broadcastAt: 0 });
  if (r.state !== 'finalized' || r.blockRef !== String(t.block)) throw new Error(JSON.stringify(r));
  return r;
});
await step('track (unknown, era still open)', async () => { const r = await a.track({ txid: '0x' + 'ff'.repeat(32), intent: { from: THROWAWAY, x: { nonce: '0', era_block: String(headNo - 10), era_period: '256' } }, blockRef: null, broadcastAt: 0 }); if (r.state !== 'broadcast' || !r.rebroadcast) throw new Error(JSON.stringify(r)); return r; });
await step('track (unknown, era ended)', async () => { const r = await a.track({ txid: '0x' + 'ff'.repeat(32), intent: { from: THROWAWAY, x: { nonce: '0', era_block: String(headNo - 5000), era_period: '256' } }, blockRef: null, broadcastAt: 0 }); if (r.state !== 'failed') throw new Error(JSON.stringify(r)); return r; });
await step('deposits (first pass starts at the head)', async () => { const d = await a.deposits(FUNDED, null); if (d.items.length || d.cursor < headNo) throw new Error(json(d)); return { items: 0, cursor: d.cursor }; });
await step('deposits (finds a real incoming transfer)', async () => {
  // the scan compares the account's state between two blocks: use a recipient that still exists (an account emptied and deleted
  // in the meantime shows no difference — which cannot happen to this wallet, whose transfers are all keep-alive)
  for (const t of real) {
    const d = polkadotDecodeExtrinsic(Buffer.from(t.hex.slice(2), 'hex')), to = ss58Encode(0, d.dest);
    if (!(await rpc(n.rpc[0]!, 'state_getStorage', [storageKey('System', 'Account', d.dest)]))) continue;
    const r = await a.deposits(to, t.block - 40);
    const hit = r.items.find((x) => x.txid === polkadotTxid(Buffer.from(t.hex.slice(2), 'hex')));
    if (!hit || hit.amount !== d.value || hit.from !== ss58Encode(0, d.signer) || hit.block !== t.block) throw new Error(json({ want: { block: t.block, value: d.value }, got: r }));
    return { scannedFrom: t.block - 40, cursor: r.cursor, items: r.items.length, found: { ...hit, amount: dot(hit.amount) } };
  }
  throw new Error('no recipient of a recent transfer still exists');
});
await step('prepare → new account, below the ED', expectErr('bad_amount', () => a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 50_000_000n })));
await step('prepare → new account, 0.5 DOT', async () => { const p = await a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 5_000_000_000n }); return { feeEstimate: dot(p.feeEstimate), warnings: p.warnings }; });
await step('prepare → more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: THROWAWAY, amount: 10n ** 20n })));
await step('prepare ← account holding nothing', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: THROWAWAY, to: FUNDED, amount: 5_000_000_000n })));
await step('prepare → a Kusama address', expectErr('bad_address', () => a.prepare({ asset: 'native', from: FUNDED, to: 'G9xV2EatmrjRC1FLPexc3ddqNRRzCsAdURU8RFiAAJX6ppY', amount: 5_000_000_000n })));
await step('prepare, an asset', expectErr('unsupported_asset', () => a.prepare({ asset: '1984', from: FUNDED, to: THROWAWAY, amount: 1n })));
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing broadcast, throwaway key only)');
process.exit(failed ? 1 : 0);
