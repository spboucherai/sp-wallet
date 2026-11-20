/**
 * What kind of failure a request ended with (NEXT W2):
 *   - `timeout`  the answer did not arrive in time      → the request may have been received: outcome UNKNOWN
 *   - `network`  the connection failed                   → the request may have been received: outcome UNKNOWN
 *   - `parse`    an answer arrived but is not JSON       → what the server did cannot be read: outcome UNKNOWN
 *   - `http`     the server answered with an error code  → outcome known (the body says what was refused)
 * `status` stays 0 and `code` stays `offline` for a network failure, as every screen already tests them.
 */
export type ApiErrorKind = 'timeout' | 'network' | 'parse' | 'http';
export class ApiError extends Error {
  /** parsed JSON body of the error answer (risk refusals carry their code and reason there) */ body: unknown = undefined;
  constructor(public status: number, public code: string, message: string, public kind: ApiErrorKind = status === 0 ? 'network' : 'http') { super(message); this.name = 'ApiError'; }
  /** true when nothing tells what the server did with the request (no answer, or an unreadable one) */
  get outcomeUnknown(): boolean { return this.kind !== 'http'; }
}
/** Did this failure leave the outcome of the request unknown? Anything that is not an answered HTTP error does (a thrown TypeError included). */
export const outcomeUnknown = (e: unknown): boolean => !(e instanceof ApiError) || e.outcomeUnknown;
let onUnauth: () => void = () => {};
export const setUnauthHandler = (f: () => void) => { onUnauth = f; };

/** every request is bounded: 20 s by default; an approval (the server waits for the signer and the first relay) and a preparation (the server simulates against the chain) get 45 s */
export const TIMEOUT_MS = 20_000, APPROVE_TIMEOUT_MS = 45_000;
export interface ApiOptions { /** time allowed for the whole exchange, body included */ timeoutMs?: number; signal?: AbortSignal;
  /** NEXT: `true` — this request is the direct result of an action of the owner (sent with `X-SPW-Interaction: 1` whatever the
   *  tracker saw: the approval that follows a passkey prompt); `false` — never marked (a background read). Default: the tracker decides. */
  interaction?: boolean }

/**
 * NEXT — `X-SPW-Interaction: 1`: what keeps the session alive (the server's idle timer counts THESE requests only, auth.ts).
 * Precisely, a request carries the header when, at the moment it is started,
 *   1. it is not a background request — not started from inside `inBackground(…)`. Background = the timed re-reads of
 *      TanStack Query (`refetchInterval`: main.tsx routes every query interval through `inBackground`), the wallet event stream
 *      and its polling fallback (walletEvents.ts), and the app's own timers that re-read a screen (Activity's head refresh);
 *   2. and either the caller says so (`interaction: true`), or the document is visible and a TRUSTED pointer, keyboard or touch
 *      event happened in this tab during the last INTERACTION_WINDOW_MS (the tracker below — `watchUserInput`, main.tsx).
 * So: an owner who taps, types or navigates keeps the session alive; a tab left open that only polls and listens does not.
 */
export const INTERACTION_HEADER = 'x-spw-interaction', INTERACTION_WINDOW_MS = 5000;
let lastInput = 0, backgroundDepth = 0;
/** a real input of the owner was seen (the tracker calls it; tests call it directly) */
export const noteUserInput = (now: number = Date.now()): void => { lastInput = now; };
/** forget what the tracker saw (lock, logout, tests) */
export const resetUserInput = (): void => { lastInput = 0; };
/** listen for trusted pointer / keyboard / touch events on this document; returns the function that stops listening */
export function watchUserInput(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const f = (e: Event) => { if (e.isTrusted) lastInput = Date.now(); };
  const evs = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const ev of evs) target.addEventListener(ev, f, { capture: true, passive: true });
  return () => { for (const ev of evs) target.removeEventListener(ev, f, { capture: true }); };
}
/** run `f` as a background task: every request it STARTS (synchronously) is unmarked, whatever the owner is doing */
export function inBackground<T>(f: () => T): T { backgroundDepth += 1; try { return f(); } finally { backgroundDepth -= 1; } }
/** does a request started now carry the header? (pure given its inputs: tested) */
export function isInteraction(opts: Pick<ApiOptions, 'interaction'> = {}, now: number = Date.now(), visible: boolean = typeof document === 'undefined' || document.visibilityState === 'visible'): boolean {
  if (backgroundDepth > 0 || opts.interaction === false) return false;
  if (opts.interaction === true) return true;
  return visible && lastInput > 0 && now - lastInput <= INTERACTION_WINDOW_MS;
}
/** a path that submits an approval (`…/approve`, `…/retry-mint`, `…/reclaim`, a switch release, a halt lift) or prepares one: the long time-out unless the caller says otherwise */
const isApproval = (method: string, path: string): boolean => method === 'POST' && /\/(approve|retry-mint|reclaim|release|resume|rebase|prepare|request-approval)(\?|$)/.test(path);

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, opts: ApiOptions = {}): Promise<T> {
  const interactive = isInteraction(opts);   // decided NOW, synchronously: the caller's context (background or not) is only known here
  const ctl = new AbortController(); let timedOut = false;
  const ms = opts.timeoutMs ?? (isApproval(method, path) ? APPROVE_TIMEOUT_MS : TIMEOUT_MS);
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const outer = opts.signal, onOuter = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onOuter, { once: true }); }
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...headers, ...(interactive ? { [INTERACTION_HEADER]: '1' } : {}) }, signal: ctl.signal };
  if (method !== 'GET') { (init.headers as Record<string, string>)['x-spw-csrf'] = '1'; (init.headers as Record<string, string>)['content-type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  const lost = () => (timedOut ? new ApiError(0, 'timeout', 'timeout', 'timeout') : new ApiError(0, 'offline', 'offline', 'network'));
  try {
    let r: Response;
    try { r = await fetch('/api/v1' + path, init); } catch { throw lost(); }
    // the body is read under the same time-out: headers that arrive and a body that never does is still a lost answer
    let text: string;
    try { text = await r.text(); } catch { throw lost(); }
    let j: any, parsed = true;
    try { j = JSON.parse(text); } catch { parsed = false; }
    if (!r.ok) {
      if (!parsed || j === null || typeof j !== 'object') j = {};
      if (r.status === 401 && j.error === 'unauthenticated') onUnauth();
      const err = new ApiError(r.status, j.error ?? 'error', j.message ?? 'error', 'http'); err.body = j;
      throw err;
    }
    if (!parsed) throw new ApiError(r.status, 'bad_answer', 'bad_answer', 'parse');   // a 200 that is not JSON is not an empty success
    return j as T;
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', onOuter); }
}
export const get = <T = any>(p: string, o?: ApiOptions) => api<T>('GET', p, undefined, {}, o);
export const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>, o?: ApiOptions) => api<T>('POST', p, b, h, o);
export const put = <T = any>(p: string, b?: unknown, o?: ApiOptions) => api<T>('PUT', p, b, {}, o);
export const patch = <T = any>(p: string, b?: unknown, o?: ApiOptions) => api<T>('PATCH', p, b, {}, o);
export const del = <T = any>(p: string, o?: ApiOptions) => api<T>('DELETE', p, undefined, {}, o);
/** a route this server does not have yet (a client newer than its server): the caller shows what it can without it */
export const routeMissing = (e: unknown): boolean => e instanceof ApiError && e.kind === 'http' && (e.status === 404 || e.status === 405 || e.status === 501);
