// Records what the four venue adapters answer NOW, in the wallet's normalised models, for the markets-hub tests:
// instruments and tickers of every venue, and for BTC and ETH the order book (order-book venues), the GMX pool liquidity and
// 24 h of funding history. READ-ONLY public market data: no key, no account, no order.
// Run: npx tsx scripts/record-markets-hub-fixtures.mts
import { mkdirSync, writeFileSync } from 'node:fs';
// the API's configuration module wants these; nothing here opens a database or contacts the signer
Object.assign(process.env, { SPW_ORIGIN: 'https://record.invalid', SPW_RP_ID: 'record.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused-'.repeat(8),
  SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { createDefaultRegistry } = await import('../services/api/src/derivatives/venues.ts');

const dir = new URL('../services/api/test/fixtures/markets-hub/', import.meta.url);
mkdirSync(dir, { recursive: true });
const reg = createDefaultRegistry();
const PICK: Record<string, string[]> = {
  hyperliquid: ['BTC', 'ETH'], dydx: ['BTC-USD', 'ETH-USD'], edgex: ['BTCUSDC', 'ETHUSDC'],
  gmx: ['BTC/USD [WBTC.b-USDC]', 'BTC/USD [BTC-USDC]', 'ETH/USD [WETH-USDC]'],
};
const recordedAt = Date.now();
for (const v of reg.list()) {
  const a = v.adapter, out: Record<string, unknown> = { venue: v.id, recordedAt, recordedAtIso: new Date(recordedAt).toISOString() };
  const instruments = await a.instruments(); out.instruments = instruments;
  out.tickers = await a.tickers();
  const books: Record<string, unknown> = {}, funding: Record<string, unknown> = {};
  for (const s of PICK[v.id] ?? []) {
    if (!instruments.some((i) => i.symbol === s)) { console.log(`  ${v.id}: ${s} is not listed`); continue; }
    if (v.facts.hasOrderBook) books[s] = await a.book(s);
    try { funding[s] = (await a.fundingHistory(s, { start: recordedAt - 24 * 3_600_000 })).map((x) => ({ ts: x.ts, rate: x.rate })); } catch (e) { console.log(`  ${v.id}: no funding history for ${s}: ${(e as Error).message}`); }
  }
  out.books = books; out.funding = funding;
  if (a.liquidity) out.liquidity = (await a.liquidity()).filter((l) => (PICK[v.id] ?? []).some((s) => l.instrument === `${v.id}:${s}`));
  writeFileSync(new URL(`${v.id}.json`, dir), JSON.stringify(out));
  console.log(`${v.id}: ${instruments.length} instruments, ${(out.tickers as unknown[]).length} tickers, books ${Object.keys(books).join(', ') || '—'}, funding ${Object.keys(funding).join(', ') || '—'}`);
}
