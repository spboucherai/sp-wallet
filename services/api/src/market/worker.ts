// Market data worker: one loop, every minute. Incremental update first (cheap: only series missing their latest closed
// bar are requested), then the quality records, then a bounded slice of the backfill. The loop is asynchronous, so the
// API is listening long before the history is complete; the backfill resumes where it stopped, pass after pass.
import { loop } from '../worker.ts';
import { backfill, recomputeQuality, updateAll } from './pipeline.ts';
import { activeMarketConfig } from './symbols.ts';
import { defaultSources } from './sources.ts';

const log = (m: string) => console.log(`[market] ${m}`);

export function startMarketWorker(): void {
  const sources = defaultSources(), priority = sources.map((s) => s.id), done = new Set<string>();
  let complete = false, set = '';
  loop('market', async () => {
    // the symbol set follows the registry and the agents (their symbols first): recomputed at every pass
    const cfg = await activeMarketConfig();
    const key = `${cfg.symbols.join(',')}|${(cfg.first ?? []).join(',')}`;
    if (key !== set) { log(`symbols: ${cfg.symbols.length} (${(cfg.first ?? []).length} used by agents)${cfg.dropped?.length ? `, ${cfg.dropped.length} left out by SPW_MARKET_MAX_SYMBOLS` : ''}`); set = key; complete = false; }
    const u = await updateAll(sources, cfg);
    if (u.requests || u.errors.length) log(`update: ${u.requests} requests, ${u.written} bars written${u.errors.length ? `, ${u.errors.length} errors (${u.errors[0]})` : ''}`);
    await recomputeQuality(cfg, priority);
    if (complete) return;
    const b = await backfill(sources, cfg, { done, maxRequests: 80, deadline: Date.now() + 30_000 });
    complete = b.complete;
    if (b.requests) { log(`backfill: ${b.requests} requests, ${b.written} bars written${b.complete ? ', complete' : ''}${b.errors.length ? `, ${b.errors.length} errors (${b.errors[0]})` : ''}`); await recomputeQuality(cfg, priority); }
  }, 60_000);
}
