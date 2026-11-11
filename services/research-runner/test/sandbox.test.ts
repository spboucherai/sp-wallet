// Proof of the OS-level isolation of a research job (macOS sandbox-exec). A job is run through the REAL runner with an agent
// whose only work is to attempt every forbidden access from inside the sandboxed process (node, python and system binaries)
// and to write down what happened. Each denial below was attempted for real; positive controls show the sandbox is not
// simply denying everything. Stand-ins: two local TCP servers play the wallet API and the signer, a Unix socket plays a
// local service, a canary file outside the job directory plays a secret. Skipped where sandbox-exec does not exist.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxProfile } from '@spw/core/research-sandbox';
import { jobPaths, runJob, sandboxAvailable } from '../src/job.ts';
import { hooks, labReady, makeJob, REPO, testConfig } from './helpers.ts';

type Probe = Record<string, { ok: boolean; error?: string; value?: string }> & { python: Record<string, { ok: boolean; error?: string }> };
const ENV_CANARY = 'CANARY-ENV-7f3a91c2d5e8';
let envHolder: ChildProcess | undefined;
let probe: Probe, profile = '', connections = { api: 0, signer: 0, unix: 0 }, servers: Server[] = [], outside = '', log = '';

describe.skipIf(!sandboxAvailable() || !labReady())('sandbox: every forbidden access, attempted from inside the job', () => {
  beforeAll(async () => {
    const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-canary-')));
    const canary = path.join(scratch, 'secret.txt'); writeFileSync(canary, 'CANARY-SECRET-0123456789');
    outside = path.join(scratch, 'written-by-the-job.txt');
    const listen = (key: 'api' | 'signer' | 'unix', where: number | string) => new Promise<Server>((resolve) => { const s = createServer((c) => { connections[key] += 1; c.destroy(); });
      if (typeof where === 'string') s.listen(where, () => resolve(s)); else s.listen(where, '127.0.0.1', () => resolve(s)); });
    const api = await listen('api', 0), signer = await listen('signer', 0), unixPath = path.join(scratch, 'svc.sock'), unix = await listen('unix', unixPath);
    servers = [api, signer, unix];
    // a process of the same user, outside the sandbox, with a secret in its environment: stands for the runner itself (the
    // kernel serves the environment a process was STARTED with, so the canary must be there at exec time)
    envHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { env: { PATH: process.env.PATH ?? '', SPW_TEST_ENV_CANARY: ENV_CANARY }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    const cfg = testConfig('probe', { home: homedir(), appDir: REPO, canary, outside, envCanary: ENV_CANARY, envPid: envHolder.pid, apiPort: (api.address() as { port: number }).port, signerPort: (signer.address() as { port: number }).port,
      unixSocket: unixPath, runnerPid: process.pid, stateDir: '' }, { keepJobs: true });
    const job = makeJob({ bars: 400 }), p = jobPaths(cfg, job.id);
    cfg.agent.argv[3] = JSON.stringify({ ...(JSON.parse(cfg.agent.argv[3]!) as object), stateDir: p.state });
    const h = hooks();
    const result = await runJob(job, cfg, h.hooks);
    log = h.captured.lines.map((l) => `${l.s}: ${l.t}`).join('\n');
    expect(result.usage.sandbox, log).toBe('sandbox-exec');
    probe = JSON.parse(readFileSync(path.join(p.work, 'probe.json'), 'utf8')) as Probe;
    profile = readFileSync(p.profile, 'utf8');
  }, 120_000);
  afterAll(() => { for (const s of servers) s.close(); envHolder?.kill('SIGKILL'); });

  const denied = (k: string, re = /EPERM|EACCES|not permitted|Permission denied/i) => { const r = probe[k]!; expect(r, k).toBeDefined(); expect(r.ok, `${k} must be denied, got ${JSON.stringify(r)}`).toBe(false); expect(r.error ?? '', k).toMatch(re); };

  it('files: the owner\'s home, ~/.ssh, ~/.config, the keychain files, the application checkout and its .env cannot be read', () => {
    for (const k of ['read_ssh', 'read_config', 'read_home', 'read_keychains', 'read_app', 'read_app_src']) denied(k);
    // a path that does not exist answers ENOENT, one that exists answers EPERM: existence can be inferred, content never
    denied('read_app_env', /EPERM|ENOENT/);
  });
  it('files: a secret elsewhere on the machine cannot be read, stat-ed, reached through a symlink or hard-linked into the job', () => {
    for (const k of ['read_canary', 'stat_canary', 'symlink_read', 'hardlink_outside']) denied(k);
  });
  it('files: nothing can be written outside the job directory; the laboratory code and the data are read-only', () => {
    for (const k of ['write_outside', 'write_ro', 'write_ro_new']) denied(k);
    expect(existsSync(outside)).toBe(false);
  });
  it('files: the runner\'s own state (its ledger copy, the sandbox profile) can be neither read nor written', () => {
    for (const k of ['read_runner_state', 'write_runner_ledger', 'read_profile']) denied(k);
  });
  it('network: the wallet API port, the signer port, PostgreSQL and every other loopback port are refused — and nothing reached the listeners', () => {
    for (const k of ['tcp_api', 'tcp_signer', 'tcp_8650', 'tcp_8651', 'tcp_5432', 'tcp_v6_api']) denied(k);
    expect(connections).toEqual({ api: 0, signer: 0, unix: 0 });
  });
  it('network: no arbitrary host (internet, LAN), no DNS, no UDP, no Unix socket (local services, PostgreSQL), no listening socket', () => {
    for (const k of ['tcp_internet', 'tcp_internet_80', 'tcp_lan', 'unix_socket', 'pg_socket', 'listen', 'udp']) denied(k);
    denied('dns', /ENOTFOUND|EAI_|EPERM|not permitted/);
  });
  it('system: no keychain, no signal to processes outside the sandbox; curl and ssh started from inside get nowhere', () => {
    expect(probe.keychain!.ok, JSON.stringify(probe.keychain)).toBe(false);
    expect(probe.keychain_find!.ok).toBe(false);
    denied('kill_runner');
    expect(probe.curl!.ok, JSON.stringify(probe.curl)).toBe(false);
    expect(probe.ssh!.ok, JSON.stringify(probe.ssh)).toBe(false);
  });
  it('v8: the environment of a process outside the sandbox (the runner\'s secrets) cannot be read — ps -E, the process list, sysctl kern.procargs2', () => {
    // before v8 the profile had a blanket `(allow sysctl-read)` and no process-info rule: all three answered
    for (const k of ['ps_env', 'ps_list', 'sysctl_env']) denied(k, /EPERM|not permitted|hidden/i);
    // v10: the sysctl probe really ran (a probe that crashed, or that was given no process to read, is not a denial) and the
    // kernel refused the read itself
    expect(probe.sysctl_env!.error).not.toMatch(/PROBE-/); expect(probe.sysctl_env!.error).toMatch(/^EPERM .*(not permitted|Errno 1)/i);
    expect(profile).toContain('(deny sysctl-read (sysctl-name-prefix "kern.proc"))');
    expect(profile).toContain('(deny process-info*)');
  });
  it('the same holds for the laboratory\'s Python (the process that runs strategy code)', () => {
    for (const k of ['py_read_home', 'py_read_canary', 'py_tcp_api', 'py_tcp_internet', 'py_dns', 'py_write_outside']) { const r = probe.python[k]!; expect(r, k).toBeDefined(); expect(r.ok, `${k}: ${JSON.stringify(r)}`).toBe(false); }
    expect(probe.python.py_import!.ok).toBe(true);
  });
  it('positive controls: the job reads its brief, writes its working directory, reaches its model gateway and nothing else', () => {
    expect(probe.ok_read_ro!.ok).toBe(true);
    expect(probe.ok_write_work).toEqual({ ok: true, value: 'x' });
    expect(probe.ok_gateway!.ok, JSON.stringify(probe.ok_gateway)).toBe(true);
  });
  it('the environment of the agent contains no secret and nothing of the runner\'s own environment', () => {
    const keys = probe.ok_env!.value!.split(',');
    // (the probe truncates the list; what matters is that every name is one the runner set on purpose)
    for (const k of keys) expect(k).toMatch(/^(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CLAUDE_[A-Z_]+|DISABLE_[A-Z_]+|HOME|JOBLIB_MULTIPROCESSING|LANG|MPLCONFIGDIR|NO_COLOR|PATH|PYTHON[A-Z]+|SHELL|SPQ_[A-Z_]+|SPW_JOB_[A-Z_]+|TMPDIR|TMPPREFIX|UV_OFFLINE|__CF_USER_TEXT_ENCODING)$/);
  });
  it('the profile itself: deny by default, one loopback port, no home directory, no application path', () => {
    expect(profile).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(profile.match(/network-outbound/g)).toHaveLength(1);
    expect(profile).toMatch(/\(allow network-outbound \(remote ip "localhost:\d+"\)\)/);
    expect(profile).not.toMatch(/network-inbound|network\*|mach-lookup|\(allow default\)|file-write\* \(subpath "\/"\)/);
    expect(profile).not.toContain(`(subpath "${homedir()}")`);
    // in this test the laboratory's virtualenv lives inside the repository: it is the ONLY readable path under it
    // (on a research node the checkout is sparse — research/ only — and the application code is not on the machine at all)
    const subpaths = [...profile.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1]!);
    for (const sp of subpaths.filter((x) => x.startsWith(REPO))) expect(sp.startsWith(path.join(REPO, 'research/.venv'))).toBe(true);
    expect(subpaths.some((x) => x === REPO || x === path.join(REPO, 'services') || x === path.join(REPO, 'research'))).toBe(false);
  });
});

describe('sandbox profile builder', () => {
  it('refuses paths that could break out of the profile text, and relative paths', () => {
    for (const bad of ['relative/path', '/tmp/a"b', '/tmp/a\\b', '/tmp/a\nb', '/tmp/../etc'])
      expect(() => sandboxProfile({ writable: [bad], readable: [], localPorts: [] }), bad).toThrow(/not a plain absolute path/);
    expect(() => sandboxProfile({ writable: ['/tmp/x'], readable: [], localPorts: [70000] })).toThrow(/bad port/);
    expect(() => sandboxProfile({ writable: [], readable: [], localPorts: [] })).toThrow(/job directory/);
  });
  it('with no port there is no network rule at all', () => {
    expect(sandboxProfile({ writable: ['/private/tmp/job'], readable: ['/opt/venv'], localPorts: [] })).not.toMatch(/network/);
  });
});
