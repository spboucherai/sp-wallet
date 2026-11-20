// NEXT W1 — the shared approval-outcome helper (src/approval.ts). Once the approval has left the browser only a state read
// from the server decides what is shown: every branch — answered, refused, answer lost then state readable (in each state),
// answer lost and state unreadable, cancel failing, the idempotency key of a draft.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { answerLost, cancelDraft, DraftKey, proposalApplied, READ_BACKOFF_MS, readOutcome, submitApproval } from '../src/approval.ts';

const timeout = () => new ApiError(0, 'timeout', 'timeout', 'timeout'), offline = () => new ApiError(0, 'offline', 'offline', 'network');
const http = (status: number, code = 'error') => new ApiError(status, code, code, 'http'), parse = () => new ApiError(200, 'bad_answer', 'bad_answer', 'parse');
const P = (state: string) => ({ id: 'p1', state });
/** no real waiting: the pauses asked for are recorded */
const clock = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms); } }; };
const LOST: [string, () => unknown][] = [['time-out', timeout], ['network failure', offline], ['HTTP 500', () => http(500, 'internal')], ['HTTP 502 from a gateway', () => http(502)], ['HTTP 504', () => http(504)], ['unreadable 200', parse], ['a thrown TypeError', () => new TypeError('boom')]];

describe('answerLost', () => {
  it('a lost answer is anything but an answered 4xx', () => {
    for (const [, e] of LOST) expect(answerLost(e())).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 429]) expect(answerLost(http(s))).toBe(false);
  });
});

describe('submitApproval', () => {
  it('answered: the server’s answer is the state; nothing is re-read', async () => {
    const read = vi.fn(); const onChecking = vi.fn();
    expect(await submitApproval({ submit: async () => P('signed'), read, applied: proposalApplied, onChecking })).toEqual({ kind: 'answered', value: P('signed') });
    expect(read).not.toHaveBeenCalled(); expect(onChecking).not.toHaveBeenCalled();
  });
  it('refused (answered 4xx): outcome known, nothing is re-read, no "checking"', async () => {
    const read = vi.fn(), onChecking = vi.fn(), e = http(409, 'expired');
    expect(await submitApproval({ submit: async () => { throw e; }, read, applied: proposalApplied, onChecking })).toEqual({ kind: 'refused', error: e });
    expect(read).not.toHaveBeenCalled(); expect(onChecking).not.toHaveBeenCalled();
  });
  for (const [name, mk] of LOST) for (const state of ['signed', 'broadcast', 'confirming', 'finalized', 'failed', 'rejected', 'expired', 'not_broadcast', 'replaced']) {
    it(`answer lost (${name}) → state readable as ${state}: shown as read, at the first read`, async () => {
      const c = clock(), e = mk(), onChecking = vi.fn(), read = vi.fn(async () => P(state));
      const o = await submitApproval({ submit: async () => { throw e; }, read, applied: proposalApplied, onChecking, sleep: c.sleep });
      expect(o).toEqual({ kind: 'read', state: P(state), applied: true, error: e });
      expect(read).toHaveBeenCalledTimes(1); expect(c.waits).toEqual([]); expect(onChecking).toHaveBeenCalledWith(e);
    });
  }
  it('answer lost → the state still awaits approval: read again with back-off, then reported as NOT applied (the server says so)', async () => {
    const c = clock(), e = timeout(), read = vi.fn(async () => P('pending_approval'));
    const o = await submitApproval({ submit: async () => { throw e; }, read, applied: proposalApplied, sleep: c.sleep });
    expect(o).toEqual({ kind: 'read', state: P('pending_approval'), applied: false, error: e });
    expect(read).toHaveBeenCalledTimes(READ_BACKOFF_MS.length + 1); expect(c.waits).toEqual([...READ_BACKOFF_MS]);
    expect(c.waits.every((w, k) => k === 0 || w > c.waits[k - 1]!)).toBe(true);   // back-off: each pause longer than the one before
  });
  it('answer lost → the server was still working: pending at first, signed at the third read', async () => {
    const c = clock(), seq = ['pending_approval', 'pending_approval', 'signed', 'broadcast'], read = vi.fn(async () => P(seq.shift()!));
    const o = await submitApproval({ submit: async () => { throw timeout(); }, read, applied: proposalApplied, sleep: c.sleep });
    expect(o).toMatchObject({ kind: 'read', state: P('signed'), applied: true }); expect(read).toHaveBeenCalledTimes(3); expect(c.waits).toEqual(READ_BACKOFF_MS.slice(0, 2));
  });
  it('answer lost → reads fail, then one succeeds: that state decides', async () => {
    const c = clock(); let k = 0; const read = vi.fn(async () => { if (k++ < 3) throw offline(); return P('broadcast'); });
    expect(await submitApproval({ submit: async () => { throw offline(); }, read, applied: proposalApplied, sleep: c.sleep })).toMatchObject({ kind: 'read', state: P('broadcast'), applied: true });
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('answer lost → a pending state was read, later reads fail: the last state read is kept (not "unknown")', async () => {
    const c = clock(); let k = 0; const read = vi.fn(async () => { if (k++ === 0) return P('pending_approval'); throw offline(); });
    expect(await submitApproval({ submit: async () => { throw timeout(); }, read, applied: proposalApplied, sleep: c.sleep })).toMatchObject({ kind: 'read', state: P('pending_approval'), applied: false });
  });
  for (const [name, mk] of LOST) it(`answer lost (${name}) and state unreadable → unknown, after every retry`, async () => {
    const c = clock(), e = mk(), read = vi.fn(async () => { throw offline(); });
    expect(await submitApproval({ submit: async () => { throw e; }, read, applied: proposalApplied, sleep: c.sleep })).toEqual({ kind: 'unknown', error: e });
    expect(read).toHaveBeenCalledTimes(READ_BACKOFF_MS.length + 1);
  });
  it('answer lost and nothing to read → unknown at once', async () => {
    const e = timeout(), onChecking = vi.fn();
    expect(await submitApproval({ submit: async () => { throw e; }, onChecking })).toEqual({ kind: 'unknown', error: e }); expect(onChecking).toHaveBeenCalledWith(e);
  });
  it('never throws, whatever submit and read do', async () => {
    await expect(submitApproval({ submit: () => { throw 'a string'; }, read: () => { throw null; }, applied: () => true, sleep: async () => {} })).resolves.toEqual({ kind: 'unknown', error: 'a string' });
  });
});

describe('readOutcome — the "check again" of the status-unknown panel', () => {
  it('readable now: the state decides', async () => { expect(await readOutcome({ read: async () => P('finalized'), applied: proposalApplied, sleep: async () => {} }, null)).toEqual({ kind: 'read', state: P('finalized'), applied: true, error: null }); });
  it('still unreadable: still unknown', async () => { expect(await readOutcome({ read: async () => { throw timeout(); }, applied: proposalApplied, sleep: async () => {} }, 'e')).toEqual({ kind: 'unknown', error: 'e' }); });
  it('a custom back-off is followed', async () => {
    const c = clock(), read = vi.fn(async () => { throw offline(); });
    await readOutcome({ read, applied: () => true, backoffMs: [5, 10], sleep: c.sleep }, null); expect(c.waits).toEqual([5, 10]); expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('cancelDraft — a cancellation that fails says so', () => {
  it('cancelled when the server accepted the rejection', async () => { const read = vi.fn(); expect(await cancelDraft(async () => ({}), read)).toEqual({ kind: 'cancelled' }); expect(read).not.toHaveBeenCalled(); });
  it('reject failing (answered refusal): failed, with the state read', async () => {
    const e = http(409, 'bad_state');
    expect(await cancelDraft(async () => { throw e; }, async () => P('broadcast'))).toEqual({ kind: 'failed', error: e, state: P('broadcast') });
  });
  it('reject failing (lost answer) and state unreadable: failed, state null — never "cancelled"', async () => {
    const e = offline();
    expect(await cancelDraft(async () => { throw e; }, async () => { throw offline(); })).toEqual({ kind: 'failed', error: e, state: null });
    expect(await cancelDraft(async () => { throw e; })).toEqual({ kind: 'failed', error: e, state: null });
  });
});

describe('DraftKey — the idempotency key of a draft', () => {
  const keys = () => { let n = 0; return new DraftKey(() => `k${++n}`); };
  it('is stable for the same content, across any number of retries', () => { const d = keys(); expect([d.for('a'), d.for('a'), d.for('a')]).toEqual(['k1', 'k1', 'k1']); });
  it('changes when the content changes — and does not come back', () => { const d = keys(); expect([d.for('a'), d.for('b'), d.for('a')]).toEqual(['k1', 'k2', 'k3']); });
  it('is kept after a lost answer, renewed after an answered refusal', () => {
    const d = keys(); d.for('a');
    for (const e of [timeout(), offline(), http(503), parse()]) { d.failed(e); expect(d.for('a')).toBe('k1'); }
    d.failed(http(400, 'bad_address')); expect(d.for('a')).toBe('k2');
  });
  it('renew() gives a new key for the same content (after a definitive answer)', () => { const d = keys(); d.for('a'); d.renew(); expect(d.for('a')).toBe('k2'); });
  it('uses crypto.randomUUID by default', () => { expect(new DraftKey().for('x')).toMatch(/^[0-9a-f-]{36}$/); });
});

describe('proposalApplied', () => {
  it('only draft and pending_approval still await the approval', () => {
    expect(['draft', 'pending_approval'].map((s) => proposalApplied({ state: s }))).toEqual([false, false]);
    expect(['approved', 'signed', 'broadcast', 'confirming', 'finalized', 'failed', 'rejected', 'expired', 'not_broadcast', 'reorged', 'replaced'].every((s) => proposalApplied({ state: s }))).toBe(true);
  });
});
