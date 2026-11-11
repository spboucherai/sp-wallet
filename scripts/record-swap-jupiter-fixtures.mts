// Re-records the Jupiter test fixtures from the LIVE API (read-only GETs, keyless, paced under the 0.5 request/s limit).
// Each file is the provider's answer verbatim: { recordedAt, url, status, body }. Nothing is signed, built or sent.
// Run: npx tsx scripts/record-swap-jupiter-fixtures.mts     (then re-run the tests: amounts in jupiter.test.ts are read from the fixtures)
import { mkdirSync, writeFileSync } from 'node:fs';
import { NETWORKS } from '@spw/core';
import { JUPITER_API_BASE, WSOL_MINT } from '../packages/swap/src/providers/jupiter.ts';

const dir = new URL('../packages/swap/test/fixtures/jupiter/', import.meta.url);
mkdirSync(dir, { recursive: true });
const mint = (symbol: string) => (symbol === 'SOL' ? WSOL_MINT : NETWORKS.solana!.tokens.find((t) => t.symbol === symbol)!.id);
/** the example wallet of Jupiter's own API reference (GET /build, parameter `taker`): a public address, not ours */
const TAKER = 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ';
const build = (from: string, to: string, amount: bigint, o: { taker?: string; slippageBps?: number } = {}) =>
  `${JUPITER_API_BASE}/build?${new URLSearchParams({ inputMint: mint(from), outputMint: mint(to), amount: amount.toString(), taker: o.taker ?? TAKER, slippageBps: String(o.slippageBps ?? 50) })}`;

const cases: [name: string, url: string][] = [
  ['sol-usdc', build('SOL', 'USDC', 300_000_000n)], // 0.3 SOL: wrap + swap
  ['usdc-sol', build('USDC', 'SOL', 25_000_000n)], // 25 USDC: swap + unwrap
  ['sol-pyusd', build('SOL', 'PYUSD', 300_000_000n)], // Token-2022 output
  ['pyusd-sol', build('PYUSD', 'SOL', 25_000_000n, { slippageBps: 100 })], // Token-2022 input, 1 % slippage
  ['usdg-usdc', build('USDG', 'USDC', 25_000_000n)], // Token-2022 input
  ['usdc-usdg', build('USDC', 'USDG', 25_000_000n, { slippageBps: 0 })], // Token-2022 output, zero slippage
  ['usdc-wbtc', build('USDC', 'WBTC', 25_000_000n)], // 8 decimals, multi-hop through mints outside the registry
  ['usdc-bonk', build('USDC', 'BONK', 25_000_000n)], // 5 decimals
  ['wbtc-usdc-high-impact', build('WBTC', 'USDC', 2_500_000_000n)], // 25 WBTC into a thin pool: price impact close to 100 %
  ['no-route-dust', build('BONK', 'USDC', 1n)], // 400 No routes found
  ['no-route-liquidity', build('USDG', 'WBTC', 10n ** 18n)], // 400 Insufficient liquidity
  ['error-invalid-taker', build('SOL', 'USDC', 300_000_000n, { taker: 'notanaddress' })], // 400 Invalid taker
  ['program-id-to-label', `${JUPITER_API_BASE}/program-id-to-label`],
];
for (const [name, url] of cases) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const body: unknown = JSON.parse(await r.text());
  writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify({ recordedAt: new Date(t0).toISOString(), url, status: r.status, body })}\n`);
  console.log(name.padEnd(24), r.status, `${Date.now() - t0} ms`, `remaining=${r.headers.get('x-ratelimit-remaining')}`);
  await new Promise((res) => setTimeout(res, 2600));
}
