// Read-only routes of the market data engine (authentication is the global hook of server.ts).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUALITY_WINDOW, rejectedCount } from './pipeline.ts';
import { activeMarketConfig } from './symbols.ts';
import { DEFAULT_PRIORITY, DEFAULT_QUALITY } from './quality.ts';
import { getSeries } from './series.ts';
import { defaultSources } from './sources.ts';
import { coverage, listQuality } from './store.ts';
import { INTERVAL_MS, isSymbol, type Interval } from './types.ts';

const RULE = 'for each bar-open time: the whole bar of the first source, in priority order, that has it; never a blend of sources';
let cached: { at: number; v: unknown } | null = null;

export function marketDataRoutes(app: FastifyInstance): void {
  app.get('/api/v1/market-data/status', async () => {
    if (cached && Date.now() - cached.at < 30_000) return cached.v;
    const cfg = await activeMarketConfig(), sources = defaultSources();
    const [cov, quality] = await Promise.all([coverage(), listQuality()]);
    const v = {
      symbols: cfg.symbols, intervals: cfg.intervals, only: cfg.only ?? {}, first: cfg.first ?? [], dropped: cfg.dropped ?? [], priority: DEFAULT_PRIORITY, rule: RULE,
      thresholds: { maxDeviationBps: DEFAULT_QUALITY.maxDeviationBps, agreeBars: DEFAULT_QUALITY.agreeBars, minSources: DEFAULT_QUALITY.minSources, maxLagBars: DEFAULT_QUALITY.maxLagBars, qualityWindow: QUALITY_WINDOW },
      sources: sources.map((s) => ({ id: s.id, maxBars: s.maxBars, historyBars: s.historyBars, pairs: Object.fromEntries(cfg.symbols.flatMap((x) => (s.pairs[x] ? [[x, s.pairs[x]]] : []))) })),
      coverage: cov.map((c) => ({ source: c.source, symbol: c.symbol, interval: c.interval, bars: c.bars, first: c.first_ts, last: c.last_ts })),
      quality: quality.map((q) => ({ symbol: q.symbol, interval: q.interval, status: q.status, fresh: q.fresh, checkedAt: q.checked_at, lastTs: q.last_ts, gaps: q.gaps,
        maxDeviationBps: q.max_deviation_bps, failures: q.detail.failures, window: q.detail.window, provided: q.detail.provided, sources: q.detail.sources })),
      rejectedSinceStart: rejectedCount,
    };
    cached = { at: Date.now(), v };
    return v;
  });

  app.get('/api/v1/market-data/candles', async (req) => {
    const q = z.object({ symbol: z.string().max(12).refine(isSymbol, 'no market data for this symbol'), interval: z.enum(Object.keys(INTERVAL_MS) as [Interval, ...Interval[]]),
      limit: z.coerce.number().int().min(1).max(5000).default(500), until: z.coerce.number().int().positive().optional() }).parse(req.query);
    const s = await getSeries(q.symbol, q.interval, { limit: q.limit, ...(q.until === undefined ? {} : { until: q.until }) });
    return { symbol: s.symbol, interval: s.interval, rule: RULE, priority: s.priority, gaps: s.gaps, provided: s.provided, bars: s.bars };
  });
}
