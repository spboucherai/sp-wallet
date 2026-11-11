// V7 research runtime — the data of a job, and the part of it the job never sees.
//
// When a job is created the API freezes ONE data set for it, as files under <data dir>/research-jobs/<job id>/:
//   full/   every closed bar available for the job's symbols (spot: the candles table, ONE source; perp: the venue's own
//           candles and funding through the existing rate-budgeted store). The server's evaluation runs on these files.
//   dev/    the same data cut just before the laboratory's own test split (the last 20 % of the bars, computed by the
//           laboratory itself with `spq.job split`). THIS is what the runner receives and what the agent can read.
// The test split is therefore not something the agent is asked not to look at: it is not on the research node at all.
// The laboratory processes get files — no database URL, not even the read-only role.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Instrument } from '@spw/derivatives';
import type { ResearchData } from '@spw/core';
import { sql } from '../db.ts';
import { backtestSource } from '../agents/strategies.ts';
import { VENUE_MAX_BARS, type PerpInterval } from '../agents/perp-data.ts';
import { PERP_VENUE } from '../agents/perp-engine.ts';
import type { PerpLabDeps } from '../agents/perp-strategies.ts';
import { dropScratch, labRun, lastLine, scratchDir } from './lab.ts';
import { researchDataDir, sysLog, type Dataset, type Holdout, type JobRow } from './store.ts';

export const MIN_DEV_BARS = 600, MIN_TEST_BARS = 120;
export const jobDataDir = (id: string): string => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad job id'); return path.join(researchDataDir(), id); };
const csvName = (dir: string, source: string, symbol: string, interval: string): string => path.join(dir, source, `${symbol}_${interval}.csv`);
const sizeDecimals = (lot: string): number => { const i = lot.indexOf('.'); return i < 0 ? 0 : lot.length - i - 1; };

interface Split { start: string; test_start: string; last: string; end: string; bars: number; dev_bars: number; test_bars: number }
async function split(kind: 'spot' | 'perp', symbols: string[], interval: string, dataDir: string, source: string | null): Promise<Split> {
  const scratch = scratchDir();
  try {
    const r = await labRun(['spq.job', 'split', '--kind', kind, '--symbols', symbols.join(','), '--interval', interval, '--data-dir', dataDir, ...(source ? ['--source', source] : [])], { timeoutMs: 120_000, scratch, readable: [dataDir] });
    if (r.code !== 0) throw new Error(lastLine(r.err) || 'the laboratory could not read the data');
    return JSON.parse(r.out) as Split;
  } finally { dropScratch(scratch); }
}
const holdoutOf = (s: Split): Holdout => {
  if (s.dev_bars < MIN_DEV_BARS || s.test_bars < MIN_TEST_BARS) throw new Error(`not enough history for a research job: ${s.bars} common closed bars (${s.dev_bars} for the agent, ${s.test_bars} held out; at least ${MIN_DEV_BARS} and ${MIN_TEST_BARS} are needed)`);
  return { start: s.start, devEnd: s.test_start, end: s.end, devBars: s.dev_bars, testBars: s.test_bars };
};

/** Freeze the data set of a job. Never throws: the outcome is written on the job (`dataset.ready` or `dataset.error`). */
export async function prepareDataset(job: Pick<JobRow, 'id' | 'kind' | 'universe' | 'interval'>, perp?: () => PerpLabDeps): Promise<Dataset> {
  let dir = jobDataDir(job.id), full = path.join(dir, 'full'), dev = path.join(dir, 'dev');
  let ds: Dataset;
  try {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(full, { recursive: true, mode: 0o700 }); mkdirSync(dev, { recursive: true });
    // canonical paths from here on: the laboratory runs in a sandbox that matches real paths (/var is /private/var on macOS)
    dir = realpathSync(dir); full = path.join(dir, 'full'); dev = path.join(dir, 'dev');
    if (job.kind === 'spot') {
      const source = backtestSource(job.universe);
      if (!source) throw new Error(`no single exchange lists every symbol (${job.universe.join(', ')}); the laboratory does not mix candle sources`);
      const series: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
      for (const s of job.universe) {
        series[s] = await sql<{ t: string; o: number; h: number; l: number; c: number; v: number }[]>`select extract(epoch from ts)::bigint::text as t, open as o, high as h, low as l, close as c, volume as v
          from candles where source = ${source} and symbol = ${s} and interval = ${job.interval} and ts + ${job.interval === '1d' ? '1 day' : job.interval === '4h' ? '4 hours' : '1 hour'}::interval <= now() order by ts`;
        if (!series[s]!.length) throw new Error(`no ${job.interval} candles of ${s} from ${source} in the market store`);
      }
      const write = (root: string, keep: (t: number) => boolean): void => { for (const s of job.universe) { const f = csvName(root, source, s, job.interval); mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, `ts,open,high,low,close,volume\n${series[s]!.filter((r) => keep(Number(r.t))).map((r) => `${r.t},${r.o},${r.h},${r.l},${r.c},${r.v}`).join('\n')}\n`); } };
      write(full, () => true);
      const holdout = holdoutOf(await split('spot', job.universe, job.interval, full, source)), cut = Date.parse(holdout.devEnd) / 1000;
      write(dev, (t) => t < cut);
      ds = { ready: true, dir, source, holdout };
    } else {
      if (!perp) throw new Error('perpetual-futures data are not available on this server');
      const d = perp(), interval = job.interval as PerpInterval, insts: Instrument[] = [];
      for (const s of job.universe) insts.push(await d.data.instrument(`${PERP_VENUE}:${s}`));
      await d.store.backfill(insts, interval, VENUE_MAX_BARS - 1, { deadlineMs: 15 * 60_000 });
      const candles: Record<string, [number, string, string, string, string, string][]> = {}, funding: Record<string, [number, string, string | null][]> = {}, meta: Record<string, unknown> = {};
      let first = Infinity;
      for (const inst of insts) { const x = await d.store.exact(inst, interval, VENUE_MAX_BARS);
        if (!x.candles.length || !x.funding.length) throw new Error(`${inst.symbol}: no ${interval} history on the venue`);
        candles[inst.symbol] = x.candles; funding[inst.symbol] = x.funding; first = Math.min(first, x.candles[0]![0]);
        meta[inst.symbol] = { max_leverage: Number(inst.maxLeverage), size_decimals: sizeDecimals(inst.lotSize) }; }
      let spot: { source: string; candles: Record<string, [number, number, number, number, number, number][]> } | undefined;
      if (d.spotCandles) { const got: Record<string, [number, number, number, number, number, number][]> = {};
        for (const s of job.universe) { const rows = await d.spotCandles(s, interval, first).catch(() => []); if (rows.length > 500) got[s] = rows; }
        if (Object.keys(got).length === job.universe.length) spot = { source: 'coinbase', candles: got }; }
      const asOf = d.store.now();
      const importInto = async (root: string, bundle: unknown): Promise<void> => {
        writeFileSync(path.join(root, 'bundle.json'), JSON.stringify(bundle));
        const scratch = scratchDir();
        try { const out = path.join(scratch, 'data');
          const r = await labRun(['spq.data.hl_import', '--input', path.join(root, 'bundle.json'), '--out', out], { timeoutMs: 120_000, scratch, readable: [root] });
          if (r.code !== 0) throw new Error(lastLine(r.err) || 'import failed');
          const { cpSync } = await import('node:fs'); cpSync(out, path.join(root, 'data'), { recursive: true });
        } finally { dropScratch(scratch); }
      };
      await importInto(full, { interval, as_of_ms: asOf, meta, candles, funding, ...(spot ? { spot } : {}) });
      const holdout = holdoutOf(await split('perp', job.universe, interval, path.join(full, 'data'), null)), cut = Date.parse(holdout.devEnd);
      const before = <T extends [number, ...unknown[]]>(rows: T[]): T[] => rows.filter((r) => r[0] < cut);
      // the agent's bundle: nothing dated at or after the first held-out bar; `as_of_ms` = that instant, so the last kept bar is closed
      await importInto(dev, { interval, as_of_ms: cut, meta, candles: Object.fromEntries(Object.entries(candles).map(([s, r]) => [s, before(r)])), funding: Object.fromEntries(Object.entries(funding).map(([s, r]) => [s, before(r)])),
        ...(spot ? { spot: { source: spot.source, candles: Object.fromEntries(Object.entries(spot.candles).map(([s, r]) => [s, before(r)])) } } : {}) });
      ds = { ready: true, dir, source: null, holdout };
    }
  } catch (e) { ds = { ready: false, error: (e as Error).message.slice(0, 400) }; rmSync(dir, { recursive: true, force: true }); }
  await sql`update research_jobs set dataset = ${sql.json(ds as never)}, updated_at = now() where id = ${job.id}`;
  await sysLog(job.id, ds.ready ? `data set frozen: ${ds.holdout!.devBars} bars for the agent (from ${ds.holdout!.start}), ${ds.holdout!.testBars} bars held out on the server from ${ds.holdout!.devEnd}` : `data set could not be prepared: ${ds.error}`);
  return ds;
}

/** What the runner is given: the development part only. */
export function runnerData(job: Pick<JobRow, 'id' | 'kind' | 'universe' | 'interval' | 'dataset'>): ResearchData {
  const ds = job.dataset;
  if (!ds?.ready || !ds.dir) throw new Error('the data set of this job is not ready');
  if (job.kind === 'spot') return { kind: 'spot', source: ds.source!, interval: job.interval, files: job.universe.map((symbol) => ({ symbol, csv: readFileSync(csvName(path.join(ds.dir!, 'dev'), ds.source!, symbol, job.interval), 'utf8') })) };
  return { kind: 'perp', bundle: JSON.parse(readFileSync(path.join(ds.dir, 'dev', 'bundle.json'), 'utf8')) as Record<string, unknown> };
}
/** laboratory data directories of a frozen data set: `dev` is what the agent had, `full` includes the held-out test split */
export function dataDirs(job: Pick<JobRow, 'kind' | 'dataset'>): { dev: string; full: string } {
  const dir = job.dataset?.dir;
  if (!dir || !existsSync(dir)) throw new Error('the data set of this job is gone');
  return job.kind === 'spot' ? { dev: path.join(dir, 'dev'), full: path.join(dir, 'full') } : { dev: path.join(dir, 'dev', 'data'), full: path.join(dir, 'full', 'data') };
}
export const dropDataset = (id: string): void => { rmSync(jobDataDir(id), { recursive: true, force: true }); };
