// V11 interface pass — the shell and Trade, tested without a browser:
//   navigation: five areas, where each screen lives, every old path still has a screen, the risk indicator never says « ok » by default;
//   Trade: the twelve order states (compared with the API's own list), UNKNOWN never drawn as a failure, the unified preview
//          request built from a panel's order, the command line's problems read from CODES, the answers to its questions;
//   i18n: the `v11` block (contiguous, two languages, same placeholders, every key used, every used key present), and — for the
//         whole app — every literal key a screen passes to `t(…)` exists;
//   structure: what must stay lazy stays lazy, the Markets list does not re-render on a tick, the first chunk does not import
//              what the pass put in its own chunks.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PARSE_ERROR_CODES, UNRESOLVABLE_CODES as CORE_UNRESOLVABLE } from '../../../packages/trading/src/commands/parse.ts';
import { ORDER_STATES as API_STATES, RISK_CHECK_IDS } from '../../../services/api/src/trading-api/spec.ts';
import { AREAS } from '../src/nav.ts';
import { riskLevel, type RiskStatus } from '../src/shell-more.tsx';
import { answerQuestion, attachedRole, byMode, checkCounts, checkKey, commandProblem, FINAL_STATES, isOpen, isSpotCommand, ORDER_STATES, PARSE_CODES, protectionsOf, QUESTION_FIELDS, RISK_CHECKS, sortChecks, STATE_LOOK, stateKey, stateLook, stateOf,
  toUnifiedRequest, UNRESOLVABLE_CODES, venueIn, type RiskCheck, type UnifiedOrder } from '../src/trade.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const i18n = read('../src/i18n.ts'), app = read('../src/App.tsx'), home = read('../src/screens/Home.tsx');
const walk = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [`${dir}${e.name}`] : []));
const files = walk('../src/').filter((f) => !f.endsWith('/i18n.ts') && !/\/derivatives\/mock[A-Za-z0-9]*\.ts$/.test(f));   // the development mocks have their own text tables (never in a production bundle)
const sources = files.map(read).join('\n') + i18n.slice(i18n.indexOf('} as const;'));   // + the functions of i18n.ts itself (errText), not its table

describe('navigation', () => {
  it('five areas, in one order, for the tab bar and the sidebar', () => {
    expect(AREAS.map((a) => a[0])).toEqual(['home', 'markets', 'trade', 'agents', 'activity']);
    expect(app).toContain('AREAS.map(');                                           // the phone's tab bar
    expect(read('../src/shell-more.tsx')).toContain('AREAS.map(');                 // the desktop sidebar
    expect(app).not.toMatch(/const MOBILE\b/);                                     // no second list that could drift
  });
  it('every screen lives in an area or is opened from the menu — and every path of the previous versions still has its screen', () => {
    const area = /export const areaOf = \(tab: Tab\): Area \| null => \(([^;]+)\);/.exec(app)![1]!;
    for (const [tab, a] of [['home', 'home'], ['assets', 'home'], ['asset', 'home'], ['receive', 'home'], ['send', 'home'], ['markets', 'markets'], ['private', 'markets'], ['swap', 'trade'], ['futures', 'trade'], ['plan', 'trade'],
      ['agents', 'agents'], ['agent', 'agents'], ['research', 'agents'], ['activity', 'activity']] as const) expect(area, tab).toMatch(new RegExp(`tab === '${tab}'[^:]*\\? '${a}'`));
    for (const p of ['/assets', '/alerts', '/monitor', '/markets', '/developer', '/risk', '/research']) expect(app, p).toContain(`location.pathname === '${p}'`);
    for (const re of [/\\\/asset\\\//, /\\\/agents\\\//, /\\\/plan\\\//, /\\\/private-markets/, /\\\/futures/]) expect(app).toMatch(re);
    for (const p of ['/trade', '/dashboard', '/compare', '/spot', '/perps']) expect(app, p).toContain(`'${p}': () =>`);
    expect(app).toContain("history.replaceState(null, '', pathOf(r))");            // an alias corrects the address bar, it does not stack a history entry
    expect(app).toContain("asset: q.get('mandate') ?? undefined");                 // /risk?mandate=<id>
  });
  it('the risk indicator: the worst state first, and never « ok » when the switches could not be read', () => {
    const sw = (kill: boolean, ro: boolean): RiskStatus['switches'] => ({ ok: true, data: { killSwitch: { on: kill }, readOnly: { on: ro } } });
    const lim = (refused: boolean): RiskStatus['liveLimits'] => ({ ok: true, data: { missing: refused ? 15 : 0, ownerOrdersRefused: refused } });
    expect(riskLevel(undefined)).toBe('unknown');
    expect(riskLevel({ switches: { ok: false }, liveLimits: lim(false) })).toBe('unknown');
    expect(riskLevel({ switches: sw(true, true), liveLimits: lim(true) })).toBe('kill');
    expect(riskLevel({ switches: sw(false, true), liveLimits: lim(true) })).toBe('readonly');
    expect(riskLevel({ switches: sw(false, false), liveLimits: lim(true) })).toBe('limits');
    expect(riskLevel({ switches: sw(false, false), liveLimits: { ok: false } })).toBe('ok');
    expect(riskLevel({ switches: sw(false, false), liveLimits: lim(false) })).toBe('ok');
  });
  it('what the first screen does not need is not in the first chunk; nothing is preloaded that was not before', () => {
    expect(app).toContain("const shellMore = () => import('./shell-more');");
    expect(app).not.toMatch(/^import \{[^}]*\} from '\.\/shell-more';/m);
    expect(read('../src/shell-more.tsx')).not.toMatch(/^import \{[^}]*\} from '\.\/App';/m);   // a value import of App would pull the shell out of the first chunk (a type import is erased)
    expect(home).toContain("lazy(() => import('./Dashboard')");
    expect(read('../src/sv.ts')).not.toContain('reasonTexts');                     // sv.ts is on the first screen's path; the table of server sentences is not
    const queue = /const queue = \[([^\]]+)\]/.exec(app)![1]!;
    for (const never of ['futures', 'markets', 'private', 'risk', 'developer', 'monitor', 'research']) expect(queue, never).not.toContain(`screens.${never}`);
  });
});

describe('Trade: the twelve states', () => {
  it('the same list as the API; every state has its look and its sentence in both languages', () => {
    expect([...ORDER_STATES]).toEqual([...API_STATES]);
    expect(Object.keys(STATE_LOOK).sort()).toEqual([...ORDER_STATES].sort());
    for (const s of ORDER_STATES) expect(i18n, s).toMatch(new RegExp(`\\bv11TrOs_${s}: \\['[^']+', '[^']+'\\]`));
    expect([...FINAL_STATES]).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'FAILED']);
  });
  it('UNKNOWN is « being verified with the venue »: not final, not a failure — and so is a state this bundle does not know', () => {
    expect(stateLook('UNKNOWN')).toEqual({ tone: 'info', icon: 'clock' });
    expect(i18n).toContain("v11TrOs_UNKNOWN: ['En vérification auprès de la plateforme', 'Being verified with the venue']");
    expect(stateOf('SOMETHING_NEWER')).toBe('UNKNOWN'); expect(stateKey('SOMETHING_NEWER')).toBe('v11TrOs_UNKNOWN');
    expect(stateLook('SOMETHING_NEWER').tone).not.toBe('danger');
    expect(isOpen({ status: 'UNKNOWN', final: false })).toBe(true);
    for (const s of ORDER_STATES) expect(STATE_LOOK[s].tone === 'danger', s).toBe(s === 'REJECTED' || s === 'FAILED');
    expect(isOpen({ status: 'FILLED', final: true })).toBe(false); expect(isOpen({ status: 'SUBMITTED', final: false })).toBe(true);
  });
  it('live and paper are two lists; attached protections are the open reduce-only stops and take-profits of the position', () => {
    const o = (x: Partial<UnifiedOrder>): UnifiedOrder => ({ id: 'o', mode: 'paper', venue: 'hyperliquid', network: 'mainnet', accountId: 'a', instrument: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', status: 'SUBMITTED', engineStatus: null, final: false, reduceOnly: true, createdAt: 1, updatedAt: 1, ...x });
    expect(byMode([o({ id: '1' }), o({ id: '2', mode: 'live' })])).toEqual({ live: [o({ id: '2', mode: 'live' })], paper: [o({ id: '1' })] });
    expect(attachedRole(o({}))).toBe('stop_loss'); expect(attachedRole(o({ type: 'take_profit_market' }))).toBe('take_profit');
    expect(attachedRole(o({ reduceOnly: false }))).toBeNull(); expect(attachedRole(o({ type: 'limit' }))).toBeNull();
    const pos = { accountId: 'a', instrument: 'hyperliquid:BTC', mode: 'paper' as const };
    expect(protectionsOf(pos, [o({ id: 's' }), o({ id: 'other-account', accountId: 'b' }), o({ id: 'live', mode: 'live' }), o({ id: 'done', status: 'FILLED', final: true }), o({ id: 'eth', instrument: 'hyperliquid:ETH' })]).map((x) => x.id)).toEqual(['s']);
  });
});

describe('Trade: the checks before a confirmation', () => {
  it('the order of a panel becomes the unified preview request without inventing or rounding anything', () => {
    const body = { instrument: 'hyperliquid:BTC', side: 'buy' as const, type: 'market' as const, size: '0.0077', price: '65000', triggerPrice: null, reduceOnly: false, tif: 'ioc' as const, leverage: '3', slippageBps: 50 };
    expect(toUnifiedRequest('paper', 'acct', body)).toEqual({ mode: 'paper', accountId: 'acct', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.0077', reduceOnly: false, tif: 'ioc', slippageBps: 50, leverage: '3' });
    // a venue account: the leverage is a venue setting, not a field of the order; a limit keeps its price, a stop its trigger
    expect(toUnifiedRequest('live', 'acct', { ...body, type: 'limit', tif: 'gtc', slippageBps: undefined })).toEqual({ mode: 'live', accountId: 'acct', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.0077', price: '65000', reduceOnly: false, tif: 'gtc' });
    expect(toUnifiedRequest('paper', 'acct', { ...body, type: 'stop_market', triggerPrice: '60000', reduceOnly: true })).toMatchObject({ triggerPrice: '60000', reduceOnly: true });
    expect('price' in toUnifiedRequest('paper', 'acct', { ...body, type: 'stop_market', triggerPrice: '60000' })).toBe(false);
  });
  it('every check id of the risk engine has a sentence; an unknown one keeps its id; failures come first', () => {
    expect([...RISK_CHECKS]).toEqual([...RISK_CHECK_IDS]);
    for (const id of RISK_CHECKS) { expect(checkKey(id)).toBe(`v11TrCk_${id}`); expect(i18n, id).toMatch(new RegExp(`\\bv11TrCk_${id}: \\['[^']+', '[^']+'\\]`)); }
    expect(checkKey('a_newer_check')).toBeNull();
    const c = (id: string, ok: boolean, exempt = false): RiskCheck => ({ id, ok, exempt, observed: null, limit: null, detail: '' });
    const list = [c('a', true), c('b', false), c('c', false, true), c('d', true)];
    expect(sortChecks(list).map((x) => x.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(checkCounts(list)).toEqual({ failed: 1, passed: 2, exempt: 1 });
  });
  it('the slot renders nothing outside the terminal, and both confirmation sheets carry it', () => {
    expect(read('../src/derivatives/orderChecks.tsx')).toContain('return render ? <>{render(p)}</> : null;');
    expect(read('../src/derivatives/OrderPanel.tsx')).toContain('<OrderChecksSlot mode="paper"');
    expect(read('../src/derivatives/LiveApproval.tsx')).toContain('<OrderChecksSlot mode="live"');
    const unified = read('../src/screens/TradeUnified.tsx');
    expect(unified).toMatch(/queryKey: \['trade', 'preview'[^\n]+staleTime: Infinity/);   // ONE preview per confirmation: it is recorded by the engine, never polled
    expect(unified).not.toMatch(/queryKey: \['trade', 'preview'[^\n]+refetchInterval/);
  });
});

describe('Trade: the command line', () => {
  const err = (code: string, data?: unknown) => ({ code, message: 'an English sentence the screen never prints', body: { error: code, data } });
  it('a refusal is read from its code and its data, never from its sentence', () => {
    expect(commandProblem(err('ambiguous_command', { questions: [{ field: 'venue', options: ['hyperliquid', 'gmx'], message: 'on which venue?' }] }))).toEqual({ kind: 'questions', questions: [{ field: 'venue', options: ['hyperliquid', 'gmx'], message: 'on which venue?' }] });
    expect(commandProblem(err('parse_error', { code: 'expected_perp', token: 1 }))).toEqual({ kind: 'parse', code: 'expected_perp', token: 1 });
    expect(commandProblem(err('no_position'))).toEqual({ kind: 'unresolvable', code: 'no_position' });
    expect(commandProblem(err('kill_switch_active', { failed: ['kill_switch'] }))).toEqual({ kind: 'refused', code: 'kill_switch_active', failed: ['kill_switch'], reasons: [] });
    expect(commandProblem(err('service_unavailable'))).toEqual({ kind: 'error', code: 'service_unavailable' });
    expect(commandProblem(new Error('x'))).toEqual({ kind: 'error', code: 'error' });
  });
  it('the codes of the grammar are the grammar\'s own, each with its sentence in both languages', () => {
    expect([...PARSE_CODES]).toEqual([...PARSE_ERROR_CODES]); expect([...UNRESOLVABLE_CODES]).toEqual([...CORE_UNRESOLVABLE]);
    for (const c of PARSE_CODES) expect(i18n, c).toMatch(new RegExp(`\\bv11TrParse_${c}: \\[`));
    for (const c of UNRESOLVABLE_CODES) expect(i18n, c).toMatch(new RegExp(`\\bv11TrUnres_${c}: \\[`));
    for (const f of QUESTION_FIELDS) expect(i18n, f).toMatch(new RegExp(`\\bv11TrQ_${f}: \\[`));
  });
  it('an answer goes into the line when the grammar can say it, into the owner\'s defaults otherwise — and a value that cannot be read is refused', () => {
    const line = 'LONG BTC-PERP 300';
    expect(answerQuestion(line, {}, 'venue', 'hyperliquid')).toEqual({ text: 'LONG BTC-PERP 300 ON hyperliquid' });
    expect(answerQuestion('LONG BTC-PERP 300 ON gmx', {}, 'venue', 'hyperliquid')).toEqual({ text: 'LONG BTC-PERP 300 ON hyperliquid' });
    expect(answerQuestion('LONG BTC-PERP 300 ON hyperliquid', {}, 'leverage', '2')).toEqual({ text: 'LONG BTC-PERP 300 x2 ON hyperliquid' });
    expect(answerQuestion(line, {}, 'instrument', 'gmx:BTC/USD [WBTC-USDC]')).toEqual({ text: 'LONG BTC-PERP 300 ON gmx' });
    expect(answerQuestion(line, { maxFeeBps: 5 }, 'marginMode', 'cross')).toEqual({ defaults: { maxFeeBps: 5, perpMarginMode: 'cross' } });
    expect(answerQuestion(line, {}, 'maxSlippageBps', '100')).toEqual({ defaults: { maxSlippageBps: 100 } });
    expect(answerQuestion(line, {}, 'orderTtlMs', '60')).toEqual({ defaults: { orderTtlMs: 60_000 } });               // typed in seconds
    expect(answerQuestion('LONG BTC-PERP 300 ON hyperliquid', {}, 'network', 'mainnet')).toEqual({ defaults: { perpNetworkByVenue: { hyperliquid: 'mainnet' } } });
    expect(answerQuestion(line, { perpVenue: 'gmx' }, 'network', 'arbitrum')).toEqual({ defaults: { perpVenue: 'gmx', perpNetworkByVenue: { gmx: 'arbitrum' } } });
    expect(answerQuestion('BUY ETH 100 USDC', {}, 'network', 'base')).toEqual({ defaults: { spotNetwork: 'base' } });
    expect(answerQuestion('SELL ETH 1', {}, 'quote', 'usdc')).toEqual({ text: 'SELL ETH 1 FOR USDC' });
    for (const [f, v] of [['maxSlippageBps', '501'], ['maxSlippageBps', '1.5'], ['maxFeeBps', '-1'], ['leverage', 'x2'], ['venue', 'Hyper Liquid'], ['marginMode', 'both'], ['network', 'mainnet'], ['orderTtlMs', '0'], ['venue', ' '], ['other', 'x']] as const) expect(answerQuestion(line, {}, f, v), `${f}=${v}`).toBeNull();
    expect(isSpotCommand('acheter ETH 100 USDC')).toBe(true); expect(isSpotCommand('LONG BTC-PERP 1')).toBe(false);
    expect(venueIn('CLOSE BTC-PERP 50% ON Hyperliquid')).toBe('hyperliquid'); expect(venueIn('SHOW POSITIONS')).toBeNull();
  });
  it('nothing runs without a dry run of the SAME line, and the run reuses one idempotency key', () => {
    const unified = read('../src/screens/TradeUnified.tsx');
    expect(unified).toContain("if (!run) runKey.current = idem();");
    expect(unified).toContain('tapi.command(cmd, mode, accountId, !run, run ? runKey.current : idem())');
    expect(unified).toContain("const stale = st.phase === 'preview' && st.text !== text.trim()");
    expect(unified).toMatch(/\{stale \? <Notice tone="warn">\{t\('v11TrCmdStale'\)\}<\/Notice>/);
  });
});

describe('live quotes: a tick re-renders its cell, not the list', () => {
  it('the Markets list, the unified blotter and the dashboard subscribe for their rows and read each figure in its own cell', () => {
    for (const f of ['../src/screens/Markets.tsx', '../src/screens/TradeUnified.tsx', '../src/screens/Dashboard.tsx']) {
      const src = read(f);
      expect(src, f).toContain('LiveCell');
      expect(src, f).not.toMatch(/\buseQuote\(|\buseQuotes\(|\buseBook\(|\buseTrades\(/);      // a hook here would re-render the whole list on every tick
    }
    expect(read('../src/screens/Markets.tsx')).toContain('useQuoteSubscriptions(');
    expect(read('../src/quotes-ui.tsx')).toMatch(/export function LiveCell[^]*?const q = useQuote\(id\)/);
  });
});

describe('i18n', () => {
  const a = i18n.indexOf('// >>> v11 interface pass'), b = i18n.indexOf('// <<< end of the `v11` block');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b(v11[A-Za-z0-9_]*): \[\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const keys = new Set(pairs.map((p) => p.key));
  it('the v11 block is contiguous; five sub-areas; every key has a French and an English text with the same placeholders', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bv11[A-Za-z0-9_]*: \[/g)).toBeNull();
    expect(keys.size).toBe(pairs.length); expect(pairs.length).toBe((block.match(/\bv11[A-Za-z0-9_]*: \[/g) ?? []).length);
    expect(pairs.length).toBeGreaterThan(400);
    for (const p of pairs) expect(/^v11(Nav|Db|Tr|Ac|Lo)[A-Z]/.test(p.key), p.key).toBe(true);
    for (const m of ['// v11Nav ·', '// v11Db ·', '// v11Tr ·', '// v11Ac ·', '// v11Lo ·']) expect(block).toContain(m);
    const vars = (x: string) => [...new Set([...x.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]!))].sort().join(',');
    for (const p of pairs) { expect(p.fr.length, p.key).toBeGreaterThan(0); expect(p.en.length, p.key).toBeGreaterThan(0); expect(vars(p.fr), p.key).toBe(vars(p.en)); }
  });
  it('every v11 key a screen names exists, and no key of the block is unused (families built at run time are counted by their prefix)', () => {
    const literal = new Set([...sources.matchAll(/['"`](v11[A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]!).filter((k) => !k.endsWith('_') && /^v11(Nav|Db|Tr|Ac|Lo)[A-Z]/.test(k)));
    for (const k of literal) expect(keys.has(k), `missing in i18n: ${k}`).toBe(true);
    const families = [...new Set([...sources.matchAll(/[`'"](v11[A-Za-z0-9]+_)(?:\$\{|['"`])/g)].map((m) => m[1]!))];
    expect(families.length).toBeGreaterThan(10);
    for (const f of families) expect([...keys].some((k) => k.startsWith(f)), `no key for the family ${f}`).toBe(true);
    const unused = [...keys].filter((k) => !literal.has(k) && !families.some((f) => k.startsWith(f)));
    expect(unused).toEqual([]);
  });
  it('whole app: every literal key passed to t(…) exists in the table (a key behind `as Key` is not checked by the compiler)', () => {
    const all = new Set([...i18n.matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*): \[\s*'/gm)].map((m) => m[1]!));
    expect(all.size).toBeGreaterThan(4000);
    const used = new Set([...sources.matchAll(/\bt\('([A-Za-z_][A-Za-z0-9_]*)'(?:\)|,| as Key)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(1500);
    expect([...used].filter((k) => !all.has(k)).sort()).toEqual([]);
  });
});
