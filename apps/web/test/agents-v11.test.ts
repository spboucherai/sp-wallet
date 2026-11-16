// V11 Agents panel — component-level checks, as the repository does for its other screens (pure helpers + source conventions):
// one mode per request and per view, backtests labelled backtest, a template without its strategy cannot be created, a family
// that cannot go live says why, state / mode tags, and the `ag2` block of i18n.ts (contiguous, two languages, no missing key).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionsOf, BACKTEST_KEYS, createBody, createProblem, emptyDraft, FAMILY_KEY, fmtPerf, isBacktestLabel, LIFE_TAG, liveBlock, MODE_TAG, ORDER_TONE, PERF_FIELDS, PERF_TAB, perfRows, PERP_RISK_KEYS, riskKey, riskUnit, scopedUrl, timelineState,
  venuesNeeded, type Perf, type Template } from '../src/screens/agentPanel';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');
const panel = read('../src/screens/agentPanel.tsx'), agents = read('../src/screens/Agents.tsx'), i18n = read('../src/i18n.ts');
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
    const used = new Set([...(panel + agents).matchAll(/'(ag2[A-Za-z0-9]+)'/g)].map((m) => m[1]!));
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    const dynamic = [
      ...['momentum', 'mean_reversion', 'stat_arb', 'funding_arb', 'market_making', 'cross_exchange', 'risk_manager', 'custom'].map(FAMILY_KEY),
      ...[...PERP_RISK_KEYS, 'maxPositionUsd', 'maxGrossUsd', 'maxDataAgeMs', 'maxAgentDrawdownPct', 'maxPortfolioDailyLossPct', 'minLiquidationDistanceBps', 'maxFundingBleedBpsPerDay', 'killSwitchDailyLossPct',
        'maxExposurePct', 'maxLossPct', 'maxOrderUsd', 'maxDailyUsd', 'maxOrdersPerDay', 'mandateDays'].map(riskKey),
      ...['not_installed', 'strategy', 'venues', 'base', 'capital', 'risk'].map((x) => `ag2Problem_${x}`),
      ...['signal', 'decision', 'order', 'fill', 'error', 'risk', 'mandate', 'state', 'proposal', 'hold', 'stop', 'other'].map((x) => `ag2Ty_${x}`),
      ...['queued', 'running', 'done', 'failed'].map((x) => `ag2Job_${x}`),
      ...Object.values(LIFE_TAG).map((x) => x.key), ...Object.values(MODE_TAG).map((x) => x.key), ...PERF_FIELDS.map((f) => f.key), ...Object.values(BACKTEST_KEYS), ...Object.values(PERF_TAB)];
    for (const k of dynamic) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
  });
  it('no key of the block is unused', () => {
    const src = panel + agents;
    const prefixes = ['ag2Fam_', 'ag2R_', 'ag2Problem_', 'ag2Ty_', 'ag2Job_'];
    for (const k of keys.keys()) expect(prefixes.some((p) => k.startsWith(p)) || src.includes(`'${k}'`), `unused: ${k}`).toBe(true);
  });
});
