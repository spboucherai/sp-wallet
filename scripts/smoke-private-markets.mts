// Live READ-ONLY smoke of the Private Markets module: the real service (services/api/src/private-markets) over the real
// adapters — Hyperliquid's public info endpoint (builder dexes) and edgeX's public quote API. No database, no account, no
// key, no order: every outgoing request is listed by host and path, and anything that is not a public read is refused
// before it leaves the process.
// Run: npx tsx scripts/smoke-private-markets.mts [--size 10] [--side long] [--json <dir>]
//   --json <dir>   also writes the API answers (list, delisted list, two details, one company) as JSON — the recorded answers
//                  the web component tests render (apps/web/test/fixtures/private-markets/)
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
Object.assign(process.env, { SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused-'.repeat(8),
  SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });

const { createDerivatives, createDefaultRegistry } = await import('../services/api/src/derivatives/index.ts');
const { PrivateMarkets } = await import('../services/api/src/private-markets/service.ts');
type Row = import('../services/api/src/private-markets/service.ts').PrivateMarketRow;

const seen = new Map<string, number>();
const watched = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url)), method = init?.method ?? 'GET';
  let what = `${method} ${u.host}${u.pathname}`;
  if (u.host === 'api.hyperliquid.xyz') {
    if (u.pathname !== '/info') throw new Error(`refused: ${what} is not the public info endpoint`);
    what += ` ${JSON.parse(String(init?.body)).type}`;
  } else if (/private|account|order|exchange|submit/i.test(u.pathname)) throw new Error(`refused: ${what} is not a public read`);
  seen.set(what, (seen.get(what) ?? 0) + 1);
  return fetch(url, init);
}) as typeof fetch;

const d = createDerivatives({ registry: createDefaultRegistry({ fetch: watched }) });
const pm = new PrivateMarkets(d);
const position = { side: arg('side', 'long') as 'long' | 'short', size: arg('size', '10') };
const iso = (ts: number | null) => (ts === null ? '—' : new Date(ts).toISOString());
const usd = (x: string | null) => (x === null ? '—' : `$${Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const line = (k: string, v: unknown) => console.log(`    ${k.padEnd(24)} ${String(v)}`);

function show(m: Row): void {
  const v = m.valuation;
  console.log(`\n  ${m.id}   [${m.status}]   ${m.platform}`);
  line('company', m.company?.name ?? '(not identified)');
  line('review', `${m.review.state}${m.review.reasons.length ? ` — ${m.review.reasons.join('; ')}` : ''} (reviewed ${m.review.reviewedAt ?? '—'}, valid until ${m.review.validUntil ?? '—'})`);
  line('nature', m.contract.nature);
  line('unit', `${m.contract.unit.kind} — ${m.contract.unit.label}; quote ${m.contract.quoteCurrency}; collateral ${m.contract.collateral}`);
  line('metadata', `max leverage ${m.contract.maxLeverage}x, margin ${m.contract.margin}, lot ${m.contract.lotSize}, szDecimals ${m.contract.szDecimals ?? '—'}, asset id ${m.contract.assetId ?? '—'} (informational), OI cap ${usd(m.contract.oiCapUsd)}, funding multiplier ${m.contract.fundingMultiplier ?? '—'}`);
  line('price (mark)', `${m.market.price.value ?? '—'}${m.market.frozen ? '  FROZEN' : ''}   oracle/index ${m.market.oracle.value ?? '—'}   read ${iso(m.market.price.ts)}${m.market.price.stale ? '  STALE' : ''}`);
  line('funding', `${m.market.funding.value ?? '—'} per ${m.market.funding.intervalSec ?? '—'} s`);
  line('open interest', `${m.market.openInterest.value ?? '—'} contracts ≈ ${usd(m.market.openInterestUsd.value)} (wallet arithmetic)`);
  line('24 h volume', `${usd(m.market.volume24h.value)}  (${m.market.volumeBase24h.value ?? '—'} contracts)`);
  line('1 synthetic price', `${v.syntheticPrice.value ?? '—'}  [${v.syntheticPrice.unitLabel}]`);
  line('2 contract value', v.contractMarketValue.value !== null ? `${usd(v.contractMarketValue.value)} per contract` : `null — ${v.contractMarketValue.reason}`);
  line('3 notional exposure', v.notionalExposure.value !== null ? `${usd(v.notionalExposure.value)} for a hypothetical ${position.side} of ${position.size}` : `null — ${v.notionalExposure.reason}`);
  line('4 implied valuation', v.impliedValuation.value !== null ? `${usd(v.impliedValuation.value)}  = ${v.impliedValuation.formula}  [${v.impliedValuation.formulaSource?.url}, read ${v.impliedValuation.formulaSource?.readAt}]` : `null (${v.impliedValuation.reasonCode}) — ${v.impliedValuation.reason}`);
  line('5 last private val.', v.lastPrivateValuation ? `${usd(v.lastPrivateValuation.value)}  ${v.lastPrivateValuation.kind}, ${v.lastPrivateValuation.date}, confidence ${v.lastPrivateValuation.confidence}  [${v.lastPrivateValuation.sourceUrl}]` : `none — ${v.lastPrivateValuationReason}`);
  line('premium / discount', v.premiumDiscount.premiumBps !== null ? `${v.premiumDiscount.premiumBps} bps (${(Number(v.premiumDiscount.premiumBps) / 100).toFixed(2)} %)` : `null — ${v.premiumDiscount.reason}`);
  line('caveats', v.caveats.map((c) => c.code).join(', '));
  for (const c of v.caveats.filter((x) => x.code === 'thin_market' || x.code === 'cross_venue')) line(`  ${c.code}`, c.text);
  line('tradable', `${m.tradable} (${m.notTradable.code})`);
  if (m.error) line('ERROR', m.error);
}

console.log(`private markets smoke (read-only)  ${new Date().toISOString()}   hypothetical position: ${position.side} ${position.size}`);
const live = await pm.list({ position });
console.log(`\n== venues`);
for (const v of live.venues) line(v.venue, `${v.status}${v.error ? ` — ${v.error}` : ''}, ${v.instruments} instrument(s), read ${iso(v.ts)}`);
console.log(`\n== live inventory: ${live.markets.length} instrument(s), ${live.companies.length} companies`);
for (const m of live.markets) show(m);
console.log(`\n== companies (each venue separately; nothing is averaged)`);
for (const c of live.companies) {
  line(c.name, `${c.contracts.join(', ')}`);
  line('  last private val.', c.lastPrivateValuation ? `${usd(c.lastPrivateValuation.value)} (${c.lastPrivateValuation.kind}, ${c.lastPrivateValuation.date})` : 'none researched');
  for (const x of c.divergence) line('  divergence', `${x.unit}: ${x.contracts.map((k) => `${k.id} ${k.price}`).join(' | ')} → spread ${x.spreadBps} bps`);
}
console.log(`\n== excluded (public companies)`);
for (const e of live.excluded) line(e.id, `${e.company} — live category '${e.liveCategory}' — ${e.reason}`);

const old = await pm.list({ delisted: true, position });
console.log(`\n== delisted filter: ${old.markets.length} instrument(s)`);
for (const m of old.markets) show(m);
for (const e of old.excluded) line(`excluded ${e.id}`, e.reason);

console.log(`\n== detail hyperliquid:io:ANTH`);
const det = await pm.detail('hyperliquid:io:ANTH', { position });
const book = det.book as { bids?: [string, string][]; asks?: [string, string][]; error?: string }, candles = det.candles as { candles?: { ts: number; close: string }[]; interval?: string; error?: string };
line('book top', book.error ?? `bid ${book.bids?.[0]?.join(' × ')} / ask ${book.asks?.[0]?.join(' × ')}`);
line('candles', candles.error ?? `${candles.candles?.length} × ${candles.interval}, last close ${candles.candles?.at(-1)?.close} at ${iso(candles.candles?.at(-1)?.ts ?? null)}`);
line('references', det.references.map((r) => `${r.kind} ${r.date} ${r.valueUsd ?? '(range)'}`).join(' | '));
line('same company', det.sameCompany.map((s) => `${s.id} ${s.price.value} [${s.unit.kind}]`).join(' | '));

console.log(`\n== detail edgex:ANTHROPICUSDC`);
const ex = await pm.detail('edgex:ANTHROPICUSDC', { position }).catch((e: Error) => ({ error: e.message }));
if ('error' in ex) line('ERROR', ex.error);
else { const b = ex.book as { bids?: [string, string][]; asks?: [string, string][]; error?: string }, c = ex.candles as { candles?: unknown[]; interval?: string; error?: string };
  line('book top', b.error ?? `bid ${b.bids?.[0]?.join(' × ')} / ask ${b.asks?.[0]?.join(' × ')}`); line('candles', c.error ?? `${c.candles?.length} × ${c.interval}`);
  line('unconfirmed convention', ex.market.contract.unconfirmedConvention?.text ?? '—'); }

const dir = arg('json', '');
if (dir) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const out = (name: string, v: unknown) => writeFileSync(`${dir}/${name}.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), answer: v }, null, 1)}\n`);
  out('list', live); out('list-delisted', old); out('detail-io-ANTH', det); if (!('error' in ex)) out('detail-edgex-ANTHROPICUSDC', ex);
  out('detail-xyz-ANT', await pm.detail('hyperliquid:xyz:ANT', { position })); out('detail-vntl-ANTHROPIC', await pm.detail('hyperliquid:vntl:ANTHROPIC', { position }));
  out('company-anthropic', await pm.company('anthropic', { position }));
  console.log(`\nJSON answers written to ${dir}`);
}
console.log(`\n== outgoing requests (all public reads)`);
for (const [k, n] of [...seen].sort()) line(k, n);
console.log(`\nvenues without adapter (documented only): ${live.venuesWithoutAdapter.map((v) => v.venue).join(', ')}`);
d.data.close();
for (const v of d.registry.list()) (v.adapter as { close?: () => void }).close?.();
setTimeout(() => process.exit(0), 200).unref();
