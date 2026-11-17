// API Bricks (CoinAPI) — the credit budgeter: a HARD daily ceiling of REST credits, counted by this process and persisted.
//
// Why it exists: the provider meters REST usage in credits (one per call, or one per 100 rows returned when `limit` is used)
// and, on the plan observed with the owner's key on 2026-11-17, answers neither `X-Credits-Used` nor `X-Credits-Remaining`:
// the only place the balance is visible is the provider's console. The wallet therefore keeps its own count and refuses to
// spend past a ceiling the owner sets (`APIBRICKS_DAILY_CREDITS`), so a loop gone wrong cannot empty a prepaid balance.
//
//   reserve(consumer, n)   before a call: true and counted, or false — the caller then reports `quota`, it never calls
//   settle(consumer, d)    after the answer: the provider's own cost (`x-ratelimit-request-cost`) minus what was reserved
//   refund(consumer, n)    the request never left (network error before any answer)
//
// The day is the UTC calendar day: this module's OWN convention for its own ceiling. It is not the provider's accounting
// (its documentation describes plan quotas as a rolling 24-hour window, and a prepaid balance has no day at all). A consumer may have its own smaller ceiling (`caps`): the market-data
// backfill must not starve the price cross-check. The count survives a restart through `store` (the settings table):
// a restart loop cannot spend the ceiling several times.

export type BudgetConsumer = 'prices' | 'quotes' | 'market' | 'research' | 'smoke';
export interface BudgetState { day: string; used: number; by: Partial<Record<BudgetConsumer, number>>; refusals: number }
export interface BudgetStore { load(): Promise<BudgetState | null>; save(s: BudgetState): Promise<void> }
export interface BudgetOptions {
  /** credits per UTC day; 0 = the provider is never called */ dailyCredits: number;
  /** a consumer's own ceiling inside the day's */ caps?: Partial<Record<BudgetConsumer, number>>;
  now?: () => number; store?: BudgetStore;
}
export interface BudgetSnapshot {
  day: string; ceiling: number; used: number; remaining: number; exhausted: boolean; resetsAt: string;
  by: Partial<Record<BudgetConsumer, number>>; caps: Partial<Record<BudgetConsumer, number>>;
  /** calls refused by the ceiling today */ refusals: number;
}
export interface Budget {
  reserve(consumer: BudgetConsumer, credits?: number): Promise<boolean>;
  settle(consumer: BudgetConsumer, delta: number): void;
  refund(consumer: BudgetConsumer, credits: number): void;
  snapshot(): BudgetSnapshot;
  /** true when `credits` more could be spent by this consumer now (no side effect) */
  has(consumer: BudgetConsumer, credits?: number): boolean;
}

const DAY_MS = 86_400_000;
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function createBudget(o: BudgetOptions): Budget {
  const now = o.now ?? Date.now, ceiling = Math.max(0, Math.floor(o.dailyCredits)), caps = o.caps ?? {};
  let st: BudgetState = { day: utcDay(now()), used: 0, by: {}, refusals: 0 };
  let loaded: Promise<void> | null = null;
  const load = (): Promise<void> => (loaded ??= (async () => {
    try { const s = await o.store?.load(); if (s && s.day === utcDay(now()) && Number.isFinite(s.used)) st = { day: s.day, used: Math.max(st.used, s.used), by: { ...s.by }, refusals: s.refusals ?? 0 }; }
    catch { /* an unreadable count starts at what this process spent: never below it */ }
  })());
  const roll = (): void => { const d = utcDay(now()); if (d !== st.day) st = { day: d, used: 0, by: {}, refusals: 0 }; };
  const save = (): void => { void o.store?.save({ ...st, by: { ...st.by } }).catch(() => { /* the in-memory count stands */ }); };
  const fits = (c: BudgetConsumer, n: number): boolean => st.used + n <= ceiling && (caps[c] === undefined || (st.by[c] ?? 0) + n <= caps[c]!);
  const add = (c: BudgetConsumer, n: number): void => { st.used = Math.max(0, st.used + n); st.by[c] = Math.max(0, (st.by[c] ?? 0) + n); };
  return {
    async reserve(c, n = 1) {
      await load(); roll();
      if (!fits(c, n)) { st.refusals += 1; save(); return false; }
      add(c, n); save();
      return true;
    },
    // the provider's own figure wins, upward or downward; an answer dearer than reserved can pass the ceiling by that
    // difference once — the next reserve is then refused
    settle(c, delta) { if (delta !== 0 && Number.isFinite(delta)) { roll(); add(c, delta); save(); } },
    refund(c, n) { roll(); add(c, -n); save(); },
    has(c, n = 1) { roll(); return fits(c, n); },
    snapshot() {
      roll();
      return { day: st.day, ceiling, used: st.used, remaining: Math.max(0, ceiling - st.used), exhausted: st.used >= ceiling,
        resetsAt: new Date(Date.parse(`${st.day}T00:00:00Z`) + DAY_MS).toISOString(), by: { ...st.by }, caps: { ...caps }, refusals: st.refusals };
    },
  };
}
