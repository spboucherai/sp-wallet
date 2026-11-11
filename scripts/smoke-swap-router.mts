// Live, read-only: run the real router (all configured providers) on a few pairs and print the ranked routes.
import { NETWORKS, formatUnits, getAsset, parseUnits } from '@spw/core';
import { createEnabledProviders, DEFAULT_POLICY, httpClient, LiquidityGraph, ProviderRuntime, QuoteAggregator, SwapRouter, type AssetRef } from '@spw/swap';
const tok = (n: string, s: string): AssetRef => ({ network: n, asset: s === 'native' ? 'native' : NETWORKS[n]!.tokens.find((t) => t.symbol === s)!.id });
const providers = createEnabledProviders(process.env);
const agg = new QuoteAggregator(providers.map((p) => new ProviderRuntime(p, { ...DEFAULT_POLICY, ...p.policy }, httpClient(p.id))));
const prices: Record<string, number> = {};
try { const ids: Record<string, string> = { ETH: 'ethereum', USDC: 'usd-coin', SOL: 'solana', BTC: 'bitcoin', WBTC: 'wrapped-bitcoin', LINK: 'chainlink', POL: 'polygon-ecosystem-token', AVAX: 'avalanche-2', BNB: 'binancecoin', USDT: 'tether' };
  const j = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(ids).join(',')}&vs_currencies=usd`)).json() as Record<string, { usd: number }>;
  for (const [s, id] of Object.entries(ids)) if (j[id]) prices[s] = j[id].usd; } catch { console.log('(no price reference available)'); }
const router = new SwapRouter(agg, new LiquidityGraph(providers), (a, amt) => { const d = getAsset(a.network, a.asset), p = prices[d.symbol]; return p === undefined ? null : Number(formatUnits(amt, d.decimals)) * p; });
const EVM = '0xeb22BF0c852Cf2d49a09a93364ceeF9B514E4A5d', SOL = 'C387pyL6jm7HZYZtWjJGXyqSawp6eRJYTp99TMn6CbvA', BTC = 'bc1qhh4h4pc6jgy5904a7qcrkpa4as4nwpnuy0se09';
const addr = (n: string) => (n === 'solana' ? SOL : n === 'bitcoin' ? BTC : EVM);
console.log('providers:', providers.map((p) => p.id).join(', ') || '(none)');
const cases: [AssetRef, AssetRef, string][] = [[tok('base', 'USDC'), tok('base', 'native'), '25'], [tok('ethereum', 'native'), tok('ethereum', 'USDC'), '0.01'], [tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), '30'],
  [tok('base', 'USDC'), tok('solana', 'USDC'), '25'], [tok('base', 'native'), tok('solana', 'native'), '0.01'], [tok('solana', 'native'), tok('solana', 'USDC'), '0.3'], [tok('bitcoin', 'native'), tok('ethereum', 'native'), '0.0005'], [tok('bitcoin', 'native'), tok('solana', 'native'), '0.0005']];
for (const [from, to, amount] of cases) {
  const f = getAsset(from.network, from.asset), t = getAsset(to.network, to.asset);
  const s = await router.search({ from, to, amountIn: parseUnits(amount, f.decimals), sender: addr(from.network), recipient: addr(to.network), slippageBps: 50 });
  console.log(`\n${amount} ${f.symbol}@${from.network} -> ${t.symbol}@${to.network}  reachable=${s.reachable} routes=${s.routes.length} in ${s.ms} ms`);
  for (const r of s.routes) console.log(`  ${r.providers.join('+').padEnd(22)} out ${formatUnits(r.amountOut, t.decimals).padEnd(22)} min ${formatUnits(r.minAmountOut, t.decimals).padEnd(22)} net ${r.valuation.netUsd?.toFixed(2) ?? '?'} USD  ${r.estimatedSeconds ?? '?'} s  risk ${r.risk.level} [${r.risk.flags.map((x) => x.code).join(',')}] ${r.tags.join(',')}`);
  for (const e of s.events) if (e.type === 'provider' && e.status === 'error') console.log(`  ! ${e.provider}: ${e.code} ${e.detail ?? ''}`);
}
