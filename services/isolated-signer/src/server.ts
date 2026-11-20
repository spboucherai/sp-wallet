import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Signer, SignerError } from './signer.ts';

const MAX_BODY = 1024 * 1024; // legacy UTXO chains attach previous transactions
/** NEXT (audit C1): the whole body of a request must have arrived this long after its headers */
const BODY_TIMEOUT_MS = 5000;
/**
 * Connections open at once; above it new ones are dropped. The API opens one connection per request and waits for its answer,
 * so this is also the depth of the queue. It keeps a flood of idle connections from using up the file descriptors the state
 * and the operator's control socket need (a connection that sends nothing is closed after `headersTimeout`).
 */
const MAX_CONNECTIONS = 128;

export function authHeader(secret: string, method: string, path: string, body: string, ts = Math.floor(Date.now() / 1000), nonce: string = crypto.randomUUID()): string {
  const mac = createHmac('sha256', secret).update([method, path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  return `t=${ts},n=${nonce},s=${mac}`;
}

/** The body, bounded in size and in time. After a refusal nothing more is read from the connection (the caller answers and closes it). */
function readBody(req: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { reject(new SignerError('too_large', 'body too large')); return; }
    let n = 0; const chunks: Buffer[] = [];
    const fail = (e: Error) => { clearTimeout(timer); req.removeAllListeners('data'); req.pause(); reject(e); };
    const timer = setTimeout(() => fail(new SignerError('timeout', 'request body not received in time')), timeoutMs);
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) fail(new SignerError('too_large', 'body too large')); else chunks.push(c); });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', fail);
  });
}

/**
 * One queue for everything that reads or changes the signer state: HTTP requests and the operator's control commands
 * (control.ts) — except the halt, which never waits in it.
 */
export type Enqueue = <T>(fn: () => Promise<T> | T) => Promise<T>;
export function createQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T> | T): Promise<T> => { const r = tail.then(fn); tail = r.catch(() => {}); return r; };
}

/**
 * NEXT (audit C2): why this listen address must not be served, or null. Without a source allowlist the signer answers only
 * on a loopback address: the HMAC secret alone is not what should face a network.
 */
export function listenRefusal(host: string, allowedIps: string[]): string | null {
  const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  return loopback || allowedIps.length > 0 ? null
    : `refusing to listen on ${host} with an empty source allowlist: set SPW_SIGNER_ALLOW_IPS to the address of the API node, or SPW_SIGNER_HOST to a loopback address`;
}

/**
 * Routes whose signature is released under the emergency halt whatever the request says: returns of the owner's own funds to
 * the owner. Every other answer computed ACROSS the moment a halt was recorded is withheld (release check below).
 */
const NEVER_HALTED = new Set(['POST /mandate/return', 'POST /vault/return']);

/**
 * The signer's HTTP surface (the route table below is all of it). Every request except the liveness probe is HMAC-authenticated
 * with replay protection. What each route verifies by itself, and which ones release a signature without a passkey, is listed
 * in docs/adr/0001-custody.md.
 *
 * NEXT (audit C1) — the order of a request:
 *   1. OUTSIDE the queue: source allowlist, shape and freshness of the auth header, the body (at most MAX_BODY bytes, within
 *      BODY_TIMEOUT_MS), the HMAC over it, the single-use nonce. A client that stalls or lies here delays nobody.
 *   2. `POST /halt` is applied at once, never queued: it cannot wait behind a signature, a price read or a venue read.
 *   3. Everything else runs one at a time in the queue (`enqueue`).
 *   4. RELEASE CHECK, in the same tick as the answer is written: if the halt was recorded while the request was being
 *      computed (not halted when its handler started, halted now), the answer is not sent and the journal says so
 *      (`halt.withheld`). A request whose handler STARTED under the halt is judged by that handler, as before (cancels,
 *      reduce-only orders, revocations and returns still pass).
 */
export function createSignerServer(signer: Signer, secret: string, allowedIps: string[] = [], enqueue: Enqueue = createQueue(), opts: { /** tests */ bodyTimeoutMs?: number } = {}): Server {
  if (secret.length < 32) throw new Error('signer shared secret too short');
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const nonces = new Map<string, number>();
  /** shape and freshness of the auth header: checked before a byte of the body is read */
  const claimed = (req: IncomingMessage) => {
    const m = /^t=(\d+),n=([0-9a-f-]{36}),s=([0-9a-f]{64})$/.exec(String(req.headers['x-spw-auth'] ?? ''));
    if (!m) throw new SignerError('unauthorized', 'missing auth');
    const ts = Number(m[1]), now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 60) throw new SignerError('unauthorized', 'stale request');
    return { ts, now, nonce: m[2]!, mac: m[3]! };
  };
  /** the HMAC over method, path, time, nonce and body; then the nonce, single use */
  const check = (req: IncomingMessage, a: ReturnType<typeof claimed>, body: string) => {
    const want = authHeader(secret, req.method ?? '', req.url ?? '', body, a.ts, a.nonce).split('s=')[1]!;
    if (!timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(a.mac, 'hex'))) throw new SignerError('unauthorized', 'bad mac');
    for (const [k, t] of nonces) if (t < a.now - 120) nonces.delete(k);
    if (nonces.has(a.nonce)) throw new SignerError('unauthorized', 'replayed request');
    nonces.set(a.nonce, a.ts);
  };
  const server = createServer({ connectionsCheckingInterval: 1000, headersTimeout: 5000, requestTimeout: 10_000, keepAliveTimeout: 1000 }, (req, res) => {
    /** a request refused before its body was read to the end (bad source, bad header, too large, too slow): the connection is closed once the answer is written */
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(obj), req.complete ? undefined : () => req.socket.destroy()); };
    const refuse = (e: unknown) => {
      const code = e instanceof SignerError ? e.code : 'internal';
      const http = code === 'unauthorized' ? 401 : code === 'not_found' ? 404 : code === 'too_large' ? 413 : code === 'timeout' ? 408 : code === 'internal' ? 500 : 422;
      send(http, { error: code, message: e instanceof SignerError ? e.message : 'internal error' });
    };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true }); // liveness only, no information
    /** step 1: nothing here touches the signer or the queue */
    const authenticated = async (): Promise<{ route: string; json: any }> => {
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (allowedIps.length && !allowedIps.includes(ip)) throw new SignerError('unauthorized', 'source not allowed');
      const a = claimed(req);
      const body = req.method === 'POST' ? await readBody(req, bodyTimeoutMs) : '';
      check(req, a, body);
      let json: unknown;
      try { json = body ? JSON.parse(body) : {}; } catch { throw new SignerError('bad_request', 'body is not JSON'); }
      if (json === null || typeof json !== 'object') throw new SignerError('bad_request', 'body is not a JSON object');
      return { route: `${req.method} ${req.url}`, json };
    };
    const dispatch = async (route: string, json: any): Promise<unknown> => {
      if (route === 'GET /status') return signer.status();
      // the FIRST passkey, with the operator's setup token; every later change of the passkey set is a credential request (SPW-CRED-v2)
      if (route === 'POST /enroll') { await signer.enroll(json); return { ok: true }; }
      if (route === 'POST /credential') return await signer.credentialApply(json.request, json.assertion, json.credential && typeof json.credential === 'object' ? json.credential : undefined);
      if (route === 'POST /sign') return await signer.sign(json.intent, json.assertion, json.aux && typeof json.aux === 'object' ? json.aux : undefined);
      // second leg of an approved bridge: only the receiveMessage that matches the stored approval (signer.ts)
      if (route === 'POST /bridge/mint') return await signer.signBridgeMint(json);
      // v8 (Solana ↔ EVM): the event-account deposit of a Solana burn back to the wallet, and the wallet's own USDC token account — passkey each
      if (route === 'POST /bridge/reclaim') return await signer.signBridgeReclaim(json);
      if (route === 'POST /sol/token-account') return await signer.signSolTokenAccount(json.request, json.assertion);
      // agent vaults: mandate approval needs the owner's passkey; orders need only to fit the mandate; revoking is always allowed
      if (route === 'POST /vault/address') return { address: signer.vaultAddress(Number(json.index)) };
      if (route === 'POST /mandate/approve') return await signer.approveMandate(json.mandate, json.assertion);
      if (route === 'POST /mandate/revoke') { signer.revokeMandate(String(json.mandateId)); return { ok: true }; }
      if (route === 'POST /mandate/sign') return await signer.signDelegated(String(json.mandateId), json.intent, json.aux && typeof json.aux === 'object' ? json.aux : undefined);
      if (route === 'POST /mandate/return') return await signer.signReturn(String(json.mandateId), json.intent);
      if (route === 'POST /vault/return') return await signer.signVaultReturn(Number(json.index), json.intent);
      // live derivatives: a dedicated trading key per venue and network; the authorization needs the owner's passkey, orders and
      // leverage changes need it too (MANUAL_LIVE), cancels do not, revoking is always allowed (venue.ts)
      if (route === 'POST /venue/key') return signer.venueKey(json.venue, json.network);
      if (route === 'POST /venue/authorize') return await signer.venueAuthorize(json.authorization, json.assertion);
      if (route === 'POST /venue/sign') return await signer.venueSign(json);
      if (route === 'POST /venue/revoke') return signer.venueRevoke(String(json.authorizationId));
      // V11: the stored answer of an active authorization, again (a lost answer of /venue/authorize); nothing is signed, no passkey
      if (route === 'POST /venue/authorization') return signer.venueAuthorization(String(json.authorizationId));
      // collateral: a withdrawal from the venue to the wallet's own address, signed by the main key after a passkey approval (venue-collateral.ts)
      if (route === 'POST /venue/withdraw') return await signer.venueWithdraw(json.withdrawal, json.assertion);
      // derivative mandates: approval needs the owner's passkey; signing needs none (every limit is checked by the signer); revoking is always allowed
      if (route === 'POST /venue/mandate/approve') return await signer.venueMandateApprove(json.mandate, json.assertion);
      if (route === 'POST /venue/mandate/sign') return await signer.venueMandateSign(json);
      if (route === 'POST /venue/mandate/revoke') return signer.venueMandateRevoke(String(json.mandateId));
      // V11 quoting mandates (market making): approval needs the owner's passkey; signing needs none (every limit is checked by the signer); revoking is always allowed
      if (route === 'POST /venue/quoting/approve') return await signer.venueQuotingApprove(json.mandate, json.assertion);
      if (route === 'POST /venue/quoting/sign') return await signer.venueQuotingSign(json);
      if (route === 'POST /venue/quoting/revoke') return signer.venueQuotingRevoke(String(json.mandateId));
      // v8 GMX v2: the venue policy needs the owner's passkey; revoking is always allowed; orders go through POST /sign (intent with a `gmx` section)
      if (route === 'POST /venue/gmx/authorize') return await signer.gmxAuthorize(json.authorization, json.assertion);
      if (route === 'POST /venue/gmx/revoke') return signer.gmxRevoke(String(json.authorizationId));
      // NFT delivery 2 (nft.ts) — passkey each: one NFT transfer built by the signer from the intent (no calldata, no helper data);
      // a change of the outpoint lock list; a change of the NFT destination allow-list
      if (route === 'POST /nft/sign') return await signer.nftSign(json.intent, json.assertion);
      if (route === 'POST /utxo/locks') return await signer.utxoLocks(json.request, json.assertion);
      if (route === 'POST /nft/allow') return await signer.nftAllow(json.request, json.assertion);
      throw new SignerError('not_found', 'no such route');
    };
    void authenticated().then(({ route, json }) => {
      // step 2: the halt takes effect now, whatever the queue is doing
      if (route === 'POST /halt') { signer.halt(); send(200, { ok: true, halted: true }); return; }
      // step 3: one at a time. `before` is read when the handler STARTS, not when the request was queued.
      return enqueue(async () => { const before = signer.halted; return { before, answer: await dispatch(route, json) }; }).then(({ before, answer }) => {
        // step 4 — release check, synchronous with the write below: nothing computed across a halt leaves this process
        if (!before && signer.halted && !NEVER_HALTED.has(route)) {
          signer.withheld(route);
          throw new SignerError('halted', 'the emergency halt was recorded while this request was being processed: nothing is released');
        }
        send(200, answer);
      });
    }).catch(refuse);
  });
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}
