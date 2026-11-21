/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/hardening-d.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// V8 hardening, item D — money display and wording (web, no money logic). Pure pieces only, in the style of qa-polish.test.ts:
// D1 the single rule for typed and shown amounts, D2 server texts in the screen's language, D3 the touch target of
// Futures → Compare, D4 the simulated positions of an agent, D5 the agent capital as a USD figure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { amountInputText, amountLocale, amountOf, amountProblem, formatAmount, parseAmountInput, sanitizeAmountText, setAmountLocale } from '../src/amount.ts';
import { COMPARE_OPEN_CLS } from '../src/derivatives/Compare.tsx';
import { defaultLimits } from '../src/derivatives/Accounts.tsx';
import { usdcInput } from '../src/derivatives/collateral.ts';
import { parseInput } from '../src/derivatives/dec.ts';
import { buildGmx, gmxAuthFromForm } from '../src/derivatives/gmx.ts';
import { errText, type Key } from '../src/i18n';
import { localizeAlertParams, reasonText } from '../src/reasonTexts.ts';
import { paperSummary, showPaperBook, type PaperBook } from '../src/screens/AgentPaper.tsx';
import { toUnits } from '../src/screens/AgentFund.tsx';
import { notificationFor } from '../src/sw-core.ts';
import { exactAmt, trimAmt, usdCapital } from '../src/ui';

const NNBSP = ' ', NBSP = ' ';
const ok = (value: string) => ({ ok: true, value });
const no = (error: string) => ({ ok: false, error });
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
afterEach(() => setAmountLocale('en'));

describe('D1 — a typed amount: comma or point, never a guess', () => {
  // [text, French screen, English screen]
  const TABLE: [string, ReturnType<typeof ok> | ReturnType<typeof no>, ReturnType<typeof ok> | ReturnType<typeof no>][] = [
    ['1,5', ok('1.5'), ok('1.5')],                                   // the comma is accepted in both languages
    ['1.5', ok('1.5'), ok('1.5')],                                   // and so is the point
    ['1 000,50', ok('1000.50'), ok('1000.50')],                      // a space groups thousands; the digits typed are kept ("…,50")
    [`1${NNBSP}000,50`, ok('1000.50'), ok('1000.50')],               // narrow no-break space (what fr-CA formatting produces)
    [`1${NBSP}000,50`, ok('1000.50'), ok('1000.50')],                // no-break space
    ['1 000 000', ok('1000000'), ok('1000000')],
    ['1,000', ok('1.000'), no('ambiguous')],                         // French: the decimal comma → one. English: a thousand or one? refused
    ['1.000', no('ambiguous'), ok('1.000')],                         // the mirror case
    ['12,345', ok('12.345'), no('ambiguous')],
    ['999.999', no('ambiguous'), ok('999.999')],
    ['0,001', ok('0.001'), ok('0.001')],                             // a thousands group cannot follow a lone 0: unambiguous
    ['0.001', ok('0.001'), ok('0.001')],
    ['1,0001', ok('1.0001'), ok('1.0001')],                          // four digits after the mark: decimals
    ['1.0001', ok('1.0001'), ok('1.0001')],
    ['1,00', ok('1.00'), ok('1.00')],
    ['1234,567', ok('1234.567'), ok('1234.567')],                    // four digits before the mark: not a thousands group
    ['1234.567', ok('1234.567'), ok('1234.567')],
    ['1 000.500', ok('1000.500'), ok('1000.500')],                   // thousands are already grouped by spaces: the point is the decimal mark
    ['1,234.5', ok('1234.5'), ok('1234.5')],                         // both marks: the last one is the decimal mark
    ['1.234,5', ok('1234.5'), ok('1234.5')],
    ['1,234,567', ok('1234567'), ok('1234567')],                     // the same mark twice can only group thousands
    ['1.234.567', ok('1234567'), ok('1234567')],
    ['1,234,567.89', ok('1234567.89'), ok('1234567.89')],
    ["1'000.5", ok('1000.5'), ok('1000.5')],                         // Swiss grouping
    ['.5', ok('0.5'), ok('0.5')], [',5', ok('0.5'), ok('0.5')], ['5.', ok('5'), ok('5')], ['5,', ok('5'), ok('5')],
    ['007', ok('7'), ok('7')], ['0', ok('0'), ok('0')], ['0,0', ok('0.0'), ok('0.0')],
    ['  2,5  ', ok('2.5'), ok('2.5')],
    ['0.123456789012345678', ok('0.123456789012345678'), ok('0.123456789012345678')],                     // 18 decimals, digit for digit
    ['123456789012345678901234567890.000000000000000001', ok('123456789012345678901234567890.000000000000000001'), ok('123456789012345678901234567890.000000000000000001')],
    ['', no('empty'), no('empty')], ['   ', no('empty'), no('empty')],
    ['abc', no('invalid'), no('invalid')], ['1e5', no('invalid'), no('invalid')], ['-3', no('invalid'), no('invalid')], ['+3', no('invalid'), no('invalid')],
    ['1.2.3', no('invalid'), no('invalid')], ['1,2,3', no('invalid'), no('invalid')],                      // not groups of three
    ['1 00', no('invalid'), no('invalid')], ['10 00,5', no('invalid'), no('invalid')], ['1 0000', no('invalid'), no('invalid')],
    ['1,5 0', no('invalid'), no('invalid')],                         // a grouping mark in the decimals
    ['1.234,5,6', no('invalid'), no('invalid')], ['1,23.456,7', no('invalid'), no('invalid')], ['12,34.5', no('invalid'), no('invalid')],
    ["1 000'000", no('invalid'), no('invalid')],                     // two grouping styles at once
    ['1 000,000.5', no('invalid'), no('invalid')],
    ['.', no('invalid'), no('invalid')], [',', no('invalid'), no('invalid')], ['$5', no('invalid'), no('invalid')], ['5 USDC', no('invalid'), no('invalid')],
  ];
  it.each(TABLE)('%j', (text, fr, en) => {
    expect(parseAmountInput(text, 'fr')).toEqual(fr);
    expect(parseAmountInput(text, 'en')).toEqual(en);
  });
  it('is exact on 18 decimals and beyond: strings only, no float anywhere in the helper', () => {
    expect(amountOf('1 234 567,000000000000000001', 'fr')).toBe('1234567.000000000000000001');
    expect(amountOf('0,1', 'fr')).toBe('0.1'); expect(amountOf('0.30000000000000004', 'en')).toBe('0.30000000000000004');
    expect(toUnits(amountOf('1,000000000000000001', 'fr')!, 18)).toBe(1_000_000_000_000_000_001n);        // what the fund sheet sends, to the wei
    const code = src('../src/amount.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // the code, without its comments
    expect(code).not.toMatch(/Number\(|parseFloat|parseInt|toFixed|Math\.|BigInt\(/);
  });
  it('maxDecimals refuses more decimals than the asset has, and never truncates silently', () => {
    expect(parseAmountInput('1,1234567', 'fr', { maxDecimals: 6 })).toEqual(no('too_many_decimals'));
    expect(parseAmountInput('1,123456', 'fr', { maxDecimals: 6 })).toEqual(ok('1.123456'));
    expect(parseAmountInput('1,1230000000', 'fr', { maxDecimals: 6 })).toEqual(ok('1.123000'));          // zeros beyond the limit carry no value
    expect(parseAmountInput('5,5', 'fr', { maxDecimals: 0 })).toEqual(no('too_many_decimals'));
  });
  it('says why, and says nothing for an empty field', () => {
    expect(amountProblem('', 'fr')).toBeNull(); expect(amountProblem('1,5', 'en')).toBeNull();
    expect(amountProblem('1.000', 'fr')).toBe('ambiguous'); expect(amountProblem('1,000', 'en')).toBe('ambiguous'); expect(amountProblem('x', 'en')).toBe('invalid');
    expect(amountOf('1.000', 'fr')).toBeNull(); expect(amountOf('1,000', 'en')).toBeNull();
  });
  it('the field keeps what is typed; only characters that can never be part of an amount are removed', () => {
    expect(sanitizeAmountText('1 000,50 USDC')).toBe('1 000,50 '); expect(sanitizeAmountText('1.5e3')).toBe('1.53'); expect(sanitizeAmountText(`-1${NNBSP}000`)).toBe(`1${NNBSP}000`);
  });
  it('a value the app writes in a field is read back exactly, in both languages (Max, suggestions, pre-filled forms)', () => {
    for (const v of ['1.000', '12.345', '0.002', '1000', '250', '0.000000000000000001', '1234567.891', '7.344872000000000000', '999.999']) for (const l of ['fr', 'en'] as const) {
      expect(amountOf(amountInputText(v, l), l), `${v} ${l}`).toBe(v);
    }
    expect(amountInputText('1.000', 'fr')).toBe('1,000'); expect(amountInputText('1.000', 'en')).toBe('1.000'); expect(amountInputText('1234.5', 'fr')).toBe('1234,5');   // no grouping in a field
    expect(amountInputText('?', 'fr')).toBe('?');
  });
});

describe('D1 — a shown amount follows the language of the screen', () => {
  it('formatAmount: decimal comma and no-break space in French, point and comma in English; truncated, never rounded up', () => {
    expect(formatAmount('1234.5', 'fr')).toBe(`1${NBSP}234,5`); expect(formatAmount('1234.5', 'en')).toBe('1,234.5');
    expect(formatAmount('1234567.000100', 'fr')).toBe(`1${NBSP}234${NBSP}567,0001`); expect(formatAmount('0.5', 'fr')).toBe('0,5'); expect(formatAmount('100', 'fr')).toBe('100');
    expect(formatAmount('0.999999999999999999', 'fr', { maxDecimals: 6 })).toBe('0,999999');             // never « 1 »
    expect(formatAmount('7.344872000000000000', 'en', { maxDecimals: 8 })).toBe('7.344872');
    expect(formatAmount('1.50', 'fr', { trim: false })).toBe('1,50'); expect(formatAmount('2', 'en', { minDecimals: 2 })).toBe('2.00');
    expect(formatAmount('1234.5', 'fr', { group: false })).toBe('1234,5');
    expect(formatAmount('123456789012345678901234567890.000000000000000001', 'en')).toBe('123,456,789,012,345,678,901,234,567,890.000000000000000001');   // no float
    expect(formatAmount('-0.5', 'fr')).toBe('−0,5'); expect(formatAmount('-0.0', 'fr')).toBe('0');
    for (const x of ['?', '—', '', '1e5', 'abc']) expect(formatAmount(x, 'fr')).toBe(x);                  // not a canonical decimal: shown as it came
  });
  it('trimAmt and exactAmt (every balance, fee and review amount of the app) follow the language App sets', () => {
    expect(amountLocale()).toBe('en');                                                                    // default = the canonical form, as before
    expect(trimAmt('1234.56789', 2)).toBe('1,234.56'); expect(exactAmt('0.50')).toBe('0.50');
    setAmountLocale('fr');
    expect(trimAmt('1234.56789', 2)).toBe(`1${NBSP}234,56`); expect(trimAmt('0.002', 6)).toBe('0,002'); expect(trimAmt('100.000000')).toBe('100');
    expect(exactAmt('0.50')).toBe('0,50'); expect(exactAmt('12.340000')).toBe('12,340000');             // the review screen shows every digit of what is signed
    expect(trimAmt('1234.5', 6, 'en')).toBe('1,234.5');                                                   // an explicit language wins
    expect(src('../src/App.tsx')).toMatch(/setAmountLocale\(locale\)/);
  });
});

describe('D1 — Futures inputs go through the same rule (derivatives/dec.ts parseInput)', () => {
  it('reads both marks, normalises as before, and refuses the ambiguous text instead of guessing', () => {
    expect(parseInput('1,5', 'fr')).toBe('1.5'); expect(parseInput('1.5', 'fr')).toBe('1.5'); expect(parseInput('1,5', 'en')).toBe('1.5');
    expect(parseInput(`1${NBSP}234,50`, 'fr')).toBe('1234.5'); expect(parseInput('0,010', 'fr')).toBe('0.01'); expect(parseInput('007', 'en')).toBe('7');
    expect(parseInput('1.000', 'fr')).toBeNull(); expect(parseInput('1,000', 'en')).toBeNull();           // before v8 both were silently read as 1
    expect(parseInput('1,000', 'fr')).toBe('1'); expect(parseInput('1.000', 'en')).toBe('1');
    expect(parseInput('1.2.3', 'en')).toBeNull(); expect(parseInput('1e5', 'en')).toBeNull(); expect(parseInput('', 'fr')).toBeNull();
  });
  it('without an explicit language it follows the screen; what the collateral forms send is unchanged', () => {
    expect(usdcInput('12,5')).toBe('12.5'); expect(usdcInput('12.5')).toBe('12.5'); expect(usdcInput('1,000')).toBeNull();   // English screen: ambiguous
    setAmountLocale('fr');
    expect(usdcInput('12,5')).toBe('12.5'); expect(usdcInput('12.5')).toBe('12.5'); expect(usdcInput('1,000')).toBe('1'); expect(usdcInput('1.000')).toBeNull();
    expect(usdcInput('1 000,5')).toBe('1000.5');
  });
  it('the limits a form is pre-filled with are written so that the rule reads them back', () => {
    expect(defaultLimits('24.68').maxDailyLoss).toBe('1.234');                                            // English screen: canonical, as before
    setAmountLocale('fr');
    const l = defaultLimits('24.68');
    expect(l.maxDailyLoss).toBe('1,234'); expect(parseInput(l.maxDailyLoss)).toBe('1.234'); expect(parseInput(l.minFreeCollateral)).toBe('2.468'); expect(parseInput(l.maxOrderNotional)).toBe('24.68');
  });
});

describe('D2 — server reasons the UI knows are shown in French', () => {
  it('translates the server\'s own sentences, with their figures, and leaves any other text alone', () => {
    expect(reasonText('mandate expired', 'fr')).toBe('le mandat est arrivé à échéance');
    expect(reasonText('loss limit reached: equity 94.20 USD against 100.00 USD allocated (limit 5 %); positions were sold to USDC', 'fr'))
      .toBe('limite de perte atteinte : valeur de 94,20 USD pour 100,00 USD alloués (limite de 5 %) ; les positions ont été vendues contre des USDC');
    expect(reasonText('daily loss limit reached: equity 968.5 USDC against 1000 at the start of the day (limit 3 % of the capital)', 'fr')).toMatch(/^limite de perte quotidienne atteinte : valeur de 968,5 USDC pour 1000 en début de journée \(limite de 3 % du capital\)$/);
    expect(reasonText('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT', 'fr')).toBe('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT');   // a network's own words: untouched
    expect(reasonText('mandate expired', 'en')).toBe('mandate expired');
    const p = { agent: 'Momentum', reason: 'the approved strategy no longer matches the mandate', count: 2 };
    expect(localizeAlertParams(p, 'fr')).toEqual({ agent: 'Momentum', reason: 'la stratégie approuvée ne correspond plus au mandat', count: 2 });
    expect(localizeAlertParams(p, 'en')).toBe(p); expect(localizeAlertParams({ agent: 'x' }, 'fr')).toEqual({ agent: 'x' });
  });
  it('a push notification with details uses the same wording', () => {
    const n = notificationFor({ v: 1, id: 7, kind: 'agent.stopped', sev: 'warning', ts: 1_800_000_000_000, l: 'fr', d: true, p: { agent: 'Momentum', reason: 'mandate expired' }, s: { type: 'agent', id: 'a1' } });
    expect(n.options.body).toBe('Momentum : le mandat est arrivé à échéance');
    expect(notificationFor({ v: 1, id: 7, kind: 'agent.stopped', sev: 'warning', ts: 1, l: 'en', d: true, p: { agent: 'Momentum', reason: 'mandate expired' }, s: null }).options.body).toBe('Momentum: mandate expired');
  });
  it('error codes that only had the server\'s English sentence now have their own', () => {
    const t = (k: Key) => String(k);
    expect(errText(t, { code: 'not_found', message: 'agent not found' })).toBe('e_not_found');
    expect(errText(t, { code: 'conflict', message: 'proposal changed concurrently; reload' })).toBe('e_conflict');
    expect(errText(t, { code: 'proposal_expired', message: 'this proposal has expired; propose it again' })).toBe('e_proposal_expired');
    expect(errText(t, { code: 'too_many_symbols', message: 'at most 8 perpetuals' })).toBe('e_too_many_symbols (v11LoSrvDetail)');   // a figure is still shown
    expect(errText(t, { code: 'bad_strategy', message: 'the laboratory refused this strategy: SyntaxError' })).toBe('v11LoSrvRefused');   // free text stays whole
  });
  it('the Compare, Router and instrument queries ask the server for the screen\'s language', () => {
    expect(src('../src/derivatives/Compare.tsx')).toMatch(/dapi\.compare\(base, locale\)/);
    expect(src('../src/derivatives/Router.tsx')).toMatch(/rapi\.route\(sent!, locale\)/);
    expect(src('../src/screens/Futures.tsx')).toMatch(/dapi\.instruments\(undefined, locale\)/);
    expect(src('../src/derivatives/routerApi.ts')).toMatch(/\/derivatives\/route\$\{locale \? `\?locale=/);  // in the query: the body stays the strict intent
  });
  it('every key of the hd block has a French and an English text, and the block is one delimited piece', () => {
    const s = src('../src/i18n.ts'), a = s.indexOf('// --- hd: v8 hardening ---'), b = s.indexOf('// --- end hd ---');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(s.indexOf('// --- hd: v8 hardening ---', a + 1)).toBe(-1);
    const block = s.slice(a, b), keys = [...block.matchAll(/(?:^|\s)([A-Za-z_0-9]+): \[/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) expect(k, k).toMatch(/^(hd[A-Z]|e_)/);
    expect((block.match(/\[\s*'[^']+',\s*'[^']+'\]/g) ?? []).length).toBe(keys.length);                  // two non-empty strings each
    expect([...s.matchAll(/\bhd[A-Z][A-Za-z]*: \[/g)].every((m) => m.index! > a && m.index! < b)).toBe(true);   // no hd key outside the block
  });
});

describe('D3 — Futures → Compare: the market link is a 44 × 44 target', () => {
  it('has a minimum height and a minimum width of 2.75 rem (44 CSS px), and the table uses it', () => {
    const cls = COMPARE_OPEN_CLS.split(' ');
    expect(cls).toContain('min-h-11'); expect(cls).toContain('min-w-11');                                 // Tailwind: 11 × 0.25 rem = 44 px
    const s = src('../src/derivatives/Compare.tsx');
    expect(s).toMatch(/<button type="button" onClick=\{\(\) => onOpen\(r\.instrument\)\} className=\{COMPARE_OPEN_CLS\}/);
    // every other control of the view (the notes disclosure) is at least 44 px high and wider than its text
    for (const m of s.matchAll(/<(button|summary)\b[^>]*className="([^"]*)"/g)) expect(m[2], m[0].slice(0, 60)).toMatch(/\bmin-h-11\b/);
  });
});

describe('D4 — the simulated positions of an agent, apart from the real vault', () => {
  const book: PaperBook = { positions: [{ symbol: 'ETH', units: '0.01', usd: 20 }, { symbol: 'LINK', units: '2', usd: null }], cashSymbol: 'USDC', cashUsd: 60, asOf: 1_800_000_000_000 };
  it('totals only what has a price and names what has none', () => {
    const s = paperSummary(book);
    expect(s.totalUsd).toBe(80); expect(s.unpriced).toEqual(['LINK']);
    expect(s.rows).toEqual([{ symbol: 'ETH', units: '0.01', usd: 20, cash: false }, { symbol: 'LINK', units: '2', usd: null, cash: false }, { symbol: 'USDC', units: '60', usd: 60, cash: true }]);
    expect(paperSummary({ ...book, positions: [] })).toMatchObject({ totalUsd: 60, unpriced: [] });
  });
  it('is shown for an agent that is not trading for real and has a paper book — never in LIVE, never without a book', () => {
    expect(showPaperBook({ state: 'PAPER_TRADING', paper: book })).toBe(true); expect(showPaperBook({ state: 'PAUSED', paper: book })).toBe(true);
    expect(showPaperBook({ state: 'LIVE', paper: book })).toBe(false); expect(showPaperBook({ state: 'PAPER_TRADING', paper: null })).toBe(false); expect(showPaperBook({ state: 'RESEARCH' })).toBe(false);
  });
  it('the card is labelled SIMULATION, is its own section, and adds nothing to the real vault', () => {
    const card = src('../src/screens/AgentPaper.tsx'), page = src('../src/screens/Agents.tsx'), i18n = src('../src/i18n.ts');
    expect(i18n).toMatch(/hdPaperTitle: \['SIMULATION — positions fictives, aucun fonds réel', 'SIMULATION — fictional positions, no real funds'\]/);
    expect(card).toMatch(/data-testid="paper-book"/); expect(card).toMatch(/\{t\('hdPaperTitle'\)\}/);
    expect(page).toMatch(/\{showPaperBook\(a\) && <PaperBookCard paper=\{a\.paper\} \/>\}/);
    expect(page.indexOf('<PaperBookCard')).toBeGreaterThan(page.indexOf("<Card><H>{t('agVault')}</H>"));   // after the vault card, not inside it
    expect(page.slice(page.indexOf("<Card><H>{t('agVault')}</H>"), page.indexOf('<ElsewhereFunds')).includes('paper.')).toBe(false);   // no paper figure in the vault card
    expect(page).toMatch(/const vaultUsd = [^\n]*a\.vault/); expect(page.match(/const vaultUsd = [^\n]*/)![0]).not.toMatch(/paper/);
  });
});

describe('D5 — the agent capital is a USD figure, whatever the cash leg', () => {
  it('is written by the fiat formatter with the currency USD', () => {
    expect(usdCapital('100', 'fr')).toBe(`100,00${NBSP}$${NBSP}US`); expect(usdCapital('100', 'en')).toBe('US$100.00');
    expect(usdCapital('1234.5', 'fr')).toBe(`1${NBSP}234,50${NBSP}$${NBSP}US`); expect(usdCapital(250, 'en')).toBe('US$250.00');
    expect(usdCapital('n/a', 'fr')).toBe('—');
  });
  it('no screen shows the capital next to the symbol of the cash leg any more', () => {
    const agents = src('../src/screens/Agents.tsx'), fund = src('../src/screens/AgentFund.tsx'), perp = src('../src/screens/PerpAgent.tsx');
    for (const s of [agents, fund, perp]) { expect(s).not.toMatch(/capitalUsdc\}? \{?a\.cash/); expect(s).not.toMatch(/\$\{a\.capitalUsdc\} \$\{a\.cash\}/); }
    expect(agents.match(/usdCapital\(a\.capitalUsdc, locale\)/g)!.length).toBe(2);                       // the list row and the agent page
    expect(fund).toMatch(/row\(t\('qaFundPlanned'\), usdCapital\(a\.capitalUsdc, loc\)\)/);            // the funding sheet
    expect(perp).toMatch(/t\('hdPaAllocated', \{ capital: usdCapital\(a\.capitalUsdc, locale\) \}\)/);   // a perp agent's page
    expect(agents).toMatch(/data-testid="capital-unit">USD</);                                           // the creation form: the capital is typed in USD
  });
});

// v10 integration: the screens `main` gained after the hardening branch was cut (redesigned Send / Asset / Home / Activity,
// GMX panels, Solana bridge sheets, Cardano / Polkadot notices) follow the same single rule.
describe('D1 — the rule on the screens added by the redesign, GMX and the Solana bridge', () => {
  const noRawSanitiser = (s: string, f: string) => { expect(s, f).not.toMatch(/replace\(',', '\.'\)/); expect(s, f).not.toMatch(/replace\(\/\[\^0-9\.,?\]\/g, ''\)(?!\) \|\| 0)/); };
  it('the redesigned Send: the field keeps what is typed, Max is written for the screen, the API receives the canonical string', () => {
    const s = src('../src/screens/Send.tsx');
    expect(s).toMatch(/onChange=\{\(e\) => \{ setAmount\(sanitizeAmountText\(e\.target\.value\)\); setApproxMax\(false\); \}\}/);
    expect(s).toMatch(/setAmount\(amountInputText\(bal\.display, locale\)\)/); expect(s).toMatch(/setAmount\(amountInputText\(m\.value, locale\)\)/);   // NEXT: Max of the native coin is net of the known fee ceiling (maxNative)
    expect(s).toMatch(/amount: amountOf\(amount, locale\) \?\? amount\.trim\(\)/);                       // what is posted: no float, no Number()
    expect(s).toMatch(/disabled=\{!to \|\| !amountOf\(amount, locale\) \|\| block !== null \|\| !n \|\| verdict\?\.ok === false\}/);   // NEXT W5: `block` = halted or signer unreachable (hooks.ts sendBlock)     // unreadable or ambiguous: no review
    expect(s).toMatch(/<AmountProblem text=\{amount\} \/>/);
    expect(s.match(/exactAmt\(cur\.amountDisplay\)/g)!.length).toBe(2);                                  // the receipt and the tracking card: every digit
    expect(s).not.toMatch(/\{cur\.amountDisplay\}/); expect(s).not.toMatch(/Number\(amount|parseFloat/);
    expect(s).toMatch(/\{cur\.amount\} \{t\('baseUnits'\)\}/);                                           // base units stay the raw integer that is signed
    noRawSanitiser(s, 'Send');
  });
  it('GMX: typed collateral, size, leverage and the policy ceiling are read by the rule; values the app writes are read back', () => {
    const panel = src('../src/derivatives/GmxOrderPanel.tsx'), auth = src('../src/derivatives/GmxAuthorize.tsx');
    for (const k of ['collateral', 'sizeUsd']) expect(panel).toMatch(new RegExp(`set\\(\\{ ${k}: sanitizeAmountText\\(e\\.target\\.value\\) \\}\\)`));
    expect(panel.match(/<AmountProblem ambiguousOnly/g)!.length).toBe(2); expect(auth).toMatch(/<AmountProblem ambiguousOnly text=\{f\.maxOrderSizeUsd\} \/>/);
    expect(panel).toMatch(/collateral: amountInputText\(p\.collateral, locale\)/);                       // a router hand-over is written for the screen
    expect(panel).toMatch(/set\(\{ leverage: amountInputText\(e\.target\.value, locale\) \}\)/);       // and so is the slider's value
    expect(auth).toMatch(/maxOrderSizeUsd: amountInputText\(prev\?\.maxOrderSizeUsd \?\? '100', locale\)/);
    noRawSanitiser(panel, 'GmxOrderPanel'); noRawSanitiser(auth, 'GmxAuthorize');
    const st = { wallet: null, authorization: null }, form = { side: 'long' as const, mode: 'leverage' as const, sizeUsd: '', slippageBps: '50' };
    setAmountLocale('fr');
    expect(buildGmx({ ...form, collateral: '25,5', leverage: '2,5' }, '0xm', st).body).toMatchObject({ collateral: '25.5', leverage: '2.5' });
    expect(buildGmx({ ...form, collateral: `1${NBSP}000,25`, leverage: '2' }, '0xm', st).body).toMatchObject({ collateral: '1000.25' });
    expect(buildGmx({ ...form, collateral: '1.000', leverage: '2' }, '0xm', st)).toMatchObject({ body: null, problem: 'gxErrCollateral' });   // French screen: ambiguous, refused
    expect(buildGmx({ ...form, collateral: amountInputText('12.345', 'fr'), leverage: '2' }, '0xm', st).body).toMatchObject({ collateral: '12.345' });   // a hand-over value survives
    const a = gmxAuthFromForm({ markets: ['0xm'], maxLeverage: '3', maxOrderSizeUsd: '1 500,50', maxOrdersPerDay: '10', bandBps: '100', days: '30' }, 'fr');
    expect(a).toMatchObject({ ok: true, body: { maxOrderSizeUsd: '1500.5' } });
    setAmountLocale('en');
    expect(buildGmx({ ...form, collateral: '1,000', leverage: '2' }, '0xm', st)).toMatchObject({ body: null, problem: 'gxErrCollateral' });
    expect(buildGmx({ ...form, collateral: '25.5', leverage: '2.5' }, '0xm', st).body).toMatchObject({ collateral: '25.5', leverage: '2.5' });
  });
  it('no screen shows a server "display" amount as it came: balances, the Solana bridge facts and swap results go through trimAmt / exactAmt', () => {
    const files = ['screens/Home.tsx', 'screens/Asset.tsx', 'screens/Assets.tsx', 'screens/Activity.tsx', 'screens/Send.tsx', 'screens/Swap.tsx', 'screens/Receive.tsx', 'bridge.tsx', 'xswap.tsx', 'plan.tsx'];
    for (const f of files) expect([...src(`../src/${f}`).matchAll(/\{[A-Za-z_.!?]*[dD]isplay!?( \?\? [A-Za-z_.!?]*[dD]isplay!?)?\}/g)].map((m) => m[0]), f).toEqual([]);
    const bridge = src('../src/bridge.tsx');
    for (const k of ['depositDisplay', 'reclaimedDisplay', 'nonceRentDisplay']) expect(bridge, k).toMatch(new RegExp(`trimAmt\\(s\\.${k}`));
    const swap = src('../src/screens/Swap.tsx');
    for (const k of ['depositDisplay', 'networkFeeDisplay', 'nonceRentDisplay', 'tokenAccountRentDisplay']) expect(swap, k).toMatch(new RegExp(`trimAmt\\(brSol\\.${k}`));
    setAmountLocale('fr');
    expect(trimAmt('0.00203928', 9)).toBe('0,00203928'); expect(trimAmt('1234.000015', 9)).toBe(`1${NBSP}234,000015`);   // a Solana deposit, a large balance
    setAmountLocale('en');
    expect(trimAmt('1234.000015', 9)).toBe('1,234.000015');
  });
  it('Cardano / Polkadot notices write their figure in the language of the screen', () => {
    const send = src('../src/screens/Send.tsx'), recv = src('../src/screens/Receive.tsx'), i18n = src('../src/i18n.ts');
    expect(send).toMatch(/t\('dtSendHint', \{ amount: trimAmt\(n\.activation \?\? '0\.01', 12\) \}\)/);
    expect(recv).toMatch(/t\('dtRecvEd', \{ amount: trimAmt\(n\.activation \?\? '0\.01', 12\) \}\)/);
    expect(recv).toMatch(/amount: trimAmt\(n\.activation, 12\)/);
    for (const f of [send, recv]) expect(f).not.toMatch(/amount: n\.activation\b(?! \?\?)/);
    expect(i18n).toMatch(/cdSendHint: \['[^']*0,97 ADA[^']*',\s*'[^']*0\.97 ADA/);                      // the fixed Cardano figure is written per language
    setAmountLocale('fr'); expect(trimAmt('0.01', 12)).toBe('0,01');
  });
});
