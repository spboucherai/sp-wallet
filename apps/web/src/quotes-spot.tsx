/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/quotes-spot.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

/**
 * V11 live spot prices for the screens of the FIRST chunk (Home, the asset page). This file is tiny on purpose: the quote
 * client (quotes.ts) is fetched on demand, after the screen is drawn — the first chunk does not grow with it. Until it has
 * arrived, and whenever the stream cannot connect or has no streamed quote for a symbol, the screen shows the polled price
 * it always showed, with that price's own date.
 */
import { useEffect, useState } from 'react';
import { useT } from './i18n';
import { Tag } from './ui';

export interface LiveSpot { usd: number; at: number; source: string }
/** symbol → streamed USD price (Coinbase), refreshed at most once a second; empty until the stream delivers */
export function useLiveSpot(symbols: string[]): Record<string, LiveSpot> {
  const [v, setV] = useState<Record<string, LiveSpot>>({});
  const sig = symbols.join(',');
  useEffect(() => {
    if (!sig) return;
    let off = (): void => {}, dead = false;
    void import('./quotes').then((m) => { if (!dead) off = m.watchSpot(sig.split(','), setV); }, () => { /* the chunk could not be fetched: the polled prices stand */ });
    return () => { dead = true; off(); setV({}); };
  }, [sig]);
  return v;
}
/** the polled price of the portfolio with the streamed one on top. The stream is in USD: another currency uses the rate implied by the polled reading (stated on screen). */
export function overlaySpot<M extends { usd: number; cad: number }>(prices: Record<string, M> | null, live: Record<string, LiveSpot>): Record<string, M & { live?: boolean }> | null {
  if (!prices) return null;
  const out: Record<string, M & { live?: boolean }> = { ...prices };
  for (const [sym, l] of Object.entries(live)) { const m = prices[sym]; if (m && m.usd > 0 && l.usd > 0) out[sym] = { ...m, usd: l.usd, cad: l.usd * (m.cad / m.usd), live: true }; }
  return out;
}
/** « live » with what it means when the screen's currency is not the stream's */
export function LiveSpotTag({ n, converted, hero }: { n?: number; converted: boolean; hero?: boolean }) {
  const t = useT();
  const text = n === undefined ? t('qtLive') : t('qtLivePrices', { n });
  if (hero) return <span className="inline-flex items-center gap-1.5" data-testid="qt-spot-live" title={converted ? t('qtSpotConverted') : undefined}><span className="h-1.5 w-1.5 rounded-full bg-emerald" aria-hidden="true" />{text}</span>;
  return <span data-testid="qt-spot-live" title={converted ? t('qtSpotConverted') : undefined}><Tag tone="ok" icon="check">{text}</Tag></span>;
}
