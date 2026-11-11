// v10 performance pass: `src/i18n.ts` keeps both languages side by side in `D` (370 kB). The web build and the dev server
// take the literal out of the app's chunk and write it as two tables, one per language (vite.config.ts `spw-i18n-split`,
// src/i18n-load.ts). This is the pure part: source text in, two tables and the source without the literal out.
// The literal must be plain data — `key: ['français', 'English'],` — a key without its two non-empty strings is an error.
const OPEN = 'const D = {', CLOSE = '\n} as const;';
export function i18nTables(source: string): { fr: Record<string, string>; en: Record<string, string>; stripped: string } {
  const a = source.indexOf(OPEN), b = source.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error('i18n: the `const D = { … } as const;` literal was not found in src/i18n.ts');
  const rows = new Function(`return ({${source.slice(a + OPEN.length, b)}\n})`)() as Record<string, unknown>;
  const fr: Record<string, string> = {}, en: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows)) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string' || !v[0] || !v[1]) throw new Error(`i18n: ${k} must be ['français', 'English']`);
    fr[k] = v[0]; en[k] = v[1];
  }
  return { fr, en, stripped: `${source.slice(0, a)}const D = {${source.slice(b)}` };
}
