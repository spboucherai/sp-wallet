// SPWallet — client of the SP Trading API (docs/openapi/trading-v1.json). Zero dependency: global `fetch`.
//
// Retries (see docs/sdk/typescript.md):
//   GET            retried on a network error, a timeout, 429 (after Retry-After / RateLimit-Reset) and 502/503/504.
//   POST / DELETE  carry an Idempotency-Key — generated ONCE per logical call when the caller gives none — and the body is
//                  serialized ONCE: every retry sends the same key and the same bytes, so the server runs the operation at
//                  most once. They are retried for that reason only. When no trustworthy answer was obtained the call
//                  throws OutcomeUnknown (with the key): it is not a failure.
import { ConfigurationError, errorFromResponse, NetworkError, OutcomeUnknown, redactSecrets, ServerError, SPWalletError, TimeoutError, WaitTimeout } from './errors.ts';
import type * as T from './generated/openapi.ts';
import { canonicalJson, decimalString, IDEMPOTENCY_KEY_RE, isTerminalOrder, newIdempotencyKey, sizeFromNotional } from './util.ts';
import { USER_AGENT } from './version.ts';

export const DEFAULT_BASE_URL = 'https://wallet.spboucher.ai';
const PREFIX = '/api/v1/trading';
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export interface SPWalletOptions {
  /** `spw_live_…`; default: environment variable SP_WALLET_API_KEY */
  apiKey?: string;
  /** default: environment variable SP_WALLET_BASE_URL, else https://wallet.spboucher.ai */
  baseUrl?: string;
  /** per attempt, milliseconds (default 30 000) */
  timeoutMs?: number;
  /** retries after the first attempt (default 2) */
  maxRetries?: number;
  /** appended to `sp-wallet-typescript/<version>` */
  userAgent?: string;
  /** default: globalThis.fetch */
  fetch?: typeof fetch;
  /** allow http:// for a host that is not localhost (never do this with a real key) */
  allowInsecureHttp?: boolean;
  /** send `X-SPW-Timestamp` with mutating calls (the server refuses a call more than 300 s from its clock); default false */
  sendTimestamp?: boolean;
  /** longest wait the SDK accepts before a retry, milliseconds (default 30 000); a 429 asking for more is thrown at once */
  maxRetryDelayMs?: number;
  /** tests */
  sleep?: (ms: number) => Promise<void>;
  /** tests: [0, 1) */
  random?: () => number;
}
export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}
export interface WriteOptions extends RequestOptions {
  /** Idempotency-Key of this logical call (8–100 chars: letters, digits, . _ : -). Default: a new UUIDv4. Pass the key of a
   *  previous attempt to resume it: the server returns the stored answer, or runs the operation once. */
  idempotencyKey?: string;
}
export interface RateLimitInfo { limit: number | null; remaining: number | null; resetSeconds: number | null }
/** facts about the HTTP exchange behind a result — `responseMeta(result)` */
export interface ResponseMeta {
  status: number;
  requestId: string | null;
  /** the Idempotency-Key that was sent (mutating calls) */
  idempotencyKey: string | null;
  /** true when the server answered from its idempotency store (`Idempotent-Replay: true`) */
  idempotentReplay: boolean;
  rateLimit: RateLimitInfo;
  /** HTTP attempts made (1 = no retry) */
  attempts: number;
}
const META = new WeakMap<object, ResponseMeta>();
/** status, request id, idempotency key, rate-limit headers and number of attempts of the call that produced `result` */
export const responseMeta = (result: object): ResponseMeta | undefined => META.get(result);

/** answer of a write operation: the OpenAPI document does not declare a success schema for them yet */
export type WriteResult = Record<string, unknown>;

type OrderBody = T.PlaceOrderBody;
/** An order. `instrument` is `venue:symbol`; `exchange` + `symbol` is the same thing in two parts. Size the order with
 *  `size` (base units, a decimal string) or with `notionalUsdc` (the SDK reads the market and computes the size, rounded
 *  down to the lot size). `mode` defaults to `paper`. */
export interface OrderInput extends Omit<OrderBody, 'mode' | 'instrument' | 'size'> {
  mode?: OrderBody['mode'];
  instrument?: string;
  exchange?: string;
  symbol?: string;
  size?: string;
  /** client-side convenience — not a field of the API: size = floor(notional / mark price, lot size) */
  notionalUsdc?: string | number;
}
export interface WaitOptions extends RequestOptions {
  /** total time, milliseconds (default 60 000) */
  waitTimeoutMs?: number;
  /** between two reads, milliseconds (default 1 000) */
  pollIntervalMs?: number;
  /** stop condition; default: the order is final (FILLED, CANCELLED, REJECTED, FAILED — never UNKNOWN) */
  until?: (order: T.GetOrderResponse['order']) => boolean;
}

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;
const num = (v: string | null): number | null => { if (v === null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function retryAfterSeconds(h: Headers, now: number): number | null {
  const ra = h.get('retry-after');
  if (ra !== null) {
    const n = num(ra);
    if (n !== null) return Math.max(0, n);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, (d - now) / 1000);
  }
  return num(h.get('ratelimit-reset'));
}
const redactDeep = (v: unknown, safe: (s: string) => string): unknown =>
  typeof v === 'string' ? safe(v) : Array.isArray(v) ? v.map((x) => redactDeep(x, safe)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, safe)])) : v;
const seg = (v: string, what: string): string => { if (typeof v !== 'string' || v === '') throw new ConfigurationError(`${what} is required`); return encodeURIComponent(v); };

export class SPWallet {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly userAgent: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #sendTimestamp: boolean;
  readonly #maxRetryDelayMs: number;

  constructor(o: SPWalletOptions = {}) {
    const key = o.apiKey ?? env('SP_WALLET_API_KEY');
    if (!key || typeof key !== 'string') throw new ConfigurationError('no API key: pass { apiKey } or set SP_WALLET_API_KEY');
    if (/[\s\r\n]/.test(key)) throw new ConfigurationError('the API key contains whitespace');
    this.#apiKey = key;
    const base = (o.baseUrl ?? env('SP_WALLET_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    let u: URL;
    try { u = new URL(base); } catch { throw new ConfigurationError('baseUrl is not a URL'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || o.allowInsecureHttp))) throw new ConfigurationError('baseUrl must be https:// (http:// is accepted for localhost only): the API key would travel in clear');
    if (u.username || u.password) throw new ConfigurationError('baseUrl must not carry credentials');
    this.baseUrl = base;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxRetries = o.maxRetries ?? 2;
    if (!(this.timeoutMs > 0) || !Number.isInteger(this.maxRetries) || this.maxRetries < 0) throw new ConfigurationError('timeoutMs must be positive and maxRetries a non-negative integer');
    this.userAgent = o.userAgent ? `${USER_AGENT} ${o.userAgent}` : USER_AGENT;
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new ConfigurationError('no fetch implementation: Node >= 20 or pass { fetch }');
    this.#fetch = o.fetch ? f : f.bind(globalThis);
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = o.random ?? Math.random;
    this.#sendTimestamp = o.sendTimestamp ?? false;
    this.#maxRetryDelayMs = o.maxRetryDelayMs ?? 30_000;
  }
  /** never shows the key */
  toJSON(): Record<string, unknown> { return { baseUrl: this.baseUrl, apiKey: '<redacted>', timeoutMs: this.timeoutMs, maxRetries: this.maxRetries, userAgent: this.userAgent }; }
  toString(): string { return `SPWallet(${this.baseUrl}, apiKey=<redacted>)`; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return this.toString(); }

  // ============================================================================================================== markets
  /** GET /markets — instruments across venues and the spot market-data symbols. Not paginated: `total` and `truncated` tell when `limit` cut the list. */
  listMarkets(query: T.ListMarketsQuery = {}, o?: RequestOptions): Promise<T.ListMarketsResponse> { return this.#get('/markets', query, o); }
  /** GET /markets/{symbol} — `venue:symbol`; a bare symbol that exists on several venues throws AmbiguousSymbol (with `candidates`) */
  getMarket(symbol: string, o?: RequestOptions): Promise<T.GetMarketResponse> { return this.#get(`/markets/${seg(symbol, 'symbol')}`, undefined, o); }
  /** GET /markets/{symbol}/orderbook — levels are [price, size] decimal strings */
  getOrderbook(symbol: string, query: T.GetOrderbookQuery = {}, o?: RequestOptions): Promise<T.GetOrderbookResponse> { return this.#get(`/markets/${seg(symbol, 'symbol')}/orderbook`, query, o); }
  /** GET /markets/{symbol}/candles — closed bars */
  getCandles(symbol: string, query: T.GetCandlesQuery = {}, o?: RequestOptions): Promise<T.GetCandlesResponse> { return this.#get(`/markets/${seg(symbol, 'symbol')}/candles`, query, o); }

  // ============================================================================================================== portfolio
  /** GET /portfolio — wallet value and derivative accounts; paper and live are never added together */
  getPortfolio(o?: RequestOptions): Promise<T.GetPortfolioResponse> { return this.#get('/portfolio', undefined, o); }
  /** GET /balances — on-chain balances (amounts are integer strings in the asset's smallest unit; `display` is the decimal string) */
  getBalances(query: T.GetBalancesQuery = {}, o?: RequestOptions): Promise<T.GetBalancesResponse> { return this.#get('/balances', query, o); }
  /** GET /positions — open positions, each with its `mode` */
  getPositions(query: T.ListPositionsQuery = {}, o?: RequestOptions): Promise<T.ListPositionsResponse> { return this.#get('/positions', query, o); }
  /** GET /activity — wallet activity and fills, newest first */
  getActivity(query: T.GetActivityQuery = {}, o?: RequestOptions): Promise<T.GetActivityResponse> { return this.#get('/activity', query, o); }
  /** GET /risk — kill switch, signer limits, capability locks, account policies */
  getRisk(o?: RequestOptions): Promise<T.GetRiskResponse> { return this.#get('/risk', undefined, o); }

  // ============================================================================================================== orders
  /** GET /orders — newest first; `open: true` keeps the orders that are not final */
  listOrders(query: Omit<T.ListOrdersQuery, 'open'> & { open?: boolean | 'true' | 'false' } = {}, o?: RequestOptions): Promise<T.ListOrdersResponse> {
    return this.#get('/orders', { ...query, open: query.open === undefined ? undefined : String(query.open) }, o);
  }
  /** GET /orders/{id} — one order and its fills */
  getOrder(id: string, o?: RequestOptions): Promise<T.GetOrderResponse> { return this.#get(`/orders/${seg(id, 'order id')}`, undefined, o); }
  /** POST /orders/preview — risk check and estimate; places nothing. Scope `orders:prepare`. */
  async previewOrder(order: OrderInput, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', '/orders/preview', await this.#orderBody(order, o), o); }
  /** POST /orders — place an order. Scope `orders:execute` AND a key bound to an owner-approved trading mandate (else MandateRequired). */
  async createOrder(order: OrderInput, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', '/orders', await this.#orderBody(order, o), o); }
  /** DELETE /orders/{id} — cancel an order */
  cancelOrder(id: string, o?: WriteOptions): Promise<WriteResult> { return this.#write('DELETE', `/orders/${seg(id, 'order id')}`, undefined, o); }
  /** Reads the order until it is final (or `until` says so). Throws WaitTimeout — which is not an order failure — when
   *  `waitTimeoutMs` elapses first. UNKNOWN is not final: the wait continues. */
  async waitForOrder(id: string, o: WaitOptions = {}): Promise<T.GetOrderResponse> {
    const total = o.waitTimeoutMs ?? 60_000, every = o.pollIntervalMs ?? 1_000, started = Date.now(), done = o.until ?? isTerminalOrder;
    let last: T.GetOrderResponse | null = null;
    for (;;) {
      last = await this.getOrder(id, o);
      if (done(last.order)) return last;
      const left = total - (Date.now() - started);
      if (left <= 0) throw new WaitTimeout(`order ${id} is not final after ${total} ms (last status: ${String(last.order.status)}); it has not failed — keep reading it`, last);
      await this.#sleep(Math.min(every, left));
    }
  }

  // ============================================================================================================== positions
  /** POST /positions/{id}/close */
  closePosition(id: string, body: T.ClosePositionBody = {}, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/positions/${seg(id, 'position id')}/close`, body, o); }
  /** POST /positions/{id}/reduce — `fraction` in (0, 1], a decimal string */
  reducePosition(id: string, body: T.ReducePositionBody, o?: WriteOptions): Promise<WriteResult> {
    return this.#write('POST', `/positions/${seg(id, 'position id')}/reduce`, { ...body, fraction: decimalString(body.fraction, 'fraction') }, o);
  }

  // ============================================================================================================== strategies
  /** GET /strategies — strategy library and the versions pinned to agents */
  listStrategies(query: T.ListStrategiesQuery = {}, o?: RequestOptions): Promise<T.ListStrategiesResponse> { return this.#get('/strategies', query, o); }
  /** POST /strategies — register a strategy version */
  createStrategy(body: T.CreateStrategyBody, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', '/strategies', body, o); }
  /** POST /strategies/{id}/backtest */
  backtestStrategy(id: string, body: T.BacktestStrategyBody = {}, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/backtest`, body, o); }
  /** POST /strategies/{id}/start */
  startStrategy(id: string, body: T.StartStrategyBody, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/start`, body, o); }
  /** POST /strategies/{id}/stop */
  stopStrategy(id: string, body: T.StopStrategyBody = {}, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/stop`, body, o); }

  // ============================================================================================================== agents
  /** GET /agents */
  listAgents(o?: RequestOptions): Promise<T.ListAgentsResponse> { return this.#get('/agents', undefined, o); }
  /** POST /agents */
  createAgent(body: T.CreateAgentBody, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', '/agents', body, o); }
  /** POST /agents/{id}/start */
  startAgent(id: string, body: T.StartAgentBody, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/start`, body, o); }
  /** POST /agents/{id}/stop */
  stopAgent(id: string, body: T.StopAgentBody = {}, o?: WriteOptions): Promise<WriteResult> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/stop`, body, o); }

  // ============================================================================================================== meta
  /** GET /openapi.json — the OpenAPI 3.1 document served by the wallet */
  openapi(o?: RequestOptions): Promise<T.GetOpenApiResponse> { return this.#get('/openapi.json', undefined, o); }

  // ============================================================================================================== internals
  async #orderBody(i: OrderInput, o?: WriteOptions): Promise<OrderBody> {
    const { exchange, symbol, notionalUsdc, instrument: given, size: givenSize, mode, ...rest } = i;
    if (given !== undefined && (exchange !== undefined || symbol !== undefined)) throw new ConfigurationError('give `instrument` or `exchange` + `symbol`, not both');
    const instrument = given ?? (exchange !== undefined && symbol !== undefined ? `${exchange}:${symbol}` : symbol);
    if (!instrument) throw new ConfigurationError('an order needs `instrument` ("venue:symbol") or `exchange` + `symbol`');
    if ((givenSize === undefined) === (notionalUsdc === undefined)) throw new ConfigurationError('an order needs exactly one of `size` (base units) and `notionalUsdc`');
    for (const k of ['price', 'triggerPrice'] as const) if (rest[k] !== undefined) decimalString(rest[k], k);
    let size: string;
    if (givenSize !== undefined) {
      if (typeof givenSize !== 'string') throw new ConfigurationError('size: pass a decimal string (e.g. "0.01"), not a float');
      size = decimalString(givenSize, 'size');
    } else {
      const notional = decimalString(notionalUsdc!, 'notionalUsdc');
      const m = await this.getMarket(instrument, o);
      const lot = (m.instrument as { lotSize?: unknown } | null)?.lotSize;
      if (m.market.stale || !m.market.mark) throw new ConfigurationError(`cannot size ${instrument} from a notional: the market has no fresh mark price (stale: ${String(m.market.stale)}); pass \`size\``);
      size = sizeFromNotional(notional, rest.price ?? m.market.mark, typeof lot === 'string' && lot ? lot : undefined);
      if (!/[1-9]/.test(size)) throw new ConfigurationError(`a notional of ${notional} is below one lot of ${instrument}`);
    }
    return { ...rest, mode: mode ?? 'paper', instrument, size };
  }
  #get<R extends object>(path: string, query: object | undefined, o?: RequestOptions): Promise<R> { return this.#request<R>('GET', path, query, undefined, o); }
  #write(method: 'POST' | 'DELETE', path: string, body: unknown, o?: WriteOptions): Promise<WriteResult> { return this.#request<WriteResult>(method, path, undefined, body, o); }

  #backoffMs(attempt: number): number { const cap = Math.min(8_000, 500 * 2 ** attempt); return Math.min(this.#maxRetryDelayMs, cap / 2 + this.#random() * (cap / 2)); }

  async #request<R extends object>(method: 'GET' | 'POST' | 'DELETE', path: string, query: object | undefined, body: unknown, o: WriteOptions = {}): Promise<R> {
    const mutating = method !== 'GET';
    const key = mutating ? (o.idempotencyKey ?? newIdempotencyKey()) : null;
    if (key !== null && !IDEMPOTENCY_KEY_RE.test(key)) throw new ConfigurationError('idempotencyKey must be 8 to 100 characters: letters, digits, . _ : -');
    const payload = body === undefined ? undefined : canonicalJson(body); // serialized once: the same bytes on every attempt
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) qs.set(k, String(v));
    const full = PREFIX + path, url = `${this.baseUrl}${full}${qs.size ? `?${qs}` : ''}`;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs, maxRetries = o.maxRetries ?? this.maxRetries;
    const safe = (s: string): string => redactSecrets(s, this.#apiKey);
    /** a mutating attempt ended without a definite answer: from then on only an answer computed under the key is trusted */
    let ambiguous = false;
    const unknown = (reason: string, x: { status?: number | null; requestId?: string | null; cause?: unknown } = {}): OutcomeUnknown => new OutcomeUnknown({ idempotencyKey: key!, method, path: full, reason, ...x });

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json', 'user-agent': this.userAgent };
      if (payload !== undefined) headers['content-type'] = 'application/json';
      if (key !== null) { headers['idempotency-key'] = key; if (this.#sendTimestamp) headers['x-spw-timestamp'] = String(Math.floor(Date.now() / 1000)); }
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
      const onAbort = (): void => ctl.abort();
      if (o.signal) { if (o.signal.aborted) ctl.abort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
      let res: Response, text: string;
      try {
        res = await this.#fetch(url, { method, headers, body: payload, signal: ctl.signal, redirect: 'error', credentials: 'omit' });
        text = await res.text();
      } catch (e) {
        const aborted = o.signal?.aborted === true && !timedOut;
        const why = timedOut ? `no answer within ${timeoutMs} ms` : aborted ? 'the call was aborted' : `network error: ${safe((e as Error)?.message ?? String(e))}`;
        if (mutating) ambiguous = true;
        if (!aborted && attempt < maxRetries) { await this.#sleep(this.#backoffMs(attempt)); continue; }
        // the cause is a copy whose text went through the redaction: the transport's own error object is not kept
        const cause = Object.assign(new Error(safe((e as Error)?.message ?? String(e))), { name: (e as Error)?.name ?? 'Error' });
        if (mutating) throw unknown(why, { cause });
        throw new (timedOut ? TimeoutError : NetworkError)(`${method} ${full}: ${why}`, { code: timedOut ? 'timeout' : aborted ? 'aborted' : 'network_error', status: null, cause });
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }

      const requestId = res.headers.get('x-request-id');
      let json: unknown, parsed = true;
      try { json = text === '' ? null : JSON.parse(text); } catch { parsed = false; }
      if (res.ok) {
        if (!parsed || json === null || typeof json !== 'object') {
          if (mutating) throw unknown(`HTTP ${res.status} with a body that is not a JSON object`, { status: res.status, requestId });
          throw new ServerError(`${method} ${full}: HTTP ${res.status} with a body that is not a JSON object`, { code: 'invalid_response', status: res.status, requestId });
        }
        META.set(json, { status: res.status, requestId, idempotencyKey: key, idempotentReplay: res.headers.get('idempotent-replay') === 'true', attempts: attempt + 1,
          rateLimit: { limit: num(res.headers.get('ratelimit-limit')), remaining: num(res.headers.get('ratelimit-remaining')), resetSeconds: num(res.headers.get('ratelimit-reset')) } });
        return json as R;
      }

      const code = parsed && json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : '';
      const structured = code !== '' && typeof (json as { statusCode?: unknown }).statusCode !== 'number'; // an answer of the API itself, not of a proxy
      const after = res.status === 429 || res.status === 503 ? retryAfterSeconds(res.headers, Date.now()) : null;
      const inProgress = mutating && res.status === 409 && code === 'idempotency_in_progress';
      // the first request with this key is still running, or the answer does not come from the API: nothing definite is known
      if (mutating && (inProgress || (res.status >= 500 && !(structured && (res.status === 501 || res.status === 503))))) ambiguous = true;
      if ((RETRY_STATUS.has(res.status) || inProgress) && attempt < maxRetries) {
        const wait = after !== null ? after * 1000 : this.#backoffMs(attempt);
        if (wait <= this.#maxRetryDelayMs) { await this.#sleep(wait); continue; }
      }
      const err = errorFromResponse(res.status, parsed ? redactDeep(json, safe) : safe(text.slice(0, 500)), { requestId, idempotencyKey: key, retryAfterSeconds: after });
      // 401, 403 and 429 are decided before the server looks at the Idempotency-Key, and a 5xx says nothing either: after an
      // ambiguous attempt they do not tell whether that attempt was executed
      if (mutating && ambiguous && (inProgress || res.status === 401 || res.status === 403 || res.status === 429 || (res.status >= 500 && res.status !== 501)))
        throw unknown(inProgress ? 'the first request with this key is still being processed' : `HTTP ${res.status}${code ? ` ${code}` : ''} after an attempt without an answer`, { status: res.status, requestId, cause: err });
      throw err;
    }
  }
}
export { SPWalletError };
