// What is in each JS chunk of the web build, module by module (rendered bytes before minification of the chunk as a whole,
// so the figures are relative weights, not the gzip of the file). Nothing is written: the build runs in memory.
//   cd apps/web && node --experimental-strip-types scripts/chunk-report.mts [chunk-name-prefix=index] [top=25]
import { build } from 'vite';

const [prefix = 'index', top = '25'] = process.argv.slice(2);
const out = await build({ logLevel: 'silent', build: { write: false } });
const bundles = Array.isArray(out) ? out : [out as { output: unknown[] }];
for (const b of bundles) for (const c of (b as { output: { type: string; name?: string; fileName: string; code?: string; modules?: Record<string, { renderedLength: number }> }[] }).output) {
  if (c.type !== 'chunk' || !c.fileName.includes(`/${prefix}`)) continue;
  const mods = Object.entries(c.modules ?? {}).map(([id, m]) => [id.replace(/^.*\/sp-wallet\/[^]*?\/(apps|packages|node_modules)\//, '$1/').replace(/^.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'npm:'), m.renderedLength] as const).sort((x, y) => y[1] - x[1]);
  console.log(`${c.fileName}  ${(c.code!.length / 1000).toFixed(2)} kB  (${mods.length} modules)`);
  for (const [id, n] of mods.slice(0, Number(top))) console.log(`  ${String(n).padStart(8)}  ${id}`);
}
