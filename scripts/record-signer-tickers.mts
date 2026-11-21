/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-signer-tickers.mts
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

// Records the public tickers the signer's price view reads (Coinbase Exchange and Kraken), for the unit tests of
// services/isolated-signer/src/prices.ts. Read-only public endpoints; no key. The pair names come from the reviewed
// static table of listings, exactly as the signer resolves them.
// Run: node scripts/record-signer-tickers.mts [SYM,SYM…]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_LISTINGS } from '../packages/core/src/market-listings.ts';

const symbols = (process.argv[2] ?? 'ETH,BTC,LINK,AAVE,UNI,USDS,POL,HYPE,AVAX,BNB,XRP,DOGE,USDC,USDT,EUR').split(',');
const responses: Record<string, unknown> = {};
const get = async (url: string) => { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'price-check' }, signal: AbortSignal.timeout(10_000) }); responses[url] = r.ok ? await r.json() : { httpStatus: r.status }; };
for (const s of symbols) {
  const l = MARKET_LISTINGS[s];
  if (!l) throw new Error(`${s} is not in the listings table`);
  if (l.coinbase) await get(`https://api.exchange.coinbase.com/products/${l.coinbase}/ticker`);
  if (l.kraken) await get(`https://api.kraken.com/0/public/Ticker?pair=${l.kraken}`);
  await new Promise((r) => setTimeout(r, 400));
}
const out = join(import.meta.dirname, '../services/isolated-signer/test/fixtures/tickers.json');
writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), symbols, responses }, null, 1) + '\n');
console.log(`${Object.keys(responses).length} tickers recorded at ${new Date().toISOString()} -> ${out}`);
