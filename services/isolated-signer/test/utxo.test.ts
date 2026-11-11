// Dogecoin and Bitcoin Cash through the real Signer (passkey approval, policy, journal), verified by independent libraries.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { cashAddressToLockingBytecode, createVirtualMachineBCH, decodeTransaction, hashTransaction } from '@bitauth/libauth';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { encodeBchInputs, intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys, utxoPath } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);
const DOGE_JS: bitcoin.Network = { messagePrefix: '\x19Dogecoin Signed Message:\n', bech32: 'doge', bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-utxo-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  let seq = 0;
  const common = () => ({ v: 1 as const, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 2 });
  const sign = async (i: Intent, aux?: Record<string, unknown>) => signer.sign(i, pk.assert(intentHash(i)), aux);
  return { store, common, sign };
}

describe('addresses (published vectors for the test mnemonic)', () => {
  it('Dogecoin m/44\'/3\'/0\'/0/0 and Bitcoin Cash m/44\'/145\'/0\'/0/0; existing addresses and the key id are unchanged', () => {
    expect(utxoPath(NETWORKS.dogecoin)).toBe("m/44'/3'/0'/0/0");
    expect(keys.addresses.dogecoin).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
    expect(keys.addresses.bitcoincash).toBe('bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
    expect(keys.addresses.btc).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(keys.addresses.litecoin).toBe('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh');
    expect(keys.keyId).toBe(deriveKeys(TEST_MNEMONIC).keyId);
  });
});

describe('Dogecoin through the signer', () => {
  const from = keys.addresses.dogecoin!, to = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';
  const lock = bitcoin.address.toOutputScript(from, DOGE_JS);
  const prev = new bitcoin.Transaction();
  prev.version = 1;
  prev.addInput(new Uint8Array(32).fill(3), 4, 0xffffffff, Uint8Array.of(0x51));
  prev.addOutput(lock, 12_000_000_000n);
  const aux = { prevTx: { [prev.getId()]: prev.toHex() } };
  const intent = (c: object): Intent => ({ ...(c as ReturnType<Awaited<ReturnType<typeof setup>>['common']>), network: 'dogecoin', chainRef: NETWORKS.dogecoin.chainRef,
    asset: 'native', symbol: 'DOGE', decimals: 8, amount: '10000000000', from, to, maxFee: '100000000',
    btc: { inputs: [{ txid: prev.getId(), vout: 0, value: '12000000000' }], change: '1997740000', fee: '2260000' } });

  it('signs a legacy transfer; bitcoinjs-lib verifies the input script and the amounts', async () => {
    const { sign, common, store } = await setup();
    const r = await sign(intent(common()), aux);
    const tx = bitcoin.Transaction.fromHex(r.raw);
    expect(tx.getId()).toBe(r.txid);
    expect(tx.ins.length).toBe(1);
    const [sigWithType, pub] = bitcoin.script.decompile(tx.ins[0]!.script) as [Uint8Array, Uint8Array];
    expect(bitcoin.payments.p2pkh({ pubkey: pub, network: DOGE_JS }).address).toBe(from);
    const { signature, hashType } = bitcoin.script.signature.decode(sigWithType);
    expect(hashType).toBe(bitcoin.Transaction.SIGHASH_ALL);
    expect(secp256k1.verify(signature, tx.hashForSignature(0, lock, hashType), pub, { prehash: false, lowS: true })).toBe(true);
    expect(tx.outs.map((o) => [bitcoin.address.fromOutputScript(o.script, DOGE_JS), o.value])).toEqual([[to, 10_000_000_000n], [from, 1_997_740_000n]]);
    expect(12_000_000_000n - tx.outs.reduce((s, o) => s + o.value, 0n)).toBe(2_260_000n);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
  });

  it('refuses: no previous transaction, a forged one, an inflated input, foreign addresses, limits', async () => {
    const { sign, common } = await setup();
    await expect(sign(intent(common()))).rejects.toThrow(/previous transaction/);
    const forged = new bitcoin.Transaction();
    forged.version = 1;
    forged.addInput(new Uint8Array(32).fill(3), 4, 0xffffffff, Uint8Array.of(0x51));
    forged.addOutput(lock, 13_000_000_000n);
    await expect(sign(intent(common()), { prevTx: { [prev.getId()]: forged.toHex() } })).rejects.toThrow(/does not match input txid/);
    const inflated = intent(common());
    inflated.btc = { inputs: [{ txid: prev.getId(), vout: 0, value: '13000000000' }], change: '2997740000', fee: '2260000' };
    await expect(sign(inflated, aux)).rejects.toThrow(/does not match the approved input/);
    await expect(sign({ ...intent(common()), to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }, aux)).rejects.toThrow();
    await expect(sign({ ...intent(common()), to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, aux)).rejects.toThrow();
    await expect(sign({ ...intent(common()), to: from }, aux)).rejects.toThrow(/destination equals source/);
    await expect(sign({ ...intent(common()), from: to }, aux)).rejects.toThrow(/source/);
    await expect(sign({ ...intent(common()), chainRef: NETWORKS.litecoin.chainRef }, aux)).rejects.toThrow(/chain/);
    await expect(sign({ ...intent(common()), maxFee: '100000001' }, aux)).rejects.toThrow(/fee ceiling/);
    await expect(sign({ ...intent(common()), amount: '70000000001' }, aux)).rejects.toThrow(/per-transaction/);
    await sign(intent(common()), aux); // still usable after refusals
  });
});

describe('Bitcoin Cash through the signer', () => {
  const from = keys.addresses.bitcoincash!, to = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
  const inputs = [{ txid: 'cd'.repeat(32), vout: 0, value: 400_000n }, { txid: 'ef'.repeat(32), vout: 3, value: 100_000n }];
  const intent = (c: object): Intent => ({ ...(c as ReturnType<Awaited<ReturnType<typeof setup>>['common']>), network: 'bitcoincash', chainRef: NETWORKS.bitcoincash.chainRef,
    asset: 'native', symbol: 'BCH', decimals: 8, amount: '450000', from, to, maxFee: '50000',
    x: { inputs: encodeBchInputs(inputs), change: '49600', fee: '400' } });
  const vm = createVirtualMachineBCH(true);
  const lockOf = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === 'string') throw new Error(r); return r.bytecode; };

  it('signs a transfer that libauth\'s virtual machine accepts under standard rules', async () => {
    const { sign, common, store } = await setup();
    const r = await sign(intent(common()));
    expect(hashTransaction(hex.decode(r.raw))).toBe(r.txid);
    const tx = decodeTransaction(hex.decode(r.raw));
    if (typeof tx === 'string') throw new Error(tx);
    expect(tx.outputs.map((o) => [hex.encode(o.lockingBytecode), o.valueSatoshis])).toEqual([[hex.encode(lockOf(to)), 450_000n], [hex.encode(lockOf(from)), 49_600n]]);
    const sourceOutputs = inputs.map((u) => ({ lockingBytecode: lockOf(from), valueSatoshis: u.value }));
    expect(vm.verify({ transaction: tx, sourceOutputs })).toBe(true);
    expect(vm.verify({ transaction: tx, sourceOutputs: [{ ...sourceOutputs[0]!, valueSatoshis: 400_001n }, sourceOutputs[1]!] })).not.toBe(true);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
  });

  it('refuses: unbalanced inputs, fee above the ceiling, unknown parameters, foreign or legacy-form addresses, replay', async () => {
    const { sign, common } = await setup();
    const x = intent(common()).x!;
    await expect(sign({ ...intent(common()), x: { ...x, fee: '401' } })).rejects.toThrow(/inputs != outputs/);
    await expect(sign({ ...intent(common()), maxFee: '399' })).rejects.toThrow(/fee exceeds/);
    await expect(sign({ ...intent(common()), maxFee: '50001' })).rejects.toThrow(/fee ceiling/);
    await expect(sign({ ...intent(common()), x: { ...x, locktime: '5' } })).rejects.toThrow(/unknown or missing/);
    await expect(sign({ ...intent(common()), to: '1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR' })).rejects.toThrow(/not normalized/);
    await expect(sign({ ...intent(common()), to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' })).rejects.toThrow();
    await expect(sign({ ...intent(common()), to: from })).rejects.toThrow(/destination equals source/);
    await expect(sign({ ...intent(common()), from: to })).rejects.toThrow(/source/);
    await expect(sign({ ...intent(common()), chainRef: NETWORKS.bitcoin.chainRef })).rejects.toThrow(/chain/);
    await expect(sign({ ...intent(common()), amount: '20000001' })).rejects.toThrow(/per-transaction/);
    const { x: _x, ...noSection } = intent(common());
    await expect(sign({ ...noSection, btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '500000' }], change: '49600', fee: '400' } } as Intent)).rejects.toThrow(/chain section/);
    const ok = intent(common());
    await sign(ok);
    await expect(sign(ok)).rejects.toThrow(/already signed/);
  });
});
