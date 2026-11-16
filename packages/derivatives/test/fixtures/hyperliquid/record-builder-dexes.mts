// Records real answers of the PUBLIC, READ-ONLY Hyperliquid info endpoint about builder-deployed (HIP-3) perp dexes, as fixtures
// for test/hyperliquid/builder-dexes.test.ts. Nothing is signed, nothing is sent to /exchange, no account is read.
// Run from the repository root:  node packages/derivatives/test/fixtures/hyperliquid/record-builder-dexes.mts
import { writeFileSync } from 'node:fs';

const API = 'https://api.hyperliquid.xyz/info';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string, v: unknown) => { writeFileSync(new URL(`./${name}.json`, import.meta.url), `${JSON.stringify(v, null, 1)}\n`); console.log(`  ${name}.json`); };

async function info(request: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const text = await r.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  await sleep(300);
  return { status: r.status, body };
}
async function record(name: string, request: Record<string, unknown>, trim?: (body: any) => unknown) {
  const { status, body } = await info(request);
  out(`builder-${name}`, { recordedAt: new Date().toISOString(), network: 'mainnet', request, status, body: trim && status === 200 ? trim(body) : body });
  return body;
}

const DEXES = ['xyz', 'io', 'para', 'vntl'];
/** the per-dex lists of perpDexs are long (one entry per asset): kept whole for the dexes under test, cut to 3 entries elsewhere */
const trimDexes = (body: any[]) => body.map((d) => d === null || DEXES.includes(d.name) ? d
  : Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 3) : v])));

await record('perpDexs', { type: 'perpDexs' }, trimDexes);
const categories = await record('perpCategories', { type: 'perpCategories' });
for (const dex of DEXES) await record(`metaAndAssetCtxs-${dex}`, { type: 'metaAndAssetCtxs', dex });
// allPerpMetas: margin tables dropped (large, unused); universes whole — the asset ids depend on every index
await record('allPerpMetas', { type: 'allPerpMetas' }, (b: any[]) => b.map((m) => ({ ...m, marginTables: [] })));

const preipo: string[] = (categories as [string, string][]).filter(([, c]) => c === 'preipo').map(([coin]) => coin);
console.log('preipo coins:', preipo.join(', '));
// perpAnnotation: every attempt is kept, in order — the endpoint answers `null` under load, then the object (dossier §1.1)
const annotations: Record<string, { attempts: unknown[] }> = {};
const burst = await Promise.all(preipo.map(async (coin) => {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'perpAnnotation', coin }) });
  return [coin, r.status === 200 ? await r.json() : { httpStatus: r.status }] as const;
}));
for (const [coin, first] of burst) annotations[coin] = { attempts: [first] };
await sleep(1500);
for (const coin of preipo) {
  for (let k = 0; k < 3; k++) {
    const last = annotations[coin]!.attempts.at(-1);
    if (last !== null && !(typeof last === 'object' && last !== null && 'httpStatus' in last)) break;
    annotations[coin]!.attempts.push((await info({ type: 'perpAnnotation', coin })).body);
    await sleep(700);
  }
}
for (const coin of ['xyz:SPCX']) annotations[coin] = { attempts: [(await info({ type: 'perpAnnotation', coin })).body] };
out('builder-perpAnnotation', { recordedAt: new Date().toISOString(), network: 'mainnet', request: { type: 'perpAnnotation', coin: '<each key>' }, status: 200, body: annotations });

const end = Date.now();
for (const coin of ['xyz:ANT', 'io:ANTH']) {
  await record(`l2Book-${coin.replace(':', '-')}`, { type: 'l2Book', coin }, (b: any) => ({ ...b, levels: b.levels.map((l: any[]) => l.slice(0, 20)) }));
  await record(`candleSnapshot-${coin.replace(':', '-')}-1h`, { type: 'candleSnapshot', req: { coin, interval: '1h', startTime: end - 48 * 3_600_000, endTime: end } });
}
await record('candleSnapshot-vntl-ANTHROPIC-1d', { type: 'candleSnapshot', req: { coin: 'vntl:ANTHROPIC', interval: '1d', startTime: Date.UTC(2026, 4, 1), endTime: end } });
await record('l2Book-vntl-ANTHROPIC', { type: 'l2Book', coin: 'vntl:ANTHROPIC' });
