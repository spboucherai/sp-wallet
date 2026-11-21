/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/freshness.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Price freshness (v11): "as of" for the prices on Home, Assets and an asset's page. `at` is the date of the price itself
// (the source's own update time), not the time of the HTTP answer; `stale` is the server's verdict (a refresh failed, or the
// price is old). Icon + words, never colour alone. There is ONE price source today (CoinGecko): a stale flag says so plainly.
import { useContext } from 'react';
import { I18n, useT } from './i18n';
import { ago } from './sv';
import { Btn, Icon, Tag } from './ui';

/** NEXT W4 — a time of day in the owner's language (« 14 h 05 » / "2:05 p.m."), with the date when it is not today's */
export function clockText(at: number | string, locale: string, now = Date.now()): string {
  const d = new Date(at), loc = locale === 'fr' ? 'fr-CA' : 'en-CA', sameDay = new Date(now).toDateString() === d.toDateString();
  return Number.isFinite(d.getTime()) ? d.toLocaleString(loc, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}
/**
 * NEXT W4 — the last refresh FAILED and what is on screen is the previous reading: said in words, with its time, and a retry.
 * `since` is when the values shown were read (TanStack's `dataUpdatedAt`). Renders nothing while the data are current.
 */
export function StaleBanner({ q }: { q: { isError: boolean; data: unknown; dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown } }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (!q.isError || q.data === undefined) return null;
  const time = clockText(q.dataUpdatedAt, locale);
  return <div role="alert" data-testid="stale-banner" className="notice items-center" data-tone="warn">
    <Icon n="warn" className="notice-icon h-4 w-4 shrink-0" /><div className="min-w-0 flex-1"><b className="block font-semibold">{t('nxStaleSince', { time })}</b>{t('nxStaleBody', { time })}</div>
    <Btn kind="soft" className="!min-h-11 shrink-0 !text-[0.84375rem]" busy={q.isFetching} onClick={() => void q.refetch()}>{t('retry')}</Btn></div>;
}

export const freshnessText = (t: ReturnType<typeof useT>, at: string | null | undefined, stale: boolean, now = Date.now()): string => t(stale ? 'svPriceStale' : 'svPriceAt', { age: ago(t, at, now) });

/** `hero`: plain light text for the dark total card; otherwise a tag. Renders nothing when there is no price at all. */
export function PriceFreshness({ at, stale, hero }: { at: string | null | undefined; stale: boolean | undefined; hero?: boolean }) {
  const t = useT();
  if (!at) return null;
  const text = freshnessText(t, at, !!stale), title = stale ? `${text} — ${t('svPriceOneSource')}` : text;
  if (hero) return <span className={`inline-flex items-center gap-1.5 ${stale ? 'font-semibold text-[var(--hero-ink)]' : ''}`} data-testid="price-freshness" data-stale={!!stale} title={title}><Icon n={stale ? 'warn' : 'clock'} className="h-3.5 w-3.5" />{text}</span>;
  return <span data-testid="price-freshness" data-stale={!!stale} title={title}><Tag tone={stale ? 'warn' : 'mute'} icon={stale ? 'warn' : 'clock'}>{text}</Tag></span>;
}
