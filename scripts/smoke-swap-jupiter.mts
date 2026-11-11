// Live READ-ONLY check of the Jupiter swap adapter: real quotes from https://api.jup.ag/swap/v2/build for realistic small
// amounts (20–50 USD), each validated by the aggregator's structural check and compared with CoinGecko spot prices.
// Nothing is built, signed or sent. Keyless Jupiter allows 0.5 request/s (5 per 10 s): requests are paced, run it once.
// Run: npx tsx scripts/smoke-swap-jupiter.mts        (JUPITER_API_KEY is used if set; SOL_WALLET overrides the quoting address)
import { NETWORKS, formatUnits } from '@spw/core';
import { checkQuote, httpClient, type AssetRef, type SwapQuoteRequest } from '@spw/swap';
import { createJupiterProvider } from '../packages/swap/src/providers/jupiter.ts';

const sol = NETWORKS.solana!;
const asset = (symbol: string): AssetRef => ({ network: 'solana', asset: symbol === 'SOL' ? 'native' : sol.tokens.find((t) => t.symbol === symbol)!.id });
const def = (symbol: string) => (symbol === 'SOL' ? sol.native : sol.tokens.find((t) => t.symbol === symbol)!);
/** a public address only used as `taker` for quoting (the example wallet of Jupiter's API reference); no balance is needed */
const WALLET = process.env.SOL_WALLET ?? 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ';
const COINGECKO: Record<string, string> = { SOL: 'solana', USDC: 'usd-coin', USDT: 'tether', PYUSD: 'paypal-usd', USDG: 'global-dollar', JUP: 'jupiter-exchange-solana', WBTC: 'wrapped-bitcoin', BONK: 'bonk' };
/** [from, to, human amount in, slippage bps, tolerated deviation from the reference in bps] */
const CASES: [string, string, string, number, number][] = [
  ['SOL', 'USDC', '0.3', 50, 150],
  ['USDC', 'SOL', '25', 50, 150],
  ['SOL', 'PYUSD', '0.4', 50, 150], // Token-2022 output
  ['USDG', 'USDC', '30', 30, 100], // Token-2022 input
  ['PYUSD', 'USDG', '20', 30, 100], // Token-2022 on both sides
  ['USDC', 'JUP', '25', 100, 200],
  ['USDC', 'WBTC', '50', 50, 200],
  ['BONK', 'SOL', '10000000', 100, 200],
];

const usd = (await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(Object.values(COINGECKO))].join(',')}&vs_currencies=usd`)).json()) as Record<string, { usd?: number }>;
const price = (symbol: string) => { const p = usd[COINGECKO[symbol]!]?.usd; if (!(p! > 0)) throw new Error(`no CoinGecko price for ${symbol}`); return p!; };
console.log('CoinGecko USD reference:', Object.keys(COINGECKO).map((s) => `${s}=${price(s)}`).join('  '));

const provider = createJupiterProvider(process.env), http = httpClient(provider.id);
const cap = provider.capabilities();
console.log(`provider ${provider.id} "${provider.name}" networks=${cap.networks} needsKey=${cap.needsKey} configured=${cap.configured} key=${process.env.JUPITER_API_KEY ? 'yes' : 'none (keyless)'}\n`);
const toUnits = (human: string, decimals: number) => { const [i, f = ''] = human.split('.'); return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals)); };
const pace = () => new Promise((r) => setTimeout(r, 2600));
const lat: number[] = []; let failed = 0;

for (const [from, to, human, slippageBps, band] of CASES) {
  const req: SwapQuoteRequest = { from: asset(from), to: asset(to), amountIn: toUnits(human, def(from).decimals), sender: WALLET, recipient: WALLET, slippageBps };
  const label = `${human} ${from} -> ${to}`.padEnd(22);
  try {
    if (!provider.supportsPair(req.from, req.to)) throw new Error('pair not supported');
    const t0 = performance.now();
    const quotes = await provider.quote(req, { signal: AbortSignal.timeout(8000), http, now: Date.now });
    const ms = Math.round(performance.now() - t0); lat.push(ms);
    const q = quotes[0]; if (!q) throw new Error('no route');
    const invalid = checkQuote(q, req, Date.now()); if (invalid) throw new Error(`invalid quote: ${invalid}`);
    const inUsd = Number(formatUnits(req.amountIn, def(from).decimals)) * price(from), outUsd = Number(formatUnits(q.amountOut, def(to).decimals)) * price(to);
    const devBps = (outUsd / inUsd - 1) * 10_000;
    const ok = Math.abs(devBps) <= band; if (!ok) failed++;
    console.log(`${label} ${String(ms).padStart(4)} ms  out=${formatUnits(q.amountOut, def(to).decimals)} ${to}  min=${formatUnits(q.minAmountOut, def(to).decimals)} (${slippageBps} bps)  impact=${q.priceImpactBps} bps  fee<=${formatUnits(q.fees[0]!.amount, 9)} SOL`);
    console.log(`${''.padEnd(22)} in≈$${inUsd.toFixed(2)} out≈$${outUsd.toFixed(2)}  vs CoinGecko ${devBps >= 0 ? '+' : ''}${devBps.toFixed(1)} bps (band ±${band}) ${ok ? 'OK' : 'OUT OF BAND'}  via ${q.steps[0]!.via.join(' + ')}  [${q.executability.class}, ttl ${Math.round((q.expiresAt - Date.now()) / 1000)} s]`);
  } catch (e) { failed++; console.log(`${label} ERR ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`); }
  await pace();
}

// "no route" and a failure, as the adapter reports them
const dust: SwapQuoteRequest = { from: asset('BONK'), to: asset('USDC'), amountIn: 1n, sender: WALLET, recipient: WALLET, slippageBps: 50 };
const none = await provider.quote(dust, { signal: AbortSignal.timeout(8000), http, now: Date.now });
console.log(`\n0.00001 BONK -> USDC     ${none.length === 0 ? 'no route (empty array), as expected' : 'UNEXPECTED QUOTE'}`); if (none.length) failed++;
const third = await provider.quote({ ...dust, amountIn: 10n ** 11n, recipient: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' }, { signal: AbortSignal.timeout(8000), http, now: Date.now });
console.log(`third-party recipient    ${third.length === 0 ? 'refused locally (empty array), as expected' : 'UNEXPECTED QUOTE'}`); if (third.length) failed++;

lat.sort((a, b) => a - b);
console.log(`\nlatency over ${lat.length} quotes: min ${lat[0]} ms, median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms`);
console.log(failed ? `FAILED: ${failed}` : 'all checks passed');
process.exit(failed ? 1 : 0);
