// The logo files themselves, as ONE lazily loaded chunk (hashed under /assets/, immutable): the whole set costs a single
// request, once, instead of one request per logo. That matters here: the API rate-limits every request of a client,
// static files included (240 per minute), and a list of 249 assets must never eat the budget of the wallet's own calls.
// SVGs are embedded as text (already sanitised, see scripts/svg-sanitize.mts), rasters as base64; both end up in
// `data:` URLs of <img> elements, which the wallet's CSP allows (img-src 'self' data:) and where nothing can execute.
const svg = import.meta.glob('./icons/**/*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const raster = import.meta.glob('./icons/**/*.{webp,png}', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>;

const cache = new Map<string, string>();
/** `asset/usdc.svg` → a data: URL, or null when the set has no such file. */
export function dataUrl(file: string): string | null {
  const hit = cache.get(file); if (hit) return hit;
  const key = `./icons/${file}`, s = svg[key], url = s !== undefined ? `data:image/svg+xml,${encodeURIComponent(s.trim())}` : raster[key] ?? null;
  if (url) cache.set(file, url);
  return url;
}
