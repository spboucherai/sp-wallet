/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/private-markets.test.ts
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

// V11 Private Markets screen — component tests. The components are rendered to markup (react-dom/server, both languages)
// over REAL answers of the API recorded on 2026-11-16 by `scripts/smoke-private-markets.mts --json` (live Hyperliquid and
// edgeX public data through the real service): fixtures/private-markets/. Plus the pure helpers of ../src/privateMarkets.ts
// and the `pm` block of i18n.ts (contiguous, two languages, every key used, every used key present).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18n, type Locale } from '../src/i18n';
import {
  ageText, caveatKey, compactUsd, freshness, fundingText, groupByCompany, noValuationKey, orderCaveats, pmDetailQuery, pmListQuery, pmPath, premiumText, priceText, quantities, referenceKindKey, sizeParam, unitBadge,
  type PmDetail, type PmList, type PmMarket,
} from '../src/privateMarkets';
import { Caveats, ContractRow, PmListView, PmNotice, PrivateMarkets, ValuationPanel } from '../src/screens/PrivateMarkets';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const fx = <A>(name: string): { recordedAt: string; answer: A } => JSON.parse(read(`./fixtures/private-markets/${name}.json`));
const LIST = fx<PmList>('list'), OLD = fx<PmList>('list-delisted'), IO = fx<PmDetail>('detail-io-ANTH'), XYZ = fx<PmDetail>('detail-xyz-ANT'), EDGEX = fx<PmDetail>('detail-edgex-ANTHROPICUSDC'), VNTL = fx<PmDetail>('detail-vntl-ANTHROPIC');
const market = (id: string): PmMarket => LIST.answer.markets.find((m) => m.id === id)!;
const render = (el: ReactElement, locale: Locale = 'fr'): string => renderToStaticMarkup(h(I18n.Provider, { value: { locale, setLocale: () => {} } }, el));
/** visible text of a rendered fragment */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
/** the figures as `text()` gives them back: no-break spaces read as spaces */
const sp = (s: string): string => s.replace(/\u00a0/g, ' ');
const cu = (...a: Parameters<typeof compactUsd>) => sp(compactUsd(...a)), pt = (...a: Parameters<typeof priceText>) => sp(priceText(...a)), pr = (...a: Parameters<typeof premiumText>) => sp(premiumText(...a));
const part = (html: string, testid: string): string => { const k = html.indexOf(`data-testid="${testid}"`); expect(k, testid).toBeGreaterThan(-1); const end = html.indexOf('</li>', k); return text(html.slice(html.lastIndexOf('<', k), end < 0 ? undefined : end)); };

describe('the recorded answers are the live ones of 2026-11-16', () => {
  it('eight live contracts on five companies, two venues answering; two delisted', () => {
    expect(LIST.recordedAt.slice(0, 10)).toBe('2026-11-16');
    expect(LIST.answer.markets.map((m) => m.id).sort()).toEqual(['edgex:ANTHROPICUSDC', 'edgex:MOONSHOTUSDC', 'edgex:POLYMARKETUSDC', 'hyperliquid:io:ANTH', 'hyperliquid:io:OAI', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT', 'hyperliquid:xyz:OURA']);
    expect(LIST.answer.venues.map((v) => `${v.venue}:${v.status}`)).toEqual(['hyperliquid:ok', 'edgex:ok']);
    expect(OLD.answer.markets.map((m) => m.id)).toEqual(['hyperliquid:vntl:ANTHROPIC', 'hyperliquid:vntl:OPENAI']);
  });
});

describe('helpers', () => {
  it('paths and queries', () => {
    expect(pmPath()).toBe('/private-markets'); expect(pmPath('hyperliquid:xyz:ANT')).toBe('/private-markets/hyperliquid%3Axyz%3AANT'); expect(pmPath(undefined, true)).toBe('/private-markets?v=delisted');
    expect(pmListQuery(false)).toBe('/private-markets'); expect(pmListQuery(true)).toBe('/private-markets?delisted=true');
    expect(pmDetailQuery('hyperliquid:io:ANTH', { side: 'short', size: '2.5' })).toBe('/private-markets/hyperliquid%3Aio%3AANTH?size=2.5&side=short');
  });
  it('a typed size is sent only when it is a positive decimal', () => {
    expect(sizeParam('10')).toBe('10'); expect(sizeParam(' 2,5 ')).toBe('2.5'); expect(sizeParam('0.00000001')).toBe('0.00000001');
    for (const bad of ['', '0', '0.0', '-1', 'abc', '1e3', '1.123456789', '01']) expect(sizeParam(bad), bad).toBeNull();
  });
  it('unit badge: per share, $B of valuation, unit not published — and never a unit for a definition that is not confirmed', () => {
    expect(unitBadge(market('hyperliquid:xyz:ANT')).key).toBe('pmUnitShare'); expect(unitBadge(market('hyperliquid:io:ANTH')).key).toBe('pmUnitValuation'); expect(unitBadge(market('edgex:ANTHROPICUSDC')).key).toBe('pmUnitUnknown');
    const m = market('hyperliquid:io:ANTH');
    expect(unitBadge({ ...m, review: { ...m.review, state: 'under_review' } })).toEqual({ key: 'pmUnitUnderReview', tone: 'warn' });
    expect(unitBadge({ ...m, review: { ...m.review, state: 'not_reviewed' } })).toEqual({ key: 'pmUnitNotReviewed', tone: 'warn' });
  });
  it('figures: compact USD, price, premium, funding, age', () => {
    expect(compactUsd('1776600000000', 'fr')).toBe('1 776,6 G$'); expect(compactUsd('1776600000000', 'en')).toBe('$1,776.6B');
    expect(compactUsd('965000000000', 'en')).toBe('$965B'); expect(compactUsd('21000000000', 'fr')).toBe('21 G$'); expect(compactUsd('7654.77', 'en')).toBe('$7,654.77');
    expect(compactUsd('8681326.67', 'en')).toBe('$8.68M'); expect(compactUsd('-4441.5', 'fr')).toBe('−4 441,5 $'); expect(compactUsd(null, 'fr')).toBe('—');
    expect(priceText('1340.056138096814292006', 'fr')).toBe('1 340,0561'); expect(priceText('101.8', 'en')).toBe('101.8'); expect(priceText(null, 'fr')).toBe('—');
    expect(premiumText('8410.3627', 'fr')).toBe('+84,10 %'); expect(premiumText('-1000', 'en')).toBe('−10.00%'); expect(premiumText('0', 'en')).toBe('0.00%'); expect(premiumText(null, 'fr')).toBe('—');
    expect(fundingText({ value: '0.0000015625', intervalSec: 3600, source: '', ts: 1, stale: false }, 'fr')).toBe('+0,00016 % / 1 h');
    expect(fundingText({ value: '-0.0002', intervalSec: 14400, source: '', ts: 1, stale: false }, 'en')).toBe('-0.02% / 4 h'); expect(fundingText({ value: null, intervalSec: null, source: '', ts: null, stale: false }, 'en')).toBe('—');
    expect(ageText(1_000, 13_000, 'fr')).toBe('il y a 12 s'); expect(ageText(0, 180_000, 'en')).toBe('3 min ago'); expect(ageText(null, 1, 'fr')).toBeNull();
  });
  it('freshness: frozen, no data, stale, fresh', () => {
    const m = market('hyperliquid:io:ANTH');
    expect(freshness(m)).toEqual({ key: 'pmFresh', tone: 'ok' });
    expect(freshness({ ...m, market: { ...m.market, price: { ...m.market.price, stale: true } } }).key).toBe('pmStale');
    expect(freshness({ ...m, market: { ...m.market, price: { ...m.market.price, value: null } } }).key).toBe('pmNoData');
    expect(freshness(OLD.answer.markets[0]!).key).toBe('pmFrozen');
  });
  it('companies keep their contracts apart; a contract without a reviewed company goes last', () => {
    const g = groupByCompany(LIST.answer);
    expect(g.map((x) => `${x.company?.slug}:${x.markets.length}`)).toEqual(['anthropic:4', 'openai:1', 'oura:1', 'polymarket:1', 'moonshot:1']);
    const stray = { ...market('hyperliquid:io:OAI'), id: 'hyperliquid:io:NEW', company: null };
    expect(groupByCompany({ markets: [...LIST.answer.markets, stray], companies: LIST.answer.companies }).at(-1)).toMatchObject({ company: null, markets: [{ id: 'hyperliquid:io:NEW' }] });
  });
  it('the five quantities, in order, each with its own presence', () => {
    expect(quantities(market('hyperliquid:io:ANTH').valuation).map((q) => `${q.n}${q.id}:${q.has}`)).toEqual(['1price:true', '2contract:true', '3exposure:true', '4implied:true', '5private:true']);
    expect(quantities(market('hyperliquid:xyz:ANT').valuation).map((q) => q.has)).toEqual([true, true, true, false, true]);
    expect(quantities(market('edgex:MOONSHOTUSDC').valuation).map((q) => q.has)).toEqual([true, true, true, false, false]);
    expect(quantities(OLD.answer.markets[0]!.valuation).map((q) => q.has)).toEqual([true, false, false, false, true]);
  });
  it('codes map to texts of the screen; an unknown code has a fallback', () => {
    expect(noValuationKey('per_share_no_share_count')).toBe('pmWhy_per_share'); expect(noValuationKey('unit_not_published')).toBe('pmWhy_unit_not_published'); expect(noValuationKey('zzz')).toBe('pmWhy_no_formula'); expect(noValuationKey(null)).toBe('pmWhy_no_formula');
    expect(referenceKindKey('primary_round')).toBe('pmKind_primary_round'); expect(referenceKindKey('zzz')).toBe('pmKind_other'); expect(caveatKey('thin_market')).toBe('pmCav_thin'); expect(caveatKey('zzz')).toBe('pmCav_other');
    expect(orderCaveats(market('edgex:ANTHROPICUSDC').valuation.caveats).map((c) => c.code)).toEqual(['thin_market', 'cross_venue', 'unit_mismatch', 'unconfirmed_convention', 'company_note', 'synthetic', 'arithmetic']);
  });
});

describe('list — companies, then each venue\'s contract', () => {
  const html = render(h(PmListView, { data: LIST.answer, onOpen: () => {} })), en = render(h(PmListView, { data: LIST.answer, onOpen: () => {} }), 'en');
  it('one card per company, one row per venue contract, the unit badge next to each price', () => {
    for (const slug of ['anthropic', 'openai', 'oura', 'polymarket', 'moonshot']) expect(html).toContain(`data-testid="pm-company-${slug}"`);
    for (const m of LIST.answer.markets) expect(html).toContain(`data-testid="pm-row-${m.id}"`);
    const row = (id: string, src = html) => { const k = src.indexOf(`data-testid="pm-row-${id}"`); return text(src.slice(k, src.indexOf('</button>', k))); };
    expect(row('hyperliquid:xyz:ANT')).toContain('par action'); expect(row('hyperliquid:io:ANTH')).toContain('G$ de valorisation'); expect(row('edgex:ANTHROPICUSDC')).toContain('unité non publiée');
    expect(row('hyperliquid:xyz:ANT', en)).toContain('per share'); expect(row('hyperliquid:io:ANTH', en)).toContain('$B of valuation'); expect(row('edgex:ANTHROPICUSDC', en)).toContain('unit not published');
    // price, funding, open interest, volume, freshness
    const io = market('hyperliquid:io:ANTH'), r = row('hyperliquid:io:ANTH');
    expect(r).toContain(pt(io.market.price.value, 'fr')); expect(r).toContain('Financement'); expect(r).toContain('Intérêt ouvert'); expect(r).toContain('Volume 24 h'); expect(r).toContain('À jour');
    expect(r).toContain(cu(io.market.openInterestUsd.value, 'fr')); expect(r).toContain(cu(io.market.volume24h.value, 'fr'));
  });
  it('the implied valuation is shown only where the contract defines it; elsewhere "non déductible du contrat" with the reason', () => {
    const row = (id: string) => { const k = html.indexOf(`data-testid="pm-row-${id}"`); return text(html.slice(html.indexOf('data-testid="pm-row-valuation"', k), html.indexOf('</button>', k))); };
    expect(row('hyperliquid:io:ANTH')).toContain(`Valorisation implicite : ${cu(market('hyperliquid:io:ANTH').valuation.impliedValuation.value, 'fr')} — estimation`);
    expect(row('hyperliquid:xyz:ANT')).toMatch(/Non déductible du contrat — Coté par action/);
    expect(row('hyperliquid:para:ANTH')).toMatch(/Non déductible du contrat — Coté par action/);
    expect(row('edgex:ANTHROPICUSDC')).toMatch(/Non déductible du contrat — La plateforme ne publie pas l’unité/);
    // the press convention ×1e9 is never rendered as a figure for edgeX
    const p = market('edgex:ANTHROPICUSDC').market.price.value!;
    expect(html).not.toContain(cu(String(Number(p) * 1e9), 'fr'));
  });
  it('each company shows its last private valuation with kind, date and a source link; several venues are said to be never averaged', () => {
    const k = html.indexOf('data-testid="pm-company-anthropic"'), head = html.slice(k, html.indexOf('data-testid="pm-row-', k));
    expect(text(head)).toContain('Dernière valorisation privée connue : 965 G$ · tour de financement · 2026-05-28');
    expect(head).toContain('href="https://www.anthropic.com/news/series-h"'); expect(head).toContain('rel="noopener noreferrer"');
    expect(text(head)).toContain('jamais moyennés'); expect(text(head)).toContain('18 Nov 2026');
    const moon = html.slice(html.indexOf('data-testid="pm-company-moonshot"'));
    expect(text(moon.slice(0, moon.indexOf('data-testid="pm-row-')))).toContain('Aucune valorisation privée recensée');
  });
  it('venues read, venues without adapter, and the excluded public companies with their reason', () => {
    expect(html).toContain('data-testid="pm-venue-hyperliquid"'); expect(html).toContain('data-testid="pm-venue-edgex"'); expect(text(html)).toContain('Répond');
    const fold = text(html.slice(html.indexOf('data-testid="pm-no-adapter"')));
    for (const v of ['Aster', 'Lighter', 'Polymarket Perps']) expect(fold).toContain(v);
    const ex = text(html.slice(html.indexOf('data-testid="pm-excluded"')));
    expect(ex).toContain('Exclus : sociétés aujourd’hui cotées (5)'); expect(ex).toContain('SpaceX'); expect(ex).toContain('Nasdaq: SPCX');
    expect(html).not.toContain('pm-row-hyperliquid:xyz:SPCX');
  });
  it('a venue that cannot be read: its rows say so, the others are intact; stale data is a word, not a colour', () => {
    const broken: PmList = { ...LIST.answer, venues: [{ ...LIST.answer.venues[0]!, status: 'error', error: 'hyperliquid: network error' }, LIST.answer.venues[1]!],
      markets: LIST.answer.markets.map((m) => m.venue !== 'hyperliquid' ? m : { ...m, error: 'hyperliquid: network error', market: { ...m.market, price: { ...m.market.price, value: null, ts: null } },
        valuation: { ...m.valuation, impliedValuation: { ...m.valuation.impliedValuation, value: null, reasonCode: 'no_price', reason: 'no price' } } }) };
    const out = render(h(PmListView, { data: broken, onOpen: () => {} }));
    const row = (id: string) => { const k = out.indexOf(`data-testid="pm-row-${id}"`); return text(out.slice(k, out.indexOf('</button>', k))); };
    expect(row('hyperliquid:io:ANTH')).toContain('Plateforme illisible — hyperliquid: network error'); expect(row('hyperliquid:io:ANTH')).toContain('Sans données'); expect(row('hyperliquid:io:ANTH')).toContain('Pas de prix');
    expect(row('edgex:ANTHROPICUSDC')).toContain('À jour'); expect(text(out)).toContain('Ne répond pas');
    const m = market('hyperliquid:io:OAI');
    expect(text(render(h(ContractRow, { m: { ...m, market: { ...m.market, price: { ...m.market.price, stale: true } } }, now: LIST.answer.ts, onOpen: () => {} })))).toContain('Données anciennes');
  });
  it('delisted filter: labelled, frozen price, no valuation; an empty list has its own state', () => {
    const out = render(h(PmListView, { data: OLD.answer, onOpen: () => {} })), t = text(out);
    expect(out).toContain('data-testid="pm-delisted"'); expect(t).toContain('Retiré de la cote'); expect(t).toContain('Prix figé'); expect(t).toContain('1 619,3');
    expect(t).toMatch(/Non déductible du contrat — Marché retiré : le prix figé n’est pas un prix actuel/); expect(t).not.toContain('Valorisation implicite :');
    expect(text(render(h(PmListView, { data: { ...OLD.answer, markets: [], companies: [] }, onOpen: () => {} })))).toContain('Aucun marché retiré');
  });
});

describe('valuation panel — five distinct quantities', () => {
  it('io:ANTH: the five lines, numbered, each with its own figure; formula, source link with the date read, the quoted sentence', () => {
    const m = IO.answer.market, v = m.valuation, html = render(h(ValuationPanel, { v, now: IO.answer.ts, quote: 'USD' }));
    for (const id of ['pm-q-price', 'pm-q-contract', 'pm-q-exposure', 'pm-q-implied', 'pm-q-private', 'pm-premium']) expect(html).toContain(`data-testid="${id}"`);
    expect(html.indexOf('pm-q-price')).toBeLessThan(html.indexOf('pm-q-contract')); expect(html.indexOf('pm-q-exposure')).toBeLessThan(html.indexOf('pm-q-implied')); expect(html.indexOf('pm-q-implied')).toBeLessThan(html.indexOf('pm-q-private'));
    expect(part(html, 'pm-q-price')).toContain(`Prix synthétique ${pt(v.syntheticPrice.value, 'fr', 6)} USD`); expect(part(html, 'pm-q-price')).toContain('USD billions of fully diluted company valuation'); expect(part(html, 'pm-q-price')).toContain('Source :');
    expect(part(html, 'pm-q-contract')).toContain(`${cu(v.contractMarketValue.value, 'fr')} par contrat`);
    expect(part(html, 'pm-q-exposure')).toContain(cu(v.notionalExposure.value, 'fr')); expect(part(html, 'pm-q-exposure')).toContain('Position hypothétique : achat de 10 contrat(s)');
    const implied = part(html, 'pm-q-implied');
    expect(implied).toContain(cu(v.impliedValuation.value, 'fr')); expect(implied).toContain('estimation'); expect(implied).toContain('price × 1 000 000 000'); expect(implied).toContain('docs.entropy.io'); expect(implied).toContain('lue le 2026-11-15');
    expect(implied).toContain('a price of $1 represents $1B'); expect(html).toContain('href="https://docs.entropy.io/market-types/pre-ipo-perpetuals"');
    const priv = part(html, 'pm-q-private');
    expect(priv).toContain('965 G$'); expect(priv).toContain('tour de financement · 2026-05-28'); expect(priv).toContain('fiabilité : élevée'); expect(html).toContain('href="https://www.anthropic.com/news/series-h"');
    expect(text(html.slice(html.indexOf('data-testid="pm-premium"')))).toContain(`${pr(v.premiumDiscount.premiumBps, 'fr')} au-dessus de la dernière valorisation privée`);
    // the five figures are five different numbers
    expect(new Set([v.syntheticPrice.value, v.notionalExposure.value, v.impliedValuation.value, v.lastPrivateValuation!.value]).size).toBe(4);
  });
  it('xyz:ANT (per share): "non déductible du contrat" with the reason; price, contract value, exposure and the private valuation still shown; no premium', () => {
    const v = XYZ.answer.market.valuation, html = render(h(ValuationPanel, { v, now: XYZ.answer.ts, quote: 'USD' })), implied = part(html, 'pm-q-implied');
    expect(implied).toContain('Non déductible du contrat'); expect(implied).toContain('Coté par action, et aucun nombre d’actions dilué n’est publié de façon fiable.'); expect(implied).toContain('It is not a fair value reference');
    expect(implied).not.toMatch(/G\$/); expect(part(html, 'pm-q-contract')).toContain('par contrat'); expect(part(html, 'pm-q-private')).toContain('965 G$');
    const prem = text(html.slice(html.indexOf('data-testid="pm-premium"')));
    expect(prem).toContain('Non calculée'); expect(prem).not.toMatch(/[+−]\d/);
  });
  it('edgeX: unit not published → no valuation; in English too', () => {
    const v = EDGEX.answer.market.valuation;
    expect(part(render(h(ValuationPanel, { v, now: EDGEX.answer.ts, quote: 'USDC' })), 'pm-q-implied')).toContain('La plateforme ne publie pas l’unité du contrat.');
    const en = render(h(ValuationPanel, { v, now: EDGEX.answer.ts, quote: 'USDC' }), 'en');
    expect(part(en, 'pm-q-implied')).toContain('Cannot be derived from the contract'); expect(part(en, 'pm-q-implied')).toContain('The venue does not publish the unit of the contract.'); expect(part(en, 'pm-q-price')).toContain('Synthetic price');
    const cav = text(render(h(Caveats, { v })));
    expect(cav).toContain('Convention non confirmée par la plateforme — non appliquée.'); expect(cav).toContain('Marché étroit'); expect(cav).toContain('La même société est cotée ailleurs');
    expect(cav.indexOf('Marché étroit')).toBeLessThan(cav.indexOf('Un prix synthétique est le prix d’un dérivé'));
  });
  it('a delisted market: frozen price, three quantities refused, the frozen caveat first', () => {
    const v = VNTL.answer.market.valuation, html = render(h(ValuationPanel, { v, now: VNTL.answer.ts, quote: 'USD' }));
    expect(part(html, 'pm-q-price')).toContain('prix figé, marché retiré'); expect(part(html, 'pm-q-contract')).toContain('Non déductible du contrat'); expect(part(html, 'pm-q-exposure')).toContain('Non déductible du contrat');
    expect(part(html, 'pm-q-implied')).toContain('Marché retiré : le prix figé n’est pas un prix actuel.'); expect(html).not.toContain('1 619,3 G$');
    expect(text(render(h(Caveats, { v }))).indexOf('Prix figé d’un marché retiré.')).toBeLessThan(40);
  });
});

describe('the screen', () => {
  it('opens on the display-only notice (trading disabled, jurisdiction and contract-definition reasons), with the live / delisted filter', () => {
    const qc = new QueryClient(), el = (view?: string) => h(QueryClientProvider, { client: qc }, h(PrivateMarkets, { nav: () => {}, ...(view ? { view } : {}) }));
    const html = render(el()), t = text(html);
    expect(html).toContain('data-testid="pm-screen"'); expect(t).toContain('Marchés privés');
    expect(t).toContain('Affichage à titre d’information — négociation désactivée.'); expect(t).toContain('ne sont pas négociables depuis ce portefeuille'); expect(t).toMatch(/Juridiction : .*Canada/); expect(t).toMatch(/Définition des contrats : /);
    expect(html).toContain('role="radiogroup"'); expect(html).toMatch(/aria-checked="true"[^>]*>Actifs/); expect(html).toMatch(/aria-checked="false"[^>]*>Retirés/);
    expect(render(el('delisted'))).toMatch(/aria-checked="true"[^>]*>Retirés/); expect(text(render(el('delisted')))).toContain('les prix sont figés');
    const en = text(render(el(), 'en'));
    expect(en).toContain('Displayed for information — trading disabled.'); expect(en).toContain('cannot be traded from this wallet');
    expect(text(render(h(PmNotice, { compact: true })))).toBe('Affichage à titre d’information — négociation désactivée.');
  });
  it('accessibility and conventions of the source: rows are buttons with a name, sources open safely, no order call, no chart library', () => {
    const src = read('../src/screens/PrivateMarkets.tsx'), model = read('../src/privateMarkets.ts');
    expect(src).not.toMatch(/\bpost\(|api\(['"]POST|\/orders|\/accounts/);                       // read-only screen
    expect(src).toMatch(/import \{ get \} from '\.\.\/api'/);
    expect(src).not.toMatch(/from '(recharts|chart\.js|d3|lightweight-charts|echarts)/); expect(src).toContain("from '../chart'");
    expect(src).toMatch(/rel="noopener noreferrer"/); expect(src).toMatch(/aria-label=\{`\$\{m\.platform\}/); expect(src).toMatch(/disabled aria-disabled="true" data-testid="pm-trade-disabled"/);
    expect(model).not.toMatch(/from 'react'/);
    const app = read('../src/App.tsx');
    expect(app).toMatch(/private: \(\) => import\('\.\/screens\/PrivateMarkets'\)/); expect(app).not.toMatch(/^import .*PrivateMarkets/m);            // a lazy chunk, never in the first one
    expect(app.slice(app.indexOf('const queue = ['), app.indexOf('const next = ()'))).not.toContain('screens.private');
  });
});

describe('the `pm` block of i18n.ts', () => {
  const i18n = read('../src/i18n.ts'), start = i18n.indexOf('// >>> v11 Private Markets'), end = i18n.indexOf('// <<< end of the `pm` block');
  const block = i18n.slice(start, end), keys = [...block.matchAll(/(?:^|[\s,])(pm[A-Za-z_0-9]*): \[/g)].map((m) => m[1]!);
  it('is one contiguous block, every key prefixed pm, two non-empty languages', () => {
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(keys.length).toBeGreaterThan(120); expect(new Set(keys).size).toBe(keys.length);
    expect([...block.matchAll(/(?:^|[\s,])([A-Za-z_][A-Za-z_0-9]*): \[/g)].every((m) => m[1]!.startsWith('pm'))).toBe(true);
    expect([...(i18n.slice(0, start) + i18n.slice(end)).matchAll(/(?:^|[\s,])(pm[A-Z][A-Za-z_0-9]*): \[/g)]).toEqual([]);      // no pm key outside the block
  });
  it('every key the screen uses exists, and every key of the block is used', () => {
    const src = read('../src/screens/PrivateMarkets.tsx') + read('../src/privateMarkets.ts') + read('../src/App.tsx');
    const used = new Set([...src.matchAll(/'(pm[A-Z][A-Za-z_0-9]*)'/g)].map((m) => m[1]!));
    for (const p of ['pmConf_high', 'pmConf_medium', 'pmConf_low', 'pmReview_reviewed', 'pmReview_under_review', 'pmReview_not_reviewed']) used.add(p);   // built from a template (`pmConf_${…}`, `pmReview_${…}`)
    for (const k of used) expect(keys, k).toContain(k);
    for (const k of keys) expect(used.has(k), `unused key ${k}`).toBe(true);
  });
});
