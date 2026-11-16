// Mocked transport for the unit tests: a `fetch` that records every call and answers from a script.
import { SPWallet, type SPWalletOptions } from '../src/index.ts';

export const KEY = 'spw_live_spk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
export interface Call { method: string; url: URL; path: string; headers: Record<string, string>; body: string | undefined }
export type Step = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | { throw: unknown } | { hang: true };
export const ok = (json: unknown, headers: Record<string, string> = {}): Step => ({ status: 200, json, headers });
export const fail = (status: number, error: string, message = 'refused', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Step => ({ status, json: { error, message, ...extra }, headers });

export function mock(steps: Step[] | ((c: Call, n: number) => Step), o: SPWalletOptions = {}) {
  const calls: Call[] = [], sleeps: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? 'GET', url, path: url.pathname, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: init.body as string | undefined };
    const n = calls.push(call) - 1;
    const step = typeof steps === 'function' ? steps(call, n) : steps[Math.min(n, steps.length - 1)]!;
    if ('throw' in step) throw step.throw;
    if ('hang' in step) return new Promise<Response>((_, rej) => { init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); });
    return new Response(step.text ?? (step.json === undefined ? '' : JSON.stringify(step.json)), { status: step.status, headers: { 'content-type': 'application/json', 'x-request-id': `req-${n + 1}`, ...step.headers } });
  }) as typeof fetch;
  const client = new SPWallet({ apiKey: KEY, baseUrl: 'https://wallet.test', fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...o });
  return { client, calls, sleeps };
}
