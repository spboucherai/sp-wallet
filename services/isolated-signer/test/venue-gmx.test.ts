// GMX v2 orders, signer side (venue-gmx.ts + the `gmx` branch of Signer.sign): the venue policy approved with a passkey, the
// transaction BUILT by the signer from the intent, and everything it refuses. No network: the price view is scripted; nothing
// is sent. The same signer class runs against the real GMX contracts on a fork in scripts/fork-gmx.mts.
// Mnemonic: the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { intentHash, verifyAuditChain, type Intent } from '@spw/core';
import { decodeGmxCalldata, GMX_EXCHANGE_ROUTER_ABI, GMX_MARKETS, GMX_PINS, GMX_POLICY_BOUNDS, gmxAcceptablePrice, gmxAuthorizationHash, gmxUsdToRaw, jurisdictionAck, ZERO_ADDRESS, type GmxAuthorization, type GmxCreateOrderParams, type GmxSection } from '@spw/derivatives/live';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import type { PriceView } from '../src/prices.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.evm, ETH = GMX_MARKETS.find((m) => m.priceSymbol === 'ETH')!, BTC = GMX_MARKETS.find((m) => m.priceSymbol === 'BTC')!, USDC = ETH.collateral[0]!.token, OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const P = GMX_PINS, NOW = 1794398400;
let n = 0;
const uuid = () => `8d2c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`;

function setup(o: { authorize?: boolean; policy?: Partial<GmxAuthorization['policy']> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-gmx-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const t = { now: NOW }, px: Record<string, number | null> = { ETH: 2000, BTC: 73_000, USDC: 1 };
  const prices: PriceView = { get: async (symbols) => Object.fromEntries(symbols.map((s): [string, number] => { const p = px[s]; if (p === null || p === undefined) throw new Error(`price sources disagree on ${s}`); return [s, p]; })) };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, prices);
  const pk = new TestPasskey(RP, ORIGIN);
  const authId = uuid();
  const auth: GmxAuthorization = { v: 1, authorizationId: authId, keyId: keys.keyId, venue: 'gmx', network: 'arbitrum', account: ME.toLowerCase(), mode: 'MANUAL_LIVE', contracts: P.id, exchangeRouter: P.exchangeRouter.address,
    policy: { allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 3, maxPriceDeviationBps: 100, maxExecutionFeeWei: '160000000000000', ...o.policy }, createdAt: NOW, expiresAt: NOW + 7 * 86400, ackSha256: jurisdictionAck('gmx', 'fr').sha256 };
  const section = (over: Partial<GmxSection> = {}): GmxSection => ({ venue: 'gmx-v2', action: 'increase', authorizationId: authId, exchangeRouter: P.exchangeRouter.address, router: P.router.address, orderVault: P.orderVault.address, market: ETH.market, indexToken: ETH.indexToken,
    collateralToken: USDC, orderType: 'MarketIncrease', isLong: true, sizeDeltaUsd: gmxUsdToRaw('60').toString(), acceptablePrice: gmxAcceptablePrice('2000', 50, { isLong: true, increase: true, indexDecimals: 18 }).toString(), triggerPrice: '0',
    executionFee: '129000000000000', approveGas: '60000', ...over });
  const intent = (g: Partial<GmxSection> = {}, over: Partial<Intent> = {}): Intent => {
    const s = section(g), gas = 2_500_000n, mf = 41_000_000n;
    return { v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'arbitrum', chainRef: '42161', asset: USDC, symbol: 'USDC', decimals: 6, amount: '20000000', from: ME, to: P.exchangeRouter.address, maxFee: ((gas + BigInt(s.approveGas)) * mf + BigInt(s.executionFee)).toString(),
      createdAt: t.now, expiresAt: t.now + 120, policyVersion: store.policy.version, gmx: s, evm: { nonce: 4, gasLimit: gas.toString(), maxFeePerGas: mf.toString(), maxPriorityFeePerGas: '1000000' }, ...over };
  };
  const decrease = (g: Partial<GmxSection> = {}) => intent({ action: 'decrease', orderType: 'MarketDecrease', approveGas: '0', acceptablePrice: gmxAcceptablePrice('2000', 50, { isLong: true, increase: false, indexDecimals: 18 }).toString(), ...g }, { amount: '0' });
  const cancel = (key = `0x${'ab'.repeat(32)}`, g: Partial<GmxSection> = {}) => intent({ action: 'cancel', orderType: 'None', market: ZERO_ADDRESS, indexToken: ZERO_ADDRESS, collateralToken: ZERO_ADDRESS, isLong: false, sizeDeltaUsd: '0', acceptablePrice: '0', executionFee: '0', approveGas: '0', orderKey: key, ...g },
    { asset: 'native', symbol: 'ETH', decimals: 18, amount: '0' });
  const sign = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
  const ready = (async () => { await signer.enroll({ credential: pk.credential(), setupToken: 'tok' }); if (o.authorize !== false) await signer.gmxAuthorize(auth, pk.assert(gmxAuthorizationHash(auth))); })();
  return { store, signer, pk, t, px, auth, authId, intent, decrease, cancel, sign, ready };
}
const refused = async (p: Promise<unknown>) => p.then(() => { throw new Error('was not refused'); }, (e: any) => `${e.code}: ${e.message}`);

describe('GMX venue policy (authorization)', () => {
  it('needs the owner\'s passkey over the canonical hash, the wallet\'s own account, the reviewed contract set and GMX\'s acknowledgement', async () => {
    const s = setup({ authorize: false }); await s.ready;
    const a = s.auth, as = (x: GmxAuthorization) => s.pk.assert(gmxAuthorizationHash(x));
    expect(await refused(s.signer.gmxAuthorize(a, undefined))).toMatch(/bad_approval: the owner's passkey approval is required/);
    expect(await refused(s.signer.gmxAuthorize(a, as({ ...a, policy: { ...a.policy, maxLeverage: 20 } })))).toMatch(/bad_approval/); // approved another policy
    expect(await refused(s.signer.gmxAuthorize({ ...a, account: OTHER.toLowerCase() }, as({ ...a, account: OTHER.toLowerCase() })))).toMatch(/wrong_source/);
    expect(await refused(s.signer.gmxAuthorize({ ...a, keyId: 'spw-0000000000000000' }, as({ ...a, keyId: 'spw-0000000000000000' })))).toMatch(/wrong_key/);
    expect(await refused(s.signer.gmxAuthorize({ ...a, contracts: 'gmx-v2-arbitrum-2027-01-01' }, as({ ...a, contracts: 'gmx-v2-arbitrum-2027-01-01' })))).toMatch(/unsupported: the authorization names another GMX contract set/);
    expect(await refused(s.signer.gmxAuthorize({ ...a, ackSha256: jurisdictionAck('hyperliquid', 'fr').sha256 }, as({ ...a, ackSha256: jurisdictionAck('hyperliquid', 'fr').sha256 })))).toMatch(/acknowledgement/);
    expect(await refused(s.signer.gmxAuthorize({ ...a, policy: { ...a.policy, maxLeverage: 21 } } as never, as(a)))).toMatch(/bad_request/);
    expect(await refused(s.signer.gmxAuthorize({ ...a, mode: 'MANDATE_LIVE' } as never, as(a)))).toMatch(/bad_request/); // no autonomous mode exists for GMX
    const fat = { ...a, policy: { ...a.policy, maxExecutionFeeWei: (GMX_POLICY_BOUNDS.maxExecutionFeeWei + 1n).toString() } };
    expect(await refused(s.signer.gmxAuthorize(fat, as(fat)))).toMatch(/execution fee ceiling/);
    expect(s.signer.status().gmx).toEqual([]);
    const r = await s.signer.gmxAuthorize(a, as(a));
    expect(r).toEqual({ authorizationId: s.authId, hash: Buffer.from(gmxAuthorizationHash(a)).toString('hex') });
    expect(s.signer.status().gmx).toMatchObject([{ revoked: false, expired: false, current: true, today: { increases: 0, reduces: 0 } }]);
    expect(await refused(s.signer.gmxAuthorize(a, as(a)))).toMatch(/replay/);
    const b = { ...a, authorizationId: uuid() };
    expect(await refused(s.signer.gmxAuthorize(b, as(b)))).toMatch(/conflict: another GMX authorization is active/);
    expect(s.signer.gmxRevoke(s.authId).revoked).toBe(true);
    await s.signer.gmxAuthorize(b, as(b)); // after a revocation a new one can be approved
    expect(s.signer.status().gmx.map((x) => x.revoked)).toEqual([true, false]);
    expect(verifyAuditChain(s.store.state.journal)).toBeNull();
  });
  it('is refused while the emergency halt is active', async () => {
    const s = setup({ authorize: false }); await s.ready; s.signer.halt();
    expect(await refused(s.signer.gmxAuthorize(s.auth, s.pk.assert(gmxAuthorizationHash(s.auth))))).toMatch(/policy: emergency halt/);
  });
});

describe('a GMX order is built by the signer', () => {
  it('increase: exact-amount approval of the pinned Router + multicall[sendWnt, sendTokens, createOrder] with msg.value = the execution fee, signed by the wallet key', async () => {
    const s = setup(); await s.ready;
    const i = s.intent(), out = await s.sign(i);
    expect(out.hash).toBe(Buffer.from(intentHash(i)).toString('hex'));
    const pre = parseTransaction(out.pre!.raw as Hex), tx = parseTransaction(out.raw as Hex);
    expect(await recoverTransactionAddress({ serializedTransaction: out.raw as never })).toBe(ME);
    expect(pre).toMatchObject({ to: USDC.toLowerCase(), nonce: 4, chainId: 42161 });
    expect(decodeFunctionData({ abi: erc20Abi, data: pre.data! })).toMatchObject({ functionName: 'approve', args: [P.router.address, 20_000_000n] });
    expect(tx).toMatchObject({ to: P.exchangeRouter.address.toLowerCase(), nonce: 5, value: 129000000000000n, gas: 2_500_000n });
    const d = decodeGmxCalldata(tx.data!), p = d.calls[2]!.args[0] as GmxCreateOrderParams;
    expect(d.calls.map((c) => c.fn)).toEqual(['sendWnt', 'sendTokens', 'createOrder']);
    expect(d.calls[0]!.args).toEqual([P.orderVault.address, 129000000000000n]); expect(d.calls[1]!.args).toEqual([USDC, P.orderVault.address, 20_000_000n]);
    expect(p.addresses).toEqual({ receiver: ME, cancellationReceiver: ME, callbackContract: ZERO_ADDRESS, uiFeeReceiver: ZERO_ADDRESS, market: ETH.market, initialCollateralToken: USDC, swapPath: [] });
    expect(p).toMatchObject({ orderType: 2, isLong: true, numbers: { sizeDeltaUsd: 60n * 10n ** 30n, callbackGasLimit: 0n, minOutputAmount: 0n } });
    const st = s.signer.status();
    expect(st.gmx[0]!.today).toEqual({ increases: 1, reduces: 0 }); expect(st.spentToday['arbitrum:USDC']).toBe('20000000');
    expect(s.store.state.journal.filter((j) => j.type === 'gmx.sign.ok')).toMatchObject([{ data: { action: 'increase', market: 'ETH/USD [WETH-USDC]', sizeDeltaUsd: '60', signerPrice: '2000.00000000', approval: true } }]);
    expect(await refused(s.sign(i))).toMatch(/replay/);
  });
  it('decrease and cancel move no asset: no amount limit applies, nothing is counted as spent, each needs its own passkey', async () => {
    const s = setup(); await s.ready;
    const d = await s.sign(s.decrease({ sizeDeltaUsd: gmxUsdToRaw('5000').toString() })); // closing is not bound by the order-size limit
    expect(d.pre).toBeUndefined();
    const dt = parseTransaction(d.raw as Hex);
    expect(decodeGmxCalldata(dt.data!).calls.map((c) => c.fn)).toEqual(['sendWnt', 'createOrder']); expect(dt.value).toBe(129000000000000n);
    const c = await s.sign(s.cancel()), ct = parseTransaction(c.raw as Hex);
    expect(decodeGmxCalldata(ct.data!)).toMatchObject({ fn: 'cancelOrder', calls: [{ args: [`0x${'ab'.repeat(32)}`] }] }); expect(ct.value ?? 0n).toBe(0n);
    expect(s.signer.status().gmx[0]!.today).toEqual({ increases: 0, reduces: 2 }); expect(s.signer.status().spentToday['arbitrum:USDC'] ?? '0').toBe('0');
    expect(await refused(s.signer.sign(s.cancel(), undefined as never))).toMatch(/bad_approval/);
    expect(await refused(s.signer.sign(s.decrease(), s.pk.assert(intentHash(s.cancel()))))).toMatch(/bad_approval/);
    expect(await refused(s.sign({ ...s.decrease(), amount: '1' }))).toMatch(/policy: (amount|this intent moves an amount)/);
  });

  const cases: [string, (s: ReturnType<typeof setup>) => Intent, RegExp][] = [
    ['another router', (s) => s.intent({ exchangeRouter: OTHER }, { to: OTHER }), /unsupported: the destination is not the pinned GMX ExchangeRouter/],
    ['another token spender', (s) => s.intent({ router: OTHER }), /unsupported: the token spender is not the pinned GMX Router/],
    ['another vault', (s) => s.intent({ orderVault: OTHER }), /unsupported: the vault is not the pinned GMX OrderVault/],
    ['a market that is not pinned', (s) => s.intent({ market: '0x450bb6774Dd8a756274E0ab4107953259d2ac541' }), /unsupported: this market is not in the wallet's pinned GMX market table/],
    ['a pinned market outside the authorization', (s) => s.intent({ market: BTC.market, indexToken: BTC.indexToken, acceptablePrice: gmxAcceptablePrice('73000', 50, { isLong: true, increase: true, indexDecimals: 8 }).toString() }), /policy: BTC\/USD \[WBTC\.b-USDC\] is not allowed/],
    ['another collateral token', (s) => s.intent({ collateralToken: ETH.longToken }), /unsupported: this collateral token is not accepted/],
    ['a size above the leverage bound', (s) => s.intent({ sizeDeltaUsd: gmxUsdToRaw('60.01').toString() }), /policy: leverage 3\.01× is above the authorized 3×/],
    ['a size above the order limit', (s) => s.intent({ sizeDeltaUsd: gmxUsdToRaw('100.5').toString() }, { amount: '40000000' }), /policy: order size 100\.5 USD is above the authorized 100/],
    ['an execution fee above the authorized ceiling', (s) => s.intent({ executionFee: '160000000000001' }), /policy: execution fee 160000000000001 wei is above the authorized 160000000000000/],
    ['an acceptable price outside the signer\'s band', (s) => s.intent({ acceptablePrice: gmxAcceptablePrice('2000', 101, { isLong: true, increase: true, indexDecimals: 18 }).toString() }), /price: acceptable price 2020\.2 is more than 100 bps away from the signer's own ETH price 2000/],
    ['a close priced outside the band', (s) => s.decrease({ acceptablePrice: gmxAcceptablePrice('2000', 150, { isLong: true, increase: false, indexDecimals: 18 }).toString() }), /price: acceptable price 1970/],
    ['collateral above the wallet\'s per-transfer limit', (s) => s.intent({ sizeDeltaUsd: gmxUsdToRaw('60').toString() }, { amount: '50000001' }), /policy: amount above per-transaction limit for arbitrum:USDC/],
    ['fees above the wallet\'s fee ceiling', (s) => s.intent({}, { maxFee: '300000000000001' }), /policy: fee ceiling above policy/],
    ['gas and fee above what was approved', (s) => s.intent({}, { maxFee: '100000000000000' }), /unsupported: gas and execution fee exceed the approved maximum/],
    ['another authorization id', (s) => s.intent({ authorizationId: '8d2c1f0e-8f5f-4b1e-9c56-ffffffffffff' }), /not_authorized/],
    ['a trigger price', (s) => s.intent({ triggerPrice: '5' }), /unsupported: market orders carry no trigger price/],
    ['another sender', (s) => s.intent({}, { from: OTHER }), /wrong_source/],
    ['another chain', (s) => s.intent({}, { network: 'base', chainRef: '8453' }), /unsupported: GMX orders are made on Arbitrum One only/],
    ['an expired approval window', (s) => s.intent({}, { createdAt: NOW - 400, expiresAt: NOW - 280 }), /policy: approval window expired/],
    ['a cancellation carrying an order', (s) => s.cancel(undefined, { market: ETH.market }), /unsupported: a cancellation carries no order field/],
  ];
  it.each(cases)('refuses %s', async (_l, make, re) => {
    const s = setup(); await s.ready;
    expect(await refused(s.sign(make(s)))).toMatch(re);
    expect(s.store.state.journal.some((j) => j.type === 'sign.ok' || j.type === 'gmx.sign.ok')).toBe(false);
    expect(s.signer.status().gmx[0]!.today).toEqual({ increases: 0, reduces: 0 });
  });
  it('has no field for a receiver, a callback contract, a UI fee receiver, a swap path or a referral code', async () => {
    const s = setup(); await s.ready;
    for (const [k, v] of [['receiver', OTHER], ['cancellationReceiver', OTHER], ['callbackContract', OTHER], ['uiFeeReceiver', OTHER], ['swapPath', [BTC.market]], ['referralCode', `0x${'11'.repeat(32)}`], ['minOutputAmount', '1'], ['dataList', []]] as const) {
      const i = s.intent(); (i.gmx as unknown as Record<string, unknown>)[k] = v;
      expect(await refused(s.signer.sign(i, s.pk.assert(new Uint8Array(32))))).toMatch(/bad_request: malformed intent/);
    }
  });
  it('fails closed without its own price, and when the collateral token cannot be priced', async () => {
    const s = setup(); await s.ready;
    s.px.ETH = null; expect(await refused(s.sign(s.intent()))).toMatch(/no_price: the signer could not establish its own market price for ETH \/ USDC/);
    expect(await refused(s.sign(s.decrease()))).toMatch(/no_price/); // a close too: the worst price cannot be judged
    s.px.ETH = 2000; s.px.USDC = null; expect(await refused(s.sign(s.intent()))).toMatch(/no_price/);
    await s.sign(s.cancel()); // a cancellation needs no price
  });
  it('enforces the daily count, the wallet\'s daily USDC limit, the expiry, the revocation, the halt and the reviewed contract set', async () => {
    const s = setup(); await s.ready;
    for (let k = 0; k < 3; k++) await s.sign(s.intent({}, { evm: { nonce: 4 + 2 * k, gasLimit: '2500000', maxFeePerGas: '41000000', maxPriorityFeePerGas: '1000000' } }));
    expect(await refused(s.sign(s.intent({ sizeDeltaUsd: gmxUsdToRaw('30').toString() }, { amount: '10000000' })))).toMatch(/policy: daily order count reached/);
    await s.sign(s.decrease()); // reducing stays possible
    const u = setup({ policy: { maxOrdersPerDay: 50 } }); await u.ready;
    for (let k = 0; k < 2; k++) await u.sign(u.intent({ sizeDeltaUsd: gmxUsdToRaw('100').toString() }, { amount: '45000000' }));
    expect(await refused(u.sign(u.intent({ sizeDeltaUsd: gmxUsdToRaw('30').toString() }, { amount: '10000001' })))).toMatch(/policy: daily limit exceeded for arbitrum:USDC/);
    const e = setup(); await e.ready; e.t.now = NOW + 7 * 86400;
    expect(await refused(e.sign(e.intent()))).toMatch(/expired: the GMX authorization expired/);
    const r = setup(); await r.ready; r.signer.gmxRevoke(r.authId);
    expect(await refused(r.sign(r.intent()))).toMatch(/revoked/); expect(await refused(r.sign(r.cancel()))).toMatch(/revoked/);
    const h = setup(); await h.ready; h.signer.halt();
    expect(await refused(h.sign(h.intent()))).toMatch(/policy: emergency halt/);
    // V11 (B-01): the halt never blocks the way out — a decrease and a cancellation are still signed (with the passkey), an increase never
    const dec = h.decrease(), out = await h.sign(dec);
    expect(out.pre).toBeUndefined();
    const dtx = parseTransaction(out.raw as `0x${string}`), calls = decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: dtx.data! });
    expect(dtx.to!.toLowerCase()).toBe(P.exchangeRouter.address.toLowerCase());
    expect(calls.functionName).toBe('multicall');
    const inner = (calls.args![0] as `0x${string}`[]).map((d) => decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: d }));
    expect(inner.map((x) => x.functionName)).toEqual(['sendWnt', 'createOrder']);                      // no sendTokens: no collateral leaves
    expect((inner[1]!.args![0] as { orderType: number }).orderType).toBe(4);                            // MarketDecrease
    expect((await h.sign(h.cancel())).txid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.signer.status().gmx[0]!.today).toEqual({ increases: 0, reduces: 2 });
    expect(await refused(h.signer.sign(h.decrease(), h.pk.assert(new Uint8Array(32))))).toMatch(/bad_approval/);          // the passkey is still required
    expect(await refused(h.signer.sign(h.decrease(), undefined as never))).toMatch(/bad_approval|unknown_credential/);
    // an intent that calls itself a decrease or a cancellation but is not one never passes: the signer builds the transaction itself
    expect(await refused(h.sign(h.intent({ action: 'decrease' })))).toMatch(/policy: this intent moves an amount|unsupported/);                 // still sends collateral
    expect(await refused(h.sign(h.intent({ action: 'decrease', orderType: 'MarketIncrease', approveGas: '0' }, { amount: '0' })))).toMatch(/unsupported: a decrease is a MarketDecrease order/);
    expect(await refused(h.sign(h.intent({ action: 'decrease', orderType: 'MarketDecrease' }, { amount: '0' })))).toMatch(/unsupported: a decrease needs no token approval/);
    expect(await refused(h.sign(h.intent({ action: 'increase', orderType: 'MarketDecrease', approveGas: '0' }, { amount: '0' })))).toMatch(/policy: emergency halt/);
    expect(await refused(h.sign(h.cancel(undefined, { sizeDeltaUsd: '1' })))).toMatch(/unsupported: a cancellation carries no order field/);
    expect(await refused(h.sign(h.decrease({ market: BTC.market, indexToken: BTC.indexToken })))).toMatch(/policy: .*not allowed by the authorization/);   // the venue policy still applies
    // everything else of the wallet stays blocked under halt: a transfer, and a withdrawal of nothing to do with GMX
    expect(await refused(h.sign({ v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'arbitrum', chainRef: '42161', asset: USDC, symbol: 'USDC', decimals: 6, amount: '5000000', from: ME, to: '0x000000000000000000000000000000000000dEaD',
      maxFee: '3690000000000', createdAt: NOW, expiresAt: NOW + 120, policyVersion: h.store.policy.version, evm: { nonce: 4, gasLimit: '90000', maxFeePerGas: '41000000', maxPriorityFeePerGas: '1000000' } }))).toMatch(/policy: emergency halt/);
    h.signer.gmxRevoke(h.authId);
    expect(await refused(h.sign(h.decrease()))).toMatch(/revoked/);                                     // a revoked authorization signs nothing, halt or not
    const c = setup(); await c.ready; c.store.state.gmx![c.authId]!.authorization = { ...c.auth, contracts: 'gmx-v2-arbitrum-2026-01-01' }; // an authorization given to an older build's table
    expect(await refused(c.sign(c.intent()))).toMatch(/contract_changed: .*a new review and a new authorization are needed/);
    expect(c.signer.status().gmx[0]!.current).toBe(false);
  });
  it('refuses a plain transfer to any pinned GMX contract, and leaves ordinary transfers alone', async () => {
    const s = setup(); await s.ready;
    const plain = (to: string): Intent => ({ v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'arbitrum', chainRef: '42161', asset: USDC, symbol: 'USDC', decimals: 6, amount: '5000000', from: ME, to, maxFee: '3690000000000', createdAt: NOW, expiresAt: NOW + 120,
      policyVersion: s.store.policy.version, evm: { nonce: 4, gasLimit: '90000', maxFeePerGas: '41000000', maxPriorityFeePerGas: '1000000' } });
    for (const c of ['orderVault', 'exchangeRouter', 'router', 'dataStore'] as const) expect(await refused(s.sign(plain(P[c].address)))).toMatch(/gmx: this destination is a GMX contract/);
    const ok = await s.sign(plain(OTHER));
    expect(decodeFunctionData({ abi: erc20Abi, data: parseTransaction(ok.raw as Hex).data! })).toMatchObject({ functionName: 'transfer', args: [OTHER, 5_000_000n] });
  });
});

describe('HTTP surface', () => {
  it('POST /venue/gmx/authorize and /venue/gmx/revoke exist behind the same HMAC channel', async () => {
    const s = setup({ authorize: false }); await s.ready;
    const secret = 'k'.repeat(48), server = createSignerServer(s.signer, secret);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const post = async (path: string, body: unknown, auth = true) => { const b = JSON.stringify(body); const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: b, headers: auth ? { 'x-spw-auth': authHeader(secret, 'POST', path, b) } : {} }); return { status: r.status, body: await r.json() as any }; };
    try {
      expect((await post('/venue/gmx/authorize', { authorization: s.auth }, false)).status).toBe(401);
      expect((await post('/venue/gmx/authorize', { authorization: s.auth })).body).toMatchObject({ error: 'bad_approval' });
      expect((await post('/venue/gmx/authorize', { authorization: s.auth, assertion: s.pk.assert(gmxAuthorizationHash(s.auth)) })).body).toMatchObject({ authorizationId: s.authId });
      expect((await post('/venue/gmx/revoke', { authorizationId: s.authId })).body).toMatchObject({ revoked: true });
      expect((await post('/venue/gmx/revoke', { authorizationId: uuid() })).status).toBe(404);
    } finally { server.close(); }
  });
});
