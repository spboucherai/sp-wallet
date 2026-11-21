/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/examples/read-only.ts
 * Module           : trading-sdk
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

// Read-only tour of the SP Trading API. Needs a key with the read scopes:
//   SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] node packages/trading-sdk/examples/read-only.ts
// Nothing here can place an order. (From an installed package: import { … } from '@sp-wallet/trading-sdk'.)
import { AmbiguousSymbol, PermissionDenied, responseMeta, ServiceUnavailable, SPWallet } from '../src/index.ts';

const client = new SPWallet(); // SP_WALLET_API_KEY, SP_WALLET_BASE_URL
console.log(`client: ${String(client)}`);

async function section(name: string, run: () => Promise<string>): Promise<void> {
  try { console.log(`${name}: ${await run()}`); }
  catch (e) {
    // a key without the scope, or a venue that cannot be reached, is reported and the tour goes on
    if (e instanceof PermissionDenied || e instanceof ServiceUnavailable) console.log(`${name}: ${e.name} (${e.code})`);
    else throw e;
  }
}

await section('markets', async () => {
  const r = await client.listMarkets({ venue: 'hyperliquid', q: 'BTC', limit: 3 });
  return `${r.total} match, first: ${r.markets.map((m) => `${m.id} mark=${m.mark ?? 'n/a'} stale=${m.stale}`).join(', ') || 'none'}; rate limit ${responseMeta(r)?.rateLimit.remaining}/${responseMeta(r)?.rateLimit.limit}`;
});
await section('orderbook', async () => {
  const b = await client.getOrderbook('hyperliquid:BTC', { depth: 1 });
  return `best bid ${b.bids[0]?.[0] ?? 'n/a'} × ${b.bids[0]?.[1] ?? 'n/a'}, best ask ${b.asks[0]?.[0] ?? 'n/a'} (prices and sizes are decimal strings)`;
});
await section('candles', async () => {
  const c = await client.getCandles('hyperliquid:BTC', { interval: '1h', limit: 2 });
  return c.candles.map((k) => `${new Date(k.ts).toISOString()} close=${k.close}`).join(', ') || 'none';
});
await section('ambiguous symbol', async () => {
  try { await client.getMarket('BTC'); return 'not ambiguous'; }
  catch (e) { if (e instanceof AmbiguousSymbol) return `"BTC" is ambiguous, candidates: ${e.candidates.slice(0, 4).join(', ')}…`; throw e; }
});
await section('portfolio', async () => {
  const p = await client.getPortfolio();
  return `wallet ${p.totals.walletUsd ?? 'n/a'} USD, live venue equity ${p.totals.liveVenueEquity ?? 'n/a'}, paper equity ${p.totals.paperEquity ?? 'n/a'} (three separate figures), halted=${p.halted}`;
});
await section('balances', async () => {
  const b = await client.getBalances({ network: 'ethereum' });
  return `${b.balances.length} assets on ethereum, e.g. ${b.balances.slice(0, 2).map((x) => `${x.symbol}=${x.display ?? 'n/a'}`).join(', ')}`;
});
await section('positions', async () => `${(await client.getPositions()).positions.length} open`);
await section('orders', async () => `${(await client.listOrders({ limit: 5 })).orders.length} recent`);
await section('agents', async () => `${(await client.listAgents()).agents.length} agents`);
await section('risk', async () => { const r = await client.getRisk(); return `signer reachable=${r.killSwitch.signerReachable}, halted=${r.killSwitch.signerHalted}`; });
console.log('done');
