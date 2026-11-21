/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/lib/smoke-native-swap.mts
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

// Shared body of scripts/smoke-swap-thorchain.mts and scripts/smoke-swap-maya.mts.
// Live and READ-ONLY: GET requests to the network's public node and to CoinGecko. Nothing is built, signed or sent.
//  1. node version vs the pinned one, 2. live pool list vs the pinned asset table (Available only, registry-mapped),
//  3. inbound_addresses: halts, pauses, routers vs the pinned routers, 4. mimir halt/pause keys that are set,
//  5. real quotes for realistic pairs (≈ 40 USD) through the provider runtime, with latency, checked by the aggregator's
//     structural validation and compared with a CoinGecko reference rate. Exits 1 on any failure.
import { formatUnits, NETWORKS } from '@spw/core';
import { assetKey as assetKeyOf, checkQuote, DEFAULT_POLICY, httpClient, ProviderError, ProviderRuntime, resolveAsset, type AssetRef, type SwapQuoteRequest } from '../../packages/swap/src/index.ts';
import { chainBlocked, createNativeSwapProvider, InboundSchema, mapPools, type NativeSwapConfig } from '../../packages/swap/src/providers/thorchain.ts';

export interface SmokePair { from: AssetRef; to: AssetRef; usd?: number; units?: number; slippageBps?: number; expect?: 'quote' | 'no_route' | 'unsupported'; note?: string }
export const native = (network: string): AssetRef => ({ network, asset: 'native' });
export const token = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });

const COINGECKO: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', DOGE: 'dogecoin', LTC: 'litecoin', BCH: 'bitcoin-cash', USDC: 'usd-coin', USDT: 'tether', DAI: 'dai',
  XRP: 'ripple', TRX: 'tron', SOL: 'solana', ATOM: 'cosmos', AVAX: 'avalanche-2', BNB: 'binancecoin', WBTC: 'wrapped-bitcoin', AAVE: 'aave' };
// well-known public addresses, used only as quote parameters (the quote endpoint validates the destination's format)
const ADDRESS: Record<string, string> = {
  evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', bitcoin: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', dogecoin: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L',
  xrpl: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', tron: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi', solana: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
  litecoin: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9', bitcoincash: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
};
const addressOn = (network: string) => ADDRESS[NETWORKS[network]!.family === 'evm' ? 'evm' : network] ?? 'UNKNOWN';
const label = (a: AssetRef) => { const { net, def } = resolveAsset(a); return a.asset === 'native' && net.family !== 'evm' ? def.symbol : `${def.symbol}(${net.id})`; };

export async function smokeNativeSwap(cfg: NativeSwapConfig, pinnedVersion: string, pairs: SmokePair[]): Promise<void> {
  let failures = 0, warnings = 0;
  const check = (ok: boolean, what: string, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}`); if (!ok) failures += 1; };
  const warn = (what: string) => { console.log(`WARN  ${what}`); warnings += 1; };
  const get = async (url: string): Promise<{ body: any; ms: number }> => {
    for (let k = 0; ; k++) {
      const t0 = Date.now();
      try { const r = await fetch(url, { headers: { accept: 'application/json', 'x-client-id': 'sp-wallet' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`http ${r.status}`); return { body: await r.json(), ms: Date.now() - t0 }; }
      catch (e) { if (k >= 2) throw new Error(`${url}: ${(e as Error).message}`); await new Promise((res) => setTimeout(res, 1500)); }
    }
  };
  const provider = createNativeSwapProvider(cfg);
  console.log(`== ${cfg.name} (${cfg.id}) — ${cfg.api} — ${new Date().toISOString()}`);

  // ---- 1. version
  const v = await get(`${cfg.api}/version`);
  if (v.body.current === pinnedVersion) check(true, 'node version is the pinned one', `${v.body.current} (${v.ms} ms)`); else warn(`node version ${v.body.current} differs from the pinned ${pinnedVersion}: re-verify the adapter against the release notes`);

  // ---- 2. pools
  const pools = (await get(`${cfg.api}/pools`)).body as { asset: string; status: string; decimals?: number; trading_halted?: boolean }[];
  const chains = Object.keys(cfg.chains);
  for (const n of cfg.pools) { const p = pools.find((x) => x.asset === n); check(p?.status === 'Available', `pinned pool ${n} is Available`, p ? `status=${p.status}` : 'missing'); if (p?.trading_halted) warn(`${n}: trading halted right now — quotes on this pool return no route`); }
  const live = mapPools({ chains: cfg.chains, pools: pools.filter((x) => x.status === 'Available' && chains.includes(x.asset.split('.')[0]!)).map((x) => x.asset) });
  for (const [k, a] of live) if (!provider.assets.has(k)) warn(`${a.notation} is Available and in the wallet registry but not pinned in the adapter`);
  for (const a of provider.assets.values()) { const d = pools.find((x) => x.asset === a.notation)?.decimals; check(d ? d === a.decimals : a.decimals >= 8, `decimals of ${a.notation}`, `registry ${a.decimals}, pool ${d ?? '(≥ 8, not reported)'}`); }
  console.log(`      ${pools.length} pools live, ${pools.filter((x) => x.status === 'Available').length} Available, ${provider.assets.size} served by the wallet: ${[...provider.assets.values()].map((a) => a.notation.split('-')[0]).join(' ')}`);

  // ---- 3. inbound addresses
  const inb = InboundSchema.parse((await get(`${cfg.api}/inbound_addresses`)).body);
  for (const chain of chains) {
    const e = inb.find((x) => x.chain === chain);
    if (!e) { warn(`${chain}: no inbound address`); continue; }
    const blocked = e.halted || e.global_trading_paused || e.chain_trading_paused;
    if (blocked) warn(`${chain}: halted=${e.halted} global_trading_paused=${e.global_trading_paused} chain_trading_paused=${e.chain_trading_paused} — quotes on this chain return no route`);
    const pinned = cfg.routers[cfg.chains[chain]!];
    if (pinned || e.router) check(!!pinned && e.router?.toLowerCase() === pinned.toLowerCase(), `${chain} router is the pinned one`, `${e.router ?? '(none)'}`);
    console.log(`      ${chain.padEnd(5)} vault ${e.address}  dust ${e.dust_threshold ?? '-'}  outbound_fee ${e.outbound_fee ?? '-'}${blocked ? '  BLOCKED' : ''}`);
  }

  // ---- 4. mimir
  const mimir = (await get(`${cfg.api}/mimir`)).body as Record<string, number>;
  const set = Object.entries(mimir).filter(([k, val]) => /^(HALT|PAUSE|SOLVENCYHALT|NODEPAUSE)/.test(k) && val !== 0 && /TRADING|CHAIN|SIGNING|GLOBAL/.test(k) && !/LP|WASM|CHURN/.test(k));
  console.log(`      mimir halt/pause keys set: ${set.length ? set.map(([k, val]) => `${k}=${val}`).join(' ') : 'none'}`);

  // ---- 5. quotes
  const ids = [...new Set(pairs.flatMap((p) => [p.from, p.to]).map((a) => COINGECKO[resolveAsset(a).def.symbol]).filter(Boolean))];
  const prices = (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`)).body as Record<string, { usd: number }>;
  const usd = (a: AssetRef) => prices[COINGECKO[resolveAsset(a).def.symbol]!]?.usd;
  console.log(`      CoinGecko: ${ids.map((i) => `${i}=${prices[i]?.usd}`).join(' ')}`);
  const rt = new ProviderRuntime(provider, { ...DEFAULT_POLICY, timeoutMs: 12_000, ratePerSec: 5, burst: 20, breakerFailures: 50 }, httpClient(cfg.id));
  const lat: number[] = [];
  for (const p of pairs) {
    const from = resolveAsset(p.from).def, to = resolveAsset(p.to).def, name = `${label(p.from)} → ${label(p.to)}`;
    const units = p.units ?? (p.usd ?? 40) / usd(p.from)!;
    const amountIn = BigInt(Math.round(units * 1e6)) * 10n ** BigInt(from.decimals) / 1_000_000n; // sizing only; the adapter itself never uses floats
    const req: SwapQuoteRequest = { from: p.from, to: p.to, amountIn, sender: addressOn(p.from.network), recipient: addressOn(p.to.network), slippageBps: p.slippageBps ?? 100 };
    const want = p.expect ?? 'quote';
    if (!provider.supportsPair(p.from, p.to)) { check(want === 'unsupported', `${name}: not served by ${cfg.name}`, p.note ?? ''); continue; }
    let quotes, ms = 0, tries = 0;
    for (;;) {
      const t0 = Date.now(); tries += 1;
      try { quotes = await rt.quote(req); ms = Date.now() - t0; break; }
      catch (e) { const err = e as ProviderError; if ((err.code === 'unavailable' || err.code === 'timeout') && tries < 8) { console.log(`      ${name}: ${err.code} (${err.message.slice(0, 70)}) — retry ${tries}`); await new Promise((res) => setTimeout(res, 4000)); continue; } check(false, `${name}: provider error`, `${err.code}: ${err.message}`); break; }
    }
    if (!quotes) continue;
    if (quotes.length === 0) {
      // a live halt is a correct "no route": confirm it on a fresh read rather than failing the run
      const now = InboundSchema.parse((await get(`${cfg.api}/inbound_addresses`)).body);
      const halted = [provider.assets.get(assetKeyOf(p.from))!.chain, provider.assets.get(assetKeyOf(p.to))!.chain].map((c) => chainBlocked(now, c)).filter(Boolean);
      if (want === 'quote' && halted.length) { warn(`${name}: no route (${ms} ms) because ${halted.join('; ')} right now`); continue; }
      check(want === 'no_route', `${name}: no route for ${formatUnits(amountIn, from.decimals)} ${from.symbol}`, `${ms} ms ${p.note ?? ''}`); continue;
    }
    lat.push(ms);
    const q = quotes[0]!, raw = q.raw as { quote: { memo: string; inbound_address: string; router?: string; expiry: number }; streaming: { quoted: boolean; quantity: number; interval: number | null }; dustThreshold1e8: string | null; recommendedMinAmountIn1e8: string; inboundConfirmationSeconds: number | null; outboundDelaySeconds: number | null };
    const bad = checkQuote(q, req, Date.now());
    const inUsd = units * usd(p.from)!, outUsd = Number(formatUnits(q.amountOut, to.decimals)) * usd(p.to)!, dev = (outUsd / inUsd - 1) * 100;
    const band = want === 'quote' && inUsd > 0 && dev > (inUsd < 100 ? -8 : -3) && dev < 2;
    check(want === 'quote' && !bad && band, `${name}: ${formatUnits(amountIn, from.decimals)} ${from.symbol} → ${formatUnits(q.amountOut, to.decimals)} ${to.symbol}`, `${ms} ms${tries > 1 ? ` (try ${tries})` : ''}${bad ? ' INVALID: ' + bad : ''}`);
    console.log(`      min ${formatUnits(q.minAmountOut, to.decimals)} ${to.symbol} (${req.slippageBps} bps) | fees ${q.fees.map((f) => `${f.kind} ${formatUnits(f.amount, to.decimals)}`).join(', ')} ${to.symbol} | slip ${q.priceImpactBps} bps | eta ${q.estimatedSeconds ?? 'n/a'} s (inbound conf ${raw.inboundConfirmationSeconds ?? 'n/a'} s, outbound delay ${raw.outboundDelaySeconds ?? 'n/a'} s)`);
    console.log(`      ${q.steps[0]!.via[2]} | vault ${raw.quote.inbound_address}${raw.quote.router ? ` router ${raw.quote.router}` : ''} | memo ${raw.quote.memo} | dust ${raw.dustThreshold1e8 ?? '-'} min_in ${raw.recommendedMinAmountIn1e8} (1e8) | expires in ${Math.round((q.expiresAt - Date.now()) / 1000)} s`);
    console.log(`      vs CoinGecko: in ${inUsd.toFixed(2)} USD, out ${outUsd.toFixed(2)} USD, ${dev >= 0 ? '+' : ''}${dev.toFixed(2)} % | ${q.executability.class}, atomic=${q.atomic}, refundable=${q.refundable}`);
  }
  lat.sort((a, b) => a - b);
  if (lat.length) console.log(`      quote latency over ${lat.length} quotes: min ${lat[0]} ms, median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms`);
  console.log(`${failures ? 'FAILED' : 'OK'}: ${failures} failure(s), ${warnings} warning(s)`);
  if (failures) process.exit(1);
}
