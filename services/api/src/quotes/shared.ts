// Quote engine — code shared BY VALUE between the API, the web client and the SDK (docs/V11-QUOTE-ENGINE.md).
// No import at all: this file is bundled into the browser as it is.

export const QUOTE_PROTOCOL_VERSION = 1;
/** the server sends a `heartbeat` frame this often; a client that sees no frame for HEARTBEAT_MS × 2.5 reconnects */
export const HEARTBEAT_MS = 15_000;
export const BOOK_DEPTHS = [5, 10, 20] as const;
export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const CHANNEL_TYPES = ['quote', 'book', 'trades', 'candle', 'status'] as const;
/** levels per side covered by the book checksum */
export const CHECKSUM_LEVELS = 10;

/** close codes of the stream (4000–4999 is the application range of RFC 6455) */
export const CLOSE = {
  /** the server is shutting down or restarting: reconnect */ goingAway: 1001,
  /** frame larger than the limit */ tooBig: 1009,
  /** the session ended (logout, expiry) or the API key was revoked: do not reconnect with the same credential */ unauthorized: 4001,
  /** the client sent too many frames */ rateLimited: 4002,
  /** the client stayed over the high-water mark: it cannot keep up */ slowConsumer: 4003,
  /** nothing subscribed and nothing sent for the idle timeout */ idle: 4004,
  /** no pong to the server's ping */ deadPeer: 4005,
  /** protocol violation (not JSON, binary frame, unknown version) repeated */ protocol: 4006,
} as const;

export type Level = readonly [price: string, size: string];

const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 (IEEE) of an ASCII string, as an unsigned 32-bit integer */
export function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/**
 * Checksum of a book: CRC-32 of `p:s|p:s…;p:s|…` over the best CHECKSUM_LEVELS levels of each side (bids first), with the
 * decimal strings exactly as sent. The server computes it on its book AFTER each message; a client that applied the message
 * to its own copy must find the same number, or its copy is wrong and it asks for a snapshot again.
 */
export function bookChecksum(bids: readonly Level[], asks: readonly Level[]): number {
  const side = (l: readonly Level[]): string => l.slice(0, CHECKSUM_LEVELS).map((x) => `${x[0]}:${x[1]}`).join('|');
  return crc32(`${side(bids)};${side(asks)}`);
}

/** compares two canonical decimal strings (/^-?(0|[1-9]\d*)(\.\d+)?$/) without a float */
export function cmpDec(a: string, b: string): number {
  const na = a.startsWith('-'), nb = b.startsWith('-');
  if (na !== nb) return na ? -1 : 1;
  const abs = (x: string, y: string): number => {
    const [xi = '', xf = ''] = x.split('.'), [yi = '', yf = ''] = y.split('.');
    if (xi.length !== yi.length) return xi.length < yi.length ? -1 : 1;
    if (xi !== yi) return xi < yi ? -1 : 1;
    const n = Math.max(xf.length, yf.length), pf = xf.padEnd(n, '0'), qf = yf.padEnd(n, '0');
    return pf === qf ? 0 : pf < qf ? -1 : 1;
  };
  const r = abs(na ? a.slice(1) : a, nb ? b.slice(1) : b);
  return na ? -r : r;
}

/**
 * Applies a book delta to one side. `levels` is the current side, best first; a size of "0" removes the price; the result
 * is sorted (bids descending, asks ascending) and cut at `depth`. Pure: used by the hub's tests, the web client and the SDK.
 */
export function applyLevels(levels: readonly Level[], changes: readonly Level[], side: 'bids' | 'asks', depth: number): Level[] {
  if (changes.length === 0) return levels.slice(0, depth);
  const m = new Map<string, string>(levels.map((l) => [l[0], l[1]]));
  for (const [p, s] of changes) { if (s === '0') m.delete(p); else m.set(p, s); }
  const out = [...m.entries()].sort((x, y) => (side === 'bids' ? cmpDec(y[0], x[0]) : cmpDec(x[0], y[0])));
  return out.slice(0, depth);
}

/** the changes that turn `prev` into `next` (same side): new or resized prices, and `[price, "0"]` for the ones that left */
export function diffLevels(prev: readonly Level[], next: readonly Level[]): Level[] {
  const before = new Map<string, string>(prev.map((l) => [l[0], l[1]])), out: Level[] = [];
  for (const [p, s] of next) { if (before.get(p) !== s) out.push([p, s]); before.delete(p); }
  for (const p of before.keys()) out.push([p, '0']);
  return out;
}

/** `type|id|param` — the identity of a subscription on both sides of the socket */
export function channelKey(c: { type: string; id: string; depth?: number | undefined; interval?: string | undefined }): string {
  return `${c.type}|${c.id}|${c.type === 'book' ? c.depth ?? 20 : c.type === 'candle' ? c.interval ?? '1m' : ''}`;
}

/** reconnect delay: exponential with full jitter in the upper half, `min · 2^attempt` capped at `max` */
export function backoffMs(attempt: number, min: number, max: number, random: () => number = Math.random): number {
  return Math.min(max, min * 2 ** Math.min(attempt, 16)) * (0.5 + 0.5 * random());
}
