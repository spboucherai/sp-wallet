// Volatility input of the quoting policies: EWMA of PAST squared mid changes, in basis points per interval — the estimator of
// the lab's study (`sigma = EWMA(0.97) of squared mid changes in bps per interval, past only`). A statistical estimate: numbers.
export interface VolState { /** EWMA of squared changes (bps²); null before the first change */ variance: number | null; lastMid: number | null; lastAt: number | null; observations: number }
export const volInit = (): VolState => ({ variance: null, lastMid: null, lastAt: null, observations: 0 });
export interface VolConfig { /** one observation per interval (ms) — the study's 5 000 */ intervalMs: number; /** decay — the study's 0.97 */ lambda: number; /** observations before the estimate is used */ warmup: number }
export const VOL_STUDY_DEFAULTS: VolConfig = { intervalMs: 5000, lambda: 0.97, warmup: 12 };

/** feed a mid; one observation is taken per elapsed interval (a gap of several intervals is ONE observation: no change is invented) */
export function volUpdate(s: VolState, mid: number, nowMs: number, cfg: VolConfig): VolState {
  if (!(mid > 0) || !Number.isFinite(mid)) return s;
  if (s.lastMid === null || s.lastAt === null) return { ...s, lastMid: mid, lastAt: nowMs };
  if (nowMs - s.lastAt < cfg.intervalMs) return s;
  const change = (mid / s.lastMid - 1) * 1e4, sq = change * change;
  return { variance: s.variance === null ? sq : cfg.lambda * s.variance + (1 - cfg.lambda) * sq, lastMid: mid, lastAt: nowMs, observations: s.observations + 1 };
}
/** bps per interval; null until `warmup` observations */
export const volBps = (s: VolState, cfg: VolConfig): number | null => (s.variance === null || s.observations < cfg.warmup ? null : Math.sqrt(s.variance));
