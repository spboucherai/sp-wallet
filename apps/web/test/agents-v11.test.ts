/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/agents-v11.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// V11 Agents panel — component-level checks, as the repository does for its other screens (pure helpers + source conventions):
// one mode per request and per view, backtests labelled backtest, a template without its strategy cannot be created, a family
// that cannot go live says why, state / mode tags, and the `ag2` block of i18n.ts (contiguous, two languages, no missing key).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionsOf, BACKTEST_KEYS, createBody, createProblem, emptyDraft, FAMILY_KEY, fmtPerf, isBacktestLabel, LIFE_TAG, liveBlock, MODE_TAG, ORDER_TONE, PERF_FIELDS, PERF_TAB, perfRows, PERP_RISK_KEYS, riskKey, riskUnit, scopedUrl, timelineState,
  parseUniverse, venuesNeeded, type Perf, type Template } from '../src/screens/agentPanel';
import { edgeKey, grossToNetRows, GTN_ORDER, gtnKey, isStrategyVerdict, isStudyVerdict, scopeKey, shortHash, splitKey, SPLITS, stopOfSplit, v3Sections, type LabStrategyVerdict, type LabVerdict } from '../src/screens/labReport';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');
const panel = read('../src/screens/agentPanel.tsx'), agents = read('../src/screens/Agents.tsx'), i18n = read('../src/i18n.ts');
const lab = read('../src/screens/labReport.tsx'), perpPage = read('../src/screens/PerpAgent.tsx');
const ONE = 'mode réel indisponible : une seule plateforme autorise l\'exécution sous mandat';
const n = (value: number | null, reason: string | null = null) => ({ value, reason });
const perf = (mode: Perf['mode']): Perf => ({ mode, label: mode === 'paper' ? 'PAPER — simulated' : 'LIVE — real', points: 3, from: 1, to: 3, equityCurve: [{ ts: 1, equity: 100 }, { ts: 2, equity: 101 }], totalReturn: n(0.01), volatility: n(0.2), sharpe: n(1.234),
  sortino: n(null, 'no negative return'), maxDrawdown: n(0.05), winRate: n(null, 'no closed trade'), profitFactor: n(null, 'no closed trade'), turnover: n(2), feesUsd: n(1.5), fundingUsd: n(-0.25), slippageUsd: n(null, 'not recorded'), netPnlUsd: n(1), closedTrades: 0, orders: 4, warnings: [] });
const tpl = (o: Partial<Template>): Template => ({ id: 'momentum', family: 'momentum', engine: 'bar', kind: 'perp', name: { fr: 'Momentum', en: 'Momentum' }, summary: { fr: 's', en: 's' }, modes: ['research', 'paper', 'live'], liveReason: null, strategyNames: ['momentum_xs_perp'],
  installed: [{ path: 'ts_momentum_perp/1', name: 'ts_momentum_perp', version: '1', sha256: 'a'.repeat(64), universe: ['BTC', 'ETH', 'SOL', 'HYPE'], interval: '1h', liveCapable: false, liveReason: 'HYPE is not pinned' }], strategyInstalled: true, rule: null,
  labBacktest: { wanted: [], installed: [] }, defaults: { universe: ['BTC', 'ETH', 'SOL'], venues: ['hyperliquid'], interval: '1h', capitalUsdc: '1000', config: {}, risk: { maxLeverage: 2, maxDailyLossPct: 3 } }, ...o });

describe('one mode per request and per view', () => {
  it('every mode-scoped read names exactly one mode', () => {
    for (const what of ['performance', 'orders', 'signals', 'journal', 'timeline'] as const) for (const mode of ['research', 'paper', 'live'] as const) {
      const u = scopedUrl('id1', what, mode, 50);
      expect(u.match(/mode=/g)).toHaveLength(1);
      expect(u).toBe(`/agents/id1/${what}?mode=${mode}&limit=50`);
    }
  });
  it('the panel reads those five routes through scopedUrl only, and never asks the API for two modes', () => {
    for (const what of ['performance', 'orders', 'signals', 'journal', 'timeline']) expect(panel.includes(`/${what}\``) || panel.includes(`/${what}'`), what).toBe(false);   // no hand-built URL without a mode
    expect(panel).not.toMatch(/mode=(paper|live)[^`']*mode=/);
    expect(panel).not.toMatch(/equityCurve[^;]*concat/);
    // the performance view is keyed by its mode: switching tab unmounts one curve and mounts the other
    expect(panel).toContain('<PerfView key={view} id={id} mode={view} />');
    expect(panel).toContain("queryKey: ['ag2-perf', id, mode]");
  });
  it('the stat rows of an answer all carry that answer\'s mode; a null figure keeps its reason and shows a dash', () => {
    const p = perfRows(perf('paper')), l = perfRows(perf('live'));
    expect(p).toHaveLength(PERF_FIELDS.length);
    expect(new Set(p.map((r) => r.mode))).toEqual(new Set(['paper']));
    expect(new Set(l.map((r) => r.mode))).toEqual(new Set(['live']));
    const sortino = p.find((r) => r.key === 'ag2PfSortino')!;
    expect([sortino.value, sortino.reason, fmtPerf(sortino, 'en')]).toEqual([null, 'no negative return', '—']);
    expect(fmtPerf(p.find((r) => r.key === 'ag2PfReturn')!, 'en')).toBe('1 %');
    expect(fmtPerf(p.find((r) => r.key === 'ag2PfSharpe')!, 'en')).toBe('1.23');
    expect(PERF_TAB).toEqual({ paper: 'ag2TabPaper', live: 'ag2TabLive' });
  });
});

describe('backtests are labelled backtest, never performance', () => {
  it('title, tag and note are the backtest keys; the card is outside the performance section', () => {
    expect(BACKTEST_KEYS).toEqual({ title: 'ag2BtTitle', tag: 'ag2BtTag', note: 'ag2BtNote' });
    expect(isBacktestLabel('backtest')).toBe(true); expect(isBacktestLabel('performance')).toBe(false); expect(isBacktestLabel(undefined)).toBe(false);
    const card = panel.slice(panel.indexOf('function BacktestCard'), panel.indexOf('// ------------------------------------------------------------------------------------------------------------------ mandate request'));
    expect(card).toContain('BACKTEST_KEYS.title'); expect(card).toContain('BACKTEST_KEYS.tag');
    expect(card).not.toMatch(/ag2Performance|ag2EqPaper|ag2EqLive|EquityCard/);
    expect(panel.indexOf('<BacktestCard')).toBeLessThan(panel.indexOf("<Section title={t('ag2Performance')}>"));
    const fr = /ag2BtTag: \['([^']*)', '([^']*)'\]/.exec(i18n)!;
    expect(fr[1]).toMatch(/Backtest/); expect(fr[1]).toMatch(/pas une performance/); expect(fr[2]).toMatch(/not performance/);
  });
});

describe('creation from a template', () => {
  it('a template whose strategy is not installed can never be submitted', () => {
    const t = tpl({ strategyInstalled: false, installed: [] }), d = { ...emptyDraft(t), name: 'Momentum agent' };
    expect(createProblem(t, d)).toBe('not_installed');
    expect(panel).toContain('disabled={!x.strategyInstalled}');
    expect(panel).toContain('disabled={problem !== null}');
  });
  it('bar: the strategy is one of the installed ones; the body carries the path, the capital and numeric limits', () => {
    const t = tpl({}), d = { ...emptyDraft(t), name: '  Momo  ' };
    expect(createProblem(t, d)).toBeNull();
    expect(createProblem(t, { ...d, strategyPath: 'other/1' })).toBe('strategy');
    expect(createProblem(t, { ...d, name: 'x' })).toBe('name');
    expect(createProblem(t, { ...d, capital: '10' })).toBe('capital');
    expect(createProblem(t, { ...d, risk: { ...d.risk, maxLeverage: '' } })).toBe('risk');
    expect(createBody(t, d)).toEqual({ template: 'momentum', name: 'Momo', mission: '', strategyPath: 'ts_momentum_perp/1', capitalUsdc: '1000', risk: { maxLeverage: 2, maxDailyLossPct: 3 } });
    // audit D1: the refusal is written on the strategy BEFORE anything is approved
    expect(panel).toContain('{!s.liveCapable && s.liveReason &&');
  });
  it('stream: one base asset and the right number of different venues', () => {
    const mm = tpl({ id: 'market-making', family: 'market_making', engine: 'stream', kind: 'stream', installed: [], rule: { name: 'spread_inventory', version: '1', sha256: 'b'.repeat(64) }, modes: ['research', 'paper'], liveReason: 'no live', defaults: { ...tpl({}).defaults, universe: ['BTC'], venues: ['hyperliquid'] } });
    const cx = tpl({ ...mm, id: 'cross-exchange', family: 'cross_exchange', rule: { name: 'net_spread', version: '1', sha256: 'c'.repeat(64) }, liveReason: ONE, defaults: { ...mm.defaults, venues: ['hyperliquid', 'edgex'] } });
    expect([venuesNeeded(mm), venuesNeeded(cx), venuesNeeded(tpl({}))]).toEqual([1, 2, 0]);
    const d = { ...emptyDraft(cx), name: 'Cross' };
    expect(createProblem(cx, d)).toBeNull();
    expect(createProblem(cx, { ...d, venues: ['hyperliquid'] })).toBe('venues');
    expect(createProblem(cx, { ...d, venues: ['hyperliquid', 'hyperliquid'] })).toBe('venues');
    expect(createProblem(cx, { ...d, base: 'b' })).toBe('base');
    expect(createBody(cx, d)).toMatchObject({ template: 'cross-exchange', universe: ['BTC'], venues: ['hyperliquid', 'edgex'], capitalUsdc: '1000' });
    expect(createBody(cx, d)).not.toHaveProperty('strategyPath');
  });
});

describe('generic universe (a laboratory strategy on [\'*\'])', () => {
  const g = tpl({ installed: [{ path: 'momentum_xs_perp/2', name: 'momentum_xs_perp', version: '2', sha256: 'b'.repeat(64), universe: ['BTC', 'ETH', 'SOL'], interval: '1h', liveCapable: true, liveReason: null, generic: false },
    { path: 'momentum_xs_perp/1', name: 'momentum_xs_perp', version: '1', sha256: 'c'.repeat(64), universe: ['*'], interval: '1h', liveCapable: true, liveReason: null, generic: true, minSymbols: 3, maxSymbols: 8, defaultUniverse: ['BTC', 'ETH', 'SOL'], liveCondition: 'only if ALL pinned' }] });
  it('the fixed /2 is proposed first and sends no universe; the generic /1 sends the agent\'s instruments, within its bounds', () => {
    const d = { ...emptyDraft(g), name: 'Momo' };
    expect([d.strategyPath, d.universe]).toEqual(['momentum_xs_perp/2', 'BTC ETH SOL']);
    expect(createProblem(g, d)).toBeNull(); expect(createBody(g, d)).not.toHaveProperty('universe');
    const d1 = { ...d, strategyPath: 'momentum_xs_perp/1' };
    expect(createProblem(g, d1)).toBeNull(); expect(createBody(g, d1)).toMatchObject({ strategyPath: 'momentum_xs_perp/1', universe: ['BTC', 'ETH', 'SOL'] });
    expect(createBody(g, { ...d1, universe: 'btc, eth  link,hype btc' })).toMatchObject({ universe: ['BTC', 'ETH', 'LINK', 'HYPE'] });
    expect(createProblem(g, { ...d1, universe: 'BTC ETH' })).toBe('universe');                                // fewer than min_symbols
    expect(createProblem(g, { ...d1, universe: 'A1 A2 A3 A4 A5 A6 A7 A8 A9' })).toBe('universe');             // more than a perp agent holds
    expect(createProblem(g, { ...d1, universe: '' })).toBe('universe');
    expect(parseUniverse(' sol,SOL btc ')).toEqual(['SOL', 'BTC']);
    // the condition for going live is written on the generic strategy, in the server's words
    expect(panel).toContain('{s.generic && s.liveCondition &&'); expect(panel).toContain('data-testid="ag2-generic-universe"');
    expect(perpPage).toContain('x.generic ? nInst >= x.minSymbols && nInst <= x.maxSymbols');
  });
});

describe('the laboratory\'s results — BACKTEST, out of sample, never performance', () => {
  const split = (o: Partial<LabStrategyVerdict['splits']['test'] & object> = {}) => ({ netReturn: -0.002, netSharpe: -0.16, grossSharpe: 1.15, maxDrawdown: 0.0366, trades: 92, stop: null,
    grossToNet: { pricePnl: 10.66, funding: -2.55, fees: 4.43, liquidationPenalties: 0, slippage: 0.66, latency: 5.01, netPnl: -1.99 }, ...o });
  const verdict = (o: Partial<LabStrategyVerdict> = {}): LabStrategyVerdict => ({ available: true, kind: 'strategy', backtest: true, name: 'momentum_xs_perp', version: '2', strategy: 'momentum_xs_perp/2', sha256: 'a'.repeat(64), symbols: ['BTC', 'ETH', 'SOL'],
    where: 'strategies', installedHashMatches: true, scope: 'agent', liveCapable: true, deflatedSharpe: 0.074, deflatedSharpeThreshold: 0.95, significant: false, trialsTested: 31, ownTrials: 4, testSharpeCi: [-5.6, 5.4],
    splits: { train: split(), validation: split(), test: split() }, stoppedSplits: [], checks: { lookahead: 'pass' }, window: { start: '2026-05-19T00:00:00+00:00', end: '2026-11-14T23:00:00+00:00', interval: '1h', bars: 4320 },
    splitDates: { test: ['2026-10-10T00:00:00+00:00', '2026-11-14T23:00:00+00:00'] }, dataSha256: 'd'.repeat(64), codeSha256: 'e'.repeat(64), engineParityApplied: true,
    results: { dir: 'research/results/2026-11-15-v11', file: 'momentum_xs_perp-2.json', fileSha256: 'f'.repeat(64), matchesManifest: true }, ...o });
  it('gross to net: price → funding → fees → slippage → latency → net, costs shown negative, both shapes of the block', () => {
    const rows = grossToNetRows(verdict().splits.test!.grossToNet)!;
    expect(rows.map((r) => r.line)).toEqual(['price', 'funding', 'fees', 'slippage', 'latency', 'net']);
    expect(rows.map((r) => r.value)).toEqual([10.66, -2.55, -4.43, -0.66, -5.01, -1.99]);
    expect(rows.slice(0, -1).reduce((x, r) => x + r.value!, 0)).toBeCloseTo(rows.at(-1)!.value!, 2);          // the lines add up to the net
    // the report's own snake_case block (metrics.<split>.gross_to_net); liquidation penalties appear only when there are any
    const rep = grossToNetRows({ price_pnl: 6.15, funding: -0.38, trading_fees: 37.63, liquidation_penalties: 2, slippage: 8.94, latency: 60.85, bad_debt_written_off: 0, net_pnl: -103.65 })!;
    expect(rep.map((r) => [r.line, r.value])).toEqual([['price', 6.15], ['funding', -0.38], ['fees', -37.63], ['slippage', -8.94], ['latency', -60.85], ['liquidation', -2], ['net', -103.65]]);
    expect([grossToNetRows(null), grossToNetRows(undefined), grossToNetRows({})]).toEqual([null, null, null]);   // a version-2 report has no such block
    expect([...GTN_ORDER]).toEqual(['price', 'funding', 'fees', 'slippage', 'latency', 'liquidation', 'net']);
    expect(grossToNetRows({ price_pnl: 1, funding: 0, trading_fees: 0, slippage: 0, latency: 0, net_pnl: 1 })!.every((r) => !Object.is(r.value, -0))).toBe(true);
  });
  it('a result says what it is: live-capable universe, paper only, backtest only, research only — and no edge unless the lab\'s own threshold is passed', () => {
    expect(scopeKey(verdict())).toBe('ag2LabScope_live');
    expect(scopeKey(verdict({ liveCapable: false }))).toBe('ag2LabScope_paper');
    expect(scopeKey(verdict({ scope: 'backtest_only', liveCapable: false }))).toBe('ag2LabScope_backtest');
    expect(scopeKey(verdict({ scope: 'research_only', liveCapable: true }))).toBe('ag2LabScope_research');     // never "live" outside the agent path
    expect([edgeKey(verdict()), edgeKey(verdict({ significant: true })), edgeKey(verdict({ significant: null }))]).toEqual(['ag2LabEdgeNo', 'ag2LabEdgeYes', 'ag2LabEdgeUnknown']);
    const list: LabVerdict[] = [verdict(), { available: false, kind: 'strategy', name: 'ts_momentum_perp', reason: 'not part of the run' },
      { available: true, kind: 'study', backtest: false, name: 'market_making_as', statement: 'MODEL STUDY', assumptions: [], fillsAreModelled: true, results: { dir: 'd', file: 'f', fileSha256: 'a', matchesManifest: null } }, { available: false, kind: 'policy', name: 'risk_supervisor', reason: 'no file' }];
    expect([list.filter(isStrategyVerdict).length, list.filter(isStudyVerdict).length]).toEqual([1, 1]);
    expect([splitKey('train'), splitKey('validation'), splitKey('test'), gtnKey('latency')]).toEqual(['ag2V3Split_train', 'ag2V3Split_validation', 'ag2V3Split_test', 'ag2V3L_latency']);
    expect([shortHash('a'.repeat(64)), shortHash(null)]).toEqual([`${'a'.repeat(12)}…`, '—']);
  });
  it('the template cards and the creation form show the lab\'s result under a BACKTEST tag, with the stop of each split; no result is written in the screen', () => {
    expect(panel).toContain('<LabVerdicts verdicts={x.labVerdicts} />');                                      // next to each template
    expect(panel).toContain('<LabVerdicts verdicts={tp.labVerdicts} detail />');
    expect(lab).toContain('data-testid="ag2-lab" data-label="backtest"'); expect(lab).toContain("testid=\"ag2-lab-tag\">{t('ag2LabTag')}");
    expect(lab).toContain('v.stoppedSplits.map('); expect(lab).toContain("t('ag2LabStopped', { split: t(splitKey(split)), reason: stop.reason })");
    const tag = /ag2LabTag: \['([^']*)', '([^']*)'\]/.exec(i18n)!, stopped = /ag2LabStopped: \['([^']*)', '([^']*)'\]/.exec(i18n)!;
    expect(tag[1]).toMatch(/BACKTEST/); expect(tag[1]).toMatch(/hors échantillon/); expect(tag[2]).toMatch(/BACKTEST/); expect(tag[2]).toMatch(/out of sample/);
    expect(stopped[2]).toMatch(/Stopped by the engine’s loss limit/); expect(stopped[1]).toMatch(/limite de perte du moteur/);
    // nothing of the run is hard-coded: no strategy name of the lab, no figure of its summary
    expect(lab + panel).not.toMatch(/momentum_xs_perp|mean_reversion_bands_perp|statarb_basket_perp|basis_cash_carry|funding_arb_cross_venue|0\.074|0\.099/);
    expect(lab).not.toMatch(/ag2Performance|ag2EqPaper|ag2EqLive|EquityCard/);                               // a backtest never borrows the performance view
  });
  it('a version-3 report: its sections are found, the split the engine stopped is named; a version-2 report has none and stays readable', () => {
    const v3 = { schemaVersion: 3, metrics: { train: { gross_to_net: { price_pnl: 1, funding: 0, trading_fees: 1, slippage: 0, latency: 0, net_pnl: 0 } }, validation: null, test: { gross_to_net: { price_pnl: 6, funding: 0, trading_fees: 30, slippage: 9, latency: 60, net_pnl: -93 } } },
      executionModel: { latency: { model: 'adverse_bound', latency_s: 60 } }, dataBias: { survivorship: { statement: 's' } }, journal: { seed: 0 },
      engineParity: { applied: true, observed: { train: { stop: null }, validation: { stop: null }, test: { stop: { code: 'total_loss', reason: 'total loss limit reached (10 % of the capital)', ts: '2026-11-04T16:00:00+00:00', equity: 899 } } } } };
    expect(v3Sections(v3)).toEqual({ v3: true, grossToNet: true, executionModel: true, engineParity: true, parityApplied: true, dataBias: true, journal: true });
    expect(stopOfSplit(v3, 'test')).toEqual({ code: 'total_loss', reason: 'total loss limit reached (10 % of the capital)', ts: '2026-11-04T16:00:00+00:00' });
    expect([stopOfSplit(v3, 'train'), stopOfSplit(null, 'test'), stopOfSplit({ engineParity: null }, 'test')]).toEqual([null, null, null]);
    expect(v3Sections({ ...v3, engineParity: { applied: false } }).parityApplied).toBe(false);
    const v2 = { schemaVersion: 2, metrics: { test: { total_return: -0.02 } }, executionModel: null, engineParity: null, dataBias: null, journal: null };
    expect(v3Sections(v2)).toEqual({ v3: false, grossToNet: false, executionModel: false, engineParity: false, parityApplied: false, dataBias: false, journal: false });
    expect(v3Sections(null).v3).toBe(false); expect([...SPLITS]).toEqual(['train', 'validation', 'test']);
    // the perp agent page and the panel's backtest card render them, inside the backtest label
    expect(perpPage).toContain('<ReportV3 summary={s} />'); expect(perpPage).toContain('const st = stopOfSplit(s, k); return st ?');
    const card = panel.slice(panel.indexOf('function BacktestCard'), panel.indexOf('// ------------------------------------------------------------------------------------------------------------------ mandate request'));
    expect(card).toContain('<ReportV3 summary={summaryOf(v)} />');
    for (const id of ['ag2-v3" data-label="backtest"', 'ag2-v3-gtn', 'ag2-v3-parity', 'ag2-v3-exec', 'ag2-v3-bias', 'ag2-v3-journal', 'ag2-v3-old', 'ag2-v3-tag']) expect(lab, id).toContain(id);
  });
  it('the new screen is in the lazily loaded Agents chunk only: the app shell does not import it', () => {
    const app = read('../src/App.tsx'), ui = read('../src/ui.tsx');
    expect(app + ui).not.toMatch(/labReport/);
    expect(app).toContain("agents: () => import('./screens/Agents')");
    for (const f of ['Home.tsx', 'Asset.tsx']) { let src = ''; try { src = read(`../src/screens/${f}`); } catch { /* not a screen of this app */ } expect(src, f).not.toMatch(/labReport|agentPanel/); }
  });
});

describe('live', () => {
  it('a family that cannot go live shows the server\'s sentence, verbatim; a bar agent off the pinned set shows its own reason', () => {
    expect(liveBlock({ modes: ['research', 'paper'], liveReason: ONE })).toBe(ONE);
    expect(liveBlock({ familyModes: { modes: ['research', 'paper'], liveReason: ONE }, live: { capable: false, reason: 'x' } })).toBe(ONE);
    expect(liveBlock({ familyModes: { modes: ['research', 'paper', 'live'], liveReason: null }, live: { capable: false, reason: 'HYPE is not pinned' } })).toBe('HYPE is not pinned');
    expect(liveBlock({ familyModes: { modes: ['research', 'paper', 'live'], liveReason: null }, live: { capable: true, reason: null } })).toBeNull();
    expect(panel.match(/data-testid="ag2-live-reason"/g)!.length).toBeGreaterThanOrEqual(3);                 // template card, creation form, panel / mandate sheet
    // nothing in the panel approves a mandate: it only reads the draft and links to the approval surface
    expect(panel).not.toMatch(/mandate\/approve|live\/approve|startAuthentication/);
    expect(panel).toContain('/mandate-draft?locale=');
    expect(panel).toContain('href={d.approval.route}');
  });
  it('actions follow the life cycle; a spot agent paused from LIVE resumes only through a new mandate (D9)', () => {
    const fm = { modes: ['research', 'paper', 'live'] as const };
    const base = { kind: 'spot', phase: 'PAUSED', familyModes: { modes: [...fm.modes], liveReason: null } };
    expect(actionsOf({ ...base, state: 'paused', mode: 'live', pausedFrom: 'LIVE' })).toMatchObject({ resume: false, resumeNeedsMandate: true, stop: true, pause: false });
    expect(actionsOf({ ...base, kind: 'perp', state: 'paused', mode: 'live', pausedFrom: null })).toMatchObject({ resume: true, resumeNeedsMandate: false });
    expect(actionsOf({ ...base, phase: 'PAPER_TRADING', state: 'active', mode: 'paper', pausedFrom: null })).toMatchObject({ pause: true, stop: true, paper: false, research: false, live: true });
    expect(actionsOf({ ...base, phase: 'STOPPED', state: 'stopped', mode: 'paper', pausedFrom: null })).toMatchObject({ pause: false, stop: false, paper: true, research: true });
    expect(actionsOf({ ...base, phase: 'STOPPING', state: 'active', mode: 'live', pausedFrom: null })).toMatchObject({ pause: false, live: false });
    expect(panel).toContain("code === 'mandate_required') setSheet('mandate')");
  });
});

describe('tags and mappings', () => {
  it('three life-cycle tags and three mode tags, each with its own tone, icon and text', () => {
    expect(Object.keys(LIFE_TAG)).toEqual(['active', 'paused', 'stopped']);
    expect(Object.keys(MODE_TAG)).toEqual(['research', 'paper', 'live']);
    expect(new Set(Object.values(MODE_TAG).map((x) => x.tone)).size).toBe(3);
    expect(new Set(Object.values(MODE_TAG).map((x) => x.icon)).size).toBe(3);
    expect(new Set(Object.values(LIFE_TAG).map((x) => x.tone)).size).toBe(3);
  });
  it('timeline items and order states', () => {
    expect(timelineState({ severity: 'error', type: 'order' })).toBe('failed');
    expect(timelineState({ severity: 'info', type: 'error' })).toBe('failed');
    expect(timelineState({ severity: 'warning', type: 'risk' })).toBe('current');
    expect(timelineState({ severity: 'info', type: 'hold' })).toBe('current');
    for (const type of ['signal', 'decision', 'order', 'fill']) expect(timelineState({ severity: 'info', type })).toBe('done');
    expect(timelineState({ severity: 'info', type: 'research' })).toBe('next');
    expect([ORDER_TONE.FILLED, ORDER_TONE.REJECTED, ORDER_TONE.FAILED, ORDER_TONE.UNKNOWN, ORDER_TONE.CANCELLED]).toEqual(['ok', 'danger', 'danger', 'warn', 'mute']);
    expect([riskUnit('maxLeverage'), riskUnit('maxDailyLossPct'), riskUnit('maxGrossUsd'), riskUnit('slippageBps'), riskUnit('unknown')]).toEqual(['×', '%', 'USD', 'bps', '']);
  });
  it('the two routes the app did not call before are wired (audit D14)', () => {
    expect(panel).toContain('`/agents/${id}/withdrawals`');
    expect(panel).toContain('`/agents/${o.id}/perp/risk`');
    expect(agents).toContain('ag2-open-panel'); expect(agents).toContain('ag2-from-template');
  });
});

describe('i18n: the ag2 block', () => {
  const a = i18n.indexOf('// >>> v11 Agents panel'), b = i18n.indexOf('// <<< end of the `ag2` block');
  const block = i18n.slice(a, b);
  const keys = new Map([...block.matchAll(/\b(ag2[A-Za-z0-9_]*): \[\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)].map((m) => [m[1]!, [m[2]!, m[3]!] as const]));
  it('is one contiguous block; every key has a non-empty French and English text', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bag2[A-Za-z0-9_]*: \[/g)).toBeNull();
    expect(keys.size).toBe((block.match(/\bag2[A-Za-z0-9_]*: \[/g) ?? []).length);
    expect(keys.size).toBeGreaterThan(150);
    for (const [k, [fr, en]] of keys) { expect(fr.length, k).toBeGreaterThan(0); expect(en.length, k).toBeGreaterThan(0); }
  });
  it('every key the screens use exists — static keys and the families, limits, problems, timeline types and job states built at run time', () => {
    const used = new Set([...(panel + agents + lab).matchAll(/'(ag2[A-Za-z0-9_]+)'/g)].map((m) => m[1]!).filter((k) => !k.endsWith('_')));
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    const dynamic = [
      ...['momentum', 'mean_reversion', 'stat_arb', 'funding_arb', 'market_making', 'cross_exchange', 'risk_manager', 'custom'].map(FAMILY_KEY),
      ...[...PERP_RISK_KEYS, 'maxPositionUsd', 'maxGrossUsd', 'maxDataAgeMs', 'maxAgentDrawdownPct', 'maxPortfolioDailyLossPct', 'minLiquidationDistanceBps', 'maxFundingBleedBpsPerDay', 'killSwitchDailyLossPct',
        'maxExposurePct', 'maxLossPct', 'maxOrderUsd', 'maxDailyUsd', 'maxOrdersPerDay', 'mandateDays'].map(riskKey),
      ...['not_installed', 'strategy', 'universe', 'venues', 'base', 'capital', 'risk'].map((x) => `ag2Problem_${x}`),
      ...SPLITS.map(splitKey), ...GTN_ORDER.map(gtnKey), ...['live', 'paper', 'backtest', 'research'].map((x) => `ag2LabScope_${x}`), 'ag2LabEdgeNo', 'ag2LabEdgeYes', 'ag2LabEdgeUnknown',
      ...['signal', 'decision', 'order', 'fill', 'error', 'risk', 'mandate', 'state', 'proposal', 'hold', 'stop', 'other'].map((x) => `ag2Ty_${x}`),
      ...['queued', 'running', 'done', 'failed'].map((x) => `ag2Job_${x}`),
      ...Object.values(LIFE_TAG).map((x) => x.key), ...Object.values(MODE_TAG).map((x) => x.key), ...PERF_FIELDS.map((f) => f.key), ...Object.values(BACKTEST_KEYS), ...Object.values(PERF_TAB)];
    for (const k of dynamic) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
  });
  it('no key of the block is unused', () => {
    const src = panel + agents + lab;
    const prefixes = ['ag2Fam_', 'ag2R_', 'ag2Problem_', 'ag2Ty_', 'ag2Job_', 'ag2V3Split_', 'ag2V3L_'];
    for (const k of keys.keys()) expect(prefixes.some((p) => k.startsWith(p)) || src.includes(`'${k}'`), `unused: ${k}`).toBe(true);
  });
});
