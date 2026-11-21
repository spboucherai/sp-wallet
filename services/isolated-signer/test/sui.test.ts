/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/sui.test.ts
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
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { intentHash, NETWORKS, suiParseRaw, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeys(MNEMONIC);
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const DEST = Ed25519Keypair.deriveKeypair(MNEMONIC, "m/44'/784'/1'/0'/0'").toSuiAddress();
const COIN = `0x${'1a'.repeat(32)}:1065912677:D5PWuxMQiHxxTp77DehNKAn4mNsUw8ifDwA7Efd5GVVg`;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-sui-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { store, signer, pk, t };
}
let n = 0;
const sui = (t: number, over: Partial<Intent> = {}): Intent => ({
  v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 4,
  network: 'sui', chainRef: NETWORKS.sui.chainRef, asset: 'native', symbol: 'SUI', decimals: 9, amount: '2500000000', from: keys.addresses.sui!, to: DEST, maxFee: '4152000',
  x: { payment: COIN, gasPrice: '100', gasBudget: '4152000', expiration: '1308' }, ...over,
});

describe('sui through the signer', () => {
  it("derives the address of the official SDK from the mnemonic (m/44'/784'/0'/0'/0')", () => {
    expect(keys.addresses.sui).toBe(Ed25519Keypair.deriveKeypair(MNEMONIC).toSuiAddress());
    expect(keys.addresses.sui).toBe('0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1');
  });

  it('signs an approved SUI payment; the official SDK decodes it and verifies the signature', async () => {
    const { signer, pk, t, store } = await setup();
    const i = sui(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const { tx, signature, txid } = suiParseRaw(r.raw);
    expect(txid).toBe(r.txid);
    expect(await Transaction.from(tx).getDigest()).toBe(r.txid);
    const v1 = bcs.TransactionData.parse(tx).V1!;
    expect([v1.sender, v1.gasData.owner, v1.gasData.price, v1.gasData.budget, v1.expiration.Epoch]).toEqual([i.from, i.from, '100', '4152000', 1308]);
    expect(v1.gasData.payment).toEqual([{ objectId: '0x' + '1a'.repeat(32), version: '1065912677', digest: 'D5PWuxMQiHxxTp77DehNKAn4mNsUw8ifDwA7Efd5GVVg' }]);
    const ptb = v1.kind.ProgrammableTransaction!;
    expect(ptb.inputs.map((x) => x.Pure?.bytes)).toEqual([Buffer.from(bcs.u64().serialize(2_500_000_000n).toBytes()).toString('base64'), Buffer.from(bcs.Address.serialize(DEST).toBytes()).toString('base64')]);
    expect(ptb.commands.map((c) => c.$kind)).toEqual(['SplitCoins', 'TransferObjects']);
    const who = await verifyTransactionSignature(tx, Buffer.from(signature).toString('base64'), { address: keys.addresses.sui! });
    expect(who.toSuiAddress()).toBe(i.from);
    // identical to the SDK signing the same bytes with the same mnemonic
    expect((await Ed25519Keypair.deriveKeypair(MNEMONIC).signTransaction(tx)).signature).toBe(Buffer.from(signature).toString('base64'));
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
  });

  it('an approval cannot be reused for other gas coins, another budget or another epoch', async () => {
    const { signer, pk, t } = await setup();
    const i = sui(t);
    for (const x of [{ payment: COIN.replace(':1065912677:', ':1065912678:') }, { gasBudget: '4151999' }, { expiration: '1309' }, { gasPrice: '101' }])
      await expect(signer.sign({ ...i, x: { ...i.x!, ...x } }, pk.assert(intentHash(i)))).rejects.toThrow(/approval/);
  });

  it('refuses unsupported or out-of-policy Sui intents before looking at the approval', async () => {
    const { signer, pk, t } = await setup();
    const cases: [Partial<Intent>, RegExp][] = [
      [{ chainRef: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }, /chain identity/],
      [{ from: DEST }, /not controlled/],
      [{ to: keys.addresses.sui! }, /equals source/],
      [{ to: '0x' + DEST.slice(2).toUpperCase() }, /Sui address/],
      [{ to: '0x' + '0'.repeat(63) + '5' }, /reserved/],
      [{ asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' }, /native/],
      [{ memo: '42' }, /memo/],
      [{ x: { ...sui(t).x!, gasBudget: '4152001' } }, /above approved maximum/],
      [{ x: { ...sui(t).x!, sponsor: DEST } }, /unknown or missing/],
      [{ x: { ...sui(t).x!, payment: `${COIN},${COIN}` } }, /duplicate/],
      [{ amount: '60000000001' }, /per-transaction limit/], // default cap: 60 SUI
      [{ maxFee: '50000001', x: { ...sui(t).x!, gasBudget: '50000001' } }, /fee ceiling/],
    ];
    for (const [over, re] of cases) { const i = sui(t, over); await expect(signer.sign(i, pk.assert(intentHash(i))), JSON.stringify(over)).rejects.toThrow(re); }
  });
});
