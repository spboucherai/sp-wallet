/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/test/stack.ts
 * Module           : trading-sdk
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Starts scripts/test-stack.mts (the real API + the real signer on an own database) and returns what it prints.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StackKey { id: string; secret: string; /** the paper mandate bound to the key (trader, trader2) */ mandateId?: string }
export interface Stack {
  baseUrl: string;
  keys: Record<'reader' | 'trader' | 'trader2' | 'unbound' | 'narrow' | 'venues' | 'agentsOnly' | 'prepare' | 'limited' | 'revoked', StackKey>;
  /** the paper account the two trader keys' mandates cover */
  paper: { accountId: string; instrument: string; maxOrderNotionalUsd: string };
  /** a venue account row without any authorization: a live order on it stops at the execution lock */
  live: { accountId: string };
  /** owner actions: POST <control>/kill-switch/release, PUT <control>/command-defaults */
  control: string;
  webhook: { secret: string; timestamp: number; body: string; signature: string };
  stop(): Promise<void>;
}
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** `{ skip: reason }` when PostgreSQL is not reachable (or SPW_SDK_INTEGRATION=off); throws on any other failure */
export function startStack(label: string): Promise<Stack | { skip: string }> {
  if (process.env.SPW_SDK_INTEGRATION === 'off') return Promise.resolve({ skip: 'SPW_SDK_INTEGRATION=off' });
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'packages/trading-sdk/scripts/test-stack.mts'), label], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '', done = false;
    const stop = (): Promise<void> => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 8000).unref(); });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('the SDK test stack did not start within 120 s')); } }, 120_000);
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (done || nl < 0) return;
      done = true; clearTimeout(timer);
      const m = JSON.parse(buf.slice(0, nl)) as { ok: boolean; skip?: boolean; reason?: string } & Omit<Stack, 'stop'>;
      if (m.ok) resolve({ baseUrl: m.baseUrl, keys: m.keys, paper: m.paper, live: m.live, control: m.control, webhook: m.webhook, stop });
      else if (m.skip) resolve({ skip: m.reason ?? 'PostgreSQL is not reachable' });
      else { void stop(); reject(new Error(`the SDK test stack failed: ${m.reason}`)); }
    });
    child.once('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`the SDK test stack exited with code ${code} before it was ready`)); } });
    child.once('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
