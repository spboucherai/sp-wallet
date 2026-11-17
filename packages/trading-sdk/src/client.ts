// SPWallet — client of the SP Trading API (docs/openapi/trading-v1.json). Zero dependency: global `fetch`.
//
// Retries (see docs/sdk/typescript.md):
//   GET            retried on a network error, a timeout, 429 (after Retry-After / RateLimit-Reset) and 502/503/504.
//   POST / DELETE  carry an Idempotency-Key — generated ONCE per logical call when the caller gives none — and the body is
//                  serialized ONCE: every retry sends the same key and the same bytes, so the server runs the operation at
//                  most once. They are retried for that reason only. When no trustworthy answer was obtained the call
//                  throws OutcomeUnknown (with the key): it is not a failure.
//   previewOrder, engageKillSwitch
//                  are POSTs the contract declares WITHOUT an Idempotency-Key: a preview creates nothing, and engaging a
//                  switch that is on changes nothing. They are safe to repeat, so they are retried like a GET and fail
//                  with the ordinary typed errors (never OutcomeUnknown).
import { ConfigurationError, errorFromResponse, NetworkError, OutcomeUnknown, redactSecrets, ServerError, SPWalletError, TimeoutError, WaitTimeout } from './errors.ts';
import type * as T from './generated/openapi.ts';
import { canonicalJson, decimalString, IDEMPOTENCY_KEY_RE, isTerminalOrder, newIdempotencyKey } from './util.ts';
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

/** @deprecated every operation of the contract has a typed answer now; kept so that code naming the type still compiles */
export type WriteResult = Record<string, unknown>;
/** research = analysis and backtests, never an order; paper = explicit simulation; live = a real venue under an owner-approved mandate */
export type AgentMode = 'research' | 'paper' | 'live';
/** a page of one agent's history, in ONE mode: `mode` is required — an answer never carries two modes (`all` is refused by the API) */
export interface AgentPageQuery { mode: AgentMode; limit?: number; /** unix ms: rows strictly before it */ before?: number }
/** POST /orders/preview: the canonical order, every check, the refusals it would meet, an estimate */
export type OrderPreview = T.PreviewOrderResponse;
/** POST /orders, /positions/{id}/close, /positions/{id}/reduce: the order, whether it is a replay, and the owner approval it waits for */
export type PlacedOrder = T.PlaceOrderResponse;
/** DELETE /orders/{id} */
export type CancelledOrder = T.CancelOrderResponse;
/** POST /commands — a discriminated union: `kind` is `query`, `control` or `order`; for an order, `executed` false means a dry run
 *  (`order` is then the CANONICAL order) and true an executed command (`order` is the placed order, `canonical` its canonical form).
 *  Narrow before reading: `if (r.kind === 'order' && r.executed) r.order.status`. */
export type CommandResult = T.RunCommandResponse;
/** POST /risk/kill-switch */
export type KillSwitchResult = T.EngageKillSwitchResponse;
export type ActivityItem = T.GetActivityResponse['items'][number];

type OrderBody = T.PlaceOrderBody;
/** An order. `instrument` is `venue:symbol`; `exchange` + `symbol` is the same thing in two parts. Size it with exactly one
 *  of `size` (base units) and `notional` (quote currency: the SERVER converts it at the order's own price, else at the mark
 *  it reads, rounded down to the lot — the answer carries the size used). Both are decimal strings. `mode` defaults to `paper`. */
export interface OrderInput extends Omit<OrderBody, 'mode' | 'instrument' | 'size' | 'notional'> {
  mode?: OrderBody['mode'];
  instrument?: string;
  exchange?: string;
  symbol?: string;
  size?: string;
  /** a decimal string, or a whole number of quote units */
  notional?: string | number;
  /** the same field under the name of the quick-start examples: sent as `notional`, nothing is computed here */
  notionalUsdc?: string | number;
}
export interface CommandOptions {
  /** default `paper` */
  mode?: 'paper' | 'live';
  /** paper account or venue account; required when the wallet has several on the venue */
  accountId?: string;
  /** true: answer what the command resolves to and do nothing */
  dryRun?: boolean;
}
export interface PageOptions extends RequestOptions {
  /** stop after this many items in total (default: no bound — the whole list) */
  maxItems?: number;
}
export interface WaitOptions extends RequestOptions {
  /** total time, milliseconds (default 60 000) */
  waitTimeoutMs?: number;
  /** between two reads, milliseconds (default 1 000) */
  pollIntervalMs?: number;
  /** stop condition; default: the order is final (FILLED, CANCELLED, REJECTED, FAILED — never UNKNOWN) */
  until?: (order: T.Order) => boolean;
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
const AGENT_MODES = ['research', 'paper', 'live'];
/** the per-agent reads are ONE mode per call: the mode is required here, although the API would fall back on the agent's current one */
function agentQuery<Q extends { mode: AgentMode }>(q: Q): Q {
  if (!q || !AGENT_MODES.includes(q.mode)) throw new ConfigurationError('`mode` is required: "research", "paper" or "live" — one mode per call, an answer never mixes two');
  return q;
}
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
  /** GET /markets/compare — the estimated cost of one position on every venue that lists the underlying. Estimates, never a recommendation. */
  compareMarkets(query: T.CompareMarketsQuery = {}, o?: RequestOptions): Promise<T.CompareMarketsResponse> { return this.#get('/markets/compare', query, o); }
  /** GET /private-markets — synthetic contracts on private companies, venue by venue. Display only: none is tradable. */
  listPrivateMarkets(query: Omit<T.ListPrivateMarketsQuery, 'delisted'> & { delisted?: boolean | 'true' | 'false' } = {}, o?: RequestOptions): Promise<T.ListPrivateMarketsResponse> {
    return this.#get('/private-markets', { ...query, delisted: query.delisted === undefined ? undefined : String(query.delisted) }, o);
  }
  /** GET /private-markets/{id} — one contract (`venue:symbol`): definition, valuation breakdown, candles, top of book */
  getPrivateMarket(id: string, query: T.GetPrivateMarketQuery = {}, o?: RequestOptions): Promise<T.GetPrivateMarketResponse> { return this.#get(`/private-markets/${seg(id, 'private market id')}`, query, o); }
  /** GET /private-markets/companies/{slug} — every contract on one company, side by side (never merged) */
  getPrivateMarketCompany(slug: string, query: T.GetPrivateMarketCompanyQuery = {}, o?: RequestOptions): Promise<T.GetPrivateMarketCompanyResponse> {
    return this.#get(`/private-markets/companies/${seg(slug, 'company slug')}`, query, o);
  }

  // ============================================================================================================== portfolio
  /** GET /portfolio — wallet value and derivative accounts; paper and live are never added together */
  getPortfolio(o?: RequestOptions): Promise<T.GetPortfolioResponse> { return this.#get('/portfolio', undefined, o); }
  /** GET /balances — on-chain balances (amounts are integer strings in the asset's smallest unit; `display` is the decimal string) */
  getBalances(query: T.GetBalancesQuery = {}, o?: RequestOptions): Promise<T.GetBalancesResponse> { return this.#get('/balances', query, o); }
  /** GET /positions — open positions, each with its `mode` */
  getPositions(query: T.ListPositionsQuery = {}, o?: RequestOptions): Promise<T.ListPositionsResponse> { return this.#get('/positions', query, o); }
  /** GET /activity — one page of wallet activity and fills, newest first; `nextCursor` is the `cursor` of the next page */
  getActivity(query: T.GetActivityQuery = {}, o?: RequestOptions): Promise<T.GetActivityResponse> { return this.#get('/activity', query, o); }

  // ============================================================================================================== NFTs (read-only)
  // There is no NFT write in this API: transfers are the owner's (passkey), and no marketplace action exists in this version.
  /** GET /nfts — one page of the wallet's NFTs (what the chain confirmed as held). NFTs carry no value: `valuation.state` is `unavailable`. */
  listNfts(query: T.ListNftsQuery = {}, o?: RequestOptions): Promise<T.ListNftsResponse> { return this.#get('/nfts', query, o); }
  /** Every NFT of the wallet, page after page (`limit` is the page size; `maxItems` stops early). */
  async *iterNfts(query: Omit<T.ListNftsQuery, 'cursor'> = {}, o: PageOptions = {}): AsyncGenerator<T.ListNftsResponse['items'][number], void, undefined> {
    yield* this.#pages((cursor) => this.listNfts({ ...query, cursor }, o).then((r) => ({ items: r.items, nextCursor: r.nextCursor })), o.maxItems);
  }
  /** GET /nfts/item — one NFT of the wallet by its `key` (`family:network:asset-id`): on-chain facts, creator metadata and sources, kept apart */
  getNft(key: string, o?: RequestOptions): Promise<T.GetNftResponse> { return this.#get('/nfts/item', { key }, o); }
  /** GET /nfts/activity — on-chain events of one NFT of the wallet. A transfer is never a sale: `price` is set only when a payment of the same transaction was linked. */
  getNftActivity(query: T.GetNftActivityQuery, o?: RequestOptions): Promise<T.GetNftActivityResponse> { return this.#get('/nfts/activity', query, o); }
  /** GET /nfts/market — market data of ANY NFT named by its chain identifiers, ONE ROW PER SOURCE (asking price, best offer, last sale, collection floor;
   *  a source without its key answers `needs_key`). Amounts are exact base-unit strings in a currency identified by network + mint / contract. */
  getNftMarket(query: T.GetNftMarketQuery, o?: RequestOptions): Promise<T.GetNftMarketResponse> { return this.#get('/nfts/market', query, o); }
  /** GET /nfts/market/events — sales, listings and offers each market source reports; a `nextCursor` goes back as `cursor` with its `provider` */
  getNftMarketEvents(query: T.GetNftMarketEventsQuery, o?: RequestOptions): Promise<T.GetNftMarketEventsResponse> { return this.#get('/nfts/market/events', query, o); }
  /** Every activity item, newest first, page after page (`limit` is the page size). `for await (const item of client.iterateActivity())` */
  async *iterateActivity(query: Omit<T.GetActivityQuery, 'cursor'> = {}, o: PageOptions = {}): AsyncGenerator<ActivityItem, void, undefined> {
    yield* this.#pages((cursor) => this.getActivity({ ...query, cursor }, o).then((r) => ({ items: r.items, nextCursor: r.nextCursor })), o.maxItems);
  }
  /** GET /risk — kill switch, signer limits, capability locks, account policies */
  getRisk(o?: RequestOptions): Promise<T.GetRiskResponse> { return this.#get('/risk', undefined, o); }
  /** POST /risk/kill-switch — blocks every NEW risk, for every principal, venue and mode. Cancels and strictly reducing orders
   *  still pass. Needs `positions:manage`, no mandate. A key cannot release it: only the owner can, with the passkey. */
  engageKillSwitch(reason = '', o?: RequestOptions): Promise<KillSwitchResult> { return this.#request<KillSwitchResult>('POST', '/risk/kill-switch', undefined, { reason }, o, 'safe'); }

  // ============================================================================================================== orders
  /** GET /orders — one page, newest first; `open: true` keeps the orders that are not final; `nextCursor` is the `cursor` of the next page */
  listOrders(query: Omit<T.ListOrdersQuery, 'open'> & { open?: boolean | 'true' | 'false' } = {}, o?: RequestOptions): Promise<T.ListOrdersResponse> {
    return this.#get('/orders', { ...query, open: query.open === undefined ? undefined : String(query.open) }, o);
  }
  /** Every order, newest first, page after page (`limit` is the page size). `for await (const order of client.iterateOrders({ open: true }))` */
  async *iterateOrders(query: Omit<T.ListOrdersQuery, 'open' | 'cursor'> & { open?: boolean | 'true' | 'false' } = {}, o: PageOptions = {}): AsyncGenerator<T.Order, void, undefined> {
    yield* this.#pages((cursor) => this.listOrders({ ...query, cursor }, o).then((r) => ({ items: r.orders, nextCursor: r.nextCursor })), o.maxItems);
  }
  /** GET /orders/{id} — one order, its fills and its history */
  getOrder(id: string, o?: RequestOptions): Promise<T.GetOrderResponse> { return this.#get(`/orders/${seg(id, 'order id')}`, undefined, o); }
  /** POST /orders/preview — every check the order would meet and an estimate; creates nothing. Scope `orders:prepare`.
   *  What would refuse the order is in `refusals` (`wouldExecute` false), not an exception. Pass `idempotencyKey` to see the
   *  exact order (`order.clientOrderId`, `hash`) that `createOrder` with the same key would place. */
  async previewOrder(order: OrderInput, o?: WriteOptions): Promise<OrderPreview> { return this.#request<OrderPreview>('POST', '/orders/preview', undefined, this.#orderBody(order), o, 'safe'); }
  /** POST /orders — place an order. Scope `orders:execute` AND a key bound to an owner-approved trading mandate that covers it
   *  (MandateRequired / MandateDenied otherwise). Read `order.status`: paper orders are usually FILLED at once; a resting
   *  order is SUBMITTED; UNKNOWN is not a failure. A refusal after the order was created throws with `error.order`. */
  async createOrder(order: OrderInput, o?: WriteOptions): Promise<PlacedOrder> { return this.#write<PlacedOrder>('POST', '/orders', this.#orderBody(order), o); }
  /** DELETE /orders/{id} — cancel. A key cancels its own orders only; no mandate is needed and the kill switch never stops a cancel. */
  cancelOrder(id: string, o?: WriteOptions): Promise<CancelledOrder> { return this.#write<CancelledOrder>('DELETE', `/orders/${seg(id, 'order id')}`, undefined, o); }
  /** POST /commands — one line of the deterministic command grammar (`LONG BTC-PERP 500 x2`, `CLOSE BTC-PERP 50%`,
   *  `CANCEL ORDER <id>`, `SHOW POSITIONS`, `KILL`). `dryRun: true` answers what it resolves to and does nothing.
   *  A command the owner's defaults do not settle throws AmbiguousCommand (with `questions`): nothing was executed. */
  async runCommand(text: string, options: CommandOptions = {}, o?: WriteOptions): Promise<CommandResult> {
    if (typeof text !== 'string' || text.trim() === '') throw new ConfigurationError('a command is one non-empty line of text');
    return this.#write<CommandResult>('POST', '/commands', { text, mode: options.mode ?? 'paper', accountId: options.accountId, dryRun: options.dryRun ?? false }, o);
  }
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
  /** POST /positions/{id}/close — a strictly reduce-only market order on the whole position (`id` from getPositions). Passes the kill switch. */
  closePosition(id: string, body: T.ClosePositionBody = {}, o?: WriteOptions): Promise<PlacedOrder> { return this.#write<PlacedOrder>('POST', `/positions/${seg(id, 'position id')}/close`, body, o); }
  /** POST /positions/{id}/reduce — `fraction` in (0, 1], a decimal string */
  reducePosition(id: string, body: T.ReducePositionBody, o?: WriteOptions): Promise<PlacedOrder> {
    return this.#write<PlacedOrder>('POST', `/positions/${seg(id, 'position id')}/reduce`, { ...body, fraction: decimalString(body.fraction, 'fraction') }, o);
  }

  // ============================================================================================================== strategies
  /** GET /strategies — strategy library and the versions pinned to agents */
  listStrategies(query: T.ListStrategiesQuery = {}, o?: RequestOptions): Promise<T.ListStrategiesResponse> { return this.#get('/strategies', query, o); }
  /** POST /strategies — pin a library strategy version to ONE agent (`agentId` is required) and queue its backtest. Approves nothing. */
  createStrategy(body: T.CreateStrategyBody, o?: WriteOptions): Promise<T.CreateStrategyResponse> { return this.#write('POST', '/strategies', body, o); }
  /** POST /strategies/{id}/backtest — an asynchronous job: read it with `getJob(result.job.id)` or `waitForJob` */
  backtestStrategy(id: string, body: T.BacktestStrategyBody = {}, o?: WriteOptions): Promise<T.BacktestStrategyResponse> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/backtest`, body, o); }
  /** POST /strategies/{id}/start — starts the agent the version is pinned to, in `mode` */
  startStrategy(id: string, body: T.StartStrategyBody, o?: WriteOptions): Promise<T.StartStrategyResponse> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/start`, body, o); }
  /** POST /strategies/{id}/stop */
  stopStrategy(id: string, body: T.StopStrategyBody = {}, o?: WriteOptions): Promise<T.StopStrategyResponse> { return this.#write('POST', `/strategies/${seg(id, 'strategy id')}/stop`, body, o); }

  // ============================================================================================================== agents
  // Managing agents needs `agents:manage` and NO trading mandate on the key: research and paper sign nothing. Starting an agent
  // LIVE needs a mandate the OWNER approved for that agent with the passkey (409 `mandate_required` otherwise) — a key can never approve one.
  /** GET /agents */
  listAgents(o?: RequestOptions): Promise<T.ListAgentsResponse> { return this.#get('/agents', undefined, o); }
  /** GET /agents/templates — the built-in agents: family, engine, the modes each can run in */
  listAgentTemplates(o?: RequestOptions): Promise<T.ListAgentTemplatesResponse> { return this.#get('/agents/templates', undefined, o); }
  /** GET /agents/{id} — one agent: model, strategy, limits, mandate reference, backtest reports (labelled), worker state */
  getAgent(id: string, o?: RequestOptions): Promise<T.GetAgentResponse> { return this.#get(`/agents/${seg(id, 'agent id')}`, undefined, o); }
  /** GET /agents/{id}/signals — the signal history of one agent in ONE mode (`mode` is required) */
  listAgentSignals(id: string, query: AgentPageQuery, o?: RequestOptions): Promise<T.ListAgentSignalsResponse> { return this.#get(`/agents/${seg(id, 'agent id')}/signals`, agentQuery(query), o); }
  /** GET /agents/{id}/journal — decisions, orders, fills, errors, risk denials and state changes of one agent in ONE mode */
  listAgentJournal(id: string, query: AgentPageQuery, o?: RequestOptions): Promise<T.ListAgentJournalResponse> { return this.#get(`/agents/${seg(id, 'agent id')}/journal`, agentQuery(query), o); }
  /** GET /agents/{id}/orders — the orders of one agent in ONE mode, in the unified order states */
  listAgentOrders(id: string, query: AgentPageQuery & { open?: boolean }, o?: RequestOptions): Promise<T.ListAgentOrdersResponse> {
    return this.#get(`/agents/${seg(id, 'agent id')}/orders`, { ...agentQuery(query), open: query.open === undefined ? undefined : String(query.open) }, o);
  }
  /** GET /agents/{id}/performance — computed from the records of ONE mode; paper and live are never added; a backtest is never here */
  getAgentPerformance(id: string, query: { mode: AgentMode }, o?: RequestOptions): Promise<T.GetAgentPerformanceResponse> { return this.#get(`/agents/${seg(id, 'agent id')}/performance`, agentQuery(query), o); }
  /** GET /jobs/{id} — one agent job (a backtest, a wind-down): status and result */
  getJob(id: string, o?: RequestOptions): Promise<T.GetJobResponse> { return this.#get(`/jobs/${seg(id, 'job id')}`, undefined, o); }
  /** Reads a job until it is `done`, `failed` or `cancelled`. Throws WaitTimeout — which is not a job failure — when the time elapses first. */
  async waitForJob(id: string, o: Omit<WaitOptions, 'until'> = {}): Promise<T.GetJobResponse> {
    const total = o.waitTimeoutMs ?? 60_000, every = o.pollIntervalMs ?? 1_000, started = Date.now();
    for (;;) {
      const last = await this.getJob(id, o);
      if (['done', 'failed', 'cancelled'].includes(last.job.status)) return last;
      const left = total - (Date.now() - started);
      if (left <= 0) throw new WaitTimeout(`job ${id} is not finished after ${total} ms (last status: ${last.job.status}); it has not failed — keep reading it`, last);
      await this.#sleep(Math.min(every, left));
    }
  }
  /** POST /agents — from a `template` (see listAgentTemplates), or a perp agent (`kind: 'perp'` + `universe`). `mode` is `research`
   *  (default: created, not running) or `paper`; never `live`. Nothing is signed. */
  createAgent(body: T.CreateAgentBody, o?: WriteOptions): Promise<T.CreateAgentResponse> { return this.#write('POST', '/agents', body, o); }
  /** POST /agents/{id}/start — `mode`: research, paper or live (live only under an owner-approved mandate for this agent) */
  startAgent(id: string, body: T.StartAgentBody, o?: WriteOptions): Promise<T.StartAgentResponse> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/start`, body, o); }
  /** POST /agents/{id}/pause — no new exposure */
  pauseAgent(id: string, body: T.PauseAgentBody = {}, o?: WriteOptions): Promise<T.PauseAgentResponse> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/pause`, body, o); }
  /** POST /agents/{id}/stop — always allowed; the safe wind-down */
  stopAgent(id: string, body: T.StopAgentBody = {}, o?: WriteOptions): Promise<T.StopAgentResponse> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/stop`, body, o); }
  /** POST /agents/{id}/backtest — an asynchronous job (always a BACKTEST, labelled as such): read it with `getJob` / `waitForJob` */
  backtestAgent(id: string, body: T.BacktestAgentBody = {}, o?: WriteOptions): Promise<T.BacktestAgentResponse> { return this.#write('POST', `/agents/${seg(id, 'agent id')}/backtest`, body, o); }

  // ============================================================================================================== meta
  /** GET /openapi.json — the OpenAPI 3.1 document served by the wallet */
  openapi(o?: RequestOptions): Promise<T.GetOpenApiResponse> { return this.#get('/openapi.json', undefined, o); }

  // ============================================================================================================== internals
  #orderBody(i: OrderInput): OrderBody {
    const { exchange, symbol, notional, notionalUsdc, instrument: given, size, mode, ...rest } = i;
    if (given !== undefined && (exchange !== undefined || symbol !== undefined)) throw new ConfigurationError('give `instrument` or `exchange` + `symbol`, not both');
    const instrument = given ?? (exchange !== undefined && symbol !== undefined ? `${exchange}:${symbol}` : symbol);
    if (!instrument) throw new ConfigurationError('an order needs `instrument` ("venue:symbol") or `exchange` + `symbol`');
    if ([size, notional, notionalUsdc].filter((x) => x !== undefined).length !== 1) throw new ConfigurationError('an order needs exactly one of `size` (base units) and `notional` (quote currency; `notionalUsdc` is the same field)');
    for (const k of ['price', 'triggerPrice', 'leverage', 'maxFeeUsd'] as const) if (rest[k] !== undefined) decimalString(rest[k], k);
    if (size !== undefined) {
      if (typeof size !== 'string') throw new ConfigurationError('size: pass a decimal string (e.g. "0.01"), not a float');
      return { ...rest, mode: mode ?? 'paper', instrument, size: decimalString(size, 'size') };
    }
    // the notional travels as it is: the server reads the price and computes the size
    return { ...rest, mode: mode ?? 'paper', instrument, notional: decimalString((notional ?? notionalUsdc)!, 'notional') };
  }
  #get<R extends object>(path: string, query: object | undefined, o?: RequestOptions): Promise<R> { return this.#request<R>('GET', path, query, undefined, o, 'read'); }
  #write<R extends object = WriteResult>(method: 'POST' | 'DELETE', path: string, body: unknown, o?: WriteOptions): Promise<R> { return this.#request<R>(method, path, undefined, body, o, 'write'); }
  /** follows `nextCursor` until the list ends (or `maxItems` were yielded) */
  async *#pages<I>(page: (cursor: string | undefined) => Promise<{ items: I[]; nextCursor: string | null }>, maxItems: number | undefined): AsyncGenerator<I, void, undefined> {
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 0)) throw new ConfigurationError('maxItems must be a non-negative integer');
    let cursor: string | undefined, n = 0;
    for (;;) {
      if (maxItems !== undefined && n >= maxItems) return;
      const r = await page(cursor);
      for (const item of r.items) { if (maxItems !== undefined && n >= maxItems) return; n += 1; yield item; }
      if (r.nextCursor === null || r.nextCursor === undefined) return;
      if (r.nextCursor === cursor) throw new ServerError('the server returned the cursor it was given: the list would never end', { code: 'invalid_response', status: 200 });
      cursor = r.nextCursor;
    }
  }

  #backoffMs(attempt: number): number { const cap = Math.min(8_000, 500 * 2 ** attempt); return Math.min(this.#maxRetryDelayMs, cap / 2 + this.#random() * (cap / 2)); }

  /** `read`: a GET. `safe`: a POST the contract declares without an Idempotency-Key (repeating it changes nothing): retried and
   *  reported like a read; a key is sent only when the caller gives one. `write`: one Idempotency-Key per logical call. */
  async #request<R extends object>(method: 'GET' | 'POST' | 'DELETE', path: string, query: object | undefined, body: unknown, o: WriteOptions = {}, kind: 'read' | 'safe' | 'write'): Promise<R> {
    const mutating = kind === 'write';
    const key = mutating ? (o.idempotencyKey ?? newIdempotencyKey()) : kind === 'safe' ? (o.idempotencyKey ?? null) : null;
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
      if (key !== null) { headers['idempotency-key'] = key; if (mutating && this.#sendTimestamp) headers['x-spw-timestamp'] = String(Math.floor(Date.now() / 1000)); }
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
