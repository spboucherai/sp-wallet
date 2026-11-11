// Live READ-ONLY check of the Maya Protocol swap adapter (price discovery). Nothing is built, signed or broadcast.
//   npx tsx scripts/smoke-swap-maya.mts
// See scripts/lib/smoke-native-swap.mts for what is verified.
import { MAYA_API_VERSION, MAYA_CONFIG } from '../packages/swap/src/providers/maya.ts';
import { native, smokeNativeSwap, token } from './lib/smoke-native-swap.mts';

await smokeNativeSwap(MAYA_CONFIG, MAYA_API_VERSION, [
  { from: native('bitcoin'), to: native('ethereum') },
  { from: native('ethereum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: token('ethereum', 'USDC') },
  { from: token('ethereum', 'USDT'), to: native('bitcoin') },
  { from: native('ethereum'), to: token('arbitrum', 'USDC') },
  { from: native('arbitrum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: native('arbitrum') },
  { from: native('bitcoin'), to: native('ethereum'), units: 2, slippageBps: 300, note: 'large: streaming expected' },
  { from: native('ethereum'), to: native('bitcoin'), usd: 1, expect: 'no_route', note: '(cannot pay the BTC outbound fee)' },
  { from: native('dogecoin'), to: native('bitcoin'), expect: 'unsupported', note: '(Maya has no DOGE pool)' },
]);
