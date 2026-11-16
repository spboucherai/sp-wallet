// V11 — the laboratory's results as DATA, and the version-3 perp report on the TypeScript side. No database, no network, no
// laboratory process: the committed files of research/results/2026-11-15-v11 are read as they are.
//   1. lab-verdicts.ts: every figure comes from summary.json / manifest.json / the reports; a missing file is `available: false`.
//   2. templatesView: each template carries the results of ITS strategies, references and studies.
//   3. perp reports: version 2 stays readable, version 3 needs engine parity, the summary surfaces the v3 sections.
//   4. generic perp universes: bounds, and live capability decided by the AGENT's instruments.
import './agent-env.ts';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-db.ts';

const LAB = path.join(REPO_ROOT, 'research'), RUN = '2026-11-15-v11', DIR = path.join(LAB, 'results', RUN);
const summary = JSON.parse(readFileSync(path.join(DIR, 'summary.json'), 'utf8')) as { n_trials: number; rows: any[] };
const report = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
let lv: typeof import('../src/agents/lab-verdicts.ts'), ps: typeof import('../src/agents/perp-strategies.ts'), pr: typeof import('../src/agents/perp-routes.ts'), tp: typeof import('../src/agents/templates.ts');

beforeAll(async () => {
  process.env.SPW_RESEARCH_DIR = LAB; delete process.env.SPW_LAB_RESULTS_RUN;
  lv = await import('../src/agents/lab-verdicts.ts'); ps = await import('../src/agents/perp-strategies.ts'); pr = await import('../src/agents/perp-routes.ts'); tp = await import('../src/agents/templates.ts');
});

describe('lab verdicts — read from the committed summary, nothing written in TypeScript', () => {
  it('the run: seven strategy versions, their figures equal to the file\'s, the file hashes equal to the run\'s manifest', () => {
    const r = lv.labRun(LAB, RUN);
    expect(r).toMatchObject({ available: true, reason: null, run: RUN, dir: `research/results/${RUN}`, trials: summary.n_trials });
    expect(r.summary).toEqual({ file: 'summary.json', sha256: createHash('sha256').update(readFileSync(path.join(DIR, 'summary.json'))).digest('hex'), matchesManifest: true });
    expect(r.strategies.map((s) => s.strategy)).toEqual(summary.rows.map((x) => x.strategy));
    expect(r.strategies.length).toBe(7);
    for (const s of r.strategies) {
      const row = summary.rows.find((x) => x.strategy === s.strategy)!;
      // every figure is the file's
      expect(s.deflatedSharpe, s.strategy).toBe(row.deflated_sharpe);
      expect([s.trialsTested, s.ownTrials, s.sha256, s.symbols]).toEqual([row.trials_tested, row.own_trials, row.sha256, row.symbols]);
      for (const k of lv.SPLITS) {
        expect(s.splits[k]).toMatchObject({ netReturn: row[k].return_net, netSharpe: row[k].sharpe_net, grossSharpe: row[k].sharpe_gross, maxDrawdown: row[k].max_drawdown, trades: row[k].trades });
        expect(s.splits[k]!.stop?.code ?? null, `${s.strategy} ${k}`).toBe(row[k].stop?.code ?? null);
        expect(s.splits[k]!.grossToNet).toMatchObject({ pricePnl: row[k].gross_to_net.price_pnl, funding: row[k].gross_to_net.funding, fees: row[k].gross_to_net.trading_fees, slippage: row[k].gross_to_net.slippage, latency: row[k].gross_to_net.latency, netPnl: row[k].gross_to_net.net_pnl });
      }
      expect(s.stoppedSplits).toEqual(lv.SPLITS.filter((k) => row[k].stop));
      // the laboratory's finding, asserted on the FILE's numbers: no version of this run comes near significance
      expect(row.deflated_sharpe, s.strategy).toBeLessThanOrEqual(0.10);
      expect(s.deflatedSharpe!).toBeLessThanOrEqual(0.10); expect(s.significant).toBe(false); expect(s.deflatedSharpeThreshold).toBe(0.95);
      // the report of the version: data window, splits, hashes — and it is the file the manifest lists
      const rep = report(`${s.name}-${s.version}.json`);
      expect(s.window).toEqual({ start: rep.config.start, end: rep.config.end, interval: rep.config.interval, bars: rep.config.bars });
      expect(s.splitDates).toEqual(rep.splits); expect(s.dataSha256).toBe(rep.journal.data.sha256); expect(s.codeSha256).toBe(rep.journal.code.code_sha256); expect(s.engineParityApplied).toBe(true);
      expect(s.results).toMatchObject({ dir: `research/results/${RUN}`, file: `${s.name}-${s.version}.json`, matchesManifest: true }); expect(s.results.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.installedHashMatches, `${s.strategy}: the installed strategy.py is the backtested one`).toBe(true);
    }
  });

  it('scope and live capability: /2 on BTC, ETH, SOL is live-capable; the generic run is not; spot legs are backtest-only; two venues are research-only', () => {
    const by = Object.fromEntries(lv.labRun(LAB, RUN).strategies.map((s) => [s.strategy, s]));
    expect([by['momentum_xs_perp/2']!.scope, by['momentum_xs_perp/2']!.liveCapable, by['momentum_xs_perp/2']!.where]).toEqual(['agent', true, 'strategies']);
    expect([by['mean_reversion_bands_perp/2']!.scope, by['mean_reversion_bands_perp/2']!.liveCapable]).toEqual(['agent', true]);
    for (const k of ['momentum_xs_perp/1', 'mean_reversion_bands_perp/1', 'statarb_basket_perp/1']) expect([k, by[k]!.scope, by[k]!.liveCapable]).toEqual([k, 'agent', false]);
    expect([by['basis_cash_carry/1']!.scope, by['basis_cash_carry/1']!.liveCapable, by['basis_cash_carry/1']!.where]).toEqual(['backtest_only', false, 'strategies']);
    expect([by['funding_arb_cross_venue/1']!.scope, by['funding_arb_cross_venue/1']!.liveCapable, by['funding_arb_cross_venue/1']!.where]).toEqual(['research_only', false, 'strategies_xvenue']);
    // a split ended by the engine's own loss limit is said, with the file's reason
    expect(by['statarb_basket_perp/1']!.stoppedSplits).toEqual(['train', 'validation', 'test']);
    expect(by['statarb_basket_perp/1']!.splits.test!.stop).toMatchObject({ code: 'total_loss', reason: summary.rows.find((x) => x.strategy === 'statarb_basket_perp/1').test.stop.reason });
    expect(by['momentum_xs_perp/2']!.stoppedSplits).toEqual([]);
  });

  it('by name: `name` = every version, `name/version` = that one, once each; a name outside the run and a policy say so', () => {
    const got = lv.labVerdictsFor(['momentum_xs_perp/2', 'momentum_xs_perp/1', 'momentum_xs_perp', 'ts_momentum_perp'], [{ name: 'market_making_as', kind: 'study' }, { name: 'risk_supervisor', kind: 'policy' }], LAB, RUN);
    expect(got.map((v) => [v.available, v.kind, v.available && v.kind === 'strategy' ? v.strategy : v.name])).toEqual([[true, 'strategy', 'momentum_xs_perp/2'], [true, 'strategy', 'momentum_xs_perp/1'],
      [false, 'strategy', 'ts_momentum_perp'], [true, 'study', 'market_making_as'], [false, 'policy', 'risk_supervisor']]);
    const study = got[3]!; if (!(study.available && study.kind === 'study')) throw new Error('study');
    expect(study.statement).toBe(report('market_making_as.json').statement); expect(study.fillsAreModelled).toBe(true); expect(study.results.matchesManifest).toBeNull();   // the manifest lists the reports, not the studies
  });

  it('a missing file is `available: false` — no figure, no sentence; a changed file no longer matches the manifest', () => {
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-labv-')));
    try {
      expect(lv.labRun(tmp, RUN)).toMatchObject({ available: false, strategies: [], trials: null, summary: null });
      expect(lv.labVerdictsFor(['momentum_xs_perp/2', 'momentum_xs_perp'], [{ name: 'vol_forecast', kind: 'study' }], tmp, RUN).map((v) => [v.available, v.name])).toEqual([[false, 'momentum_xs_perp'], [false, 'vol_forecast']]);
      cpSync(DIR, path.join(tmp, 'results', RUN), { recursive: true });
      const s = JSON.parse(readFileSync(path.join(tmp, 'results', RUN, 'summary.json'), 'utf8')); s.rows[0].deflated_sharpe = 0.99;
      writeFileSync(path.join(tmp, 'results', RUN, 'summary.json'), JSON.stringify(s));
      const r = lv.labRun(tmp, RUN);
      expect(r.summary!.matchesManifest).toBe(false);                                                    // said, not hidden
      expect([r.strategies[0]!.deflatedSharpe, r.strategies[0]!.significant, r.strategies[0]!.where]).toEqual([0.99, true, null]);   // the figure is the file's; no strategy file in this directory
      writeFileSync(path.join(tmp, 'results', RUN, 'summary.json'), '{not json');
      expect(lv.labRun(tmp, RUN).available).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

const info = (name: string, version: string, universe: string[], extra: Record<string, unknown> = {}) => ({ path: `strategies/${name}/${version}`, sha256: 'a'.repeat(64), kind: 'perp' as const, spotLegs: universe.some((s) => s.endsWith('.SPOT')),
  generic: universe[0] === '*', minSymbols: universe[0] === '*' ? 3 : universe.length, maxSymbols: universe[0] === '*' ? 8 : universe.length,
  meta: { name, version, kind: 'perp' as const, universe, interval: '1h', lookback: 800, max_leverage: 1, max_gross_exposure: 1, params: {}, ...extra } });
const LIB = [info('basis_cash_carry', '1', ['BTC', 'ETH', 'SOL', 'BTC.SPOT', 'ETH.SPOT', 'SOL.SPOT']), info('mean_reversion_bands_perp', '1', ['*']), info('mean_reversion_bands_perp', '2', ['BTC', 'ETH', 'SOL']),
  info('momentum_xs_perp', '1', ['*']), info('momentum_xs_perp', '2', ['BTC', 'ETH', 'SOL']), info('statarb_basket_perp', '1', ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'HYPE']), info('ts_momentum_perp', '1', ['BTC', 'ETH'])];

describe('templates — bound by name to the installed laboratory strategies, each with the laboratory\'s results', () => {
  it('momentum and mean reversion bind /2 (BTC, ETH, SOL: live-capable) before the generic /1; stat-arb its basket; references and studies are never bound', async () => {
    const by = Object.fromEntries((await tp.templatesView(async () => LIB)).map((t) => [t.id, t]));
    expect(by.momentum!.installed.map((s) => [s.path, s.generic, s.liveCapable])).toEqual([['momentum_xs_perp/2', false, true], ['momentum_xs_perp/1', true, true], ['ts_momentum_perp/1', false, true]]);
    expect(by.momentum!.installed[1]).toMatchObject({ universe: ['*'], minSymbols: 3, maxSymbols: 8, defaultUniverse: ['BTC', 'ETH', 'SOL'], liveReason: null }); expect(by.momentum!.installed[1]!.liveCondition).toMatch(/ALL its instruments are among BTC, ETH, SOL/);
    expect(by.momentum!.installed[0]).toMatchObject({ generic: false, defaultUniverse: null, liveCondition: null });
    expect(by['mean-reversion']!.installed.map((s) => s.path)).toEqual(['mean_reversion_bands_perp/2', 'mean_reversion_bands_perp/1']);
    expect(by['stat-arb']!.installed.map((s) => [s.path, s.liveCapable])).toEqual([['statarb_basket_perp/1', false]]); expect(by['stat-arb']!.installed[0]!.liveReason).toMatch(/LINK, AAVE, HYPE/);
    // the spot-leg strategy and the cross-venue one: backtest / research references of the funding family, in no template's `installed`
    expect(by['funding-arb']!.labBacktest).toEqual({ wanted: ['funding_arb_cross_venue', 'basis_cash_carry'], installed: ['funding_arb_cross_venue', 'basis_cash_carry'], agentRunnable: false });
    for (const t of Object.values(by)) expect(t!.installed.map((s) => s.name).filter((n) => ['basis_cash_carry', 'funding_arb_cross_venue', 'market_making_as', 'cross_exchange_spread', 'vol_forecast', 'risk_supervisor'].includes(n)), t!.id).toEqual([]);
    expect(by['market-making']!.labStudies).toEqual([{ name: 'market_making_as', kind: 'study', installed: true }, { name: 'vol_forecast', kind: 'study', installed: true }]);
    expect(by['cross-exchange']!.labStudies).toEqual([{ name: 'cross_exchange_spread', kind: 'study', installed: true }]);
    expect(by['risk-manager']!.labStudies).toEqual([{ name: 'risk_supervisor', kind: 'policy', installed: true }, { name: 'vol_forecast', kind: 'study', installed: true }]);
  });

  it('labVerdicts: the template\'s own strategies, in its order, from the file — deflated Sharpe <= 0.10 for every one, /2 marked live-capable', async () => {
    const by = Object.fromEntries((await tp.templatesView(async () => LIB)).map((t) => [t.id, t]));
    const strat = (id: string) => by[id]!.labVerdicts.filter((v): v is import('../src/agents/lab-verdicts.ts').LabStrategyVerdict => v.available && v.kind === 'strategy');
    expect(strat('momentum').map((v) => [v.strategy, v.liveCapable, v.scope])).toEqual([['momentum_xs_perp/2', true, 'agent'], ['momentum_xs_perp/1', false, 'agent']]);
    expect(strat('mean-reversion').map((v) => [v.strategy, v.liveCapable])).toEqual([['mean_reversion_bands_perp/2', true], ['mean_reversion_bands_perp/1', false]]);
    expect(strat('stat-arb').map((v) => [v.strategy, v.stoppedSplits.length])).toEqual([['statarb_basket_perp/1', 3]]);
    expect(strat('funding-arb').map((v) => [v.strategy, v.scope])).toEqual([['funding_arb_cross_venue/1', 'research_only'], ['basis_cash_carry/1', 'backtest_only']]);
    const all = Object.values(by).flatMap((t) => t!.labVerdicts.filter((v) => v.available && v.kind === 'strategy')) as import('../src/agents/lab-verdicts.ts').LabStrategyVerdict[];
    expect(new Set(all.map((v) => v.strategy)).size).toBe(7);
    for (const v of all) { expect(v.deflatedSharpe!, v.strategy).toBeLessThanOrEqual(0.10); expect(v.backtest).toBe(true); expect(v.results.dir).toBe(`research/results/${RUN}`); }
    expect(by['market-making']!.labVerdicts.map((v) => [v.kind, v.name, v.available])).toEqual([['study', 'market_making_as', true], ['study', 'vol_forecast', true]]);
    expect(by['risk-manager']!.labVerdicts.map((v) => [v.kind, v.name, v.available])).toEqual([['policy', 'risk_supervisor', false], ['study', 'vol_forecast', true]]);
  });
});

describe('perp reports — version 2 stays readable, version 3 needs engine parity', () => {
  const v3 = () => report('momentum_xs_perp-2.json'), SHA = v3().strategy_sha256 as string, SYMS = ['BTC', 'ETH', 'SOL'];
  it('approvable: v2 as before; v3 only with engine_parity.applied === true; any other version is refused', () => {
    const v2 = { schema_version: 2, kind: 'perp', strategy_sha256: 'a'.repeat(64), config: { symbols: ['BTC'] }, checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass' } };
    expect(ps.perpReportProblem(v2, 'a'.repeat(64), ['BTC'])).toBeNull();                               // a report stored before V11
    expect(ps.perpReportProblem(v3(), SHA, SYMS)).toBeNull();                                           // the committed version-3 report
    expect(ps.perpReportProblem({ ...v3(), engine_parity: { ...v3().engine_parity, applied: false } }, SHA, SYMS)).toMatch(/WITHOUT engine parity/);
    expect(ps.perpReportProblem({ ...v3(), engine_parity: undefined }, SHA, SYMS)).toMatch(/WITHOUT engine parity/);
    expect(ps.perpReportProblem({ ...v3(), engine_parity: { applied: 'true' } }, SHA, SYMS)).toMatch(/WITHOUT engine parity/);
    for (const n of [1, 4, '3', undefined]) expect(ps.perpReportProblem({ ...v3(), schema_version: n }, SHA, SYMS), String(n)).toMatch(/version-2 or version-3/);
    expect(ps.perpReportProblem({ ...v3(), checks: { ...v3().checks, ledger: 'fail' } }, SHA, SYMS)).toMatch(/ledger/);
    expect([ps.isPerpReportVersion(2), ps.isPerpReportVersion(3), ps.isPerpReportVersion(1), ps.isPerpReportVersion('3')]).toEqual([true, true, false, false]);
  });

  it('summary of a v3 report: gross-to-net per split, execution model, engine parity with the stop of each split, data bias, journal', () => {
    const r = v3(), s = pr.perpReportSummary(r, SHA, SYMS)!;
    expect(s).toMatchObject({ schemaVersion: 3, problem: null, checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass' } });
    for (const k of ['train', 'validation', 'test']) expect(s.metrics[k]!.gross_to_net).toEqual(r.metrics[k].gross_to_net);
    const g = s.metrics.test!.gross_to_net as { price_pnl: number; funding: number; trading_fees: number; liquidation_penalties: number; slippage: number; latency: number; bad_debt_written_off: number; net_pnl: number };
    expect(g.price_pnl + g.funding - g.trading_fees - g.liquidation_penalties - g.slippage - g.latency - g.bad_debt_written_off).toBeCloseTo(g.net_pnl, 6);   // the lab's identity, on the file's numbers
    expect(s.executionModel).toEqual(r.execution_model); expect(s.engineParity).toEqual(r.engine_parity); expect(s.dataBias).toEqual(r.data_bias); expect(s.journal).toEqual(r.journal);
    expect(s.engineParity.applied).toBe(true); expect(s.engineParity.observed.test.stop).toBeNull();
    const stopped = report('statarb_basket_perp-1.json'), ss = pr.perpReportSummary(stopped, stopped.strategy_sha256, stopped.config.symbols)!;
    expect(ss.engineParity.observed.test.stop).toMatchObject({ code: 'total_loss' }); expect(ss.problem).toBeNull();
  });

  it('summary of a v2 report (an older database): the same fields as before, the v3 sections null', () => {
    const s = pr.perpReportSummary({ schema_version: 2, kind: 'perp', strategy_sha256: 'c'.repeat(64), config: { symbols: ['BTC'], start: '2026-04-16T20:00:00+00:00', end: '2026-11-11T03:00:00+00:00' },
      checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass', data_quality: 'pass', notes: [] }, metrics: { test: { total_return: -0.02, liquidations: 0 } }, robustness: { deflated_sharpe: 0.01, trials_tested: 9 } }, 'c'.repeat(64), ['BTC'])!;
    expect(s).toMatchObject({ schemaVersion: 2, historyDays: 208, problem: null, executionModel: null, engineParity: null, dataBias: null, journal: null });
    expect(s.metrics.test).toMatchObject({ total_return: -0.02, gross_to_net: null });
  });
});

describe('generic perp universes', () => {
  const generic = { spotLegs: false, meta: { name: 'g', version: '1', kind: 'perp' as const, universe: ['*'], min_symbols: 3, max_symbols: 12, interval: '1h', lookback: 10, max_leverage: 1, max_gross_exposure: 1, params: {} } };
  it('a generic strategy fits any instrument set within its bounds (never more than a perp agent can hold); a fixed one still needs its exact universe', () => {
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH', 'SOL'], '1h')).toEqual({ ok: true });
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH', 'LINK', 'HYPE'], '1h')).toEqual({ ok: true });
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH'], '1h')).toMatchObject({ ok: false, code: 'universe_size' });
    expect(ps.fitsPerpAgent(generic, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'], '1h')).toMatchObject({ ok: false, code: 'universe_size' });   // META says 12; a perp agent holds 8
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH', 'SOL'], '4h')).toMatchObject({ ok: false, code: 'interval_mismatch' });
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH', 'BTC.SPOT'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
    expect(ps.fitsPerpAgent(generic, ['BTC', 'ETH', 'BTC@EDGEX'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
    expect(ps.fitsPerpAgent({ ...generic, generic: true, minSymbols: 1, maxSymbols: 2 }, ['BTC', 'ETH', 'SOL'], '1h')).toMatchObject({ ok: false, code: 'universe_size' });
    const fixed = { ...generic, meta: { ...generic.meta, universe: ['BTC', 'ETH'] } };
    expect(ps.fitsPerpAgent(fixed, ['ETH', 'BTC'], '1h')).toEqual({ ok: true }); expect(ps.fitsPerpAgent(fixed, ['BTC', 'ETH', 'SOL'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
    expect([ps.isGenericPerp(['*']), ps.isGenericPerp(['*', 'BTC']), ps.isGenericPerp(['BTC'])]).toEqual([true, false, false]);
  });

  it('live capability of an agent on a generic strategy is decided by the AGENT\'s instruments', async () => {
    const { liveVerdict } = await import('../src/agent-runtime/model.ts');
    expect(liveVerdict('momentum', 'perp', ['BTC', 'ETH', 'SOL'])).toEqual({ capable: true });
    expect(liveVerdict('momentum', 'perp', ['BTC', 'ETH', 'LINK'])).toMatchObject({ capable: false, code: 'universe_not_pinned' });
  });
});
