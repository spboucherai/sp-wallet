// Heartbeats of the background loops (read by the monitoring dashboard and the "worker failing" alert). Its own small module
// so that the agent engines (which have their own timers, outside worker.ts `loop()`) can report here too — v8 hardening.
export interface LoopStat { name: string; everyMs: number; runs: number; lastStartAt: number | null; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null; /** failed passes in a row */ failures: number }
export const loopStats = new Map<string, LoopStat>();

/** Register a loop and get the three marks of one pass. */
export function heartbeat(name: string, everyMs: number): { start(): void; ok(): void; fail(reason: string): void; stat: LoopStat } {
  const st: LoopStat = { name, everyMs, runs: 0, lastStartAt: null, lastOkAt: null, lastErrorAt: null, lastError: null, failures: 0 };
  loopStats.set(name, st);
  return { stat: st, start: () => { st.lastStartAt = Date.now(); st.runs += 1; }, ok: () => { st.lastOkAt = Date.now(); st.failures = 0; },
    fail: (reason) => { st.lastErrorAt = Date.now(); st.lastError = reason.slice(0, 200); st.failures += 1; } };
}

/** One pass of an agent engine: its outcome per agent. The pass FAILED when it threw, or when there are agents and every one
 *  of them ended in an error (or is backing off after one) — an engine that runs but can place nothing is not healthy. */
export function enginePassFailure(out: Record<string, string>): string | null {
  const all = Object.values(out);
  if (!all.length) return null;
  const bad = all.filter((x) => x.startsWith('error:') || x.startsWith('backing off'));
  return bad.length === all.length ? (all.find((x) => x.startsWith('error:')) ?? bad[0]!).slice(0, 200) : null;
}

/** Run `pass` on a timer with a heartbeat (never two passes at once). Returns the stop function. */
export function engineLoop(name: string, everyMs: number, pass: () => Promise<Record<string, string>>): () => void {
  const hb = heartbeat(name, everyMs);
  let busy = false;
  const tick = (): void => { if (busy) return; busy = true; hb.start();
    pass().then((out) => { const why = enginePassFailure(out); if (why) hb.fail(why); else hb.ok(); }, (e: Error) => hb.fail(e.message ?? String(e))).finally(() => { busy = false; }); };
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => { clearInterval(t); loopStats.delete(name); };
}
