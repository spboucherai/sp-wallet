export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
let onUnauth: () => void = () => {};
export const setUnauthHandler = (f: () => void) => { onUnauth = f; };

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET') { (init.headers as Record<string, string>)['x-spw-csrf'] = '1'; (init.headers as Record<string, string>)['content-type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  let r: Response;
  try { r = await fetch('/api/v1' + path, init); } catch { throw new ApiError(0, 'offline', 'offline'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && j.error === 'unauthenticated') onUnauth();
    throw new ApiError(r.status, j.error ?? 'error', j.message ?? 'error');
  }
  return j as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => api<T>('POST', p, b, h);
