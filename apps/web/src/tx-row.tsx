/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/tx-row.tsx
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
 * NEXT — the transaction row and the range selector (design system §4), shared by the dashboard's recent activity, the asset
 * page and the Activity screen. A module of its own: none of it is needed before the first paint.
 */
import type { ReactNode } from 'react';
import { useT, type Key } from './i18n';
import { Icon, Money, Seg, StatusPill, trimAmt } from './ui';
import { RANGES, type Contact, type Range } from './wallet';
import { counterpartyLabel, counterpartyOf, directionOf, isInternalDeposit, originKey, shortAddr, type WalletItem } from './walletItems';

/** Range selector (design system §4): 1D 1W 1M 3M 1Y ALL — « 1J 1S 1M 3M 1A TOUT » in French. Arrow keys move and select; the choice is announced by its full name. */
export function RangeSelector({ value, onChange, ranges = RANGES, testid = 'range' }: { value: Range; onChange: (r: Range) => void; ranges?: readonly Range[]; testid?: string }) {
  const t = useT();
  return <Seg compact testid={testid} label={t('nwRangeLabel')} value={value} onChange={onChange} options={ranges.map((r) => [r, t(`nwR_${r}` as Key), t(`nwRL_${r}` as Key)] as const)} />;
}

const KIND_ICON: Record<string, string> = { in: 'arrowDown', out: 'arrowUp', swap: 'swap' };
/** what a movement is, in words: the counterparty by its contact label when known, else the shortened address (the full one is on the detail) */
export function itemTitle(t: ReturnType<typeof useT>, i: WalletItem, contacts: readonly Contact[] | undefined): string {
  if (i.kind === 'bridge') return `${t('brActivity')} · ${i.symbol} → ${i.bridge?.toNetworkName ?? ''}`;
  if (i.kind === 'swap') return `${t('swap')} · ${i.symbol} → ${i.swap?.toSymbol ?? ''}`;
  if (i.kind === 'gmx') return `${t('svKind_gmx')} · ${i.symbol}`;
  if (isInternalDeposit(i)) return t(originKey(i.origin) as Key);
  const who = counterpartyLabel(i, contacts) ?? (counterpartyOf(i) ? shortAddr(counterpartyOf(i)!) : null);
  return i.kind === 'receive' ? (who ? t('nwReceivedFrom', { who }) : t('received')) : who ? t('nwSentTo', { who }) : t('sent');
}
/**
 * Transaction row (design system §4): direction symbol · what it is and with whom · network and time · signed amount · status
 * pill of the life cycle. A deposit is « confirmed » only once final; an internal deposit is named by its operation.
 */
export function TransactionRow({ i, contacts, hidden, time, onOpen, expanded, right, testid }: { i: WalletItem; contacts?: readonly Contact[]; hidden: boolean; time: string; onOpen?: () => void; expanded?: boolean; /** replaces the status pill (a bridge's or a THORChain swap's own progress pill) */ right?: ReactNode; testid?: string }) {
  const t = useT(); const dir = directionOf(i), internal = isInternalDeposit(i);
  const body = <>
    <span className="disc" data-tone={dir === 'in' && !internal ? 'positive' : dir === 'swap' || internal ? 'accent' : undefined} aria-hidden="true"><Icon n={internal ? 'refresh' : KIND_ICON[dir]!} className="h-[1.125rem] w-[1.125rem]" /></span>
    <span className="row-main"><span className="t-body block truncate font-medium">{itemTitle(t, i, contacts)}</span><span className="t-footnote block truncate text-mute">{i.networkName} · {time}</span></span>
    <span className="row-end flex flex-col items-end gap-1">
      <span className={`t-body-strong amt ${dir === 'in' ? 'text-positive' : ''}`}><Money hidden={hidden}>{dir === 'in' ? '+' : '−'}{trimAmt(i.amountDisplay)} {i.symbol}</Money></span>
      {right ?? <StatusPill of={i} />}</span></>;
  return onOpen ? <button className="row row-press" onClick={onOpen} aria-expanded={expanded} data-testid={testid ?? 'tx-row'} data-id={i.id}>{body}</button> : <div className="row" data-testid={testid ?? 'tx-row'} data-id={i.id}>{body}</div>;
}
