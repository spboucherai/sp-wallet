// Starts scripts/stream-stack.mts (the real API with the real venue adapters on an own database, keys written with the
// server's own hash) and returns what it prints. The stack of the stream integration tests: it needs PostgreSQL only.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StreamStackKey { id: string; secret: string }
export interface StreamStack { baseUrl: string; keys: Record<'reader' | 'narrow' | 'limited' | 'revoked' | 'venues', StreamStackKey>; stop(): Promise<void> }
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** `{ skip: reason }` when PostgreSQL is not reachable (or SPW_SDK_INTEGRATION=off); throws on any other failure */
export function startStreamStack(label: string): Promise<StreamStack | { skip: string }> {
  if (process.env.SPW_SDK_INTEGRATION === 'off') return Promise.resolve({ skip: 'SPW_SDK_INTEGRATION=off' });
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'packages/trading-sdk/scripts/stream-stack.mts'), label], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const stop = (): Promise<void> => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 8000).unref(); });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('the stream test stack did not start within 120 s')); } }, 120_000);
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (done || nl < 0) return;
      done = true; clearTimeout(timer);
      const m = JSON.parse(buf.slice(0, nl)) as { ok: boolean; skip?: boolean; reason?: string } & Omit<StreamStack, 'stop'>;
      if (m.ok) resolve({ baseUrl: m.baseUrl, keys: m.keys, stop });
      else if (m.skip) resolve({ skip: m.reason ?? 'PostgreSQL is not reachable' });
      else { void stop(); reject(new Error(`the stream test stack failed: ${m.reason}`)); }
    });
    child.once('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`the stream test stack exited with code ${code} before it was ready`)); } });
    child.once('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
