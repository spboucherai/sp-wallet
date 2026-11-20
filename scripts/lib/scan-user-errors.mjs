// Lists the `UserError` codes thrown in a set of source files, with the HTTP statuses they are thrown with.
// A reading aid for the error catalogue of the wallet API (services/api/src/wallet-api/spec.ts) and the source of one test:
// node scripts/lib/scan-user-errors.mjs services/api/src/transfers.ts services/api/src/chains
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** every `new UserError('code', …[, status])` of a source text: code → statuses (400 is the default of the class) */
export function userErrorsOf(source) {
  const out = new Map();
  for (const m of source.matchAll(/new UserError\('([a-z0-9_]+)'/g)) {
    // walk to the closing parenthesis of this constructor call (strings and template literals are skipped)
    let i = m.index + m[0].length, depth = 1, quote = null, last = i;
    for (; i < source.length && depth > 0; i += 1) {
      const c = source[i];
      if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
      if (c === '\'' || c === '"' || c === '`') quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 1) last = i + 1;
    }
    const tail = source.slice(last, i - 1).trim(), status = /^\d{3}$/.test(tail) ? Number(tail) : 400;
    out.set(m[1], (out.get(m[1]) ?? new Set()).add(status));
  }
  return out;
}
export function filesOf(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((f) => filesOf(join(path, f))).filter((f) => f.endsWith('.ts'));
}
export function scan(paths) {
  const all = new Map();
  for (const f of paths.flatMap(filesOf)) for (const [code, st] of userErrorsOf(readFileSync(f, 'utf8'))) all.set(code, new Set([...(all.get(code) ?? []), ...st]));
  return all;
}

if (process.argv[1] && process.argv[1].endsWith('scan-user-errors.mjs')) {
  for (const [code, st] of [...scan(process.argv.slice(2))].sort(([a], [b]) => (a < b ? -1 : 1))) console.log(`${code}\t${[...st].sort().join(',')}`);
}
