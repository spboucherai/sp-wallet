/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/lifecycleUi.tsx
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
 * NEXT — the life cycle of a transfer on screen (design system §3 / §4): the timeline with the time of each step the server
 * recorded, and the explanation that ALWAYS accompanies a transfer that left the path — dropped, replaced, expired, failed,
 * signed but not sent — with « still watched » while the server keeps looking for it. Used by the tracker of Send and by the
 * detail of a movement in Activity; loaded with those screens, not with the first one.
 */
import { useContext } from 'react';
import { I18n, useT, type Key } from './i18n';
import { lifecycleIcon, lifecycleLabel, lifecycleOf, needsExplanation, timelineOf, type HasLifecycle, type LifecycleTimes } from './lifecycle';
import { propError } from './sv';
import { Icon, Notice } from './ui';

type Row = HasLifecycle & LifecycleTimes & { txid?: string | null; error?: string | null; errorParams?: Record<string, string | number> | null; confirmations?: number };
const at = (iso: string, locale: string): string => new Date(iso).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Each step says its state with a symbol and a word; the rail only repeats it. Nothing here is animated but the spinner of the current step. */
export function LifecycleTimeline({ of, minConf }: { of: Row; /** confirmations the network needs for finality, when known */ minConf?: number }) {
  const t = useT(); const { locale } = useContext(I18n); const steps = timelineOf(of), l = lifecycleOf(of);
  return <ol className="lc" aria-label={t('nwLcTitle')} data-testid="lifecycle" data-lifecycle={l}>{steps.map((s) =>
    <li key={s.key} className="lc-step" data-state={s.state} data-step={s.key} data-lifecycle={s.state === 'current' ? s.key : undefined} aria-current={s.state === 'current' ? 'step' : undefined}>
      <span className="lc-node" aria-hidden="true"><Icon n={s.state === 'done' ? 'check' : s.state === 'next' ? 'minus' : lifecycleIcon(s.key)} className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1 pt-0.5"><div className={`t-callout ${s.state === 'next' ? 'text-mute' : 'font-semibold'}`}>{lifecycleLabel(s.key, locale)}
        <span className="sr-only"> — {t(`nwLcState_${s.state}` as Key)}</span>
        {s.key === 'confirming' && s.state === 'current' && typeof of.confirmations === 'number' && <span className="font-normal text-mute" data-testid="lc-confirmations"> · {minConf ? t('nwLcConfOf', { n: of.confirmations, of: minConf }) : t('nwLcConf', { n: of.confirmations })}</span>}</div>
        {s.at && <div className="t-footnote text-mute">{at(s.at, locale)}</div>}</div></li>)}</ol>;
}

/**
 * Why a transfer left the path, in the owner's language (the server's `errorCode`, sv.ts), and — while `watched` — that the
 * server still looks for it. Renders nothing for a transfer on its path.
 */
export function LifecycleExplain({ of }: { of: Row }) {
  const t = useT(); const l = lifecycleOf(of);
  if (!needsExplanation(l) && !of.watched) return null;
  const why = propError(t, of) || t(`nwLcWhy_${l}` as Key);
  const tone = l === 'failed' ? 'danger' : l === 'expired' || l === 'not_sent' ? 'info' : 'warn';
  return <Notice tone={tone} testid="lifecycle-explain"><span data-lifecycle={l} data-testid="activity-error">{why}</span>
    {(of.watched || l === 'dropped' || l === 'replaced') && <b className="mt-1 block font-semibold" data-testid="still-watched">{t(l === 'replaced' ? 'nwLcWatchedReplaced' : 'nwLcWatched')}</b>}</Notice>;
}
