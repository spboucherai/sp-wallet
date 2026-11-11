// v10 performance pass: what left the first chunk must still be whole. The per-language tables are exactly `D`; the lookup
// gives the same text with a table as without; the critical logos are real files of the set, few and small; the screens
// that are not the first one are separate chunks.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { i18nTables } from '../scripts/i18n-split.mts';
import { ASSET_ICONS, NETWORK_ICONS } from '../src/icons.gen.ts';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url)), src = (rel: string) => readFileSync(path(rel), 'utf8');

describe('one language at a time', () => {
  const source = src('../src/i18n.ts'), t = i18nTables(source);
  it('the two tables have every key of D, each with its own non-empty text', () => {
    const keys = [...source.slice(source.indexOf('const D = {'), source.indexOf('\n} as const;')).matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z_0-9]*): \[/g)].map((m) => m[1]!);
    expect(Object.keys(t.fr).length).toBeGreaterThan(2500);
    expect(new Set(keys).size).toBe(Object.keys(t.fr).length);                       // nothing invented, nothing lost
    expect(keys.length).toBe(new Set(keys).size);                                    // and no key written twice (the second would silently win)
    expect(Object.keys(t.en)).toEqual(Object.keys(t.fr));
    expect(t.fr.unlock).toBe('Déverrouiller avec la clé d’accès'); expect(t.en.unlock).toBe('Unlock with passkey');
    expect(t.fr.hdPaperTitle).toBe('SIMULATION — positions fictives, aucun fonds réel'); expect(t.en.flToneReal).toBe('Real — real money');
  });
  it('the app chunk keeps the code and none of the texts', () => {
    expect(t.stripped).toContain('const D = {\n} as const;'); expect(t.stripped).toContain('export function useT()');
    expect(t.stripped).not.toContain('Déverrouiller'); expect(t.stripped).not.toContain('Unlock with passkey');
    expect(t.stripped.length).toBeLessThan(6000);
  });
  it('a key that is not two non-empty strings stops the build', () => {
    expect(() => i18nTables("const D = {\n  a: ['un', ''],\n} as const;")).toThrow(/a must be/);
    expect(() => i18nTables("const D = {\n  a: ['un'],\n} as const;")).toThrow(/a must be/);
    expect(() => i18nTables('nothing here')).toThrow(/not found/);
  });
  it('with a table or without, the lookup answers the same (errText, stateKey: the two that test for a key)', async () => {
    const i18n = await import('../src/i18n.ts');
    const tr = (k: string) => k, before = [i18n.stateKey('finalized'), i18n.stateKey('nope'), i18n.errText(tr as never, { code: 'bad_address', message: 'x' }), i18n.errText(tr as never, { code: 'zz_unknown', message: 'server words' })];
    expect(i18n.hasLocaleTable('fr')).toBe(false);
    i18n.setLocaleTable('fr', t.fr);
    expect(i18n.hasLocaleTable('fr')).toBe(true);
    expect([i18n.stateKey('finalized'), i18n.stateKey('nope'), i18n.errText(tr as never, { code: 'bad_address', message: 'x' }), i18n.errText(tr as never, { code: 'zz_unknown', message: 'server words' })]).toEqual(before);
    expect(before).toEqual(['s_finalized', 's_draft', 'e_bad_address', 'server words']);
  });
  it('the app waits for the table before it draws, and before a change of language takes effect', () => {
    expect(src('../src/main.tsx')).toMatch(/await loadLocale\(localStorage\.getItem\('spw-locale'\) === 'en' \? 'en' : 'fr'\);[\s\S]*createRoot/);
    expect(src('../src/App.tsx')).toMatch(/void loadLocale\(l\)\.then\(\(\) => \{ localStorage\.setItem\('spw-locale', l\); document\.documentElement\.lang = l; setLocaleState\(l\); \}/);
  });
});

describe('critical logos and separate screens', () => {
  it('the critical few are files of the set, used by registry assets and networks, and stay small', async () => {
    const { CRITICAL_FILES, criticalUrl } = await import('../src/icons-critical.ts').catch(() => ({ CRITICAL_FILES: null, criticalUrl: null })) as { CRITICAL_FILES: readonly string[] | null; criticalUrl: ((f: string) => string | null) | null };
    // the module imports the SVGs through Vite's `?raw`; outside Vite it cannot load, so the list is read from its source
    const listed = CRITICAL_FILES ?? [...src('../src/icons-critical.ts').matchAll(/'((?:asset|network)\/[a-z0-9-]+\.svg)': /g)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThanOrEqual(6); expect(listed.length).toBeLessThanOrEqual(12);
    const used = new Set([...Object.values(ASSET_ICONS), ...Object.values(NETWORK_ICONS)].map((d) => d.file));
    let bytes = 0;
    for (const f of listed) { expect(used.has(f), f).toBe(true); expect(existsSync(path(`../src/logos/${f}`)), f).toBe(true); bytes += statSync(path(`../src/logos/${f}`)).size; }
    expect(bytes).toBeLessThan(24_000);
    for (const sym of ['BTC', 'ETH', 'USDC', 'USDT', 'SOL']) expect(listed, sym).toContain(ASSET_ICONS[sym]!.file);   // « Populaires » and the usual holdings
    for (const net of ['base', 'arbitrum', 'ethereum', 'solana', 'bitcoin']) expect(listed, net).toContain(NETWORK_ICONS[net]!.file);
    if (criticalUrl) expect(criticalUrl('asset/nope.svg')).toBeNull();
  });
  it('a logo outside the critical few asks for the set after the paint, never during it; a critical one never asks', () => {
    const s = src('../src/icons.tsx');
    expect(s).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => idle\(load\)\)\)/);
    expect(s).toMatch(/useIconsReady\(!!def && !crit\)/);
    expect(s).toMatch(/const url = def \? crit \?\? dataUrl!\(def\.file\) : null;/);
    expect(s).not.toMatch(/useState<'wait' \| 'ok' \| 'bad'>/);                      // no state update per loaded image any more
  });
  it('only the first screen is in the first chunk: every other screen is imported on demand', () => {
    const app = src('../src/App.tsx');
    for (const m of ['./screens/Swap', './screens/Send', './screens/Receive', './screens/Activity', './screens/Agents', './screens/Research', './plan', './screens/Security', './screens/Settings', './screens/Futures', './screens/Alerts', './screens/Monitor']) {
      expect(app, m).toMatch(new RegExp(`\\(\\) => import\\('${m.replace(/[./]/g, '\\$&')}'\\)`));
      expect(app, m).not.toMatch(new RegExp(`^import \\{[^}]*\\} from '${m.replace(/[./]/g, '\\$&')}';`, 'm'));
    }
    for (const m of ['./screens/Home', './screens/Assets', './screens/Asset', './screens/Gate']) expect(app, m).toMatch(new RegExp(`^import \\{[^}]*\\} from '${m.replace(/[./]/g, '\\$&')}';`, 'm'));
    expect(app).toMatch(/useEffect\(\(\) => \{ preloadScreens\(\); \}, \[\]\);/);
  });
});
