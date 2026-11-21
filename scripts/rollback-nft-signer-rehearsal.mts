/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/rollback-nft-signer-rehearsal.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// Rollback rehearsal of the SIGNER for NFT delivery 2 (docs/nft/NFT-TRANSFERS.md §9, docs/runbooks/deploy.md), with the signer
// code of BOTH versions in one process, on the same directories, one after the other — as two deployments would be.
//
//   npx tsx scripts/rollback-nft-signer-rehearsal.mts <path of a checkout of the previous release (branch nft or v11)>
//
//   Part A  an ordinary BTC send, no lock anywhere: the previous code and this code sign the SAME BYTES for the same intent
//           (the lock check added to `sign` changes nothing when the list is empty).
//   Part B  this code signs an NFT transfer, locks an outpoint and allows a destination (new state fields) → the PREVIOUS code
//           opens that directory, signs, saves → this code opens it again. What survives, and what the previous code does
//           NOT enforce (it signs a send that spends the locked outpoint): the reason for the rollback rule.
//   Part C  policy.json: the file this version leaves in place is read by the previous code; a file to which the operator
//           added an `nft` key is refused by the previous code at start.
//
// No network, no real key (the public BIP-39 test mnemonic), a software passkey, temporary directories only. Prints what it
// observed and exits 1 if an observation differs from what the documents state.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { intentHash, NETWORKS, nftAllowHash, nftIntentHash, utxoLockHash, type Intent, type NftAllowIntent, type NftIntent, type UtxoLockIntent } from '@spw/core';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const OLD = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(join(OLD, 'services/isolated-signer/src/signer.ts'))) { console.error('usage: rollback-nft-signer-rehearsal.mts <checkout of the previous release>'); process.exit(2); }
if (existsSync(join(OLD, 'services/isolated-signer/src/nft.ts'))) { console.error('that checkout already contains NFT delivery 2: give a checkout of the release before it'); process.exit(2); }
const old = async (rel: string): Promise<any> => import(pathToFileURL(join(OLD, rel)).href); // eslint-disable-line @typescript-eslint/no-explicit-any
const { Signer: OldSigner } = await old('services/isolated-signer/src/signer.ts'), { Store: OldStore } = await old('services/isolated-signer/src/store.ts'), { deriveKeys: oldDeriveKeys } = await old('services/isolated-signer/src/keys.ts');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', keys = deriveKeys(MNEMONIC), oldKeys = oldDeriveKeys(MNEMONIC), T = 1_800_000_000;
let failed = 0;
const say = (s: string): void => console.log(s);
const check = (what: string, got: unknown, want: unknown): void => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed += 1; say(`  ${ok ? 'as documented' : 'DIFFERS     '}  ${what}: ${JSON.stringify(got)}${ok ? '' : ` (documented: ${JSON.stringify(want)})`}`); };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'SIGNED'; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message.slice(0, 60)); } };
const dirOf = () => { const d = mkdtempSync(join(tmpdir(), 'spw-nft-rollback-')); return { d, state: join(d, 'state.json'), policy: join(d, 'policy.json') }; };
const setupToken = (store: { state: { setupTokenHash: string | null } }) => { store.state.setupTokenHash = sha('setup-token'); };
const btc = (id: string, inputs: { txid: string; vout: number; value: string }[]): Intent => { const total = inputs.reduce((s, x) => s + BigInt(x.value), 0n);
  return { v: 1, proposalId: id, keyId: keys.keyId, network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '20000', from: keys.addresses.btc, to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    maxFee: '5000', createdAt: T, expiresAt: T + 120, policyVersion: 4, btc: { inputs, change: (total - 21000n).toString(), fee: '1000' } }; };
const INSCRIPTION = { txid: 'ab'.repeat(32), vout: 0 }, COIN = { txid: 'cd'.repeat(32), vout: 1 };

say(`previous release: ${OLD}`);
check('same key id from both versions', oldKeys.keyId, keys.keyId);

say('\nPart A — an ordinary BTC send with an empty lock list: both versions sign the same bytes');
{
  const a = dirOf(), b = dirOf(), pk = new TestPasskey(RP, ORIGIN);
  const sNew = new Store(a.state, a.policy), sOld = new OldStore(b.state, b.policy);
  setupToken(sNew); setupToken(sOld);
  const now = new Signer(keys, sNew, { rpId: RP, origin: ORIGIN }, () => T), before = new OldSigner(oldKeys, sOld, { rpId: RP, origin: ORIGIN }, () => T);
  await now.enroll({ credential: pk.credential(), setupToken: 'setup-token' }); await before.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  const i = btc('6f1c1f0e-8f5f-4b1e-9c56-0000000b7c01', [{ ...COIN, value: '50000' }, { ...INSCRIPTION, value: '546' }]);
  const r1 = await now.sign(i, pk.assert(intentHash(i))), r0 = await before.sign(i, pk.assert(intentHash(i)));
  check('raw transaction of this version = raw transaction of the previous version', r1.raw === r0.raw, true);
  check('txid', r1.txid, r0.txid);
  say(`      txid ${r1.txid}   sha256(raw) ${sha(r1.raw)}   (pinned in services/isolated-signer/test/nft.test.ts)`);
  check('policy.json written by a new installation is byte-identical in both versions', sha(readFileSync(a.policy)), sha(readFileSync(b.policy)));
}

say('\nPart B — state written by this version, opened by the previous one, then by this one again');
{
  const p = dirOf(), pk = new TestPasskey(RP, ORIGIN);
  const s1 = new Store(p.state, p.policy); setupToken(s1);
  const v2 = new Signer(keys, s1, { rpId: RP, origin: ORIGIN }, () => T);
  await v2.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  const nft: NftIntent = { v: 1, kind: 'nft-transfer', proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0000000000b1', keyId: keys.keyId, network: 'ethereum', chainRef: '1', standard: 'erc721', asset: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', tokenId: '1', quantity: '1',
    program: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', from: keys.addresses.evm, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', maxFee: '3000000000000000', createdAt: T, expiresAt: T + 120, policyVersion: 4, nftPolicyVersion: 1,
    evm: { nonce: 0, gasLimit: '150000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } };
  await v2.nftSign(nft, pk.assert(nftIntentHash(nft)));
  const lock: UtxoLockIntent = { v: 1, kind: 'utxo-locks', requestId: '6f1c1f0e-8f5f-4b1e-9c56-0000000000b2', keyId: keys.keyId, network: 'bitcoin', action: 'lock', reason: 'owner', outpoints: [INSCRIPTION], createdAt: T, expiresAt: T + 120, policyVersion: 4 };
  await v2.utxoLocks(lock, pk.assert(utxoLockHash(lock)));
  const allow: NftAllowIntent = { v: 1, kind: 'nft-allow', requestId: '6f1c1f0e-8f5f-4b1e-9c56-0000000000b3', keyId: keys.keyId, network: 'ethereum', action: 'add', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', createdAt: T, expiresAt: T + 120, policyVersion: 4 };
  await v2.nftAllow(allow, pk.assert(nftAllowHash(allow)));
  const spend = btc('6f1c1f0e-8f5f-4b1e-9c56-0000000000b4', [{ ...INSCRIPTION, value: '30000' }]);
  check('this version refuses to spend the locked outpoint', await codeOf(v2.sign(spend, pk.assert(intentHash(spend)))), 'utxo_locked');
  const written = JSON.parse(readFileSync(p.state, 'utf8'));
  check('state written by this version — new optional fields', Object.keys(written).filter((k) => ['nftDaily', 'nftAllow', 'utxoLocks'].includes(k)).sort(), ['nftAllow', 'nftDaily', 'utxoLocks']);
  const headBefore = s1.journalHead()!.seq;

  // rollback: the previous binary on the same directory
  let sOld: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { sOld = new OldStore(p.state, p.policy); check('the previous code opens the state and the policy written by this version', true, true); }
  catch (e) { check('the previous code opens the state and the policy written by this version', (e as Error).message.slice(0, 120), true); throw e; }
  const v1 = new OldSigner(oldKeys, sOld, { rpId: RP, origin: ORIGIN }, () => T + 10);
  check('previous code: credentials, halt and replay markers are the ones this version saved', [sOld.state.credentials.length, sOld.state.halted, Object.keys(sOld.state.used).length], [1, false, 3]);
  check('previous code: an NFT intent is not something it signs (no route, and `sign` refuses it)', await codeOf(v1.sign(nft, pk.assert(nftIntentHash(nft)))), 'bad_request');
  const spendOld = btc('6f1c1f0e-8f5f-4b1e-9c56-0000000000b5', [{ ...INSCRIPTION, value: '30000' }]);
  const spendOldAt = { ...spendOld, createdAt: T + 10, expiresAt: T + 130 };
  check('previous code: it DOES sign a send that spends the outpoint this version locked (it does not know the list)', await codeOf(v1.sign(spendOldAt, pk.assert(intentHash(spendOldAt)))), 'SIGNED');
  const afterOld = JSON.parse(readFileSync(p.state, 'utf8'));
  check('the new fields are still on disk after the previous code saved', [afterOld.utxoLocks, afterOld.nftAllow, afterOld.nftDaily], [written.utxoLocks, written.nftAllow, written.nftDaily]);

  // forward again
  const s3 = new Store(p.state, p.policy), v3 = new Signer(keys, s3, { rpId: RP, origin: ORIGIN }, () => T + 20);
  check('forward again: journal intact', s3.journalBrokenAt, null);
  check('forward again: the lock, the allowed destination and the day\'s count are in force again', [v3.status().utxoLocks, v3.status().nft.allow.length, v3.status().nft.signedToday], [{ bitcoin: [{ outpoint: `${INSCRIPTION.txid}:0`, reason: 'owner', at: T }] }, 1, 1]);
  const spendAgain = { ...btc('6f1c1f0e-8f5f-4b1e-9c56-0000000000b6', [{ ...INSCRIPTION, value: '30000' }]), createdAt: T + 20, expiresAt: T + 140 };
  check('forward again: the locked outpoint is refused again', await codeOf(v3.sign(spendAgain, pk.assert(intentHash(spendAgain)))), 'utxo_locked');
  check('forward again: the journal head moved on from the one this version left', s3.journalHead()!.seq > headBefore, true);
}

say('\nPart C — policy.json across the rollback');
{
  const p = dirOf();
  new Store(p.state, p.policy);
  const file = JSON.parse(readFileSync(p.policy, 'utf8'));
  check('the file this version writes has no NFT key', 'nft' in file, false);
  let opened = 'opened';
  try { new OldStore(p.state, p.policy); } catch (e) { opened = (e as Error).message.slice(0, 40); }
  check('the previous code reads it', opened, 'opened');
  writeFileSync(p.policy, JSON.stringify({ ...file, nft: { maxTransfersPerDay: 2 } }, null, 2));
  check('this version reads a file to which the operator added `nft`', new Signer(keys, new Store(p.state, p.policy), { rpId: RP, origin: ORIGIN }).status().nft.policy.maxTransfersPerDay, 2);
  let refused = false;
  try { new OldStore(p.state, p.policy); } catch { refused = true; }
  check('the previous code REFUSES TO START on a policy.json that carries an `nft` key (remove the key before rolling back)', refused, true);
}

say(failed ? `\n${failed} observation(s) differ from the documents` : '\nevery observation is as documented');
process.exit(failed ? 1 : 0);
