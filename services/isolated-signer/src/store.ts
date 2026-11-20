import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { appendAudit, auditHash, DEFAULT_POLICY, PolicySchema, verifyAuditChain, type AuditRecord, type CctpBridge, type Mandate, type Policy } from '@spw/core';

/**
 * `lastUsedAt` and `addedBy` (NEXT, optional — absent on a credential written before): the last approval this signer verified
 * with the passkey, and the passkey that approved its addition (absent on the first one, pinned with the setup token).
 */
export interface StoredCredential { id: string; publicKey: string; counter: number; transports?: string[]; addedAt: string; lastUsedAt?: string; addedBy?: string }
export interface SignerState {
  v: 1;
  halted: boolean;
  setupTokenHash: string | null;
  credentials: StoredCredential[];
  /** proposalId -> expiresAt (unix s); single-use replay cache */
  used: Record<string, number>;
  /** "<YYYY-MM-DD>|<network>:<symbol>" -> base units signed that UTC day */
  spent: Record<string, string>;
  /**
   * IN MEMORY: the last records of the journal (a bounded window, see JOURNAL_TAIL). ON DISK, since V11: always `[]` — the
   * records live in the append-only journal file and `journalRef` names the last one. A state.json written before V11 holds
   * the whole journal here and no `journalRef`: it is read as such and moved to the journal file at the first save.
   */
  journal: AuditRecord[];
  /** V11: sequence number and hash of the last journal record this state was saved with (absent in a pre-V11 file) */
  journalRef?: { seq: number; hash: string };
  /** agent mandates approved by the owner; usage is counted per UTC day */
  mandates?: Record<string, StoredMandate>;
  /** bridges approved by the owner (proposalId -> record): each authorises the one matching mint on the destination, with no expiry */
  bridges?: Record<string, StoredBridge>;
  /** live derivatives: venue authorizations approved by the owner (authorizationId -> record). Never deleted: a revoked one stays revoked. */
  venues?: Record<string, StoredVenueAuthorization>;
  /** venue withdrawals signed by the main key after a passkey approval (withdrawalId -> record), kept 30 days (venue-collateral.ts) */
  venueWithdrawals?: Record<string, import('./venue-collateral.ts').StoredVenueWithdrawal>;
  /** derivative mandates approved by the owner (mandateId -> record), each extending one venue authorization. Never deleted. */
  venueMandates?: Record<string, StoredVenueMandate>;
  /** V11: quoting mandates (market making) approved by the owner (mandateId -> record), each extending one venue authorization.
   *  Never deleted. Absent in a state written before V11; a pre-V11 binary keeps the field untouched but does not know it
   *  (rollback rule: revoke every quoting mandate BEFORE rolling the signer back — docs/v11/work/mm-core.md). */
  venueQuotingMandates?: Record<string, StoredVenueQuotingMandate>;
  /** v8: GMX venue policies approved by the owner (authorizationId -> record). Never deleted: a revoked one stays revoked. */
  gmx?: Record<string, import('./venue-gmx.ts').StoredGmxAuthorization>;
  // NFT delivery 2 — three OPTIONAL fields, absent in every state written before. An older binary keeps them on disk untouched
  // (it rewrites the fields it does not know as it read them) but does not ENFORCE them: see the rollback rule in
  // docs/runbooks/deploy.md ("Signer state added by NFT delivery 2").
  /** "<YYYY-MM-DD>" -> NFT transfers signed that UTC day (nft.ts); kept three days */
  nftDaily?: Record<string, number>;
  /** "<network>:<address>" -> destination the owner approved with the passkey for NFT transfers (allow-list mode) */
  nftAllow?: Record<string, { at: number }>;
  /** network -> "<txid>:<vout>" -> lock. An ordinary send that names a locked outpoint is refused (inscription safety). Never pruned. */
  utxoLocks?: Record<string, Record<string, import('./nft.ts').StoredUtxoLock>>;
  // NEXT — three OPTIONAL fields, absent in every state written before. An older binary keeps them on disk untouched and does
  // not enforce them: see the rollback rule in docs/runbooks/deploy.md ("Signer state added by NEXT").
  /** "<YYYY-MM-DD>" -> vault index -> passkey-less returns signed for that vault that UTC day (audit C3); kept three days */
  vaultReturns?: Record<string, Record<string, number>>;
  /** when the operator last completed `export-recovery` / last typed a phrase that `verify-recovery` found to match (ISO dates) */
  recoveryExportedAt?: string;
  recoveryVerifiedAt?: string;
}
/** an order signed with a trading key that can still add exposure on the venue: kept until its venue expiry + a grace (venue-mandate.ts) */
export interface VenuePendingOrder { clientId: string; instrument: string; side: 'buy' | 'sell'; size: string; price: string; /** unix ms */ until: number; /** unix ms */ signedAt?: number;
  /** V11: 1 = a quote signed under a quoting mandate (venue-quoting.ts drops it once the venue lists it); absent on every other entry */ q?: 1 }
/**
 * `usage`: per UTC day — orders that can add exposure, reduce-only orders, cancels, leverage changes, and the summed notional of
 * the first. `hour`: unix seconds of the exposure-adding orders signed in the last hour.
 */
export interface StoredVenueMandate { mandate: import('@spw/derivatives/live').VenueMandate; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string;
  usage: Record<string, { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: string }>; hour: number[] }
/**
 * V11 quoting mandate record. `usage`: per UTC day — quotes signed (orders), quote batches, reduce-only orders, cancels,
 * dead-man's-switch heartbeats, summed notional of the quotes, and presumed triggers of the switch (`lapses`). `hours`: quotes
 * per UTC hour ("YYYY-MM-DDTHH"). `bucket`: the token bucket of quote batches — persisted, so a restart refills nothing.
 * `dms`: the deadline (unix ms) of the last scheduleCancel this signer signed for the account, null when none is in force.
 */
export interface StoredVenueQuotingMandate { mandate: import('@spw/derivatives/live').VenueQuotingMandate; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string;
  usage: Record<string, { quotes: number; batches: number; reduceOnly: number; cancels: number; heartbeats: number; turnover: string; lapses: number }>; hours: Record<string, number>;
  bucket: import('@spw/derivatives/live').QuotingBucket; dms: { deadline: number; signedAt: number } | null }
/**
 * `approve`: the one approveAgent signature the main key made for this authorization (kept so that a lost answer gets the same
 * bytes again, never a second signature). `nonces`: the highest venue nonces signed with the trading key (ascending, at most 100 — the venue's own rule). `clientIds`: client
 * order id -> unix day number it was signed (replay; kept three days). `usage`: orders signed per UTC day.
 */
export interface StoredVenueAuthorization { authorization: import('@spw/derivatives/live').VenueAuthorization; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string;
  approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number }; nonces: number[]; clientIds: Record<string, number>; usage: Record<string, { orders: number; cancels: number; leverage: number }>;
  /** exposure ledger shared by manual and mandate orders of this trading key (read only by mandates) */ pending?: VenuePendingOrder[] }
/**
 * `mint` is set when a receiveMessage transaction has been signed for this bridge. `raw` is kept so that an identical
 * request (lost answer, restart) gets the same bytes back instead of a second signature.
 */
export interface StoredBridge { bridge: CctpBridge; approvedAt: number; burnTxid: string;
  mint?: { messageHash: string; txid: string; raw: string; params: string; signedAt: number; signatures: number };
  /** v8, a burn on Solana: the one-time event account the signer generated for it (public key only; the secret is never stored) */
  sol?: { eventAccount: string };
  /** v8: the last reclaim_event_account signature for that account (each one needs the owner's passkey) */
  reclaim?: { txid: string; signedAt: number; signatures: number } }
export interface StoredMandate { mandate: Mandate; approvedAt: string; revoked: boolean; revokedAt?: string; usage: Record<string, { sold: Record<string, string>; orders: number }> }

const EMPTY: SignerState = { v: 1, halted: false, setupTokenHash: null, credentials: [], used: {}, spent: {}, journal: [] };

// ---------------------------------------------------------------------------------------------------------------------------
// V11 (B-05, B-06) — the journal is an append-only file next to state.json, and one process at a time writes the state.
//
//   <dir>/state.json            counters, replay markers, authorizations, `journalRef` (last record) — small, rewritten atomically
//   <dir>/journal.jsonl         one audit record per line, appended and fsynced BEFORE state.json is replaced
//   <dir>/journal-<a>-<b>.jsonl a closed segment (records a..b), produced by rotation; never written again
//   <dir>/state.lock            pid of the process that owns the state (the daemon, or a CLI command when no daemon runs)
//
// Order of a save: journal lines first, state second. A crash in between leaves the journal AHEAD of the state: the records
// describe a decision whose counters were not saved and whose signature was therefore never released; at the next start the
// journal's own last record becomes the head again. The chain (seq, prev, hash) runs unbroken across segments.

/** records kept in memory (`state.journal`); the file is the whole journal */
export const JOURNAL_TAIL = 1000;
/** a journal file is closed and a new one started once it is this large */
export const JOURNAL_ROTATE_BYTES = 8 * 1024 * 1024;
export interface StoreOptions { journalPath?: string; rotateBytes?: number; tail?: number }

/** first record that does not follow from the one before it (seq + 1, prev = hash of the previous, own hash valid); null = intact */
export function verifyJournalSegment(records: AuditRecord[], before: { seq: number; hash: string } | null = null): number | null {
  let prev = before;
  for (const r of records) {
    const { hash, ...rest } = r;
    if (auditHash(rest) !== hash || (prev !== null && (r.seq !== prev.seq + 1 || r.prev !== prev.hash))) return r.seq;
    prev = { seq: r.seq, hash };
  }
  return null;
}

export class StoreLockedError extends Error { constructor(public pid: number, path: string) { super(`the signer state is in use by process ${pid} (${path})`); } }
/**
 * Exclusive ownership of the signer directory. The daemon holds it for its whole life; a CLI command that changes the state
 * takes it only when no daemon runs (otherwise it asks the daemon, control.ts). A lock left by a process that no longer
 * exists is taken over. Returns the release function.
 */
export function acquireStateLock(statePath: string): () => void {
  const path = `${statePath}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let k = 0; k < 3; k++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      let released = false;
      return () => { if (released) return; released = true; try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(readFileSync(path, 'utf8').trim()); } catch { continue; } // released meanwhile: try again
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (x) { alive = (x as NodeJS.ErrnoException).code === 'EPERM'; } }
      if (alive) throw new StoreLockedError(pid, path);
      try { unlinkSync(path); } catch { /* another process took it over */ }
    }
  }
  throw new Error(`could not take the signer state lock (${path})`);
}

export class Store {
  state: SignerState;
  policy: Policy;
  /** first broken sequence number of the journal as found on disk (null = intact). The daemon refuses to start on a broken journal. */
  journalBrokenAt: number | null = null;
  private readonly journalPath: string;
  private readonly rotateBytes: number;
  private readonly tail: number;
  private head: AuditRecord | null = null;
  /** records logged (or carried by a pre-V11 state) that are not in the journal file yet */
  private unsaved: AuditRecord[] = [];
  /** a pre-V11 state.json: the journal file is (re)written whole at the first save */
  private migrate = false;
  /** sequence number of the first record of the current journal file (null = the file is empty or absent) */
  private fileFirstSeq: number | null = null;
  /** bytes of an incomplete last line found in the journal file when it was read */
  private torn = 0;
  /** a separate chain a pre-V11 binary wrote into the state after a rollback: moved to a side file at the first save */
  private rollback: AuditRecord[] | null = null;

  constructor(private statePath: string, private policyPath: string, opts: StoreOptions = {}) {
    this.journalPath = opts.journalPath ?? join(dirname(statePath), 'journal.jsonl');
    this.rotateBytes = opts.rotateBytes ?? JOURNAL_ROTATE_BYTES;
    this.tail = opts.tail ?? JOURNAL_TAIL;
    this.state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as SignerState) : structuredClone(EMPTY);
    this.loadJournal();
    if (existsSync(policyPath)) this.policy = PolicySchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
    else { this.policy = DEFAULT_POLICY; this.atomicWrite(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2)); }
  }

  /** Reads only: nothing is written here (the CLI `status` command opens a store next to a running daemon). */
  private loadJournal(): void {
    const s = this.state, inState = Array.isArray(s.journal) ? s.journal : [];
    if (s.journalRef === undefined) {
      // a state.json of before V11 (or a new one): the journal is the array itself
      this.journalBrokenAt = verifyAuditChain(inState);
      this.head = inState[inState.length - 1] ?? null;
      this.unsaved = [...inState]; this.migrate = inState.length > 0;
      s.journal = inState.slice(-this.tail);
      return;
    }
    const ref = s.journalRef, file = this.readSegment(this.journalPath);
    let recs = file.records, last = recs[recs.length - 1] ?? null;
    this.torn = file.torn;
    this.fileFirstSeq = recs[0]?.seq ?? null;
    this.journalBrokenAt = verifyJournalSegment(recs);
    if (last === null) {
      // empty: legitimate only right after a rotation (the closed segment ends at the state's reference)
      if (!readdirSync(dirname(this.journalPath)).some((f) => f.startsWith('journal-') && f.endsWith(`-${ref.seq}.jsonl`))) this.journalBrokenAt ??= ref.seq;
      last = { seq: ref.seq, hash: ref.hash } as AuditRecord;
    } else if (last.seq < ref.seq) this.journalBrokenAt ??= last.seq + 1;                          // the file lost records the state was saved with
    else if (recs.find((r) => r.seq === ref.seq)?.hash !== ref.hash && !(recs[0]!.seq === ref.seq + 1 && recs[0]!.prev === ref.hash)) this.journalBrokenAt ??= ref.seq; // not the same chain
    // Records found in the state itself: a pre-V11 binary ran on this directory after this version (a rollback) and journaled
    // the only way it knows. Either they continue the chain (taken into the file), or they are a chain of their own that it
    // started from nothing because it saw `journal: []` (kept whole in a side file, whose head the main chain then records —
    // see save()). Anything else is a broken journal.
    const extra = inState.filter((r) => r.seq > last!.seq);
    if (inState.length && extra.length === inState.length && verifyJournalSegment(extra, { seq: last.seq, hash: last.hash }) === null) { this.unsaved = [...extra]; recs = [...recs, ...extra]; }
    else if (inState.length && verifyAuditChain(inState) === null) this.rollback = [...inState];
    else if (inState.length) this.journalBrokenAt ??= inState[0]!.seq;
    this.head = recs[recs.length - 1] ?? last;
    s.journal = recs.slice(-this.tail);
  }
  /** the records of one journal file; an incomplete last line (a crash while appending) is not a record */
  private readSegment(path: string): { records: AuditRecord[]; torn: number } {
    if (!existsSync(path)) return { records: [], torn: 0 };
    const text = readFileSync(path, 'utf8'), lines = text.split('\n'), records: AuditRecord[] = [];
    let good = 0;
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k]!;
      if (line === '') { if (k < lines.length - 1) good += 1; continue; }
      let rec: AuditRecord | null = null;
      try { rec = JSON.parse(line) as AuditRecord; } catch { rec = null; }
      if (rec === null || k === lines.length - 1) {
        // unreadable, or readable but not terminated by a newline: only tolerated as the very last line
        if (k !== lines.length - 1) { records.push({ seq: -1, ts: '', type: 'unreadable', actor: '', data: {}, prev: '', hash: '' }); good += Buffer.byteLength(line) + 1; continue; }
        return { records, torn: Buffer.byteLength(text) - good };
      }
      records.push(rec); good += Buffer.byteLength(line) + 1;
    }
    return { records, torn: 0 };
  }

  private atomicWrite(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  }
  private flushJournal(): void {
    if (!this.unsaved.length && !this.migrate) return;
    const lines = this.unsaved.map((r) => `${JSON.stringify(r)}\n`).join('');
    if (this.migrate) { this.atomicWrite(this.journalPath, lines); this.fileFirstSeq = this.unsaved[0]?.seq ?? null; this.migrate = false; }
    else {
      mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
      // an incomplete last line left by a crash while appending (seen when the file was read) is cut before the first append;
      // after that every append of this process is whole lines, fsynced
      if (this.torn > 0) { const fd = openSync(this.journalPath, 'r+'); try { ftruncateSync(fd, statSync(this.journalPath).size - this.torn); fsyncSync(fd); } finally { closeSync(fd); } this.torn = 0; }
      const fd = openSync(this.journalPath, 'a', 0o600);
      try { writeSync(fd, lines); fsyncSync(fd); } finally { closeSync(fd); }
      this.fileFirstSeq ??= this.unsaved[0]!.seq;
    }
    this.unsaved = [];
  }
  /** closes the current journal file once it is large: it is renamed, never written again, and the chain goes on in a new file */
  private rotate(): void {
    if (this.head === null || this.fileFirstSeq === null || !existsSync(this.journalPath) || statSync(this.journalPath).size < this.rotateBytes) return;
    const to = join(dirname(this.journalPath), `${basename(this.journalPath, '.jsonl')}-${this.fileFirstSeq}-${this.head.seq}.jsonl`);
    renameSync(this.journalPath, to);
    this.fileFirstSeq = null;
  }

  /** Durably persist before any signature is released: the journal lines first, then the state that refers to them. */
  save(): void {
    if (this.rollback) {
      // what the old binary journaled while it ran is not lost and not silently merged: its records go, untouched, to a file
      // of their own, and the main chain commits to that file's last hash
      const seg = this.rollback, first = seg[0]!, lastRec = seg[seg.length - 1]!, name = `journal-rollback-${first.ts.replace(/[^0-9]/g, '').slice(0, 14)}.jsonl`;
      this.atomicWrite(join(dirname(this.journalPath), name), seg.map((r) => `${JSON.stringify(r)}\n`).join(''));
      this.rollback = null;
      this.log('journal.rollback_segment', { file: name, records: seg.length, firstTs: first.ts, lastTs: lastRec.ts, headHash: lastRec.hash });
    }
    this.flushJournal();
    const { journal: _tail, journalRef: _ref, ...rest } = this.state;
    void _tail; void _ref;
    const ref = this.head ? { seq: this.head.seq, hash: this.head.hash } : undefined;
    if (ref) this.state.journalRef = ref;
    this.atomicWrite(this.statePath, JSON.stringify({ ...rest, journal: [], ...(ref ? { journalRef: ref } : {}) }));
    this.rotate(); // after the state names the segment's last record
  }
  log(type: string, data: Record<string, unknown>): void {
    const rec = appendAudit(this.head, type, 'signer', data);
    this.head = rec; this.unsaved.push(rec);
    const j = this.state.journal;
    j.push(rec);
    if (j.length > this.tail * 2) j.splice(0, j.length - this.tail);
  }
  /** the last record of the journal (logged, not necessarily saved yet); null for an empty journal */
  journalHead(): { seq: number; hash: string } | null { return this.head ? { seq: this.head.seq, hash: this.head.hash } : null; }
  /** every record of the CURRENT journal file plus what is not saved yet — for the CLI and tests; closed segments are not read */
  journalRecords(): AuditRecord[] {
    return this.migrate ? [...this.unsaved] : [...this.readSegment(this.journalPath).records, ...this.unsaved];
  }
  prune(nowSec: number): void {
    for (const [k, exp] of Object.entries(this.state.used)) if (exp + 86400 < nowSec) delete this.state.used[k];
    const keep = new Date((nowSec - 3 * 86400) * 1000).toISOString().slice(0, 10);
    for (const k of Object.keys(this.state.spent)) if (k.slice(0, 10) < keep) delete this.state.spent[k];
    for (const k of Object.keys(this.state.nftDaily ?? {})) if (k < keep) delete this.state.nftDaily![k]; // NFT delivery 2
    for (const k of Object.keys(this.state.vaultReturns ?? {})) if (k < keep) delete this.state.vaultReturns![k]; // NEXT (C3)
    for (const m of Object.values(this.state.mandates ?? {})) for (const d of Object.keys(m.usage)) if (d < keep) delete m.usage[d];
    // a bridge whose mint was signed is kept 90 more days (retries); one that was never minted is kept for ever
    // v8: a Solana burn whose event-account deposit was never reclaimed is kept (the record is the only authority for the reclaim)
    for (const [k, b] of Object.entries(this.state.bridges ?? {})) if (b.mint && b.mint.signedAt + 90 * 86400 < nowSec && !(b.sol && !b.reclaim)) delete this.state.bridges![k];
    // venue authorizations: daily counters and client order ids older than three days go (an order approval is valid two minutes,
    // and the venue nonce only moves forward, so an old client id cannot come back without a new passkey approval)
    for (const v of Object.values(this.state.venues ?? {})) {
      for (const d of Object.keys(v.usage)) if (d < keep) delete v.usage[d];
      for (const [c, d] of Object.entries(v.clientIds)) if (d < Math.floor(nowSec / 86400) - 3) delete v.clientIds[c];
      if (v.pending) v.pending = v.pending.filter((p) => p.until > nowSec * 1000);
    }
    for (const m of Object.values(this.state.venueMandates ?? {})) {
      for (const d of Object.keys(m.usage)) if (d < keep) delete m.usage[d];
      m.hour = m.hour.filter((t) => t > nowSec - 3600);
    }
    const keepHour = new Date((nowSec - 2 * 3600) * 1000).toISOString().slice(0, 13);
    for (const m of Object.values(this.state.venueQuotingMandates ?? {})) {
      for (const d of Object.keys(m.usage)) if (d < keep) delete m.usage[d];
      for (const h of Object.keys(m.hours)) if (h < keepHour) delete m.hours[h];
    }
  }
}
