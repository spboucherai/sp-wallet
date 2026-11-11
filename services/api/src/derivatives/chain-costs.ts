// Chain-side inputs of the derivatives router (simulation): the Arbitrum gas price and the minimum execution fee the GMX
// contracts require for a market increase order. READ ONLY: `eth_gasPrice` and `eth_call` on public RPC endpoints — nothing is
// signed, nothing is sent, no key exists here.
//
// GMX execution fee (docs/v4/venues/gmx.md §1, contracts gas/GasUtils.sol and data/Keys.sol, branch `updates`):
//   minimum fee at creation = tx.gasprice × adjustGasLimitForEstimate(estimatedGasLimit, oraclePriceCount)
//   estimatedGasLimit (increase order, no swap, no callback) = DataStore[INCREASE_ORDER_GAS_LIMIT]
//   adjustGasLimitForEstimate = DataStore[ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1] + DataStore[ESTIMATED_GAS_FEE_PER_ORACLE_PRICE] × oraclePriceCount
//                               + estimatedGasLimit × DataStore[ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR] / 10^30
//   oraclePriceCount = 3 + swaps (GasUtils.estimateOrderOraclePriceCount)
// The keeper is paid only the gas it used; the rest is refunded. What is computed here is what must be SENT, an upper bound of
// the cost. A DataStore key is keccak256(abi.encode(<name>)).
import { encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';
import { D, type ChainCosts, type DecStr } from '@spw/derivatives';

/** GMX DataStore on Arbitrum One — docs/v4/venues/gmx.md §4 (the address is documented as permanent) */
export const GMX_DATASTORE_ARBITRUM = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
export const ARBITRUM_RPCS = ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'];
export const GMX_GAS_KEYS = ['INCREASE_ORDER_GAS_LIMIT', 'ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1', 'ESTIMATED_GAS_FEE_PER_ORACLE_PRICE', 'ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'] as const;
export type GmxGasKey = (typeof GMX_GAS_KEYS)[number];
export const dataStoreKey = (name: string): `0x${string}` => keccak256(encodeAbiParameters([{ type: 'string' }], [name]));
const GET_UINT = toFunctionSelector('getUint(bytes32)');
/** oracle prices of a market increase without a swap path */
export const GMX_ORACLE_PRICE_COUNT = 3n;
export const CHAIN_COSTS_TTL_MS = 30_000;
/** DataStore gas parameters change by governance only: one read an hour is enough */
const PARAMS_TTL_MS = 3_600_000;
const WEI = D.from(10n ** 18n);

export interface GmxGasParams { increaseOrderGasLimit: bigint; baseAmount: bigint; perOraclePrice: bigint; multiplierFactor: bigint }
/** `GasUtils.adjustGasLimitForEstimate` for a market increase order */
export function gmxEstimatedExecutionGas(p: GmxGasParams): bigint {
  return p.baseAmount + p.perOraclePrice * GMX_ORACLE_PRICE_COUNT + (p.increaseOrderGasLimit * p.multiplierFactor) / 10n ** 30n;
}

export interface ChainCostsReader { read(ethUsd: { value: DecStr; source: string } | null): Promise<ChainCosts> }

export function createChainCostsReader(o: { fetch?: typeof fetch; now?: () => number; rpcs?: string[]; timeoutMs?: number } = {}): ChainCostsReader {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now, rpcs = o.rpcs ?? ARBITRUM_RPCS, timeoutMs = o.timeoutMs ?? 4000;
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<bigint> => {
    let last: unknown = new Error('no RPC endpoint');
    for (const url of rpcs) {
      try {
        const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        const j = await r.json() as { result?: unknown; error?: { message?: string } };
        if (typeof j.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(j.result)) throw new Error(j.error?.message ?? `unexpected answer to ${method}`);
        return BigInt(j.result);
      } catch (e) { last = e; }
    }
    throw last;
  };
  let gas: { at: number; wei: bigint } | null = null, params: { at: number; p: GmxGasParams } | null = null;
  const gasPrice = async (): Promise<bigint> => {
    if (gas && now() - gas.at < CHAIN_COSTS_TTL_MS) return gas.wei;
    const wei = await rpc('eth_gasPrice', []);
    if (wei <= 0n) throw new Error('gas price is not positive');
    gas = { at: now(), wei };
    return wei;
  };
  const gmxParams = async (): Promise<GmxGasParams> => {
    if (params && now() - params.at < PARAMS_TTL_MS) return params.p;
    const [increaseOrderGasLimit, baseAmount, perOraclePrice, multiplierFactor] = await Promise.all(GMX_GAS_KEYS.map((k) => rpc('eth_call', [{ to: GMX_DATASTORE_ARBITRUM, data: `${GET_UINT}${dataStoreKey(k).slice(2)}` }, 'latest'])));
    const p = { increaseOrderGasLimit: increaseOrderGasLimit!, baseAmount: baseAmount!, perOraclePrice: perOraclePrice!, multiplierFactor: multiplierFactor! };
    // a wrong key reads zero: a zero gas limit or multiplier means the keys are not what the contracts use — say unknown, never a fee of zero
    if (p.increaseOrderGasLimit === 0n || p.multiplierFactor === 0n) throw new Error('GMX DataStore answered zero for a gas parameter');
    params = { at: now(), p };
    return p;
  };
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

  return {
    /** never throws: what cannot be read is null, with the reason in the note — the router then reports that cost as unknown */
    async read(ethUsd) {
      const out: ChainCosts = { gasPriceEth: null, ethUsd: ethUsd?.value ?? null, ethUsdSource: ethUsd?.source ?? 'no ETH price in the snapshot', gmxExecutionFeeEth: null, gmxExecutionFeeNote: '', ts: now() };
      let wei: bigint;
      try { wei = await gasPrice(); out.gasPriceEth = D.str(D.div(D.from(wei), WEI, 18, 'down')); }
      catch (e) { out.gmxExecutionFeeNote = `the Arbitrum gas price could not be read (${msg(e)})`; return out; }
      try {
        const p = await gmxParams(), limit = gmxEstimatedExecutionGas(p);
        out.gmxExecutionFeeEth = D.str(D.div(D.from(limit * wei), WEI, 18, 'up'));
        out.gmxExecutionFeeNote = `minimum the contracts require at this gas price: ${limit} gas (DataStore: increase order gas limit ${p.increaseOrderGasLimit}, base ${p.baseAmount}, ${p.perOraclePrice} per oracle price × ${GMX_ORACLE_PRICE_COUNT}, multiplier ${D.str(D.div(D.from(p.multiplierFactor), D.from(10n ** 30n), 6, 'half_even'))}) × ${wei} wei; the venue's interface adds a buffer, and the unused part is refunded`;
      } catch (e) { out.gmxExecutionFeeNote = `the GMX gas parameters could not be read from the DataStore (${msg(e)})`; }
      return out;
    },
  };
}
