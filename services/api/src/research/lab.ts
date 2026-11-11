// V7 research runtime — how the API runs the laboratory on anything that comes from a research job.
//
// A submitted strategy is code written by an AI agent. Before the owner has approved it, the API executes it only through
// this module: a child process with the minimal environment of the existing laboratory calls (no wallet secret, NO database
// URL at all — the data are files) and, where the platform has one, the OS sandbox of @spw/core/research-sandbox:
// no network of any kind, read access limited to the laboratory and the job's data, write access to one scratch directory.
// On a platform without sandbox-exec the process still has the minimal environment and the result says `sandbox: 'none'`.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_EXEC, sandboxProfile } from '@spw/core';
import { RESEARCH_DIR } from '../agents/live.ts';
import { py } from '../agents/strategies.ts';

export interface LabResult { code: number | null; out: string; err: string; sandbox: 'sandbox-exec' | 'none' }
export const labPython = (): string => process.env.SPW_RESEARCH_PYTHON ?? path.join(RESEARCH_DIR, '.venv/bin/python');
export const labSandboxAvailable = (): boolean => process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && existsSync(labPython()) && process.env.SPW_RESEARCH_SANDBOX !== 'off';

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

/** Run `python -m <args>` of the laboratory. `scratch` is the only writable directory (and the cwd); `readable` are extra
 *  read-only paths (the job's data, a staging directory). Never throws. */
export function labRun(args: string[], o: { timeoutMs: number; scratch: string; readable?: string[] }): Promise<LabResult> {
  if (!labSandboxAvailable()) return py(args, { timeoutMs: o.timeoutMs }).then((r) => ({ ...r, sandbox: 'none' as const })); // minimal environment, no OS confinement
  const python = labPython(), scratch = realpathSync(o.scratch), lab = realpathSync(RESEARCH_DIR);
  const readable = [path.join(lab, 'src'), path.join(lab, 'schema'), path.join(lab, 'strategies'), realpathSync(up(python, 2)), up(realpathSync(python), 2), ...symlinksOnPath(python),
    ...(o.readable ?? []).map((p) => realpathSync(p))].filter((p) => existsSync(p));
  const profile = path.join(scratch, '.lab.sb');
  writeFileSync(profile, sandboxProfile({ writable: [scratch], readable, localPorts: [] }), { mode: 0o600 });
  return new Promise((resolve) => {
    const ch = spawn(SANDBOX_EXEC, ['-f', profile, python, '-m', ...args], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${path.dirname(python)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: scratch, PYTHONPATH: path.join(lab, 'src'), PYTHONDONTWRITEBYTECODE: '1', JOBLIB_MULTIPROCESSING: '0', MPLCONFIGDIR: scratch, LANG: 'en_US.UTF-8' } });
    let out = '', err = '';
    const timer = setTimeout(() => ch.kill('SIGKILL'), o.timeoutMs);
    ch.stdout.on('data', (c: Buffer) => { if (out.length < 2_000_000) out += c; });
    ch.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-4000); });
    ch.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: `could not start: ${e.message}`, sandbox: 'sandbox-exec' }); });
    ch.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, sandbox: 'sandbox-exec' }); });
  });
}

export const scratchDir = (): string => realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-research-')));
export const dropScratch = (dir: string): void => { rmSync(dir, { recursive: true, force: true }); };
export const lastLine = (s: string, max = 300): string => (s.trim().split('\n').pop() ?? '').slice(0, max);
