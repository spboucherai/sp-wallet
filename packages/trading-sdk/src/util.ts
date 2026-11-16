// Pure helpers: canonical JSON, idempotency keys, decimal strings, order states. No I/O, no dependency.
import { ConfigurationError } from './errors.ts';

// ---------------------------------------------------------------------------------------------------------------- canonical JSON
/** Deterministic JSON: object keys sorted, `undefined` members dropped, no whitespace — the same rule as the server's
 *  `canonicalJson` (services/api/src/trading-api/key-model.ts), so the bytes of a call are the same on every retry and
 *  the server's request hash is the same too. Non-finite numbers are refused (JSON cannot carry them). */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new ConfigurationError('a request body cannot contain NaN or Infinity');
  if (typeof v === 'bigint') throw new ConfigurationError('a request body cannot contain a bigint: pass a decimal string');
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------------------------------------------- idempotency keys
/** what the server accepts in `Idempotency-Key` */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;
/** a fresh UUIDv4 — one per LOGICAL call; store it before sending if the process may crash, and pass it again to resume */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------------------------- decimals
/** Money, prices and sizes are decimal STRINGS on the wire and in this SDK: never a binary float. */
export const DECIMAL_RE = /^\d+(\.\d+)?$/;
export const isDecimalString = (v: unknown): v is string => typeof v === 'string' && DECIMAL_RE.test(v);
/** a decimal string, or an integer given as a safe integer number (100 → "100"); anything else (0.1, 1e21, NaN, "1,5") throws */
export function decimalString(v: string | number, what: string): string {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new ConfigurationError(`${what}: pass a decimal string (e.g. "0.01"), not a float`);
    return String(v);
  }
  if (!isDecimalString(v)) throw new ConfigurationError(`${what}: expected a non-negative decimal string such as "0.01"`);
  return v;
}
const parse = (s: string): { n: bigint; scale: number } => { const [i, f = ''] = s.split('.'); return { n: BigInt(i! + f), scale: f.length }; };
const format = (n: bigint, scale: number): string => {
  if (scale === 0) return n.toString();
  const s = n.toString().padStart(scale + 1, '0'), out = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  return out;
};
/** Largest multiple of `lotSize` whose value at `price` does not exceed `notional` — exact integer arithmetic on the
 *  decimal strings (rounded DOWN, never up). Example: sizeFromNotional("100", "64907", "0.00001") = "0.00154". */
export function sizeFromNotional(notional: string | number, price: string, lotSize = '0.000001'): string {
  const a = parse(decimalString(notional, 'notional')), p = parse(decimalString(price, 'price')), l = parse(decimalString(lotSize, 'lotSize'));
  if (p.n === 0n || l.n === 0n) throw new ConfigurationError('price and lotSize must be positive');
  // units = floor(notional / (price × lot)), with every operand an integer scaled by a power of ten
  const units = (a.n * 10n ** BigInt(p.scale + l.scale)) / (p.n * l.n * 10n ** BigInt(a.scale));
  return format(units * l.n, l.scale);
}

// ---------------------------------------------------------------------------------------------------------------- order states
/** the states of the unified order state machine */
export const ORDER_STATES = ['CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
/** final states. UNKNOWN is NOT final and is NOT a failure: the venue's answer is not known yet — keep reading the order. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = ['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'];
/** `status` of an order as an OrderState (case-insensitive, `canceled` = `cancelled`), or null when it is not one of the twelve */
export function orderState(status: unknown): OrderState | null {
  if (typeof status !== 'string') return null;
  const s = status.toUpperCase().replace(/^CANCELED$/, 'CANCELLED');
  return (ORDER_STATES as readonly string[]).includes(s) ? (s as OrderState) : null;
}
/** True when the order is final. An order whose `status` is one of the twelve states is judged by that state alone; for
 *  the statuses the read side still reports from older tables (`open`, `pending`, `triggered`, swap states…), the
 *  server's own `final` flag decides. `UNKNOWN` is never final. */
export function isTerminalOrder(order: { status?: unknown; final?: unknown }): boolean {
  const s = orderState(order.status);
  if (s !== null) return TERMINAL_ORDER_STATES.includes(s);
  return order.final === true;
}
