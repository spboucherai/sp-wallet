// Validates the logo set against the registry and generates the typed map the app imports (src/icons.gen.ts) and the
// human-readable provenance table (src/logos/SOURCES.md), both from the manifest src/logos/icons.json.
//
//   npx tsx apps/web/scripts/gen-icons.mts           # validate + (re)generate
//   npx tsx apps/web/scripts/gen-icons.mts --check   # validate only; exit 1 on any problem (also run by `vite build`)
//
// A build fails when: a registry symbol or network has neither a logo nor a declared fallback; a file named by the manifest
// is missing; an SVG is not in its sanitised canonical form or contains anything svg-sanitize.mts refuses; a raster is not a
// PNG/WebP of at least 128 px; a file lies in src/logos/ without being declared; the generated map is stale.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS } from '../../../packages/core/src/networks.ts';
import { cleanSvg, rasterSize, unsafeReason } from './svg-sanitize.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ICON_DIR = join(HERE, '../src/logos'), GEN_FILE = join(HERE, '../src/icons.gen.ts');
/** Networks that feature code is adding while this set was built: they must have a logo before they land. */
export const UPCOMING_NETWORKS = ['cardano', 'polkadot'];
export const VENUE_IDS = ['hyperliquid', 'gmx', 'dydx'], PROVIDER_IDS = ['kyberswap', 'jupiter', 'cctp', 'thorchain', 'lifi', 'debridge', 'maya'];

interface Entry { file?: string; source?: string; licence?: string; verified?: string; retrieved?: string; plate?: string; scale?: number; of?: string; asset?: string; note?: string; fallback?: string }
interface Manifest { note: string; licences: Record<string, { name: string; licence: string; url: string }>; assets: Record<string, Entry>; networks: Record<string, Entry>; venues: Record<string, Entry>; providers: Record<string, Entry> }
export const readManifest = (): Manifest => JSON.parse(readFileSync(join(ICON_DIR, 'icons.json'), 'utf8'));

/** every symbol the registry can show, with the first network where it is the native coin (its "home": no badge there) */
export function registry() {
  const symbols = new Set<string>(), home: Record<string, string> = {}, where: Record<string, string[]> = {};
  for (const [id, n] of Object.entries(NETWORKS)) { symbols.add(n.native.symbol); home[n.native.symbol] ??= id; for (const t of [n.native, ...n.tokens]) { symbols.add(t.symbol); (where[t.symbol] ??= []).push(id); } }
  // a symbol deployed on exactly one network: that network is its badge even where a screen does not say the network
  const only: Record<string, string> = {}; for (const [s, nets] of Object.entries(where)) if (nets.length === 1) only[s] = nets[0]!;
  return { symbols: [...symbols].sort(), networks: Object.keys(NETWORKS), home, only };
}

function checkFile(file: string, errors: string[]) {
  const p = join(ICON_DIR, file);
  if (!existsSync(p)) { errors.push(`${file}: file missing`); return; }
  const b = readFileSync(p);
  if (file.endsWith('.svg')) {
    const s = b.toString('utf8'); let clean = '';
    try { clean = cleanSvg(s); } catch (e) { errors.push(`${file}: ${(e as Error).message}`); return; }
    if (clean !== s) errors.push(`${file}: not in sanitised canonical form (run fetch-icons.mts or cleanSvg)`);
    const bad = unsafeReason(s); if (bad) errors.push(`${file}: refused — ${bad}`);
  } else {
    const d = rasterSize(b);
    if (!d) errors.push(`${file}: neither SVG, PNG nor WebP`); else if (d.w < 128 || d.h < 128) errors.push(`${file}: ${d.w}×${d.h} is under 128 px`);
  }
}

export function build(m: Manifest = readManifest()) {
  const errors: string[] = [], reg = registry(), used = new Set<string>();
  const def = (e: Entry) => ({ file: e.file!, ...(e.plate ? { plate: e.plate } : {}), ...(e.scale ? { scale: e.scale } : {}) });
  const asset = (sym: string, seen: string[] = []): { file: string; plate?: string; scale?: number } | null => {
    const e = m.assets[sym]; if (!e || seen.includes(sym)) return null;
    return e.of ? asset(e.of, [...seen, sym]) : e.file ? def(e) : null;
  };
  const assets: Record<string, object> = {}, networks: Record<string, object> = {}, venues: Record<string, object> = {}, providers: Record<string, object> = {}, fallbacks: string[] = [];
  for (const sym of new Set([...reg.symbols, 'ADA', 'DOT'])) {
    const e = m.assets[sym];
    if (!e) { errors.push(`asset ${sym}: in the registry, no logo and no declared fallback`); continue; }
    if (e.fallback) { fallbacks.push(sym); continue; }
    const d = asset(sym); if (!d) { errors.push(`asset ${sym}: entry resolves to no file`); continue; }
    used.add(d.file);
    assets[sym] = { ...d, ...(e.of ? { of: e.of } : {}), ...(reg.home[sym] ? { home: reg.home[sym] } : {}), ...(e.of && reg.only[sym] ? { only: reg.only[sym] } : {}) };
  }
  for (const sym of Object.keys(m.assets)) if (!assets[sym] && !m.assets[sym]!.fallback && !errors.some((x) => x.startsWith(`asset ${sym}:`))) { const d = asset(sym); if (d) { used.add(d.file); assets[sym] = { ...d, ...(m.assets[sym]!.of ? { of: m.assets[sym]!.of } : {}) }; } }
  const other = (kind: string, ids: string[], table: Record<string, Entry>, out: Record<string, object>) => {
    for (const id of ids) {
      const e = table[id]; if (!e) { errors.push(`${kind} ${id}: no logo and no declared fallback`); continue; }
      if (e.fallback) { fallbacks.push(`${kind}:${id}`); continue; }
      const d = e.asset ? asset(e.asset) : e.file ? def(e) : null;
      if (!d) { errors.push(`${kind} ${id}: entry resolves to no file`); continue; }
      used.add(d.file); out[id] = d;
    }
  };
  other('network', [...new Set([...reg.networks, ...UPCOMING_NETWORKS])], m.networks, networks);
  other('venue', VENUE_IDS, m.venues, venues); other('provider', PROVIDER_IDS, m.providers, providers);
  for (const f of used) checkFile(f, errors);
  for (const kind of ['asset', 'network', 'venue', 'provider']) for (const f of existsSync(join(ICON_DIR, kind)) ? readdirSync(join(ICON_DIR, kind)) : []) if (!used.has(`${kind}/${f}`)) errors.push(`${kind}/${f}: file not declared in icons.json`);
  for (const e of [...Object.values(m.assets), ...Object.values(m.networks), ...Object.values(m.venues), ...Object.values(m.providers)]) if (e.file && (!e.source || !e.licence || !e.retrieved)) errors.push(`${e.file}: source, licence or retrieval date missing`);

  const obj = (o: Record<string, object>) => Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v).replace(/"(\w+)":/g, '$1: ').replace(/"/g, "'").replace(/,/g, ', ')},`).join('\n');
  const code = `// GENERATED by apps/web/scripts/gen-icons.mts from src/logos/icons.json — do not edit by hand.
// file: path under src/logos/ · plate: disc drawn behind a free-form mark ('auto' = the theme's own plate) · scale: size of the mark on its plate
// of: the asset has no mark of its own, it shows this asset's logo and ALWAYS a network badge · home: the network where the coin is native (no badge there)
// only: an "of" asset that exists on a single network — that network is its badge even when the caller names none
export interface IconDef { file: string; plate?: string; scale?: number; of?: string; home?: string; only?: string }
export const ASSET_ICONS: Record<string, IconDef> = {\n${obj(assets)}\n};
export const NETWORK_ICONS: Record<string, IconDef> = {\n${obj(networks)}\n};
export const VENUE_ICONS: Record<string, IconDef> = {\n${obj(venues)}\n};
export const PROVIDER_ICONS: Record<string, IconDef> = {\n${obj(providers)}\n};
/** registry entries that deliberately keep the generic letter disc (no legitimate logo source) */
export const ICON_FALLBACKS: string[] = ${JSON.stringify(fallbacks)};
`;
  const row = (kind: string, id: string, e: Entry) => `| ${kind} | \`${id}\` | ${e.file ? `\`${e.file}\`` : e.of ? `logo of \`${e.of}\` + network badge` : e.asset ? `logo of asset \`${e.asset}\`` : `generic fallback: ${e.fallback}`} | ${e.source ? `<${e.source}>` : e.note ?? ''} | ${e.licence ?? ''} | ${e.verified ?? ''} | ${e.retrieved ?? ''} |`;
  const sources = `# Logo sources

${m.note}

Every file here is served by the wallet itself (hashed under \`/assets/\`, immutable): nothing is fetched from a third party at run time.
Each SVG passed \`apps/web/scripts/svg-sanitize.mts\` (no script, no foreignObject, no embedded or remote image, no external reference);
rasters are 192 px WebP made from the 256 px PNG of the source. No logo was redrawn, recoloured or cropped: a free-form mark is
only placed, whole and unmodified, on a round plate (the \`plate\` / \`scale\` fields of \`icons.json\`).

How a token's logo was chosen: **by contract address of a registry deployment**, not by ticker. The ticker-keyed collections were
compared with the address-keyed ones on 2026-11-11 and are wrong for several registry symbols (SKY → Skycoin, VELO → Velo,
DEGEN, TOSHI, tBTC, rETH, SNX, crvUSD, AAVE's previous mark), so they are used only for coins native to a network.

## Licences (read on the retrieval date)

${Object.values(m.licences).map((l) => `- **${l.name}** — ${l.licence} — <${l.url}>`).join('\n')}

MIT and Apache-2.0 allow redistribution with the notice kept (this file); CC0 has no condition; CC BY 4.0 asks for attribution
(given here). These licences cover the files, not the marks: every logo remains the trademark of its owner and is shown only to
identify the asset, network or service it designates.

## Table

| Kind | Id | File | Source | Licence | Checked against | Retrieved |
|---|---|---|---|---|---|---|
${[...Object.entries(m.assets).map(([k, e]) => row('asset', k, e)), ...Object.entries(m.networks).map(([k, e]) => row('network', k, e)), ...Object.entries(m.venues).map(([k, e]) => row('venue', k, e)), ...Object.entries(m.providers).map(([k, e]) => row('provider', k, e))].join('\n')}
`;
  const count = (o: object) => Object.keys(o).length;
  return { errors, code, sources, stats: { assets: count(assets), assetsOwnFile: Object.values(assets).filter((a: any) => !a.of).length, networks: count(networks), venues: count(venues), providers: count(providers), fallbacks, files: used.size, registrySymbols: reg.symbols.length, registryNetworks: reg.networks.length } };
}

/** used by `vite build` and by the tests */
export function checkIcons(): string[] {
  const r = build();
  if (!existsSync(GEN_FILE) || readFileSync(GEN_FILE, 'utf8') !== r.code) r.errors.push('src/icons.gen.ts is stale: run `npx tsx apps/web/scripts/gen-icons.mts`');
  return r.errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const r = build();
  if (!check && r.errors.length === 0) { writeFileSync(GEN_FILE, r.code); writeFileSync(join(ICON_DIR, 'SOURCES.md'), r.sources); }
  const errors = check ? checkIcons() : r.errors;
  for (const e of errors) console.error('icons:', e);
  console.log(`icons: ${r.stats.assets} assets (${r.stats.assetsOwnFile} with their own file, ${r.stats.assets - r.stats.assetsOwnFile} shown as underlying + badge) of ${r.stats.registrySymbols} registry symbols, ${r.stats.networks} networks (${r.stats.registryNetworks} in the registry), ${r.stats.venues} venues, ${r.stats.providers} providers, ${r.stats.files} files, fallbacks: ${r.stats.fallbacks.join(', ') || 'none'}`);
  if (errors.length) process.exit(1);
}
