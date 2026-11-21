/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-swap-kyberswap-fixtures.mts
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

// Records real answers of the KyberSwap Aggregator API (GET /routes only: price discovery, nothing is built or signed) into
// packages/swap/test/fixtures/kyberswap/. Each file keeps the request URL, the HTTP status, the time and the untouched body.
// Run: npx tsx scripts/record-swap-kyberswap-fixtures.mts   (about one request per second; the public limit is 3 rps)
import { mkdirSync, writeFileSync } from 'node:fs';
import { NETWORKS } from '@spw/core';

const BASE = 'https://aggregator-api.kyberswap.com';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const dir = new URL('../packages/swap/test/fixtures/kyberswap/', import.meta.url);
mkdirSync(dir, { recursive: true });
const tok = (net: string, sym: string) => NETWORKS[net]!.tokens.find((t) => t.symbol === sym)!.id;
const cases: [name: string, chain: string, tokenIn: string, tokenOut: string, amountIn: string][] = [
  ['ethereum-eth-usdc', 'ethereum', NATIVE, tok('ethereum', 'USDC'), '10000000000000000'],
  ['ethereum-usdc-wbtc', 'ethereum', tok('ethereum', 'USDC'), tok('ethereum', 'WBTC'), '50000000'],
  ['base-usdc-eth', 'base', tok('base', 'USDC'), NATIVE, '25000000'],
  ['arbitrum-usdc-link', 'arbitrum', tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), '30000000'],
  ['polygon-pol-usdc', 'polygon', NATIVE, tok('polygon', 'USDC'), '100000000000000000000'],
  ['optimism-eth-usdc', 'optimism', NATIVE, tok('optimism', 'USDC'), '10000000000000000'],
  ['bsc-bnb-fdusd', 'bsc', NATIVE, tok('bsc', 'FDUSD'), '40000000000000000'],
  ['avalanche-usdc-usdt', 'avalanche', tok('avalanche', 'USDC'), tok('avalanche', 'USDT'), '20000000'],
  ['hyperevm-hype-usdc', 'hyperevm', NATIVE, tok('hyperevm', 'USDC'), '1000000000000000000'],
  ['no-route-1-wei', 'ethereum', NATIVE, tok('ethereum', 'USDC'), '1'],
  ['error-unknown-token', 'ethereum', NATIVE, '0x000000000000000000000000000000000000dEaD', '10000000000000000'],
  ['error-malformed-token', 'ethereum', NATIVE, 'nothex', '10000000000000000'],
  ['error-amount-too-large', 'ethereum', NATIVE, tok('ethereum', 'USDC'), '1000000000000000000000000000000000'],
  ['error-unknown-chain', 'notachain', NATIVE, tok('ethereum', 'USDC'), '10000000000000000'],
];
for (const [name, chain, tokenIn, tokenOut, amountIn] of cases) {
  const url = `${BASE}/${chain}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const t0 = Date.now();
  const r = await fetch(url, { headers: { accept: 'application/json', 'x-client-id': process.env.KYBERSWAP_CLIENT_ID ?? 'swap-router' } });
  const text = await r.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify({ recordedAt: new Date(t0).toISOString(), url, status: r.status, body }, null, 1) + '\n');
  console.log(name.padEnd(26), r.status, `${Date.now() - t0} ms`, text.slice(0, 150).replace(/\s+/g, ' '));
  await new Promise((res) => setTimeout(res, 1000));
}
