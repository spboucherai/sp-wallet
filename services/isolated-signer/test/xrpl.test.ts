/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/xrpl.test.ts
 * Module           : services
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

// XRP Ledger through the real Signer: passkey approval bound to the intent, plugin build + sign with the signer's key handle.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, verifySignature, Wallet } from 'xrpl';
import { intentHash, NETWORKS, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);
const DEST = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const X = { sequence: '5', lastLedgerSequence: '108249120', fee: '12' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-xrpl-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { signer, pk, t };
}
let seq = 0;
const intent = (t: number, over: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 45,
  policyVersion: 4, network: 'xrpl', chainRef: NETWORKS.xrpl.chainRef, asset: 'native', symbol: 'XRP', decimals: 6, amount: '3000000', from: keys.addresses.xrpl!, to: DEST, maxFee: '12',
  memo: '20261110', x: X, ...over });

describe('XRP Ledger through the signer', () => {
  it("derives the published m/44'/144'/0'/0/0 address of the test mnemonic", () => {
    expect(keys.addresses.xrpl).toBe('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3');
    expect(keys.addresses.xrpl).toBe(Wallet.fromMnemonic(TEST_MNEMONIC, { derivationPath: "m/44'/144'/0'/0/0" }).classicAddress);
  });

  it('signs an approved XRP payment that the official SDK decodes and verifies', async () => {
    const { signer, pk, t } = await setup();
    const i = intent(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    expect(verifySignature(r.raw)).toBe(true);
    const d = decode(r.raw) as Record<string, unknown>;
    expect(d).toMatchObject({ TransactionType: 'Payment', Account: keys.addresses.xrpl, Destination: DEST, Amount: '3000000', Fee: '12', Sequence: 5,
      LastLedgerSequence: 108249120, DestinationTag: 20261110, Flags: 0x80000000 });
    expect(Object.keys(d).length).toBe(11);
    const sdk = Wallet.fromMnemonic(TEST_MNEMONIC, { derivationPath: "m/44'/144'/0'/0/0" }).sign({ TransactionType: 'Payment', Account: i.from, Destination: DEST, Amount: '3000000', Fee: '12',
      Sequence: 5, LastLedgerSequence: 108249120, DestinationTag: 20261110, Flags: 0x80000000, SigningPubKey: String(d.SigningPubKey) });
    expect(r.raw).toBe(sdk.tx_blob);
    expect(r.txid).toBe(sdk.hash);
  });

  it('refuses everything else', async () => {
    const { signer, pk, t } = await setup();
    const tryIt = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
    const good = intent(t);
    const approval = pk.assert(intentHash(good));
    await expect(signer.sign({ ...good, amount: '3000001' }, approval)).rejects.toThrow(/approval/); // approval bound to other fields
    await expect(signer.sign({ ...good, memo: '1' }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...X, sequence: '6' } }, approval)).rejects.toThrow(/approval/);
    await expect(tryIt(intent(t, { amount: '47000001' }))).rejects.toThrow(/per-transaction/);
    await expect(tryIt(intent(t, { maxFee: '100001', x: { ...X, fee: '100001' } }))).rejects.toThrow(/fee ceiling/);
    await expect(tryIt(intent(t, { x: { ...X, fee: '13' } }))).rejects.toThrow(/approved maximum/);
    await expect(tryIt(intent(t, { chainRef: NETWORKS.bitcoin.chainRef }))).rejects.toThrow(/chain/);
    await expect(tryIt(intent(t, { from: DEST, to: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn' }))).rejects.toThrow(/source/);
    await expect(tryIt(intent(t, { to: keys.addresses.xrpl! }))).rejects.toThrow(/destination equals source/);
    await expect(tryIt(intent(t, { to: 'XVLhHMPHU98es4dbozjVtdWzVrDjtV5fdx1mHp98tDMoQXb' }))).rejects.toThrow(/X-addresses/);
    await expect(tryIt(intent(t, { asset: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }))).rejects.toThrow(/only native XRP/);
    await expect(tryIt(intent(t, { memo: '4294967296' }))).rejects.toThrow(/destination tag/);
    await expect(tryIt(intent(t, { x: { ...X, flags: '131072' } }))).rejects.toThrow(/unknown or missing/);
    expect(() => tryIt(intent(t, { x: undefined }))).toThrow(/chain section/); // no approval can even be formed
    await expect(signer.sign(intent(t, { x: undefined }), approval)).rejects.toThrow();
    await expect(signer.sign(good, approval, { prevTx: {} })).rejects.toThrow(/helper data/);
    const r = await signer.sign(good, approval); // still usable, and only once
    expect(verifySignature(r.raw)).toBe(true);
    await expect(signer.sign(good, pk.assert(intentHash(good)))).rejects.toThrow(/already signed/);
  });
});
