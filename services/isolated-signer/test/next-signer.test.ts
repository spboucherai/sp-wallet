/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/next-signer.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — the signer's part of the work package "isolated signer + credential life cycle" (docs/next/SP-WALLET-AUDIT.md §4):
//   P1  credential life cycle v2 (SPW-CRED-v2: add / revoke, single use, expiry, halt, last passkey, self-approval, cool-down)
//   C1  nothing unauthenticated or unfinished enters the queue; the halt never waits; a signature computed across a halt is withheld
//   C2  no network listen address without a source allowlist
//   C3  a daily cap on the passkey-less returns of one vault
//   K1  recovery hygiene: export / verification dates, `verify-recovery` (terminal only), `backup-state` (no key material)
// No network beyond 127.0.0.1. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CRED_DOMAIN, credentialBytes, credentialHash, DEFAULT_POLICY, intentHash, NETWORKS, toHex, vaultKeyId, verifyAuditChain, type CredentialRequest, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { applyControl, controlCall, controlRunner, isControlRequest, startControlServer } from '../src/control.ts';
import { deriveKeys } from '../src/keys.ts';
import { initKeystore, loadMnemonic } from '../src/keystore.ts';
import { backupNames, backupState, phraseMatches } from '../src/recovery.ts';
import { authHeader, createQueue, createSignerServer, listenRefusal } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { Store, type SignerState } from '../src/store.ts';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', SECRET = 's'.repeat(48);
const keys = deriveKeys(TEST_MNEMONIC);
const ROOT = join(import.meta.dirname, '../../..'), TSX = join(ROOT, 'node_modules/.bin/tsx'), MAIN = join(ROOT, 'services/isolated-signer/src/main.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

let seq = 0;
const uuid = () => `7b2c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`;
/** a signer with ONE passkey enrolled the only way a first passkey can be: the setup token */
async function setup(policy: Record<string, unknown> = {}, nowRef = { t: 1_800_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-next-'));
  if (Object.keys(policy).length) writeFileSync(join(dir, 'policy.json'), JSON.stringify({ ...DEFAULT_POLICY, ...policy }));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { dir, store, signer, pk, nowRef, reload: () => new Store(join(dir, 'state.json'), join(dir, 'policy.json')) };
}
const addReq = (target: TestPasskey, now: number, over: Partial<CredentialRequest> = {}): CredentialRequest =>
  ({ v: 2, action: 'add', requestId: uuid(), keyId: keys.keyId, credentialId: target.id, publicKey: target.publicKey, createdAt: now, expiresAt: now + 300, ...over });
const revokeReq = (target: TestPasskey, now: number, over: Partial<CredentialRequest> = {}): CredentialRequest =>
  ({ v: 2, action: 'revoke', requestId: uuid(), keyId: keys.keyId, credentialId: target.id, createdAt: now, expiresAt: now + 300, ...over });
const transfer = (now: number, over: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'base', chainRef: '8453',
  asset: NETWORKS.base.tokens[0]!.id, symbol: 'USDC', decimals: 6, amount: '1000000', from: keys.addresses.evm, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', maxFee: '100000000000000',
  createdAt: now, expiresAt: now + 120, policyVersion: 4, evm: { nonce: 0, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...over });
const VAULT = keys.vault(1).address;
const vaultReturn = (now: number, over: Partial<Intent> = {}): Intent => transfer(now, { keyId: vaultKeyId(keys.keyId, 1), from: VAULT, to: keys.addresses.evm, expiresAt: now + 90, ...over });
const types = (store: Store) => store.journalRecords().map((r) => r.type);
const lastDenied = (store: Store) => { const r = store.journalRecords().filter((x) => x.type.endsWith('.denied')).pop()!; return `${r.type}:${String(r.data.code)}`; };

describe('SPW-CRED-v2 — the canonical credential request', () => {
  const T = 1_800_000_000, ID = 'AAECAwQFBgcICQoLDA0ODw', PK = 'pQECAyYgASFYIBERERERERERERERERERERERERERERERERERERERERERIlggIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI';
  const add: CredentialRequest = { v: 2, action: 'add', requestId: '7b2c1f0e-8f5f-4b1e-9c56-aaaaaaaaaaaa', keyId: 'spw-0123456789abcdef', credentialId: ID, publicKey: PK, createdAt: T, expiresAt: T + 300 };
  it('is framed like an intent, under its own domain, eight fields in a fixed order', () => {
    const b = Buffer.from(credentialBytes(add));
    expect(b.subarray(0, CRED_DOMAIN.length + 1).toString('latin1')).toBe('SPW-CRED-v2\u0000');
    const fields: [string, string][] = []; let o = CRED_DOMAIN.length + 1;
    while (o < b.length) { const kl = b.readUInt16BE(o), vl = b.readUInt32BE(o + 2); fields.push([b.subarray(o + 6, o + 6 + kl).toString(), b.subarray(o + 6 + kl, o + 6 + kl + vl).toString()]); o += 6 + kl + vl; }
    expect(fields).toEqual([['v', '2'], ['action', 'add'], ['requestId', add.requestId], ['keyId', add.keyId], ['credentialId', ID], ['publicKey', PK], ['createdAt', String(T)], ['expiresAt', String(T + 300)]]);
    expect(toHex(credentialHash(add))).toMatchInlineSnapshot(`"bee17567d0d634bdee62f2e1baecab0202c2586f8a5f8447a96c2fd3d0605abe"`);
    expect(toHex(credentialHash({ ...add, publicKey: undefined, action: 'revoke' }))).toMatchInlineSnapshot(`"ea2a1ba3cd7654016f4233a235c1ae386c7d3ecf9d5c409a91235f532b8d7e34"`);
  });
  it('every field changes the hash; key order of the JSON does not; a malformed request has no hash', () => {
    const h = toHex(credentialHash(add));
    for (const m of [{ requestId: '7b2c1f0e-8f5f-4b1e-9c56-bbbbbbbbbbbb' }, { keyId: 'spw-fedcba9876543210' }, { credentialId: 'EBESExQVFhcYGRobHB0eHw' }, { publicKey: `${PK.slice(0, -1)}J` }, { createdAt: T + 1 }, { expiresAt: T + 299 }] as Partial<CredentialRequest>[])
      expect(toHex(credentialHash({ ...add, ...m })), JSON.stringify(m)).not.toBe(h);
    expect(toHex(credentialHash(Object.fromEntries(Object.entries(add).reverse()) as CredentialRequest))).toBe(h);
    expect(() => credentialHash({ ...add, action: 'revoke' })).toThrow(/public key/);                    // a revocation names no key
    expect(() => credentialHash({ ...add, publicKey: undefined })).toThrow(/public key/);                // an addition names one
    expect(() => credentialHash({ ...add, v: 1 } as never)).toThrow();
    expect(() => credentialHash({ ...add, extra: 1 } as never)).toThrow();                               // strict
    expect(() => credentialHash({ ...add, action: 'replace' } as never)).toThrow();
  });
});

describe('credential life cycle v2 (P1)', () => {
  it('add: an enrolled passkey approves the canonical request; the new passkey is pinned, journaled, and can approve', async () => {
    const { signer, pk, store, nowRef, reload } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), r = addReq(pk2, nowRef.t);
    const out = await signer.credentialApply(r, pk.assert(credentialHash(r)), { counter: 0, transports: ['internal'] });
    expect(out).toEqual({ ok: true, action: 'add', credentialId: pk2.id, hash: toHex(credentialHash(r)), credentials: 2 });
    expect(signer.status().credentials).toEqual([
      { id: pk.id, addedAt: new Date(nowRef.t * 1000).toISOString(), createdAt: new Date(nowRef.t * 1000).toISOString(), lastUsedAt: new Date(nowRef.t * 1000).toISOString(), inCooldown: false, cooldownUntil: null },
      { id: pk2.id, addedAt: new Date(nowRef.t * 1000).toISOString(), createdAt: new Date(nowRef.t * 1000).toISOString(), lastUsedAt: null, inCooldown: false, cooldownUntil: null }]);
    expect(JSON.stringify(signer.status().credentials)).not.toContain(pk2.publicKey);                    // no key material in the status
    const rec = store.journalRecords().pop()!;
    expect(rec).toMatchObject({ type: 'credential.added', data: { requestId: r.requestId, id: pk2.id, by: pk.id, credentials: 2, hash: out.hash } });
    // durable before the answer: another process reading the directory sees the passkey AND the single-use marker
    const disk = reload();
    expect(disk.state.credentials.map((c) => [c.id, c.addedBy])).toEqual([[pk.id, undefined], [pk2.id, pk.id]]);
    expect(disk.state.used[r.requestId]).toBe(r.expiresAt);
    expect(verifyAuditChain(disk.journalRecords())).toBeNull();
    const i = transfer(nowRef.t);                                                                        // no cool-down by default: behaviour unchanged
    expect((await signer.sign(i, pk2.assert(intentHash(i)))).txid).toMatch(/^0x/);
  });

  it('add is refused: expired, window too long or in the future, another key, replayed request id, approval of another request or action', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), pk3 = new TestPasskey(RP, ORIGIN), t = nowRef.t;
    const no = async (r: CredentialRequest, a: unknown, re: RegExp, code: string) => { await expect(signer.credentialApply(r, a as never)).rejects.toThrow(re); expect(lastDenied(store)).toBe(`credential.denied:${code}`); };
    let r = addReq(pk2, t - 600, { expiresAt: t - 300 });
    await no(r, pk.assert(credentialHash(r)), /expired/, 'expired');
    r = addReq(pk2, t, { expiresAt: t });                                                                // expires at this very second
    await no(r, pk.assert(credentialHash(r)), /expired/, 'expired');
    r = addReq(pk2, t, { expiresAt: t + 301 });
    await no(r, pk.assert(credentialHash(r)), /validity window/, 'policy');
    r = addReq(pk2, t + 61, { expiresAt: t + 300 });
    await no(r, pk.assert(credentialHash(r)), /validity window/, 'policy');
    r = addReq(pk2, t + 30, { expiresAt: t + 20 });                                                      // ends before it starts
    await no(r, pk.assert(credentialHash(r)), /validity window/, 'policy');
    r = addReq(pk2, t, { keyId: 'spw-ffffffffffffffff' });
    await no(r, pk.assert(credentialHash(r)), /another key/, 'wrong_key');
    // the approval is bound to every field: one made for another request, another credential or another ACTION does not serve
    r = addReq(pk2, t);
    const other = addReq(pk2, t);
    await no(r, pk.assert(credentialHash(other)), /approval/, 'bad_approval');
    await no(r, pk.assert(credentialHash(addReq(pk3, t, { requestId: r.requestId }))), /approval/, 'bad_approval');
    await no(r, pk.assert(credentialHash({ ...r, action: 'revoke', publicKey: undefined })), /approval/, 'bad_approval');
    await no(r, pk.assert(credentialHash(r), { origin: 'https://evil.example' }), /approval/, 'bad_approval');
    await no(r, pk.assert(credentialHash(r), { uv: false }), /approval/, 'bad_approval');
    await no(r, undefined, /needs the approval/, 'bad_approval');
    await no(r, new TestPasskey(RP, ORIGIN).assert(credentialHash(r)), /enrolled passkey/, 'unknown_credential');
    expect(signer.status().credentials).toHaveLength(1);                                                 // nothing was added by any of the above
    await signer.credentialApply(r, pk.assert(credentialHash(r)));                                       // and the request itself was still usable
    // single use: the same request again, and another passkey under the same request id
    await no(r, pk.assert(credentialHash(r)), /already applied/, 'replay');
    const again = addReq(pk3, t, { requestId: r.requestId });
    await no(again, pk.assert(credentialHash(again)), /already applied/, 'replay');
    const dup = addReq(pk2, t);
    await no(dup, pk.assert(credentialHash(dup)), /already enrolled/, 'conflict');
    expect(signer.status().credentials.map((c) => c.id)).toEqual([pk.id, pk2.id]);
  });

  it('malformed requests are refused before anything is looked at', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), r = addReq(pk2, nowRef.t), a = pk.assert(credentialHash(r)), before = store.journalRecords().length;
    for (const bad of [null, {}, { ...r, v: 1 }, { ...r, action: 'replace' }, { ...r, publicKey: undefined }, { ...r, credentialId: 'short' }, { ...r, requestId: 'x' }, { ...r, extra: true }, { ...revokeReq(pk2, nowRef.t), publicKey: pk2.publicKey }])
      await expect(signer.credentialApply(bad, a), JSON.stringify(bad)).rejects.toThrow(/malformed credential request/);
    for (const extra of [{ counter: -1 }, { counter: 1.5 }, { counter: '0' }, { transports: 'internal' }, { transports: [1] }, { transports: Array(9).fill('usb') }, { transports: ['x'.repeat(33)] }])
      await expect(signer.credentialApply(r, a, extra), JSON.stringify(extra)).rejects.toThrow(/malformed credential/);
    expect(store.journalRecords()).toHaveLength(before);
    expect(signer.status().credentials).toHaveLength(1);
  });

  it('a passkey never approves its own addition; with no passkey at all the request path adds nothing', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), r = addReq(pk2, nowRef.t);
    await expect(signer.credentialApply(r, pk2.assert(credentialHash(r)))).rejects.toThrow(/its own addition/);
    expect(lastDenied(store)).toBe('credential.denied:self_approval');
    expect(signer.status().credentials.map((c) => c.id)).toEqual([pk.id]);
    // after the operator reset the passkeys, only the setup token enrols the first one again
    applyControl(store, { cmd: 'reset-passkeys' }, 'file');
    const r2 = addReq(pk2, nowRef.t);
    await expect(signer.credentialApply(r2, pk.assert(credentialHash(r2)))).rejects.toThrow(/setup token/);
    expect(lastDenied(store)).toBe('credential.denied:forbidden');
  });

  it('under the emergency halt: no passkey is added (also when the halt lands while the approval is verified); a revocation still passes', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), pk3 = new TestPasskey(RP, ORIGIN);
    const r2 = addReq(pk2, nowRef.t);
    await signer.credentialApply(r2, pk.assert(credentialHash(r2)));
    // the halt is recorded between the start of the request and the end of the passkey verification
    const racing = addReq(pk3, nowRef.t), p = signer.credentialApply(racing, pk.assert(credentialHash(racing)));
    signer.halt();
    await expect(p).rejects.toThrow(/halt/);
    expect(lastDenied(store)).toBe('credential.denied:policy');
    const r3 = addReq(pk3, nowRef.t);
    await expect(signer.credentialApply(r3, pk.assert(credentialHash(r3)))).rejects.toThrow(/halt is active: no passkey is added/);
    expect(signer.status().credentials.map((c) => c.id)).toEqual([pk.id, pk2.id]);
    const rv = revokeReq(pk2, nowRef.t);                                                                 // removing authority is always allowed
    expect(await signer.credentialApply(rv, pk.assert(credentialHash(rv)))).toMatchObject({ action: 'revoke', credentials: 1 });
    expect(signer.status()).toMatchObject({ halted: true, credentials: [{ id: pk.id }] });
  });

  it('revoke: another enrolled passkey approves; the revoked one approves nothing any more; single use', async () => {
    const { signer, pk, store, nowRef, reload } = await setup();
    const pk2 = new TestPasskey(RP, ORIGIN), a = addReq(pk2, nowRef.t);
    await signer.credentialApply(a, pk.assert(credentialHash(a)));
    const no = async (r: CredentialRequest, as: unknown, re: RegExp, code: string) => { await expect(signer.credentialApply(r, as as never)).rejects.toThrow(re); expect(lastDenied(store)).toBe(`credential.denied:${code}`); };
    let r = revokeReq(pk2, nowRef.t);
    await no(r, pk2.assert(credentialHash(r)), /its own addition or revocation/, 'self_approval');       // not by the passkey it names
    await no(r, pk.assert(credentialHash(addReq(pk2, nowRef.t, { requestId: r.requestId }))), /approval/, 'bad_approval'); // an approval of the ADD of the same passkey
    r = revokeReq(new TestPasskey(RP, ORIGIN), nowRef.t);
    await no(r, pk.assert(credentialHash(r)), /no such passkey/, 'not_found');
    r = revokeReq(pk2, nowRef.t - 400, { expiresAt: nowRef.t - 100 });
    await no(r, pk.assert(credentialHash(r)), /expired/, 'expired');
    r = revokeReq(pk2, nowRef.t);
    expect(await signer.credentialApply(r, pk.assert(credentialHash(r)))).toEqual({ ok: true, action: 'revoke', credentialId: pk2.id, hash: toHex(credentialHash(r)), credentials: 1 });
    expect(store.journalRecords().pop()).toMatchObject({ type: 'credential.revoked', data: { id: pk2.id, by: pk.id, requestId: r.requestId, credentials: 1 } });
    expect(reload().state.credentials.map((c) => c.id)).toEqual([pk.id]);
    const i = transfer(nowRef.t);
    await expect(signer.sign(i, pk2.assert(intentHash(i)))).rejects.toThrow(/enrolled passkey/);        // the revoked passkey moves nothing
    await no(r, pk.assert(credentialHash(r)), /already applied/, 'replay');
    // the same passkey can be added again later — with a NEW request; the old add request does not come back to life
    await no(a, pk.assert(credentialHash(a)), /already applied/, 'replay');
  });

  it('the last passkey is never revoked', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const r = revokeReq(pk, nowRef.t);
    await expect(signer.credentialApply(r, pk.assert(credentialHash(r)))).rejects.toThrow(/last passkey/);
    expect(lastDenied(store)).toBe('credential.denied:last_credential');
    const pk2 = new TestPasskey(RP, ORIGIN), a = addReq(pk2, nowRef.t);
    await signer.credentialApply(a, pk.assert(credentialHash(a)));
    const r1 = revokeReq(pk, nowRef.t);
    await signer.credentialApply(r1, pk2.assert(credentialHash(r1)));                                    // the newer one may remove the older one…
    const r2 = revokeReq(pk2, nowRef.t);
    await expect(signer.credentialApply(r2, pk2.assert(credentialHash(r2)))).rejects.toThrow(/last passkey/); // …but then it is the last
    expect(signer.status().credentials.map((c) => c.id)).toEqual([pk2.id]);
  });

  it('cool-down (policy, off by default): a passkey just added approves nothing — no transfer, no addition, no revocation — until it ends', async () => {
    const { signer, pk, store, nowRef } = await setup({ newCredentialCooldownSec: 3600 });
    const t0 = nowRef.t, pk2 = new TestPasskey(RP, ORIGIN), pk3 = new TestPasskey(RP, ORIGIN), a = addReq(pk2, t0);
    await signer.credentialApply(a, pk.assert(credentialHash(a)));
    expect(signer.status()).toMatchObject({ credentialCooldownSec: 3600, credentials: [{ id: pk.id, inCooldown: false, cooldownUntil: null }, { id: pk2.id, inCooldown: true, cooldownUntil: t0 + 3600 }] });
    const i = transfer(t0);
    await expect(signer.sign(i, pk2.assert(intentHash(i)))).rejects.toThrow(/added recently/);
    expect(lastDenied(store)).toBe('sign.denied:cooldown');
    const add3 = addReq(pk3, t0);
    await expect(signer.credentialApply(add3, pk2.assert(credentialHash(add3)))).rejects.toThrow(/added recently/);
    const rv = revokeReq(pk, t0);                                                                        // it cannot evict the passkey that was there before it
    await expect(signer.credentialApply(rv, pk2.assert(credentialHash(rv)))).rejects.toThrow(/added recently/);
    expect(lastDenied(store)).toBe('credential.denied:cooldown');
    expect((await signer.sign(i, pk.assert(intentHash(i)))).txid).toMatch(/^0x/);                        // the first passkey (setup token) is never in cool-down
    nowRef.t = t0 + 3599;
    const j = transfer(nowRef.t);
    await expect(signer.sign(j, pk2.assert(intentHash(j)))).rejects.toThrow(/added recently/);
    nowRef.t = t0 + 3600;
    expect((await signer.sign(j, pk2.assert(intentHash(j)))).txid).toMatch(/^0x/);
    expect(signer.status().credentials[1]).toMatchObject({ inCooldown: false, cooldownUntil: null, lastUsedAt: new Date(nowRef.t * 1000).toISOString() });
    // a date that cannot be read counts as "added now", never as "no cool-down"
    store.state.credentials[1]!.addedAt = 'not a date';
    expect(signer.status().credentials[1]).toMatchObject({ inCooldown: true, cooldownUntil: nowRef.t + 3600 });
  });

  it('the first passkey is still enrolled with the setup token — also under the halt — and never through a credential request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-next-')), store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
    const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => 1_800_000_000), pk = new TestPasskey(RP, ORIGIN);
    expect(signer.status()).toMatchObject({ enrollmentOpen: false, credentials: [] });
    await expect(signer.enroll({ credential: pk.credential(), setupToken: 'anything' })).rejects.toThrow(/setup token/); // no token was issued
    applyControl(store, { cmd: 'setup-token', tokenHash: createHash('sha256').update('tok').digest('hex') }, 'file');
    signer.halt();
    expect(signer.status().enrollmentOpen).toBe(true);
    await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
    expect(signer.status()).toMatchObject({ enrollmentOpen: false, halted: true, credentials: [{ id: pk.id, addedAt: '2027-01-15T08:00:00.000Z', lastUsedAt: null, inCooldown: false }] });
    expect(types(store).slice(-1)).toEqual(['credential.enrolled']);
    await expect(signer.enroll({ credential: new TestPasskey(RP, ORIGIN).credential(), setupToken: 'tok' })).rejects.toThrow(/SPW-CRED-v2/);
  });
});

describe('a state.json written before NEXT (fixture)', () => {
  it('loads as it is; the new fields are absent, reported as "never" / "no cool-down", and survive a save next to what was there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-next-'));
    copyFileSync(join(import.meta.dirname, 'fixtures/state-pre-next.json'), join(dir, 'state.json'));
    const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => 1_795_000_100);
    expect(store.journalBrokenAt).toBeNull();
    const st = signer.status();
    expect(st).toMatchObject({ halted: false, recoveryExportedAt: null, recoveryVerifiedAt: null, credentialCooldownSec: 0, maxVaultReturnsPerDay: 12 });
    expect(st.credentials).toEqual([
      { id: 'AAECAwQFBgcICQoLDA0ODw', addedAt: '2026-11-10T14:02:11.000Z', createdAt: '2026-11-10T14:02:11.000Z', lastUsedAt: null, inCooldown: false, cooldownUntil: null },
      { id: 'EBESExQVFhcYGRobHB0eHw', addedAt: '2026-11-12T09:30:00.000Z', createdAt: '2026-11-12T09:30:00.000Z', lastUsedAt: null, inCooldown: false, cooldownUntil: null }]);
    applyControl(store, { cmd: 'recovery-mark', what: 'exported' }, 'file');
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as SignerState;
    expect(disk.credentials).toEqual(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/state-pre-next.json'), 'utf8')).credentials); // untouched: no field added to an old credential
    expect(disk).toMatchObject({ v: 1, used: { '6f1c1f0e-8f5f-4b1e-9c56-000000000001': 1795000000 }, spent: { '2026-11-18|base:USDC': '12500000' }, nftDaily: { '2026-11-18': 1 } });
    expect(Date.parse(disk.recoveryExportedAt!)).toBeGreaterThan(0);
  });
  it('a passkey stored in the old shape still approves, and a policy.json without the new keys means: no cool-down, twelve returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-next-')), pk = new TestPasskey(RP, ORIGIN), t = 1_800_000_000;
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, halted: false, setupTokenHash: null, credentials: [{ ...pk.credential(), addedAt: '2026-11-10T14:02:11.000Z' }], used: {}, spent: {}, journal: [] }));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));                             // exactly what the previous binary wrote
    const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
    expect(Object.keys(store.policy).sort()).toEqual(['allowlist', 'daily', 'maxApprovalTtlSec', 'maxFee', 'perTx', 'version']);
    const i = transfer(t);
    expect((await signer.sign(i, pk.assert(intentHash(i)))).txid).toMatch(/^0x/);
    expect(JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'))).toEqual(DEFAULT_POLICY);          // the signer never writes the new keys into the file
  });
});

describe('vault returns (C3)', () => {
  it('are capped per vault and per UTC day; a refusal is journaled; the count is saved before the signature', async () => {
    const { signer, store, nowRef, reload } = await setup({ maxVaultReturnsPerDay: 2 });
    const day = new Date(nowRef.t * 1000).toISOString().slice(0, 10);
    for (let k = 0; k < 2; k++) expect((await signer.signVaultReturn(1, vaultReturn(nowRef.t, { evm: { nonce: k, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } }))).txid).toMatch(/^0x/);
    expect(reload().state.vaultReturns).toEqual({ [day]: { 1: 2 } });
    const third = vaultReturn(nowRef.t);
    await expect(signer.signVaultReturn(1, third)).rejects.toThrow(/daily number of returns/);
    expect(store.journalRecords().pop()).toMatchObject({ type: 'return.denied', data: { vaultIndex: 1, proposalId: third.proposalId, code: 'policy' } });
    expect(store.state.used[third.proposalId]).toBeUndefined();                                          // a refused return consumed nothing
    // another vault has its own count
    const v2 = keys.vault(2).address;
    expect((await signer.signVaultReturn(2, vaultReturn(nowRef.t, { keyId: vaultKeyId(keys.keyId, 2), from: v2 }))).txid).toMatch(/^0x/);
    // a refused request (wrong destination) is not counted
    await expect(signer.signVaultReturn(2, vaultReturn(nowRef.t, { keyId: vaultKeyId(keys.keyId, 2), from: v2, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }))).rejects.toThrow(/owner/);
    expect(store.state.vaultReturns![day]).toEqual({ 1: 2, 2: 1 });
    nowRef.t += 86400;                                                                                   // next UTC day
    expect((await signer.signVaultReturn(1, vaultReturn(nowRef.t))).txid).toMatch(/^0x/);
    nowRef.t += 4 * 86400; store.prune(nowRef.t);
    expect(Object.keys(store.state.vaultReturns!)).toEqual([]);                                          // counters are kept three days
  });
  it('default: twelve a day (no key in policy.json); the halt still does not stop a return', async () => {
    const { signer, nowRef } = await setup();
    signer.halt();
    for (let k = 0; k < 12; k++) await signer.signVaultReturn(1, vaultReturn(nowRef.t));
    await expect(signer.signVaultReturn(1, vaultReturn(nowRef.t))).rejects.toThrow(/daily number of returns/);
    expect(signer.status().maxVaultReturnsPerDay).toBe(12);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('transport (C1): authentication and body outside the queue, the halt never waits', () => {
  async function serve(signer: Signer, opts: { bodyTimeoutMs?: number; enqueue?: ReturnType<typeof createQueue>; allowed?: string[] } = {}) {
    const srv: Server = createSignerServer(signer, SECRET, opts.allowed ?? [], opts.enqueue ?? createQueue(), { bodyTimeoutMs: opts.bodyTimeoutMs }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    closers.push(() => srv.close());
    const port = (srv.address() as { port: number }).port;
    const call = async (method: 'GET' | 'POST', path: string, payload?: unknown) => {
      const body = payload === undefined ? '' : JSON.stringify(payload);
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-spw-auth': authHeader(SECRET, method, path, body), connection: 'close' }, body: body || undefined });
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };
    /** a raw client: writes `head` (+ whatever follows) and resolves with everything the server sent once the connection is closed */
    const raw = (head: string) => { const sock = net.connect(port, '127.0.0.1'); let got = ''; sock.on('data', (d) => { got += d.toString(); }); sock.on('error', () => {});
      const closed = new Promise<string>((r) => sock.on('close', () => r(got))); sock.write(head); return { sock, closed }; };
    return { srv, port, call, raw };
  }

  it('a client that stalls in the middle of its body blocks neither a valid /sign nor the halt, and is cut after the body time-out', async () => {
    const { signer, pk, nowRef } = await setup(), { call, raw } = await serve(signer, { bodyTimeoutMs: 1500 });
    nowRef.t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ intent: transfer(nowRef.t), assertion: {} });
    const stalled = raw(`POST /sign HTTP/1.1\r\nhost: signer\r\nx-spw-auth: ${authHeader(SECRET, 'POST', '/sign', body)}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 40)}`);
    let cut = false; void stalled.closed.then(() => { cut = true; });
    await sleep(60);                                                                                     // the server has the headers and 40 bytes; nothing more will come
    const t0 = Date.now(), i = transfer(nowRef.t);
    expect((await call('GET', '/status')).status).toBe(200);
    const signed = await call('POST', '/sign', { intent: i, assertion: pk.assert(intentHash(i)) });
    expect(signed.status).toBe(200);
    expect(signed.json.txid).toMatch(/^0x/);
    expect(await call('POST', '/halt', {})).toEqual({ status: 200, json: { ok: true, halted: true } });
    expect(cut).toBe(false);                                                                             // all three while the stalled request was still open
    expect(signer.halted).toBe(true);
    const answer = await stalled.closed;                                                                 // then the stalled connection is answered 408 and closed
    expect(answer).toMatch(/^HTTP\/1\.1 408 /);
    expect(answer).toContain('"error":"timeout"');
    expect(Date.now() - t0).toBeGreaterThan(1000);
  });

  it('nothing unauthenticated enters the queue: bad source, bad header, bad MAC and replayed nonce are answered while the queue is busy', async () => {
    const enqueue = createQueue(); let release!: () => void;
    void enqueue(() => new Promise<void>((r) => { release = r; }));                                      // a handler that takes its time
    const { signer } = await setup(), { port, call, raw } = await serve(signer, { enqueue });
    const get = (auth?: string) => fetch(`http://127.0.0.1:${port}/status`, { headers: auth ? { 'x-spw-auth': auth } : {} }).then((r) => r.status);
    expect(await get()).toBe(401);
    expect(await get(authHeader('x'.repeat(48), 'GET', '/status', ''))).toBe(401);
    expect(await get(authHeader(SECRET, 'GET', '/status', '', Math.floor(Date.now() / 1000) - 600))).toBe(401);
    const h = authHeader(SECRET, 'GET', '/status', ''), first = get(h);                                  // valid: waits in the queue
    await sleep(30);
    expect(await get(h)).toBe(401);                                                                      // its nonce is already taken, although its handler has not run
    expect(await call('POST', '/halt', {})).toMatchObject({ status: 200 });                              // and the halt does not wait either
    // refused on its header: answered and CLOSED at once, although the body it announced never came (its bytes are not waited for)
    const t0 = Date.now(), unread = await raw('POST /sign HTTP/1.1\r\nhost: signer\r\nx-spw-auth: nonsense\r\ncontent-length: 500\r\n\r\n{"intent":').closed;
    expect(unread).toMatch(/^HTTP\/1\.1 401 /);
    expect(Date.now() - t0).toBeLessThan(2000);
    release();
    expect(await first).toBe(200);
    // source allowlist: checked first, before the header and the body
    const { call: closed } = await serve(signer, { allowed: ['203.0.113.7'] });
    expect(await closed('GET', '/status')).toMatchObject({ status: 401, json: { message: 'source not allowed' } });
    expect(await closed('POST', '/halt', {})).toMatchObject({ status: 401 });
  });

  it('a body above the limit is refused (declared or streamed) and never parsed; a body that is not a JSON object is a bad request', async () => {
    const { signer } = await setup(), { call, raw, port } = await serve(signer);
    const auth = authHeader(SECRET, 'POST', '/sign', '');
    const declared = await raw(`POST /sign HTTP/1.1\r\nhost: signer\r\nx-spw-auth: ${auth}\r\ncontent-length: ${1024 * 1024 + 1}\r\n\r\n`).closed;
    expect(declared).toMatch(/^HTTP\/1\.1 413 /);
    expect(declared).toContain('"error":"too_large"');
    const streamed = raw(`POST /sign HTTP/1.1\r\nhost: signer\r\nx-spw-auth: ${authHeader(SECRET, 'POST', '/sign', '')}\r\ntransfer-encoding: chunked\r\n\r\n`);
    const chunk = `10000\r\n${'a'.repeat(0x10000)}\r\n`;
    for (let k = 0; k < 17; k++) streamed.sock.write(chunk);                                             // 17 × 64 KiB > 1 MiB
    const out = await streamed.closed;                                                                   // cut by the server (the 413 may be lost with the reset of a connection that still had unread data)
    expect(out === '' || /^HTTP\/1\.1 413 /.test(out), out.slice(0, 40)).toBe(true);
    for (const [body, status] of [['{"intent":', 422], ['null', 422], ['"x"', 422], ['[]', 422]] as const) {
      const r = await fetch(`http://127.0.0.1:${port}/sign`, { method: 'POST', headers: { 'x-spw-auth': authHeader(SECRET, 'POST', '/sign', body) }, body });
      expect([r.status, ((await r.json()) as { error: string }).error], body).toEqual([status, 'bad_request']);
    }
    expect((await call('GET', '/status')).status).toBe(200);                                             // still serving
    expect(await call('POST', '/unhalt', {})).toMatchObject({ status: 404 });                            // and there is still no such route
  });

  it('a halt recorded while a signature is being produced: the signature is NOT released, and the journal says so', async () => {
    const { signer, pk, store, nowRef } = await setup(), { call } = await serve(signer);
    nowRef.t = Math.floor(Date.now() / 1000);
    // the real handler, held at the last moment: the transaction is signed, journaled and saved, the answer is about to leave
    const real = signer.sign.bind(signer); let computed!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => { computed = r; }), gate = new Promise<void>((r) => { release = r; });
    signer.sign = async (...a) => { const out = await real(...a); computed(); await gate; return out; };
    const i = transfer(nowRef.t), pending = call('POST', '/sign', { intent: i, assertion: pk.assert(intentHash(i)) });
    await reached;
    expect(types(store).slice(-1)).toEqual(['sign.ok']);
    expect(await call('POST', '/halt', {})).toEqual({ status: 200, json: { ok: true, halted: true } }); // answered although /sign still holds the queue
    release();
    const res = await pending;
    expect(res).toEqual({ status: 422, json: { error: 'halted', message: 'the emergency halt was recorded while this request was being processed: nothing is released' } });
    expect(JSON.stringify(res.json)).not.toMatch(/0x[0-9a-f]{20}/);                                      // no transaction, no hash
    expect(types(store).slice(-3)).toEqual(['sign.ok', 'halt.on', 'halt.withheld']);
    expect(store.journalRecords().pop()!.data).toEqual({ route: 'POST /sign' });
    // the proposal is spent (its marker was saved before the signature existed): it cannot be asked again, halt or not
    expect(store.state.used[i.proposalId]).toBe(i.expiresAt);
    // a request whose handler STARTS under the halt is judged by that handler, as before
    signer.sign = real;
    const j = transfer(nowRef.t);
    expect(await call('POST', '/sign', { intent: j, assertion: pk.assert(intentHash(j)) })).toMatchObject({ status: 422, json: { error: 'policy', message: 'emergency halt is active' } });
    expect((await call('GET', '/status')).json.halted).toBe(true);
  });

  it('a return of the owner\'s funds computed across a halt IS released (returns are never halted)', async () => {
    const { signer, nowRef } = await setup(), { call } = await serve(signer);
    nowRef.t = Math.floor(Date.now() / 1000);
    const real = signer.signVaultReturn.bind(signer); let computed!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => { computed = r; }), gate = new Promise<void>((r) => { release = r; });
    signer.signVaultReturn = async (...a) => { const out = await real(...a); computed(); await gate; return out; };
    const pending = call('POST', '/vault/return', { index: 1, intent: vaultReturn(nowRef.t) });
    await reached;
    expect((await call('POST', '/halt', {})).status).toBe(200);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.json.txid).toMatch(/^0x/);
  });

  it('the operator\'s halt on the control socket is applied at once; every other command waits its turn', async () => {
    const { store, dir } = await setup(), sock = join(dir, 'control.sock');
    const enqueue = createQueue(); let release!: () => void;
    void enqueue(() => new Promise<void>((r) => { release = r; }));                                      // a signing request waiting for a price that does not come
    const server = startControlServer(sock, controlRunner(store, enqueue));
    await new Promise((r) => server.once('listening', r));
    closers.push(() => server.close());
    expect(await controlCall(sock, { cmd: 'halt' }, 1000)).toEqual({ ok: true, halted: true, credentials: 1, via: 'daemon' });
    expect(store.state.halted).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).halted).toBe(true);                 // saved, not only in memory
    const unhalt = controlCall(sock, { cmd: 'unhalt' }, 5000);
    await sleep(150);
    expect(store.state.halted).toBe(true);                                                               // lifting the halt is never rushed past a request in progress
    release();
    expect(await unhalt).toMatchObject({ ok: true, halted: false });
  });

  it('POST /credential is the only way to change the passkey set over HTTP once a passkey exists', async () => {
    const { signer, pk, nowRef } = await setup(), { call } = await serve(signer);
    nowRef.t = Math.floor(Date.now() / 1000);
    const pk2 = new TestPasskey(RP, ORIGIN), r = addReq(pk2, nowRef.t);
    expect(await call('POST', '/enroll', { credential: pk2.credential(), assertion: pk.assert(credentialHash(r)) })).toMatchObject({ status: 422, json: { error: 'forbidden' } });
    expect(await call('POST', '/credential', { request: r, assertion: pk.assert(credentialHash(r)), credential: { counter: 0, transports: ['internal'] } })).toMatchObject({ status: 200, json: { ok: true, action: 'add', credentials: 2 } });
    expect(await call('POST', '/credential', { request: r, assertion: pk.assert(credentialHash(r)) })).toMatchObject({ status: 422, json: { error: 'replay' } });
    const st = (await call('GET', '/status')).json;
    expect(st.credentials.map((c: { id: string }) => c.id)).toEqual([pk.id, pk2.id]);
    expect(JSON.stringify(st)).not.toContain(pk2.publicKey);
    expect(JSON.stringify(st)).not.toMatch(/abandon|priv|seed/i);
  });
});

describe('start-up refusals (C2)', () => {
  it('a network listen address needs a source allowlist; a loopback address does not', () => {
    for (const host of ['0.0.0.0', '192.168.2.105', '10.67.0.35', '::', 'signer.example', '']) expect(listenRefusal(host, []), host).toMatch(/empty source allowlist/);
    for (const host of ['127.0.0.1', '127.0.0.53', '::1', 'localhost']) expect(listenRefusal(host, []), host).toBeNull();
    expect(listenRefusal('0.0.0.0', ['192.168.2.50'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('recovery hygiene (K1) and the command line', () => {
  /** a real signer directory made by the real CLI (keystore and wrap key INSIDE it, the worst case for a backup) */
  function cli(args: string[], dir: string, env: Record<string, string> = {}, input = '') {
    return spawnSync(TSX, [MAIN, ...args], { encoding: 'utf8', input, timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: dir, SPW_SIGNER_DIR: dir, SPW_SIGNER_WRAP_KEY: join(dir, 'wrap.key'), ...env } });
  }
  it('the typed phrase is compared, never shown: case and spacing do not matter, any other difference does', () => {
    expect(phraseMatches(TEST_MNEMONIC, TEST_MNEMONIC)).toBe(true);
    expect(phraseMatches(`  ${TEST_MNEMONIC.toUpperCase().replace(/ /g, '   ')}\n`, TEST_MNEMONIC)).toBe(true);
    expect(phraseMatches(TEST_MNEMONIC.replace(/about$/, 'above'), TEST_MNEMONIC)).toBe(false);
    expect(phraseMatches(TEST_MNEMONIC.split(' ').reverse().join(' '), TEST_MNEMONIC)).toBe(false);
    expect(phraseMatches('', TEST_MNEMONIC)).toBe(false);
  });

  it('`recovery-mark` records a date and a journal line, nothing else; the status says "never" until then', async () => {
    const { signer, store } = await setup();
    expect(signer.status()).toMatchObject({ recoveryExportedAt: null, recoveryVerifiedAt: null });
    for (const bad of [{ cmd: 'recovery-mark' }, { cmd: 'recovery-mark', what: 'words' }, { cmd: 'verify-recovery' }, { cmd: 'backup-state' }]) expect(isControlRequest(bad), JSON.stringify(bad)).toBe(false);
    expect(applyControl(store, { cmd: 'recovery-mark', what: 'exported' }, 'file')).toMatchObject({ ok: true });
    expect(Date.parse(signer.status().recoveryExportedAt!)).toBeGreaterThan(Date.now() - 5000);
    expect(signer.status().recoveryVerifiedAt).toBeNull();
    applyControl(store, { cmd: 'recovery-mark', what: 'verified' }, 'file');
    expect(Date.parse(signer.status().recoveryVerifiedAt!)).toBeGreaterThan(Date.now() - 5000);
    expect(store.journalRecords().slice(-2).map((r) => [r.type, r.data])).toEqual([['recovery.exported', { via: 'cli' }], ['recovery.verified', { via: 'cli' }]]);
  });

  it('backup-state: state, policy and journal — no keystore, no wrap key, no gateway secret; private; never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-cli-')), ks = join(dir, 'keystore.json'), wk = join(dir, 'wrap.key');
    initKeystore(ks, wk);
    writeFileSync(join(dir, 'gateway.secret'), 'G'.repeat(48));
    const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'), { rotateBytes: 600 });
    for (let k = 0; k < 6; k++) { store.log('test.event', { k, pad: 'x'.repeat(200) }); store.save(); }   // several closed journal segments and the open one
    writeFileSync(join(dir, 'state.json.lock'), '1'); writeFileSync(join(dir, 'journal.jsonl.tmp'), 'x'); writeFileSync(join(dir, 'keystore.json.bak'), 'x');
    const names = backupNames(dir);
    expect(names.slice(0, 2)).toEqual(['state.json', 'policy.json']);                                    // the state is read before the journal
    expect(names.length).toBeGreaterThan(3);
    for (const n of names.slice(2)) expect(n).toMatch(/^journal(-\d+-\d+)?\.jsonl$/);
    const out = join(dir, 'backup.tar');
    expect(backupState(dir, out)).toEqual(names);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(() => backupState(dir, out)).toThrow(/EEXIST/);
    // read back by the system's tar: exactly those files, byte for byte
    const list = spawnSync('tar', ['-tf', out], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split('\n').sort()).toEqual([...names].sort());
    for (const n of names) expect(spawnSync('tar', ['-xOf', out, n], { encoding: 'buffer' }).stdout.equals(readFileSync(join(dir, n))), n).toBe(true);
    const tar = readFileSync(out).toString('latin1'), keystore = JSON.parse(readFileSync(ks, 'utf8')) as { ct: string; salt: string; tag: string };
    for (const secret of [keystore.ct, keystore.salt, keystore.tag, readFileSync(wk, 'utf8').trim(), 'G'.repeat(48), 'keystore', 'wrap.key', 'gateway']) expect(tar.includes(secret), secret.slice(0, 12)).toBe(false);
    const words = loadMnemonic(ks, wk).split(' ');
    for (let k = 0; k + 1 < words.length; k++) expect(tar.includes(`${words[k]} ${words[k + 1]}`)).toBe(false);
    expect(() => backupState(mkdtempSync(join(tmpdir(), 'spw-cli-')), join(dir, 'b2.tar'))).toThrow(/no state.json/);
    // the copy is a state the store accepts
    const restore = mkdtempSync(join(tmpdir(), 'spw-cli-'));
    expect(spawnSync('tar', ['-xf', out, '-C', restore]).status).toBe(0);
    const copy = new Store(join(restore, 'state.json'), join(restore, 'policy.json'));
    expect(copy.journalBrokenAt).toBeNull();
    expect(copy.journalHead()).toEqual(store.journalHead());
  });

  it('the CLI: verify-recovery and export-recovery refuse anything that is not a terminal; backup-state writes the tar; serve refuses a network address without an allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-cli-'));
    expect(cli(['init'], dir).status).toBe(0);
    const words = loadMnemonic(join(dir, 'keystore.json'), join(dir, 'wrap.key'));
    for (const cmd of ['verify-recovery', 'export-recovery']) {
      const r = cli([cmd], dir, {}, `${words}\nSHOW\n`);                                                 // piped: even the right words, even "SHOW"
      expect(r.status, cmd).toBe(1);
      expect(r.stderr).toContain(`${cmd} only runs in an interactive terminal`);
      for (let k = 0; k < 23; k++) expect((r.stdout + r.stderr).includes(words.split(' ').slice(k, k + 2).join(' ')), cmd).toBe(false);
    }
    expect(existsSync(join(dir, 'state.json'))).toBe(false);                                             // nothing was recorded by a refused command
    expect(cli(['halt'], dir).status).toBe(0);                                                           // creates the state (no daemon: written under the lock)
    const out = join(dir, 'b.tar'), b = cli(['backup-state', out], dir);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('state.json, policy.json, journal.jsonl');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(cli(['backup-state', out], dir)).toMatchObject({ status: 1, stderr: expect.stringContaining('not overwritten') });
    expect(cli(['backup-state'], dir).status).toBe(2);
    const env = { SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_RP_ID: RP, SPW_ORIGIN: ORIGIN, SPW_SIGNER_PORT: '0' };
    for (const host of ['0.0.0.0', '192.168.2.105']) {
      const s = cli(['serve'], dir, { ...env, SPW_SIGNER_HOST: host });
      expect(s.status, host).toBe(1);
      expect(s.stderr).toContain(`refusing to listen on ${host} with an empty source allowlist`);
      expect(s.stdout).not.toContain('listening');
    }
    expect(existsSync(join(dir, 'state.json.lock'))).toBe(false);                                        // the refused daemon released the state
  }, 120_000);
});
