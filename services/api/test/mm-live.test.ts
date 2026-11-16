// LIVE market making end to end, through the agents runtime: PostgreSQL, the REAL isolated-signer code, the execution layer
// (mandate service, unified risk service), the agents' leases, the stream engine → MmRuntime → MmEngine → the live adapter →
// the signer's QUOTING path → a venue double replaying a RECORDED Hyperliquid tape (mm-live-world.ts). Fills are modelled by
// the venue double; nothing reaches a network; no real key, no funded account, mainnet or testnet.
//
//   1. the quoting mandate: ONE lifecycle with trading mandates — bounds refused (never clamped), the quoting section covered by
//      the same passkey-bound approval, exclusivity with a directional mandate, the lost approval answer, revocation at the signer
//   2. the session: start → quotes → fills on both sides → the hard-limit unwind → breaker → pull → restart with resting orders →
//      wind-down at expiry → revoke; each lock; the kill switch; the signer down; a user-stream gap; an unknown batch; two
//      workers; a worker that dies with resting quotes (the dead man's switch fires at the venue)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import { useDatabase } from './derivatives-helpers.ts';
import { BTC, MM_CONFIG, mmLiveWorld, QUOTING, type MmLiveWorld } from './mm-live-world.ts';

let w: MmLiveWorld, sql: any, account = '', agentId = '', mandateId = '';
let tpl: typeof import('../src/agents/templates.ts'), life: typeof import('../src/agents/lifecycle.ts'), model: typeof import('../src/agent-runtime/model.ts');
const MIN = 60_000;
const body = (over: Record<string, unknown> = {}, quoting: Record<string, unknown> | null = {}) => ({ principal: { kind: 'agent', id: agentId }, mode: 'live', accountIds: [account], instruments: [BTC], marketKinds: ['perp'], orderTypes: ['limit'],
  maxCapitalUsd: '300', maxOrderNotionalUsd: '40', maxPositionNotionalUsd: '200', maxLeverage: '3', maxDailyLossUsd: '20', floorEquityUsd: '100', days: 1, frequency: { perMinute: 10, perHour: 60, perDay: 200 }, maxSlippageBps: 50, maxFeeUsd: '1',
  stopConditions: [], strategySha256: model.ruleHash('spread_inventory'), label: 'MM BTC', locale: 'en', ...over,
  ...(quoting === null ? {} : { quoting: { terms: { ...QUOTING.terms, ...((quoting.terms as object) ?? {}) }, engine: { ...QUOTING.engine, ...((quoting.engine as object) ?? {}) } } }) });
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
const session = async () => (await sql`select * from mm_sessions where agent_id = ${agentId} order by started_at desc, id desc limit 1`)[0];
const agent = async () => (await sql`select state, mode, stop_reason, runtime from agents where id = ${agentId}`)[0];
const journalCodes = async () => (await sql`select code from research_log where agent_id = ${agentId} order by id`).map((r: any) => r.code as string);
const approve = async (id: string) => { const p: any = await w.execution.mandates.prepareApproval(id, 'en'); return { p, done: () => w.execution.mandates.approve(id, { assertion: w.pk.assert(w.b64(p.signer.hash)) as never, bindingAssertion: w.pk.assert(w.b64(p.binding.hash)) as never, acknowledged: true }) }; };

beforeAll(async () => {
  await useDatabase('mm_live');
  process.env.SPW_MM_MIN_PAPER_MINUTES = '1';
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  w = await mmLiveWorld({ toMs: 30 * MIN });
  tpl = await import('../src/agents/templates.ts'); life = await import('../src/agents/lifecycle.ts'); model = await import('../src/agent-runtime/model.ts');
  account = await w.authorise('testnet');
  w.t.user(w.ACCOUNT).leverage.set('BTC', { type: 'cross', value: 3 });
  agentId = (await tpl.createFromTemplate({ template: 'market-making', name: 'MM live', venues: ['hyperliquid'], universe: ['BTC'], capitalUsdc: '1000', config: MM_CONFIG, risk: { maxDataAgeMs: 5000 } }, 'owner')).agent.id;
  w.route.sim = true;
}, 60_000);
afterAll(async () => { delete process.env.SPW_MM_MIN_PAPER_MINUTES; await sql?.end(); });

describe('the quoting mandate — one lifecycle with the trading mandates', () => {
  it('a live start without a mandate answers mandate_required, for the owner and for a key', async () => {
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('mandate_required');
    expect(await code(life.startAgent(agentId, 'live', { kind: 'api_key', id: 'spk_x' }))).toBe('mandate_required');
  });

  it('values beyond a compiled bound, the venue authorization or the mandate itself are REFUSED with a code — never clamped; nothing is stored', async () => {
    const m = w.execution.mandates, cases: [Record<string, unknown>, Record<string, unknown> | null, string][] = [
      [{}, { terms: { deadManSeconds: 121 } }, 'value_not_expressible'], [{}, { terms: { deadManSeconds: 9 } }, 'value_not_expressible'], [{}, { terms: { levelsPerSide: 6 } }, 'value_not_expressible'],
      [{}, { terms: { minHalfSpreadBps: 0 } }, 'value_not_expressible'], [{}, { terms: { maxDistanceBps: 501 } }, 'exceeds_authorization'], [{}, { terms: { actionsPerMinute: 61 } }, 'value_not_expressible'],
      [{}, { terms: { quotesPerHour: 3601 } }, 'value_not_expressible'], [{}, { terms: { quotesPerDay: 20_001 } }, 'value_not_expressible'], [{}, { terms: { dailyTurnoverUsd: '2000001' } }, 'value_not_expressible'],
      [{}, { terms: { burstActions: 21 } }, 'value_not_expressible'], [{}, { terms: { maxDistanceBps: 301 } }, 'exceeds_authorization'],
      [{ days: 8 }, {}, 'duration_not_expressible'], [{ maxCapitalUsd: '6000', maxOrderNotionalUsd: '2001', maxPositionNotionalUsd: '5000' }, {}, 'value_not_expressible'], [{ maxCapitalUsd: '400', maxPositionNotionalUsd: '1001' }, {}, 'exceeds_authorization'],
      [{}, { engine: { quoteSizeUsd: '9' } }, 'quoting_config_mismatch'], [{}, { engine: { hardInventoryUsd: '190' } }, 'value_not_expressible'], [{}, { engine: { softInventoryUsd: '50' } }, 'value_not_expressible'],
      [{}, { engine: { maxSessionMinutes: 1441 } }, 'value_not_expressible'], [{}, { engine: { maxSessionLossUsd: '21' } }, 'value_not_expressible'], [{}, { engine: { breakers: { drawdown_session: 'pull' } } }, 'value_not_expressible'],
      [{}, { engine: { policy: 'avellaneda_stoikov' } }, 'quoting_config_mismatch'], [{}, { terms: { minHalfSpreadBps: 2 } }, 'quoting_config_mismatch'],
      [{ instruments: [BTC, 'hyperliquid:ETH'] }, {}, 'quoting_instrument_mismatch'], [{ strategySha256: 'ab'.repeat(32) }, {}, 'strategy_hash_mismatch'], [{ mode: 'paper' }, {}, 'quoting_requires_live'],
    ];
    for (const [over, q, want] of cases) expect(`${JSON.stringify(over)} ${JSON.stringify(q)} → ${await code(m.create(body(over, q)))}`).toBe(`${JSON.stringify(over)} ${JSON.stringify(q)} → ${want}`);
    expect((await sql`select count(*)::int as n from trading_mandates`)[0].n).toBe(0);
  });

  it('created → the approval sheet shows the enforced-by table VERBATIM and the hashes; the passkey covers the trading mandate, the quoting section and the signer mandate', async () => {
    const created: any = await w.execution.mandates.create(body());
    mandateId = created.id;
    expect([created.kind, created.state, created.mode, created.quoting.section.terms.deadManSeconds, created.quoting.section.engine.quoteSizeUsd]).toEqual(['quoting', 'created', 'live', 30, '20']);
    expect(created.quoting.maxima['terms.deadManSeconds']).toBe('10…120'); expect(created.quoting.maxima['engine.quoteSizeUsd']).toBe('10…40');
    expect(created.enforcement.find((e: any) => e.field === 'frequency')).toMatchObject({ enforcedBy: 'api_only' });
    expect(created.quoting.termsEnforcement.find((e: any) => e.term === 'quotesPerHour')).toMatchObject({ enforcedBy: 'signer', signerField: 'rate.ordersPerHour' });
    expect(created.quoting.sectionEnforcement.every((e: any) => e.enforcedBy === 'api_only')).toBe(true);
    // not approved: still mandate_required
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('mandate_required');
    const { p } = await approve(mandateId);
    expect(p.kind).toBe('quoting'); expect(p.signer.shape).toBe('SPW-VENUE-QUOTING-MANDATE-v1');
    expect(p.quoting.table).toContain('| `frequency` | **API only**.'); expect(p.quoting.table).toContain('| terms: `deadManSeconds` | **signer (partly)**'); expect(p.quoting.table).toContain('| section: `engine.breakers` | **API only**.');
    expect(p.hashes).toMatchObject({ tradingMandate: created.hash, quotingSection: created.quoting.hash, signerMandate: p.signer.hash });
    expect(p.binding.intent).toMatchObject({ tradingMandateHash: created.hash, quotingSectionHash: created.quoting.hash, signer: { shape: 'SPW-VENUE-QUOTING-MANDATE-v1', mandateHash: p.signer.hash } });
    expect(p.signer.mandate).toMatchObject({ deadManSeconds: 30, minHalfSpreadBps: 1, maxDistanceBps: 200, rate: { ordersPerHour: 3600, ordersPerDay: 20_000, burstActions: 20, actionsPerMinute: 60 }, floorEquity: '100' });
    expect(p.signer.acknowledgement.text.length).toBeGreaterThan(50);
    // one passkey prompt is not enough, and an assertion over another hash is refused
    expect(await code(w.execution.mandates.approve(mandateId, { assertion: w.pk.assert(w.b64(p.signer.hash)) as never, acknowledged: true }))).toBe('passkey_required');
    expect(await code(w.execution.mandates.approve(mandateId, { assertion: w.pk.assert(w.b64(p.signer.hash)) as never, bindingAssertion: w.pk.assert(w.b64(p.signer.hash)) as never, acknowledged: true }))).toBe('bad_approval');
    expect(w.signerQuoting(mandateId)).toBeUndefined();
  });

  it('a LOST ANSWER of the approval is not a refusal: the mandate stays pending, recover adopts what the signer holds (same hash, stored approval verified)', async () => {
    const { done } = await approve(mandateId);
    w.lose.approveAnswer = true;
    expect(await code(done())).toBe('quoting_approval_unknown');
    expect((await w.execution.mandates.get(mandateId)).state).toBe('pending_signer');
    expect(w.signerQuoting(mandateId).phase).toBe('active');                                         // the signer DID store it
    expect(await w.execution.mandates.recoverQuoting()).toEqual({ adopted: [mandateId], revoked: [], pending: [] });
    const v: any = await w.execution.mandates.get(mandateId);
    expect([v.state, v.phase, v.signer.shape, v.integrity.ok, v.approval.quotingSectionHash]).toEqual(['active', 'active', 'SPW-VENUE-QUOTING-MANDATE-v1', true, v.quoting.hash]);
    expect(w.signerJournal('venue.quoting.approved')).toHaveLength(1);
  });

  it('integrity: a quoting section altered after the approval makes the mandate unusable', async () => {
    const [orig] = await sql`select quoting from trading_mandates where id = ${mandateId}`;
    const wider = { ...orig.quoting, section: { ...orig.quoting.section, engine: { ...orig.quoting.section.engine, hardInventoryUsd: '150' } } };
    await sql`update trading_mandates set quoting = ${sql.json(wider)} where id = ${mandateId}`;
    expect((await w.execution.mandates.quotingFor(agentId))!.integrity).toMatch(/quoting section does not hash/);
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('mandate_integrity');
    await sql`update trading_mandates set quoting = ${sql.json(orig.quoting)} where id = ${mandateId}`;
    expect((await w.execution.mandates.quotingFor(agentId))!.integrity).toBeNull();
  });

  it('EXCLUSIVITY with a directional mandate on the same venue account, both ways, with a precise code; the signer refuses it too', async () => {
    // a directional trading mandate for the same account, while the quoting mandate is active
    expect(await code(w.execution.mandates.create(body({ orderTypes: ['market', 'limit'] }, null)))).toBe('directional_excludes_quoting');
    // and at the signer itself: a directional mandate on that authorization is a conflict
    const dm = await w.svc.prepareMandate(account, { strategySha256: 'cd'.repeat(32), agentId: 'x', instruments: [{ instrument: BTC, maxLeverage: 2, maxPositionNotional: '100' }], maxOrderNotional: '50', maxGrossExposure: '100', maxOrdersPerDay: 10, maxOrdersPerHour: 5, maxDailyTurnover: '500', floorEquity: '100', days: 1, locale: 'en' } as never);
    expect(await code(w.svc.approveMandate(account, { assertion: w.pk.assert(w.b64(dm.hash)) as never, acknowledged: true }))).toBe('signer_conflict');
    // the other way: an active directional mandate refuses a quoting mandate
    await sql`insert into deriv_mandates (id, account_id, authorization_id, state, mandate, hash, ack, prepared_at, approved_at) values (gen_random_uuid(), ${account}, gen_random_uuid(), 'active', ${sql.json({ expiresAt: Math.floor(w.clock.now() / 1000) + 3600, agentId: 'other' })}, 'x', '{}', now(), now())`;
    expect(await code(w.execution.mandates.create(body()))).toBe('quoting_excludes_directional');
    await sql`delete from deriv_mandates where hash = 'x'`;
  });
});

describe('locks and the go-live checklist', () => {
  it('each lock off: the live start is refused with the precise code; the network decides which locks are consulted', async () => {
    const { mmNetworkSelection, mmOpeningLock, envMmLocks } = await import('../src/mm/live-adapter.ts');
    const on = { SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on', SPW_DERIV_MM_MAINNET: 'on', SPW_DERIV_MM_TESTNET: 'on', SPW_TRADING_API_EXECUTION: 'on' };
    expect(mmOpeningLock('mainnet', envMmLocks(on))).toBeNull(); expect(mmOpeningLock('testnet', envMmLocks(on))).toBeNull();
    for (const [k, c] of [['SPW_DERIV_LIVE_MAINNET', 'mainnet_disabled'], ['SPW_DERIV_MANDATE_MAINNET', 'mandate_mainnet_disabled'], ['SPW_DERIV_MM_MAINNET', 'mm_mainnet_disabled'], ['SPW_TRADING_API_EXECUTION', 'execution_disabled']] as const)
      expect(mmOpeningLock('mainnet', envMmLocks({ ...on, [k]: 'off' }))!.code).toBe(c);
    expect(mmOpeningLock('mainnet', envMmLocks({ ...on, SPW_DERIV_MM_MAINNET: 'ON' }))!.code).toBe('mm_mainnet_disabled');   // only the exact value `on`
    expect(mmOpeningLock('mainnet', envMmLocks({}))!.code).toBe('mainnet_disabled');                 // default: everything off
    // testnet: its own switch and the agents' execution switch; the three mainnet locks are NOT consulted
    expect(mmOpeningLock('testnet', envMmLocks({ SPW_DERIV_MM_TESTNET: 'on', SPW_TRADING_API_EXECUTION: 'on' }))).toBeNull();
    expect(mmOpeningLock('testnet', envMmLocks({ ...on, SPW_DERIV_MM_TESTNET: 'off' }))!.code).toBe('mm_testnet_disabled');
    expect(mmOpeningLock('testnet', envMmLocks({ SPW_DERIV_MM_TESTNET: 'on' }))!.code).toBe('execution_disabled');
    const tn = mmNetworkSelection('testnet', envMmLocks({})), mn = mmNetworkSelection('mainnet', envMmLocks({}));
    expect([tn.network, tn.restUrl, tn.wsUrl, tn.lock!.code, tn.consulted]).toEqual(['testnet', 'https://api.hyperliquid-testnet.xyz', 'wss://api.hyperliquid-testnet.xyz/ws', 'mm_testnet_disabled', ['SPW_DERIV_MM_TESTNET', 'SPW_TRADING_API_EXECUTION']]);
    expect([mn.network, mn.restUrl, mn.lock!.code, mn.consulted.length]).toEqual(['mainnet', 'https://api.hyperliquid.xyz', 'mainnet_disabled', 4]);
    expect(() => mmNetworkSelection('arbitrum', envMmLocks(on))).toThrow(/mainnet or testnet/);
    // through the lifecycle, on this testnet account
    w.flags.locks.SPW_DERIV_MM_TESTNET = 'off';
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('mm_testnet_disabled');
    w.flags.locks.SPW_DERIV_MM_TESTNET = 'on'; w.flags.locks.SPW_TRADING_API_EXECUTION = 'off';
    expect(await code(life.startAgent(agentId, 'live', { kind: 'api_key', id: 'spk_x' }))).toBe('execution_disabled');
    w.flags.locks.SPW_TRADING_API_EXECUTION = 'on';
  });

  it('the checklist, in order, each step with its evidence: paper session, the NEGATIVE evidence acknowledged, the jurisdiction, (testnet), the mandate, the locks', async () => {
    const { goLiveChecklist, acknowledge, MM_EVIDENCE, evidenceSha256 } = await import('../src/mm/lifecycle.ts'), store = await import('../src/agent-runtime/store.ts');
    const { envMmLocks } = await import('../src/mm/live-adapter.ts'), o = () => ({ now: w.clock.now(), locks: envMmLocks(w.flags.locks) });
    const list = async () => goLiveChecklist(await store.loadAgent(agentId), w.execution.mandates, o());
    let l = await list();
    expect(l.steps.map((s) => [s.id, s.done])).toEqual([['paper', false], ['evidence', false], ['jurisdiction', false], ['testnet', false], ['mandate', true], ['locks', true]]);
    expect(l.ready).toBe(false);
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('golive_incomplete');
    expect(MM_EVIDENCE.simulation.figures.pnlUsd).toBe('-0.125'); expect(MM_EVIDENCE.lab.figures.btcBpsOfVolume).toBe('-3.2'); expect(MM_EVIDENCE.statement.en).toMatch(/NEGATIVE/);
    // a recorded paper session on the instrument (here: stored as the runtime stores it), then the two acknowledgements
    await sql`insert into mm_sessions (id, agent_id, mode, instrument, session_hex, policy, state, started_at, ended_at, heartbeat_at, pnl) values (gen_random_uuid(), ${agentId}, 'PAPER', ${BTC}, '00000000000000aa', 'spread_inventory', 'stopped',
      ${new Date(w.clock.now() - 5 * MIN)}, ${new Date(w.clock.now() - MIN)}, ${new Date(w.clock.now() - MIN)}, ${sql.json({ fills: 3, totalUsd: '-0.01' })})`;
    const acks = await acknowledge(agentId, 'evidence', { locale: 'en' }, w.clock.now());
    expect(acks.evidence!.sha256).toBe(evidenceSha256('en'));
    await acknowledge(agentId, 'jurisdiction', { locale: 'fr' }, w.clock.now());
    l = await list();
    expect(l.steps.map((s) => s.done)).toEqual([true, true, true, false, true, true]);
    expect(l.network).toBe('testnet'); expect(l.ready).toBe(true);                                 // this mandate IS the testnet step: it is not its own prerequisite
    expect((l.steps[0]!.evidence as any).session.minutes).toBe(4);
    // a key cannot make the FIRST live start
    expect(await code(life.startAgent(agentId, 'live', { kind: 'api_key', id: 'spk_x' }))).toBe('mandate_required');
  });
});

describe('a live session through the runtime', () => {
  let w1: ReturnType<MmLiveWorld['worker']>, w2: ReturnType<MmLiveWorld['worker']>;
  const kinds = () => w.quotingCalls.filter((c) => c.ok).map((c) => c.kind);

  it('start: the owner starts the agent; ONE worker takes the lease; cancel-all → reconcile → arm the dead man\'s switch → quote', async () => {
    expect((await life.startAgent(agentId, 'live', { kind: 'owner' })).state).toBe('LIVE');
    expect((await agent()).runtime.mm.live.mandateId).toBe(mandateId);
    w1 = w.worker('worker-1'); w2 = w.worker('worker-2');
    const out = await w.run(8000, [w1, w2]);
    // exactly one worker quotes the agent: the other never has a session
    expect(w1.stream!.mm.has(agentId)).toBe(true); expect(w2.stream!.mm.has(agentId)).toBe(false);
    expect(out.filter((o) => o[agentId] !== undefined).length).toBe(8);                              // one pass a second answered for the agent, all by worker-1
    expect(kinds()[0]).toBe('schedule_cancel');                                                       // the first signature of the session arms the switch
    expect(w.sim.log.find((x) => x.type !== 'scheduleCancel')!.type).toBe('order');
    const r = w.resting(), mid = Number(w.sim.mid());
    expect(r.buy).toHaveLength(1); expect(r.sell).toHaveLength(1);
    expect(Number(r.buy[0]!.px)).toBeLessThan(mid); expect(Number(r.sell[0]!.px)).toBeGreaterThan(mid);
    expect(w.sim.scheduledAt()!).toBeGreaterThan(w.sim.now + 10_000);
    const s = await session();
    expect([s.mode, s.network, s.state, s.mandate_id, s.account_id, s.worker]).toEqual(['LIVE', 'testnet', 'running', mandateId, account, 'worker-1']);
    expect(s.status.phase).toBe('quoting'); expect(s.status.quotes).toHaveLength(2); expect(s.status.switch.armed).toBe(true); expect(s.status.switch.venueTriggersPerDay).toBe(10);
    expect(s.status.mandate).toMatchObject({ id: mandateId, phase: 'active' }); expect(s.status.stream.synced).toBe(true);
    // every signature went through the quoting path; the manual and the directional paths signed nothing
    expect(w.signerJournal('venue.sign.ok')).toHaveLength(0); expect(w.signerJournal('venue.mandate.sign.ok')).toHaveLength(0);
    // quotes are NOT rows of the unified order table
    expect((await sql`select count(*)::int as n from orders where principal_id = ${agentId}`)[0].n).toBe(0);
    // the unified risk service judged the plan (a preview decision for the agent's principal)
    expect((await sql`select count(*)::int as n from risk_decisions where principal_id = ${agentId}`)[0].n).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('fills on both sides: each fill is ONE row with the mid at the fill; the attribution identity holds; the position is the agent\'s (provenance)', async () => {
    const before = (await sql`select count(*)::int as n from mm_fills where agent_id = ${agentId}`)[0].n;
    // a seller trades through our bid, then a buyer through our ask (synthetic trades at chosen moments; the book is the recording)
    const bid = w.resting().buy[0]!;
    w.sim.injectTrade('A', D.str(D.sub(D.from(bid.px), D.from('50'))), '1');
    await w.run(4000, [w1]);
    const ask = w.resting().sell[0]!;
    w.sim.injectTrade('B', D.str(D.add(D.from(ask.px), D.from('50'))), '1');
    await w.run(4000, [w1]);
    const fills = await sql`select side, price::text as price, size::text as size, fee::float as fee, maker, reduce, mid::text as mid, client_id, fill_id, ts from mm_fills where agent_id = ${agentId} and mode = 'LIVE' order by id`;
    expect(fills.length).toBeGreaterThanOrEqual(before + 2);
    expect(new Set(fills.map((f: any) => f.side))).toEqual(new Set(['buy', 'sell']));
    for (const f of fills) { expect(f.maker).toBe(true); expect(f.reduce).toBe(false); expect(Number(f.mid)).toBeGreaterThan(0); expect(f.fee).toBeCloseTo(Number(f.price) * Number(f.size) * 0.00015, 6); expect(f.client_id).toMatch(/^0x[0-9a-f]{32}$/); }
    const s = await session();
    expect(s.pnl.fills).toBe(fills.length);
    expect(Number(s.pnl.totalUsd)).toBeCloseTo(Number(s.pnl.spreadCaptureUsd) + Number(s.pnl.inventoryPnlUsd) + Number(s.pnl.feesUsd) + Number(s.pnl.fundingUsd), 9);
    expect(Number(s.pnl.feesUsd)).toBeLessThan(0);                                                    // tier 0: the maker fee is PAID
    // provenance: the venue's fills, as the live engine stores them, are attributed to the AGENT by the session's client-id prefix
    for (const f of w.sim.fills) await sql`insert into deriv_fills (account_id, fill_id, instrument, order_id, client_id, side, price, size, fee, fee_asset, ts) values (${account}, ${`${f.hash}-${f.tid}`}, ${BTC}, ${String(f.oid)}, ${f.cloid ?? null},
      ${f.side === 'B' ? 'buy' : 'sell'}, ${f.px}, ${f.sz}, ${f.fee}, 'USDC', ${new Date(f.time)}) on conflict do nothing`;
    const { lotsOf, principalKey } = await import('../src/orders/provenance.ts');
    const lots = await lotsOf(account, BTC), pos = D.from(w.sim.positionSize());
    if (!D.isZero(pos)) expect(D.str(lots.get(principalKey({ kind: 'agent', id: agentId })) ?? D.zero)).toBe(D.str(pos));
    expect(lots.get('owner:owner')).toBeUndefined();
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
  }, 60_000);

  it('hard inventory limit: quotes are pulled and the excess is unwound with reduce-only orders — each one a unified order of the agent', async () => {
    // inventory the session did not quote for (as if a fill had been missed): 0.0012 BTC ≈ 78 USD, above the hard limit of 50 USD
    (w.sim as unknown as { position: string }).position = '0.0012';
    await w.run(22_000, [w1]);
    expect(kinds()).toContain('reduce');
    const usd = Number(w.sim.positionSize()) * Number(w.sim.mid());
    expect(usd).toBeLessThanOrEqual(31.5); expect(usd).toBeGreaterThan(0);                           // down to the SOFT limit (30 USD, within one lot), not flat
    const orders = await sql`select id, state, reduce_only, side, engine, origin, principal_kind, mode, mandate_id, record, detail from orders where principal_id = ${agentId} order by created_at`;
    expect(orders.length).toBeGreaterThanOrEqual(1);
    for (const o of orders) { expect([o.principal_kind, o.reduce_only, o.side, o.engine, o.origin, o.mode, o.mandate_id]).toEqual(['agent', true, 'sell', 'none', 'agent', 'live', mandateId]); expect(['FILLED', 'CANCELLED']).toContain(o.state); expect(o.detail.source).toBe('market_making'); expect(o.detail.why).toBe('hard_limit'); }
    expect(orders.some((o: any) => o.state === 'FILLED' || Number(o.record.filledSize) > 0)).toBe(true);
    const events = await sql`select event from order_events where order_id = ${orders[0].id} order by seq`;
    expect(events.map((e: any) => e.event).slice(0, 4)).toEqual(['validated', 'approved', 'submit_started', 'venue_accepted']);
    const taker = await sql`select maker, reduce, side from mm_fills where agent_id = ${agentId} and reduce order by id`;
    expect(taker.length).toBeGreaterThanOrEqual(1); for (const f of taker) expect([f.maker, f.side]).toEqual([false, 'sell']);
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
    await w.run(6000, [w1]);
    expect(w.resting().sell.length).toBe(1);                                                          // under the soft limit again: the reducing side is quoted
  }, 60_000);

  it('kill switch: quotes are pulled at once (cancels are signed), nothing is quoted while it is engaged; a breaker event is journaled and audited for the alerts', async () => {
    w.flags.kill = true;
    const [o] = (await w.run(2000, [w1])).slice(-1);
    expect(o![agentId]).toMatch(/^pulled: breaker kill_switch/);
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    const n = w.sim.log.filter((x) => x.type === 'order').length;
    await w.run(5000, [w1]);
    expect(w.sim.log.filter((x) => x.type === 'order').length).toBe(n);
    const s = await session();
    expect(s.status.activeBreakers).toEqual(['kill_switch']); expect(s.breakers.at(-1)).toMatchObject({ code: 'kill_switch', action: 'pull' });
    expect(await journalCodes()).toContain('breaker:kill_switch');
    expect((await sql`select count(*)::int as n from audit_events where type = 'mm.breaker' and data->>'agent' = ${agentId} and data->>'code' = 'kill_switch'`)[0].n).toBe(1);
    w.flags.kill = false;
    await w.run(4000, [w1]);
    expect((await session()).status.phase).toBe('quoting');
  }, 60_000);

  it('the owner\'s PULL and FLATTEN work under a closed lock and under the kill switch; a closed lock alone holds the quotes and never the exits', async () => {
    const { postCommand } = await import('../src/mm/sessions.ts');
    // a lock closed mid-session: quotes are pulled (cancels pass), the code is shown, and they come back when it is opened
    w.flags.locks.SPW_DERIV_MM_TESTNET = 'off';
    await w.run(3000, [w1]);
    let s = await session();
    expect(s.status.lock).toBe('mm_testnet_disabled'); expect(s.status.quotes).toEqual([]); expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    expect(s.status.reason).toMatch(/^mm_testnet_disabled: SPW_DERIV_MM_TESTNET is not on/);
    // with the lock closed AND the kill switch engaged, the owner flattens: reduce-only orders are signed and filled
    w.flags.kill = true;
    expect(Math.abs(Number(w.sim.positionSize()))).toBeGreaterThan(0);
    const before = kinds().filter((k) => k === 'reduce').length;
    expect((await postCommand(agentId, 'flatten', 'owner', w.clock.now()))!.command.command).toBe('flatten');
    await w.run(8000, [w1]);
    expect(D.isZero(D.from(w.sim.positionSize()))).toBe(true);
    expect(kinds().filter((k) => k === 'reduce').length).toBeGreaterThan(before);
    s = await session();
    expect(s.status.manual).toBe('pull'); expect(s.command).toBeNull(); expect(s.command_ack.result).toBe('taken by the session');   // flat: it stays pulled until the owner resumes
    const flat = await sql`select detail->>'why' as why, state from orders where principal_id = ${agentId} order by created_at desc limit 1`;
    expect(flat[0].why).toBe('flatten');
    // everything open again: still pulled — the owner's instruction stands until he resumes
    w.flags.kill = false; w.flags.locks.SPW_DERIV_MM_TESTNET = 'on';
    await w.run(4000, [w1]);
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    await postCommand(agentId, 'resume', 'owner', w.clock.now());
    await w.run(5000, [w1]);
    expect((await session()).status.manual).toBeNull(); expect(w.resting().buy.length + w.resting().sell.length).toBe(2);
    // PULL alone
    await postCommand(agentId, 'pull', 'owner', w.clock.now());
    await w.run(3000, [w1]);
    expect((await session()).status.manual).toBe('pull'); expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    await postCommand(agentId, 'resume', 'owner', w.clock.now());
    await w.run(5000, [w1]);
    expect(w.resting().buy.length + w.resting().sell.length).toBe(2);
  }, 60_000);

  it('UNKNOWN OUTCOME of a quote batch (the venue took it, the answer was lost): reconciled by client id — never sent twice', async () => {
    const orders = () => w.sim.log.filter((x) => x.type === 'order').length;
    w.flags.failNextQuoteBatch = 'lost_after_apply';
    const bid = w.resting().buy[0]!;
    w.sim.injectTrade('A', D.str(D.sub(D.from(bid.px), D.from('50'))), '1');                         // our bid fills → the engine requotes → THAT batch's answer is lost
    const n0 = orders();
    await w.run(6000, [w1]);
    expect(w.flags.failNextQuoteBatch).toBeNull();
    expect(await journalCodes()).toContain('outcome_unknown');
    const s = await session();
    expect(s.counters.unknownOutcomes).toBe(1);
    // the order of unknown outcome exists ONCE on the venue; the session found it by its client id and did not place another next to it
    expect(w.resting().buy.length).toBe(1);
    expect(orders() - n0).toBeLessThanOrEqual(2);
    expect(s.status.blockedSides).toEqual([]);
    const ids = w.sim.log.length; void ids;
    expect(new Set([...w.resting().buy, ...w.resting().sell].map((o) => o.cloid)).size).toBe(w.resting().buy.length + w.resting().sell.length);
  }, 60_000);

  it('USER-STREAM GAP: quotes are pulled while the session cannot see its own orders; REST is the safety reconcile at a bounded rate; a missed event is found by the audit and REST wins', async () => {
    const rest = () => w.simRequests.filter((r) => r.type === 'frontendOpenOrders').length;
    const r0 = rest();
    await w.run(20_000, [w1]);
    expect(rest() - r0).toBeLessThanOrEqual(1);                                                       // steady state: the stream answers, REST only at the audit cadence
    w.setUserStream('reconnecting');
    const r1 = rest();
    await w.run(25_000, [w1]);
    let s = await session();
    expect(s.status.stream.status).toBe('reconnecting'); expect(s.status.activeBreakers).toContain('venue_disconnected');
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    expect(rest() - r1).toBeGreaterThanOrEqual(2); expect(rest() - r1).toBeLessThanOrEqual(4);       // every 10 s at most while the stream is down
    w.setUserStream('connected');
    await w.run(22_000, [w1]);
    s = await session();
    expect([s.status.stream.status, s.status.stream.synced, s.status.phase]).toEqual(['connected', true, 'quoting']);
    expect(s.status.stream.gaps).toBeGreaterThanOrEqual(1);
    // an event the stream never delivered: a fill while the feed silently drops messages — the 60 s REST audit finds it
    const fillsBefore = (await sql`select count(*)::int as n from mm_fills where agent_id = ${agentId}`)[0].n, bid = w.resting().buy[0]!;
    w.flags.dropUser = true;
    w.sim.injectTrade('A', D.str(D.sub(D.from(bid.px), D.from('50'))), '1');
    w.flags.dropUser = false;
    await w.run(75_000, [w1]);
    s = await session();
    expect(s.status.stream.divergences).toBeGreaterThanOrEqual(1);
    expect((await sql`select count(*)::int as n from mm_fills where agent_id = ${agentId}`)[0].n).toBeGreaterThan(fillsBefore);
    expect(await journalCodes()).toContain('stream_divergence');
  }, 120_000);

  it('SIGNER DOWN: nothing can be signed — the heartbeat stops and the VENUE cancels everything at the switch\'s deadline; when the signer is back the session reconciles and quotes again', async () => {
    expect(w.resting().buy.length + w.resting().sell.length).toBeGreaterThan(0);
    const triggers = w.sim.triggersToday();
    w.flags.signerDown = true;
    await w.run(40_000, [w1]);
    expect(w.sim.triggersToday()).toBe(triggers + 1);                                                 // the dead man's switch fired at the venue
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0);
    let s = await session();
    expect(s.status.phase).toBe('pulled'); expect(s.status.reason).toMatch(/no quoting mandate|dead man/);
    w.flags.signerDown = false;
    await w.run(12_000, [w1]);
    s = await session();
    expect(s.status.phase).toBe('quoting'); expect(w.resting().buy.length + w.resting().sell.length).toBeGreaterThan(0);
    // the signer counted the lapse of the deadline it had signed; the session saw it and wrote the audit event the alert reads
    expect(w.signerQuoting(mandateId).today.lapses).toBeGreaterThanOrEqual(1);
    expect(s.status.switch.lapsesToday).toBeGreaterThanOrEqual(1);
    expect((await sql`select count(*)::int as n from audit_events where type = 'mm.switch_lapse' and data->>'agent' = ${agentId}`)[0].n).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('RESTART WITH RESTING ORDERS: the worker is replaced while its quotes rest — the new session adopts what rests, cancels it FIRST, reconciles, re-arms, then quotes', async () => {
    const resting = [...w.resting().buy, ...w.resting().sell].map((o) => o.cloid);
    expect(resting.length).toBeGreaterThan(0);
    const s1 = await session(), calls = w.quotingCalls.length;
    // worker-1 stops (it sends nothing more) and its lease is released, as a clean process exit does
    w1.stream!.mm.forget(agentId);
    await sql`update agent_leases set expires_at = ${new Date(w.clock.now())} where agent_id = ${agentId}`;
    await w.run(6000, [w2]);
    const s2 = await session();
    expect(s2.id).not.toBe(s1.id); expect(s2.worker).toBe('worker-2');
    expect((await sql`select state from mm_sessions where id = ${s1.id}`)[0].state).toBe('abandoned');
    const after = w.quotingCalls.slice(calls).filter((c) => c.ok).map((c) => c.kind);
    expect(after.slice(0, 3)).toEqual(['cancel', 'schedule_cancel', 'quotes']);                       // cancel-all → (reconcile) → arm → quote
    const now = [...w.resting().buy, ...w.resting().sell].map((o) => o.cloid);
    expect(now.some((c) => resting.includes(c))).toBe(false);                                          // none of the old session's orders is left
    expect(now.every((c) => c!.startsWith(`0x${s2.session_hex}`))).toBe(true);
    expect((await sql`select count(*)::int as n from research_log where agent_id = ${agentId} and code = 'adopted_order'`)[0].n).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('THE WORKER DIES with resting quotes (no shutdown, no release): the venue\'s dead man\'s switch cancels them; the next worker takes the expired lease and restarts cleanly', async () => {
    expect(w.resting().buy.length + w.resting().sell.length).toBeGreaterThan(0);
    const triggers = w.sim.triggersToday(), deadline = w.sim.scheduledAt()!, s2 = await session();
    expect(deadline).toBeGreaterThan(w.sim.now);
    // SIGKILL: worker-2 simply stops running — nothing is cancelled, nothing is released. Nobody else may quote while its lease lives.
    const w3 = w.worker('worker-3');
    const out = await w.run(deadline - w.sim.now + 1500, [w3]);
    expect(out.every((o) => o[agentId] === undefined)).toBe(true);                                    // the lease (30 s) is still worker-2's: worker-3 does nothing
    expect(w.sim.triggersToday()).toBe(triggers + 1);                                                 // the venue fired the switch
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0);                                 // at most deadManSeconds of unmanaged quotes
    await w.run(40_000, [w3]);
    const s3 = await session();
    expect(s3.id).not.toBe(s2.id); expect(s3.worker).toBe('worker-3'); expect(s3.status.phase).toBe('quoting');
    expect((await sql`select state, end_reason from mm_sessions where id = ${s2.id}`)[0]).toMatchObject({ state: 'abandoned' });
    expect(w.resting().buy.length + w.resting().sell.length).toBeGreaterThan(0);
    w1 = w3;
  }, 120_000);

  it('WIND-DOWN AT EXPIRY: inside stopBeforeExpiryS the session cancels, removes the switch and ends; the agent is stopped and the mandate REVOKED at the signer; live needs a new mandate', async () => {
    const m: any = await w.execution.mandates.get(mandateId), triggers = w.sim.triggersToday();
    // 24 h later, 200 s before the expiry (the tape has ended: the book is old — stopping needs no fresh data)
    w.sim.advance(m.notAfter - 200_000); w.clock.t = w.sim.now;
    for (let k = 0; k < 8; k++) { w.sim.advance(w.sim.now + 1000); w.clock.t = w.sim.now; await w1.streamPass(); }
    const s = await session(), a = await agent();
    expect([s.state, a.state]).toEqual(['stopped', 'STOPPED']); expect(s.end_reason).toMatch(/expires within 300 s/); expect(a.stop_reason).toMatch(/expires within/);
    expect(w.resting().buy.length + w.resting().sell.length).toBe(0); expect(w.sim.scheduledAt()).toBeNull();
    expect(w.sim.triggersToday()).toBe(triggers >= 0 ? w.sim.triggersToday() : 0);
    const after: any = await w.execution.mandates.get(mandateId);
    expect([after.state, after.revocation.signerRevoked]).toEqual(['revoked', true]);
    expect(w.signerQuoting(mandateId).revoked).toBe(true);
    expect((await sql`select count(*)::int as n from audit_events where type = 'mm.session_ended' and data->>'agent' = ${agentId}`)[0].n).toBeGreaterThanOrEqual(1);
    expect(await code(life.startAgent(agentId, 'live', { kind: 'owner' }))).toBe('mandate_required');
    // per-mode performance: LIVE has the sessions above; PAPER has only the one recorded for the checklist
    const { mmPerformance } = await import('../src/mm/sessions.ts'), live = await mmPerformance(agentId, 'LIVE'), paper = await mmPerformance(agentId, 'PAPER');
    expect(live.mode).toBe('live'); expect(live.sessions).toBeGreaterThanOrEqual(3); expect(live.fills).toBeGreaterThanOrEqual(3);
    expect(Number(live.attribution.totalUsd)).toBeCloseTo(Number(live.attribution.spreadCaptureUsd) + Number(live.attribution.inventoryPnlUsd) + Number(live.attribution.feesUsd) + Number(live.attribution.fundingUsd), 9);
    expect([paper.mode, paper.sessions]).toEqual(['paper', 1]);
  }, 120_000);
});
