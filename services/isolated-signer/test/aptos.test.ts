/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/aptos.test.ts
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

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Account, Deserializer, SignedTransaction, TransactionAuthenticatorEd25519, TransactionPayloadEntryFunction, generateSigningMessage } from '@aptos-labs/ts-sdk';
import { aptosRawBytes, aptosTxid, intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds of ours, never used outside tests.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeys(MNEMONIC);
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const DEST = Account.fromDerivationPath({ path: "m/44'/637'/1'/0'/0'", mnemonic: MNEMONIC, legacy: true }).accountAddress.toStringLong();

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-apt-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { store, signer, pk, t };
}
let n = 0;
const apt = (t: number, over: Partial<Intent> = {}): Intent => ({
  v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 4,
  network: 'aptos', chainRef: NETWORKS.aptos.chainRef, asset: 'native', symbol: 'APT', decimals: 8, amount: '250000000', from: keys.addresses.aptos!, to: DEST, maxFee: '812200',
  x: { sequence_number: '7', max_gas_amount: '8122', gas_unit_price: '100', expiration_timestamp_secs: String(t + 180) }, ...over,
});

describe('aptos through the signer', () => {
  it("derives the Petra / official SDK account from the mnemonic (m/44'/637'/0'/0'/0')", () => {
    expect(keys.addresses.aptos).toBe('0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf');
    expect(keys.addresses.aptos).toBe(Account.fromDerivationPath({ path: "m/44'/637'/0'/0'/0'", mnemonic: MNEMONIC, legacy: true }).accountAddress.toStringLong());
  });

  it('signs an approved APT transfer; the official SDK decodes it and verifies the signature', async () => {
    const { signer, pk, t, store } = await setup();
    const i = apt(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const bytes = aptosRawBytes(r.raw);
    expect(r.txid).toBe(aptosTxid(bytes));
    const d = new Deserializer(bytes), tx = SignedTransaction.deserialize(d);
    expect(d.remaining()).toBe(0);
    const raw = tx.raw_txn, ef = (raw.payload as TransactionPayloadEntryFunction).entryFunction;
    expect([raw.sender.toStringLong(), raw.sequence_number, raw.max_gas_amount, raw.gas_unit_price, raw.expiration_timestamp_secs, raw.chain_id.chainId]).toEqual([i.from, 7n, 8122n, 100n, BigInt(t + 180), 1]);
    expect([ef.module_name.address.toString(), ef.module_name.name.identifier, ef.function_name.identifier, ef.type_args.length, ef.args.length]).toEqual(['0x1', 'aptos_account', 'transfer', 0, 2]);
    expect('0x' + Buffer.from(ef.args[0]!.bcsToBytes()).toString('hex')).toBe(DEST);
    expect(Buffer.from(ef.args[1]!.bcsToBytes()).readBigUInt64LE()).toBe(250_000_000n);
    const auth = tx.authenticator as TransactionAuthenticatorEd25519;
    expect(tx.authenticator).toBeInstanceOf(TransactionAuthenticatorEd25519);
    expect(auth.public_key.authKey().derivedAddress().toStringLong()).toBe(keys.addresses.aptos);
    expect(auth.public_key.verifySignature({ message: generateSigningMessage(raw.bcsToBytes(), 'APTOS::RawTransaction'), signature: auth.signature })).toBe(true);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
  });

  it('an approval cannot be reused for other transaction parameters', async () => {
    const { signer, pk, t } = await setup();
    const ok = apt(t);
    for (const x of [{ sequence_number: '8' }, { max_gas_amount: '8121' }, { max_gas_amount: '8000', gas_unit_price: '101' }, { expiration_timestamp_secs: String(t + 181) }]) {
      const swapped = { ...ok, x: { ...ok.x!, ...x } };
      await expect(signer.sign(swapped, pk.assert(intentHash(ok))), JSON.stringify(x)).rejects.toThrow(/approval/);
    }
  });

  it('refuses unsupported or out-of-policy Aptos intents before looking at the approval', async () => {
    const { signer, pk, t } = await setup();
    const cases: [Partial<Intent>, RegExp][] = [
      [{ chainRef: '2' }, /chain identity/],
      [{ from: DEST }, /not controlled/],
      [{ to: keys.addresses.aptos! }, /equals source/],
      [{ to: '0x' + DEST.slice(2).toUpperCase() }, /Aptos address/],
      [{ to: '0x' + '0'.repeat(63) + '1' }, /reserved/],
      [{ asset: '0x1::aptos_coin::AptosCoin' }, /native/],
      [{ memo: 'hello' }, /no memo/],
      [{ x: { ...apt(t).x!, max_gas_amount: '8123' } }, /above approved maximum/],
      [{ x: { ...apt(t).x!, gas_unit_price: '99' } }, /range/],
      [{ x: { ...apt(t).x!, function: '0x1::coin::transfer' } }, /unknown or missing/],
      [{ x: { ...apt(t).x!, expiration_timestamp_secs: String(t + 3600) } }, /too far/],
      [{ amount: '8800000001' }, /per-transaction limit/], // default cap: 88 APT
      [{ maxFee: '10000100', x: { ...apt(t).x!, max_gas_amount: '100001' } }, /fee ceiling/],
    ];
    for (const [over, re] of cases) { const i = apt(t, over); await expect(signer.sign(i, pk.assert(intentHash(i))), JSON.stringify(over)).rejects.toThrow(re); }
  });
});
