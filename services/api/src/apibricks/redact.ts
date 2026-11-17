// API Bricks (CoinAPI) — the API key never reaches a log line, an error message, a response body or a fixture.
//
// The provider accepts the key in several places (docs: coinapi.io/products/market-data-api/docs/authentication, and its own
// 401 answer read on 2026-11-17): the headers `X-CoinAPI-Key`, `X-APIBricks-Key`, `X-APIKey` and `Authorization`, a query
// parameter `apikey`, a URL path segment `/apikey-<key>/`, and basic auth. This module only ever SENDS it as the header, but an upstream error, a proxy or a library may echo a URL or a
// header back in a message. Every text that leaves the client goes through `redact` first. Pure.

/** the key format published by the provider: the prefix `abk` and an underscore, 32 hex characters, 8 hex characters of checksum; older
 *  keys are GUIDs. The prefix is assembled here so that a search of the repository for it finds a leaked key and nothing else. */
export const KEY_PREFIX = `${'ab'}${'k'}_`;
const KEY_SHAPES: readonly RegExp[] = [
  new RegExp(`${KEY_PREFIX}[0-9a-f]{8,}`, 'gi'),
  /(apikey=)[^&\s"'<>]+/gi,
  /(APIKEY-)[0-9A-Za-z_-]+/gi,
  /((?:x-coinapi-key|x-apibricks-key|x-apikey)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"',}]+/gi,
];
export const REDACTED = '[redacted]';

/** `text` without the key: the exact value when it is known, and anything shaped like a key or carried where a key travels. */
export function redact(text: string, key?: string | null): string {
  let out = text;
  if (key && key.length >= 8) {
    out = out.split(key).join(REDACTED);
    // the same key written in another case, URL-encoded or base64 of `coinapi:<key>` (basic auth)
    out = out.replace(new RegExp(escapeRe(key), 'gi'), REDACTED).split(encodeURIComponent(key)).join(REDACTED).split(Buffer.from(`coinapi:${key}`).toString('base64')).join(REDACTED);
  }
  for (const re of KEY_SHAPES) out = out.replace(re, (_m, lead?: unknown) => (typeof lead === 'string' ? `${lead}${REDACTED}` : REDACTED));
  return out;
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** the message of anything thrown, redacted and bounded */
export function redactError(e: unknown, key?: string | null, max = 200): string {
  const raw = e instanceof Error ? `${e.message}${e.cause ? ` (${e.cause instanceof Error ? e.cause.message : String(e.cause)})` : ''}` : String(e);
  return redact(raw, key).slice(0, max);
}
