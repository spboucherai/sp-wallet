/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/research-runner/src/api-client.ts
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

// The runner's side of the narrow endpoint pair of the wallet API. The runner PULLS a job and PUSHES log lines and one
// result; it holds one shared secret that opens these three routes and nothing else, plus — per job — the token the API
// handed out with that job. It has no owner session, no cookie and no access to any other route.
import { RunnerJob, type RunnerResult } from '@spw/core/research-job';

export interface LogLine { s: 'out' | 'err' | 'sys'; t: string }
export interface RunnerApi {
  claim(): Promise<RunnerJob | null>;
  log(job: RunnerJob, lines: LogLine[], state?: 'running'): Promise<{ cancel: boolean }>;
  result(job: RunnerJob, result: RunnerResult): Promise<void>;
}

export function httpApi(o: { apiUrl: string; secret: string; runnerId: string; fetch?: typeof fetch }): RunnerApi {
  const f = o.fetch ?? fetch, base = `${o.apiUrl}/api/v1/research/runner`;
  const post = async (path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> => {
    const r = await f(`${base}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.secret}`, ...(token ? { 'x-spw-job-token': token } : {}) }, body: JSON.stringify(body) });
    let json: unknown = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  };
  return {
    async claim() {
      const r = await post('/claim', { runnerId: o.runnerId });
      if (r.status === 204 || (r.status === 200 && !r.json?.job)) return null;
      if (r.status !== 200) throw new Error(`claim refused: HTTP ${r.status} ${String(r.json?.error ?? '')}`);
      return RunnerJob.parse(r.json.job);
    },
    async log(job, lines, state) {
      const r = await post(`/jobs/${job.id}/log`, { lines, ...(state ? { state } : {}) }, job.token);
      if (r.status !== 200) throw new Error(`log refused: HTTP ${r.status}`);
      return { cancel: r.json?.cancel === true };
    },
    async result(job, result) {
      const r = await post(`/jobs/${job.id}/result`, result, job.token);
      if (r.status !== 200 && r.status !== 202) throw new Error(`result refused: HTTP ${r.status} ${String(r.json?.message ?? '').slice(0, 200)}`);
    },
  };
}
