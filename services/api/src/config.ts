const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined || v === '') throw new Error(`missing env ${k}`); return v; };
/** a non-negative number from the environment; the default when it is absent or not a number */
const nonNeg = (k: string, d: number): number => { const v = process.env[k]; const n = v === undefined || v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export const config = {
  origin: env('SPW_ORIGIN'),
  rpId: env('SPW_RP_ID'),
  port: Number(env('PORT', '8650')),
  host: env('HOST', '127.0.0.1'),
  databaseUrl: env('DATABASE_URL'),
  signerUrl: env('SPW_SIGNER_URL', 'http://127.0.0.1:8651'),
  signerSecret: env('SPW_SIGNER_SECRET'),
  trustProxy: (process.env.SPW_TRUST_PROXY ?? '127.0.0.1').split(',').map((x) => x.trim()),
  webDir: process.env.SPW_WEB_DIR ?? '',
  /** tests only: never relay signed bytes to a network */
  broadcast: env('SPW_BROADCAST', 'on') === 'on',
  /** SPW_WORKERS: `on` (default — every background worker in this process, the agent runtime included), `off`, `api` (every worker
   *  EXCEPT the agent runtime: a separate `sp-wallet-agents` process runs it) — `agents` is the value of that separate process
   *  (agent-worker-main.ts) and starts none of the API's workers */
  workers: ['on', 'api'].includes(env('SPW_WORKERS', 'on')),
  agentWorkers: ['on', 'agents'].includes(env('SPW_WORKERS', 'on')),
  /**
   * V11 — API Bricks (CoinAPI) market data: OPTIONAL and keyed. Without APIBRICKS_API_KEY the provider is absent (reported
   * `needsKey`) and the wallet behaves exactly as before. The key is a SECRET: it is read here and nowhere else, sent only as a
   * header to rest.coinapi.io, and scrubbed from every message (apibricks/redact.ts). Never log this object.
   * Defaults come from the plan observed with the owner's key on 2026-11-17 (docs/v11/research/apibricks.md): usage is paid per
   * REST credit from a prepaid balance, so every figure below is a deliberate ceiling, not a technical limit.
   */
  apibricks: {
    key: (process.env.APIBRICKS_API_KEY ?? '').trim(),
    /** hard ceiling of REST credits per UTC day, all uses together; 0 = never call */
    dailyCredits: nonNeg('APIBRICKS_DAILY_CREDITS', 100),
    /** of which, at most, for the market-data bars and for the quote hub */
    marketDailyCredits: nonNeg('APIBRICKS_MARKET_DAILY_CREDITS', 25), quoteDailyCredits: nonNeg('APIBRICKS_QUOTE_DAILY_CREDITS', 30),
    /** refresh window of the second price list; shorter while the primary source is down or stale */
    priceTtlMs: nonNeg('APIBRICKS_PRICE_TTL_MS', 30 * 60_000), failoverTtlMs: nonNeg('APIBRICKS_FAILOVER_TTL_MS', 5 * 60_000),
    /** two prices further apart than this are flagged `divergent` */
    divergenceBps: nonNeg('APIBRICKS_DIVERGENCE_BPS', 100),
    /** polling period of the quote hub's metered spot source */
    quotePollMs: Math.max(60_000, nonNeg('APIBRICKS_QUOTE_POLL_MS', 5 * 60_000)),
    /** intervals of the additional confirming market source: a list among 1d,1h,5m, or `off` (default 1d: one credit per symbol and per day) */
    marketIntervals: (process.env.APIBRICKS_MARKET_INTERVALS ?? '1d').split(',').map((x) => x.trim()).filter((x) => x === '1d' || x === '1h' || x === '5m') as ('1d' | '1h' | '5m')[],
    /** its symbols (default: the base set of the market module); only those with an independent series are served */
    marketSymbols: (process.env.APIBRICKS_MARKET_SYMBOLS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    marketHistoryBars: Math.max(100, nonNeg('APIBRICKS_MARKET_HISTORY_BARS', 300)),
  },
};
export const secureCookies = config.origin.startsWith('https://');
export class UserError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
