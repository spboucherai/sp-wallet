/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/research-runner/test/helpers.ts
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

// Shared fixtures of the runner tests: synthetic candles, a job, a runner configuration whose "agent" is the deterministic
// fake (test/fixtures/fake-agent.mjs), launched exactly like the real CLI — same sandbox profile, same environment.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchBudgets, jobStrategyName, type RunnerJob } from '@spw/core/research-job';
import type { RunnerConfig } from '../src/config.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const LAB = path.join(REPO, 'research');
export const PYTHON = path.join(LAB, '.venv/bin/python');
export const labReady = (): boolean => existsSync(PYTHON);

/** deterministic OHLCV random walk, CSV text with `ts` in seconds (bar-open, hourly, ending well in the past) */
export function candlesCsv(n: number, seed: number, o: { p0?: number; start?: number; stepSec?: number; drift?: number } = {}): string {
  let s = seed >>> 0;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const step = o.stepSec ?? 3600, start = o.start ?? 1_735_689_600; // 2025-01-01T00:00:00Z
  let close = o.p0 ?? 100;
  const rows = ['ts,open,high,low,close,volume'];
  for (let i = 0; i < n; i++) {
    const open = close; close = open * Math.exp((o.drift ?? 0.00005) + 0.008 * gauss());
    const hi = Math.max(open, close) * (1 + Math.abs(0.002 * gauss())), lo = Math.min(open, close) * (1 - Math.abs(0.002 * gauss()));
    rows.push(`${start + i * step},${open.toFixed(6)},${hi.toFixed(6)},${lo.toFixed(6)},${close.toFixed(6)},${(1 + 9 * rnd()).toFixed(4)}`);
  }
  return rows.join('\n') + '\n';
}

export function makeJob(o: Partial<Omit<RunnerJob, 'budgets'>> & { bars?: number; budgets?: Partial<RunnerJob['budgets']> } = {}): RunnerJob {
  const id = o.id ?? randomUUID(), bars = o.bars ?? 1500, universe = o.universe ?? ['BTC', 'ETH'];
  return {
    id, token: 't'.repeat(48), kind: 'spot', mission: 'Développe une stratégie statistique BTC/ETH, teste-la sur données historiques et prépare une simulation avec un capital virtuel de 1 000 USDC',
    universe, interval: '1h', capitalUsd: 1000, tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], strategyName: jobStrategyName(id), strategyVersion: '1', labCommit: null,
    holdout: { start: '2025-01-01T00:00:00+00:00', devEnd: '2025-03-04T12:00:00+00:00', end: '2025-03-20T00:00:00+00:00', devBars: bars, testBars: Math.floor(bars / 4) },
    data: { kind: 'spot', source: 'coinbase', interval: '1h', files: universe.map((symbol, i) => ({ symbol, csv: candlesCsv(bars, 7 + 31 * i, { p0: 100 * (i + 1) }) })) },
    ...o, budgets: ResearchBudgets.parse({ wallSeconds: 240, maxTrials: 60, maxDiskMb: 64, ...(o.budgets ?? {}) }),
  };
}

let fakeDir: string | null = null;
/** the fake agent copied OUT of the repository: a job cannot read the application checkout, so its agent cannot live there */
export function fakeAgentPath(): string {
  if (!fakeDir) { fakeDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-fake-agent-'))); copyFileSync(path.join(REPO, 'services/research-runner/test/fixtures/fake-agent.mjs'), path.join(fakeDir, 'fake-agent.mjs')); }
  return path.join(fakeDir, 'fake-agent.mjs');
}

export function testConfig(mode: string, extra: unknown = {}, o: Partial<RunnerConfig> = {}): RunnerConfig {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-runner-'))), fake = fakeAgentPath();
  return {
    apiUrl: 'http://127.0.0.1:9', secret: 's'.repeat(48), runnerId: 'test', jobsRoot: path.join(home, 'jobs'), stateRoot: path.join(home, 'state'), labDir: LAB, labPin: 'worktree', python: PYTHON,
    readable: [path.dirname(fake)], agent: { kind: 'command', bin: '', model: null, argv: [process.execPath, fake, mode, JSON.stringify(extra)] },
    sandbox: process.platform === 'darwin' ? 'required' : 'off', model: { upstream: 'http://127.0.0.1:9', credential: null }, pollMs: 50, tickMs: 150, logFlushMs: 200, keepJobs: false, ...o,
  };
}

export interface Captured { lines: { s: string; t: string }[]; running: number; cancel: boolean }
export const hooks = (c: Captured = { lines: [], running: 0, cancel: false }) => ({ captured: c, hooks: { log: (s: 'out' | 'err' | 'sys', t: string) => { c.lines.push({ s, t }); }, running: () => { c.running += 1; }, cancelRequested: () => c.cancel } });
