// NEXT (audit K1) — recovery hygiene that changes nothing about how keys are generated, stored or derived:
//   - `phraseMatches`: is the phrase the operator typed the one of this signer? (CLI `verify-recovery`, terminal only);
//   - `backupState`: a tar of the signer's state, policy and journal — and nothing else of its directory. The keystore, the
//     wrap key, the gateway secret, the lock and the control socket are never read by this file.
// Restoring a signer from its phrase (`import`) is deliberately NOT here: it creates key material and needs its own review.
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Case and spacing of what was typed do not matter; the words and their order do. Answers yes or no, nothing else. */
export function phraseMatches(typed: string, mnemonic: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ')).digest();
  return timingSafeEqual(digest(typed), digest(mnemonic));
}

/** One line typed on the terminal, never echoed (raw mode). Null when the operator gave up (Ctrl-C, Ctrl-D on an empty line). */
export function readHidden(prompt: string, stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (v: string | null) => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); resolve(v); };
    const onData = (d: string) => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003' || (ch === '\u0004' && buf === '')) return done(null);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
    stdin.on('data', onData);
  });
}

/** The files of a signer directory that hold no key and no secret. `state.json` comes first: see `backupState`. */
export function backupNames(dir: string): string[] {
  const journals = readdirSync(dir).filter((f) => /^journal[A-Za-z0-9-]*\.jsonl$/.test(f)).sort();
  return [...['state.json', 'policy.json'].filter((f) => existsSync(join(dir, f))), ...journals];
}

/** one file of a POSIX ustar archive: a 512-byte header, the data, zero padding to a multiple of 512 */
function tarEntry(name: string, data: Buffer, mtimeSec: number): Buffer {
  const h = Buffer.alloc(512), octal = (n: number, width: number) => n.toString(8).padStart(width, '0');
  h.write(name, 0, 100, 'utf8');
  h.write(`${octal(0o600, 7)}\0${octal(0, 7)}\0${octal(0, 7)}\0${octal(data.length, 11)}\0${octal(mtimeSec, 11)}\0`, 100, 'ascii');
  h.write('        0', 148, 'ascii'); // checksum field as spaces while it is computed, then the type: a regular file
  h.write('ustar\u000000', 257, 'ascii');
  h.write(`${octal(h.reduce((sum, b) => sum + b, 0), 6)}\0 `, 148, 'ascii');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/**
 * Writes `out` (mode 0600, never over an existing file): a tar of state.json, policy.json and every journal file of `dir`.
 * It can run next to a daemon: the state is read FIRST, the journal after — so the copy's journal is at or ahead of the
 * state it goes with, which is the one inconsistency the store accepts at start (store.ts, "journal AHEAD of the state").
 * Returns the names written.
 */
export function backupState(dir: string, out: string, nowMs: number = Date.now()): string[] {
  const names = backupNames(dir);
  if (!names.includes('state.json')) throw new Error(`no state.json in ${dir}: nothing to back up`);
  const entries = names.map((n) => tarEntry(n, readFileSync(join(dir, n)), Math.floor(nowMs / 1000)));
  writeFileSync(out, Buffer.concat([...entries, Buffer.alloc(1024)]), { mode: 0o600, flag: 'wx' });
  return names;
}
