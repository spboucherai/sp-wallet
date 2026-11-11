// Live READ-ONLY check of the deBridge (DLN) swap adapter: real estimates from
// https://dln.debridge.finance/v1.0/dln/order/create-tx for small amounts (about 30 USD each), with latency, compared with
// CoinGecko spot prices. Price discovery only: the answer's calldata is used for two sanity checks inside the adapter and is
// never signed, relayed or submitted — no order is created by asking. The addresses are public ones, used as labels.
// Run: npx tsx scripts/smoke-swap-debridge.mts
import { NETWORKS, formatUnits } from '@spw/core';
import { checkQuote, httpClient, resolveAsset, type AssetRef, type SwapQuote, type SwapQuoteRequest } from '@spw/swap';
import { createDebridgeProvider } from '../packages/swap/src/providers/debridge.ts';

const ADDR: Record<string, string> = { evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', sol: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', tron: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi' };
const GECKO: Record<string, string> = { ETH: 'ethereum', SOL: 'solana', USDC: 'usd-coin', USDT: 'tether', TRX: 'tron', LINK: 'chainlink', HYPE: 'hyperliquid' };
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const nat = (network: string): AssetRef => ({ network, asset: 'native' });
const USD = 30;
const CASES: [string, AssetRef, AssetRef][] = [
  ['USDC Base -> USDC Solana (EVM -> SVM)', tok('base', 'USDC'), tok('solana', 'USDC')],
  ['ETH Ethereum -> SOL Solana (pre-order swap + destination swap)', nat('ethereum'), nat('solana')],
  ['USDC Solana -> USDC Arbitrum (SVM -> EVM)', tok('solana', 'USDC'), tok('arbitrum', 'USDC')],
  ['LINK Ethereum -> SOL Solana (token pre-order swap)', tok('ethereum', 'LINK'), nat('solana')],
  ['USDC Base -> USDC HyperEVM', tok('base', 'USDC'), tok('hyperevm', 'USDC')],
  ['USDT TRON -> USDT Ethereum (TVM -> EVM)', tok('tron', 'USDT'), tok('ethereum', 'USDT')],
  ['USDC Arbitrum -> USDT TRON (EVM -> TVM)', tok('arbitrum', 'USDC'), tok('tron', 'USDT')],
];

const sym = (a: AssetRef) => resolveAsset(a).def.symbol, dec = (a: AssetRef) => resolveAsset(a).def.decimals;
const fmt = (a: AssetRef, v: bigint) => `${formatUnits(v, dec(a))} ${sym(a)}`;
const prices = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(GECKO).join(',')}&vs_currencies=usd`)).json() as Record<string, { usd: number }>;
const px = (a: AssetRef): number => { const p = prices[GECKO[sym(a)]!]?.usd; if (!(p > 0)) throw new Error(`no CoinGecko price for ${sym(a)}`); return p; };
const usd = (a: AssetRef, v: bigint) => (Number(v) / 10 ** dec(a)) * px(a);
console.log('market reference (CoinGecko, USD):', Object.entries(GECKO).map(([s, id]) => `${s} ${prices[id]?.usd}`).join('  '));

const dln = createDebridgeProvider(process.env), http = httpClient('debridge');
console.log('provider', dln.id, JSON.stringify(dln.capabilities()));
let failed = 0;
const lat: number[] = [];
for (const [label, from, to] of CASES) {
  const famOf = (a: AssetRef) => ADDR[NETWORKS[a.network]!.family] ?? ADDR.evm!;
  const units = (USD / px(from)) * 10 ** dec(from), mag = 10 ** Math.max(0, Math.floor(Math.log10(units)) - 3);
  const req: SwapQuoteRequest = { from, to, amountIn: BigInt(Math.round(units / mag)) * BigInt(mag), sender: famOf(from), recipient: famOf(to), slippageBps: 50 };
  const t0 = performance.now();
  let quotes: SwapQuote[];
  try { quotes = await dln.quote(req, { signal: AbortSignal.timeout(15_000), http, now: Date.now }); }
  catch (e) { failed++; console.log(`\n${label}\n  ERR ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`); continue; }
  const ms = Math.round(performance.now() - t0); lat.push(ms);
  const inUsd = usd(from, req.amountIn);
  console.log(`\n${label}: ${fmt(from, req.amountIn)} (~${inUsd.toFixed(2)} USD) — ${quotes.length} quote(s) in ${ms} ms`);
  if (quotes.length !== 1) { failed++; console.log('  FAIL no route'); continue; }
  const q = quotes[0]!;
  const invalid = checkQuote(q, req, Date.now()); if (invalid) { failed++; console.log('  FAIL invalid quote:', invalid); }
  const outUsd = usd(to, q.amountOut);
  const onTop = q.fees.filter((f) => !f.includedInOutput).reduce((s, f) => s + usd(f.asset, f.amount), 0), inside = q.fees.filter((f) => f.includedInOutput).reduce((s, f) => s + usd(f.asset, f.amount), 0);
  console.log(`  bridge[${q.steps[0]!.via.join(' + ')}]  out = min ${fmt(to, q.amountOut)} (fixed in the order)  | ${q.estimatedSeconds} s | price impact ${q.priceImpactBps} bps | ${q.firmness} | ${q.executability.class} | refundable ${q.refundable}`);
  for (const f of q.fees) console.log(`      fee ${f.kind.padEnd(8)} ${fmt(f.asset, f.amount).padEnd(28)} ~${usd(f.asset, f.amount).toFixed(3)} USD  ${f.includedInOutput ? 'inside the output' : 'paid on top'}${f.estimated ? ' (estimate)' : ''}`);
  console.log(`      contracts: ${q.steps[0]!.contracts.map((c) => `${c.role}@${c.network} ${c.address}`).join(' ; ')}`);
  // DLN deducts its itemised costs from the output, and they are large against 30 USD. The market check is therefore made on
  // the rate before those deductions (output + fees inside the output); the net figures are printed as they are.
  const gross = (outUsd + inside) / inUsd, net = outUsd / inUsd, ok = gross >= 0.97 && gross <= 1.03 && net <= 1.03;
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} rate before itemised deductions = ${(gross * 100).toFixed(2)} % of market value (band 97–103 %); net output = ${(net * 100).toFixed(2)} % of input value; all-in cost ~${(inUsd - outUsd + onTop).toFixed(2)} USD (${(inside).toFixed(2)} inside the output, ${onTop.toFixed(2)} on top)`);
}
lat.sort((a, b) => a - b);
console.log(`\nlatency ms: min ${lat[0]} median ${lat[Math.floor(lat.length / 2)]} max ${lat[lat.length - 1]} (n=${lat.length})`);
console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
