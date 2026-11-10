import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, erc20Abi } from 'viem';
import { buildSolMessage, intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { initKeystore, loadMnemonic } from '../src/keystore.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { enrollChallenge, Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';
import { createHash } from 'node:crypto';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);

function setup(nowRef = { t: Math.floor(Date.now() / 1000) }) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t);
  const pk = new TestPasskey(RP, ORIGIN);
  return { dir, store, signer, pk, nowRef };
}
let seq = 0;
function evm(now: number, over: Partial<Intent> = {}): Intent {
  seq += 1;
  return { v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(seq).padStart(12, '0')}`, keyId: keys.keyId, network: 'base', chainRef: '8453',
    asset: NETWORKS.base.tokens[0]!.id, symbol: 'USDC', decimals: 6, amount: '10000000', from: keys.addresses.evm,
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', maxFee: '100000000000000', createdAt: now, expiresAt: now + 120, policyVersion: 2,
    evm: { nonce: 0, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...over };
}

describe('key derivation (public test vectors)', () => {
  it('matches BIP-44 / BIP-84 / SLIP-0010 reference addresses', () => {
    expect(keys.addresses.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(keys.addresses.btc).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(keys.addresses.sol).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });
});

describe('per-network keys', () => {
  it('Litecoin uses BIP-84 coin type 2 (public vector) and every network has an address', () => {
    expect(keys.addresses.litecoin).toBe('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh');
    for (const n of Object.values(NETWORKS)) expect(keys.addresses[n.id], n.id).toBeTruthy();
    for (const id of ['base', 'optimism', 'bsc', 'avalanche', 'hyperevm']) expect(keys.addresses[id]).toBe(keys.addresses.evm);
  });
  it('signs a Litecoin intent with Litecoin parameters and refuses a Bitcoin address as destination', async () => {
    const { signer, pk, nowRef } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const t = nowRef.t;
    const ltc: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-cccccccccccc', keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 2, network: 'litecoin', chainRef: NETWORKS.litecoin.chainRef,
      asset: 'native', symbol: 'LTC', decimals: 8, amount: '2000000', from: keys.addresses.litecoin!, to: 'ltc1qg42tkwuuxefutzxezdkdel39gfstuap288mfea', maxFee: '100000',
      btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '5000000' }], change: '2990000', fee: '10000' } };
    const r = await signer.sign(ltc, pk.assert(intentHash(ltc)));
    const tx = Transaction.fromRaw(hex.decode(r.raw));
    expect(tx.id).toBe(r.txid);
    expect(tx.getOutput(0).amount).toBe(2_000_000n);
    const bad = { ...ltc, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-dddddddddddd', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };
    await expect(signer.sign(bad, pk.assert(intentHash(bad)))).rejects.toThrow();
    const wrongChain = { ...ltc, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-eeeeeeeeeeee', chainRef: NETWORKS.bitcoin.chainRef };
    await expect(signer.sign(wrongChain, pk.assert(intentHash(wrongChain)))).rejects.toThrow(/chain/);
  });
});

describe('keystore', () => {
  it('encrypts at rest, 0600, never overwrites, round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-ks-'));
    const ks = join(dir, 'keystore.json'), wk = join(dir, 'w', 'wrap.key');
    initKeystore(ks, wk);
    expect(statSync(ks).mode & 0o777).toBe(0o600);
    expect(statSync(wk).mode & 0o777).toBe(0o600);
    const m = loadMnemonic(ks, wk);
    expect(m.split(' ').length).toBe(24);
    const file = readFileSync(ks, 'utf8');
    for (const w of m.split(' ').filter((x) => x.length > 5)) expect(file.includes(w)).toBe(false);
    expect(() => initKeystore(ks, wk)).toThrow(/refusing/);
    expect(deriveKeys(m).addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('enrollment', () => {
  it('first passkey needs the one-time token; later ones need an existing passkey', async () => {
    const { signer, pk } = setup();
    await expect(signer.enroll({ credential: pk.credential(), setupToken: 'wrong' })).rejects.toThrow(/setup token/);
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const pk2 = new TestPasskey(RP, ORIGIN);
    await expect(signer.enroll({ credential: pk2.credential(), setupToken: 'setup-token' })).rejects.toThrow(/passkey approval/);
    const rogue = new TestPasskey(RP, ORIGIN);
    await expect(signer.enroll({ credential: pk2.credential(), assertion: rogue.assert(enrollChallenge(pk2.id, pk2.publicKey)) })).rejects.toThrow();
    await signer.enroll({ credential: pk2.credential(), assertion: pk.assert(enrollChallenge(pk2.id, pk2.publicKey)) });
    expect(signer.status().credentials.length).toBe(2);
  });
});

describe('signing', () => {
  it('signs an approved USDC transfer; signature recovers to the wallet address', async () => {
    const { signer, pk, nowRef, store } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const i = evm(nowRef.t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const tx = parseTransaction(r.raw as `0x${string}`);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(keys.addresses.evm);
    expect(tx.to?.toLowerCase()).toBe(NETWORKS.base.tokens[0]!.id.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args).toEqual([i.to, 10_000_000n]);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
  });

  it('rejects approval bound to a different intent (any mutated field)', async () => {
    const { signer, pk, nowRef } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const i = evm(nowRef.t);
    const a = pk.assert(intentHash(i));
    for (const m of [{ amount: '10000001' }, { to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }, { maxFee: '100000000000001' },
      { evm: { ...i.evm!, nonce: 1 } }, { network: 'arbitrum' as const, chainRef: '42161', asset: NETWORKS.arbitrum.tokens[0]!.id }])
      await expect(signer.sign({ ...i, ...m }, a)).rejects.toThrow(/approval/);
  });

  it('rejects replay, wrong origin, no user verification, unknown passkey, missing approval', async () => {
    const { signer, pk, nowRef } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const i = evm(nowRef.t);
    await signer.sign(i, pk.assert(intentHash(i)));
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
    const j = evm(nowRef.t);
    await expect(signer.sign(j, pk.assert(intentHash(j), { origin: 'https://evil.example' }))).rejects.toThrow();
    await expect(signer.sign(j, pk.assert(intentHash(j), { uv: false }))).rejects.toThrow();
    await expect(signer.sign(j, new TestPasskey(RP, ORIGIN).assert(intentHash(j)))).rejects.toThrow(/enrolled/);
    await expect(signer.sign(j, undefined as never)).rejects.toThrow();
    await signer.sign(j, pk.assert(intentHash(j))); // still usable after failed attempts
  });

  it('enforces limits, expiry, halt, key, chain, source and token allowlist', async () => {
    const { signer, pk, nowRef } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const t = nowRef.t;
    const tryIt = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
    await expect(tryIt(evm(t, { amount: '50000001' }))).rejects.toThrow(/per-transaction/);
    await expect(tryIt(evm(t, { expiresAt: t + 4000 }))).rejects.toThrow(/window/);
    await expect(tryIt(evm(t, { keyId: 'spw-ffffffffffffffff' }))).rejects.toThrow(/another key/);
    await expect(tryIt(evm(t, { chainRef: '1' }))).rejects.toThrow(/chain/);
    await expect(tryIt(evm(t, { from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }))).rejects.toThrow(/source/);
    await expect(tryIt(evm(t, { asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }))).rejects.toThrow(/allowlisted/);
    await expect(tryIt(evm(t, { to: keys.addresses.evm }))).rejects.toThrow(/destination equals source/);
    await tryIt(evm(t, { amount: '50000000' }));
    await tryIt(evm(t, { amount: '50000000' }));
    await expect(tryIt(evm(t, { amount: '1' }))).rejects.toThrow(/daily limit/);
    nowRef.t += 86400; // next UTC day
    const k = evm(nowRef.t, { amount: '1' });
    await tryIt(k);
    const old = evm(t);
    await expect(tryIt(old)).rejects.toThrow(/expired/);
    signer.halt();
    await expect(tryIt(evm(nowRef.t))).rejects.toThrow(/halt/);
  });

  it('signs Solana and Bitcoin intents verifiably', async () => {
    const { signer, pk, nowRef } = setup();
    await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
    const t = nowRef.t, common = { v: 1 as const, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 2 };
    const sol: Intent = { ...common, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-aaaaaaaaaaaa', network: 'solana', chainRef: NETWORKS.solana.chainRef,
      asset: NETWORKS.solana.tokens[0]!.id, symbol: 'USDC', decimals: 6, amount: '5000000', from: keys.addresses.sol,
      to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', maxFee: '100000',
      sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 10, createAta: false, computeUnitLimit: 60000, computeUnitPrice: '1000' } };
    const rs = await signer.sign(sol, pk.assert(intentHash(sol)));
    const wire = Buffer.from(rs.raw, 'base64');
    expect(wire[0]).toBe(1);
    const sig = wire.subarray(1, 65), msg = wire.subarray(65);
    expect(Buffer.compare(msg, Buffer.from(buildSolMessage(sol)))).toBe(0);
    expect(ed25519.verify(sig, msg, base58.decode(keys.addresses.sol))).toBe(true);
    expect(rs.txid).toBe(base58.encode(sig));

    const btc: Intent = { ...common, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-bbbbbbbbbbbb', network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef,
      asset: 'native', symbol: 'BTC', decimals: 8, amount: '20000', from: keys.addresses.btc, to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', maxFee: '2000',
      btc: { inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: '50000' }], change: '29500', fee: '500' } };
    const rb = await signer.sign(btc, pk.assert(intentHash(btc)));
    const tx = Transaction.fromRaw(hex.decode(rb.raw));
    expect(tx.id).toBe(rb.txid);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(20000n);
    expect(tx.getInput(0).finalScriptWitness?.length).toBe(2);
  });
});

describe('gateway transport', () => {
  it('requires a valid, fresh, non-replayed HMAC and exposes no generic signing route', async () => {
    const { signer } = setup();
    const secret = 's'.repeat(48);
    const srv = createSignerServer(signer, secret).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const call = (path: string, method: string, auth?: string, body = '') => fetch(url + path, { method, headers: auth ? { 'x-spw-auth': auth } : {}, body: body || undefined });
    expect((await call('/status', 'GET')).status).toBe(401);
    expect((await call('/status', 'GET', authHeader('x'.repeat(48), 'GET', '/status', ''))).status).toBe(401);
    expect((await call('/status', 'GET', authHeader(secret, 'GET', '/status', '', Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    const h = authHeader(secret, 'GET', '/status', '');
    const ok = await call('/status', 'GET', h);
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).not.toMatch(/abandon|priv|seed/i);
    expect((await call('/status', 'GET', h)).status).toBe(401); // replayed nonce
    expect((await call('/sign-message', 'POST', authHeader(secret, 'POST', '/sign-message', '{}'), '{}')).status).toBe(404);
    const bad = await call('/sign', 'POST', authHeader(secret, 'POST', '/sign', '{"intent":{}}'), '{"intent":{}}');
    expect(bad.status).toBe(422);
    srv.close();
  });
});
