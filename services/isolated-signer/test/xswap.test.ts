// Native cross-chain swaps (THORChain) at the signer: what it signs, what it refuses, and its own vault check.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { decodeFunctionData, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { encodeThorPubKey, intentHash, NETWORKS, THOR_ROUTER_ABI, THOR_ROUTERS, thorPubKeyBytes, thorVaultAddress, utxoPaymentTo, verifyAuditChain, type Intent, type ThorAnswer, type ThorVaultWant, type ThorView } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';
import { noVaults, thorVaults, vaultHosts, type VaultView } from '../src/vaults.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', ME_EVM = keys.addresses.evm, ME_BTC = keys.addresses.bitcoin!;
const KEY = 'thorpub1addwnpepqgwpafz6l99mkevlz7spaezgzcxy5t2896hgm7e6kytqrkmulex4wxjp8az'; // a real Asgard key of 2026-11-11 (public data)
const V_BTC = thorVaultAddress(KEY, 'bitcoin'), V_ETH = thorVaultAddress(KEY, 'ethereum'), ROUTER = THOR_ROUTERS.ethereum!.address;
const EVIL = (() => { const k = thorPubKeyBytes(KEY).slice(); k[0] = 0x02; k[5]! ^= 1; for (let j = 0; j < 256; j++) { k[6] = j; try { return encodeThorPubKey(k); } catch { /* not on the curve */ } } throw new Error('no key'); })();

const view = (o: Partial<{ chain: string; router: string | null; halted: boolean; height: number; status: string }> = {}): ThorView => ({ height: o.height ?? 1000,
  inbound: [{ chain: o.chain ?? 'BTC', pubKey: KEY, address: 'x'.repeat(30), router: o.router ?? null, halted: !!o.halted, paused: false, gasRate: 3n, dustThreshold: 1000n, outboundFee: 1000n }],
  vaults: [{ pubKey: KEY, status: o.status ?? 'ActiveVault', statusSince: 900, chains: ['BTC', 'ETH'], members: 19 }] });
/** Five scripted operators behind the signer's real fetch-and-check code (thorVaults), keyed by host. */
function operators(per: (host: string) => ThorView | Error): VaultView {
  return thorVaults(async (url) => {
    const u = new URL(url), v = per(u.host); if (v instanceof Error) throw v;
    if (u.pathname.endsWith('/lastblock')) return [{ chain: 'BTC', thorchain: v.height }];
    if (u.pathname.endsWith('/inbound_addresses')) return v.inbound.map((x) => ({ chain: x.chain, pub_key: x.pubKey, address: x.address, ...(x.router ? { router: x.router } : {}), halted: x.halted, chain_trading_paused: x.paused, gas_rate: '3', dust_threshold: '1000', outbound_fee: '1000' }));
    return v.vaults.map((x) => ({ pub_key: x.pubKey, status: x.status, status_since: x.statusSince, chains: x.chains, membership: Array.from({ length: x.members }, () => 'n') }));
  });
}
async function setup(vaults?: VaultView) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-xswap-')), nowRef = { t: Math.floor(Date.now() / 1000) };
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')), calls: ThorVaultWant[] = [];
  const spy: VaultView | undefined = vaults && { check: (w) => { calls.push(w); return vaults.check(w); } };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t, undefined, spy), pk = new TestPasskey(RP, ORIGIN);
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  return { store, signer, pk, nowRef, calls };
}
let seq = 0;
const id = () => `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`;
function btc(now: number, o: Partial<Intent> = {}, x: Partial<NonNullable<Intent['xswap']>> = {}): Intent {
  return { v: 1, proposalId: id(), keyId: keys.keyId, network: 'bitcoin', chainRef: NETWORKS.bitcoin!.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '60000', from: ME_BTC, to: x.vault ?? V_BTC, maxFee: '1000',
    createdAt: now, expiresAt: now + 120, policyVersion: 3, btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '150000' }], change: '89300', fee: '700' },
    xswap: { provider: 'thorchain', toNetwork: 'ethereum', toAsset: 'native', minOut: '20000000000000000', limit: '2000000', memo: `=:e:${ME_EVM}:2000000`, vault: V_BTC, vaultPubKey: KEY, router: '', expiry: now + 900, approveGas: '0', ...x }, ...o };
}
function evm(now: number, o: Partial<Intent> = {}, x: Partial<NonNullable<Intent['xswap']>> = {}): Intent {
  return { v: 1, proposalId: id(), keyId: keys.keyId, network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '20000000000000000', from: ME_EVM, to: x.vault ?? V_ETH, maxFee: '2000000000000000',
    createdAt: now, expiresAt: now + 120, policyVersion: 3, evm: { nonce: 5, gasLimit: '80000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' },
    xswap: { provider: 'thorchain', toNetwork: 'bitcoin', toAsset: 'native', minOut: '54000', limit: '54000', memo: `=:b:${ME_BTC}:54000`, vault: V_ETH, vaultPubKey: KEY, router: ROUTER, expiry: now + 900, approveGas: '0', ...x }, ...o };
}
const five = (f: (k: number) => ThorView | Error = () => view()) => { const hosts = vaultHosts(); return operators((h) => f(hosts.indexOf(h))); };

describe('cross-chain swap, Bitcoin source', () => {
  it('signs the transaction it built itself — vault, change to the wallet, memo — after its own operators confirmed the vault', async () => {
    const { signer, store, pk, nowRef, calls } = await setup(five()), i = btc(nowRef.t);
    const out = await signer.sign(i, pk.assert(intentHash(i)));
    const tx = Transaction.fromRaw(hex.decode(out.raw), { allowUnknownOutputs: true });
    expect(tx.outputsLength).toBe(3); expect(tx.id).toBe(out.txid);
    expect(utxoPaymentTo(out.raw, 'bitcoin', V_BTC)).toEqual({ txid: out.txid, paid: 60_000n, memo: `=:e:${ME_EVM}:2000000` });
    expect(utxoPaymentTo(out.raw, 'bitcoin', ME_BTC).paid).toBe(89_300n);
    expect(calls).toEqual([{ chain: 'BTC', vaultPubKey: KEY, router: null, amount: 60_000n }]);
    expect(store.state.spent[`${new Date(nowRef.t * 1000).toISOString().slice(0, 10)}|bitcoin:BTC`]).toBe('60000'); // counted like a send
    const types = store.state.journal.map((r) => r.type);
    expect(types.slice(-2)).toEqual(['xswap.vault_confirmed', 'sign.ok']);
    expect(store.state.journal.at(-2)!.data).toMatchObject({ vault: V_BTC, vaultPubKey: KEY, operators: ['liquify', 'rorcual', 'ibs', 'thorwallet', 'keplr'], churnHeight: 900 });
    expect(store.state.journal.at(-1)!.data).toMatchObject({ to: V_BTC, xswap: 'thorchain', toNetwork: 'ethereum', memo: `=:e:${ME_EVM}:2000000` });
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'replay' }); // never twice: no replacement transaction can be signed
  });
  it('signs with two operators silent, as long as three confirm', async () => {
    const { signer, pk, nowRef } = await setup(five((k) => (k < 2 ? new Error('timeout') : view()))), i = btc(nowRef.t);
    await expect(signer.sign(i, pk.assert(intentHash(i)))).resolves.toMatchObject({ txid: expect.any(String) });
  });
  it.each<[string, (k: number) => ThorView | Error, RegExp]>([
    ['only two operators answer', (k) => (k < 3 ? new Error('down') : view()), /only 2 THORNode/],
    ['one operator does not know the vault (a lying API would need every operator to lie)', (k) => (k === 4 ? { ...view(), vaults: [{ ...view().vaults[0]!, pubKey: EVIL }] } : view()), /does not list this vault/],
    ['one operator lists it as retiring', (k) => (k === 0 ? view({ status: 'RetiringVault' }) : view()), /RetiringVault/],
    ['one operator is stale', (k) => (k === 2 ? view({ height: 900 }) : view()), /blocks behind/],
    ['one operator reports the chain halted', (k) => (k === 1 ? view({ halted: true }) : view()), /halted/],
    ['an operator answers nonsense and only two remain', (k) => (k === 0 ? view() : k === 1 ? view() : ({ height: Number.NaN, inbound: [], vaults: [] } as ThorView)), /only 2 THORNode/],
  ])('refuses when %s — nothing is recorded as spent', async (_l, f, re) => {
    const { signer, store, pk, nowRef } = await setup(five(f)), i = btc(nowRef.t);
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'vault_unconfirmed', message: expect.stringMatching(re) });
    expect(store.state.spent).toEqual({}); expect(store.state.used[i.proposalId]).toBeUndefined();
    expect(store.state.journal.at(-1)).toMatchObject({ type: 'sign.denied' });
  });
  it('refuses every cross-chain swap when no vault view is configured (fail closed)', async () => {
    const { signer, pk, nowRef } = await setup(), i = btc(nowRef.t);
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'vault_unconfirmed' });
    await expect(noVaults.check({ chain: 'BTC', vaultPubKey: KEY, router: null, amount: 1n })).rejects.toThrow();
  });
  it('refuses, before asking any operator, what it can disprove alone', async () => {
    const { signer, pk, nowRef, calls } = await setup(five());
    const no = async (i: Intent, re: RegExp) => { await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(re); };
    const evilAddr = thorVaultAddress(EVIL, 'bitcoin');
    await no(btc(nowRef.t, {}, { vault: evilAddr }), /not the address of the committed vault key/); // API swaps the address, keeps the genuine key
    await no(btc(nowRef.t, {}, { memo: `=:e:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:2000000` }), /memo does not match/); // pays someone else
    await no(btc(nowRef.t, {}, { limit: '1', memo: `=:e:${ME_EVM}:1` }), /below the approved minimum/);
    await no(btc(nowRef.t, {}, { memo: `=:e:${ME_EVM}:2000000:t:50` }), /memo does not match/); // affiliate
    await no(btc(nowRef.t, {}, { memo: `=:e:${ME_EVM}/${ME_BTC}:2000000` }), /memo does not match/); // refund override
    await no(btc(nowRef.t, { to: ME_BTC }), /destination equals source/);
    await no(btc(nowRef.t, { amount: '80000', btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '150000' }], change: '69300', fee: '700' } }), /per-transaction limit/);
    await no(btc(nowRef.t, { btc: { inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: '60700' }], change: '0', fee: '700' } }), /change/);
    await no(btc(nowRef.t, {}, { expiry: nowRef.t + 5000 }), /expiry/);
    expect(calls).toEqual([]);
  });
  it('a vault key the API invented, with its matching address, passes every offline check and is stopped by the operators', async () => {
    const { signer, pk, nowRef, calls } = await setup(five()), evilAddr = thorVaultAddress(EVIL, 'bitcoin');
    const i = btc(nowRef.t, {}, { vault: evilAddr, vaultPubKey: EVIL });
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'vault_unconfirmed', message: expect.stringMatching(/does not list this vault/) });
    expect(calls).toHaveLength(1);
  });
  it('the passkey must have approved exactly this intent (vault and memo included)', async () => {
    const { signer, pk, nowRef } = await setup(five()), a = btc(nowRef.t), b = { ...a, xswap: { ...a.xswap!, limit: '2000001', memo: `=:e:${ME_EVM}:2000001`, minOut: '20000010000000000' } };
    await expect(signer.sign(b, pk.assert(intentHash(a)))).rejects.toMatchObject({ code: 'bad_approval' });
  });
});

describe('cross-chain swap, Ethereum source', () => {
  it('signs one call to the pinned router with the committed vault, memo and expiry; checks the router with its operators', async () => {
    const { signer, pk, nowRef, calls } = await setup(five(() => view({ chain: 'ETH', router: ROUTER }))), i = evm(nowRef.t);
    const out = await signer.sign(i, pk.assert(intentHash(i))), tx = parseTransaction(out.raw as Hex);
    expect(await recoverTransactionAddress({ serializedTransaction: out.raw as never })).toBe(ME_EVM);
    expect(tx.to).toBe(ROUTER.toLowerCase()); expect(tx.value).toBe(20_000_000_000_000_000n); expect(out.pre).toBeUndefined();
    expect(decodeFunctionData({ abi: THOR_ROUTER_ABI, data: tx.data! }).args).toEqual([V_ETH, '0x0000000000000000000000000000000000000000', 20_000_000_000_000_000n, `=:b:${ME_BTC}:54000`, BigInt(nowRef.t + 900)]);
    expect(calls).toEqual([{ chain: 'ETH', vaultPubKey: KEY, router: ROUTER, amount: 2_000_000n }]);
  });
  it('refuses when an operator names another router, and when the intent does', async () => {
    const a = await setup(five((k) => view({ chain: 'ETH', router: k === 3 ? '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' : ROUTER }))), i = evm(a.nowRef.t);
    await expect(a.signer.sign(i, a.pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'vault_unconfirmed', message: expect.stringMatching(/another router/) });
    const j = evm(a.nowRef.t, {}, { router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' });
    await expect(a.signer.sign(j, a.pk.assert(intentHash(j)))).rejects.toThrow(/pinned THORChain router/);
  });
});
