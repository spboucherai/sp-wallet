// Live READ-ONLY check of the LI.FI swap adapter: real routes from https://li.quest/v1/advanced/routes for small amounts
// (about 30 USD each), with latency, compared with CoinGecko spot prices. Price discovery only: the endpoint returns no
// transaction data, and nothing is built, signed or sent. The addresses are public ones, used as sender/recipient labels.
// Keyless LI.FI allows 75 route requests per two hours per IP: this script spends 8 of them.
// Run: npx tsx scripts/smoke-swap-lifi.mts        (LIFI_API_KEY is used when set)
import { NETWORKS, formatUnits } from '@spw/core';
import { checkQuote, httpClient, resolveAsset, type AssetRef, type SwapQuote, type SwapQuoteRequest } from '@spw/swap';
import { createLifiProvider } from '../packages/swap/src/providers/lifi.ts';

const ADDR: Record<string, string> = {
  evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', sol: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', tron: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi',
  btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', sui: '0x7d20dcdb2bca4f508ea9613994683eb4e76e9c4ed371169677c1be02aaf0b58e',
};
const GECKO: Record<string, string> = { ETH: 'ethereum', SOL: 'solana', BTC: 'bitcoin', USDC: 'usd-coin', USDT: 'tether', TRX: 'tron', SUI: 'sui', LINK: 'chainlink', JUP: 'jupiter-exchange-solana', HYPE: 'hyperliquid' };
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const nat = (network: string): AssetRef => ({ network, asset: 'native' });
const USD = 30;
/** [label, from, to, lowest acceptable (guaranteed output value / input value) for the best route] */
const CASES: [string, AssetRef, AssetRef, number][] = [
  ['USDC Base -> USDC Solana (EVM -> SVM)', tok('base', 'USDC'), tok('solana', 'USDC'), 0.97],
  ['ETH Ethereum -> SOL Solana', nat('ethereum'), nat('solana'), 0.96],
  ['SOL Solana -> USDC Arbitrum (SVM -> EVM)', nat('solana'), tok('arbitrum', 'USDC'), 0.96],
  ['ETH Arbitrum -> USDC Arbitrum (same chain)', nat('arbitrum'), tok('arbitrum', 'USDC'), 0.97],
  ['BTC Bitcoin -> ETH Ethereum (UTXO -> EVM)', nat('bitcoin'), nat('ethereum'), 0.95],
  ['USDT TRON -> USDT Ethereum (TVM -> EVM)', tok('tron', 'USDT'), tok('ethereum', 'USDT'), 0.95],
  ['LINK Ethereum -> JUP Solana (swap + bridge)', tok('ethereum', 'LINK'), tok('solana', 'JUP'), 0.95],
  ['SUI Sui -> USDC Base (MVM -> EVM)', nat('sui'), tok('base', 'USDC'), 0.95],
];

const sym = (a: AssetRef) => resolveAsset(a).def.symbol, dec = (a: AssetRef) => resolveAsset(a).def.decimals;
const fmt = (a: AssetRef, v: bigint) => `${formatUnits(v, dec(a))} ${sym(a)}`;
const prices = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(GECKO).join(',')}&vs_currencies=usd`)).json() as Record<string, { usd: number }>;
const px = (a: AssetRef): number => { const p = prices[GECKO[sym(a)]!]?.usd; if (!(p > 0)) throw new Error(`no CoinGecko price for ${sym(a)}`); return p; };
const usd = (a: AssetRef, v: bigint) => (Number(v) / 10 ** dec(a)) * px(a);
console.log('market reference (CoinGecko, USD):', Object.entries(GECKO).map(([s, id]) => `${s} ${prices[id]?.usd}`).join('  '));

const lifi = createLifiProvider(process.env), http = httpClient('lifi');
console.log('provider', lifi.id, JSON.stringify(lifi.capabilities()));
let failed = 0;
const lat: number[] = [];
for (const [label, from, to, floor] of CASES) {
  const famOf = (a: AssetRef) => ADDR[NETWORKS[a.network]!.family] ?? ADDR.evm!;
  // about 30 USD of the input asset, rounded to 4 significant digits of base units (display amount only; the quote itself is integer end to end)
  const units = (USD / px(from)) * 10 ** dec(from), mag = 10 ** Math.max(0, Math.floor(Math.log10(units)) - 3);
  const req: SwapQuoteRequest = { from, to, amountIn: BigInt(Math.round(units / mag)) * BigInt(mag), sender: famOf(from), recipient: famOf(to), slippageBps: 50 };
  const t0 = performance.now();
  let quotes: SwapQuote[];
  try { quotes = await lifi.quote(req, { signal: AbortSignal.timeout(15_000), http, now: Date.now }); }
  catch (e) { failed++; console.log(`\n${label}\n  ERR ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`); continue; }
  const ms = Math.round(performance.now() - t0); lat.push(ms);
  const inUsd = usd(from, req.amountIn);
  console.log(`\n${label}: ${fmt(from, req.amountIn)} (~${inUsd.toFixed(2)} USD), slippage 0.5 % — ${quotes.length} route(s) in ${ms} ms`);
  if (quotes.length === 0) { failed++; console.log('  FAIL no route'); continue; }
  for (const q of quotes) {
    const invalid = checkQuote(q, req, Date.now()); if (invalid) { failed++; console.log('  FAIL invalid quote:', invalid); }
    const onTop = q.fees.filter((f) => !f.includedInOutput).reduce((s, f) => s + usd(f.asset, f.amount), 0), inside = q.fees.filter((f) => f.includedInOutput).reduce((s, f) => s + usd(f.asset, f.amount), 0);
    console.log(`  ${q.steps.map((s) => `${s.kind}[${s.via.join(' + ')}] ${sym(s.from)}@${s.from.network}->${sym(s.to)}@${s.to.network}`).join(' , ')}`);
    console.log(`      out ${fmt(to, q.amountOut)}  min ${fmt(to, q.minAmountOut)}  = ${(usd(to, q.amountOut) / inUsd * 100).toFixed(2)} % / ${(usd(to, q.minAmountOut) / inUsd * 100).toFixed(2)} % of input value  | ${q.estimatedSeconds} s | fees inside output ~${inside.toFixed(3)} USD, on top (gas) ~${onTop.toFixed(3)} USD | ${q.fees.length} fee item(s) | atomic ${q.atomic} | ${q.executability.class}`);
  }
  // sanity band on the best route: the guaranteed output must be worth 95–103 % (bridges) of the input at market prices
  const best = quotes.reduce((a, b) => (b.minAmountOut > a.minAmountOut ? b : a)), ratio = usd(to, best.minAmountOut) / inUsd, top = usd(to, best.amountOut) / inUsd;
  const ok = ratio >= floor && top <= 1.03;
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} best guaranteed output = ${(ratio * 100).toFixed(2)} % of market value (band ${(floor * 100).toFixed(0)}–103 %), implied rate 1 ${sym(from)} = ${(Number(best.amountOut) / 10 ** dec(to) / (Number(req.amountIn) / 10 ** dec(from))).toPrecision(6)} ${sym(to)} vs market ${(px(from) / px(to)).toPrecision(6)}`);
}
lat.sort((a, b) => a - b);
console.log(`\nlatency ms: min ${lat[0]} median ${lat[Math.floor(lat.length / 2)]} max ${lat[lat.length - 1]} (n=${lat.length})`);
console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
