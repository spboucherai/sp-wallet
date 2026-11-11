// CoinGecko reads (public coin ids only — never an address or a balance), with a cache, stale-on-error and — since v10 — a
// short retry after a failure.
//
// Before v10 the answer of a call was cached for its TTL whatever it was: on a process that had no earlier value, ONE refused
// request (the free tier answers 429 to a burst) was kept as "no price" for four minutes. Home then showed « Prix désactivés »
// and no daily change although prices were enabled, and concurrent requests each made their own call, which is what the free
// tier refuses. Now: concurrent callers share one request; a refused request is retried once after a pause; a failure is
// remembered for RETRY_MS only (the stale value, when there is one, is served meanwhile).
export type GeckoFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface GeckoOpts { now?: () => number; retryMs?: number; pauseMs?: number; base?: string }

export function createGecko(fetchJson: GeckoFetch, o: GeckoOpts = {}): <T>(key: string, ttlMs: number, path: string) => Promise<T | null> {
  const now = o.now ?? Date.now, RETRY_MS = o.retryMs ?? 15_000, PAUSE_MS = o.pauseMs ?? 1200, BASE = o.base ?? 'https://api.coingecko.com/api/v3';
  const fresh = new Map<string, { at: number; v: unknown }>(), stale = new Map<string, unknown>(), failedAt = new Map<string, number>(), inflight = new Map<string, Promise<unknown>>();
  return async function gecko<T>(key: string, ttlMs: number, path: string): Promise<T | null> {
    const c = fresh.get(key);
    if (c && now() - c.at < ttlMs) return c.v as T;
    const f = failedAt.get(key);
    if (f !== undefined && now() - f < RETRY_MS) return (stale.get(key) as T | undefined) ?? null;
    const running = inflight.get(key);
    if (running) return running as Promise<T | null>;
    const once = async (): Promise<T> => {
      const r = await fetchJson(BASE + path, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as T;
    };
    const p = (async (): Promise<T | null> => {
      try {
        let j: T;
        try { j = await once(); } catch { await new Promise((r) => setTimeout(r, PAUSE_MS)); j = await once(); }
        stale.set(key, j); fresh.set(key, { at: now(), v: j }); failedAt.delete(key);
        return j;
      } catch { failedAt.set(key, now()); return (stale.get(key) as T | undefined) ?? null; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  };
}
