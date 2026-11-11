/**
 * The GMX « account » (v8). GMX has no venue account: the account IS the wallet's own Arbitrum address — its USDC and ETH,
 * the wallet's limits, its positions and pending orders read from the chain. The card says, lock by lock, why trading is or
 * is not possible: the two server settings (named, and not changeable from the app), the venue policy approved with the
 * passkey, the pinned contracts, the signer, the chain. When everything is open it carries the same real-money band as a
 * mainnet venue account. `GmxLocked` is the short form shown in the terminal in place of the order panel.
 *
 * v10: same content as tidy facts — the venue and network logos, the wallet's figures as tiles, the locks as rows with an
 * icon + word state, the pinned contracts as a list of explorer links, the policy as a receipt.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, AssetIcon, Btn, Card, Fact, Fold, Icon, NetworkIcon, Notice, Stat, StatGrid, Tag, VenueIcon } from '../ui';
import { timeOf } from './bits';
import { fmt, usd } from './dec';
import { gapi, GMX_STATUS_KEY, gmxError, needsAuthorization, SETTING_OF, sortBlockers, type GmxBlocker, type GmxErr, type GmxStatus } from './gmx';
import { GmxActivity } from './GmxActivity';
import { GmxAuthorize } from './GmxAuthorize';
import { ChainTag, eth, GMX_LABEL, GmxErrNotice, usdc } from './GmxBits';
import { Group, ModeBand, TICKET, WORDS } from './LiveBits';

const SOFT: ReadonlySet<GmxBlocker> = new Set(['not_authorized', 'authorization_expired', 'authorization_revoked']);
/** every lock that is closed, explained: the server's sentence when it sent one, ours otherwise; a server setting is named */
export function GmxBlockers({ status }: { status: GmxStatus }) {
  const t = useT();
  return <ul className="space-y-2.5" data-testid="gmx-blockers">{sortBlockers(status.blockers).map((b) => { const setting = SETTING_OF[b];
    return <li key={b}><Notice tone={SOFT.has(b) ? 'info' : 'warn'}><div data-testid="gmx-blocker" data-code={b}>
      <b className="mb-0.5 block font-semibold">{t(`gxBT_${b}` as Key)}</b>{status.blockerText[b] || t(`gxB_${b}` as Key)}
      {setting && <span className="mt-2 flex items-start gap-1.5 text-[12.5px]" data-testid="gmx-setting-note"><Icon n="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0">{t('gxSettingNote')} <code className="break-all rounded-md bg-elev px-1.5 py-0.5 font-mono text-[11.5px]">{setting}</code></span></span>}
      {b === 'contracts_changed' && status.pins.problems.length > 0 && <span className={`mt-1.5 ${WORDS}`}>{status.pins.problems.join(' · ')}</span>}
      {b === 'wallet_unreadable' && status.walletError && <span className={`mt-1.5 ${WORDS}`}>{status.walletError}</span>}
      {b === 'chain_unreadable' && status.positionsError && <span className={`mt-1.5 ${WORDS}`}>{status.positionsError}</span>}
    </div></Notice></li>; })}</ul>;
}

/** in the terminal, where the order panel would be: trading is closed, and why */
export function GmxLocked({ status, goAccounts }: { status: GmxStatus; goAccounts: () => void }) {
  const t = useT();
  return <div className="min-w-0 space-y-3.5" data-testid="gmx-locked">
    <div className="flex items-start gap-3"><VenueIcon venue="gmx" size={36} /><div className="min-w-0"><h3 className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.01em]"><Icon n="lock" className="h-4 w-4 shrink-0 text-mute" />{t('gxLockedTitle')}</h3><p className="mt-0.5 text-[13px] leading-snug text-mute">{t('gxLockedIntro')}</p></div></div>
    <GmxBlockers status={status} />
    <Btn full kind="soft" onClick={goAccounts} data-testid="gmx-go-account">{t(needsAuthorization(status) ? 'gxGoAuthorize' : 'gxGoAccount')}<Icon n="chev" className="h-4 w-4" /></Btn>
  </div>;
}

export function GmxCard({ status, onOpen }: { status: GmxStatus; /** open a market in the terminal */ onOpen: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [sheet, setSheet] = useState(false), [confirmRevoke, setConfirmRevoke] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState<{ e: GmxErr; raw: unknown } | null>(null);
  const s = status, a = s.authorization, w = s.wallet, onOff = (v: boolean) => <Tag tone={v ? 'ok' : 'mute'} icon={v ? 'check' : 'lock'}>{t(v ? 'gxOn' : 'gxOff')}</Tag>;
  const revoke = async () => {
    setBusy(true); setErr(null);
    try { qc.setQueryData([...GMX_STATUS_KEY, locale], await gapi.revoke()); setConfirmRevoke(false); } catch (e) { setErr({ e: gmxError(e), raw: e }); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: GMX_STATUS_KEY }); }
  };
  const name = (m: string) => s.markets.find((x) => x.market.toLowerCase() === m.toLowerCase())?.name ?? m;
  const coin = (sym: string, label: string) => <span className="inline-flex items-center gap-1.5"><AssetIcon sym={sym} size={16} />{label}</span>;
  return <Card><div className="min-w-0 space-y-4" data-testid="gmx-card" data-tradable={s.tradable ? '1' : '0'}>
    <div className="flex items-center gap-3"><VenueIcon venue="gmx" size={40} />
      <div className="min-w-0 flex-1"><h2 className="text-[17px] font-semibold leading-tight tracking-[-0.015em]">{t('gxCardTitle')}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><Tag tone={s.tradable ? 'danger' : 'mute'} icon={s.tradable ? 'warn' : 'lock'} testid="gmx-card-state">{t(s.tradable ? 'gxStateTradable' : 'gxStateLocked')}</Tag>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-mute"><NetworkIcon net="arbitrum" size={14} />Arbitrum</span></div></div></div>
    {s.tradable && <div><ModeBand tone="mainnet" label={GMX_LABEL} compact /><p className="mt-2 text-[13px] leading-snug">{t('gxBandReal')}</p></div>}

    <div className="rounded-[18px] bg-elev/60 p-4" data-testid="gmx-account">
      <div className="text-[14px] font-semibold">{t('gxAccountIsWallet')}</div><p className="mt-0.5 text-[12.5px] leading-snug text-mute">{t('gxAccountNote')}</p>
      {s.account ? <div className="mt-2.5"><Addr value={s.account.address} />
        <div><a href={s.account.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-blue">{t('gxSeeAddress')}<Icon n="ext" className="h-3.5 w-3.5" /></a></div></div> : <p className="mt-1 text-[13px] text-mute">—</p>}
      {w ? <><div className="mt-1" data-testid="gmx-wallet"><StatGrid cols={4} className="[&_.stat-value]:text-[16px] [&_.stat]:bg-surface">
        <Stat label={coin('USDC', t('gxWalletUsdc'))} value={usdc(w.usdc, locale)} /><Stat label={coin('ETH', t('gxWalletEth'))} value={eth(w.eth, locale)} />
        <Stat label={t('gxLimitTx')} value={usdc(w.limits.perTransfer, locale)} /><Stat label={t('gxLimitDay')} value={usdc(w.limits.perDay, locale)} /></StatGrid></div>
        <p className="mt-2.5 text-[12px] leading-snug text-mute">{t('gxLimitsNote', { spent: fmt(w.limits.spentToday, { locale, dp: 2 }), max: fmt(w.limits.maxNow, { locale, dp: 2 }), fee: fmt(w.feeCeilingEth, { locale, dp: 6, trim: true }) })}</p></>
        : <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-snug text-warn" data-testid="gmx-wallet-error"><Icon n="warn" className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0">{t('gxWalletUnread')}{s.walletError ? <span className="block break-words font-mono text-[11px]">{s.walletError}</span> : null}</span></p>}
    </div>

    {s.blockers.length > 0 && <GmxBlockers status={s} />}

    <div data-testid="gmx-locks"><Group title={t('gxLocksTitle')}>
      <div className="rounded-[18px] border border-line px-4 py-1.5"><dl>
        <Fact k={<code className="break-all font-mono text-[11.5px]">SPW_DERIV_LIVE_MAINNET</code>}><span data-testid="gmx-setting-mainnet">{onOff(s.settings.liveMainnet)}</span></Fact>
        <Fact k={<code className="break-all font-mono text-[11.5px]">SPW_DERIV_GMX_LIVE</code>}><span data-testid="gmx-setting-gmx">{onOff(s.settings.gmxLive)}</span></Fact>
        <Fact k={t('gxLockAuth')}><span data-testid="gmx-auth-state" data-state={a?.state ?? 'none'}>{a ? `${t(`gxAuth_${a.state}` as Key)}${a.state === 'active' ? ` · ${t('gxUntil', { date: timeOf(a.expiresAt * 1000, locale, true) })}` : ''}` : t('gxAuth_none')}</span></Fact>
        <Fact k={t('gxLockPins')}><span data-testid="gmx-pins" data-ok={String(s.pins.ok)} className={`inline-flex items-center justify-end gap-1.5 ${s.pins.ok === false ? 'font-semibold text-warn' : ''}`}><Icon n={s.pins.ok === true ? 'check' : s.pins.ok === false ? 'warn' : 'clock'} className={`h-3.5 w-3.5 shrink-0 ${s.pins.ok === true ? 'text-emerald' : ''}`} />{t(s.pins.ok === true ? 'gxPinsOk' : s.pins.ok === false ? 'gxPinsChanged' : 'gxPinsUnchecked')}</span></Fact></dl></div>
      <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-mute"><Icon n="lock" className="mt-px h-3.5 w-3.5 shrink-0" /><span className="min-w-0">{t('gxLocksNote')}</span></p>
      <Fold className="mt-1" testid="gmx-contracts" summary={<span className="text-blue">{t('gxPinsDetails', { id: s.pins.id, date: s.pins.reviewedAt })}</span>}>
        <ul className="divide-y divide-line">{s.pins.contracts.map((c) => <li key={c.name} className="py-2"><div className="text-[13px] font-semibold">{c.name}</div>
          <a href={c.explorer} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex items-start gap-1.5 break-all font-mono text-[11.5px] leading-snug text-blue">{c.address}<Icon n="ext" className="mt-px h-3 w-3 shrink-0" /></a></li>)}</ul></Fold>
    </Group></div>

    {a && <div data-testid="gmx-policy"><Group title={t('gxPolicyTitle')}>
      <div className={TICKET}><dl className="receipt">
        <Fact k={t('gxAuthMarkets')}><span className="block">{a.policy.allowedMarkets.map((m) => <span key={m} className="block">{name(m)}</span>)}</span></Fact>
        <Fact k={t('gxAuthLeverage')}>{a.policy.maxLeverage}×</Fact><Fact k={t('gxAuthOrder')}>{usd(a.policy.maxOrderSizeUsd, locale)}</Fact>
        <Fact k={t('gxAuthPerDay')}>{a.policy.maxOrdersPerDay} · {t('gxToday', { inc: a.today.increases, red: a.today.reduces })}</Fact>
        <Fact k={t('gxAuthBand')}>{a.policy.maxPriceDeviationBps} {t('gxBps')}</Fact></dl></div></Group></div>}

    {err && <GmxErrNotice err={err.e} raw={err.raw} />}
    <div className="flex flex-wrap gap-2.5">
      {needsAuthorization(s) && <Btn onClick={() => setSheet(true)} data-testid="gmx-authorize-open"><Icon n="key" className="h-4 w-4" />{t(a ? 'gxAuthorizeAgain' : 'gxAuthorize')}</Btn>}
      {s.tradable && s.markets.filter((m) => m.allowed).map((m) => <Btn key={m.market} kind="soft" className="!pl-3" onClick={() => onOpen(m.instrument)} data-testid={`gmx-trade-${m.base}`}><AssetIcon sym={m.base} size={26} />{t('gxTrade', { market: `${m.base}/USD` })}</Btn>)}
      {a?.state === 'active' && (confirmRevoke
        ? <><Btn kind="danger" busy={busy} onClick={() => void revoke()} data-testid="gmx-revoke-confirm"><Icon n="stop" className="h-4 w-4" />{t('gxRevokeConfirm')}</Btn><Btn kind="ghost" disabled={busy} onClick={() => setConfirmRevoke(false)}>{t('cancel')}</Btn></>
        : <Btn kind="ghost" onClick={() => setConfirmRevoke(true)} data-testid="gmx-revoke">{t('gxRevoke')}</Btn>)}
    </div>
    {confirmRevoke && <p className="text-[13px] leading-snug text-mute">{t('gxRevokeNote')}</p>}

    <div className="border-t border-line pt-4"><div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-mute"><ChainTag />{t('gxChainCount', { positions: s.positions.length, orders: s.pendingOrders.length })}</div>
      <GmxActivity status={s} onSelect={onOpen} /></div>
    {sheet && <GmxAuthorize status={s} onClose={() => setSheet(false)} />}
  </div></Card>;
}
