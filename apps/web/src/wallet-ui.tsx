/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/wallet-ui.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
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

/**
 * NEXT — the wallet's own components (design system §4) that the FIRST screen draws: the asset row and the signed change.
 * The transaction row and the range selector are in tx-row.tsx (loaded with the screens that show movements).
 * Figures are the server's strings (money.ts).
 */
import { useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Bal, Portfolio } from './hooks';
import { I18n, useT } from './i18n';
import { fiatText, mulDecimal, pctText } from './money';
import { AssetIcon, Icon, Money, trimAmt } from './ui';
import { feedMode, onFeedMode } from './feed-state';

/** the interval of a query's fallback polling: slow while the event stream is connected (it says when to re-read), the usual one otherwise */
export function useFallbackInterval(usual: number, slow: number): number {
  const mode = useSyncExternalStore(onFeedMode, feedMode, feedMode);
  return mode === 'stream' ? slow : usual;
}

/** signed change with its arrow: the direction is never carried by colour alone. `abs` is a server string, `pct` a ratio. */
export function ChangeText({ abs, pct, cur, className = '' }: { abs?: string | null; pct: number | null; cur?: string; className?: string }) {
  const { locale } = useContext(I18n);
  const dir = pct !== null ? Math.sign(Math.abs(pct) < 0.005 ? 0 : pct) : abs ? (abs.startsWith('-') ? -1 : /[1-9]/.test(abs) ? 1 : 0) : 0;
  return <span className={`inline-flex items-center gap-1 font-semibold ${dir > 0 ? 'text-positive' : dir < 0 ? 'text-negative' : 'text-mute'} ${className}`}>
    {dir !== 0 && <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 shrink-0" aria-hidden="true"><path d={dir > 0 ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>}
    {abs && cur ? fiatText(abs, cur, locale, { sign: true }) : null}{abs && cur && pct !== null ? ' (' : ''}{pct !== null ? pctText(pct, locale, 2, 2, true) : ''}{abs && cur && pct !== null ? ')' : ''}</span>;
}

type Prices = Portfolio['prices'];
/** the fiat value of a row, as a decimal string (exact product, truncated to cents); null without a price or a balance */
export const rowValue = (b: Pick<Bal, 'display' | 'symbol'>, prices: Prices, ck: 'usd' | 'cad'): string | null => { const m = prices?.[b.symbol]; return m && b.display !== null ? mulDecimal(b.display, m[ck]) : null; };

/**
 * Asset row (design system §4): logo with its network badge · name + network · amount + fiat value · 24 h change.
 * An asset the wallet does not hold shows its price instead of « 0 ». `trailing` holds the row's own controls (favourite, hide).
 */
export function AssetRow({ b, prices, cur, ck, hidden, onOpen, trailing, favorite, testid }: { b: Bal; prices: Prices; cur: string; ck: 'usd' | 'cad'; hidden: boolean; onOpen: () => void; trailing?: ReactNode; favorite?: boolean; testid?: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const m = prices?.[b.symbol], zero = b.amount === '0', v = rowValue(b, prices, ck);
  return (
    <li className="flex items-stretch" data-testid={testid ?? 'asset-row'} data-asset={`${b.network}:${b.asset}`}>
      <button onClick={onOpen} className="row row-asset row-press min-w-0 flex-1">
        <AssetIcon sym={b.symbol} net={b.network} size={44} />
        <span className="row-main"><span className="t-body-strong flex items-center gap-1.5 leading-tight"><span className="truncate">{b.name}</span>{favorite && <Icon n="starFill" className="h-3.5 w-3.5 shrink-0 text-caution" />}</span>
          <span className="t-footnote mt-0.5 block truncate text-mute">{b.symbol} · {b.networkName}</span></span>
        <span className="row-end">
          {b.display === null ? <span className="t-footnote inline-flex items-center gap-1 text-caution"><Icon n="warn" className="h-3.5 w-3.5" />{t('unavailable')}</span> : zero ? <>
            <span className="t-body-strong block leading-tight">{m ? fiatText(mulDecimal('1', m[ck], m[ck] < 1 ? 6 : 2), cur, locale, { dp: m[ck] < 1 ? 6 : 2 }) : '—'}</span>
            <span className="t-footnote mt-0.5 block">{m && m.change24h !== null ? <ChangeText pct={m.change24h} /> : <span className="text-mute">{t('nwNotHeld')}</span>}</span></> : <>
            <span className="t-body-strong amt block leading-tight"><Money hidden={hidden}>{trimAmt(b.display)} <span className="font-normal text-mute">{b.symbol}</span></Money></span>
            <span className="t-footnote mt-0.5 flex flex-wrap items-center justify-end gap-x-2 text-mute">{v !== null ? <Money hidden={hidden}>{fiatText(v, cur, locale)}</Money> : <span>{t('nwNoPrice')}</span>}{m && m.change24h !== null && <ChangeText pct={m.change24h} />}</span></>}
        </span>
      </button>
      {trailing}
    </li>);
}
