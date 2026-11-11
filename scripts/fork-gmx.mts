// GMX v2 trading proof on a LOCAL FORK of Arbitrum One (anvil) with the REAL GMX contracts. Nothing reaches a real network:
// every transaction goes to http://127.0.0.1 only. The wallet key is a fresh random BIP-39 phrase generated in memory, never
// printed, funded ON THE FORK ONLY, gone when the process ends.
//     npx tsx scripts/fork-gmx.mts            (tsx: the signer class is not strip-only TypeScript)
//
// What it shows, in order:
//   1. the fork's GMX contracts are the pinned bytecode, hold the required roles, and the pinned markets read back from Reader;
//   2. the REAL isolated signer class (real WebAuthn assertions from a software passkey, its real two-exchange price view)
//      refuses everything it must refuse;
//   3. a MarketIncrease built and signed by the signer is mined on the fork: `OrderCreated` carries exactly the approved
//      fields, the collateral is in the OrderVault, the execution fee was wrapped into it, the Router allowance is back to 0;
//   4. SIMULATED execution by GMX's own SimulationRouter (real code, prices given by the script): the order WOULD execute at
//      the market price and WOULD NOT at a price beyond the acceptable price;
//   5. KEEPER execution on the fork: a real ORDER_KEEPER address is impersonated and calls the real
//      OrderHandler.executeOrder — WITH ONE SUBSTITUTION: the bytecode of GMX's ChainlinkDataStreamProvider is replaced on the
//      fork by scripts/lib/GmxMockOracleProvider.sol, which returns the price it is handed instead of verifying a signed
//      Chainlink Data Streams report (nobody outside Chainlink's network can produce one). Everything else — OrderHandler,
//      Oracle, DataStore, vaults, market, fee and price-impact logic — is the unmodified mainnet bytecode;
//   6. the position is closed by a MarketDecrease built by the signer, executed the same way: the collateral comes back;
//   7. cancellation: a keeper-side cancellation (price beyond the acceptable price → `OrderCancelled` with the reason,
//      collateral returned), and a user `cancelOrder` built by the signer — refused by the contracts before the request
//      expiration (300 s), mined after the fork's clock is advanced past it; collateral and unused fee come back.
//
// WHAT THIS CANNOT SHOW: that GMX's real keepers pick the order up, how long they take, the price they execute at, and the
// real oracle path (signed Data Streams reports verified by Chainlink's verifier contract). Step 5 replaces exactly that part.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, hexToNumber, keccak256, numberToHex, parseAbi, parseTransaction, parseUnits, toFunctionSelector, type Hex } from 'viem';
import { intentHash, NETWORKS, type Intent } from '@spw/core';
import {
  buildGmxTxs, decodeGmxCalldata, decodeGmxEvent, GMX_DATASTORE_ABI, GMX_DATASTORE_KEYS, GMX_MARKETS, GMX_PINNED_CONTRACTS, GMX_PINS, GMX_READER_ABI, GMX_REQUEST_EXPIRATION_SEC, GMX_REQUIRED_ROLES, GMX_ROLE_KEYS, GMX_ROLE_STORE_ABI,
  gmxAcceptablePrice, gmxAuthorizationHash, gmxEventKey, gmxExecutionFee, gmxExecutionGas, gmxKey, gmxOrderCreatedDiff, gmxPriceFromRaw, gmxPriceToRaw, gmxUsdFromRaw, gmxUsdToRaw, jurisdictionAck, ZERO_ADDRESS,
  type GmxAuthorization, type GmxEvent, type GmxSection,
} from '@spw/derivatives/live';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../services/isolated-signer/src/prices.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const net = NETWORKS[GMX_PINS.network]!, PORT = 8572, URL_ = `http://127.0.0.1:${PORT}`, RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.evm; // fresh throwaway wallet
const M = GMX_MARKETS.find((m) => m.priceSymbol === 'ETH')!, BTC = GMX_MARKETS.find((m) => m.priceSymbol === 'BTC')!, USDC = M.collateral[0]!;
const P = GMX_PINS, VAULT = P.orderVault.address, ROUTER = P.exchangeRouter.address;
/** runtime bytecode of scripts/lib/GmxMockOracleProvider.sol (solc 0.8.29, optimizer 200 runs, no metadata) */
const MOCK_PROVIDER = '0x608060405234801561000f575f5ffd5b506004361061004a575f3560e01c8063377bbdaf1461004e5780638263c28e146100c757806386d59f93146100c7578063eed790c7146100c7575b5f5ffd5b61006161005c36600461018e565b6100d5565b6040516100be919081516001600160a01b0390811682526020808401519083015260408084015190830152606080840151908301526080808401519083015260a0838101519083015260c092830151169181019190915260e00190565b60405180910390f35b6040515f81526020016100be565b6101206040518060e001604052805f6001600160a01b031681526020015f81526020015f81526020015f81526020015f81526020015f81526020015f6001600160a01b031681525090565b5f5f83806020019051810190610136919061025f565b6040805160e0810182526001600160a01b039890981688526020880183905287018190526060870191909152608086015250504260a084015250503060c082015290565b634e487b7160e01b5f52604160045260245ffd5b5f5f6040838503121561019f575f5ffd5b82356001600160a01b03811681146101b5575f5ffd5b9150602083013567ffffffffffffffff8111156101d0575f5ffd5b8301601f810185136101e0575f5ffd5b803567ffffffffffffffff8111156101fa576101fa61017a565b604051601f8201601f19908116603f0116810167ffffffffffffffff811182821017156102295761022961017a565b604052818152828201602001871015610240575f5ffd5b816020840160208301375f602083830101528093505050509250929050565b5f5f60408385031215610270575f5ffd5b50508051602090910151909290915056';
const say = (s = '') => console.log(s);
let failures = 0;
const check = (ok: boolean, label: string) => { say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sha = (h: string) => createHash('sha256').update(Buffer.from(h.slice(2), 'hex')).digest('hex');
const eqA = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
let rid = 0;
class RpcError extends Error { data: string | undefined; constructor(m: string, data?: string) { super(m); this.data = data; } }
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  if (!URL_.startsWith('http://127.0.0.1:')) throw new Error('this script only talks to the local fork');
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
  const j = await r.json() as { result?: T; error?: { message: string; data?: string } }; if (j.error) throw new RpcError(`${method}: ${j.error.message}`, typeof j.error.data === 'string' ? j.error.data : undefined); return j.result as T;
};
const call = (to: string, data: Hex, from?: string) => rpc<Hex>('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const erc = async (token: string, fn: 'balanceOf' | 'allowance', args: string[]) => hexToBigInt(await call(token, encodeFunctionData({ abi: erc20Abi, functionName: fn, args } as never)));
const eth = async (who: string) => hexToBigInt(await rpc<Hex>('eth_getBalance', [who, 'latest']));
const reader = async <F extends 'getMarket' | 'getAccountPositions' | 'getAccountOrders' | 'getOrder'>(fn: F, args: unknown[]) => decodeFunctionResult({ abi: GMX_READER_ABI, functionName: fn, data: await call(P.reader.address, encodeFunctionData({ abi: GMX_READER_ABI, functionName: fn, args } as never)) } as never) as any;
const dsUint = async (key: string) => hexToBigInt(await call(P.dataStore.address, encodeFunctionData({ abi: GMX_DATASTORE_ABI, functionName: 'getUint', args: [key as Hex] })));
interface Receipt { status: Hex; gasUsed: Hex; effectiveGasPrice: Hex; blockNumber: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] }
async function mined(hash: string): Promise<Receipt> { for (let k = 0; k < 600; k++) { const rc = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]); if (rc) return rc; await new Promise((r) => setTimeout(r, 100)); } throw new Error('no receipt'); }
const send = async (raw: string) => mined(await rpc<Hex>('eth_sendRawTransaction', [raw]));
const events = (rc: Receipt): GmxEvent[] => rc.logs.map((l) => decodeGmxEvent(l)).filter((e): e is GmxEvent => !!e);
async function refused(label: string, p: Promise<unknown>, re: RegExp) {
  try { await p; check(false, `${label}: was NOT refused`); } catch (e) { const m = `${(e as { code?: string }).code}: ${(e as Error).message}`; check(re.test(m), `${label} → refused (${m.slice(0, 150)})`); }
}
const ERR = { end: toFunctionSelector('EndOfOracleSimulation()'), price: toFunctionSelector('OrderNotFulfillableAtAcceptablePrice(uint256,uint256)'), early: toFunctionSelector('RequestNotYetCancellable(uint256,uint256,string)') };
const simAbi = parseAbi(['struct Price { uint256 min; uint256 max; }', 'struct SimulatePricesParams { address[] primaryTokens; Price[] primaryPrices; uint256 minTimestamp; uint256 maxTimestamp; }', 'function simulateExecuteLatestOrder(SimulatePricesParams simulatedOracleParams) payable']);
const handlerAbi = parseAbi(['struct SetPricesParams { address[] tokens; address[] providers; bytes[] data; }', 'function executeOrder(bytes32 key, SetPricesParams oracleParams)', 'function orderVault() view returns (address)']);
const routerViews = parseAbi(['function router() view returns (address)', 'function orderHandler() view returns (address)', 'function dataStore() view returns (address)', 'function roleStore() view returns (address)']);
const roleAbi = parseAbi(['function getRoleMembers(bytes32 roleKey, uint256 start, uint256 end) view returns (address[])']);

let anvil: ChildProcess | undefined;
process.on('exit', () => anvil?.kill());
try {
  say(`Fork of ${net.name} (chain ${net.chainRef}) on ${URL_} — throwaway wallet ${ME} (seed in memory only)`);
  anvil = spawn('anvil', ['--fork-url', process.env.FORK_RPC_ARBITRUM ?? net.rpc[0]!, '--port', String(PORT), '--chain-id', net.chainRef, '--retries', '12', '--fork-retry-backoff', '1500', '--silent'], { stdio: 'ignore' });
  for (let k = 0; ; k++) { try { await rpc('eth_chainId'); break; } catch { if (k > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
  check(hexToNumber(await rpc<Hex>('eth_chainId')) === P.chainId, `fork chain id ${P.chainId}, forked at block ${hexToNumber(await rpc<Hex>('eth_blockNumber'))}`);

  // -------------------------------------------------------------------------------------------------------------------
  say('\n1. The GMX contracts on the fork (unmodified mainnet state) against the pinned table');
  for (const c of GMX_PINNED_CONTRACTS) { const code = await rpc<string>('eth_getCode', [P[c].address, 'latest']); check(sha(code) === P[c].codeSha256 && (code.length - 2) / 2 === P[c].codeBytes, `${c} ${P[c].address}: ${(code.length - 2) / 2} bytes, sha256 ${sha(code).slice(0, 16)}… = pinned`); }
  for (const r of GMX_REQUIRED_ROLES) check(decodeFunctionResult({ abi: GMX_ROLE_STORE_ABI, functionName: 'hasRole', data: await call(P.roleStore.address, encodeFunctionData({ abi: GMX_ROLE_STORE_ABI, functionName: 'hasRole', args: [P[r.holder].address as Hex, GMX_ROLE_KEYS[r.role]] })) }) === true, `RoleStore: ${r.holder} holds ${r.role}`);
  const rv = async (fn: 'router' | 'orderHandler' | 'dataStore' | 'roleStore') => decodeFunctionResult({ abi: routerViews, functionName: fn, data: await call(ROUTER, encodeFunctionData({ abi: routerViews, functionName: fn })) });
  check(eqA(await rv('router'), P.router.address) && eqA(await rv('orderHandler'), P.orderHandler.address) && eqA(await rv('dataStore'), P.dataStore.address) && eqA(await rv('roleStore'), P.roleStore.address), 'ExchangeRouter immutables: router, orderHandler, dataStore, roleStore = the pinned addresses');
  check(eqA(decodeFunctionResult({ abi: handlerAbi, functionName: 'orderVault', data: await call(P.orderHandler.address, encodeFunctionData({ abi: handlerAbi, functionName: 'orderVault' })) }), VAULT), 'OrderHandler.orderVault() = the pinned OrderVault');
  check(eqA(decodeFunctionResult({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', data: await call(P.dataStore.address, encodeFunctionData({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', args: [gmxKey('WNT')] })) }), P.wnt), `DataStore WNT = ${P.wnt}`);
  check((await dsUint(GMX_DATASTORE_KEYS.REQUEST_EXPIRATION_TIME)) === BigInt(GMX_REQUEST_EXPIRATION_SEC), `DataStore REQUEST_EXPIRATION_TIME = ${GMX_REQUEST_EXPIRATION_SEC} s`);
  for (const m of GMX_MARKETS) { const x = await reader('getMarket', [P.dataStore.address, m.market]); check(eqA(x.marketToken, m.market) && eqA(x.indexToken, m.indexToken) && eqA(x.longToken, m.longToken) && eqA(x.shortToken, m.shortToken), `Reader.getMarket(${m.name}): index, long and short tokens = the pinned row`); }
  const gasParams = { orderGasLimit: await dsUint(GMX_DATASTORE_KEYS.INCREASE_ORDER_GAS_LIMIT), baseAmount: await dsUint(GMX_DATASTORE_KEYS.ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1), perOraclePrice: await dsUint(GMX_DATASTORE_KEYS.ESTIMATED_GAS_FEE_PER_ORACLE_PRICE), multiplierFactor: await dsUint(GMX_DATASTORE_KEYS.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR) };
  const execGas = gmxExecutionGas(gasParams), decGas = gmxExecutionGas({ ...gasParams, orderGasLimit: await dsUint(GMX_DATASTORE_KEYS.DECREASE_ORDER_GAS_LIMIT) });
  say(`  execution gas the contracts price an order at (DataStore): increase ${execGas}, decrease ${decGas}`);

  // -------------------------------------------------------------------------------------------------------------------
  // the wallet on the fork: ETH for gas and fees, USDC by writing the FiatToken balance slot (mapping at slot 9)
  await rpc('anvil_setBalance', [ME, numberToHex(parseUnits('0.01', 18))]);
  await rpc('anvil_setStorageAt', [USDC.token, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ME as Hex, 9n])), numberToHex(parseUnits('100', 6), { size: 32 })]);
  if ((await erc(USDC.token, 'balanceOf', [ME])) !== parseUnits('100', 6)) throw new Error('could not fund the test wallet with USDC on the fork');

  const dir = mkdtempSync(join(tmpdir(), 'spw-fork-gmx-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const prices = exchangePrices(); // the signer's real price view: Coinbase + Kraken public tickers (read only)
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, prices);
  const pk = new TestPasskey(RP, ORIGIN), stranger = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const ethPx = (await prices.get(['ETH', 'USDC'])).ETH!, ref = ethPx.toFixed(2);
  say(`\n  the signer's own ETH price now (Coinbase + Kraken): ${ref} USD — used as the market price of the whole run`);

  let seq = 0;
  const uuid = () => `9c3d1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`;
  const AUTH_ID = uuid();
  const fees = async () => { const base = hexToBigInt((await rpc<{ baseFeePerGas: Hex }>('eth_getBlockByNumber', ['latest', false])).baseFeePerGas), tip = 1_000_000n; return { base, tip, maxFeePerGas: base * 2n + tip }; };
  const nonce = async () => hexToNumber(await rpc<Hex>('eth_getTransactionCount', [ME, 'pending']));
  const head = (g: GmxSection, o: { asset: string; symbol: string; decimals: number; amount: bigint; gas: bigint; f: Awaited<ReturnType<typeof fees>>; nonce: number }): Intent => {
    const now = Math.floor(Date.now() / 1000);
    return { v: 1, proposalId: uuid(), keyId: keys.keyId, network: net.id, chainRef: net.chainRef, asset: o.asset, symbol: o.symbol, decimals: o.decimals, amount: o.amount.toString(), from: ME, to: ROUTER,
      maxFee: ((o.gas + BigInt(g.approveGas)) * o.f.maxFeePerGas + BigInt(g.executionFee)).toString(), createdAt: now, expiresAt: now + 120, policyVersion: store.policy.version, gmx: g,
      evm: { nonce: o.nonce, gasLimit: o.gas.toString(), maxFeePerGas: o.f.maxFeePerGas.toString(), maxPriorityFeePerGas: o.f.tip.toString() } };
  };
  const section = (over: Partial<GmxSection>): GmxSection => ({ venue: 'gmx-v2', action: 'increase', authorizationId: AUTH_ID, exchangeRouter: ROUTER, router: P.router.address, orderVault: VAULT, market: M.market, indexToken: M.indexToken, collateralToken: USDC.token,
    orderType: 'MarketIncrease', isLong: true, sizeDeltaUsd: '0', acceptablePrice: '0', triggerPrice: '0', executionFee: '0', approveGas: '0', ...over });
  /** a long increase: `collateral` USDC, `size` USD, acceptable price = the signer's price + `slipBps` */
  async function increase(collateral: string, size: string, over: Partial<GmxSection> = {}, slipBps = 50, intentOver: Partial<Intent> = {}): Promise<Intent> {
    const f = await fees(), amount = parseUnits(collateral, 6);
    const g = section({ sizeDeltaUsd: gmxUsdToRaw(size).toString(), acceptablePrice: gmxAcceptablePrice(ref, slipBps, { isLong: true, increase: true, indexDecimals: M.indexDecimals }).toString(), executionFee: gmxExecutionFee(execGas, f.base, f.tip).toString(), approveGas: '60000', ...over });
    return { ...head(g, { asset: USDC.token, symbol: 'USDC', decimals: 6, amount, gas: 2_500_000n, f, nonce: await nonce() }), ...intentOver };
  }
  const sign = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));

  // -------------------------------------------------------------------------------------------------------------------
  say('\n2. Authorization (venue policy approved once with the passkey) and what the signer refuses');
  await refused('an order before any authorization', sign(await increase('20', '60')), /not_authorized/);
  const now0 = Math.floor(Date.now() / 1000);
  const auth: GmxAuthorization = { v: 1, authorizationId: AUTH_ID, keyId: keys.keyId, venue: 'gmx', network: 'arbitrum', account: ME.toLowerCase(), mode: 'MANUAL_LIVE', contracts: P.id, exchangeRouter: ROUTER,
    policy: { allowedMarkets: [M.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, maxExecutionFeeWei: '160000000000000' }, createdAt: now0, expiresAt: now0 + 7 * 86400, ackSha256: jurisdictionAck('gmx', 'fr').sha256 };
  await refused('authorization without a passkey', signer.gmxAuthorize(auth, undefined), /bad_approval/);
  await refused('authorization with the Hyperliquid acknowledgement', signer.gmxAuthorize({ ...auth, ackSha256: jurisdictionAck('hyperliquid', 'fr').sha256 }, pk.assert(gmxAuthorizationHash({ ...auth, ackSha256: jurisdictionAck('hyperliquid', 'fr').sha256 }))), /acknowledgement/);
  await refused('authorization for another GMX contract set', signer.gmxAuthorize({ ...auth, exchangeRouter: ME }, pk.assert(gmxAuthorizationHash({ ...auth, exchangeRouter: ME }))), /another GMX contract set/);
  await refused('authorization for another account', signer.gmxAuthorize({ ...auth, account: `0x${'11'.repeat(20)}` }, pk.assert(gmxAuthorizationHash({ ...auth, account: `0x${'11'.repeat(20)}` }))), /wrong_source/);
  const authed = await signer.gmxAuthorize(auth, pk.assert(gmxAuthorizationHash(auth)));
  check(authed.authorizationId === AUTH_ID && signer.status().gmx.length === 1, `authorized: ${M.name} only, leverage ≤ 3×, order ≤ 100 USD, 5 increases a day, price band 100 bps, execution fee ≤ 0.00016 ETH, 7 days`);

  const other = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  const withField = async (k: string, v: unknown) => { const i = await increase('20', '60'); (i.gmx as unknown as Record<string, unknown>)[k] = v; return signer.sign(i, pk.assert(new Uint8Array(32))); };
  await refused('another receiver (there is no such field)', withField('receiver', other), /bad_request: malformed intent/);
  await refused('a callback contract (no such field)', withField('callbackContract', other), /bad_request: malformed intent/);
  await refused('a UI fee receiver (no such field)', withField('uiFeeReceiver', other), /bad_request: malformed intent/);
  await refused('a swap path (no such field)', withField('swapPath', [BTC.market]), /bad_request: malformed intent/);
  await refused('a referral code (no such field)', withField('referralCode', `0x${'11'.repeat(32)}`), /bad_request: malformed intent/);
  await refused('a market that is not pinned (ETH/USD [WETH-WETH])', sign(await increase('20', '60', { market: '0x450bb6774Dd8a756274E0ab4107953259d2ac541' })), /unsupported: this market is not in the wallet's pinned GMX market table/);
  await refused('a pinned market outside the authorization (BTC/USD)', sign(await increase('20', '60', { market: BTC.market, indexToken: BTC.indexToken, acceptablePrice: gmxAcceptablePrice((await prices.get(['BTC'])).BTC!.toFixed(2), 50, { isLong: true, increase: true, indexDecimals: 8 }).toString() })), /policy: BTC\/USD .* is not allowed/);
  await refused('another collateral token (WETH)', sign(await increase('20', '60', { collateralToken: M.longToken })), /unsupported: this collateral token is not accepted/);
  await refused('an unpinned router', sign(await increase('20', '60', { exchangeRouter: other }, 50, { to: other })), /unsupported: the destination is not the pinned GMX ExchangeRouter/);
  await refused('an unpinned token spender', sign(await increase('20', '60', { router: other })), /unsupported: the token spender is not the pinned GMX Router/);
  await refused('leverage above the venue policy (61 USD on 20 USDC)', sign(await increase('20', '61')), /policy: leverage 3\.05× is above the authorized 3×/);
  await refused('size above the venue policy (101 USD on 40 USDC)', sign(await increase('40', '101')), /policy: order size 101 USD is above the authorized 100/);
  await refused('execution fee above the authorization ceiling', sign(await increase('20', '60', { executionFee: '160000000000001' })), /policy: execution fee 160000000000001 wei is above the authorized 160000000000000/);
  await refused('acceptable price 2 % above the signer\'s own price', sign(await increase('20', '60', {}, 200)), /price: acceptable price .* is more than 100 bps away from the signer's own ETH price/);
  await refused('collateral above the wallet\'s per-transfer limit (60 USDC)', sign(await increase('60', '100')), /policy: amount above per-transaction limit/);
  { const a = await increase('20', '60'), b = { ...a, gmx: { ...a.gmx!, sizeDeltaUsd: gmxUsdToRaw('59').toString() } }; await refused('a different size than the one the passkey approved', signer.sign(b, pk.assert(intentHash(a))), /bad_approval/); }
  { const a = await increase('20', '60'), b = { ...a, amount: parseUnits('21', 6).toString() }; await refused('a different collateral than the one the passkey approved', signer.sign(b, pk.assert(intentHash(a))), /bad_approval/); }
  await refused('no passkey', signer.sign(await increase('20', '60'), undefined as never), /bad_approval|TypeError|Cannot read/);
  { const i = await increase('20', '60'); await refused('a passkey that is not enrolled', signer.sign(i, stranger.assert(intentHash(i))), /unknown_credential/); }
  { const i = await increase('20', '60'); const t = Math.floor(Date.now() / 1000) - 400; await refused('an expired approval window', sign({ ...i, createdAt: t, expiresAt: t + 120 }), /policy: approval window expired/); }
  { const f = await fees(), now = Math.floor(Date.now() / 1000);
    const plain: Intent = { v: 1, proposalId: uuid(), keyId: keys.keyId, network: net.id, chainRef: net.chainRef, asset: USDC.token, symbol: 'USDC', decimals: 6, amount: '5000000', from: ME, to: VAULT, maxFee: (90_000n * f.maxFeePerGas).toString(), createdAt: now, expiresAt: now + 120,
      policyVersion: store.policy.version, evm: { nonce: await nonce(), gasLimit: '90000', maxFeePerGas: f.maxFeePerGas.toString(), maxPriorityFeePerGas: f.tip.toString() } };
    await refused('a plain transfer of USDC to the OrderVault', sign(plain), /gmx: this destination is a GMX contract/); }
  check(store.state.journal.filter((j) => j.type === 'sign.ok').length === 0, 'signer journal: no signature so far');

  // -------------------------------------------------------------------------------------------------------------------
  let approvalGas = 0;
  /** sign, send (approval first when there is one), return the receipt of the ExchangeRouter call */
  async function place(i: Intent): Promise<{ rc: Receipt; signed: Awaited<ReturnType<typeof sign>> }> {
    const signed = await sign(i);
    if (signed.pre) { const rc = await send(signed.pre.raw); if (hexToNumber(rc.status) !== 1) throw new Error('the approval reverted'); approvalGas = hexToNumber(rc.gasUsed); }
    return { rc: await send(signed.raw), signed };
  }
  const created = (rc: Receipt) => events(rc).find((e) => e.eventName === 'OrderCreated');
  const bal = async () => ({ usdc: await erc(USDC.token, 'balanceOf', [ME]), vaultUsdc: await erc(USDC.token, 'balanceOf', [VAULT]), vaultWnt: await erc(P.wnt, 'balanceOf', [VAULT]), eth: await eth(ME), weth: await erc(P.wnt, 'balanceOf', [ME]) });
  const usd6 = (v: bigint) => formatUnits(v, 6), e18 = (v: bigint) => formatUnits(v, 18);

  say('\n3. A MarketIncrease (long ETH/USD, 20 USDC collateral, 60 USD = 3×), built and signed by the signer, mined ON THE FORK');
  const i1 = await increase('20', '60'), plan1 = buildGmxTxs(i1, ME).plan, b0 = await bal();
  const { rc: rc1, signed: s1 } = await place(i1);
  const tx1 = parseTransaction(s1.raw as Hex), pre1 = parseTransaction(s1.pre!.raw as Hex);
  check(eqA(pre1.to, USDC.token) && pre1.data === encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [P.router.address as Hex, parseUnits('20', 6)] }), `approval transaction: USDC.approve(Router ${P.router.address}, 20 USDC) — exact amount, mined (gas used ${approvalGas})`);
  check(eqA(tx1.to, ROUTER) && tx1.value === plan1.executionFee && decodeGmxCalldata(tx1.data!).calls.map((c) => c.fn).join() === 'sendWnt,sendTokens,createOrder', `order transaction: ExchangeRouter.multicall[sendWnt, sendTokens, createOrder], msg.value = execution fee ${e18(plan1.executionFee)} ETH`);
  check(hexToNumber(rc1.status) === 1, `receipt status 1, gas used ${hexToNumber(rc1.gasUsed)}`);
  const ev1 = created(rc1)!, key1 = gmxEventKey(ev1)!, diff1 = gmxOrderCreatedDiff(ev1, plan1, ME);
  check(!!ev1 && diff1.length === 0, `OrderCreated ${key1}: every field equals the approved one (account, receiver, cancellationReceiver = wallet; callback, UI fee receiver = 0; market; collateral token; empty swap path; type 2; size; collateral; acceptable price; execution fee; minOutput 0; isLong)${diff1.length ? ` — DIFF ${diff1.join('; ')}` : ''}`);
  say(`       size ${gmxUsdFromRaw(ev1.fields.sizeDeltaUsd as bigint)} USD, collateral ${usd6(ev1.fields.initialCollateralDeltaAmount as bigint)} USDC, acceptable price ${gmxPriceFromRaw(ev1.fields.acceptablePrice as bigint, 18)}, execution fee ${e18(ev1.fields.executionFee as bigint)} ETH`);
  const b1 = await bal();
  check(b0.usdc - b1.usdc === parseUnits('20', 6) && b1.vaultUsdc - b0.vaultUsdc === parseUnits('20', 6), `collateral: wallet −${usd6(b0.usdc - b1.usdc)} USDC, OrderVault +${usd6(b1.vaultUsdc - b0.vaultUsdc)} USDC`);
  check(b1.vaultWnt - b0.vaultWnt === plan1.executionFee, `execution fee: OrderVault +${e18(b1.vaultWnt - b0.vaultWnt)} WETH (wrapped from msg.value)`);
  check((await erc(USDC.token, 'allowance', [ME, P.router.address])) === 0n, 'USDC allowance of the Router: back to 0');
  const o1 = await reader('getOrder', [P.dataStore.address, key1]);
  const list1 = await reader('getAccountOrders', [P.dataStore.address, ME, 0n, 10n]);
  check(eqA(o1.addresses.account, ME) && eqA(o1.addresses.receiver, ME) && eqA(o1.addresses.cancellationReceiver, ME) && o1.numbers.sizeDeltaUsd === plan1.sizeDeltaUsd && list1.length === 1 && list1[0].orderKey === key1, 'Reader (on-chain): the order is stored under the wallet, with the wallet as receiver and cancellation receiver');
  await refused('the same approval again', sign(i1), /replay/);

  // -------------------------------------------------------------------------------------------------------------------
  say('\n4. Simulated execution — GMX\'s own SimulationRouter.simulateExecuteLatestOrder (real code, no state change)');
  const blockTs = async () => hexToBigInt((await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false])).timestamp);
  const ethRaw = (p: string) => gmxPriceToRaw(p, 18), usdcRaw = 10n ** 24n; // USDC (6 decimals): 1 USD = 1e24
  async function simulate(price: string): Promise<string> {
    const ts = o1.numbers.updatedAtTime as bigint;
    const data = encodeFunctionData({ abi: simAbi, functionName: 'simulateExecuteLatestOrder', args: [{ primaryTokens: [M.indexToken as Hex, USDC.token as Hex], primaryPrices: [{ min: ethRaw(price), max: ethRaw(price) }, { min: usdcRaw, max: usdcRaw }], minTimestamp: ts, maxTimestamp: ts }] });
    try { await call(P.simulationRouter.address, data, ME); return 'returned without reverting'; } catch (e) { const d = (e as RpcError).data ?? (e as Error).message; return d.startsWith(ERR.end) ? 'EndOfOracleSimulation' : d.startsWith(ERR.price) ? 'OrderNotFulfillableAtAcceptablePrice' : d.slice(0, 80); }
  }
  check((await simulate(ref)) === 'EndOfOracleSimulation', `at ${ref} USD: reverts with EndOfOracleSimulation = the whole execution ran without an error (GMX's convention for a successful simulation)`);
  const beyond = (ethPx * 1.01).toFixed(2);
  check((await simulate(beyond)) === 'OrderNotFulfillableAtAcceptablePrice', `at ${beyond} USD (1 % above, beyond the acceptable price): OrderNotFulfillableAtAcceptablePrice — the contracts enforce the approved worst price`);

  // -------------------------------------------------------------------------------------------------------------------
  say('\n5. Keeper execution ON THE FORK — real keeper address impersonated, real OrderHandler; price provider REPLACED (see header)');
  const provider = decodeFunctionResult({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', data: await call(P.dataStore.address, encodeFunctionData({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', args: [keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }], [gmxKey('ORACLE_PROVIDER_FOR_TOKEN'), '0x26C02F221e8dB5A821e12347C7eA8a6b6E10842f', USDC.token as Hex]))] })) }) as string;
  await rpc('anvil_setCode', [provider, MOCK_PROVIDER]);
  const keeper = (decodeFunctionResult({ abi: roleAbi, functionName: 'getRoleMembers', data: await call(P.roleStore.address, encodeFunctionData({ abi: roleAbi, functionName: 'getRoleMembers', args: [GMX_ROLE_KEYS.ORDER_KEEPER, 0n, 1n] })) }) as string[])[0]!;
  await rpc('anvil_impersonateAccount', [keeper]); await rpc('anvil_setBalance', [keeper, numberToHex(parseUnits('1', 18))]);
  say(`  price provider ${provider} (ChainlinkDataStreamProvider) replaced by the mock; keeper ${keeper} (holds ORDER_KEEPER) impersonated`);
  async function execute(key: string, price: string): Promise<Receipt> {
    const px = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [v, v]);
    const data = encodeFunctionData({ abi: handlerAbi, functionName: 'executeOrder', args: [key as Hex, { tokens: [M.indexToken as Hex, USDC.token as Hex], providers: [provider as Hex, provider as Hex], data: [px(ethRaw(price)), px(usdcRaw)] }] });
    const f = await fees(); // the keeper pays the block's base fee and no tip, as on Arbitrum
    return mined(await rpc<Hex>('eth_sendTransaction', [{ from: keeper, to: P.orderHandler.address, data, gas: numberToHex(12_000_000n), maxFeePerGas: numberToHex(f.base * 2n), maxPriorityFeePerGas: '0x0' }]));
  }
  const names = (rc: Receipt) => events(rc).map((e) => e.eventName);
  const rcx = await execute(key1, ref), evx = events(rcx);
  check(hexToNumber(rcx.status) === 1 && evx.some((e) => e.eventName === 'OrderExecuted' && gmxEventKey(e) === key1), `OrderHandler.executeOrder mined (gas ${hexToNumber(rcx.gasUsed)}): OrderExecuted for the order key`);
  const inc = evx.find((e) => e.eventName === 'PositionIncrease'), feesEv = evx.find((e) => e.eventName === 'PositionFeesCollected');
  check(!!inc && eqA(inc.fields.account, ME) && inc.fields.sizeInUsd === gmxUsdToRaw('60') && inc.fields.isLong === true, `PositionIncrease: account = wallet, size ${inc ? gmxUsdFromRaw(inc.fields.sizeInUsd as bigint) : '?'} USD, execution price ${inc ? gmxPriceFromRaw(inc.fields.executionPrice as bigint, 18) : '?'}, collateral in position ${inc ? usd6(inc.fields.collateralAmount as bigint) : '?'} USDC`);
  const sUsd = (v: unknown) => (typeof v === 'bigint' ? `${v < 0n ? '−' : ''}${gmxUsdFromRaw(v < 0n ? -v : v)}` : '?');
  if (feesEv) say(`       position fee ${typeof feesEv.fields.positionFeeAmount === 'bigint' ? usd6(feesEv.fields.positionFeeAmount) : '?'} USDC (factor ${sUsd(feesEv.fields.positionFeeFactor)})`);
  const pos1 = await reader('getAccountPositions', [P.dataStore.address, ME, 0n, 10n]);
  check(pos1.length === 1 && eqA(pos1[0].addresses.market, M.market) && eqA(pos1[0].addresses.collateralToken, USDC.token) && pos1[0].numbers.sizeInUsd === gmxUsdToRaw('60') && pos1[0].flags.isLong === true, `Reader (on-chain): one position, ${M.name}, long, size 60 USD, collateral ${pos1.length ? usd6(pos1[0].numbers.collateralAmount) : '?'} USDC, ${pos1.length ? formatUnits(pos1[0].numbers.sizeInTokens, 18) : '?'} ETH`);
  check((await reader('getAccountOrders', [P.dataStore.address, ME, 0n, 10n])).length === 0, 'Reader: the order is gone from the pending orders');
  const b2 = await bal();
  check(b2.eth > b1.eth, `unused execution fee refunded to the wallet: +${e18(b2.eth - b1.eth)} ETH of the ${e18(plan1.executionFee)} sent (the keeper kept ${e18(plan1.executionFee - (b2.eth - b1.eth))})`);

  // -------------------------------------------------------------------------------------------------------------------
  say('\n6. Closing the position: a MarketDecrease of the whole size, built by the signer, executed the same way');
  async function decrease(size: bigint, slipBps = 50): Promise<Intent> {
    const f = await fees();
    const g = section({ action: 'decrease', orderType: 'MarketDecrease', sizeDeltaUsd: size.toString(), acceptablePrice: gmxAcceptablePrice(ref, slipBps, { isLong: true, increase: false, indexDecimals: 18 }).toString(), executionFee: gmxExecutionFee(decGas, f.base, f.tip).toString() });
    return head(g, { asset: USDC.token, symbol: 'USDC', decimals: 6, amount: 0n, gas: 2_500_000n, f, nonce: await nonce() });
  }
  await refused('a close whose acceptable price is 2 % below the signer\'s price', sign(await decrease(gmxUsdToRaw('60'), 200)), /price: acceptable price/);
  const i2 = await decrease(gmxUsdToRaw('60')), plan2 = buildGmxTxs(i2, ME).plan;
  const { rc: rc2, signed: s2 } = await place(i2);
  const ev2 = created(rc2)!, key2 = gmxEventKey(ev2)!;
  check(!s2.pre && hexToNumber(rc2.status) === 1 && gmxOrderCreatedDiff(ev2, plan2, ME).length === 0, `MarketDecrease created ${key2} (no approval, no token sent): every field equals the approved one`);
  const b3 = await bal();
  check(b3.usdc === b2.usdc, 'no USDC left the wallet for the close');
  const rcd = await execute(key2, ref), evd = events(rcd);
  const dec = evd.find((e) => e.eventName === 'PositionDecrease');
  check(hexToNumber(rcd.status) === 1 && evd.some((e) => e.eventName === 'OrderExecuted' && gmxEventKey(e) === key2) && !!dec && dec.fields.sizeInUsd === 0n, `keeper execution: OrderExecuted, PositionDecrease to size 0 (PnL ${sUsd(dec?.fields.basePnlUsd)} USD at an unchanged price, price impact ${sUsd(dec?.fields.priceImpactUsd)} USD)`);
  const b4 = await bal();
  check((await reader('getAccountPositions', [P.dataStore.address, ME, 0n, 10n])).length === 0, 'Reader (on-chain): no position left');
  check(b4.usdc > b3.usdc && b4.usdc < b0.usdc, `collateral back in the wallet: +${usd6(b4.usdc - b3.usdc)} USDC of the 20 sent (round-trip cost in USDC: ${usd6(b0.usdc - b4.usdc)} = position fees and price impact)`);

  // -------------------------------------------------------------------------------------------------------------------
  say('\n7. Cancellation paths');
  // (a) by the keeper: the price moved beyond the acceptable price
  const i3 = await increase('20', '60'); const { rc: rc3 } = await place(i3); const key3 = gmxEventKey(created(rc3)!)!, b5 = await bal();
  const rck = await execute(key3, beyond), evk = events(rck), can = evk.find((e) => e.eventName === 'OrderCancelled');
  check(hexToNumber(rck.status) === 1 && !!can && gmxEventKey(can) === key3 && !names(rck).includes('OrderExecuted'), `keeper execution at ${beyond} USD: the order is CANCELLED, not executed — OrderCancelled with reasonBytes = ${String(can?.fields.reasonBytes).slice(0, 10) === ERR.price ? 'OrderNotFulfillableAtAcceptablePrice(price, acceptablePrice)' : String(can?.fields.reasonBytes).slice(0, 10)}`);
  const b6 = await bal();
  check(b6.usdc - b5.usdc === parseUnits('20', 6) && b6.eth > b5.eth, `collateral returned in full to the wallet: +${usd6(b6.usdc - b5.usdc)} USDC; unused execution fee: +${e18(b6.eth - b5.eth)} ETH`);
  check((await reader('getAccountPositions', [P.dataStore.address, ME, 0n, 10n])).length === 0 && (await reader('getAccountOrders', [P.dataStore.address, ME, 0n, 10n])).length === 0, 'Reader: no position, no pending order');

  // (b) by the owner: cancelOrder built by the signer, possible only after the request expiration
  const i4 = await increase('20', '60'); const { rc: rc4 } = await place(i4); const key4 = gmxEventKey(created(rc4)!)!, b7 = await bal();
  async function cancelIntent(key: string, gas: bigint): Promise<Intent> {
    const f = await fees();
    return head(section({ action: 'cancel', orderType: 'None', market: ZERO_ADDRESS, indexToken: ZERO_ADDRESS, collateralToken: ZERO_ADDRESS, isLong: false, orderKey: key }), { asset: 'native', symbol: 'ETH', decimals: 18, amount: 0n, gas, f, nonce: await nonce() });
  }
  const cdata = buildGmxTxs(await cancelIntent(key4, 1_500_000n), ME).main.data!;
  const early = await call(ROUTER, cdata, ME).then(() => 'did not revert', (e: RpcError) => ((e.data ?? e.message).startsWith(ERR.early) ? 'RequestNotYetCancellable' : (e.data ?? e.message).slice(0, 80)));
  check(early === 'RequestNotYetCancellable', `cancelOrder right after creation: the contracts answer ${early} (a market order can be cancelled by its account only ${GMX_REQUEST_EXPIRATION_SEC} s after its creation)`);
  await rpc('evm_increaseTime', [numberToHex(GMX_REQUEST_EXPIRATION_SEC + 1)]); await rpc('evm_mine', []);
  say(`  fork clock advanced by ${GMX_REQUEST_EXPIRATION_SEC + 1} s (now ${await blockTs()})`);
  const est = hexToBigInt(await rpc<Hex>('eth_estimateGas', [{ from: ME, to: ROUTER, data: cdata }]));
  const i5 = await cancelIntent(key4, (est * 3n) / 2n);
  await refused('a cancellation carrying a market', sign({ ...i5, proposalId: uuid(), gmx: { ...i5.gmx!, market: M.market } }), /unsupported: a cancellation carries no order field/);
  const { rc: rc5, signed: s5 } = await place(i5);
  const tx5 = parseTransaction(s5.raw as Hex), can5 = events(rc5).find((e) => e.eventName === 'OrderCancelled');
  check((tx5.value ?? 0n) === 0n && decodeGmxCalldata(tx5.data!).fn === 'cancelOrder' && hexToNumber(rc5.status) === 1 && !!can5 && gmxEventKey(can5) === key4, `cancelOrder(${key4.slice(0, 18)}…) signed by the signer and mined (gas ${hexToNumber(rc5.gasUsed)}, estimate ${est}): OrderCancelled reason "${String(can5?.fields.reason)}"`);
  const b8 = await bal(), gasCost = hexToBigInt(rc5.gasUsed) * hexToBigInt(rc5.effectiveGasPrice);
  check(b8.usdc - b7.usdc === parseUnits('20', 6), `collateral returned in full to the wallet: +${usd6(b8.usdc - b7.usdc)} USDC`);
  check(b8.eth + gasCost > b7.eth, `execution fee returned: +${e18(b8.eth + gasCost - b7.eth)} ETH of the ${e18(BigInt(i4.gmx!.executionFee))} sent (before the gas of the cancellation itself, ${e18(gasCost)} ETH)`);
  check((await reader('getAccountOrders', [P.dataStore.address, ME, 0n, 10n])).length === 0, 'Reader: no pending order');

  // -------------------------------------------------------------------------------------------------------------------
  say('\n8. Limits and revocation');
  const st = signer.status(), usage = st.gmx[0]!.today;
  check(usage.increases === 3 && usage.reduces === 2, `signer counters today: ${usage.increases} increases, ${usage.reduces} decreases/cancellations`);
  check(st.spentToday[`${net.id}:USDC`] === parseUnits('60', 6).toString(), `USDC counted against the wallet's daily limit: ${usd6(BigInt(st.spentToday[`${net.id}:USDC`] ?? '0'))} of ${usd6(BigInt(store.policy.daily[`${net.id}:USDC`]!))}`);
  await refused('one more increase of 45 USDC (60 + 45 is above the wallet\'s daily USDC limit)', sign(await increase('45', '100')), /policy: daily limit exceeded/);
  signer.gmxRevoke(AUTH_ID);
  await refused('an order after the authorization is revoked', sign(await increase('10', '20')), /revoked/);
  check(store.state.journal.filter((j) => j.type === 'gmx.sign.ok').length === 5 && store.state.journal.filter((j) => j.type === 'sign.ok').length === 5, 'signer journal: 5 GMX signatures (3 increases, 1 decrease, 1 cancellation), each journaled twice (gmx.sign.ok + sign.ok)');
  check((await eth(ROUTER)) === 0n, 'no ETH left in the ExchangeRouter (msg.value was exactly the execution fee)');

  say(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  say('Proven on the fork: creation with exactly the approved fields; simulated execution by GMX\'s SimulationRouter (succeeds at the market price, fails beyond the acceptable price);');
  say('keeper execution by the real OrderHandler with an impersonated real keeper and a MOCKED price provider (no signed oracle report); close; keeper cancellation; user cancellation after the delay.');
  say('NOT proven: execution by GMX\'s real keepers with real signed Chainlink Data Streams prices (timing, price, liveness) — that only exists on mainnet.');
} finally { anvil?.kill(); }
process.exit(failures ? 1 : 0);
