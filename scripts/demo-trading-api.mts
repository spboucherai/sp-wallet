// Drives a LOCAL dev stack (scripts/dev-stack.sh, fresh: the owner is not set up yet) with real `curl` commands and prints
// the transcript: owner setup with a software passkey, an API key created through the routes (prepare → passkey assertion →
// create), read calls with the key, a call refused outside /api/v1/trading/, a refused scope, a preview refused for lack of a mandate, a path that is not an operation, a revoked key.
// Secrets are redacted in what is printed. Nothing here can sign a transaction or place an order.
//   SPW_DEV_PORT=8760 SPW_DEV_DB=spw_dev_v11api SPW_DEV_DIR=/tmp/spw-dev-v11api scripts/dev-stack.sh
//   SPW_DEV_PORT=8760 SPW_DEV_DIR=/tmp/spw-dev-v11api node_modules/.bin/tsx scripts/demo-trading-api.mts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TestPasskey } from '../tests/helpers/passkey.ts';

const PORT = process.env.SPW_DEV_PORT ?? '8650', BASE = `http://localhost:${PORT}`, DIR = process.env.SPW_DEV_DIR ?? '/tmp/spw-dev';
const owner = new TestPasskey('localhost', BASE);
let cookie = '', secret = '';
const redact = (s: string): string => s.split(secret || '\u0000').join('spw_live_<key id>_<REDACTED>').replace(/spw_live_(spk_[0-9a-f]{12})_[A-Za-z0-9_-]{43}/g, 'spw_live_$1_<REDACTED>').replace(/(spw|__Host-spw)=[A-Za-z0-9_-]{20,}/g, '$1=<SESSION>')
  .replace(/"(signature|authenticatorData|clientDataJSON|attestationObject)":"[^"]+"/g, '"$1":"<…>"');
const clip = (s: string, n = 900): string => (s.length > n ? `${s.slice(0, n)}… [${s.length} bytes]` : s);

function curl(title: string, method: string, path: string, o: { key?: boolean; owner?: boolean; body?: unknown; headers?: string[]; show?: (j: any) => unknown } = {}): any {
  const args = ['-s', '-i', '-X', method, `${BASE}${path}`];
  if (o.key) args.push('-H', `Authorization: Bearer ${secret}`);
  if (o.owner) { args.push('-H', `Cookie: ${cookie}`); if (method !== 'GET') args.push('-H', `Origin: ${BASE}`, '-H', 'x-spw-csrf: 1'); }
  for (const h of o.headers ?? []) args.push('-H', h);
  if (o.body !== undefined) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(o.body));
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const [head, ...rest] = out.split('\r\n\r\n'), text = rest.join('\r\n\r\n');
  const status = head!.split('\r\n')[0]!, keep = head!.split('\r\n').filter((l) => /^(ratelimit-|retry-after|x-request-id|idempotent-replay)/i.test(l));
  const set = /set-cookie: ([^;]+)/i.exec(head!);
  if (set) cookie = set[1]!;
  let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  console.log(`\n# ${title}`);
  console.log(redact(`$ curl -s -i ${args.slice(2).map((a) => (/[ {"&?]/.test(a) ? `'${clip(a, 260)}'` : a)).join(' ')}`));
  console.log(status); for (const l of keep) console.log(l);
  console.log(redact(clip(JSON.stringify(o.show && json ? o.show(json) : json ?? text))));
  return json;
}

// ---- owner setup (once per stack) and session
let o = curl('owner setup: registration options', 'POST', '/api/v1/auth/setup/options', { headers: [`Origin: ${BASE}`, 'x-spw-csrf: 1'], body: {}, show: (j) => ({ challengeId: j.challengeId, options: '…' }) });
if (!o?.challengeId) { console.error('this stack is already set up: restart scripts/dev-stack.sh'); process.exit(1); }
curl('owner setup: the passkey is enrolled on the API and on the signer; a session cookie is set', 'POST', '/api/v1/auth/setup/verify', { headers: [`Origin: ${BASE}`, 'x-spw-csrf: 1'],
  body: { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: readFileSync(`${DIR}/setup-token`, 'utf8').trim() } });

// ---- create a key through the routes
const p = curl('1. prepare the key: the server builds the canonical intent and a WebAuthn request whose challenge is its SHA-256', 'POST', '/api/v1/developer/keys/prepare', { owner: true,
  body: { name: 'demo reader', scopes: ['markets:read', 'agents:read', 'orders:prepare'], expiresInDays: 30, limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 2000 } },
  show: (j) => ({ intentId: j.intentId, intent: j.intent, sha256: j.sha256, options: { challenge: j.options.challenge, rpId: j.options.rpId, userVerification: j.options.userVerification } }) });
const c = curl('2. create: the passkey assertion over that challenge; the secret is in this answer and nowhere else', 'POST', '/api/v1/developer/keys', { owner: true,
  body: { intentId: p.intentId, assertion: owner.assert(Buffer.from(p.options.challenge, 'base64url')) } });
secret = c.secret; const id = c.key.id as string;

// ---- three reads with the key (no cookie, no CSRF header)
curl('3. read: markets (Hyperliquid, live public data through the derivatives data service)', 'GET', '/api/v1/trading/markets?venue=hyperliquid&q=BTC&limit=2', { key: true,
  show: (j) => ({ markets: j.markets?.map((m: any) => ({ id: m.id, kind: m.kind, mark: m.mark, ts: m.ts, stale: m.stale, source: m.source })), total: j.total, errors: j.errors, error: j.error, message: j.message }) });
curl('4. read: order book', 'GET', '/api/v1/trading/markets/hyperliquid:BTC/orderbook?depth=2', { key: true });
curl('5. read: agents', 'GET', '/api/v1/trading/agents', { key: true });
curl('6. an ambiguous bare symbol: 409 with the candidates', 'GET', '/api/v1/trading/markets/BTC', { key: true });

// ---- refusals
curl('7. REFUSED outside the prefix: the security overview', 'GET', '/api/v1/security/overview', { key: true });
curl('8. REFUSED outside the prefix: key management itself', 'GET', '/api/v1/developer/keys', { key: true });
curl('9. REFUSED outside the prefix: the emergency halt', 'POST', '/api/v1/security/emergency-halt', { key: true, body: {} });
curl('10. REFUSED scope: the key has no wallet:read', 'GET', '/api/v1/trading/portfolio', { key: true });
curl('11. REFUSED: key and session cookie together', 'GET', '/api/v1/trading/agents', { key: true, headers: [`Cookie: ${cookie}`] });
curl('12. an order preview: scope held (orders:prepare), but no trading mandate is bound to this key — 403 mandate_required (a key previews the order it could place)', 'POST', '/api/v1/trading/orders/preview', { key: true,
  body: { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01' } });
curl('13. a path that is not an operation: 404 not_found, in the API\'s own error model', 'GET', '/api/v1/trading/nope', { key: true });
curl('14. no key at all', 'GET', '/api/v1/trading/agents');

// ---- revoke, then the key is dead
curl('15. the owner revokes the key (session only)', 'POST', `/api/v1/developer/keys/${id}/revoke`, { owner: true, body: { reason: 'demo over' }, show: (j) => ({ key: { id: j.key.id, status: j.key.status, revokedReason: j.key.revokedReason } }) });
curl('16. REVOKED key', 'GET', '/api/v1/trading/agents', { key: true });
curl('17. the usage log of the key (owner): route patterns and statuses only', 'GET', `/api/v1/developer/usage?key=${id}`, { owner: true, show: (j) => j.items.map((u: any) => `${u.method} ${u.route} ${u.status}`) });
