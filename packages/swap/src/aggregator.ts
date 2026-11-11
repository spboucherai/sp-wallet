import { ProviderRuntime, type ProviderStats } from './runtime.ts';
import { ProviderError, sameAsset, type SwapQuote, type SwapQuoteRequest } from './types.ts';

export type QuoteEvent =
  | { type: 'quote'; quote: SwapQuote; ms: number }
  | { type: 'provider'; provider: string; status: 'no_route' | 'skipped' | 'error'; code?: string; detail?: string; ms: number }
  | { type: 'done'; ms: number };

/** Structural validation applied to every provider answer before anyone else sees it. A failing quote is dropped and counted as an error. */
export function checkQuote(q: SwapQuote, req: SwapQuoteRequest, now: number): string | null {
  if (!sameAsset(q.request.from, req.from) || !sameAsset(q.request.to, req.to)) return 'quote is for another pair';
  if (q.request.amountIn !== req.amountIn) return 'quote is for another amount';
  if (q.request.recipient !== req.recipient || q.request.sender !== req.sender) return 'quote is for other addresses';
  if (typeof q.amountOut !== 'bigint' || typeof q.minAmountOut !== 'bigint') return 'amounts are not integers';
  if (q.amountOut <= 0n || q.minAmountOut <= 0n) return 'non-positive output';
  if (q.minAmountOut > q.amountOut) return 'minimum output above expected output';
  if (!(q.expiresAt > now)) return 'quote already expired';
  if (q.steps.length === 0 || q.steps.length > 6) return 'unreasonable number of steps';
  if (!sameAsset(q.steps[0]!.from, req.from) || !sameAsset(q.steps[q.steps.length - 1]!.to, req.to)) return 'steps do not connect the requested assets';
  for (let k = 1; k < q.steps.length; k++) if (!sameAsset(q.steps[k - 1]!.to, q.steps[k]!.from)) return 'steps are not contiguous';
  for (const f of q.fees) if (typeof f.amount !== 'bigint' || f.amount < 0n) return 'invalid fee amount';
  if (q.estimatedSeconds !== null && !(q.estimatedSeconds >= 0 && q.estimatedSeconds < 7 * 86400)) return 'invalid time estimate';
  if (q.priceImpactBps !== null && !(q.priceImpactBps >= -10_000 && q.priceImpactBps <= 10_000)) return 'invalid price impact';
  return null;
}

export class QuoteAggregator {
  constructor(private runtimes: ProviderRuntime[], private now: () => number = Date.now) {}
  providers(): ProviderStats[] { return this.runtimes.map((r) => r.stats()); }
  runtime(id: string): ProviderRuntime | undefined { return this.runtimes.find((r) => r.provider.id === id); }

  /** Query every compatible provider concurrently and yield results as they arrive (fastest first). */
  async *stream(req: SwapQuoteRequest, opts: { deadlineMs?: number; signal?: AbortSignal; only?: string[]; role?: 'direct' | 'leg' } = {}): AsyncGenerator<QuoteEvent> {
    const t0 = this.now();
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), opts.deadlineMs ?? 4000);
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const queue: QuoteEvent[] = []; let wake: (() => void) | null = null; let pending = 0;
    const push = (e: QuoteEvent) => { queue.push(e); wake?.(); };
    for (const rt of this.runtimes) {
      const id = rt.provider.id;
      if (opts.only && !opts.only.includes(id)) continue;
      const cap = rt.provider.capabilities();
      if (!rt.enabled) { push({ type: 'provider', provider: id, status: 'skipped', code: 'disabled', ms: 0 }); continue; }
      if (cap.needsKey && !cap.configured) { push({ type: 'provider', provider: id, status: 'skipped', code: 'not_configured', ms: 0 }); continue; }
      if (!rt.provider.supportsPair(req.from, req.to)) continue;
      if (rt.provider.policy?.scarce && (opts.role === 'leg' || req.from.network === req.to.network)) continue; // keep a small quota for what only it can do
      pending += 1;
      rt.quote(req, ac.signal).then((quotes) => {
        const ms = this.now() - t0; let ok = 0;
        for (const q of quotes) { const bad = checkQuote(q, req, this.now()); if (bad) push({ type: 'provider', provider: id, status: 'error', code: 'invalid_quote', detail: bad, ms }); else { ok += 1; push({ type: 'quote', quote: q, ms }); } }
        if (quotes.length === 0) push({ type: 'provider', provider: id, status: 'no_route', ms });
        void ok;
      }, (e: unknown) => {
        const err = e instanceof ProviderError ? e : new ProviderError(id, 'bad_response', String((e as Error)?.message ?? e));
        push({ type: 'provider', provider: id, status: 'error', code: err.code, detail: err.message.slice(0, 160), ms: this.now() - t0 });
      }).finally(() => { pending -= 1; wake?.(); });
    }
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (pending === 0) break;
        await new Promise<void>((r) => { wake = r; }); wake = null;
      }
      while (queue.length) yield queue.shift()!;
      yield { type: 'done', ms: this.now() - t0 };
    } finally { clearTimeout(kill); ac.abort(); }
  }
  async collect(req: SwapQuoteRequest, opts?: { deadlineMs?: number; signal?: AbortSignal; only?: string[]; role?: 'direct' | 'leg' }): Promise<{ quotes: SwapQuote[]; events: QuoteEvent[] }> {
    const quotes: SwapQuote[] = [], events: QuoteEvent[] = [];
    for await (const e of this.stream(req, opts)) { events.push(e); if (e.type === 'quote') quotes.push(e.quote); }
    return { quotes, events };
  }
}
