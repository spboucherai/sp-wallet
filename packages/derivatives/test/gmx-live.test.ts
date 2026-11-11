// GMX v2 trading — the shared, pure part (packages/derivatives/src/live/gmx.ts): ABI encoding against the VERIFIED ABI and
// against real transactions and events of other people (fixtures recorded read-only by scripts/record-gmx-order-fixtures.mts),
// exact price / USD conversions, the intent verification, the venue policy and the authorization hash.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Abi, type Hex } from 'viem';
import {
  buildGmxTxs, decodeGmxCalldata, decodeGmxEvent, GMX_DATASTORE_KEYS, GMX_EXCHANGE_ROUTER_ABI, GMX_MARKETS, GMX_PINS, GMX_PINNED_CONTRACTS, GMX_REQUIRED_ROLES, GMX_ROLE_KEYS, gmxAcceptablePrice, gmxAuthorizationHashHex, gmxCalldata,
  gmxEventKey, gmxKey, gmxMarket, gmxOrderCreatedDiff, gmxPolicyVerdict, gmxPriceFromRaw, gmxPriceToRaw, gmxUsdFromRaw, gmxUsdToRaw, jurisdictionAck, jurisdictionAckOf, scaleExact, validateGmxAuthorization, verifyGmxIntent,
  ZERO_ADDRESS, ZERO_BYTES32, type GmxAuthorization, type GmxCreateOrderParams, type GmxIntent, type GmxPolicy,
} from '../src/live/index.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/gmx-live/${name}`, import.meta.url), 'utf8'));
const VERIFIED = fx('exchange-router-abi.json').abi as Abi;
const REAL = fx('orders.json') as { items: { kind: string; tx: { hash: string; from: string; to: string; input: Hex; value: string }; logs: { address: string; topics: string[]; data: string }[] }[] };

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', BTC = GMX_MARKETS[0]!, ETH = GMX_MARKETS[1]!, USDC = BTC.collateral[0]!;
const AUTH = '7a1c1f0e-8f5f-4b1e-9c56-0000000000aa';
function intent(over: Partial<GmxIntent> = {}, g: Partial<NonNullable<GmxIntent['gmx']>> = {}): GmxIntent {
  return { network: 'arbitrum', chainRef: '42161', asset: USDC.token, symbol: 'USDC', decimals: 6, amount: '20000000', from: ME, to: GMX_PINS.exchangeRouter.address, maxFee: '260000000000000',
    evm: { nonce: 7, gasLimit: '2000000', maxFeePerGas: '40000000', maxPriorityFeePerGas: '1000000' },
    gmx: { venue: 'gmx-v2', action: 'increase', authorizationId: AUTH, exchangeRouter: GMX_PINS.exchangeRouter.address, router: GMX_PINS.router.address, orderVault: GMX_PINS.orderVault.address, market: ETH.market, indexToken: ETH.indexToken,
      collateralToken: USDC.token, orderType: 'MarketIncrease', isLong: true, sizeDeltaUsd: gmxUsdToRaw('60').toString(), acceptablePrice: gmxPriceToRaw('2080.5', 18).toString(), triggerPrice: '0', executionFee: '170000000000000', approveGas: '60000', ...g },
    ...over };
}
const decrease = (g: Partial<NonNullable<GmxIntent['gmx']>> = {}) => intent({ amount: '0' }, { action: 'decrease', orderType: 'MarketDecrease', approveGas: '0', acceptablePrice: gmxPriceToRaw('2055', 18).toString(), ...g });
const KEY = `0x${'ab'.repeat(32)}`;
const cancel = (g: Partial<NonNullable<GmxIntent['gmx']>> = {}) => intent({ asset: 'native', symbol: 'ETH', decimals: 18, amount: '0', maxFee: '90000000000000' }, { action: 'cancel', orderType: 'None', market: ZERO_ADDRESS, indexToken: ZERO_ADDRESS, collateralToken: ZERO_ADDRESS,
  isLong: false, sizeDeltaUsd: '0', acceptablePrice: '0', executionFee: '0', approveGas: '0', orderKey: KEY, ...g });

describe('pinned tables', () => {
  it('role and DataStore keys are keccak256(abi.encode(name))', () => {
    for (const [name, key] of Object.entries(GMX_ROLE_KEYS)) expect(gmxKey(name)).toBe(key);
    for (const [name, key] of Object.entries(GMX_DATASTORE_KEYS)) expect(gmxKey(name)).toBe(key);
  });
  it('every pinned contract has an address, a hash and a size; the required roles name pinned contracts', () => {
    for (const c of GMX_PINNED_CONTRACTS) { expect(GMX_PINS[c].address).toMatch(/^0x[0-9a-fA-F]{40}$/); expect(GMX_PINS[c].codeSha256).toMatch(/^[0-9a-f]{64}$/); expect(GMX_PINS[c].codeBytes).toBeGreaterThan(1000); }
    expect(new Set(GMX_PINNED_CONTRACTS.map((c) => GMX_PINS[c].address.toLowerCase())).size).toBe(GMX_PINNED_CONTRACTS.length);
    for (const r of GMX_REQUIRED_ROLES) expect(GMX_PINNED_CONTRACTS).toContain(r.holder);
    expect(GMX_REQUIRED_ROLES.map((r) => `${r.holder}:${r.role}`)).toEqual(['exchangeRouter:CONTROLLER', 'exchangeRouter:ROUTER_PLUGIN', 'orderHandler:CONTROLLER']);
  });
  it('markets: USDC collateral only, the short token of both pools; lookups are case-insensitive but the intent must carry the pinned spelling', () => {
    for (const m of GMX_MARKETS) { expect(m.collateral.map((c) => c.symbol)).toEqual(['USDC']); expect(m.shortToken).toBe(USDC.token); }
    expect(gmxMarket(BTC.market.toLowerCase())).toBe(BTC);
    expect(gmxMarket('0x450bb6774Dd8a756274E0ab4107953259d2ac541')).toBeNull(); // ETH/USD [WETH-WETH]: a real GMX market, not pinned
  });
});

describe('exact conversions', () => {
  it('USD has 30 decimals; prices have 30 − token decimals', () => {
    expect(gmxUsdToRaw('1')).toBe(10n ** 30n);
    expect(gmxUsdFromRaw(gmxUsdToRaw('1234.000000000000000000000000000001'))).toBe('1234.000000000000000000000000000001');
    expect(gmxPriceToRaw('73634.3408', 8)).toBe(736343408n * 10n ** 18n); // BTC: 22 decimals (the dossier's Oracle API example has this magnitude)
    expect(gmxPriceToRaw('2063.55', 18)).toBe(206355n * 10n ** 10n); // ETH: 12 decimals
    expect(gmxPriceFromRaw(736743447840545300000000000n, 8)).toBe('73674.3447840545300000000000'.replace(/0+$/, ''));
    expect(gmxPriceFromRaw(gmxPriceToRaw('0.000000000001', 18), 18)).toBe('0.000000000001');
  });
  it('never rounds: a value the unit cannot carry is refused', () => {
    expect(() => gmxPriceToRaw('2063.1234567890123', 18)).toThrow(/more than 12 decimals/);
    expect(() => scaleExact('-1', 6)).toThrow(/negative/);
    expect(() => gmxUsdToRaw('1e3')).toThrow();
  });
  it('acceptable price: long open / short close above the reference, the others below, rounded to the worse side', () => {
    expect(gmxAcceptablePrice('2000', 50, { isLong: true, increase: true, indexDecimals: 18 })).toBe(gmxPriceToRaw('2010', 18));
    expect(gmxAcceptablePrice('2000', 50, { isLong: false, increase: true, indexDecimals: 18 })).toBe(gmxPriceToRaw('1990', 18));
    expect(gmxAcceptablePrice('2000', 50, { isLong: true, increase: false, indexDecimals: 18 })).toBe(gmxPriceToRaw('1990', 18));
    expect(gmxAcceptablePrice('2000', 50, { isLong: false, increase: false, indexDecimals: 18 })).toBe(gmxPriceToRaw('2010', 18));
    expect(gmxAcceptablePrice('0.333333333333', 1, { isLong: true, increase: true, indexDecimals: 18 })).toBe(333366666667n); // 0.3333666666663333… rounded up
    expect(gmxAcceptablePrice('0.333333333333', 1, { isLong: false, increase: true, indexDecimals: 18 })).toBe(333299999999n); // rounded down
    expect(() => gmxAcceptablePrice('2000', 10_001, { isLong: true, increase: true, indexDecimals: 18 })).toThrow();
  });
});

describe('ABI encoding against the verified ABI', () => {
  const sel = (abi: Abi, name: string, args: unknown[]) => encodeFunctionData({ abi, functionName: name, args } as never);
  it('every function of this build has the selector and the encoding of the verified ExchangeRouter ABI', () => {
    const p = verifyGmxIntent(intent(), ME).params!;
    const cases: [string, unknown[]][] = [['sendWnt', [GMX_PINS.orderVault.address, 123n]], ['sendTokens', [USDC.token, GMX_PINS.orderVault.address, 20_000_000n]], ['cancelOrder', [KEY]], ['createOrder', [p]], ['multicall', [['0x1234', '0xabcdef']]]];
    for (const [name, args] of cases) expect(sel(GMX_EXCHANGE_ROUTER_ABI as unknown as Abi, name, args), name).toBe(sel(VERIFIED, name, args));
  });
  it('the increase calldata = multicall[sendWnt, sendTokens, createOrder] rebuilt with the verified ABI', () => {
    const plan = verifyGmxIntent(intent(), ME);
    const ref = sel(VERIFIED, 'multicall', [[sel(VERIFIED, 'sendWnt', [GMX_PINS.orderVault.address, plan.executionFee]), sel(VERIFIED, 'sendTokens', [USDC.token, GMX_PINS.orderVault.address, plan.amount]), sel(VERIFIED, 'createOrder', [plan.params])]]);
    expect(gmxCalldata(plan)).toBe(ref);
    const d = verifyGmxIntent(decrease(), ME);
    expect(gmxCalldata(d)).toBe(sel(VERIFIED, 'multicall', [[sel(VERIFIED, 'sendWnt', [GMX_PINS.orderVault.address, d.executionFee]), sel(VERIFIED, 'createOrder', [d.params])]]));
    expect(gmxCalldata(verifyGmxIntent(cancel(), ME))).toBe(sel(VERIFIED, 'cancelOrder', [KEY]));
  });
});

describe('real GMX transactions (recorded read-only from Arbitrum One)', () => {
  const creates = REAL.items.filter((x) => x.kind === 'OrderCreated'), cancels = REAL.items.filter((x) => x.kind === 'OrderCancelled');
  it('the fixture holds several real Classic order transactions to the pinned ExchangeRouter', () => {
    expect(creates.length).toBeGreaterThanOrEqual(6);
    for (const x of REAL.items) expect(x.tx.to.toLowerCase()).toBe(GMX_PINS.exchangeRouter.address.toLowerCase());
  });
  it('the decoder round-trips real multicalls byte for byte, and its reading equals the verified ABI\'s', () => {
    let decoded = 0, orders = 0;
    for (const x of creates) {
      let d; try { d = decodeGmxCalldata(x.tx.input); } catch { continue; } // a transaction using a function this build never calls (updateOrder, sendNativeToken…) is outside its ABI
      decoded++;
      expect(d.fn).toBe('multicall');
      const ref = decodeFunctionData({ abi: VERIFIED, data: x.tx.input });
      expect((ref.args![0] as Hex[]).length).toBe(d.calls.length);
      (ref.args![0] as Hex[]).forEach((inner, k) => { const r = decodeFunctionData({ abi: VERIFIED, data: inner }); expect(r.functionName).toBe(d.calls[k]!.fn); expect(r.args).toEqual(d.calls[k]!.args); });
      // re-encode with THIS build's ABI: identical bytes
      const again = encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: 'multicall', args: [d.calls.map((c) => encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: c.fn, args: c.args } as never))] });
      expect(again).toBe(x.tx.input.toLowerCase());
      // the execution fee sent as msg.value is what sendWnt wraps (plus native collateral, when the order pays in ETH)
      const wnt = d.calls.filter((c) => c.fn === 'sendWnt').reduce((s, c) => s + (c.args[1] as bigint), 0n);
      expect(BigInt(x.tx.value)).toBe(wnt);
      orders += d.calls.filter((c) => c.fn === 'createOrder').length;
    }
    expect(decoded).toBeGreaterThanOrEqual(6);
    expect(orders).toBeGreaterThanOrEqual(6);
  });
  it('each real OrderCreated event decodes and carries exactly the fields of the createOrder call of its transaction', () => {
    let compared = 0;
    for (const x of creates) {
      let d; try { d = decodeGmxCalldata(x.tx.input); } catch { continue; }
      const calls = d.calls.filter((c) => c.fn === 'createOrder').map((c) => c.args[0] as GmxCreateOrderParams);
      const events = x.logs.map((l) => decodeGmxEvent(l)).filter((e) => e?.eventName === 'OrderCreated');
      expect(events.length).toBe(calls.length);
      events.forEach((e, k) => {
        const p = calls[k]!, f = e!.fields;
        expect(gmxEventKey(e!)).toMatch(/^0x[0-9a-f]{64}$/);
        expect(String(f.account).toLowerCase()).toBe(x.tx.from.toLowerCase());
        expect(String(e!.topic2).toLowerCase()).toBe(`0x${'0'.repeat(24)}${x.tx.from.slice(2).toLowerCase()}`);
        expect(f.receiver).toBe(p.addresses.receiver); expect(f.cancellationReceiver).toBe(p.addresses.cancellationReceiver); expect(f.callbackContract).toBe(p.addresses.callbackContract);
        expect(f.uiFeeReceiver).toBe(p.addresses.uiFeeReceiver); expect(f.market).toBe(p.addresses.market); expect(f.initialCollateralToken).toBe(p.addresses.initialCollateralToken); expect(f.swapPath).toEqual(p.addresses.swapPath);
        expect(f.orderType).toBe(BigInt(p.orderType)); expect(f.sizeDeltaUsd).toBe(p.numbers.sizeDeltaUsd); expect(f.triggerPrice).toBe(p.numbers.triggerPrice); expect(f.acceptablePrice).toBe(p.numbers.acceptablePrice);
        expect(f.minOutputAmount).toBe(p.numbers.minOutputAmount); expect(f.isLong).toBe(p.isLong); expect(f.shouldUnwrapNativeToken).toBe(p.shouldUnwrapNativeToken); expect(f.autoCancel).toBe(p.autoCancel);
        expect(f.executionFee as bigint).toBeGreaterThanOrEqual(p.numbers.executionFee); // "whatever WNT arrived becomes the order's fee"
        compared++;
      });
    }
    expect(compared).toBeGreaterThanOrEqual(6);
  });
  it('a real user cancellation is cancelOrder(key) and its OrderCancelled event names the same key', () => {
    for (const x of cancels) {
      const d = decodeGmxCalldata(x.tx.input);
      expect(d.fn).toBe('cancelOrder');
      const ev = x.logs.map((l) => decodeGmxEvent(l)).find((e) => e?.eventName === 'OrderCancelled')!;
      expect(gmxEventKey(ev)).toBe(String(d.calls[0]!.args[0]).toLowerCase());
      expect(typeof ev.fields.reason).toBe('string');
    }
  });
  it('a log of another contract, or calldata with trailing bytes, is not read', () => {
    const l = creates[0]!.logs[0]!;
    expect(decodeGmxEvent({ ...l, address: ZERO_ADDRESS })).toBeNull();
    expect(() => decodeGmxCalldata(`${gmxCalldata(verifyGmxIntent(cancel(), ME))}00`)).toThrow(/canonical/);
  });
});

describe('verifyGmxIntent / buildGmxTxs', () => {
  it('increase: exact-amount approval of the pinned Router, then the multicall with msg.value = the execution fee', () => {
    const { plan, approve, main } = buildGmxTxs(intent(), ME);
    expect(approve).toMatchObject({ to: USDC.token, value: 0n, nonce: 7, gas: 60000n, chainId: 42161 });
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data! })).toMatchObject({ functionName: 'approve', args: [GMX_PINS.router.address, 20_000_000n] });
    expect(main).toMatchObject({ to: GMX_PINS.exchangeRouter.address, value: 170000000000000n, nonce: 8, gas: 2_000_000n });
    const d = decodeGmxCalldata(main.data!);
    expect(d.calls.map((c) => c.fn)).toEqual(['sendWnt', 'sendTokens', 'createOrder']);
    const p = d.calls[2]!.args[0] as GmxCreateOrderParams;
    expect(p.addresses).toEqual({ receiver: ME, cancellationReceiver: ME, callbackContract: ZERO_ADDRESS, uiFeeReceiver: ZERO_ADDRESS, market: ETH.market, initialCollateralToken: USDC.token, swapPath: [] });
    expect(p.numbers).toEqual({ sizeDeltaUsd: 60n * 10n ** 30n, initialCollateralDeltaAmount: 20_000_000n, triggerPrice: 0n, acceptablePrice: 2080_500000000000n, executionFee: 170000000000000n, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n });
    expect(p).toMatchObject({ orderType: 2, decreasePositionSwapType: 0, isLong: true, shouldUnwrapNativeToken: false, autoCancel: false, referralCode: ZERO_BYTES32, dataList: [] });
    expect(plan.params).toEqual(p);
    expect(buildGmxTxs(intent({}, { approveGas: '0' }), ME).approve).toBeNull();
  });
  it('decrease: no token moves, no approval; cancel: one cancelOrder call with no value', () => {
    const d = buildGmxTxs(decrease(), ME);
    expect(d.approve).toBeNull();
    expect(decodeGmxCalldata(d.main.data!).calls.map((c) => c.fn)).toEqual(['sendWnt', 'createOrder']);
    expect((decodeGmxCalldata(d.main.data!).calls[1]!.args[0] as GmxCreateOrderParams)).toMatchObject({ orderType: 4, numbers: { initialCollateralDeltaAmount: 0n, minOutputAmount: 0n } });
    const c = buildGmxTxs(cancel(), ME);
    expect(c.main).toMatchObject({ to: GMX_PINS.exchangeRouter.address, value: 0n, nonce: 7 });
    expect(decodeGmxCalldata(c.main.data!)).toMatchObject({ fn: 'cancelOrder', calls: [{ args: [KEY] }] });
  });
  const other = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  const refusals: [string, GmxIntent, RegExp][] = [
    ['another router', intent({ to: other }), /pinned GMX ExchangeRouter/],
    ['another router named in the section', intent({}, { exchangeRouter: other }), /pinned GMX ExchangeRouter/],
    ['another token spender', intent({}, { router: other }), /pinned GMX Router/],
    ['another vault', intent({}, { orderVault: other }), /pinned GMX OrderVault/],
    ['a market that is not pinned', intent({}, { market: '0x450bb6774Dd8a756274E0ab4107953259d2ac541' }), /pinned GMX market table/],
    ['the index token of another market', intent({}, { indexToken: BTC.indexToken }), /index token/],
    ['another collateral token', intent({}, { collateralToken: ETH.longToken }), /collateral token is not accepted/],
    ['an intent asset that is not the collateral', intent({ asset: ETH.longToken, symbol: 'WETH', decimals: 18 }), /intent asset is not the collateral/],
    ['another network', intent({ network: 'base', chainRef: '8453' }), /Arbitrum One only/],
    ['another sender', intent({ from: other }), /wallet's own address/],
    ['a trigger price', intent({}, { triggerPrice: '1' }), /trigger price/],
    ['zero size', intent({}, { sizeDeltaUsd: '0' }), /size must be positive/],
    ['zero collateral', intent({ amount: '0' }), /sends collateral/],
    ['zero acceptable price', intent({}, { acceptablePrice: '0' }), /acceptable price must be positive/],
    ['no execution fee', intent({}, { executionFee: '0' }), /execution fee must be positive/],
    ['fees above the approved maximum', intent({ maxFee: '250000000000000' }), /exceed the approved maximum/],
    ['an order key on an increase', intent({}, { orderKey: KEY }), /only a cancellation/],
    ['a swap section', intent({ swap: {} }), /neither a swap/],
    ['a memo', intent({ memo: 'x' }), /neither a swap/],
    ['a decrease that sends collateral', decrease({}) && { ...decrease(), amount: '5' }, /sends no collateral/],
    ['a decrease typed as an increase', decrease({ orderType: 'MarketIncrease' }), /MarketDecrease/],
    ['a decrease with an approval', decrease({ approveGas: '60000' }), /no token approval/],
    ['a cancellation carrying a market', cancel({ market: ETH.market }), /no order field/],
    ['a cancellation carrying an execution fee', cancel({ executionFee: '1' }), /no order field/],
    ['a cancellation without a key', cancel({ orderKey: undefined }), /names the order key/],
    ['a cancellation of the zero key', cancel({ orderKey: ZERO_BYTES32 }), /names the order key/],
    ['a cancellation that moves an asset', { ...cancel(), amount: '1' }, /moves no asset/],
    ['gas limit out of range', intent({ evm: { nonce: 1, gasLimit: '7000000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }), /gas limit out of range/],
    ['priority fee above max fee', intent({ evm: { nonce: 1, gasLimit: '2000000', maxFeePerGas: '1', maxPriorityFeePerGas: '2' } }), /priority fee/],
  ];
  it.each(refusals)('refuses %s', (_label, i, re) => { expect(() => buildGmxTxs(i, ME)).toThrow(re); });
  it('there is no field for a receiver, a callback, a UI fee receiver, a swap path or a referral code: an unknown field is not read', () => {
    const i = intent(); (i.gmx as unknown as Record<string, unknown>).receiver = other; (i.gmx as unknown as Record<string, unknown>).callbackContract = other; (i.gmx as unknown as Record<string, unknown>).swapPath = [BTC.market];
    const p = decodeGmxCalldata(buildGmxTxs(i, ME).main.data!).calls[2]!.args[0] as GmxCreateOrderParams;
    expect(p.addresses.receiver).toBe(ME); expect(p.addresses.callbackContract).toBe(ZERO_ADDRESS); expect(p.addresses.swapPath).toEqual([]);
  });
  it('OrderCreated diff: an event equal to the plan has no difference; any changed field is named', () => {
    const plan = verifyGmxIntent(intent(), ME), p = plan.params!;
    const fields: Record<string, unknown> = { account: ME, receiver: ME, cancellationReceiver: ME, callbackContract: ZERO_ADDRESS, uiFeeReceiver: ZERO_ADDRESS, market: p.addresses.market, initialCollateralToken: USDC.token, swapPath: [],
      orderType: 2n, decreasePositionSwapType: 0n, sizeDeltaUsd: p.numbers.sizeDeltaUsd, initialCollateralDeltaAmount: 20_000_000n, triggerPrice: 0n, acceptablePrice: p.numbers.acceptablePrice, executionFee: p.numbers.executionFee, callbackGasLimit: 0n,
      minOutputAmount: 0n, uiFeeFactor: 0n, updatedAtTime: 1n, validFromTime: 0n, srcChainId: 0n, isLong: true, shouldUnwrapNativeToken: false, autoCancel: false, dataList: [], key: KEY };
    const ev = { eventName: 'OrderCreated', msgSender: GMX_PINS.orderHandler.address, topic1: KEY, topic2: null, fields };
    expect(gmxOrderCreatedDiff(ev, plan, ME)).toEqual([]);
    expect(gmxOrderCreatedDiff({ ...ev, fields: { ...fields, receiver: other, sizeDeltaUsd: 1n, swapPath: [BTC.market] } }, plan, ME)).toHaveLength(3);
  });
});

describe('venue policy', () => {
  const policy: GmxPolicy = { allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, maxExecutionFeeWei: '300000000000000' };
  const px = { index: 2070, collateral: 1 };
  const plan = (i: GmxIntent) => verifyGmxIntent(i, ME);
  it('accepts an order inside every bound; a cancellation is bound by nothing here', () => {
    expect(gmxPolicyVerdict(policy, plan(intent()), px)).toBeNull(); // 60 USD on 20 USDC = 3×
    expect(gmxPolicyVerdict(policy, plan(decrease()), px)).toBeNull();
    expect(gmxPolicyVerdict(policy, plan(cancel()), null)).toBeNull();
  });
  it('refuses a market outside the authorization, leverage, size, execution fee and price outside the band — and fails closed without a price', () => {
    expect(gmxPolicyVerdict({ ...policy, allowedMarkets: [BTC.market] }, plan(intent()), px)).toMatch(/not allowed/);
    expect(gmxPolicyVerdict(policy, plan(intent({}, { sizeDeltaUsd: (gmxUsdToRaw('60') + 1n).toString() })), px)).toMatch(/leverage 3\.01× is above the authorized 3×/);
    expect(gmxPolicyVerdict(policy, plan(intent({ amount: '50000000' }, { sizeDeltaUsd: gmxUsdToRaw('100.01').toString() })), px)).toMatch(/order size 100\.01 USD is above/);
    expect(gmxPolicyVerdict(policy, plan(intent({ maxFee: '500000000000000' }, { executionFee: '300000000000001' })), px)).toMatch(/execution fee/);
    expect(gmxPolicyVerdict(policy, plan(intent({}, { acceptablePrice: gmxPriceToRaw('2090.71', 18).toString() })), px)).toMatch(/more than 100 bps away from the signer's own ETH price 2070/);
    expect(gmxPolicyVerdict(policy, plan(intent({}, { acceptablePrice: gmxPriceToRaw('2090.7', 18).toString() })), px)).toBeNull(); // exactly 100 bps
    expect(gmxPolicyVerdict(policy, plan(decrease({ acceptablePrice: gmxPriceToRaw('2000', 18).toString() })), px)).toMatch(/bps away/);
    expect(gmxPolicyVerdict(policy, plan(intent()), null)).toBe('no price');
    expect(gmxPolicyVerdict(policy, plan(intent()), { index: NaN, collateral: 1 })).toBe('no price');
    // a collateral token that lost its peg is worth less: the same order is then above the leverage bound
    expect(gmxPolicyVerdict(policy, plan(intent()), { index: 2070, collateral: 0.9 })).toMatch(/leverage/);
  });
  it('a decrease is not bound by size or leverage (closing must stay possible), only by market, fee and price band', () => {
    expect(gmxPolicyVerdict(policy, plan(decrease({ sizeDeltaUsd: gmxUsdToRaw('100000').toString() })), px)).toBeNull();
  });
});

describe('authorization', () => {
  const NOW = 1794398400;
  const A: GmxAuthorization = { v: 1, authorizationId: AUTH, keyId: 'spw-0123456789abcdef', venue: 'gmx', network: 'arbitrum', account: ME.toLowerCase(), mode: 'MANUAL_LIVE', contracts: GMX_PINS.id, exchangeRouter: GMX_PINS.exchangeRouter.address,
    policy: { allowedMarkets: [ETH.market, BTC.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, maxExecutionFeeWei: '300000000000000' }, createdAt: NOW, expiresAt: NOW + 30 * 86400, ackSha256: jurisdictionAck('gmx', 'fr').sha256 };
  it('the hash is pinned and covers every field', () => {
    const h = gmxAuthorizationHashHex(A);
    expect(h).toBe(gmxAuthorizationHashHex({ ...A, policy: { ...A.policy, allowedMarkets: [BTC.market, ETH.market], maxOrderSizeUsd: '100.0' } })); // order of markets and decimal spelling do not matter
    const changes: Partial<GmxAuthorization>[] = [{ authorizationId: AUTH.replace('aa', 'ab') }, { keyId: 'spw-0123456789abcdee' }, { account: `0x${'22'.repeat(20)}` }, { contracts: 'x-y-z-1' }, { exchangeRouter: ME }, { createdAt: NOW + 1 }, { expiresAt: NOW + 1 }, { ackSha256: jurisdictionAck('gmx', 'en').sha256 },
      { policy: { ...A.policy, maxLeverage: 4 } }, { policy: { ...A.policy, maxOrderSizeUsd: '101' } }, { policy: { ...A.policy, maxOrdersPerDay: 6 } }, { policy: { ...A.policy, maxPriceDeviationBps: 101 } }, { policy: { ...A.policy, maxExecutionFeeWei: '1' } }, { policy: { ...A.policy, allowedMarkets: [ETH.market] } }];
    const seen = new Set([h]);
    for (const c of changes) seen.add(gmxAuthorizationHashHex({ ...A, ...c }));
    expect(seen.size).toBe(changes.length + 1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('validation: the reviewed contract set, pinned markets, bounded fee ceiling, current, at most 90 days', () => {
    expect(() => validateGmxAuthorization(A, NOW)).not.toThrow();
    expect(() => validateGmxAuthorization({ ...A, contracts: 'gmx-v2-arbitrum-2027-01-01' }, NOW)).toThrow(/another GMX contract set/);
    expect(() => validateGmxAuthorization({ ...A, exchangeRouter: ME }, NOW)).toThrow(/another GMX contract set/);
    expect(() => validateGmxAuthorization({ ...A, policy: { ...A.policy, allowedMarkets: ['0x450bb6774Dd8a756274E0ab4107953259d2ac541'] } }, NOW)).toThrow(/not in the pinned/);
    expect(() => validateGmxAuthorization({ ...A, policy: { ...A.policy, maxExecutionFeeWei: '2000000000000001' } }, NOW)).toThrow(/execution fee ceiling/);
    expect(() => validateGmxAuthorization({ ...A, expiresAt: NOW + 91 * 86400 }, NOW)).toThrow(/at most 90 days/);
    expect(() => validateGmxAuthorization(A, NOW + 31 * 86400)).toThrow(/expired/);
    expect(() => validateGmxAuthorization({ ...A, createdAt: NOW - 601 }, NOW)).toThrow(/not current/);
  });
  it('the acknowledgement is GMX\'s own text, in both languages, and only its hash is accepted for GMX', () => {
    expect(jurisdictionAck('gmx', 'en').text).toMatch(/GMX v2/); expect(jurisdictionAck('gmx', 'fr').text).toMatch(/keepers/);
    expect(jurisdictionAckOf('gmx', jurisdictionAck('gmx', 'fr').sha256)?.locale).toBe('fr');
    expect(jurisdictionAckOf('gmx', jurisdictionAck('hyperliquid', 'fr').sha256)).toBeNull();
    expect(jurisdictionAckOf('hyperliquid', jurisdictionAck('gmx', 'fr').sha256)).toBeNull();
  });
});
