// V8 hardening — the ONE way the API starts a laboratory process (anything that imports or runs a strategy.py: the spot and
// perp signal runners, describe, the spot and perp backtests, the research evaluation, and the data helpers around them).
//
// Every call is one Python interpreter inside the deny-default macOS sandbox of @spw/core `labSandboxProfile`:
//   network   none (no loopback port, no Unix socket, no DNS) — data arrive on stdin or as files prepared by the API;
//   files     read: the laboratory's code (research/src, research/schema), its virtualenv, the interpreter's install prefix,
//             the ONE strategy directory of the call, the caller's read-only data; write: one scratch directory, fresh per call
//             (or owned by the caller when it needs the files afterwards), removed afterwards. Not the application checkout
//             beyond those research/ paths, not the home directory, not /tmp at large, not the PostgreSQL socket;
//   process   no fork / posix_spawn / exec of anything else: nothing can outlive the call, no helper program can be started;
//             other processes (their arguments, their ENVIRONMENT) are invisible;
//   limits    wall-clock timeout → SIGKILL of the process group; CPU seconds and written-file size by rlimit (set by a
//             /bin/sh wrapper OUTSIDE the sandbox, inherited across exec); resident memory by a watchdog of this process
//             (macOS refuses RLIMIT_AS / RLIMIT_DATA / RLIMIT_RSS: measured, see docs/v8/SANDBOX.md); bounded output.
//   env       built from nothing: no secret, no database URL, HOME and TMPDIR = the scratch directory.
//
// FAIL CLOSED. If sandbox-exec does not exist, the interpreter is missing, or the profile does not apply (start-up self-test,
// repeated after any sandbox error), `labExec` throws `LabUnavailable`: no signal is computed (the engine holds), no backtest
// runs. The only way around is the explicit development switch SPW_LAB_SANDBOX=off (default: on), which is logged loudly and
// reported by `labStatus()` (monitoring screen, alert `system.lab_sandbox_off`).
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { labSandboxProfile, SANDBOX_EXEC } from '@spw/core';

// the bundled server runs from the repository root (dist/api.mjs); from source the module sits four levels below it
export const RESEARCH_DIR = path.resolve(process.env.SPW_RESEARCH_DIR ?? [path.join(process.cwd(), 'research'), path.join(import.meta.dirname, '../../../../research')].find((d) => existsSync(path.join(d, 'pyproject.toml'))) ?? path.join(process.cwd(), 'research'));
export const labPython = (): string => process.env.SPW_RESEARCH_PYTHON ?? path.join(RESEARCH_DIR, '.venv/bin/python');

/** resident-memory ceiling of one signal call (a signal works on at most a few thousand bars) */
export const SIGNAL_MAX_RSS_MB = Number(process.env.SPW_LAB_SIGNAL_MAX_RSS_MB) || 2048;

export type LabSandboxKind = 'sandbox-exec' | 'none';
export interface LabResult { code: number | null; out: string; err: string; sandbox: LabSandboxKind;
  /** why this process killed the child, if it did */
  killed: 'timeout' | 'memory' | 'output' | null; ms: number }
export class LabUnavailable extends Error {
  code = 'lab_sandbox_unavailable';
  constructor(reason: string) { super(`the strategy sandbox is not available (${reason}); nothing was run`); }
}

export interface LabStatus {
  /** 'sandbox-exec' = confined; 'off' = the development switch is set (NOT confined); 'unavailable' = nothing runs */
  mode: 'sandbox-exec' | 'off' | 'unavailable';
  ok: boolean; reason: string | null; python: string; checkedAt: number | null;
  /** last sandbox error seen on a real call */
  lastFailureAt: number | null; lastFailure: string | null; calls: number; refused: number;
}
const ESCAPE = (): boolean => process.env.SPW_LAB_SANDBOX === 'off';
const state: { checkedAt: number | null; ok: boolean; reason: string | null; lastFailureAt: number | null; lastFailure: string | null; calls: number; refused: number; warned: boolean; testing: Promise<void> | null } =
  { checkedAt: null, ok: false, reason: 'not checked yet', lastFailureAt: null, lastFailure: null, calls: 0, refused: 0, warned: false, testing: null };
const SELFTEST_EVERY_MS = 10 * 60_000;

function symlinksOnPath(p: string): string[] {
  const out: string[] = []; let todo = path.resolve(p).split(path.sep).filter(Boolean), cur: string = path.sep, hops = 0;
  while (todo.length) {
    const next = path.join(cur, todo.shift()!);
    let st; try { st = lstatSync(next); } catch { break; }
    if (st.isSymbolicLink() && hops++ < 40) { out.push(next); todo = [...path.resolve(cur, readlinkSync(next)).split(path.sep).filter(Boolean), ...todo]; cur = path.sep; } else cur = next;
  }
  return out;
}
const up = (p: string, n: number): string => { let x = p; for (let i = 0; i < n; i++) x = path.dirname(x); return x; };

export interface LabOpts {
  timeoutMs: number;
  /** written to the child's stdin (the signal input) */
  stdin?: string;
  /** the strategy version directory this call may read (and nothing else under research/strategies) */
  strategyDir?: string;
  /** extra read-only paths (data prepared by the API) */
  readable?: string[];
  /** a caller-owned scratch directory (canonical path; the caller removes it). Default: a fresh one, removed after the call. */
  scratch?: string;
  /** stdout bound; beyond it the child is killed ('kill', the signal runner) or the rest is dropped ('truncate') */
  maxOut?: number; onOverflow?: 'kill' | 'truncate';
  /** resident-memory ceiling enforced by the watchdog (default SPW_LAB_MAX_RSS_MB or 4096) */
  maxRssMb?: number;
}

/** paths of the laboratory installation, canonical. Throws when the interpreter is missing. */
function labPaths(): { python: string; real: string; lab: string; readable: string[]; exec: string[]; homebrew: boolean } {
  const python = labPython();
  if (!existsSync(python)) throw new LabUnavailable(`the laboratory's interpreter is missing: ${python} (run \`uv sync --frozen\` in research/)`);
  const real = realpathSync(python), lab = realpathSync(RESEARCH_DIR), links = symlinksOnPath(python);
  const venv = up(path.resolve(python), 2), prefix = up(real, 2);
  const readable = [path.join(lab, 'src'), path.join(lab, 'schema'), existsSync(venv) ? realpathSync(venv) : venv, prefix, ...links].filter((p) => existsSync(p));
  return { python, real, lab, readable, exec: [...new Set([real, path.resolve(python), ...links])], homebrew: /^\/(opt\/homebrew|usr\/local)\//.test(real) };
}
const childEnv = (lab: string, scratch: string): Record<string, string> => ({ PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, PYTHONPATH: path.join(lab, 'src'), PYTHONDONTWRITEBYTECODE: '1',
  JOBLIB_MULTIPROCESSING: '0', MPLCONFIGDIR: scratch, LANG: 'en_US.UTF-8', UV_OFFLINE: '1' });

// rlimits are set by /bin/sh BEFORE sandbox-exec (they survive exec); a limit that cannot be set stops the call (exit 70)
const WRAPPER = 'ulimit -t "$1" || exit 70; ulimit -f "$2" || exit 70; shift 2; exec "$@"';
const SANDBOX_ERR = /^sandbox-exec: /m;

function rssMb(pid: number): Promise<number | null> {
  return new Promise((resolve) => { execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 3000 }, (e, out) => { const kb = Number(String(out).trim()); resolve(e || !Number.isFinite(kb) ? null : kb / 1024); }); });
}

function run(argv: string[], env: Record<string, string>, cwd: string, o: LabOpts, sandbox: LabSandboxKind): Promise<LabResult> {
  const cpu = Math.max(60, Math.ceil((o.timeoutMs / 1000) * 4)), fileBlocks = 2 * 1024 * 1024; // CPU seconds over all threads; one file ≤ 2 GiB (1024-byte blocks in /bin/sh)
  const maxOut = o.maxOut ?? 2_000_000, maxRss = o.maxRssMb ?? (Number(process.env.SPW_LAB_MAX_RSS_MB) || 4096), t0 = Date.now();
  return new Promise((resolve) => {
    const ch = spawn('/bin/sh', ['-c', WRAPPER, 'spw-lab', String(cpu), String(fileBlocks), ...argv], { cwd, env, stdio: [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    let out = '', err = '', killed: LabResult['killed'] = null, done = false;
    const kill = (why: NonNullable<LabResult['killed']>): void => { if (done || killed) return; killed = why; try { process.kill(-ch.pid!, 'SIGKILL'); } catch { ch.kill('SIGKILL'); } };
    const timer = setTimeout(() => kill('timeout'), o.timeoutMs);
    const watch = setInterval(() => { if (ch.pid) void rssMb(ch.pid).then((mb) => { if (mb !== null && mb > maxRss) kill('memory'); }); }, 1000);
    const finish = (code: number | null, extra = ''): void => { if (done) return; done = true; clearTimeout(timer); clearInterval(watch); resolve({ code, out, err: err + extra, sandbox, killed, ms: Date.now() - t0 }); };
    ch.stdout!.on('data', (c: Buffer) => { if (out.length < maxOut) out += c; else if ((o.onOverflow ?? 'truncate') === 'kill') kill('output'); });
    ch.stderr!.on('data', (c: Buffer) => { err = (err + c).slice(-4000); });
    ch.on('error', (e) => finish(null, `could not start: ${e.message}`));
    ch.on('close', (code) => finish(code));
    if (o.stdin !== undefined) { ch.stdin!.on('error', () => {}); ch.stdin!.end(o.stdin); }
  });
}

/** Does the profile really confine? One tiny interpreter run that must (a) start, (b) be refused the home directory, a
 *  network socket and a fork. Anything else = unavailable. */
async function selfTest(): Promise<void> {
  const now = Date.now();
  try {
    if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) throw new LabUnavailable(`${SANDBOX_EXEC} does not exist on this platform (${process.platform})`);
    const p = labPaths(), scratch = scratchDir();
    try {
      const probe = 'import os,socket,sys\nr=[]\n'
        + 'for n,f in (("home",lambda:os.listdir(os.environ["SPW_PROBE_HOME"])),("net",lambda:socket.create_connection(("127.0.0.1",9),1)),("fork",lambda:os.fork() or os._exit(0)),("write",lambda:open(os.environ["SPW_PROBE_HOME"]+"/.spw-lab-probe","w"))):\n'
        + '    try:\n        f(); r.append(n)\n    except PermissionError:\n        pass\n    except OSError as e:\n        r.append(n+":"+str(e.errno))\nprint("LEAK "+",".join(r) if r else "CONFINED")\n';
      const profile = labSandboxProfile({ scratch, readable: p.readable, exec: p.exec, homebrew: p.homebrew });
      const r = await run([SANDBOX_EXEC, '-p', profile, p.python, '-P', '-s', '-B', '-c', probe], { ...childEnv(p.lab, scratch), SPW_PROBE_HOME: process.env.HOME ?? '/Users' }, scratch, { timeoutMs: 30_000 }, 'sandbox-exec');
      if (r.code !== 0 || r.out.trim() !== 'CONFINED') throw new LabUnavailable(r.out.startsWith('LEAK') ? `the profile does not confine: ${r.out.trim().slice(0, 80)}` : `the profile could not be applied: ${(r.err.trim().split('\n').pop() ?? `exit ${r.code}`).slice(0, 160)}`);
    } finally { dropScratch(scratch); }
    state.ok = true; state.reason = null;
  } catch (e) { state.ok = false; state.reason = (e as Error).message.replace(/^the strategy sandbox is not available \((.*)\); nothing was run$/, '$1').slice(0, 300); }
  state.checkedAt = now;
}
async function ensureChecked(force = false): Promise<void> {
  if (!force && state.checkedAt !== null && Date.now() - state.checkedAt < SELFTEST_EVERY_MS && state.ok) return;
  if (!force && state.checkedAt !== null && !state.ok && Date.now() - state.checkedAt < 30_000) return; // a broken sandbox is re-tested at most every 30 s
  state.testing ??= selfTest().finally(() => { state.testing = null; });
  await state.testing;
}

/** Health of the confinement (monitoring, alerts, start-up log). `refresh` re-runs the self-test now. */
export async function labStatus(refresh = false): Promise<LabStatus> {
  await ensureChecked(refresh);
  const off = ESCAPE();
  return { mode: off ? 'off' : state.ok ? 'sandbox-exec' : 'unavailable', ok: !off && state.ok, reason: off ? 'SPW_LAB_SANDBOX=off: strategy code runs WITHOUT OS confinement (development only)' : state.reason,
    python: labPython(), checkedAt: state.checkedAt, lastFailureAt: state.lastFailureAt, lastFailure: state.lastFailure, calls: state.calls, refused: state.refused };
}
/** tests: forget the cached self-test */
export const resetLabStatus = (): void => { state.checkedAt = null; state.ok = false; state.reason = 'not checked yet'; state.warned = false; };

/** Run `python -m <args>` of the laboratory, confined. Throws LabUnavailable (nothing ran) when it cannot be confined. */
export async function labExec(args: string[], o: LabOpts): Promise<LabResult> {
  state.calls += 1;
  const own = o.scratch === undefined, scratch = own ? scratchDir() : realpathSync(o.scratch!);
  try {
    if (ESCAPE()) {
      // explicit development switch: same interpreter, same empty environment, same limits — but NO OS confinement
      if (!state.warned) { state.warned = true; console.warn('[lab] SPW_LAB_SANDBOX=off — strategy code runs WITHOUT the OS sandbox. Development only; never set this on a machine that holds funds.'); }
      const p = labPaths();
      return await run([p.python, '-P', '-s', '-B', '-m', ...args], childEnv(p.lab, scratch), scratch, o, 'none');
    }
    await ensureChecked();
    if (!state.ok) { state.refused += 1; throw new LabUnavailable(state.reason ?? 'unknown'); }
    const p = labPaths();
    const readable = [...p.readable, ...(o.strategyDir ? [realpathSync(o.strategyDir)] : []), ...(o.readable ?? []).map((x) => realpathSync(x))];
    const profile = labSandboxProfile({ scratch, readable, exec: p.exec, homebrew: p.homebrew });
    const r = await run([SANDBOX_EXEC, '-p', profile, p.python, '-P', '-s', '-B', '-m', ...args], childEnv(p.lab, scratch), scratch, o, 'sandbox-exec');
    if ((r.code === 70 && !r.out) || (r.code !== 0 && !r.out && SANDBOX_ERR.test(r.err))) {
      // the wrapper or sandbox-exec itself failed: the interpreter never started confined. Re-test before the next call.
      state.lastFailureAt = Date.now(); state.lastFailure = (r.err.trim().split('\n').pop() ?? `exit ${r.code}`).slice(0, 200); state.refused += 1;
      await ensureChecked(true);
      throw new LabUnavailable(state.lastFailure);
    }
    return r;
  } finally { if (own) dropScratch(scratch); }
}

export const scratchDir = (): string => realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-lab-')));
export const dropScratch = (dir: string): void => { rmSync(dir, { recursive: true, force: true }); };
export const lastLine = (s: string, max = 300): string => (s.trim().split('\n').pop() ?? '').slice(0, max);
