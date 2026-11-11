// Live READ-ONLY check of the KyberSwap adapter: real quotes (GET /routes only — nothing is encoded, signed or sent) for small
// realistic amounts on each served network, with latency, compared with CoinGecko spot prices.
// Run: npx tsx scripts/smoke-swap-kyberswap.mts     (about one request per second; the public limit is 3 rps)
import { NETWORKS, formatUnits } from '@spw/core';
import { checkQuote, httpClient, resolveAsset, type AssetRef, type SwapQuoteRequest } from '../packages/swap/src/index.ts';
import { createKyberswapProvider } from '../packages/swap/src/providers/kyberswap.ts';

const BAND = 0.02; // quoted rate must be within 2 % of the CoinGecko cross rate
const CG: Record<string, string> = { ETH: 'ethereum', USDC: 'usd-coin', USDT: 'tether', WBTC: 'wrapped-bitcoin', LINK: 'chainlink', POL: 'polygon-ecosystem-token', BNB: 'binancecoin', FDUSD: 'first-digital-usd', AVAX: 'avalanche-2', HYPE: 'hyperliquid' };
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const native = (network: string): AssetRef => ({ network, asset: 'native' });
const WALLET = '0x1111111111111111111111111111111111111111'; // placeholder; never sent to the provider
const cases: [AssetRef, AssetRef, bigint][] = [
  [native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n],          // 0.01 ETH
  [tok('ethereum', 'USDC'), tok('ethereum', 'WBTC'), 50_000_000n],    // 50 USDC
  [tok('base', 'USDC'), native('base'), 25_000_000n],                 // 25 USDC
  [tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), 30_000_000n],    // 30 USDC
  [native('polygon'), tok('polygon', 'USDC'), 200n * 10n ** 18n],     // 200 POL
  [native('optimism'), tok('optimism', 'USDC'), 10n ** 16n],          // 0.01 ETH
  [native('bsc'), tok('bsc', 'FDUSD'), 4n * 10n ** 16n],              // 0.04 BNB
  [native('avalanche'), tok('avalanche', 'USDC'), 2n * 10n ** 18n],   // 2 AVAX
  [native('hyperevm'), tok('hyperevm', 'USDC'), 10n ** 18n],          // 1 HYPE
];
const prices = (await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(CG).join(',')}&vs_currencies=usd`)).json()) as Record<string, { usd: number }>;
const usd = (sym: string) => { const v = prices[CG[sym]!]?.usd; if (!(v! > 0)) throw new Error(`no CoinGecko price for ${sym}`); return v!; };

const p = createKyberswapProvider(process.env), http = httpClient(p.id);
let failed = 0; const lat: number[] = [];
console.log(`provider ${p.id}  networks ${p.capabilities().networks.join(',')}  ${new Date().toISOString()}`);
for (const [from, to, amountIn] of cases) {
  const a = resolveAsset(from).def, b = resolveAsset(to).def, label = `${from.network}: ${formatUnits(amountIn, a.decimals)} ${a.symbol} -> ${b.symbol}`;
  const req: SwapQuoteRequest = { from, to, amountIn, sender: WALLET, recipient: WALLET, slippageBps: 50 };
  const t0 = Date.now();
  try {
    const quotes = await p.quote(req, { signal: AbortSignal.timeout(8000), http, now: Date.now });
    const ms = Date.now() - t0; lat.push(ms);
    if (quotes.length !== 1) throw new Error(`expected one quote, got ${quotes.length}`);
    const q = quotes[0]!, invalid = checkQuote(q, req, Date.now());
    if (invalid) throw new Error(`checkQuote: ${invalid}`);
    const inUnits = Number(amountIn) / 10 ** a.decimals; // display only
    const rate = (Number(q.amountOut) / 10 ** b.decimals) / inUnits, ref = usd(a.symbol) / usd(b.symbol), dev = rate / ref - 1;
    const gas = q.fees[0]!, nat = NETWORKS[from.network]!.native;
    const ok = Math.abs(dev) <= BAND; if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(36)} out ${formatUnits(q.amountOut, b.decimals)} ${b.symbol} (min ${formatUnits(q.minAmountOut, b.decimals)})  ~${(inUnits * usd(a.symbol)).toFixed(2)} USD in`
      + `\n     rate ${rate.toPrecision(7)} vs CoinGecko ${ref.toPrecision(7)} (${(dev * 100).toFixed(3)} %)  impact ${q.priceImpactBps} bps  gas ${formatUnits(gas.amount, 18)} ${nat.symbol} (~${((Number(gas.amount) / 1e18) * usd(nat.symbol)).toFixed(4)} USD)  via ${q.steps[0]!.via.join('+')}  ${ms} ms`);
  } catch (e) { failed++; console.log(`ERR  ${label.padEnd(36)} ${(e as { code?: string }).code ?? ''} ${(e as Error).message}  ${Date.now() - t0} ms`); }
  await new Promise((r) => setTimeout(r, 1000));
}
// "no route" must be an empty array, not an error
const none = await p.quote({ from: native('ethereum'), to: tok('ethereum', 'USDC'), amountIn: 1n, sender: WALLET, recipient: WALLET, slippageBps: 50 }, { signal: AbortSignal.timeout(8000), http, now: Date.now });
console.log(`${none.length === 0 ? 'OK  ' : 'FAIL'} ${'ethereum: 1 wei ETH -> USDC'.padEnd(36)} no route -> ${JSON.stringify(none)}`); if (none.length) failed++;
lat.sort((x, y) => x - y);
console.log(`latency ms: min ${lat[0]} median ${lat[Math.floor(lat.length / 2)]} max ${lat[lat.length - 1]}  (${lat.length} quotes)`);
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
