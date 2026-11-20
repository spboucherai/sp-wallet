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

/** every request is bounded: 20 s by default; an approval (the server waits for the signer and the first relay) gets 45 s */
export const TIMEOUT_MS = 20_000, APPROVE_TIMEOUT_MS = 45_000;
export interface ApiOptions { /** time allowed for the whole exchange, body included */ timeoutMs?: number; signal?: AbortSignal }
/** a path that submits an approval (`…/approve`, `…/retry-mint`): the long time-out unless the caller says otherwise */
const isApproval = (method: string, path: string): boolean => method === 'POST' && /\/(approve|retry-mint)(\?|$)/.test(path);

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, opts: ApiOptions = {}): Promise<T> {
  const ctl = new AbortController(); let timedOut = false;
  const ms = opts.timeoutMs ?? (isApproval(method, path) ? APPROVE_TIMEOUT_MS : TIMEOUT_MS);
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const outer = opts.signal, onOuter = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onOuter, { once: true }); }
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...headers }, signal: ctl.signal };
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
