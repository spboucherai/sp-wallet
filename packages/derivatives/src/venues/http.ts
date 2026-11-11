// HTTP plumbing shared by the dYdX and GMX read adapters: injectable fetch, VenueError mapping, zod validation, and a JSON
// parser that never turns a venue's number into a JS number.
import type { z } from 'zod';
import { VenueError, type VenueErrorCode } from '../models.ts';
import type { VenueId } from '../models.ts';
import { D, type Dec } from '../decimal.ts';

/** The single place where a VenueError is built by these adapters (one line to adapt if the shared constructor differs). */
export const venueError = (venue: VenueId, code: VenueErrorCode, message: string): VenueError => new VenueError(code, `${venue}: ${message}`, { venue });

/** Marker for a JSON number kept as its exact source text (see `parseJsonExact`). */
export class JsonNumber {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
/**
 * JSON.parse that keeps every number as its source text (`JsonNumber`), so a price such as `73503.65` or an amount beyond
 * 2^53 is never rounded by a double. Uses the reviver's source-text access (Node ≥ 22). Strings, booleans, null are unchanged.
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _k: string, v: unknown, ctx?: { source?: string }) {
    if (typeof v !== 'number') return v;
    if (typeof ctx?.source !== 'string') throw new Error('this JSON runtime does not expose number source text');
    return new JsonNumber(ctx.source);
  } as (this: unknown, key: string, value: unknown) => unknown);
}
/** Exact decimal string of a JSON number literal (handles exponents with integer arithmetic on the digits). */
export function jsonNumberToDecStr(n: JsonNumber): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(n.text);
  if (!m) throw new Error(`not a JSON number: ${n.text.slice(0, 40)}`);
  const neg = m[1] === '-', int = m[2]!, frac = m[3] ?? '', exp = Number(m[4] ?? '0');
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) throw new Error('exponent out of range');
  let digits = int + frac, point = int.length + exp;            // decimal point position inside `digits`
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) digits = digits + '0'.repeat(point - digits.length);
  const i = digits.slice(0, point).replace(/^0+(?=\d)/, ''), f = digits.slice(point).replace(/0+$/, '');
  const out = f ? `${i}.${f}` : i;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

export interface HttpAnswer { status: number; text: string }
export interface VenueHttp {
  /** GET (or POST when `body` is given) → status + raw text. Maps transport failures, 429 and 5xx to VenueError; 4xx are returned. */
  raw(url: string, o?: { body?: unknown; signal?: AbortSignal }): Promise<HttpAnswer>;
  /** raw + JSON.parse + zod. A 2xx whose body is not JSON or does not match the schema is `bad_answer`; other 4xx go to `on4xx` or `rejected`. */
  get<T>(url: string, schema: z.ZodType<T>, o?: { exact?: boolean; body?: unknown; signal?: AbortSignal; on4xx?: (a: HttpAnswer) => VenueError | null }): Promise<T>;
}

export function venueHttp(venue: VenueId, fetchImpl: typeof fetch = fetch, o: { timeoutMs?: number; maxBytes?: number } = {}): VenueHttp {
  const timeoutMs = o.timeoutMs ?? 15_000, maxBytes = o.maxBytes ?? 8_000_000;
  const raw: VenueHttp['raw'] = async (url, ro = {}) => {
    let r: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      r = await fetchImpl(url, {
        method: ro.body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { accept: 'application/json', ...(ro.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(ro.body === undefined ? {} : { body: JSON.stringify(ro.body) }),
        signal: ro.signal ? AbortSignal.any([ro.signal, timeout]) : timeout,
      });
    } catch (e) { throw venueError(venue, 'unavailable', `network error: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
    if (r.status === 429) throw venueError(venue, 'rate_limited', 'rate limit (HTTP 429)');
    let text: string;
    try { text = await r.text(); } catch (e) { throw venueError(venue, 'unavailable', `body read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    if (r.status >= 500) throw venueError(venue, 'unavailable', `HTTP ${r.status}: ${text.slice(0, 160)}`);
    if (text.length > maxBytes) throw venueError(venue, 'bad_answer', 'answer too large');
    return { status: r.status, text };
  };
  return {
    raw,
    async get(url, schema, go = {}) {
      const a = await raw(url, go);
      if (a.status < 200 || a.status >= 300) {
        throw go.on4xx?.(a) ?? venueError(venue, 'rejected', `HTTP ${a.status}: ${a.text.slice(0, 200)}`);
      }
      let body: unknown;
      try { body = go.exact ? parseJsonExact(a.text) : JSON.parse(a.text); } catch { throw venueError(venue, 'bad_answer', `non-JSON answer from ${new URL(url).pathname}`); }
      const p = schema.safeParse(body);
      if (!p.success) {
        const i = p.error.issues[0];
        throw venueError(venue, 'bad_answer', `${new URL(url).pathname}: ${i ? `${i.path.join('.')} ${i.message}` : 'schema mismatch'}`.slice(0, 300));
      }
      return p.data;
    },
  };
}

/** `raw / 10^decimals` as an exact canonical decimal string (trailing zeros trimmed). Pure bigint. */
export function fixed(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('decimals must be a non-negative integer');
  const neg = raw < 0n, digits = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const int = digits.slice(0, digits.length - decimals), frac = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  const out = frac ? `${int}.${frac}` : int;
  return neg && raw !== 0n ? `-${out}` : out;
}
/** Exact `value × 10^decimals` as a bigint; throws if `value` has more than `decimals` significant decimals. */
export function toRaw(value: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a decimal: ${value.slice(0, 40)}`);
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  const v = BigInt(m[2]! + frac.padEnd(decimals, '0'));
  return m[1] === '-' ? -v : v;
}

/** canonical form of a plain decimal string: no leading zeros, no trailing fractional zeros, no "-0" */
export function canonDec(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal: ${s.slice(0, 40)}`);
  const int = m[2]!.replace(/^0+(?=\d)/, ''), frac = (m[3] ?? '').replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return m[1] === '-' && /[1-9]/.test(out) ? `-${out}` : out;
}
/** `D.str` in canonical form, whatever scale the shared decimal implementation chooses to print */
export const ds = (d: Dec): string => canonDec(D.str(d));
