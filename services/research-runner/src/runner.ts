// The runner loop: claim one job, run it, push its log and its result. One job at a time.
import { MAX_LOG_BATCH, type RunnerJob, type RunnerResult } from '@spw/core/research-job';
import type { LogLine, RunnerApi } from './api-client.ts';
import type { RunnerConfig } from './config.ts';
import { runJob } from './job.ts';

/** Run one claimed job to its result, streaming the log. Never throws: a runner error is a `failed` result. */
export async function processJob(job: RunnerJob, cfg: RunnerConfig, api: RunnerApi): Promise<RunnerResult> {
  const buffer: LogLine[] = []; let cancel = false, sending: Promise<void> = Promise.resolve(), dropped = 0, announce = false;
  const flush = (): Promise<void> => {
    sending = sending.then(async () => {
      while (buffer.length || announce) {
        const batch = buffer.splice(0, MAX_LOG_BATCH), state = announce ? 'running' as const : undefined; announce = false;
        try { if ((await api.log(job, batch, state)).cancel) cancel = true; } catch { /* the API is away: the job goes on, these lines are lost */ }
      }
    });
    return sending;
  };
  const timer = setInterval(() => { void flush(); }, cfg.logFlushMs);
  const result = await runJob(job, cfg, {
    log: (s, t) => { if (buffer.length < 5000) buffer.push({ s, t }); else dropped += 1; },
    running: () => { announce = true; void flush(); },
    cancelRequested: () => cancel,
  });
  clearInterval(timer);
  if (dropped) buffer.push({ s: 'sys', t: `${dropped} log lines were dropped (the agent wrote faster than the log is sent)` });
  await flush();
  return result;
}

export async function pushResult(job: RunnerJob, result: RunnerResult, api: RunnerApi, attempts = 5): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { await api.result(job, result); return true; } catch (e) { if (i === attempts - 1) { console.error(`result of ${job.id} could not be pushed: ${(e as Error).message}`); return false; } await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
  return false;
}

export async function runOnce(cfg: RunnerConfig, api: RunnerApi): Promise<RunnerResult | null> {
  const job = await api.claim();
  if (!job) return null;
  const result = await processJob(job, cfg, api);
  await pushResult(job, result, api);
  return result;
}

export function startRunner(cfg: RunnerConfig, api: RunnerApi): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try { if (!(await runOnce(cfg, api))) await new Promise((r) => setTimeout(r, cfg.pollMs)); }
      catch (e) { console.error(`runner: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, Math.max(cfg.pollMs, 5000))); }
    }
  })();
  return () => { stopped = true; };
}
