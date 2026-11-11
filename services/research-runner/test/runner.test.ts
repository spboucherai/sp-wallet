// The runner's state machine with the deterministic fake agent (no model, no network): success, crash, timeout, cancel, every
// budget, malformed submissions, ledger tampering, the cross-process seal of the inner test split. On macOS every job below
// runs under the real sandbox-exec profile.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunnerResult, decodeSubmission, parseClaims } from '@spw/core/research-job';
import { configFromEnv } from '../src/config.ts';
import { agentArgv, collectSubmission, describeStreamEvent, jobPaths, runJob, sandboxAvailable } from '../src/job.ts';
import { LedgerTail } from '../src/ledger.ts';
import { processJob } from '../src/runner.ts';
import { hooks, labReady, makeJob, testConfig } from './helpers.ts';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const T = 180_000;
const run = async (mode: string, extra: unknown = {}, o: { job?: Parameters<typeof makeJob>[0]; cfg?: Parameters<typeof testConfig>[2] } = {}) => {
  const job = makeJob(o.job), cfg = testConfig(mode, extra, o.cfg), h = hooks();
  const result = RunnerResult.parse(await runJob(job, cfg, h.hooks));   // what the runner returns is exactly what the API accepts
  return { job, cfg, result, log: h.captured.lines.map((l) => `${l.s}: ${l.t}`).join('\n'), captured: h.captured };
};

describe.skipIf(!labReady())('runner state machine (fake agent)', () => {
  it('success: two trials, one sealed look at the inner test split, a submission with exactly the expected files and the runner\'s ledger', async () => {
    const { result, cfg, job, log, captured } = await run('ok');
    expect(result.outcome, log).toBe('submission');
    if (result.outcome !== 'submission') return;
    expect(captured.running).toBe(1);
    expect(result.usage.sandbox).toBe(process.platform === 'darwin' ? 'sandbox-exec' : 'none');
    expect(result.usage.exitCode).toBe(0);
    expect(result.usage.ledgerTampered).toBe(false);
    const sub = decodeSubmission(result.archive);
    expect(Object.keys(sub.files).sort()).toEqual(['NOTES.md', 'README.md', 'claims.json', 'strategy.py']);
    expect(new TextDecoder().decode(sub.files['strategy.py'])).toContain(`"name": "${job.strategyName}"`);
    // the ledger is the RUNNER's copy: 2 explicit trials, the report's own selection runs, exactly one test evaluation
    const recs = result.archive.ledger.trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    expect(recs.filter((r) => r.kind === 'test')).toHaveLength(1);
    expect(recs.filter((r) => r.kind === 'trial').length).toBeGreaterThanOrEqual(3);
    expect(result.usage.trials).toBe(recs.length);
    // the claims were written by the laboratory from its own report
    const { claims } = parseClaims(new TextDecoder().decode(sub.files['claims.json']));
    expect(claims?.trials).toBe(recs.length);
    expect(typeof claims?.inner_test?.sharpe === 'number' || claims?.inner_test?.sharpe === null).toBe(true);
    // nothing is left behind: the job directory is gone, the runner's ledger copy stays
    expect(existsSync(jobPaths(cfg, job.id).job)).toBe(false);
    expect(readFileSync(jobPaths(cfg, job.id).ledgerCopy, 'utf8')).toBe(result.archive.ledger);
    expect(log).toMatch(/starting the agent \(command\)/);
  }, T);

  it('crash: a non-zero exit is a failed job, never a submission', async () => {
    const { result } = await run('crash');
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') { expect(result.reason).toMatch(/exited with code 3/); expect(result.usage.exitCode).toBe(3); }
  }, T);

  it('exit 0 without files, an empty submission: failed (malformed)', async () => {
    const { result } = await run('nothing');
    expect(result).toMatchObject({ outcome: 'failed' });
    if (result.outcome === 'failed') expect(result.reason).toMatch(/malformed submission: the submission has no strategy.py/);
  }, T);

  it('timeout: the wall-clock budget kills the agent from outside → over_budget, nothing is submitted', async () => {
    const job = makeJob(); job.budgets = { ...job.budgets, wallSeconds: 2 };
    const cfg = testConfig('hang'), h = hooks(), t0 = Date.now();
    const result = await runJob(job, cfg, h.hooks);
    expect(result.outcome).toBe('over_budget');
    if (result.outcome === 'over_budget') expect(result.reason).toMatch(/wall time over 2 s/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(result.usage.signal).toBe('SIGKILL');
  }, T);

  it('cancel: the owner\'s cancel request kills the agent → cancelled', async () => {
    const job = makeJob(), cfg = testConfig('hang'), h = hooks();
    setTimeout(() => { h.captured.cancel = true; }, 1500);
    const result = await runJob(job, cfg, h.hooks);
    expect(result).toMatchObject({ outcome: 'cancelled', reason: 'cancelled by the owner' });
  }, T);

  // v10: through the runner loop, as in production — the cancel is only known from the API's answer to a log push
  it('cancel of a SILENT agent: nothing is printed after the first line, the heartbeat still learns the cancel', async () => {
    const job = makeJob(), cfg = { ...testConfig('hang'), logFlushMs: 150 }, pushes: number[] = []; let cancelAt = 0, wanted = false;
    const api = { claim: async () => null, result: async () => {}, log: async (_j: unknown, lines: unknown[]) => { pushes.push(lines.length); return { cancel: wanted }; } };
    setTimeout(() => { wanted = true; cancelAt = Date.now(); }, 2500);   // long after the agent's only line (« working for ever ») was pushed
    const result = await processJob(job, cfg, api as never);
    expect(result).toMatchObject({ outcome: 'cancelled', reason: 'cancelled by the owner' });
    expect(Date.now() - cancelAt).toBeLessThan(5000);                    // not the wall-clock budget (minutes)
    expect(pushes.filter((n) => n === 0).length).toBeGreaterThan(2);     // empty batches were pushed to ask
  }, T);

  it('trial budget: more ledger lines than allowed → over_budget, and the consumed trials are reported', async () => {
    const { result } = await run('trials', { n: 40, waitMs: 5000 }, { job: { budgets: { maxTrials: 10 } } });
    expect(result.outcome).toBe('over_budget');
    // the runner kills as soon as it sees the overrun: between 11 and 40 lines were written by then, and all of them are reported
    if (result.outcome === 'over_budget') { expect(result.reason).toMatch(/^\d+ trials, budget 10$/); expect(result.usage.trials).toBeGreaterThan(10); expect(result.usage.trials).toBeLessThanOrEqual(40);
      expect(result.ledger.trim().split('\n')).toHaveLength(result.usage.trials); }
  }, T);

  it('disk budget: the job directory is measured from outside → over_budget', async () => {
    const { result } = await run('disk', { mb: 40, waitMs: 8000 }, { job: { budgets: { maxDiskMb: 16 } } });
    expect(result.outcome).toBe('over_budget');
    if (result.outcome === 'over_budget') expect(result.reason).toMatch(/MB on disk .* budget 16 MB/);
  }, T);

  it('malformed submissions are refused by the runner: oversized file, unexpected file, symlink, hard link', async () => {
    const reasons: Record<string, RegExp> = { oversized: /NOTES.md is 307200 bytes \(limit 262144\)/, extra: /unexpected file in the submission: "run.sh"/, symlink: /strategy.py cannot be opened as a regular file/, hardlink: /strategy.py has 2 hard links/ };
    for (const [mode, re] of Object.entries(reasons)) {
      const { result, log } = await run(mode);
      expect(result.outcome, `${mode}\n${log}`).toBe('failed');
      if (result.outcome === 'failed') expect(result.reason, mode).toMatch(re);
    }
  }, 4 * T);

  it('ledger tampering: emptying the agent\'s ledger file does not shrink the runner\'s copy, and is reported', async () => {
    const { result, log } = await run('tamper');
    expect(result.outcome, log).toBe('submission');
    expect(result.usage.ledgerTampered).toBe(true);
    expect(result.usage.trials).toBeGreaterThanOrEqual(4);
    if (result.outcome === 'submission') expect(result.archive.ledger.trim().split('\n').length).toBe(result.usage.trials);
  }, T);

  it('the inner test split is sealed across processes: a second evaluation with another version is refused by the laboratory', async () => {
    const { result, log } = await run('second-look');
    expect(log).toMatch(/second look: exit 7: spq.job: TestSplitError: the inner test split of this job was already evaluated/);
    expect(result.outcome).toBe('submission');
    if (result.outcome === 'submission') expect(result.archive.ledger.trim().split('\n').map((l) => JSON.parse(l) as { kind: string }).filter((r) => r.kind === 'test')).toHaveLength(1);
  }, T);

  it('a runner that requires the OS sandbox does not start a job without it', async () => {
    if (sandboxAvailable()) return;                                    // only meaningful where sandbox-exec is missing
    const { result } = await run('ok', {}, { cfg: { sandbox: 'required' } });
    expect(result).toMatchObject({ outcome: 'failed' });
  }, T);
});

describe('runner units', () => {
  it('LedgerTail copies complete lines only, never shrinks, and flags truncation and in-place rewrites', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spw-ledger-')), src = path.join(dir, 'src.jsonl'), copy = path.join(dir, 'copy.jsonl');
    const t = new LedgerTail(src, copy, 10_000);
    expect(t.sync()).toBe(0);
    writeFileSync(src, '{"a":1}\n{"a":2}\n{"a":'); expect(t.sync()).toBe(2);
    appendFileSync(src, '3}\n'); expect(t.sync()).toBe(1);
    expect(readFileSync(copy, 'utf8')).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
    writeFileSync(src, '');                                             // truncated
    expect(t.sync()).toBe(0); expect(t.tampered).toBe(true); expect(t.lines).toBe(3);
    writeFileSync(src, '{"b":1}\n'); expect(t.sync()).toBe(1); expect(t.lines).toBe(4);
    const t2 = new LedgerTail(path.join(dir, 's2'), path.join(dir, 'c2'), 10_000);
    writeFileSync(path.join(dir, 's2'), '{"x":1}\n{"x":2}\n'); t2.sync();
    writeFileSync(path.join(dir, 's2'), '{"x":9}\n{"x":2}\n{"x":3}\n');  // rewritten in place, longer
    t2.sync(); expect(t2.tampered).toBe(true); expect(t2.lines).toBe(5); // every line of the new file counts again
    const big = new LedgerTail(path.join(dir, 's3'), path.join(dir, 'c3'), 30);
    writeFileSync(path.join(dir, 's3'), `${'{"k":1}\n'.repeat(10)}${'x'.repeat(5000)}\n`); big.sync();
    expect(big.lines).toBe(11); expect(readFileSync(path.join(dir, 'c3'), 'utf8').length).toBeLessThanOrEqual(30); // counted even when the copy is full
  });

  it('collectSubmission accepts exactly the expected regular files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spw-sub-'));
    expect(() => collectSubmission(path.join(dir, 'none'))).toThrow(/no submission directory/);
    writeFileSync(path.join(dir, 'strategy.py'), 'META = {}\n'); writeFileSync(path.join(dir, 'README.md'), '# x\n');
    expect(collectSubmission(dir).map((f) => f.path)).toEqual(['strategy.py', 'README.md']);
    writeFileSync(path.join(dir, 'claims.json'), ''); expect(() => collectSubmission(dir)).toThrow(/claims.json is empty/);
    writeFileSync(path.join(dir, 'claims.json'), '{}'); writeFileSync(path.join(dir, '.hidden'), 'x'); expect(() => collectSubmission(dir)).toThrow(/unexpected file/);
    expect(readdirSync(dir)).toContain('.hidden');
  });

  it('the Claude Code invocation: headless, bare (no keychain, no OAuth), listed tools only, nothing that prompts, no web tool, the brief as system prompt', () => {
    const job = makeJob(), cfg = testConfig('ok', {}, { agent: { kind: 'claude', bin: '/opt/homebrew/bin/claude', model: 'sonnet', argv: [] } });
    const argv = agentArgv(cfg, job, jobPaths(cfg, job.id));
    expect(argv[0]).toBe('/opt/homebrew/bin/claude');
    expect(argv.slice(1, 3)[0]).toBe('-p');
    for (const flag of ['--bare', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) expect(argv).toContain(flag);
    const val = (f: string) => argv[argv.indexOf(f) + 1];
    expect(val('--output-format')).toBe('stream-json');
    expect(val('--tools')).toBe('Read,Write,Edit,Glob,Grep,Bash');
    expect(val('--allowedTools')).toBe(val('--tools'));
    expect(val('--disallowedTools')).toBe('WebFetch,WebSearch');
    expect(val('--permission-mode')).toBe('dontAsk');
    expect(val('--permission-prompts')).toBe('none');
    expect(val('--max-budget-usd')).toBe('10');
    expect(val('--model')).toBe('sonnet');
    expect(val('--append-system-prompt-file')).toMatch(/\/ro\/CLAUDE\.md$/);
    expect(argv.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });

  it('stream-json events become log lines; the cost comes from the result event', () => {
    expect(describeStreamEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the lab"},{"type":"tool_use","name":"Bash","input":{"command":"python -m spq.job info"}}]}}').text).toBe('agent: Reading the lab\ntool Bash: python -m spq.job info');
    expect(describeStreamEvent('{"type":"result","subtype":"success","num_turns":7,"total_cost_usd":0.4321}')).toEqual({ text: 'agent finished: success, 7 turns, 0.4321 USD reported by the CLI', costUsd: 0.4321 });
    expect(describeStreamEvent('not json')).toEqual({ text: 'not json', costUsd: null });
  });

  it('configuration: the model credential is taken out of the environment, the runner secret has a minimum length, Claude needs a credential', () => {
    const base = { SPW_RUNNER_API_URL: 'https://wallet.example/', SPW_RUNNER_SECRET: 'r'.repeat(40), SPW_RUNNER_LAB_DIR: '/x/research' };
    const env: NodeJS.ProcessEnv = { ...base, ANTHROPIC_API_KEY: 'sk-test-not-a-real-key' };
    const cfg = configFromEnv(env);
    expect(cfg.model.credential).toEqual(['x-api-key', 'sk-test-not-a-real-key']);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.apiUrl).toBe('https://wallet.example');
    expect(cfg.sandbox).toBe('required'); expect(cfg.labPin).toBe('commit');
    expect(() => configFromEnv({ ...base })).toThrow(/needs ANTHROPIC_API_KEY/);
    expect(() => configFromEnv({ ...base, SPW_RUNNER_SECRET: 'short' })).toThrow(/at least 32/);
    expect(configFromEnv({ ...base, SPW_RUNNER_AGENT: 'command', SPW_RUNNER_AGENT_CMD: '["/bin/true"]' }).agent).toMatchObject({ kind: 'command', argv: ['/bin/true'] });
  });
});
