/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-quote-fixtures.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Records REAL public websocket frames for the quote engine's tests (services/api/test/fixtures/quotes/):
//   hyperliquid-ws.json   bbo, candle, activeAssetCtx, l2Book and trades of BTC and of one builder-dex coin (xyz:ANT)
//   coinbase-ws.json      the Exchange feed: subscriptions ack, ticker and heartbeat of BTC-USD and ETH-USD, and the error to an unknown product
// Public market data only: no key, no account. Each recording keeps the frames SENT and the first frames of every channel.
// Run: npx tsx scripts/record-quote-fixtures.mts        (the edgeX and dYdX recordings are those of packages/derivatives/test/fixtures)
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../services/api/test/fixtures/quotes/', import.meta.url);
mkdirSync(OUT, { recursive: true });

async function record(name: string, url: string, sent: unknown[], keyOf: (m: any) => string, keep: number, ms: number, later: { afterMs: number; frame: unknown }[] = []): Promise<void> {
  const messages: unknown[] = [], counts: Record<string, number> = {}, all = [...sent];
  const recordedAt = new Date().toISOString();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { for (const s of sent) ws.send(JSON.stringify(s)); for (const l of later) setTimeout(() => { all.push(l.frame); ws.send(JSON.stringify(l.frame)); }, l.afterMs); };
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)), k = keyOf(m); counts[k] = (counts[k] ?? 0) + 1; if (counts[k]! <= keep) messages.push(m); };
    ws.onerror = () => reject(new Error(`${name}: websocket error`));
    setTimeout(() => { ws.close(); resolve(); }, ms);
  });
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify({ recordedAt, url, sent: all, trimmed: `the first ${keep} frames of each channel and market are kept`, counts, messages }, null, 1)}\n`);
  console.log(`${name}: ${messages.length} frames kept of ${Object.values(counts).reduce((s, x) => s + x, 0)} — ${JSON.stringify(counts)}`);
}

const hlSubs = ['BTC', 'xyz:ANT'].flatMap((coin) => [{ type: 'bbo', coin }, { type: 'activeAssetCtx', coin }, { type: 'l2Book', coin }, { type: 'trades', coin }, { type: 'candle', coin, interval: '1m' }]);
await record('hyperliquid-ws', 'wss://api.hyperliquid.xyz/ws', [...hlSubs.map((subscription) => ({ method: 'subscribe', subscription })), { method: 'ping' }],
  (m) => `${m.channel}:${m.data?.coin ?? m.data?.s ?? (Array.isArray(m.data) ? m.data[0]?.coin : '') ?? ''}`, 4, 15_000);
await record('coinbase-ws', 'wss://ws-feed.exchange.coinbase.com', [{ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker', 'heartbeat'] }],
  (m) => `${m.type}:${m.product_id ?? ''}`, 5, 8_000, [{ afterMs: 3_000, frame: { type: 'subscribe', product_ids: ['NOPE-USD'], channels: ['ticker'] } }]);
process.exit(0);
