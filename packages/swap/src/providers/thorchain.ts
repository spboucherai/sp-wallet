// THORChain native cross-chain swaps — price discovery only (docs/swap/providers/thorchain.md).
// The engine in this file is shared with Maya Protocol (maya.ts), a THORChain fork that differs in endpoints,
// pools, error envelope and in how the memo limit is enforced. Nothing here builds, signs or sends a transaction.
//
// Verified live on 2026-11-10 against THORNode 3.21.3 (see the dossier for every source):
//  - GET /thorchain/quote/swap?from_asset&to_asset&amount&destination&liquidity_tolerance_bps
//  - GET /thorchain/inbound_addresses (chain halts, trading pauses, routers, dust thresholds)
//  - amounts are 1e8 fixed point for every asset, whatever the asset's real decimals
import { z } from 'zod';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { assetKey, ProviderError, resolveAsset, sameAsset, type AssetRef, type FeeItem, type ProviderContext, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import type { ProviderEnv } from './index.ts';

// ───────────────────────────── 1e8 fixed point ⇄ real decimals (exact integer arithmetic) ─────────────────────────────

/** Protocol precision: every amount inside THORChain / MAYAChain is an integer number of 1e-8 units. */
export const PROTOCOL_DECIMALS = 8;
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const checkDecimals = (d: number) => { if (!Number.isInteger(d) || d < 0 || d > 36) throw new RangeError(`unsupported decimals: ${d}`); };

/** Base units of an asset → protocol 1e8 units. Rounds DOWN: the part of an 18-decimal amount below 1e-8 is not credited by the protocol. */
export function toProtocolAmount(baseUnits: bigint, decimals: number): bigint {
  checkDecimals(decimals); if (baseUnits < 0n) throw new RangeError('negative amount');
  return decimals >= PROTOCOL_DECIMALS ? baseUnits / pow10(decimals - PROTOCOL_DECIMALS) : baseUnits * pow10(PROTOCOL_DECIMALS - decimals);
}
/** Protocol 1e8 units → base units of an asset. Rounds DOWN for assets with fewer than 8 decimals (the chain cannot pay a fraction of a base unit). */
export function fromProtocolAmount(protocolUnits: bigint, decimals: number): bigint {
  checkDecimals(decimals); if (protocolUnits < 0n) throw new RangeError('negative amount');
  return decimals >= PROTOCOL_DECIMALS ? protocolUnits * pow10(decimals - PROTOCOL_DECIMALS) : protocolUnits / pow10(PROTOCOL_DECIMALS - decimals);
}
/** The limit the protocol writes in the memo for `liquidity_tolerance_bps`: floor(expected_amount_out × (10000 − bps) / 10000), in 1e8 units.
 *  Source: x/thorchain/querier_quotes.go (`outputLimit := emitAmount.Sub(outboundFeeAmount).MulUint64(10000 - bps).QuoUint64(10000)`). */
export function liquidityToleranceLimit(expectedOut: bigint, toleranceBps: number): bigint {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 1 || toleranceBps > 9999) throw new RangeError('tolerance must be an integer in 1..9999 bps');
  return (expectedOut * BigInt(10_000 - toleranceBps)) / 10_000n;
}

// ───────────────────────────── configuration of one network (THORChain, or its fork Maya) ─────────────────────────────

export interface NativeSwapConfig {
  id: string; name: string; docs: string;
  /** pinned API base, including the module path (…/thorchain or …/mayachain) */
  api: string;
  /** protocol chain id → wallet network id */
  chains: Record<string, string>;
  /** pool assets that were `Available` when this file was last verified. Only these can be quoted; the wallet asset behind
   *  each one is resolved by chain + contract address against the wallet registry, never by ticker. */
  pools: readonly string[];
  /** memo short codes the protocol may use for the target asset (pool `short_code`), short → full notation */
  shortCodes: Record<string, string>;
  /** router contracts per wallet network, as published by the network itself; a quote naming any other router is rejected */
  routers: Record<string, string>;
  /** streaming parameters sent with every quote, or null to let the protocol decide (THORChain's advanced swap queue) */
  streaming: { interval: number } | null;
  /** true: the memo limit is enforced on the amount net of the outbound fee (THORChain ≥ v3 `swap_current.go`);
   *  false: it is enforced on the gross swap output, so the recipient's real floor is limit − outbound fee (Maya) */
  limitIsNetOfOutboundFee: boolean;
}

/** One pool asset resolved against the wallet registry. */
export interface MappedAsset { notation: string; chain: string; ref: AssetRef; decimals: number; symbol: string }

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Resolve the pinned pool list against the wallet registry: chain must be mapped, and the contract must be a registry token
 *  on that network (or the pool must be the chain's gas asset and carry the registry's native symbol). */
export function mapPools(cfg: Pick<NativeSwapConfig, 'chains' | 'pools'>): Map<string, MappedAsset> {
  const out = new Map<string, MappedAsset>();
  for (const notation of cfg.pools) {
    const m = /^([A-Z0-9]+)\.([A-Z0-9]+)(?:-([A-Z0-9]+))?$/.exec(notation); if (!m) continue;
    const [, chain, ticker, contract] = m as unknown as [string, string, string, string | undefined];
    const network = cfg.chains[chain]; const net: NetworkDef | undefined = network ? NETWORKS[network] : undefined; if (!network || !net) continue;
    if (contract === undefined) {
      if (net.native.symbol.toUpperCase() !== ticker) continue; // e.g. a non-gas native-denominated pool we do not know
      const ref = { network, asset: 'native' };
      out.set(assetKey(ref), { notation, chain, ref, decimals: net.native.decimals, symbol: net.native.symbol });
    } else {
      const hits = net.tokens.filter((t) => t.id.toUpperCase() === contract);
      if (hits.length !== 1) continue; // not in the registry, or ambiguous once upper-cased: never guess
      const t = hits[0]!; const ref = { network, asset: t.id };
      out.set(assetKey(ref), { notation, chain, ref, decimals: t.decimals, symbol: t.symbol });
    }
  }
  return out;
}

// ───────────────────────────── response schemas ─────────────────────────────

const digits = z.string().regex(/^(0|[1-9]\d{0,38})$/, 'not a non-negative integer string');
const count = z.number().int().nonnegative().max(1e9);
export const QuoteSchema = z.looseObject({
  inbound_address: z.string().regex(/^[A-Za-z0-9:]{20,120}$/),
  inbound_confirmation_blocks: count.optional(), inbound_confirmation_seconds: count.optional(),
  outbound_delay_blocks: count.optional(), outbound_delay_seconds: count.optional(),
  fees: z.looseObject({ asset: z.string().min(3).max(120), affiliate: digits, outbound: digits, liquidity: digits, total: digits,
    slippage_bps: z.number().int().min(0).max(10_000), total_bps: z.number().int().min(0).max(10_000) }),
  router: z.string().regex(EVM_ADDRESS).optional(),
  expiry: z.number().int().positive(),
  warning: z.string().max(2000).optional(), notes: z.string().max(4000).optional(),
  dust_threshold: digits.optional(), recommended_min_amount_in: digits,
  recommended_gas_rate: digits.optional(), gas_rate_units: z.string().max(40).optional(),
  memo: z.string().min(5).max(250),
  expected_amount_out: digits,
  max_streaming_quantity: count.optional(), streaming_swap_blocks: count.optional(), streaming_swap_seconds: count.optional(),
  total_swap_seconds: count.optional(),
});
export type NativeQuote = z.infer<typeof QuoteSchema>;
/** THORNode answers errors as HTTP 4xx `{code, message}`; MAYANode as HTTP 200 `{error}`. */
const ErrorSchema = z.union([z.looseObject({ message: z.string() }), z.looseObject({ error: z.string() })]);
export const InboundSchema = z.array(z.looseObject({
  chain: z.string().regex(/^[A-Z0-9]{2,10}$/), address: z.string().min(20).max(160), router: z.string().regex(EVM_ADDRESS).optional(),
  halted: z.boolean(), global_trading_paused: z.boolean().optional(), chain_trading_paused: z.boolean().optional(),
  dust_threshold: digits.optional(), outbound_fee: digits.optional(),
})).min(1).max(200);
export type InboundAddresses = z.infer<typeof InboundSchema>;

/** Why a chain cannot be used right now, or null. `halted` covers HALT<CHAIN>CHAIN / solvency halts, the two pause flags cover
 *  HALTTRADING and HALT<CHAIN>TRADING mimirs (THORNode derives all three from mimir in `inbound_addresses`). */
export function chainBlocked(inbound: InboundAddresses, chain: string): string | null {
  const e = inbound.find((x) => x.chain === chain);
  if (!e) return `${chain}: no inbound address (chain not active)`;
  if (e.halted) return `${chain}: chain halted`;
  if (e.global_trading_paused) return 'trading paused globally';
  if (e.chain_trading_paused) return `${chain}: trading paused`;
  return null;
}

// ───────────────────────────── memo ─────────────────────────────

export interface ParsedSwapMemo { asset: string; destination: string; limit: bigint; interval: number | null; quantity: number | null }
/** Parse `=:ASSET:DEST:LIM[/INTERVAL/QUANTITY]`. Anything else — another handler, a refund override, an affiliate, an
 *  aggregator hop, scientific notation — is rejected: this adapter never asks for those, so their presence is hostile. */
export function parseSwapMemo(memo: string): ParsedSwapMemo {
  const p = memo.split(':');
  if (p.length !== 4) throw new Error(`unexpected memo shape (${p.length} fields)`);
  if (p[0] !== '=') throw new Error('memo is not a market swap');
  const lim = p[3]!.split('/');
  if (lim.length !== 1 && lim.length !== 3) throw new Error('unexpected limit/streaming field');
  if (!lim.every((x) => /^(0|[1-9]\d{0,38})$/.test(x))) throw new Error('non-integer limit/streaming field');
  if (p[2]!.includes('/')) throw new Error('memo carries a refund address override');
  return { asset: p[1]!, destination: p[2]!, limit: BigInt(lim[0]!), interval: lim.length === 3 ? Number(lim[1]) : null, quantity: lim.length === 3 ? Number(lim[2]) : null };
}
/** The memo's target asset must be the requested one: full notation, the pinned short code, or the protocol's own
 *  abbreviations of that exact notation (`CHAIN.TICKER`, `CHAIN.TICKER-<contract suffix>`). */
export function memoAssetMatches(field: string, notation: string, shortCodes: Record<string, string>): boolean {
  if (shortCodes[field] !== undefined) return shortCodes[field] === notation;
  const f = field.toUpperCase();
  if (f === notation) return true;
  const dash = notation.indexOf('-'); if (dash < 0) return false;
  const head = notation.slice(0, dash), contract = notation.slice(dash + 1);
  if (f === head) return true;
  return f.startsWith(head + '-') && f.length > head.length + 1 && contract.endsWith(f.slice(head.length + 1));
}
const normAddress = (net: NetworkDef, a: string) => (net.family === 'evm' ? a.toLowerCase() : net.family === 'bch' ? a.replace(/^bitcoincash:/i, '') : a);

// ───────────────────────────── provider ─────────────────────────────

/** Protocol messages that mean "this swap cannot be done now" (→ no route) rather than "the provider is broken". */
const NO_ROUTE = [/dust threshold/i, /min swap amount/i, /not enough asset to pay for fees/i, /pool\(.*\) is not available/i, /pool does not exist/i,
  /halt/i, /paused/i, /less than price limit/i, /zero emit asset/i, /swap (amount )?too small/i, /outbound amount does not meet requirements/i];
const STALE = /stale state/i;
const INBOUND_TTL_MS = 15_000; // halt flags only; the vault address is never cached (it comes with each quote)
const MAX_EXPIRY_AHEAD_S = 3600;

export function createNativeSwapProvider(cfg: NativeSwapConfig): SwapProvider & { assets: Map<string, MappedAsset> } {
  const assets = mapPools(cfg);
  const networks = [...new Set([...assets.values()].map((a) => a.ref.network))];
  const headers = { 'x-client-id': 'sp-wallet' };
  let inboundCache: { at: number; data: InboundAddresses } | null = null;
  let seq = 0;
  const schemaError = (m: string) => new ProviderError(cfg.id, 'schema', m);

  async function inbound(ctx: ProviderContext): Promise<InboundAddresses> {
    if (inboundCache && ctx.now() - inboundCache.at < INBOUND_TTL_MS && ctx.now() >= inboundCache.at) return inboundCache.data;
    const p = InboundSchema.safeParse(await ctx.http.getJson(`${cfg.api}/inbound_addresses`, { headers, signal: ctx.signal }));
    if (!p.success) throw schemaError(`inbound_addresses: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`);
    inboundCache = { at: ctx.now(), data: p.data };
    return p.data;
  }
  /** → validated quote, or a protocol refusal message */
  async function fetchQuote(url: string, ctx: ProviderContext): Promise<{ quote: NativeQuote } | { refusal: string }> {
    let body: unknown;
    try { body = await ctx.http.getJson(url, { headers, signal: ctx.signal }); }
    catch (e) {
      const errBody = e instanceof ProviderError && e.code === 'http' ? ErrorSchema.safeParse((e as ProviderError & { body?: unknown }).body) : null;
      if (!errBody?.success) throw e;
      return { refusal: 'message' in errBody.data ? errBody.data.message as string : errBody.data.error as string };
    }
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { error?: unknown }).error === 'string' && !('expected_amount_out' in body)) return { refusal: (body as { error: string }).error };
    const p = QuoteSchema.safeParse(body);
    if (!p.success) throw schemaError(`quote: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`);
    return { quote: p.data };
  }

  const supportsPair = (from: AssetRef, to: AssetRef): boolean => { try { return !sameAsset(from, to) && assets.has(assetKey(from)) && assets.has(assetKey(to)); } catch { return false; } };

  return {
    id: cfg.id, name: cfg.name, assets,
    capabilities: () => ({ networks, crossChain: true, needsKey: false, configured: true, kinds: ['native_swap'], docs: cfg.docs }),
    supportsPair,

    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!supportsPair(req.from, req.to)) return [];
      const src = assets.get(assetKey(req.from))!, dst = assets.get(assetKey(req.to))!;
      // decimals come from the wallet registry, re-read here so a registry/asset-table mismatch can never go unnoticed
      if (resolveAsset(req.from).def.decimals !== src.decimals || resolveAsset(req.to).def.decimals !== dst.decimals) throw schemaError('registry decimals changed');
      const srcNet = NETWORKS[src.ref.network]!, dstNet = NETWORKS[dst.ref.network]!;
      // the protocol's limit parameter is an integer number of basis points in 1..9999; zero tolerance cannot be expressed
      if (!Number.isInteger(req.slippageBps) || req.slippageBps < 1 || req.slippageBps > 9999) return [];
      if (req.amountIn <= 0n) return [];
      const amount = toProtocolAmount(req.amountIn, src.decimals);
      if (amount === 0n) return [];

      const q = new URLSearchParams({ from_asset: src.notation, to_asset: dst.notation, amount: amount.toString(), destination: req.recipient, liquidity_tolerance_bps: String(req.slippageBps) });
      if (cfg.streaming) { q.set('streaming_interval', String(cfg.streaming.interval)); q.set('streaming_quantity', '0'); }
      // one round: the quote and (unless fresh) the halt flags, concurrently
      // A public gateway load-balances over several nodes; one that lags answers "refusing quote on node with stale state" within
      // milliseconds. That refusal (and only that one) is retried once, which normally lands on another node.
      const url = `${cfg.api}/quote/swap?${q}`;
      const quoteP = fetchQuote(url, ctx).then((first) => ('refusal' in first && STALE.test(first.refusal) ? fetchQuote(url, ctx) : first));
      quoteP.catch(() => undefined); // if inbound() throws first, the quote's own failure must not become an unhandled rejection
      const inb = await inbound(ctx);
      if (chainBlocked(inb, src.chain) || chainBlocked(inb, dst.chain)) { await quoteP.catch(() => undefined); return []; }
      const res = await quoteP;
      if ('refusal' in res) {
        if (STALE.test(res.refusal)) throw new ProviderError(cfg.id, 'unavailable', res.refusal.slice(0, 160));
        if (NO_ROUTE.some((r) => r.test(res.refusal))) return [];
        throw new ProviderError(cfg.id, 'http', res.refusal.slice(0, 160));
      }
      const r = res.quote;

      // ── everything below treats the answer as hostile ──
      if (r.fees.asset !== dst.notation) throw schemaError(`fees are in ${r.fees.asset.slice(0, 60)}, not ${dst.notation}`);
      const fee = { affiliate: BigInt(r.fees.affiliate), outbound: BigInt(r.fees.outbound), liquidity: BigInt(r.fees.liquidity), total: BigInt(r.fees.total) };
      if (fee.affiliate !== 0n) throw schemaError('affiliate fee on a quote requested without affiliate');
      if (fee.total !== fee.affiliate + fee.outbound + fee.liquidity) throw schemaError('fee total does not add up');
      const expected = BigInt(r.expected_amount_out);

      let memo: ParsedSwapMemo;
      try { memo = parseSwapMemo(r.memo); } catch (e) { throw schemaError(`memo: ${(e as Error).message}`); }
      if (!memoAssetMatches(memo.asset, dst.notation, cfg.shortCodes)) throw schemaError(`memo targets ${memo.asset.slice(0, 60)}, not ${dst.notation}`);
      if (normAddress(dstNet, memo.destination) !== normAddress(dstNet, req.recipient)) throw schemaError('memo pays another recipient');
      const limit = liquidityToleranceLimit(expected, req.slippageBps);
      if (memo.limit !== limit) throw schemaError(`memo limit ${memo.limit} is not expected_amount_out less ${req.slippageBps} bps (${limit})`);
      if (cfg.streaming ? memo.interval !== cfg.streaming.interval : memo.interval !== null && memo.interval !== 0) throw schemaError('unexpected streaming interval in memo');

      const srcInbound = inb.find((x) => x.chain === src.chain)!;
      if (srcNet.family === 'evm') {
        const pinned = cfg.routers[src.ref.network];
        if (!r.router || !pinned || r.router.toLowerCase() !== pinned.toLowerCase()) throw schemaError(`router ${r.router ?? '(none)'} is not the pinned ${cfg.name} router for ${src.ref.network}`);
        if (srcInbound.router?.toLowerCase() !== pinned.toLowerCase()) throw schemaError('inbound_addresses names another router');
        if (!EVM_ADDRESS.test(r.inbound_address) || r.inbound_address.toLowerCase() === pinned.toLowerCase()) throw schemaError('inbound vault is not a plain EVM address');
      } else if (r.router !== undefined) throw schemaError('router on a non-EVM source chain');
      if (normAddress(srcNet, r.inbound_address) === normAddress(srcNet, req.sender)) throw schemaError('inbound vault is the sender');

      const nowS = Math.floor(ctx.now() / 1000);
      if (r.expiry <= nowS) throw new ProviderError(cfg.id, 'bad_response', 'quote already expired');
      if (r.expiry > nowS + MAX_EXPIRY_AHEAD_S) throw schemaError('expiry too far in the future');

      // protocol minimums: at or below dust the inbound is ignored (funds lost); below the recommended minimum a refund cannot pay its own fee
      if (r.dust_threshold !== undefined && amount <= BigInt(r.dust_threshold)) return [];
      if (amount < BigInt(r.recommended_min_amount_in)) return [];

      const quantity = memo.quantity !== null && memo.quantity > 0 ? memo.quantity : memo.interval !== null ? (r.max_streaming_quantity ?? 0) : 1;
      const streaming = quantity > 1;
      // what the recipient is guaranteed if the swap executes in full (see NativeSwapConfig.limitIsNetOfOutboundFee)
      const floor1e8 = cfg.limitIsNetOfOutboundFee ? limit : limit > fee.outbound ? limit - fee.outbound : 0n;
      const amountOut = fromProtocolAmount(expected, dst.decimals), minAmountOut = fromProtocolAmount(floor1e8, dst.decimals);
      if (amountOut <= 0n || minAmountOut <= 0n) return [];

      const feeItem = (kind: FeeItem['kind'], v: bigint): FeeItem => ({ kind, asset: dst.ref, amount: fromProtocolAmount(v, dst.decimals), includedInOutput: true, estimated: true });
      const contracts: SwapQuote['steps'][number]['contracts'] = [{ network: src.ref.network, address: r.inbound_address, role: 'vault' }];
      if (r.router) contracts.push({ network: src.ref.network, address: r.router, role: 'router' });
      return [{
        id: `${cfg.id}-${ctx.now()}-${++seq}`, provider: cfg.id, request: req,
        steps: [{ kind: 'native_swap', provider: cfg.id, from: req.from, to: req.to,
          via: [cfg.name, `${src.notation} → ${dst.notation}`, streaming ? `streaming swap: ${quantity} sub-swaps${memo.interval ? `, every ${memo.interval} block(s)` : ''}` : 'single swap'], contracts }],
        amountOut, minAmountOut,
        // liquidity (slip) fee stays in the pools; the outbound fee pays the destination-chain gas of the vault's outbound transaction.
        // Both are already deducted from expected_amount_out. The sender's own source-chain network fee is not part of the quote.
        fees: [feeItem('protocol', fee.liquidity), feeItem('network', fee.outbound)],
        estimatedSeconds: r.total_swap_seconds ?? null,
        priceImpactBps: r.fees.slippage_bps,
        expiresAt: r.expiry * 1000,
        firmness: 'indicative',
        executability: { class: 'quote_only', reason: `${cfg.name} swaps are a transfer to a rotating vault address that only the network's API can name; the isolated signer cannot yet verify that address or rebuild the memo itself (docs/swap/providers/${cfg.id}.md)` },
        refundable: true, // amount ≥ recommended_min_amount_in: a failed swap is refunded to the sender, less the source-chain outbound fee
        atomic: false,
        raw: { quote: r, request: Object.fromEntries(q), amount1e8: amount.toString(), limit1e8: limit.toString(), guaranteed1e8: floor1e8.toString(),
          streaming: { quoted: streaming, interval: memo.interval, quantity, maxQuantity: r.max_streaming_quantity ?? null, seconds: r.streaming_swap_seconds ?? null },
          dustThreshold1e8: r.dust_threshold ?? null, recommendedMinAmountIn1e8: r.recommended_min_amount_in,
          inboundConfirmationSeconds: r.inbound_confirmation_seconds ?? null, outboundDelaySeconds: r.outbound_delay_seconds ?? null },
      }];
    },
  };
}

// ───────────────────────────── THORChain ─────────────────────────────

/** Liquify public gateway — the endpoint the official developer docs list (https://dev.thorchain.org/concepts/connecting-to-thorchain.html). */
export const THORCHAIN_API = 'https://gateway.liquify.com/chain/thorchain_api/thorchain';
export const THORCHAIN_API_VERSION = '3.21.3'; // /thorchain/version on 2026-11-10

export const THORCHAIN_CONFIG: NativeSwapConfig = {
  id: 'thorchain', name: 'THORChain', docs: 'https://dev.thorchain.org/swap-guide/quickstart-guide.html', api: THORCHAIN_API,
  chains: { BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', DOGE: 'dogecoin', BCH: 'bitcoincash', AVAX: 'avalanche', BSC: 'bsc', BASE: 'base',
    GAIA: 'cosmos', XRP: 'xrpl', TRON: 'tron', SOL: 'solana' },
  // GET /thorchain/pools on 2026-11-10: every pool with status "Available" on a chain the wallet has (ZEC.ZEC, THOR.* have no wallet network).
  // Pools whose contract is not in the wallet registry are listed anyway and dropped by mapPools(); Staged pools (e.g. ETH.LINK) are not listed.
  pools: [
    'BTC.BTC', 'ETH.ETH', 'LTC.LTC', 'DOGE.DOGE', 'BCH.BCH', 'AVAX.AVAX', 'BSC.BNB', 'BASE.ETH', 'GAIA.ATOM', 'XRP.XRP', 'TRON.TRX', 'SOL.SOL',
    'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7',
    'ETH.DAI-0X6B175474E89094C44DA98B954EEDEAC495271D0F', 'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599',
    'ETH.AAVE-0X7FC66500C84A76AD7E9C93437BFC5AC33E2DDAE9',
    'AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E', 'AVAX.USDT-0X9702230A8EA53601F5CD2DC00FDBC13D4DF4A8C7',
    'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
    'BSC.USDC-0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D', 'BSC.USDT-0X55D398326F99059FF775485246999027B3197955',
    'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T',
  ],
  // pool `short_code` values from GET /thorchain/pools
  shortCodes: { a: 'AVAX.AVAX', f: 'BASE.ETH', c: 'BCH.BCH', s: 'BSC.BNB', b: 'BTC.BTC', d: 'DOGE.DOGE', e: 'ETH.ETH', g: 'GAIA.ATOM', l: 'LTC.LTC', o: 'SOL.SOL', tr: 'TRON.TRX', x: 'XRP.XRP' },
  // `router` in GET /thorchain/inbound_addresses and in every active Asgard vault (GET /thorchain/vaults/asgard) on 2026-11-10
  routers: {
    ethereum: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146',
    avalanche: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4',
    base: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4',
    bsc: '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b',
  },
  streaming: null, // advanced swap queue: the network sizes rapid streaming itself and writes LIM/0/N in the memo when N > 1
  limitIsNetOfOutboundFee: true,
};

export function createThorchainProvider(_env: ProviderEnv = {}): SwapProvider {
  return createNativeSwapProvider(THORCHAIN_CONFIG);
}
