/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-tokens.mts
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

// Read-only check of the generated token registry against the live networks. Nothing is signed or sent.
//   node scripts/smoke-tokens.mts            every registry token, on BOTH RPC endpoints of its network: code exists,
//                                            symbol()/decimals() as registered, totalSupply() > 0 (Solana: mint owner/decimals/supply)
//   node scripts/smoke-tokens.mts --kyber    also asks KyberSwap for a route native -> token and token -> native (EVM networks where
//                                            swap execution is enabled), about one request per 1.2 s; tokens without a route are listed
// Writes research/token-verification.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hexToBigInt, hexToNumber, hexToString, parseUnits } from 'viem';
import { KYBER_ENABLED, KYBER_NATIVE, NETWORKS, type AssetDef, type NetworkDef } from '@spw/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  for (let k = 0; k < 5; k++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json() as any; if (j.error) throw new Error(j.error.message); if (j.result === undefined) throw new Error('no result (rate limit?)'); return j.result;
    } catch (e) { if (k === 4) throw e; await sleep(1000 * (k + 1)); }
  }
}
const str = (raw: `0x${string}`): string => { try { return decodeAbiParameters([{ type: 'string' }], raw)[0]; } catch { return hexToString(raw, { size: 32 }); } };
const fn = (name: 'symbol' | 'decimals' | 'totalSupply') => encodeFunctionData({ abi: erc20Abi, functionName: name });
async function evm(url: string, t: AssetDef): Promise<string | null> {
  if ((await rpc(url, 'eth_getCode', [t.id, 'latest'])) === '0x') return 'no code';
  const c = (data: string) => rpc(url, 'eth_call', [{ to: t.id, data }, 'latest']);
  const sym = str(await c(fn('symbol'))), dec = hexToNumber(await c(fn('decimals'))), supply = hexToBigInt(await c(fn('totalSupply')));
  if (sym !== (t.onchainSymbol ?? t.symbol)) return `symbol "${sym}"`;
  if (dec !== t.decimals) return `decimals ${dec}`;
  return supply > 0n ? null : 'zero supply';
}
async function sol(url: string, t: AssetDef): Promise<string | null> {
  const a = (await rpc(url, 'getAccountInfo', [t.id, { encoding: 'jsonParsed', commitment: 'finalized' }])).value;
  const want = t.program === 'token2022' ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  if (!a || a.data?.parsed?.type !== 'mint' || a.owner !== want) return 'not a mint of the registered program';
  if (a.data.parsed.info.decimals !== t.decimals) return `decimals ${a.data.parsed.info.decimals}`;
  return BigInt(a.data.parsed.info.supply) > 0n ? null : 'zero supply';
}
async function tron(url: string, t: AssetDef): Promise<string | null> {
  const c = async (selector: string) => { for (let k = 0; ; k++) { const j = await (await fetch(url + '/wallet/triggerconstantcontract', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ owner_address: t.id, contract_address: t.id, function_selector: selector, parameter: '', visible: true }) })).json().catch(() => null) as any;
    if (j?.constant_result?.[0]) return `0x${j.constant_result[0]}` as `0x${string}`; if (k === 4) throw new Error('call failed'); await sleep(1500 * (k + 1)); } };
  const sym = str(await c('symbol()')), dec = hexToNumber(await c('decimals()')), supply = hexToBigInt(await c('totalSupply()'));
  if (sym !== (t.onchainSymbol ?? t.symbol)) return `symbol "${sym}"`;
  if (dec !== t.decimals) return `decimals ${dec}`;
  return supply > 0n ? null : 'zero supply';
}
const nets = (Object.values(NETWORKS) as NetworkDef[]).filter((n) => n.tokens.length > 0);
const onchain: { network: string; symbol: string; address: string; endpoint: string; ok: boolean; problem: string | null }[] = [];
await Promise.all(nets.map(async (n) => {
  const read = n.family === 'evm' ? evm : n.family === 'sol' ? sol : n.family === 'tron' ? tron : null;
  if (!read) return;
  for (const t of n.tokens) for (const url of n.rpc) {
    let problem: string | null;
    try { problem = await read(url, t); } catch (e) { problem = `unreachable: ${(e as Error).message.slice(0, 80)}`; }
    onchain.push({ network: n.id, symbol: t.symbol, address: t.id, endpoint: new URL(url).host, ok: problem === null, problem });
    await sleep(n.family === 'evm' ? 60 : 700);
  }
}));
const bad = onchain.filter((r) => !r.ok);
for (const n of nets) console.log(`${n.id.padEnd(10)} ${String(n.tokens.length).padStart(3)} tokens, ${onchain.filter((r) => r.network === n.id && r.ok).length}/${n.tokens.length * n.rpc.length} endpoint checks ok`);
for (const r of bad) console.log('FAIL', r.network, r.symbol, r.address, r.endpoint, r.problem);

const OUT = 'research/token-verification.json';
let routes: { network: string; symbol: string; address: string; buy: string | null; sell: string | null }[] = [];
if (process.argv.includes('--kyber')) {
  const NATIVE_IN: Record<string, string> = { ETH: '0.004', POL: '60', BNB: '0.015', AVAX: '0.6', HYPE: '0.25' }; // roughly 10 USD
  const quote = async (net: string, tIn: string, tOut: string, amount: bigint): Promise<bigint | null> => {
    for (let k = 0; k < 4; k++) {
      await sleep(1200);
      try {
        const r = await fetch(`https://aggregator-api.kyberswap.com/${net}/api/v1/routes?tokenIn=${tIn}&tokenOut=${tOut}&amountIn=${amount}&excludeRFQSources=true&excludedSources=kyberswap-limit-order-v2,kyberswap-limit-order`, { headers: { 'x-client-id': 'swap-router' }, signal: AbortSignal.timeout(20000) });
        if (r.status === 429) { await sleep(8000); continue; }
        const j = await r.json() as any;
        return j.code === 0 && j.data?.routeSummary?.amountOut ? BigInt(j.data.routeSummary.amountOut) : null;
      } catch { /* retry */ }
    }
    return null;
  };
  for (const n of nets.filter((x) => x.family === 'evm' && KYBER_ENABLED[x.id])) { // one network after the other: the rate limit is per client, not per network
    const amountIn = parseUnits(NATIVE_IN[n.native.symbol] ?? '0.004', 18);
    for (const t of n.tokens) {
      const out = await quote(n.id, KYBER_NATIVE, t.id, amountIn);
      const back = out === null ? null : await quote(n.id, t.id, KYBER_NATIVE, out);
      routes.push({ network: n.id, symbol: t.symbol, address: t.id, buy: out === null ? null : formatUnits(out, t.decimals), sell: back === null ? null : formatUnits(back, 18) });
    }
  }
  const none = routes.filter((r) => r.buy === null || r.sell === null);
  console.log(`\nKyberSwap: ${routes.length - none.length}/${routes.length} tokens have a route in both directions with the native coin`);
  for (const r of none) console.log('NO ROUTE', r.network, r.symbol, r.address, r.buy === null ? 'native -> token' : 'token -> native');
}
let kyberAt: string | null = process.argv.includes('--kyber') ? new Date().toISOString() : null;
if (!kyberAt && existsSync(OUT)) { const old = JSON.parse(readFileSync(OUT, 'utf8')); routes = old.kyber ?? []; kyberAt = old.kyberAt ?? (routes.length ? old.at : null); } // keep the last route survey
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), onchain, kyberAt, kyber: routes }, null, 1) + '\n');
console.log(`\n${onchain.length - bad.length}/${onchain.length} on-chain checks ok`);
if (bad.length) process.exitCode = 1;
