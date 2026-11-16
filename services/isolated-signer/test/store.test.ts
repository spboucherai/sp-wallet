// V11 Phase B (B-05, B-06) — the signer's state on disk: the append-only journal file and its rotation, the read path of a
// state.json written BEFORE V11 (fixture in the old format), the state lock, and the operator's commands reaching a running
// daemon through its control socket instead of being undone by it. No network. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, mandateHash, verifyAuditChain, type AuditRecord, type Mandate } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { applyControl, controlCall, isControlRequest, startControlServer } from '../src/control.ts';
import { deriveKeys } from '../src/keys.ts';
import { createQueue } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { acquireStateLock, Store, StoreLockedError, verifyJournalSegment, type SignerState } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const FIXTURE = join(import.meta.dirname, 'fixtures');
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'spw-store-')); return { dir, state: join(dir, 'state.json'), policy: join(dir, 'policy.json'), journal: join(dir, 'journal.jsonl'), sock: join(dir, 'control.sock') }; };
const lines = (path: string): AuditRecord[] => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as SignerState;
/** the fixture, copied into a new directory as the production files would be found by the new binary */
const legacy = () => { const p = fresh(); copyFileSync(join(FIXTURE, 'state-pre-v11.json'), p.state); copyFileSync(join(FIXTURE, 'policy-pre-v11.json'), p.policy); return p; };
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

describe('journal file (B-05)', () => {
  it('records go to an append-only file; state.json keeps only a reference to the last one and no longer grows with the journal', () => {
    const p = fresh(), s = new Store(p.state, p.policy);
    expect(s.journalHead()).toBeNull();
    for (let k = 0; k < 50; k++) { s.log('test.event', { k, pad: 'x'.repeat(200) }); s.save(); }
    const sizeAt50 = statSync(p.state).size;
    for (let k = 50; k < 400; k++) { s.log('test.event', { k, pad: 'x'.repeat(200) }); s.save(); }
    expect(statSync(p.state).size).toBeLessThanOrEqual(sizeAt50 + 8);                 // only the digits of the sequence number
    const recs = lines(p.journal);
    expect(recs).toHaveLength(400);
    expect(verifyAuditChain(recs)).toBeNull();                                         // the same chain as before: genesis, seq, prev, hash
    expect(onDisk(p.state)).toMatchObject({ journal: [], journalRef: { seq: 400, hash: recs[399]!.hash } });
    expect(s.journalHead()).toEqual({ seq: 400, hash: recs[399]!.hash });
    // a new process finds the same head and goes on in the same chain
    const again = new Store(p.state, p.policy);
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()).toEqual(s.journalHead());
    again.log('test.after_restart', {}); again.save();
    expect(verifyAuditChain(lines(p.journal))).toBeNull();
    expect(lines(p.journal)).toHaveLength(401);
  });

  it('nothing is written to the journal file before save(), and an unsaved record is not in the next process', () => {
    const p = fresh(), s = new Store(p.state, p.policy);
    s.log('a', {}); s.save();
    s.log('b', {});
    expect(lines(p.journal).map((r) => r.type)).toEqual(['a']);
    expect(new Store(p.state, p.policy).journalHead()!.seq).toBe(1);
    s.save();
    expect(lines(p.journal).map((r) => r.type)).toEqual(['a', 'b']);
  });

  it('keeps a bounded window in memory, whatever the length of the journal', () => {
    const p = fresh(), s = new Store(p.state, p.policy, { tail: 20 });
    for (let k = 0; k < 500; k++) s.log('e', { k });
    s.save();
    expect(s.state.journal.length).toBeLessThanOrEqual(40);
    expect(s.state.journal.at(-1)!.data).toEqual({ k: 499 });
    const again = new Store(p.state, p.policy, { tail: 20 });
    expect(again.state.journal).toHaveLength(20);
    expect(again.state.journal.at(-1)!.seq).toBe(500);
    expect(again.journalRecords()).toHaveLength(500);
  });

  it('rotation: a full file is closed under its sequence range and the chain continues in a new one', () => {
    const p = fresh(), s = new Store(p.state, p.policy, { rotateBytes: 4000 });
    for (let k = 0; k < 60; k++) { s.log('e', { k, pad: 'y'.repeat(150) }); s.save(); }
    const segs = readdirSync(p.dir).filter((f) => /^journal-\d+-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    expect(segs.length).toBeGreaterThan(2);
    const all = [...segs.flatMap((f) => lines(join(p.dir, f))), ...(existsSync(p.journal) ? lines(p.journal) : [])];
    expect(all).toHaveLength(60);
    expect(verifyAuditChain(all)).toBeNull();                                          // one unbroken chain across the segments
    for (const f of segs) { const r = lines(join(p.dir, f)); expect(f).toBe(`journal-${r[0]!.seq}-${r.at(-1)!.seq}.jsonl`); expect(statSync(join(p.dir, f)).size).toBeLessThan(4000 + 600); }
    // restart in every position, including right after a rotation (the current file does not exist yet)
    const again = new Store(p.state, p.policy, { rotateBytes: 4000 });
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()!.seq).toBe(60);
    again.log('after', {}); again.save();
    const t = new Store(p.state, p.policy, { rotateBytes: 4000 });
    expect(t.journalBrokenAt).toBeNull(); expect(t.journalHead()!.seq).toBe(61);
    const p2 = fresh(), r2 = new Store(p2.state, p2.policy, { rotateBytes: 1 });
    r2.log('only', {}); r2.save();                                                     // rotated at once: no current file
    expect(existsSync(p2.journal)).toBe(false);
    const r3 = new Store(p2.state, p2.policy, { rotateBytes: 1 });
    expect(r3.journalBrokenAt).toBeNull();
    r3.log('next', {}); r3.save();
    expect(verifyAuditChain([...lines(join(p2.dir, 'journal-1-1.jsonl')), ...lines(join(p2.dir, 'journal-2-2.jsonl'))])).toBeNull();
  });

  it('a crash between the journal append and the state write: the journal is ahead, the chain is kept, nothing is lost', () => {
    const p = fresh(), s = new Store(p.state, p.policy);
    s.log('a', {}); s.save();
    const before = readFileSync(p.state, 'utf8');
    s.log('b', {}); s.save();
    writeFileSync(p.state, before);                                                    // the state of before the second save
    const again = new Store(p.state, p.policy);
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()!.seq).toBe(2);
    again.log('c', {}); again.save();
    expect(verifyAuditChain(lines(p.journal))).toBeNull();
    expect(lines(p.journal).map((r) => r.type)).toEqual(['a', 'b', 'c']);
  });

  it('a line cut by a crash while appending is dropped at the next append; any other damage is a broken journal', () => {
    const p = fresh(), s = new Store(p.state, p.policy);
    for (const t of ['a', 'b', 'c']) { s.log(t, {}); s.save(); }
    appendFileSync(p.journal, '{"seq":4,"ts":"2026-11-15T00:00:00.000Z","type":"hal');           // torn
    const again = new Store(p.state, p.policy);
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()!.seq).toBe(3);
    again.log('d', {}); again.save();
    expect(lines(p.journal).map((r) => r.type)).toEqual(['a', 'b', 'c', 'd']);
    expect(verifyAuditChain(lines(p.journal))).toBeNull();
    // a record altered in place
    const recs = lines(p.journal); recs[1] = { ...recs[1]!, data: { forged: true } };
    writeFileSync(p.journal, recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
    expect(new Store(p.state, p.policy).journalBrokenAt).toBe(2);
    // a record removed from the middle, or from the end (the state refers to a record the file no longer has)
    const good = fresh(), g = new Store(good.state, good.policy);
    for (const t of ['a', 'b', 'c']) { g.log(t, {}); g.save(); }
    const three = lines(good.journal);
    writeFileSync(good.journal, [three[0], three[2]].map((r) => `${JSON.stringify(r)}\n`).join(''));
    expect(new Store(good.state, good.policy).journalBrokenAt).toBe(3);
    writeFileSync(good.journal, [three[0], three[1]].map((r) => `${JSON.stringify(r)}\n`).join(''));
    expect(new Store(good.state, good.policy).journalBrokenAt).toBe(3);
    writeFileSync(good.journal, '');
    expect(new Store(good.state, good.policy).journalBrokenAt).toBe(3);                            // emptied, and no closed segment ends there
    // an unreadable line that is not the last
    writeFileSync(good.journal, `${JSON.stringify(three[0])}\nnot json\n${JSON.stringify(three[2])}\n`);
    expect(new Store(good.state, good.policy).journalBrokenAt).not.toBeNull();
    expect(verifyJournalSegment(three)).toBeNull();
    expect(verifyJournalSegment(three.slice(1), { seq: 1, hash: three[0]!.hash })).toBeNull();
    expect(verifyJournalSegment(three.slice(1), { seq: 1, hash: 'ff'.repeat(32) })).toBe(2);
  });
});

describe('a state.json and policy.json written before V11 (fixture in the old format)', () => {
  it('is read as it is: credentials, halt, replay markers, spend, mandates, authorizations, journal, policy', () => {
    const p = legacy(), raw = onDisk(join(FIXTURE, 'state-pre-v11.json'));
    expect(raw.journalRef).toBeUndefined();                                            // the fixture really is the old format
    expect(raw.journal.length).toBeGreaterThan(5);
    const s = new Store(p.state, p.policy);
    expect(s.journalBrokenAt).toBeNull();
    expect(s.journalHead()).toEqual({ seq: raw.journal.length, hash: raw.journal.at(-1)!.hash });
    const { journal: _j, ...rest } = s.state, { journal: _r, ...rawRest } = raw;
    void _j; void _r;
    expect(rest).toEqual(rawRest);                                                     // every other field, untouched
    expect(s.state.journal).toEqual(raw.journal);
    expect(s.policy).toEqual(JSON.parse(readFileSync(join(FIXTURE, 'policy-pre-v11.json'), 'utf8')));
    // opening it changed nothing on disk (the CLI `status` command reads next to a running daemon)
    expect(readFileSync(p.state, 'utf8')).toBe(readFileSync(join(FIXTURE, 'state-pre-v11.json'), 'utf8'));
    expect(readFileSync(p.policy, 'utf8')).toBe(readFileSync(join(FIXTURE, 'policy-pre-v11.json'), 'utf8'));
    expect(existsSync(p.journal)).toBe(false);
  });

  it('the first save moves the whole journal to the file, in the same chain, and loses nothing of the state', () => {
    const p = legacy(), raw = onDisk(join(FIXTURE, 'state-pre-v11.json'));
    const s = new Store(p.state, p.policy);
    s.log('upgrade.first_save', {}); s.save();
    const recs = lines(p.journal);
    expect(recs.slice(0, raw.journal.length)).toEqual(raw.journal);                    // byte-for-byte the old records, then the new one
    expect(recs).toHaveLength(raw.journal.length + 1);
    expect(verifyAuditChain(recs)).toBeNull();
    const d = onDisk(p.state), { journal: _a, journalRef, ...now } = d, { journal: _b, ...was } = raw;
    void _a; void _b;
    expect(now).toEqual(was);
    expect(d.journal).toEqual([]);
    expect(journalRef).toEqual({ seq: recs.length, hash: recs.at(-1)!.hash });
    expect(readFileSync(p.policy, 'utf8')).toBe(readFileSync(join(FIXTURE, 'policy-pre-v11.json'), 'utf8'));   // the policy file is never rewritten
    const again = new Store(p.state, p.policy);
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()).toEqual(journalRef);
  });

  it('a crash in the middle of that first save is harmless: the state still holds the journal and the move is done again', () => {
    const p = legacy(), raw = onDisk(join(FIXTURE, 'state-pre-v11.json'));
    writeFileSync(p.journal, `${JSON.stringify(raw.journal[0])}\n${JSON.stringify(raw.journal[1])}\n`);   // a half-written journal file from the crashed attempt
    const s = new Store(p.state, p.policy);
    expect(s.journalBrokenAt).toBeNull();
    s.log('again', {}); s.save();
    expect(lines(p.journal)).toHaveLength(raw.journal.length + 1);
    expect(verifyAuditChain(lines(p.journal))).toBeNull();
  });

  it('the signer built on it behaves as the old one did: the halt is in force, the passkey still approves, the stored mandate still stands', async () => {
    const p = legacy(), raw = onDisk(join(FIXTURE, 'state-pre-v11.json'));
    const store = new Store(p.state, p.policy), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
    const st = signer.status();
    expect(st).toMatchObject({ halted: raw.halted, journalLength: raw.journal.length, journalHead: raw.journal.at(-1)!.hash, policy: JSON.parse(readFileSync(join(FIXTURE, 'policy-pre-v11.json'), 'utf8')) });
    expect(st.credentials.map((c) => c.id)).toEqual(raw.credentials.map((c) => c.id));
    expect(st.mandates.map((m) => m.mandate.mandateId)).toEqual(Object.keys(raw.mandates ?? {}));
    expect(st.policy.version).toBe(DEFAULT_POLICY.version);                            // no policy value or version was touched by the upgrade
    expect(st.policy).toEqual(DEFAULT_POLICY);
    expect(st.venues.map((v) => [v.authorization.authorizationId, v.revoked])).toEqual(Object.values(raw.venues!).map((v) => [v.authorization.authorizationId, v.revoked]));
    expect(st.mandates[0]).toMatchObject({ revoked: true });                           // revoked before the upgrade: revoked after
    // the fixture is halted: so is the new signer, before anything else is looked at
    const stored = Object.values(raw.mandates!)[0]!.mandate;
    const m: Mandate = { ...stored, mandateId: '7a1c1f0e-8f5f-4b1e-9c56-0000000000f2', vaultIndex: 2, vault: keys.vault(2).address };
    await expect(signer.approveMandate(m, new TestPasskey(RP, ORIGIN).assert(mandateHash(m)))).rejects.toThrow(/emergency halt is active/);
    // a replay marker of the old file still refuses the same proposal id
    expect(Object.keys(store.state.used)).toEqual(Object.keys(raw.used));
    expect(store.state.spent).toEqual(raw.spent);
    expect(verifyAuditChain(lines(p.journal))).toBeNull();                             // the denial was journaled after the old records, in the file
    expect(lines(p.journal)).toHaveLength(raw.journal.length + 1);
  });

  it('an old-format file with a live passkey: approvals still verify, counters and replay markers still bind, after the move', async () => {
    // written here exactly as the old store wrote it — JSON.stringify of the state with the whole journal inside and no journalRef —
    // because the static fixture's passkey private key is, rightly, not in the repository
    const a = fresh(), s0 = new Store(a.state, a.policy), now = Math.floor(Date.now() / 1000);
    s0.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
    const old = new Signer(keys, s0, { rpId: RP, origin: ORIGIN }), pk = new TestPasskey(RP, ORIGIN);
    await old.enroll({ credential: pk.credential(), setupToken: 'tok' });
    const stored = Object.values(onDisk(join(FIXTURE, 'state-pre-v11.json')).mandates!)[0]!.mandate;
    const m1: Mandate = { ...stored, mandateId: '7a1c1f0e-8f5f-4b1e-9c56-0000000000f3', createdAt: now, expiresAt: now + 86400 };
    await old.approveMandate(m1, pk.assert(mandateHash(m1)));
    const { journalRef: _drop, ...asOld } = { ...onDisk(a.state), journal: lines(a.journal) };
    void _drop;
    const p = fresh();
    writeFileSync(p.state, JSON.stringify(asOld)); copyFileSync(a.policy, p.policy);
    expect(Object.keys(onDisk(p.state))).not.toContain('journalRef');

    const store = new Store(p.state, p.policy), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
    expect(store.journalBrokenAt).toBeNull();
    expect(signer.status().credentials[0]!.id).toBe(pk.id);
    // the passkey counter stored by the old version still protects against a replayed assertion; a fresh one verifies
    const m2: Mandate = { ...m1, mandateId: '7a1c1f0e-8f5f-4b1e-9c56-0000000000f4', vaultIndex: 2, vault: keys.vault(2).address };
    expect((await signer.approveMandate(m2, pk.assert(mandateHash(m2)))).mandateId).toBe(m2.mandateId);
    await expect(signer.approveMandate(m1, pk.assert(mandateHash(m1)))).rejects.toThrow(/mandate already recorded/);     // the old record binds
    const m3: Mandate = { ...m1, mandateId: '7a1c1f0e-8f5f-4b1e-9c56-0000000000f5' };
    await expect(signer.approveMandate(m3, pk.assert(mandateHash(m3)))).rejects.toThrow(/another mandate is active on this vault/); // …also for the V11 rule
    const recs = lines(p.journal);
    expect(verifyAuditChain(recs)).toBeNull();
    expect(recs.map((r) => r.type)).toEqual(['credential.enrolled', 'mandate.approved', 'mandate.approved', 'mandate.denied', 'mandate.denied']);
    expect(new Signer(keys, new Store(p.state, p.policy), { rpId: RP, origin: ORIGIN }).status().mandates).toHaveLength(2);
  });

  it('records appended to the state by the old binary after a rollback are taken into the file; a chain that does not continue is a broken journal', () => {
    const p = fresh(), s = new Store(p.state, p.policy);
    for (const t of ['a', 'b']) { s.log(t, {}); s.save(); }
    const two = lines(p.journal), d = onDisk(p.state);
    // the old binary keeps unknown fields and appends to `journal`
    const scratch = fresh(), tmp = new Store(scratch.state, scratch.policy);
    tmp.state.journal.push(...two); (tmp as unknown as { head: AuditRecord }).head = two[1]!;
    tmp.log('old.binary', {});
    const extra = tmp.state.journal.at(-1)!;
    writeFileSync(p.state, JSON.stringify({ ...d, journal: [extra] }));
    const again = new Store(p.state, p.policy);
    expect(again.journalBrokenAt).toBeNull();
    expect(again.journalHead()!.seq).toBe(3);
    again.save();
    expect(lines(p.journal).map((r) => r.type)).toEqual(['a', 'b', 'old.binary']);
    writeFileSync(p.state, JSON.stringify({ ...onDisk(p.state), journal: [{ ...extra, seq: 1, prev: '0'.repeat(64) }] }));   // a chain started over
    expect(new Store(p.state, p.policy).journalBrokenAt).not.toBeNull();
  });
});

describe('state lock and control socket (B-06)', () => {
  it('one owner at a time: a second taker is refused while the first lives; a lock left by a dead process is taken over', () => {
    const p = fresh(), release = acquireStateLock(p.state);
    expect(() => acquireStateLock(p.state)).toThrow(StoreLockedError);
    try { acquireStateLock(p.state); } catch (e) { expect((e as StoreLockedError).pid).toBe(process.pid); }
    release(); release();                                                              // idempotent
    const again = acquireStateLock(p.state); again();
    writeFileSync(`${p.state}.lock`, '2147483646');                                    // a pid that does not exist
    const taken = acquireStateLock(p.state);
    expect(readFileSync(`${p.state}.lock`, 'utf8')).toBe(String(process.pid));
    taken();
    expect(existsSync(`${p.state}.lock`)).toBe(false);
    writeFileSync(`${p.state}.lock`, 'garbage');
    acquireStateLock(p.state)();
  });

  it('BEFORE V11 a CLI halt under a running daemon was undone by the daemon\'s next save — the scenario, and why it can no longer happen', async () => {
    const p = fresh();
    // the daemon: owns the lock, holds the state in memory
    const release = acquireStateLock(p.state); closers.push(release);
    const daemon = new Store(p.state, p.policy), enqueue = createQueue();
    daemon.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
    const signer = new Signer(keys, daemon, { rpId: RP, origin: ORIGIN }), pk = new TestPasskey(RP, ORIGIN);
    await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
    const server = startControlServer(p.sock, (req) => enqueue(() => applyControl(daemon, req, 'daemon')));
    closers.push(() => server.close());
    await new Promise((r) => server.once('listening', r));
    expect(statSync(p.sock).mode & 0o077).toBe(0);                                     // the socket is the owner's alone
    // the old way — a second process writing the file — is refused outright
    expect(() => acquireStateLock(p.state)).toThrow(/in use by process/);
    // the CLI's way now: through the daemon
    const a = await controlCall(p.sock, { cmd: 'halt' });
    expect(a).toEqual({ ok: true, halted: true, credentials: 1, via: 'daemon' });
    expect(signer.status().halted).toBe(true);                                         // in force at once, no restart
    // the daemon keeps saving (denials, signatures…): the halt survives every save and is on disk
    daemon.log('some.later.event', {}); daemon.save();
    expect(onDisk(p.state).halted).toBe(true);
    expect(new Store(p.state, p.policy).state.halted).toBe(true);
    expect(lines(p.journal).map((r) => r.type)).toEqual(['credential.enrolled', 'halt.on', 'some.later.event']);
    expect(lines(p.journal)[1]!.data).toEqual({ via: 'cli' });
    // unhalt, setup-token (refused while a passkey exists), reset-passkeys, then a setup token
    expect(await controlCall(p.sock, { cmd: 'unhalt' })).toMatchObject({ ok: true, halted: false });
    expect(signer.status().halted).toBe(false);
    const hash = createHash('sha256').update('new-token').digest('hex');
    expect(await controlCall(p.sock, { cmd: 'setup-token', tokenHash: hash })).toEqual({ ok: false, error: 'a passkey is already enrolled; setup token refused' });
    expect(await controlCall(p.sock, { cmd: 'reset-passkeys' })).toMatchObject({ ok: true, credentials: 0 });
    expect(signer.status().credentials).toEqual([]);
    expect(await controlCall(p.sock, { cmd: 'setup-token', tokenHash: hash })).toMatchObject({ ok: true });
    daemon.log('x', {}); daemon.save();
    expect(onDisk(p.state)).toMatchObject({ halted: false, credentials: [], setupTokenHash: hash });
    await signer.enroll({ credential: new TestPasskey(RP, ORIGIN).credential(), setupToken: 'new-token' });      // the daemon really uses it
    expect(verifyAuditChain(lines(p.journal))).toBeNull();
  });

  it('the control socket takes the four commands and nothing else; with no daemon the CLI is told so', async () => {
    const p = fresh(), store = new Store(p.state, p.policy);
    expect(await controlCall(p.sock, { cmd: 'halt' })).toBeNull();                     // no socket: no daemon
    const server = startControlServer(p.sock, async (req) => applyControl(store, req, 'daemon'));
    await new Promise((r) => server.once('listening', r));
    for (const bad of [{ cmd: 'sign' }, { cmd: 'status' }, { cmd: 'setup-token' }, { cmd: 'setup-token', tokenHash: 'zz' }, { cmd: 'export-recovery' }, {}, null, 'halt', { cmd: 'unhalt ' }]) {
      expect(isControlRequest(bad), JSON.stringify(bad)).toBe(false);
      expect(await controlCall(p.sock, bad as never), JSON.stringify(bad)).toEqual({ ok: false, error: 'unknown control command' });
    }
    expect(store.state.halted).toBe(false);
    expect(store.journalHead()).toBeNull();
    await new Promise((r) => server.close(r));
    expect(await controlCall(p.sock, { cmd: 'halt' })).toBeNull();                     // the socket file is left behind, nobody listens: treated as no daemon
    // without a daemon the same function writes the file under the lock
    const release = acquireStateLock(p.state);
    expect(applyControl(new Store(p.state, p.policy), { cmd: 'halt' }, 'file')).toMatchObject({ ok: true, halted: true, via: 'file' });
    release();
    expect(onDisk(p.state).halted).toBe(true);
  });
});
