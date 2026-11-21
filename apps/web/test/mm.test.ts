/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/mm.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// V11 market making (web) — the rules of apps/web/src/mm.ts and of screens/mmPanel.tsx, as the repository checks its other
// screens: pure helpers, components rendered to markup from fixtures shaped like the API's answers, and source conventions.
//   the checklist is ordered and gated by the server's steps · the evidence shows its NEGATIVE figures and needs the exact
//   statement ticked · every field of the quoting mandate shows its compiled bound · a refusal shows the server's code and
//   sentence · PAPER is labelled SIMULATED · the dead man's switch reads "N of 10, the signer stops at 8" · pull and flatten
//   stay enabled under a lock and a halt · one mode per request · the `mm` block of i18n.ts (contiguous, two languages).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hasText, I18n, setLocaleTable, type Locale } from '../src/i18n';
import {
  addMul, ageText, boundText, breakerChoices, canApprove, canRevoke, capKey, checklist, commandState, draftProblems, emptyQuotingDraft, fieldKey, FIELDS, flatFigures, goLivePath, groupKey, GROUPS, hmsUtc, INT_FIELDS, isNegative, markoutCell, MM_POLL_MS,
  mmAgentUrl, mmFillsUrl, mmPerfUrl, MONEY_FIELDS, parseHm, pollInterval, positionLimit, quotingAgent, quotingBody, quotingMandates, refusalOf, STEP_ORDER, stepKey, stepState, switchFacts, tableRows, TESTNET_CHECKS, testnetCheckKey, testnetNoteOk,
  type GoLive, type MmBounds, type MmEvidence, type MmFills, type MmPerformance, type MmView, type QuotingApproval, type SessionView, type StepId,
} from '../src/mm';
import { ApprovalBody, Attribution, CommandBar, EvidenceBlock, FillsTable, GoLiveList, PastSessions, QuotingFields, QuotingMandatesBlock, RefusalNotice, SessionNow, SwitchLine, type GoLiveActions, type GoLiveState } from '../src/screens/mmPanel';

// run from apps/web, vitest reads the app's vite.config.ts: its `spw-i18n-split` plugin empties the texts of i18n.ts and serves one
// table per language, as in the browser — they are loaded here the way main.tsx does. From the repository root the texts are in i18n.ts.
if (!hasText('mmTitle')) for (const l of ['fr', 'en'] as const) { const id = `virtual:spw-i18n-${l}`; setLocaleTable(l, ((await import(/* @vite-ignore */ id)) as { default: Record<string, string> }).default); }
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');
const panel = read('../src/screens/mmPanel.tsx'), lib = read('../src/mm.ts'), i18n = read('../src/i18n.ts'), agentPanel = read('../src/screens/agentPanel.tsx'), risk = read('../src/screens/Risk.tsx'), monitor = read('../src/screens/Monitor.tsx');
const render = (el: ReactElement, locale: Locale = 'en'): string => renderToStaticMarkup(h(I18n.Provider, { value: { locale, setLocale: () => {} } }, el));
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
/** the opening tag that carries a data-testid */
const tag = (html: string, testid: string): string => { const k = html.indexOf(`data-testid="${testid}"`); expect(k, testid).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<', k), html.indexOf('>', k) + 1); };
/** the visible text of the element that carries a data-testid (an element without a nested element of the same tag) */
const inner = (html: string, testid: string): string => { const k = html.indexOf(`data-testid="${testid}"`); expect(k, testid).toBeGreaterThan(-1); const a = html.lastIndexOf('<', k), name = /^<([a-z0-9]+)/.exec(html.slice(a))![1]!; return text(html.slice(a, html.indexOf(`</${name}>`, k))); };
/** the markup from a data-testid to the next one of the list (or the end) */
const from = (html: string, testid: string, until?: string): string => { const k = html.indexOf(`data-testid="${testid}"`); expect(k, testid).toBeGreaterThan(-1); const e = until ? html.indexOf(`data-testid="${until}"`, k + 1) : -1; return html.slice(k, e < 0 ? undefined : e); };

// ---- fixtures: the shapes of services/api/src/mm/routes.ts
const AGENT = '11111111-2222-4333-8444-555555555555', MANDATE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BOUNDS: MmBounds = {
  signer: { maxDays: 7, maxInstruments: 3, maxLeverage: 10, maxQuoteNotional: '2000', maxRestingPerSide: 5, maxRestingTotal: 20, maxRestingNotionalPerSide: '10000', maxInventoryNotional: '20000', maxGrossExposure: '50000', minHalfSpreadBpsFloor: 1, maxDistanceBpsCeiling: 500,
    minReduceDeviationBps: 10, maxReduceDeviationBps: 300, maxBurstActions: 20, maxActionsPerMinute: 60, maxOrdersPerHour: 3600, maxOrdersPerDay: 20000, maxDailyTurnover: '2000000', maxBatch: 20, minDeadManSeconds: 10, maxDeadManSeconds: 120 },
  section: { minQuoteSizeUsd: '10', minSessionMinutes: 5, maxSessionMinutes: 1440, maxSessionLossUsd: '5000', minStopBeforeExpiryS: 60, maxStopBeforeExpiryS: 86400 },
  breakers: [{ code: 'data_stale', default: 'pull', alwaysStops: false }, { code: 'adverse_selection', default: 'pull', alwaysStops: false }, { code: 'consecutive_rejects', default: 'halt', alwaysStops: true }, { code: 'drawdown_session', default: 'halt', alwaysStops: true }],
  locks: { mainnet: { network: 'mainnet', lock: { code: 'mainnet_disabled', setting: 'SPW_DERIV_LIVE_MAINNET', message: 'SPW_DERIV_LIVE_MAINNET is not on: no order that can add risk is sent to mainnet' }, consulted: ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_MANDATE_MAINNET', 'SPW_DERIV_MM_MAINNET', 'SPW_TRADING_API_EXECUTION'] },
    testnet: { network: 'testnet', lock: { code: 'mm_testnet_disabled', setting: 'SPW_DERIV_MM_TESTNET', message: 'SPW_DERIV_MM_TESTNET is not on: no quote is placed on testnet' }, consulted: ['SPW_DERIV_MM_TESTNET', 'SPW_TRADING_API_EXECUTION'] } },
};
const STATEMENT = 'I have read the two results above. The laboratory study and the simulation both show a NEGATIVE modelled PnL and adverse markouts, at a maker fee of 1.5 bps that I pay. Nothing here supports an expectation of profit. Running a live session is my own decision.';
const EVIDENCE: MmEvidence = { evidence: { version: '2026-11-16',
  lab: { source: 'research/studies/market_making_as', ranOn: '2026-11-15', sample: '68 minutes of 5 s books; fills MODELLED, not observed', result: 'Avellaneda–Stoikov PnL NEGATIVE on BTC, ETH and SOL on Hyperliquid, under both fill rules',
    figures: { btcPnlUsd: '-9.5', btcVolumeUsd: '30000', btcBpsOfVolume: '-3.2', markout60sBps: 'between -1 and -2.7 (adverse selection)', makerFeeBps: '1.5 paid' } },
  simulation: { source: 'services/api/test/mm-engine.test.ts on the recorded public BTC tape; fills MODELLED (queue + trade-through)', result: 'PnL NEGATIVE',
    figures: { minutes: 36, quoteBatches: 286, quotes: 495, cancels: 486, fills: 36, volumeUsd: '683', pnlUsd: '-0.125', bpsOfVolume: '-1.83', spreadCaptureUsd: '0.086', inventoryPnlUsd: '-0.108', feesUsd: '-0.102', markoutBps: { '1s': '-0.47', '10s': '-0.92', '60s': '-0.33' } } },
  fees: 'tier 0 on Hyperliquid perpetuals: maker 0.015 % PAID (not received), taker 0.045 %', statement: { en: STATEMENT, fr: 'J’ai lu les deux résultats ci-dessus.' } },
  statement: STATEMENT, sha256: 'e'.repeat(64), jurisdiction: { text: 'Hyperliquid restricts access from certain jurisdictions.\nYou confirm you are not in one of them.', sha256: 'f'.repeat(64), version: '1', source: 'docs/v4/venues/jurisdiction.md' }, minPaperMinutes: 30 };
const step = (id: StepId, done: boolean, evidence: Record<string, unknown> = {}, missing: string | null = done ? null : `missing ${id}`) => ({ id, done, evidence, missing });
const goLive = (done: StepId[], network: GoLive['network'] = null, ready = false): GoLive => ({ steps: STEP_ORDER.map((id) => step(id, done.includes(id), id === 'paper' ? { requiredMinutes: 30, instrument: 'hyperliquid:BTC', session: done.includes('paper') ? { id: 's1', minutes: 31.4, fills: 7, startedAt: 1_800_000_000_000 } : null }
  : id === 'locks' ? { network, code: network === 'mainnet' ? 'mainnet_disabled' : null, setting: network === 'mainnet' ? 'SPW_DERIV_LIVE_MAINNET' : null } : {})), ready, network });
const session = (o: Partial<SessionView> = {}): SessionView => ({ id: 's1', mode: 'paper', instrument: 'hyperliquid:BTC', network: 'mainnet', state: 'running', policy: 'spread_inventory', startedAt: 1_800_000_000_000, endedAt: null, endReason: null, heartbeatAt: 1_800_000_050_000, stale: false,
  counters: { quotesPlaced: 12, quotesCancelled: 10 }, pnl: { totalUsd: '-0.125', spreadCaptureUsd: '0.086', inventoryPnlUsd: '-0.108', feesUsd: '-0.102', fundingUsd: '0', position: '0.0004', fills: 3, volumeUsd: '150', bpsOfVolume: '-8.33' },
  markouts: [{ horizonMs: 1000, fills: 3, meanBps: '-0.47', weightedMeanBps: '-0.5', worstBps: '-1.2' }], refusals: { signer_quote_too_close: 2, post_only_would_cross: 1 },
  budget: { limitPerMinute: 1200, usedLastMinute: 84, peakPerMinute: 140, restWeight: 400, exchangeWeight: 90, signerWeightEstimate: 30, address: { remaining: 9876, orders: 24, cancels: 20, heartbeats: 6 } }, breakers: [{ ts: 1_800_000_010_000, code: 'data_stale', action: 'pull' }],
  status: { phase: 'quoting', reason: null, ending: null, position: '0.0004', positionUsd: '41.2', mid: '103000.5', quotes: [{ clientId: 'c1', side: 'buy', price: '102990', size: '0.00048', state: 'resting', ageMs: 1500, distanceBps: '1.02' }, { clientId: 'c2', side: 'sell', price: '103011', size: '0.00048', state: 'resting', ageMs: 61_000, distanceBps: '1.02' }],
    blockedSides: [], activeBreakers: [], halted: null, manual: null, lock: null, switch: { deadline: Date.UTC(2026, 10, 16, 3, 7, 9), armed: true, lapsesToday: 3, venueTriggersPerDay: 10, signerStopsAt: 8 }, mandate: null, schedule: null, stream: null, simulated: true, ts: 1_800_000_050_000 },
  simulated: true, label: 'PAPER — SIMULATED fills on real books', ...o });
const view = (o: Partial<MmView> = {}): MmView => ({ agentId: AGENT, state: 'PAPER_TRADING', mode: 'PAPER', universe: ['BTC'], venues: ['hyperliquid'], config: { quoteSizeUsd: '50', minHalfSpreadBps: '2', maxInventoryUsd: '250', policy: 'spread_inventory' }, configVersion: 1, session: null, sessions: [], mandate: null, goLive: goLive([]), ts: 1_800_000_050_000, ...o });
const QA = quotingAgent(view(), { strategySha256: 'b'.repeat(64), capitalUsd: '1000' });
const ST: GoLiveState = { busy: '', refusal: null, refusalAt: '', evidenceChecked: false, jurisdictionChecked: false, note: '' };
const ON: GoLiveActions = { check: () => {}, note: () => {}, ack: () => {}, form: () => {}, review: () => {}, revoke: () => {}, recover: () => {}, start: () => {}, stop: () => {} };
const list = (v: MmView, st: Partial<GoLiveState> = {}, locale: Locale = 'en') => render(h(GoLiveList, { view: v, ev: EVIDENCE, bounds: BOUNDS, st: { ...ST, ...st }, on: ON }), locale);
const stepHtml = (html: string, id: StepId): string => from(html, `mm-step-${id}`, STEP_ORDER[STEP_ORDER.indexOf(id) + 1] ? `mm-step-${STEP_ORDER[STEP_ORDER.indexOf(id) + 1]}` : undefined);

describe('one mode per request; the poll runs only while the section is on screen', () => {
  it('every read names exactly one mode', () => {
    for (const mode of ['paper', 'live'] as const) for (const u of [mmAgentUrl('a', mode), mmFillsUrl('a', mode), mmPerfUrl('a', mode)]) { expect(u.match(/mode=/g)).toHaveLength(1); expect(u).toContain(`mode=${mode}`); }
    expect(mmFillsUrl('a', 'live', 50)).toBe('/mm/agents/a/fills?mode=live&limit=50');
    // the three queries are keyed by the tab, and the tab's subtree is keyed too: switching tab never merges two answers
    for (const k of ["queryKey: ['mm-agent', id, tab]", "queryKey: ['mm-fills', id, tab]", "queryKey: ['mm-perf', id, tab]", 'key={tab}']) expect(panel).toContain(k);
    expect(panel).not.toMatch(/mode=(paper|live)/);                                             // no hand-built URL: mm.ts builds them
  });
  it('2 s while visible, nothing when hidden or off screen', () => {
    expect([MM_POLL_MS, pollInterval(true), pollInterval(false)]).toEqual([2000, 2000, false]);
    expect(panel).toContain('refetchInterval: pollInterval(visible), refetchIntervalInBackground: false');
    expect(panel).toContain('IntersectionObserver'); expect(panel).toContain("document.addEventListener('visibilitychange'"); expect(panel).toContain("document.removeEventListener('visibilitychange'");
  });
});

describe('the go-live checklist: ordered, gated, the server decides what is done', () => {
  it('six steps in the order of the flow; a step is actionable only when every step before it is done', () => {
    expect([...STEP_ORDER]).toEqual(['paper', 'evidence', 'jurisdiction', 'testnet', 'mandate', 'locks']);
    const none = checklist(goLive([]));
    expect(none.map((s) => [s.n, s.id, s.actionable, s.locked])).toEqual([[1, 'paper', true, false], [2, 'evidence', false, true], [3, 'jurisdiction', false, true], [4, 'testnet', false, true], [5, 'mandate', false, true], [6, 'locks', false, true]]);
    const two = checklist(goLive(['paper', 'evidence']));
    expect(two.filter((s) => s.actionable).map((s) => s.id)).toEqual(['jurisdiction']);
    expect(two.map(stepState)).toEqual(['done', 'done', 'current', 'next', 'next', 'next']);
    // a later step the server reports done stays done, but it does not open the ones a missing step still gates
    const hole = checklist(goLive(['paper', 'jurisdiction']));
    expect(hole.map((s) => [s.id, s.done, s.actionable])).toEqual([['paper', true, false], ['evidence', false, true], ['jurisdiction', true, false], ['testnet', false, false], ['mandate', false, false], ['locks', false, false]]);
    // the server lists the steps in any order: the screen keeps its own
    const shuffled = goLive(['paper']); shuffled.steps.reverse();
    expect(checklist(shuffled).map((s) => s.id)).toEqual([...STEP_ORDER]);
    expect(checklist(shuffled).find((s) => s.actionable)!.id).toBe('evidence');
  });
  it('the testnet step is not asked of a mandate that is itself on testnet — and only then', () => {
    const tn = checklist(goLive(['paper', 'evidence', 'jurisdiction', 'mandate'], 'testnet'));
    expect(tn.find((s) => s.id === 'testnet')).toMatchObject({ done: false, skipped: true, actionable: false, locked: false });
    expect(tn.find((s) => s.id === 'locks')).toMatchObject({ actionable: true });
    const mn = checklist(goLive(['paper', 'evidence', 'jurisdiction', 'mandate'], 'mainnet'));
    expect(mn.find((s) => s.id === 'testnet')).toMatchObject({ skipped: false, actionable: true });
    expect(mn.find((s) => s.id === 'locks')).toMatchObject({ actionable: false, locked: true });
  });
  it('rendered: nothing can be acted on past the first missing step; the server\'s "missing" sentence is shown', () => {
    const html = list(view());
    expect((html.match(/data-testid="mm-step-(paper|evidence|jurisdiction|testnet|mandate|locks)"/g) ?? []).map((x) => /mm-step-(\w+)/.exec(x)![1])).toEqual([...STEP_ORDER]);
    expect(tag(html, 'mm-step-paper')).toContain('data-state="current"');
    for (const id of ['evidence', 'jurisdiction', 'testnet', 'mandate', 'locks'] as const) expect(tag(html, `mm-step-${id}`), id).toContain('data-state="next"');
    for (const id of ['mm-evidence-check', 'mm-evidence-ack', 'mm-jurisdiction-check', 'mm-jurisdiction-ack', 'mm-testnet-note', 'mm-testnet-ack', 'mm-testnet-mandate', 'mm-mandate-create', 'mm-mandate-review']) expect(html, id).not.toContain(`data-testid="${id}"`);
    expect(text(stepHtml(html, 'paper'))).toContain('Missing, says the server: missing paper');
    expect(text(stepHtml(html, 'paper'))).toContain('A paper session of at least 30 minutes on hyperliquid:BTC.');
    expect(tag(html, 'mm-start-live')).toMatch(/\sdisabled=""/);                                    // start is the server's `ready`, nothing else
    expect(html).toContain('data-testid="mm-start-blocked"');
    expect(tag(html, 'mm-golive')).toContain('data-ready="false"');
  });
  it('rendered: each step shows its evidence; the next one becomes the step to act on', () => {
    const p = list(view({ goLive: goLive(['paper']) }));
    expect(text(from(p, 'mm-paper-evidence', 'mm-step-evidence'))).toMatch(/Longest session: 31.4 min, 7 fills/);
    expect(stepHtml(p, 'paper')).toContain('data-testid="mm-simulated"');                           // the paper session is evidence of a SIMULATION
    expect(tag(p, 'mm-step-evidence')).toContain('data-state="current"');
    expect(p).toContain('data-testid="mm-evidence-check"'); expect(p).not.toContain('data-testid="mm-jurisdiction-check"');
    const j = list(view({ goLive: goLive(['paper', 'evidence']) }));
    expect(j).toContain('data-testid="mm-jurisdiction-check"'); expect(j).not.toContain('data-testid="mm-evidence-check"'); expect(j).toContain('data-testid="mm-evidence-acked"');
    expect(text(from(j, 'mm-jurisdiction-text', 'mm-jurisdiction-check'))).toContain('Hyperliquid restricts access from certain jurisdictions. You confirm you are not in one of them.');
    expect(tag(j, 'mm-jurisdiction-ack')).toMatch(/\sdisabled=""/);
    expect(tag(list(view({ goLive: goLive(['paper', 'evidence']) }), { jurisdictionChecked: true }), 'mm-jurisdiction-ack')).not.toMatch(/\sdisabled=""/);
    const m = list(view({ goLive: goLive(['paper', 'evidence', 'jurisdiction', 'testnet']) }));
    expect(m).toContain('data-testid="mm-mandate-create"'); expect(m).toContain('data-testid="mm-mandate-none"');
  });
  it('the testnet step is the owner\'s: six verifications, a free-text attestation of at least ten characters', () => {
    expect([...TESTNET_CHECKS]).toEqual(['schedule', 'alo', 'expires', 'lag', 'cloid', 'ratelimit']);
    expect([testnetNoteOk('too short'), testnetNoteOk('  ran it  '), testnetNoteOk('ran a 20 min session: scheduleCancel fired once'), testnetNoteOk('x'.repeat(501))]).toEqual([false, false, true, false]);
    const g = goLive(['paper', 'evidence', 'jurisdiction']), html = list(view({ goLive: g }));
    const body = stepHtml(html, 'testnet'), words = text(body);
    expect((body.match(/<li>/g) ?? []).length).toBe(6);
    for (const w of ['scheduleCancel', 'Alo (post-only)', 'expiresAfter', 'open orders', 'duplicate cloid', 'userRateLimit', 'SPW_DERIV_MM_TESTNET=on', 'test funds', 'The wallet does not run it for you']) expect(words, w).toContain(w);
    expect(tag(html, 'mm-testnet-ack')).toMatch(/\sdisabled=""/);
    expect(tag(list(view({ goLive: g }), { note: 'ran 20 minutes on testnet, switch fired once' }), 'mm-testnet-ack')).not.toMatch(/\sdisabled=""/);
    expect(panel).toContain("...(step === 'testnet' ? { note: st.note.trim() } : {})");
    expect(panel).toContain('post(`/mm/agents/${id}/golive/ack`, { step, locale, acknowledged: true,');
  });
  it('locks: every consulted setting is listed, a closed lock shows its code and the server\'s sentence; start follows `ready`', () => {
    const closed = list(view({ goLive: goLive(['paper', 'evidence', 'jurisdiction', 'testnet', 'mandate'], 'mainnet') }));
    const lk = stepHtml(closed, 'locks');
    expect((lk.match(/data-testid="mm-lock-setting"/g) ?? []).length).toBe(4);
    for (const s of BOUNDS.locks.mainnet.consulted) expect(text(lk)).toContain(s);
    expect(text(from(lk, 'mm-lock-code', 'mm-step-lock'))).toContain('mainnet_disabled — SPW_DERIV_LIVE_MAINNET is not on: no order that can add risk is sent to mainnet');
    expect(lk).not.toContain('data-testid="mm-locks-testnet"');                                     // the network follows from the mandate: only its locks
    expect(tag(closed, 'mm-start-live')).toMatch(/\sdisabled=""/);
    // without a mandate there is no network yet: both sets of settings are shown
    const both = stepHtml(list(view()), 'locks');
    expect(both).toContain('data-testid="mm-locks-mainnet"'); expect(both).toContain('data-testid="mm-locks-testnet"'); expect(text(both)).toContain('mm_testnet_disabled');
    const open: MmBounds = { ...BOUNDS, locks: { ...BOUNDS.locks, mainnet: { ...BOUNDS.locks.mainnet, lock: null } } };
    const ready = render(h(GoLiveList, { view: view({ goLive: goLive([...STEP_ORDER], 'mainnet', true) }), ev: EVIDENCE, bounds: open, st: ST, on: ON }));
    expect(tag(ready, 'mm-start-live')).not.toMatch(/\sdisabled=""/); expect(tag(ready, 'mm-locks-mainnet')).toContain('data-open="true"'); expect(ready).not.toContain('data-testid="mm-start-blocked"');
    // a live agent being stopped says so until its session has cancelled and disarmed
    const stopping = render(h(GoLiveList, { view: view({ state: 'STOPPING', mode: 'LIVE', goLive: goLive([...STEP_ORDER], 'mainnet', true) }), ev: EVIDENCE, bounds: open, st: ST, on: ON }));
    expect(stopping).toContain('data-testid="mm-stopping"'); expect(tag(stopping, 'mm-start-live')).toMatch(/\sdisabled=""/); expect(tag(stopping, 'mm-stop-live')).not.toMatch(/\sdisabled=""/);
  });
});

describe('the evidence is shown as it is: NEGATIVE, unrounded, with the exact statement to tick', () => {
  it('every figure of the server, by its path, with its own text', () => {
    const f = flatFigures(EVIDENCE.evidence.simulation.figures);
    expect(f.find((x) => x.path === 'pnlUsd')!.value).toBe('-0.125'); expect(f.find((x) => x.path === 'bpsOfVolume')!.value).toBe('-1.83');
    expect(f.filter((x) => x.path.startsWith('markoutBps.')).map((x) => `${x.path}=${x.value}`)).toEqual(['markoutBps.1s=-0.47', 'markoutBps.10s=-0.92', 'markoutBps.60s=-0.33']);
    expect(f).toHaveLength(14);
    expect([isNegative('-0.125'), isNegative('-0'), isNegative('0.086'), isNegative(null), isNegative('-0.00'), isNegative(-3)]).toEqual([true, false, false, false, false, true]);
  });
  it('rendered: both results say NEGATIVE, the negative figures are there to the digit, and nothing is coloured as a gain', () => {
    const html = render(h(EvidenceBlock, { ev: EVIDENCE })), words = text(html);
    expect(text(from(html, 'mm-evidence-lab-result', 'mm-evidence-sim'))).toContain('Avellaneda–Stoikov PnL NEGATIVE on BTC, ETH and SOL');
    expect(text(from(html, 'mm-evidence-sim-result', 'mm-evidence-fees'))).toContain('PnL NEGATIVE');
    for (const v of ['-0.125', '-1.83', '-0.108', '-0.102', '-0.47', '-0.92', '-0.33', '-9.5', '-3.2', 'between -1 and -2.7 (adverse selection)', '1.5 paid', '0.086', 'fills MODELLED']) expect(words, v).toContain(v);
    expect((html.match(/Negative result/g) ?? []).length).toBe(2);
    expect(/data-figure="pnlUsd"[^>]*>/.exec(html.replace(/class="([^"]*)" data-figure="pnlUsd"/, 'data-figure="pnlUsd" class="$1"'))![0]).toContain('text-danger');
    expect(html).not.toMatch(/text-emerald|tone="ok"|data-tone="ok"/);                               // the one positive figure (spread capture) is plain
    expect(words).toContain('maker 0.015 % PAID (not received)');
  });
  it('the acknowledgement is the server\'s statement, word for word, and recording it needs the box ticked', () => {
    const html = list(view({ goLive: goLive(['paper']) }));
    expect(inner(html, 'mm-evidence-statement')).toBe(STATEMENT);
    expect(tag(html, 'mm-evidence-ack')).toMatch(/\sdisabled=""/);
    expect(tag(list(view({ goLive: goLive(['paper']) }), { evidenceChecked: true }), 'mm-evidence-ack')).not.toMatch(/\sdisabled=""/);
    expect(panel).toContain('disabled={!st.evidenceChecked}'); expect(panel).toContain('<span data-testid="mm-evidence-statement">{ev.statement}</span>');
    // the evidence is on the page before the step can be acted on (a locked step still shows it), in French too
    const locked = list(view(), {}, 'fr');
    expect(locked).toContain('data-testid="mm-evidence-lab"'); expect(text(locked)).toContain('-0.125'); expect(text(locked)).toContain('Résultat négatif');
  });
});

describe('the quoting mandate form: every field shows its compiled bound; nothing is clamped', () => {
  const d0 = emptyQuotingDraft(QA, BOUNDS);
  it('the 25 numeric fields each have a range from /mm/bounds or the agent, and a label in both languages', () => {
    expect(FIELDS.map((f) => f.key).sort()).toEqual([...MONEY_FIELDS, ...INT_FIELDS].sort());
    expect(FIELDS).toHaveLength(25);
    for (const f of FIELDS) { expect(boundText(f, BOUNDS, d0, QA).length, f.key).toBeGreaterThan(0); expect(GROUPS).toContain(f.group); }
    const b = (k: string) => boundText(FIELDS.find((f) => f.key === k)!, BOUNDS, d0, QA);
    expect([b('maxLeverage'), b('levelsPerSide'), b('maxDistanceBps'), b('deadManSeconds'), b('days'), b('quotesPerDay'), b('dailyTurnoverUsd'), b('maxSessionMinutes'), b('stopBeforeExpiryS'), b('maxSlippageBps'), b('perDay')])
      .toEqual(['1…10', '1…5', '2…500', '10…120', '1…7', '1…20000', '≤ 2000000', '5…1440', '60…86400', '10…300', '1…500']);
    expect(b('minHalfSpreadBps')).toBe('1…2 · < maxDistanceBps');                                  // not above the agent's own minimum half-spread
    expect(b('maxOrderNotionalUsd')).toBe('50…2000 · maxOrderNotionalUsd × levelsPerSide ≤ 10000'); // not below the agent's quote size
    expect(b('hardInventoryUsd')).toBe('≤ 20000 · hardInventoryUsd + quoteSizeUsd × levelsPerSide ≤ 20000');
    expect(b('maxSessionLossUsd')).toBe('≤ 5000 · ≤ maxDailyLossUsd');
    expect(b('maxCapitalUsd')).toBe('≤ 50000 · maxCapitalUsd × maxLeverage ≤ 50000');
    expect(boundText(FIELDS.find((f) => f.key === 'maxCapitalUsd')!, BOUNDS, { ...d0, maxLeverage: '10' }, QA)).toMatch(/^≤ 5000 /);
  });
  it('rendered: each field carries its bound next to it', () => {
    const html = render(h(QuotingFields, { d: d0, bounds: BOUNDS, agent: QA, onChange: () => {} }));
    for (const f of FIELDS) {
      expect(html, f.key).toContain(`data-testid="mm-f-${f.key}"`);
      const max = from(html, `mm-max-${f.key}`).slice(0, 600);
      expect(max, f.key).toContain('data-bad="false"'); expect(text(`<${max}`), f.key).toContain(`Compiled bound: ${boundText(f, BOUNDS, d0, QA)}`);
    }
    expect((html.match(/data-testid="mm-max-/g) ?? []).length).toBe(FIELDS.length);
    for (const g of GROUPS) expect(html).toContain(`data-testid="mm-form-group-${g}"`);
    // the fixed values of the agent and the derived position limit show their bounds too
    for (const id of ['mm-max-quoteSizeUsd', 'mm-max-maxPositionNotionalUsd', 'mm-form-fixed']) expect(panel, id).toContain(`data-testid="${id}"`);
    expect(panel).toContain('<Mono testid="mm-form-position">{pos ?? \'—\'} USD</Mono>');
  });
  it('the first values are sendable; the section says what the agent\'s configuration says', () => {
    expect(draftProblems(d0, BOUNDS, QA).map((p) => p.field)).toEqual(['accountId']);
    const d = { ...d0, accountId: 'cccccccc-1111-4222-8333-444444444444', hoursStart: '13:30', hoursEnd: '20:00' };
    expect(draftProblems(d, BOUNDS, QA)).toEqual([]);
    const body = quotingBody(d, QA, 'fr') as any;
    expect(body).toMatchObject({ principal: { kind: 'agent', id: AGENT }, mode: 'live', accountIds: [d.accountId], instruments: ['hyperliquid:BTC'], marketKinds: ['perp'], orderTypes: ['limit'], stopConditions: [], strategySha256: 'b'.repeat(64), locale: 'fr', days: 1,
      maxOrderNotionalUsd: '50', maxPositionNotionalUsd: '300', maxCapitalUsd: '1000', floorEquityUsd: '800', frequency: { perMinute: 5, perHour: 60, perDay: 200 }, maxSlippageBps: 50 });
    expect(body.quoting.engine).toMatchObject({ policy: 'spread_inventory', quoteSizeUsd: '50', softInventoryUsd: '125', hardInventoryUsd: '250', hours: { startUtcMinute: 810, endUtcMinute: 1200 }, flattenOnStop: false, maxSessionMinutes: 60, stopBeforeExpiryS: 300 });
    expect(body.quoting.terms).toEqual({ levelsPerSide: 1, minHalfSpreadBps: 2, maxDistanceBps: 150, burstActions: 10, actionsPerMinute: 30, quotesPerHour: 1200, quotesPerDay: 10000, dailyTurnoverUsd: '100000', deadManSeconds: 30 });
    expect(body.quoting.engine.breakers).toEqual({ data_stale: 'pull', adverse_selection: 'pull', consecutive_rejects: 'halt', drawdown_session: 'halt' });
    expect(Number(body.maxDailyLossUsd)).toBeGreaterThanOrEqual(Number(body.quoting.engine.maxSessionLossUsd));
    expect(quotingBody({ ...d, hoursStart: '', hoursEnd: '' }, QA, 'en')).toMatchObject({ quoting: { engine: { hours: null } } });
    // an Avellaneda–Stoikov agent: the policy sent is the agent's
    const as = quotingAgent(view({ config: { quoteSizeUsd: '75', minHalfSpreadBps: '3', policy: 'avellaneda_stoikov' } }), { strategySha256: 'b'.repeat(64), capitalUsd: '500' });
    expect((quotingBody({ ...emptyQuotingDraft(as, BOUNDS), accountId: d.accountId }, as, 'en') as any).quoting.engine).toMatchObject({ policy: 'avellaneda_stoikov', quoteSizeUsd: '75' });
    expect([positionLimit({ ...d, hardInventoryUsd: '250.5', levelsPerSide: '3' }, QA), addMul('0.1', '0.2', 1), addMul('19900', '50', 2), parseHm('9:05'), parseHm('24:00'), parseHm('')]).toEqual(['400.5', '0.3', '20000', 545, null, null]);
  });
  it('a value outside its bound is named with the bound, shown in red, and sent exactly as typed — never changed', () => {
    const d = { ...d0, accountId: 'x', deadManSeconds: '300', levelsPerSide: '9', softInventoryUsd: '250', maxLeverage: '20', hoursStart: '25:00', breakers: { ...d0.breakers, drawdown_session: 'pull' as const } };
    const p = new Map(draftProblems(d, BOUNDS, QA).map((x) => [x.field, x.bound]));
    expect(p.get('deadManSeconds')).toBe('10…120'); expect(p.get('levelsPerSide')).toBe('1…5'); expect(p.get('softInventoryUsd')).toBe('< hardInventoryUsd'); expect(p.get('maxLeverage')).toBe('1…10'); expect(p.get('hours')).toBe('HH:MM–HH:MM UTC');
    expect(p.get('breakers.drawdown_session')).toBe('flatten | halt');
    expect([breakerChoices({ alwaysStops: true }), breakerChoices({ alwaysStops: false })]).toEqual([['flatten', 'halt'], ['pull', 'flatten', 'halt']]);
    const body = quotingBody(d, QA, 'en') as any;
    expect([body.quoting.terms.deadManSeconds, body.quoting.terms.levelsPerSide, body.maxLeverage, body.quoting.engine.softInventoryUsd]).toEqual([300, 9, '20', '250']);   // as typed: the server refuses, the form does not clamp
    const html = render(h(QuotingFields, { d, bounds: BOUNDS, agent: QA, onChange: () => {} }));
    expect(from(html, 'mm-max-deadManSeconds').slice(0, 200)).toContain('data-bad="true"'); expect(from(html, 'mm-f-deadManSeconds').slice(0, 300)).toContain('value="300"');
    const qb = lib.slice(lib.indexOf('export function quotingBody'), lib.indexOf('// ------------------------------------------------------------------------------------------------------------------ Risk'));
    expect(qb.length).toBeGreaterThan(500); expect(qb).not.toMatch(/Math\.(min|max)|clamp/);
    expect(panel).toContain('disabled={problems.length > 0}'); expect(panel).toContain("post<{ mandate: { id: string } }>('/mandates', quotingBody(d, agent, locale))");
  });
  it('a closed server lock is said in the form with its code and sentence, before anything is sent', () => {
    expect(panel).toContain('data-testid="mm-form-lock" data-code={lock.lock.code}'); expect(panel).toContain('{lock.lock.message}');
    expect(panel).toContain("(aq.data?.accounts ?? []).filter((a) => a.venue === 'hyperliquid' && a.authorization && (!testnetOnly || a.network === 'testnet'))");
    expect(panel).toContain("queryKey: ['risk', 'live-accounts'], queryFn: () => get<{ accounts: LiveAccount[] }>('/derivatives/live/accounts')");   // the same list as the Risk mandate form
  });
});

describe('refusals are shown verbatim; no passkey prompt past a refusal', () => {
  it('the code and the sentence of the server, and the steps of a golive_incomplete', () => {
    const e = Object.assign(new Error('engine.hardInventoryUsd + quoteSizeUsd × levelsPerSide (20050) is above the mandate\'s maxPositionNotionalUsd (20000)'), { status: 400, code: 'value_not_expressible', body: {} });
    const r = refusalOf(e)!;
    expect(r).toMatchObject({ code: 'value_not_expressible', status: 400, steps: null });
    const html = render(h(RefusalNotice, { r }));
    expect(tag(html, 'mm-refusal')).toContain('data-code="value_not_expressible"');
    expect(inner(html, 'mm-refusal-code')).toBe('value_not_expressible');
    expect(inner(html, 'mm-refusal-message')).toBe(e.message);
    for (const code of ['mainnet_disabled', 'mandate_mainnet_disabled', 'mm_mainnet_disabled', 'mm_testnet_disabled', 'mandate_required', 'quoting_config_mismatch', 'exceeds_authorization', 'quoting_config_changed', 'mandate_integrity', 'execution_disabled'])
      expect(text(render(h(RefusalNotice, { r: refusalOf({ code, message: `${code}: the server's own words`, status: 403 }) }))), code).toBe(`${code} ${code}: the server's own words`);
    const inc = refusalOf({ code: 'golive_incomplete', message: 'the go-live checklist is not complete', status: 409, body: { data: { steps: goLive(['paper']).steps } } })!;
    expect(inc.steps).toHaveLength(6);
    expect(text(render(h(RefusalNotice, { r: inc })))).toContain('evidence — missing evidence');
    expect(refusalOf({ name: 'NotAllowedError' })).toBeNull();                                      // a cancelled passkey prompt is not a refusal
    expect(render(h(RefusalNotice, { r: null }))).toBe('');
  });
  it('a refusal in the checklist shows at the step it came from', () => {
    const r = refusalOf({ code: 'mandate_required', message: 'this market-making agent has no quoting mandate', status: 409 });
    const html = list(view({ goLive: goLive([...STEP_ORDER], 'mainnet', true) }), { refusal: r, refusalAt: 'locks' });
    expect(stepHtml(html, 'locks')).toContain('data-code="mandate_required"'); expect(stepHtml(html, 'mandate')).not.toContain('data-testid="mm-refusal"');
  });
  it('the approval sheet: once refused, the approve button is gone — recover for a lost signer answer, close otherwise', () => {
    const sheet = panel.slice(panel.indexOf('export function QuotingApprovalSheet'), panel.indexOf('// ------------------------------------------------------------------------------------------------------------------ the section of the agent page'));
    expect(sheet).toContain("footer={refusal ? (refusal.code === 'quoting_approval_unknown' ? <Btn full busy={busy} onClick={() => void recover()} data-testid=\"mm-approval-recover\">");
    expect(sheet).toContain(': <Btn full busy={busy} disabled={!ack || ap.locked} onClick={() => void approve()} data-testid="mm-approval-approve">');   // NEXT W1: nor while an approval's outcome is unread
    expect(sheet).toContain("post<{ adopted: string[]; revoked: string[]; pending: string[] }>('/mm/recover', {})");
    // the two prompts, in order: the signer's request, then the binding; both only inside approve(), which the refused sheet cannot call
    const a = sheet.indexOf('startAuthentication({ optionsJSON: sheet.signer.options'), b = sheet.indexOf('startAuthentication({ optionsJSON: sheet.binding.options'), c = sheet.indexOf('post(`/mandates/${sheet.mandateId}/approve`, { assertion, bindingAssertion, acknowledged: true })');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b);
    expect((panel.match(/startAuthentication\(/g) ?? []).length).toBe(2);
    // the agent page itself still approves nothing (apps/web/test/agents-v11.test.ts): the prompts live in this chunk only
    expect(agentPanel).not.toMatch(/startAuthentication|mandate\/approve/);
  });
  it('the approval body: the enforced-by table row by row and unedited, the four hashes, the acknowledgement text', () => {
    const table = '| field | enforced by |\n|---|---|\n| `maxOrderNotionalUsd` | **signer**. size × max(price, the signer\'s mid) of each quote |\n| term: `deadManSeconds` | **signer**. armed at most this far ahead |\n| section: `engine.policy` | **API only**. the quoting rule the engine runs (spread_inventory) |';
    const rows = tableRows(table);
    expect(rows.map((r) => [r.header, r.cells.length])).toEqual([[true, 2], [false, 2], [false, 2], [false, 2]]);
    expect(rows[3]!.cells).toEqual(['section: `engine.policy`', '**API only**. the quoting rule the engine runs (spread_inventory)']);
    expect(rows.map((r) => r.raw)).toEqual(table.split('\n').filter((l) => !/^\|-/.test(l)));        // every row of the server, none rewritten
    const ap: QuotingApproval = { kind: 'quoting', mandateId: MANDATE, mandate: { label: 'MM BTC' }, hash: '1'.repeat(64), quoting: { hash: '2'.repeat(64), maxima: { 'terms.levelsPerSide': '5', 'engine.maxSessionLossUsd': '5000' }, table },
      signer: { shape: 'SPW-VENUE-QUOTING-MANDATE-v1', hash: '3'.repeat(64), acknowledgement: { text: 'I understand that the signer signs quotes for this agent without asking me.', sha256: '5'.repeat(64) }, options: {} }, binding: { hash: '4'.repeat(64), options: {} },
      hashes: { tradingMandate: '1'.repeat(64), quotingSection: '2'.repeat(64), signerMandate: '3'.repeat(64), approvalIntent: '4'.repeat(64) }, note: 'two passkey prompts.' };
    const html = render(h(ApprovalBody, { sheet: ap }));
    expect((html.match(/data-testid="mm-approval-row"/g) ?? []).length).toBe(4);
    for (const r of rows) for (const c of r.cells) expect(text(html), c).toContain(c);
    expect(['trading', 'section', 'signer', 'intent'].map((k) => inner(html, `mm-hash-${k}`))).toEqual(['1', '2', '3', '4'].map((x) => x.repeat(64)));
    expect(inner(html, 'mm-approval-ack-text')).toBe('I understand that the signer signs quotes for this agent without asking me.');
    expect(text(html)).toContain('two passkey prompts.');
    expect(html.indexOf('mm-approval-hashes')).toBeLessThan(html.indexOf('mm-approval-table')); expect(html.indexOf('mm-approval-table')).toBeLessThan(html.indexOf('mm-approval-ack-text'));
  });
});

describe('the session now', () => {
  it('PAPER is labelled SIMULATED on the session, on its result, on past sessions and on the section itself', () => {
    const html = render(h(SessionNow, { s: session(), tab: 'paper' }));
    expect(tag(html, 'mm-session')).toContain('data-simulated="true"');
    expect((html.match(/data-testid="mm-simulated"/g) ?? []).length).toBeGreaterThanOrEqual(2);       // next to the phase, and on the session result
    expect(text(html)).toContain('SIMULATED'); expect(text(from(html, 'mm-session-label', 'mm-position'))).toContain('PAPER — SIMULATED fills on real books');
    expect(text(render(h(SessionNow, { s: session(), tab: 'paper' }), 'fr'))).toContain('SIMULÉ');
    expect(render(h(PastSessions, { sessions: [session({ state: 'stopped', endReason: 'the agent was stopped', endedAt: 1_800_000_100_000 })], tab: 'paper' }))).toContain('data-testid="mm-simulated"');
    // the section: a tag in its heading and a persistent sentence, whatever the session
    expect(panel).toContain("<Section title={t('mmTitle')} right={<ModeMark mode={tab} />}>");
    expect(panel).toContain("{tab === 'paper' ? <Notice tone=\"info\"><span data-testid=\"mm-paper-note\">{t('mmPaperNote')}</span></Notice>");
    const note = /mmPaperNote: \['([^']*)',\s*'([^']*)'\]/.exec(i18n)!;
    expect(note[1]).toMatch(/^SIMULÉ/); expect(note[2]).toMatch(/^SIMULATED/); expect(note[2]).toMatch(/not a real track record/); expect(note[2]).toMatch(/never added to those of the Live tab/);
    // a live session carries no simulated mark
    const live = render(h(SessionNow, { s: session({ mode: 'live', simulated: false, label: 'LIVE — mainnet' }), tab: 'live' }));
    expect(live).not.toContain('data-testid="mm-simulated"'); expect(live).toContain('data-testid="mm-live-tag"');
  });
  it('quotes: side, price, size, state, age and distance from the mid in bps; inventory in base and in USD', () => {
    const html = render(h(SessionNow, { s: session(), tab: 'paper' }));
    expect((html.match(/data-testid="mm-quote"/g) ?? []).length).toBe(2);
    const q = text(from(html, 'mm-quotes', 'mm-breakers'));
    expect(q).toContain('Bid · 102990'); expect(q).toContain('Ask · 103011'); expect(q).toContain('resting');
    expect(q).toContain('0.00048 BTC · age 1.5 s · 1.02 bps from the mid'); expect(q).toContain('age 1 min 1 s');
    expect([ageText(250), ageText(1500), ageText(61_000)]).toEqual(['250 ms', '1.5 s', '1 min 1 s']);
    expect(text(from(html, 'mm-position', 'mm-position-usd'))).toContain('Inventory (BTC) 0.0004'); expect(text(from(html, 'mm-position-usd', 'mm-quotes'))).toContain('41.2 USD');
    expect(tag(html, 'mm-session')).toContain('data-phase="quoting"');
  });
  it('the data-gap hold: no quote, the phase and the reason of the engine, the active breaker and its events', () => {
    const s = session(); s.status = { ...s.status, phase: 'pulled', reason: 'data_stale: no book for 6 s', quotes: [], activeBreakers: ['data_stale'], halted: null };
    const html = render(h(SessionNow, { s, tab: 'paper' }));
    expect(html).toContain('data-testid="mm-no-quotes"'); expect(text(from(html, 'mm-phase', 'mm-session-label'))).toContain('pulled');
    expect(text(from(html, 'mm-reason', 'mm-position'))).toContain('Reason: data_stale: no book for 6 s');
    expect(text(from(html, 'mm-breakers', 'mm-refusals'))).toMatch(/Active breakers data_stale .*Breaker events of the session \(1\).*data_stale.*pull/);
    const halted = session(); halted.status = { ...halted.status, phase: 'halted', halted: 'drawdown_session', lock: 'mm_mainnet_disabled' };
    const hh = render(h(SessionNow, { s: halted, tab: 'live' }));
    expect(text(from(hh, 'mm-halted', 'mm-session-label'))).toContain('Halted · drawdown_session'); expect(inner(hh, 'mm-session-lock')).toBe('mm_mainnet_disabled');
  });
  it('the dead man\'s switch: armed until HH:MM:SS, "N of the venue\'s 10; the signer stops at 8"', () => {
    const sw = { deadline: Date.UTC(2026, 10, 16, 3, 7, 9), armed: true, lapsesToday: 3, venueTriggersPerDay: 10, signerStopsAt: 8 };
    expect(switchFacts(sw)).toEqual({ armed: true, until: '03:07:09', used: 3, of: 10, stopsAt: 8, atStop: false });
    expect(hmsUtc(Date.UTC(2026, 0, 1, 23, 59, 58))).toBe('23:59:58');
    const html = render(h(SwitchLine, { sw }));
    expect(text(html)).toBe('Armed until 03:07:09 UTC Triggers used today: 3 of the venue’s 10; the signer stops at 8.');
    expect(text(render(h(SwitchLine, { sw }), 'fr'))).toBe('Armé jusqu’à 03:07:09 UTC Déclenchements utilisés aujourd’hui : 3 sur les 10 de la plateforme ; le signataire s’arrête à 8.');
    const stop = render(h(SwitchLine, { sw: { ...sw, armed: false, deadline: null, lapsesToday: 8 } }));
    expect(text(stop)).toContain('Not armed'); expect(text(stop)).toContain('8 of the venue’s 10'); expect(tag(stop, 'mm-switch-triggers')).toContain('text-danger');
    expect([switchFacts(null), render(h(SwitchLine, { sw: undefined }))]).toEqual([null, '']);
    expect(text(render(h(SessionNow, { s: session({ mode: 'live', simulated: false }), tab: 'live' })))).toContain('Triggers used today: 3 of the venue’s 10; the signer stops at 8.');
  });
  it('refusals by code, the rate budget against 1 200, the address requests remaining, the stream', () => {
    const html = render(h(SessionNow, { s: session(), tab: 'paper' }));
    expect(text(from(html, 'mm-refusals', 'mm-budget'))).toMatch(/signer_quote_too_close 2 post_only_would_cross 1/);
    const b = text(from(html, 'mm-budget', 'mm-stream'));
    expect(b).toMatch(/Weight, last minute 84 \/ 1,200/); expect(b).toMatch(/Peak per minute 140/); expect(b).toMatch(/Address requests remaining 9,876/); expect(b).toContain('orders 24 · cancels 20 · heartbeats 6');
    expect(text(from(html, 'mm-stream', 'mm-session-pnl'))).toContain('Not applicable in paper mode');
    const live = session({ mode: 'live', simulated: false }); live.status = { ...live.status, stream: { status: 'connected', synced: true, streamOrders: 40, streamFills: 3, audits: 2, divergences: 0, gaps: 1, lastAuditAt: null } };
    expect(text(from(render(h(SessionNow, { s: live, tab: 'live' })), 'mm-stream', 'mm-session-pnl'))).toMatch(/Status connected · in sync .*orders 40 · fills 3 · audits 2 · divergences 0 · gaps 1/);
  });
});

describe('pull and flatten', () => {
  it('are enabled whenever there is something to act on — a lock, a halt or an unfinished checklist never disables them', () => {
    const locked = session({ mode: 'live', simulated: false }); locked.status = { ...locked.status, phase: 'halted', halted: 'drawdown_day', lock: 'mm_mainnet_disabled', activeBreakers: ['kill_switch'] };
    expect(commandState({ mode: 'LIVE', session: locked }, 'live')).toEqual({ pull: true, flatten: true, resume: true });
    expect(commandState({ mode: 'LIVE', session: null }, 'live')).toEqual({ pull: true, flatten: true, resume: false });        // the agent is live, its worker died: the API acts itself
    expect(commandState({ mode: 'PAPER', session: session({ mode: 'live', state: 'abandoned' }) }, 'live')).toMatchObject({ pull: true, flatten: true });
    expect(commandState({ mode: 'PAPER', session: session() }, 'paper')).toEqual({ pull: true, flatten: true, resume: true });
    expect(commandState({ mode: 'PAPER', session: null }, 'paper')).toEqual({ pull: false, flatten: false, resume: false });
    const src = lib.slice(lib.indexOf('export function commandState'), lib.indexOf('// ------------------------------------------------------------------------------------------------------------------ refusals'));
    expect(src.length).toBeGreaterThan(100); expect(src).not.toMatch(/lock|halted|goLive|ready|breaker/i);                     // the rule reads the session and the agent's mode, nothing else
  });
  it('rendered under a lock and a halt: both buttons are live, flatten asks to confirm, and one line says why they always work', () => {
    const locked = session({ mode: 'live', simulated: false }); locked.status = { ...locked.status, phase: 'halted', halted: 'drawdown_day', lock: 'mm_mainnet_disabled' };
    const on = { pull: () => {}, flatten: () => {}, confirm: () => {}, cancel: () => {}, resume: () => {} };
    const html = render(h(CommandBar, { view: { mode: 'LIVE', session: locked }, tab: 'live', busy: '', confirming: false, note: '', refusal: null, on }));
    expect(tag(html, 'mm-pull')).not.toMatch(/\sdisabled=""/); expect(tag(html, 'mm-flatten')).not.toMatch(/\sdisabled=""/);
    expect(text(html)).toContain('Pull quotes now'); expect(text(html)).toContain('Flatten (reduce-only)'); expect(text(html)).toContain('Resume');
    expect(inner(html, 'mm-commands-note')).toBe('Pull and flatten work under every lock and every halt: cancelling and reducing are never blocked.');
    expect(html).not.toContain('data-testid="mm-flatten-confirm"');
    expect(render(h(CommandBar, { view: { mode: 'LIVE', session: locked }, tab: 'live', busy: '', confirming: true, note: '', refusal: null, on }))).toContain('data-testid="mm-flatten-confirm"');
    expect(panel).toContain("flatten: () => setConfirming(true), confirm: () => void send('flatten')");                        // the request goes out on the confirmation only
    expect(panel).toContain('post<{ taken: string; note?: string }>(`/mm/agents/${id}/command`, { command })');
    const idle = render(h(CommandBar, { view: { mode: 'PAPER', session: null }, tab: 'paper', busy: '', confirming: false, note: '', refusal: null, on }));
    expect(tag(idle, 'mm-pull')).toMatch(/\sdisabled=""/);
  });
});

describe('fills, markouts, attribution', () => {
  const fills: MmFills = { mode: 'paper', simulated: true, fills: [
    { id: '2', side: 'sell', price: '103011', size: '0.00048', fee: '0.0074', maker: true, reduce: false, mid: '103000', ts: 1_800_000_040_000, markoutsBps: { '1s': '-0.4700', '10s': null, '60s': null }, markoutsDone: false },
    { id: '1', side: 'buy', price: '102990', size: '0.00048', fee: '0.0074', maker: true, reduce: false, mid: '103000', ts: 1_800_000_020_000, markoutsBps: { '1s': '0.9700', '10s': '-0.9200', '60s': null }, markoutsDone: true }] };
  it('a markout is the server\'s figure, "pending" until computed, a dash when the tape had no mid', () => {
    expect([markoutCell('-0.47', false), markoutCell(null, false), markoutCell(null, true), markoutCell(undefined, false)]).toEqual([{ kind: 'value', text: '-0.47' }, { kind: 'pending', text: '' }, { kind: 'none', text: '—' }, { kind: 'pending', text: '' }]);
    const html = render(h(FillsTable, { data: fills }));
    expect(tag(html, 'mm-fills')).toContain('data-mode="paper"'); expect(tag(html, 'mm-fills')).toContain('data-simulated="true"');
    expect((html.match(/data-markout="pending"/g) ?? []).length).toBe(2); expect((html.match(/data-markout="none"/g) ?? []).length).toBe(1); expect((html.match(/data-markout="value"/g) ?? []).length).toBe(3);
    expect(text(html)).toMatch(/Markout 1s \(bps\) Markout 10s \(bps\) Markout 60s \(bps\)/); expect(text(html)).toMatch(/Sell 103011 0.00048 0.0074 -0.4700 pending pending/); expect(text(html)).toMatch(/Buy 102990 0.00048 0.0074 0.9700 -0.9200 —/);
    expect(render(h(FillsTable, { data: { ...fills, fills: [] } }))).toContain('data-testid="mm-no-fills"');
  });
  it('attribution: spread capture, inventory, fees, funding, total, bps of volume and the markout means — of ONE mode, negatives in red, no gain colour', () => {
    const p: MmPerformance = { mode: 'paper', label: 'PAPER — SIMULATED fills on real books (a fill only when the market trades through the quote); no money moved', sessions: 2, fills: 36, volumeUsd: '683',
      attribution: { totalUsd: '-0.125', spreadCaptureUsd: '0.086', inventoryPnlUsd: '-0.108', feesUsd: '-0.102', fundingUsd: '0', bpsOfVolume: '-1.83' }, markouts: [{ horizon: '1s', fills: 36, meanBps: '-0.47' }, { horizon: '10s', fills: 36, meanBps: '-0.92' }, { horizon: '60s', fills: 30, meanBps: null }], note: 'attribution: total = spread capture + inventory PnL + fees + funding (exact).' };
    const html = render(h(Attribution, { p })), w = text(html);
    expect(tag(html, 'mm-attribution')).toContain('data-mode="paper"'); expect(inner(html, 'mm-attribution-label')).toContain('PAPER — SIMULATED');
    for (const s of ['Spread capture 0.086 USD', 'Inventory -0.108 USD', 'Fees -0.102 USD', 'Funding 0 USD', 'Total -0.125 USD', 'Bps of volume -1.83 bps', 'Mean markout 1s -0.47 bps', 'Mean markout 10s -0.92 bps', 'Mean markout 60s —', '2 sessions · 36 fills · volume 683 USD.']) expect(w, s).toContain(s);
    expect((html.match(/text-danger/g) ?? []).length).toBe(6); expect(html).not.toMatch(/text-emerald/);
    expect(panel).not.toMatch(/tone=\{?["']ok["']\}?[^>]*value=\{usd/);
  });
});

describe('Risk and Monitor', () => {
  const rows = [{ id: MANDATE, kind: 'quoting', label: 'MM BTC', principal: { kind: 'agent', id: AGENT }, state: 'active', phase: 'active', notAfter: 1_800_000_000_000, integrity: { ok: true, reason: null } },
    { id: 'd1', kind: 'directional', label: 'Momentum', principal: { kind: 'agent', id: 'x' }, state: 'active', phase: 'active', notAfter: 1, integrity: null },
    { id: 'q2', kind: 'quoting', label: 'MM ETH', principal: { kind: 'agent', id: 'y' }, state: 'pending_signer', phase: 'not_approved', notAfter: 1_800_000_000_000, integrity: null }];
  it('the Risk block lists the quoting mandates only, with state, expiry, integrity, revoke and the way to the agent\'s go-live flow', () => {
    expect(quotingMandates(rows).map((m) => m.id)).toEqual([MANDATE, 'q2']);
    expect([canRevoke({ state: 'active' }), canRevoke({ state: 'revoked' }), canApprove({ state: 'pending_signer' }), canApprove({ state: 'active' })]).toEqual([true, false, true, false]);
    expect(goLivePath(AGENT)).toBe(`/agents/${AGENT}?mm=live`);
    const html = render(h(QuotingMandatesBlock, { mandates: rows, onChanged: () => {} }));
    expect(html).toContain(`data-testid="mm-risk-mandate-${MANDATE}"`); expect(html).not.toContain('Momentum');
    expect(tag(html, `mm-risk-golive-${MANDATE}`)).toContain(`href="/agents/${AGENT}?mm=live"`);
    expect(html).toContain(`data-testid="mm-risk-revoke-${MANDATE}"`); expect(html).not.toContain(`data-testid="mm-risk-review-${MANDATE}"`); expect(html).toContain('data-testid="mm-risk-review-q2"');
    const w = text(html);
    expect(w).toContain('Quoting mandate (market making)'); expect(w).toContain(`agent:${AGENT}`); expect(w).toContain('active · active'); expect(w).toContain('matches the approval'); expect(w).toContain('not approved yet');
    expect(text(render(h(QuotingMandatesBlock, { mandates: [rows[1]!], onChanged: () => {} })))).toContain('No quoting mandate.');
  });
  it('Risk.tsx: the block is loaded lazily, and a quoting mandate is never approved through the directional sheet', () => {
    expect(risk).toContain("const QuotingMandatesBlock = lazy(() => import('./mmPanel').then((m) => ({ default: m.QuotingMandatesBlock })));");
    expect(risk).toContain('<Suspense fallback={null}><QuotingMandatesBlock mandates={mandates} onChanged={refresh} /></Suspense>');
    expect(risk).toContain("(m as { kind?: string }).kind !== 'quoting' && <Btn busy={busy === `prep-${m.id}`}");
    expect(risk).not.toMatch(/from '\.\/mmPanel'|from '\.\.\/mm'/);
  });
  it('Monitor: the two capability lines of market making read their label from the mm block', () => {
    expect([capKey('deriv_mm_mainnet'), capKey('deriv_mm_testnet'), capKey('deriv_live_mainnet')]).toEqual(['mmCap_deriv_mm_mainnet', 'mmCap_deriv_mm_testnet', 'hdCap_deriv_live_mainnet']);
    expect(monitor).toContain("t((c.id.startsWith('deriv_mm_') ? `mmCap_${c.id}` : `hdCap_${c.id}`) as Key)");
    expect(/mmCap_deriv_mm_mainnet: \['([^']*)', '([^']*)'\]/.exec(i18n)!.slice(1)).toEqual(['Tenue de marché réelle (Hyperliquid, mainnet)', 'Live market making (Hyperliquid, mainnet)']);
    expect(/mmCap_deriv_mm_testnet: \['([^']*)', '([^']*)'\]/.exec(i18n)!.slice(1)).toEqual(['Tenue de marché réelle (Hyperliquid, testnet)', 'Live market making (Hyperliquid, testnet)']);
  });
});

describe('chunks: the first chunk does not grow', () => {
  it('mmPanel is reached through lazy imports of the Agents and Risk chunks only; the shell and the eager screens do not know it', () => {
    expect(agentPanel).toContain("const MmSection = lazy(() => import('./mmPanel').then((m) => ({ default: m.MmSection })));");
    expect(agentPanel).toContain('{isMm && <Suspense fallback={<SkeletonCard lines={4} />}><MmSection id={id}');
    expect(agentPanel).toContain("const isMm = q.data?.family === 'market_making'");
    expect(agentPanel).not.toMatch(/from '\.\/mmPanel'|from '\.\.\/mm'/);
    const app = read('../src/App.tsx'), ui = read('../src/ui.tsx'), main = read('../src/main.tsx');
    expect(app + ui + main).not.toMatch(/mmPanel|['"]\.\/mm['"]/);
    for (const f of ['Home.tsx', 'Asset.tsx', 'Markets.tsx', 'Futures.tsx', 'Settings.tsx', 'Monitor.tsx']) { let src = ''; try { src = read(`../src/screens/${f}`); } catch { /* not a screen of this app */ } expect(src, f).not.toMatch(/mmPanel|from '\.\.\/mm'/); }
    expect(panel).not.toMatch(/from '\.\/agentPanel'|from '\.\/Agents'|from '\.\/Risk'/);            // the chunk stands alone: Risk does not pull the Agents chunk through it
    expect(lib).not.toMatch(/from 'react'|\.tsx'/);
  });
});

describe('i18n: the mm block', () => {
  const a = i18n.indexOf('// >>> v11 market making'), b = i18n.indexOf('// <<< end of the `mm` block');
  const block = i18n.slice(a, b);
  const keys = new Map([...block.matchAll(/\b(mm[A-Z][A-Za-z0-9_]*): \[\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)].map((m) => [m[1]!, [m[2]!, m[3]!] as const]));
  it('is one contiguous block right after the ag2 block; every key has a non-empty French and English text', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(i18n.slice(i18n.indexOf('// <<< end of the `ag2` block'), a).trim()).toBe('// <<< end of the `ag2` block');
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bmm[A-Z][A-Za-z0-9_]*: \[/g)).toBeNull();
    expect(keys.size).toBe((block.match(/\bmm[A-Z][A-Za-z0-9_]*: \[/g) ?? []).length);
    expect(keys.size).toBeGreaterThan(200);
    for (const [k, [fr, en]] of keys) { expect(fr.length, k).toBeGreaterThan(0); expect(en.length, k).toBeGreaterThan(0); }
    // only `mm` keys live in the block
    expect((block.match(/^\s{2}([a-zA-Z0-9_]+): \[/gm) ?? []).every((l) => /^\s{2}mm[A-Z]/.test(l))).toBe(true);
  });
  it('every key the screens use exists — static keys and the steps, fields, groups, checks, states and actions built at run time', () => {
    const used = new Set([...(panel + lib).matchAll(/'(mm[A-Z][A-Za-z0-9_]+)'/g)].map((m) => m[1]!).filter((k) => !k.endsWith('_')));
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    const dynamic = [...STEP_ORDER.map(stepKey), ...TESTNET_CHECKS.map(testnetCheckKey), ...FIELDS.map((f) => fieldKey(f.key)), ...GROUPS.map(groupKey), ...['engine', 'queued', 'direct', 'nothing'].map((x) => `mmTaken_${x}`),
      ...['running', 'stopped', 'abandoned'].map((x) => `mmState_${x}`), ...['pull', 'flatten', 'halt'].map((x) => `mmAct_${x}`), capKey('deriv_mm_mainnet'), capKey('deriv_mm_testnet')];
    for (const k of dynamic) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
  });
  it('no key of the block is unused, and no text carries an emoji or a promise of gain', () => {
    const src = panel + lib, prefixes = ['mmStep_', 'mmTn_', 'mmF_', 'mmG_', 'mmTaken_', 'mmState_', 'mmAct_', 'mmCap_'];
    for (const k of keys.keys()) expect(prefixes.some((p) => k.startsWith(p)) || src.includes(`'${k}'`), `unused: ${k}`).toBe(true);
    for (const [k, [fr, en]] of keys) {
      expect(`${fr}${en}`, k).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      if (/\b(profits?|gains?|rentab\w*|earn\w*)\b/i.test(`${fr} ${en}`)) expect(`${fr} ${en}`, k).toMatch(/NÉGATIF|NEGATIVE/);                 // the word appears only to deny it
    }
    const sw = keys.get('mmSwitchTriggers')!; expect(sw[1]).toBe('Triggers used today: {n} of the venue’s {of}; the signer stops at {stop}.');
    expect(keys.get('mmSimulated')).toEqual(['SIMULÉ', 'SIMULATED']);
    expect(keys.get('mmPull')![1]).toBe('Pull quotes now'); expect(keys.get('mmFlatten')![1]).toBe('Flatten (reduce-only)'); expect(keys.get('mmResume')![1]).toBe('Resume');
  });
});
