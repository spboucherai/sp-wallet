// SP Universal Swap Router — shared contract. Every provider adapter, the aggregator, the graph, the optimizer,
// the API and the UI speak these types. Amounts are bigint base units end to end; nothing here is ever a float
// except fiat estimates, which are display/ranking aids and never feed a transaction.
import { getAsset, getNetwork, type AssetDef, type NetworkDef } from '@spw/core';

/** An asset is identified by network + contract/mint ('native' for the chain coin). A symbol is never an identifier. */
export interface AssetRef { network: string; asset: string }
export const assetKey = (a: AssetRef): string => `${a.network}:${a.asset === 'native' ? 'native' : getNetwork(a.network).family === 'evm' ? a.asset.toLowerCase() : a.asset}`;
export const sameAsset = (a: AssetRef, b: AssetRef) => assetKey(a) === assetKey(b);
/** Resolve against the wallet's verified registry; throws for anything not allowlisted. */
export function resolveAsset(a: AssetRef): { net: NetworkDef; def: AssetDef } { return { net: getNetwork(a.network), def: getAsset(a.network, a.asset) }; }

export type RoutingMode = 'best_price' | 'fastest' | 'balanced';

export interface SwapQuoteRequest {
  from: AssetRef; to: AssetRef;
  /** exact input, base units of `from` */
  amountIn: bigint;
  /** the wallet's address on the source network (pays) and on the destination network (receives) */
  sender: string; recipient: string;
  /** maximum tolerated slippage, basis points (50 = 0.5 %) */
  slippageBps: number;
}

export type StepKind = 'swap' | 'bridge' | 'native_swap' | 'wrap' | 'unwrap';
export interface RouteStep {
  kind: StepKind; provider: string;
  from: AssetRef; to: AssetRef;
  /** the venue as the provider names it (pool, DEX, bridge), for display only */
  via: string[];
  /** contracts / programs / vault addresses this step would interact with, on `network` */
  contracts: { network: string; address: string; role: 'router' | 'spender' | 'vault' | 'bridge' | 'program' }[];
}

export type FeeKind = 'network' | 'protocol' | 'provider' | 'bridge' | 'affiliate';
export interface FeeItem {
  kind: FeeKind; asset: AssetRef; amount: bigint;
  /** true when `amountOut` is already net of this fee (so it must not be subtracted again) */
  includedInOutput: boolean;
  /** true when the figure is an estimate (e.g. gas) rather than a fixed charge */
  estimated: boolean;
}

/** How far the wallet can take this quote today. Reported honestly per quote. */
export type Executability =
  /** the isolated signer can rebuild/verify every value-moving field itself */
  | { class: 'verified' }
  /** provider-built calldata/instructions the signer can only constrain structurally (allowlisted contract, exact allowance) */
  | { class: 'opaque'; reason: string; /** v11: machine code of `reason` (the UI translates it; `reason` stays the English sentence) */ code?: string }
  /** price discovery only: the wallet cannot execute this route */
  | { class: 'quote_only'; reason: string; code?: string };

export type RiskLevel = 'low' | 'medium' | 'high';
export interface RiskFlag { code: string; level: RiskLevel; detail?: string;
  /** v11: the figures of `detail` as parameters (the UI builds its own sentence from `code` + `params`) */ params?: Record<string, string | number> }
export interface RiskAssessment { level: RiskLevel; score: number; flags: RiskFlag[] }

export interface SwapQuote {
  /** unique per quote response */
  id: string;
  provider: string;
  request: SwapQuoteRequest;
  steps: RouteStep[];
  /** expected output and the minimum the route guarantees after slippage, base units of `to` */
  amountOut: bigint; minAmountOut: bigint;
  fees: FeeItem[];
  /** provider's own estimate; null when it gives none (never invented) */
  estimatedSeconds: number | null;
  priceImpactBps: number | null;
  /** unix ms at which the adapter received this answer from the provider (v11: the age shown on the route card) */
  quotedAt: number;
  /** unix ms after which this quote must not be used to build a transaction */
  expiresAt: number;
  /** indicative = fast price discovery; firm = fetched for execution with the real addresses */
  firmness: 'indicative' | 'firm';
  executability: Executability;
  /** can funds come back to the sender if the destination leg fails */
  refundable: boolean | null;
  /** not refundable, but never lost either: if the destination leg stalls, the funds stay claimable there (e.g. a CCTP burn awaiting its mint) */
  recoverable?: boolean;
  /** single transaction that either fully succeeds or fully reverts */
  atomic: boolean;
  /** opaque provider payload needed to build the transaction later; never shown, never trusted */
  raw?: unknown;
}

/** One fee line of a route card: what the provider reported, valued at the caller's price reference when there is one. */
export interface RouteCardFee { kind: FeeKind; asset: AssetRef; amount: bigint; estimated: boolean; includedInOutput: boolean; usd: number | null }
/**
 * The normalized route card (v11): the same object for every route of a quote response, whatever the provider.
 * Rule: REAL VALUES ONLY. A figure the provider does not give is `null`; nothing is estimated silently (card.ts).
 */
export interface RouteCard {
  routeId: string; providers: string[];
  /** stable fingerprint of what the route promises (pair, amount in, tolerance, amounts out); sent back when the route is prepared */
  fingerprint: string;
  /** amount sent, estimated amount received, minimum received after the tolerance — base units */
  amountIn: bigint; estimatedOut: bigint; minimumOut: bigint;
  /** network fees (native coins) the providers reported, with their USD total; null = none reported */
  networkFee: { items: RouteCardFee[]; usd: number | null; estimated: boolean; includedInOutput: boolean } | null;
  /** protocol / provider / bridge / affiliate fees reported, USD total and basis points of the amount sent; null = none reported */
  protocolFee: { items: RouteCardFee[]; usd: number | null; bps: number | null; includedInOutput: boolean } | null;
  /** the tolerance the quote was asked with */
  toleranceBps: number;
  /** cost of the estimated output against the amount sent at the reference price, basis points; null without a price for both sides */
  effectiveSlippageBps: number | null;
  /** provider's own estimate; null when it gives none */
  etaSeconds: number | null;
  riskLevel: RiskLevel; /** risk flag codes */ riskFlags: string[];
  steps: { kind: StepKind; /** where the step starts and ends */ network: string; toNetwork: string; provider: string; /** `step_<kind>`: the UI's sentence for it */ descriptionCode: string }[];
  /** unix ms: when the (oldest leg of the) quote was received, and when it must no longer be used */
  quotedAt: number; expiresAt: number;
  /** can the wallet execute this route itself, through which executor, and if not, why (code) */
  executable: boolean; executor: string | null; reasonCode: string | null;
}

export interface ProviderCapabilities {
  /** network ids (from the wallet registry) this provider can act on */
  networks: string[];
  crossChain: boolean;
  /** true when the provider needs an API key that is not configured: it is skipped and reported as such */
  needsKey: boolean; configured: boolean;
  /** steps this provider can produce */
  kinds: StepKind[];
  docs: string;
}

export interface ProviderContext {
  /** abort when the caller's deadline budget is exhausted */
  signal: AbortSignal;
  /** schema-validating HTTP helper with keep-alive; adapters must not call fetch directly */
  http: HttpClient;
  now: () => number;
}
export interface HttpClient {
  getJson(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<unknown>;
  postJson(url: string, body: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<unknown>;
}

/** What a provider adapter must implement. Unsupported behaviour is omitted, never faked. */
export interface SwapProvider {
  id: string; name: string;
  /** provider-specific runtime limits (rate, timeout) that override the defaults, e.g. a keyless tier's quota */
  policy?: { timeoutMs?: number; ratePerSec?: number; burst?: number;
    /** tight request quota: only asked for direct cross-chain requests, never for the legs of a composed route or same-chain pairs */
    scarce?: boolean };
  capabilities(): ProviderCapabilities;
  /** cheap, local pre-filter (no network): can this provider possibly serve the pair? */
  supportsPair(from: AssetRef, to: AssetRef): boolean;
  /** real quotes from the provider's API, strictly schema-validated. Empty array = no route. Throws on provider failure. */
  quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]>;
}

export class ProviderError extends Error {
  constructor(public provider: string, public code: 'timeout' | 'http' | 'schema' | 'rate_limited' | 'unavailable' | 'bad_response', message: string) { super(message); }
}
