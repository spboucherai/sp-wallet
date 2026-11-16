// V11 Dashboard panels — the pure helpers (dashboard.ts), the rendered panels for a readable answer / a failed section / the
// loading state (rendered to a string: no browser), and the `v11Db` keys of i18n.ts (two languages, every key used, every used
// key present). The books are never added: the test greps the screen for an addition across modes.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { bookEmpty, bpsToFraction, ERROR_CODES, errKey, liquidationNear, nearestLiquidation, quoteIds, riskLevel, systemLevel, type Book, type BookPosition, type Summary } from '../src/dashboard.ts';
import { I18n } from '../src/i18n.ts';
import { DashboardPanels } from '../src/screens/Dashboard.tsx';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const i18n = read('../src/i18n.ts'), screen = read('../src/screens/Dashboard.tsx'), pure = read('../src/dashboard.ts');

const pos = (o: Partial<BookPosition> = {}): BookPosition => ({ venue: 'hyperliquid', accountId: 'a1', asset: 'BTC', instrument: 'hyperliquid:BTC', side: 'long', size: '0.02', markPrice: '50000', notional: '1000', leverage: '3',
  liquidationPrice: '34000', liquidationDistanceBps: '3200', unrealizedPnl: '-1.5', ...o });
const book = (o: Partial<Book> = {}): Book => ({ book: 'paper', ts: 1, equity: '10000', grossExposure: '1000', leverage: '0.1', byAsset: [{ asset: 'BTC', long: '1000', short: '0', net: '1000' }], byVenue: [{ venue: 'hyperliquid', gross: '1000' }],
  collateral: [{ venue: 'hyperliquid', accountId: 'a1', equity: '10000', collateral: '10000', freeCollateral: '9666', marginUsed: '334', shareBps: '10000' }], positions: [pos()], errors: [],
  pnl: { realizedToday: '-0.45', unrealizedToday: '-1.5', realizedInception: '12.3', unrealizedInception: '-1.5' }, ...o });
const empty = (b: string): Book => book({ book: b, equity: '0', grossExposure: '0', leverage: null, byAsset: [], byVenue: [], collateral: [], positions: [], pnl: { realizedToday: '0', unrealizedToday: '0', realizedInception: '0', unrealizedInception: '0' } });
const ok = <T,>(data: T) => ({ ok: true as const, data, asOf: 1 });
const summary = (o: Partial<Summary> = {}): Summary => ({ ts: Date.now(), books: { paper: ok(book()), live: ok(empty('live-mainnet')), liveTestnet: ok(empty('live-testnet')) },
  risk: ok({ switches: { killSwitch: { on: false, at: null, reason: null }, readOnly: { on: false, at: null, reason: null } }, live: { missing: ['maxOrderNotional', 'maxDailyLoss'], missingForAutomation: ['maxOrderNotional', 'maxDailyLoss'], ownerOrdersRefused: true, automationOrdersRefused: true } }),
  agents: ok({ count: 3, total: { active: 2, paused: 1, stopped: 0 }, byMode: { research: { active: 0, paused: 0, stopped: 0 }, paper: { active: 2, paused: 0, stopped: 0 }, live: { active: 0, paused: 1, stopped: 0 } } }),
  agentsPnl: ok({ tz: 'America/Toronto', note: 'flows_included', today: { research: { abs: null, agents: 0, partial: false, reason: 'research_no_pnl' }, paper: { abs: 12.5, agents: 2, partial: false, reason: null }, live: { abs: null, agents: 0, partial: false, reason: 'no_snapshot' } } }),
  health: ok({ signer: { reachable: true, halted: false }, connectors: { total: 9, ok: 7, notMeasured: 2, failing: [] }, loops: { total: 4, late: [] } }),
  audit: ok({ checkedAt: 1, total: 42, intact: true, brokenAt: null }), ...o });

function render(s: Summary | null, locale: 'fr' | 'en' = 'fr'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (s) qc.setQueryData(['dashboard', 'summary'], s);
  return renderToString(createElement(QueryClientProvider, { client: qc }, createElement(I18n.Provider, { value: { locale, setLocale: () => {} } }, createElement(DashboardPanels, { nav: () => {} }))));
}

describe('dashboard.ts — pure helpers', () => {
  it('the nearest liquidation is the smallest distance among positions that have one', () => {
    expect(nearestLiquidation([])).toBeNull();
    expect(nearestLiquidation([pos({ liquidationDistanceBps: null })])).toBeNull();
    expect(nearestLiquidation([pos({ instrument: 'hyperliquid:BTC', liquidationDistanceBps: '3200' }), pos({ instrument: 'hyperliquid:ETH', liquidationDistanceBps: '850' }), pos({ instrument: 'gmx:SOL', liquidationDistanceBps: null })])?.instrument).toBe('hyperliquid:ETH');
    expect(liquidationNear('850')).toBe(true); expect(liquidationNear('1000')).toBe(false); expect(liquidationNear(null)).toBe(false);
    expect(bpsToFraction('1250')).toBe('0.125000');
  });
  it('an unknown reason code reads as the generic sentence; known codes have their own', () => {
    for (const c of ERROR_CODES) expect(errKey(c)).toBe(`v11DbErr_${c}`);
    expect(errKey('ECONNRESET at 10.0.0.1')).toBe('v11DbErr_other'); expect(errKey(null)).toBe('v11DbErr_other');
  });
  it('risk leads with the kill switch, then read-only, then missing live limits', () => {
    const sw = (k: boolean, r: boolean) => ({ killSwitch: { on: k, at: null, reason: null }, readOnly: { on: r, at: null, reason: null } }), set = { missing: [], missingForAutomation: [], ownerOrdersRefused: false, automationOrdersRefused: false };
    expect(riskLevel({ switches: sw(true, true), live: set })).toBe('halted');
    expect(riskLevel({ switches: sw(false, true), live: set })).toBe('read_only');
    expect(riskLevel({ switches: sw(false, false), live: { ...set, automationOrdersRefused: true } })).toBe('limits_missing');
    expect(riskLevel({ switches: sw(false, false), live: set })).toBe('ok');
  });
  it('system status: signer unreachable or broken chain is down; a failing connector, a late loop or an unreadable source is degraded', () => {
    const s = summary();
    expect(systemLevel(s.health, s.audit)).toBe('ok');
    expect(systemLevel(ok({ ...(s.health as { data: any }).data, signer: { reachable: false, halted: null } }), s.audit)).toBe('down');
    expect(systemLevel(s.health, ok({ checkedAt: 1, total: 42, intact: false, brokenAt: 7 }))).toBe('down');
    expect(systemLevel(ok({ ...(s.health as { data: any }).data, loops: { total: 4, late: ['orders'] } }), s.audit)).toBe('degraded');
    expect(systemLevel({ ok: false, error: { code: 'timeout', message: '' } }, s.audit)).toBe('degraded');
  });
  it('quote ids: the instruments of the readable books, once each', () => {
    const s = summary({ books: { paper: ok(book({ positions: [pos(), pos({ instrument: 'hyperliquid:ETH' })] })), live: ok(book({ positions: [pos()] })), liveTestnet: { ok: false, error: { code: 'timeout', message: '' } } } });
    expect(quoteIds(s)).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH']); expect(quoteIds(undefined)).toEqual([]);
    expect(bookEmpty(empty('paper'))).toBe(true); expect(bookEmpty(book())).toBe(false);
  });
});

describe('DashboardPanels — rendered', () => {
  it('a paper position is under « Simulation » and not under « Réel »; every panel is there', () => {
    const html = render(summary());
    for (const id of ['dashboard', 'db-accounts', 'db-positions', 'db-pnl', 'db-risk', 'db-agents', 'db-system', 'db-freshness']) expect(html, id).toContain(`data-testid="${id}"`);
    const positions = html.slice(html.indexOf('data-testid="db-positions"'), html.indexOf('data-testid="db-pnl"'));
    const live = positions.slice(positions.indexOf('data-book="live"'), positions.indexOf('data-book="paper"')), paper = positions.slice(positions.indexOf('data-book="paper"'));
    expect(live).toContain('Réel'); expect(live).not.toContain('data-testid="db-position"'); expect(live).toContain('Aucune position ouverte.');
    expect(paper).toContain('Simulation'); expect(paper).toContain('data-testid="db-position"'); expect(paper).toContain('data-instrument="hyperliquid:BTC"');
    expect(positions).not.toContain('data-book="liveTestnet"');                       // an empty testnet book says nothing
    expect(html).toContain('Arrêt d’urgence désactivé'); expect(html).toContain('Limites réelles non définies (2)');
    expect(html).toContain('Joignable'); expect(html).toContain('Chaîne d’audit intacte');
    expect(html).toMatch(/\+12,50\s\$/);                                              // agents' PnL of the day, paper
    expect(html).toContain('pas encore de relevé');                                   // live agents: no figure, with its reason
    expect(html).toMatch(/−1,50\s\$/);                                                // the sign is written, not only coloured
  });
  it('English: the same panels, no French left in the states', () => {
    const html = render(summary(), 'en');
    expect(html).toContain('Kill switch off'); expect(html).toContain('Audit chain intact'); expect(html).toContain('Live limits not set (2)');
    expect(html).not.toMatch(/Arrêt d|Indisponible|Simulation e2e|Réalisé/);
    expect(html).toMatch(/-?\$1\.50|−\$1\.50/);
  });
  it('a failed section says « Indisponible » with its reason in its own panel — never the server sentence — and the others show', () => {
    const html = render(summary({ books: { ...summary().books, live: { ok: false, error: { code: 'timeout', message: 'no answer within 8000 ms' } } }, health: { ok: false, error: { code: 'weird_code', message: 'connect ECONNREFUSED 127.0.0.1:9' } } }));
    expect(html).toContain('Indisponible : la source n’a pas répondu à temps'); expect(html).toContain('data-code="timeout"');
    expect(html).toContain('Indisponible : la source n’a pas pu être lue');
    expect(html).not.toContain('ECONNREFUSED'); expect(html).not.toContain('no answer within');
    expect(html).toContain('data-testid="db-position"'); expect(html).toContain('Chaîne d’audit intacte');   // paper positions and the audit chain still show
    expect(html).toContain('data-level="degraded"');
  });
  it('kill switch on, signer unreachable, broken chain: said in words', () => {
    const s = summary();
    const html = render({ ...s, risk: ok({ ...(s.risk as { data: any }).data, switches: { killSwitch: { on: true, at: 1, reason: 'x' }, readOnly: { on: false, at: null, reason: null } } }),
      health: ok({ ...(s.health as { data: any }).data, signer: { reachable: false, halted: null } }), audit: ok({ checkedAt: 1, total: 42, intact: false, brokenAt: 7 }) });
    expect(html).toContain('Arrêt d’urgence activé'); expect(html).toContain('data-level="halted"');
    expect(html).toContain('Injoignable'); expect(html).toContain('Chaîne d’audit rompue'); expect(html).toContain('data-level="down"');
  });
  it('loading: skeletons, marked busy; no agent: a designed empty state', () => {
    expect(render(null)).toContain('aria-busy="true"');
    const s = summary();
    expect(render({ ...s, agents: ok({ count: 0, total: { active: 0, paused: 0, stopped: 0 }, byMode: (s.agents as { data: any }).data.byMode }) })).toContain('Aucun agent');
  });
});

describe('the screen and its texts', () => {
  const a = i18n.indexOf('  // v11Db · dashboard'), b = i18n.indexOf('  // v11Tr · trade');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b(v11Db[A-Za-z0-9_]+): \[\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const keys = new Set(pairs.map((p) => p.key));
  it('one contiguous run under the marker; two non-empty languages; no v11Db key elsewhere; no duplicate', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(pairs.length).toBeGreaterThan(80); expect(keys.size).toBe(pairs.length);
    expect([...block.matchAll(/\b(v11Db[A-Za-z0-9_]+): \[/g)].length).toBe(pairs.length);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bv11Db[A-Za-z0-9_]*: \[/g)).toBeNull();
    for (const p of pairs) expect(p.fr.trim().length > 0 && p.en.trim().length > 0, p.key).toBe(true);
  });
  it('every key the panels use exists, and every key of the run is used', () => {
    const used = new Set<string>([...screen.matchAll(/['"](v11Db[A-Za-z0-9_]+)['"]/g)].map((m) => m[1]!));
    const families: Record<string, string[]> = { v11DbMode_: ['live', 'liveTestnet', 'paper'], v11DbAgentMode_: ['live', 'paper', 'research'], v11DbPnlWhy_: ['research_no_pnl', 'no_snapshot'], v11DbErr_: [...ERROR_CODES, 'other'] };
    for (const [prefix, members] of Object.entries(families)) { expect(screen.includes(`\`${prefix}\${`) || pure.includes(`\`${prefix}\${`), prefix).toBe(true); for (const m of members) used.add(prefix + m); }
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    for (const k of keys) expect(used.has(k), `unused key: ${k}`).toBe(true);
  });
  it('the panels are their own chunk material: no terminal import, no fetch of their own, no sum across books', () => {
    expect(screen).not.toMatch(/from '\.\.\/derivatives\/(Live|Order|Blotter|Book|Candles|store|live|mock)/);
    expect(screen).not.toMatch(/\bfetch\(|\bpost\(/);
    expect(screen + pure).not.toMatch(/paper[^;\n]{0,60}\+[^;\n]{0,60}live\b.*equity|totalAcrossModes/i);
    expect(pure).toMatch(/get<Summary>\('\/dashboard\/summary'\)/);
  });
});
