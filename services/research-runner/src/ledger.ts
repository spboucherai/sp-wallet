// The trial ledger of a job, seen from outside the agent.
//
// The laboratory (spq.research.Experiment, SPQ_JOB_LEDGER) appends one JSON line per trial and per look at the inner test
// split to a file INSIDE the job directory — the agent's processes must be able to write it. This class copies every complete
// line, as it appears, into a file in the runner's own state directory, which the sandbox profile does not let the agent
// read or write. The copy is append-only: it never shrinks, whatever happens to the agent's file. If the agent's file is
// truncated or rewritten, that is recorded (`tampered`) and everything in the new file counts again as new lines.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';

const TAIL = 64, MAX_LINE = 4000;

export class LedgerTail {
  private offset = 0;
  private last = Buffer.alloc(0);
  private carry = '';
  lines = 0;
  bytes = 0;
  tampered = false;
  private readonly source: string;
  private readonly copy: string;
  private readonly maxBytes: number;

  constructor(source: string, copy: string, maxBytes: number) {
    this.source = source; this.copy = copy; this.maxBytes = maxBytes;
    writeFileSync(copy, '', { flag: 'a', mode: 0o600 });
  }

  /** Copy what is new. Returns the number of lines added. Never throws on a missing or odd source file. */
  sync(): number {
    if (!existsSync(this.source)) { if (this.offset > 0) this.reset(); return 0; }
    let fd: number;
    try { fd = openSync(this.source, 'r'); } catch { return 0; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return 0;
      if (st.size < this.offset) this.reset();
      else if (this.last.length) {
        // the bytes just before our position must still be the ones we copied: otherwise the file was rewritten in place
        const probe = Buffer.alloc(this.last.length);
        readSync(fd, probe, 0, probe.length, this.offset - probe.length);
        if (!probe.equals(this.last)) this.reset();
      }
      let added = 0;
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.last = Buffer.concat([this.last, buf.subarray(0, n)]).subarray(-TAIL);
        const parts = (this.carry + buf.subarray(0, n).toString('utf8')).split('\n');
        this.carry = parts.pop() ?? '';
        if (this.carry.length > MAX_LINE * 4) this.carry = this.carry.slice(0, MAX_LINE * 4); // an endless line is cut, not buffered for ever
        for (const raw of parts) {
          if (!raw.trim()) continue;
          const line = raw.length > MAX_LINE ? JSON.stringify({ kind: 'oversized', bytes: raw.length }) : raw;
          this.lines += 1; added += 1;
          if (this.bytes + line.length + 1 <= this.maxBytes) { appendFileSync(this.copy, line + '\n'); this.bytes += line.length + 1; }
        }
      }
      return added;
    } finally { closeSync(fd); }
  }

  private reset(): void { this.tampered = true; this.offset = 0; this.last = Buffer.alloc(0); this.carry = ''; }
}
