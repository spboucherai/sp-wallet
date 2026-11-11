// v10 performance pass — the few logos the FIRST screen always shows (the held majors, « Populaires », the badges of the
// most used networks), bundled with the app itself (≈ 17 kB of sanitised SVG text) so that Home paints them at once and
// the 320 kB set (icons-data.ts) is not requested until the first paint is done. Same files, same sanitiser, same
// `data:` URLs as the full set: this module only decides WHEN they arrive. A file listed here that is missing fails the
// build (static import) and the unit test (apps/web/test/icons.test.ts).
import btc from './logos/asset/btc.svg?raw';
import eth from './logos/asset/eth.svg?raw';
import sol from './logos/asset/sol.svg?raw';
import usdc from './logos/asset/usdc.svg?raw';
import usdt from './logos/asset/usdt.svg?raw';
import arbitrum from './logos/network/arbitrum.svg?raw';
import base from './logos/network/base.svg?raw';
import optimism from './logos/network/optimism.svg?raw';

const RAW: Record<string, string> = { 'asset/btc.svg': btc, 'asset/eth.svg': eth, 'asset/sol.svg': sol, 'asset/usdc.svg': usdc, 'asset/usdt.svg': usdt, 'network/arbitrum.svg': arbitrum, 'network/base.svg': base, 'network/optimism.svg': optimism };
export const CRITICAL_FILES: readonly string[] = Object.keys(RAW);
const cache = new Map<string, string>();
/** `asset/usdc.svg` → a data: URL when the file is one of the critical few, else null (the full set answers later) */
export function criticalUrl(file: string): string | null {
  const hit = cache.get(file); if (hit) return hit;
  const s = RAW[file]; if (s === undefined) return null;
  const url = `data:image/svg+xml,${encodeURIComponent(s.trim())}`;
  cache.set(file, url);
  return url;
}
