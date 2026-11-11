// Monitoring dashboard — read-only endpoints under /api/v1/monitor/, behind the owner session like every other /api/ route
// (the global onRequest hook of server.ts). Each answer is cached for a few seconds: opening the screen costs a handful of
// indexed queries, never a call to a chain, a venue or a provider.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { signer } from '../signer-client.ts';
import { healthCache, loopStats } from '../worker.ts';
import { alertSettings } from '../alerts/store.ts';
import { capital, exposure, pnl } from './aggregate.ts';
import { auditChainStatus, collectConnectors, diskFree, lastBackup, versions } from './health.ts';
import { labStatus } from '../agents/lab.ts'; // v8

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
export const clearMonitorCache = (): void => cache.clear();

interface PortfolioAnswer { prices: Record<string, { usd: number; cad: number }> | null; balances: { symbol: string; display: string | null; error: string | null }[] }
/** The wallet total, from the existing /portfolio endpoint (same session, same balance cache): no second way of reading balances. */
async function walletTotal(app: FastifyInstance, req: FastifyRequest): Promise<{ usd: number | null; cad: number | null; assets: number; unpriced: number; unavailable: number }> {
  const r = await app.inject({ method: 'GET', url: '/api/v1/portfolio', headers: { cookie: req.headers.cookie ?? '' } });
  if (r.statusCode !== 200) return { usd: null, cad: null, assets: 0, unpriced: 0, unavailable: 0 };
  const p = r.json() as PortfolioAnswer;
  let usd = 0, cad = 0, assets = 0, unpriced = 0, unavailable = 0;
  for (const b of p.balances) {
    if (b.display === null) { unavailable += 1; continue; }
    const v = Number(b.display);
    if (!(v > 0)) continue;
    assets += 1;
    const px = p.prices?.[b.symbol];
    if (!px) { unpriced += 1; continue; }
    usd += v * px.usd; cad += v * px.cad;
  }
  const rd = (x: number) => Math.round(x * 100) / 100;
  return p.prices ? { usd: rd(usd), cad: rd(cad), assets, unpriced, unavailable } : { usd: null, cad: null, assets, unpriced, unavailable };
}

export function monitorRoutes(app: FastifyInstance): void {
  const P = '/api/v1/monitor';
  app.get(`${P}/capital`, async (req) => {
    const [wallet, rest] = await Promise.all([cached('wallet', 15_000, () => walletTotal(app, req)), cached('capital', 15_000, () => capital(Date.now()))]);
    return { ...rest, wallet };
  });
  app.get(`${P}/pnl`, async () => cached('pnl', 30_000, async () => pnl(Date.now(), (await alertSettings()).quiet.tz)));
  app.get(`${P}/exposure`, async () => cached('exposure', 15_000, () => exposure(Date.now())));
  app.get(`${P}/health`, async () => cached('health', 10_000, async () => {
    const now = Date.now();
    const { connectors, signer: st } = await collectConnectors({ now: () => now, signerStatus: () => signer.status().catch(() => null), rpcHealth: () => [...healthCache.values()], loops: () => [...loopStats.values()] });
    const backup = lastBackup(), audit = await auditChainStatus(now);
    return {
      asOf: now,
      connectors: connectors.map((c) => ({ ...c, ageSec: c.lastSuccessAt === null ? null : Math.max(0, Math.round((now - c.lastSuccessAt) / 1000)) })),
      loops: [...loopStats.values()].map((l) => ({ name: l.name, everyMs: l.everyMs, runs: l.runs, lastOkAt: l.lastOkAt, lastErrorAt: l.lastErrorAt, lastError: l.lastError, failures: l.failures,
        ageSec: l.lastOkAt === null ? null : Math.round((now - l.lastOkAt) / 1000), late: l.lastOkAt !== null && now - l.lastOkAt > Math.max(3 * l.everyMs, 60_000) })),
      // the agent engine runs on its own timer, outside `loop()`: it has no heartbeat here (each agent's last bar is on the capital endpoint)
      loopsNote: 'agent_engine_not_listed',
      backup: backup ? { visible: true, lastAt: backup.lastAt, files: backup.files, ageHours: backup.lastAt === null ? null : Math.round((now - backup.lastAt) / 360_000) / 10 } : { visible: false, lastAt: null, files: 0, ageHours: null },
      disk: await diskFree(),
      audit,
      signer: st ? { reachable: true, halted: st.halted } : { reachable: false, halted: null },
      versions: versions(st),
      // v8: the OS sandbox every strategy process runs in; `ok: false` = signals and backtests do not run (agents hold)
      lab: await labStatus().then((l) => ({ mode: l.mode, ok: l.ok, reason: l.reason, checkedAt: l.checkedAt, lastFailureAt: l.lastFailureAt, lastFailure: l.lastFailure, calls: l.calls, refused: l.refused }), () => null),
    };
  }));
}
