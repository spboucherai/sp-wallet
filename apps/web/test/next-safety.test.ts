// NEXT web safety — the pure pieces of W3 (failed chunks), W4 (honest freshness), W5 (dust, one rule for « send », activity
// window) and of the accessibility fixes (arrow keys, focus trap). The flows themselves are in next-approval.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mergePages, withHead } from '../src/activity.ts';
import { setAmountLocale } from '../src/amount.ts';
import { isChunkError, mayAutoReload } from '../src/ErrorBoundary.tsx';
import { clockText } from '../src/freshness.tsx';
import { portfolioGaps, sendBlock, sendBlockKey, type Bal } from '../src/hooks.ts';
import { roveIndex, trapTarget, trimAmt } from '../src/ui.tsx';
import { APP_VERSION } from '../src/version.ts';

const NBSP = ' ';
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
afterEach(() => setAmountLocale('en'));

describe('W5 — dust never displays as "0"', () => {
  it('an amount below the last decimal shown reads "< 0.000001", in the screen’s language', () => {
    expect(trimAmt('0.0000001')).toBe(`<${NBSP}0.000001`); expect(trimAmt('0.000000000000000001')).toBe(`<${NBSP}0.000001`);
    expect(trimAmt('0.00000001', 8)).toBe('0.00000001'); expect(trimAmt('0.000000001', 8)).toBe(`<${NBSP}0.00000001`);
    setAmountLocale('fr'); expect(trimAmt('0.0000001')).toBe(`<${NBSP}0,000001`);
  });
  it('a true zero stays "0"; an amount with a shown part is truncated as before (never rounded up)', () => {
    expect(trimAmt('0')).toBe('0'); expect(trimAmt('0.000000')).toBe('0'); expect(trimAmt('0.0000019')).toBe('0.000001'); expect(trimAmt('1.0000001')).toBe('1');
    expect(trimAmt('12.3456789', 2)).toBe('12.34');
  });
  it('a text that is not a number is returned as it is', () => { expect(trimAmt('—')).toBe('—'); expect(trimAmt('?')).toBe('?'); });
  it('a negative dust does not read "0" either', () => { expect(trimAmt('-0.0000001')).toBe('> −0.000001'); });
});

describe('W4 — a partial total is labelled', () => {
  const b = (network: string, amount: string | null): Bal => ({ network, networkName: network.toUpperCase(), asset: 'native', symbol: 'X', name: 'X', decimals: 18, amount, display: amount, error: amount === null ? 'unavailable' : null });
  it('derived from the rows the server could not read', () => {
    expect(portfolioGaps({ balances: [b('base', '1'), b('solana', '0')] })).toEqual({ partial: false, missing: [] });
    expect(portfolioGaps({ balances: [b('base', '1'), b('solana', null), b('solana', null), b('ton', null)] })).toEqual({ partial: true, missing: ['SOLANA', 'TON'] });
  });
  it('reads `summary.complete` / `missing` when the server sends them, and still counts unreadable rows', () => {
    expect(portfolioGaps({ balances: [b('base', '1')], summary: { complete: true } })).toEqual({ partial: false, missing: [] });
    expect(portfolioGaps({ balances: [b('base', '1')], summary: { complete: false, missing: ['base', 'near'] } })).toEqual({ partial: true, missing: ['BASE', 'near'] });
    expect(portfolioGaps({ balances: [b('base', '1')], summary: { complete: false } })).toEqual({ partial: true, missing: [] });
    expect(portfolioGaps({ balances: [b('ton', null)], summary: { complete: true, missing: [] } }).partial).toBe(true);   // the rows win over a summary that says "complete"
    expect(portfolioGaps({ balances: [], summary: null })).toEqual({ partial: false, missing: [] });
  });
  it('Home says it: the label, the note, the read time and the « not up to date » banner', () => {
    const home = src('../src/screens/Home.tsx');
    for (const s of ['data-testid="total-partial"', "t('nxPartialBody'", "t('nxBalancesAt'", '<StaleBanner q={pf} />']) expect(home).toContain(s);
    expect(src('../src/freshness.tsx')).toMatch(/if \(!q\.isError \|\| q\.data === undefined\) return null;/);   // only when a refresh failed AND older values are shown
  });
  it('clockText: the time alone today, with the date otherwise', () => {
    const now = new Date(2026, 10, 19, 15, 0).getTime();
    expect(clockText(new Date(2026, 10, 19, 14, 5).getTime(), 'en', now)).toMatch(/2:05/); expect(clockText(new Date(2026, 10, 19, 14, 5).getTime(), 'fr', now)).toMatch(/14.*05/);
    expect(clockText(new Date(2026, 10, 18, 14, 5).getTime(), 'en', now)).toMatch(/18/); expect(clockText('not a date', 'en', now)).toBe('—');
  });
});

describe('W5 — one rule for « can a transfer be started? »', () => {
  it('halted, signer unreachable (or halt state unknown), free', () => {
    expect(sendBlock(undefined)).toBeNull();
    expect(sendBlock({ halted: false, signer: { reachable: true, addressesAsOf: '' } })).toBeNull(); expect(sendBlock({ halted: false })).toBeNull();
    expect(sendBlock({ halted: true, signer: { reachable: true, addressesAsOf: '' } })).toBe('halted');
    expect(sendBlock({ halted: false, signer: { reachable: false, addressesAsOf: '' } })).toBe('signer'); expect(sendBlock({ halted: null })).toBe('signer');
    expect([sendBlockKey('halted'), sendBlockKey('signer')]).toEqual(['nxSendOffHalted', 'nxSendOffSigner']);
  });
  it('Home, the asset page and Send all use it, each with the reason on screen', () => {
    for (const f of ['Home', 'Asset', 'Send']) { const s = src(`../src/screens/${f}.tsx`); expect(s).toMatch(/sendBlock\(/); expect(s).toMatch(/sendBlockKey\(block\)/); expect(s).not.toMatch(/disabled=\{!!pf\.data\.halted\}/); }
  });
});

describe('W5 — the asset page’s activity', () => {
  it('reads the widest window and never says « no activity » from a full window', () => {
    const s = src('../src/screens/Asset.tsx');
    expect(s).toMatch(/ACTIVITY_WINDOW = 500/); expect(s).toMatch(/windowFull \? t\('nxActivityWindow'/); expect(s).toContain('backOr(() => nav({ tab: \'home\' }))');
  });
});

describe('Activity — only the first page is re-read on the interval', () => {
  const page = (...ids: [string, string][]) => ({ items: ids.map(([id, status]) => ({ id, status })) }) as never;
  it('the fresh head is laid first, so its version of an item wins and nothing is lost', () => {
    const pages = [page(['c', 'old'], ['b', 'old']), page(['a', 'old'])], head = { page: page(['d', 'new'], ['c', 'new']), at: 200 };
    const merged = mergePages(withHead(pages, head, 100)) as unknown as { id: string; status: string }[];
    expect(merged.map((i) => `${i.id}:${i.status}`)).toEqual(['d:new', 'c:new', 'b:old', 'a:old']);
  });
  it('a head older than the pages (they were re-read since), or with no page yet, is left out', () => {
    const pages = [page(['c', 'fresh'])];
    expect(withHead(pages, { page: page(['c', 'stale']), at: 50 }, 100)).toEqual(pages); expect(withHead([], { page: page(['x', 'y']), at: 500 }, 0)).toEqual([]); expect(withHead(pages, null, 0)).toEqual(pages);
  });
  it('the infinite query itself has no interval', () => { const s = src('../src/screens/Activity.tsx'); expect(s).not.toMatch(/refetchInterval: 20_000 \}\);\n  const pages/); expect(s).toMatch(/setInterval\(tick, headMs\)/); expect(s).toMatch(/useFallbackInterval\(HEAD_REFRESH_MS, /); });
});

describe('query cache — kept a few minutes, never beyond the session', () => {
  it('gcTime is no longer 0, and the cache is emptied on lock, on 401 and when the server says the session is gone', () => {
    const main = src('../src/main.tsx'), app = src('../src/App.tsx');
    expect(main).toMatch(/CACHE_MS = 5 \* 60_000/); expect(main).toMatch(/gcTime: CACHE_MS/); expect(main).not.toMatch(/gcTime: 0 \}/);
    expect(app).toMatch(/setUnauthHandler\(\(\) => \{ dispatchEvent\(new Event\('spw-session-end'\)\); qc\.clear\(\);/);                 // 401
    expect(app).toMatch(/await post\('\/auth\/logout'\)\.catch\(\(\) => \{\}\); qc\.clear\(\);/);                                          // lock / logout
    expect(app).toMatch(/if \(signedOut\) qc\.removeQueries\(\{ predicate: \(q\) => q\.queryKey\[0\] !== 'auth' \}\)/);                    // session ended elsewhere
  });
});

describe('W3 — failed lazy chunks', () => {
  it('recognises a failed dynamic import in every engine’s words, and nothing else', () => {
    for (const m of ['Failed to fetch dynamically imported module: https://x/assets/Send-abc.js', 'error loading dynamically imported module', 'Importing a module script failed.', 'Unable to preload CSS for /assets/x.css'])
      expect(isChunkError(new TypeError(m))).toBe(true);
    for (const e of [new Error('Cannot read properties of undefined'), null, undefined, 'offline']) expect(isChunkError(e)).toBe(false);
  });
  it('one automatic reload: not again within two minutes', () => {
    expect(mayAutoReload(null, 1_000_000)).toBe(true); expect(mayAutoReload('garbage', 1_000_000)).toBe(true);
    expect(mayAutoReload(String(1_000_000 - 5000), 1_000_000)).toBe(false); expect(mayAutoReload(String(1_000_000 - 119_999), 1_000_000)).toBe(false);
    expect(mayAutoReload(String(1_000_000 - 120_000), 1_000_000)).toBe(true);
  });
  it('the app and every screen are under a boundary', () => {
    expect(src('../src/main.tsx')).toMatch(/<ErrorBoundary scope="app">/); const app = src('../src/App.tsx');
    expect(app).toMatch(/<ErrorBoundary scope="screen" resetKey=\{pathOf\(route\)\}>/); expect(app).toMatch(/<ErrorBoundary scope="app" resetKey=/);
  });
});

describe('accessibility — arrow keys and the focus trap', () => {
  it('roveIndex: next / previous with wrap-around; from nothing focused, the first or the last', () => {
    expect([roveIndex(0, 1, 3), roveIndex(2, 1, 3), roveIndex(0, -1, 3), roveIndex(1, -1, 3)]).toEqual([1, 0, 2, 0]); expect([roveIndex(-1, 1, 3), roveIndex(-1, -1, 3)]).toEqual([0, 2]);
  });
  it('trapTarget: Tab wraps at the ends, comes back inside from outside, and leaves the browser alone in the middle', () => {
    const a = 'a', b = 'b', c = 'c', panel = 'panel', list = [a, b, c];
    expect(trapTarget(list, c, false, panel)).toBe(a); expect(trapTarget(list, a, true, panel)).toBe(c);
    expect(trapTarget(list, b, false, panel)).toBeNull(); expect(trapTarget(list, b, true, panel)).toBeNull();
    expect(trapTarget(list, 'outside', false, panel)).toBe(a); expect(trapTarget(list, panel, true, panel)).toBe(c);
    expect(trapTarget([], 'outside', false, panel)).toBe(panel); expect(trapTarget([], panel, false, panel)).toBeNull();
  });
  it('Chips and Seg have one tab stop and the key handler; Sheet restores the focus and makes the background inert', () => {
    const ui = src('../src/ui.tsx');
    expect(ui.match(/onKeyDown=\{roveKeys\}/g)!.length).toBe(2); expect(ui.match(/tabIndex=\{value === /g)!.length).toBe(2);
    expect(ui).toMatch(/const hidden = inertOutside\(root\.current\);/); expect(ui).toMatch(/for \(const el of hidden\) el\.inert = false; if \(opener\?\.isConnected\) opener\.focus/);
  });
});

describe('W5 — version from the build', () => {
  it('no literal version in Settings; « dev » outside a Vite build', () => {
    expect(APP_VERSION).toBe('dev'); const s = src('../src/screens/Settings.tsx'); expect(s).toContain('{APP_VERSION}'); expect(s).not.toMatch(/1\.0\.0/);
    expect(src('../vite.config.ts')).toMatch(/define: \{ __SPW_VERSION__: JSON\.stringify\(`\$\{pkgVersion\} \(\$\{commit\(\)\}\)`\) \}/);
  });
});

describe('W1 — every flow that submits a passkey approval uses the shared helper', () => {
  const FLOWS = ['screens/Send.tsx', 'screens/Swap.tsx', 'bridge.tsx', 'plan.tsx', 'screens/NftSend.tsx', 'screens/AgentFund.tsx', 'screens/Agents.tsx', 'screens/PerpAgentLive.tsx', 'screens/mmPanel.tsx', 'screens/Risk.tsx', 'screens/Developer.tsx', 'screens/Security.tsx',
    'risk/mandate.tsx', 'risk/limits.tsx', 'derivatives/GmxConfirm.tsx', 'derivatives/GmxAuthorize.tsx', 'derivatives/LiveApproval.tsx', 'derivatives/LiveCollateral.tsx', 'derivatives/LiveAuthorize.tsx', 'derivatives/LiveOrderPanel.tsx'];
  it('each one calls it and draws its panel', () => {
    for (const f of FLOWS) { const s = src(`../src/${f}`); expect(s, f).toMatch(/useApprovalOutcome</); expect(s, f).toMatch(/[aA]p\.(run|send)[<(]/); expect(s, f).toMatch(/<ApprovalOutcomePanel ap=\{/); }
  });
  it('no file asks for a passkey assertion outside that list (the login and the pure API clients apart)', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url)), files: string[] = [];
    const scan = (d: string) => { for (const n of readdirSync(d)) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) scan(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
    scan(root);
    const using = files.filter((p) => /startAuthentication\(\{/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(root.length + 1)).filter((p) => p !== 'screens/Gate.tsx').sort();
    expect(using).toEqual([...FLOWS].sort());
  });
  it('no swallowed rejection of a proposal is left', () => {
    for (const f of FLOWS) expect(src(`../src/${f}`), f).not.toMatch(/\/reject`\)\.catch\(\(\) => \{\}\)/);
  });
  it('Send: no Approve and no Cancel while the outcome is unread; the key is not regenerated on a lost answer', () => {
    const s = src('../src/screens/Send.tsx');
    expect(s).toMatch(/\{!ap\.locked && <Btn full busy=\{!!busy\} disabled=\{needCheck && !checked\} onClick=\{approve\}/); expect(s).toMatch(/\{!ap\.locked && busy !== 'submit' && <Btn full kind="ghost"/);
    expect(s).toMatch(/catch \(e\) \{ fail\(e\); draft\.current\.failed\(e\); \}/); expect(s).not.toMatch(/setIdem\(crypto\.randomUUID\(\)\)/);
  });
});
