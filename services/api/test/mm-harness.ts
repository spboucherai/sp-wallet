// Simulator harness of the market-making engine: the engine (src/mm/engine.ts) over the LIVE adapter (src/mm/live-adapter.ts),
// the REAL isolated-signer code (a `Signer` instance in this process, its own state directory, a quoting mandate approved with a
// test passkey) and a fake venue (src/mm/sim-venue.ts) that replays a recorded Hyperliquid tape and enforces the venue's rules.
// The signer's own venue read goes through its real reader (venue-read.ts) to the fake venue's info endpoint; its own prices are
// an injected feed (the tape's mid, plus an offset a test can set). Nothing here touches a network or a real key.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { D } from '@spw/derivatives';
import { hlRoundAsk, hlRoundBid, hlRoundQuote, hlRoundSize } from '@spw/derivatives/hyperliquid';
import { hlPinnedAssets, jurisdictionAck, venueAuthorizationHash, venueQuotingMandateHash, type VenueAuthorization, type VenueQuotingMandate } from '@spw/derivatives/live';
import { AS_STUDY_DEFAULTS, avellanedaStoikov, VOL_STUDY_DEFAULTS, type BreakerConfig, type QuotePolicy, type QuoteRounder } from '@spw/trading/mm';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { hyperliquidReader, VENUE_INFO_URL } from '../../isolated-signer/src/venue-read.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { MmEngine, type MmEngineConfig } from '../src/mm/engine.ts';
import { createLiveMmAdapter } from '../src/mm/live-adapter.ts';
import type { JournalEvent, MandateView, VenueStatus } from '../src/mm/ports.ts';
import { SimVenue, type TapeEvent } from '../src/mm/sim-venue.ts';

export interface TapeDoc { provenance: Record<string, unknown>; coin: string; t0: number; b: [number, string, string, string, string][]; t: [number, 0 | 1, string, string][] }
export const TAPE: TapeDoc = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/mm/hl-btc-tape.json.gz', import.meta.url))).toString('utf8'));
/** the recorded tape as events, in venue-time order (a book state before a trade of the same millisecond) */
export function tapeEvents(fromMs = 0, toMs = Infinity): TapeEvent[] {
  const ev: TapeEvent[] = [
    ...TAPE.b.filter((x) => x[0] >= fromMs && x[0] <= toMs).map((x): TapeEvent => ({ t: TAPE.t0 + x[0], k: 'b', bid: x[1], bidSz: x[2], ask: x[3], askSz: x[4] })),
    ...TAPE.t.filter((x) => x[0] >= fromMs && x[0] <= toMs).map((x): TapeEvent => ({ t: TAPE.t0 + x[0], k: 't', side: x[1] === 1 ? 'B' : 'A', px: x[2], sz: x[3] })),
  ];
  return ev.sort((a, b) => a.t - b.t || (a.k === b.k ? 0 : a.k === 'b' ? -1 : 1));
}

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
export const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');   // the public BIP-39 test vector
export const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
const ACK = jurisdictionAck('hyperliquid', 'fr').sha256;
let n = 0;
const uuid = () => `7c1e0d2a-3b4c-4d5e-8f60-${String(++n).padStart(12, '0')}`;
const SZ = 5;                                                                                       // BTC lot decimals (pinned table)
export const round: QuoteRounder = (side, price, size) => { const r = hlRoundQuote(side, price, size, SZ); return r.ok ? { ok: true, price: r.quote.price, size: r.quote.size } : { ok: false, reason: r.reason }; };
/** a reduce-only order is meant to execute: its price rounds TOWARDS the other side */
export const roundReduce: QuoteRounder = (side, price, size) => { const p = side === 'sell' ? hlRoundBid(price, SZ) : hlRoundAsk(price, SZ), s = hlRoundSize(size, SZ); return p && s ? { ok: true, price: p, size: s } : { ok: false, reason: 'rounds to nothing' }; };

export const BREAKERS: BreakerConfig = { maxDataAgeMs: 5000, maxSpreadBps: '20', minTopDepthUsd: '0', volSpikeMultiple: 8, maxVolBps: 40, fillBurstCount: 6, fillBurstWindowMs: 10_000, minMarkoutBps: '-10', markoutSample: 8, consecutiveRejects: 5,
  maxSessionLossUsd: '-5', maxDayLossUsd: '-10', coolDownMs: 15_000, action: {} };
export const INSTRUMENT = 'hyperliquid:BTC';
export const engineConfig = (over: Partial<MmEngineConfig> = {}): MmEngineConfig => ({
  instrument: INSTRUMENT, sessionId: '00000000000000a1',
  planner: { requoteToleranceBps: '1.5', sizeToleranceBps: '5000', maxRestingPerSide: 1, softInventory: '0.0009', hardInventory: '0.0015', reduceSlippageBps: '5', maxReduceSize: '0.0006' },
  breakers: BREAKERS, rate: { addressReserve: 500, addressComfort: 2000, ipReserve: 300, ipWeightPerQuoteBatch: 43, maxBatch: 20 }, vol: VOL_STUDY_DEFAULTS, baselineLambda: 0.995,
  reconcileEveryMs: 5000, rateEveryMs: 30_000, ipWeightRemaining: () => 1100, flattenOnStop: false, round, roundReduce, ...over });
/** the lab study's policy: gamma 0.1, tau 12 intervals of 5 s, kappa as fitted by the study on Hyperliquid BTC (0.69); 20 USD lots */
export const studyPolicy = (over: Partial<Parameters<typeof avellanedaStoikov>[0]> = {}): QuotePolicy => avellanedaStoikov({ ...AS_STUDY_DEFAULTS, kappa: 0.69, lotUsd: '20', minHalfSpreadBps: '1.2', maxHalfSpreadBps: '150', fallbackVolBps: null, ...over });

export interface WorldOptions {
  fromMs?: number; toMs?: number; startEquity?: string; startVolume?: number; startUsed?: number; startPosition?: string;
  mandate?: Partial<VenueQuotingMandate>; instrument?: Partial<VenueQuotingMandate['instruments'][number]>; mandateSeconds?: number;
  engine?: Partial<MmEngineConfig>; policy?: QuotePolicy;
}
export async function createWorld(o: WorldOptions = {}) {
  const tape = tapeEvents(o.fromMs ?? 0, o.toMs ?? Infinity);
  const sim = new SimVenue({ network: 'testnet', assets: hlPinnedAssets('testnet'), coin: 'BTC', account: ACCOUNT, agent: AGENT, tape, startEquity: o.startEquity ?? '1000', startVolume: o.startVolume ?? 0, startUsed: o.startUsed ?? 0, ...(o.startPosition ? { startPosition: o.startPosition } : {}) });
  const flags = { signerDown: false, priceFail: '', priceOffsetBps: 0, kill: false, riskDeny: null as string | null, status: 'connected' as VenueStatus, freezeBook: null as ReturnType<SimVenue['top']> | null, bookOverride: null as (() => ReturnType<SimVenue['top']>) | null,
    /** called with the body of every exchange request before the fake venue sees it */ onExchange: null as ((body: any) => void) | null };
  const nowSec = () => Math.floor(sim.now / 1000);
  // ---- the real signer ----
  const dir = mkdtempSync(join(tmpdir(), 'spw-mm-sim-')), paths = [join(dir, 'state.json'), join(dir, 'policy.json')] as const;
  const store = new Store(...paths);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const prices = { get: async (syms: string[]) => { if (flags.priceFail) throw new Error(flags.priceFail); return Object.fromEntries(syms.map((s) => [s, Number(sim.mid()) * (1 + flags.priceOffsetBps / 1e4)])); } };
  const infoCalls: string[] = [];
  const reader = hyperliquidReader(async (url, body) => { if (url !== VENUE_INFO_URL.testnet) throw new Error(`the signer asked ${url}`); infoCalls.push((body as { type: string }).type); return sim.info(body); });
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, nowSec, prices, reader);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const now = nowSec();
  const authorization: VenueAuthorization = { v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-mm', mode: 'MANUAL_LIVE',
    policy: { allowedInstruments: [INSTRUMENT], maxLeverage: 5, maxOrderNotional: '300', maxPositionNotional: '500', maxGrossExposure: '800', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 },
    createdAt: now, expiresAt: now + 60 * 86400, approveNonce: now * 1000, ackSha256: ACK };
  await signer.venueAuthorize(authorization, pk.assert(venueAuthorizationHash(authorization)));
  const mandate: VenueQuotingMandate = { v: 1, mandateId: uuid(), authorizationId: authorization.authorizationId, keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, strategySha256: 'ab'.repeat(32), agentId: 'mm-sim',
    instruments: [{ instrument: INSTRUMENT, maxLeverage: 3, maxQuoteNotional: '40', maxRestingPerSide: 2, maxRestingNotionalPerSide: '80', maxInventoryNotional: '200', ...o.instrument }], maxRestingTotal: 4, maxGrossExposure: '300',
    minHalfSpreadBps: 1, maxDistanceBps: 200, maxReduceDeviationBps: 50, floorEquity: '500', rate: { burstActions: 20, actionsPerMinute: 60, ordersPerHour: 3600, ordersPerDay: 20_000, dailyTurnover: '500000' }, deadManSeconds: 30,
    createdAt: now, expiresAt: now + (o.mandateSeconds ?? 5 * 86400), ackSha256: ACK, ...o.mandate };
  await signer.venueQuotingApprove(mandate, pk.assert(venueQuotingMandateHash(mandate)));

  // ---- ports ----
  const signerCalls: { kind: string; ok: boolean; code: string | null }[] = [];
  const adapter = createLiveMmAdapter({ network: 'testnet', account: ACCOUNT, mandateId: mandate.mandateId, now: () => sim.now, actionTtlMs: 10_000,
    locks: { liveMainnet: () => false, mandateMainnet: () => false, mmMainnet: () => false },                    // testnet: the mainnet locks are not consulted
    signer: { venueQuotingSign: async (p) => {
      if (flags.signerDown) { signerCalls.push({ kind: '?', ok: false, code: 'unreachable' }); throw new Error('connect ECONNREFUSED'); }
      try { const r = await signer.venueQuotingSign(p); signerCalls.push({ kind: r.kind, ok: true, code: null }); return r; }
      catch (e) { signerCalls.push({ kind: '?', ok: false, code: (e as { code?: string }).code ?? 'error' }); throw e; }
    } },
    venue: { exchange: (body) => { flags.onExchange?.(body); return sim.exchange(body); }, info: (body) => sim.info(body) } });
  const journal: JournalEvent[] = [];
  const mandateView = async (): Promise<MandateView | null> => {
    if (flags.signerDown) return null;
    const s = signer.status().venueQuotingMandates.find((x) => x.mandate.mandateId === mandate.mandateId);
    if (!s) return null;
    return { mandateId: mandate.mandateId, phase: s.phase, expiresAt: mandate.expiresAt, deadManSeconds: mandate.deadManSeconds, bucketActions: s.bucketActions, quotesLeftHour: mandate.rate.ordersPerHour - s.quotesThisHour, quotesLeftDay: mandate.rate.ordersPerDay - s.today.quotes };
  };
  const ports = {
    market: { snapshot: () => ({ status: flags.status, book: flags.bookOverride?.() ?? flags.freezeBook ?? (sim.top().ts ? sim.top() : null) }) },
    orders: adapter,
    risk: { killSwitch: async () => flags.kill, evaluate: async (i: { kind: string }) => (flags.riskDeny && i.kind === 'quotes' ? { allow: false, code: flags.riskDeny, message: 'refused by the test' } : { allow: true, code: null, message: null }) },
    mandate: { current: mandateView }, clock: { now: () => sim.now }, journal: { record: (e: JournalEvent) => { journal.push(e); } },
  };
  const makeEngine = (cfg: Partial<MmEngineConfig> = {}, policy: QuotePolicy = o.policy ?? studyPolicy()) => new MmEngine(engineConfig({ ...o.engine, ...cfg }), policy, ports);
  const world = { sim, signer, store, pk, flags, mandate, authorization, adapter, journal, signerCalls, infoCalls, ports, makeEngine, engine: makeEngine(),
    /** advance the tape and tick the engine every `stepMs` of venue time, for `ms` */
    async run(ms: number, stepMs = 1000, each?: () => void | Promise<void>) {
      const end = Math.min(sim.now + ms, sim.end);
      while (sim.now < end) { sim.advance(Math.min(sim.now + stepMs, end)); await world.engine.tick(); if (each) await each(); }
    },
    events: (type: string) => journal.filter((e) => e.type === type),
    signerJournal: (type: string) => store.journalRecords().filter((j) => j.type === type),
    /** quotes resting on the fake venue, per side */
    resting: () => { const open = (sim as unknown as { orders: { side: 'B' | 'A'; px: string; sz: string; reduceOnly: boolean }[] }).orders; return { buy: open.filter((x) => x.side === 'B'), sell: open.filter((x) => x.side === 'A') }; },
    midNumber: () => Number(sim.mid()),
    notionalUsd: (size: string) => Number(D.str(D.mul(D.from(size), D.from(sim.mid())))),
  };
  return world;
}
export type World = Awaited<ReturnType<typeof createWorld>>;
