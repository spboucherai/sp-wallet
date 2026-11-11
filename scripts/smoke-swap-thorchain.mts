// Live READ-ONLY check of the THORChain swap adapter (price discovery). Nothing is built, signed or broadcast.
//   npx tsx scripts/smoke-swap-thorchain.mts
// See scripts/lib/smoke-native-swap.mts for what is verified.
import { THORCHAIN_API_VERSION, THORCHAIN_CONFIG } from '../packages/swap/src/providers/thorchain.ts';
import { native, smokeNativeSwap, token } from './lib/smoke-native-swap.mts';

await smokeNativeSwap(THORCHAIN_CONFIG, THORCHAIN_API_VERSION, [
  { from: native('bitcoin'), to: native('ethereum') },
  { from: native('ethereum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: token('ethereum', 'USDC') },
  { from: native('dogecoin'), to: native('bitcoin') },
  { from: token('ethereum', 'USDC'), to: native('bitcoin') },
  { from: native('litecoin'), to: native('ethereum') },
  { from: native('xrpl'), to: native('tron') },
  { from: native('solana'), to: token('avalanche', 'USDC') },
  { from: native('bitcoin'), to: native('ethereum'), units: 20, slippageBps: 300, note: 'large: streaming expected' },
  { from: native('bitcoin'), to: native('ethereum'), usd: 2, expect: 'no_route', note: '(below recommended_min_amount_in)' },
  { from: native('bitcoin'), to: token('ethereum', 'LINK'), expect: 'unsupported', note: '(ETH.LINK pool is Staged)' },
]);
