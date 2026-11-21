/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-market-fixtures.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Records real answers of the three exchanges (public, read-only) as fixtures for services/api/test/market-*.test.ts.
// Each fixture keeps the exact URL the adapter built, the HTTP status, the body and the clock at recording time, so the
// tests replay the adapter against it without network. The requested range includes the bar that is still open.
// Run: npx tsx scripts/record-market-fixtures.mts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://record.invalid', SPW_RP_ID: 'record.invalid', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { bitstampSource, coinbaseSource, httpJson, krakenSource } = await import('../services/api/src/market/sources.ts');
const { INTERVAL_MS, expectedLastTs } = await import('../services/api/src/market/types.ts');
type Interval = keyof typeof INTERVAL_MS;

const dir = join(dirname(fileURLToPath(import.meta.url)), '../services/api/test/fixtures/market');
mkdirSync(dir, { recursive: true });
const now = Date.now();
const makers = { coinbase: coinbaseSource, bitstamp: bitstampSource, kraken: krakenSource };
const PLAN: [Interval, number][] = [['1h', 48], ['1d', 30], ['5m', 24]];

for (const [id, make] of Object.entries(makers)) {
  for (const [interval, n] of PLAN) {
    let seen: { url: string; status: number; body: unknown } | null = null;
    const src = make({ get: async (url) => { const r = await httpJson(url); seen = { url, ...r }; return r; } });
    const iv = INTERVAL_MS[interval], expected = expectedLastTs(interval, now);
    const range = { start: expected - (n - 1) * iv, end: expected + iv };
    const bars = await src.candles('BTC', interval, range, now);
    writeFileSync(join(dir, `${id}-BTC-${interval}.json`), JSON.stringify({ source: id, symbol: 'BTC', interval, recordedAt: now, range, ...seen! }, null, 1) + '\n');
    console.log(`${id} BTC ${interval}: http ${seen!.status}, ${bars.length} closed bars, last ${new Date(bars.at(-1)!.ts).toISOString()}`);
  }
  // an unknown pair, as each exchange really answers it
  const bad = { coinbase: 'https://api.exchange.coinbase.com/products/NOPE-USD/candles?granularity=3600', bitstamp: 'https://www.bitstamp.net/api/v2/ohlc/nopeusd/?step=3600&limit=5',
    kraken: 'https://api.kraken.com/0/public/OHLC?pair=NOPEUSD&interval=60' }[id]!;
  const r = await httpJson(bad);
  writeFileSync(join(dir, `${id}-unknown-pair.json`), JSON.stringify({ source: id, recordedAt: now, url: bad, ...r }, null, 1) + '\n');
  console.log(`${id} unknown pair: http ${r.status} ${JSON.stringify(r.body)}`);
}
