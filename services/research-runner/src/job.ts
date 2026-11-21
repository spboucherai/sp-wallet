/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/research-runner/src/job.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// One research job, from a claimed job to a result: prepare the job directory, launch the coding agent under the OS
// sandbox, enforce the owner's budgets from outside, collect the submission.
//
//   <jobsRoot>/<id>/ro/   read-only for the agent: lab/ (laboratory code), data/ (candles), JOB.json, CLAUDE.md
//   <jobsRoot>/<id>/rw/   read-write: work/ (cwd; work/submission/ is what is handed in), ledger/, tmp/, home/
//   <stateRoot>/<id>/     the runner's own: ledger.jsonl (append-only copy), profile.sb — outside the agent's reach
//
// The agent's environment holds no secret: PATH, HOME and TMPDIR inside rw/, the laboratory's paths, and the address of the
// job's model gateway with a placeholder key. Nothing of the runner's own environment is inherited.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_LEDGER_BYTES, MAX_LOG_LINE, SUBMISSION_FILES, type RunnerJob, type RunnerResult, type RunnerUsage, type SubmissionFileName } from '@spw/core/research-job';
import { SANDBOX_EXEC, sandboxProfile } from '@spw/core/research-sandbox';
import { jobBrief, kickoffPrompt } from './brief.ts';
import type { RunnerConfig } from './config.ts';
import { ModelGateway } from './gateway.ts';
import { LedgerTail } from './ledger.ts';

export interface JobHooks {
  log(stream: 'out' | 'err' | 'sys', text: string): void;
  /** the agent process started */
  running(): void;
  /** the owner asked to cancel (learned from the API when log lines are pushed) */
  cancelRequested(): boolean;
}
export const sandboxAvailable = (): boolean => process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

export interface JobPaths { job: string; ro: string; rw: string; work: string; submission: string; ledger: string; state: string; ledgerCopy: string; profile: string }
export function jobPaths(cfg: Pick<RunnerConfig, 'jobsRoot' | 'stateRoot'>, id: string): JobPaths {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad job id');
  const job = path.join(cfg.jobsRoot, id), rw = path.join(job, 'rw'), state = path.join(cfg.stateRoot, id);
  return { job, ro: path.join(job, 'ro'), rw, work: path.join(rw, 'work'), submission: path.join(rw, 'work', 'submission'), ledger: path.join(rw, 'ledger', 'trials.jsonl'),
    state, ledgerCopy: path.join(state, 'ledger.jsonl'), profile: path.join(state, 'profile.sb') };
}

const sh = (cmd: string, args: string[], o: { cwd?: string; input?: Buffer } = {}): Promise<{ code: number | null; out: Buffer; err: string }> => new Promise((resolve) => {
  const ch = spawn(cmd, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' } });
  const out: Buffer[] = []; let err = '';
  ch.stdout.on('data', (c: Buffer) => out.push(c)); ch.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-2000); });
  ch.on('error', (e) => resolve({ code: null, out: Buffer.concat(out), err: e.message }));
  ch.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
  ch.stdin.on('error', () => {}); ch.stdin.end(o.input);
});

const LAB_PARTS = ['src', 'schema', 'strategies', 'README.md', 'pyproject.toml', 'uv.lock'];
/** Put the laboratory at the pinned commit into `dest`. Returns the commit that was used (null: an unpinned copy of the directory). */
export async function installLab(cfg: Pick<RunnerConfig, 'labDir' | 'labPin'>, commit: string | null, dest: string): Promise<string | null> {
  mkdirSync(dest, { recursive: true });
  if (cfg.labPin === 'worktree') {
    if (commit) throw new Error(`this job is pinned to laboratory commit ${commit}, but this runner copies its working tree (SPW_RUNNER_LAB_PIN=worktree): refusing`);
    for (const part of LAB_PARTS) if (existsSync(path.join(cfg.labDir, part))) cpSync(path.join(cfg.labDir, part), path.join(dest, part), { recursive: true, filter: (src) => !/(__pycache__|\.pytest_cache)/.test(src) });
    return null;
  }
  const git = (args: string[]) => sh('git', ['-C', cfg.labDir, ...args]);
  const prefix = (await git(['rev-parse', '--show-prefix'])).out.toString().trim();
  const head = await git(['rev-parse', commit ?? 'HEAD']);
  if (head.code !== 0) throw new Error(`the laboratory checkout does not have commit ${commit ?? 'HEAD'}: ${head.err.trim().slice(0, 160)}`);
  const sha = head.out.toString().trim();
  // the prepared virtualenv was built from the checkout's uv.lock: a job pinned to a commit with other dependencies must not run on it
  const lock = await git(['show', `${sha}:${prefix}uv.lock`]);
  if (lock.code !== 0 || createHash('sha256').update(lock.out).digest('hex') !== createHash('sha256').update(readFileSync(path.join(cfg.labDir, 'uv.lock'))).digest('hex'))
    throw new Error(`the laboratory environment of this runner was not built for commit ${sha.slice(0, 12)} (uv.lock differs): run uv sync on that commit first`);
  const tar = await git(['archive', '--format=tar', `${sha}:${prefix.replace(/\/$/, '') || '.'}`, ...LAB_PARTS]);
  if (tar.code !== 0) throw new Error(`git archive failed: ${tar.err.trim().slice(0, 160)}`);
  const x = await sh('tar', ['-x', '-C', dest], { input: tar.out });
  if (x.code !== 0) throw new Error(`could not unpack the laboratory: ${x.err.trim().slice(0, 160)}`);
  return sha;
}

/** every symbolic link met while resolving `p` (a venv's python → a versioned alias → the real interpreter): the sandbox must
 *  let the process read each link itself, not only the final target */
export function symlinksOnPath(p: string): string[] {
  const out: string[] = []; let todo = path.resolve(p).split(path.sep).filter(Boolean), cur: string = path.sep, hops = 0;
  while (todo.length) {
    const next = path.join(cur, todo.shift()!);
    let st; try { st = lstatSync(next); } catch { break; }
    if (st.isSymbolicLink() && hops++ < 40) { out.push(next); const target = path.resolve(cur, readlinkSync(next)); todo = [...target.split(path.sep).filter(Boolean), ...todo]; cur = path.sep; }
    else cur = next;
  }
  return out;
}
/** read-only toolchain paths the sandbox must allow: the virtualenv, the real interpreter behind it, the agent's program */
export function toolchain(cfg: Pick<RunnerConfig, 'python' | 'readable' | 'agent'>): string[] {
  const up = (p: string, n: number): string => { let x = p; for (let i = 0; i < n; i++) x = path.dirname(x); return x; };
  const out = new Set<string>(cfg.readable.map((p) => realpathSync(p)));
  out.add(realpathSync(up(cfg.python, 2)));                              // <venv>
  out.add(up(realpathSync(cfg.python), 2));                              // the interpreter's installation
  for (const l of symlinksOnPath(cfg.python)) out.add(l);
  const bin = cfg.agent.kind === 'claude' ? cfg.agent.bin : cfg.agent.argv[0];
  if (bin && existsSync(bin)) { out.add(up(realpathSync(bin), 2)); for (const l of symlinksOnPath(bin)) out.add(l); }
  return [...out];
}

const setTree = (root: string, dirMode: number, fileMode: number): void => {
  const walk = (p: string): void => { const st = lstatSync(p); if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { chmodSync(p, 0o700); for (const e of readdirSync(p)) walk(path.join(p, e)); chmodSync(p, dirMode); } else chmodSync(p, fileMode); };
  if (existsSync(root)) walk(root);
};
/** bytes and entries under a directory (no symlink is followed) */
export function diskUsage(root: string, maxEntries = 200_000): { bytes: number; entries: number } {
  let bytes = 0, entries = 0;
  const walk = (p: string): void => { let st; try { st = lstatSync(p); } catch { return; }
    entries += 1; if (entries > maxEntries) return;
    if (st.isDirectory()) { let list: string[] = []; try { list = readdirSync(p); } catch { /* unreadable: counted as empty */ } for (const e of list) walk(path.join(p, e)); } else bytes += st.blocks ? st.blocks * 512 : st.size; };
  walk(root);
  return { bytes, entries };
}

/** Read the submission directory with the runner's own privileges — so every file is opened without following links, must be
 *  a regular file with ONE link (a hard link to a file elsewhere is refused), within its size limit, and one of the expected names. */
export function collectSubmission(dir: string): { path: SubmissionFileName; b64: string }[] {
  let st; try { st = lstatSync(dir); } catch { throw new Error('no submission directory'); }
  if (!st.isDirectory()) throw new Error('submission is not a directory');
  const names = readdirSync(dir).sort(), files: { path: SubmissionFileName; b64: string }[] = [];
  for (const name of names) if (!(name in SUBMISSION_FILES)) throw new Error(`unexpected file in the submission: ${JSON.stringify(name.slice(0, 60))} (only ${Object.keys(SUBMISSION_FILES).join(', ')})`);
  for (const [name, spec] of Object.entries(SUBMISSION_FILES) as [SubmissionFileName, { max: number; required: boolean }][]) {
    if (!names.includes(name)) { if (spec.required) throw new Error(`the submission has no ${name}`); continue; }
    let fd: number;
    try { fd = openSync(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new Error(`${name} cannot be opened as a regular file (a link?)`); }
    try {
      const f = fstatSync(fd);
      if (!f.isFile()) throw new Error(`${name} is not a regular file`);
      if (f.nlink !== 1) throw new Error(`${name} has ${f.nlink} hard links: refused`);
      if (f.size > spec.max) throw new Error(`${name} is ${f.size} bytes (limit ${spec.max})`);
      if (f.size === 0) throw new Error(`${name} is empty`);
      const buf = Buffer.alloc(f.size); let got = 0;
      while (got < f.size) { const n = readSync(fd, buf, got, f.size - got, got); if (n <= 0) break; got += n; }
      files.push({ path: name, b64: buf.subarray(0, got).toString('base64') });
    } finally { closeSync(fd); }
  }
  return files;
}

/** One line of the Claude Code `stream-json` output → a line of the job log (and the cost the CLI reports at the end). */
export function describeStreamEvent(line: string): { text: string | null; costUsd: number | null } {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return { text: line, costUsd: null }; }
  if (!ev || typeof ev !== 'object') return { text: line, costUsd: null };
  const clip = (s: unknown, n = 400): string => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  if (ev.type === 'system') return { text: ev.subtype === 'init' ? `agent started (model ${clip(ev.model, 60)}, tools ${clip((ev.tools ?? []).join(','), 200)})` : null, costUsd: null };
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const parts: string[] = [];
    for (const c of ev.message.content) {
      if (c?.type === 'text' && c.text) parts.push(`agent: ${clip(c.text, 1200)}`);
      else if (c?.type === 'tool_use') parts.push(`tool ${clip(c.name, 30)}: ${clip(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? JSON.stringify(c.input ?? {}), 500)}`);
    }
    return { text: parts.length ? parts.join('\n') : null, costUsd: null };
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const parts: string[] = [];
    for (const c of ev.message.content) if (c?.type === 'tool_result') parts.push(`  → ${c.is_error ? 'ERROR ' : ''}${clip(typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x?.text ?? '').join(' '), 500)}`);
    return { text: parts.length ? parts.join('\n') : null, costUsd: null };
  }
  if (ev.type === 'result') { const cost = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
    return { text: `agent finished: ${clip(ev.subtype, 40)}${ev.is_error ? ' (error)' : ''}, ${Number(ev.num_turns ?? 0)} turns${cost === null ? '' : `, ${cost.toFixed(4)} USD reported by the CLI`}`, costUsd: cost }; }
  return { text: null, costUsd: null };
}

export function agentArgv(cfg: RunnerConfig, job: RunnerJob, p: JobPaths): string[] {
  const prompt = kickoffPrompt(job, { ro: p.ro, work: p.work, python: cfg.python });
  if (cfg.agent.kind === 'command') return cfg.agent.argv.map((a) => a.replaceAll('{work}', p.work).replaceAll('{ro}', p.ro).replaceAll('{prompt}', prompt));
  // Claude Code, headless (`claude --help`, 2.1.x):
  //   -p / --output-format stream-json --verbose   non-interactive, one JSON event per line
  //   --bare                    no hooks, plugins, auto-memory, CLAUDE.md discovery, and NO keychain / OAuth read: the only
  //                             credential it would accept is ANTHROPIC_API_KEY — here a placeholder for the job's gateway
  //   --tools / --allowedTools  the built-in tools that exist for this run, all pre-approved; nothing else can be approved:
  //   --permission-mode dontAsk + --permission-prompts none   anything that would prompt is denied (unattended)
  //   --strict-mcp-config (no MCP server), --disable-slash-commands, --no-session-persistence
  //   --max-budget-usd          the CLI's own spend cap (a convenience: the runner's gateway and clock are the enforcement)
  const tools = job.tools.join(',');
  return [cfg.agent.bin, '-p', prompt, '--bare', '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', path.join(p.ro, 'CLAUDE.md'),
    '--tools', tools, '--allowedTools', tools, '--disallowedTools', 'WebFetch,WebSearch', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-budget-usd', String(job.budgets.maxModelUsd),
    ...(cfg.agent.model ? ['--model', cfg.agent.model] : [])];
}

export async function runJob(job: RunnerJob, cfg: RunnerConfig, hooks: JobHooks): Promise<RunnerResult> {
  const p = jobPaths(cfg, job.id), t0 = Date.now();
  const usage: RunnerUsage = { wallMs: 0, trials: 0, diskMb: 0, modelTokens: 0, modelRequests: 0, modelUsd: null, ledgerTampered: false, sandbox: 'none', agent: cfg.agent.kind === 'claude' ? 'claude-code' : 'command', labCommit: null, exitCode: null, signal: null };
  const sys = (t: string): void => hooks.log('sys', t);
  let gateway: ModelGateway | null = null, ledger: LedgerTail | null = null;
  const ledgerText = (): string => { try { return readFileSync(p.ledgerCopy, 'utf8').slice(0, MAX_LEDGER_BYTES); } catch { return ''; } };
  const finish = (r: { outcome: 'failed' | 'cancelled' | 'over_budget'; reason: string }): RunnerResult => {
    usage.wallMs = Date.now() - t0; if (ledger) { ledger.sync(); usage.trials = ledger.lines; usage.ledgerTampered = ledger.tampered; }
    sys(`job ${r.outcome}: ${r.reason}`);
    return { outcome: r.outcome, usage, reason: r.reason.slice(0, 600), ledger: ledgerText() };
  };
  try {
    // ---- preparing
    const confined = sandboxAvailable();
    if (!confined && cfg.sandbox === 'required') return finish({ outcome: 'failed', reason: 'this runner has no OS sandbox (sandbox-exec) and is configured to require one: the job was not started' });
    usage.sandbox = confined ? 'sandbox-exec' : 'none';
    if (existsSync(p.job)) return finish({ outcome: 'failed', reason: 'a job directory with this id already exists on the runner' });
    for (const d of [cfg.jobsRoot, cfg.stateRoot, p.state, p.ro, p.work, p.submission, path.join(p.work, 'candidates'), path.dirname(p.ledger), path.join(p.rw, 'tmp'), path.join(p.rw, 'home')]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const real = { job: realpathSync(p.job), ro: realpathSync(p.ro), rw: realpathSync(p.rw), lab: realpathSync(cfg.labDir) };
    // the job directory is never inside the laboratory checkout (an application checkout), nor the reverse
    if (real.job.startsWith(real.lab + path.sep) || real.lab.startsWith(real.job + path.sep) || real.job.startsWith(path.dirname(real.lab) + path.sep)) return finish({ outcome: 'failed', reason: 'the jobs directory is inside an application checkout: refusing to run' });
    usage.labCommit = await installLab(cfg, job.labCommit, path.join(p.ro, 'lab'));
    sys(`laboratory ${usage.labCommit ? `at commit ${usage.labCommit.slice(0, 12)}` : 'copied from the working tree (unpinned)'}`);
    const dataDir = path.join(real.ro, 'data'), tools = toolchain(cfg);
    const baseEnv: Record<string, string> = { PATH: `${path.dirname(cfg.python)}:/usr/bin:/bin`, HOME: path.join(real.rw, 'home'), TMPDIR: path.join(real.rw, 'tmp'), LANG: 'en_US.UTF-8',
      // shells write here-documents to temporary files: bash under TMPDIR, zsh under TMPPREFIX (default /tmp/zsh, outside the job)
      SHELL: '/bin/bash', TMPPREFIX: path.join(real.rw, 'tmp', 'zsh'),
      PYTHONPATH: path.join(real.ro, 'lab', 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', JOBLIB_MULTIPROCESSING: '0', MPLCONFIGDIR: path.join(real.rw, 'tmp'), UV_OFFLINE: '1' };
    const confine = (profile: string | null, argv: string[]): string[] => (profile ? [SANDBOX_EXEC, '-f', profile, ...argv] : argv);
    if (job.data.kind === 'spot') {
      for (const f of job.data.files) { const dir = path.join(dataDir, job.data.source); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${f.symbol}_${job.data.interval}.csv`), f.csv); }
    } else {
      // perpetual data arrive as one bundle; the laboratory's importer (offline, sandboxed, no network at all) writes the store
      const bundle = path.join(real.rw, 'tmp', 'bundle.json'); writeFileSync(bundle, JSON.stringify(job.data.bundle));
      const prep = path.join(p.state, 'prepare.sb');
      if (confined) writeFileSync(prep, sandboxProfile({ writable: [real.job], readable: tools, localPorts: [] }), { mode: 0o600 });
      const argv = confine(confined ? prep : null, [cfg.python, '-m', 'spq.data.hl_import', '--input', bundle, '--out', dataDir]);
      const r = await new Promise<{ code: number | null; err: string }>((resolve) => { const ch = spawn(argv[0]!, argv.slice(1), { cwd: real.rw, env: baseEnv, stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
        ch.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-1000); }); ch.on('error', (e) => resolve({ code: null, err: e.message })); ch.on('close', (code) => resolve({ code, err })); });
      rmSync(bundle, { force: true });
      if (r.code !== 0) return finish({ outcome: 'failed', reason: `the data of the job could not be imported: ${r.err.trim().split('\n').pop()?.slice(0, 200) ?? ''}` });
    }
    writeFileSync(path.join(p.ro, 'JOB.json'), JSON.stringify({ kind: job.kind, symbols: job.universe, interval: job.interval, capital_usd: job.capitalUsd, data_dir: dataDir, source: job.data.kind === 'spot' ? job.data.source : null, name: job.strategyName, version: job.strategyVersion }, null, 1));
    writeFileSync(path.join(p.ro, 'CLAUDE.md'), jobBrief(job, { ro: real.ro, work: path.join(real.rw, 'work'), python: cfg.python }));
    setTree(p.ro, 0o555, 0o444);

    // ---- running
    ledger = new LedgerTail(p.ledger, p.ledgerCopy, MAX_LEDGER_BYTES);
    const jobKey = `job-${randomBytes(24).toString('hex')}`;
    gateway = new ModelGateway({ upstream: cfg.model.upstream, credential: cfg.model.credential, jobKey, maxTokens: job.budgets.maxModelTokens, onLog: sys });
    const port = await gateway.start();
    if (confined) writeFileSync(p.profile, sandboxProfile({ writable: [real.rw], readable: [real.ro, ...tools], localPorts: [port] }), { mode: 0o600 });
    const env: Record<string, string> = { ...baseEnv, SPQ_JOB_FILE: path.join(real.ro, 'JOB.json'), SPQ_JOB_LEDGER: path.join(real.rw, 'ledger', 'trials.jsonl'), SPQ_DATA_DIR: dataDir,
      // the model API as the agent sees it: the job's gateway on loopback and a placeholder key (the real credential stays in the runner)
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: jobKey, CLAUDE_CONFIG_DIR: path.join(real.rw, 'home', '.claude'), CLAUDE_CODE_TMPDIR: path.join(real.rw, 'tmp'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_COLOR: '1',
      SPW_JOB_ID: job.id, SPW_JOB_RO: real.ro, SPW_JOB_WORK: path.join(real.rw, 'work'), SPW_JOB_GATEWAY_PORT: String(port) };
    if (cfg.agent.kind === 'claude') env.PATH = `${path.dirname(cfg.python)}:${path.dirname(cfg.agent.bin)}:/usr/bin:/bin`;
    const rp = { ...p, ro: real.ro, rw: real.rw, work: path.join(real.rw, 'work') };
    const argv = confine(confined ? p.profile : null, agentArgv(cfg, job, rp));
    sys(`starting the agent (${usage.agent}) ${confined ? 'under sandbox-exec' : 'WITHOUT an OS sandbox'}; budgets: ${job.budgets.wallSeconds} s, ${job.budgets.maxTrials} trials, ${job.budgets.maxDiskMb} MB, ${job.budgets.maxModelTokens} tokens, ${job.budgets.maxModelUsd} USD`);
    const child: ChildProcess = spawn(argv[0]!, argv.slice(1), { cwd: rp.work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    hooks.running();
    const st: { stop: { outcome: 'cancelled' | 'over_budget'; reason: string } | null; costUsd: number | null; startError: string | null } = { stop: null, costUsd: null, startError: null };
    const killAll = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const lines = (stream: 'out' | 'err') => { let carry = ''; return (c: Buffer): void => { const parts = (carry + c.toString('utf8')).split('\n'); carry = (parts.pop() ?? '').slice(0, 1_000_000);
      for (const raw of parts) { if (!raw.trim()) continue;
        if (stream === 'out' && cfg.agent.kind === 'claude') { const d = describeStreamEvent(raw); if (d.costUsd !== null) st.costUsd = d.costUsd; if (d.text) for (const l of d.text.split('\n')) hooks.log('out', l.slice(0, MAX_LOG_LINE)); }
        else hooks.log(stream, raw.slice(0, MAX_LOG_LINE)); } }; };
    child.stdout!.on('data', lines('out')); child.stderr!.on('data', lines('err'));
    let tick = 0;
    const check = (): void => {
      if (st.stop) return;
      tick += 1; ledger!.sync();
      const over = (reason: string): void => { st.stop = { outcome: 'over_budget', reason }; killAll(); };
      if (hooks.cancelRequested()) { st.stop = { outcome: 'cancelled', reason: 'cancelled by the owner' }; killAll(); return; }
      if (Date.now() - t0 > job.budgets.wallSeconds * 1000) return over(`wall time over ${job.budgets.wallSeconds} s`);
      if (ledger!.lines > job.budgets.maxTrials) return over(`${ledger!.lines} trials, budget ${job.budgets.maxTrials}`);
      if (gateway!.usage.exhausted) return over(`${gateway!.usage.total} model tokens, budget ${job.budgets.maxModelTokens}`);
      if (st.costUsd !== null && st.costUsd > job.budgets.maxModelUsd) return over(`${st.costUsd.toFixed(2)} USD reported by the CLI, budget ${job.budgets.maxModelUsd}`);
      if (tick % 4 === 0) { const d = diskUsage(p.rw); usage.diskMb = Math.round(d.bytes / 1024 / 1024 * 10) / 10;
        if (d.bytes > job.budgets.maxDiskMb * 1024 * 1024 || d.entries > 200_000) return over(`${usage.diskMb} MB on disk (${d.entries} entries), budget ${job.budgets.maxDiskMb} MB`); }
    };
    const timer = setInterval(check, cfg.tickMs);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('error', (e) => { st.startError = e.message; resolve({ code: null, signal: null }); });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    clearInterval(timer);
    killAll();                                                          // whatever the agent left running in its process group
    check();                                                            // a last look at the budgets with the final ledger
    usage.exitCode = exit.code; usage.signal = exit.signal; usage.modelUsd = st.costUsd;
    usage.modelTokens = gateway.usage.total; usage.modelRequests = gateway.usage.requests;
    usage.diskMb = Math.round(diskUsage(p.rw).bytes / 1024 / 1024 * 10) / 10;
    if (st.stop) return finish(st.stop);
    if (st.startError) return finish({ outcome: 'failed', reason: `the agent could not be started: ${st.startError.slice(0, 200)}` });
    if (exit.code !== 0) return finish({ outcome: 'failed', reason: `the agent exited ${exit.signal ? `on signal ${exit.signal}` : `with code ${exit.code}`} without a submission` });

    // ---- collecting (the agent's processes are dead; the files are read without following any link)
    let files;
    try { files = collectSubmission(p.submission); } catch (e) { return finish({ outcome: 'failed', reason: `malformed submission: ${(e as Error).message}` }); }
    ledger.sync(); usage.trials = ledger.lines; usage.ledgerTampered = ledger.tampered; usage.wallMs = Date.now() - t0;
    sys(`submission collected: ${files.map((f) => f.path).join(', ')}; ${usage.trials} trials${usage.ledgerTampered ? ' (the agent\'s ledger file was rewritten: every line counted)' : ''}`);
    return { outcome: 'submission', usage, archive: { v: 1, files, ledger: ledgerText() } };
  } catch (e) {
    return finish({ outcome: 'failed', reason: `runner error: ${(e as Error).message.slice(0, 300)}` });
  } finally {
    await gateway?.stop().catch(() => {});
    if (!cfg.keepJobs) { try { setTree(p.ro, 0o700, 0o600); rmSync(p.job, { recursive: true, force: true }); } catch { /* left for the operator */ } }
  }
}
