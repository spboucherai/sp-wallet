// V11 (B-06) — the operator's commands that CHANGE the signer state (`halt`, `unhalt`, `reset-passkeys`, `setup-token`) while a
// daemon is running. Before V11 the CLI rewrote state.json under the daemon, whose next save silently undid the change.
//
// Now the daemon owns the state (state.lock) and listens on a Unix socket inside its own data directory (mode 0600, directory
// 0700). The CLI sends the command there; the daemon applies it in the same queue as every signing request, so it is neither
// lost nor interleaved with a signature — except `halt`, which since NEXT is applied at once (`controlRunner`). When no daemon
// runs, the CLI takes the lock itself and writes the file.
//
// This is NOT reachable from the API: the API talks to the signer over TCP (HMAC), and the route table of server.ts has no
// un-halt, no passkey reset and no setup token. A Unix socket is a file: only a process of the signer's own user, on the
// signer machine, can open it — exactly who could already edit state.json.
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import type { Enqueue } from './server.ts';
import type { Store } from './store.ts';

export type ControlRequest = { cmd: 'halt' } | { cmd: 'unhalt' } | { cmd: 'reset-passkeys' } | { cmd: 'setup-token'; /** sha256 (hex) of the token the CLI generated and prints; the token itself never leaves the CLI */ tokenHash: string }
  /** NEXT (audit K1): the CLI completed `export-recovery`, or `verify-recovery` found the typed phrase to match. A date and a journal record: no word, no key. */
  | { cmd: 'recovery-mark'; what: 'exported' | 'verified' };
export type ControlAnswer = { ok: true; halted: boolean; credentials: number; via: 'daemon' | 'file' } | { ok: false; error: string };

export function isControlRequest(x: unknown): x is ControlRequest {
  const c = (x as { cmd?: unknown } | null)?.cmd;
  if (c === 'halt' || c === 'unhalt' || c === 'reset-passkeys') return true;
  if (c === 'recovery-mark') { const w = (x as { what?: unknown }).what; return w === 'exported' || w === 'verified'; }
  return c === 'setup-token' && /^[0-9a-f]{64}$/.test(String((x as { tokenHash?: unknown }).tokenHash ?? ''));
}

/** One state change, journaled and saved. The same function serves the daemon and the CLI without a daemon. */
export function applyControl(store: Store, req: ControlRequest, via: 'daemon' | 'file'): ControlAnswer {
  const s = store.state;
  if (req.cmd === 'halt' || req.cmd === 'unhalt') { s.halted = req.cmd === 'halt'; store.log(req.cmd === 'halt' ? 'halt.on' : 'halt.off', { via: 'cli' }); }
  else if (req.cmd === 'reset-passkeys') { s.credentials = []; store.log('credentials.reset', { via: 'cli' }); }
  else if (req.cmd === 'recovery-mark') {
    if (req.what === 'exported') s.recoveryExportedAt = new Date().toISOString(); else s.recoveryVerifiedAt = new Date().toISOString();
    store.log(`recovery.${req.what}`, { via: 'cli' });
  } else {
    if (s.credentials.length > 0) return { ok: false, error: 'a passkey is already enrolled; setup token refused' };
    s.setupTokenHash = req.tokenHash; store.log('setup_token.issued', {});
  }
  store.save();
  return { ok: true, halted: s.halted, credentials: s.credentials.length, via };
}

/**
 * NEXT (audit C1) — how the running daemon applies a control command. `halt` is applied AT ONCE, in the tick its line is read:
 * it never waits behind a signing request, a price read or a venue read (a signature being computed at that moment is not
 * released: server.ts, release check). Every other command — `unhalt` included — waits its turn in the daemon's serial queue,
 * as before, so that it is never interleaved with a signature.
 */
export const controlRunner = (store: Store, enqueue: Enqueue) => async (req: ControlRequest): Promise<ControlAnswer> =>
  (req.cmd === 'halt' ? applyControl(store, req, 'daemon') : enqueue(() => applyControl(store, req, 'daemon')));

/** The daemon's side. `run` applies the request (`controlRunner`). One JSON line in, one JSON line out. */
export function startControlServer(sockPath: string, run: (req: ControlRequest) => Promise<ControlAnswer>): net.Server {
  if (existsSync(sockPath)) unlinkSync(sockPath); // left by a daemon that no longer runs: this process holds the state lock
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    let buf = '';
    const answer = (a: ControlAnswer) => { c.end(`${JSON.stringify(a)}\n`); };
    c.setEncoding('utf8'); c.setTimeout(10_000, () => c.destroy());
    c.on('error', () => { /* a client that went away */ });
    c.on('data', (d: string) => {
      buf += d;
      if (buf.length > 4096) { c.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req: unknown; try { req = JSON.parse(buf.slice(0, nl)); } catch { req = null; }
      buf = '';
      if (!isControlRequest(req)) { answer({ ok: false, error: 'unknown control command' }); return; }
      run(req).then(answer, (e: unknown) => answer({ ok: false, error: (e as Error).message.slice(0, 200) }));
    });
  });
  server.listen(sockPath, () => { try { chmodSync(sockPath, 0o600); } catch { /* the umask already restricts it */ } });
  return server;
}

/** The CLI's side: the daemon's answer, or null when no daemon listens on the socket. */
export function controlCall(sockPath: string, req: ControlRequest, timeoutMs = 10_000): Promise<ControlAnswer | null> {
  return new Promise((resolve, reject) => {
    if (!existsSync(sockPath)) { resolve(null); return; }
    const c = net.createConnection(sockPath);
    let buf = '', done = false;
    const finish = (v: ControlAnswer | null, err?: Error) => { if (done) return; done = true; c.destroy(); if (err) reject(err); else resolve(v); };
    c.setEncoding('utf8'); c.setTimeout(timeoutMs, () => finish(null, new Error('the signer daemon did not answer the control command in time; nothing is known to have changed')));
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d: string) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { try { finish(JSON.parse(buf.slice(0, nl)) as ControlAnswer); } catch { finish(null, new Error('unreadable answer from the signer daemon')); } } });
    c.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') finish(null); else finish(null, e); });
    c.on('close', () => finish(null, new Error('the signer daemon closed the control connection without an answer')));
  });
}
