/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/cardano.test.ts
 * Module           : services
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

// Cardano through the real Signer, and the BIP32-Ed25519 key derivation (CIP-1852 / Icarus) against published vectors and the
// official cardano-serialization-lib: master key, child keys, public keys, signatures, addresses.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { cardanoBaseAddress, cardanoFormatInputs, CARDANO_SLOT_ZERO_UNIX, intentHash, NETWORKS, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveChild, derivePath, icarusMasterKey, xprvPublicKey, xprvSign } from '../src/bip32-ed25519.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const H = 0x80000000;
const DEST = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x'; // CIP-19 test vector
const IN = { txid: 'd805937a8b98ac498a4e116c820bbc3fa316e8774583cf0468eea9223304c299', index: 0, value: 50_000_000n };

describe('BIP32-Ed25519 (CIP-1852, Icarus master key)', () => {
  it('reproduces the CIP-3 master key vector, with and without a passphrase', () => {
    // https://github.com/cardano-foundation/CIPs/blob/master/CIP-0003/Icarus.md
    const entropy = mnemonicToEntropy('eight country switch draw meat scout mystery blade tip drift useless good keep usage title', wordlist);
    const m = icarusMasterKey(entropy);
    expect(hex(m.kL) + hex(m.kR) + hex(m.chainCode)).toBe('c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620');
    const p = icarusMasterKey(entropy, new TextEncoder().encode('foo'));
    expect(hex(p.kL) + hex(p.kR) + hex(p.chainCode)).toBe('70531039904019351e1afb361cd1b312a4d0565d4ff9f8062d38acf4b15cce41d7b5738d9c893feea55512a3004acb0d222c35d3e3d5cde943a15a9824cbac59443cf67e589614076ba01e354b1a432e0e6db3b59e37fc56b5fb0222970a010e');
    expect(() => icarusMasterKey(new Uint8Array(15))).toThrow(/entropy/);
  });

  it('derives the addresses mainstream wallets publish for their test mnemonics', () => {
    const addr = (mnemonic: string, account = 0) => {
      const m = icarusMasterKey(mnemonicToEntropy(mnemonic, wordlist));
      return cardanoBaseAddress(xprvPublicKey(derivePath(m, `m/1852'/1815'/${account}'/0/0`)), xprvPublicKey(derivePath(m, `m/1852'/1815'/${account}'/2/0`)));
    };
    // Trust Wallet, wallet-core CoinAddressDerivationTests.kt (CARDANO)
    expect(addr('shoot island position soft burden budget tooth cruel issue economy destroy above')).toBe('addr1qyr8jjfnypp95eq74aqzn7ss687ehxclgj7mu6gratmg3mul2040vt35dypp042awzsjk5xm3zr3zm5qh7454uwdv08s84ray2');
    // Trezor firmware, common/tests/fixtures/cardano/get_base_address.json (account 4)
    expect(addr('all all all all all all all all all all all all', 4)).toBe('addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990');
    // CIP-19 / cardano-serialization-lib documentation: the payment key of "test walk nut penalty …" is the CIP-19 vector key addr_vk1w0l2sr2z…
    const cip19 = icarusMasterKey(mnemonicToEntropy('test walk nut penalty hip pave soap entry language right filter choice', wordlist));
    expect(hex(xprvPublicKey(derivePath(cip19, "m/1852'/1815'/0'/0/0")))).toBe('73fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d');
    expect(keys.addresses.cardano).toBe(addr(TEST_MNEMONIC));
    expect(keys.addresses.cardano).toBe('addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv');
  });

  it('matches the official library key for key: extended private keys, public keys, signatures (hardened and soft steps)', () => {
    for (const mnemonic of [TEST_MNEMONIC, 'all all all all all all all all all all all all', 'eight country switch draw meat scout mystery blade tip drift useless good keep usage title',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art']) {
      const entropy = mnemonicToEntropy(mnemonic, wordlist);
      let sdk = CSL.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array(0)), mine = icarusMasterKey(entropy);
      expect(hex(mine.kL) + hex(mine.kR) + hex(mine.chainCode)).toBe(hex(sdk.as_bytes()));
      for (const index of [H + 1852, H + 1815, H, 0, 0, 7, H + 3, 2, 0x7fffffff, H + 0x7fffffff]) {
        sdk = sdk.derive(index); mine = deriveChild(mine, index);
        expect(hex(mine.kL) + hex(mine.kR) + hex(mine.chainCode)).toBe(hex(sdk.as_bytes()));
        expect(hex(xprvPublicKey(mine))).toBe(hex(sdk.to_public().to_raw_key().as_bytes()));
      }
      const msg = new TextEncoder().encode('cardano ' + mnemonic.slice(0, 9));
      const sig = xprvSign(mine, msg);
      expect(hex(sig)).toBe(sdk.to_raw_key().sign(msg).to_hex());
      expect(ed25519.verify(sig, msg, xprvPublicKey(mine))).toBe(true);
    }
  });

  it('agrees with the official library on random entropy and random paths', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.array(fc.integer({ min: 0, max: 0xffffffff }), { minLength: 1, maxLength: 6 }), fc.uint8Array({ minLength: 0, maxLength: 80 }), (entropy, path, msg) => {
      let sdk = CSL.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array(0)), mine = icarusMasterKey(entropy);
      for (const index of path) { sdk = sdk.derive(index); mine = deriveChild(mine, index); }
      expect(hex(mine.kL) + hex(mine.kR) + hex(mine.chainCode)).toBe(hex(sdk.as_bytes()));
      expect(hex(xprvPublicKey(mine))).toBe(hex(sdk.to_public().to_raw_key().as_bytes()));
      expect(hex(xprvSign(mine, msg))).toBe(sdk.to_raw_key().sign(msg).to_hex());
    }), { numRuns: 40 });
    expect(() => derivePath(icarusMasterKey(new Uint8Array(16)), "m/1852'/x")).toThrow(/path/);
    expect(() => deriveChild(icarusMasterKey(new Uint8Array(16)), -1)).toThrow(/index/);
  });

  it('adding Cardano and Polkadot does not change the wallet key id or any existing address', () => {
    // the key id is bound to the EVM, Bitcoin and Solana addresses only
    expect(keys.addresses.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(keys.addresses.btc).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(keys.addresses.sol).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    expect(keys.keyId).toBe('spw-' + createHash('sha256').update('0x9858EfFD232B4033E47d90003D41EC34EcaEda94|bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu|HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk').digest('hex').slice(0, 16));
    expect(keys.addresses.cosmos).toBe('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4');
    expect(keys.addresses.sui).toBe('0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1');
    expect(Object.keys(keys.addresses).sort()).toEqual([...Object.keys(NETWORKS), 'btc', 'evm', 'sol'].sort());
  });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-cardano-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { signer, pk, t };
}
let seq = 0;
const intent = (t: number, over: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120,
  policyVersion: 4, network: 'cardano', chainRef: NETWORKS.cardano.chainRef, asset: 'native', symbol: 'ADA', decimals: 6, amount: '2500000', from: keys.addresses.cardano!, to: DEST, maxFee: '169021',
  x: { inputs: cardanoFormatInputs([IN]), fee: '169021', change: '47330979', ttl: String(t - CARDANO_SLOT_ZERO_UNIX + 900) }, ...over });

describe('Cardano through the signer', () => {
  it('signs an approved ADA payment that the official library decodes and whose witness is the payment key of the wallet address', async () => {
    const { signer, pk, t } = await setup();
    const i = intent(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const tx = CSL.Transaction.from_hex(r.raw);
    expect(tx.to_hex()).toBe(r.raw);
    expect(CSL.FixedTransaction.from_hex(r.raw).transaction_hash().to_hex()).toBe(r.txid);
    const body = tx.body();
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex() + '#' + body.inputs().get(0).index()).toBe(`${IN.txid}#0`);
    expect(body.outputs().len()).toBe(2);
    expect([body.outputs().get(0).address().to_bech32(), body.outputs().get(0).amount().coin().to_str()]).toEqual([DEST, '2500000']);
    expect([body.outputs().get(1).address().to_bech32(), body.outputs().get(1).amount().coin().to_str()]).toEqual([keys.addresses.cardano, '47330979']);
    expect(body.fee().to_str()).toBe('169021');
    expect(body.ttl_bignum()!.to_str()).toBe(i.x!.ttl);
    expect(body.certs()).toBeUndefined();
    expect(body.withdrawals()).toBeUndefined();
    expect(body.mint()).toBeUndefined();
    const w = tx.witness_set().vkeys()!;
    expect(w.len()).toBe(1);
    // the witness key hashes to the payment credential of the wallet's own address, and the signature verifies in the official library
    const cred = CSL.BaseAddress.from_address(CSL.Address.from_bech32(keys.addresses.cardano!))!.payment_cred().to_keyhash()!.to_hex();
    expect(w.get(0).vkey().public_key().hash().to_hex()).toBe(cred);
    expect(w.get(0).vkey().public_key().verify(Buffer.from(r.txid, 'hex'), w.get(0).signature())).toBe(true);
    // the same transaction signed by the official library with the key it derives itself from the mnemonic: identical bytes
    const acct = CSL.Bip32PrivateKey.from_bip39_entropy(mnemonicToEntropy(TEST_MNEMONIC, wordlist), new Uint8Array(0)).derive(H + 1852).derive(H + 1815).derive(H);
    const sdkWitness = CSL.make_vkey_witness(CSL.TransactionHash.from_hex(r.txid), acct.derive(0).derive(0).to_raw_key());
    expect(sdkWitness.to_hex()).toBe(w.get(0).to_hex());
  });

  it('refuses everything else', async () => {
    const { signer, pk, t } = await setup();
    const tryIt = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
    const good = intent(t);
    const approval = pk.assert(intentHash(good));
    await expect(signer.sign({ ...good, amount: '2500001', x: { ...good.x!, change: '47330978' } }, approval)).rejects.toThrow(/approval/); // approval bound to other fields
    await expect(signer.sign({ ...good, to: 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8' }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...good.x!, ttl: String(Number(good.x!.ttl) + 1) } }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...good.x!, inputs: cardanoFormatInputs([{ ...IN, index: 1 }]) } }, approval)).rejects.toThrow(/approval/);
    await expect(tryIt(intent(t, { amount: '285000001', x: { ...good.x!, inputs: cardanoFormatInputs([{ ...IN, value: 300_000_000n }]), change: '14830978' } }))).rejects.toThrow(/per-transaction/);
    await expect(tryIt(intent(t, { maxFee: '500001', x: { ...good.x!, fee: '500001', change: '46999999' } }))).rejects.toThrow(/fee ceiling/);
    await expect(tryIt(intent(t, { x: { ...good.x!, fee: '169022', change: '47330978' } }))).rejects.toThrow(/approved maximum/);
    await expect(tryIt(intent(t, { x: { ...good.x!, change: '47330980' } }))).rejects.toThrow(/inputs do not equal/);
    await expect(tryIt(intent(t, { x: { ...good.x!, ttl: String(t - CARDANO_SLOT_ZERO_UNIX + 7201) } }))).rejects.toThrow(/too long/);
    await expect(tryIt(intent(t, { x: { ...good.x!, ttl: String(t - CARDANO_SLOT_ZERO_UNIX) } }))).rejects.toThrow(/already closed/);
    await expect(tryIt(intent(t, { chainRef: '1' }))).rejects.toThrow(/chain/);
    await expect(tryIt(intent(t, { from: DEST, to: keys.addresses.cardano! }))).rejects.toThrow(/not controlled|does not control/);
    await expect(tryIt(intent(t, { to: keys.addresses.cardano! }))).rejects.toThrow(/destination equals source/);
    await expect(tryIt(intent(t, { to: 'addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx' }))).rejects.toThrow(/script addresses/);
    await expect(tryIt(intent(t, { to: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae' }))).rejects.toThrow(/address/);
    await expect(tryIt(intent(t, { asset: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344' }))).rejects.toThrow(/only native ADA/);
    await expect(tryIt(intent(t, { memo: 'hello' }))).rejects.toThrow(/memo/);
    await expect(tryIt(intent(t, { x: { ...good.x!, metadata: '674' } }))).rejects.toThrow(/unknown or missing/);
    expect(() => tryIt(intent(t, { x: undefined }))).toThrow(/chain section/); // no approval can even be formed
    await expect(signer.sign(good, approval, { prevTx: {} })).rejects.toThrow(/helper data/);
    const r = await signer.sign(good, approval); // still usable, and only once
    expect(CSL.Transaction.from_hex(r.raw).witness_set().vkeys()!.len()).toBe(1);
    await expect(signer.sign(good, pk.assert(intentHash(good)))).rejects.toThrow(/already signed/);
  });
});
