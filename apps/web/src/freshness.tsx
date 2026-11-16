// Price freshness (v11): "as of" for the prices on Home, Assets and an asset's page. `at` is the date of the price itself
// (the source's own update time), not the time of the HTTP answer; `stale` is the server's verdict (a refresh failed, or the
// price is old). Icon + words, never colour alone. There is ONE price source today (CoinGecko): a stale flag says so plainly.
import { useT } from './i18n';
import { ago } from './sv';
import { Icon, Tag } from './ui';

export const freshnessText = (t: ReturnType<typeof useT>, at: string | null | undefined, stale: boolean, now = Date.now()): string => t(stale ? 'svPriceStale' : 'svPriceAt', { age: ago(t, at, now) });

/** `hero`: plain light text for the dark total card; otherwise a tag. Renders nothing when there is no price at all. */
export function PriceFreshness({ at, stale, hero }: { at: string | null | undefined; stale: boolean | undefined; hero?: boolean }) {
  const t = useT();
  if (!at) return null;
  const text = freshnessText(t, at, !!stale), title = stale ? `${text} — ${t('svPriceOneSource')}` : text;
  if (hero) return <span className={`inline-flex items-center gap-1.5 ${stale ? 'font-semibold text-[#f4b65b]' : ''}`} data-testid="price-freshness" data-stale={!!stale} title={title}><Icon n={stale ? 'warn' : 'clock'} className="h-3.5 w-3.5" />{text}</span>;
  return <span data-testid="price-freshness" data-stale={!!stale} title={title}><Tag tone={stale ? 'warn' : 'mute'} icon={stale ? 'warn' : 'clock'}>{text}</Tag></span>;
}
