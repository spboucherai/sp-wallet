// HTTP client of the Hyperliquid adapter: POST /info and POST /exchange through an injectable fetch, with the documented IP rate
// limit accounted for locally so that the adapter refuses a request BEFORE the venue does.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
//   "REST requests share an aggregated weight limit of 1200 per minute."
//   exchange: 1 + floor(batch_length / 40) · info: 2 for l2Book, allMids, clearinghouseState, orderStatus,
//   spotClearinghouseState, exchangeStatus · 60 for userRole · 20 for every other documented info request ·
//   plus 1 per 20 items returned for recentTrades, historicalOrders, userFills, userFillsByTime, fundingHistory, userFunding …
//   and 1 per 60 items returned for candleSnapshot.
import { VenueError } from './error.ts';
import type { HlNetwork } from './signing.ts';

export const HL_API: Record<HlNetwork, string> = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' };
export const HL_WS: Record<HlNetwork, string> = { mainnet: 'wss://api.hyperliquid.xyz/ws', testnet: 'wss://api.hyperliquid-testnet.xyz/ws' };

export const HL_WEIGHT_LIMIT_PER_MINUTE = 1200;
const WEIGHT_2 = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
const PER_20_ITEMS = new Set(['recentTrades', 'historicalOrders', 'userFills', 'userFillsByTime', 'fundingHistory', 'userFunding', 'nonUserFundingUpdates', 'twapHistory', 'userTwapSliceFills', 'userTwapSliceFillsByTime', 'delegatorHistory', 'delegatorRewards', 'validatorStats']);

/** base weight of an info request, known before it is sent */
export function hlInfoWeight(type: string): number { return WEIGHT_2.has(type) ? 2 : type === 'userRole' ? 60 : 20; }
/** additional weight charged on the answer's length */
export function hlInfoExtraWeight(type: string, items: number): number {
  if (type === 'candleSnapshot') return Math.floor(items / 60);
  return PER_20_ITEMS.has(type) ? Math.floor(items / 20) : 0;
}
/** weight of an exchange request: `1 + floor(batch_length / 40)` */
export function hlExchangeWeight(batchLength: number): number { return 1 + Math.floor(batchLength / 40); }

/** Sliding one-minute window of spent weight. Shared by every request of one adapter instance (one IP). */
export class HlWeightBudget {
  readonly limit: number;
  private readonly now: () => number;
  private spent: { at: number; weight: number }[] = [];
  constructor(limit = HL_WEIGHT_LIMIT_PER_MINUTE, now: () => number = Date.now) { this.limit = limit; this.now = now; }
  used(): number {
    const cut = this.now() - 60_000;
    while (this.spent.length && this.spent[0]!.at <= cut) this.spent.shift();
    return this.spent.reduce((n, s) => n + s.weight, 0);
  }
  /** ms until `weight` fits again (0 = it fits now) */
  retryAfterMs(weight: number): number {
    let used = this.used();
    if (used + weight <= this.limit) return 0;
    for (const s of this.spent) { used -= s.weight; if (used + weight <= this.limit) return Math.max(1, s.at + 60_000 - this.now()); }
    return 60_000;
  }
  /** reserves `weight` or throws `rate_limited` without sending anything */
  take(weight: number, what: string): void {
    const wait = this.retryAfterMs(weight);
    if (wait > 0) throw new VenueError('hyperliquid', 'rate_limited', `local weight budget exhausted (${this.used()}/${this.limit} per minute) before ${what}`, { retryAfterMs: wait, local: true });
    this.spent.push({ at: this.now(), weight });
  }
  /** charges weight that is only known afterwards (per-item surcharge); never throws */
  charge(weight: number): void { if (weight > 0) this.spent.push({ at: this.now(), weight }); }
  /** the venue said 429: consider the window full */
  exhaust(): void { this.charge(Math.max(0, this.limit - this.used())); }
}

export interface HlHttpOptions { network: HlNetwork; fetch?: typeof fetch; now?: () => number; timeoutMs?: number; budget?: HlWeightBudget; maxBytes?: number; baseUrl?: string }

export interface HlHttp {
  readonly network: HlNetwork; readonly baseUrl: string; readonly budget: HlWeightBudget;
  /** POST /info — returns the parsed JSON body (not yet validated) */
  info(body: { type: string } & Record<string, unknown>): Promise<unknown>;
  /** POST /exchange — returns the parsed JSON body (not yet validated) */
  exchange(body: Record<string, unknown>, batchLength: number): Promise<unknown>;
}

const err = (code: ConstructorParameters<typeof VenueError>[1], message: string, detail: Record<string, unknown> = {}) => new VenueError('hyperliquid', code, message, detail);

export function createHlHttp(o: HlHttpOptions): HlHttp {
  const fetchImpl = o.fetch ?? fetch, now = o.now ?? Date.now, timeoutMs = o.timeoutMs ?? 10_000, maxBytes = o.maxBytes ?? 8_000_000;
  const baseUrl = o.baseUrl ?? HL_API[o.network], budget = o.budget ?? new HlWeightBudget(HL_WEIGHT_LIMIT_PER_MINUTE, now);

  const post = async (path: '/info' | '/exchange', body: unknown, what: string): Promise<unknown> => {
    let r: Response;
    try {
      r = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = (e as Error).name;
      throw err('unavailable', `${what}: ${name === 'AbortError' || name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : `network error (${(e as Error).message?.slice(0, 120) ?? name})`}`, { timeout: name === 'AbortError' || name === 'TimeoutError' });
    }
    let text: string;
    try { text = await r.text(); } catch (e) { throw err('unavailable', `${what}: answer interrupted (${(e as Error).message?.slice(0, 120)})`); }
    if (r.status === 429) { budget.exhaust(); throw err('rate_limited', `${what}: venue rate limit (HTTP 429)`, { retryAfterMs: 60_000, body: text.slice(0, 200) }); }
    if (r.status >= 500) throw err('unavailable', `${what}: HTTP ${r.status} ${text.slice(0, 120)}`, { status: r.status });
    // 422 = "Failed to deserialize the JSON body into the target type": our request was malformed for the venue
    if (!r.ok) throw err(path === '/exchange' ? 'rejected' : 'bad_answer', `${what}: HTTP ${r.status} ${text.slice(0, 160)}`, { status: r.status, body: text.slice(0, 400) });
    if (text.length > maxBytes) throw err('bad_answer', `${what}: answer too large (${text.length} bytes)`);
    try { return JSON.parse(text); } catch { throw err('bad_answer', `${what}: answer is not JSON`, { body: text.slice(0, 200) }); }
  };

  return {
    network: o.network, baseUrl, budget,
    async info(body) {
      budget.take(hlInfoWeight(body.type), `info ${body.type}`);
      const out = await post('/info', body, `info ${body.type}`);
      if (Array.isArray(out)) budget.charge(hlInfoExtraWeight(body.type, out.length));
      return out;
    },
    async exchange(body, batchLength) {
      budget.take(hlExchangeWeight(batchLength), 'exchange');
      return post('/exchange', body, 'exchange');
    },
  };
}
