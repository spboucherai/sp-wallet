// Rollback rehearsal of the SIGNER STATE (V11 final validation; docs/V11-DEPLOYMENT.md §9), with the signer code of BOTH
// versions in one process, each on the same directory, one after the other — as two deployments would be.
//
//   npx tsx scripts/rollback-signer-rehearsal.mts <path of a checkout of the previous release (a118e3e)>
//
//   Part A  the committed V10-format fixture (services/isolated-signer/test/fixtures/{state,policy}-pre-v11.json):
//           V11 code opens it and writes → the PREVIOUS code opens what V11 left and writes → V11 opens it again.
//   Part B  why "revoke every quoting mandate before rolling the signer back": a fresh directory, a software passkey, a
//           venue authorization and a QUOTING mandate approved by the V11 code; a directional mandate on the same
//           authorization is refused by V11 (`conflict`) and is asked again of the previous code on the same state.
//
// No network (prices are a constant, the venue reader is a scripted answer), no real key (the public BIP-39 test mnemonic),
// no venue, nothing sent anywhere. Temporary directories only. Prints what it observed; exits 1 if an observation differs
// from what docs/V11-DEPLOYMENT.md §9 states (so that the document cannot drift from the code silently).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jurisdictionAck, venueAuthorizationHash, venueMandateHash, venueQuotingMandateHash, type VenueAuthorization, type VenueMandate, type VenueQuotingMandate } from '@spw/derivatives/live';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';
import { hyperliquidReader } from '../services/isolated-signer/src/venue-read.ts';

const OLD = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(join(OLD, 'services/isolated-signer/src/signer.ts'))) { console.error('usage: rollback-signer-rehearsal.mts <checkout of the previous release>'); process.exit(2); }
const old = async (rel: string): Promise<any> => import(pathToFileURL(join(OLD, rel)).href);
const { Signer: OldSigner } = await old('services/isolated-signer/src/signer.ts'), { Store: OldStore } = await old('services/isolated-signer/src/store.ts');
const { deriveKeys: oldDeriveKeys } = await old('services/isolated-signer/src/keys.ts');
let oldReader: any = null;
try { oldReader = (await old('services/isolated-signer/src/venue-read.ts')).hyperliquidReader; } catch { /* the previous release reads the venue elsewhere */ }

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', keys = deriveKeys(MNEMONIC), oldKeys = oldDeriveKeys(MNEMONIC);
const FIX = new URL('../services/isolated-signer/test/fixtures/', import.meta.url);
let failed = 0;
const say = (s: string): void => console.log(s);
const check = (what: string, got: unknown, want: unknown): void => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed += 1; say(`  ${ok ? 'as documented' : 'DIFFERS     '}  ${what}: ${JSON.stringify(got)}${ok ? '' : ` (documented: ${JSON.stringify(want)})`}`); };
const files = (dir: string): string => readdirSync(dir).sort().map((f) => `${f} (${statSync(join(dir, f)).size} B)`).join(', ');
const attempt = async (f: () => unknown): Promise<string> => { try { await f(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code ?? 'error'}: ${(e as Error).message.slice(0, 140)}`; } };
const onDisk = (dir: string): any => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

// ------------------------------------------------------------------------------------------------------------- Part A
say('== Part A — the V10-format fixture: V11 → previous release → V11');
{
  const dir = mkdtempSync(join(tmpdir(), 'spw-rb-signer-a-')), sp = join(dir, 'state.json'), pp = join(dir, 'policy.json');
  copyFileSync(new URL('state-pre-v11.json', FIX), sp); copyFileSync(new URL('policy-pre-v11.json', FIX), pp);
  const before = onDisk(dir), policyBefore = readFileSync(pp, 'utf8');
  say(`  fixture: ${before.journal.length} journal records inside state.json, ${before.credentials.length} credential(s), halted=${before.halted}; files: ${files(dir)}`);

  const s1 = new Store(sp, pp);
  check('V11 opens the old state — journal intact', s1.journalBrokenAt, null);
  const g1 = new Signer(keys, s1, { rpId: RP, origin: ORIGIN });
  g1.halt();                                                                                  // a state change that journals and saves
  const afterV11 = onDisk(dir);
  say(`  after V11 wrote (halt): files: ${files(dir)}`);
  check('state.json no longer carries the journal array (it holds a reference)', [Array.isArray(afterV11.journal) ? afterV11.journal.length : null, typeof afterV11.journalRef], [0, 'object']);
  check('policy.json untouched by V11', readFileSync(pp, 'utf8') === policyBefore, true);
  const v11Status = g1.status() as any;
  say(`  V11 status: keyId ${v11Status.keyId}, halted=${v11Status.halted}, journalLength=${v11Status.journalLength}`);

  // the PREVIOUS release on what V11 left
  let o1: any = null; const openOld = await attempt(() => { o1 = new OldStore(sp, pp); });
  check('the previous release opens the V11 state', openOld, 'ok');
  if (o1) {
    const og = new OldSigner(oldKeys, o1, { rpId: RP, origin: ORIGIN }), st = og.status();
    say(`  previous release status: keyId ${st.keyId}, halted=${st.halted}, journalLength=${st.journalLength}, credentials=${o1.state.credentials.length}`);
    check('same key id under both versions', st.keyId, v11Status.keyId);
    check('the previous release sees the halt V11 recorded', st.halted, true);
    check('the previous release sees an EMPTY journal (it does not read journal.jsonl)', st.journalLength, 0);
    check('replay markers and spending counters written before are still there', [Object.keys(o1.state.used).length, Object.keys(o1.state.spent).length], [Object.keys(before.used).length, Object.keys(before.spent).length]);
    o1.state.halted = false; o1.log('halt.off', { by: 'rehearsal: the operator on the previous release' }); o1.save();   // what its CLI `unhalt` does
    const afterOld = onDisk(dir);
    say(`  after the previous release wrote (unhalt): state.json journal array = ${afterOld.journal.length} record(s); journalRef kept = ${afterOld.journalRef !== undefined}; files: ${files(dir)}`);
  }
  // forward again
  const s2 = new Store(sp, pp);
  check('V11 opens it again — journal intact', s2.journalBrokenAt, null);
  const g2 = new Signer(keys, s2, { rpId: RP, origin: ORIGIN }), st2 = g2.status() as any;
  check('V11 sees the unhalt made under the previous release', st2.halted, false);
  g2.halt();
  const side = readdirSync(dir).filter((f) => f.startsWith('journal-rollback-'));
  check('what the previous release journaled is kept in ONE side file', side.length, 1);
  say(`  after V11 wrote again: journalLength=${(g2.status() as any).journalLength}; files: ${files(dir)}`);
  check('a third V11 start finds the journal intact', new Store(sp, pp).journalBrokenAt, null);
}

// ------------------------------------------------------------------------------------------------------------- Part B
say('\n== Part B — a quoting mandate left active, then the previous release on the same state');
{
  const dir = mkdtempSync(join(tmpdir(), 'spw-rb-signer-b-')), sp = join(dir, 'state.json'), pp = join(dir, 'policy.json');
  const t = { now: Math.floor(Date.now() / 1000) }, ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
  const ACK = jurisdictionAck('hyperliquid', 'fr').sha256, SHA = 'ab'.repeat(32);
  const prices = { get: async (syms: string[]) => Object.fromEntries(syms.map((s) => [s, s === 'BTC' ? 70_000 : 2_000])) };
  const post = async (_url: string, body: any): Promise<unknown> => {
    const summary = { accountValue: '1000', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' };
    if (body.type === 'clearinghouseState') return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions: [], time: t.now * 1000 };
    if (body.type === 'frontendOpenOrders') return [];
    if (body.type === 'orderStatus') return { status: 'unknownOid' };
    if (body.type === 'activeAssetData') return { user: body.user, coin: body.coin, leverage: { type: 'cross', value: 3 }, markPx: '0' };
    throw new Error(`scripted venue: no answer for ${body.type}`);
  };
  const store = new Store(sp, pp);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, prices as never, hyperliquidReader(post));
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const uuid = (n: number): string => `8b2d2f1e-9a6a-4c2f-8d67-${String(n).padStart(12, '0')}`;
  const a: VenueAuthorization = { v: 1, authorizationId: uuid(1), keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
    policy: { allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxLeverage: 5, maxOrderNotional: '300', maxPositionNotional: '500', maxGrossExposure: '800', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 },
    createdAt: t.now, expiresAt: t.now + 60 * 86400, approveNonce: t.now * 1000, ackSha256: ACK };
  await signer.venueAuthorize(a, pk.assert(venueAuthorizationHash(a)));
  const q: VenueQuotingMandate = { v: 1, mandateId: uuid(2), authorizationId: a.authorizationId, keyId: a.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress, strategySha256: SHA, agentId: 'mm-1',
    instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxQuoteNotional: '150', maxRestingPerSide: 2, maxRestingNotionalPerSide: '290', maxInventoryNotional: '400' }], maxRestingTotal: 4, maxGrossExposure: '600',
    minHalfSpreadBps: 2, maxDistanceBps: 100, maxReduceDeviationBps: 50, floorEquity: '100', rate: { burstActions: 5, actionsPerMinute: 10, ordersPerHour: 100, ordersPerDay: 500, dailyTurnover: '20000' }, deadManSeconds: 60,
    createdAt: t.now, expiresAt: t.now + 5 * 86400, ackSha256: ACK };
  check('V11 approves the quoting mandate (software passkey)', await attempt(() => signer.venueQuotingApprove(q, pk.assert(venueQuotingMandateHash(q)))), 'ok');
  const directional = (n: number): VenueMandate => ({ v: 1, mandateId: uuid(n), authorizationId: a.authorizationId, keyId: a.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress,
    strategySha256: SHA, agentId: 'agent-7', instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400' }], maxOrderNotional: '200', maxGrossExposure: '600', maxOrdersPerDay: 10, maxOrdersPerHour: 6,
    maxDailyTurnover: '1500', floorEquity: '100', maxPriceDeviationBps: 300, createdAt: t.now, expiresAt: t.now + 20 * 86400, ackSha256: ACK });
  const d1 = directional(3), v11Says = await attempt(() => signer.venueMandateApprove(d1, pk.assert(venueMandateHash(d1))));
  say(`  V11, directional mandate next to the active quoting mandate → ${v11Says}`);
  check('V11 refuses it with `conflict`', v11Says.startsWith('conflict'), true);
  const phase = (s: any): string => JSON.stringify(((s.status() as any).venueQuotingMandates ?? []).map((m: any) => `${m.mandate.mandateId.slice(-4)}:${m.phase}`));
  say(`  V11 status: venueQuotingMandates ${phase(signer)}`);

  // the previous release on this state, as after `signer.mjs.bak-*` is put back
  const oStore = new OldStore(sp, pp), oSigner = new OldSigner(oldKeys, oStore, { rpId: RP, origin: ORIGIN }, () => t.now, prices, oldReader ? oldReader(post) : undefined);
  const os = oSigner.status();
  say(`  previous release status: knows venueQuotingMandates = ${os.venueQuotingMandates !== undefined}; has a quoting sign route = ${typeof oSigner.venueQuotingSign === 'function'}; has a quoting revoke route = ${typeof oSigner.venueQuotingRevoke === 'function'}`);
  check('the previous release does not report the quoting mandate', os.venueQuotingMandates, undefined);
  check('the previous release cannot revoke it (no such route)', typeof oSigner.venueQuotingRevoke, 'undefined');
  check('…but keeps it on disk in memory', Object.keys(oStore.state.venueQuotingMandates ?? {}).length, 1);
  const d2 = directional(4), oldSays = await attempt(() => oSigner.venueMandateApprove(d2, pk.assert(venueMandateHash(d2))));
  say(`  previous release, the SAME directional request (a new mandate id) → ${oldSays}`);
  check('the previous release APPROVES a directional mandate next to the active quoting mandate', oldSays, 'ok');
  check('the quoting mandate is still on disk after the previous release saved', Object.keys(onDisk(dir).venueQuotingMandates ?? {}).length, 1);

  // forward again: both are now in force on one authorization — the state V11 never allows itself to create
  const again = new Signer(keys, new Store(sp, pp), { rpId: RP, origin: ORIGIN }, () => t.now, prices as never, hyperliquidReader(post)), as = again.status() as any;
  const dirActive = Object.values((onDisk(dir).venueMandates ?? {}) as Record<string, any>).filter((m) => !m.revoked).length;
  say(`  V11 again: venueQuotingMandates ${phase(again)}; directional mandates not revoked on disk: ${dirActive}`);
  check('after the round trip a quoting mandate AND a directional mandate are both active on one authorization', [(as.venueQuotingMandates ?? []).filter((m: any) => m.phase === 'active').length, dirActive], [1, 1]);

  // the documented procedure: revoke first
  const dir2 = mkdtempSync(join(tmpdir(), 'spw-rb-signer-c-')), sp2 = join(dir2, 'state.json'), pp2 = join(dir2, 'policy.json');
  copyFileSync(sp, sp2); copyFileSync(pp, pp2); for (const f of readdirSync(dir).filter((x) => x.startsWith('journal'))) copyFileSync(join(dir, f), join(dir2, f));
  const s3 = new Signer(keys, new Store(sp2, pp2), { rpId: RP, origin: ORIGIN }, () => t.now, prices as never, hyperliquidReader(post));
  check('revocation of the quoting mandate needs no passkey', await attempt(() => s3.venueQuotingRevoke(q.mandateId)), 'ok');
  say(`  after revocation: venueQuotingMandates ${phase(s3)}`);
  check('a revoked quoting mandate is in its wind-down (or ended): quotes are refused, exits pass', ((s3.status() as any).venueQuotingMandates ?? []).every((m: any) => m.phase === 'wind_down' || m.phase === 'ended'), true);
}
say(failed ? `\n${failed} observation(s) DIFFER from the documented behaviour` : '\nevery observation is as documented');
process.exit(failed ? 1 : 0);
