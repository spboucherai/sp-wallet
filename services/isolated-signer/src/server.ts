import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Signer, SignerError } from './signer.ts';

const MAX_BODY = 1024 * 1024; // legacy UTXO chains attach previous transactions

export function authHeader(secret: string, method: string, path: string, body: string, ts = Math.floor(Date.now() / 1000), nonce: string = crypto.randomUUID()): string {
  const mac = createHmac('sha256', secret).update([method, path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  return `t=${ts},n=${nonce},s=${mac}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new SignerError('too_large', 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Narrow HTTP surface: status, enroll, sign, halt. Every request is HMAC-authenticated with replay protection. */
export function createSignerServer(signer: Signer, secret: string, allowedIps: string[] = []): Server {
  if (secret.length < 32) throw new Error('signer shared secret too short');
  const nonces = new Map<string, number>();
  const check = (req: IncomingMessage, body: string) => {
    const m = /^t=(\d+),n=([0-9a-f-]{36}),s=([0-9a-f]{64})$/.exec(String(req.headers['x-spw-auth'] ?? ''));
    if (!m) throw new SignerError('unauthorized', 'missing auth');
    const ts = Number(m[1]), now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 60) throw new SignerError('unauthorized', 'stale request');
    const want = authHeader(secret, req.method ?? '', req.url ?? '', body, ts, m[2]!).split('s=')[1]!;
    if (!timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(m[3]!, 'hex'))) throw new SignerError('unauthorized', 'bad mac');
    for (const [k, t] of nonces) if (t < now - 120) nonces.delete(k);
    if (nonces.has(m[2]!)) throw new SignerError('unauthorized', 'replayed request');
    nonces.set(m[2]!, ts);
  };
  let queue: Promise<unknown> = Promise.resolve(); // strictly serialize state-changing work
  return createServer((req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true }); // liveness only, no information
    const run = async () => {
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (allowedIps.length && !allowedIps.includes(ip)) throw new SignerError('unauthorized', 'source not allowed');
      const body = req.method === 'POST' ? await readBody(req) : '';
      check(req, body);
      const json = body ? JSON.parse(body) : {};
      const route = `${req.method} ${req.url}`;
      if (route === 'GET /status') return signer.status();
      if (route === 'POST /enroll') { await signer.enroll(json); return { ok: true }; }
      if (route === 'POST /sign') return await signer.sign(json.intent, json.assertion, json.aux && typeof json.aux === 'object' ? json.aux : undefined);
      if (route === 'POST /halt') { signer.halt(); return { ok: true, halted: true }; }
      // agent vaults: mandate approval needs the owner's passkey; orders need only to fit the mandate; revoking is always allowed
      if (route === 'POST /vault/address') return { address: signer.vaultAddress(Number(json.index)) };
      if (route === 'POST /mandate/approve') return await signer.approveMandate(json.mandate, json.assertion);
      if (route === 'POST /mandate/revoke') { signer.revokeMandate(String(json.mandateId)); return { ok: true }; }
      if (route === 'POST /mandate/sign') return await signer.signDelegated(String(json.mandateId), json.intent, json.aux && typeof json.aux === 'object' ? json.aux : undefined);
      if (route === 'POST /mandate/return') return await signer.signReturn(String(json.mandateId), json.intent);
      throw new SignerError('not_found', 'no such route');
    };
    queue = queue.then(run).then((r) => send(200, r), (e: unknown) => {
      const code = e instanceof SignerError ? e.code : 'internal';
      const http = code === 'unauthorized' ? 401 : code === 'not_found' ? 404 : code === 'internal' ? 500 : 422;
      send(http, { error: code, message: e instanceof SignerError ? e.message : 'internal error' });
    });
  });
}
