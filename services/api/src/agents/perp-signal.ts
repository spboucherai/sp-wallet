// Signal runner for perp agents: `python -m spq.signal --contract 2` in a separate process with an almost empty environment
// (no secret, no database URL, UV_OFFLINE), a timeout and a bounded output — exactly the sandbox of the spot runner (live.ts).
// Any deviation throws, and the engine holds.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RESEARCH_DIR } from './live.ts';
import type { PerpInterval, PerpSeries } from './perp-data.ts';
import type { PerpSignal } from './perp-engine.ts';

const UV = process.env.SPW_UV_BIN ?? 'uv';
const SIGNAL_TIMEOUT_MS = 60_000;

/** signal-input-v2: candles + funding per perpetual; nothing dated after the last closed bar's open */
export function perpSignalInput(data: Record<string, PerpSeries>, interval: PerpInterval): { input: string; last: number } {
  const syms = Object.keys(data);
  if (!syms.length) throw new Error('no series');
  const first = data[syms[0]!]!, last = first.bars.at(-1)?.ts;
  if (last === undefined || syms.some((s) => data[s]!.bars.at(-1)?.ts !== last || data[s]!.bars.length !== first.bars.length)) throw new Error('series are not aligned on the same closed bars');
  const candles = Object.fromEntries(syms.map((s) => [s, data[s]!.bars.map((b) => [Math.floor(b.ts / 1000), b.open, b.high, b.low, b.close, b.volume])]));
  const funding = Object.fromEntries(syms.map((s) => [s, data[s]!.funding.filter((f) => f.ts <= last).map((f) => (f.premium === null ? [Math.floor(f.ts / 1000), f.rate] : [Math.floor(f.ts / 1000), f.rate, f.premium]))]));
  return { input: JSON.stringify({ candles, funding, interval, as_of: new Date(last).toISOString().replace('.000Z', 'Z') }), last };
}

export function runPerpSignal(strategy: { path: string; sha256: string }, data: Record<string, PerpSeries>, interval: PerpInterval): Promise<PerpSignal> {
  const dir = path.resolve(RESEARCH_DIR, strategy.path);
  if (!dir.startsWith(path.join(RESEARCH_DIR, 'strategies') + path.sep) || !existsSync(path.join(dir, 'strategy.py'))) return Promise.reject(new Error('strategy directory is not inside research/strategies'));
  if (!/^[0-9a-f]{64}$/.test(strategy.sha256)) return Promise.reject(new Error('bad strategy hash'));
  let built: { input: string; last: number };
  try { built = perpSignalInput(data, interval); } catch (e) { return Promise.reject(e as Error); }
  const { input, last } = built;
  return new Promise((resolve, reject) => {
    const home = process.env.HOME ?? '/tmp';
    const env = { PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, UV_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' }; // no secrets, no database URL
    const ch = spawn(UV, ['run', '--frozen', '--no-sync', 'python', '-m', 'spq.signal', '--contract', '2', '--strategy', dir, '--sha256', strategy.sha256, '--input', '-'], { cwd: RESEARCH_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (e: Error | null, v?: PerpSignal) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(v!); };
    const timer = setTimeout(() => { ch.kill('SIGKILL'); finish(new Error('signal timed out')); }, SIGNAL_TIMEOUT_MS);
    ch.stdout.on('data', (c: Buffer) => { out += c; if (out.length > 100_000) { ch.kill('SIGKILL'); finish(new Error('signal output too large')); } });
    ch.stderr.on('data', (c: Buffer) => { if (err.length < 2000) err += c; });
    ch.on('error', (e) => finish(new Error(`signal runner could not start: ${e.message}`)));
    ch.on('close', (code) => {
      if (code !== 0) return finish(new Error(`signal exit ${code}: ${err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`));
      try {
        const j = JSON.parse(out) as { schema_version?: number; kind?: string; strategy_sha256?: string; as_of?: string; weights?: Record<string, number>; max_leverage?: number; max_gross_exposure?: number };
        if (j.schema_version !== 2 || j.kind !== 'perp') throw new Error('not a contract-2 (perp) signal');
        if (j.strategy_sha256 !== strategy.sha256) throw new Error('signal computed by another strategy hash');
        if (!j.as_of || Date.parse(j.as_of) !== last) throw new Error('signal is not for the last closed bar');
        if (!j.weights || typeof j.weights !== 'object' || typeof j.max_leverage !== 'number' || typeof j.max_gross_exposure !== 'number') throw new Error('no weights or no leverage bounds');
        finish(null, { weights: j.weights, maxLeverage: j.max_leverage, maxGrossExposure: j.max_gross_exposure });
      } catch (e) { finish(new Error(`unreadable signal: ${(e as Error).message}`)); }
    });
    ch.stdin.on('error', () => {}); ch.stdin.end(input);
  });
}
