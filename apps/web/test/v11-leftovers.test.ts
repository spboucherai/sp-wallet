// V11 interface pass — the audit leftovers in the web (docs/v11/work/ui.md, item 5):
//   B3 remainder: a server sentence is never printed on a French screen as if it were a sentence of the interface — it is
//     translated when the server's wording is known (reasonTexts.ts), quoted and marked as English otherwise (sv.ts `srvText`,
//     i18n.ts `errText`); an English screen is unchanged;
//   Private Markets: the standard « not tradable » codes have a text, source texts are marked as quotations;
//   the seven dead `rk*` keys are gone and no `rk*` key of the Risk block is unused;
//   the Asset page no longer calls a swap, a bridge or a GMX order « sent »;
//   the development mock answers the V11 sections and the quote websocket closes without the network;
//   `/risk?mandate=<id>` is a small, localized change of Risk.tsx that never opens an approval by itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hubList, hubRow, isQuoteStream, MockQuoteSocket, NOT_SIMULATED, v11Route, type V11Ctx } from '../src/derivatives/mockV11';
import type { Instrument } from '../src/derivatives/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18nTables } from '../scripts/i18n-split.mts';
import { errText, I18n, type Key, type Locale } from '../src/i18n';
import { notTradableKey, type PmDetail } from '../src/privateMarkets';
import { reasonKnown, reasonText } from '../src/reasonTexts';
import { PrivateMarkets } from '../src/screens/PrivateMarkets';
import { srvText } from '../src/srvText';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = `${dir}${f}`; return statSync(p).isDirectory() ? files(`${p}/`) : /\.tsx?$/.test(f) ? [p] : []; });
const TABLES = i18nTables(read('../src/i18n.ts'));
const tOf = (locale: Locale) => (k: Key, v?: Record<string, string | number>): string => { let s: string = TABLES[locale][k] ?? k; for (const [a, b] of Object.entries(v ?? {})) s = s.split(`{${a}}`).join(String(b)); return s; };
const fr = tOf('fr'), en = tOf('en');

describe('B3 remainder: server sentences', () => {
  it('errText: a translated code keeps the server\'s figures as a QUOTATION marked as English on a French screen, unchanged on an English one', () => {
    const e = { code: 'insufficient_funds', message: 'balance 3.5 USDC, needed 5' };
    expect(errText(fr, e)).toBe(`${fr('e_insufficient_funds' as Key)} (détail du serveur, en anglais : « balance 3.5 USDC, needed 5 »)`);
    expect(errText(en, e)).toBe(`${en('e_insufficient_funds' as Key)} (balance 3.5 USDC, needed 5)`);
    expect(errText(fr, { code: 'insufficient_funds', message: 'insufficient balance' })).toBe(fr('e_insufficient_funds' as Key));   // no figure: the translation alone
  });
  it('errText: an unknown code never prints the English sentence as if it were French', () => {
    const e = { code: 'never_heard_of_it', message: 'something specific' };
    expect(errText(fr, e)).toBe('Demande refusée par le serveur. Message d’origine (en anglais) : « something specific »');
    expect(errText(en, e)).toBe('something specific');
    expect(errText(fr, { code: 'never_heard_of_it' })).toBe('Demande refusée par le serveur (code never_heard_of_it).');
    expect(errText(fr, { name: 'NotAllowedError' })).toBe('');
  });
  it('srvText: known wording → French; unknown → a marked quotation; English screen → as sent; a code with a text wins', () => {
    expect(srvText(fr, 'fr', 'broadcast is disabled on this server; nothing was sent')).toBe('la diffusion est désactivée sur ce serveur ; rien n’a été envoyé');
    expect(srvText(fr, 'fr', 'the account holds hyperliquid:DOGE, which this agent does not manage')).toBe('le compte détient hyperliquid:DOGE, que cet agent ne gère pas');
    expect(srvText(fr, 'fr', 'venue says: order would cross')).toBe('Message du serveur (en anglais) : « venue says: order would cross »');
    expect(srvText(en, 'en', 'venue says: order would cross')).toBe('venue says: order would cross');
    expect(srvText(fr, 'fr', 'whatever the server wrote', 'broadcast_disabled')).toBe(fr('sv_broadcast_disabled' as Key));
    expect(srvText(fr, 'fr', null)).toBe(''); expect(srvText(fr, 'fr', '', 'some_code')).toBe('some_code');
  });
  it('every sentence the agent-withdrawal tracker, the research routes and the system-status connectors write has a French wording', () => {
    const api = (rel: string) => read(`../../../services/api/src/${rel}`);
    const wd = [...api('agents/withdrawals.ts').matchAll(/error: '([^']+)'/g)].map((m) => m[1]!);
    expect(wd.length).toBeGreaterThanOrEqual(6);
    for (const s of wd) expect(reasonKnown(s), s).toBe(true);
    for (const s of ['refused by the signer: daily limit', 'not relayed yet: nonce too low']) { expect(reasonKnown(s), s).toBe(true); expect(reasonText(s, 'fr')).toContain('en anglais'); }
    const health = [...api('monitor/health.ts').matchAll(/detail: (?:[^,]*\? )?'([^']+)'(?: : '([^']+)')?/g)].flatMap((m) => [m[1]!, m[2]].filter((x): x is string => !!x && !/^[, ]|\$/.test(x)));   // whole sentences (the pieces of a template are covered by the patterns below)
    expect(health.length).toBeGreaterThanOrEqual(8);
    for (const s of health) expect(reasonKnown(s), s).toBe(true);
    for (const s of ['3/4 endpoints', '2/3 endpoints, degraded, identity not verified', '5/8 series fresh', '2 transfer(s) awaiting attestation', 'Market data · coinbase', 'Signer']) expect(reasonText(s, 'fr'), s).not.toBe(s);
    for (const s of ['cancelled by the owner', 'the runner stopped reporting (no log line or heartbeat for 5 minutes)', 'no data set: no bars']) expect(reasonKnown(s), s).toBe(true);
    expect(reasonText('answering', 'en')).toBe('answering');
  });
  it('the screens of the audit\'s list no longer print these server fields raw', () => {
    const raw: [string, RegExp][] = [
      ['screens/AgentFund.tsx', />\{w\.error\}</], ['screens/PerpAgent.tsx', /\{a\.stopReason\}<\/Notice>|\{a\.hold\.reason\}|\{a\.flattening\.reason\}|\{a\.flag\.message\} \(/],
      ['screens/Research.tsx', />\{j\.reason\}<|\{t\('rjRefused'\)\} \{s\.reason\}/], ['screens/Monitor.tsx', />\{x\.detail\}|· \{x\.detail\}|>\{l\.lastError\}<|\$\{h\.lab\.reason\}|\$\{a\.stopReason\}/],
      ['screens/PerpAgentLive.tsx', />\{L\.reason\}</], ['screens/agentPanel.tsx', />\{w\.message\}<|\$\{job\.error\}|>\{d\.reason\}<|>\{o\.stopReason\}</],
    ];
    for (const [f, re] of raw) expect(re.test(read(`../src/${f}`)), f).toBe(false);
  });
});

describe('Private Markets: standard codes are translated, source texts are quotations', () => {
  const XYZ = JSON.parse(read('./fixtures/private-markets/detail-xyz-ANT.json')) as { answer: PmDetail }, EDGEX = JSON.parse(read('./fixtures/private-markets/detail-edgex-ANTHROPICUSDC.json')) as { answer: PmDetail };
  const render = (el: ReactElement, locale: Locale): string => renderToStaticMarkup(h(I18n.Provider, { value: { locale, setLocale: () => {} } }, el));
  /** the detail page over a recorded answer (the query's cache holds it: nothing is fetched) */
  const detail = (d: PmDetail, locale: Locale): string => { const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } }); qc.setQueryData(['pm-detail', d.market.id, 'long', '1'], d);
    return render(h(QueryClientProvider, { client: qc }, h(PrivateMarkets, { nav: () => {}, instrument: d.market.id })), locale); };
  it('the codes of « not tradable » have a sentence in both languages; an unknown code has the generic one', () => {
    expect(notTradableKey(XYZ.answer.market.notTradable.code)).toBe('v11LoPmNT_builder_dex_read_only');
    expect(notTradableKey(EDGEX.answer.market.notTradable.code)).toBe('v11LoPmNT_venue_restricted');
    expect(notTradableKey('new_code')).toBe('v11LoPmNT_other'); expect(notTradableKey(null)).toBe('v11LoPmNT_other');
  });
  it('French screen: the reason by code is in French, every English source sentence carries the « cité en anglais » tag and lang="en"; English screen: no tag', () => {
    const html = detail(XYZ.answer, 'fr');
    expect(html).toContain(fr('v11LoPmNT_builder_dex_read_only'));
    expect(html).toMatch(/data-testid="pm-not-tradable-why" data-code="builder_dex_read_only"/);
    const reasons = html.slice(html.indexOf('data-testid="pm-not-tradable"'));
    expect((reasons.match(/data-testid="pm-en"/g) ?? []).length).toBe(XYZ.answer.market.notTradable.reasons.length);
    expect(reasons).toContain('cité en anglais'); expect(reasons).toContain('lang="en"');
    expect(html).toMatch(/<dl lang="en" data-testid="pm-contract-terms"/);
    const enHtml = detail(XYZ.answer, 'en');
    expect(enHtml).not.toContain('data-testid="pm-en"'); expect(enHtml).toContain(en('v11LoPmNT_builder_dex_read_only'));
  });
});

describe('i18n: the `rk` block and the `v11Lo` keys', () => {
  const i18n = read('../src/i18n.ts'), src = files(SRC).filter((f) => !f.endsWith('/i18n.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');
  it('the seven dead keys of the Risk block are gone, and every remaining key of the block is used (literally or through a built family)', () => {
    for (const k of ['rkCollateral', 'rkMissingTitle', 'rkMissingBody', 'rkLimitsJson', 'rkHash', 'rkSheetPasskey', 'rkNewJson']) expect(new RegExp(`\\b${k}: \\[`).test(i18n), k).toBe(false);
    const a = i18n.indexOf('// >>> v11 Risk'), b = i18n.indexOf('// <<< end of the `rk` block');
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
    const keys = [...i18n.slice(a, b).matchAll(/(?:^|[\s,])(rk[A-Za-z0-9_]*): \[/g)].map((m) => m[1]!), families = [...new Set([...src.matchAll(/`(rk[A-Za-z0-9_]*)\$\{/g)].map((m) => m[1]!))];
    expect(keys.length).toBeGreaterThan(200);
    for (const k of keys) expect(new RegExp(`['"\`]${k}['"\`]`).test(src) || families.some((f) => k.startsWith(f)), `unused key: ${k}`).toBe(true);
  });
  it('every `v11Lo` key has its two texts and is used', () => {
    const keys = Object.keys(TABLES.fr).filter((k) => k.startsWith('v11Lo'));
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const k of keys) { const f = TABLES.fr[k]!, e = TABLES.en[k] ?? ''; expect(f.trim().length > 0 && e.trim().length > 0, k).toBe(true);
      expect(src.includes(`'${k}'`) || i18n.includes(`t('${k}'`), `unused key: ${k}`).toBe(true); }
  });
});

describe('the Asset page names the kind of an operation', () => {
  it('a swap, a cross-chain transfer and a GMX order are not « sent »', () => {
    const s = read('../src/screens/Asset.tsx');
    expect(s).not.toMatch(/i\.kind === 'receive' \? t\('received'\) : t\('sent'\)/);
    expect(s).toMatch(/i\.kind === 'gmx' \? t\('svKind_gmx'\)/);
  });
});

describe('the development mock serves the V11 sections', () => {
  const inst = (venue: string, base: string, status = 'active'): Instrument => ({ id: `${venue}:${base}`, venue, symbol: `${base}-USD`, base, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0.1', lotSize: '0.001', minOrderSize: null, minNotional: '10',
    maxLeverage: '20', marginModes: ['cross'], fundingIntervalSec: 3600, markPriceMethod: '', status } as unknown as Instrument);
  const tick = (mark: string, vol: string) => ({ instrument: '', mark, index: mark, mid: mark, funding: '0.0000125', openInterest: '100', volume24h: vol, change24h: '0.012' });
  const ctx: V11Ctx = { now: 1_800_000_000_000, venueName: (id) => id.toUpperCase(), markets: () => [{ inst: inst('hyperliquid', 'BTC'), ticker: tick('60000', '900') }, { inst: inst('dydx', 'BTC'), ticker: tick('60010', '500') }, { inst: inst('hyperliquid', 'ETH'), ticker: tick('3000', '700') }] };
  const q = (s = '') => new URLSearchParams(s);
  it('the explorer lists the mock\'s own perpetuals with the filters, the sort and the page of the real route', () => {
    const all = hubList(ctx, q()).json as { rows: { id: string; tradable: boolean; tradableReason: string | null; funding: { annualised: string } }[]; total: number; counts: { perp: number; spot: number }; venues: { id: string }[] };
    expect(all.rows.map((r) => r.id)).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH', 'dydx:BTC']);   // by volume, descending
    expect(all.counts).toMatchObject({ perp: 3, spot: 0 }); expect(all.venues.map((v) => v.id).sort()).toEqual(['dydx', 'hyperliquid']);
    expect(all.rows.find((r) => r.id === 'dydx:BTC')).toMatchObject({ tradable: false, tradableReason: 'dydx_jurisdiction' });
    expect(Number(all.rows[0]!.funding.annualised)).toBeCloseTo(0.0000125 * 8760, 6);
    expect((hubList(ctx, q('kind=spot')).json as { rows: unknown[] }).rows).toEqual([]);
    expect((hubList(ctx, q('q=eth')).json as { total: number }).total).toBe(1);
    expect((hubList(ctx, q('venue=hyperliquid&tradable=yes&sort=symbol&dir=asc&limit=1&offset=1')).json as { rows: { id: string }[]; total: number })).toMatchObject({ total: 2, rows: [{ id: 'hyperliquid:ETH' }] });
    expect(hubRow(inst('hyperliquid', 'SOL', 'halted'), tick('100', '1'), 'HL', 1)).toMatchObject({ tradable: false, tradableReason: 'instrument_halted', paper: true });
  });
  it('Risk, Private markets, unified orders, the Dashboard and Activity answer in the shape of the real routes; writes are refused cleanly', () => {
    const risk = v11Route('GET', '/risk/state', q(), ctx)!.json as { switches: { killSwitch: { on: boolean } }; exposure: Record<string, { positions: unknown[] }>; limits: { live: { missing: string[] } } };
    expect(risk.switches.killSwitch.on).toBe(false); expect(Object.keys(risk.exposure)).toEqual(['paper', 'live', 'liveTestnet']); expect(risk.limits.live.missing).toEqual([]);
    expect(v11Route('POST', '/risk/kill-switch', q(), ctx)).toEqual({ status: 503, json: NOT_SIMULATED });
    expect(v11Route('GET', '/mandates', q(), ctx)!.json).toEqual({ mandates: [] });
    expect(v11Route('GET', '/private-markets', q(), ctx)!.json).toMatchObject({ markets: [], companies: [], notice: { tradable: false } });
    expect(v11Route('GET', '/private-markets/xyz:ANT', q(), ctx)!.status).toBe(404);
    expect(v11Route('GET', '/trading/orders', q(), ctx)!.json).toMatchObject({ orders: [], nextCursor: null });
    expect(v11Route('POST', '/trading/commands', q(), ctx)!.status).toBe(503);
    const sum = v11Route('GET', '/dashboard/summary', q(), ctx)!.json as Record<string, any>;
    for (const s of [sum.books.paper, sum.books.live, sum.books.liveTestnet, sum.risk, sum.agents, sum.agentsPnl, sum.health, sum.audit]) expect(s).toMatchObject({ ok: false, error: { code: 'not_simulated' } });
    expect(v11Route('GET', '/dashboard/activity', q(), ctx)!.json).toMatchObject({ items: [], nextCursor: null, errors: [] });
    expect(v11Route('GET', '/portfolio', q(), ctx)!.json).toMatchObject({ balances: [], prices: null });
    expect(v11Route('GET', '/derivatives/venues', q(), ctx)).toBeNull(); expect(v11Route('GET', '/something/else', q(), ctx)).toBeNull();
  });
  it('the quote websocket closes by itself without the network; the mock is wired in mock.ts only (dev-only bundle)', async () => {
    (globalThis as { location?: unknown }).location ??= { origin: 'http://localhost:5173' };
    expect(isQuoteStream('ws://localhost:5173/api/v1/stream')).toBe(true); expect(isQuoteStream('ws://localhost:5173/api/v1/trading/stream')).toBe(false);
    const ws = new MockQuoteSocket('ws://localhost:5173/api/v1/stream'); let closed: number | undefined;
    ws.onclose = (e) => { closed = e.code; };
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toBe(1006); expect(ws.readyState).toBe(3);
    const importers = files(SRC).filter((f) => /from '\.\/mockV11'|from '\.\.\/derivatives\/mockV11'|mockV11'\)/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length));
    expect(importers).toEqual(['derivatives/mock.ts']);
    expect(read('../src/main.tsx')).toMatch(/if \(import\.meta\.env\.DEV\) \{[\s\S]*import\('\.\/derivatives\/mock'\)/);
  });
});

describe('/risk?mandate=<id>', () => {
  const s = read('../src/screens/Risk.tsx');
  it('scrolls to the mandate (no smooth scrolling under reduced motion), focuses it, opens its details, and says when the id is unknown', () => {
    expect(s).toMatch(/prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth'/);
    expect(s).toMatch(/data-mandate-card=\{m\.id\}/); expect(s).toMatch(/el\.focus\(\{ preventScroll: true \}\)/);
    expect(s).toMatch(/<Fold summary=\{t\('rkFields'\)\} open=\{m\.id === wanted\}>/); expect(s).toMatch(/<Fold summary=\{t\('rkEnforcement'\)\} open=\{m\.id === wanted\}>/);
    expect(s).toMatch(/data-testid="rk-mandate-unknown"/);
  });
  it('never opens the approval sheet from the link: `openApproval` is called from a click or after a creation only', () => {
    const calls = [...s.matchAll(/openApproval\(/g)].length, clicks = [...s.matchAll(/onClick=\{\(\) => void openApproval\(m\.id\)\}/g)].length, created = [...s.matchAll(/onCreated=\{\(id\) => \{[^}]*openApproval\(id\)/g)].length;
    expect(clicks).toBe(1); expect(created).toBe(1); expect(calls).toBe(clicks + created);   // + the definition is `const openApproval = (`
    expect(s.slice(s.indexOf('useEffect(() => { if (!wantedFound'), s.indexOf('}, [wanted, wantedFound, pageReady]);'))).not.toMatch(/setSheet|openApproval/);
  });
});
