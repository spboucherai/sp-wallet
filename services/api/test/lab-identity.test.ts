// V8 hardening — confinement changes NOTHING in what the laboratory computes.
//   1. Signals: for every strategy of the library (spot and perp), the sandboxed runner's output is byte-identical to the
//      output of the pre-v8 invocation (`uv run --frozen --no-sync python -m spq.signal`, minimal environment, no sandbox).
//   2. Spot backtest: the report produced from the FILES the API now exports (sandboxed, no database URL) equals the report
//      the laboratory produced when it read the candles table itself (DATABASE_URL + SPQ_CANDLE_SOURCE, pre-v8), field for
//      field except its timestamp.
//   3. Latency of one signal call, measured (printed; must stay negligible next to a 1 h bar).
// The laboratory here is the real code and the real library, with its own results/ directory (the trial ledger).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAgent, world, type World } from './alerts-helpers.ts';
import { bars, fixtureLab, REAL_LAB, REAL_PYTHON } from './lab-hostile.ts';

const READY = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') && existsSync(REAL_PYTHON);
const UV = (() => { try { return execFileSync('/bin/sh', ['-c', 'command -v uv'], { encoding: 'utf8', env: { PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } }).trim(); } catch { return ''; } })();
let w: World, sql: any, fx: ReturnType<typeof fixtureLab>;
let lab: typeof import('../src/agents/lab.ts'), live: typeof import('../src/agents/live.ts'), perpSignal: typeof import('../src/agents/perp-signal.ts');
let strategies: typeof import('../src/agents/strategies.ts');
const library: string[] = [];

/** the invocation of the laboratory as it was before v8: the virtualenv's interpreter (through `uv run`), cwd = research/,
 *  three environment variables, no sandbox */
function legacy(args: string[], o: { input?: string; env?: Record<string, string>; viaUv?: boolean } = {}): { status: number | null; stdout: string; stderr: string; ms: number } {
  const home = process.env.HOME ?? '/tmp', t0 = Date.now();
  const env = { PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, UV_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', ...o.env };
  // `uv run` only execs the virtualenv's interpreter; it is used here for the latency figure only. For the comparisons the
  // interpreter is started directly (same binary, same environment): several `uv run` at once — suites running in parallel —
  // were seen to hang for ever, and spawnSync would then block this whole test process. Every call has a timeout.
  const useUv = !!UV && o.viaUv === true;
  const r = useUv ? spawnSync(UV, ['run', '--frozen', '--no-sync', 'python', '-m', ...args], { cwd: REAL_LAB, env, input: o.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, killSignal: 'SIGKILL' })
    : spawnSync(REAL_PYTHON, ['-m', ...args], { cwd: REAL_LAB, env, input: o.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, killSignal: 'SIGKILL' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}
const SYMS: Record<string, [number, number]> = { BTC: [11, 60_000], ETH: [23, 3000], LINK: [31, 15], SOL: [41, 150], AAVE: [53, 90], HYPE: [61, 25] };
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

beforeAll(async () => {
  if (!READY) return;
  fx = fixtureLab({ lint: 'real' });
  for (const name of readdirSync(path.join(REAL_LAB, 'strategies')).sort()) { if (!/^[a-z0-9_]{1,40}$/.test(name) || name.startsWith('rj_') || name.startsWith('zz_')) continue;
    for (const ver of readdirSync(path.join(REAL_LAB, 'strategies', name)).sort()) { const f = path.join(REAL_LAB, 'strategies', name, ver, 'strategy.py'); if (!existsSync(f)) continue;
      fx.addStrategy(`${name}/${ver}`, readFileSync(f, 'utf8')); library.push(`${name}/${ver}`); } }
  Object.assign(process.env, { SPW_RESEARCH_DIR: fx.dir, SPW_RESEARCH_PYTHON: fx.python });
  delete process.env.SPW_LAB_SANDBOX; delete process.env.RESEARCH_DATABASE_URL;
  w = await world('lab_identity'); sql = w.sql;
  const H = 3_600_000, rows: Record<string, unknown>[] = [];
  for (const sym of ['BTC', 'ETH']) for (const b of bars(1500, SYMS[sym]![0], SYMS[sym]![1])) rows.push({ source: 'coinbase', symbol: sym, interval: '1h', ts: new Date(b.ts - H), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  for (let i = 0; i < rows.length; i += 500) await sql`insert into candles ${sql(rows.slice(i, i + 500))}`;
  lab = await import('../src/agents/lab.ts'); live = await import('../src/agents/live.ts'); perpSignal = await import('../src/agents/perp-signal.ts');
  strategies = await import('../src/agents/strategies.ts');
}, 120_000);
afterAll(async () => { await sql?.end(); });

describe.skipIf(!READY)('confinement does not change a signal', () => {
  it('every library strategy: the sandboxed output is byte-identical to the pre-v8 invocation, and runSignal / runPerpSignal return those weights', async () => {
    expect(library.length).toBeGreaterThanOrEqual(20);
    let spot = 0, perp = 0;
    for (const rel of library) {
      const dir = path.join(fx.dir, 'strategies', rel), realDir = path.join(REAL_LAB, 'strategies', rel);
      const d = legacy(['spq.describe', '--strategy', realDir, '--contract', '2']);
      expect(d.status, `${rel}: ${d.stderr}`).toBe(0);
      const info = JSON.parse(d.stdout) as { sha256: string; kind: 'spot' | 'perp'; meta: { universe: string[]; lookback: number; interval: string } };
      if (info.meta.interval !== '1h') continue;
      const universe = info.meta.universe[0] === '*' ? ['BTC', 'ETH', 'LINK'] : info.meta.universe;
      if (universe.some((s) => s.endsWith('.SPOT'))) continue;            // spot legs: not runnable by a perp agent
      const n = info.meta.lookback + 5;
      if (info.kind === 'spot') {
        const data = Object.fromEntries(universe.map((s) => [s, bars(n, SYMS[s]![0], SYMS[s]![1])]));
        const last = data[universe[0]!]!.at(-1)!.ts;
        const input = JSON.stringify({ candles: Object.fromEntries(universe.map((s) => [s, data[s]!.map((b) => [Math.floor(b.ts / 1000), b.open, b.high, b.low, b.close, b.volume])])), interval: '1h', as_of: new Date(last).toISOString().replace('.000Z', 'Z') });
        const ref = legacy(['spq.signal', '--strategy', realDir, '--sha256', info.sha256, '--input', '-'], { input });
        expect(ref.status, `${rel}: ${ref.stderr}`).toBe(0);
        const boxed = await lab.labExec(['spq.signal', '--strategy', dir, '--sha256', info.sha256, '--input', '-'], { timeoutMs: 120_000, stdin: input, strategyDir: dir });
        expect(boxed.sandbox).toBe('sandbox-exec');
        expect(boxed.out, rel).toBe(ref.stdout);
        expect(await live.runSignal({ path: `strategies/${rel}`, sha256: info.sha256 }, data, '1h'), rel).toEqual(JSON.parse(ref.stdout).weights);
        spot += 1;
      } else {
        const data = Object.fromEntries(universe.map((s) => { const b = bars(n, SYMS[s]![0], SYMS[s]![1]); return [s, { bars: b, funding: b.map((x, i) => ({ ts: x.ts, rate: 0.0000125 * Math.sin(i / 7 + SYMS[s]![0]), premium: null })) }]; }));
        const { input } = perpSignal.perpSignalInput(data as never, '1h');
        const ref = legacy(['spq.signal', '--contract', '2', '--strategy', realDir, '--sha256', info.sha256, '--input', '-'], { input });
        expect(ref.status, `${rel}: ${ref.stderr}`).toBe(0);
        const boxed = await lab.labExec(['spq.signal', '--contract', '2', '--strategy', dir, '--sha256', info.sha256, '--input', '-'], { timeoutMs: 120_000, stdin: input, strategyDir: dir });
        expect(boxed.out, rel).toBe(ref.stdout);
        expect((await perpSignal.runPerpSignal({ path: `strategies/${rel}`, sha256: info.sha256 }, data as never, '1h')).weights, rel).toEqual(JSON.parse(ref.stdout).weights);
        perp += 1;
      }
    }
    expect(spot).toBeGreaterThanOrEqual(12); expect(perp).toBeGreaterThanOrEqual(5);
    console.log(`[lab-identity] ${spot} spot + ${perp} perp library strategies: sandboxed signal output byte-identical to the pre-v8 invocation`);
  }, 600_000);

  it('latency of one signal call: sandboxed runner vs the pre-v8 `uv run` (measured)', async () => {
    const rel = 'ma_trend/3', dir = path.join(fx.dir, 'strategies', rel), info = await strategies.describe(rel), data = { BTC: bars(info.meta.lookback + 5, 11, 60_000), ETH: bars(info.meta.lookback + 5, 23, 3000) };
    const last = data.BTC.at(-1)!.ts, input = JSON.stringify({ candles: Object.fromEntries(Object.entries(data).map(([s, b]) => [s, b.map((x) => [Math.floor(x.ts / 1000), x.open, x.high, x.low, x.close, x.volume])])), interval: '1h', as_of: new Date(last).toISOString().replace('.000Z', 'Z') });
    const boxed: number[] = [], old: number[] = [];
    for (let i = 0; i < 7; i++) { const t0 = Date.now(); await live.runSignal({ path: info.path, sha256: info.sha256 }, data, '1h'); boxed.push(Date.now() - t0);
      old.push(legacy(['spq.signal', '--strategy', path.join(REAL_LAB, 'strategies', rel), '--sha256', info.sha256, '--input', '-'], { input, viaUv: true }).ms); }
    void dir;
    console.log(`[lab-identity] one signal call (ma_trend/3, ${info.meta.lookback} bars x 2 symbols), 7 runs: sandboxed median ${median(boxed)} ms (min ${Math.min(...boxed)}, max ${Math.max(...boxed)}); pre-v8 ${UV ? 'uv run' : 'python'} median ${median(old)} ms (min ${Math.min(...old)}, max ${Math.max(...old)})`);
    expect(median(boxed)).toBeLessThan(5000);                             // 0.14 % of a 1 h bar at the very worst
  }, 120_000);
});

describe.skipIf(!READY)('the spot backtest: files exported by the API ≡ the laboratory reading the candles table', () => {
  it('same report (every field but its timestamp), same trial ledger, for two library strategies', async () => {
    for (const rel of ['ma_trend/3', 'ts_momentum/3']) {
      const realDir = path.join(REAL_LAB, 'strategies', rel), info = await strategies.describe(rel), tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-identity-')));
      // before (pre-v8): the laboratory opens the database itself
      const ref = legacy(['spq.backtest', '--strategy', realDir, '--sha256', info.sha256, '--symbols', 'BTC,ETH', '--out', path.join(tmp, 'before.json'), '--ledger', path.join(tmp, 'ledger.jsonl')],
        { env: { DATABASE_URL: process.env.DATABASE_URL!, SPQ_CANDLE_SOURCE: 'coinbase' } });
      expect(ref.status, ref.stderr).toBe(0);
      // after (v8): the real backtest() — export to files, sandbox, no database URL
      rmSync(strategies.LEDGER(), { force: true });
      const agentId = await addAgent(sql, { name: `Identity ${rel}`, state: 'CREATED', universe: ['BTC', 'ETH'] }), vid = randomUUID();
      await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta) values (${vid}, ${agentId}, ${info.meta.name}, ${info.meta.version}, ${info.sha256}, ${info.path}, '{}')`;
      await strategies.backtest(vid, info, ['BTC', 'ETH']);
      const [row] = await sql`select status, notes, report from strategy_versions where id = ${vid}`;
      expect(row.notes, rel).toBe(''); expect(row.report, rel).not.toBeNull();
      const before = JSON.parse(readFileSync(path.join(tmp, 'before.json'), 'utf8')), after = row.report;
      expect(typeof before.generated_at).toBe('string');
      const strip = (r: any) => { const x = structuredClone(r); delete x.generated_at; return x; };
      expect(strip(after), rel).toEqual(strip(before));
      expect(JSON.stringify(strip(after)).length).toBeGreaterThan(2000);
      const led = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => { const j = JSON.parse(l); delete j.at; delete j.ts; delete j.time; return j; });
      expect(led(strategies.LEDGER()), rel).toEqual(led(path.join(tmp, 'ledger.jsonl')));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 600_000);

  it('the trial ledger is written by the API only: lines appended by the process are merged, a rewritten history is not', () => {
    const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-ledger-')));
    rmSync(strategies.LEDGER(), { force: true }); writeFileSync(strategies.LEDGER(), '{"kind":"trial","n":1}\n');
    const a = strategies.stageLedger(scratch); appendFileSync(a.copy, '{"kind":"trial","n":2}\n');
    expect(a.merge()).toBe(true);
    expect(readFileSync(strategies.LEDGER(), 'utf8')).toBe('{"kind":"trial","n":1}\n{"kind":"trial","n":2}\n');
    const b = strategies.stageLedger(scratch); writeFileSync(b.copy, '{"kind":"trial","n":99}\n');          // history rewritten inside the sandbox
    expect(b.merge()).toBe(false);
    expect(readFileSync(strategies.LEDGER(), 'utf8')).toBe('{"kind":"trial","n":1}\n{"kind":"trial","n":2}\n');
    rmSync(scratch, { recursive: true, force: true }); rmSync(strategies.LEDGER(), { force: true });
  });
});
