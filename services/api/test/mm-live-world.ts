// The world of a LIVE market-making session for tests: PostgreSQL, the REAL live execution engine, the REAL isolated-signer
// class (in process, the public test mnemonic) with its REAL venue reader, a software passkey producing real WebAuthn
// assertions, the execution layer (risk, mandates), the agents runtime with its leases — and TWO fakes of the venue behind one
// fetch: the scripted Hyperliquid fake of the other suites (hl-fake.ts) for the account's authorization and the market reads of
// the risk engine, and the tape-replaying venue double (mm-sim-venue.ts) for everything a quoting session and the signer's own
// read ask once `route.sim` is on. Nothing reaches a network; no real key; no funded account. Import AFTER `useDatabase`.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Book, Instrument } from '@spw/derivatives';
import { hlPinnedAssets } from '@spw/derivatives/live';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer, SignerError } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { hyperliquidReader } from '../../isolated-signer/src/venue-read.ts';
import { Clock, fixtureVenues, openLiveLimits } from './derivatives-helpers.ts';
import { FakeHl, routeFetch } from './hl-fake.ts';
import { tapeEvents, TAPE } from './mm-harness.ts';
import { SimVenue } from './mm-sim-venue.ts';
import { AUTH_POLICY, ORIGIN, RP, TEST_MNEMONIC } from './perp-live-world.ts';

const SIM_INFO = new Set(['frontendOpenOrders', 'clearinghouseState', 'activeAssetData', 'userRateLimit', 'userFillsByTime', 'orderStatus']);
export const BTC = 'hyperliquid:BTC';
export const MM_CONFIG = { quoteSizeUsd: '20', minHalfSpreadBps: '1.5', volMultiplier: '0', skewBps: '1', maxInventoryUsd: '30', volWindow: 30, decisionEveryMs: 1000 };
export const QUOTING = { terms: { levelsPerSide: 1, minHalfSpreadBps: 1, maxDistanceBps: 200, burstActions: 20, actionsPerMinute: 60, quotesPerHour: 3600, quotesPerDay: 20_000, dailyTurnoverUsd: '500000', deadManSeconds: 30 },
  engine: { policy: 'spread_inventory', quoteSizeUsd: '20', softInventoryUsd: '30', hardInventoryUsd: '50', maxSessionMinutes: 120, hours: null, maxSessionLossUsd: '5', stopBeforeExpiryS: 300, breakers: {}, flattenOnStop: false } };

export async function mmLiveWorld(o: { fromMs?: number; toMs?: number; startEquity?: string } = {}) {
  const lv = await import('../src/derivatives/live.ts'), ex = await import('../src/derivatives/exec.ts'), { UserError } = await import('../src/config.ts'), db = await import('../src/db.ts');
  const sql = db.sql;
  const keys = deriveKeys(TEST_MNEMONIC), ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
  const tape = tapeEvents(o.fromMs ?? 0, o.toMs ?? Infinity);
  const sim = new SimVenue({ network: 'testnet', assets: hlPinnedAssets('testnet'), coin: 'BTC', account: ACCOUNT, agent: AGENT, tape, startEquity: o.startEquity ?? '1000' });
  const clock = new Clock(sim.now);
  const t = new FakeHl('testnet', clock.now), m = new FakeHl('mainnet', clock.now);
  const route = { sim: false }, flags = { failNextQuoteBatch: null as 'lost_after_apply' | 'lost_before_apply' | 'garbage' | null, signerDown: false, kill: false, priceOffsetBps: 0, userStream: 'connected' as 'connected' | 'reconnecting', dropUser: false,
    locks: { SPW_DERIV_LIVE_MAINNET: 'off', SPW_DERIV_MANDATE_MAINNET: 'off', SPW_DERIV_MM_MAINNET: 'off', SPW_DERIV_MM_TESTNET: 'on', SPW_TRADING_API_EXECUTION: 'on' } as Record<string, string> };
  const fake = routeFetch([t, m]);
  /** one fetch for the API and for the signer's reader: the quoting session's traffic on testnet goes to the venue double */
  const fetchAll = (async (url: string, init?: RequestInit) => {
    const u = String(url), body = JSON.parse(String(init?.body ?? '{}'));
    if (route.sim && u.includes('hyperliquid-testnet')) {
      try {
        if (u.endsWith('/info') && SIM_INFO.has(String(body.type))) return new Response(JSON.stringify(await sim.info(body)), { status: 200 });
        if (u.endsWith('/exchange')) return new Response(JSON.stringify(await sim.exchange(body)), { status: 200 });
      } catch (e) { return new Response(String((e as Error).message), { status: 502 }); }
    }
    return fake(url as never, init);
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'spw-mm-live-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const reader = hyperliquidReader(async (url, body) => { const r = await fetchAll(url, { method: 'POST', body: JSON.stringify(body) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  /** the signer's OWN mid: the tape's, plus an offset a test sets */
  const prices = { get: async (s: string[]) => Object.fromEntries(s.map((k) => [k, Number(sim.mid()) * (1 + flags.priceOffsetBps / 1e4)])) };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000), prices, reader);
  const pk = new TestPasskey(RP, ORIGIN);
  const call = async <T>(fn: () => T | Promise<T>): Promise<T> => { if (flags.signerDown) throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); try { return await fn(); } catch (e) { if (e instanceof SignerError) throw new UserError(`signer_${e.code}`, e.message, 422); throw e; } };
  const port: import('../src/derivatives/exec.ts').LiveSignerPort = { status: () => call(() => signer.status()) as never, venueKey: (v, n) => call(() => signer.venueKey(v, n)), venueAuthorize: (a, s) => call(() => signer.venueAuthorize(a, s as never)),
    venueRevoke: (id) => call(() => signer.venueRevoke(id)), venueSign: (p) => call(() => signer.venueSign(p as never)) };
  const mandatePort: import('../src/derivatives/exec.ts').MandateSignerPort = { venueMandateApprove: (x, s) => call(() => signer.venueMandateApprove(x, s as never)), venueMandateRevoke: (id) => call(() => signer.venueMandateRevoke(id)), venueMandateSign: (p) => call(() => signer.venueMandateSign(p as never)) };
  /** the signer's quoting endpoints, every call recorded */
  const quotingCalls: { op: string; kind?: string; ok: boolean; code: string | null }[] = [];
  const lose = { approveAnswer: false };
  const quotingSigner: import('../src/orders/index.ts').QuotingSigner = {
    status: () => call(() => signer.status()) as never,
    venueQuotingApprove: async (x, s) => { const r = await call(() => signer.venueQuotingApprove(x, s as never)); if (lose.approveAnswer) { lose.approveAnswer = false; throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); } return r; },
    venueQuotingRevoke: (id) => call(() => signer.venueQuotingRevoke(id)),
    venueQuotingSign: async (p) => { try { const r = await call(() => signer.venueQuotingSign(p as never)); quotingCalls.push({ op: 'sign', kind: r.kind, ok: true, code: null }); return r as never; } catch (e) { quotingCalls.push({ op: 'sign', ok: false, code: (e as { code?: string }).code ?? 'error' }); throw e; } },
  };
  const svc = lv.createLive({ fetch: fetchAll, signer: port, mandateSigner: mandatePort, now: clock.now, rpId: RP, mainnetEnabled: () => flags.locks.SPW_DERIV_LIVE_MAINNET === 'on', mandateMainnetEnabled: () => flags.locks.SPW_DERIV_MANDATE_MAINNET === 'on',
    credentials: async () => [{ id: pk.id, transports: ['internal'] }], confirmDelayMs: 0 });
  // the owner's passkey is enrolled at the signer AND in the API's credentials table (the API verifies the full-hash binding itself)
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const c = pk.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports as never)}, 'test passkey') on conflict do nothing`;
  // NEXT (audit P4): the API's own passkey checks ask the SIGNER which passkeys it lists; this world's signer is in process (no HTTP)
  (await import('../src/signer-client.ts')).signer.status = (async () => signer.status()) as never;
  await openLiveLimits(sql);
  const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');
  t.setMid(Math.round(Number(sim.mid())));
  const authorise = async (network: 'testnet' | 'mainnet' = 'testnet'): Promise<string> => {
    (network === 'testnet' ? t : m).fund(ACCOUNT, '1000');
    const id = (await svc.createAccount({ venue: 'hyperliquid', network, label: network })).id as string;
    const prep = await svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: AUTH_POLICY, days: 30, locale: 'fr' }));
    await svc.approveAuthorization(id, { assertion: pk.assert(b64(prep.hash)) as never, acknowledged: true });
    return id;
  };
  // the execution layer on these instances
  const mod = await import('../src/derivatives/index.ts'), venues = fixtureVenues(clock);
  const derivs = mod.createDerivatives({ registry: mod.createRegistry(venues.adapters, clock.now), now: clock.now });
  const { createExecution } = await import('../src/orders/index.ts'), { envMmLocks } = await import('../src/mm/live-adapter.ts');
  const execution = createExecution({ derivatives: derivs, live: svc, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never, quotingSigner, mmLocks: () => envMmLocks(flags.locks) });
  (await import('../src/agents/execution-bind.ts')).bindExecution(execution);
  const inst: Instrument = (await venues.adapters.hyperliquid.instruments()).find((i) => i.symbol === 'BTC')!;

  // the market feed of the stream engine: the tape's top of book, pushed at each step
  const subs = new Map<string, (ev: any) => void>();
  const feed: import('../src/agent-runtime/stream-engine.ts').StreamFeed = { now: clock.now, fees: () => ({ takerRate: '0.00045', makerRate: '0.00015', source: 'test (Hyperliquid base tier)' }), resolve: async (venue, base) => (venue === 'hyperliquid' && base === 'BTC' ? inst : null),
    subscribe: (i, on) => { subs.set(i.id, on); on({ event: 'status', data: { status: 'connected', ts: clock.now() } }); return () => { subs.delete(i.id); }; } };
  const market = { status: 'connected' as 'connected' | 'reconnecting', frozen: false };
  const pushBook = (): void => {
    const top = sim.top(), on = subs.get(BTC);
    if (!on || market.frozen || !top.ts) return;
    const book: Book = { instrument: BTC, bids: [[top.bid, top.bidSize]], asks: [[top.ask, top.askSize]], ts: top.ts };
    on({ event: 'book', data: book });
  };
  const setMarketStatus = (s: 'connected' | 'reconnecting'): void => { market.status = s; subs.get(BTC)?.({ event: 'status', data: { status: s, ts: clock.now() } }); };

  // the venue's user streams, delivered by the venue double
  const userSubs = new Set<{ on: (ev: any) => void; onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void }>();
  sim.onUser = (ev) => { if (flags.userStream !== 'connected' || flags.dropUser) return; for (const u of userSubs) u.on(ev); };
  const setUserStream = (s: 'connected' | 'reconnecting'): void => { flags.userStream = s; for (const u of userSubs) { u.onStatus(s); if (s === 'connected') u.on({ type: 'gap', reason: 'reconnected' }); } };
  const { mmLiveDeps } = await import('../src/mm/bind.ts');
  const base = mmLiveDeps(execution), simRequests: { t: number; who: 'api'; type: string }[] = [];
  const live: import('../src/mm/runtime.ts').MmLiveDeps = { ...base,
    venue: () => ({ info: async (b) => { simRequests.push({ t: clock.now(), who: 'api', type: String((b as { type: string }).type) }); return sim.info(b); }, exchange: (b) => { const a = (b as { action?: { type?: string; orders?: { r?: boolean }[] } }).action; if (flags.failNextQuoteBatch && a?.type === 'order' && a.orders?.every((x) => x.r !== true)) { sim.failNextExchange = flags.failNextQuoteBatch; flags.failNextQuoteBatch = null; } return sim.exchange(b); } }),
    userFeed: () => ({ subscribe: (_account, on, onStatus) => { const u = { on, onStatus }; userSubs.add(u); onStatus(flags.userStream); return () => { userSubs.delete(u); }; } }) };
  const { createAgentRuntime } = await import('../src/agent-runtime/scheduler.ts');
  const worker = (name: string) => {
    // the testnet books of this test are the tape, delivered through the worker's own feed
    const ref: { rt: ReturnType<typeof createAgentRuntime> | null } = { rt: null };
    ref.rt = createAgentRuntime({ spotAgents: async () => [], perpAgents: async () => [], tickSpot: async () => 'idle', tickPerp: async () => 'idle', feed },
      { workerId: name, now: clock.now, stream: { record: false, killSwitch: { engaged: async () => ({ engaged: flags.kill, reason: flags.kill ? 'test' : null }) },
        mm: { live, worker: name, locks: () => envMmLocks(flags.locks), saveEveryMs: 0, slowEveryMs: 5000, auditEveryMs: 60_000, books: () => ({ read: (i) => ref.rt?.stream?.bookSource().read(i) ?? null }) } } });
    return ref.rt;
  };

  /** advance the venue, the clocks, the signer's own mid and the feed by `ms`, in steps, running a pass of each worker at every step */
  const run = async (ms: number, workers: ReturnType<typeof worker>[], stepMs = 1000, each?: () => void | Promise<void>): Promise<Record<string, string>[]> => {
    const out: Record<string, string>[] = [], end = sim.now + ms;
    while (sim.now < end) {
      sim.advance(Math.min(sim.now + stepMs, end)); clock.t = sim.now;
      pushBook();
      for (const w of workers) out.push(await w.streamPass());
      if (each) await each();
    }
    return out;
  };
  return { sql, sim, clock, t, m, signer, store, pk, flags, route, lose, svc, execution, ACCOUNT, AGENT, b64, authorise, inst, feed, worker, run, pushBook, setMarketStatus, setUserStream, quotingCalls, simRequests, live, TAPE,
    signerJournal: (type: string) => store.journalRecords().filter((j) => j.type === type),
    signerQuoting: (id: string) => (signer.status() as any).venueQuotingMandates.find((x: any) => x.mandate.mandateId === id),
    resting: () => { const open = (sim as unknown as { orders: { side: 'B' | 'A'; px: string; sz: string; cloid: string | null }[] }).orders; return { buy: open.filter((x) => x.side === 'B'), sell: open.filter((x) => x.side === 'A') }; } };
}
export type MmLiveWorld = Awaited<ReturnType<typeof mmLiveWorld>>;
