/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/market/worker.ts
 * Module           : market
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

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
