/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/v11-activity.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

// V11 Activity — the pure helpers of the unified timeline (apps/web/src/activity.ts) and the `v11Ac` texts of i18n.ts:
// filters → query string (shared by the list and the CSV link), date ranges at the device's own midnight, pages merged
// without a repeat, the twelve unified order states with UNKNOWN never drawn as a failure, the codes that have a sentence,
// and the block itself (two languages, every key used, every used key present).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS, activityApi, activityQuery, checkKey, defaultActivityFilters, eventKey, EVENT_CODES, failedChecks, filtersActive, groupByDay, mergePages, ORDER_STATES, orderStateView, PRINCIPALS, rangeBounds, RANGES, RISK_CHECKS, switchKey,
  transitionStep, type ActivityItem } from '../src/activity';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const item = (id: string, at: string, o: Partial<ActivityItem> = {}): ActivityItem => ({ id, kind: 'order', source: 'orders', at, mode: 'paper', venue: 'hyperliquid', network: null, principal: { kind: 'owner', id: 'owner' }, code: 'order', params: {}, status: 'FILLED',
  instrument: 'hyperliquid:BTC', side: 'buy', amount: null, received: null, ref: { type: 'order', id }, txid: null, explorer: null, ...o });

describe('filters', () => {
  it('no filter: no query string; the CSV link is the bare route', () => {
    const f = defaultActivityFilters();
    expect(activityQuery(f)).toBe('');
    expect(filtersActive(f)).toBe(false);
    expect(activityApi.csvHref(f)).toBe('/api/v1/dashboard/activity.csv');
  });
  it('every filter is sent, encoded; limit and cursor only when given; the CSV link carries the same filters and no cursor', () => {
    const f = { ...defaultActivityFilters(), kind: 'order' as const, mode: 'paper' as const, venue: 'hyperliquid', principal: 'api_key' as const };
    expect(activityQuery(f, { limit: 50, cursor: 'abc_-9' })).toBe('?kind=order&mode=paper&venue=hyperliquid&principal=api_key&limit=50&cursor=abc_-9');
    expect(activityApi.csvHref(f)).toBe('/api/v1/dashboard/activity.csv?kind=order&mode=paper&venue=hyperliquid&principal=api_key');
    expect(filtersActive(f)).toBe(true);
    expect(filtersActive({ ...defaultActivityFilters(), range: 'custom' })).toBe(false);   // « dates au choix » without a date filters nothing yet
    expect(filtersActive({ ...defaultActivityFilters(), range: 'today' })).toBe(true);
  });
  it('a period is the device\'s own days: today starts at local midnight, 7 days is today and the six before, custom dates are whole days', () => {
    const now = new Date(2026, 10, 15, 14, 30).getTime();
    expect(rangeBounds({ range: 'all', from: '', to: '' }, now)).toEqual({ from: null, to: null });
    expect(rangeBounds({ range: 'today', from: '', to: '' }, now)).toEqual({ from: new Date(2026, 10, 15).toISOString(), to: null });
    expect(rangeBounds({ range: '7d', from: '', to: '' }, now).from).toBe(new Date(2026, 10, 9).toISOString());
    expect(rangeBounds({ range: '30d', from: '', to: '' }, now).from).toBe(new Date(2026, 9, 17).toISOString());
    expect(rangeBounds({ range: 'custom', from: '2026-11-01', to: '2026-11-03' }, now)).toEqual({ from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 10, 3, 23, 59, 59, 999).toISOString() });
    expect(rangeBounds({ range: 'custom', from: 'hier', to: '' }, now)).toEqual({ from: null, to: null });
    expect(activityQuery({ ...defaultActivityFilters(), range: 'today' }, { now })).toBe(`?from=${encodeURIComponent(new Date(2026, 10, 15).toISOString())}`);
  });
});

describe('pages', () => {
  it('pages are one list, in order, an item shown once', () => {
    const a = item('o:1', '2026-11-15T10:00:00Z'), b = item('o:2', '2026-11-15T09:00:00Z'), c = item('o:3', '2026-11-14T09:00:00Z');
    expect(mergePages([{ items: [a, b] }, { items: [b, c] }]).map((i) => i.id)).toEqual(['o:1', 'o:2', 'o:3']);
    expect(mergePages([])).toEqual([]);
  });
  it('day groups keep the order of the list', () => {
    const g = groupByDay([item('a', new Date(2026, 10, 15, 10).toISOString()), item('b', new Date(2026, 10, 15, 9).toISOString()), item('c', new Date(2026, 10, 14, 23).toISOString())]);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([['2026-11-15', 2], ['2026-11-14', 1]]);
  });
});

describe('unified order states', () => {
  it('the twelve states each have a label key; only the four final ones are final', () => {
    expect(ORDER_STATES).toHaveLength(12);
    for (const s of ORDER_STATES) expect(orderStateView(s).key).toBe(`v11AcOs_${s}`);
    expect(ORDER_STATES.filter((s) => orderStateView(s).final)).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'FAILED']);
  });
  it('the web list is the server\'s list', () => {
    const spec = read('../../../services/api/src/trading-api/spec.ts');
    const m = /export const ORDER_STATES = \[([^\]]+)\]/.exec(spec)!;
    expect(m[1]!.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...ORDER_STATES]);
    const checks = /export const RISK_CHECK_IDS = \[([^\]]+)\]/.exec(spec)!;
    expect(checks[1]!.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...RISK_CHECKS]);
    const kinds = /export const ACTIVITY_KINDS = \[([^\]]+)\]/.exec(read('../../../services/api/src/dashboard/activity.ts'))!;
    expect(kinds[1]!.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...ACTIVITY_KINDS]);
  });
  it('UNKNOWN is a verification in progress: information tone, a clock, not final — never the tone or the step of a failure', () => {
    const u = orderStateView('UNKNOWN');
    expect(u).toEqual({ key: 'v11AcOs_UNKNOWN', tone: 'info', icon: 'clock', final: false });
    expect(orderStateView('FAILED').tone).toBe('danger'); expect(orderStateView('REJECTED').tone).toBe('danger');
    expect(transitionStep('UNKNOWN', true)).toBe('current'); expect(transitionStep('UNKNOWN', false)).toBe('done');
    expect(transitionStep('FAILED', true)).toBe('failed'); expect(transitionStep('REJECTED', false)).toBe('failed');
    expect(transitionStep('FILLED', true)).toBe('done'); expect(transitionStep('SUBMITTED', true)).toBe('current');
    const i18n = read('../src/i18n.ts'), row = /v11AcOs_UNKNOWN: \['([^']+)', '([^']+)'\]/.exec(i18n)!;
    expect(row[1]).toBe('En vérification auprès de la plateforme');
    expect(`${row[1]} ${row[2]}`).not.toMatch(/[ée]chec|[ée]chou|fail|erreur|error/i);
  });
  it('a state this screen does not know is shown as it is, neutral', () => {
    expect(orderStateView('SOMETHING_NEW')).toEqual({ key: null, tone: 'mute', icon: 'list', final: false });
    expect(orderStateView(null).key).toBeNull();
  });
});

describe('codes', () => {
  it('an audit event with a sentence gives its key; a switch says which way it went; another code gives none', () => {
    expect(eventKey('apikey.created')).toBe('v11AcEv_apikey_created');
    expect(eventKey('deriv.live.cancel_sent')).toBeNull();
    expect(switchKey({ code: 'risk.kill_switch', params: { engaged: true } })).toBe('v11AcEv_risk_kill_switch_on');
    expect(switchKey({ code: 'risk.kill_switch', params: { engaged: false } })).toBe('v11AcEv_risk_kill_switch_off');
    expect(switchKey({ code: 'risk.read_only', params: { engaged: false } })).toBe('v11AcEv_risk_read_only_off');
    expect(switchKey({ code: 'mandate.created', params: {} })).toBeNull();
    expect(checkKey('kill_switch')).toBe('v11AcChk_kill_switch'); expect(checkKey('made_up')).toBeNull();
    expect(failedChecks({ params: { failed: 'kill_switch,order_notional' } })).toEqual(['kill_switch', 'order_notional']);
    expect(failedChecks({ params: {} })).toEqual([]);
  });
});

describe('the v11Ac texts', () => {
  const i18n = read('../src/i18n.ts'), screen = read('../src/screens/Activity.tsx'), pure = read('../src/activity.ts');
  const a = i18n.indexOf('// >>> v11 interface pass'), b = i18n.indexOf('// <<< end of the `v11` block');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b(v11Ac[A-Za-z0-9_]+): \[\s*'((?:[^'\\]|\\.)+)',\s*'((?:[^'\\]|\\.)+)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const keys = new Set(pairs.map((p) => p.key));
  it('inside the v11 block; every key has a French and an English text; no duplicate; none outside the block', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(pairs.length).toBeGreaterThan(150);
    expect(keys.size).toBe(pairs.length);
    expect([...block.matchAll(/\b(v11Ac[A-Za-z0-9_]+): \[/g)].length).toBe(pairs.length);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bv11Ac[A-Za-z0-9_]*: \[/g)).toBeNull();
    for (const p of pairs) expect(p.fr.trim().length > 0 && p.en.trim().length > 0, p.key).toBe(true);
  });
  it('every key the screen uses exists, and every key of the sub-block is used', () => {
    const used = new Set<string>([...screen.matchAll(/'(v11Ac[A-Za-z0-9_]+)'/g)].map((m) => m[1]!));
    const families: Record<string, string[]> = { v11AcKind_: [...ACTIVITY_KINDS], v11AcPrincipal_: [...PRINCIPALS], v11AcRange_: [...RANGES], v11AcSrc_: ['wallet', 'plans', 'orders', 'decisions', 'audit'],
      v11AcOs_: [...ORDER_STATES], v11AcChk_: [...RISK_CHECKS], v11AcEvGeneric_: ['agent', 'mandate', 'risk', 'key', 'security'], v11AcPlan_: ['active', 'paused', 'done', 'stopped'],
      v11AcEv_: [...EVENT_CODES.map((c) => c.replace(/\./g, '_')), 'risk_kill_switch_on', 'risk_kill_switch_off', 'risk_read_only_on', 'risk_read_only_off'] };
    for (const [prefix, members] of Object.entries(families)) {
      expect(screen.includes(`\`${prefix}\${`) || pure.includes(`\`${prefix}\${`), prefix).toBe(true);   // the family is really built in the code
      for (const m of members) used.add(prefix + m);
    }
    for (const k of used) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    for (const k of keys) expect(used.has(k), `unused key: ${k}`).toBe(true);
  });
  it('the screen prints codes through i18n, never a server sentence: no `.message`, no `.reason` text of the API in the timeline rows', () => {
    expect(screen).not.toMatch(/errors\.map\(\(e\) => e\.message\)/);
    expect(screen).toContain('data-testid="ac-audit"'); expect(screen).toContain('data-testid="ac-more"'); expect(screen).toContain('data-testid="ac-csv"');
    expect(screen).toContain('data-testid="ac-item"');
  });
});
